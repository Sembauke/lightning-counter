import { describe, expect, it } from 'vitest';
import { compactStormCounting, emptyStormCounting, mergeStormCounting } from '../app/lib/stormCounting';
import { restoreStormCounting, type MigratingCountingStorm } from '../app/lib/stormCountingMigration';
import { lifecycleStrikeId } from '../app/lib/stormLifecycle';
import { STORM_TRANSITION_MS, type StormTransition } from '../app/lib/stormTransition';

const NOW = 1_800_000_000_000;
const first: [number, number, number] = [45, 7, NOW - 120_000];
const second: [number, number, number] = [45, 7.1, NOW - 90_000];
const third: [number, number, number] = [45, 7.2, NOW - 60_000];
const id = ([lat, lon, time]: [number, number, number]) => lifecycleStrikeId({ lat, lon, time });

function storm(key: string, allStrikes = [first, second], extra: Partial<MigratingCountingStorm> = {}): MigratingCountingStorm {
  return { key, totalStrikes: allStrikes.length, keepEvery: 1, lastStrikeTime: NOW - 30_000, allStrikes, ...extra };
}

function hold(kind: StormTransition['kind']): StormTransition {
  return { id: `${kind}:A`, kind, startedAt: NOW - 240_000, confirmAt: NOW + 60_000,
    observedAt: NOW - 30_000, stormKeys: ['A'], links: [{ from: { nx: .1, ny: .2 }, to: { nx: .2, ny: .2 } }] };
}

