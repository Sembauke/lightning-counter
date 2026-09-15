# States, provinces, and other subdivisions

`subdivisions.json` contains 4,576 named administrative regions from [Natural Earth Admin 1 v5.1.1](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/). Natural Earth data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/).

Each row contains `[ISO alpha-2 country, English name, bounding box, polygons]`. Names fall back to the source name when English is unavailable. Unnamed features, Antarctica, and features without an ISO country code are omitted. Polygon holes and separate islands are retained. The source geometry is simplified with a topology-preserving tolerance of 0.01 degrees (about 1.1 km in latitude) and rounded to four decimal places. These generalized boundaries support storm location labels; they do not provide precise administrative boundaries. The server restricts matches to the storm's country when available.

Regenerate from the repository root with Python and temporary generation dependencies (`pyshp==2.3.1`, `shapely==2.0.7`; neither is needed by the application):

```python
import hashlib
import io
import json
import zipfile
from pathlib import Path
from urllib.request import urlopen

import shapefile
from shapely.geometry import mapping, shape

url = 'https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces.zip'
source = urlopen(url).read()
assert hashlib.sha256(source).hexdigest() == 'efc59726337323058f9446210adc96673179cd344e053666ee3d28cb58ba2b05'
archive = zipfile.ZipFile(io.BytesIO(source))
stem = 'ne_10m_admin_1_states_provinces'
reader = shapefile.Reader(**{
    extension: io.BytesIO(archive.read(f'{stem}.{extension}'))
    for extension in ['shp', 'shx', 'dbf']
})
regions = []
for record in reader.iterShapeRecords():
    properties = record.record.as_dict()
    country = properties['iso_a2']
    name = properties['name_en'] or properties['name']
    if not name or len(country) != 2 or country == '-1' or country == 'AQ':
        continue
    geometry = shape(record.shape.__geo_interface__).simplify(0.01, preserve_topology=True)
    polygons = mapping(geometry)['coordinates']
    if geometry.geom_type == 'Polygon':
        polygons = [polygons]
    polygons = [[[[round(x, 4), round(y, 4)] for x, y in ring]
                 for ring in polygon] for polygon in polygons]
    regions.append([country, name, [round(value, 4) for value in geometry.bounds], polygons])
regions.sort(key=lambda region: (region[0], region[1]))
Path('app/lib/data/subdivisions.json').write_text(
    '[\n' + ',\n'.join(json.dumps(region, separators=(',', ':'), ensure_ascii=False)
                       for region in regions) + '\n]\n'
)
```
