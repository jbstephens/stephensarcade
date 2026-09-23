// Distill poco_osm.json into compact game-ready course data (local meters).
import fs from 'fs';
const { elements } = JSON.parse(fs.readFileSync(new URL('./poco_osm.json', import.meta.url).pathname, 'utf8'));

const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
const LAT0 = 37.944, LON0 = -122.070; // course origin: heart of PoCo (Soule/Boyd area)
const mx = (lon) => +(R * toRad(lon - LON0) * Math.cos(toRad(LAT0))).toFixed(1);
const my = (lat) => +(R * toRad(lat - LAT0)).toFixed(1); // +y = north
const toXY = (g) => g.map((p) => [mx(p.lon), my(p.lat)]);

// Course crop: keep things inside this local-meter box (canal west -> downtown edge east)
const XMIN = -1120, XMAX = 1120, YMIN = -900, YMAX = 950;
const inBox = (pts) => pts.some(([x, y]) => x >= XMIN && x <= XMAX && y >= YMIN && y <= YMAX);

// Douglas-Peucker simplify
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const dmax = { d: 0, i: 0 };
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1e-9;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > dmax.d) { dmax.d = d; dmax.i = i; }
  }
  if (dmax.d > eps) {
    return [...simplify(pts.slice(0, dmax.i + 1), eps).slice(0, -1), ...simplify(pts.slice(dmax.i), eps)];
  }
  return [a, b];
}

const ways = elements.filter((e) => e.type === 'way' && e.geometry);
const nodes = elements.filter((e) => e.type === 'node');
const out = {
  meta: {
    origin: { lat: LAT0, lon: LON0 }, units: 'meters, +x east, +y north',
    crop: { XMIN, XMAX, YMIN, YMAX },
    source: 'OpenStreetMap (ODbL) via Overpass, mined 2026-09-22; elevation USGS 3DEP via AWS terrarium z15',
  },
  streets: [], paths: [], water: [], parks: [], pitches: [], playgrounds: [], pools: [],
  buildings: [], landmarks: [], culdesacs: [], elev: null,
};

const KEEP_HW = ['residential', 'tertiary', 'secondary', 'unclassified', 'living_street', 'primary'];
for (const w of ways) {
  const t = w.tags || {}, pts = toXY(w.geometry);
  if (!inBox(pts)) continue;
  if (t.highway && KEEP_HW.includes(t.highway)) {
    out.streets.push({ name: t.name || null, class: t.highway, pts: simplify(pts, 1.5) });
  } else if (['footway', 'cycleway', 'path'].includes(t.highway)) {
    out.paths.push({ name: t.name || null, pts: simplify(pts, 1.5) });
  } else if (t.waterway) {
    out.water.push({ name: t.name || t.waterway, kind: t.waterway, pts: simplify(pts, 1.5) });
  } else if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'recreation_ground' || t.landuse === 'grass') {
    out.parks.push({ name: t.name || null, pts: simplify(pts, 1.5) });
  } else if (t.leisure === 'pitch') {
    out.pitches.push({ sport: t.sport || null, pts: simplify(pts, 1) });
  } else if (t.leisure === 'playground') {
    out.playgrounds.push({ pts: simplify(pts, 1) });
  } else if (t.leisure === 'swimming_pool' || t.leisure === 'hot_tub') {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    out.pools.push([+cx.toFixed(1), +cy.toFixed(1)]);
  } else if (t.building) {
    out.buildings.push({ kind: t.building, name: t.name || null, pts: simplify(pts, 0.8) });
  } else if (t.landuse === 'water' || t.natural === 'water') {
    out.water.push({ name: t.name || 'pond', kind: 'pond', pts: simplify(pts, 1) });
  }
  // named amenity ways (schools etc.) -> landmark polygons too
  if ((t.amenity || t.shop) && t.name) {
    out.landmarks.push({ name: t.name, kind: t.amenity || t.shop, pts: simplify(pts, 2) });
  }
}
for (const n of nodes) {
  const t = n.tags || {}, x = mx(n.lon), y = my(n.lat);
  if (x < XMIN || x > XMAX || y < YMIN || y > YMAX) continue;
  if (t.highway === 'turning_circle') out.culdesacs.push([x, y]);
  else if ((t.amenity || t.shop || t.leisure) && t.name) out.landmarks.push({ name: t.name, kind: t.amenity || t.shop || t.leisure, at: [x, y] });
}
// name cul-de-sacs by nearest named street endpoint
const namedStreets = out.streets.filter((s) => s.name);
out.culdesacs = out.culdesacs.map(([x, y]) => {
  let best = null, bd = 1e9;
  for (const s of namedStreets) for (const p of s.pts) {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bd) { bd = d; best = s.name; }
  }
  return { name: best, at: [x, y] };
});

const counts = Object.fromEntries(Object.entries(out).filter(([k, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
console.log(counts);
const json = JSON.stringify(out);
fs.writeFileSync(new URL('./poco_course_data.json', import.meta.url).pathname, json);
console.log('bytes:', json.length);

// hole-length calculator for proposed routing
const holes = [
  ['H1 Soule St canyon', 37.9427, -122.0723, 37.9438, -122.0694],
  ['H2 First Bell (Sequoia E->M)', 37.9440, -122.0695, 37.9447, -122.0662],
  ['H3 Murderers Creek dogleg', 37.9436, -122.0668, 37.9420, -122.0699],
  ['H4 Beatrice->Pleasant Oaks', 37.9415, -122.0705, 37.9378, -122.0693],
  ['H5 Cloverleaf diamonds', 37.9378, -122.0693, 37.9372, -122.0658],
  ['H6 Canal carry (OakPark->CTK)', 37.9390, -122.0755, 37.9466, -122.0790],
  ['H7 Christ the King amphitheater', 37.9466, -122.0790, 37.9470, -122.0779],
  ['H8 Gregory downhill to City Hall pond', 37.9477, -122.0700, 37.9475, -122.0632],
  ['H9 Park Long Drive (rec->pool)', 37.9497, -122.0673, 37.9489, -122.0655],
];
console.log('\nPROPOSED HOLE LENGTHS:');
for (const [nm, la1, lo1, la2, lo2] of holes) {
  const d = Math.hypot(mx(lo2) - mx(lo1), my(la2) - my(la1));
  console.log(`  ${nm}: ${Math.round(d)}m (${Math.round(d * 1.09361)}y)`);
}