describe('storm counting snapshot migration', () => {
  it('exposes exact official samples only when every unversioned history is complete', () => {
    const a = storm('A', [first, second, third]);
    const b = storm('B', [second, third]);
    expect(restoreStormCounting([a, b], NOW)).toEqual({ mode: 'exact', migrated: 2, mixed: false });
    expect(a.counting!.recent).toEqual({ [id(first)]: first[2], [id(second)]: second[2], [id(third)]: third[2] });
    expect(b.counting!.recent).toEqual({ [id(second)]: second[2], [id(third)]: third[2] });
    expect(a.counting!.legacy).toBeUndefined();
    expect(a.totalStrikes).toBe(3);
    expect(b.totalStrikes).toBe(2);
  });

  it('deduplicates saved samples and excludes quiet replay tails from official proof', () => {
    const tail: [number, number, number] = [45, 7.3, NOW - 10_000];
    const a = storm('A', [first, second, second, tail], { totalStrikes: 2 });
    expect(restoreStormCounting([a], NOW).mode).toBe('exact');
    expect(a.counting!.recent).toEqual({ [id(first)]: first[2], [id(second)]: second[2] });
    expect(a.counting!.recent[id(tail)]).toBeUndefined();
  });

  it('compacts complete old histories into shared weights without retaining lifetime point IDs', () => {
    const points = (lon: number, count: number): Array<[number, number, number]> => Array.from({ length: count }, (_, i) => [45, lon, NOW - 3_600_000 + i]);
    const shared = points(7, 2500);
    const a = storm('A', [...shared, ...points(8, 1500)]);
    const b = storm('B', [...shared, ...points(9, 500)]);
    expect(restoreStormCounting([a, b], NOW).mode).toBe('exact');
    compactStormCounting([a, b], NOW);
    expect(a.counting!.recent).toEqual({});
    expect(b.counting!.recent).toEqual({});
    expect(Object.values(a.counting!.cohorts)).toEqual([2500]);
    expect(a.counting!.cohorts).toEqual(b.counting!.cohorts);
    expect(mergeStormCounting(a, b)).toBe(500);
    expect(a.totalStrikes).toBe(4500);
    compactStormCounting([a], NOW);
    expect(a.counting!.cohorts).toEqual({});
  });

  it('keeps all unversioned histories opaque when one snapshot was sampled', () => {
    const a = storm('A');
    const ancestors = { A: 100 };
    const b = storm('B', [third], { keepEvery: 2, totalStrikes: 400, initialStrikesByAncestor: ancestors });
    expect(restoreStormCounting([a, b], NOW)).toEqual({ mode: 'legacy', migrated: 2, mixed: false });
    expect(a.counting).toEqual({ recent: {}, cohorts: {}, legacy: { total: 2, ancestors: {} } });
    expect(b.counting).toEqual({ recent: {}, cohorts: {}, legacy: { total: 400, ancestors: { A: 100 } } });
    expect(b.counting!.legacy!.ancestors).not.toBe(ancestors);
    expect([a.totalStrikes, b.totalStrikes]).toEqual([2, 400]);
  });

  it('does not infer completeness from keepEvery alone or from invalid sample data', () => {
    for (const candidate of [storm('missing', [first], { totalStrikes: 20 }), storm('invalid', [[NaN, 7, NOW - 1000]])]) {
      expect(restoreStormCounting([candidate], NOW).mode).toBe('legacy');
      expect(candidate.counting!.recent).toEqual({});
      expect(candidate.counting!.legacy!.total).toBe(candidate.totalStrikes);
    }
  });

  it('warms up an opaque pending split while preserving the last actual observation and links', () => {
    const original = hold('split');
    const a = storm('A', [first], { totalStrikes: 1000, lifecycle: { transitions: [original] } });
    restoreStormCounting([a], NOW);
    expect(a.lifecycle!.transitions[0]).toEqual({ ...original, startedAt: NOW, confirmAt: NOW + STORM_TRANSITION_MS });
    expect(a.lifecycle!.transitions[0].observedAt).toBe(NOW - 30_000);
  });

  it('preserves pending merge holds and does not delay provably exact split histories', () => {
    const merging = storm('A', [first], { totalStrikes: 1000, lifecycle: { transitions: [hold('merge')] } });
    const merge = merging.lifecycle!.transitions[0];
    restoreStormCounting([merging], NOW);
    expect(merging.lifecycle!.transitions[0]).toBe(merge);
    const splitting = storm('B', [first], { lifecycle: { transitions: [hold('split')] } });
    const split = splitting.lifecycle!.transitions[0];
    restoreStormCounting([splitting], NOW);
    expect(splitting.lifecycle!.transitions[0]).toBe(split);
  });

  it('never reinitializes versioned counts or extends their timers on another restart', () => {
    const a = storm('A', [first], { totalStrikes: 1000, lifecycle: { transitions: [hold('split')] } });
    restoreStormCounting([a], NOW);
    const counting = a.counting;
    const transition = a.lifecycle!.transitions[0];
    expect(restoreStormCounting([a], NOW + 60_000).mode).toBe('unchanged');
    expect(a.counting).toBe(counting);
    expect(a.lifecycle!.transitions[0]).toBe(transition);
  });

  it('preserves existing ledgers in a partial snapshot and reports opaque compatibility mode', () => {
    const counting = emptyStormCounting();
    counting.recent[id(first)] = first[2];
    counting.cohorts.old = 50;
    const versioned = storm('A', [first], { totalStrikes: 51, counting, lifecycle: { transitions: [hold('split')] } });
    const unversioned = storm('B', [first, third], { initialStrikesByAncestor: { A: 1 } });
    const transition = versioned.lifecycle!.transitions[0];
    expect(restoreStormCounting([versioned, unversioned], NOW)).toEqual({ mode: 'legacy', migrated: 1, mixed: true });
    expect(versioned.counting).toBe(counting);
    expect(versioned.lifecycle!.transitions[0]).toBe(transition);
    expect(unversioned.counting).toEqual({ recent: {}, cohorts: {}, legacy: { total: 2, ancestors: { A: 1 } } });
  });

  it('does nothing for an empty snapshot', () => {
    expect(restoreStormCounting([], NOW)).toEqual({ mode: 'unchanged', migrated: 0, mixed: false });
  });
});
