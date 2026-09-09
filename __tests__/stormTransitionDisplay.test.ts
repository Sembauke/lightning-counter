import { describe, expect, it } from 'vitest';
import type { StormTransition } from '../app/lib/stormTransition';
import { collectStormTransitions, STORM_TRANSITION_STALE_MS, transitionLabel } from '../app/lib/stormTransitionDisplay';

const now = 1_000_000;
const transition: StormTransition = {
  id: 'merge:a:b', kind: 'merge', startedAt: now - 60_000,
  confirmAt: now + 30_000, observedAt: now,
  stormKeys: ['a', 'b'], links: [{ from: { nx: 0.5, ny: 0.4 }, to: { nx: 0.51, ny: 0.4 } }],
};

describe('authoritative transition display', () => {
  it('counts down to the supplied deadline in seconds without rounding early', () => {
    expect(transitionLabel(transition, now)).toBe('Merge 00:30');
    expect(transitionLabel(transition, now + 1000)).toBe('Merge 00:29');
    expect(transitionLabel(transition, transition.confirmAt - 1)).toBe('Merge 00:01');
    expect(transitionLabel({ ...transition, kind: 'split', confirmAt: now + 299_000 }, now)).toBe('Split 04:59');
  });

  it('waits for the server at the deadline instead of confirming locally', () => {
    expect(transitionLabel(transition, transition.confirmAt)).toBe('Confirming merge…');
    expect(transitionLabel({ ...transition, kind: 'split' }, transition.confirmAt + 1)).toBe('Confirming split…');
    expect(collectStormTransitions([{ transitions: [transition] }])?.get('a')).toBe(transition);
  });

  it('shows waiting state for a disconnected or stale source even beyond the deadline', () => {
    expect(transitionLabel(transition, now + 1000, false)).toBe('Merge · waiting for update');
    expect(transitionLabel(transition, now + STORM_TRANSITION_STALE_MS + 1)).toBe('Merge · waiting for update');
    expect(transitionLabel({ ...transition, observedAt: now + STORM_TRANSITION_STALE_MS }, now + STORM_TRANSITION_STALE_MS + 1)).toBe('Confirming merge…');
  });

  it('deduplicates shared merge events and associates both storm identities', () => {
    const later = { ...transition, observedAt: now + 30_000 };
    const result = collectStormTransitions([{ transitions: [transition] }, { transitions: [later] }]);
    expect([...result!.keys()]).toEqual(['a', 'b']);
    expect(result!.get('a')).toBe(later);
    expect(result!.get('b')).toBe(later);
  });

  it('clears cancelled or confirmed transitions only when a snapshot removes them', () => {
    expect(collectStormTransitions([{ transitions: [transition] }])?.size).toBe(2);
    expect(collectStormTransitions([{ transitions: [] }, { key: 'b' }])?.size).toBe(0);
    expect(collectStormTransitions([])?.size).toBe(0);
  });

  it('keeps malformed input distinguishable from an authoritative cancellation', () => {
    expect(collectStormTransitions({})).toBeNull();
    expect(collectStormTransitions([null])).toBeNull();
    expect(collectStormTransitions([{ transitions: {} }])).toBeNull();
    expect(collectStormTransitions([{ transitions: [{ ...transition, confirmAt: Number.NaN }] }])).toBeNull();
    expect(collectStormTransitions([{ transitions: [{ ...transition, links: [{ from: null, to: {} }] }] }])).toBeNull();
  });

  it('resolves duplicate conflicting snapshots deterministically without inventing membership', () => {
    const split = { ...transition, id: 'split:a', kind: 'split' as const, observedAt: now + 1, stormKeys: ['a'] };
    const result = collectStormTransitions([{ transitions: [transition, split] }]);
    expect(result!.get('a')).toBe(split);
    expect(result!.get('b')).toBe(transition);
  });
});
