import { getMarineName } from './geoMarine';
import { getSubdivisionName } from './geoSubdivision';

interface StormLocation {
  code: string;
  lat: number;
  lon: number;
  city: string | null;
  originCity: string | null;
  originLat?: number | null;
  originLon?: number | null;
}

/** Enrich display locations without changing stored cities or country attribution. */
export function withStormLocationNames<T extends StormLocation>(storm: T): T & {
  subdivision?: string;
  originSubdivision?: string;
} {
  const city = storm.city === 'Open Ocean' || (storm.city == null && storm.code === 'XO')
    ? getMarineName(storm.lat, storm.lon) ?? storm.city
    : storm.city;
  const originCity = (storm.originCity === 'Open Ocean' || (storm.originCity == null && storm.code === 'XO'))
    && storm.originLat != null && storm.originLon != null
    ? getMarineName(storm.originLat, storm.originLon) ?? storm.originCity
    : storm.originCity;
  const subdivision = storm.code !== 'XO' && storm.city !== 'Open Ocean'
    ? getSubdivisionName(storm.lat, storm.lon, storm.code)
    : null;
  const originSubdivision = storm.originCity !== 'Open Ocean' && storm.originLat != null && storm.originLon != null
    ? getSubdivisionName(storm.originLat, storm.originLon)
    : null;
  return {
    ...storm, city, originCity,
    ...(subdivision ? { subdivision } : {}),
    ...(originSubdivision ? { originSubdivision } : {}),
  };
}
