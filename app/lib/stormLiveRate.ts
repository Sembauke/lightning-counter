import type { StormStrike } from './db';
import { replayStrikeKey } from './stormReplayState';

export interface StormLiveRateSnapshot {
  at: number;
  rates: Record<string, number | null>;
}

/** A missed feed must not leave a frozen number presented as a live rate. */
export function getStormLiveRate(
  snapshot: StormLiveRateSnapshot | null, key: string | null | undefined, now: number,
): number | null {
  if (!snapshot || !key || !Number.isFinite(snapshot.at) || now - snapshot.at > 5000) return null;
  const rate = snapshot.rates[key];
  return typeof rate === 'number' && Number.isInteger(rate) && rate >= 0 ? rate : null;
}

/** Unique observed strikes in the rolling last minute, independent of arrival order. */
export function recentStormStrikes(strikes: readonly StormStrike[], now: number): StormStrike[] {
  const recent = new Map<string, StormStrike>();
  for (const strike of strikes) {
    const [lat, lon, time] = strike;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90
      || !Number.isFinite(lon) || Math.abs(lon) > 180
      || !(time > now - 60_000 && time <= now)) continue;
    recent.set(replayStrikeKey(strike), strike);
  }
  return [...recent.values()];
}
