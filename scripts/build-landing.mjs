#!/usr/bin/env node
// Build the marketing layer: OG images (1200x630, real gameplay + title bar),
// one landing page per game at /<slug>/, the arcade homepage at /arcade/,
// sitemap.xml, robots.txt, humans.txt. Pure static output; the console shell
// and games/ are never read, never written. Re-run any time.
//   node --experimental-websocket scripts/build-landing.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://ses.q5labs.co';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8932, CDP_PORT = 9332;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const games = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
const landing = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'landing.json'), 'utf8'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- OG images via a headless compositor page ----------------------------
function ogCompositorHtml(g, meta) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id=c width=1200 height=630></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');
const img=new Image();img.src='/site/shots/${g.slug}-title.png';
img.onload=()=>{
  x.imageSmoothingEnabled=false;
  // use only the TOP 76% of the shot (the games print control hints along
  // the bottom - cabinet chrome, not marketing art), cover-fit that region
  const srcH=img.height*0.76;
  const s=Math.max(1200/img.width,470/srcH),w=img.width*s,h=srcH*s;
  x.drawImage(img,0,0,img.width,srcH,(1200-w)/2,0,w,h);
  // solid title band - nothing bleeds through
  const gr=x.createLinearGradient(0,400,0,470);
  gr.addColorStop(0,'rgba(12,9,20,0)');gr.addColorStop(1,'rgba(12,9,20,1)');
  x.fillStyle=gr;x.fillRect(0,400,1200,70);
  x.fillStyle='#0c0914';x.fillRect(0,470,1200,160);
  x.textBaseline='alphabetic';
  x.font='700 60px Menlo, monospace';x.fillStyle='#f4d38c';
  x.fillText(${JSON.stringify(g.title)},48,540);
  x.font='400 27px Menlo, monospace';x.fillStyle='#c8c0d4';
  x.fillText(${JSON.stringify(meta.tagline)},48,588,1104);
  // brand chip, top-right, on its own pill
  x.font='700 22px Menlo, monospace';
  const tag='STEPHENS ARCADE \\u00b7 PLAY FREE \\u00b7 Q5LABS';
  const tw=x.measureText(tag).width;
  x.fillStyle='rgba(12,9,20,0.85)';x.fillRect(1200-40-tw-28,24,tw+28,44);
  x.fillStyle='#f4d38c';x.fillText(tag,1200-40-tw-14,53);
  x.fillStyle='#ff9a3c';x.fillRect(0,622,1200,8);
  document.title='ready';
};
</script>`;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
function serveRepo() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.startsWith('/__og/')) {
        const slug = p.slice(6).replace(/\/$/, '');
        const g = games.find(x => x.slug === slug);
        rsp.writeHead(200, { 'Content-Type': 'text/html' });
        rsp.end(ogCompositorHtml(g, landing[slug]));
        return;
      }
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(rsp);
    });
    srv.listen(HTTP_PORT, () => res(srv));
  });
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) { return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); }); },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
  });
}
async function buildOgImages() {
  const srv = await serveRepo();
  const userDir = fs.mkdtempSync('/tmp/ses-og-');
  const proc = spawn(CHROME, ['--headless=new', '--mute-audio', '--disable-gpu', '--no-first-run',
    '--window-size=1200,630', '--force-device-scale-factor=1', '--hide-scrollbars',
    '--user-data-dir=' + userDir, '--remote-debugging-port=' + CDP_PORT, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://localhost:${CDP_PORT}/json/version`); if (r.ok) break; } catch (e) {} await sleep(100); }
  for (const g of games) {
    const r = await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await r.json();
    const c = await connect(target.webSocketDebuggerUrl);
    await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: `http://localhost:${HTTP_PORT}/__og/${g.slug}` });
    await sleep(1200);
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(ROOT, 'site', 'og'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'site', 'og', `${g.slug}.png`), Buffer.from(s.data, 'base64'));
    c.close();
    await fetch(`http://localhost:${CDP_PORT}/json/close/${target.id}`);
    console.log('og', g.slug);
  }
  proc.kill(); srv.close();
}

