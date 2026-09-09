import type { StrikePoint } from './stormClusters';
import { densityCore } from './stormOutline';
import { replayStrikeKey } from './stormReplayState';

export interface StormFootprintGeometry {
  segments: Array<[number, number, number, number]>;
  cores: Array<{ nx: number; ny: number; count: number }>;
}

export interface StormFootprintObservation {
  lat: number;
  lon: number;
  members: StrikePoint[];
  activeMembers: StrikePoint[];
  /** Original dense support, excluding retained sparse border strikes. */
  supportMembers: StrikePoint[];
  outline: StormFootprintGeometry;
}

const FOOTPRINT_MS = 10 * 60_000;
const ACTIVE_MS = 5 * 60_000;
const SUPPORT_KM = 10;
const MIN_SUPPORT = 10;
const BUFFER_KM = 10;
const BORDER_KM = 25;
const RES_KM = 1;
const EARTH_KM = 6371.0088;
const WORLD_KM = 40_075.016686;
const MAX_LAT = 85.05112878;
const GRID_STRIDE = 262_144;
const GRID_OFFSET = 131_072;

type NormalizedPoint = { nx: number; ny: number };
type Point3D = { x: number; y: number; z: number; strike: StrikePoint };
type Region = { supportMembers: StrikePoint[]; outline: StormFootprintGeometry };

