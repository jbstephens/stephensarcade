// Fetch OSM data for Poets Corner in small chunks with retry/backoff.
const BBOX = '37.936,-122.082,37.958,-122.056';
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const CHUNKS = {
  highways: `way["highway"](${BBOX});node["highway"="turning_circle"](${BBOX});`,
  buildings: `way["building"](${BBOX});`,
  nature: `way["waterway"](${BBOX});way["natural"](${BBOX});node["natural"="tree"](${BBOX});way["landuse"](${BBOX});`,
  places: `way["leisure"](${BBOX});node["leisure"](${BBOX});way["amenity"](${BBOX});node["amenity"](${BBOX});way["shop"](${BBOX});node["shop"](${BBOX});way["barrier"](${BBOX});`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(name, body) {
  const query = `[out:json][timeout:60];(${body});out geom;`;
  for (let attempt = 0; attempt < 9; attempt++) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'User-Agent': 'stephens-arcade-dev', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      const text = await res.text();
      if (text.trimStart().startsWith('{')) {
        const json = JSON.parse(text);
        if (json.elements) {
          console.log(`${name}: ${json.elements.length} elements (via ${new URL(ep).host})`);
          return json.elements;
        }
      }
      console.log(`${name}: attempt ${attempt + 1} on ${new URL(ep).host} not JSON/busy`);
    } catch (e) {
      console.log(`${name}: attempt ${attempt + 1} error ${e.message}`);
    }
    await sleep(4000 + attempt * 3000);
  }
  throw new Error(`${name}: all attempts failed`);
}

const all = [];
for (const [name, body] of Object.entries(CHUNKS)) {
  all.push(...await fetchChunk(name, body));
  await sleep(2000);
}
// Dedup by type+id
const seen = new Set();
const elements = all.filter((e) => {
  const k = e.type + e.id;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const fs = await import('fs');
fs.writeFileSync(new URL('./poco_osm.json', import.meta.url).pathname, JSON.stringify({ elements }));
console.log('TOTAL saved:', elements.length);
