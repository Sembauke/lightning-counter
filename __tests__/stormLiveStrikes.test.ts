import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/storms/[key]/strikes/route';
import { getStormReplayByKey } from '../app/lib/db';
import { getStormLiveStrikes, getStormLiveRates, publishStormOwnership } from '../app/lib/strikeStream';
import type { StormOwnershipSource } from '../app/lib/stormStrikeOwnership';
import { STORM_OBSERVATION_GAP_MS } from '../app/lib/stormTransition';

vi.mock('../app/lib/db', () => ({
  getStormReplayByKey: vi.fn(),
  getNearbyRankedStorms: vi.fn(() => []),
}));

const now = 1_000_000;
const point = (lon: number, time = now - 1000) => ({ lat: 44, lon, time });
const storm = (key: string, members = [point(10)]): StormOwnershipSource => ({
  key, lat: members[0].lat, lon: members[0].lon, lastSeen: now, currentRate: 30,
  lifecycle: { members, supportMembers: members, transitions: [] },
});
const globals = globalThis as typeof globalThis & Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  for (const key of ['_stormStrikeOwnership', '_stormStrikeSubscribers', '_recentStrikes']) delete globals[key];
});

afterEach(() => {
  for (const key of ['_stormStrikeOwnership', '_stormStrikeSubscribers', '_recentStrikes']) delete globals[key];
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('live storm strike observations', () => {
  it('uses the identical rolling window for shared map rates and detail snapshots', () => {
    publishStormOwnership([
      storm('a', [point(10, now - 60_000), point(10, now - 59_500), point(10.01)]),
      storm('b', [point(10.65)]),
    ], now);
    globals._recentStrikes = [point(10.02, now), point(10.64, now)];
    const rates = getStormLiveRates(['a', 'b', 'missing'], now);
    expect(rates).toEqual({ at: now, rates: { a: 3, b: 2, missing: null } });
    expect(rates.rates.a).toBe(getStormLiveStrikes('a', now)?.length);
    expect(rates.rates.b).toBe(getStormLiveStrikes('b', now)?.length);
    expect(getStormLiveRates(['a', 'b'], now + 1000).rates).toEqual({ a: 2, b: 2 });
    expect(getStormLiveRates(['a', 'b'], now + 60_000).rates).toEqual({ a: 0, b: 0 });
  });

  it('provides the full recent owned window separately from a sampled replay in polls', async () => {
    const members = [point(10, now - 50_000), point(10.01, now - 30_000), point(10.02)];
    publishStormOwnership([storm('a', members)], now);
    const sample = [[44, 10.02, now - 1000]];
    vi.mocked(getStormReplayByKey).mockReturnValue({ stormKey: 'a', strikes: sample } as ReturnType<typeof getStormReplayByKey>);

    const response = await GET(new NextRequest('http://localhost/api/storms/alias/strikes'), {
      params: Promise.resolve({ key: 'alias' }),
    });
    expect(await response.json()).toMatchObject({
      stormKey: 'a',
      strikes: sample,
      liveStrikes: members.map(p => [p.lat, p.lon, p.time]),
    });
  });

  it('excludes a confirmed sibling from inherited anchors and the global live tail', () => {
    const left = storm('left');
    left.replayAnchors = [[44, 10.65, now - 1000]];
    publishStormOwnership([left, storm('right', [point(10.65)])], now);
    globals._recentStrikes = [point(10.01, now), point(10.64, now)];

    expect(getStormLiveStrikes('left', now)).toEqual([
      [44, 10, now - 1000], [44, 10.01, now],
    ]);
  });

  it('includes late and simultaneous distinct observations while deduplicating rounded coordinates', () => {
    publishStormOwnership([storm('a', [point(10, now - 30_000), point(10.01)])], now);
    globals._recentStrikes = [
      point(10.0001, now - 30_000),
      point(10.02, now - 10_000),
      point(10.03),
      point(10.03),
    ];

    expect(getStormLiveStrikes('a', now)).toEqual([
      [44, 10.0001, now - 30_000], [44, 10.02, now - 10_000],
      [44, 10.01, now - 1000], [44, 10.03, now - 1000],
    ]);
  });

  it('uses a rolling minute and rejects future or invalid global observations', () => {
    publishStormOwnership([storm('a', [point(10, now - 60_000), point(10.01, now - 59_999)])], now);
    globals._recentStrikes = [point(10.02, now), point(10.03, now + 1), point(10.04, NaN), point(NaN, now)];

    expect(getStormLiveStrikes('a', now)).toEqual([
      [44, 10.01, now - 59_999], [44, 10.02, now],
    ]);
    expect(getStormLiveStrikes('a', now + 60_001)).toEqual([]);
  });

  it('does not assign unconfirmed live observations to quiet owners', () => {
    publishStormOwnership([{ ...storm('quiet'), currentRate: 19 }], now);
    globals._recentStrikes = [point(10.01, now)];
    expect(getStormLiveStrikes('quiet', now)).toEqual([[44, 10, now - 1000]]);
  });

  it('distinguishes missing or stale ownership from a known empty recent window', () => {
    expect(getStormLiveStrikes('a', now)).toBeNull();
    publishStormOwnership([storm('a', [point(10, now - 2 * 60_000)])], now);
    expect(getStormLiveStrikes('missing', now)).toBeNull();
    expect(getStormLiveStrikes('a', now)).toEqual([]);
    expect(getStormLiveStrikes('a', now + STORM_OBSERVATION_GAP_MS)).toEqual([]);
    expect(getStormLiveStrikes('a', now + STORM_OBSERVATION_GAP_MS + 1)).toBeNull();
  });
});
