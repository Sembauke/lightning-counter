import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closeGridArchiveReaders, readGridArchive } from '../app/lib/gridArchiveReader';
import { GRID_ARCHIVE_WINDOW_MS, type GridArchivePage } from '../app/lib/gridArchiveTypes';

const NOW = Date.UTC(2026, 8, 9, 20);
const ROWS = 1_000_000;
const bounds = { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 };
let directory: string;
let sql: Database.Database;
let area: typeof import('../app/api/grid/area/route');
let cell: typeof import('../app/api/grid/[cellId]/route');
let viewport: typeof import('../app/api/grid/viewport/route');
const originalPath = process.env.DB_PATH;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-grid-archive-'));
  process.env.DB_PATH = directory;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const db = await import('../app/lib/db');
  db.loadCounters();
  sql = new Database(path.join(directory, 'lightning.db'));
  const seed = sql.prepare(`WITH RECURSIVE row(n) AS (SELECT ? UNION ALL SELECT n + 1 FROM row WHERE n < ?)
    INSERT INTO grid_strikes (cell_id, strike_time, lat, lon)
    SELECT 'seed', ? - n * 200, -75 + (n % 15000) / 100.0, -180 + ((n * 997) % 36000) / 100.0 FROM row`);
  // Keep the real million-row fixture without a second, archive-sized WAL.
  for (let start = 1; start <= ROWS; start += 25_000) seed.run(start, Math.min(ROWS, start + 24_999), NOW);
  sql.pragma('wal_checkpoint(TRUNCATE)');
  area = await import('../app/api/grid/area/route');
  cell = await import('../app/api/grid/[cellId]/route');
  viewport = await import('../app/api/grid/viewport/route');
}, 60_000);

beforeEach(() => { sql.prepare('DELETE FROM grid_strikes WHERE id > ?').run(ROWS); });

