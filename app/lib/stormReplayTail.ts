import type { StormStrike } from './db';
import type { StrikePoint } from './stormClusters';

// Once lightning has been absent for ten minutes, a later nearby discharge
// must not restart a fading replay. Official storm detection is independent.
export const REPLAY_TAIL_GAP_MS = 10 * 60_000;
const RADIUS_KM = 25;
const CELL_DEG = 0.25;
const LON_CELLS = 360 / CELL_DEG;

export interface ReplayTailStorm {
  key: string;
  allStrikes: StormStrike[];
  lastStrikeTime: number;
  replayAnchors?: StormStrike[];
  lastReplayTime?: number;
  replayDirty?: boolean;
}

function key(p: StormStrike): string {
  return `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${p[2]}`;
}

function lonCell(lon: number): number {
  return ((Math.floor((lon + 180) / CELL_DEG) % LON_CELLS) + LON_CELLS) % LON_CELLS;
}

/** Keep an unthinned recent footprint, including when replay samples thin. */
export function rememberReplayAnchors(st: ReplayTailStorm, points: StormStrike[], now: number): void {
  const recent = new Map<string, StormStrike>();
  for (const p of [...(st.replayAnchors ?? st.allStrikes), ...points]) {
    if (p[2] <= now && p[2] > now - REPLAY_TAIL_GAP_MS) recent.set(key(p), p);
    st.lastReplayTime = Math.max(st.lastReplayTime ?? st.lastStrikeTime, p[2]);
  }
  st.replayAnchors = [...recent.values()];
}

/**
 * Attach residual lightning to existing identities only. Freeze the footprint
 * for each pass: a chain of background strikes cannot grow a storm in one pass.
 * All qualified cells reserve their members, even cells outside the UI's top20.
 * `active` owners compete for proximity but only fading owners collect tails.
 * Neither the official counter watermark nor any storm metric is changed.
 */
export function collectReplayTails<T extends ReplayTailStorm>(
  storms: T[], candidates: StrikePoint[], reserved: Set<StrikePoint>, active: Set<T>,
  now: number, maxSamples = 24_000,
): Set<T> {
  const index = new Map<string, Array<{ point: StormStrike; storm: T }>>();
  const seen = new Set<string>();
  for (const st of storms) {
    rememberReplayAnchors(st, [], now);
    for (const point of st.replayAnchors!) {
      seen.add(key(point));
      const bucket = `${Math.floor(point[0] / CELL_DEG)}:${lonCell(point[1])}`;
      const entries = index.get(bucket) ?? [];
      entries.push({ point, storm: st });
      index.set(bucket, entries);
    }
  }
  const additions = new Map<T, StormStrike[]>();
  for (const s of candidates) {
    if (reserved.has(s) || s.time > now || s.time <= now - REPLAY_TAIL_GAP_MS) continue;
    if (![s.lat, s.lon, s.time].every(Number.isFinite) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) continue;
    const point: StormStrike = [s.lat, s.lon, s.time];
    if (seen.has(key(point))) continue;
    let owner: T | undefined;
    let nearestKm = RADIUS_KM;
    const latReach = RADIUS_KM / 111.32;
    const lonReach = latReach / Math.max(0.000001, Math.cos(Math.min(90, Math.abs(s.lat) + latReach) * Math.PI / 180));
    const columns = Math.min(LON_CELLS, 2 * Math.ceil(lonReach / CELL_DEG) + 1);
    const firstCol = lonCell(s.lon) - Math.floor(columns / 2);
    for (let y = Math.floor((s.lat - latReach) / CELL_DEG); y <= Math.floor((s.lat + latReach) / CELL_DEG); y++) {
      for (let x = firstCol; x < firstCol + columns; x++) {
        for (const { point: anchor, storm } of index.get(`${y}:${(x + LON_CELLS) % LON_CELLS}`) ?? []) {
          if (s.time <= anchor[2] || s.time - anchor[2] > REPLAY_TAIL_GAP_MS) continue;
          const dLat = (s.lat - anchor[0]) * 111.32;
          const dLon = ((s.lon - anchor[1] + 540) % 360 - 180) * 111.32 * Math.cos((s.lat + anchor[0]) / 2 * Math.PI / 180);
          const km = Math.hypot(dLat, dLon);
          if (km < nearestKm || (km === nearestKm && (!owner || storm.key < owner.key))) {
            nearestKm = km;
            owner = storm;
          }
        }
      }
    }
    if (!owner || active.has(owner)) continue;
    const rounded: StormStrike = [Math.round(s.lat * 1000) / 1000, Math.round(s.lon * 1000) / 1000, s.time];
    const batch = additions.get(owner) ?? [];
    batch.push(rounded);
    additions.set(owner, batch);
    seen.add(key(point));
  }
  for (const [st, batch] of additions) {
    // Keep the new quiet tail intact if old, dense history needs thinning.
    if (st.allStrikes.length + batch.length > maxSamples) {
      st.allStrikes = st.allStrikes.filter((_, i, points) => i % 2 === 0 || i === points.length - 1);
    }
    st.allStrikes.push(...batch.sort((a, b) => a[2] - b[2]));
    rememberReplayAnchors(st, batch, now);
    st.replayDirty = true;
  }
  return new Set(additions.keys());
}
