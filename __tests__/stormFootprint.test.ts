import { describe, expect, it } from 'vitest';
import { buildStormFootprint, detectStormFootprints, footprintContact, type StormFootprintGeometry } from '../app/lib/stormFootprint';
import type { StrikePoint } from '../app/lib/stormClusters';

const NOW = 1_790_000_000_000;
const LAT = 44;
const WORLD_KM = 40_075.016686 * Math.cos(LAT * Math.PI / 180);
const lonAt = (km: number) => 10 + km / WORLD_KM * 360;
function cloud(km: number, count = 20, time = NOW): StrikePoint[] {
  return Array.from({ length: count }, (_, i) => ({ lat: LAT + (i % 3) * 0.0001, lon: lonAt(km) + (i % 5) * 0.0001, time: time - i * 10 }));
}
function square(x: number, y: number, size: number): StormFootprintGeometry {
  const nx = 190 / 360, ny = 0.5 - Math.log((1 + Math.sin(LAT * Math.PI / 180)) / (1 - Math.sin(LAT * Math.PI / 180))) / (4 * Math.PI);
  const left = nx + x / WORLD_KM, right = left + size / WORLD_KM, top = ny + y / WORLD_KM, bottom = top + size / WORLD_KM;
  return { cores: [], segments: [[left, top, right, top], [right, top, right, bottom], [right, bottom, left, bottom], [left, bottom, left, top]] };
}

function anchorOnBoundary(point: { nx: number; ny: number }, geometry: StormFootprintGeometry): boolean {
  return geometry.segments.some(([ax, ay, bx, by]) => {
    const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = Math.max(0, Math.min(1, ((point.nx - ax) * (bx - ax) + (point.ny - ay) * (by - ay)) / length2));
    return Math.hypot(point.nx - ax - t * (bx - ax), point.ny - ay - t * (by - ay)) < 1e-10;
  });
}

describe('authoritative storm footprint detection', () => {
  it('requires ten local strikes but keeps regions below storm qualification', () => {
    expect(detectStormFootprints(cloud(0, 9), NOW)).toEqual([]);
    const observed = detectStormFootprints(cloud(0, 10), NOW);
    expect(observed).toHaveLength(1);
    expect(observed[0].members).toHaveLength(10);
    expect(observed[0].activeMembers).toHaveLength(10);
    expect(observed[0].supportMembers).toHaveLength(10);
  });

  it('separates dense regions with a real gap and connects physically overlapping buffers', () => {
    expect(detectStormFootprints([...cloud(0), ...cloud(25)], NOW)).toHaveLength(2);
    expect(detectStormFootprints([...cloud(0), ...cloud(15)], NOW)).toHaveLength(1);
  });

  it('does not let sparse strike chains join independent dense regions', () => {
    const bridges = [14, 28, 42, 56].map((km, i) => ({ lat: LAT, lon: lonAt(km), time: NOW - 1000 - i }));
    const observed = detectStormFootprints([...cloud(0), ...cloud(70), ...bridges], NOW);
    expect(observed).toHaveLength(2);
    expect(observed.map(region => region.supportMembers.length)).toEqual([20, 20]);
    expect(observed.flatMap(region => region.members)).toHaveLength(42);
    expect(footprintContact(observed[0].outline, observed[1].outline)!.gapKm).toBeGreaterThan(45);
  });

  it('retains sparse border strikes for counts and replay without extending the outline', () => {
    const base = cloud(0);
    const border = { lat: LAT, lon: lonAt(23), time: NOW - 1000 };
    const original = detectStormFootprints(base, NOW)[0];
    const extended = detectStormFootprints([...base, border], NOW)[0];
    expect(extended.members).toContain(border);
    expect(extended.activeMembers).toContain(border);
    expect(extended.supportMembers).not.toContain(border);
    expect(extended.outline).toEqual(original.outline);
  });

  it('assigns each retained border strike to only one region', () => {
    const middle = { lat: LAT, lon: lonAt(20), time: NOW - 1000 };
    const observed = detectStormFootprints([...cloud(0), ...cloud(40), middle], NOW);
    expect(observed).toHaveLength(2);
    expect(observed.flatMap(region => region.members).filter(strike => strike === middle)).toHaveLength(1);
  });

  it('separates the ten-minute footprint from the five-minute active count', () => {
    const old = cloud(0, 20, NOW - 6 * 60_000);
    const recent = cloud(0, 2);
    const expired = cloud(0, 20, NOW - 11 * 60_000);
    const observed = detectStormFootprints([...old, ...recent, ...expired], NOW)[0];
    expect(observed.members).toHaveLength(22);
    expect(observed.activeMembers).toEqual([...recent].reverse());
    expect(observed.supportMembers).toHaveLength(22);
    expect(detectStormFootprints(expired, NOW)).toEqual([]);
  });

  it('is deterministic under input reordering and does not count duplicate input twice', () => {
    const points = [...cloud(0), ...cloud(25), { lat: LAT, lon: lonAt(48), time: NOW - 1000 }];
    const expected = detectStormFootprints(points, NOW);
    expect(detectStormFootprints([...points].reverse(), NOW)).toEqual(expected);
    expect(detectStormFootprints([...points, ...points], NOW)).toEqual(expected);
    expect(detectStormFootprints(Array(20).fill(points[0]), NOW)).toEqual([]);
  });

  it('handles connected activity across the date line', () => {
    const points = [...cloud(0, 10).map(point => ({ ...point, lon: 179.95 })),
      ...cloud(0, 10, NOW - 1000).map(point => ({ ...point, lon: -179.95 }))];
    const observed = detectStormFootprints(points, NOW);
    expect(observed).toHaveLength(1);
    expect(observed[0].members).toHaveLength(20);
    const xs = observed[0].outline.segments.flatMap(([ax, , bx]) => [ax, bx]);
    expect((Math.max(...xs) - Math.min(...xs)) * WORLD_KM).toBeLessThan(30);
  });

  it('ignores unusable and future records', () => {
    expect(detectStormFootprints([...cloud(0, 9), { lat: NaN, lon: 10, time: NOW },
      { lat: LAT, lon: 10, time: NOW + 1 }, { lat: LAT, lon: 181, time: NOW }], NOW)).toEqual([]);
  });
});

