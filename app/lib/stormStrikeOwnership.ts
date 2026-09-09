import { MIN_STORM_RATE, type StrikePoint } from './stormClusters';
import type { StormStrike } from './db';
import { STORM_OBSERVATION_GAP_MS, type StormTransition } from './stormTransition';

const WINDOW_MS = 10 * 60_000;
const RADIUS_KM = 25;
const CELL_DEG = 0.25;
const LON_CELLS = 360 / CELL_DEG;

export interface StormOwnershipSource {
  key: string;
  lat: number;
  lon: number;
  lastSeen: number;
  currentRate: number;
  lifecycle?: {
    members: StrikePoint[];
    supportMembers?: StrikePoint[];
    transitions: StormTransition[];
  };
  replayAnchors?: StormStrike[];
}

export interface StormStrikeOwner { key: string; active: boolean }
type Owner = StormStrikeOwner & { lat: number; lon: number; points: StrikePoint[]; peers: string[] };
type Anchor = { point: StrikePoint; owner: Owner; support: boolean };

export function ownedStrikeId(point: StrikePoint): string {
  return `${Math.round(point.lat * 1000)},${Math.round(point.lon * 1000)},${point.time}`;
}

function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * 111.32,
    ((a.lon - b.lon + 540) % 360 - 180) * 111.32 * Math.cos((a.lat + b.lat) * Math.PI / 360));
}

function column(lon: number): number {
  return ((Math.floor((lon + 180) / CELL_DEG) % LON_CELLS) + LON_CELLS) % LON_CELLS;
}

function valid(point: StrikePoint): boolean {
  return Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180 && Number.isFinite(point.time);
}

/** Immutable ten-minute ownership evidence, rebuilt once per tracking pass. */
export function buildStormStrikeOwnership(storms: StormOwnershipSource[], now: number) {
  const owners = new Map<string, Owner>();
  const exact = new Map<string, Owner>();
  const index = new Map<string, Map<Owner, Anchor[]>>();
  const recent = (point: StrikePoint) => valid(point) && point.time > now - WINDOW_MS && point.time <= now;
  const sorted = [...storms].sort((a, b) => a.key.localeCompare(b.key));

  for (const storm of sorted) {
    owners.set(storm.key, { key: storm.key, lat: storm.lat, lon: storm.lon,
      active: storm.currentRate >= MIN_STORM_RATE && now - storm.lastSeen <= 5 * 60_000,
      points: [], peers: [...new Set((storm.lifecycle?.transitions ?? [])
        .filter(transition => transition.kind === 'merge').flatMap(transition => transition.stormKeys))] });
  }
  // Confirmed member IDs outrank inherited replay anchors after a split.
  for (const storm of sorted) {
    const owner = owners.get(storm.key)!;
    for (const point of storm.lifecycle?.members ?? []) {
      if (recent(point) && !exact.has(ownedStrikeId(point))) exact.set(ownedStrikeId(point), owner);
    }
  }
  for (const storm of sorted) {
    const owner = owners.get(storm.key)!;
    const support = new Set((storm.lifecycle?.supportMembers ?? storm.lifecycle?.members ?? []).map(ownedStrikeId));
    const points = new Map<string, StrikePoint>();
    for (const point of [...(storm.lifecycle?.members ?? []), ...(storm.replayAnchors ?? [])
      .map(([lat, lon, time]) => ({ lat, lon, time }))]) {
      if (!recent(point)) continue;
      const id = ownedStrikeId(point);
      if (!exact.has(id)) exact.set(id, owner);
      if (exact.get(id) === owner) points.set(id, { lat: point.lat, lon: point.lon, time: point.time });
    }
    owner.points = [...points.values()];
    for (const [id, point] of points) {
      const key = `${Math.floor(point.lat / CELL_DEG)}:${column(point.lon)}`;
      const bucket = index.get(key) ?? new Map<Owner, Anchor[]>();
      const anchors = bucket.get(owner) ?? [];
      anchors.push({ point, owner, support: support.has(id) });
      bucket.set(owner, anchors);
      index.set(key, bucket);
    }
  }

  function find(point: StrikePoint, at = point.time): StormStrikeOwner | undefined {
    if (!valid(point)) return undefined;
    const result = (owner: StormStrikeOwner): StormStrikeOwner => ({ key: owner.key,
      active: owner.active && at - now <= STORM_OBSERVATION_GAP_MS });
    const existing = exact.get(ownedStrikeId(point));
    if (existing) return result(existing);
    const candidates = new Map<string, Owner>();
    let tail: Owner | undefined;
    let tailKm = RADIUS_KM;
    const latReach = RADIUS_KM / 111.32;
    const lonReach = latReach / Math.max(0.000001, Math.cos(Math.min(90, Math.abs(point.lat) + latReach) * Math.PI / 180));
    const columns = Math.min(LON_CELLS, Math.ceil(lonReach / CELL_DEG) * 2 + 1);
    const first = column(point.lon) - Math.floor(columns / 2);
    for (let y = Math.floor((point.lat - latReach) / CELL_DEG); y <= Math.floor((point.lat + latReach) / CELL_DEG); y++) {
      for (let x = first; x < first + columns; x++) {
        for (const [bucketOwner, anchors] of index.get(`${y}:${(x + LON_CELLS) % LON_CELLS}`) ?? []) {
          if (candidates.has(bucketOwner.key)) continue;
          for (const anchor of anchors) {
            if (anchor.point.time >= point.time || point.time - anchor.point.time > WINDOW_MS) continue;
            const km = distance(point, anchor.point);
            if (km > RADIUS_KM) continue;
            if (anchor.support || !anchor.owner.active) {
              candidates.set(anchor.owner.key, anchor.owner);
              // A connected observation with two pending merge owners assigns
              // new members to their nearest centroid, preserving lexical ties.
              for (const key of anchor.owner.peers) {
                const peer = owners.get(key);
                if (peer) candidates.set(key, peer);
              }
            }
            if (km < tailKm || (km === tailKm && (!tail || anchor.owner.key < tail.key))) {
              tailKm = km;
              tail = anchor.owner;
            }
            if (candidates.has(bucketOwner.key)) break;
          }
        }
      }
    }
    let owner: Owner | undefined;
    let nearest = Infinity;
    for (const candidate of candidates.values()) {
      const km = distance(point, candidate);
      if (km < nearest || (km === nearest && (!owner || candidate.key < owner.key))) {
        owner = candidate;
        nearest = km;
      }
    }
    // Quiet tails still reserve their own nearby activity, but callers must
    // not count those strikes as qualified lightning on the live detail page.
    return owner ? result(owner) : tail ? { key: tail.key, active: false } : undefined;
  }

  function history(key: string, at = now): StormStrike[] | undefined {
    const owner = owners.get(key);
    return owner?.points.filter(point => point.time > at - WINDOW_MS && point.time <= at)
      .sort((a, b) => a.time - b.time).map(point => [point.lat, point.lon, point.time]);
  }
  return { find, history, has: (key: string) => owners.has(key), publishedAt: now };
}

export type StormStrikeOwnership = ReturnType<typeof buildStormStrikeOwnership>;