afterAll(async () => {
  await closeGridArchiveReaders();
  sql.close();
  vi.restoreAllMocks();
  if (originalPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

function url(query: Record<string, string | number> = bounds, route = 'area'): string {
  return `http://localhost/api/grid/${route}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`;
}

async function page(query: Record<string, string | number> = bounds): Promise<GridArchivePage> {
  const response = await area.GET(new Request(url(query)));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('isolated, bounded public grid archive', () => {
  it('pages a million-row archive by stable cursor while late arrivals cannot change its rows or totals', async () => {
    const first = await page();
    expect(first.total).toBe(ROWS);
    expect(first.pages).toBe(40_000);
    expect(first.strikes.map(strike => strike.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(first.since).toBe(NOW - GRID_ARCHIVE_WINDOW_MS);
    sql.prepare('INSERT INTO grid_strikes(cell_id,strike_time,lat,lon) VALUES(?,?,?,?)').run('seed', NOW - 1000, 45, 7);
    const second = await page({ cursor: first.nextCursor! });
    expect(second.page).toBe(2);
    expect(second.total).toBe(ROWS);
    expect(second.strikes.map(strike => strike.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 26));
    expect(await page({ cursor: first.nextCursor! })).toEqual(second);
    expect((await page()).total).toBe(ROWS + 1);
    const changed = await area.GET(new Request(url({ ...bounds, minLat: 0, cursor: first.nextCursor! })));
    expect(changed.status).toBe(400);
  });

  it('keeps ingestion timers and a separate writer running during an actual million-row count', async () => {
    // Warm the worker first, so the observation includes real SQL rather than
    // just proving that creating a worker is asynchronous.
    await page();
    let heartbeats = 0;
    let wroteBeforeCompletion = false;
    let finished = false;
    const heartbeat = setInterval(() => { heartbeats++; }, 2);
    const insert = setTimeout(() => {
      sql.prepare('INSERT INTO grid_strikes(cell_id,strike_time,lat,lon) VALUES(?,?,?,?)').run('writer', NOW, 45, 7);
      wroteBeforeCompletion = !finished;
    }, 1);
    const started = performance.now();
    const first = await page();
    finished = true;
    const firstPageMs = performance.now() - started;
    clearInterval(heartbeat);
    clearTimeout(insert);
    expect(first.strikes).toHaveLength(25);
    expect(heartbeats).toBeGreaterThan(0);
    expect(wroteBeforeCompletion).toBe(true);
    const lastStarted = performance.now();
    const last = await readGridArchive({ kind: 'area', bounds, since: NOW - GRID_ARCHIVE_WINDOW_MS, until: NOW,
      snapshotId: ROWS, after: { strikeTime: NOW - 999_975 * 200, id: 999_975 }, total: ROWS, limit: 25 });
    const lastPageMs = performance.now() - lastStarted;
    expect(last.strikes.map(strike => strike.id)).toEqual(Array.from({ length: 25 }, (_, i) => 999_976 + i));
    expect(last.next).toBeNull();
    console.info(JSON.stringify({ gridArchiveBenchmark: { rows: ROWS, firstPageMs, lastPageMs, heartbeats, wroteBeforeCompletion } }));
  });

  it('reports retained cell totals, with indexed equal-time paging rather than lifetime empty pages', async () => {
    sql.prepare('INSERT OR REPLACE INTO grid_cells(cell_id,total_strikes,last_strike_time) VALUES(?,?,?)').run('100,200', 5000, NOW);
    const insert = sql.prepare('INSERT INTO grid_strikes(cell_id,strike_time,lat,lon) VALUES(?,?,?,?)');
    sql.transaction(() => {
      for (let i = 0; i < 51; i++) insert.run('100,200', NOW - 1000, 45, 7);
      insert.run('100,200', NOW - GRID_ARCHIVE_WINDOW_MS - 1, 45, 7);
    })();
    const firstResponse = await cell.GET(new Request(url({}, '100%2C200')), { params: Promise.resolve({ cellId: '100,200' }) });
    const first = await firstResponse.json();
    expect(first.total).toBe(51);
    expect(first.cell.total_strikes).toBe(5000);
    expect(first.pages).toBe(3);
    const secondResponse = await cell.GET(new Request(url({ cursor: first.nextCursor }, '100%2C200')), { params: Promise.resolve({ cellId: '100,200' }) });
    const second = await secondResponse.json();
    const thirdResponse = await cell.GET(new Request(url({ cursor: second.nextCursor }, '100%2C200')), { params: Promise.resolve({ cellId: '100,200' }) });
    const third = await thirdResponse.json();
    expect(third.strikes).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    expect(new Set([...first.strikes, ...second.strikes, ...third.strikes].map(strike => strike.id)).size).toBe(51);
  });

  it('supports date-line archive selections and inclusive geographic edges', async () => {
    const insert = sql.prepare('INSERT INTO grid_strikes(cell_id,strike_time,lat,lon) VALUES(?,?,?,?)');
    for (const [lat, lon] of [[85, 179], [86, -179], [85.5, 0], [86.1, 179]]) insert.run('edge', NOW, lat, lon);
    const result = await page({ minLat: 85, maxLat: 86, minLon: 179, maxLon: -179 });
    expect(result.total).toBe(2);
    expect(result.strikes.map(strike => strike.lon).sort()).toEqual([-179, 179]);
  });

  it('rejects arbitrary offsets, malformed bounds, old windows, oversized limits and edited cursors before reading', async () => {
    const invalid: Array<Record<string, string | number>> = [
      { page: 'oops' }, { page: 'Infinity' }, { page: 40_000 }, { page: 0 }, { page: 1.5 },
      { minLat: '-Infinity' }, { maxLat: 91 }, { minLon: 181 }, { maxLat: -91 }, { maxLat: '25abc' },
      { since: 0 }, { since: -1 }, { until: 0 }, { limit: 1_000_000 }, { cursor: 'bad' },
    ];
    for (const override of invalid) {
      expect((await area.GET(new Request(url({ ...bounds, ...override })))).status).toBe(400);
    }
    expect((await area.GET(new Request(`${url()}&minLat=0`))).status).toBe(400);
    expect((await viewport.GET(new Request(url({ ...bounds, limit: 1_000_000 }, 'viewport')))).status).toBe(400);
    expect((await cell.GET(new Request(url({}, 'invalid')), { params: Promise.resolve({ cellId: 'Infinity,1' }) })).status).toBe(400);
    const first = await page();
    const [payload, signature] = first.nextCursor!.split('.');
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString());
    edited.total = 10_000_000;
    const tampered = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${signature}`;
    expect((await area.GET(new Request(url({ cursor: tampered })))).status).toBe(400);
    expect((await cell.GET(new Request(url({ cursor: first.nextCursor! })), { params: Promise.resolve({ cellId: '100,200' }) })).status).toBe(400);
  });

  it('bounds simultaneous reads and returns retryable overload responses without false completion', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => cell.GET(new Request(url({}, '0,0')), { params: Promise.resolve({ cellId: '0,0' }) })));
    expect(responses.filter(response => response.status === 200)).toHaveLength(16);
    expect(responses.filter(response => response.status === 503)).toHaveLength(4);
    for (const response of responses.filter(response => response.status === 503)) {
      expect(response.headers.get('Retry-After')).toBe('2');
      expect(await response.json()).not.toHaveProperty('strikes');
    }
    const abort = new AbortController();
    const cancelled = area.GET(new Request(url(), { signal: abort.signal }));
    abort.abort();
    expect((await cancelled).status).toBe(503);
    expect((await page()).strikes).toHaveLength(25);
  });

  it('expires active and queued work and can recover with a new worker after the deadline', async () => {
    await page();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const active = area.GET(new Request(url()));
      const queued = area.GET(new Request(url()));
      // Advance synchronously so worker responses cannot race the deadline.
      vi.advanceTimersByTime(5_000);
      expect((await active).status).toBe(503);
      expect((await queued).status).toBe(503);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
    expect((await page()).strikes).toHaveLength(25);
    await closeGridArchiveReaders();
    expect((await page()).strikes).toHaveLength(25);
  });
});
