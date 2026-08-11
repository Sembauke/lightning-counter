// Playback lasts ~2 s per storm-minute, clamped so short storms stay watchable
// and multi-hour storms don't drag on forever.
export const REPLAY_MS_MIN = 10_000;
export const REPLAY_MS_MAX = 300_000;
export const REPLAY_MS_PER_STORM_MIN = 2_000;

export function computeReplayDurationMs(spanMs: number): number {
  return Math.min(
    REPLAY_MS_MAX,
    Math.max(REPLAY_MS_MIN, (spanMs / 60_000) * REPLAY_MS_PER_STORM_MIN),
  );
}

// During playback a strike counts as "fresh" for ~1.2 real seconds, scaled by
// how compressed real time is relative to replay time.
export function computeFreshMs(spanMs: number, replayMs: number): number {
  return (spanMs / replayMs) * 1200;
}

export function cutoffForProgress(progress: number, minTime: number, maxTime: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return minTime + p * (maxTime - minTime);
}

export function progressForCutoff(cutoff: number, minTime: number, maxTime: number): number {
  const span = maxTime - minTime;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (cutoff - minTime) / span));
}
