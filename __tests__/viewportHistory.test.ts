import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { MAP_HISTORY_PAGE_SIZE, MAP_HISTORY_WINDOW_MS, type MapHistoryPage, type MapHistoryStrike } from '../app/lib/mapHistory';

const NOW = Date.UTC(2026, 8, 9, 12);
const oldDbPath = process.env.DB_PATH;
const globals = globalThis as typeof globalThis & { _viewportCursorKey?: Buffer };
const oldCursorKey = globals._viewportCursorKey;
let tmpDir: string;
let sql: Database.Database;
let route: typeof import('../app/api/grid/viewport/route');
type Query = Record<string, string | number | undefined>;
const initialQuery: Query = { minLat: 44, maxLat: 46, minLon: 6, maxLon: 8,
  since: NOW - MAP_HISTORY_WINDOW_MS, until: NOW };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-viewport-history-'));
  process.env.DB_PATH = tmpDir;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const db = await import('../app/lib/db');
  db.getStormByKey('__init__');
  sql = new Database(path.join(tmpDir, 'lightning.db'));
  route = await import('../app/api/grid/viewport/route');
});

beforeEach(() => { sql.exec('DELETE FROM grid_strikes'); });

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  sql.close();
  if (oldDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = oldDbPath;
  if (oldCursorKey === undefined) delete globals._viewportCursorKey;
  else globals._viewportCursorKey = oldCursorKey;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insert(points: Array<[number, number, number]>) {
  const statement = sql.prepare('INSERT INTO grid_strikes (cell_id, lat, lon, strike_time) VALUES (?, ?, ?, ?)');
  sql.transaction(() => {
    for (const [lat, lon, time] of points) statement.run('fixture', lat, lon, time);
  })();
}

function request(query: Query = initialQuery) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value !== undefined) params.set(name, String(value));
  return route.GET(new Request(`http://localhost/api/grid/viewport?${params}`));
}

async function page(query: Query = initialQuery): Promise<MapHistoryPage> {
  const response = await request(query);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const result = await response.json() as MapHistoryPage;
  expect(result.complete).toBe(result.nextCursor === null);
  expect(result.strikes.length).toBeLessThanOrEqual(MAP_HISTORY_PAGE_SIZE);
  return result;
}

