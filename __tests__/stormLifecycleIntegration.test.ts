import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { LifecycleStorm } from '../app/lib/stormLifecycle';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: vi.fn(() => 'IT') }));

let tmpDir: string;
let db: typeof import('../app/lib/db');
let route: typeof import('../app/api/strikes/route');
let sql: Database.Database;
const globals = globalThis as typeof globalThis & Record<string, any>;
const start = Date.UTC(2026, 8, 9, 8);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-lifecycle-test-'));
  process.env.DB_PATH = tmpDir;
  vi.useFakeTimers();
  vi.setSystemTime(start);
  globals._recentStrikes = [];
  globals._strikeQueue = [];
  globals._sseControllers = new Set();
  db = await import('../app/lib/db');
  route = await import('../app/api/strikes/route');
  sql = new Database(path.join(tmpDir, 'lightning.db'));
});

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  sql.close();
  delete process.env.DB_PATH;
  for (const key of ['_recentStrikes', '_strikeQueue', '_sseControllers', '_processStrike', '_stormStrikeOwnership']) delete globals[key];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function feed(lon: number, count = 90) {
  for (let i = 0; i < count; i++) globals._processStrike(45 + i % 3 * .0001, lon, Date.now() - 25_000 + i * 100);
}
function saved() { return db.loadTrackedStorms() as Array<LifecycleStorm & { initialStrikesByAncestor: Record<string, number>; allStrikes: number[][] }> }
function events(kind: string) { return (sql.prepare('SELECT COUNT(*) AS n FROM storm_events WHERE event_type = ?').get(kind) as { n: number }).n }
async function tick(joined = false) {
  feed(7); feed(7.6);
  if (joined) { feed(7.15, 30); feed(7.3, 30); feed(7.45, 30); }
  await vi.advanceTimersByTimeAsync(30_000);
}

