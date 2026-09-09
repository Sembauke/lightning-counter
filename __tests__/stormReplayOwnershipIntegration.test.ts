import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectStormFootprints, footprintContact } from '../app/lib/stormFootprint';
import type { BiggestStorm, StormStrike } from '../app/lib/db';

let db: typeof import('../app/lib/db');
let sql: Database.Database;
let tmpDir: string;
const oldDbPath = process.env.DB_PATH;
const now = Date.now();
const strikeTime = now - 2 * 60 * 60_000;
const tables = ['storms', 'country_biggest_storms', 'storm_records'];

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-replay-ownership-test-'));
  process.env.DB_PATH = tmpDir;
  db = await import('../app/lib/db');
  db.getStormByKey('__init__');
  await new Promise<void>(resolve => setImmediate(resolve));
  sql = new Database(path.join(tmpDir, 'lightning.db'));
});

afterEach(() => {
  sql?.close();
  if (oldDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = oldDbPath;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function points(lon: number): StormStrike[] {
  return Array.from({ length: 200 }, (_, i) => [45 + i % 3 * .001, lon, strikeTime + i * 500]);
}
function record(key: string, strikes: StormStrike[]): BiggestStorm {
  return { stormKey: key, code: 'IT', count: 200, rate: 40, lat: 45.001, lon: strikes[0][1],
    city: key, date: new Date(strikeTime).toISOString().slice(0, 10),
    originLat: 45.001, originLon: strikes[0][1], originCity: key,
    startTime: strikeTime, endTime: strikeTime + 100_000, traveledKm: 0,
    totalCount: 6000, strikes, countryPath: ['IT'] };
}
function archive(strikes: StormStrike[]) {
  db.archiveGridStrikeBatch(strikes.map(([lat, lon, time]) => ({ lat, lon, time })));
}
function chronological(strikes: StormStrike[]) {
  return [...strikes].sort((a, b) => a[2] - b[2]);
}
function metrics() {
  return tables.map(table => (sql.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
    .map(({ strikes: _strikes, ...fields }) => fields));
}
function expectCopies(key: string, expected: StormStrike[], sources = tables) {
  for (const table of sources) {
    const copies = sql.prepare(`SELECT strikes FROM ${table} WHERE storm_key = ?`).all(key) as { strikes: string }[];
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect(JSON.parse(copy.strikes)).toEqual(expected);
  }
}

it('never imports a separate nearby storm into a finished replay or any persisted record copy', async () => {
  const a = points(7), b = points(7.29);
  const storm = record('A', a), neighbor = record('B', b);
  db.upsertStorms([storm, neighbor]);
  db.upsertBiggestStorms([storm]);
  db.upsertStormRecords([storm]);
  db.recordStormAlias('old-A', 'A');
  archive([...a, ...b]);

  // Centers are 22.8 km apart: both dense ten-kilometre footprints are distinct,
  // although the old 25 km replay heuristic accepts every neighboring strike.
  const physical = detectStormFootprints([...a, ...b].map(([lat, lon, time]) => ({ lat, lon, time })), strikeTime + 100_000);
  expect(physical).toHaveLength(2);
  expect(footprintContact(physical[0].outline, physical[1].outline)!.gapKm).toBeGreaterThan(0);
  expect((sql.prepare('SELECT COUNT(*) AS count FROM grid_strikes').get() as { count: number }).count).toBe(400);
  const before = metrics();
  expect(db.getStormByKey('A')!.strikes).toHaveLength(200);

  const replay = db.getStormReplayByKey('A', now)!;
  expect(replay.strikes).toHaveLength(200);
  expect(replay.strikes).toEqual(a);
  expect(replay.totalCount).toBe(storm.totalCount);
  expectCopies('A', a);
  expect(metrics()).toEqual(before);

  for (let i = 1; i <= 3; i++) {
    const repeated = db.getStormReplayByKey('old-A', now + i * 60_000)!;
    expect(repeated.stormKey).toBe('A');
    expect(repeated.strikes).toEqual(a);
  }
  vi.resetModules();
  db = await import('../app/lib/db');
  expect(db.getStormReplayByKey('old-A', now + 5 * 60_000)!.strikes).toEqual(a);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(db.getStormReplayByKey('B', now + 5 * 60_000)!.strikes).toEqual(b);
  expectCopies('A', a);
  expect(db.getStormByKey('B')!.strikes).toEqual(b);
  expect(metrics()).toEqual(before);
});

it('recovers only proven missing replay points, including distant history and fading tails, after reads and restart', async () => {
  const a = points(7), b = points(7.29);
  const distant: StormStrike = [45.2, 10, strikeTime + 45_123];
  const tail: StormStrike = [45.1, 7.1, strikeTime + 20 * 60_000];
  const unknownNearby: StormStrike = [45.001, 7.001, strikeTime + 1234];
  const owned = chronological([...a, distant, tail]);
  const storm = record('A', [a[0], a[a.length - 1]]);
  db.upsertStorms([storm, record('B', b)]);
  db.upsertBiggestStorms([storm]);
  db.upsertStormRecords([storm]);
  db.recordStormAlias('old-A', 'A');
  archive([...owned, ...b, unknownNearby]);
  db.saveStormReplayOwnership([{ stormKey: 'A', strikes: owned }, { stormKey: 'B', strikes: b }], now);
  const before = metrics();

  const recovered = db.getStormReplayByKey('old-A', now)!;
  expect(recovered.stormKey).toBe('A');
  expect(recovered.strikes).toHaveLength(202);
  expect(recovered.strikes).toEqual(owned);
  expect(recovered.strikes).not.toContainEqual(unknownNearby);
  expectCopies('A', owned);
  expect(metrics()).toEqual(before);

  // Proven history may become available after an earlier read. It must still
  // recover without raw geographic candidates or a process-local ownership map.
  const laterOwned: StormStrike = [45.12, 7.13, strikeTime + 30 * 60_000];
  db.saveStormReplayOwnership([{ stormKey: 'A', strikes: [laterOwned] }], now);
  sql.exec('DELETE FROM grid_strikes');
  vi.resetModules();
  db = await import('../app/lib/db');
  const expected = chronological([...owned, laterOwned]);
  expect(db.getStormReplayByKey('old-A', now + 60_000)!.strikes).toEqual(expected);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(db.getStormReplayByKey('A', now + 120_000)!.strikes).toEqual(expected);
  expectCopies('A', expected);
  expect(metrics()).toEqual(before);
});

it('waits for a recent owned fading tail even when the saved replay has not caught up', () => {
  const a = points(7);
  const tail: StormStrike = [45.1, 7.1, now - 5 * 60_000];
  const storm = record('A', a);
  db.upsertStorms([storm]);
  db.upsertBiggestStorms([storm]);
  db.upsertStormRecords([storm]);
  db.saveStormReplayOwnership([{ stormKey: 'A', strikes: [...a, tail] }], now);
  const before = metrics();

  expect(db.getStormReplayByKey('A', now)!.strikes).toEqual(a);
  expect(db.getStormReplayByKey('A', now + 55 * 60_000)!.strikes).toEqual(a);
  expectCopies('A', a);
  expect(db.getStormReplayByKey('A', now + 55 * 60_000 + 1)!.strikes).toEqual([...a, tail]);
  expectCopies('A', [...a, tail]);
  expect(metrics()).toEqual(before);
});

it('preserves legitimate shared history for both split identities and unions ownership on canonical merges', async () => {
  const a = points(7), b = points(7.29);
  const shared: StormStrike = [45.001, 7.145, strikeTime + 32_123];
  const parentOwned = chronological([...a, shared]);
  const childOwned = chronological([...b, shared]);
  const parent = record('parent', [a[0], a[a.length - 1]]);
  const child = record('child', [b[0], b[b.length - 1]]);
  db.upsertStorms([parent, child]);
  db.upsertBiggestStorms([parent]);
  db.upsertStormRecords([parent]);
  db.saveStormReplayOwnership([
    { stormKey: 'parent', strikes: parentOwned },
    { stormKey: 'child', strikes: childOwned },
  ], now);
  db.recordStormAlias('older-child', 'child');

  expect(db.getStormReplayByKey('parent', now)!.strikes).toEqual(parentOwned);
  expect(db.getStormReplayByKey('older-child', now)!.strikes).toEqual(childOwned);
  const sharedRows = sql.prepare('SELECT storm_key FROM storm_replay_points WHERE strike_time = ? ORDER BY storm_key').all(shared[2]);
  expect(sharedRows).toEqual([{ storm_key: 'child' }, { storm_key: 'parent' }]);

  // Follow the confirmed tracker's alias-then-delete ordering. The consumed
  // identity's actual history becomes eligible for its canonical survivor.
  db.recordStormAlias('child', 'parent');
  db.deleteStorm('child');
  const before = metrics();
  const expected = chronological([...a, ...b, shared]);
  const merged = db.getStormReplayByKey('older-child', now)!;
  expect(merged.stormKey).toBe('parent');
  expect(merged.strikes).toHaveLength(401);
  expect(new Set(merged.strikes!.map(point => point.join(','))).size).toBe(401);
  expect(merged.strikes).toEqual(expected);
  expectCopies('parent', expected);
  expect(metrics()).toEqual(before);
  expect(sql.prepare("SELECT COUNT(*) AS count FROM storm_replay_points WHERE storm_key = 'child'").get()).toEqual({ count: 0 });

  const lateOwned: StormStrike = [45.1, 7.15, strikeTime + 110_000];
  db.saveStormReplayOwnership([{ stormKey: 'older-child', strikes: [shared, lateOwned] }], now);
  vi.resetModules();
  db = await import('../app/lib/db');
  const final = chronological([...expected, lateOwned]);
  expect(db.getStormReplayByKey('child', now + 60_000)!.strikes).toEqual(final);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(db.getStormReplayByKey('parent', now + 120_000)!.strikes).toEqual(final);
  expectCopies('parent', final);
  expect(metrics()).toEqual(before);
});

it('preserves each cache copy\'s existing history without importing it into the primary replay', () => {
  const base = points(7)[0];
  const older: StormStrike = [44, 6, strikeTime - 20 * 60_000];
  const missing: StormStrike = [45, 7.01, strikeTime + 1000];
  const storm = { ...record('A', [base]), startTime: older[2] };
  db.upsertStorms([storm]);
  db.upsertBiggestStorms([{ ...storm, strikes: [older, base] }]);
  db.upsertStormRecords([{ ...storm, strikes: [older, base] }]);
  db.saveStormReplayOwnership([{ stormKey: 'A', strikes: [missing] }], now);
  const before = metrics();

  const recovered = db.getStormReplayByKey('A', now)!;
  expect(recovered.strikes).toEqual([base, missing]);
  expect(recovered.strikes).not.toContainEqual(older);
  expectCopies('A', [base, missing], ['storms']);
  expectCopies('A', [older, base, missing], ['country_biggest_storms', 'storm_records']);
  expect(metrics()).toEqual(before);
  expect(db.getStormReplayByKey('A', now + 60_000)!.strikes).toEqual([base, missing]);
  expectCopies('A', [older, base, missing], ['country_biggest_storms', 'storm_records']);
});

it('repairs a cache missing an owned point even when the primary replay already contains it', () => {
  const base = points(7)[0];
  const owned: StormStrike = [45, 7.01, strikeTime + 1000];
  const storm = record('A', [base, owned]);
  db.upsertStorms([storm]);
  db.upsertBiggestStorms([{ ...storm, strikes: [base] }]);
  db.upsertStormRecords([{ ...storm, strikes: [base] }]);
  db.saveStormReplayOwnership([{ stormKey: 'A', strikes: [owned] }], now);
  const before = metrics();

  expect(db.getStormReplayByKey('A', now)!.strikes).toEqual([base, owned]);
  expectCopies('A', [base, owned]);
  expect(metrics()).toEqual(before);
});

it('preserves old marked samples without using their foreign points to claim more raw strikes', () => {
  const a = points(7), b = points(7.29);
  const historical = [a[0], b[0]];
  const fartherForeign: StormStrike = [45, 7.58, strikeTime + 1500];
  const proven: StormStrike = [45.001, 7.02, strikeTime + 1234];
  const storm = record('A', historical);
  db.upsertStorms([storm]);
  db.upsertBiggestStorms([storm]);
  db.upsertStormRecords([storm]);
  archive([...a, ...b, fartherForeign]);
  const markerValue = String(now - 60_000);
  sql.prepare('INSERT INTO counters (key, value) VALUES (?, ?)').run('replay_edges_v1:A', markerValue);
  const before = metrics();

  // A v1 repair did not record which saved points it inferred. Leave that old
  // evidence intact, but neither its marker nor its anchors establish ownership.
  expect(db.getStormReplayByKey('A', now)!.strikes).toEqual(historical);
  db.saveStormReplayOwnership([{ stormKey: 'A', strikes: [proven] }], now);
  const expected = [...historical, proven];
  const recovered = db.getStormReplayByKey('A', now + 60_000)!;
  expect(recovered.strikes).toEqual(expected);
  expect(recovered.strikes).toContainEqual(b[0]);
  expect(recovered.strikes).not.toContainEqual(b[1]);
  expect(recovered.strikes).not.toContainEqual(fartherForeign);
  expectCopies('A', expected);
  expect(metrics()).toEqual(before);
  expect(sql.prepare('SELECT value FROM counters WHERE key = ?').get('replay_edges_v1:A')).toEqual({ value: markerValue });
});

it('rejects expired, future and invalid ownership and prunes old ownership alongside the raw archive', () => {
  const retention = 3 * 24 * 60 * 60_000;
  const old: StormStrike = [45, 7, now - 1000];
  const rejected: StormStrike[] = [
    [45, 7, now - retention],
    [45, 7, now + 1],
    [91, 7, now - 500],
    [45, 181, now - 500],
    [Number.NaN, 7, now - 500],
    [45, 7, Number.NaN],
  ];
  db.saveStormReplayOwnership([{ stormKey: 'A', strikes: [old, ...rejected] }], now);
  archive([old]);
  expect(sql.prepare('SELECT strike_time FROM storm_replay_points').all()).toEqual([{ strike_time: old[2] }]);

  const later = now + retention;
  const recent: StormStrike = [45.001, 7.001, later - 1000];
  const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
  try {
    db.saveStormReplayOwnership([{ stormKey: 'A', strikes: [recent] }], later);
    archive([recent]);
    db.pruneGridStrikes();
    expect(sql.prepare('SELECT storm_key, strike_time, lat_milli, lon_milli FROM storm_replay_points').all())
      .toEqual([{ storm_key: 'A', strike_time: recent[2], lat_milli: 45001, lon_milli: 7001 }]);
    expect(sql.prepare('SELECT strike_time FROM grid_strikes').all()).toEqual([{ strike_time: recent[2] }]);
  } finally {
    clock.mockRestore();
  }
});
