import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { LifecycleStorm } from '../app/lib/stormLifecycle';
import type { StormStrike } from '../app/lib/db';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: vi.fn(() => 'IT') }));

type SavedStorm = LifecycleStorm & { allStrikes: StormStrike[]; lastReplayTime: number };
let tmpDir: string;
let db: typeof import('../app/lib/db');
let sql: Database.Database;
const globals = globalThis as typeof globalThis & Record<string, any>;
const oldDbPath = process.env.DB_PATH;
const start = Date.UTC(2026, 8, 9, 18);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-replay-ownership-test-'));
  process.env.DB_PATH = tmpDir;
  vi.useFakeTimers();
  vi.setSystemTime(start);
  globals._recentStrikes = [];
  globals._strikeQueue = [];
  globals._sseControllers = new Set();
  db = await import('../app/lib/db');
  await import('../app/api/strikes/route');
  sql = new Database(path.join(tmpDir, 'lightning.db'));
});

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  sql?.close();
  if (oldDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = oldDbPath;
  for (const key of ['_recentStrikes', '_strikeQueue', '_sseControllers', '_processStrike', '_stormStrikeOwnership']) delete globals[key];
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function feed(lon: number, count = 90) {
  const points: StormStrike[] = [];
  for (let i = 0; i < count; i++) {
    const lat = 45 + i % 3 * .001, time = Date.now() - 25_000 + i * 100;
    globals._processStrike(lat, lon, time);
    points.push([lat, lon, time]);
  }
  return points;
}
async function tick(joined = false) {
  feed(7); feed(9);
  if (joined) for (let i = 1; i < 10; i++) feed(Number((7 + i * .2).toFixed(1)), 30);
  await vi.advanceTimersByTimeAsync(30_000);
}
function saved() { return db.loadTrackedStorms() as SavedStorm[]; }
function owned(key: string): StormStrike[] {
  const rows = sql.prepare('SELECT lat_milli, lon_milli, strike_time FROM storm_replay_points WHERE storm_key = ? ORDER BY strike_time, lat_milli, lon_milli')
    .all(key) as Array<{ lat_milli: number; lon_milli: number; strike_time: number }>;
  return rows.map(row => [row.lat_milli / 1000, row.lon_milli / 1000, row.strike_time]);
}
function ids(points: StormStrike[]) { return new Set(points.map(point => point.join(','))); }

it('persists actual replay membership through split seeds, confirmed merges, fading tails and restart', async () => {
  // Initially one continuous outline. Both ends keep firing while the old
  // bridge expires, leaving a distant split with ten minutes of branch anchors.
  for (let i = 0; i <= 10; i++) feed(Number((7 + i * .2).toFixed(1)), 120);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(saved()).toHaveLength(1);
  const parentKey = saved()[0].key;
  const initialIds = ids(owned(parentKey));
  expect(initialIds.size).toBe(1320);

  for (let i = 0; i < 24 && !saved()[0].lifecycle!.transitions.length; i++) await tick();
  const split = saved()[0].lifecycle!.transitions[0];
  expect(split?.kind).toBe('split');
  expect(split.confirmAt - split.startedAt).toBe(60_000);
  while (Date.now() < split.confirmAt) await tick();
  let storms = saved();
  expect(storms).toHaveLength(2);
  const child = storms.find(storm => storm.key !== parentKey)!;
  const childKey = child.key;
  const childSeed = owned(childKey);
  expect(childSeed.length).toBeGreaterThan(0);
  expect(child.lifecycle!.members.some(point => point.time <= Date.now() - 5 * 60_000)).toBe(true);
  expect(childSeed.every(point => point[2] > Date.now() - 5 * 60_000)).toBe(true);
  expect(ids(childSeed)).toEqual(ids(child.allStrikes));
  expect(childSeed.every(point => point[1] === 9)).toBe(true);
  const parentHistory = ids(owned(parentKey));
  for (const id of initialIds) expect(parentHistory.has(id)).toBe(true);

  await tick(true);
  const pending = saved()[0].lifecycle!.transitions[0];
  expect(pending.kind).toBe('merge');
  expect(owned(parentKey).length).toBeGreaterThan(0);
  expect(owned(childKey).length).toBeGreaterThan(0);
  while (Date.now() < pending.confirmAt - 30_000) await tick(true);
  const beforeMergeIds = ids([...owned(parentKey), ...owned(childKey)]);
  await tick(true);
  storms = saved();
  expect(storms).toHaveLength(1);
  const canonicalKey = storms[0].key;
  const absorbedKey = canonicalKey === parentKey ? childKey : parentKey;
  expect(db.resolveStormKey(absorbedKey)).toBe(canonicalKey);
  expect(owned(absorbedKey)).toEqual([]);
  const mergedIds = ids(owned(canonicalKey));
  for (const id of beforeMergeIds) expect(mergedIds.has(id)).toBe(true);
  expect(mergedIds).toEqual(ids(storms[0].allStrikes));

  // Once its five-minute rate window is empty, only the accepted nearby quiet
  // continuation is owned. Neither it nor a distant background point adds an
  // official storm count or advances the official end time.
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  const quiet = saved()[0];
  expect(quiet.currentRate).toBe(0);
  const totalBeforeTail = quiet.totalStrikes, endBeforeTail = quiet.lastSeen;
  const [tail] = feed(7.01, 1);
  const [background] = feed(30, 1);
  await vi.advanceTimersByTimeAsync(30_000);
  const continued = saved()[0];
  expect(continued.totalStrikes).toBe(totalBeforeTail);
  expect(continued.lastSeen).toBe(endBeforeTail);
  expect(continued.allStrikes).toContainEqual(tail);
  expect(owned(canonicalKey)).toContainEqual(tail);
  expect(owned(canonicalKey)).not.toContainEqual(background);

  const durable = owned(canonicalKey);
  globals._recentStrikes = [];
  vi.resetModules();
  await import('../app/api/strikes/route');
  expect(owned(canonicalKey)).toEqual(durable);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(owned(canonicalKey)).toEqual(durable);
  expect(saved()[0].totalStrikes).toBe(totalBeforeTail);
}, 30_000);
