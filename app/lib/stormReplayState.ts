import type { StormStrike } from './db';

// Persisted replay coordinates use three decimals; SSE can carry more precision.
export function replayStrikeKey([lat, lon, time]: StormStrike): string {
  return `${Math.round(lat * 1000)},${Math.round(lon * 1000)},${time}`;
}

export function mergeReplayStrikes(base: StormStrike[], appended: StormStrike[] = []): StormStrike[] {
  const seen = new Set<string>();
  const merged: StormStrike[] = [];
  for (const batch of [base, appended]) {
    for (const strike of batch) {
      const key = replayStrikeKey(strike);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(strike);
    }
  }
  return merged;
}

export function latestReplayTime(strikes: StormStrike[]): number {
  let latest = 0;
  for (const strike of strikes) latest = Math.max(latest, strike[2]);
  return latest;
}

// Keep checking while the tracker can revive the storm, or while its weakening
// lightning is still arriving. The replay can outlive the official storm end.
export function shouldPollStormReplay(endTime: number | null, latestStrike: number, now = Date.now()): boolean {
  return (endTime != null && now - endTime <= 60 * 60_000)
    || (latestStrike > 0 && now - latestStrike < 10 * 60_000);
}
