#!/usr/bin/env node
// Stephens Arcade — headless verification of the Game Factory console overlays.
//
//   node --experimental-websocket scripts/verify-factory.mjs [factoryDir] [--pristine <dir>]
//
// factoryDir defaults to <repo>/factory (already injected by scripts/inject-factory.py).
// --pristine <dir> (optional): an UN-injected copy of Ben's tree; enables the full
// real-corpus determinism check (inject once vs twice -> identical bytes, and equal
// to factoryDir's html when factoryDir was built from the same tree).
//
// Design: docs/game-factory.md, "Agent B — console overlays". It serves the repo root
// with /factory/* mapped to factoryDir, boots headless Chrome (--mute-audio, via
// lib/harness.mjs) with a stubbed standard pad (iframes share the top page's pads, like
// a real pad is shared), runs in console mode (arcade_lowfx=1), and drives:
//   the book: zero console errors, D-pad flips, X opens a game, PS-hold in the game
//     closes it (and does not also leave the book), PS-hold on the book -> /,
//     wormhole window.open -> truthy + / within ~2s;
//   platformer.html (D-pad game): left stick never moves the cursor, right stick does,
//     PS-hold standalone -> /factory/ and the still-held button does not chain to /;
//   cookbook.html (pointer game): both sticks move the cursor, X clicks the element
//     under it, window.print() shows the toast and returns;
//   jigsaw.html: pad-driven picker -> PLAY, then a drag on the board yields
//     mousedown / mousemove(buttons=1) / mouseup on the same element;
//   phantom filter, node --check of every overlay, marker counts, determinism.
// Screenshots: verify-shots/factory-*.png (1280x720). Exit non-zero on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { ROOT, sleep, launchChrome, openPage, extractInlineScripts } from '../lib/harness.mjs';

