// Storm-cell detection (isomorphic — used by the widget client-side and the
// record tracker server-side): groups a country's recent strikes into spatial
// clusters and derives per-storm stats (rate, trend, drift direction).

export interface StrikePoint { lat: number; lon: number; time: number; cc?: string | null | undefined }

export interface StormCell {
  lat: number;
  lon: number;
  count: number;
  rate: number; // strikes per minute
  /** distance from centroid to the farthest strike in the cluster */
  radiusKm: number;
  trend: 'up' | 'down' | 'steady';
  /** 8-point compass direction the storm is drifting toward, or null if stationary */
  drift: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | null;
  /** the strikes that make up this storm */
  members: StrikePoint[];
}

export type CityTuple = [name: string, lat: number, lon: number];

// ~0.25° ≈ 25 km cells; adjacent active cells merge into one storm
const CELL_DEG = 0.25;
// A cluster only counts as a storm at 15+ strikes per minute
const MIN_RATE_PER_MIN = 15;
const MAX_STORMS = 8;
// Clusters with centroids closer than this are the same storm
const MERGE_KM = 75;
// Centroid must move ~3 km between window halves to count as drifting
const DRIFT_MIN_DEG = 0.03;

const NEIGHBORS = [-1, 0, 1];

export function detectStorms(strikes: StrikePoint[], windowMs: number): StormCell[] {
  const cells = new Map<string, StrikePoint[]>();
  for (const s of strikes) {
    const key = `${Math.floor(s.lat / CELL_DEG)}:${Math.floor(s.lon / CELL_DEG)}`;
    const arr = cells.get(key);
    if (arr) arr.push(s);
    else cells.set(key, [s]);
  }

  // BFS-merge adjacent occupied cells into clusters
  const visited = new Set<string>();
  const clusters: StrikePoint[][] = [];
  for (const start of cells.keys()) {
    if (visited.has(start)) continue;
    visited.add(start);
    const cluster: StrikePoint[] = [];
    const queue = [start];
    while (queue.length) {
      const key = queue.pop()!;
      cluster.push(...cells.get(key)!);
      const [ci, cj] = key.split(':').map(Number);
      for (const di of NEIGHBORS) for (const dj of NEIGHBORS) {
        if (di === 0 && dj === 0) continue;
        const nk = `${ci + di}:${cj + dj}`;
        if (cells.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    clusters.push(cluster);
  }

  // Agglomerative merge: storms less than MERGE_KM apart are one storm
  const groups = clusters.map(strikes => {
    let lat = 0, lon = 0;
    for (const s of strikes) { lat += s.lat; lon += s.lon; }
    return { strikes, lat: lat / strikes.length, lon: lon / strikes.length };
  });
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j];
        const dLat = (a.lat - b.lat) * 111.32;
        const dLon = (a.lon - b.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
        if (Math.hypot(dLat, dLon) < MERGE_KM) {
          const all = a.strikes.concat(b.strikes);
          let lat = 0, lon = 0;
          for (const s of all) { lat += s.lat; lon += s.lon; }
          groups[i] = { strikes: all, lat: lat / all.length, lon: lon / all.length };
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  const halfCutoff = Date.now() - windowMs / 2;
  const minStrikes = MIN_RATE_PER_MIN * (windowMs / 60_000);
  return groups
    .map(g => g.strikes)
    .filter(c => c.length >= minStrikes)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_STORMS)
    .map(cluster => {
      let latSum = 0, lonSum = 0;
      let oldN = 0, oldLat = 0, oldLon = 0;
      let newN = 0, newLat = 0, newLon = 0;
      for (const s of cluster) {
        latSum += s.lat;
        lonSum += s.lon;
        if (s.time < halfCutoff) { oldN++; oldLat += s.lat; oldLon += s.lon; }
        else { newN++; newLat += s.lat; newLon += s.lon; }
      }
      const n = cluster.length;
      const cLat = latSum / n;
      const cLon = lonSum / n;

      const cosLat = Math.cos(cLat * Math.PI / 180);
      let maxD2 = 0;
      for (const s of cluster) {
        const dLat = (s.lat - cLat) * 111.32;
        const dLon = (s.lon - cLon) * 111.32 * cosLat;
        const d2 = dLat * dLat + dLon * dLon;
        if (d2 > maxD2) maxD2 = d2;
      }

      let trend: StormCell['trend'] = 'steady';
      if (newN >= oldN * 1.3 && newN - oldN >= 3) trend = 'up';
      else if (oldN >= newN * 1.3 && oldN - newN >= 3) trend = 'down';

      let drift: StormCell['drift'] = null;
      if (oldN >= 2 && newN >= 2) {
        const dLat = newLat / newN - oldLat / oldN;
        const dLon = (newLon / newN - oldLon / oldN) * cosLat;
        if (Math.hypot(dLat, dLon) >= DRIFT_MIN_DEG) {
          const deg = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
          drift = COMPASS[Math.round(deg / 45) % 8];
        }
      }

      return {
        lat: cLat,
        lon: cLon,
        count: n,
        rate: n / (windowMs / 60_000),
        radiusKm: Math.max(10, Math.sqrt(maxD2)),
        trend,
        drift,
        members: cluster,
      };
    });
}

export type Compass = NonNullable<StormCell['drift']>;

const COMPASS: Compass[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 8-point compass direction from (fromLat, fromLon) toward (toLat, toLon) */
export function compassDir(fromLat: number, fromLon: number, toLat: number, toLon: number): Compass {
  const dLat = toLat - fromLat;
  const dLon = (toLon - fromLon) * Math.cos(((fromLat + toLat) / 2) * Math.PI / 180);
  const deg = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

export function nearestCity(
  cities: CityTuple[],
  lat: number,
  lon: number,
): { name: string; km: number; dir: Compass } | null {
  let best: CityTuple | null = null;
  let bestD = Infinity;
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (const c of cities) {
    const dLat = c[1] - lat;
    const dLon = (c[2] - lon) * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return null;
  return {
    name: best[0],
    km: Math.round(Math.sqrt(bestD) * 111.32),
    dir: compassDir(best[1], best[2], lat, lon),
  };
}
