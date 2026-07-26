import type { StormStrike } from './db';

type Subscriber = {
  lat: number;
  lon: number;
  radiusKm: number;
  send: (strike: StormStrike) => void;
};

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
  for (const sub of reg.values()) {
    const dLat = (lat - sub.lat) * 111.32;
    const dLon = (lon - sub.lon) * 111.32 * Math.cos(((lat + sub.lat) / 2) * Math.PI / 180);
    if (Math.hypot(dLat, dLon) <= sub.radiusKm) {
      try { sub.send([lat, lon, time]); } catch { /* subscriber gone */ }
    }
  }
}
