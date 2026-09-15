import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { getStormName } from '../app/lib/stormName';
import en from '../messages/en.json';

const t = createTranslator({ locale: 'en', messages: en, namespace: 'storms' });
const storm = { code: 'US', lat: 41.258, lon: -95.907, city: 'Omaha', originCity: null };

describe('storm location labels', () => {
  it('identifies the storm region without assigning its nearby city to that region', () => {
    expect(getStormName({ ...storm, subdivision: 'Iowa' }, t)).toBe('Storm in Iowa, near Omaha');
  });

  it('includes both regions when a storm moves between places with the same city name', () => {
    expect(getStormName({ ...storm, city: 'Springfield', originCity: 'Springfield',
      subdivision: 'Missouri', originSubdivision: 'Illinois' }, t))
      .toBe('Storm from Illinois (near Springfield) to Missouri (near Springfield)');
  });

  it('does not invent a journey from missing origin information or repeat a region name', () => {
    expect(getStormName({ ...storm, originCity: 'Omaha', subdivision: 'Iowa' }, t)).toBe('Storm in Iowa, near Omaha');
    expect(getStormName({ ...storm, subdivision: 'Iowa', originSubdivision: 'Iowa' }, t)).toBe('Storm in Iowa, near Omaha');
    expect(getStormName({ ...storm, city: 'Iowa', subdivision: 'Iowa' }, t)).toBe('Storm in Iowa');
    expect(getStormName({ ...storm, city: null, subdivision: 'Iowa' }, t)).toBe('Storm in Iowa');
  });

  it('keeps named seas, city-only labels and coordinate fallbacks', () => {
    expect(getStormName({ ...storm, code: 'XO', city: 'North Sea' }, t)).toBe('Storm near North Sea');
    expect(getStormName(storm, t)).toBe('Storm near Omaha');
    expect(getStormName({ ...storm, city: null }, t)).toBe('41.26, -95.91');
  });
});
