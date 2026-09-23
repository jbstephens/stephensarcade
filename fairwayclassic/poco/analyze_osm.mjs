// Digest poco_osm.json into course-relevant intel.
import fs from 'fs';
const { elements } = JSON.parse(fs.readFileSync(new URL('./poco_osm.json', import.meta.url).pathname, 'utf8'));

const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
const LAT0 = 37.947, LON0 = -122.069; // local origin
const mx = (lon) => R * toRad(lon - LON0) * Math.cos(toRad(LAT0));
const my = (lat) => R * toRad(lat - LAT0);
function wayLen(geom) {
  let L = 0;
  for (let i = 1; i < geom.length; i++) {
    const dx = mx(geom[i].lon) - mx(geom[i - 1].lon), dy = my(geom[i].lat) - my(geom[i - 1].lat);
    L += Math.hypot(dx, dy);
  }
  return L;
}
const center = (g) => {
  const lat = g.reduce((s, p) => s + p.lat, 0) / g.length, lon = g.reduce((s, p) => s + p.lon, 0) / g.length;
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
};

const ways = elements.filter((e) => e.type === 'way' && e.geometry);
const nodes = elements.filter((e) => e.type === 'node');

// STREETS grouped by name
const streets = {};
for (const w of ways.filter((w) => w.tags?.highway)) {
  const t = w.tags;
  if (['footway', 'cycleway', 'path', 'service', 'steps'].includes(t.highway)) continue;
  const name = t.name || `(unnamed ${t.highway})`;
  streets[name] ??= { class: t.highway, len: 0, segs: 0, maxspeed: t.maxspeed, lanes: t.lanes };
  streets[name].len += wayLen(w.geometry);
  streets[name].segs++;
}
console.log('=== STREETS (named, by length m) ===');
Object.entries(streets).sort((a, b) => b[1].len - a[1].len).forEach(([n, s]) =>
  console.log(`${n.padEnd(28)} ${s.class.padEnd(12)} ${Math.round(s.len)}m  segs=${s.segs}${s.maxspeed ? ' ' + s.maxspeed : ''}${s.lanes ? ' lanes=' + s.lanes : ''}`));

// PATHS / TRAILS
console.log('\n=== PATHS/TRAILS/CYCLEWAYS ===');
const paths = {};
for (const w of ways.filter((w) => ['footway', 'cycleway', 'path'].includes(w.tags?.highway))) {
  const name = w.tags.name || `(unnamed ${w.tags.highway})`;
  paths[name] ??= { len: 0, segs: 0 };
  paths[name].len += wayLen(w.geometry);
  paths[name].segs++;
}
Object.entries(paths).sort((a, b) => b[1].len - a[1].len).slice(0, 15).forEach(([n, s]) =>
  console.log(`${n.padEnd(40)} ${Math.round(s.len)}m segs=${s.segs}`));

// WATER
console.log('\n=== WATERWAYS ===');
for (const w of ways.filter((w) => w.tags?.waterway))
  console.log(`${w.tags.name || w.tags.waterway} [${w.tags.waterway}] ${Math.round(wayLen(w.geometry))}m @ ${center(w.geometry)}`);

// LEISURE / PARKS
console.log('\n=== LEISURE/PARKS ===');
for (const w of ways.filter((w) => w.tags?.leisure))
  console.log(`${(w.tags.name || '(unnamed)').padEnd(38)} [${w.tags.leisure}${w.tags.sport ? '/' + w.tags.sport : ''}] @ ${center(w.geometry)}`);
for (const n of nodes.filter((n) => n.tags?.leisure))
  console.log(`node: ${(n.tags.name || '(unnamed)').padEnd(32)} [${n.tags.leisure}] @ ${n.lat.toFixed(5)},${n.lon.toFixed(5)}`);

// AMENITIES & SHOPS
console.log('\n=== AMENITIES/SHOPS (named) ===');
for (const e of [...ways, ...nodes].filter((e) => (e.tags?.amenity || e.tags?.shop) && e.tags?.name)) {
  const loc = e.geometry ? center(e.geometry) : `${e.lat.toFixed(5)},${e.lon.toFixed(5)}`;
  console.log(`${e.tags.name.padEnd(42)} [${e.tags.amenity || e.tags.shop}] @ ${loc}`);
}

// LANDUSE / NATURAL
console.log('\n=== LANDUSE/NATURAL (named or notable) ===');
for (const w of ways.filter((w) => w.tags?.landuse || (w.tags?.natural && w.tags.natural !== 'tree')))
  console.log(`${(w.tags.name || '(unnamed)').padEnd(38)} [${w.tags.landuse || w.tags.natural}] @ ${center(w.geometry)}`);

// CUL-DE-SACS
const circles = nodes.filter((n) => n.tags?.highway === 'turning_circle');
console.log(`\n=== TURNING CIRCLES (cul-de-sacs): ${circles.length} ===`);
// find nearest named street for each
const namedSegs = ways.filter((w) => w.tags?.highway && w.tags?.name);
for (const c of circles) {
  let best = null, bd = 1e9;
  for (const w of namedSegs) for (const p of w.geometry) {
    const d = Math.hypot(mx(p.lon) - mx(c.lon), my(p.lat) - my(c.lat));
    if (d < bd) { bd = d; best = w.tags.name; }
  }
  console.log(`  ${c.lat.toFixed(5)},${c.lon.toFixed(5)}  near: ${best} (${Math.round(bd)}m)`);
}

// BUILDINGS
const bld = ways.filter((w) => w.tags?.building);
const byType = {};
for (const b of bld) byType[b.tags.building] = (byType[b.tags.building] || 0) + 1;
console.log(`\n=== BUILDINGS: ${bld.length} ===`, byType);
for (const b of bld.filter((b) => b.tags.name)) console.log(`  named: ${b.tags.name} [${b.tags.building}] @ ${center(b.geometry)}`);

// TREES
console.log(`\n=== TREE NODES: ${nodes.filter((n) => n.tags?.natural === 'tree').length} ===`);

// BARRIERS
const barr = {};
for (const w of ways.filter((w) => w.tags?.barrier)) barr[w.tags.barrier] = (barr[w.tags.barrier] || 0) + Math.round(wayLen(w.geometry));
console.log('\n=== BARRIERS (type: total m) ===', barr);

// BBOX extents in local meters
let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
for (const w of ways) for (const p of w.geometry) {
  minx = Math.min(minx, mx(p.lon)); maxx = Math.max(maxx, mx(p.lon));
  miny = Math.min(miny, my(p.lat)); maxy = Math.max(maxy, my(p.lat));
}
console.log(`\nLOCAL EXTENT: x ${Math.round(minx)}..${Math.round(maxx)} (${Math.round(maxx - minx)}m wide), y ${Math.round(miny)}..${Math.round(maxy)} (${Math.round(maxy - miny)}m tall)`);
