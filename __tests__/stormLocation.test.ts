import { describe, expect, it } from 'vitest';
import { withStormLocationNames } from '../app/lib/stormLocation';

const oceanStorm = {
  code: 'XO', lat: 56, lon: 3, city: 'Open Ocean',
  originLat: 34, originLon: 18, originCity: 'Open Ocean',
};

describe('storm location names', () => {
  it('names the current sea and origin sea separately for legacy storms', () => {
    const named = withStormLocationNames(oceanStorm);
    expect(named).toEqual({ ...oceanStorm, city: 'North Sea', originCity: 'Mediterranean Sea' });
    expect(oceanStorm.city).toBe('Open Ocean');
    expect(oceanStorm.originCity).toBe('Open Ocean');
  });

  it('fills missing ocean names without using the current location for an unknown origin', () => {
    expect(withStormLocationNames({ ...oceanStorm, city: null, originCity: null })).toMatchObject({
      city: 'North Sea', originCity: 'Mediterranean Sea',
    });
    expect(withStormLocationNames({ ...oceanStorm, originLat: null, originLon: null })).toMatchObject({
      city: 'North Sea', originCity: 'Open Ocean',
    });
    expect(withStormLocationNames({ ...oceanStorm, originLat: null, originCity: null }).originCity).toBeNull();
  });

  it('keeps a sea origin when a storm has moved onto land', () => {
    expect(withStormLocationNames({
      code: 'NL', lat: 52.3676, lon: 4.9041, city: 'Amsterdam',
      originLat: 56, originLon: 3, originCity: 'Open Ocean',
    })).toMatchObject({ city: 'Amsterdam', subdivision: 'North Holland', originCity: 'North Sea' });
  });

  it('keeps actual city names and resolves subdivisions independently across country borders', () => {
    expect(withStormLocationNames({
      code: 'NL', lat: 52.3676, lon: 4.9041, city: 'Amsterdam',
      originLat: 48.1351, originLon: 11.582, originCity: 'Munich',
    })).toMatchObject({
      city: 'Amsterdam', subdivision: 'North Holland', originCity: 'Munich', originSubdivision: 'Bavaria',
    });
    expect(withStormLocationNames({ ...oceanStorm, city: 'Offshore platform' }).city).toBe('Offshore platform');
  });

  it('retains the land origin subdivision when the current location is at sea', () => {
    expect(withStormLocationNames({
      ...oceanStorm, originLat: 52.3676, originLon: 4.9041, originCity: 'Amsterdam',
    })).toEqual({
      ...oceanStorm, city: 'North Sea', originLat: 52.3676, originLon: 4.9041,
      originCity: 'Amsterdam', originSubdivision: 'North Holland',
    });
  });

  it('preserves fallback labels when coordinates cannot identify a place', () => {
    expect(withStormLocationNames({ ...oceanStorm, lat: NaN, originLon: Infinity })).toEqual({
      ...oceanStorm, lat: NaN, originLon: Infinity,
    });
    expect(withStormLocationNames({
      code: 'XO', lat: 52.3676, lon: 4.9041, city: null, originCity: null,
    })).toEqual({ code: 'XO', lat: 52.3676, lon: 4.9041, city: null, originCity: null });
  });
});
