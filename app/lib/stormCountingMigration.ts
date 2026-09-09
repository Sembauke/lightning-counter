import { emptyStormCounting, type CountingStorm } from './stormCounting';
import { lifecycleStrikeId } from './stormLifecycle';
import { STORM_TRANSITION_MS, type StormTransition } from './stormTransition';

export interface MigratingCountingStorm extends CountingStorm {
  keepEvery?: number;
  lastStrikeTime?: number;
  allStrikes?: Array<[number, number, number]>;
  initialStrikesByAncestor?: Record<string, number>;
  lifecycle?: { transitions: StormTransition[] };
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
 * Existing versioned states are never reset or reinterpreted here.
 *
 * Call the shared-history compactor immediately afterward: exact migration
 * temporarily exposes full saved samples so old intersections become weighted
 * cohorts, rather than retaining lifetime point IDs.
 */
export function restoreStormCounting(storms: MigratingCountingStorm[], now: number) {
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
      };
      if (storm.lifecycle) {
        storm.lifecycle.transitions = storm.lifecycle.transitions.map(transition => transition.kind === 'split'
          ? { ...transition, startedAt: now, confirmAt: now + STORM_TRANSITION_MS }
          : transition);
      }
    }
    storm.counting = counting;
  }
  return { mode: exact ? 'exact' as const : 'legacy' as const, migrated: legacy.length, mixed };
}