function mercatorY(lat: number): number {
  const sin = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

function inverseLatitude(ny: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180 / Math.PI;
}

function centroid(points: StrikePoint[]): { lat: number; lon: number } {
  let lat = 0, sinLon = 0, cosLon = 0;
  for (const point of points) {
    lat += point.lat;
    sinLon += Math.sin(point.lon * Math.PI / 180);
    cosLon += Math.cos(point.lon * Math.PI / 180);
  }
  return { lat: lat / points.length, lon: Math.atan2(sinLon, cosLon) * 180 / Math.PI };
}

function point3D(strike: StrikePoint): Point3D {
  const lat = strike.lat * Math.PI / 180, lon = strike.lon * Math.PI / 180;
  const cos = Math.cos(lat);
  return { x: EARTH_KM * cos * Math.cos(lon), y: EARTH_KM * cos * Math.sin(lon), z: EARTH_KM * Math.sin(lat), strike };
}

function squaredDistance(a: Point3D, b: Point3D): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function chordSquared(km: number): number {
  return (2 * EARTH_KM * Math.sin(km / (2 * EARTH_KM))) ** 2;
}

function makeIndex(points: Point3D[]): Map<string, Point3D[]> {
  const index = new Map<string, Point3D[]>();
  for (const point of points) {
    const key = `${Math.floor(point.x / SUPPORT_KM)},${Math.floor(point.y / SUPPORT_KM)},${Math.floor(point.z / SUPPORT_KM)}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(point);
    else index.set(key, [point]);
  }
  return index;
}

function nearbyBuckets(index: Map<string, Point3D[]>, point: Point3D, radius: number): Point3D[][] {
  const x = Math.floor(point.x / SUPPORT_KM), y = Math.floor(point.y / SUPPORT_KM), z = Math.floor(point.z / SUPPORT_KM);
  const reach = Math.ceil(radius / SUPPORT_KM);
  const buckets: Point3D[][] = [];
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const bucket = index.get(`${x + dx},${y + dy},${z + dz}`);
        if (bucket) buckets.push(bucket);
      }
    }
  }
  return buckets;
}

function gridKey(x: number, y: number): number {
  return (y + GRID_OFFSET) * GRID_STRIDE + x + GRID_OFFSET;
}

function gridPosition(key: number): { x: number; y: number } {
  const row = Math.floor(key / GRID_STRIDE);
  return { x: key - row * GRID_STRIDE - GRID_OFFSET, y: row - GRID_OFFSET };
}

interface RasterCells extends Iterable<[number, number]> {
  occupy(x: number, y: number): void;
  get(key: number): number | undefined;
  set(key: number, value: number): unknown;
  keys(): IterableIterator<number>;
}

function rasterCells(points: Array<{ x: number; y: number }>): RasterCells {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, Math.ceil((point.x - BUFFER_KM) / RES_KM));
    maxX = Math.max(maxX, Math.floor((point.x + BUFFER_KM) / RES_KM));
    minY = Math.min(minY, Math.ceil((point.y - BUFFER_KM) / RES_KM));
    maxY = Math.max(maxY, Math.floor((point.y + BUFFER_KM) / RES_KM));
  }
  const cols = maxX - minX + 1, rows = maxY - minY + 1;
  if (cols * rows > 250_000) {
    const sparse = new Map<number, number>();
    return Object.assign(sparse, { occupy: (x: number, y: number) => { sparse.set(gridKey(x, y), 0); } });
  }
  // Most storm regions fit in a small local grid. Bound this allocation to 1MB
  // and fall back to occupied cells for geographically broad, sparse systems.
  const data = new Uint32Array(cols * rows);
  const indexOf = (key: number): number => {
    const { x, y } = gridPosition(key);
    return x < minX || x > maxX || y < minY || y > maxY ? -1 : (y - minY) * cols + x - minX;
  };
  return {
    occupy(x, y) { data[(y - minY) * cols + x - minX] = 1; },
    get(key) { const index = indexOf(key); return index < 0 || data[index] === 0 ? undefined : data[index] - 1; },
    set(key, value) { const index = indexOf(key); if (index >= 0) data[index] = value + 1; },
    *keys() {
      for (let i = 0; i < data.length; i++) if (data[i]) yield gridKey(minX + i % cols, minY + Math.floor(i / cols));
    },
    *[Symbol.iterator]() {
      for (let i = 0; i < data.length; i++) {
        if (data[i]) yield [gridKey(minX + i % cols, minY + Math.floor(i / cols)), data[i] - 1];
      }
    },
  };
}

/** A sparse geographic raster allocates occupied cells rather than a world-sized bounding box. */
function rasterRegions(points: StrikePoint[], reference: { lat: number; lon: number }): Region[] {
  if (points.length === 0) return [];
  const worldKm = WORLD_KM * Math.cos(Math.max(-MAX_LAT, Math.min(MAX_LAT, reference.lat)) * Math.PI / 180);
  const referenceX = (reference.lon + 180) / 360;
  const projected = points.map(strike => {
    const delta = ((strike.lon - reference.lon + 540) % 360) - 180;
    return { x: (referenceX + delta / 360) * worldKm, y: mercatorY(strike.lat) * worldKm, strike };
  });
  const cells = rasterCells(projected);
  const drawnPositions = new Set<string>();
  for (const point of projected) {
    const position = `${point.x},${point.y}`;
    if (drawnPositions.has(position)) continue;
    drawnPositions.add(position);
    const minX = Math.ceil((point.x - BUFFER_KM) / RES_KM), maxX = Math.floor((point.x + BUFFER_KM) / RES_KM);
    const minY = Math.ceil((point.y - BUFFER_KM) / RES_KM), maxY = Math.floor((point.y + BUFFER_KM) / RES_KM);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if ((x * RES_KM - point.x) ** 2 + (y * RES_KM - point.y) ** 2 <= BUFFER_KM ** 2) cells.occupy(x, y);
      }
    }
  }

  let label = 0;
  for (const [start, assigned] of cells) {
    if (assigned) continue;
    label++;
    const queue = [start];
    cells.set(start, label);
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      for (const next of [current - 1, current + 1, current - GRID_STRIDE, current + GRID_STRIDE]) {
        if (cells.get(next) !== 0) continue;
        cells.set(next, label);
        queue.push(next);
      }
    }
  }
  const regions = Array.from({ length: label }, () => ({ points: [] as typeof projected, segments: [] as StormFootprintGeometry['segments'] }));
  for (const point of projected) {
    const owner = cells.get(gridKey(Math.round(point.x / RES_KM), Math.round(point.y / RES_KM)));
    if (owner) regions[owner - 1].points.push(point);
  }

  // Visit each raster square through its lowest-index occupied corner. This
  // avoids allocating a second grid and keeps diagonal contacts separate.
  for (const key of cells.keys()) {
    const { x: nodeX, y: nodeY } = gridPosition(key);
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      const col = nodeX + dx, row = nodeY + dy;
      const blKey = gridKey(col, row), brKey = blKey + 1, tlKey = blKey + GRID_STRIDE, trKey = tlKey + 1;
      const bl = cells.get(blKey) ?? 0, br = cells.get(brKey) ?? 0, tl = cells.get(tlKey) ?? 0, tr = cells.get(trKey) ?? 0;
      const first = bl ? blKey : br ? brKey : tl ? tlKey : trKey;
      if (first !== key) continue;
      const idx = (Number(!!tl) << 3) | (Number(!!tr) << 2) | (Number(!!br) << 1) | Number(!!bl);
      if (idx === 15) continue;
      const x = col * RES_KM / worldKm, y = row * RES_KM / worldKm, h = RES_KM / (2 * worldKm);
      const L: NormalizedPoint = { nx: x, ny: y + h }, R: NormalizedPoint = { nx: x + 2 * h, ny: y + h };
      const B: NormalizedPoint = { nx: x + h, ny: y }, T: NormalizedPoint = { nx: x + h, ny: y + 2 * h };
      const push = (owner: number, a: NormalizedPoint, b: NormalizedPoint) => regions[owner - 1].segments.push([a.nx, a.ny, b.nx, b.ny]);
      const owner = bl || br || tl || tr;
      switch (idx) {
        case 1: case 14: push(owner, L, B); break;
        case 2: case 13: push(owner, B, R); break;
        case 3: case 12: push(owner, L, R); break;
        case 4: case 11: push(owner, T, R); break;
        case 5: push(bl, L, B); push(tr, T, R); break;
        case 6: case 9: push(owner, B, T); break;
        case 7: case 8: push(owner, L, T); break;
        case 10: push(tl, L, T); push(br, B, R); break;
      }
    }
  }
  return regions.filter(region => region.points.length > 0).map(region => {
    const core = densityCore(region.points, BUFFER_KM);
    return {
      supportMembers: region.points.map(point => point.strike),
      outline: { segments: region.segments, cores: [{ nx: core.x / worldKm, ny: core.y / worldKm, count: region.points.length }] },
    };
  });
}

/** The supplied points are dense support; sparse replay borders must not be passed here. */
export function buildStormFootprint(points: StrikePoint[], reference: { lat: number; lon: number }): StormFootprintGeometry {
  if (!Number.isFinite(reference.lat) || Math.abs(reference.lat) > 90
    || !Number.isFinite(reference.lon) || Math.abs(reference.lon) > 180) return { segments: [], cores: [] };
  const valid = points.filter(point => Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180)
    .sort((a, b) => a.lat - b.lat || a.lon - b.lon || a.time - b.time);
  const regions = rasterRegions(valid, reference);
  return {
    segments: regions.flatMap(region => region.outline.segments),
    cores: regions.flatMap(region => region.outline.cores).sort((a, b) => b.count - a.count || a.nx - b.nx || a.ny - b.ny),
  };
}

export function detectStormFootprints(strikes: StrikePoint[], nowMs: number): StormFootprintObservation[] {
  const unique = new Map<string, StrikePoint>();
  for (const strike of strikes) {
    if (!Number.isFinite(strike.lat) || Math.abs(strike.lat) > 90 || !Number.isFinite(strike.lon) || Math.abs(strike.lon) > 180
      || !Number.isFinite(strike.time) || strike.time <= nowMs - FOOTPRINT_MS || strike.time > nowMs) continue;
    const key = replayStrikeKey([strike.lat, strike.lon, strike.time]);
    const previous = unique.get(key);
    if (!previous || strike.lat < previous.lat || (strike.lat === previous.lat && strike.lon < previous.lon)) unique.set(key, strike);
  }
  const points = [...unique.values()].sort((a, b) => a.lat - b.lat || a.lon - b.lon || a.time - b.time).map(point3D);
  const index = makeIndex(points);
  const supportLimit = chordSquared(SUPPORT_KM);
  const supported = points.filter(point => {
    let count = 0;
    for (const bucket of nearbyBuckets(index, point, SUPPORT_KM)) {
      for (const neighbor of bucket) {
        if (squaredDistance(point, neighbor) <= supportLimit && ++count >= MIN_SUPPORT) return true;
      }
    }
    return false;
  });
  if (supported.length === 0) return [];

  // Build broad local groups first. Exact connectivity is decided by the shared
  // one-kilometre raster, not these conservative spatial buckets.
  const supportIndex = makeIndex(supported);
  const buckets = [...supportIndex.values()];
  const bucketIds = new Map(buckets.map((bucket, i) => [bucket, i]));
  const parent = buckets.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const broadLimit = chordSquared(25);
  for (let i = 0; i < buckets.length; i++) {
    for (const other of nearbyBuckets(supportIndex, buckets[i][0], 25)) {
      const j = bucketIds.get(other)!;
      if (j <= i || root(i) === root(j)) continue;
      let touching = false;
      outer: for (const a of buckets[i]) {
        for (const b of other) {
          if (squaredDistance(a, b) <= broadLimit) { touching = true; break outer; }
        }
      }
      if (touching) parent[root(j)] = root(i);
    }
  }
  const groups = new Map<number, StrikePoint[]>();
  for (let i = 0; i < buckets.length; i++) {
    const key = root(i);
    const members = buckets[i].map(point => point.strike);
    const group = groups.get(key);
    if (group) group.push(...members);
    else groups.set(key, members);
  }
  const regions = [...groups.values()].flatMap(group => rasterRegions(group, centroid(group)));
  const ownership = new Map<StrikePoint, number>();
  const observations: StormFootprintObservation[] = regions.map((region, i) => {
    for (const strike of region.supportMembers) ownership.set(strike, i);
    return { ...centroid(region.supportMembers), supportMembers: region.supportMembers,
      members: [...region.supportMembers], activeMembers: [], outline: region.outline };
  });
  const borderLimit = chordSquared(BORDER_KM);
  for (const point of points) {
    if (ownership.has(point.strike)) continue;
    let nearest = borderLimit, owner: number | undefined;
    for (const bucket of nearbyBuckets(supportIndex, point, BORDER_KM)) {
      for (const anchor of bucket) {
        const distance = squaredDistance(point, anchor);
        const region = ownership.get(anchor.strike)!;
        if (distance < nearest || (distance === nearest && (owner == null || region < owner))) {
          nearest = distance;
          owner = region;
        }
      }
    }
    if (owner != null) observations[owner].members.push(point.strike);
  }
  for (const observation of observations) {
    observation.members.sort((a, b) => a.time - b.time || a.lat - b.lat || a.lon - b.lon);
    observation.activeMembers = observation.members.filter(strike => strike.time > nowMs - ACTIVE_MS);
    Object.assign(observation, centroid(observation.activeMembers.length ? observation.activeMembers : observation.members));
  }
  return observations.sort((a, b) => b.activeMembers.length - a.activeMembers.length || a.lat - b.lat || a.lon - b.lon);
}

export function footprintContact(a: StormFootprintGeometry, b: StormFootprintGeometry): {
  gapKm: number; from: NormalizedPoint; to: NormalizedPoint;
} | null {
  if (!a.segments.length || !b.segments.length) return null;
  const normalizedBounds = (segments: StormFootprintGeometry['segments']) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [ax, ay, bx, by] of segments) {
      minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx);
      minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
    }
    return { minX, maxX, minY, maxY };
  };
  const aNormalized = normalizedBounds(a.segments), bNormalized = normalizedBounds(b.segments);
  const shift = Math.round((aNormalized.minX + aNormalized.maxX - bNormalized.minX - bNormalized.maxX) / 2);
  const latitude = inverseLatitude((Math.min(aNormalized.minY, bNormalized.minY) + Math.max(aNormalized.maxY, bNormalized.maxY)) / 2);
  const worldKm = WORLD_KM * Math.cos(latitude * Math.PI / 180);
  type XY = { x: number; y: number };
  type Segment = { a: XY; b: XY; minX: number; maxX: number; minY: number; maxY: number };
  const project = (segments: StormFootprintGeometry['segments'], dx: number): Segment[] => segments.map(([ax, ay, bx, by]) => {
    const a = { x: (ax + dx) * worldKm, y: ay * worldKm }, b = { x: (bx + dx) * worldKm, y: by * worldKm };
    return { a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
  });
  const as = project(a.segments, 0), bs = project(b.segments, shift).sort((a, b) => a.minX - b.minX);
  const distance2 = (a: XY, b: XY) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const closest = (point: XY, segment: Segment): XY => {
    const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / length)) : 0;
    return { x: segment.a.x + t * dx, y: segment.a.y + t * dy };
  };
  let from = as[0].a, to = bs[0].a, best = distance2(from, to);
  for (const left of as) {
    for (const right of bs) {
      const reach = Math.sqrt(best);
      if (right.minX > left.maxX + reach) break;
      const dx = Math.max(0, right.minX - left.maxX, left.minX - right.maxX);
      const dy = Math.max(0, right.minY - left.maxY, left.minY - right.maxY);
      if (dx * dx + dy * dy > best) continue;
      const rx = left.b.x - left.a.x, ry = left.b.y - left.a.y;
      const sx = right.b.x - right.a.x, sy = right.b.y - right.a.y;
      const cross = rx * sy - ry * sx;
      if (Math.abs(cross) > 1e-12) {
        const qx = right.a.x - left.a.x, qy = right.a.y - left.a.y;
        const t = (qx * sy - qy * sx) / cross, u = (qx * ry - qy * rx) / cross;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          const hit = { nx: (left.a.x + t * rx) / worldKm, ny: (left.a.y + t * ry) / worldKm };
          return { gapKm: 0, from: hit, to: hit };
        }
      }
      const pairs: Array<[XY, XY]> = [
        [left.a, closest(left.a, right)], [left.b, closest(left.b, right)],
        [closest(right.a, left), right.a], [closest(right.b, left), right.b],
      ];
      for (const [pa, pb] of pairs) {
        const distance = distance2(pa, pb);
        if (distance < best) { best = distance; from = pa; to = pb; }
        if (best < 1e-14) return { gapKm: 0,
          from: { nx: from.x / worldKm, ny: from.y / worldKm }, to: { nx: to.x / worldKm, ny: to.y / worldKm } };
      }
    }
  }
  const bounds = (segments: Segment[]) => segments.reduce((box, segment) => ({
    minX: Math.min(box.minX, segment.minX), maxX: Math.max(box.maxX, segment.maxX),
    minY: Math.min(box.minY, segment.minY), maxY: Math.max(box.maxY, segment.maxY),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const aBounds = bounds(as), bBounds = bounds(bs);
  const contains = (point: XY, segments: Segment[], box: typeof aBounds): boolean => {
    if (point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY) return false;
    let inside = false;
    for (const segment of segments) {
      const a = segment.a, b = segment.b;
      if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const boundsOverlap = aBounds.minX <= bBounds.maxX && aBounds.maxX >= bBounds.minX
    && aBounds.minY <= bBounds.maxY && aBounds.maxY >= bBounds.minY;
  const overlaps = best < 1e-14 || (boundsOverlap
    && (as.some(segment => contains(segment.a, bs, bBounds)) || bs.some(segment => contains(segment.a, as, aBounds))));
  return { gapKm: overlaps ? 0 : Math.sqrt(best),
    from: { nx: from.x / worldKm, ny: from.y / worldKm }, to: { nx: to.x / worldKm, ny: to.y / worldKm } };
}
