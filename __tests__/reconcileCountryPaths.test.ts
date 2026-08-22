/**
 * Reproduces and fixes a "country_path lists a country the replay can't show"
 * bug, found on a real storm (ES:1787269369744:3468 — country_path listed
 * Spain, France, and Monaco as the storm's origin leg, but the strikes blob's
 * lat/lon range didn't cover any of them).
 *
 * country_path is append-only and never thinned; the strikes blob is capped
 * and thinned (see replayTailContinuity.test.ts / accumulateStrikes). For a
 * long-lived storm, thinning can erase every surviving strike from an early
 * leg while country_path still lists that leg's country — a real mismatch
 * between what's claimed and what the replay can show.
 *
 * `reconcileCountryPaths` can't recover the lost strikes, but it keeps the
 * two consistent going forward: it drops country_path entries with no
 * supporting strikes left in the (thinned) sample.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dbModule: typeof import('../app/lib/db');
let tmpDir: string;

// Toy geocoder: FR is west of lon 5, HU is east of lon 15, HR is in between.
function lookupCC(_lat: number, lon: number): string | null {
  if (lon < 5) return 'FR';
  if (lon > 15) return 'HU';
  return 'HR';
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-db-test-'));
  process.env.DB_PATH = tmpDir;
  dbModule = await import('../app/lib/db');
  dbModule.getStormByKey('__init__'); // force schema init
});

afterAll(() => {
  delete process.env.DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('reconcileCountryPaths', () => {
  it('drops a country_path entry with no supporting strikes left in the sample', () => {
    // Storm claims it passed through FR, HR, HU, but every surviving strike
    // is in HR/HU territory (lon >= 5) — FR was thinned away entirely.
    const strikes: Array<[number, number, number]> = Array.from({ length: 40 }, (_, i) => [45, 10 + i * 0.2, 1000 + i]);
    dbModule.upsertStorms([{
      code: 'HU', count: 100, rate: 20, lat: 45, lon: 17, city: null, date: '2026-08-21',
      originLat: 45, originLon: 10, originCity: null,
      startTime: 1000, endTime: 2000, stormKey: 'TEST:path:1',
      totalCount: 100, traveledKm: 500, strikes, countryPath: ['FR', 'HR', 'HU'],
    }]);

    const fixed = dbModule.reconcileCountryPaths(lookupCC);
    expect(fixed).toBeGreaterThanOrEqual(1);

    const after = dbModule.getStormByKey('TEST:path:1');
    expect(after!.countryPath).toEqual(['HR', 'HU']); // FR dropped, order preserved
  });

  it('always keeps the storm\'s own tracked code, even with no supporting strikes', () => {
    // Every strike falls in HR territory (5 <= lon <= 15); neither listed
    // country ('DE' nor 'AT') is ever evidenced by lookupCC.
    const strikes: Array<[number, number, number]> = Array.from({ length: 10 }, (_, i) => [45, 10 + i * 0.2, 1000 + i]);
    dbModule.upsertStorms([{
      code: 'FR', count: 10, rate: 5, lat: 45, lon: 11, city: null, date: '2026-08-21',
      originLat: 45, originLon: 10, originCity: null,
      startTime: 1000, endTime: 1100, stormKey: 'TEST:path:2',
      totalCount: 10, traveledKm: 0, strikes, countryPath: ['DE', 'AT'],
    }]);

    dbModule.reconcileCountryPaths(lookupCC);
    const after = dbModule.getStormByKey('TEST:path:2');
    // DE and AT both dropped (no support anywhere), falls back to the tracked code
    expect(after!.countryPath).toEqual(['FR']);
  });

  it('leaves a storm untouched when every listed country is still evidenced', () => {
    const strikes: Array<[number, number, number]> = [[45, 2, 1000], [45, 10, 1100], [45, 20, 1200]];
    dbModule.upsertStorms([{
      code: 'HU', count: 3, rate: 1, lat: 45, lon: 20, city: null, date: '2026-08-21',
      originLat: 45, originLon: 2, originCity: null,
      startTime: 1000, endTime: 1200, stormKey: 'TEST:path:3',
      totalCount: 3, traveledKm: 0, strikes, countryPath: ['FR', 'HR', 'HU'],
    }]);

    dbModule.reconcileCountryPaths(lookupCC);
    const after = dbModule.getStormByKey('TEST:path:3');
    expect(after!.countryPath).toEqual(['FR', 'HR', 'HU']);
  });

  it('leaves single-country paths and storms without strikes alone', () => {
    dbModule.upsertStorms([{
      code: 'NL', count: 10, rate: 2, lat: 52, lon: 5, city: null, date: '2026-08-21',
      originLat: 52, originLon: 5, originCity: null,
      startTime: 1000, endTime: 1100, stormKey: 'TEST:path:4',
      totalCount: 10, traveledKm: 0, strikes: [[52, 5, 1000]], countryPath: ['NL'],
    }]);
    const fixed = dbModule.reconcileCountryPaths(lookupCC);
    const after = dbModule.getStormByKey('TEST:path:4');
    expect(after!.countryPath).toEqual(['NL']);
    expect(fixed).toBe(0);
  });
});
