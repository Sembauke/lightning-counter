import fs from 'fs';
import path from 'path';
import { getCountryCode } from './geoCountry';
import type { CityTuple } from './stormClusters';
import type { StormLocation } from './stormLocation';

const cityCache = new Map<string, Map<string, CityTuple[]>>();

function citiesFor(code: string): Map<string, CityTuple[]> {
  const cached = cityCache.get(code);
  if (cached) return cached;
  const index = new Map<string, CityTuple[]>();
  if (/^[A-Z]{2}$/.test(code) && code !== 'XO') {
    try {
      const cities = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'cities', `${code}.json`), 'utf8')) as CityTuple[];
      for (const city of cities) {
        const matches = index.get(city[0]) ?? [];
        matches.push(city);
        index.set(city[0], matches);
      }
    } catch { /* Missing city data keeps the existing city-only label. */ }
  }
  cityCache.set(code, index);
  return index;
}

function regionFor(codes: string[], city: string | null | undefined, lat: number, lon: number): string | null {
  if (!city || city === 'Open Ocean' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const candidates = [...new Set(codes)].flatMap(code => citiesFor(code).get(city) ?? []);
  const cosLat = Math.cos(lat * Math.PI / 180);
  let nearest: CityTuple | undefined;
  let nearestDistance = Infinity;
  for (const candidate of candidates) {
    const longitudeDelta = ((candidate[2] - lon + 540) % 360) - 180;
    const distance = (candidate[1] - lat) ** 2 + (longitudeDelta * cosLat) ** 2;
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest?.[3] || null;
}

/** Enrich on read so historical storms gain details without rewriting the DB. */
export function withStormRegions<T extends StormLocation & {
  originLat: number | null;
  originLon: number | null;
  countryPath: string[] | null;
}>(storm: T): T & { cityRegion: string | null; originRegion: string | null } {
  let originRegion: string | null = null;
  if (storm.originCity && storm.originCity !== 'Open Ocean' && storm.originLat != null && storm.originLon != null) {
    // A centroid near a coarse country border may geocode to the wrong country.
    // Compare namesakes across the recorded path using the city's coordinates.
    const originCodes = [storm.code, ...(storm.countryPath ?? [])];
    try {
      const geocoded = getCountryCode(storm.originLat, storm.originLon);
      if (geocoded) originCodes.push(geocoded);
    } catch { /* Use the recorded country path. */ }
    originRegion = regionFor(originCodes, storm.originCity, storm.originLat, storm.originLon);
  }
  return {
    ...storm,
    cityRegion: regionFor([storm.code], storm.city, storm.lat, storm.lon),
    originRegion,
  };
}
