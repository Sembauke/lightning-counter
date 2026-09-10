import { describe, expect, it } from 'vitest';
import { cityWithRegion, formatStormName, type StormLocation } from '../app/lib/stormLocation';
import { withStormRegions } from '../app/lib/stormRegions';
import { nearestCity } from '../app/lib/stormClusters';

const translate = (key: string, values: Record<string, string>) => key === 'stormNear'
  ? `Storm near ${values.city}`
  : `Storm from ${values.from} to ${values.to}`;

const storm = {
  code: 'NL', city: 'Amsterdam', lat: 52.374, lon: 4.89,
  originCity: null, originLat: null, originLon: null, countryPath: ['NL'],
};

describe('storm location details', () => {
  it('enriches an existing city-only record without changing its compact name', () => {
    const enriched = withStormRegions(storm);
    expect(enriched.cityRegion).toBe('North Holland');
    expect(enriched.city).toBe(storm.city);
    expect(formatStormName(enriched, translate)).toBe('Storm near Amsterdam');
    expect(formatStormName(enriched, translate, true)).toBe('Storm near Amsterdam, North Holland');
  });

  it('uses the origin country for a cross-border path', () => {
    const enriched = withStormRegions({
      ...storm, originCity: 'Antwerp', originLat: 51.22, originLon: 4.4, countryPath: ['BE', 'NL'],
    });
    expect(enriched.originRegion).toBe('Flanders');
    expect(formatStormName(enriched, translate, true)).toBe('Storm from Antwerp, Flanders to Amsterdam, North Holland');
  });

  it('distinguishes identically named cities by their coordinates', () => {
    const massachusetts = withStormRegions({ ...storm, code: 'US', city: 'Springfield', lat: 42.102, lon: -72.59 });
    const illinois = withStormRegions({ ...storm, code: 'US', city: 'Springfield', lat: 39.802, lon: -89.644 });
    expect(massachusetts.cityRegion).toBe('Massachusetts');
    expect(illinois.cityRegion).toBe('Illinois');
  });

  it('uses the nearby recorded city when coarse borders geocode its namesake country', () => {
    const borderStorm = withStormRegions({
      ...storm, city: 'Velden', lat: 51.412, lon: 6.168,
      originCity: 'Velden', originLat: 51.412, originLon: 6.168, countryPath: ['NL', 'DE'],
    });
    expect(borderStorm.cityRegion).toBe('Limburg');
    expect(borderStorm.originRegion).toBe('Limburg');
    expect(formatStormName(borderStorm, translate, true)).toBe('Storm near Velden, Limburg');
  });

  it('preserves unknown, ocean, and coordinate-only locations', () => {
    const unknown = withStormRegions({ ...storm, city: 'Unknown town' });
    expect(unknown.cityRegion).toBeNull();
    expect(formatStormName(unknown, translate, true)).toBe('Storm near Unknown town');
    expect(formatStormName({ ...storm, city: null, code: 'XO' }, translate, true)).toBe('Storm near Open Ocean');
    expect(formatStormName({ ...storm, city: null }, translate, true)).toBe('52.37, 4.89');
    expect(withStormRegions({ ...storm, originCity: 'Amsterdam' }).originRegion).toBeNull();
  });

  it('avoids duplicate names and retains both regions when a path uses the same city name', () => {
    expect(cityWithRegion('New York', 'New York')).toBe('New York');
    const sameName: StormLocation = { ...storm, city: 'Springfield', cityRegion: 'Illinois', originCity: 'Springfield', originRegion: 'Missouri' };
    expect(formatStormName(sameName, translate, true)).toBe('Storm from Springfield, Missouri to Springfield, Illinois');
    expect(formatStormName(sameName, translate)).toBe('Storm near Springfield');
  });

  it('does not invent a journey when an old record lacks the origin region', () => {
    const partial = withStormRegions({ ...storm, originCity: 'Amsterdam' });
    expect(formatStormName(partial, translate, true)).toBe('Storm near Amsterdam, North Holland');
  });

  it('supports both enriched and legacy city tuples in live activity', () => {
    expect(nearestCity([['Amsterdam', 52.374, 4.89, 'North Holland']], 52.374, 4.89)?.region).toBe('North Holland');
    expect(nearestCity([['Amsterdam', 52.374, 4.89]], 52.374, 4.89)?.region).toBeNull();
  });
});
