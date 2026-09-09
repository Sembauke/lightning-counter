import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { mergeStormCounting, type CountingStorm } from '../app/lib/stormCounting';
import type { LifecycleStorm } from '../app/lib/stormLifecycle';
import { STORM_DISTANT_SPLIT_MS, STORM_TRANSITION_MS } from '../app/lib/stormTransition';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: vi.fn(() => 'IT') }));

type SavedStorm = LifecycleStorm & CountingStorm & {
  allStrikes: Array<[number, number, number]>;
  fragmentLabel: string | null;
};
type StormSummary = { key: string; transitions: NonNullable<LifecycleStorm['lifecycle']>['transitions'] };

let tmpDir: string;
let db: typeof import('../app/lib/db');
let route: typeof import('../app/api/strikes/route');
let sql: Database.Database;
let periodic: StormSummary[] = [];
const globals = globalThis as typeof globalThis & Record<string, any>;
const oldDbPath = process.env.DB_PATH;
const start = Date.UTC(2026, 8, 9, 16);
const decoder = new TextDecoder();
const controller = { enqueue(bytes: Uint8Array) {
  const text = decoder.decode(bytes);
  if (text.startsWith('event: storms')) periodic = JSON.parse(text.split('data: ')[1]);
} };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-distant-split-test-'));
  process.env.DB_PATH = tmpDir;
  vi.useFakeTimers();
  vi.setSystemTime(start);
  globals._recentStrikes = [];
  globals._strikeQueue = [];
  globals._sseControllers = new Set([controller]);
  db = await import('../app/lib/db');
  route = await import('../app/api/strikes/route');
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
  for (let i = 0; i < count; i++) globals._processStrike(45 + i % 3 * .0001, lon, Date.now() - 25_000 + i * 100);
}
async function tick() {
  feed(7); feed(7.6); feed(10.5);
  await vi.advanceTimersByTimeAsync(30_000);
}
function saved() { return db.loadTrackedStorms() as SavedStorm[]; }
function splitEvents() {
  return sql.prepare("SELECT storm_key, related_key FROM storm_events WHERE event_type = 'split' ORDER BY id").all() as Array<{ storm_key: string; related_key: string }>;
}
function expectExactUnion(storms: SavedStorm[]) {
  const copies = structuredClone(storms);
  for (const child of copies.slice(1)) mergeStormCounting(copies[0], child);
  expect(copies[0].totalStrikes).toBe(globals._serverTotal);
  // This fixture stays below replay thinning and never feeds a fading tail.
  // The physical point union independently verifies the provenance union.
  const physicalIds = new Set(storms.flatMap(st => st.allStrikes.map(p => p.join(','))));
  expect(physicalIds.size).toBe(globals._serverTotal);
  for (const st of storms) expect(new Set(st.allStrikes.map(p => p.join(','))).size).toBe(st.allStrikes.length);
}
async function initialSummaries() {
  const response = await route.GET();
  const reader = response.body!.getReader();
  let summaries: StormSummary[] | undefined;
  for (let i = 0; i < 3; i++) {
    const text = decoder.decode((await reader.read()).value);
    if (text.startsWith('event: storms')) summaries = JSON.parse(text.split('data: ')[1]);
  }
  await reader.cancel();
  expect(summaries).toBeDefined();
  return summaries!;
}

