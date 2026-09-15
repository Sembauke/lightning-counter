import type { StormStrike } from './db';
import { replayStrikeKey } from './stormReplayState';

export interface StormLiveRateSnapshot {
  at: number;
  rates: Record<string, number | null>;
  peakRates?: Record<string, number | null>;
}

/** A missed feed must not leave a frozen number presented as a live rate. */
export function getStormLiveRate(
  snapshot: StormLiveRateSnapshot | null, key: string | null | undefined, now: number,
): number | null {
  if (!snapshot || !key || !Number.isFinite(snapshot.at) || now - snapshot.at > 5000) return null;
  const rate = snapshot.rates[key];
  return typeof rate === 'number' && Number.isInteger(rate) && rate >= 0 ? rate : null;
}

/** Unique observed strikes in the requested rolling window, independent of arrival order. */
export function recentStormStrikes(strikes: readonly StormStrike[], now: number, windowMs = 60_000): StormStrike[] {
  const recent = new Map<string, StormStrike>();
  for (const strike of strikes) {
    const [lat, lon, time] = strike;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90
      || !Number.isFinite(lon) || Math.abs(lon) > 180
      || !(time > now - windowMs && time <= now)) continue;
    recent.set(replayStrikeKey(strike), strike);
  }
  return [...recent.values()];
}

/** Highest rolling-minute count in the complete five-minute tracking window. */
export function peakStormMinuteRate(strikes: readonly StormStrike[], now: number): number {
  const times = recentStormStrikes(strikes, now, 5 * 60_000).map(strike => strike[2]).sort((a, b) => a - b);
  let peak = 0;
  let first = 0;
  for (let last = 0; last < times.length; last++) {
    while (times[first] <= times[last] - 60_000) first++;
    peak = Math.max(peak, last - first + 1);
  }
  return peak;
}
