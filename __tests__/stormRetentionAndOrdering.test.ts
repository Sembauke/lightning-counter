/**
 * Two related fixes:
 *
 * 1. pruneStormStrikes only exempted the day's peak-5-minute-burst storm and
 *    the (at most 4) global storm_records category holders from losing their
 *    replay after 7 days. Storms sitting anywhere in the Top 100 all-time
 *    list — a much bigger set, ranked by total_count — weren't exempted at
 *    all, so most of them lost their replay despite being prominently listed.
 *    Fixed to also protect: the day's biggest storm BY total_count (matching
 *    site-wide convention) and the all-time Top 100 by total_count.
 *
 * 2. getBiggestStormPerDay picked each day's "winner" by peak `count` (a
 *    different storm than total_count-based "biggest" almost as often as
 *    not) and then sorted the whole list by magnitude instead of date —
 *    so the "best storm per day" timeline view actually showed storms out
 *    of chronological order, sorted by size instead. Fixed to pick each
 *    day's winner by total_count and order the timeline by date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BiggestStorm } from '../app/lib/db';

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

function makeStorm(overrides: Partial<BiggestStorm> & { stormKey: string; date: string }): BiggestStorm & { date: string } {
  return {
    code: 'NL', count: 100, rate: 20, lat: 52, lon: 5, city: null,
    originLat: 52, originLon: 5, originCity: null,
    startTime: 1000, endTime: 2000, traveledKm: 0, totalCount: 5000,
    strikes: [[52, 5, 1500]], countryPath: null,
    ...overrides,
  } as BiggestStorm & { date: string };
}

describe('pruneStormStrikes retention', () => {
  const oldEnough = 1_000_000_000; // way more than 7 days before `now` below
  const now = oldEnough + 8 * 24 * 60 * 60 * 1000; // 8 days after end_time

  // A stable pool of 100 huge, unrelated storms occupying the global Top 100
  // by total_count, so nothing below accidentally qualifies just by being
  // the only storm in an otherwise-empty test database.
  beforeAll(() => {
    const fillers = Array.from({ length: 100 }, (_, i) => makeStorm({
      stormKey: `TEST:prune:filler:${i}`,
      date: `2015-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      endTime: oldEnough - 1000 - i,
      totalCount: 100_000_000 - i,
    }));
    dbModule.upsertStorms(fillers);
  });

  it('nulls strikes for an old, unranked, non-record storm', () => {
    dbModule.upsertStorms([
      makeStorm({ stormKey: 'TEST:prune:unranked', date: '2020-01-01', endTime: oldEnough, totalCount: 6000 }),
      // Beats it on the same date, so 'unranked' isn't even its own day's winner.
      makeStorm({ stormKey: 'TEST:prune:unranked-competitor', date: '2020-01-01', endTime: oldEnough + 1, totalCount: 7000 }),
    ]);
    dbModule.pruneStormStrikes(now);
    expect(dbModule.getStormByKey('TEST:prune:unranked')!.strikes).toBeNull();
  });

  it('keeps strikes for an old storm that is a current global record holder', () => {
    const key = 'TEST:prune:record-holder';
    dbModule.upsertStorms([makeStorm({ stormKey: key, date: '2020-01-02', endTime: oldEnough, totalCount: 6000 })]);
    // Make it the 'longest' record holder — a category unrelated to total_count size.
    dbModule.upsertStormRecords([makeStorm({
      stormKey: key, date: '2020-01-02', endTime: oldEnough, startTime: oldEnough - 999_999_999, totalCount: 6000,
    })]);
    dbModule.pruneStormStrikes(now);
    expect(dbModule.getStormByKey(key)!.strikes).not.toBeNull();
  });

  it('keeps strikes for the day\'s biggest storm by total_count, even if another storm that day had a higher peak count', () => {
    const bigTotalKey = 'TEST:prune:day-big-total';
    const bigPeakKey = 'TEST:prune:day-big-peak';
    dbModule.upsertStorms([
      makeStorm({ stormKey: bigTotalKey, date: '2020-01-03', endTime: oldEnough, count: 50, totalCount: 50_000 }),
      makeStorm({ stormKey: bigPeakKey, date: '2020-01-03', endTime: oldEnough + 1, count: 500, totalCount: 6000 }),
    ]);
    dbModule.pruneStormStrikes(now);
    expect(dbModule.getStormByKey(bigTotalKey)!.strikes).not.toBeNull(); // protected: day's biggest by total_count
    expect(dbModule.getStormByKey(bigPeakKey)!.strikes).toBeNull();      // not protected: bigger peak, smaller total
  });

  it('keeps strikes for a storm within the all-time Top 100 by total_count, even when it is not its own day\'s biggest', () => {
    const bigCompetitorKey = 'TEST:prune:top100:competitor';
    const top100OnlyKey = 'TEST:prune:top100:only';
    dbModule.upsertStorms([
      // Beats top100Only on their shared date, so top100Only is NOT the daily winner.
      makeStorm({ stormKey: bigCompetitorKey, date: '2020-02-02', endTime: oldEnough + 10, totalCount: 500_000_000 }),
      // Still far bigger than the weakest filler (~99,999,901) — qualifies for
      // the global Top 100 on its own merit, independent of the daily check.
      makeStorm({ stormKey: top100OnlyKey, date: '2020-02-02', endTime: oldEnough + 11, totalCount: 150_000_000 }),
    ]);
    dbModule.pruneStormStrikes(now);
    expect(dbModule.getStormByKey(top100OnlyKey)!.strikes).not.toBeNull();
  });

  it('does not protect a storm that is neither its day\'s biggest, nor Top 100, nor a record holder — even if a filler storm-of-a-day exists', () => {
    // Same date as an existing filler-adjacent scenario, but deliberately tiny.
    dbModule.upsertStorms([makeStorm({
      stormKey: 'TEST:prune:tiny-loser', date: '2020-02-02', endTime: oldEnough + 12, totalCount: 5100,
    })]);
    dbModule.pruneStormStrikes(now);
    expect(dbModule.getStormByKey('TEST:prune:tiny-loser')!.strikes).toBeNull();
  });

  it('never touches a storm younger than 7 days, regardless of ranking', () => {
    const key = 'TEST:prune:recent';
    dbModule.upsertStorms([makeStorm({ stormKey: key, date: '2020-06-01', endTime: now - 60_000, totalCount: 1 })]);
    dbModule.pruneStormStrikes(now);
    expect(dbModule.getStormByKey(key)!.strikes).not.toBeNull();
  });
});

describe('getBiggestStormPerDay', () => {
  it('picks each day\'s winner by total_count, not peak count', () => {
    dbModule.upsertStorms([
      makeStorm({ stormKey: 'TEST:day:bigtotal', date: '2021-05-05', count: 50, totalCount: 90_000, endTime: 5_000_000 }),
      makeStorm({ stormKey: 'TEST:day:bigpeak', date: '2021-05-05', count: 900, totalCount: 6000, endTime: 5_000_001 }),
    ]);
    const perDay = dbModule.getBiggestStormPerDay();
    const may5 = perDay.find(s => s.date === '2021-05-05');
    expect(may5?.stormKey).toBe('TEST:day:bigtotal');
  });

  it('orders the timeline chronologically (newest first), not by magnitude', () => {
    dbModule.upsertStorms([
      makeStorm({ stormKey: 'TEST:order:old-huge', date: '2018-01-01', totalCount: 999_999, endTime: 6_000_000 }),
      makeStorm({ stormKey: 'TEST:order:mid-small', date: '2018-06-01', totalCount: 6000, endTime: 6_100_000 }),
      makeStorm({ stormKey: 'TEST:order:new-tiny', date: '2018-12-01', totalCount: 5001, endTime: 6_200_000 }),
    ]);
    const perDay = dbModule.getBiggestStormPerDay();
    const dates = perDay.map(s => s.date).filter(d => d.startsWith('2018'));
    expect(dates).toEqual(['2018-12-01', '2018-06-01', '2018-01-01']); // newest first, despite being the smallest
  });
});
