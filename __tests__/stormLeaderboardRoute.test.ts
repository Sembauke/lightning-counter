import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { StormLeaderboardPage } from '../app/lib/db';

const previousDbPath = process.env.DB_PATH;
let directory: string;
let sql: Database.Database;
let db: typeof import('../app/lib/db');
let route: typeof import('../app/api/storms/[key]/leaderboard/route');

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-leaderboard-route-'));
  process.env.DB_PATH = directory;
  db = await import('../app/lib/db');
  db.getStormByKey('__initialize__');
  await new Promise<void>(resolve => setImmediate(resolve));
  sql = new Database(path.join(directory, 'lightning.db'));
  route = await import('../app/api/storms/[key]/leaderboard/route');
});

beforeEach(() => {
  sql.exec('DELETE FROM storms; DELETE FROM storm_aliases; DELETE FROM storm_replay_points;');
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(() => {
  sql.close();
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

function key(index: number) { return `FR:storm-${String(index).padStart(2, '0')}`; }
function seed(count = 40, tied = false) {
  const insert = sql.prepare(`INSERT INTO storms
    (storm_key, code, count, rate, lat, lon, city, origin_city, date, total_count, strikes)
    VALUES (?, 'FR', ?, 25, 48, 2, 'Paris', 'Paris', '2026-09-10', ?, '[[48,2,1789000000000]]')`);
  // Reverse insertion order deliberately differs from the key order for ties.
  sql.transaction(() => {
    for (let i = count; i >= 1; i--) {
      const total = tied ? 6000 : 100_000 - i * 1000;
      insert.run(key(i), total, i % 2 ? total : null);
    }
  })();
}
function request(stormKey = key(25), before?: string) {
  const url = new URL(`http://localhost/api/storms/${encodeURIComponent(stormKey)}/leaderboard`);
  if (before !== undefined) url.searchParams.set('before', before);
  return route.GET(new Request(url), { params: Promise.resolve({ key: encodeURIComponent(stormKey) }) });
}
async function page(stormKey = key(25), before?: string): Promise<StormLeaderboardPage> {
  const response = await request(stormKey, before);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}
function keys(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, i) => key(first + i));
}

describe('lazy storm leaderboard pages', () => {
  it('loads the initial neighborhood and ten upcoming rows at a time through the top of the leaderboard', async () => {
    seed();
    const initial = await page();
    expect(initial.stormKey).toBe(key(25));
    expect(initial.currentRank).toBe(25);
    expect(initial.rows).toEqual(db.getNearbyRankedStorms(key(25)));
    expect(initial.rows.map(row => row.stormKey)).toEqual(keys(15, 35));
    expect(initial.hasMoreAbove).toBe(true);
    expect(initial).not.toHaveProperty('anchor');

    const next = await page(key(25), initial.rows[0].stormKey);
    expect(next.rows.map(row => row.stormKey)).toEqual(keys(5, 14));
    expect(next.hasMoreAbove).toBe(true);
    const top = await page(key(25), next.rows[0].stormKey);
    expect(top.rows.map(row => row.stormKey)).toEqual(keys(1, 4));
    expect(top.hasMoreAbove).toBe(false);
    expect(await page(key(25), key(1))).toEqual({
      stormKey: key(25), currentRank: 25, rows: [], hasMoreAbove: false,
      anchor: top.rows[0],
    });
  });

  it('keeps the boundary attached to a known row when the live storm crosses several global ranks', async () => {
    seed();
    const initial = await page();
    sql.prepare('UPDATE storms SET total_count = 97500 WHERE storm_key = ?').run(key(25));
    const next = await page(key(25), initial.rows[0].stormKey);
    expect(next.currentRank).toBe(3);
    expect(next.rows.map(row => row.stormKey)).toEqual(keys(5, 14));
    expect(next.rows.map(row => row.rank)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(next.rows.some(row => initial.rows.some(known => known.stormKey === row.stormKey))).toBe(false);
  });

  it('uses deterministic storm-key order for ties and matches the initial server-rendered neighborhood', async () => {
    seed(23, true);
    const initial = await page(key(12));
    expect(initial.currentRank).toBe(12);
    expect(initial.rows.map(row => row.stormKey)).toEqual(keys(2, 22));
    expect(initial.rows).toEqual(db.getNearbyRankedStorms(key(12)));
    const next = await page(key(12), key(12));
    expect(next.rows.map(row => row.stormKey)).toEqual(keys(2, 11));
    expect(next.rows.every(row => row.totalCount === 6000)).toBe(true);
  });

  it('resolves merged aliases for both the viewed storm and the row used as the cursor', async () => {
    seed();
    db.recordStormAlias('FR:previous-storm', key(25));
    db.recordStormAlias('FR:previous-anchor', key(15));
    const result = await page('FR:previous-storm', 'FR:previous-anchor');
    expect(result.stormKey).toBe(key(25));
    expect(result.currentRank).toBe(25);
    expect(result.rows.map(row => row.stormKey)).toEqual(keys(5, 14));
    expect(result.anchor).toMatchObject({ stormKey: key(15), rank: 15, totalCount: 85_000 });
  });

  it('refreshes the cursor rank and count after higher rows disappear, including a merged cursor at the top', async () => {
    seed();
    const initial = await page();
    const cursor = initial.rows[0];
    expect(cursor.rank).toBe(15);
    sql.prepare('DELETE FROM storms WHERE storm_key < ?').run(key(11));
    sql.prepare('UPDATE storms SET total_count = 85500 WHERE storm_key = ?').run(cursor.stormKey);
    db.recordStormAlias('FR:old-cursor', cursor.stormKey);
    const refreshed = await page(key(25), 'FR:old-cursor');
    expect(refreshed.currentRank).toBe(15);
    expect(refreshed.rows.map(row => row.stormKey)).toEqual(keys(11, 14));
    expect(refreshed.rows.map(row => row.rank)).toEqual([1, 2, 3, 4]);
    expect(refreshed.anchor).toEqual({ ...cursor, rank: 5, totalCount: 85_500 });
    expect(refreshed.hasMoreAbove).toBe(false);
    expect(refreshed.anchor).not.toHaveProperty('currentRank');

    sql.prepare('DELETE FROM storms WHERE storm_key < ?').run(cursor.stormKey);
    const top = await page(key(25), 'FR:old-cursor');
    expect(top.rows).toEqual([]);
    expect(top.hasMoreAbove).toBe(false);
    expect(top.anchor).toEqual({ ...cursor, rank: 1, totalCount: 85_500 });
  });

  it('returns a bounded initial neighborhood for the first/last storm and a one-storm leaderboard', async () => {
    seed();
    expect((await page(key(1))).rows.map(row => row.stormKey)).toEqual(keys(1, 11));
    expect((await page(key(1))).hasMoreAbove).toBe(false);
    expect((await page(key(40))).rows.map(row => row.stormKey)).toEqual(keys(30, 40));
    sql.prepare('DELETE FROM storms WHERE storm_key != ?').run(key(1));
    const only = await page(key(1));
    expect(only.rows).toHaveLength(1);
    expect(only.currentRank).toBe(1);
    expect(only.hasMoreAbove).toBe(false);
  });

  it('reports missing/deleted cursor rows separately from a successful empty page at the top', async () => {
    seed();
    expect((await request('FR:missing')).status).toBe(404);
    expect((await request(key(25), 'FR:missing')).status).toBe(404);
    sql.prepare('DELETE FROM storms WHERE storm_key = ?').run(key(15));
    expect((await request(key(25), key(15))).status).toBe(404);
  });

  it('rejects empty/oversized cursors and malformed encoded keys before querying the database', async () => {
    const lookup = vi.spyOn(db, 'getStormLeaderboardPage');
    for (const [stormKey, before] of [[key(25), ''], [key(25), 'x'.repeat(257)], ['x'.repeat(257), undefined]]) {
      expect((await request(stormKey, before)).status).toBe(400);
    }
    const malformed = await route.GET(new Request('http://localhost/api/storms/%/leaderboard'), {
      params: Promise.resolve({ key: '%' }),
    });
    expect(malformed.status).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not recover, read, or mutate archived replay samples while loading rank pages', async () => {
    seed();
    const recovery = vi.spyOn(db, 'getStormReplayByKey').mockImplementation(() => { throw new Error('Unexpected replay recovery'); });
    const replayRead = vi.spyOn(db, 'getStormByKey').mockImplementation(() => { throw new Error('Unexpected replay read'); });
    const before = sql.prepare('SELECT * FROM storms ORDER BY storm_key').all();
    const data = await page(key(25), key(15));
    expect(data.rows).toHaveLength(10);
    expect(data.rows.every(row => !('strikes' in row))).toBe(true);
    expect(recovery).not.toHaveBeenCalled();
    expect(replayRead).not.toHaveBeenCalled();
    expect(sql.prepare('SELECT * FROM storms ORDER BY storm_key').all()).toEqual(before);
  });
});
