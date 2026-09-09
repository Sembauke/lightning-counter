import { describe, expect, it } from 'vitest';
import { compactStormCounting, COUNTED_STRIKE_WINDOW_MS, emptyStormCounting, mergeStormCounting, remapStormCountingKeys, rememberCountedStrike, sharedStormStrikeCount, type CountingStorm } from '../app/lib/stormCounting';

const point = (i: number, time = i) => ({ lat: 45, lon: 7 + i / 1000, time });
function storm(key: string, ids: number[]): CountingStorm {
  const result: CountingStorm = { key, totalStrikes: ids.length, counting: emptyStormCounting() };
  for (const id of ids) rememberCountedStrike(result, point(id));
  return result;
}

describe('official strike provenance through splits and merges', () => {
  it('counts only the actual shared subset when siblings overlap and then rejoin an ancestor', () => {
    const ids = Array.from({ length: 100 }, (_, i) => i);
    const parent = storm('parent', ids);
    const left = storm('left', ids.slice(0, 60));
    const right = storm('right', ids.slice(40));
    compactStormCounting([parent, left, right], COUNTED_STRIKE_WINDOW_MS + 1000);

    expect(Object.keys(parent.counting!.recent)).toHaveLength(0);
    expect(sharedStormStrikeCount(left, right)).toBe(20);
    expect(mergeStormCounting(left, right)).toBe(40);
    expect(left.totalStrikes).toBe(100);
    compactStormCounting([parent, left], COUNTED_STRIKE_WINDOW_MS + 2000);
    expect(Object.values(left.counting!.cohorts)).toEqual([100]);

    // A winner can adopt a stored ancestor's key without changing strike identity.
    left.key = 'canonical';
    remapStormCountingKeys([parent, left], 'left', 'canonical');
    expect(mergeStormCounting(left, parent)).toBe(0);
    expect(left.totalStrikes).toBe(100);
    compactStormCounting([left], COUNTED_STRIKE_WINDOW_MS + 3000);
    expect(left.counting!.cohorts).toEqual({});
  });

  it('does not pass a legacy baseline overlap into a new descendant', () => {
    const parent: CountingStorm = { key: 'A', totalStrikes: 250,
      counting: { ...emptyStormCounting(), legacy: { total: 250, ancestors: {} } } };
    const child: CountingStorm = { key: 'B', totalStrikes: 100,
      counting: { ...emptyStormCounting(), legacy: { total: 100, ancestors: { A: 100 } } } };
    const grandchild = storm('C', Array.from({ length: 150 }, (_, i) => i));
    for (let i = 0; i < 150; i++) { child.totalStrikes++; rememberCountedStrike(child, point(i)); }

    expect(sharedStormStrikeCount(parent, grandchild)).toBe(0);
    expect(mergeStormCounting(parent, grandchild)).toBe(150);
    expect(parent.totalStrikes).toBe(400);
    compactStormCounting([parent, child], COUNTED_STRIKE_WINDOW_MS + 1000);
    expect(sharedStormStrikeCount(parent, child)).toBe(250);
    expect(mergeStormCounting(child, parent)).toBe(150);
    expect(child.totalStrikes).toBe(400);
  });

  it('retains shared old history while both owners survive, even through repeated compaction', () => {
    const a = storm('A', [1, 2, 3]);
    const b = storm('B', [2, 3, 4]);
    const c = storm('C', [3, 4, 5]);
    for (let minutes = 11; minutes <= 90; minutes++) compactStormCounting([a, b, c], minutes * 60_000);
    expect(sharedStormStrikeCount(a, c)).toBe(1);
    // Retire B without merging. Its departure cannot erase A/C's shared strike.
    compactStormCounting([c, a], 91 * 60_000);
    expect(sharedStormStrikeCount(a, c)).toBe(1);
    expect(mergeStormCounting(a, c)).toBe(2);
    expect(a.totalStrikes).toBe(5);
  });

  it('never lets an uncertain legacy overlap subtract newly counted strikes', () => {
    const a = storm('A', Array.from({ length: 500 }, (_, i) => i));
    a.totalStrikes += 100;
    a.counting!.legacy = { total: 100, ancestors: {} };
    const b = storm('B', []);
    b.totalStrikes = 1000;
    b.counting!.legacy = { total: 1000, ancestors: { A: 500 } };
    expect(mergeStormCounting(a, b)).toBe(900);
    expect(a.totalStrikes).toBe(1500);
    expect(Object.keys(a.counting!.recent)).toHaveLength(500);
    expect(a.counting!.legacy!.total).toBe(1000);
  });

  it('matches an independent lifetime set oracle across repeated splits, merges, key changes and restarts', () => {
    let seed = 42;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    let now = 0, sequence = 0, identity = 0, splits = 0, merges = 0, maxCohorts = 0;
    const times = new Map<number, number>();
    let states: Array<CountingStorm & { expected: Set<number> }> = [];
    function create() {
      const st = { key: `storm-${identity++}`, totalStrikes: 0, counting: emptyStormCounting(), expected: new Set<number>() };
      states.push(st);
      return st;
    }
    for (let step = 0; step < 180; step++) {
      if (!states.length) create();
      const target = states[random(states.length)];
      for (let i = 0; i < 25; i++) {
        const id = sequence++;
        times.set(id, now);
        target.expected.add(id); target.totalStrikes++;
        rememberCountedStrike(target, point(id, now));
      }
      const action = random(4);
      if (action === 0 && states.length < 8) {
        splits++;
        const child = create();
        for (const id of target.expected) {
          if (times.get(id)! <= now - 5 * 60_000 || random(2)) continue;
          child.expected.add(id); child.totalStrikes++;
          rememberCountedStrike(child, point(id, times.get(id)!));
        }
      } else if (action === 1 && states.length > 1) {
        merges++;
        const loser = states.filter(s => s !== target)[random(states.length - 1)];
        const union = new Set([...target.expected, ...loser.expected]);
        const before = target.totalStrikes;
        expect(mergeStormCounting(target, loser)).toBe(union.size - before);
        target.expected = union;
        states = states.filter(s => s !== loser);
        const oldKey = target.key;
        target.key = `adopted-${identity++}`;
        remapStormCountingKeys(states, oldKey, target.key);
      }
      now += 60_000;
      compactStormCounting(states, now);
      maxCohorts = Math.max(maxCohorts, ...states.map(s => Object.keys(s.counting!.cohorts).length));
      if (step % 7 === 0) {
        states = states.map(s => ({ ...JSON.parse(JSON.stringify(s)), expected: s.expected }));
      }
      for (const s of states) expect(s.totalStrikes).toBe(s.expected.size);
      for (let i = 0; i < states.length; i++) for (let j = i + 1; j < states.length; j++) {
        const overlap = [...states[i].expected].filter(id => states[j].expected.has(id)).length;
        expect(sharedStormStrikeCount(states[i], states[j])).toBe(overlap);
      }
    }
    expect(splits).toBeGreaterThan(5);
    expect(merges).toBeGreaterThan(5);
    expect(maxCohorts).toBeGreaterThan(0);
  });
});