// ---- shared page chrome ---------------------------------------------------
const CSS = `
:root{--bg:#0e0b18;--panel:#181322;--line:#3a3248;--gold:#f4d38c;--ember:#ff9a3c;--text:#e6dff0;--dim:#a89ec0}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:"Menlo","Consolas",monospace;line-height:1.65}
a{color:var(--ember);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
header.site{padding:14px 0;border-bottom:1px solid var(--line)}
header.site .wrap{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.brand{color:var(--gold);font-weight:700;letter-spacing:2px}
.brand small{color:var(--dim);font-weight:400;letter-spacing:1px}
.hero{border-bottom:4px solid var(--ember);max-height:440px;overflow:hidden}
.hero img{display:block;width:100%;height:auto;image-rendering:pixelated;object-fit:cover;object-position:center 18%}
.titleblock{padding:26px 0 0}
h1{color:var(--gold);font-size:clamp(28px,6vw,54px);letter-spacing:3px;text-shadow:0 3px 0 #000}
.tagline{color:var(--text);font-size:clamp(14px,2.4vw,20px);margin-top:4px}
.playrow{margin:26px 0;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.btn{display:inline-block;background:var(--ember);color:#1a1206;font-weight:700;letter-spacing:2px;padding:14px 30px;border-radius:6px;border-bottom:4px solid #b05a10}
.btn:hover{text-decoration:none;filter:brightness(1.08)}
.meta{color:var(--dim);font-size:14px}
section{margin:34px 0}
h2{color:var(--gold);letter-spacing:2px;font-size:20px;margin-bottom:12px;border-bottom:1px solid var(--line);padding-bottom:8px}
p{margin:12px 0;max-width:70ch}
ul.features{list-style:none}
ul.features li{padding:6px 0 6px 26px;position:relative}
ul.features li:before{content:"\\25a0";color:var(--ember);position:absolute;left:2px;font-size:12px;top:10px}
.shot{border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:14px 0}
.shot img{display:block;width:100%;image-rendering:pixelated}
.faq dt{color:var(--gold);margin-top:16px}
.faq dd{margin:6px 0 0 0;color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;display:block;color:var(--text)}
.card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;image-rendering:pixelated}
.card .pad{padding:12px 14px}
.card .t{color:var(--gold);letter-spacing:2px;font-weight:700}
.card .g{color:var(--dim);font-size:12px;letter-spacing:1px;margin-top:2px}
.card:hover{border-color:var(--ember);text-decoration:none}
footer{border-top:1px solid var(--line);margin-top:50px;padding:26px 0;color:var(--dim);font-size:14px}
footer .q5{color:var(--gold);font-weight:700;letter-spacing:3px}
`;

