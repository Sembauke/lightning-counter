#!/usr/bin/env python3
"""Append GeoNames first-level administrative names to existing city tuples.

This uses only Python's standard library. It never changes names, coordinates,
or order. Unknown/ambiguous regions retain the original three-element tuple.
"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import unicodedata
import urllib.request
import zipfile


SOURCE_BASE = "https://download.geonames.org/export/dump/"
SOURCE_NAMES = ("cities500.zip", "admin1CodesASCII.txt")
TOLERANCE = 0.002


def normalize(name):
    return unicodedata.normalize("NFKC", name).casefold().strip()


def build_indexes(cache, wanted):
    admins = {}
    for line in (cache / "admin1CodesASCII.txt").read_text(encoding="utf-8").splitlines():
        code, name, _ascii_name, _id = line.split("\t")
        admins[code] = name
    primary = defaultdict(list)
    aliases = defaultdict(list)
    with zipfile.ZipFile(cache / "cities500.zip") as archive:
        with archive.open("cities500.txt") as raw:
            for line in io.TextIOWrapper(raw, encoding="utf-8"):
                fields = line.rstrip("\n").split("\t")
                country = fields[8]
                if country not in wanted or fields[6] != "P":
                    continue
                candidate = {
                    "id": fields[0],
                    "name": fields[1],
                    "lat": float(fields[4]),
                    "lon": float(fields[5]),
                    "region": admins.get(f"{country}.{fields[10]}"),
                    "admin_code": fields[10],
                }
                primary_names = {normalize(fields[1]), normalize(fields[2])}
                for name in primary_names & wanted[country]:
                    primary[(country, name)].append(candidate)
                alternate_names = {normalize(name) for name in fields[3].split(",")} - primary_names
                for name in alternate_names & wanted[country]:
                    aliases[(country, name)].append(candidate)
    return primary, aliases


def select_match(candidates, lat, lon):
    nearby = [c for c in candidates if abs(c["lat"] - lat) <= TOLERANCE and abs(c["lon"] - lon) <= TOLERANCE]
    if not nearby:
        return None, "no_nearby_match"
    # Exact matches at the source file's 3-decimal precision are strongest.
    rounded = [c for c in nearby if abs(c["lat"] - lat) <= 0.000501 and abs(c["lon"] - lon) <= 0.000501]
    chosen = rounded or nearby
    regions = {c["region"] for c in chosen}
    if len(regions) != 1:
        return None, "ambiguous_regions"
    region = next(iter(regions))
    if not region:
        return None, "missing_admin1"
    return region, "rounded_coordinates" if rounded else "within_tolerance"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Directory of original XX.json files")
    parser.add_argument("--output", required=True, type=Path, help="Directory for enriched XX.json files")
    parser.add_argument("--cache", type=Path, default=Path(__file__).parent / "sources")
    parser.add_argument("--report", type=Path, default=Path(__file__).parent / "report.json")
    parser.add_argument("--download", action="store_true", help="Download fresh GeoNames source files")
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error("--output must differ from --input")
    args.cache.mkdir(parents=True, exist_ok=True)
    for name in SOURCE_NAMES:
        target = args.cache / name
        if args.download or not target.exists():
            urllib.request.urlretrieve(SOURCE_BASE + name, target)

    originals = {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(args.input.glob("[A-Z][A-Z].json"))}
    wanted = {country: {normalize(row[0]) for row in rows} for country, rows in originals.items()}
    primary, aliases = build_indexes(args.cache, wanted)
    args.output.mkdir(parents=True, exist_ok=True)
    counts = Counter()
    countries = {}
    unknown = []
    for country, rows in originals.items():
        output = []
        local_counts = Counter()
        for row in rows:
            name, lat, lon = row[:3]
            key = (country, normalize(name))
            region, reason = select_match(primary.get(key, []), lat, lon)
            method = "primary"
            if region is None and reason == "no_nearby_match":
                region, reason = select_match(aliases.get(key, []), lat, lon)
                method = "alias"
            base = [name, lat, lon]
            if region:
                output.append(base + [region])
                counts["enriched"] += 1
                counts[f"{method}_{reason}"] += 1
                local_counts["enriched"] += 1
            else:
                output.append(base)
                counts["unknown"] += 1
                counts[reason] += 1
                local_counts["unknown"] += 1
                unknown.append({"country": country, "city": base, "reason": reason})
            counts["total"] += 1
            local_counts["total"] += 1
        # Validate the invariants before emitting an asset.
        assert len(rows) == len(output)
        assert all(before[:3] == after[:3] for before, after in zip(rows, output))
        (args.output / f"{country}.json").write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        countries[country] = dict(local_counts)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "schema": "[cityName, latitude, longitude, provinceOrState?]",
        "tolerance_degrees_per_axis": TOLERANCE,
        "sources": [{"url": SOURCE_BASE + name, "sha256": hashlib.sha256((args.cache / name).read_bytes()).hexdigest()} for name in SOURCE_NAMES],
        "license": "CC BY 4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "Province/state data derived from GeoNames (https://www.geonames.org/), licensed under CC BY 4.0.",
        "counts": dict(counts),
        "countries": countries,
        "unknown": unknown,
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(dict(counts), indent=2))


if __name__ == "__main__":
    main()
