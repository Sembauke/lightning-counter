import { describe, expect, it } from 'vitest';
import { detectStorms, type StrikePoint } from '../app/lib/stormClusters';

const WINDOW_MS = 5 * 60_000;
const NOW = Date.now();

function points(lat: number, lon: number, count: number): StrikePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: lat + i * 0.000001,
    lon,
    time: NOW - 60_000 + i * 100,
  }));
}

describe('storm core and border membership', () => {
  it('keeps a close fringe across a grid boundary when the same cloud is translated', () => {
    // Just 163 metres separate these groups, but longitude -95 divides their
    // buckets. The old detector dropped all nine points east of the boundary.
    const input = [...points(43.01, -95.001, 80), ...points(43.01, -94.999, 9)];
    const [atBoundary] = detectStorms(input, WINDOW_MS);
    const translated = input.map(s => ({ ...s, lon: s.lon - 0.01 }));
    const [awayFromBoundary] = detectStorms(translated, WINDOW_MS);

    expect(atBoundary.members).toHaveLength(input.length);
    expect(new Set(atBoundary.members)).toEqual(new Set(input));
    expect(awayFromBoundary.count).toBe(atBoundary.count);
    expect(atBoundary.rate).toBe(input.length / 5);
  });

  it('does not merge separate cores through a sparse bridge or grow borders recursively', () => {
    const west = points(43.125, 0.125, 80);
    const east = points(43.125, 2.125, 80);
    const bridge = Array.from({ length: 7 }, (_, i) => points(43.125, 0.375 + i * 0.25, 9));
    const input = [...west, ...bridge.flat(), ...east];

    for (const ordered of [input, [...input].reverse()]) {
      const storms = detectStorms(ordered, WINDOW_MS);
      expect(storms).toHaveLength(2);
      expect(storms.every(s => s.mergedFrom === 1)).toBe(true);
      const members = new Set(storms.flatMap(s => s.members));
      expect(members.has(bridge[0][0])).toBe(true); // Within 25 km of the western core.
      expect(members.has(bridge[6][0])).toBe(true); // Within 25 km of the eastern core.
      expect(members.has(bridge[1][0])).toBe(false); // Near an attached border, beyond the core.
      expect(members.has(bridge[3][0])).toBe(false); // Middle of the inter-storm background.
    }
  });

  it('measures border distance to actual core points and excludes a distant sparse outlier', () => {
    const core = points(43.125, -95.125, 80);
    const nearby = points(43.251, -95.125, 1)[0];
    const distant = points(43.475, -95.125, 1)[0];
    // Both border points are in the same adjacent grid bucket; only one is
    // physically within 25 km. Adding whole adjacent buckets would keep both.
    const [storm] = detectStorms([...core, nearby, distant], WINDOW_MS);

    expect(storm.members).toContain(nearby);
    expect(storm.members).not.toContain(distant);
    expect(storm.count).toBe(81);
  });

  it('searches beyond adjacent longitude buckets where meridians converge', () => {
    const core = points(80.01, 10.01, 80);
    const nearby = points(80.01, 11.26, 1)[0]; // About 24 km, across five longitude buckets.
    const distant = points(80.01, 11.51, 1)[0]; // About 29 km.
    const [storm] = detectStorms([...core, nearby, distant], WINDOW_MS);

    expect(storm.members).toContain(nearby);
    expect(storm.members).not.toContain(distant);
  });

  it('assigns a shared border to the nearest original core exactly once', () => {
    // Elongated cores have well-separated centroids but their nearest edges
    // are both within 25 km of the two border points in the intervening cell.
    const west = [-96.1, -95.9, -95.65, -95.4, -95.2]
      .flatMap((lon, i) => points(43.125, lon, i === 0 ? 80 : 10));
    const east = [-94.65, -94.4, -94.15, -93.9]
      .flatMap((lon, i) => points(43.125, lon, i === 3 ? 80 : 10));
    const nearWest = points(43.125, -94.94, 1)[0];
    const nearEast = points(43.125, -94.91, 1)[0];
    const input = [...west, ...east, nearWest, nearEast];
    const storms = detectStorms(input, WINDOW_MS);

    expect(storms).toHaveLength(2);
    const westernStorm = storms.find(s => s.members.includes(west[0]))!;
    const easternStorm = storms.find(s => s.members.includes(east[0]))!;
    expect(westernStorm.members).toContain(nearWest);
    expect(westernStorm.members).not.toContain(nearEast);
    expect(easternStorm.members).toContain(nearEast);
    expect(easternStorm.members).not.toContain(nearWest);
    expect(storms.flatMap(s => s.members)).toHaveLength(input.length);
    expect(new Set(storms.flatMap(s => s.members))).toHaveProperty('size', input.length);
    for (const storm of storms) {
      expect(storm.count).toBe(storm.members.length);
      expect(storm.rate).toBe(storm.count / 5);
    }
  });

  it('requires a qualifying dense core before adding sparse border strikes', () => {
    const belowThreshold = [...points(43.01, -95.001, 74), ...points(43.01, -94.999, 9)];
    expect(detectStorms(belowThreshold, WINDOW_MS)).toEqual([]);
    const onlySparse = Array.from({ length: 10 }, (_, i) => points(43.125, i * 0.25, 9)).flat();
    expect(detectStorms(onlySparse, WINDOW_MS)).toEqual([]);
  });
});
