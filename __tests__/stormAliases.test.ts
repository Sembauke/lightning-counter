import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BiggestStorm } from '../app/lib/db';

let db: typeof import('../app/lib/db');
let sql: Database.Database;
let directory: string;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-alias-test-'));
  vi.stubEnv('DB_PATH', directory);
  db = await import('../app/lib/db');
  db.getStormByKey('__init__');
  sql = new Database(path.join(directory, 'lightning.db'));
});

afterEach(() => {
  sql.close();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function storm(key: string, count: number, code = 'IT'): BiggestStorm {
  const now = Date.now();
  return { stormKey: key, code, count, rate: 30, lat: 44, lon: 10,
    city: key, date: new Date(now).toISOString().slice(0, 10),
    originLat: 44, originLon: 9, originCity: 'Origin',
    startTime: now - 3_600_000, endTime: now, traveledKm: 80, totalCount: count,
    strikes: [[44, 10, now - 1000]], countryPath: null };
}

describe('confirmed storm merge aliases', () => {
  it('keeps absorbed replay URLs and leaderboard lookup pointed at the survivor', () => {
    db.upsertStorms([storm('old', 5000), storm('survivor', 9000)]);
    db.recordStormAlias('old', 'survivor');
    db.deleteStorm('old');
    expect(db.getStormByKey('old')?.stormKey).toBe('survivor');
    expect(db.getStormReplayByKey('old')?.strikes).toEqual(db.getStormReplayByKey('survivor')?.strikes);
    expect(db.getNearbyRankedStorms('old').map(row => row.stormKey)).toContain('survivor');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM storms').get()).toEqual({ n: 1 });
  });

  it('preserves earlier country records and split events when deleting the old log row', () => {
    const old = storm('old', 5000, 'CH');
    db.upsertStorms([old, storm('survivor', 9000)]);
    db.upsertBiggestStorms([old]);
    db.upsertStormRecords([old]);
    db.recordStormEvent('old', 'split', Date.now(), 'child', 'Child', 'IT', null, 'F1');
    db.recordStormAlias('old', 'survivor');
    db.deleteStorm('old');
    expect(db.countSplitEvents('survivor')).toBe(1);
    expect(sql.prepare('SELECT storm_key FROM country_biggest_storms WHERE code = ?').get('CH')).toEqual({ storm_key: 'survivor' });
    const records = sql.prepare('SELECT storm_key FROM storm_records').all() as { storm_key: string }[];
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(record => record.storm_key === 'survivor')).toBe(true);
  });

  it('flattens subsequent merges without creating redirect cycles', () => {
    db.upsertStorms([storm('third', 12000)]);
    db.recordStormAlias('first', 'second');
    db.recordStormAlias('second', 'third');
    db.recordStormAlias('third', 'first');
    expect(db.resolveStormKey('first')).toBe('third');
    expect(db.resolveStormKey('second')).toBe('third');
    expect(db.resolveStormKey('third')).toBe('third');
    expect(db.getStormByKey('first')?.stormKey).toBe('third');
  });

  it('leaves unrelated missing storm keys missing', () => {
    expect(db.resolveStormKey('missing')).toBe('missing');
    expect(db.getStormByKey('missing')).toBeNull();
  });
});