function pageShell({ title, desc, canonical, og, jsonld, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Stephens Arcade">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${og}">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<style>${CSS}</style>
</head>
<body>
<header class="site"><div class="wrap">
  <a class="brand" href="/arcade/">STEPHENS ARCADE <small>&middot; 8-BIT FAMILY SYSTEM</small></a>
  <nav><a href="/arcade/">All games</a></nav>
</div></header>
${body}
<footer><div class="wrap">
  <div class="q5"><a href="https://q5labs.co" rel="author">Q5LABS</a></div>
  <p>Stephens Arcade is a <a href="https://q5labs.co">Q5Labs</a> project &mdash; games designed and playtested by a dad and his two sons, built with Claude, and shipped only after they run at 60fps on the family's Raspberry Pi arcade cabinet.</p>
</div></footer>
</body>
</html>`;
}

const ORG = { '@type': 'Organization', name: 'Q5Labs', url: 'https://q5labs.co' };

function gamePage(g) {
  const m = landing[g.slug];
  const url = `${SITE}/${g.slug}/`;
  const playUrl = `/games/${g.slug}/`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'VideoGame',
    name: g.title, url, image: `${SITE}/site/og/${g.slug}.png`,
    description: m.desc.join(' '),
    genre: m.genre, gamePlatform: ['Web browser', 'Raspberry Pi arcade cabinet', 'iPad'],
    playMode: m.mode, applicationCategory: 'Game',
    operatingSystem: 'Any (web browser)',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: ORG, publisher: ORG,
  };
  const body = `
<div class="hero">
  <img src="/site/shots/${g.slug}-title.png" alt="${esc(g.title)} title screen" width="1280" height="720">
</div>
<main class="wrap">
  <div class="titleblock">
    <h1>${esc(g.title)}</h1>
    <div class="tagline">${esc(m.tagline)}</div>
  </div>
  <div class="playrow">
    <a class="btn" href="${playUrl}">&#9658; PLAY FREE IN BROWSER</a>
    <span class="meta">${esc(m.players)} &middot; ${esc(m.genre)} &middot; no install, no account</span>
  </div>
  <section>
    <h2>ABOUT THE GAME</h2>
    ${m.desc.map(p => `<p>${esc(p)}</p>`).join('\n    ')}
  </section>
  <section>
    <h2>FEATURES</h2>
    <ul class="features">${m.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
  </section>
  <section>
    <h2>IN THE GAME</h2>
    <div class="shot"><img src="/site/shots/${g.slug}-play.png" alt="${esc(g.title)} gameplay" loading="lazy" width="1280" height="720"></div>
  </section>
  <section class="faq">
    <h2>FAQ</h2>
    <dl>${m.faq.map(f => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join('\n    ')}</dl>
  </section>
</main>`;
  return pageShell({
    title: `${g.title} — free browser game | Stephens Arcade`,
    desc: `${m.tagline} ${m.desc[0]}`.slice(0, 158),
    canonical: url, og: `${SITE}/site/og/${g.slug}.png`, jsonld, body,
  });
}

function homePage() {
  const url = `${SITE}/arcade/`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'WebSite',
    name: 'Stephens Arcade', url: SITE,
    description: 'A free 8-bit family arcade: twelve browser games built by a dad and his two sons, playable anywhere and running on a living-room Raspberry Pi cabinet.',
    publisher: ORG,
  };
  const cards = games.map(g => `
  <a class="card" href="/${g.slug}/">
    <img src="/site/shots/${g.slug}-title.png" alt="${esc(g.title)}" loading="lazy">
    <div class="pad"><div class="t">${esc(g.title)}</div><div class="g">${esc(landing[g.slug].tagline)}</div></div>
  </a>`).join('');
  const body = `
<main class="wrap">
  <section style="margin-top:40px">
    <h1>STEPHENS ARCADE</h1>
    <div class="tagline" style="margin:10px 0 4px">Twelve free games. One family. Zero quarters.</div>
    <p>Stephens Arcade is an 8-bit family game system that lives in a web page: every game here was designed and playtested by a dad and his two sons, built with Claude, and ships only when it runs at a smooth 60fps on the Raspberry Pi arcade cabinet in their living room. Play any of them free, right in your browser &mdash; gamepad, keyboard or touch.</p>
  </section>
  <section>
    <h2>THE GAMES</h2>
    <div class="grid">${cards}</div>
  </section>
  <section class="faq">
    <h2>FAQ</h2>
    <dl>
      <dt>Are the games really free?</dt><dd>Completely. No ads, no accounts, no install &mdash; they are the family's own games, shared.</dd>
      <dt>What do I need to play?</dt><dd>Any modern browser. Most games support gamepad, keyboard and touch; several are two-player on one screen.</dd>
      <dt>Who is behind this?</dt><dd>Stephens Arcade is a Q5Labs project by John Stephens and his two sons. The games are born as family design sessions, built with Claude, and playtested hard by a seven-year-old.</dd>
    </dl>
  </section>
</main>`;
  return pageShell({
    title: 'Stephens Arcade — twelve free 8-bit family browser games',
    desc: 'A free 8-bit family arcade: twelve browser games built by a dad and his two sons — RPG, co-op run-and-gun, racing, puzzles and more. Play in any browser.',
    canonical: url, og: `${SITE}/site/og/shatteredsun.png`, jsonld, body,
  });
}

// ---- write everything -----------------------------------------------------
async function main() {
  await buildOgImages();
  for (const g of games) {
    const dir = path.join(ROOT, g.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), gamePage(g));
    console.log('page /', g.slug);
  }
  fs.mkdirSync(path.join(ROOT, 'arcade'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'arcade', 'index.html'), homePage());
  const urls = [`${SITE}/arcade/`, ...games.map(g => `${SITE}/${g.slug}/`)];
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>\n');
  fs.writeFileSync(path.join(ROOT, 'robots.txt'),
    `User-agent: *\nDisallow: /games/\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  fs.writeFileSync(path.join(ROOT, 'humans.txt'),
    `Stephens Arcade — an 8-bit family game system\nBuilt by John Stephens & sons, with Claude\nA Q5Labs project — https://q5labs.co\n`);
  console.log('sitemap + robots + humans written');
}
main().catch(e => { console.error(e); process.exit(1); });
