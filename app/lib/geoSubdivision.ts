// Server-side state, province, and region lookup. Dataset: ./data/subdivisions.README.md.
import { containsPoint } from './geoPolygon';

type Subdivision = [
  country: string,
  name: string,
  bbox: [number, number, number, number],
  polygons: number[][][][],
];

let subdivisions: Subdivision[] | null = null;
const subdivisionsByCountry = new Map<string, Subdivision[]>();

export function getSubdivisionName(lat: number, lon: number, countryCode?: string): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  if (lon === 180) lon = -180;

  if (!subdivisions) {
    // Keep the large geographic asset out of TypeScript's inferred JSON types.
    subdivisions = require('./data/subdivisions.json') as Subdivision[];
    for (const subdivision of subdivisions) {
      const country = subdivision[0];
      const regions = subdivisionsByCountry.get(country) ?? [];
      regions.push(subdivision);
      subdivisionsByCountry.set(country, regions);
    }
  }

  const candidates = countryCode === undefined
    ? subdivisions
    : subdivisionsByCountry.get(countryCode.toUpperCase()) ?? [];
  for (const [, name, bbox, polygons] of candidates) {
    if (lon < bbox[0] || lat < bbox[1] || lon > bbox[2] || lat > bbox[3]) continue;
    for (const [exterior, ...holes] of polygons) {
      if (containsPoint(exterior, lat, lon) && !holes.some(hole => containsPoint(hole, lat, lon))) {
        return name;
      }
    }
  }
  return null;
}