describe('physical footprint contact', () => {
  it('returns nearest actual boundary anchors for separated regions', () => {
    const a = square(0, 0, 10), b = square(15, 0, 10);
    const contact = footprintContact(a, b)!;
    expect(contact.gapKm).toBeCloseTo(5, 1);
    expect(anchorOnBoundary(contact.from, a)).toBe(true);
    expect(anchorOnBoundary(contact.to, b)).toBe(true);
  });

  it('recognizes tangency, crossing outlines, and containment', () => {
    expect(footprintContact(square(0, 0, 10), square(10, 0, 10))!.gapKm).toBe(0);
    expect(footprintContact(square(0, 0, 10), square(5, 5, 10))!.gapKm).toBe(0);
    const outer = square(0, 0, 50), inner = square(10, 10, 5);
    const containment = footprintContact(outer, inner)!;
    expect(containment.gapKm).toBe(0);
    expect(anchorOnBoundary(containment.from, outer)).toBe(true);
    expect(anchorOnBoundary(containment.to, inner)).toBe(true);
  });

  it('handles containment in a secondary disconnected component and leaves holes empty', () => {
    const a = { cores: [], segments: [...square(0, 0, 10).segments, ...square(50, 0, 20).segments] };
    expect(footprintContact(a, square(55, 5, 5))!.gapKm).toBe(0);
    const ring = { cores: [], segments: [...square(0, 0, 50).segments, ...square(10, 10, 30).segments] };
    expect(footprintContact(ring, square(20, 20, 5))!.gapKm).toBeGreaterThan(9);
  });

  it('compares normalized contours across longitude wrapping', () => {
    const a = square(0, 0, 10), original = square(15, 0, 10);
    const b: StormFootprintGeometry = { cores: [], segments: original.segments.map(([ax, ay, bx, by]) => [ax - 1, ay, bx - 1, by]) };
    expect(footprintContact(a, b)!.gapKm).toBeCloseTo(5, 1);
    expect(footprintContact(a, { cores: [], segments: [] })).toBeNull();
  });

  it('uses identical geometry for a union of owner support points at every zoom', () => {
    const points = [...cloud(0), ...cloud(40)];
    const geometry = buildStormFootprint(points, { lat: LAT, lon: 10 });
    expect(geometry.cores).toHaveLength(2);
    expect(geometry.cores.map(core => core.count)).toEqual([20, 20]);
    expect(buildStormFootprint([...points].reverse(), { lat: LAT, lon: 10 })).toEqual(geometry);
    for (const zoom of [3, 6, 8, 12, 18]) {
      const scale = 256 * 2 ** zoom;
      for (const segment of geometry.segments) {
        segment.forEach(value => expect((value * scale + 543) / scale - 543 / scale).toBeCloseTo(value, 12));
      }
    }
  });

  it('preserves one-kilometre resolution for a sparse footprint with a huge bounding box', () => {
    const points = [...cloud(0), ...cloud(1000).map(point => ({ ...point, lat: point.lat + 10 }))];
    const geometry = buildStormFootprint(points, { lat: LAT, lon: 10 });
    expect(geometry.cores).toHaveLength(2);
    for (const [ax, ay, bx, by] of geometry.segments) {
      expect(Math.hypot(bx - ax, by - ay) * WORLD_KM).toBeLessThanOrEqual(1.000001);
    }
  });

  it('does not depend on contour segment order when measuring a gap', () => {
    const a = square(0, 0, 10), b = square(15, 0, 10);
    const original = footprintContact(a, b)!.gapKm;
    const reordered = footprintContact({ ...a, segments: [...a.segments].reverse() }, { ...b, segments: [...b.segments].reverse() })!;
    expect(reordered.gapKm).toBeCloseTo(original, 10);
    expect(footprintContact(b, a)!.gapKm).toBeCloseTo(original, 10);
  });
});
