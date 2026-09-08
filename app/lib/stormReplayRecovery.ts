import type { StormStrike } from './db';

// A replay's saved strikes anchor the same five-minute activity window used
// by storm detection. Recovery may fill its sparse edges, never grow a chain
// from recovered points into a different storm.
export const REPLAY_EDGE_RADIUS_KM = 25;
export const REPLAY_EDGE_TIME_MS = 150_000;
const CELL_DEG = 0.25;
const LON_CELLS = 360 / CELL_DEG;
const EARTH_KM = 6371;
const RAD = Math.PI / 180;

function key([lat, lon, time]: StormStrike): string {
  return `${Math.round(lat * 1000)},${Math.round(lon * 1000)},${time}`;
}

function lonCell(lon: number): number {
  return ((Math.floor((lon + 180) / CELL_DEG) % LON_CELLS) + LON_CELLS) % LON_CELLS;
}

function distanceKm(a: StormStrike, b: StormStrike): number {
  const lat = (a[0] - b[0]) * RAD;
  const lon = (a[1] - b[1]) * RAD;
  const h = Math.sin(lat / 2) ** 2
    + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(lon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function recoverReplayEdges(
  original: StormStrike[],
  candidates: Iterable<StormStrike>,
): { strikes: StormStrike[]; recoveredCount: number } {
  if (original.length === 0) return { strikes: [], recoveredCount: 0 };

  const anchors = new Map<string, StormStrike[]>();
  const seen = new Set<string>();
  const strikes: StormStrike[] = [];
  let minTime = Infinity, maxTime = -Infinity;
  for (const point of original) {
    const id = key(point);
    if (seen.has(id)) continue;
    seen.add(id);
    strikes.push(point);
    minTime = Math.min(minTime, point[2]);
    maxTime = Math.max(maxTime, point[2]);
    const bucket = `${Math.floor(point[2] / REPLAY_EDGE_TIME_MS)}:${Math.floor(point[0] / CELL_DEG)}:${lonCell(point[1])}`;
    const points = anchors.get(bucket);
    if (points) points.push(point);
    else anchors.set(bucket, [point]);
  }

  const latReach = REPLAY_EDGE_RADIUS_KM / EARTH_KM / RAD;
  let recoveredCount = 0;
  for (const point of candidates) {
    const [lat, lon, time] = point;
    if (!point.every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (time < minTime || time > maxTime || seen.has(key(point))) continue;

    const timeCell = Math.floor(time / REPLAY_EDGE_TIME_MS);
    const minLatCell = Math.floor((lat - latReach) / CELL_DEG);
    const maxLatCell = Math.floor((lat + latReach) / CELL_DEG);
    const lonReach = Math.abs(lat) + latReach >= 90
      ? 180
      : Math.asin(Math.min(1, Math.sin(latReach * RAD) / Math.cos(lat * RAD))) / RAD;
    const lonCells = Math.min(LON_CELLS, 2 * Math.ceil(lonReach / CELL_DEG) + 1);
    const firstLonCell = lonCell(lon) - Math.floor(lonCells / 2);

    let matched = false;
    search: for (let t = timeCell - 1; t <= timeCell + 1; t++) {
      for (let y = minLatCell; y <= maxLatCell; y++) {
        for (let x = firstLonCell; x < firstLonCell + lonCells; x++) {
          const wrappedX = ((x % LON_CELLS) + LON_CELLS) % LON_CELLS;
          for (const anchor of anchors.get(`${t}:${y}:${wrappedX}`) ?? []) {
            if (Math.abs(anchor[2] - time) <= REPLAY_EDGE_TIME_MS
              && distanceKm(anchor, point) <= REPLAY_EDGE_RADIUS_KM) {
              matched = true;
              break search;
            }
          }
        }
      }
    }
    if (!matched) continue;

    const recovered: StormStrike = [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000, time];
    seen.add(key(recovered));
    strikes.push(recovered);
    recoveredCount++;
  }

  strikes.sort((a, b) => a[2] - b[2]);
  return { strikes, recoveredCount };
}
