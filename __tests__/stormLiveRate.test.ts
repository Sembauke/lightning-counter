import { describe, expect, it } from 'vitest';
import type { StormStrike } from '../app/lib/db';
import { getStormLiveRate, peakStormMinuteRate, recentStormStrikes } from '../app/lib/stormLiveRate';

const now = Date.parse('2026-09-13T12:00:30Z');
const strike = (time: number, lat = 46, lon = 9): StormStrike => [lat, lon, time];

describe('live storm strike rate', () => {
  it('uses a rolling minute across clock-minute boundaries and excludes future points', () => {
    const points = [strike(now - 60_001), strike(now - 60_000), strike(now - 59_999),
      strike(now - 30_000), strike(now), strike(now + 1)];
    expect(recentStormStrikes(points, now)).toEqual(points.slice(2, 5));
  });

  it('drops to zero without new strikes as the minute expires', () => {
    const points = [strike(now - 59_000), strike(now - 30_000), strike(now)];
    expect(recentStormStrikes(points, now)).toHaveLength(3);
    expect(recentStormStrikes(points, now + 1000)).toHaveLength(2);
    expect(recentStormStrikes(points, now + 30_000)).toHaveLength(1);
    expect(recentStormStrikes(points, now + 60_000)).toEqual([]);
  });

  it('deduplicates snapshot and live precision while counting distinct simultaneous strikes', () => {
    const stored = strike(now, 46.123, 9.123);
    const live = strike(now, 46.1231, 9.1231);
    const distinct = strike(now, 46.124, 9.124);
    expect(recentStormStrikes([stored, live, distinct, stored], now)).toHaveLength(2);
  });

  it('accepts late arrivals within the window and bounds the buffer when merging snapshots', () => {
    const previous = [strike(now - 50_000), strike(now)];
    const incoming = [strike(now - 10_000), strike(now), strike(now + 15_000)];
    expect(recentStormStrikes([...previous, ...incoming], now + 15_000))
      .toEqual([previous[1], incoming[0], incoming[2]]);
  });

  it('ignores invalid points and handles no recent activity', () => {
    expect(recentStormStrikes([], now)).toEqual([]);
    expect(recentStormStrikes([strike(NaN), strike(Infinity), strike(now, NaN),
      strike(now, 91), strike(now, 46, 181), strike(now - 120_000)], now)).toEqual([]);
  });

  it('reads the same current snapshot on each screen and expires a disconnected feed', () => {
    const snapshot = { at: now, rates: { storm: 1127, quiet: 0, unavailable: null } };
    expect(getStormLiveRate(snapshot, 'storm', now)).toBe(1127);
    expect(getStormLiveRate(snapshot, 'storm', now + 1000)).toBe(1127);
    expect(getStormLiveRate(snapshot, 'quiet', now)).toBe(0);
    expect(getStormLiveRate(snapshot, 'unavailable', now)).toBeNull();
    expect(getStormLiveRate(snapshot, 'missing', now)).toBeNull();
    expect(getStormLiveRate(snapshot, 'storm', now + 5001)).toBeNull();
    expect(getStormLiveRate(null, 'storm', now)).toBeNull();
  });
});

describe('peak storm strike rate', () => {
  it('captures a one-minute peak between tracking passes after the live rate has fallen', () => {
    const points = [strike(now - 100_000), strike(now - 90_000), strike(now - 80_000), strike(now)];
    expect(recentStormStrikes(points, now)).toHaveLength(1);
    expect(peakStormMinuteRate(points, now)).toBe(3);
  });

  it('uses a strict rolling-minute boundary and accepts unsorted arrivals', () => {
    const points = [strike(now), strike(now - 59_999), strike(now - 60_000), strike(now - 120_000)];
    expect(peakStormMinuteRate(points, now)).toBe(2);
  });

  it('deduplicates precision variants and ignores future, invalid and expired points', () => {
    const points = [strike(now, 46.123, 9.123), strike(now, 46.1231, 9.1231),
      strike(now, 46.124, 9.124), strike(now + 1), strike(now, NaN), strike(now, 91),
      strike(now, 46, 181), strike(NaN), strike(now - 5 * 60_000), strike(now - 5 * 60_000 - 1)];
    expect(peakStormMinuteRate(points, now)).toBe(2);
    expect(peakStormMinuteRate([], now)).toBe(0);
  });
});
