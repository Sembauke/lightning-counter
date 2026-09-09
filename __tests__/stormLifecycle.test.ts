import { describe, expect, it } from 'vitest';
import { combineStormLifecycle, lifecycleStrikeId, reconcileStormLifecycle, stormLifecycleSummaries, type LifecycleStorm } from '../app/lib/stormLifecycle';
import { buildStormFootprint, type StormFootprintObservation } from '../app/lib/stormFootprint';
import type { StrikePoint } from '../app/lib/stormClusters';

const NOW = 1_789_000_000_000;
function points(lon: number, now = NOW, count = 120): StrikePoint[] {
  return Array.from({ length: count }, (_, i) => ({ lat: 45 + i % 3 * .0001, lon, time: now - 20_000 + i, cc: 'IT' }));
}
function observation(members: StrikePoint[], now = NOW): StormFootprintObservation {
  const lat = members.reduce((sum, p) => sum + p.lat, 0) / members.length;
  const lon = members.reduce((sum, p) => sum + p.lon, 0) / members.length;
  return { lat, lon, members, activeMembers: members.filter(p => p.time > now - 300_000), supportMembers: members,
    outline: buildStormFootprint(members, { lat, lon })! };
}
function storm(key: string, members: StrikePoint[], now = NOW): LifecycleStorm {
  const obs = observation(members, now);
  return { key, lat: obs.lat, lon: obs.lon, lastSeen: now, currentRate: obs.activeMembers.length / 5,
    peakCount: obs.activeMembers.length, totalStrikes: members.length, inDb: true,
    lastStrikeTime: Math.max(...members.map(p => p.time)),
    lifecycle: { members, supportMembers: members, observedAt: now, outline: obs.outline, transitions: [] } };
}
function factory(now: number) {
  let sequence = 0;
  return (members: StrikePoint[]) => storm(`new:${now}:${sequence++}`, members, now);
}

