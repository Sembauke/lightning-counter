import { describe, expect, it } from 'vitest';
import { collectReplayTails, rememberReplayAnchors, REPLAY_TAIL_GAP_MS, type ReplayTailStorm } from '../app/lib/stormReplayTail';
import { detectStorms, type StrikePoint } from '../app/lib/stormClusters';

const start = 1_000_000_000;
const minute = 60_000;
const point = (lon: number, time: number, lat = 43): StrikePoint => ({ lat, lon, time });
function storm(key = 'A', lon = 0): ReplayTailStorm & { totalStrikes: number; lastSeen: number; peakRate: number } {
  return { key, allStrikes: [[43, lon, start]], lastStrikeTime: start, totalStrikes: 5000, lastSeen: start, peakRate: 100 };
}
function collect(storms: ReplayTailStorm[], points: StrikePoint[], now: number) {
  return collectReplayTails(storms, points, new Set(), new Set(), now);
}

describe('fading storm replay capture', () => {
  it('keeps scattered subthreshold lightning without changing storm metrics', () => {
    const st = storm();
    const fading = [point(0.01, start + minute), point(0.02, start + 2 * minute)];
    expect(detectStorms(fading, 5 * minute)).toEqual([]);
    expect(collect([st], fading, start + 2 * minute)).toEqual(new Set([st]));
    expect(st.allStrikes).toEqual([[43, 0, start], [43, 0.01, start + minute], [43, 0.02, start + 2 * minute]]);
    expect(st).toMatchObject({ totalStrikes: 5000, lastSeen: start, lastStrikeTime: start, peakRate: 100, lastReplayTime: start + 2 * minute });
  });

  it('follows a weakening storm longer than an hour, including after state reload', () => {
    let st = storm();
    for (let i = 1; i <= 90; i++) {
      const time = start + i * minute;
      collect([st], [point(i * 0.01, time)], time);
      if (i === 45) st = JSON.parse(JSON.stringify(st));
    }
    expect(st.allStrikes).toHaveLength(91);
    expect(st.lastReplayTime).toBe(start + 90 * minute);
    expect(st.lastSeen).toBe(start);
    expect(st.replayAnchors!.length).toBeLessThanOrEqual(10);
  });

  it('stops after ten minutes without strikes and cannot restart from stale duplicates', () => {
    const st = storm();
    collect([st], [point(0, start)], start + 9 * minute);
    collect([st], [point(0.01, start + REPLAY_TAIL_GAP_MS)], start + REPLAY_TAIL_GAP_MS);
    collect([st], [point(0.01, start + 20 * minute)], start + 20 * minute);
    expect(st.allStrikes).toHaveLength(1);
    expect(st.lastReplayTime).toBe(start);
  });

  it('does not create identities, attach distant lightning, or grow a chain in one pass', () => {
    const st = storm();
    const points = [point(0.2, start + minute), point(0.4, start + 2 * minute), point(2, start + minute)];
    expect(collect([], points, start + 2 * minute).size).toBe(0);
    collect([st], points, start + 2 * minute);
    expect(st.allStrikes).toEqual([[43, 0, start], [43, 0.2, start + minute]]);
  });

  it('assigns overlapping tails once to the closest owner regardless of input order', () => {
    for (const reverse of [false, true]) {
      const a = storm('A', 0), b = storm('B', 0.4);
      const nearB = point(0.25, start + minute);
      collect(reverse ? [b, a] : [a, b], [nearB, { ...nearB }], start + minute);
      expect(a.allStrikes).toHaveLength(1);
      expect(b.allStrikes).toHaveLength(2);
    }
  });

  it('reserves qualified cells and respects a closer active owner', () => {
    const a = storm('A', 0), b = storm('B', 0.4);
    const reserved = point(0.01, start + minute);
    collectReplayTails([a, b], [reserved, point(0.25, start + minute)], new Set([reserved]), new Set([b]), start + minute);
    expect(a.allStrikes).toHaveLength(1);
    expect(b.allStrikes).toHaveLength(1);
  });

  it('deduplicates overlapping passes and preserves quiet points when dense history thins', () => {
    const st = storm();
    st.allStrikes = Array.from({ length: 10 }, (_, i) => [43, 0, start - i]);
    const tail = point(0.1, start + minute);
    collectReplayTails([st], [tail, { ...tail }], new Set(), new Set(), start + minute, 10);
    collectReplayTails([st], [tail], new Set(), new Set(), start + 2 * minute, 10);
    expect(st.allStrikes.filter(p => p[2] === tail.time)).toHaveLength(1);
    expect(st.allStrikes.at(-1)).toEqual([43, 0.1, tail.time]);
  });

  it('retains true footprint timestamps when refreshing qualified anchors', () => {
    const st = storm();
    rememberReplayAnchors(st, [[43, 0.1, start + minute]], start + 2 * minute);
    expect(st.lastReplayTime).toBe(start + minute);
    collect([st], [point(0.2, start + 11 * minute)], start + 11 * minute);
    expect(st.allStrikes).toHaveLength(1);
  });

  it('handles nearby lightning across the date line', () => {
    const st = storm('A', 179.95);
    collect([st], [point(-179.95, start + minute)], start + minute);
    expect(st.allStrikes).toHaveLength(2);
  });
});

describe('storm qualification', () => {
  it('requires at least 20 strikes/minute over the five-minute window', () => {
    const points = Array.from({ length: 100 }, (_, i) => point(0.1, start + i));
    expect(detectStorms(points.slice(0, 99), 5 * minute)).toEqual([]);
    expect(detectStorms(points, 5 * minute)[0].rate).toBe(20);
  });

  it('can reserve qualified storms beyond the visible top20', () => {
    const points = Array.from({ length: 21 }, (_, i) =>
      Array.from({ length: 100 }, (_, j) => point(-100 + i * 3, start + j))).flat();
    expect(detectStorms(points, 5 * minute)).toHaveLength(20);
    expect(detectStorms(points, 5 * minute, Infinity)).toHaveLength(21);
  });
});
