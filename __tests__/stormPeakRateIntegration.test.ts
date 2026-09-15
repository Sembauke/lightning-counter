import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: () => 'IT' }));

const globals = globalThis as typeof globalThis & Record<string, any>;
const previousDbPath = process.env.DB_PATH;
const now = Date.UTC(2026, 8, 15, 12);
const stateKeys = ['_iv_histPrune', '_iv_dbFlush', '_iv_gridBatch', '_iv_hourly', '_routeIntervals',
  '_processStrike', '_processStrikes', '_flushIngestion', '_stopIngestion', '_strikeQueue', '_recentStrikes',
  '_sseControllers', '_sseBcastGen', '_serverTotal', '_serverCountryCounts', '_todayCounts', '_todayDate',
  '_stormSeq', '_stormStrikeOwnership', '_stormStrikeSubscribers', '_activeSources', '_ingestionReady'];
let directory: string;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  for (const key of stateKeys) delete globals[key];
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-peak-rate-'));
  process.env.DB_PATH = directory;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const key of stateKeys) delete globals[key];
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

it('persists a higher one-minute peak without viewers or an increase in the five-minute peak', async () => {
  const db = await import('../app/lib/db');
  await import('../app/api/strikes/route');
  await vi.advanceTimersByTimeAsync(0);
  globals._processStrikes(Array.from({ length: 500 }, (_, i) => ({
    lat: 45 + i % 10 * .001, lon: 12, time: now - 299_500 + i * 600,
  })));
  globals._flushIngestion();
  const first = db.getBiggestStorm('IT')!;
  expect(first.count).toBe(500);
  expect(first.rate).toBe(100);

  await vi.advanceTimersByTimeAsync(120_000);
  // The concentrated burst arrives late, after part of its minute has expired.
  // Its complete window remains in the exact five-minute tracking members.
  globals._processStrikes(Array.from({ length: 150 }, (_, i) => ({
    lat: 45 + i % 10 * .001, lon: 12, time: Date.now() - 65_000 + i * 50,
  })));
  globals._flushIngestion();
  const storm = db.getBiggestStorm('IT')!;
  expect(storm.stormKey).toBe(first.stormKey);
  expect(storm.count).toBe(500);
  expect(storm.rate).toBe(150);
  const tracked = db.loadTrackedStorms() as Array<{ currentRate: number; peakCount: number; peakRate: number }>;
  expect(tracked).toHaveLength(1);
  expect(tracked[0]).toMatchObject({ currentRate: 90, peakCount: 500, peakRate: 150 });
  expect((await import('../app/lib/strikeStream')).getStormLiveRates([storm.stormKey!]).rates[storm.stormKey!]).toBe(49);

  await vi.advanceTimersByTimeAsync(90_000);
  expect(db.getBiggestStorm('IT')!.rate).toBe(150);
  vi.resetModules();
  await import('../app/api/strikes/route');
  globals._flushIngestion();
  const restored = (await import('../app/lib/db')).getBiggestStorm('IT')!;
  expect(restored.stormKey).toBe(storm.stormKey);
  expect(restored.rate).toBe(150);
});

it('retains the final live peak when the next tracking pass drops below the storm threshold', async () => {
  const db = await import('../app/lib/db');
  await import('../app/api/strikes/route');
  await vi.advanceTimersByTimeAsync(0);
  const batch = (count: number, first: number) => Array.from({ length: count }, (_, i) => ({
    lat: 45 + i % 10 * .001, lon: 12, time: first + i * 100,
  }));
  globals._processStrikes([...batch(40, now - 299_000), ...batch(35, now - 150_000), ...batch(25, now - 30_000)]);
  globals._flushIngestion();
  const first = db.getBiggestStorm('IT')!;
  expect(first).toMatchObject({ count: 100, rate: 40, totalCount: 100, endTime: now });
  // Country-path enrichment can exist only in the stored rows. A final peak
  // must update those copies without replacing their metadata from the tracker.
  const enriched = { ...first, countryPath: ['IT'] };
  db.upsertStorms([enriched]);
  db.upsertBiggestStorms([enriched]);
  db.upsertStormRecords([enriched]);

  await vi.advanceTimersByTimeAsync(10_000);
  globals._processStrikes(batch(26, now + 5000));
  const live = (await import('../app/lib/strikeStream')).getStormLiveRates([first.stormKey!]);
  expect(live.rates[first.stormKey!]).toBe(51);
  await vi.advanceTimersByTimeAsync(20_000);

  // Forty older points expire, leaving only 86 in five minutes. Saving its new
  // peak must not extend its official lifetime or add the fading tail to totals.
  const expected = { stormKey: first.stormKey, count: 100, rate: 51, totalCount: 100, endTime: now, date: first.date, countryPath: ['IT'] };
  expect(db.getBiggestStorm('IT')).toMatchObject(expected);
  expect(db.getStormByKey(first.stormKey!)).toMatchObject(expected);
  expect(db.loadTrackedStorms()).toEqual([expect.objectContaining({ currentRate: 0, peakRate: 51, lastSeen: now })]);
  expect(db.getStormRecords().filter(storm => storm.stormKey === first.stormKey).length).toBeGreaterThan(0);
  for (const record of db.getStormRecords().filter(storm => storm.stormKey === first.stormKey)) expect(record).toMatchObject(expected);

  vi.resetModules();
  await import('../app/api/strikes/route');
  globals._flushIngestion();
  expect((await import('../app/lib/db')).getBiggestStorm('IT')).toMatchObject(expected);
});
