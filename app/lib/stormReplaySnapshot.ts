import type { StormStrike } from './db';
import { mergeReplayStrikes } from './stormReplayState';

// Matches the tracker's 24,000-point sample plus its permanent origin sample.
const MAX_STORED_POINTS = 24_200;
const ORIGIN_POINTS = 200;
const COVERAGE_BUCKET_MS = 5 * 60_000;

function coverage(strikes: StormStrike[]) {
  let first = Infinity, last = -Infinity;
  const buckets = new Set<number>();
  for (const [, , time] of strikes) {
    first = Math.min(first, time);
    last = Math.max(last, time);
    buckets.add(Math.floor(time / COVERAGE_BUCKET_MS));
  }
  return { first, last, buckets };
}

function boundSample(strikes: StormStrike[]): StormStrike[] {
  if (strikes.length <= MAX_STORED_POINTS) return strikes;
  const sorted = [...strikes].sort((a, b) => a[2] - b[2]);
  const keep = new Set(Array.from({ length: ORIGIN_POINTS }, (_, i) => i));
  keep.add(sorted.length - 1);
  const covered = new Set([...keep].map(i => Math.floor(sorted[i][2] / COVERAGE_BUCKET_MS)));
  const bucketAnchors: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const bucket = Math.floor(sorted[i][2] / COVERAGE_BUCKET_MS);
    if (!covered.has(bucket)) {
      covered.add(bucket);
      bucketAnchors.push(i);
    }
  }
  // Reserve evidence of every occupied five-minute interval before filling
  // the remaining budget uniformly. Otherwise sparse intervals can vanish.
  const anchorSlots = Math.min(bucketAnchors.length, MAX_STORED_POINTS - keep.size);
  for (let i = 0; i < anchorSlots; i++) {
    keep.add(bucketAnchors[Math.floor(i * bucketAnchors.length / anchorSlots)]);
  }
  const candidates = sorted.map((_, i) => i).filter(i => !keep.has(i));
  const remaining = MAX_STORED_POINTS - keep.size;
  for (let i = 0; i < remaining; i++) {
    keep.add(candidates[Math.floor(i * candidates.length / remaining)]);
  }
  return sorted.filter((_, i) => keep.has(i));
}

/** Choose a current replay by historical coverage, never by point count. */
export function selectStormReplaySnapshot(
  stored: StormStrike[] | null,
  incoming: StormStrike[] | null,
): StormStrike[] | null {
  if (!incoming?.length) return stored ?? incoming;
  if (!stored?.length) return boundSample(incoming);

  const oldCoverage = coverage(stored);
  const newCoverage = coverage(incoming);
  const coversHistory = newCoverage.first <= oldCoverage.first
    && newCoverage.last >= oldCoverage.last
    && [...oldCoverage.buckets].every(bucket => newCoverage.buckets.has(bucket));
  // Normal tracker thinning keeps the full timeline while halving its size.
  // Accept that snapshot directly so each thinning is not undone by a union.
  // Check occupied time buckets as well as endpoints: a restart can preserve
  // the origin reservoir and newest tail while losing the entire middle.
  if (coversHistory) return boundSample(incoming);

  // An older, partial flush must not replace a newer persisted continuation.
  if (newCoverage.first >= oldCoverage.first && newCoverage.last <= oldCoverage.last
      && [...newCoverage.buckets].every(bucket => oldCoverage.buckets.has(bucket))) return stored;

  // A partial restart or key adoption can contribute a new tail without
  // containing older history. Preserve both, with bounded persisted storage.
  return boundSample(mergeReplayStrikes(stored, incoming).sort((a, b) => a[2] - b[2]));
}
