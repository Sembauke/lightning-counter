import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { StormLifecycleState } from '../app/lib/stormLifecycle';
import type { StormStrike } from '../app/lib/db';

const { countryLookup } = vi.hoisted(() => ({ countryLookup: vi.fn(() => 'IT') }));
vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: countryLookup }));

const globals = globalThis as typeof globalThis & Record<string, any>;
const timerKeys = ['_iv_histPrune', '_iv_dbFlush', '_iv_gridBatch', '_iv_hourly'] as const;
const stateKeys = [
  ...timerKeys, '_routeIntervals', '_processStrike', '_strikeQueue', '_recentStrikes',
  '_sseControllers', '_sseBcastGen', '_serverTotal', '_serverCountryCounts',
  '_todayCounts', '_todayDate', '_stormSeq', '_stormStrikeOwnership',
  '_stormStrikeSubscribers', '_activeSources', '_ingestionReady',
];
const start = Date.UTC(2026, 8, 9, 12);
const oldDbPath = process.env.DB_PATH;
let tmpDir: string;
let sql: Database.Database | undefined;

type SavedStorm = {
  key: string;
  totalStrikes: number;
  allStrikes: StormStrike[];
  lifecycle: StormLifecycleState;
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(start);
  for (const key of stateKeys) delete globals[key];
  globals._strikeQueue = [];
  globals._recentStrikes = [];
  globals._sseControllers = new Set();
  countryLookup.mockReset().mockReturnValue('IT');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-startup-persistence-'));
  process.env.DB_PATH = tmpDir;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sql?.close();
  sql = undefined;
  for (const key of stateKeys) delete globals[key];
  if (oldDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = oldDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function scalar(query: string): number {
  return (sql!.prepare(query).get() as { n: number }).n;
}

it('persists ingestion and storm ownership for twenty minutes after HEAD startup with no SSE visitor', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const route = await import('../app/api/strikes/route');
  const head = await route.HEAD();
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect(head.headers.get('Cache-Control')).toBe('no-store');
  expect(globals._ingestionReady()).toBe(true);
  expect(globals._sseControllers.size).toBe(0);
  expect(globals._processStrike).toEqual(expect.any(Function));
  for (const key of timerKeys) expect(globals[key]).toBeDefined();
  // Drain the database's one-off initialization callback without advancing any
  // periodic maintenance. HEAD itself must not create an SSE heartbeat timer.
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(4);

  const db = await import('../app/lib/db');
  sql = new Database(path.join(tmpDir, 'lightning.db'), { readonly: true });
  const processor = globals._processStrike;
  const timers = timerKeys.map(key => globals[key]);
  for (let i = 0; i < 600; i++) {
    processor(45 + i % 20 * .001, 12 + Math.floor(i / 20) * .001, start - 60_000 + i * 50);
  }
  expect(globals._serverTotal).toBe(600);
  expect(db.loadCounters().total).toBe(0);
  expect(scalar('SELECT COUNT(*) AS n FROM grid_strikes')).toBe(0);

  // A health check must not reinitialize counters from the older database or
  // replace timers while their batches are still waiting to be written.
  for (let i = 0; i < 3; i++) expect((await route.HEAD()).status).toBe(200);
  expect(globals._processStrike).toBe(processor);
  expect(timerKeys.map(key => globals[key])).toEqual(timers);
  expect(vi.getTimerCount()).toBe(4);
  expect(globals._serverTotal).toBe(600);
  expect(globals._sseControllers.size).toBe(0);

  await vi.advanceTimersByTimeAsync(30_000);
  const firstSnapshot = db.loadTrackedStorms() as SavedStorm[];
  expect(firstSnapshot).toHaveLength(1);
  expect(firstSnapshot[0].totalStrikes).toBe(600);
  expect(firstSnapshot[0].lifecycle.members).toHaveLength(600);
  expect(firstSnapshot[0].allStrikes).toHaveLength(600);
  const stormKey = firstSnapshot[0].key;
  expect(globals._stormStrikeOwnership.history(stormKey)).toHaveLength(600);

  await vi.advanceTimersByTimeAsync(20 * 60_000 - 30_000);
  expect(Date.now()).toBe(start + 20 * 60_000);
  expect(globals._sseControllers.size).toBe(0);
  expect(globals._recentStrikes).toHaveLength(0);
  expect(db.loadCounters()).toEqual({ total: 600, countries: { IT: 600 } });
  expect(db.loadDailyStrikes('2026-09-09')).toEqual({ IT: 600 });
  expect(scalar('SELECT COUNT(*) AS n FROM grid_strikes')).toBe(600);
  expect(scalar('SELECT COUNT(*) AS n FROM storm_replay_points')).toBe(600);
  expect(sql.prepare('SELECT DISTINCT storm_key FROM storm_replay_points').all()).toEqual([{ storm_key: stormKey }]);
  const saved = db.loadTrackedStorms() as SavedStorm[];
  expect(saved).toHaveLength(1);
  expect(saved[0].key).toBe(stormKey);
  expect(saved[0].totalStrikes).toBe(600);
  expect(saved[0].allStrikes).toHaveLength(600);
  expect(errors).not.toHaveBeenCalled();

  // The first actual visitor sees the latest in-memory total, including a new
  // strike that has not reached the next durable flush yet.
  processor(45, 12, Date.now());
  const response = await route.GET();
  expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  expect(globals._sseControllers.size).toBe(1);
  expect(vi.getTimerCount()).toBe(5);
  const reader = response.body!.getReader();
  try {
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toMatch(/^event: init\ndata: /);
    const init = JSON.parse(firstChunk.split('\ndata: ')[1].trim());
    expect(init).toEqual({ total: 601, countries: { IT: 601 } });
    expect(db.loadCounters().total).toBe(600);
  } finally {
    await reader.cancel();
  }
  expect(globals._sseControllers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(4);
  expect(timerKeys.map(key => globals[key])).toEqual(timers);
}, 15_000);

it('initializes every persistence timer before draining strikes queued during startup', async () => {
  globals._strikeQueue = [{ lat: 45, lon: 12, time: start - 1000 }];
  const readyWhenProcessed: boolean[] = [];
  countryLookup.mockImplementation(() => {
    readyWhenProcessed.push(timerKeys.every(key => globals[key] !== undefined));
    return 'IT';
  });
  const route = await import('../app/api/strikes/route');
  expect((await route.HEAD()).status).toBe(200);
  expect(readyWhenProcessed).toEqual([true]);
  expect(globals._strikeQueue).toEqual([]);
  expect(globals._serverTotal).toBe(1);
  expect(globals._sseControllers.size).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  const db = await import('../app/lib/db');
  expect(db.loadCounters()).toEqual({ total: 1, countries: { IT: 1 } });
  sql = new Database(path.join(tmpDir, 'lightning.db'), { readonly: true });
  expect(scalar('SELECT COUNT(*) AS n FROM grid_strikes')).toBe(1);
});

it('reports not ready when the processor is replaced or an owned maintenance timer is destroyed', async () => {
  const route = await import('../app/api/strikes/route');
  expect(globals._ingestionReady()).toBe(true);
  const processor = globals._processStrike;
  globals._processStrike = () => {};
  try {
    expect(globals._ingestionReady()).toBe(false);
    const head = await route.HEAD();
    expect(head.status).toBe(503);
    expect(await head.text()).toBe('');
  } finally {
    globals._processStrike = processor;
  }
  expect((await route.HEAD()).status).toBe(200);

  // Node marks cleared Timeout objects as destroyed. Preserve the exact timer
  // identity while simulating that state; identity checks alone cannot detect it.
  const timer = globals._iv_gridBatch;
  const priorDestroyed = timer._destroyed;
  timer._destroyed = true;
  try {
    expect(globals._ingestionReady()).toBe(false);
    expect((await route.HEAD()).status).toBe(503);
  } finally {
    if (priorDestroyed === undefined) delete timer._destroyed;
    else timer._destroyed = priorDestroyed;
  }
  expect(globals._ingestionReady()).toBe(true);
  expect((await route.HEAD()).status).toBe(200);
  expect(globals._sseControllers.size).toBe(0);
});
