/** Integration tests: startup repair uses durable replay ownership, never raw proximity. */
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
  dbModule.getStormByKey('__init__'); // force schema init
});

afterAll(() => {
  delete process.env.DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A deterministic cluster of strikes spread across the requested interval. */
function denseCluster(centerLat: number, centerLon: number, fromMs: number, toMs: number, count = 120) {
  const out: Array<{ lat: number; lon: number; time: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({
      lat: centerLat + ((i % 7) / 7 - 0.5) * 0.05,
      lon: centerLon + ((i % 11) / 11 - 0.5) * 0.05,
      time: fromMs + Math.floor((i / count) * (toMs - fromMs)),
    });
  }
  return out;
}

function own(stormKey: string, points: Array<{ lat: number; lon: number; time: number }>, now: number) {
  dbModule.saveStormReplayOwnership([{ stormKey, strikes: points.map(p => [p.lat, p.lon, p.time]) }], now);
}

describe('backfillStormTail', () => {
  it('restores a truncated tail from recorded membership across the missing interval', () => {
    const t0 = 10_000_000;
    // Storm's known strikes end at t0; it was tracked (end_time) for another 20 minutes.
    dbModule.upsertStorms([{
      code: 'IT', count: 100, rate: 20, lat: 44.2, lon: 9.2, city: null, date: '2026-08-20',
      originLat: 43.5, originLon: 8.5, originCity: null,
      startTime: t0 - 3_600_000, endTime: t0 + 20 * 60_000, stormKey: 'TEST:backfill:1',
      totalCount: 5000, traveledKm: 50, strikes: [[44.0, 9.0, t0]], countryPath: ['IT'],
    }]);

    // Archive the real continuation and its recorded membership as it moves.
    let cursor = t0;
    let lat = 44.0, lon = 9.0;
    for (let chunk = 0; chunk < 4; chunk++) {
      const chunkEnd = cursor + 5 * 60_000;
      const batch = denseCluster(lat, lon, cursor + 1000, chunkEnd - 1000);
      dbModule.archiveGridStrikeBatch(batch);
      own('TEST:backfill:1', batch, t0 + 30 * 60_000);
      lat += 0.05; lon += 0.05;
      cursor = chunkEnd;
    }

    const result = dbModule.backfillStormTail('TEST:backfill:1', t0 + 30 * 60_000);
    expect(result).not.toBeNull();
    expect(result!.recoveredStrikes).toBeGreaterThan(0);
    expect(result!.chunksMatched).toBeGreaterThan(0);
    expect(result!.reachedEnd).toBe(true);

    const after = dbModule.getStormByKey('TEST:backfill:1');
    expect(after!.strikes!.length).toBeGreaterThan(1);
    // Recovered points should be sorted and span close to the true end_time.
    const maxTime = Math.max(...after!.strikes!.map(s => s[2]));
    expect(maxTime).toBeGreaterThan(t0 + 15 * 60_000);
  });

  it('never fills a gap from a nearby storm, including during the automatic startup scan', () => {
    const t0 = 20_000_000;
    dbModule.upsertStorms([{
      code: 'IT', count: 100, rate: 20, lat: 44.0, lon: 9.0, city: null, date: '2026-08-20',
      originLat: 43.5, originLon: 8.5, originCity: null,
      startTime: t0 - 3_600_000, endTime: t0 + 20 * 60_000, stormKey: 'TEST:backfill:2',
      totalCount: 5000, traveledKm: 50, strikes: [[44.0, 9.0, t0]], countryPath: ['IT'],
    }]);

    // Proximity alone would accept this storm, only a few kilometres away.
    const neighbor = denseCluster(44.02, 9.02, t0 + 1000, t0 + 4 * 60_000, 200);
    dbModule.archiveGridStrikeBatch(neighbor);
    own('TEST:neighbor', neighbor, t0 + 30 * 60_000);

    const result = dbModule.backfillStormTail('TEST:backfill:2', t0 + 30 * 60_000);
    expect(result).not.toBeNull();
    expect(result!.recoveredStrikes).toBe(0); // gave up rather than latching onto the distractor
    expect(result!.reachedEnd).toBe(false);

    const after = dbModule.getStormByKey('TEST:backfill:2');
    expect(after!.strikes!.length).toBe(1); // untouched
    dbModule.backfillGappedStormTails(t0 + 30 * 60_000);
    expect(dbModule.getStormByKey('TEST:backfill:2')!.strikes).toEqual(after!.strikes);
  });

  it('ignores a distant distractor even when a real nearby continuation also exists', () => {
    const t0 = 30_000_000;
    dbModule.upsertStorms([{
      code: 'IT', count: 100, rate: 20, lat: 44.0, lon: 9.0, city: null, date: '2026-08-20',
      originLat: 43.5, originLon: 8.5, originCity: null,
      startTime: t0 - 3_600_000, endTime: t0 + 20 * 60_000, stormKey: 'TEST:backfill:3',
      totalCount: 5000, traveledKm: 50, strikes: [[44.0, 9.0, t0]], countryPath: ['IT'],
    }]);

    // Real continuation right next to the last known point...
    const continuation = denseCluster(44.02, 9.02, t0 + 1000, t0 + 4 * 60_000, 120);
    dbModule.archiveGridStrikeBatch(continuation);
    own('TEST:backfill:3', continuation, t0 + 30 * 60_000);
    // ...plus an unrelated, larger storm far away in the same window.
    dbModule.archiveGridStrikeBatch(denseCluster(53.0, 10.0, t0 + 1000, t0 + 4 * 60_000, 300));

    const result = dbModule.backfillStormTail('TEST:backfill:3', t0 + 30 * 60_000);
    expect(result!.recoveredStrikes).toBeGreaterThan(0);
    const after = dbModule.getStormByKey('TEST:backfill:3');
    for (const [lat, lon] of after!.strikes!) {
      // Every recovered point stays near the true continuation, never near the distractor.
      expect(Math.abs(lat - 44.0)).toBeLessThan(1);
      expect(Math.abs(lon - 9.0)).toBeLessThan(1);
    }
  });

  it('returns null for a gap smaller than the minimum worth backfilling', () => {
    const t0 = 40_000_000;
    dbModule.upsertStorms([{
      code: 'IT', count: 10, rate: 5, lat: 44.0, lon: 9.0, city: null, date: '2026-08-20',
      originLat: 44.0, originLon: 9.0, originCity: null,
      startTime: t0 - 60_000, endTime: t0 + 60_000, stormKey: 'TEST:backfill:4', // 1 min gap
      totalCount: 10, traveledKm: 0, strikes: [[44.0, 9.0, t0]], countryPath: null,
    }]);
    expect(dbModule.backfillStormTail('TEST:backfill:4', t0 + 60_000)).toBeNull();
  });

  it('returns null once the gap has aged out of the ownership retention window', () => {
    const t0 = 1_000_000;
    dbModule.upsertStorms([{
      code: 'IT', count: 10, rate: 5, lat: 44.0, lon: 9.0, city: null, date: '2026-08-01',
      originLat: 44.0, originLon: 9.0, originCity: null,
      startTime: t0 - 3_600_000, endTime: t0 + 30 * 60_000, stormKey: 'TEST:backfill:5',
      totalCount: 10, traveledKm: 0, strikes: [[44.0, 9.0, t0]], countryPath: null,
    }]);
    const wayLater = t0 + 4 * 24 * 60 * 60 * 1000; // 4 days later — past the 3-day retention
    expect(dbModule.backfillStormTail('TEST:backfill:5', wayLater)).toBeNull();
  });

  it('mirrors the recovered blob into country_biggest_storms and storm_records for the same storm_key', () => {
    const t0 = 50_000_000;
    dbModule.upsertStorms([{
      code: 'IT', count: 100, rate: 20, lat: 44.0, lon: 9.0, city: null, date: '2026-08-20',
      originLat: 44.0, originLon: 9.0, originCity: null,
      startTime: t0 - 3_600_000, endTime: t0 + 20 * 60_000, stormKey: 'TEST:backfill:6',
      totalCount: 5000, traveledKm: 50, strikes: [[44.0, 9.0, t0]], countryPath: ['IT'],
    }]);
    dbModule.upsertBiggestStorms([{
      code: 'ITBK', count: 100, rate: 20, lat: 44.0, lon: 9.0, city: null, date: '2026-08-20',
      originLat: 44.0, originLon: 9.0, originCity: null,
      startTime: t0 - 3_600_000, endTime: t0 + 20 * 60_000, stormKey: 'TEST:backfill:6',
      totalCount: 5000, traveledKm: 50, strikes: [[44.0, 9.0, t0]], countryPath: ['IT'],
    }]);

    const continuation = denseCluster(44.01, 9.01, t0 + 1000, t0 + 4 * 60_000, 120);
    dbModule.archiveGridStrikeBatch(continuation);
    own('TEST:backfill:6', continuation, t0 + 30 * 60_000);
    dbModule.backfillStormTail('TEST:backfill:6', t0 + 30 * 60_000);

    const countryAfter = dbModule.getBiggestStorm('ITBK');
    expect(countryAfter!.strikes!.length).toBeGreaterThan(1);
  });
});

describe('backfillGappedStormTails', () => {
  it('only attempts storms whose end_time is still within the retention window', () => {
    const now = 100_000_000;
    const recent = now - 60 * 60_000; // 1 hour ago — in range
    const stale = now - 4 * 24 * 60 * 60 * 1000; // 4 days ago — out of range

    dbModule.upsertStorms([
      {
        code: 'IT', count: 100, rate: 20, lat: 44.0, lon: 9.0, city: null, date: '2026-08-20',
        originLat: 44.0, originLon: 9.0, originCity: null,
        startTime: recent - 3_600_000, endTime: recent, stormKey: 'TEST:scan:recent',
        totalCount: 5000, traveledKm: 50, strikes: [[44.0, 9.0, recent - 20 * 60_000]], countryPath: ['IT'],
      },
      {
        code: 'IT', count: 100, rate: 20, lat: 44.0, lon: 9.0, city: null, date: '2026-08-01',
        originLat: 44.0, originLon: 9.0, originCity: null,
        startTime: stale - 3_600_000, endTime: stale, stormKey: 'TEST:scan:stale',
        totalCount: 5000, traveledKm: 50, strikes: [[44.0, 9.0, stale - 20 * 60_000]], countryPath: ['IT'],
      },
    ]);

    const results = dbModule.backfillGappedStormTails(now);
    const keys = results.map(r => r.stormKey);
    expect(keys).toContain('TEST:scan:recent');
    expect(keys).not.toContain('TEST:scan:stale');
  });
});
