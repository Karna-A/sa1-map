# SA1 print map

Static site for printing doorknock maps of Victorian SA1s. Replaces the old
`sa1s.australianlabor.org.au` page (which downloaded a 43 MB national file per view).

## Using it

Open `index.html` (hosted, or via a local server) with the SA1 codes in the URL:

```
?sa1=21203130422:1234,21203130423
```

(`code:pin` gives that SA1 its own SwiftFox PIN, printed on its page.)

- Paste codes into the box (commas, spaces or new lines all work) and press Enter or **Show**.
- Click any SA1 on the map to add it; click a selected SA1 to set its PIN. The selected list on
  the left also has a PIN box and a remove button per SA1. Zoom in to see the surrounding SA1s.
  Dashed dark-red lines are the state district boundaries.
- **Whole seat** selects every SA1 in a seat. **Suburb** then narrows to that seat's suburbs and
  selects only the SA1s in both (with no seat chosen it selects the whole suburb). A suburb
  includes any SA1 of which it covers 20% or more.
- Each SA1's PIN is printed on its page as "PIN 1234   Please login at alp.sfox.au".
- **Print** produces one A4 landscape page per selected SA1: the code in large type, suburb,
  district, date, PIN line and a map of that SA1 with its neighbours.
- The URL always reflects the selection and PINs, so copy it to reproduce the print.

## Data

Everything comes from the Spatial folder, nothing from the roll:

- `Spatial/sa1_districts.shp`: ABS SA1 2021 polygons for Victoria, tagged with the VEC 2022 state district.
- `Spatial/Victoria Boundries/LOCALITY_POLYGON.shp`: Vicmap localities, overlaid on each SA1 to give the suburb
  (every locality holding 20%+ of the SA1's area, largest first).

Rebuild after either file changes:

```
python build/build_sa1_data.py
```

Outputs `data/sa2/<SA2 code>.json` (one file per SA2, simplified to about 2 m), `data/sa2_index.json`,
`data/districts.json` (district boundary lines from `STATE_ASSEMBLY_2022.shp`, about 50 m) and
`data/groups.json` (seat and suburb to SA1 lists). Takes about five minutes.

## Local testing

```
python -m http.server 8765 --directory C:\Users\Amit.Aalok\sa1-map
```

then open `http://localhost:8765/?sa1=21203130422`.

## Hosting

Any static host works; there is no server code. GitHub Pages: push this folder to a public repo, then
Settings > Pages > branch `main`, folder `/ (root)`.
