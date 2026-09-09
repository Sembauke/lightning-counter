import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BiggestStorm, StormStrike } from '../app/lib/db';

let dbModule: typeof import('../app/lib/db');
let sql: Database.Database;
let tmpDir: string;
const now = Date.now();
const strikeTime = now - 2 * 60 * 60_000;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-replay-test-'));
  process.env.DB_PATH = tmpDir;
  dbModule = await import('../app/lib/db');
  dbModule.getStormByKey('__init__');
  // Let existing startup migrations finish before installing test fixtures.
  await new Promise<void>(resolve => setImmediate(resolve));
  sql = new Database(path.join(tmpDir, 'lightning.db'));
});

beforeEach(() => {
  sql.exec(`
    DELETE FROM storms;
    DELETE FROM country_biggest_storms;
    DELETE FROM storm_records;
    DELETE FROM grid_strikes;
    DELETE FROM storm_replay_points;
    DELETE FROM counters WHERE key LIKE 'replay_edges_v1:%';
  `);
});

afterAll(() => {
  sql.close();
  delete process.env.DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function saveStorm(overrides: Partial<BiggestStorm> = {}): BiggestStorm {
  const storm: BiggestStorm = {
    stormKey: 'TEST:replay', code: 'US', count: 300, rate: 60,
    lat: 0, lon: 0, city: 'End', date: new Date(strikeTime).toISOString().slice(0, 10),
    originLat: 0, originLon: 0, originCity: 'Start',
    startTime: strikeTime - 60_000, endTime: strikeTime + 60_000,
    traveledKm: 50, totalCount: 10_000,
    strikes: [[0, 0, strikeTime], [0, 0, strikeTime + 60_000]], countryPath: ['US'],
    ...overrides,
  };
  dbModule.upsertStorms([storm]);
  return storm;
}

function archive(points: StormStrike[]) {
  dbModule.archiveGridStrikeBatch(points.map(([lat, lon, time]) => ({ lat, lon, time })));
}

function own(points: StormStrike[], stormKey = 'TEST:replay') {
  dbModule.saveStormReplayOwnership([{ stormKey, strikes: points }], now);
}

function marker(key = 'TEST:replay') {
  return sql.prepare('SELECT value FROM counters WHERE key = ?').get(`replay_edges_v1:${key}`);
}

function tableMetrics(table: string) {
  const rows = sql.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  return rows.map(({ strikes: _strikes, ...metrics }) => metrics);
}

describe('updateStormReplay', () => {
  it('updates every existing replay copy while preserving official metrics and ranks', () => {
    const storm = saveStorm();
    dbModule.upsertBiggestStorms([storm]);
    dbModule.upsertStormRecords([storm]);
    saveStorm({ stormKey: 'TEST:bigger', totalCount: 20_000, strikes: null });
    const tables = ['storms', 'country_biggest_storms', 'storm_records'];
    const metrics = tables.map(tableMetrics);
    const rank = dbModule.getStormRank(storm.totalCount!);
    const fadingReplay: StormStrike[] = [...storm.strikes!, [0, 0.1, now - 60_000]];

    dbModule.updateStormReplay(storm.stormKey!, fadingReplay);

    for (const table of tables) {
      const copies = sql.prepare(`SELECT strikes FROM ${table} WHERE storm_key = ?`).all(storm.stormKey) as { strikes: string }[];
      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies) expect(JSON.parse(copy.strikes)).toEqual(fadingReplay);
    }
    expect(tables.map(tableMetrics)).toEqual(metrics);
    expect(dbModule.getStormRank(storm.totalCount!)).toBe(rank);
    expect(dbModule.getStormByKey('TEST:bigger')!.strikes).toBeNull();
  });

  it('does not create log entries, claim records, or resurrect deleted storms', () => {
    const storm = saveStorm();
    dbModule.upsertBiggestStorms([storm]);
    dbModule.upsertStormRecords([storm]);
    dbModule.deleteStorm(storm.stormKey!);

    dbModule.updateStormReplay(storm.stormKey!, storm.strikes!);
    dbModule.updateStormReplay('TEST:never-recorded', storm.strikes!);

    expect(dbModule.getStormByKey(storm.stormKey!)).toBeNull();
    expect(dbModule.getStormByKey('TEST:never-recorded')).toBeNull();
    expect(dbModule.getBiggestStorm(storm.code)).toBeNull();
    expect(dbModule.getStormRecords()).toEqual([]);
  });

  it('rolls back all replay copies when a cache update fails', () => {
    const storm = saveStorm();
    dbModule.upsertBiggestStorms([storm]);
    dbModule.upsertStormRecords([storm]);
    sql.exec(`
      CREATE TRIGGER reject_tail_copy BEFORE UPDATE OF strikes ON storm_records
      BEGIN SELECT RAISE(ABORT, 'simulated tail write failure'); END;
    `);
    try {
      expect(() => dbModule.updateStormReplay(storm.stormKey!, [...storm.strikes!, [0, 0.1, now - 60_000]]))
        .toThrow('simulated tail write failure');
      expect(dbModule.getStormByKey(storm.stormKey!)!.strikes).toEqual(storm.strikes);
      expect(dbModule.getBiggestStorm(storm.code)!.strikes).toEqual(storm.strikes);
      expect(dbModule.getStormRecords().every(record => JSON.stringify(record.strikes) === JSON.stringify(storm.strikes))).toBe(true);
    } finally {
      sql.exec('DROP TRIGGER reject_tail_copy');
    }
  });
});

describe('getStormReplayByKey', () => {
  it('persists recorded owned points in every replay copy without changing metrics or ranks', () => {
    const storm = saveStorm();
    dbModule.upsertBiggestStorms([storm]);
    dbModule.upsertStormRecords([storm]);
    saveStorm({ stormKey: 'TEST:bigger', totalCount: 20_000, strikes: null });
    const tables = ['storms', 'country_biggest_storms', 'storm_records'];
    const metrics = tables.map(tableMetrics);
    const rank = dbModule.getStormRank(storm.totalCount!);
    const edge: StormStrike = [0, 0.18, strikeTime + 1000];
    archive([storm.strikes![0], edge, [5, 5, strikeTime + 1000]]);
    own([edge]);

    const result = dbModule.getStormReplayByKey(storm.stormKey!, now)!;

    expect(result.strikes).toEqual([storm.strikes![0], edge, storm.strikes![1]]);
    for (const table of tables) {
      const rows = sql.prepare(`SELECT strikes FROM ${table} WHERE storm_key = ?`).all(storm.stormKey) as { strikes: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(JSON.parse(row.strikes)).toEqual(result.strikes);
    }
    expect(tables.map(tableMetrics)).toEqual(metrics);
    expect(dbModule.getStormRank(storm.totalCount!)).toBe(rank);
    expect(marker()).toBeUndefined();
  });

  it('repeated reads never treat recovered points as ownership of nearby raw strikes', () => {
    const storm = saveStorm();
    const edge: StormStrike = [0, 0.18, strikeTime + 1000];
    const chained: StormStrike = [0, 0.36, strikeTime + 2000];
    archive([edge, chained]);
    own([edge]);
    const once = dbModule.getStormReplayByKey(storm.stormKey!, now)!;
    expect(once.strikes).toEqual([storm.strikes![0], edge, storm.strikes![1]]);
    expect(marker()).toBeUndefined();

    const again = dbModule.getStormReplayByKey(storm.stormKey!, now + 60_000)!;
    expect(again.strikes).toEqual(once.strikes);
    expect(again.strikes).not.toContainEqual(chained);
    expect(dbModule.getStormByKey(storm.stormKey!)!.strikes).toEqual(once.strikes);
  });

  it('iterates dense archive windows beyond the old 20,000-row query limit', () => {
    const storm = saveStorm();
    const dense: StormStrike[] = Array.from({ length: 20_025 }, (_, i) => [0, 0.1, strikeTime + i + 1]);
    archive(dense);
    own(dense);

    const result = dbModule.getStormReplayByKey(storm.stormKey!, now)!;
    expect(result.strikes).toHaveLength(dense.length + storm.strikes!.length);
    expect(result.strikes).toContainEqual(dense[dense.length - 1]);
  });

  it('leaves missing ownership unchanged and retryable after membership is restored', () => {
    const storm = saveStorm();
    expect(dbModule.getStormReplayByKey(storm.stormKey!, now)!.strikes).toEqual(storm.strikes);
    expect(marker()).toBeUndefined();
    const edge: StormStrike = [0, 0.18, strikeTime + 1000];
    archive([edge]);
    own([edge]);

    expect(dbModule.getStormReplayByKey(storm.stormKey!, now)!.strikes).toContainEqual(edge);
    expect(marker()).toBeUndefined();
  });

  it('does not repair live, dormant, unknown-end, empty, missing, or expired replays', () => {
    const oldTime = now - 4 * 24 * 60 * 60_000;
    const cases: Partial<BiggestStorm>[] = [
      { stormKey: 'TEST:live', endTime: now - 5 * 60_000 },
      { stormKey: 'TEST:dormant-11m', endTime: now - 11 * 60_000 },
      { stormKey: 'TEST:dormant-59m', endTime: now - 59 * 60_000 },
      { stormKey: 'TEST:retirement-boundary', endTime: now - 60 * 60_000 },
      { stormKey: 'TEST:unknown-end', endTime: null },
      { stormKey: 'TEST:no-points', strikes: null },
      { stormKey: 'TEST:empty', strikes: [] },
      { stormKey: 'TEST:expired', endTime: oldTime + 1000, strikes: [[0, 0, oldTime]] },
    ];
    archive([[0, 0.1, strikeTime + 1000], [0, 0.1, oldTime + 1000]]);
    for (const overrides of cases) {
      const storm = saveStorm(overrides);
      expect(dbModule.getStormReplayByKey(storm.stormKey!, now)!.strikes).toEqual(storm.strikes);
      expect(marker(storm.stormKey!)).toBeUndefined();
    }
    expect(dbModule.getStormReplayByKey('TEST:absent', now)).toBeNull();
    expect(marker('TEST:absent')).toBeUndefined();
  });

  it('waits for a fading replay tail to settle after the official storm has ended', () => {
    const storm = saveStorm();
    const fadingReplay: StormStrike[] = [...storm.strikes!, [0, 0, now - 5 * 60_000]];
    dbModule.updateStormReplay(storm.stormKey!, fadingReplay);
    const edge: StormStrike = [0, 0.18, strikeTime + 1000];
    archive([edge]);
    own([edge]);

    expect(dbModule.getStormReplayByKey(storm.stormKey!, now)!.strikes).toEqual(fadingReplay);
    expect(marker()).toBeUndefined();
    expect(dbModule.getStormReplayByKey(storm.stormKey!, now + 55 * 60_000)!.strikes).toEqual(fadingReplay);
    expect(marker()).toBeUndefined();
    expect(dbModule.getStormReplayByKey(storm.stormKey!, now + 55 * 60_000 + 1)!.strikes).toContainEqual(edge);
    expect(marker()).toBeUndefined();
    expect(dbModule.getStormByKey(storm.stormKey!)!.endTime).toBe(storm.endTime);
  });

  it('rolls back all replay copies when persistence fails and keeps ownership retryable', () => {
    const storm = saveStorm();
    dbModule.upsertBiggestStorms([storm]);
    dbModule.upsertStormRecords([storm]);
    archive([[0, 0.18, strikeTime + 1000]]);
    own([[0, 0.18, strikeTime + 1000]]);
    sql.exec(`
      CREATE TRIGGER reject_replay_copy BEFORE UPDATE OF strikes ON storm_records
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
    `);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(dbModule.getStormReplayByKey(storm.stormKey!, now)!.strikes).toEqual(storm.strikes);
      expect(dbModule.getStormByKey(storm.stormKey!)!.strikes).toEqual(storm.strikes);
      expect(dbModule.getBiggestStorm(storm.code)!.strikes).toEqual(storm.strikes);
      expect(dbModule.getStormRecords().every(record => JSON.stringify(record.strikes) === JSON.stringify(storm.strikes))).toBe(true);
      expect(marker()).toBeUndefined();
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      sql.exec('DROP TRIGGER reject_replay_copy');
    }
  });
});
