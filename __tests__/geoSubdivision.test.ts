import { describe, expect, it } from 'vitest';
import { getSubdivisionName } from '../app/lib/geoSubdivision';

describe('storm subdivision lookup', () => {
  it.each([
    ['Amsterdam', 52.3676, 4.9041, 'NL', 'North Holland'],
    ['Munich', 48.1351, 11.5820, 'DE', 'Bavaria'],
    ['Toronto', 43.6532, -79.3832, 'CA', 'Ontario'],
    ['Montreal', 45.5019, -73.5674, 'CA', 'Quebec'],
    ['Austin', 30.2672, -97.7431, 'US', 'Texas'],
    ['Miami', 25.774, -80.194, 'US', 'Florida'],
    ['Sacramento', 38.5816, -121.4944, 'US', 'California'],
    ['Sydney', -33.8688, 151.2093, 'AU', 'New South Wales'],
    ['Manaus', -3.1190, -60.0217, 'BR', 'Amazonas'],
    ['Tokyo', 35.6762, 139.6503, 'JP', 'Tokyo'],
    ['Mumbai', 19.0760, 72.8777, 'IN', 'Maharashtra'],
    ['Nairobi', -1.2921, 36.8219, 'KE', 'Nairobi'],
    ['Honolulu', 21.3099, -157.8581, 'US', 'Hawaii'],
  ])('finds the subdivision containing %s', (_city, lat, lon, country, expected) => {
    expect(getSubdivisionName(lat, lon, country)).toBe(expected);
  });

  it('supports lookups without a country and normalizes ISO country codes', () => {
    expect(getSubdivisionName(52.3676, 4.9041)).toBe('North Holland');
    expect(getSubdivisionName(52.3676, 4.9041, 'nl')).toBe('North Holland');
  });

  it('does not attach a subdivision from a different country', () => {
    expect(getSubdivisionName(52.3676, 4.9041, 'DE')).toBeNull();
    expect(getSubdivisionName(52.3676, 4.9041, 'XX')).toBeNull();
    // Lesotho is a hole in the surrounding South African province polygons.
    expect(getSubdivisionName(-29.3158, 27.4869, 'ZA')).toBeNull();
  });

  it('returns no subdivision for ocean coordinates or areas without named subdivisions', () => {
    expect(getSubdivisionName(0, -140)).toBeNull();
    expect(getSubdivisionName(54, 3, 'NL')).toBeNull();
    expect(getSubdivisionName(-85, 0, 'AQ')).toBeNull();
  });

  it.each([
    [NaN, 0], [0, NaN], [Infinity, 0], [0, Infinity],
    [91, 0], [-91, 0], [0, 181], [0, -181],
  ])('ignores invalid coordinates (%s, %s)', (lat, lon) => {
    expect(getSubdivisionName(lat, lon)).toBeNull();
  });
});
