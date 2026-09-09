import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: (lat: number) => lat > 46 ? null : 'IT' }));
const globals = globalThis as typeof globalThis & Record<string, any>;
const timerKeys = ['_iv_histPrune', '_iv_dbFlush', '_iv_gridBatch', '_iv_hourly'];
const stateKeys = [...timerKeys, '_routeIntervals', '_processStrike', '_processStrikes', '_flushIngestion', '_stopIngestion',
  '_strikeQueue', '_recentStrikes', '_sseControllers', '_sseBcastGen', '_serverTotal', '_serverCountryCounts',
  '_todayCounts', '_todayDate', '_stormSeq', '_stormStrikeOwnership', '_stormStrikeSubscribers', '_activeSources', '_ingestionReady'];
const start = Date.UTC(2026, 8, 9, 12);
let tmp: string;
let sql: Database.Database;
let db: typeof import('../app/lib/db');
const originalPath = process.env.DB_PATH;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(start);
  for (const key of stateKeys) delete globals[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-intake-durability-'));
  process.env.DB_PATH = tmp;
  await import('../app/api/strikes/route');
  db = await import('../app/lib/db');
  sql = new Database(path.join(tmp, 'lightning.db'));
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sql.close();
  for (const key of stateKeys) delete globals[key];
  if (originalPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = originalPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});
function points(n: number, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => ({ lat: 45 + i % 20 * .001, lon: 12 + Math.floor(i / 20) * .001, time: now - 60_000 + i * 50 }));
}
function scalar(query: string) { return (sql.prepare(query).get() as { n: number }).n; }
function storms() { return db.loadTrackedStorms() as Array<{ key: string; totalStrikes: number; allStrikes: number[][]; currentRate: number }>; }
async function restart(now = Date.now()) {
  vi.clearAllTimers();
  for (const key of stateKeys) delete globals[key];
  vi.setSystemTime(now);
  vi.resetModules();
  await import('../app/api/strikes/route');
  db = await import('../app/lib/db');
}

