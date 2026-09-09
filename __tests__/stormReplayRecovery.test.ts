import { describe, expect, it } from 'vitest';
import { recoverOwnedReplay } from '../app/lib/stormReplayRecovery';
import type { StormStrike } from '../app/lib/db';

const time = 1_788_855_645_577;

describe('recoverOwnedReplay', () => {
  it('restores recorded membership even across a large gap in the sampled replay', () => {
    const anchors: StormStrike[] = [[43, -95, time], [43, -95, time + 60_000]];
    const owned: StormStrike[] = [[44, -93, time + 30_000], [45, -90, time + 600_000]];
    const result = recoverOwnedReplay(anchors, owned);
    expect(result.recoveredCount).toBe(2);
    expect(result.strikes).toEqual([anchors[0], owned[0], anchors[1], owned[1]]);
    expect(anchors).toHaveLength(2);
  });

  it('leaves a legacy sample unchanged when there is no recorded ownership to add', () => {
    const original: StormStrike[] = [[43, -95, time + 1000], [43, -95, time]];
    expect(recoverOwnedReplay(original, [])).toEqual({ strikes: original, recoveredCount: 0 });
    expect(recoverOwnedReplay([], [])).toEqual({ strikes: [], recoveredCount: 0 });
  });

  it('deduplicates shared ownership and rounded samples across repeated reads', () => {
    const anchor: StormStrike = [43.201, -94.506, time];
    const owned: StormStrike = [43.205314, -94.498717, time + 500];
    const once = recoverOwnedReplay([anchor], [[43.2011, -94.5061, time], owned, owned]);
    expect(once).toEqual({ strikes: [anchor, [43.205, -94.499, time + 500]], recoveredCount: 1 });
    expect(recoverOwnedReplay(once.strikes, [owned])).toEqual({ strikes: once.strikes, recoveredCount: 0 });
  });

  it('rejects invalid owned coordinates or times without removing historical samples', () => {
    const original: StormStrike[] = [[43, -95, time]];
    expect(recoverOwnedReplay(original, [[NaN, -95, time], [91, -95, time], [43, Infinity, time], [43, -95, NaN]]))
      .toEqual({ strikes: original, recoveredCount: 0 });
  });
});
