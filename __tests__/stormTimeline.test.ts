import { describe, expect, it } from 'vitest';
import type { StormStrike } from '../app/lib/db';
import { buildStormTimeline } from '../app/lib/stormTimeline';

const MINUTE = 60_000;
const end = Date.parse('2026-09-09T08:51:40Z');
const strike = (time: number, lat = 46): StormStrike => [lat, 9, time];

describe('storm detail minute timeline', () => {
  it('uses the known storm end before recent SSE history arrives', () => {
    const staleReplay = [strike(end - 6 * 60 * MINUTE), strike(end - 2 * 60 * MINUTE)];
    const initial = buildStormTimeline(staleReplay, end);
    const updated = buildStormTimeline([...staleReplay, strike(end - MINUTE)], end);

    expect(initial).toHaveLength(60);
    expect(initial[0].ts).toBe(Date.parse('2026-09-09T07:52:00Z'));
    expect(initial.at(-1)?.ts).toBe(Date.parse('2026-09-09T08:51:00Z'));
    expect(updated.map(bucket => bucket.ts)).toEqual(initial.map(bucket => bucket.ts));
    expect(initial.every(bucket => bucket.count === 0)).toBe(true);
    expect(updated.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
  });

  it('increments the same clock-minute bucket while retaining the other bars', () => {
    const base = [strike(end - 90 * MINUTE), strike(end - 2 * MINUTE), strike(end - 15_000)];
    const initial = buildStormTimeline(base, end);
    const updated = buildStormTimeline([...base, strike(end + 5_000)], end);

    expect(updated.slice(0, -1)).toEqual(initial.slice(0, -1));
    expect(initial.at(-1)?.count).toBe(1);
    expect(updated.at(-1)).toEqual({ ts: initial.at(-1)!.ts, count: 2 });
  });

  it('does not rebase the visible buckets when an earlier replay sample is backfilled', () => {
    const base = [strike(end - 90 * MINUTE + 15_000), strike(end - MINUTE), strike(end)];
    const initial = buildStormTimeline(base, end);
    const backfilled = buildStormTimeline([strike(end - 120 * MINUTE - 12_000), ...base], end);
    expect(backfilled).toEqual(initial);
  });

  it('aligns exact minute boundaries across midnight and clips a short storm', () => {
    const midnight = Date.parse('2026-09-10T00:00:00Z');
    expect(buildStormTimeline([strike(midnight - 1), strike(midnight), strike(midnight + MINUTE)], null)).toEqual([
      { ts: midnight - MINUTE, count: 1 },
      { ts: midnight, count: 1 },
      { ts: midnight + MINUTE, count: 1 },
    ]);
  });

  it('slides by one minute for a new minute and preserves overlapping bucket counts', () => {
    const minuteEnd = Math.floor(end / MINUTE) * MINUTE;
    const base = Array.from({ length: 61 }, (_, i) => strike(minuteEnd - i * MINUTE));
    const initial = buildStormTimeline(base, end);
    const updated = buildStormTimeline([...base, strike(minuteEnd + MINUTE)], end);

    expect(updated).toHaveLength(60);
    expect(updated.slice(0, -1)).toEqual(initial.slice(1));
    expect(updated.at(-1)).toEqual({ ts: minuteEnd + MINUTE, count: 1 });
  });

  it('deduplicates stored and SSE coordinates while preserving distinct simultaneous strikes', () => {
    const base: StormStrike = [46.123, 9.123, end];
    const sse: StormStrike = [46.1231, 9.1231, end];
    const distinct: StormStrike = [46.124, 9.124, end];
    expect(buildStormTimeline([base, sse, distinct], end)).toEqual([
      { ts: Math.floor(end / MINUTE) * MINUTE, count: 2 },
    ]);
  });

  it('builds only the visible 60 buckets for years of sparse replay history', () => {
    const old = Date.parse('2020-01-01T00:00:00Z');
    const timeline = buildStormTimeline([strike(old), strike(end)], end);
    expect(timeline).toHaveLength(60);
    expect(timeline.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
  });

  it('handles empty replay data and invalid timestamps without creating invalid buckets', () => {
    expect(buildStormTimeline([], end)).toEqual([]);
    expect(buildStormTimeline([strike(NaN)], end)).toEqual([]);
    expect(buildStormTimeline([strike(end), strike(Infinity)], NaN)).toEqual([
      { ts: Math.floor(end / MINUTE) * MINUTE, count: 1 },
    ]);
  });
});
