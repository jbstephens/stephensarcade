// Render poco_course_data.json into a yardage-book SVG (theme-aware via CSS classes).
import fs from 'fs';
const D = JSON.parse(fs.readFileSync(new URL('./poco_course_data.json', import.meta.url).pathname, 'utf8'));
const { XMIN, XMAX, YMIN, YMAX } = D.meta.crop;
const S = 0.5;
const W = (XMAX - XMIN) * S, H = (YMAX - YMIN) * S;
const px = (x) => +((x - XMIN) * S).toFixed(1);
const py = (y) => +((YMAX - y) * S).toFixed(1);
const path = (pts, close = false) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${px(p[0])} ${py(p[1])}`).join('') + (close ? 'Z' : '');

const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
const LAT0 = D.meta.origin.lat, LON0 = D.meta.origin.lon;
const gx = (lon) => R * toRad(lon - LON0) * Math.cos(toRad(LAT0));
const gy = (lat) => R * toRad(lat - LAT0);

let out = [];
out.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PoCo Open course map" class="course-map">`);
out.push(`<rect class="m-ground" x="0" y="0" width="${W}" height="${H}"/>`);

// parks
for (const p of D.parks) out.push(`<path class="m-park" d="${path(p.pts, true)}"/>`);
// pitches (ball diamonds etc.)
for (const p of D.pitches) out.push(`<path class="m-pitch${p.sport === 'baseball' ? ' m-sand' : ''}" d="${path(p.pts, true)}"/>`);
for (const p of D.playgrounds) out.push(`<path class="m-pitch" d="${path(p.pts, true)}"/>`);

// streets under water so canal bridges read as crossings? No - streets above water looks like bridges. water first.
for (const w of D.water) {
  if (w.kind === 'pond') out.push(`<path class="m-pond" d="${path(w.pts, true)}"/>`);
  else out.push(`<path class="m-water${w.kind === 'canal' ? ' m-canal' : ''}" d="${path(w.pts)}"/>`);
}
// canal trail + paths (dashed, only named trail to avoid clutter)
for (const p of D.paths) if (p.name) out.push(`<path class="m-trail" d="${path(p.pts)}"/>`);

// streets
const CLASSW = { secondary: 4.6, tertiary: 3.8, primary: 5, unclassified: 3, residential: 2.6, living_street: 2.2 };
for (const s of D.streets) out.push(`<path class="m-street" style="stroke-width:${CLASSW[s.class] || 2.6}" d="${path(s.pts)}"/>`);

// buildings
for (const b of D.buildings) out.push(`<path class="m-bldg${['school', 'church', 'civic', 'retail', 'commercial'].includes(b.kind) ? ' m-bldg-big' : ''}" d="${path(b.pts, true)}"/>`);

// pools
for (const [x, y] of D.pools) out.push(`<circle class="m-pool" cx="${px(x)}" cy="${py(y)}" r="2.6"/>`);

