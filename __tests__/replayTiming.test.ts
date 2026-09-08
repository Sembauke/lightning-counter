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

  it.each([
    [30, 15_000],
    [60, 30_000],
    [120, 60_000],
    [180, 90_000],
  ])('plays %i storm-minutes in %i milliseconds', (minutes, expectedMs) => {
    expect(computeReplayDurationMs(minutes * 60_000)).toBe(expectedMs);
  });

  it.each([4, 8, 24])('caps a %i-hour storm at 90 seconds', hours => {
    expect(computeReplayDurationMs(hours * 60 * 60 * 1000)).toBe(90_000);
    expect(REPLAY_MS_MAX).toBe(90_000);
  });

  it.each([0, -60_000, NaN, Infinity, -Infinity])('uses the minimum for an invalid or empty span (%s)', spanMs => {
    expect(computeReplayDurationMs(spanMs)).toBe(8_000);
  });
});

describe('computeFreshMs', () => {
  it('scales with how compressed real time is relative to replay time', () => {
    // spanMs 10x replayMs => strikes stay fresh 10x as long in replay-time
    expect(computeFreshMs(100_000, 10_000)).toBeCloseTo(1200 * 10);
  });

  it.each([1, 60, 120, 180, 480])('keeps strikes fresh for 1.2 playback seconds in a %i-minute storm', minutes => {
    const spanMs = minutes * 60_000;
    const replayMs = computeReplayDurationMs(spanMs);
    expect(computeFreshMs(spanMs, replayMs) / spanMs * replayMs).toBeCloseTo(1200);
  });

  it.each([
    [0, 8000],
    [-1000, 8000],
    [NaN, 8000],
    [Infinity, 8000],
    [60_000, 0],
    [60_000, -1000],
    [60_000, NaN],
    [60_000, Infinity],
  ])('returns no freshness window for invalid timing (%s, %s)', (spanMs, replayMs) => {
    expect(computeFreshMs(spanMs, replayMs)).toBe(0);
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

  it.each([60, 120, 480])('maps half of a %i-minute replay to half of the storm timeline', minutes => {
    const endTime = minTime + minutes * 60_000;
    const elapsedPlaybackMs = computeReplayDurationMs(endTime - minTime) / 2;
    const progress = elapsedPlaybackMs / computeReplayDurationMs(endTime - minTime);
    const cutoff = cutoffForProgress(progress, minTime, endTime);
    expect(cutoff).toBe(minTime + (endTime - minTime) / 2);
    expect(progressForCutoff(cutoff, minTime, endTime)).toBe(0.5);
  });

  it('clamps progressForCutoff to [0, 1] for out-of-range times', () => {
    expect(progressForCutoff(minTime - 5000, minTime, maxTime)).toBe(0);
    expect(progressForCutoff(maxTime + 5000, minTime, maxTime)).toBe(1);
  });

  it('does not divide by zero when minTime === maxTime', () => {
    expect(progressForCutoff(5000, 5000, 5000)).toBe(0);
  });
});
