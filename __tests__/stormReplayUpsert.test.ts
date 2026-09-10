import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BiggestStorm, StormStrike } from '../app/lib/db';

let dbModule: typeof import('../app/lib/db');
let sql: Database.Database;
let tmpDir: string;
const start = Date.UTC(2026, 8, 9);
const minute = 60_000;
const key = 'CH:thinned-replay';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-replay-upsert-'));
  process.env.DB_PATH = tmpDir;
  dbModule = await import('../app/lib/db');
  dbModule.getStormByKey('__init__');
  await new Promise<void>(resolve => setImmediate(resolve));
  sql = new Database(path.join(tmpDir, 'lightning.db'));
});

beforeEach(() => {
  sql.exec('DELETE FROM storms; DELETE FROM country_biggest_storms; DELETE FROM storm_records;');
});

afterAll(() => {
  sql.close();
  delete process.env.DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function point(index: number): StormStrike {
  return [46, 8 + index / 100_000, start + index * 1000];
}

function save(strikes: StormStrike[] | null, overrides: Partial<BiggestStorm> = {}): BiggestStorm {
  const storm: BiggestStorm = {
    stormKey: key, code: 'CH', count: 300, rate: 60,
    lat: 46, lon: 8, city: 'End', date: '2026-09-09',
    originLat: 46, originLon: 8, originCity: 'Start',
    startTime: start, endTime: start + 8 * 60 * minute,
    traveledKm: 150, totalCount: 40_000, strikes, countryPath: ['CH', 'IT'],
    ...overrides,
  };
  dbModule.upsertStorms([storm]);
  return storm;
}

function saved(): StormStrike[] {
  return dbModule.getStormByKey(key)!.strikes!;
}

describe('persisted storm replay snapshots', () => {
  it('keeps advancing across repeated 24,000-to-12,000 tracker thinning', () => {
    let sample = Array.from({ length: 24_000 }, (_, i) => point(i));
    save(sample);
    let next = 24_000;
    for (let round = 0; round < 3; round++) {
      sample.push(point(next++));
      sample = sample.filter((_, i) => i % 2 === 0);
      save(sample);
      expect(saved()).toEqual(sample);
      expect(saved()[saved().length - 1]).toEqual(point(next - 1));

      // Another pass must advance immediately, although its sample remains
      // far shorter than the previously persisted 24,000-point snapshot.
      sample.push(point(next++));
      save(sample);
      expect(saved()[saved().length - 1]).toEqual(point(next - 1));
      while (sample.length < 24_000) sample.push(point(next++));
      save(sample);
    }
  });

  it('scans actual timestamps when the permanent origin sample is out of order', () => {
    const history = Array.from({ length: 500 }, (_, i) => point(i));
    save(history);
    const incoming = [...history.filter((_, i) => i % 2 === 0).slice(1), point(600), history[0]];
    save(incoming);
    expect(saved()).toEqual(incoming);
    expect(Math.max(...saved().map(p => p[2]))).toBe(point(600)[2]);
  });

  it('merges a shorter restart continuation without losing the earlier journey', () => {
    const history = Array.from({ length: 1000 }, (_, i) => point(i));
    save(history);
    const continuation = [point(999), point(1000), point(1001)];
    save(continuation);
    expect(saved()).toEqual([...history, point(1000), point(1001)]);
  });

  it('does not mistake an origin reservoir plus a recent tail for full middle coverage', () => {
    const history = Array.from({ length: 1000 }, (_, i) => point(i));
    save(history);
    save([history[0], point(1001)]);
    expect(saved()).toEqual([...history, point(1001)]);
  });

  it('preserves the current tail when an older, partial snapshot arrives', () => {
    const history = [point(0), point(500), point(1000)];
    save(history);
    save([point(400), point(450), point(500)]);
    expect(saved()).toEqual(history);
    save(null);
    expect(saved()).toEqual(history);
    save([]);
    expect(saved()).toEqual(history);
  });

  it('accepts an interior backfill that restores a missing five-minute interval', () => {
    const history = [point(0), point(2000)];
    save(history);
    save([point(1000)]);
    expect(saved()).toEqual([point(0), point(1000), point(2000)]);
  });

  it('bounds repeated partial merges while preserving the origin and newest continuation', () => {
    const history = Array.from({ length: 24_000 }, (_, i) => point(i));
    save(history);
    for (let round = 0; round < 5; round++) {
      const from = 24_000 + round * 500;
      save(Array.from({ length: 500 }, (_, i) => point(from + i)));
      const replay = saved();
      expect(replay.length).toBeLessThanOrEqual(24_200);
      expect(replay.slice(0, 200)).toEqual(history.slice(0, 200));
      expect(replay[replay.length - 1]).toEqual(point(from + 499));
      // The existing journey is still represented across its whole duration.
      const buckets = new Set(replay.map(p => Math.floor((p[2] - start) / (5 * minute))));
      for (let bucket = 0; bucket < 80; bucket++) expect(buckets.has(bucket)).toBe(true);
    }
  });

  it('updates official fields from the tracker independently of replay sample selection', () => {
    const history = Array.from({ length: 1000 }, (_, i) => point(i));
    save(history);
    const updated = save(history.filter((_, i) => i % 2 === 0).concat([point(1000)]), {
      totalCount: 60_000, count: 350, rate: 70, lat: 46.1, lon: 10.5,
      city: 'Venice', endTime: start + 10 * 60 * minute, traveledKm: 200,
    });
    // Region names are derived display metadata, separate from persisted tracker fields.
    const { strikes: _actualStrikes, cityRegion: _cityRegion, originRegion: _originRegion, ...actual } = dbModule.getStormByKey(key)!;
    const { strikes: _expectedStrikes, ...expected } = updated;
    expect(actual).toEqual(expected);
    expect(saved()).toHaveLength(501);
  });

  it('retains isolated low-activity intervals when bounding a merged replay', () => {
    const dense = Array.from({ length: 24_000 }, (_, i) => [46, 8, start + i] as StormStrike);
    const sparse = Array.from({ length: 100 }, (_, i) => [46, 8, start + (i + 1) * 5 * minute] as StormStrike);
    save([...dense, ...sparse]);
    save(Array.from({ length: 500 }, (_, i) => [46, 8, start + 600 * minute + i] as StormStrike));
    const replay = saved();
    expect(replay.length).toBeLessThanOrEqual(24_200);
    const times = new Set(replay.map(p => p[2]));
    for (const point of sparse) expect(times.has(point[2])).toBe(true);
  });

  it('preserves richer replay history in all fading copies without changing metrics', () => {
    const history = Array.from({ length: 1000 }, (_, i) => point(i));
    const storm = save(history);
    dbModule.upsertBiggestStorms([storm]);
    dbModule.upsertStormRecords([storm]);
    const tables = ['storms', 'country_biggest_storms', 'storm_records'];
    const metrics = () => tables.map(table => {
      const rows = sql.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      return rows.map(({ strikes: _strikes, ...rest }) => rest);
    });
    const before = metrics();
    dbModule.updateStormReplay(key, [point(999), point(1000)]);
    for (const table of tables) {
      const rows = sql.prepare(`SELECT strikes FROM ${table} WHERE storm_key = ?`).all(key) as { strikes: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(JSON.parse(row.strikes)).toEqual([...history, point(1000)]);
    }
    expect(metrics()).toEqual(before);
  });
});
