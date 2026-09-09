import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { countryLookup } = vi.hoisted(() => ({ countryLookup: vi.fn((): string | null => 'IT') }));
vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: countryLookup }));

const globals = globalThis as typeof globalThis & Record<string, any>;
const keys = ['_iv_histPrune', '_iv_dbFlush', '_iv_gridBatch', '_iv_hourly', '_routeIntervals',
  '_processStrike', '_processStrikes', '_flushIngestion', '_stopIngestion', '_ingestionReady',
  '_strikeQueue', '_recentStrikes', '_sseControllers', '_sseBcastGen', '_serverTotal', '_serverCountryCounts',
  '_todayCounts', '_todayDate', '_stormSeq', '_stormStrikeOwnership', '_stormStrikeSubscribers', '_activeSources'];
const midnight = Date.parse('2026-09-10T00:00:00Z');
let directory: string;
let db: typeof import('../app/lib/db');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(midnight + 1000);
  vi.stubEnv('TZ', 'America/New_York');
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-daily-date-'));
  vi.stubEnv('DB_PATH', directory);
  for (const key of keys) delete globals[key];
  globals._recentStrikes = [];
  globals._strikeQueue = [];
  globals._sseControllers = new Set();
  countryLookup.mockReset().mockReturnValue('IT');
  db = await import('../app/lib/db');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const key of keys) delete globals[key];
  fs.rmSync(directory, { recursive: true, force: true });
});

async function flush() {
  if (globals._flushIngestion) globals._flushIngestion();
  else await vi.advanceTimersByTimeAsync(30_000);
}