// street labels: longest segment per chosen name, rotated
const LABELS = ['Boyd Road', 'Soule Avenue', 'Roberta Avenue', 'Hubbard Avenue', 'Beatrice Road', 'Byron Drive', 'Shelly Drive', 'Masefield Drive', 'Stevenson Drive', 'Elliot Drive', 'Oakvue Road', 'Gregory Lane', 'Oak Park Boulevard', 'Patterson Boulevard', 'Cleaveland Road', 'Doray Drive'];
const segsByName = {};
for (const s of D.streets) {
  if (!s.name || !LABELS.includes(s.name)) continue;
  let len = 0;
  for (let i = 1; i < s.pts.length; i++) len += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]);
  if (!segsByName[s.name] || len > segsByName[s.name].len) segsByName[s.name] = { len, pts: s.pts };
}
for (const [name, { pts }] of Object.entries(segsByName)) {
  // midpoint + angle of middle segment
  const mi = Math.floor(pts.length / 2);
  const a = pts[Math.max(0, mi - 1)], b = pts[Math.min(pts.length - 1, mi)];
  const cxm = (a[0] + b[0]) / 2, cym = (a[1] + b[1]) / 2;
  let ang = (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  if (ang > 90) ang -= 180;
  if (ang < -90) ang += 180;
  out.push(`<text class="m-stlabel" transform="translate(${px(cxm)} ${py(cym) - 2.5}) rotate(${ang.toFixed(1)})" text-anchor="middle">${name.toUpperCase()}</text>`);
}

// landmark labels (curated)
const LM = [
  ['SEQUOIA ELEMENTARY', 37.9433, -122.0713],
  ['SEQUOIA MIDDLE', 37.9448, -122.0664],
  ['PLEASANT HILL PARK', 37.9497, -122.0668],
  ['PLEASANT OAKS PARK', 37.9368, -122.0713],
  ['PH MIDDLE', 37.9362, -122.0636],
  ['CHRIST THE KING', 37.9472, -122.0787],
  ['CITY HALL', 37.9478, -122.0638],
  ["SOLDIER'S MEMORIAL", 37.9428, -122.0608],
  ['CONTRA COSTA CANAL', 37.9448, -122.0802],
  ['MURDERERS CREEK', 37.9424, -122.0688],
  ['DOWNTOWN', 37.9452, -122.0592],
];
for (const [nm, la, lo] of LM) {
  out.push(`<text class="m-lmlabel" x="${px(gx(lo))}" y="${py(gy(la))}" text-anchor="middle">${nm}</text>`);
}

// holes: [num, name, par, yards, tee lat/lon, green lat/lon, optional waypoint lat/lon]
const HOLES = [
  [1, 'Soule Street Canyon', 4, 37.9427, -122.0723, 37.9438, -122.0694, null],
  [2, 'First Bell', 4, 37.9440, -122.0695, 37.9447, -122.0662, null],
  [3, 'Murderers Creek', 4, 37.9436, -122.0668, 37.9420, -122.0699, [37.9423, -122.0680]],
  [4, 'Beatrice Road', 5, 37.9415, -122.0705, 37.9378, -122.0693, [37.9398, -122.0704]],
  [5, 'The Cloverleaf', 4, 37.9378, -122.0693, 37.9372, -122.0658, null],
  [6, 'The Canal', 5, 37.9391, -122.0795, 37.9426, -122.0794, [37.9408, -122.0801]],
  [7, 'Christ the King', 3, 37.9463, -122.0801, 37.9468, -122.0786, null],
  [8, 'City Hall Pond', 3, 37.9470, -122.0637, 37.9476, -122.0630, null],
  [9, 'Park Long Drive', 4, 37.9490, -122.0685, 37.94885, -122.0655, null],
];
console.log('HOLE TABLE:');
for (const [n, nm, par, tla, tlo, gla, glo, wp] of HOLES) {
  const tx = gx(tlo), ty = gy(tla), gxx = gx(glo), gyy = gy(gla);
  let d;
  if (wp) {
    const wx = gx(wp[1]), wy = gy(wp[0]);
    d = Math.hypot(wx - tx, wy - ty) + Math.hypot(gxx - wx, gyy - wy);
    out.push(`<path class="m-fairway" d="M${px(tx)} ${py(ty)} Q${px(wx)} ${py(wy)} ${px(gxx)} ${py(gyy)}"/>`);
  } else {
    d = Math.hypot(gxx - tx, gyy - ty);
    out.push(`<path class="m-fairway" d="M${px(tx)} ${py(ty)} L${px(gxx)} ${py(gyy)}"/>`);
  }
  const yards = Math.round(d * 1.09361);
  console.log(`  ${n}. ${nm} — par ${par}, ${yards}y`);
  out.push(`<circle class="m-green" cx="${px(gxx)}" cy="${py(gyy)}" r="4.2"/>`);
  out.push(`<line class="m-pin" x1="${px(gxx)}" y1="${py(gyy)}" x2="${px(gxx)}" y2="${py(gyy) - 9}"/>`);
  out.push(`<path class="m-flag" d="M${px(gxx)} ${py(gyy) - 9} l7 2.6 l-7 2.6 Z"/>`);
  out.push(`<circle class="m-tee" cx="${px(tx)}" cy="${py(ty)}" r="6.5"/>`);
  out.push(`<text class="m-teenum" x="${px(tx)}" y="${py(ty) + 2.4}" text-anchor="middle">${n}</text>`);
}
out.push('</svg>');
fs.writeFileSync(new URL('./map.svg', import.meta.url).pathname, out.join('\n'));
console.log('svg bytes:', out.join('\n').length, ' viewBox', W, H);
