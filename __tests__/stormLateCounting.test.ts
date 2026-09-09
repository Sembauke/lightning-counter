import { describe, expect, it } from 'vitest';
import { compactStormCounting, countStormStrike, COUNTED_STRIKE_WINDOW_MS, emptyStormCounting, mergeStormCounting, type CountingStorm } from '../app/lib/stormCounting';
import { lifecycleStrikeId } from '../app/lib/stormLifecycle';

const NOW = Date.UTC(2026, 8, 9, 16);
const point = (lon: number, time = NOW - 30_000) => ({ lat: 45, lon, time });
const storm = (key = 'A'): CountingStorm => ({ key, totalStrikes: 0, counting: emptyStormCounting() });

describe('late official strike counting', () => {
  it('counts distinct equal-time and older strikes once through shuffled delivery and restart', () => {
    let owner = storm();
    const newest = point(7), sameTime = point(7.1), older = point(7.2, NOW - 120_000);
    for (const p of [newest, sameTime, older]) expect(countStormStrike(owner, p, NOW)).toBe(true);
    expect(owner.totalStrikes).toBe(3);
    owner = JSON.parse(JSON.stringify(owner));
    for (const p of [older, newest, sameTime, older]) expect(countStormStrike(owner, p, NOW + 30_000)).toBe(false);
    expect(countStormStrike(owner, point(7.3, NOW - 180_000), NOW + 30_000)).toBe(true);
    expect(owner.totalStrikes).toBe(4);
  });

  it('cannot recount an expired identity after compaction has removed its exact ID', () => {
    const a = storm(), b = storm('B');
    const old = point(7);
    expect(countStormStrike(a, old, NOW)).toBe(true);
    expect(countStormStrike(b, old, NOW)).toBe(true);
    const later = old.time + COUNTED_STRIKE_WINDOW_MS;
    compactStormCounting([a, b], later);
    expect(a.counting!.recent).toEqual({});
    expect(Object.values(a.counting!.cohorts)).toEqual([1]);
    expect(countStormStrike(a, old, later)).toBe(false);
    expect(countStormStrike(a, point(7.1, old.time - 1), later)).toBe(false);
    expect(countStormStrike(a, point(7.2, old.time + 1), later)).toBe(true);
    expect(countStormStrike(a, point(7.3, later + 1), later)).toBe(false);
    expect(mergeStormCounting(a, b)).toBe(0);
    expect(a.totalStrikes).toBe(2);
  });

  it('deduplicates delayed strikes after merging and keeps the latest unknown legacy cutoff', () => {
    const a = storm(), b = storm('B');
    a.totalStrikes = 100;
    a.counting!.legacy = { total: 100, ancestors: {}, through: NOW - 180_000 };
    b.totalStrikes = 200;
    b.counting!.legacy = { total: 200, ancestors: {}, through: NOW - 120_000 };
    const shared = point(7, NOW - 60_000);
    expect(countStormStrike(a, shared, NOW)).toBe(true);
    expect(countStormStrike(b, shared, NOW)).toBe(true);
    expect(mergeStormCounting(a, b)).toBe(200);
    expect(a.totalStrikes).toBe(301);
    expect(a.counting!.legacy!.through).toBe(NOW - 120_000);
    expect(countStormStrike(a, shared, NOW)).toBe(false);
    expect(countStormStrike(a, point(7.1, NOW - 120_000), NOW)).toBe(false);
    expect(countStormStrike(a, point(7.2, NOW - 90_000), NOW)).toBe(true);
    expect(a.totalStrikes).toBe(302);
  });

  it('uses official identity records independently of missing samples or replay-only points', () => {
    const owner = { ...storm(), allStrikes: [] as number[][] };
    const counted = point(7), tail = point(7.1, NOW - 60_000);
    expect(countStormStrike(owner, counted, NOW)).toBe(true);
    // The counted sample was thinned; the tail is visible but not official yet.
    owner.allStrikes = [[tail.lat, tail.lon, tail.time]];
    expect(owner.counting!.recent[lifecycleStrikeId(tail)]).toBeUndefined();
    expect(countStormStrike(owner, counted, NOW)).toBe(false);
    expect(countStormStrike(owner, tail, NOW)).toBe(true);
    expect(countStormStrike(owner, tail, NOW)).toBe(false);
    expect(owner.totalStrikes).toBe(2);
  });
});
