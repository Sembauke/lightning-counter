// Server-side ocean and sea lookup. Dataset provenance: ./data/README.md.
import marineRegions from './data/marineRegions.json';
import { containsPoint } from './geoPolygon';

export function getMarineName(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  // The polygons are split at the antimeridian; use the western copy of its edge.
  if (lon === 180) lon = -180;

  // Regions are ordered by area so any overlapping, more specific sea wins.
  for (const { name, bbox, polygons } of marineRegions) {
    if (lon < bbox[0] || lat < bbox[1] || lon > bbox[2] || lat > bbox[3]) continue;
    for (const [exterior, ...holes] of polygons) {
      if (containsPoint(exterior, lat, lon) && !holes.some(hole => containsPoint(hole, lat, lon))) {
        return name;
      }
    }
  }
  return null;
}
