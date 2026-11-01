"""
Build the static data files for the SA1 print-map site.

Inputs (all from the Spatial folder, nothing from the roll):
  sa1_districts.shp                         VIC SA1 2021 polygons (GDA2020 lat/lon) already
                                            tagged with the VEC 2022 state district + region.
  Victoria Boundries/LOCALITY_POLYGON.shp   Vicmap Admin localities = suburbs (GDA2020 VicGrid).

Outputs (into ../data):
  sa2/<SA2_CODE>.json   one GeoJSON FeatureCollection per SA2, holding its SA1s with
                        properties {sa1, suburb, sa2, district}. The browser derives the
                        file name from the SA1 code (first 9 digits = SA2 code), so no
                        per-SA1 index is needed.
  sa2_index.json        {sa2_code: [minlng, minlat, maxlng, maxlat]} so the browser can
                        load the SA2 files that intersect the current viewport.
  districts.json        VEC 2022 state district boundaries as merged lines (shared borders stored
                        once, simplified ~50 m) plus a label point per district.
  groups.json           {"seats": {district: [sa1...]}, "suburbs": {suburb: [sa1...]}} for the
                        bulk "print every SA1 in this seat / suburb" option. A straddling SA1
                        is listed under each suburb that holds 20%+ of it.

Suburb rule: overlay each SA1 on the locality polygons (in VicGrid metres so areas are
honest) and keep every locality holding >= 20% of the SA1's area, largest first, joined
with " / ". SA1s with no locality overlap (shouldn't happen on land) fall back to the ABS
SA2 name. Run time is about a minute; re-run only when the shapefiles change.
"""
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

import pyproj
import shapefile
import shapely
from shapely.geometry import shape, mapping
from shapely.ops import transform
from shapely.strtree import STRtree

# Folder holding the shapefiles; set SA1_SPATIAL_DIR rather than hard-coding a path here
# (this script is in a public repo).
SPATIAL = Path(os.environ.get("SA1_SPATIAL_DIR") or "/nonexistent").expanduser()
if not (SPATIAL / "sa1_districts.shp").is_file():
    sys.exit("Set SA1_SPATIAL_DIR to the folder containing sa1_districts.shp and Victoria Boundries/")
SA1_SHP = SPATIAL / "sa1_districts.shp"
LOC_SHP = SPATIAL / "Victoria Boundries" / "LOCALITY_POLYGON.shp"
DIST_SHP = SPATIAL / "Victoria Boundries" / "STATE_ASSEMBLY_2022.shp"
OUT = Path(__file__).resolve().parent.parent / "data"

MIN_SHARE = 0.20   # a locality must cover this much of the SA1 to be named
ROUND_DP = 6       # ~10 cm; keeps the JSON small without visible change at street scale
SIMPLIFY_DEG = 0.00002  # ~2 m Douglas-Peucker; sub-pixel at print zooms, roughly halves the JSON
DIST_SIMPLIFY_DEG = 0.0005  # ~50 m for the district lines; they are context, not the target


def round_coords(obj):
    """Recursively round every coordinate in a GeoJSON geometry dict."""
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], float):
            return [round(v, ROUND_DP) for v in obj]
        return [round_coords(o) for o in obj]
    return obj