it('the actual route separates a distant group after one minute, survives restart, and finishes the nearby hold without losing counts or replay', async () => {
  // The storm first forms as one supported physical outline. Once the old
  // bridge expires, its two nearby western cells and far eastern cell remain.
  for (let i = 0; i <= 23; i++) feed(Number((7 + i * .15).toFixed(2)), 120);
  feed(10.5, 120);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(saved()).toHaveLength(1);
  const parentKey = saved()[0].key;
  const originalReplay = new Set(saved()[0].allStrikes.map(p => p.join(',')));

  for (let i = 0; i < 24 && !saved()[0].lifecycle!.transitions.length; i++) await tick();
  let parent = saved()[0];
  const distant = parent.lifecycle!.transitions[0];
  expect(distant?.kind).toBe('split');
  expect(distant.confirmAt - distant.startedAt).toBe(STORM_DISTANT_SPLIT_MS);
  const normalDeadline = parent.lifecycle!.splitTransition!.confirmAt;
  expect(normalDeadline - distant.startedAt).toBe(STORM_TRANSITION_MS);
  expect(parent.lifecycle!.distantSplit!.branches).toHaveLength(2);
  expect(parent.lifecycle!.splitBranches).toHaveLength(3);
  expect(splitEvents()).toEqual([]);
  expect(periodic.map(st => st.key)).toEqual([parentKey]);
  expect((await initialSummaries())[0].transitions).toEqual([distant]);
  expectExactUnion(saved());

  await tick();
  expect(Date.now()).toBe(distant.confirmAt - 30_000);
  expect(saved()).toHaveLength(1);
  expect(splitEvents()).toEqual([]);
  expect(periodic.map(st => st.key)).toEqual([parentKey]);
  const countBeforeRestart = globals._serverTotal;
  const persistedBeforeRestart = saved()[0];
  globals._recentStrikes = [];
  vi.resetModules();
  route = await import('../app/api/strikes/route');
  expect(globals._serverTotal).toBe(countBeforeRestart);
  expect(globals._recentStrikes.length).toBeGreaterThan(0);
  expect(saved()[0].counting).toEqual(persistedBeforeRestart.counting);
  const initial = await initialSummaries();
  expect(initial.map(st => st.key)).toEqual([parentKey]);
  expect(initial[0].transitions[0].confirmAt).toBe(distant.confirmAt);

  await tick();
  let storms = saved();
  expect(Date.now()).toBe(distant.confirmAt);
  expect(storms).toHaveLength(2);
  parent = storms.find(st => st.key === parentKey)!;
  const far = storms.find(st => st.key !== parentKey)!;
  const farKey = far.key;
  expect(parent.lon).toBeCloseTo(7.3, 2);
  expect(far.lon).toBeCloseTo(10.5, 2);
  expect(far.fragmentLabel).toBe('F1');
  expect(far.lifecycle!.transitions).toEqual([]);
  expect(parent.lifecycle!.transitions[0].confirmAt).toBe(normalDeadline);
  expect(parent.lifecycle!.transitions[0].startedAt).toBe(distant.startedAt);
  expect(splitEvents()).toEqual([{ storm_key: parentKey, related_key: farKey }]);
  expect(periodic.map(st => st.key).sort()).toEqual([parentKey, farKey].sort());
  expect(periodic.find(st => st.key === parentKey)!.transitions).toEqual(parent.lifecycle!.transitions);
  expect(periodic.find(st => st.key === farKey)!.transitions).toEqual([]);
  expectExactUnion(storms);
  expect(far.allStrikes.every(p => p[1] === 10.5)).toBe(true);
  const retainedReplay = new Set(parent.allStrikes.map(p => p.join(',')));
  for (const id of originalReplay) expect(retainedReplay.has(id)).toBe(true);

  while (Date.now() < normalDeadline - 30_000) {
    await tick();
    expect(saved()).toHaveLength(2);
    expect(splitEvents()).toHaveLength(1);
    expect(saved().find(st => st.key === parentKey)!.lifecycle!.transitions[0].confirmAt).toBe(normalDeadline);
  }
  await tick();
  storms = saved();
  expect(Date.now()).toBe(normalDeadline);
  expect(storms).toHaveLength(3);
  const nearbyChild = storms.find(st => st.key !== parentKey && st.key !== farKey)!;
  expect(nearbyChild.lon).toBeCloseTo(7.6, 2);
  expect(nearbyChild.fragmentLabel).toBe('F2');
  expect(splitEvents()).toEqual([
    { storm_key: parentKey, related_key: farKey },
    { storm_key: parentKey, related_key: nearbyChild.key },
  ]);
  expect(periodic.map(st => st.key).sort()).toEqual(storms.map(st => st.key).sort());
  expect(periodic.every(st => st.transitions.length === 0)).toBe(true);
  expectExactUnion(storms);
  expect(nearbyChild.allStrikes.every(p => p[1] === 7.6)).toBe(true);

  await tick();
  expect(saved()).toHaveLength(3);
  expect(splitEvents()).toHaveLength(2);
  expectExactUnion(saved());
}, 30_000);
