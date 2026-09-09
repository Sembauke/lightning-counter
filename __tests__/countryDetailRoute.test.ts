import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { BiggestStorm } from '../app/lib/db';

const NOW = Date.UTC(2026, 8, 9, 0, 0, 1);
const TODAY = '2026-09-09';
const YESTERDAY = '2026-09-08';
const oldDbPath = process.env.DB_PATH;
const globals = globalThis as typeof globalThis & { _todayDate?: string; _todayCounts?: Record<string, number> };
const oldLiveDate = globals._todayDate;
const oldLiveCounts = globals._todayCounts;
let tmpDir: string;
let sql: Database.Database;
let db: typeof import('../app/lib/db');
let route: typeof import('../app/api/country/[code]/route');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightning-country-detail-'));
  process.env.DB_PATH = tmpDir;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = await import('../app/lib/db');
  db.getCountryHistory('IT');
  sql = new Database(path.join(tmpDir, 'lightning.db'));
  route = await import('../app/api/country/[code]/route');
});

beforeEach(() => {
  vi.setSystemTime(NOW);
  delete globals._todayDate;
  delete globals._todayCounts;
  sql.exec(`DELETE FROM daily_strikes; DELETE FROM country_peaks;
    DELETE FROM storms; DELETE FROM country_biggest_storms; DELETE FROM storm_records;
    DELETE FROM storm_replay_points; DELETE FROM storm_aliases;`);
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  sql.close();
  if (oldDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = oldDbPath;
  if (oldLiveDate === undefined) delete globals._todayDate;
  else globals._todayDate = oldLiveDate;
  if (oldLiveCounts === undefined) delete globals._todayCounts;
  else globals._todayCounts = oldLiveCounts;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function history(date: string, count: number, code = 'IT') {
  sql.prepare('INSERT OR REPLACE INTO daily_strikes (date, code, count) VALUES (?, ?, ?)').run(date, code, count);
}
function peak(count: number, date: string, code = 'IT') {
  sql.prepare('INSERT OR REPLACE INTO country_peaks (code, count, date) VALUES (?, ?, ?)').run(code, count, date);
}
async function get(summary = true, code = 'IT') {
  const response = await route.GET(new Request(`http://localhost/api/country/${code}${summary ? '?summary=1' : ''}`), { params: Promise.resolve({ code }) });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json();
}

describe('selected-country live summaries', () => {
  it('returns coherent live header/history values without querying or recovering a replay', async () => {
    history('2026-09-01', 50);
    history(YESTERDAY, 80);
    history(TODAY, 100);
    history(TODAY, 900, 'US');
    peak(120, '2026-08-01');
    globals._todayDate = TODAY;
    globals._todayCounts = { IT: 145, US: 901 };
    const biggest = vi.spyOn(db, 'getBiggestStorm').mockImplementation(() => { throw new Error('Unexpected replay lookup'); });
    const recovery = vi.spyOn(db, 'getStormReplayByKey').mockImplementation(() => { throw new Error('Unexpected replay recovery'); });

    expect(await get()).toEqual({
      row: { code: 'IT', today: 145, peakCount: 145, peakDate: TODAY },
      history: [{ date: TODAY, count: 145 }, { date: YESTERDAY, count: 80 }, { date: '2026-09-01', count: 50 }],
    });
    expect(biggest).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    // Reading a live summary does not flush counters or change daily records.
    expect(db.getCountryHistory('IT')[0]).toEqual({ date: TODAY, count: 100 });
    expect(db.getCountryPeak('IT')).toEqual({ count: 120, date: '2026-08-01' });
  });

  it('lets explicit zero and an absent country in current live counters replace stale persisted today counts', async () => {
    history(TODAY, 32);
    peak(40, '2026-08-01');
    globals._todayDate = TODAY;
    const liveCounts: Array<Record<string, number>> = [{ IT: 0 }, { US: 12 }];
    for (const counts of liveCounts) {
      globals._todayCounts = counts;
      const data = await get();
      expect(data.row).toEqual({ code: 'IT', today: 0, peakCount: 40, peakDate: '2026-08-01' });
      expect(data.history).toEqual([{ date: TODAY, count: 0 }]);
    }
  });

  it('keeps yesterday’s final unflushed count on yesterday when UTC rolls over, then refreshes the new day', async () => {
    history(YESTERDAY, 100);
    peak(100, YESTERDAY);
    globals._todayDate = YESTERDAY;
    globals._todayCounts = { IT: 125 };
    const beforeFirstStrike = await get();
    expect(beforeFirstStrike.row).toEqual({ code: 'IT', today: 0, peakCount: 125, peakDate: YESTERDAY });
    expect(beforeFirstStrike.history).toEqual([{ date: TODAY, count: 0 }, { date: YESTERDAY, count: 125 }]);

    // Ingestion durably saves yesterday before moving its memory to today.
    db.saveDailyAndPeaks(YESTERDAY, { IT: 125 });
    globals._todayDate = TODAY;
    globals._todayCounts = { IT: 3 };
    const afterFirstStrike = await get();
    expect(afterFirstStrike.row).toEqual({ code: 'IT', today: 3, peakCount: 125, peakDate: YESTERDAY });
    expect(afterFirstStrike.history).toEqual([{ date: TODAY, count: 3 }, { date: YESTERDAY, count: 125 }]);
  });

  it('ignores older or future live dates and falls back to the country’s persisted current day', async () => {
    history(TODAY, 17);
    history(YESTERDAY, 12);
    peak(20, '2026-08-01');
    for (const date of ['2026-09-07', '2026-09-10', undefined]) {
      globals._todayDate = date;
      globals._todayCounts = { IT: 9000 };
      const data = await get();
      expect(data.row).toEqual({ code: 'IT', today: 17, peakCount: 20, peakDate: '2026-08-01' });
      expect(data.history).toEqual([{ date: TODAY, count: 17 }, { date: YESTERDAY, count: 12 }]);
    }
  });

  it('retains the saved record date on ties and reflects a strict live increase before persistence', async () => {
    peak(100, '2026-08-01');
    globals._todayDate = TODAY;
    globals._todayCounts = { IT: 100 };
    expect((await get()).row).toEqual({ code: 'IT', today: 100, peakCount: 100, peakDate: '2026-08-01' });
    globals._todayCounts.IT = 101;
    expect((await get()).row).toEqual({ code: 'IT', today: 101, peakCount: 101, peakDate: TODAY });
  });

  it('normalizes lowercase country codes and supplies an explicit zero row when no data exists', async () => {
    history(TODAY, 24);
    expect((await get(true, 'it')).row).toEqual({ code: 'IT', today: 24, peakCount: 24, peakDate: TODAY });
    expect(await get(true, 'xo')).toEqual({
      row: { code: 'XO', today: 0, peakCount: 0, peakDate: '' }, history: [{ date: TODAY, count: 0 }],
    });
  });

  it('uses the code-first history index rather than scanning all countries for each poll', () => {
    const plan = sql.prepare('EXPLAIN QUERY PLAN SELECT date, count FROM daily_strikes WHERE code = ? ORDER BY date DESC')
      .all('IT') as Array<{ detail: string }>;
    expect(plan.some(row => row.detail.includes('idx_daily_strikes_code_date') && row.detail.includes('code=?'))).toBe(true);
    expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
  });

  it('preserves the initial full response and its durable biggest-storm replay recovery', async () => {
    const time = NOW - 2 * 60 * 60_000;
    const storm: BiggestStorm = {
      stormKey: 'IT:country-replay', code: 'IT', count: 200, rate: 40,
      lat: 45, lon: 7, city: 'Example', date: YESTERDAY,
      originLat: 45, originLon: 7, originCity: 'Example',
      startTime: time, endTime: time + 60_000, traveledKm: 0, totalCount: 6000,
      strikes: [[45, 7, time], [45, 7, time + 60_000]], countryPath: ['IT'],
    };
    db.upsertStorms([storm]);
    db.upsertBiggestStorms([storm]);
    const missing: [number, number, number] = [45, 7.02, time + 30_000];
    db.saveStormReplayOwnership([{ stormKey: storm.stormKey!, strikes: [missing] }], NOW);
    const biggest = vi.spyOn(db, 'getBiggestStorm');
    const recovery = vi.spyOn(db, 'getStormReplayByKey');

    const data = await get(false, 'it');
    expect(data.row).toEqual({ code: 'IT', today: 0, peakCount: 0, peakDate: '' });
    expect(data.history).toEqual([{ date: TODAY, count: 0 }]);
    expect(data.biggestStorm.stormKey).toBe(storm.stormKey);
    expect(data.biggestStorm.totalCount).toBe(6000);
    expect(data.biggestStorm.strikes).toContainEqual(missing);
    expect(biggest).toHaveBeenCalledTimes(2);
    expect(recovery).toHaveBeenCalledExactlyOnceWith(storm.stormKey);
  });
});