it('the actual tracking route confirms split/merge once, preserves counts/replays and publishes matching SSE state', async () => {
  for (const lon of [7, 7.15, 7.3, 7.45, 7.6]) feed(lon, 120);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(saved()).toHaveLength(1);
  const parentKey = saved()[0].key;
  let pending = saved()[0].lifecycle!.transitions[0];
  for (let i = 0; i < 24 && !pending; i++) {
    await tick();
    pending = saved()[0].lifecycle!.transitions[0];
  }
  expect(pending?.kind).toBe('split');
  const splitDeadline = pending.confirmAt;
  while (Date.now() < splitDeadline - 30_000) {
    expect(saved()).toHaveLength(1);
    expect(events('split')).toBe(0);
    await tick();
  }
  expect(events('split')).toBe(0);
  await tick();
  let storms = saved();
  expect(storms).toHaveLength(2);
  expect(storms.some(s => s.key === parentKey)).toBe(true);
  expect(events('split')).toBe(1);
  const child = storms.find(s => s.key !== parentKey)!;
  expect(child.initialStrikesByAncestor[parentKey]).toBeGreaterThan(0);
  const effective = storms.reduce((sum, s) => sum + s.totalStrikes, 0) - child.initialStrikesByAncestor[parentKey];
  expect(effective).toBe(globals._serverTotal);

  await tick(true);
  storms = saved();
  expect(storms).toHaveLength(2);
  const mergeDeadline = storms[0].lifecycle!.transitions[0].confirmAt;
  expect(storms[0].lifecycle!.transitions[0].kind).toBe('merge');
  // Restart with an empty ingestion buffer; persisted observation ownership
  // must restore the same pending contact without counting its history again.
  const oceanPoint = storms[0].lifecycle!.members.find(p => p.time > Date.now() - 60_000)!;
  oceanPoint.cc = null;
  const legacyPoint = storms[0].lifecycle!.members.find(p => p !== oceanPoint && p.time > Date.now() - 60_000)!;
  delete legacyPoint.cc;
  const countryLookup = vi.mocked((await import('../app/lib/geoCountry')).getCountryCode);
  countryLookup.mockReturnValueOnce(null);
  const lookupsBeforeReload = countryLookup.mock.calls.length;
  db.saveTrackedStorms(storms);
  globals._recentStrikes = [];
  vi.resetModules();
  route = await import('../app/api/strikes/route');
  expect(globals._recentStrikes.find((p: { lat: number; lon: number; time: number }) => p.lat === oceanPoint.lat && p.lon === oceanPoint.lon && p.time === oceanPoint.time)?.cc).toBeNull();
  expect(globals._recentStrikes.find((p: { lat: number; lon: number; time: number }) => p.lat === legacyPoint.lat && p.lon === legacyPoint.lon && p.time === legacyPoint.time)?.cc).toBeNull();
  expect(countryLookup.mock.calls.length - lookupsBeforeReload).toBe(1);
  await tick(true);
  expect((sql.prepare("SELECT rate FROM country_peak_rates WHERE code = 'XO'").get() as { rate: number }).rate).toBeGreaterThan(0);
  expect(saved()).toHaveLength(2);
  expect(saved()[0].lifecycle!.transitions[0].confirmAt).toBe(mergeDeadline);
  while (Date.now() < mergeDeadline - 30_000) {
    expect(events('merge')).toBe(0);
    await tick(true);
  }
  expect(events('merge')).toBe(0);
  await tick(true);
  storms = saved();
  expect(storms).toHaveLength(1);
  expect(storms[0].key).toBe(parentKey);
  expect(events('merge')).toBe(1);
  expect(storms[0].totalStrikes).toBe(globals._serverTotal);
  expect(new Set(storms[0].allStrikes.map(p => p.join(','))).size).toBe(storms[0].allStrikes.length);
  expect(storms[0].allStrikes.some(p => p[1] === 7)).toBe(true);
  expect(storms[0].allStrikes.some(p => p[1] === 7.6)).toBe(true);
  expect(db.getStormByKey(parentKey)).not.toBeNull();
  expect(db.getStormByKey(child.key)?.stormKey).toBe(parentKey);
  expect(sql.prepare('SELECT event_type FROM storm_events WHERE storm_key = ?').all(parentKey)).toHaveLength(2);

  const response = await route.GET();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let initial: any[] | undefined;
  for (let i = 0; i < 3; i++) {
    const text = decoder.decode((await reader.read()).value);
    if (text.startsWith('event: storms')) initial = JSON.parse(text.split('data: ')[1]);
  }
  expect(initial?.map(s => s.key)).toEqual([parentKey]);
  expect(initial?.[0].outline).toEqual(storms[0].lifecycle!.outline);
  expect(initial?.[0].transitions).toEqual([]);
  let periodic: any[] | undefined;
  const controller = { enqueue(bytes: Uint8Array) {
    const text = decoder.decode(bytes);
    if (text.startsWith('event: storms')) periodic = JSON.parse(text.split('data: ')[1]);
  } };
  globals._sseControllers.add(controller);
  await tick(true);
  expect(periodic?.map(s => s.key)).toEqual(initial?.map(s => s.key));
  expect(periodic?.[0].transitions).toEqual([]);
  expect(saved()[0].totalStrikes).toBe(globals._serverTotal);
  await reader.cancel();
  globals._sseControllers.delete(controller);
}, 30_000);

it('tracks a footprint across the date line at its physical longitude', async () => {
  // These are about eight km apart at45°N, not opposite ends of the world.
  feed(179.95, 120); feed(-179.95, 120);
  await vi.advanceTimersByTimeAsync(30_000);
  const ocean = saved().find(st => Math.abs(st.lon) > 170);
  expect(ocean).toBeDefined();
  expect(Math.abs(ocean!.lon)).toBeGreaterThan(179.9);
  expect(ocean!.currentRate).toBe(48);
  expect(ocean!.lifecycle!.transitions).toEqual([]);
  const key = ocean!.key;
  feed(179.96, 120); feed(-179.96, 120);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(saved().filter(st => Math.abs(st.lon) > 170).map(st => st.key)).toEqual([key]);
});
