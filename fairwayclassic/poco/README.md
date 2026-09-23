# PoCo Open — mined course data (2026-09-22)

Real Poets Corner (Pleasant Hill, CA) geometry for the Fairway Classic
neighborhood course. Proposal artifact: "The PoCo Open" (claude.ai).

- `poco_course_data.json` — game-ready: local meters (+x E, +y N), origin
  37.944,-122.070. Streets/paths/water/parks/pitches/pools/buildings/
  landmarks/cul-de-sacs, Douglas-Peucker simplified. ~72KB.
- `fetch_osm.mjs` → `poco_osm.json` (raw Overpass pull, chunked+retry).
- `analyze_osm.mjs` — digest of the raw pull (street/landmark inventory).
- `distill.mjs` — raw → poco_course_data.json + hole-length calc.
- `gen_map.mjs` — course-data → yardage-book SVG (`map.svg`) + scorecard.
- `mosaic.py` — Esri aerial mosaics (z17 overview + z19 crops) for art
  direction; refetch on demand, don't commit the JPGs.
- `elev.py` — USGS 3DEP elevation grid via terrarium tiles. West canal
  ridge ~30m → east park ~15m; Murderers Creek valley through middle.

Sources: OpenStreetMap (ODbL), USGS 3DEP, Esri World Imagery (reference
only). No residents' names/addresses anywhere — keep it that way.
