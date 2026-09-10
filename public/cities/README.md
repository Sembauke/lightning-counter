# City and province/state data

Each country file contains `[cityName, latitude, longitude, provinceOrState?]`
tuples. The optional fourth field names the city's first-level administrative
division: a province, state, region, or local equivalent. It describes the named
city, rather than asserting that the storm centroid is inside that division.

Province/state data is derived from [GeoNames](https://www.geonames.org/),
licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
The original city files were modified by joining GeoNames administrative names
to the same country, city name, and coordinates; names, coordinates, and order
were preserved. GeoNames data is provided as-is.

Sources downloaded September 10, 2026:

- [City data](https://download.geonames.org/export/dump/cities500.zip)
- [Administrative names](https://download.geonames.org/export/dump/admin1CodesASCII.txt)
- [Format and license documentation](https://download.geonames.org/export/dump/readme.txt)

169,755 of 170,355 cities have a province/state. The remaining 600 keep their
city-only label: 380 lack an administrative name and 220 lack a confident match.
Matching requires a primary/alternate name and coordinates within 0.002 degrees
on both axes, preferring the original three-decimal precision. Ambiguous matches
are left unknown.

To regenerate from the repository root, using Python 3's standard library:

```sh
python3 scripts/enrich_cities.py --input public/cities \
  --output /tmp/lightning-enriched-cities \
  --cache /tmp/lightning-geonames --report /tmp/lightning-region-report.json --download
```

Review the report and generated assets before replacing the country files.
The generator also accepts enriched inputs and preserves their first three fields.
Keep this attribution with the generated assets.
