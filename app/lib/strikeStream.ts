import type { StormStrike } from './db';
import { buildStormStrikeOwnership, type StormOwnershipSource, type StormStrikeOwnership } from './stormStrikeOwnership';

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