describe('authoritative storm lifecycle', () => {
  it('keeps disconnected qualified branches under one parent until five continuous minutes elapse', () => {
    const a = points(7), b = points(7.6);
    const parent = storm('A', [...a, ...b]);
    const storms = [parent];
    for (let elapsed = 0; elapsed <= 300_000; elapsed += 30_000) {
      const now = NOW + elapsed;
      const left = observation([...a, ...points(7, now)], now);
      const right = observation([...b, ...points(7.6, now)], now);
      const plan = reconcileStormLifecycle(storms, elapsed % 60_000 ? [right, left] : [left, right], now, factory(now));
      if (elapsed < 300_000) {
        expect(storms).toHaveLength(1);
        expect(plan.assignments.get(parent)).toHaveLength(elapsed ? 480 : 240);
        expect(parent.lifecycle!.transitions[0].startedAt).toBe(NOW);
        expect(parent.lifecycle!.transitions[0].confirmAt).toBe(NOW + 300_000);
        expect(plan.splits).toHaveLength(0);
      } else {
        expect(storms).toHaveLength(2);
        expect(plan.splits).toHaveLength(1);
        expect(parent.lifecycle!.transitions).toEqual([]);
        expect(plan.splits[0].overlap).toBe(0);
        expect(stormLifecycleSummaries(storms, now)).toHaveLength(2);
      }
      parent.lastSeen = now;
    }
  });

  it('cancels separation on reconnection and starts a new full timer later', () => {
    const a = points(7), b = points(7.6), parent = storm('A', [...a, ...b]);
    const storms = [parent];
    reconcileStormLifecycle(storms, [observation(a), observation(b)], NOW, factory(NOW));
    reconcileStormLifecycle(storms, [observation([...a, ...b])], NOW + 30_000, factory(NOW));
    expect(parent.lifecycle!.transitions).toEqual([]);
    reconcileStormLifecycle(storms, [observation(a), observation(b)], NOW + 60_000, factory(NOW));
    expect(parent.lifecycle!.transitions[0].startedAt).toBe(NOW + 60_000);
  });

  it('does not turn a quiet branch or sparse outlier into a split candidate', () => {
    const a = points(7), b = points(7.6, NOW, 99), parent = storm('A', [...a, ...b]);
    const plan = reconcileStormLifecycle([parent], [observation(a), observation(b)], NOW, factory(NOW));
    expect(parent.lifecycle!.transitions).toEqual([]);
    expect(plan.splits).toEqual([]);
    expect(plan.assignments.get(parent)).toHaveLength(219);
  });

  it('keeps two touching identities and their exact strike ownership until the merge deadline', () => {
    const a = points(7), b = points(7.2), first = storm('A', a), second = storm('B', b);
    const storms = [first, second];
    for (let elapsed = 0; elapsed <= 300_000; elapsed += 30_000) {
      const now = NOW + elapsed;
      const freshA = points(7, now), freshB = points(7.2, now);
      const plan = reconcileStormLifecycle(storms, [observation([...a, ...b, ...freshA, ...freshB], now)], now, factory(now));
      const firstIds = new Set(plan.assignments.get(first)!.map(lifecycleStrikeId));
      expect(plan.assignments.get(second)!.every(p => !firstIds.has(lifecycleStrikeId(p)))).toBe(true);
      expect(plan.splits).toHaveLength(0);
      if (elapsed < 300_000) {
        expect(plan.merges).toHaveLength(0);
        expect(first.lifecycle!.transitions[0].startedAt).toBe(NOW);
        expect(second.lifecycle!.transitions[0]).toEqual(first.lifecycle!.transitions[0]);
      } else expect(plan.merges.map(({ winner, losers }) => ({ winner, losers }))).toEqual([{ winner: first, losers: [second] }]);
      first.lastSeen = second.lastSeen = now;
    }
  });

  it('cancels a merge immediately when contact ends', () => {
    const a = points(7), b = points(7.2), storms = [storm('A', a), storm('B', b)];
    reconcileStormLifecycle(storms, [observation([...a, ...b])], NOW, factory(NOW));
    const plan = reconcileStormLifecycle(storms, [observation(a), observation(b)], NOW + 30_000, factory(NOW));
    expect(storms.every(st => !st.lifecycle!.transitions.length)).toBe(true);
    expect(plan.merges).toHaveLength(0);
  });

  it('starts a merge when the touching branch is weak but its whole storm qualifies', () => {
    const west = points(7), east = points(7.6, NOW, 40), neighbor = points(7.75);
    const first = storm('A', [...west, ...east]), second = storm('B', neighbor);
    const plan = reconcileStormLifecycle([first, second], [observation(west), observation([...east, ...neighbor])], NOW, factory(NOW));
    expect(plan.assignments.get(first)).toHaveLength(160);
    expect(plan.assignments.get(second)).toHaveLength(120);
    expect(first.lifecycle!.transitions[0].kind).toBe('merge');
    expect(first.lifecycle!.transitions[0].stormKeys).toEqual(['A', 'B']);
    expect(second.lifecycle!.transitions[0]).toEqual(first.lifecycle!.transitions[0]);
    expect(plan.merges).toHaveLength(0);
  });

  it('does not start a merge when the touching storm as a whole is below twenty per minute', () => {
    const west = points(7, NOW, 50), east = points(7.6, NOW, 40), neighbor = points(7.75);
    const first = storm('A', [...west, ...east]), second = storm('B', neighbor);
    const plan = reconcileStormLifecycle([first, second], [observation(west), observation([...east, ...neighbor])], NOW, factory(NOW));
    expect(plan.assignments.has(first)).toBe(false);
    expect(plan.assignments.get(second)).toHaveLength(120);
    expect(first.lifecycle!.transitions).toEqual([]);
    expect(second.lifecycle!.transitions).toEqual([]);
    expect(plan.merges).toHaveLength(0);
  });

  it('persists a short-restart countdown but resets after an observation gap', () => {
    const a = points(7), b = points(7.2);
    let storms = [storm('A', a), storm('B', b)];
    reconcileStormLifecycle(storms, [observation([...a, ...b])], NOW, factory(NOW));
    storms = JSON.parse(JSON.stringify(storms));
    reconcileStormLifecycle(storms, [observation([...a, ...b])], NOW + 60_000, factory(NOW));
    expect(storms[0].lifecycle!.transitions[0].startedAt).toBe(NOW);
    reconcileStormLifecycle(storms, [observation([...a, ...b])], NOW + 151_000, factory(NOW));
    expect(storms[0].lifecycle!.transitions[0].startedAt).toBe(NOW + 151_000);
  });

  it('restarts the hold when a third identity joins the contacting group', () => {
    const a = points(7), b = points(7.2), c = points(7.4);
    const storms = [storm('A', a), storm('B', b), storm('C', c)];
    reconcileStormLifecycle(storms, [observation([...a, ...b]), observation(c)], NOW, factory(NOW));
    reconcileStormLifecycle(storms, [observation([...a, ...b, ...c])], NOW + 30_000, factory(NOW));
    expect(storms[0].lifecycle!.transitions[0].stormKeys).toEqual(['A', 'B', 'C']);
    expect(storms[0].lifecycle!.transitions[0].startedAt).toBe(NOW + 30_000);
  });

  it('keeps nearby independently confirmed storm labels visible and deduplicates only exact keys', () => {
    const a = storm('A', points(7)), b = storm('B', points(7.1));
    const snapshots = stormLifecycleSummaries([a, a, b], NOW);
    expect(snapshots.map(s => s.key)).toEqual(['A', 'B']);
    expect(snapshots.every(s => s.outline && s.transitions)).toBe(true);
  });

  it('publishes a stale pending hold on reconnect until fresh evidence restarts it', () => {
    const a = points(7), b = points(7.2);
    const storms = [storm('A', a), storm('B', b)];
    reconcileStormLifecycle(storms, [observation([...a, ...b])], NOW, factory(NOW));
    const snapshots = stormLifecycleSummaries(storms, NOW + 120_000);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].transitions[0]).toMatchObject({ observedAt: NOW, startedAt: NOW });
    const plan = reconcileStormLifecycle(storms, [observation([...a, ...b], NOW + 120_000)], NOW + 120_000, factory(NOW));
    expect(plan.merges).toHaveLength(0);
    expect(storms[0].lifecycle!.transitions[0].startedAt).toBe(NOW + 120_000);
  });

  it('preserves combined ownership and advances the absorbed strike watermark', () => {
    const a = storm('A', points(7)), b = storm('B', points(7.2, NOW + 30_000));
    combineStormLifecycle(a, [b], NOW + 30_000);
    expect(a.lastStrikeTime).toBe(b.lastStrikeTime);
    expect(a.lifecycle!.members).toHaveLength(240);
    expect(a.lifecycle!.outline!.segments.length).toBeGreaterThan(0);
  });
});