describe('bounded live-map history snapshots', () => {
  it('returns every point beyond twenty thousand, including equal timestamps and the full hour, without concurrent insertions changing the snapshot', async () => {
    const equalTime = NOW - 20 * 60_000;
    const dense: Array<[number, number, number]> = Array.from({ length: 25_037 }, (_, i) => [44 + i % 1000 * .001, 7, equalTime]);
    insert([...dense, [45, 7, NOW - 59 * 60_000], [45, 7, NOW - MAP_HISTORY_WINDOW_MS],
      [45, 7, NOW - MAP_HISTORY_WINDOW_MS - 1], [45, 7, NOW + 1], [47, 7, equalTime], [45, 8.01, equalTime]]);
    const expected = sql.prepare(`SELECT id, lat, lon, strike_time FROM grid_strikes
      WHERE lat BETWEEN 44 AND 46 AND lon BETWEEN 6 AND 8 AND strike_time BETWEEN ? AND ?
      ORDER BY strike_time DESC, id DESC`).all(NOW - MAP_HISTORY_WINDOW_MS, NOW) as MapHistoryStrike[];
    let current = await page();
    expect(current.complete).toBe(false);
    expect(current.strikes).toHaveLength(MAP_HISTORY_PAGE_SIZE);
    const firstCursor = current.nextCursor!;
    const firstPage = current.strikes;
    const received = [...current.strikes];

    // A newer event, a delayed event and another equal-time event all have
    // larger row IDs than the captured snapshot, so none can enter later pages.
    insert([[45, 7, NOW - 1000], [45, 7, NOW - 50 * 60_000], [45, 7, equalTime]]);
    let pages = 1;
    while (current.nextCursor) {
      current = await page({ ...initialQuery, since: current.since, until: current.until, cursor: current.nextCursor });
      received.push(...current.strikes);
      expect(++pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(received).toEqual(expected);
    expect(new Set(received.map(strike => strike.id)).size).toBe(expected.length);
    expect(received.at(-1)!.strike_time).toBe(NOW - MAP_HISTORY_WINDOW_MS);
    expect((await page({ cursor: firstCursor })).strikes).toEqual(received.slice(firstPage.length, firstPage.length * 2));
    expect((await page()).strikes[0].strike_time).toBe(NOW - 1000);
  });

  it('keeps a valid continuation retryable after a rejected or altered cursor request', async () => {
    insert(Array.from({ length: MAP_HISTORY_PAGE_SIZE + 3 }, (_, i) => [45, 7, NOW - i - 1]));
    const first = await page();
    const cursor = first.nextCursor!;
    expect((await request({ ...initialQuery, cursor, maxLon: 9 })).status).toBe(400);
    expect((await request({ ...initialQuery, cursor, since: first.since + 1 })).status).toBe(400);
    expect((await request({ ...initialQuery, cursor, until: first.until - 1 })).status).toBe(400);
    const [payload, signature] = cursor.split('.');
    const altered = JSON.parse(Buffer.from(payload, 'base64url').toString());
    altered.maxLon = 9;
    const tampered = `${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${signature}`;
    expect((await request({ cursor: tampered })).status).toBe(400);
    const recovered = await page({ cursor });
    expect(recovered.strikes).toHaveLength(3);
    expect(recovered.complete).toBe(true);
    expect(await page({ ...initialQuery, cursor })).toEqual(recovered);
  });

  it('never reports completion when the database cannot serve a continuation', async () => {
    insert(Array.from({ length: MAP_HISTORY_PAGE_SIZE + 1 }, (_, i) => [45, 7, NOW - i - 1]));
    const first = await page();
    sql.exec('ALTER TABLE grid_strikes RENAME TO unavailable_grid_strikes');
    try {
      await expect(request({ cursor: first.nextCursor! })).rejects.toThrow();
    } finally {
      sql.exec('ALTER TABLE unavailable_grid_strikes RENAME TO grid_strikes');
    }
    const retry = await page({ cursor: first.nextCursor! });
    expect(retry.strikes).toHaveLength(1);
    expect(retry.complete).toBe(true);
  });

  it('supports inclusive geographic edges and a viewport crossing the date line', async () => {
    insert([[44, 179, NOW - 1000], [46, -179, NOW - 1000], [45, 179.9, NOW - 1000],
      [45, -179.9, NOW - 1000], [45, 0, NOW - 1000], [47, 179.9, NOW - 1000]]);
    const crossing = await page({ ...initialQuery, minLon: 179, maxLon: -179 });
    expect(crossing.strikes).toHaveLength(4);
    expect(crossing.strikes.every(point => Math.abs(point.lon) >= 179)).toBe(true);
    const east = await page({ ...initialQuery, minLon: 179, maxLon: 180 });
    expect(east.strikes.map(point => point.lon).sort()).toEqual([179, 179.9]);
  });

  it('defaults to one hour and bounds legacy since-only requests instead of scanning all retained history', async () => {
    insert([[45, 7, NOW - MAP_HISTORY_WINDOW_MS - 1], [45, 7, NOW - 55 * 60_000]]);
    const legacy = await page({ ...initialQuery, since: 0, until: undefined });
    expect(legacy.since).toBe(NOW - MAP_HISTORY_WINDOW_MS);
    expect(legacy.until).toBe(NOW);
    expect(legacy.strikes).toHaveLength(1);
    const defaults = await page({ ...initialQuery, since: undefined, until: undefined });
    expect(defaults).toEqual(legacy);
  });

  it('returns an explicitly complete empty snapshot', async () => {
    expect(await page()).toEqual({ strikes: [], nextCursor: null, complete: true,
      since: NOW - MAP_HISTORY_WINDOW_MS, until: NOW });
  });

  it('normalizes an ahead-of-server client clock once while preserving a full-hour snapshot', async () => {
    insert(Array.from({ length: MAP_HISTORY_PAGE_SIZE + 1 }, (_, i) => [45, 7, NOW - i - 1]));
    const ahead = 5 * 60_000;
    const first = await page({ ...initialQuery, since: NOW + ahead - MAP_HISTORY_WINDOW_MS, until: NOW + ahead });
    expect(first.since).toBe(NOW - MAP_HISTORY_WINDOW_MS);
    expect(first.until).toBe(NOW);
    const second = await page({ ...initialQuery, cursor: first.nextCursor!, since: first.since, until: first.until });
    expect(second.strikes).toHaveLength(1);
    expect(second.complete).toBe(true);
    expect((await request({ ...initialQuery, cursor: first.nextCursor!,
      since: NOW + ahead - MAP_HISTORY_WINDOW_MS, until: NOW + ahead })).status).toBe(400);
  });

  it('rejects malformed geography, times, ambiguous parameters and cursors', async () => {
    const invalid: Query[] = [
      { minLat: 'Infinity' }, { maxLat: 'NaN' }, { minLon: '' }, { minLat: -91 }, { maxLat: 91 },
      { minLat: 47, maxLat: 46 }, { minLon: -181 }, { maxLon: 181 }, { minLat: undefined },
      { since: '12oops' }, { since: -1 }, { since: -1, until: undefined }, { since: NOW - .5 },
      { since: NOW + 1 }, { until: NOW + 1 }, { until: NOW - .5 },
      { since: NOW - MAP_HISTORY_WINDOW_MS - 1 }, { since: 'Infinity' }, { until: 'NaN' },
      { cursor: '' }, { cursor: 'invalid' }, { cursor: 'x'.repeat(2049) },
    ];
    for (const override of invalid) {
      const response = await request({ ...initialQuery, ...override });
      expect(response.status, JSON.stringify(override)).toBe(400);
      expect(await response.json()).not.toHaveProperty('complete');
    }
    const repeated = new URLSearchParams(initialQuery as Record<string, string>);
    repeated.append('minLat', '45');
    expect((await route.GET(new Request(`http://localhost/api/grid/viewport?${repeated}`))).status).toBe(400);
  });
});
