import { describe, expect, it } from 'vitest';
import { buildStormFootprint, detectStormFootprints, footprintContact } from '../app/lib/stormFootprint';
import { combineStormLifecycle, reconcileStormLifecycle, type LifecycleStorm } from '../app/lib/stormLifecycle';
import type { StrikePoint } from '../app/lib/stormClusters';
import { STORM_DISTANT_SPLIT_KM, STORM_DISTANT_SPLIT_MS, STORM_TRANSITION_MS } from '../app/lib/stormTransition';

const NOW = Date.UTC(2026, 8, 9, 12);

function points(lon: number, now: number, count = 120): StrikePoint[] {
  return Array.from({ length: count }, (_, i) => ({ lat: 45 + i % 3 * .001, lon, time: now - 10_000 + i * 10, cc: 'IT' }));
}

function storm(key: string, members: StrikePoint[], now: number): LifecycleStorm {
  const lat = 45.001, lon = members.reduce((sum, p) => sum + p.lon, 0) / members.length;
  return { key, lat, lon, lastSeen: now, currentRate: members.length / 5, peakCount: members.length,
    totalStrikes: members.length, inDb: true, lastStrikeTime: Math.max(...members.map(p => p.time)),
    lifecycle: { observedAt: now, members, supportMembers: members, outline: buildStormFootprint(members, { lat, lon }), transitions: [] } };
}

function scenario(longitudes: number[], extra: StrikePoint[] = []) {
  const history = [...longitudes.flatMap(lon => points(lon, NOW)), ...extra];
  const parent = storm('parent', history, NOW);
  let storms = [parent], sequence = 0;
  function pass(elapsed: number, added: StrikePoint[] = []) {
    const now = NOW + elapsed;
    history.push(...longitudes.flatMap(lon => points(lon, now)), ...added);
    const observations = detectStormFootprints(history, now);
    const plan = reconcileStormLifecycle(storms, observations, now, members => storm(`child:${sequence++}`, members, now));
    for (const [owner, members] of plan.assignments) {
      owner.lastSeen = now;
      owner.currentRate = members.length / 5;
      owner.peakCount = Math.max(owner.peakCount, members.length);
    }
    return { observations, plan };
  }
  return { parent, pass, storms: () => storms, restart: () => { storms = JSON.parse(JSON.stringify(storms)); } };
}