describe('daily totals use the discharge UTC date', () => {
  it('shows the new UTC day in the main archive before any post-midnight delivery', async () => {
    db.saveDailyAndPeaks('2026-09-09', { IT: 100 });
    db.saveDailyAndPeaks('2026-09-10', { IT: 3 });
    globals._todayDate = '2026-09-09';
    globals._todayCounts = { IT: 100 };
    const archive = await import('../app/api/archive/route');
    expect((await (await archive.GET()).json()).find((row: { code: string }) => row.code === 'IT').today).toBe(3);
  });

  it('credits a strike delivered after midnight to yesterday and keeps today separate', async () => {
    db.saveDailyAndPeaks('2026-09-09', { IT: 100 });
    db.saveDailyAndPeaks('2026-09-10', { IT: 3 });
    db.saveCounters(103, { IT: 103 });
    await import('../app/api/strikes/route');
    globals._processStrike(45, 12, midnight - 1000);
    globals._processStrike(45.001, 12, midnight + 1000);
    expect(globals._todayDate).toBe('2026-09-10');
    expect(globals._todayCounts).toEqual({ IT: 4 });
    expect(globals._serverTotal).toBe(105);
    await flush();
    expect(db.loadDailyStrikes('2026-09-09')).toEqual({ IT: 101 });
    expect(db.loadDailyStrikes('2026-09-10')).toEqual({ IT: 4 });
    expect(db.getCountryPeak('IT')).toEqual({ date: '2026-09-09', count: 101 });
    expect(db.getGlobalDailyTotals().reduce((sum, row) => sum + row.total, 0)).toBe(105);
  });

  it('handles out-of-order older deliveries and ocean strikes without replacing today’s counters', async () => {
    db.saveDailyAndPeaks('2026-09-08', { IT: 20 });
    db.saveDailyAndPeaks('2026-09-09', { IT: 30 });
    await import('../app/api/strikes/route');
    globals._processStrike(45, 12, midnight - 25 * 60 * 60_000);
    countryLookup.mockReturnValue(null);
    globals._processStrike(0, 0, midnight - 1000);
    countryLookup.mockReturnValue('IT');
    globals._processStrike(45.001, 12, midnight + 1000);
    expect(globals._todayCounts).toEqual({ IT: 1 });
    await flush();
    expect(db.loadDailyStrikes('2026-09-08')).toEqual({ IT: 21 });
    expect(db.loadDailyStrikes('2026-09-09')).toEqual({ IT: 30, XO: 1 });
    expect(db.loadDailyStrikes('2026-09-10')).toEqual({ IT: 1 });
  });

  it('keeps an admitted next-day timestamp when the wall clock later rolls over', async () => {
    vi.setSystemTime(midnight - 1000);
    await import('../app/api/strikes/route');
    // Existing ingestion allows up to one minute of provider clock skew.
    globals._processStrike(45, 12, midnight + 1000);
    expect(globals._todayDate).toBe('2026-09-09');
    expect(globals._todayCounts.IT ?? 0).toBe(0);
    await flush();
    vi.setSystemTime(midnight + 2000);
    globals._processStrike(45.001, 12, midnight + 2000);
    expect(globals._todayDate).toBe('2026-09-10');
    expect(globals._todayCounts).toEqual({ IT: 2 });
    await flush();
    expect(db.loadDailyStrikes('2026-09-10')).toEqual({ IT: 2 });
  });

  it('recovers mixed midnight buckets once and preserves dates recorded by the previous journal format', async () => {
    // An already accepted row from the arrival-date release stays in its
    // recorded bucket. Only new acceptance uses the corrected discharge date.
    db.appendStrikeIntake([{
      identity: `45,12,${midnight - 1000}`, receivedAt: midnight + 1000,
      time: midnight - 1000, lat: 45, lon: 12, cc: 'IT', countDate: '2026-09-10', live: 1,
    }]);
    await import('../app/api/strikes/route');
    const delivered = [
      { lat: 45.001, lon: 12, time: midnight - 500 },
      { lat: 45.002, lon: 12, time: midnight + 1000 },
    ];
    globals._processStrikes(delivered);
    expect(globals._todayCounts).toEqual({ IT: 2 });
    // Lose the memory before another checkpoint. Rebuild from the journal on
    // a later UTC day without moving any strike into that startup day's bucket.
    vi.clearAllTimers();
    for (const key of keys) delete globals[key];
    vi.setSystemTime(midnight + 2 * 24 * 60 * 60_000);
    vi.resetModules();
    await import('../app/api/strikes/route');
    db = await import('../app/lib/db');
    expect(db.loadDailyStrikes('2026-09-09')).toEqual({ IT: 1 });
    expect(db.loadDailyStrikes('2026-09-10')).toEqual({ IT: 2 });
    expect(globals._todayDate).toBe('2026-09-12');
    expect(globals._todayCounts).toEqual({});
    globals._processStrikes(delivered);
    await flush();
    expect(db.loadCounters().total).toBe(3);
    expect(db.getGlobalDailyTotals().reduce((sum, row) => sum + row.total, 0)).toBe(3);
  });

  it('dates active storm records by the checkpoint even when its latest delivery belongs to an older day', async () => {
    await import('../app/api/strikes/route');
    globals._processStrikes(Array.from({ length: 120 }, (_, i) => ({
      lat: 45 + i % 10 * .001, lon: 12 + Math.floor(i / 10) * .001, time: midnight - 1000 - i * 500,
    })));
    globals._processStrike(0, 0, midnight - 25 * 60 * 60_000);
    await flush();
    expect(db.getBiggestStorm('IT')?.date).toBe('2026-09-10');
    expect(db.loadDailyStrikes('2026-09-09')).toEqual({ IT: 120 });
    expect(db.loadDailyStrikes('2026-09-08')).toEqual({ IT: 1 });
    expect(globals._todayCounts).toEqual({});
  });

  it('uses arrival time only when a discharge timestamp is missing or invalid', async () => {
    await import('../app/api/strikes/route');
    for (const [index, time] of [undefined, NaN, Infinity, -Infinity, -1, midnight + 120_000].entries()) {
      globals._processStrike(45 + index * .001, 12, time);
    }
    expect(globals._todayCounts).toEqual({ IT: 6 });
    await flush();
    expect(db.loadDailyStrikes('2026-09-10')).toEqual({ IT: 6 });
    expect(db.getCountryHistory('IT')).toEqual([{ date: '2026-09-10', count: 6 }]);
  });
});
