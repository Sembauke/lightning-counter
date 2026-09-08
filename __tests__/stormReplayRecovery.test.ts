import { describe, expect, it } from 'vitest';
import { recoverReplayEdges } from '../app/lib/stormReplayRecovery';
import type { StormStrike } from '../app/lib/db';

const time = 1_788_855_645_577;

describe('recoverReplayEdges', () => {
  it('recovers the production strike clipped across longitude -94.5', () => {
    const anchors: StormStrike[] = [
      [43.201, -94.506, time - 1000],
      [43.201, -94.506, time],
    ];
    const missing: StormStrike = [43.205314, -94.498717, 1_788_855_645_259];
    const result = recoverReplayEdges(anchors, [missing]);
    expect(result.recoveredCount).toBe(1);
    expect(result.strikes).toContainEqual([43.205, -94.499, missing[2]]);
    expect(anchors).toHaveLength(2);
  });

  it('never uses recovered points to bridge into a neighboring storm', () => {
    const anchors: StormStrike[] = [[43, -95, time], [43, -95, time + 1000]];
    // The first point is ~20km from the anchors, the next is ~40km away.
    const candidates: StormStrike[] = [[43.18, -95, time + 500], [43.36, -95, time + 600]];
    const result = recoverReplayEdges(anchors, candidates);
    expect(result.recoveredCount).toBe(1);
    expect(result.strikes).not.toContainEqual(candidates[1]);
  });

  it('excludes distant points, other times, and points outside the saved lifetime', () => {
    const anchors: StormStrike[] = [[43, -95, time], [43, -95, time + 600_000]];
    const candidates: StormStrike[] = [
      [44, -95, time + 1000],
      [43, -95, time + 300_000],
      [43, -95, time - 1],
      [43, -95, time + 600_001],
    ];
    expect(recoverReplayEdges(anchors, candidates).recoveredCount).toBe(0);
  });

  it('deduplicates overlapping archive chunks and the stored rounded coordinates', () => {
    const anchor: StormStrike = [43.201, -94.506, time];
    const end: StormStrike = [43.202, -94.507, time + 1000];
    const recovered: StormStrike = [43.205314, -94.498717, time + 500];
    const result = recoverReplayEdges([end, anchor, anchor], [
      [43.2011, -94.5061, time], recovered, recovered,
    ]);
    expect(result.recoveredCount).toBe(1);
    expect(result.strikes).toEqual([anchor, [43.205, -94.499, time + 500], end]);
  });

  it('handles longitude wrapping without a grid discontinuity at the date line', () => {
    const anchors: StormStrike[] = [[10, 179.99, time], [10, 179.99, time + 1000]];
    expect(recoverReplayEdges(anchors, [[10, -179.99, time + 500]]).recoveredCount).toBe(1);
  });

  it('requires original evidence and rejects invalid archive coordinates', () => {
    expect(recoverReplayEdges([], [[43, -95, time]]).strikes).toEqual([]);
    const anchors: StormStrike[] = [[43, -95, time], [43, -95, time + 1000]];
    expect(recoverReplayEdges(anchors, [[NaN, -95, time], [91, -95, time], [43, Infinity, time]])
      .recoveredCount).toBe(0);
  });
});
