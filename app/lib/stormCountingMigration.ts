import { emptyStormCounting, type CountingStorm } from './stormCounting';
import { lifecycleStrikeId } from './stormLifecycle';
import { STORM_TRANSITION_MS, type StormTransition } from './stormTransition';

export interface MigratingCountingStorm extends CountingStorm {
  keepEvery?: number;
  lastStrikeTime?: number;
  allStrikes?: Array<[number, number, number]>;
  initialStrikesByAncestor?: Record<string, number>;
  splitNotBefore?: number;
  lifecycle?: {
    transitions: StormTransition[];
    splitTransition?: StormTransition;
    distantSplit?: { transition: StormTransition };
  };
}

/** Unknown legacy contributions cannot be identified from a sampled replay. */
function legacyThrough(storm: MigratingCountingStorm, now: number): number {
  const watermark = Number.isFinite(storm.lastStrikeTime) ? Math.min(storm.lastStrikeTime!, now) : now;
  // The original migration guaranteed that its opaque history was older than
  // this floor minus one seed window. Merges preserve the latest such floor.
  return Number.isFinite(storm.splitNotBefore)
    ? Math.min(watermark, storm.splitNotBefore! - STORM_TRANSITION_MS)
    : watermark;
}

function protectSplitSeeds(storm: MigratingCountingStorm, through: number): void {
  const floor = Math.max(storm.splitNotBefore ?? 0, through + STORM_TRANSITION_MS);
  storm.splitNotBefore = floor;
  const clamp = (transition: StormTransition): StormTransition => transition.kind === 'split' && transition.confirmAt < floor
    ? { ...transition, confirmAt: floor } : transition;
  if (storm.lifecycle) {
    storm.lifecycle.transitions = storm.lifecycle.transitions.map(clamp);
    if (storm.lifecycle.splitTransition) storm.lifecycle.splitTransition = clamp(storm.lifecycle.splitTransition);
    if (storm.lifecycle.distantSplit) storm.lifecycle.distantSplit.transition = clamp(storm.lifecycle.distantSplit.transition);
  }
}

/**
 * A complete, unthinned official sample can prove historical intersections.
 * A replay tail is not officially counted; exclude it before checking that
 * the unique sample exactly accounts for the stored lifetime counter.
 */
function completeOfficialSample(storm: MigratingCountingStorm): Record<string, number> | null {
  if ((storm.keepEvery ?? 1) !== 1 || !Number.isFinite(storm.lastStrikeTime)) return null;
  const recent: Record<string, number> = {};
  for (const point of storm.allStrikes ?? []) {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)
        || Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180) return null;
    const [lat, lon, time] = point;
    if (time > storm.lastStrikeTime!) continue;
    recent[lifecycleStrikeId({ lat, lon, time })] = time;
  }
  return Object.keys(recent).length === storm.totalStrikes ? recent : null;
}

/**
 * Migrate a saved tracking snapshot as one group. Mixed exact/opaque historical
 * accounting cannot safely compare scalar ancestry against exact new counts.
 * Existing versioned counters and ownership are preserved. Older opaque
 * ledgers receive a one-time boundary for safe late-arrival counting.
 *
 * Call the shared-history compactor immediately afterward: exact migration
 * temporarily exposes full saved samples so old intersections become weighted
 * cohorts, rather than retaining lifetime point IDs.
 */
export function restoreStormCounting(storms: MigratingCountingStorm[], now: number) {
  for (const storm of storms) {
    const baseline = storm.counting?.legacy;
    if (!baseline) continue;
    // The first counting-ledger release did not persist a lateness boundary.
    // Upgrade that baseline once; advancing it on every restart would discard
    // newly arriving strikes whose ownership can already be proved exactly.
    if (!Number.isFinite(baseline.through)) baseline.through = legacyThrough(storm, now);
    protectSplitSeeds(storm, baseline.through!);
  }
  const legacy = storms.filter(storm => !storm.counting);
  if (!legacy.length) return { mode: 'unchanged' as const, migrated: 0, mixed: false };

  const mixed = legacy.length !== storms.length;
  const samples = legacy.map(completeOfficialSample);
  const exact = !mixed && samples.every(sample => sample !== null);
  for (let i = 0; i < legacy.length; i++) {
    const storm = legacy[i];
    const counting = emptyStormCounting();
    if (exact) {
      counting.recent = samples[i]!;
    } else {
      // These are compatibility baselines, not evidence that a future child
      // inherited any particular historical strike from a distant ancestor.
      counting.legacy = {
        total: storm.totalStrikes,
        ancestors: { ...(storm.initialStrikesByAncestor ?? {}) },
        through: Number.isFinite(storm.lastStrikeTime) ? Math.min(storm.lastStrikeTime!, now) : now,
      };
      // A child seeds its count from the last five minutes. Wait until that
      // entire window has exact ownership, even if a distant split confirms
      // faster than the ordinary hold. Persist this floor across restarts.
      storm.splitNotBefore = now + STORM_TRANSITION_MS;
      if (storm.lifecycle) {
        storm.lifecycle.transitions = storm.lifecycle.transitions.map(transition => transition.kind === 'split'
          ? { ...transition, startedAt: now, confirmAt: now + STORM_TRANSITION_MS }
          : transition);
      }
      protectSplitSeeds(storm, counting.legacy.through!);
    }
    storm.counting = counting;
  }
  return { mode: exact ? 'exact' as const : 'legacy' as const, migrated: legacy.length, mixed };
}
