// Ported 1:1 from app/lib/replayTiming.ts.
// Playback lasts ~2s per storm-minute, clamped so short storms stay watchable
// and multi-hour storms don't drag on forever.
const int kReplayMsMin = 10000;
const int kReplayMsMax = 300000;
const int kReplayMsPerStormMin = 2000;

int computeReplayDurationMs(int spanMs) {
  final scaled = (spanMs / 60000) * kReplayMsPerStormMin;
  return scaled.clamp(kReplayMsMin, kReplayMsMax).round();
}

/// During playback a strike counts as "fresh" for ~1.2 real seconds, scaled by
/// how compressed real time is relative to replay time.
double computeFreshMs(int spanMs, int replayMs) => (spanMs / replayMs) * 1200;

int cutoffForProgress(double progress, int minTime, int maxTime) {
  final p = progress.clamp(0.0, 1.0);
  return (minTime + p * (maxTime - minTime)).round();
}

double progressForCutoff(int cutoff, int minTime, int maxTime) {
  final span = maxTime - minTime;
  if (span <= 0) return 0;
  return ((cutoff - minTime) / span).clamp(0.0, 1.0);
}
