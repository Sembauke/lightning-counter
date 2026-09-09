import { describe, expect, it } from 'vitest';
import { assignOutlinePoints } from '../app/lib/stormOutlineMembership';

describe('storm outline ownership', () => {
  const west = { stormKey: 'west', rank: 1, lat: 44, lon: 8 };
  const east = { stormKey: 'east', rank: 2, lat: 44, lon: 10 };

  it('keeps distinct tracked identities even when their collection radii overlap', () => {
    const points = [{ lat: 44, lon: 8.8 }, { lat: 44, lon: 9.2 }];
    const owned = assignOutlinePoints([west, east], points);
    expect(owned.get(west)).toEqual([points[0]]);
    expect(owned.get(east)).toEqual([points[1]]);
  });

  it('assigns ties deterministically and ignores far-away points', () => {
    const points = [{ lat: 44, lon: 9 }, { lat: 40, lon: 5 }];
    for (const storms of [[west, east], [east, west]]) {
      const owned = assignOutlinePoints(storms, points);
      expect(owned.get(east)).toEqual([points[0]]);
      expect(owned.get(west)).toEqual([]);
    }
  });

  it('keeps separated active patches under the same server identity', () => {
    const storm = { stormKey: 'IT:one-system', rank: 1, lat: 44, lon: 9.5 };
    const points = [{ lat: 44.4, lon: 8.95 }, { lat: 44.1, lon: 9.8 }];
    expect(assignOutlinePoints([storm], points).get(storm)).toEqual(points);
  });

  it('handles nearby points across the date line', () => {
    const storm = { stormKey: 'ocean', rank: 1, lat: 0, lon: 179.9 };
    const point = { lat: 0, lon: -179.9 };
    expect(assignOutlinePoints([storm], [point]).get(storm)).toEqual([point]);
  });
});
