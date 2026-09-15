import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BiggestStorm } from '../app/lib/db';

const previousDbPath = process.env.DB_PATH;
let directory: string;
let raw: Database.Database;
let db: typeof import('../app/lib/db');
const tables = ['storms', 'country_biggest_storms', 'storm_records'];
let storedRows: unknown[][];

const oceanStorm: BiggestStorm = {
  stormKey: 'legacy-ocean', code: 'XO', count: 100, rate: 20, totalCount: 20_000,
  lat: 56, lon: 3, city: 'Open Ocean', date: '2026-09-10',
  originLat: 34, originLon: 18, originCity: 'Open Ocean',
  startTime: 1_000, endTime: 61_000, traveledKm: 100,
  strikes: [[56, 3, 31_000]], countryPath: ['XO'],
};
const landStorm: BiggestStorm = {
  ...oceanStorm, stormKey: 'legacy-land', code: 'NL', totalCount: 10_000, date: '2026-09-11',
  lat: 52.3676, lon: 4.9041, city: 'Amsterdam',
  originLat: 48.1351, originLon: 11.582, originCity: 'Munich', countryPath: ['DE', 'NL'],
};

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-location-'));
  process.env.DB_PATH = directory;
  db = await import('../app/lib/db');
  db.getStormByKey('__init__');
  await new Promise(resolve => setImmediate(resolve));
  db.upsertStorms([oceanStorm, landStorm]);
  db.upsertBiggestStorms([oceanStorm, landStorm]);
  db.upsertStormRecords([oceanStorm, landStorm]);
  raw = new Database(path.join(directory, 'lightning.db'));
  storedRows = tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
});

afterAll(() => {
  raw?.close();
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('saved storm location reads', () => {
  it('enriches legacy ocean names consistently across details, archives, and records', () => {
    const expected = { code: 'XO', city: 'North Sea', originCity: 'Mediterranean Sea', totalCount: 20_000 };
    const reads = [
      db.getStormByKey(oceanStorm.stormKey!), db.getBiggestStorm('XO'),
      ...db.getStormsForDate(oceanStorm.date),
      ...db.getBiggestStormPerDay().filter(row => row.stormKey === oceanStorm.stormKey),
      ...db.getTop100Storms().filter(row => row.stormKey === oceanStorm.stormKey),
      ...db.getStormRecords(),
    ];
    expect(reads.length).toBeGreaterThan(5);
    for (const row of reads) expect(row).toMatchObject(expected);
  });

  it('includes subdivisions in details, archives, leaderboards and pagination anchors', () => {
    const expected = {
      code: 'NL', city: 'Amsterdam', subdivision: 'North Holland',
      originCity: 'Munich', originSubdivision: 'Bavaria', totalCount: 10_000,
    };
    const reads = [
      db.getStormByKey(landStorm.stormKey!), db.getBiggestStorm('NL'),
      ...db.getStormsForDate(landStorm.date, 'NL'),
      ...db.getBiggestStormPerDay().filter(row => row.stormKey === landStorm.stormKey),
      ...db.getTop100Storms().filter(row => row.stormKey === landStorm.stormKey),
    ];
    for (const row of reads) expect(row).toMatchObject(expected);
    const leaderboards = [
      db.getNearbyRankedStorms(landStorm.stormKey!),
      db.getStormLeaderboardPage(landStorm.stormKey!)!.rows,
    ];
    for (const rows of leaderboards) {
      expect(rows.find(row => row.stormKey === landStorm.stormKey)).toMatchObject(expected);
      expect(rows.find(row => row.stormKey === oceanStorm.stormKey)).toMatchObject({
        code: 'XO', city: 'North Sea', originCity: 'Mediterranean Sea',
      });
      for (const row of rows) {
        expect(row).not.toHaveProperty('originLat');
        expect(row).not.toHaveProperty('originLon');
        expect(row).not.toHaveProperty('currentRank');
      }
    }
    const page = db.getStormLeaderboardPage(landStorm.stormKey!, landStorm.stormKey!)!;
    expect(page.anchor).toMatchObject(expected);
    expect(page.rows[0]).toMatchObject({ city: 'North Sea', originCity: 'Mediterranean Sea' });
    expect(db.getStormLeaderboardPage(landStorm.stormKey!, oceanStorm.stormKey!)!.anchor).toMatchObject({
      city: 'North Sea', originCity: 'Mediterranean Sea',
    });
  });

  it('leaves the stored cities, attribution, counts, and archive rows unchanged after reading', () => {
    expect(tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(storedRows);
    expect(raw.prepare('SELECT code, city, origin_city FROM storms WHERE storm_key = ?').get(oceanStorm.stormKey)).toEqual({
      code: 'XO', city: 'Open Ocean', origin_city: 'Open Ocean',
    });
  });
});
