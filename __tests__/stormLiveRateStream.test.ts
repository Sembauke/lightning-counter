import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StormLiveRateSnapshot } from '../app/lib/stormLiveRate';

vi.mock('../app/lib/geoCountry', () => ({ getCountryCode: () => 'IT' }));
const globals = globalThis as typeof globalThis & Record<string, any>;
const previousDbPath = process.env.DB_PATH;
const now = Date.UTC(2026, 8, 13, 12);
let directory: string;
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
const stateKeys = ['_iv_histPrune', '_iv_dbFlush', '_iv_gridBatch', '_iv_hourly', '_routeIntervals',
  '_processStrike', '_processStrikes', '_flushIngestion', '_stopIngestion', '_strikeQueue', '_recentStrikes',
  '_sseControllers', '_sseBcastGen', '_serverTotal', '_serverCountryCounts', '_todayCounts', '_todayDate',
  '_stormSeq', '_stormStrikeOwnership', '_stormStrikeSubscribers', '_activeSources', '_ingestionReady'];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  for (const key of stateKeys) delete globals[key];
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-live-rate-stream-'));
  process.env.DB_PATH = directory;
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel();
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const key of stateKeys) delete globals[key];
  if (previousDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = previousDbPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function event<T>(reader: ReadableStreamDefaultReader<Uint8Array>, name: string): Promise<T> {
  for (let i = 0; i < 10; i++) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Stream closed before snapshot');
    const chunk = new TextDecoder().decode(value);
    if (chunk.startsWith(`event: ${name}\n`)) return JSON.parse(chunk.split('\ndata: ')[1]);
  }
  throw new Error(`Missing ${name} event`);
}

it('gives map and detail viewers the same one-second rates, including quiet-window expiry', async () => {
  const route = await import('../app/api/strikes/route');
  await vi.advanceTimersByTimeAsync(0);
  globals._processStrikes(Array.from({ length: 120 }, (_, i) => ({
    lat: 45 + (i % 10) * .001, lon: 12 + Math.floor(i / 10) * .001,
    time: now - 59_500 + i * 400,
  })));
  globals._flushIngestion();

  const mapReader = (await route.GET()).body!.getReader();
  const detailReader = (await route.GET()).body!.getReader();
  readers.push(mapReader, detailReader);
  const summaries = await event<Array<{ key: string; rate: number }>>(mapReader, 'storms');
  const key = summaries[0].key;
  expect(summaries[0].rate).toBe(24); // Detection still uses its stable five-minute average.
  const mapInitial = await event<StormLiveRateSnapshot>(mapReader, 'storm-rates');
  const detailInitial = await event<StormLiveRateSnapshot>(detailReader, 'storm-rates');
  expect(mapInitial).toEqual({ at: now, rates: { [key]: 120 } });
  expect(detailInitial).toEqual(mapInitial);

  globals._processStrike(45.005, 12.005, now);
  await vi.advanceTimersByTimeAsync(1000);
  const mapUpdated = await event<StormLiveRateSnapshot>(mapReader, 'storm-rates');
  const detailUpdated = await event<StormLiveRateSnapshot>(detailReader, 'storm-rates');
  expect(mapUpdated).toEqual({ at: now + 1000, rates: { [key]: 119 } });
  expect(detailUpdated).toEqual(mapUpdated);
});