describe('durable intake and atomic tracking checkpoints', () => {
  it('recovers accepted but completely unflushed intake after a two-hour outage, without replay broadcasts or duplicate totals', async () => {
    const batch = points(600);
    globals._processStrikes(batch);
    expect(globals._serverTotal).toBe(600);
    expect(db.loadCounters().total).toBe(0);
    expect(scalar('SELECT COUNT(*) n FROM grid_strikes')).toBe(0);
    expect(scalar('SELECT COUNT(*) n FROM strike_intake')).toBe(600);
    await restart(start + 2 * 60 * 60_000);
    expect(db.loadCounters()).toEqual({ total: 600, countries: { IT: 600 } });
    expect(db.loadDailyStrikes('2026-09-09')).toEqual({ IT: 600 });
    expect(scalar('SELECT COUNT(*) n FROM grid_strikes')).toBe(600);
    expect(scalar('SELECT SUM(total_strikes) n FROM grid_cells')).toBe(600);
    expect(scalar('SELECT COUNT(*) n FROM storm_replay_points')).toBe(600);
    expect(storms()).toHaveLength(1);
    expect(storms()[0].totalStrikes).toBe(600);
    expect(storms()[0].allStrikes).toHaveLength(600);
    expect(globals._recentStrikes).toEqual([]);
    expect(globals._sseControllers.size).toBe(0);
    const key = storms()[0].key;
    // Mirrors/reconnects re-deliver the same physical strokes under new feed IDs.
    globals._processStrikes(batch);
    expect(globals._serverTotal).toBe(600);
    await restart();
    expect(globals._serverTotal).toBe(600);
    expect(db.getBiggestStorm('IT')?.stormKey).toBe(key);
    expect(db.getBiggestStorm('IT')?.totalCount).toBe(600);
    expect(scalar('SELECT COUNT(*) n FROM grid_strikes')).toBe(600);
  });

  it('preserves lifetime grid-cell totals after an outage beyond raw retention', async () => {
    globals._processStrikes(points(120));
    await restart(start + 4 * 24 * 60 * 60_000);
    expect(db.loadCounters().total).toBe(120);
    expect(scalar('SELECT COUNT(*) n FROM grid_strikes')).toBe(0);
    expect(scalar('SELECT SUM(total_strikes) n FROM grid_cells')).toBe(120);
    expect(storms()[0].totalStrikes).toBe(120);
    expect(storms()[0].allStrikes).toHaveLength(120);
  });

  it('does not duplicate raw rows already archived before a crash and preserves cross-midnight arrival buckets', async () => {
    vi.setSystemTime(Date.UTC(2026, 8, 9, 23, 59, 59));
    const first = points(120);
    globals._processStrikes(first);
    db.flushIntakeArchive();
    vi.setSystemTime(Date.UTC(2026, 8, 10, 0, 0, 1));
    const second = points(120).map(p => ({ ...p, lat: p.lat + 2 }));
    globals._processStrikes(second);
    await restart(Date.UTC(2026, 8, 10, 0, 0, 20));
    expect(db.loadCounters()).toEqual({ total: 240, countries: { IT: 120, XO: 120 } });
    expect(db.loadDailyStrikes('2026-09-09')).toEqual({ IT: 120 });
    expect(db.loadDailyStrikes('2026-09-10')).toEqual({ XO: 120 });
    expect(scalar('SELECT COUNT(*) n FROM grid_strikes')).toBe(240);
    expect(scalar('SELECT SUM(total_strikes) n FROM grid_cells')).toBe(240);
    globals._processStrikes([...first, ...second]);
    globals._flushIngestion();
    expect(db.loadCounters().total).toBe(240);
  });

  it('rolls back every database projection and mutable lifecycle state when a checkpoint fails, then retries exactly once', () => {
    globals._processStrikes(points(600));
    const checkpoint = vi.spyOn(db, 'saveTrackedStorms').mockImplementationOnce(() => { throw new Error('Injected checkpoint failure'); });
    expect(() => globals._flushIngestion()).toThrow('Injected checkpoint failure');
    expect(db.loadCounters().total).toBe(0);
    expect(db.loadDailyStrikes('2026-09-09')).toEqual({});
    expect(db.getBiggestStorm('IT')).toBeNull();
    expect(scalar('SELECT COUNT(*) n FROM storm_replay_points')).toBe(0);
    expect(db.loadIntakeCheckpoint()).toBeNull();
    expect(scalar('SELECT COUNT(*) n FROM strike_intake')).toBe(600);
    checkpoint.mockRestore();
    globals._flushIngestion();
    expect(db.loadCounters().total).toBe(600);
    expect(storms()).toHaveLength(1);
    expect(storms()[0].totalStrikes).toBe(600);
    expect(db.loadIntakeCheckpoint()?.stormSeq).toBe(1);
    globals._flushIngestion();
    expect(storms()[0].totalStrikes).toBe(600);
    expect(scalar('SELECT COUNT(*) n FROM storm_replay_points')).toBe(600);
    expect(scalar('SELECT COUNT(*) n FROM grid_strikes')).toBe(600);
  });

  it('keeps committed lifecycle memory when post-commit publication fails', async () => {
    globals._processStrikes(points(600));
    const streams = await import('../app/lib/strikeStream');
    const publish = vi.spyOn(streams, 'publishStormOwnership').mockImplementationOnce(() => { throw new Error('Injected publication failure'); });
    expect(() => globals._flushIngestion()).toThrow('Injected publication failure');
    expect(db.loadCounters().total).toBe(600);
    const key = storms()[0].key;
    publish.mockRestore();
    vi.setSystemTime(start + 30_000);
    globals._processStrikes(points(120));
    globals._flushIngestion();
    expect(storms()).toHaveLength(1);
    expect(storms()[0].key).toBe(key);
    expect(storms()[0].totalStrikes).toBe(720);
  });

  it('flushes every accepted projection on orderly stop and refuses further intake', async () => {
    globals._processStrikes(points(600));
    globals._stopIngestion();
    expect(globals._ingestionReady()).toBe(false);
    expect(() => globals._processStrike(45, 12, start)).toThrow('stopped');
    expect(db.loadCounters().total).toBe(600);
    expect(storms()[0].totalStrikes).toBe(600);
    expect(scalar('SELECT COUNT(*) n FROM grid_strikes')).toBe(600);
    expect(scalar('SELECT COUNT(*) n FROM storm_replay_points')).toBe(600);
    await restart(start + 1000);
    expect(globals._serverTotal).toBe(600);
    globals._processStrikes(points(600, start));
    expect(globals._serverTotal).toBe(600);
  });

  it('rejects a full journal atomically and never deletes pending intake during cleanup', () => {
    const insert = sql.prepare(`INSERT INTO strike_intake(identity, received_at, strike_time, lat, lon, cc, count_date, live)
      VALUES (?, ?, ?, 45, 12, 'IT', '2026-09-09', 1)`);
    sql.transaction(() => {
      for (let i = 0; i < db.MAX_PENDING_INTAKE; i++) insert.run(`old-${i}`, start - 86_400_000, start - 86_400_000);
    })();
    expect(() => globals._processStrikes(points(1))).toThrow('Durable intake is full');
    expect(globals._serverTotal).toBe(0);
    expect(scalar('SELECT COUNT(*) n FROM strike_intake')).toBe(db.MAX_PENDING_INTAKE);
    db.checkpointStrikeIntake({ through: 0, time: start, stormSeq: 0 }, () => {});
    expect(scalar('SELECT COUNT(*) n FROM strike_intake')).toBe(db.MAX_PENDING_INTAKE);
  });
});
