// Play one storm-hour in 30 seconds (120x), with an 8-second floor for short
// storms and a 90-second ceiling so a full day's activity stays easy to watch.
export const REPLAY_MS_MIN = 8_000;
export const REPLAY_MS_MAX = 90_000;
export const REPLAY_MS_PER_STORM_MIN = 500;

export function computeReplayDurationMs(spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return REPLAY_MS_MIN;
  return Math.min(
    REPLAY_MS_MAX,
    Math.max(REPLAY_MS_MIN, (spanMs / 60_000) * REPLAY_MS_PER_STORM_MIN),
  );
}

// During playback a strike counts as "fresh" for ~1.2 real seconds, scaled by
// how compressed real time is relative to replay time.
export function computeFreshMs(spanMs: number, replayMs: number): number {
  if (!Number.isFinite(spanMs) || !Number.isFinite(replayMs) || spanMs <= 0 || replayMs <= 0) return 0;
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
