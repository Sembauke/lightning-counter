export interface StormLocation {
  code: string;
  city: string | null;
  cityRegion?: string | null;
  lat: number;
  lon: number;
  originCity?: string | null;
  originRegion?: string | null;
}

/** Keep city names intact so legacy records and compact labels stay consistent. */
export function cityWithRegion(city: string, region?: string | null): string {
  const detail = region?.trim();
  return detail && detail.toLocaleLowerCase() !== city.trim().toLocaleLowerCase()
    ? `${city}, ${detail}`
    : city;
}

export function formatStormName(
  storm: StormLocation,
  translate: (key: 'stormNear' | 'stormFromTo', values: Record<string, string>) => string,
  detailed = false,
): string {
  const city = storm.city ?? (storm.code === 'XO' ? 'Open Ocean' : null);
  const origin = storm.originCity ?? (storm.code === 'XO' ? 'Open Ocean' : null);
  const destination = city && detailed ? cityWithRegion(city, storm.cityRegion) : city;
  const source = origin && detailed ? cityWithRegion(origin, storm.originRegion) : origin;
  const differentRegions = detailed && storm.originRegion && storm.cityRegion
    && storm.originRegion.trim().toLocaleLowerCase() !== storm.cityRegion.trim().toLocaleLowerCase();
  return source && destination && (origin !== city || differentRegions)
    ? translate('stormFromTo', { from: source, to: destination })
    : destination
      ? translate('stormNear', { city: destination })
      : `${storm.lat.toFixed(2)}, ${storm.lon.toFixed(2)}`;
}