const args = process.argv.slice(2);
let FACTORY = path.join(ROOT, 'factory'), PRISTINE = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pristine') PRISTINE = path.resolve(args[++i]);
  else FACTORY = path.resolve(args[i]);
}
const SHOTS = path.join(ROOT, 'verify-shots');
const INJECT = path.join(ROOT, 'scripts', 'inject-factory.py');
const OVERLAYS = path.join(ROOT, 'scripts', 'factory-overlays');
const CDP_PORT = 9381;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── static file server: /factory/* -> FACTORY, everything else -> repo root ──
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      let base = ROOT;
      if (p === '/factory' ) { rsp.writeHead(301, { Location: '/factory/' }); rsp.end(); return; }
      if (p.startsWith('/factory/')) { base = FACTORY; p = p.slice('/factory'.length); }
      const file = path.join(base, p);
      if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rsp.writeHead(404); rsp.end(); return; }
      rsp.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      res({ port, url: `http://localhost:${port}`, close: () => new Promise(r => srv.close(r)) });
    });
  });
}

// Injected before page scripts in every frame (after the harness pad stub):
//  - console mode, like the Pi kiosk (the Stephens launcher persists ?fx=low);
//  - child frames share the top page's pad array (one physical pad, seen by both);
//  - optional "button already held when the page loads" (sessionStorage), to prove
//    a hold that left one page never counts on the next.
const PRELUDE = `
try { localStorage.setItem('arcade_lowfx', '1'); } catch (e) {}
try { if (window.parent !== window && window.parent.__pads) window.__pads = window.parent.__pads; } catch (e) {}
try { if (window.parent === window && sessionStorage.getItem('__gfHoldHome') === '1') { window.__press(0, 'home', true); } } catch (e) {}
`;

async function newPage() { return openPage(CDP_PORT, { width: 1280, height: 720, inject: [PRELUDE] }); }
async function tryEval(page, expr) { try { return await page.eval(expr); } catch { return undefined; } }
async function waitFor(page, expr, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (await tryEval(page, expr)) return Date.now() - t0;
    if (Date.now() - t0 > timeout) return -1;
    await sleep(40);
  }
}
const cur = page => page.eval('JSON.stringify(window.__gfCursorState || null)').then(JSON.parse);
const shot = (page, name) => page.screenshot(path.join(SHOTS, `factory-${name}.png`));
const errs = (page, from = 0) => page.errors.slice(from);

// in-page closed-loop steering of the RIGHT stick until the cursor sits on (tx,ty)
const STEER = (tx, ty) => `new Promise(res => { const t0 = performance.now();
  const g = d => Math.abs(d) < 1.5 ? 0 : Math.sign(d) * Math.max(0.3, Math.min(1, Math.abs(d) / 220));
  (function f() { const S = window.__gfCursorState; const dx = ${tx} - S.x, dy = ${ty} - S.y;
    if ((Math.abs(dx) < 3 && Math.abs(dy) < 3) || performance.now() - t0 > 8000) { __axis(0,2,0); __axis(0,3,0); res([Math.round(S.x), Math.round(S.y)]); return; }
    __axis(0,2,g(dx)); __axis(0,3,g(dy)); requestAnimationFrame(f); })(); })`;
// centre of the first visible element matching sel that is hit-testable at its centre
const CENTER = sel => `(() => { for (const el of document.querySelectorAll(${JSON.stringify(sel)})) {
  const r = el.getBoundingClientRect(); if (r.width < 16 || r.height < 16) continue;
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
  const hit = document.elementFromPoint(x, y); if (hit && (hit === el || el.contains(hit))) return [x, y]; }
  return null; })()`;
const EVLOG = `window.__ev = []; ['pointerdown','pointerup','mousedown','mousemove','mouseup','click'].forEach(t =>
  window.addEventListener(t, e => { if (e.isTrusted) return; const n = e.target;
    __ev.push({ t, id: n && n.id || '', tag: n && n.tagName || '', b: e.buttons, x: Math.round(e.clientX), y: Math.round(e.clientY),
      same: !!(window.__evT && window.__evT === n) }); }, true));`;

// ── static checks ────────────────────────────────────────────────────────────
function htmlFiles(dir) { return fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort(); }
function markerCount(html) { return (html.match(/id="__gf_(padfilter|pad_exit|lowfx|print|cursor|idle|book)"/g) || []).length; }
function inject(dir) { return spawnSync('python3', [INJECT, dir], { encoding: 'utf8' }); }
function sameTree(a, b) {
  const fa = htmlFiles(a), fb = htmlFiles(b);
  if (fa.join() !== fb.join()) return 'file lists differ';
  for (const f of fa) if (!fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))) return 'differs: ' + f;
  return '';
}
function copyHtml(src, dst) { fs.mkdirSync(dst, { recursive: true }); for (const f of htmlFiles(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f)); }

function staticChecks() {
  // node --check every overlay script
  let bad = [], n = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-check-'));
  for (const f of fs.readdirSync(OVERLAYS).filter(f => f.endsWith('.html')).sort()) {
    for (const b of extractInlineScripts(fs.readFileSync(path.join(OVERLAYS, f), 'utf8'))) {
      const js = path.join(tmp, `${f}.${b.index}.js`); fs.writeFileSync(js, b.code);
      const r = spawnSync(process.execPath, ['--check', js], { encoding: 'utf8' }); n++;
      if (r.status !== 0) bad.push(f + ': ' + r.stderr.trim().split('\n').pop());
      for (const banned of ['shadowBlur =', 'backdrop-filter:', 'backdropFilter']) if (b.code.includes(banned) && f !== 'low-fx.html') bad.push(`${f}: uses ${banned}`);
    }
  }
  record('overlays: node --check', !bad.length && n === 7, bad.length ? bad.join(' | ') : `${n} overlay scripts OK`);

  // marker counts on the real tree: 6 per game, 7 for index.html / arcade.html
  const files = htmlFiles(FACTORY), wrong = [];
  for (const f of files) {
    const html = fs.readFileSync(path.join(FACTORY, f), 'utf8');
    const want = (f === 'index.html' || f === 'arcade.html') ? 7 : 6;
    const got = markerCount(html);
    if (got !== want) wrong.push(`${f}=${got}`);
    const head = html.indexOf('id="__gf_padfilter"'), tp = html.indexOf('<script src="touchpad.js');
    if (tp >= 0 && !(head >= 0 && head < tp)) wrong.push(`${f}: padfilter not before touchpad.js`);
  }
  record('markers: 6/game, 7/book', files.length > 0 && !wrong.length, wrong.length ? wrong.slice(0, 6).join(', ') : `${files.length} html files`);

  // idempotence on the real tree: re-injecting a copy changes nothing
  const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-idem-'));
  copyHtml(FACTORY, t1);
  const r1 = inject(t1);
  const d1 = r1.status === 0 ? sameTree(FACTORY, t1) : 'injector exit ' + r1.status + ' ' + r1.stderr;
  record('idempotent: re-inject factory/ = no change', !d1, d1 || (r1.stdout.trim().split('\n').pop()));

  // determinism on a synthetic corpus covering every anchor rule
  const syn = {
    'index.html': '<!doctype html>\n<meta charset="utf-8">\n<script>var a=1;</script>\n<script src="touchpad.js?v=2"></script>\n<div id="player"></div>\n',
    'tp-body.html': '<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n<script>TOUCHPAD = { dpad: true };</script>\n<script src="touchpad.js?v=2"></script>\n</head><body>\n<canvas></canvas>\n</body></html>\n',
    'script-only.html': '<!DOCTYPE html>\n<html><body>\n<script>var b=2;</script>\n</body></html>',
    'meta-only.html': '<meta charset="utf-8">\n<title>x</title><p>hi',
    'doctype-only.html': '<!doctype html>\n<title>x</title>',
    'bare.html': '<p>nothing</p>',
  };
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-detA-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-detB-'));
  for (const [f, s] of Object.entries(syn)) { fs.writeFileSync(path.join(a, f), s); fs.writeFileSync(path.join(b, f), s); }
  const ra = inject(a), rb1 = inject(b), rb2 = inject(b);
  let det = [ra, rb1, rb2].some(r => r.status !== 0) ? 'injector failed' : sameTree(a, b);
  const chk = (f, cond, msg) => { if (!det && !cond(fs.readFileSync(path.join(a, f), 'utf8'))) det = `${f}: ${msg}`; };
  chk('index.html', h => markerCount(h) === 7 && h.indexOf('__gf_padfilter') < h.indexOf('<script src="touchpad.js') && h.indexOf('__gf_padfilter') > h.indexOf('var a=1') && h.includes('var IS_BOOK = true;') && !h.includes('__GF_CURSOR_LEFT = true'), 'book anchors/flags');
  chk('tp-body.html', h => markerCount(h) === 6 && h.indexOf('__gf_idle') < h.indexOf('</body>') && !h.includes('__GF_CURSOR_LEFT = true') && !h.includes('IS_BOOK = true'), 'dpad game anchors/flags');
  chk('script-only.html', h => h.indexOf('__gf_padfilter') < h.indexOf('var b=2') && h.includes('__GF_CURSOR_LEFT = true;'), 'before first <script');
  chk('meta-only.html', h => h.startsWith('<meta charset="utf-8">\n<!--') && h.trimEnd().endsWith('</script>'), 'after meta charset / appended at end');
  chk('doctype-only.html', h => h.startsWith('<!doctype html>\n<!--'), 'after doctype');
  chk('bare.html', h => markerCount(h) === 6, 'prepend fallback');
  record('deterministic: inject once == inject twice (synthetic anchors)', !det, det || '6 anchor cases');

  if (PRISTINE) {
    const p1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-p1-')), p2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-p2-'));
    copyHtml(PRISTINE, p1); copyHtml(PRISTINE, p2);
    const s = [inject(p1), inject(p2), inject(p2)];
    let d = s.some(r => r.status !== 0) ? 'injector failed' : sameTree(p1, p2);
    const vsFactory = d ? '' : sameTree(p1, FACTORY);
    record('deterministic: real corpus once == twice', !d, d || `${htmlFiles(p1).length} files byte-identical` +
      (vsFactory ? ` (factory/ differs from pristine+inject: ${vsFactory} — e.g. three.js rewrite)` : ', == factory/'));
  }
}

// ── the book ─────────────────────────────────────────────────────────────────
async function testBook(base) {
  const page = await newPage();
  try {
    await page.nav(`${base}/factory/`);
    await sleep(1200);
    const info = await page.eval(`({ title: document.title, hub: !!window.__gfHub, filt: !!navigator.__gfPadFilter, cur: typeof cur !== 'undefined' ? cur : null,
      lowfx: (() => { const c = document.createElement('canvas').getContext('2d'); c.shadowBlur = 9; return c.shadowBlur === 0; })() })`);
    record('book: loads, 0 console errors', info.hub && info.filt && /Game Factory/.test(info.title) && !page.errors.length,
      page.errors.length ? page.errors.slice(0, 3).join(' | ') : `title "${info.title}", overlays live, shadowBlur no-op=${info.lowfx}`);

    await page.connectPad(0); await sleep(200);
    const c0 = await page.eval('cur');
    await page.pressPad('right', 150);
    const flipMs = await waitFor(page, `cur === ${c0 + 1}`, 3000);
    record('book: pad D-pad right flips a page', flipMs >= 0, `cur ${c0} -> ${await page.eval('cur')}`);

    for (let i = 0; i < 4 && (await page.eval('cur')) < 2; i++) { await sleep(800); await page.pressPad('right', 150); await waitFor(page, 'cur >= 2 && !busy', 3000); }
    await sleep(300);
    const gi = await page.eval('cur - 2');
    const gfile = await page.eval(`GAMES[${gi}] && GAMES[${gi}].file`);
    await page.pressPad('south', 150);
    const openMs = await waitFor(page, `document.getElementById('player').classList.contains('open') && !!document.querySelector('#player iframe')`, 3000);
    record('book: X on a game page opens the iframe', openMs >= 0, `page ${gi + 2} -> ${gfile}`);
    if (openMs < 0) return;

    const IF = `document.querySelector('#player iframe').contentWindow`;
    await waitFor(page, `${IF}.document.readyState === 'complete' && !!${IF}.__gfHub`, 8000);
    await sleep(800);
    const ifr = await page.eval(`({ stub: typeof ${IF}.__connectPad === 'function', shared: ${IF}.__pads === window.__pads,
      markers: ${IF}.document.querySelectorAll('script[id^="__gf_"]').length })`);
    record('harness: addScriptToEvaluateOnNewDocument reaches the game iframe', ifr.stub && ifr.shared, `stub=${ifr.stub} sharedPads=${ifr.shared} overlays in iframe=${ifr.markers}`);
    await page.eval(`${IF}.dispatchEvent(new Event('gamepadconnected'))`);
    // move the in-game cursor so the shot shows it (right stick)
    await page.axisPad(2, 0.7); await page.axisPad(3, 0.35); await sleep(350); await page.axisPad(2, 0); await page.axisPad(3, 0);
    const inGameCur = await page.eval(`JSON.stringify(${IF}.__gfCursorState)`).then(JSON.parse);
    const bookCurHidden = await page.eval(`!window.__gfCursorState || !window.__gfCursorState.awake`);

    // PS hold inside the game: closes it after ~1s; the same hold must not then leave the book
    const errBefore = page.errors.length;
    const t0 = Date.now();
    await page.eval(`__press(0,'home',true)`);
    await sleep(550);
    await shot(page, 'book-game-exit');
    const badge = await page.eval(`(() => { const b = ${IF}.document.getElementById('__gfx_exit'); return b ? b.textContent + '|' + getComputedStyle(b).opacity : null; })()`).catch(() => null);
    const closeMs = await waitFor(page, `!document.getElementById('player').classList.contains('open') && !document.querySelector('#player iframe')`, 3000);
    const heldFor = Date.now() - t0;
    await sleep(Math.max(0, 2600 - (Date.now() - t0)));
    const stayed = await page.eval(`location.pathname`);
    await page.eval(`__press(0,'home',false)`);
    await sleep(400);
    const stayed2 = await page.eval(`location.pathname`);
    record('book: PS held 1.1s in the game closes it (iframe removed)', closeMs >= 0 && heldFor >= 1000,
      `closed after ~${heldFor}ms of hold; in-game badge "${badge}"; in-game cursor moved to ${Math.round(inGameCur.x)},${Math.round(inGameCur.y)}; book cursor hidden=${bookCurHidden}`);
    record('book: the closing hold does not also leave the book', stayed === '/factory/' && stayed2 === '/factory/', `held 2.6s total, still at ${stayed2}`);

    // cursor on the book + screenshot
    await page.axisPad(2, 0.8); await page.axisPad(3, -0.45); await sleep(450); await page.axisPad(2, 0); await page.axisPad(3, 0);
    await sleep(150);
    const bc = await cur(page);
    await shot(page, 'book');
    record('book: right stick wakes the cursor', bc && bc.awake, bc ? `cursor at ${Math.round(bc.x)},${Math.round(bc.y)}` : 'no cursor');

    // PS hold on the book (no game open) -> /
    const bookErrs = errs(page);
    record('book: 0 console errors through the whole drive', !bookErrs.length && page.errors.length === errBefore + 0, bookErrs.slice(0, 3).join(' | ') || 'clean');
    const t1 = Date.now();
    await page.eval(`__press(0,'home',true)`);
    await sleep(550);
    await shot(page, 'book-exit');
    const navMs = await waitFor(page, `location.pathname === '/'`, 3000);
    record('book: PS held with no game open -> /', navMs >= 0, `left after ~${Date.now() - t1}ms`);
  } finally { await page.close(); }
}

async function testWormhole(base) {
  const page = await newPage();
  try {
    await page.nav(`${base}/factory/`);
    await sleep(600);
    const other = await page.eval(`window.open('https://example.com/popup', '_blank') === null`);
    const t0 = Date.now();
    const truthy = await page.eval(`!!window.open('https://ses.q5labs.co', '_blank')`);
    const ms = await waitFor(page, `location.pathname === '/'`, 3000);
    record('book: wormhole window.open -> truthy, / within ~2s', truthy && ms >= 0 && other, `truthy=${truthy}, other URLs -> null: ${other}, navigated after ${Date.now() - t0}ms`);
  } finally { await page.close(); }
  // Ben's real code path (jumpWormhole plays its whoosh, then show(cur)) — must not throw
  const p2 = await newPage();
  try {
    await p2.nav(`${base}/factory/`);
    await sleep(600);
    const has = await p2.eval(`typeof jumpWormhole === 'function'`);
    if (has) await p2.eval(`jumpWormhole(document.createElement('div')), 1`);
    const ms = has ? await waitFor(p2, `location.pathname === '/'`, 3500) : -1;
    const e = p2.errors.filter(x => !/\/index\.html|localhost:\d+\/(?!factory)/.test(x));
    record("book: Ben's jumpWormhole() -> / (no errors)", has && ms >= 0 && !e.length, has ? `navigated; ${e.length ? e.join(' | ') : 'clean'}` : 'jumpWormhole not found');
  } finally { await p2.close(); }
}

// ── platformer.html: D-pad game ──────────────────────────────────────────────
async function testPlatformer(base) {
  const page = await newPage();
  try {
    await page.nav(`${base}/factory/platformer.html`);
    await sleep(600);
    await page.connectPad(0); await sleep(250);
    await page.eval(`window.__keys = []; document.addEventListener('keydown', e => __keys.push(e.key), true)`);
    const s0 = await cur(page);
    await page.axisPad(0, 1); await sleep(500); await page.axisPad(0, 0); await sleep(100);
    const s1 = await cur(page);
    const keys = await page.eval('__keys.join(",")');
    record('platformer: left stick does NOT move the cursor (still drives the game)', s0.installed && s1.x === s0.x && s1.y === s0.y && !s1.awake && keys.includes('ArrowRight'),
      `cursor ${s0.x},${s0.y} -> ${s1.x},${s1.y}, awake=${s1.awake}; touchpad.js still got: ${[...new Set(keys.split(','))].join(' ')}`);
    await page.axisPad(2, 1); await page.axisPad(3, -0.5); await sleep(400); await page.axisPad(2, 0); await page.axisPad(3, 0); await sleep(80);
    const s2 = await cur(page);
    record('platformer: right stick moves the cursor', s2.awake && s2.x - s1.x > 150, `${Math.round(s1.x)} -> ${Math.round(s2.x)} px in 0.4s`);
    await shot(page, 'platformer');

    // phantom DualShock sub-devices are nulled, indices kept
    const ph = await page.eval(`(() => {
      __pads[1] = { index: 1, id: 'Wireless Controller Motion Sensors', connected: true, mapping: '', axes: [0,0,0,0,0,0], buttons: [] };
      __pads[2] = { index: 2, id: 'Sony Wireless Controller Touchpad', connected: true, mapping: '', axes: [0,0], buttons: [{pressed:true,value:1}] };
      __pads[3] = { index: 3, id: 'Generic HID (non-standard)', connected: true, mapping: '', axes: [0,0], buttons: [] };
      const g = navigator.getGamepads(); const out = [g.length, !!g[0] && g[0].id, g[1], g[2], g[3]];
      __pads[1] = __pads[2] = __pads[3] = null; return JSON.stringify(out); })()`).then(JSON.parse);
    record('padfilter: "Wireless Controller Motion Sensors" nulled', ph[0] === 4 && ph[1] === 'Stub Standard Pad' && ph[2] === null && ph[3] === null && ph[4] === null,
      `getGamepads() -> [${ph.map(v => v === null ? 'null' : JSON.stringify(v)).join(', ')}]`);

    const errBefore = page.errors.length;
    record('platformer: 0 console errors', !errBefore, page.errors.slice(0, 3).join(' | ') || 'clean');

    // standalone PS hold -> /factory/; the still-held PS must not chain the book to /
    await page.eval(`sessionStorage.setItem('__gfHoldHome', '1'); __press(0,'home',true)`);
    const t0 = Date.now();
    const ms = await waitFor(page, `location.pathname === '/factory/'`, 3000);
    await waitFor(page, `document.readyState === 'complete' && !!window.__gfHub`, 5000);
    const held = await tryEval(page, `window.__pads[0] && window.__pads[0].buttons[16].pressed`);
    await sleep(1600);
    const still = await tryEval(page, 'location.pathname');
    await tryEval(page, `sessionStorage.removeItem('__gfHoldHome'); __press(0,'home',false)`);
    record('platformer: PS hold standalone -> /factory/ (no chain to /)', ms >= 0 && held === true && still === '/factory/',
      `book reached after ~${Date.now() - t0 - 1600}ms; PS still held on the book for 1.6s -> stayed at ${still}`);
  } finally { await page.close(); }
}

// ── cookbook.html: pointer game ──────────────────────────────────────────────
async function testCookbook(base) {
  const page = await newPage();
  try {
    await page.nav(`${base}/factory/cookbook.html`);
    await sleep(700);
    await page.connectPad(0); await sleep(250);
    const s0 = await cur(page);
    await page.axisPad(0, -1); await sleep(300); await page.axisPad(0, 0); await sleep(60);
    const s1 = await cur(page);
    await page.axisPad(3, 1); await sleep(250); await page.axisPad(3, 0); await sleep(60);
    const s2 = await cur(page);
    record('cookbook: left AND right stick move the cursor', s1.x < s0.x - 100 && s2.y > s1.y + 80, `left stick x ${Math.round(s0.x)}->${Math.round(s1.x)}, right stick y ${Math.round(s1.y)}->${Math.round(s2.y)}`);

    const tgt = await page.eval(CENTER('button, [onclick], .card, .recipe, [data-r], [data-i], a'));
    let clickOk = false, detail = 'no clickable element found';
    if (tgt) {
      const at = await page.eval(STEER(tgt[0], tgt[1]));
      await page.eval(`${EVLOG} window.__evT = document.elementFromPoint(${at[0]}, ${at[1]}); window.__before = document.body.innerHTML.length + ':' + document.querySelectorAll('*').length; 1`);
      await shot(page, 'cookbook');
      const desc = await page.eval(`(__evT.tagName + (__evT.id ? '#' + __evT.id : '') + ' "' + (__evT.textContent || '').trim().slice(0, 24) + '"')`);
      await page.pressPad('south', 120); await sleep(400);
      const ev = await page.eval('JSON.stringify(__ev.filter(e => e.t !== "mousemove" || e.b))').then(JSON.parse);
      const seq = ev.map(e => e.t).join('>');
      const click = ev.find(e => e.t === 'click');
      const after = await page.eval(`document.body.innerHTML.length + ':' + document.querySelectorAll('*').length`);
      const before = await page.eval('__before');
      clickOk = !!click && click.same && Math.abs(click.x - at[0]) <= 1 && Math.abs(click.y - at[1]) <= 1 && seq.startsWith('pointerdown>mousedown>pointerup>mouseup>click');
      detail = `steered to ${at} on ${desc}; events ${seq}; page ${before === after ? 'unchanged' : 'changed (the click did something)'}`;
    }
    await sleep(150);
    record('cookbook: X dispatches click at the cursor', clickOk, detail);

    const pr = await page.eval(`(() => { const t0 = performance.now(); const r = window.print(); const dt = performance.now() - t0;
      const el = document.getElementById('__gfx_print'); return JSON.stringify({ ret: r === undefined, dt, text: el && el.textContent }); })()`).then(JSON.parse);
    await sleep(300);
    const vis = await page.eval(`getComputedStyle(document.getElementById('__gfx_print')).opacity`);
    await shot(page, 'cookbook-print');
    await sleep(2600);
    const gone = await page.eval(`getComputedStyle(document.getElementById('__gfx_print')).opacity`);
    record('cookbook: window.print() -> toast, returns', pr.ret && pr.dt < 50 && /Printing works on the iPad/.test(pr.text) && vis === '1' && gone === '0',
      `"${pr.text}" visible=${vis}, gone after 2.5s=${gone === '0'}, returned in ${pr.dt.toFixed(1)}ms`);
    record('cookbook: 0 console errors', !page.errors.length, page.errors.slice(0, 3).join(' | ') || 'clean');
  } finally { await page.close(); }
}

// ── jigsaw.html: drag ────────────────────────────────────────────────────────
async function clickAt(page, sel) {
  const c = await page.eval(CENTER(sel));
  if (!c) return false;
  await page.eval(STEER(c[0], c[1]));
  await page.pressPad('south', 110); await sleep(350);
  return true;
}
async function testJigsaw(base) {
  const page = await newPage();
  try {
    await page.nav(`${base}/factory/jigsaw.html`);
    await sleep(700);
    await page.connectPad(0); await sleep(250);
    // pad-only: pick the first picture, then PLAY (Enter from ✕ may also act; that is Ben's mapping)
    await clickAt(page, '#grid > *');
    await waitFor(page, `document.getElementById('setup').classList.contains('on') || document.getElementById('play').classList.contains('on')`, 2000);
    if (await page.eval(`document.getElementById('setup').classList.contains('on')`)) await clickAt(page, '#sPlay');
    const inPlay = await waitFor(page, `document.getElementById('play').classList.contains('on')`, 2000) >= 0;
    await sleep(500);
    // aim at the top-most loose piece (Ben's game state) so the drag really moves a piece
    const r = await page.eval(`(() => { const b = document.getElementById('board').getBoundingClientRect();
      if (typeof game !== 'undefined' && game && game.pos && game.z) { for (let k = game.z.length - 1; k >= 0; k--) { const i = game.z[k], p = game.pos[i];
        if (p.placed) continue; const x = Math.round(b.left + view.bx + (p.x + game.pz.cw / 2) * view.k), y = Math.round(b.top + view.by + (p.y + game.pz.ch / 2) * view.k);
        if (x > 40 && x < innerWidth - 300 && y > 80 && y < innerHeight - 140) { window.__piece = i; window.__p0 = [p.x, p.y]; return [x, y]; } } }
      return [Math.round(b.left + b.width * 0.15), Math.round(b.top + b.height * 0.5)]; })()`);
    await page.eval(STEER(r[0], r[1]));
    await page.eval(`${EVLOG} window.__evT = document.elementFromPoint(${r[0]}, ${r[1]}); 1`);
    await page.eval(`__press(0,'south',true)`); await sleep(120);
    await page.axisPad(2, 0.8); await page.axisPad(3, -0.3); await sleep(350); await page.axisPad(2, 0); await page.axisPad(3, 0);
    await sleep(80);
    await shot(page, 'jigsaw');
    await page.eval(`__press(0,'south',false)`); await sleep(200);
    const ev = await page.eval('JSON.stringify(__ev)').then(JSON.parse);
    const moved = await page.eval(`window.__piece === undefined ? 'no piece aimed' : (() => { const p = game.pos[__piece]; return 'piece #' + __piece + ' moved ' + Math.round(Math.hypot(p.x - __p0[0], p.y - __p0[1])) + ' units' + (p.placed ? ' (snapped)' : ''); })()`);
    const md = ev.find(e => e.t === 'mousedown'), mu = ev.find(e => e.t === 'mouseup');
    const drags = ev.filter(e => e.t === 'mousemove' && e.b === 1);
    const ok = inPlay && md && mu && md.same && mu.same && drags.length >= 3 && drags.every(e => e.same) && !ev.some(e => e.t === 'click')
      && ev.indexOf(md) < ev.indexOf(drags[0]) && ev.indexOf(drags[drags.length - 1]) < ev.indexOf(mu);
    record('jigsaw: drag = mousedown / mousemove(b=1) / mouseup on one element', ok,
      `in play=${inPlay}; ${moved}; target ${md ? md.tag + '#' + md.id : '?'}; mousedown@${md && md.x},${md && md.y} -> ${drags.length} drag moves -> mouseup@${mu && mu.x},${mu && mu.y}; click=${ev.some(e => e.t === 'click')}`);
    record('jigsaw: 0 console errors', !page.errors.length, page.errors.slice(0, 3).join(' | ') || 'clean');
  } finally { await page.close(); }
}

// ── idle return (test override ?idle=10 -> 10 s) ────────────────────────────
async function testIdle(base) {
  const page = await newPage();
  try {
    await page.nav(`${base}/factory/duo.html?idle=10`);
    const t0 = Date.now();
    const ms = await waitFor(page, `location.pathname === '/'`, 14000);
    record('idle: ?idle=10 standalone -> / after ~10s', ms >= 0 && Date.now() - t0 >= 9000, `left after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally { await page.close(); }
}

async function main() {
  if (!fs.existsSync(path.join(FACTORY, 'index.html'))) { console.error(`no ${FACTORY}/index.html — build factory/ first (scripts/bundle-factory.sh)`); process.exit(2); }
  console.log(`verify-factory: ${FACTORY}${PRISTINE ? '  (pristine: ' + PRISTINE + ')' : ''}`);
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\n── static');
  staticChecks();
  const srv = await serve();
  const chrome = await launchChrome({ port: CDP_PORT });   // harness passes --mute-audio
  try {
    for (const [name, fn] of [['book', testBook], ['wormhole', testWormhole], ['platformer.html', testPlatformer], ['cookbook.html', testCookbook], ['jigsaw.html', testJigsaw], ['idle', testIdle]]) {
      console.log(`\n── ${name}`);
      try { await fn(srv.url); } catch (e) { record(`${name}: drive threw`, false, e.message); }
    }
  } finally { chrome.kill(); await srv.close(); }

  const W = Math.max(...results.map(r => r.name.length)) + 2;
  console.log('\n' + '='.repeat(W + 8));
  console.log('CHECK'.padEnd(W) + 'RESULT');
  console.log('-'.repeat(W + 8));
  for (const r of results) console.log(r.name.padEnd(W) + (r.ok ? 'PASS' : 'FAIL'));
  console.log('-'.repeat(W + 8));
  const fails = results.filter(r => !r.ok);
  console.log(`${results.length - fails.length}/${results.length} passed; screenshots: verify-shots/factory-*.png`);
  if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log(`  ${f.name}: ${f.detail}`); }
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
