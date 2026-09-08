import { describe, expect, it } from 'vitest';
import { latestReplayTime, mergeReplayStrikes, shouldPollStormReplay } from '../app/lib/stormReplayState';

describe('replay updates', () => {
  it('deduplicates overlapping persisted and live history without losing strikes sharing a timestamp', () => {
    const base: [number, number, number][] = [[43.201, -94.506, 1000]];
    const live: [number, number, number][] = [[43.2011, -94.5061, 1000], [43.3, -94.4, 1000], [43.4, -94.3, 2000]];
    const merged = mergeReplayStrikes(base, live);
    expect(merged).toEqual([base[0], live[1], live[2]]);
    expect(latestReplayTime(merged)).toBe(2000);
  });

  it('continues polling after official activity ends and while a long residual tail remains', () => {
    const now = 10_000_000;
    expect(shouldPollStormReplay(now - 59 * 60_000, now - 20 * 60_000, now)).toBe(true);
    expect(shouldPollStormReplay(now - 2 * 60 * 60_000, now - 9 * 60_000, now)).toBe(true);
    expect(shouldPollStormReplay(now - 2 * 60 * 60_000, now - 10 * 60_000, now)).toBe(false);
    expect(shouldPollStormReplay(null, 0, now)).toBe(false);
  });

  it('matches the persisted rounding at negative half-millidegrees and signed zero', () => {
    expect(mergeReplayStrikes([[-50, 0, 1000]], [[-50.0005, -0.0002, 1000]])).toEqual([[-50, 0, 1000]]);
  });
});
