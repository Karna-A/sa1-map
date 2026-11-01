# SA1 print map

Static site for printing doorknock maps of Victorian SA1s. Replaces the old
`sa1s.australianlabor.org.au` page (which downloaded a 43 MB national file per view).

## Using it

Open `index.html` (hosted, or via a local server) with the SA1 codes in the URL:

```
?sa1=21203130422,21203130423
```

- Paste codes into the box (commas, spaces or new lines all work) and press Enter or **Show**.
- Click any SA1 on the map to add or remove it. Zoom in to see the surrounding SA1s and their codes.
- **Add pin**, then click the map, to drop a labelled pin. Drag to move; click it to remove.
- **Print** lays the page out as A4 landscape with the SA1 code(s), suburb and district at the top.
- The URL always reflects the current selection and pins, so copy it to share the exact map.

## Data

Everything comes from the Spatial folder, nothing from the roll:

- `Spatial/sa1_districts.shp`: ABS SA1 2021 polygons for Victoria, tagged with the VEC 2022 state district.
- `Spatial/Victoria Boundries/LOCALITY_POLYGON.shp`: Vicmap localities, overlaid on each SA1 to give the suburb
  (every locality holding 20%+ of the SA1's area, largest first).

Rebuild after either file changes:

```
python build/build_sa1_data.py
```

Outputs `data/sa2/<SA2 code>.json` (one file per SA2, simplified to about 2 m) and `data/sa2_index.json`.

## Local testing

```
python -m http.server 8765 --directory C:\Users\Amit.Aalok\sa1-map
```

then open `http://localhost:8765/?sa1=21203130422`.

## Hosting

Any static host works; there is no server code. GitHub Pages: push this folder to a public repo, then
Settings > Pages > branch `main`, folder `/ (root)`.
