import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { StrikePoint } from '../app/lib/stormClusters';
import type { LifecycleStorm } from '../app/lib/stormLifecycle';
import type { CountingStorm } from '../app/lib/stormCounting';
import type { StormStrike } from '../app/lib/db';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: vi.fn(() => 'IT') }));

type SavedStorm = LifecycleStorm & CountingStorm & { allStrikes: StormStrike[]; keepEvery: number };
type Summary = { key: string; totalStrikes: number; rate: number };

let tmpDir: string;
let db: typeof import('../app/lib/db');
let sql: Database.Database;
let summaries: Summary[];
const globals = globalThis as typeof globalThis & Record<string, any>;
const oldDbPath = process.env.DB_PATH;
const start = Date.UTC(2026, 8, 9, 18);

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-late-strike-test-'));
  process.env.DB_PATH = tmpDir;
  vi.useFakeTimers();
  vi.setSystemTime(start);
  summaries = [];
  globals._recentStrikes = [];
  globals._strikeQueue = [];
  globals._sseControllers = new Set([{ enqueue(bytes: Uint8Array) {
    const text = new TextDecoder().decode(bytes);
    if (text.startsWith('event: storms')) summaries = JSON.parse(text.split('data: ')[1]);
  } }]);
  db = await import('../app/lib/db');
  await import('../app/api/strikes/route');
  sql = new Database(path.join(tmpDir, 'lightning.db'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  sql?.close();
  if (oldDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = oldDbPath;
  for (const key of ['_recentStrikes', '_strikeQueue', '_sseControllers', '_processStrike', '_stormStrikeOwnership']) delete globals[key];
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function points(count: number, time: number, offset = 0): StrikePoint[] {
  return Array.from({ length: count }, (_, i) => ({ lat: 45 + offset + i % 3 * .001, lon: 7 + offset, time: time + i * 100, cc: 'IT' }));
}
function ingest(batch: StrikePoint[]) {
  for (const point of batch) globals._processStrike(point.lat, point.lon, point.time);
}
function replayDuplicateDeliveries(batch: StrikePoint[]) {
  // Transport deduplication is upstream of this route. Replayed buffer copies
  // exercise the storm's own idempotence without changing global ingestion.
  globals._recentStrikes.push(...batch.map(point => ({ ...point })));
}
function saved() { return db.loadTrackedStorms() as SavedStorm[]; }
async function flush() { await vi.advanceTimersByTimeAsync(30_000); }
function expectReplay(storm: SavedStorm, expected: number) {
  expect(storm.keepEvery).toBe(1);
  expect(storm.allStrikes).toHaveLength(expected);
  expect(new Set(storm.allStrikes.map(point => point.join(','))).size).toBe(expected);
}
async function coldRestart() {
  const total = globals._serverTotal;
  globals._recentStrikes = [];
  vi.resetModules();
  await import('../app/api/strikes/route');
  expect(globals._serverTotal).toBe(total);
  expect(globals._recentStrikes.length).toBeGreaterThan(0);
}

it('counts distinct delayed and equal-time strikes once across repeated passes and a cold restart', async () => {
  const initial = points(150, start - 20_000);
  ingest(initial);
  await flush();
  expect(saved()).toHaveLength(1);
  const key = saved()[0].key;
  const originalWatermark = saved()[0].lastStrikeTime;
  expect(saved()[0].totalStrikes).toBe(150);
  expectReplay(saved()[0], 150);

  const delayed = points(100, start - 19_000, .01);
  expect(delayed.every(point => point.time < originalWatermark)).toBe(true);
  ingest(delayed);
  await flush();
  let current = saved()[0];
  expect(globals._serverTotal).toBe(250);
  expect(current.totalStrikes).toBe(250);
  expect(current.currentRate).toBe(50);
  expect(current.lastStrikeTime).toBe(originalWatermark);
  expectReplay(current, 250);
  expect(db.getBiggestStorm('IT')?.totalCount).toBe(250);
  expect(summaries.find(storm => storm.key === key)?.totalStrikes).toBe(250);

  // Different locations at exactly the last accepted timestamp are distinct
  // discharges; replaying an identical location/timestamp is still one strike.
  const equalTime = Array.from({ length: 15 }, (_, i) => ({ lat: 45.02 + i * .001, lon: 7.02, time: originalWatermark, cc: 'IT' }));
  ingest(equalTime);
  replayDuplicateDeliveries([...initial, ...delayed, ...equalTime]);
  await flush();
  current = saved()[0];
  expect(current.totalStrikes).toBe(265);
  expect(current.lastStrikeTime).toBe(originalWatermark);
  expectReplay(current, 265);
  await flush();
  expect(saved()[0].totalStrikes).toBe(265);
  expectReplay(saved()[0], 265);

  await coldRestart();
  replayDuplicateDeliveries([...initial, ...delayed, ...equalTime]);
  await flush();
  expect(saved().map(storm => storm.key)).toEqual([key]);
  expect(saved()[0].totalStrikes).toBe(265);
  expectReplay(saved()[0], 265);

  const afterRestart = points(70, start - 18_000, .03);
  ingest(afterRestart);
  replayDuplicateDeliveries(afterRestart);
  await flush();
  current = saved()[0];
  expect(current.totalStrikes).toBe(335);
  expect(current.currentRate).toBe(67);
  expectReplay(current, 335);
  expect(globals._serverTotal).toBe(335);
  expect(db.loadCounters().total).toBe(335);
  expect((sql.prepare('SELECT COUNT(*) AS count FROM grid_strikes').get() as { count: number }).count).toBe(335);
  expect(summaries.find(storm => storm.key === key)?.totalStrikes).toBe(335);
});

it('counts saved quiet-tail strikes exactly once when the same storm revives after restart', async () => {
  ingest(points(150, start - 20_000));
  await flush();
  const key = saved()[0].key;
  const originalWatermark = saved()[0].lastStrikeTime;

  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(saved()[0].currentRate).toBe(0);
  const quietTail = points(20, Date.now() - 25_000, .01);
  ingest(quietTail);
  await flush();
  const quiet = saved()[0];
  expect(quiet.totalStrikes).toBe(150);
  expect(quiet.lastStrikeTime).toBe(originalWatermark);
  expectReplay(quiet, 170);
  expect(summaries.some(storm => storm.key === key)).toBe(false);

  await coldRestart();
  const revival = points(90, Date.now() - 25_000, .01);
  ingest(revival);
  replayDuplicateDeliveries([...quietTail, ...revival]);
  await flush();
  expect(saved().map(storm => storm.key)).toEqual([key]);
  const revived = saved()[0];
  expect(revived.totalStrikes).toBe(260);
  expect(revived.currentRate).toBe(22);
  expectReplay(revived, 260);
  expect(globals._serverTotal).toBe(260);
  expect(summaries.find(storm => storm.key === key)?.totalStrikes).toBe(260);

  await flush();
  await coldRestart();
  replayDuplicateDeliveries([...quietTail, ...revival]);
  await flush();
  expect(saved()[0].totalStrikes).toBe(260);
  expectReplay(saved()[0], 260);
});