describe('distance-aware confirmed storm splits', () => {
  it('confirms a fifty-kilometre outline gap after sixty continuous seconds', () => {
    const test = scenario([7, 9]);
    const first = test.pass(0);
    expect(first.observations).toHaveLength(2);
    expect(footprintContact(first.observations[0].outline, first.observations[1].outline)!.gapKm).toBeGreaterThan(STORM_DISTANT_SPLIT_KM);
    expect(test.parent.lifecycle!.splitTransition?.confirmAt).toBe(NOW + STORM_TRANSITION_MS);
    expect(test.parent.lifecycle!.transitions[0].confirmAt).toBe(NOW + STORM_DISTANT_SPLIT_MS);
    expect(test.pass(30_000).plan.splits).toHaveLength(0);
    const confirmed = test.pass(60_000);
    expect(confirmed.plan.splits).toHaveLength(1);
    expect(test.storms()).toHaveLength(2);
    expect(test.storms()[0].key).toBe('parent');
    expect(test.storms().every(owner => owner.lifecycle!.transitions.length === 0)).toBe(true);
  });

  it('keeps nearby disconnected outlines on the ordinary five-minute hold', () => {
    const test = scenario([7, 7.6]);
    const first = test.pass(0);
    const gap = footprintContact(first.observations[0].outline, first.observations[1].outline)!.gapKm;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(STORM_DISTANT_SPLIT_KM);
    for (let elapsed = 30_000; elapsed < STORM_TRANSITION_MS; elapsed += 30_000) {
      expect(test.pass(elapsed).plan.splits).toHaveLength(0);
      expect(test.parent.lifecycle!.distantSplit).toBeUndefined();
      expect(test.parent.lifecycle!.transitions[0].confirmAt).toBe(NOW + STORM_TRANSITION_MS);
    }
    expect(test.pass(STORM_TRANSITION_MS).plan.splits).toHaveLength(1);
  });

  it.each([{ lon: 7.85, distant: false }, { lon: 7.92, distant: true }])('uses the contour gap around fifty kilometres at longitude $lon', ({ lon, distant }) => {
    const test = scenario([7, lon]);
    const first = test.pass(0);
    const gap = footprintContact(first.observations[0].outline, first.observations[1].outline)!.gapKm;
    expect(gap).toBeGreaterThan(45);
    expect(gap).toBeLessThan(55);
    expect(gap >= STORM_DISTANT_SPLIT_KM).toBe(distant);
    expect(!!test.parent.lifecycle!.distantSplit).toBe(distant);
  });

  it('separates far groups together and preserves the normal hold inside each group', () => {
    const test = scenario([7, 7.6, 9.5, 10.1]);
    test.pass(0);
    expect(test.parent.lifecycle!.distantSplit?.branches).toHaveLength(2);
    expect(test.parent.lifecycle!.splitBranches).toHaveLength(4);
    expect(test.parent.lifecycle!.transitions[0].links).toHaveLength(1);
    test.pass(30_000);
    expect(test.pass(60_000).plan.splits).toHaveLength(1);
    expect(test.storms()).toHaveLength(2);
    for (const owner of test.storms()) {
      expect(owner.lifecycle!.splitBranches).toHaveLength(2);
      expect(owner.lifecycle!.transitions[0].startedAt).toBe(NOW);
      expect(owner.lifecycle!.transitions[0].confirmAt).toBe(NOW + STORM_TRANSITION_MS);
      expect(owner.lifecycle!.transitions[0].stormKeys).toEqual([owner.key]);
    }
    for (let elapsed = 90_000; elapsed < STORM_TRANSITION_MS; elapsed += 30_000) expect(test.pass(elapsed).plan.splits).toHaveLength(0);
    expect(test.pass(STORM_TRANSITION_MS).plan.splits).toHaveLength(2);
    expect(test.storms()).toHaveLength(4);
  });

  it('does not separate nearby chains early just because their endpoints are distant', () => {
    const test = scenario([7, 7.8, 8.6]);
    const first = test.pass(0);
    expect(first.observations).toHaveLength(3);
    expect(test.parent.lifecycle!.distantSplit).toBeUndefined();
    test.pass(30_000);
    expect(test.pass(60_000).plan.splits).toHaveLength(0);
    expect(test.parent.lifecycle!.transitions[0].confirmAt).toBe(NOW + STORM_TRANSITION_MS);
  });

  it('starts a fresh distant hold when an old connecting tail expires late in a normal hold', () => {
    const tail = [7.2, 7.4, 7.6, 7.8].flatMap(lon => points(lon, NOW - 335_000, 10));
    const test = scenario([7, 8.5], tail);
    test.pass(0);
    expect(test.parent.lifecycle!.distantSplit).toBeUndefined();
    for (let elapsed = 30_000; elapsed <= 240_000; elapsed += 30_000) test.pass(elapsed);
    expect(test.parent.lifecycle!.distantSplit).toBeUndefined();
    expect(test.pass(270_000).plan.splits).toHaveLength(0);
    expect(test.parent.lifecycle!.distantSplit?.transition.startedAt).toBe(NOW + 270_000);
    expect(test.parent.lifecycle!.distantSplit?.transition.confirmAt).toBe(NOW + 330_000);
    // The already observed normal separation is due first; widening the gap
    // cannot retroactively make the new sixty-second evidence complete.
    expect(test.parent.lifecycle!.transitions[0].confirmAt).toBe(NOW + 300_000);
    expect(test.pass(300_000).plan.splits).toHaveLength(1);
  });

  it('cancels the distant hold when the gap narrows without resetting normal separation', () => {
    const test = scenario([7, 9]);
    test.pass(0);
    const extension = [7.2, 7.4, 7.6, 7.8, 8, 8.2, 8.4].flatMap(lon => points(lon, NOW - 540_000, 10));
    const narrowed = test.pass(30_000, extension);
    expect(narrowed.observations).toHaveLength(2);
    expect(test.parent.lifecycle!.distantSplit).toBeUndefined();
    expect(test.parent.lifecycle!.splitTransition?.startedAt).toBe(NOW);
    expect(test.parent.lifecycle!.transitions[0].confirmAt).toBe(NOW + STORM_TRANSITION_MS);
    // Once that old extension expires, the distant gap needs a new full hold.
    expect(test.pass(60_000).plan.splits).toHaveLength(0);
    expect(test.parent.lifecycle!.distantSplit?.transition.startedAt).toBe(NOW + 60_000);
    expect(test.parent.lifecycle!.splitTransition?.startedAt).toBe(NOW);
    test.pass(90_000);
    expect(test.pass(120_000).plan.splits).toHaveLength(1);
  });

  it('restarts the distant hold when group membership changes despite the same group count', () => {
    const expiringTail = points(7.2, NOW - 575_000, 10);
    const test = scenario([7, 8, 9], expiringTail);
    test.pass(0);
    expect(test.parent.lifecycle!.distantSplit?.branches).toHaveLength(2);
    const changed = test.pass(30_000, points(8.2, NOW + 30_000, 10));
    expect(changed.observations).toHaveLength(3);
    expect(test.parent.lifecycle!.distantSplit?.branches).toHaveLength(2);
    expect(test.parent.lifecycle!.distantSplit?.transition.startedAt).toBe(NOW + 30_000);
    expect(test.parent.lifecycle!.splitTransition?.startedAt).toBe(NOW);
    expect(test.pass(60_000).plan.splits).toHaveLength(0);
    expect(test.pass(90_000).plan.splits).toHaveLength(1);
  });

  it('preserves a short restart but restarts distant evidence after an observation gap', () => {
    const restored = scenario([7, 9]);
    restored.pass(0);
    restored.pass(30_000);
    restored.restart();
    expect(restored.pass(60_000).plan.splits).toHaveLength(1);

    const interrupted = scenario([7, 9]);
    interrupted.pass(0);
    expect(interrupted.pass(91_000).plan.splits).toHaveLength(0);
    expect(interrupted.parent.lifecycle!.distantSplit?.transition.startedAt).toBe(NOW + 91_000);
    expect(interrupted.parent.lifecycle!.splitTransition?.startedAt).toBe(NOW + 91_000);
    interrupted.pass(121_000);
    expect(interrupted.pass(151_000).plan.splits).toHaveLength(1);
  });

  it('honors migrated counting warmup rather than splitting an opaque storm after sixty seconds', () => {
    const test = scenario([7, 9]);
    test.parent.splitNotBefore = NOW + STORM_TRANSITION_MS;
    for (let elapsed = 0; elapsed < STORM_TRANSITION_MS; elapsed += 30_000) {
      expect(test.pass(elapsed).plan.splits).toHaveLength(0);
      expect(test.parent.lifecycle!.transitions[0].confirmAt).toBe(NOW + STORM_TRANSITION_MS);
    }
    expect(test.pass(STORM_TRANSITION_MS).plan.splits).toHaveLength(1);
  });

  it('preserves the latest counting warmup when a migrant is absorbed', () => {
    const winner = storm('winner', points(7, NOW), NOW);
    const first = storm('first', points(7.1, NOW), NOW);
    const second = storm('second', points(7.2, NOW), NOW);
    winner.splitNotBefore = NOW + 60_000;
    first.splitNotBefore = NOW + 300_000;
    second.splitNotBefore = NOW + 240_000;
    combineStormLifecycle(winner, [first, second], NOW);
    expect(winner.splitNotBefore).toBe(NOW + 300_000);
  });
});
