/**
 * Tests for the pure replay-timing math used by StormReplayMap: how long a
 * replay takes, how long a strike stays "fresh" during playback, and the
 * progress <-> storm-time conversions that back the draggable scrubber.
 */
import { describe, it, expect } from 'vitest';
import {
  REPLAY_MS_MIN,
  REPLAY_MS_MAX,
  computeReplayDurationMs,
  computeFreshMs,
  cutoffForProgress,
  progressForCutoff,
} from '../app/lib/replayTiming';

describe('computeReplayDurationMs', () => {
  it('clamps very short storms to the minimum duration', () => {
    expect(computeReplayDurationMs(1000)).toBe(REPLAY_MS_MIN);
  });

  it('scales proportionally to storm length in the middle of the range', () => {
    // 30 storm-minutes * 2000ms/min = 60_000ms, within [MIN, MAX]
    const spanMs = 30 * 60_000;
    expect(computeReplayDurationMs(spanMs)).toBe(60_000);
  });

  it('clamps very long storms to the 5-minute maximum instead of the old 40s cap', () => {
    const sixHours = 6 * 60 * 60 * 1000;
    expect(computeReplayDurationMs(sixHours)).toBe(REPLAY_MS_MAX);
    expect(REPLAY_MS_MAX).toBe(300_000);
  });
});

describe('computeFreshMs', () => {
  it('scales with how compressed real time is relative to replay time', () => {
    // spanMs 10x replayMs => strikes stay fresh 10x as long in replay-time
    expect(computeFreshMs(100_000, 10_000)).toBeCloseTo(1200 * 10);
  });
});

describe('cutoffForProgress / progressForCutoff', () => {
  const minTime = 1_000;
  const maxTime = 11_000;

  it('maps progress 0 and 1 to the start and end times', () => {
    expect(cutoffForProgress(0, minTime, maxTime)).toBe(minTime);
    expect(cutoffForProgress(1, minTime, maxTime)).toBe(maxTime);
  });

  it('clamps out-of-range progress', () => {
    expect(cutoffForProgress(-0.5, minTime, maxTime)).toBe(minTime);
    expect(cutoffForProgress(1.5, minTime, maxTime)).toBe(maxTime);
  });

  it('round-trips a mid-range cutoff', () => {
    const cutoff = cutoffForProgress(0.4, minTime, maxTime);
    expect(progressForCutoff(cutoff, minTime, maxTime)).toBeCloseTo(0.4);
  });

  it('clamps progressForCutoff to [0, 1] for out-of-range times', () => {
    expect(progressForCutoff(minTime - 5000, minTime, maxTime)).toBe(0);
    expect(progressForCutoff(maxTime + 5000, minTime, maxTime)).toBe(1);
  });

  it('does not divide by zero when minTime === maxTime', () => {
    expect(progressForCutoff(5000, 5000, 5000)).toBe(0);
  });
});
