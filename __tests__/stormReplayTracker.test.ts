import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BiggestStorm, StormStrike } from '../app/lib/db';

const minute = 60_000;
const start = Date.UTC(2026, 8, 8, 12);
const trackedKey = 'US:tail-integration';
const replayTables = ['storms', 'country_biggest_storms', 'storm_records'];
const globals = globalThis as typeof globalThis & Record<string, any>;
const globalKeys = [
  '_recentStrikes', '_processStrike', '_routeIntervals', '_iv_histPrune', '_iv_dbFlush',
  '_iv_gridBatch', '_iv_hourly', '_serverTotal', '_serverCountryCounts', '_todayCounts',
  '_todayDate', '_sseControllers', '_sseBcastGen', '_strikeQueue', '_stormSeq', '_stormStrikeSubscribers',
];

let dbModule: typeof import('../app/lib/db');
let sql: Database.Database;
let tmpDir: string;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(start);
  for (const key of globalKeys) delete globals[key];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-tracker-test-'));
  vi.stubEnv('DB_PATH', tmpDir);
  dbModule = await import('../app/lib/db');
  dbModule.getStormByKey('__init__');
  await vi.advanceTimersByTimeAsync(0);
  sql = new Database(path.join(tmpDir, 'lightning.db'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const key of globalKeys) delete globals[key];
  sql.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedTrackedStorm(shortState = false) {
  const strikes: StormStrike[] = Array.from({ length: 200 }, (_, i) => [43, -94, start - 2 * minute + i * 300]);
  const officialWatermark = strikes[strikes.length - 1][2];
  const storm: BiggestStorm = {
    stormKey: trackedKey, code: 'US', count: 300, rate: 60,
    lat: 43, lon: -94, city: 'End', date: '2026-09-08',
    originLat: 43, originLon: -94, originCity: 'Start',
    startTime: start - 45 * minute, endTime: start - minute,
    traveledKm: 50, totalCount: 5000, strikes, countryPath: null,
  };
  dbModule.upsertStorms([storm]);
  dbModule.upsertBiggestStorms([storm]);
  dbModule.upsertStormRecords([storm]);
  dbModule.saveTrackedStorms([{
    key: trackedKey, cc: storm.code,
    originLat: storm.originLat, originLon: storm.originLon, originCity: storm.originCity,
    startTime: storm.startTime, lat: storm.lat, lon: storm.lon, city: storm.city,
    peakCount: storm.count, peakRate: storm.rate, traveledKm: storm.traveledKm,
    travelAnchor: { lat: storm.lat, lon: storm.lon }, posBuf: [],
    lastSeen: storm.endTime, currentRate: 60, inDb: true,
    allStrikes: shortState ? strikes.slice(0, 20) : strikes,
    originSample: strikes.slice(0, 20), lastStrikeTime: officialWatermark, totalStrikes: storm.totalCount,
    countryCodes: ['US'], initialStrikesByAncestor: {}, keepEvery: 1, appendSeq: strikes.length,
    splitDetected: false, splitCandidateAt: null, fragmentLabel: null,
  }]);
  return { storm, officialWatermark };
}

async function startTracker() {
  await import('../app/api/strikes/route');
  await vi.advanceTimersByTimeAsync(0);
}

function tracked() {
  return (dbModule.loadTrackedStorms() as Array<Record<string, any>>).find(storm => storm.key === trackedKey)!;
}

function metrics() {
  return replayTables.map(table => {
    const rows = sql.prepare(`SELECT * FROM ${table} ORDER BY storm_key`).all() as Record<string, unknown>[];
    return rows.map(({ strikes: _strikes, ...rest }) => rest);
  });
}

function expectReplayEverywhere(points: StormStrike[]) {
  for (const table of replayTables) {
    const rows = sql.prepare(`SELECT strikes FROM ${table} WHERE storm_key = ?`).all(trackedKey) as { strikes: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const strikes = JSON.parse(row.strikes) as StormStrike[];
      for (const point of points) expect(strikes.filter(saved => JSON.stringify(saved) === JSON.stringify(point))).toHaveLength(1);
    }
  }
}

function feed(point: StormStrike) {
  globals._processStrike(...point);
}

// Keep timestamps distributed across seconds so these fixtures represent real
// lightning rather than the ingestion-backlog burst rejected by the tracker.
function feedQualifiedWindow(from: number): StormStrike[] {
  const points: StormStrike[] = Array.from({ length: 101 }, (_, i) => [43.01, -94, from + i * 190]);
  for (const point of points) feed(point);
  return points;
}

describe('storm replay tails through the real ingestion tracker and SQLite', () => {
  it('persists a weak tail without changing official metrics, then counts requalification once', async () => {
    const { storm, officialWatermark } = seedTrackedStorm();
    await startTracker();
    const before = metrics();
    await vi.advanceTimersByTimeAsync(10_000);
    const fading: StormStrike = [43.01, -94, Date.now()];
    feed(fading);
    await vi.advanceTimersByTimeAsync(20_000);

    expectReplayEverywhere([fading]);
    expect(metrics()).toEqual(before);
    expect(tracked()).toMatchObject({
      lastSeen: storm.endTime, totalStrikes: 5000, lastStrikeTime: officialWatermark,
      currentRate: 0, lastReplayTime: fading[2], replayDirty: false,
    });

    const qualifying = feedQualifiedWindow(start + 10_100);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dbModule.getStormByKey(trackedKey)!.totalCount).toBe(5102);
    expect(tracked().totalStrikes).toBe(5102);
    expectReplayEverywhere([fading, ...qualifying]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dbModule.getStormByKey(trackedKey)!.totalCount).toBe(5102);
    expectReplayEverywhere([fading, ...qualifying]);
  });

  it('continues beyond one hour and through a restart, then stops after ten quiet minutes', async () => {
    const { storm } = seedTrackedStorm();
    await startTracker();
    const before = metrics();
    const fading: StormStrike[] = [];
    for (let pass = 1; pass <= 15; pass++) {
      await vi.advanceTimersByTimeAsync(5 * minute - 1);
      const point: StormStrike = [43.01, -94, Date.now()];
      fading.push(point);
      feed(point);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(tracked()).toMatchObject({ lastSeen: storm.endTime, lastReplayTime: fading.at(-1)![2] });
    expectReplayEverywhere(fading);
    expect(metrics()).toEqual(before);

    // Reimport the actual route, letting its named interval cleanup and SQLite
    // state loader run exactly as they do during an application restart.
    vi.resetModules();
    globals._recentStrikes = [];
    dbModule = await import('../app/lib/db');
    await startTracker();
    await vi.advanceTimersByTimeAsync(4 * minute - 1);
    const afterRestart: StormStrike = [43.02, -94, Date.now()];
    feed(afterRestart);
    await vi.advanceTimersByTimeAsync(1);
    expectReplayEverywhere([...fading, afterRestart]);
    expect(metrics()).toEqual(before);

    await vi.advanceTimersByTimeAsync(11 * minute);
    const unrelated: StormStrike = [43.02, -94, Date.now()];
    feed(unrelated);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dbModule.getStormByKey(trackedKey)!.strikes).not.toContainEqual(unrelated);
    expect(tracked().lastReplayTime).toBe(afterRestart[2]);
    expect(metrics()).toEqual(before);

    // Keeping the old identity in memory for its replay must not let a later
    // dense storm inherit its official lifetime and accumulated count.
    feedQualifiedWindow(Date.now() - 20_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const identities = dbModule.loadTrackedStorms() as Array<Record<string, any>>;
    expect(identities).toHaveLength(2);
    expect(identities.find(st => st.key !== trackedKey)!.totalStrikes).toBe(102);
    expect(tracked().totalStrikes).toBe(5000);
    expect(dbModule.getStormByKey(trackedKey)!.endTime).toBe(storm.endTime);
    expect(metrics().slice(0, 2)).toEqual(before.slice(0, 2));
    expect(dbModule.getStormRecords().every(record => record.stormKey === trackedKey)).toBe(true);
  });

  it('restores a short replay buffer without treating replay-only points as officially counted', async () => {
    const { storm, officialWatermark } = seedTrackedStorm(true);
    const fading: StormStrike = [43.01, -94, start - 20_000];
    dbModule.updateStormReplay(trackedKey, [...storm.strikes!, fading]);
    await startTracker();
    feed(fading);
    const qualifying = feedQualifiedWindow(start - 19_900);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(officialWatermark).toBeLessThan(fading[2]);
    expect(dbModule.getStormByKey(trackedKey)!.totalCount).toBe(5102);
    expectReplayEverywhere([fading, ...qualifying]);
  });
});
