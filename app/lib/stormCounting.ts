import { lifecycleStrikeId } from './stormLifecycle';
import type { StrikePoint } from './stormClusters';

const has = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

// A split can seed only the last five minutes. Retain exact counted identities
// for ten minutes, independently of the sampled/possibly replay-only history.
export const COUNTED_STRIKE_WINDOW_MS = 10 * 60_000;

export interface StormCountingState {
  recent: Record<string, number>;
  /** Disjoint, older sets of shared strikes: cohort identity -> cardinality. */
  cohorts: Record<string, number>;
  /** Pre-upgrade totals whose sampled history cannot prove exact ownership. */
  legacy?: { total: number; ancestors: Record<string, number> };
}

export interface CountingStorm {
  key: string;
  totalStrikes: number;
  counting?: StormCountingState;
}

export function emptyStormCounting(): StormCountingState {
  return { recent: {}, cohorts: {} };
}

export function rememberCountedStrike(storm: CountingStorm, point: StrikePoint): void {
  const state = storm.counting ??= emptyStormCounting();
  state.recent[lifecycleStrikeId(point)] = point.time;
}

function exactOverlap(a: StormCountingState, b: StormCountingState): number {
  let overlap = 0;
  for (const id of Object.keys(a.recent)) if (has(b.recent, id)) overlap++;
  for (const [id, count] of Object.entries(a.cohorts)) {
    if (has(b.cohorts, id)) overlap += count;
  }
  return overlap;
}

function legacyOverlap(a: CountingStorm, b: CountingStorm): number {
  const left = a.counting?.legacy, right = b.counting?.legacy;
  if (!left || !right) return 0;
  // Compatibility applies only to opaque pre-upgrade contributions. A new
  // descendant never inherits these guesses or subtracts them from new strikes.
  return Math.min(left.total, right.total, Math.max(0, right.ancestors[a.key] ?? left.ancestors[b.key] ?? 0));
}

export function sharedStormStrikeCount(a: CountingStorm, b: CountingStorm): number {
  return exactOverlap(a.counting!, b.counting!) + legacyOverlap(a, b);
}

/** Union official history, irrespective of parent/child direction or key choice. */
export function mergeStormCounting(big: CountingStorm, small: CountingStorm): number {
  const left = big.counting!, right = small.counting!;
  const overlap = exactOverlap(left, right) + legacyOverlap(big, small);
  const netNew = small.totalStrikes - overlap;

  // Keep the old baseline correction isolated until those identities disappear.
  // Complete snapshots and every newly tracked storm use only exact provenance.
  if (left.legacy || right.legacy) {
    const a = left.legacy ?? { total: 0, ancestors: {} as Record<string, number> };
    const b = right.legacy ?? { total: 0, ancestors: {} as Record<string, number> };
    const ancestors = { ...a.ancestors };
    if (a.total > 0 && b.total > 0 && has(b.ancestors, big.key)) {
      for (const [key, count] of Object.entries(b.ancestors)) {
        if (key !== big.key) ancestors[key] = (ancestors[key] ?? 0) + count;
      }
    } else if (a.total > 0 && b.total > 0 && has(a.ancestors, small.key)) {
      Object.assign(ancestors, b.ancestors);
    } else {
      for (const [key, count] of Object.entries(b.ancestors)) {
        ancestors[key] = (ancestors[key] ?? 0) + count;
      }
    }
    delete ancestors[big.key];
    delete ancestors[small.key];
    left.legacy = { total: a.total + b.total - legacyOverlap(big, small), ancestors };
  }

  Object.assign(left.recent, right.recent);
  Object.assign(left.cohorts, right.cohorts);
  big.totalStrikes += netNew;
  return netNew;
}

/** Only opaque legacy metadata uses mutable storm keys; exact cohorts do not. */
export function remapStormCountingKeys(storms: CountingStorm[], from: string, to: string): void {
  if (from === to) return;
  for (const storm of storms) {
    const ancestors = storm.counting?.legacy?.ancestors;
    if (!ancestors) continue;
    if (has(ancestors, from)) {
      ancestors[to] = ancestors[from];
      delete ancestors[from];
    }
    delete ancestors[storm.key];
  }
}

/**
 * Compact all surviving owners together. Old strike IDs become disjoint weighted
 * cohorts with identical owner sets. A later merge intersects those cohorts
 * exactly, without retaining an ever-growing lifetime set of strike IDs.
 * Quiet storms remain owners until the tracker actually retires their identity.
 */
export function compactStormCounting(storms: CountingStorm[], now: number): void {
  const tokens = new Map<string, { count: number; owners: number[] }>();
  const add = (token: string, count: number, owner: number) => {
    const existing = tokens.get(token);
    if (existing) existing.owners.push(owner);
    else tokens.set(token, { count, owners: [owner] });
  };
  const cutoff = now - COUNTED_STRIKE_WINDOW_MS;
  for (let i = 0; i < storms.length; i++) {
    const state = storms[i].counting!;
    for (const [id, time] of Object.entries(state.recent)) {
      if (time > cutoff) continue;
      add(`strike:${id}`, 1, i);
      delete state.recent[id];
    }
    for (const [id, count] of Object.entries(state.cohorts)) add(`cohort:${id}`, count, i);
    state.cohorts = {};
  }

  const groups = new Map<string, { count: number; owners: number[] }>();
  for (const { count, owners } of tokens.values()) {
    if (owners.length < 2) continue; // No surviving peer can count this history twice.
    const key = JSON.stringify(owners);
    const group = groups.get(key);
    if (group) group.count += count;
    else groups.set(key, { count, owners });
  }
  for (const [id, { count, owners }] of groups) {
    for (const i of owners) storms[i].counting!.cohorts[id] = count;
  }
}
