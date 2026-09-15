import { describe, expect, it } from 'vitest';
import { getMarineName } from '../app/lib/geoMarine';

describe('getMarineName', () => {
  it.each<[number, number, string]>([
    [40, -35, 'Atlantic Ocean'],
    [-30, -20, 'Atlantic Ocean'],
    [15, -170, 'Pacific Ocean'],
    [15, 170, 'Pacific Ocean'],
    [-30, -130, 'Pacific Ocean'],
    [-25, 75, 'Indian Ocean'],
    [89, 0, 'Arctic Ocean'],
    [-65, 60, 'Southern Ocean'],
    [55, 3, 'North Sea'],
    [57, 20, 'Baltic Sea'],
    [34, 18, 'Mediterranean Sea'],
    [40, 12, 'Tyrrhenian Sea'],
    [15, -75, 'Caribbean Sea'],
    [25, -90, 'Gulf of Mexico'],
    [27, -60, 'Sargasso Sea'],
    [-18, 155, 'Coral Sea'],
    [15, 115, 'South China Sea'],
    [20, 38, 'Red Sea'],
  ])('names the water at %s, %s as %s', (lat, lon, name) => {
    expect(getMarineName(lat, lon)).toBe(name);
  });

  it.each([
    [52.37, 4.9], // Amsterdam: mainland.
    [28.6, 77.2], // Delhi: mainland within the Indian Ocean's bounding box.
    [65, -19], // Iceland: an island hole inside the Atlantic's bounding box.
    [40, 9], // Sardinia: an island hole beside the Tyrrhenian Sea.
    [1, 115], // Borneo: an island amid several seas.
    [19.8, -155.5], // Hawaii: an island hole in the Pacific Ocean.
  ])('does not label land at %s, %s as water', (lat, lon) => {
    expect(getMarineName(lat, lon)).toBeNull();
  });

  it('recognizes both sides of the antimeridian and the North Pole', () => {
    expect(getMarineName(15, 180)).toBe('Pacific Ocean');
    expect(getMarineName(15, -180)).toBe('Pacific Ocean');
    expect(getMarineName(85, 180)).toBe('Arctic Ocean');
    expect(getMarineName(90, 0)).toBe('Arctic Ocean');
  });

  it.each([
    [NaN, 0], [0, NaN], [Infinity, 0], [0, -Infinity],
    [91, 0], [-91, 0], [0, 181], [0, -181],
  ])('returns no name for invalid coordinates %s, %s', (lat, lon) => {
    expect(getMarineName(lat, lon)).toBeNull();
  });
});