def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "sa2").mkdir(exist_ok=True)

    # Coordinate systems come from the .prj files so this doesn't depend on proj's EPSG db.
    sa1_crs = pyproj.CRS.from_wkt(SA1_SHP.with_suffix(".prj").read_text())
    loc_crs = pyproj.CRS.from_wkt(LOC_SHP.with_suffix(".prj").read_text())
    to_vicgrid = pyproj.Transformer.from_crs(sa1_crs, loc_crs, always_xy=True).transform
    to_latlon = pyproj.Transformer.from_crs(loc_crs, sa1_crs, always_xy=True).transform

    # --- state districts (VicGrid -> lat/lon, simplified) -----------------------------
    dist_polys, labels = [], []
    for sr in shapefile.Reader(str(DIST_SHP)).iterShapeRecords(fields=["DISTRICT"]):
        g = transform(to_latlon, shape(sr.shape.__geo_interface__))
        dist_polys.append(g)
        pt = g.representative_point()
        labels.append({"name": sr.record["DISTRICT"].strip().title(),
                       "lat": round(pt.y, 5), "lng": round(pt.x, 5)})
    # coverage_simplify keeps shared borders identical between neighbours (no slivers);
    # the union then stores each shared border once and line_merge joins the fragments
    # into long lines (without it, simplify has nothing to remove and the file balloons).
    simplified = shapely.coverage_simplify(dist_polys, DIST_SIMPLIFY_DEG)
    lines = shapely.line_merge(shapely.unary_union([g.boundary for g in simplified]))
    (OUT / "districts.json").write_text(json.dumps(
        {"lines": round_coords(mapping(lines)), "labels": labels}, separators=(",", ":")), encoding="utf-8")
    print(f"districts: {len(labels)}, {(OUT / 'districts.json').stat().st_size / 1e6:.1f} MB")

    # --- localities -----------------------------------------------------------------
    loc_reader = shapefile.Reader(str(LOC_SHP))
    loc_geoms, loc_names = [], []
    for sr in loc_reader.iterShapeRecords(fields=["LOCALITY"]):
        g = shape(sr.shape.__geo_interface__)
        if not g.is_valid:
            g = shapely.make_valid(g)
        loc_geoms.append(g)
        loc_names.append((sr.record["LOCALITY"] or "").strip().title())
    tree = STRtree(loc_geoms)
    print(f"localities: {len(loc_geoms)}")

    # --- SA1s -----------------------------------------------------------------------
    sa1_reader = shapefile.Reader(str(SA1_SHP))
    by_sa2 = defaultdict(list)
    bbox_by_sa2 = {}
    seats = defaultdict(list)      # district -> SA1 codes
    suburbs = defaultdict(list)    # locality -> SA1 codes (an SA1 can sit under several)
    n = n_fallback = n_nogeom = 0
    fields = ["SA1_CODE21", "SA2_CODE21", "SA2_NAME21", "DISTRICT"]
    for sr in sa1_reader.iterShapeRecords(fields=fields):
        rec = sr.record
        code = rec["SA1_CODE21"]
        sa2 = rec["SA2_CODE21"]
        assert code[:9] == sa2, f"SA1 {code} does not nest in SA2 {sa2}"

        # ABS special-purpose SA1s ("No usual address", "Migratory - Offshore - Shipping")
        # carry no polygon; nothing to draw, so skip them.
        if sr.shape.shapeType == shapefile.NULL:
            n_nogeom += 1
            continue

        g = shape(sr.shape.__geo_interface__)
        if not g.is_valid:
            g = shapely.make_valid(g)
        # Suburb overlay uses the full-resolution shape; only the drawn geometry is simplified.
        g_draw = g.simplify(SIMPLIFY_DEG, preserve_topology=True)

        # Suburb shares, computed in metres.
        gm = transform(to_vicgrid, g)
        area = gm.area
        shares = []
        if area > 0:
            for i in tree.query(gm, predicate="intersects"):
                a = gm.intersection(loc_geoms[i]).area / area
                if a >= MIN_SHARE:
                    shares.append((a, loc_names[i]))
        shares.sort(reverse=True)
        if shares:
            suburb = " / ".join(name for _, name in shares)
            for _, name in shares:
                suburbs[name].append(code)
        else:
            suburb = rec["SA2_NAME21"]
            suburbs[suburb].append(code)
            n_fallback += 1
        district = (rec["DISTRICT"] or "").strip().title()
        seats[district].append(code)

        by_sa2[sa2].append({
            "type": "Feature",
            "properties": {
                "sa1": code,
                "suburb": suburb,
                "sa2": rec["SA2_NAME21"],
                "district": district,
            },
            "geometry": round_coords(mapping(g_draw)),
        })
        b = g.bounds
        if sa2 in bbox_by_sa2:
            o = bbox_by_sa2[sa2]
            bbox_by_sa2[sa2] = [min(o[0], b[0]), min(o[1], b[1]), max(o[2], b[2]), max(o[3], b[3])]
        else:
            bbox_by_sa2[sa2] = list(b)
        n += 1
        if n % 2000 == 0:
            print(f"  {n} SA1s, {time.time() - t0:.0f}s", flush=True)

    # --- write ----------------------------------------------------------------------
    total = largest = 0
    for sa2, feats in by_sa2.items():
        p = OUT / "sa2" / f"{sa2}.json"
        p.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                separators=(",", ":")), encoding="utf-8")
        size = p.stat().st_size
        total += size
        largest = max(largest, size)
    index = {sa2: [round(v, ROUND_DP) for v in b] for sa2, b in bbox_by_sa2.items()}
    (OUT / "sa2_index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    groups = {"seats": {k: sorted(v) for k, v in sorted(seats.items())},
              "suburbs": {k: sorted(v) for k, v in sorted(suburbs.items())}}
    (OUT / "groups.json").write_text(json.dumps(groups, separators=(",", ":")), encoding="utf-8")
    print(f"groups: {len(groups['seats'])} seats, {len(groups['suburbs'])} suburbs, "
          f"{(OUT / 'groups.json').stat().st_size / 1e6:.1f} MB")

    print(f"SA1s written: {n} | skipped (no geometry): {n_nogeom} | SA2 files: {len(by_sa2)} "
          f"| suburb fallback to SA2 name: {n_fallback}")
    print(f"data size: {total / 1e6:.1f} MB total, largest SA2 file {largest / 1e3:.0f} KB")
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.exit(main())
