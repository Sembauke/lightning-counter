import type { StormStrike } from './db';
import { buildStormStrikeOwnership, type StormOwnershipSource, type StormStrikeOwnership } from './stormStrikeOwnership';
import { peakStormMinuteRate, recentStormStrikes, type StormLiveRateSnapshot } from './stormLiveRate';
import { STORM_OBSERVATION_GAP_MS } from './stormTransition';

type Subscriber = {
  stormKey: string;
  resolveKey?: () => string;
  send: (strike: StormStrike) => void;
};

function ownership(): StormStrikeOwnership | undefined {
  return (globalThis as any)._stormStrikeOwnership;
}

export function publishStormOwnership(storms: StormOwnershipSource[], now = Date.now()): void {
  (globalThis as any)._stormStrikeOwnership = buildStormStrikeOwnership(storms, now);
  const resolved = new Map<string, string>();
  for (const subscriber of registry().values()) {
    if (!subscriber.resolveKey) continue;
    if (!resolved.has(subscriber.stormKey)) {
      try { resolved.set(subscriber.stormKey, subscriber.resolveKey()); } catch { continue; }
    }
    subscriber.stormKey = resolved.get(subscriber.stormKey)!;
  }
}

export function findStormStrikeOwner(lat: number, lon: number, time: number) {
  return ownership()?.find({ lat, lon, time }, Date.now());
}

/** Legacy/finished rows fall back to their saved replay, never a nearby raw-grid query. */
export function stormStrikeHistory(stormKey: string, saved: StormStrike[] | null, now = Date.now()): StormStrike[] {
  return ownership()?.history(stormKey, now) ?? (saved ?? [])
    .filter(strike => strike[2] > now - 10 * 60_000 && strike[2] <= now)
    .sort((a, b) => a[2] - b[2]);
}

/** Resolve global observations once for the whole requested group of storms. */
function collectStormLiveStrikes(stormKeys: Iterable<string>, now: number, windowMs = 60_000): Map<string, StormStrike[] | null> {
  const current = ownership();
  const known = current && Number.isFinite(now)
    && now >= current.publishedAt && now - current.publishedAt <= STORM_OBSERVATION_GAP_MS;
  const byStorm = new Map<string, StormStrike[] | null>();
  for (const key of stormKeys) {
    byStorm.set(key, known && current.has(key) ? current.history(key, now) ?? [] : null);
  }
  if (!known) return byStorm;
  const cutoff = now - windowMs;
  const recent = (globalThis as typeof globalThis & {
    _recentStrikes?: Array<{ lat: number; lon: number; time: number }>;
  })._recentStrikes ?? [];
  for (const point of recent) {
    if (!(point.time > cutoff && point.time <= now)) continue;
    const owner = current.find(point, now);
    if (!owner?.active) continue;
    // A late observation can precede the latest history timestamp and still be new.
    byStorm.get(owner.key)?.push([point.lat, point.lon, point.time]);
  }
  for (const [key, strikes] of byStorm) {
    if (strikes) byStorm.set(key, recentStormStrikes(strikes, now, windowMs));
  }
  return byStorm;
}

/** Recent owned observations are complete; persisted replay samples are not. */
export function getStormLiveStrikes(stormKey: string, now = Date.now()): StormStrike[] | null {
  return collectStormLiveStrikes([stormKey], now).get(stormKey)?.sort((a, b) => a[2] - b[2]) ?? null;
}

/** The map and detail page receive this same rolling-minute snapshot. */
export function getStormLiveRates(stormKeys: Iterable<string>, now = Date.now()): StormLiveRateSnapshot {
  // Retain peaks between tracker checkpoints, including for a newly connected viewer.
  const strikes = collectStormLiveStrikes(stormKeys, now, 5 * 60_000);
  return {
    at: now,
    rates: Object.fromEntries([...strikes].map(([key, points]) => [key, points ? recentStormStrikes(points, now).length : null])),
    peakRates: Object.fromEntries([...strikes].map(([key, points]) => [key, points ? peakStormMinuteRate(points, now) : null])),
  };
}

function registry(): Map<string, Subscriber> {
  if (!(globalThis as any)._stormStrikeSubscribers) {
    (globalThis as any)._stormStrikeSubscribers = new Map<string, Subscriber>();
  }
  return (globalThis as any)._stormStrikeSubscribers as Map<string, Subscriber>;
}

export function registerStrikeSubscriber(id: string, sub: Subscriber): void {
  registry().set(id, sub);
}

export function unregisterStrikeSubscriber(id: string): void {
  registry().delete(id);
}

export function dispatchStrike(lat: number, lon: number, time: number): void {
  const reg = registry();
  if (reg.size === 0) return;
  const owner = findStormStrikeOwner(lat, lon, time);
  if (!owner?.active) return;
  for (const sub of reg.values()) {
    if (sub.stormKey === owner.key) {
      try { sub.send([lat, lon, time]); } catch { /* subscriber gone */ }
    }
  }
}
