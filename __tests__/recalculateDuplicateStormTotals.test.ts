/**
 * Integration test for the one-time DB repair that runs on the first server
 * start after the duplicate-strike-ingestion fix (server.mjs / absorbInto —
 * see duplicateStrikeIngestion.test.ts for the ingestion-level bug/fix).
 *
 * Storms recorded before the fix have inflated total_count/count/rate and
 * literal duplicate [lat,lon,time] points in their stored strikes blob.
 * `recalculateDuplicateStormTotals` walks every such row, dedupes the blob,
 * and scales the numeric fields down by the ratio of duplication found in
 * the sample. This test runs it against a real (temporary) SQLite DB via the
 * same public db.ts API the rest of the app uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dbModule: typeof import('../app/lib/db');
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-db-test-'));
  process.env.DB_PATH = tmpDir;
  dbModule = await import('../app/lib/db');
  // Force schema init (and let the empty-DB startup migrations run and settle)
  // before tests insert their own rows.
  dbModule.getStormByKey('__init__');
});

afterAll(() => {
  delete process.env.DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tripleUp(points: Array<[number, number, number]>, copies: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const p of points) for (let i = 0; i < copies; i++) out.push(p);
  return out;
}

describe('recalculateDuplicateStormTotals', () => {
  it('dedupes the strikes blob and scales total_count/count/rate down by the measured duplication ratio', () => {
    const uniquePoints: Array<[number, number, number]> = Array.from({ length: 100 }, (_, i) => [44.9 + i * 0.001, 16.6, 1_000_000 + i * 1000]);
    const corruptedBlob = tripleUp(uniquePoints, 3); // 300 points, 3x duplicated — matches the real-world bug

    dbModule.upsertStorms([{
      code: 'HU', count: 3000, rate: 600, lat: 44.9, lon: 16.6, city: 'Harkány', date: '2026-08-21',
      originLat: 44.0, originLon: 16.0, originCity: 'Open Ocean',
      startTime: 1_000_000, endTime: 1_100_000, stormKey: 'TEST:dup:1',
      traveledKm: 100, totalCount: 900_000, // inflated ~3x, matching the corrupted production storm
      strikes: corruptedBlob, countryPath: ['HU'],
    }]);

    const before = dbModule.getStormByKey('TEST:dup:1');
    expect(before?.strikes?.length).toBe(300);

    const result = dbModule.recalculateDuplicateStormTotals();
    expect(result.storms).toBeGreaterThanOrEqual(1);

    const after = dbModule.getStormByKey('TEST:dup:1');
    expect(after).not.toBeNull();
    // Blob is fully deduped
    expect(after!.strikes!.length).toBe(100);
    const uniqueKeys = new Set(after!.strikes!.map(s => s.join(',')));
    expect(uniqueKeys.size).toBe(100);
    // total_count scaled down by the same ratio measured in the sample (1/3)
    expect(after!.totalCount).toBe(300_000);
    // count/rate scaled by the same ratio
    expect(after!.count).toBe(1000);
    expect(after!.rate).toBeCloseTo(200, 5);
  });

  it('never scales the corrected total below the number of strikes known to be unique', () => {
    const uniquePoints: Array<[number, number, number]> = Array.from({ length: 500 }, (_, i) => [10 + i * 0.0001, 20, 2_000_000 + i]);
    const corruptedBlob = tripleUp(uniquePoints, 2); // 1000 points, 2x duplicated

    // totalCount deliberately tiny relative to the sample (simulates a heavily
    // thinned/edge-case row) so the naive ratio*totalCount would undershoot
    // the strikes we can already prove are real.
    dbModule.upsertStorms([{
      code: 'XX', count: 50, rate: 10, lat: 10, lon: 20, city: null, date: '2026-08-21',
      originLat: 10, originLon: 20, originCity: null,
      startTime: 2_000_000, endTime: 2_100_000, stormKey: 'TEST:dup:2',
      totalCount: 100, // smaller than the 500 unique strikes we can already see in the sample
      traveledKm: 0, strikes: corruptedBlob, countryPath: null,
    }]);

    dbModule.recalculateDuplicateStormTotals();
    const after = dbModule.getStormByKey('TEST:dup:2');
    expect(after!.strikes!.length).toBe(500);
    expect(after!.totalCount).toBeGreaterThanOrEqual(500);
  });

  it('leaves storms with no detectable duplicates untouched', () => {
    const uniquePoints: Array<[number, number, number]> = Array.from({ length: 40 }, (_, i) => [50 + i * 0.001, 5, 3_000_000 + i * 100]);

    dbModule.upsertStorms([{
      code: 'NL', count: 40, rate: 8, lat: 50, lon: 5, city: 'Amsterdam', date: '2026-08-21',
      originLat: 50, originLon: 5, originCity: 'Amsterdam',
      startTime: 3_000_000, endTime: 3_100_000, stormKey: 'TEST:clean:1',
      totalCount: 40, traveledKm: 0, strikes: uniquePoints, countryPath: ['NL'],
    }]);

    dbModule.recalculateDuplicateStormTotals();
    const after = dbModule.getStormByKey('TEST:clean:1');
    expect(after!.strikes!.length).toBe(40);
    expect(after!.totalCount).toBe(40);
    expect(after!.rate).toBe(8);
  });

  it('also corrects the country_biggest_storms cache, independently of the storms table', () => {
    const uniquePoints: Array<[number, number, number]> = Array.from({ length: 60 }, (_, i) => [30 + i * 0.001, 40, 4_000_000 + i * 500]);
    const corruptedBlob = tripleUp(uniquePoints, 4); // 240 points, 4x duplicated

    dbModule.upsertBiggestStorms([{
      code: 'TESTCC', count: 2400, rate: 480, lat: 30, lon: 40, city: 'Testville', date: '2026-08-21',
      originLat: 30, originLon: 40, originCity: 'Testville',
      startTime: 4_000_000, endTime: 4_100_000, stormKey: 'TEST:country:1',
      totalCount: 240_000, traveledKm: 0, strikes: corruptedBlob, countryPath: ['TESTCC'],
    }]);

    const result = dbModule.recalculateDuplicateStormTotals();
    expect(result.countryBiggest).toBeGreaterThanOrEqual(1);

    const after = dbModule.getBiggestStorm('TESTCC');
    expect(after!.strikes!.length).toBe(60);
    expect(after!.totalCount).toBe(60_000); // 240_000 / 4
    expect(after!.count).toBe(600); // 2400 / 4
  });

  it('rebuilds storm_records from corrected totals so hall-of-fame rankings are not stuck on corrupted numbers', () => {
    const uniquePoints: Array<[number, number, number]> = Array.from({ length: 100 }, (_, i) => [1 + i * 0.001, 1, 5_000_000 + i * 1000]);
    const corruptedBlob = tripleUp(uniquePoints, 10); // wildly inflated, would otherwise dominate every category

    dbModule.upsertStorms([{
      code: 'ZZ', count: 1000, rate: 200, lat: 1, lon: 1, city: null, date: '2026-08-21',
      originLat: 1, originLon: 1, originCity: null,
      startTime: 5_000_000, endTime: 5_999_000, stormKey: 'TEST:record:1',
      totalCount: 1_000_000, traveledKm: 10, strikes: corruptedBlob, countryPath: null,
    }]);
    // A genuinely large, uncorrupted storm that should now outrank the corrected one.
    dbModule.upsertStorms([{
      code: 'ZZ', count: 900, rate: 180, lat: 2, lon: 2, city: null, date: '2026-08-21',
      originLat: 2, originLon: 2, originCity: null,
      startTime: 6_000_000, endTime: 6_999_000, stormKey: 'TEST:record:2',
      totalCount: 500_000, traveledKm: 5, strikes: null, countryPath: null,
    }]);

    dbModule.recalculateDuplicateStormTotals();

    const records = dbModule.getStormRecords();
    const biggest = records.find(r => r.category === 'biggest');
    // Corrected total for record:1 is 100_000 (1_000_000 / 10) — the clean
    // 500_000-strike storm should now hold the 'biggest' record instead.
    expect(biggest?.stormKey).toBe('TEST:record:2');
  });
});
