interface StormPlace {
  code: string;
  city: string | null;
  originCity: string | null;
  lat: number;
  lon: number;
  subdivision?: string | null;
  originSubdivision?: string | null;
}

type Translate = (
  key: 'stormNear' | 'stormFromTo' | 'stormNearIn' | 'stormIn' | 'regionNearCity',
  values?: Record<string, string>,
) => string;

/** The region belongs to the storm; its nearest city may be across a border. */
export function getStormName(storm: StormPlace, t: Translate): string {
  const { subdivision, originSubdivision } = storm;
  const city = storm.city ?? (storm.code === 'XO' ? 'Open Ocean' : null);
  const place = (name: string | null, region?: string | null): string | null => {
    if (!region) return name;
    return name && name !== region ? t('regionNearCity', { region, city: name }) : region;
  };
  const current = place(city, subdivision);
  const origin = place(storm.originCity, originSubdivision);
  // A missing region at one endpoint is not evidence that the storm moved.
  const moved = (storm.originCity != null && city != null && storm.originCity !== city)
    || (subdivision && originSubdivision && subdivision !== originSubdivision);
  if (origin && current && origin !== current && moved) return t('stormFromTo', { from: origin, to: current });
  if (subdivision) return city && city !== subdivision
    ? t('stormNearIn', { region: subdivision, city })
    : t('stormIn', { region: subdivision });
  return city ? t('stormNear', { city }) : `${storm.lat.toFixed(2)}, ${storm.lon.toFixed(2)}`;
}
