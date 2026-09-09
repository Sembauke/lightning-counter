import type { StormStrike } from './db';
import { replayStrikeKey } from './stormReplayState';

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;

export interface StormMinuteBucket {
  ts: number;
  count: number;
}

/** One stable clock-minute window shared by the chart bars and time labels. */
export function buildStormTimeline(
  strikes: readonly StormStrike[],
  endTime: number | null,
): StormMinuteBucket[] {
  let firstTime = Infinity, latestTime = -Infinity;
  for (const [, , time] of strikes) {
    if (!Number.isFinite(time)) continue;
    firstTime = Math.min(firstTime, time);
    latestTime = Math.max(latestTime, time);
  }
  if (!Number.isFinite(firstTime)) return [];

  // A saved replay can lag behind the storm metadata. Start at the known
  // current window immediately, rather than jumping forward when SSE arrives.
  const knownEnd = endTime != null && Number.isFinite(endTime) ? endTime : latestTime;
  const endMinute = Math.floor(Math.max(knownEnd, latestTime) / MINUTE_MS);
  const startMinute = Math.max(Math.floor(firstTime / MINUTE_MS), endMinute - WINDOW_MINUTES + 1);
  const timeline = Array.from({ length: endMinute - startMinute + 1 }, (_, i) => ({
    ts: (startMinute + i) * MINUTE_MS,
    count: 0,
  }));

  // Only retain identity keys for visible strikes; a multi-day replay still
  // produces at most 60 buckets and does not need sorting or a full history map.
  const seen = new Set<string>();
  for (const strike of strikes) {
    const minute = Math.floor(strike[2] / MINUTE_MS);
    if (!Number.isFinite(minute) || minute < startMinute || minute > endMinute) continue;
    const key = replayStrikeKey(strike);
    if (seen.has(key)) continue;
    seen.add(key);
    timeline[minute - startMinute].count++;
  }
  return timeline;
}
