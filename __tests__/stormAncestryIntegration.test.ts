import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildStormFootprint } from '../app/lib/stormFootprint';
import type { StrikePoint } from '../app/lib/stormClusters';
import type { LifecycleStorm } from '../app/lib/stormLifecycle';
import type { BiggestStorm, StormStrike } from '../app/lib/db';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: vi.fn(() => 'IT') }));

type SavedStorm = LifecycleStorm & {
  cc: string;
  city: string | null;
  startTime: number;
  initialStrikesByAncestor: Record<string, number>;
  allStrikes: StormStrike[];
  keepEvery: number;
};

let tmpDir: string;
let db: typeof import('../app/lib/db');
let sql: Database.Database;
const globals = globalThis as typeof globalThis & Record<string, any>;
const start = Date.UTC(2026, 8, 9, 12);
const ancestorKey = 'IT:ancestor';
const parentKey = 'IT:parent';
const oldDbPath = process.env.DB_PATH;

function points(lon: number, time: number, count: number, spacing = 100): StrikePoint[] {
  return Array.from({ length: count }, (_, i) => ({ lat: 45 + i % 3 * .001, lon, time: time + i * spacing, cc: 'IT' }));
}
function tuple(p: StrikePoint): StormStrike { return [p.lat, p.lon, p.time]; }
function ids(strikes: StormStrike[]) { return new Set(strikes.map(p => p.join(','))); }
function saved() { return db.loadTrackedStorms() as SavedStorm[]; }
function events(kind: string) {
  return sql.prepare('SELECT storm_key, related_key FROM storm_events WHERE event_type = ? ORDER BY id').all(kind) as Array<{ storm_key: string; related_key: string }>;
}
function feed(lon: number, count: number) {
  for (let i = 0; i < count; i++) globals._processStrike(45 + i % 3 * .001, lon, Date.now() - 25_000 + i * 60);
}
async function tick(joined = false, reuniteParent = false) {
  feed(7, 60);
  feed(7.6, joined ? 300 : 60);
  feed(9, 60);
  if (joined) for (const lon of [7.75, 7.9, 8.05, 8.2, 8.35, 8.5, 8.65, 8.8, 8.95]) feed(lon, 15);
  if (reuniteParent) for (const lon of [7.15, 7.3, 7.45]) feed(lon, 15);
  await vi.advanceTimersByTimeAsync(30_000);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-ancestry-test-'));
  process.env.DB_PATH = tmpDir;
  vi.useFakeTimers();
  vi.setSystemTime(start);
  globals._recentStrikes = [];
  globals._strikeQueue = [];
  globals._sseControllers = new Set();

  // A and B have genuinely shared history from an earlier split. Every strike
  // in B's current eastern branch occurred later and is absent from A.
  const shared = points(8, start - 20 * 60_000, 100);
  const privateHistory = points(9, start - 4 * 60 * 60_000, 5000, 2500);
  const aCurrent = points(9, start - 60_000, 150);
  const bCurrent = [...points(7, start - 60_000, 150), ...points(7.6, start - 60_000, 150)];
  function fixture(key: string, members: StrikePoint[], history: StrikePoint[]) {
    const all = [...history, ...members].sort((a, b) => a.time - b.time);
    const lat = 45.001;
    const lon = members.reduce((sum, p) => sum + p.lon, 0) / members.length;
    return {
      key, cc: 'IT', originLat: all[0].lat, originLon: all[0].lon, originCity: key,
      startTime: all[0].time, lat, lon, city: key, peakCount: members.length,
      peakRate: members.length / 5, traveledKm: 0, travelAnchor: { lat, lon }, posBuf: [],
      lastSeen: start, currentRate: members.length / 5, inDb: key === ancestorKey,
      allStrikes: all.map(tuple), originSample: all.slice(0, 200).map(tuple),
      lastStrikeTime: all[all.length - 1].time, totalStrikes: all.length, countryCodes: ['IT'],
      initialStrikesByAncestor: {} as Record<string, number>, keepEvery: 1, appendSeq: all.length,
      splitDetected: false, splitCandidateAt: null, fragmentLabel: null,
      replayAnchors: members.map(tuple), lastReplayTime: Math.max(...members.map(p => p.time)),
      lifecycle: { members, supportMembers: members, outline: buildStormFootprint(members, { lat, lon }), observedAt: start, transitions: [] },
    };
  }
  const ancestor = fixture(ancestorKey, aCurrent, [...privateHistory, ...shared]);
  const parent = fixture(parentKey, bCurrent, shared);
  parent.initialStrikesByAncestor[ancestorKey] = shared.length;

  db = await import('../app/lib/db');
  const initialUnique = ids([...ancestor.allStrikes, ...parent.allStrikes]).size;
  db.saveCounters(initialUnique, { IT: initialUnique });
  db.saveTrackedStorms([ancestor, parent]);
  // Only A is already in the public storm log. The stronger grandchild must
  // eventually inherit this canonical URL when their merge is confirmed.
  const logged: BiggestStorm = {
    code: 'IT', count: ancestor.peakCount, rate: ancestor.peakRate,
    lat: ancestor.lat, lon: ancestor.lon, city: ancestor.city,
    date: new Date(start).toISOString().slice(0, 10),
    originLat: ancestor.originLat, originLon: ancestor.originLon, originCity: ancestor.originCity,
    startTime: ancestor.startTime, endTime: ancestor.lastSeen, stormKey: ancestorKey,
    traveledKm: 0, totalCount: ancestor.totalStrikes, strikes: ancestor.allStrikes, countryPath: ['IT'],
  };
  db.upsertStorms([logged]);
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

it('counts a later grandchild exactly through real split, restart, merge confirmation and canonical key adoption', async () => {
  await tick();
  const split = saved().find(st => st.key === parentKey)!.lifecycle!.transitions.find(t => t.kind === 'split');
  expect(split).toBeDefined();
  while (Date.now() < split!.confirmAt) {
    expect(events('split')).toHaveLength(0);
    await tick();
  }
  let storms = saved();
  expect(storms).toHaveLength(3);
  expect(events('split')).toEqual([{ storm_key: parentKey, related_key: expect.any(String) }]);
  const child = storms.find(st => st.key !== ancestorKey && st.key !== parentKey)!;
  expect(child.lon).toBeCloseTo(7.6, 2);
  const childKey = child.key;
  const ancestorIds = ids(storms.find(st => st.key === ancestorKey)!.allStrikes);
  expect(child.allStrikes.filter(p => ancestorIds.has(p.join(',')))).toHaveLength(0);
  expect(child.initialStrikesByAncestor[parentKey]).toBeGreaterThan(0);

  await tick(true);
  storms = saved();
  const pending = storms.find(st => st.key === childKey)!.lifecycle!.transitions.find(t => t.kind === 'merge');
  expect(pending?.stormKeys).toEqual([ancestorKey, childKey].sort());
  expect(events('merge')).toHaveLength(0);
  const mergeDeadline = pending!.confirmAt;

  // Persist and reload while the real contact timer is still running. This
  // also tests that ancestry survives losing the process's ingestion buffer.
  await tick(true);
  await tick(true);
  const countBeforeRestart = globals._serverTotal;
  globals._recentStrikes = [];
  vi.resetModules();
  await import('../app/api/strikes/route');
  expect(globals._serverTotal).toBe(countBeforeRestart);
  expect(globals._recentStrikes.length).toBeGreaterThan(0);

  while (Date.now() < mergeDeadline - 30_000) {
    expect(events('merge')).toHaveLength(0);
    await tick(true);
    expect(saved().find(st => st.key === childKey)!.lifecycle!.transitions.find(t => t.kind === 'merge')?.confirmAt).toBe(mergeDeadline);
  }
  storms = saved();
  const beforeChild = storms.find(st => st.key === childKey)!;
  const beforeAncestor = storms.find(st => st.key === ancestorKey)!;
  expect(beforeChild.peakCount).toBeGreaterThan(beforeAncestor.peakCount);
  expect(beforeChild.inDb).toBe(false);
  expect(beforeAncestor.inDb).toBe(true);
  expect(events('merge')).toHaveLength(0);
  await tick(true);

  storms = saved();
  expect(storms.map(st => st.key).sort()).toEqual([ancestorKey, parentKey].sort());
  const merged = storms.find(st => st.key === ancestorKey)!;
  expect(merged.keepEvery).toBe(1);
  const mergedIds = ids(merged.allStrikes);
  expect(merged.allStrikes).toHaveLength(mergedIds.size);
  // All fixture strikes were officially counted and the replay was never
  // thinned, so its set of physical IDs is an independent exact count oracle.
  // The old inherited-scalar logic subtracts 100 nonexistent shared strikes.
  expect(merged.totalStrikes).toBe(mergedIds.size);
  expect(merged.totalStrikes).toBeGreaterThan(beforeChild.totalStrikes + beforeAncestor.totalStrikes);
  for (const id of ancestorIds) expect(mergedIds.has(id)).toBe(true);
  expect(events('merge')).toEqual([{ storm_key: ancestorKey, related_key: childKey }]);
  expect(db.getStormByKey(childKey)?.stormKey).toBe(ancestorKey);
  expect(db.getStormByKey(ancestorKey)?.totalCount).toBe(merged.totalStrikes);

  // A further flush must not apply the ancestry correction or event twice.
  await tick(true);
  const continued = saved().find(st => st.key === ancestorKey)!;
  expect(continued.totalStrikes).toBe(ids(continued.allStrikes).size);
  expect(events('merge')).toHaveLength(1);

  // B later rejoins the canonical A/C identity. Here the overlap is real:
  // both the 100 old shared strikes and B's pre-split eastern branch must be
  // counted once, even after their history has aged beyond the live window.
  const remainingParent = saved().find(st => st.key === parentKey)!;
  const continuedIds = ids(continued.allStrikes);
  const genuineOverlap = remainingParent.allStrikes.filter(p => continuedIds.has(p.join(','))).length;
  expect(genuineOverlap).toBeGreaterThan(100);
  await tick(true, true);
  const reunion = saved().find(st => st.key === parentKey)!.lifecycle!.transitions.find(t => t.kind === 'merge');
  expect(reunion?.stormKeys).toEqual([ancestorKey, parentKey].sort());
  while (Date.now() < reunion!.confirmAt) {
    expect(events('merge')).toHaveLength(1);
    await tick(true, true);
  }
  const reunited = saved();
  expect(reunited).toHaveLength(1);
  expect(reunited[0].key).toBe(ancestorKey);
  expect(reunited[0].keepEvery).toBe(1);
  expect(reunited[0].totalStrikes).toBe(ids(reunited[0].allStrikes).size);
  expect(reunited[0].totalStrikes).toBe(globals._serverTotal);
  expect(events('merge')).toEqual([
    { storm_key: ancestorKey, related_key: childKey },
    { storm_key: ancestorKey, related_key: parentKey },
  ]);
  expect(db.getStormByKey(childKey)?.stormKey).toBe(ancestorKey);
  expect(db.getStormByKey(parentKey)?.stormKey).toBe(ancestorKey);
}, 30_000);
