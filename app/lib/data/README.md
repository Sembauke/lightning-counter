# Marine regions

`marineRegions.json` contains named marine polygons from [Natural Earth v5.1.2](https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_10m_geography_marine_polys.geojson), used by the server to label storms with their ocean, sea, gulf, or other named water body.

Natural Earth data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/). The source coordinates, including island holes and antimeridian splits, are retained without simplification. These are generalized geographic regions: Natural Earth describes the [physical label boundaries](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-physical-labels/) as approximately 1:50 million scale, so small coastal features can be omitted.

The asset retains only English names (falling back to the source name), polygon coordinates, and calculated bounding boxes. Unnamed features are omitted. Regions are sorted by polygon area, with holes subtracted, so smaller regions take precedence if polygons overlap. North/South Atlantic and Pacific regions share their source English ocean names.

Regenerate from the pinned source using Python's standard library, from the repository root:

```python
import json
from pathlib import Path
from urllib.request import urlopen

url = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_geography_marine_polys.geojson'
features = json.load(urlopen(url))['features']
regions = []
for feature in features:
    name = feature['properties']['name_en'] or feature['properties']['name']
    if not name:
        continue
    geometry = feature['geometry']
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    vertices = [point for polygon in polygons for ring in polygon for point in ring]
    bbox = [min(p[0] for p in vertices), min(p[1] for p in vertices),
            max(p[0] for p in vertices), max(p[1] for p in vertices)]
    area = sum(
        abs(sum(ring[i][0] * ring[i - 1][1] - ring[i - 1][0] * ring[i][1]
                for i in range(len(ring)))) * (1 if index == 0 else -1)
        for polygon in polygons for index, ring in enumerate(polygon)
    )
    regions.append((area, {'name': name, 'bbox': bbox, 'polygons': polygons}))
regions.sort(key=lambda region: region[0])
Path('app/lib/data/marineRegions.json').write_text(
    '[\n' + ',\n'.join(json.dumps(region, separators=(',', ':'), ensure_ascii=False)
                       for _, region in regions) + '\n]\n'
)
```
