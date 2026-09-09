import type { StormStrike } from './db';
import { replayStrikeKey } from './stormReplayState';

/**
 * Only tracker-recorded membership may add a point to a replay. The caller
 * supplies its durable ownership ledger, never a geographic raw-grid search.
 * Saved samples remain historical evidence, not anchors for claiming neighbors.
 */
export function recoverOwnedReplay(
  original: StormStrike[],
  owned: Iterable<StormStrike>,
): { strikes: StormStrike[]; recoveredCount: number } {
  const strikes = [...original];
  const seen = new Set(original.map(replayStrikeKey));
  let recoveredCount = 0;
  for (const point of owned) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) continue;
    const [lat, lon, time] = point;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const id = replayStrikeKey(point);
    if (seen.has(id)) continue;
    seen.add(id);
    strikes.push([Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000, time]);
    recoveredCount++;
  }
  // Leave old samples untouched if there is no new, proven membership.
  if (recoveredCount) strikes.sort((a, b) => a[2] - b[2]);
  return { strikes, recoveredCount };
}
