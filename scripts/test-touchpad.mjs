#!/usr/bin/env node
// Verification harness for the lib/controller.js virtual touch gamepad
// (touchpad-v1). Serves this repo over localhost, boots headless Chrome with
// touch emulation at iPad-landscape 1180x820, and — because bundled games
// reference https://ses.q5labs.co/lib/controller.js absolutely — intercepts
// that request via CDP Fetch and fulfills it with the LOCAL lib/controller.js
// so the new code is tested against the real bundles.
//
// Suites:
//   1. per-game basics (all games/): no overlay before touch, engage on tap
//      (except the ghost-patrol / scream-rocket skip list), stick axes + dpad
//      synthesis, south press events + justPressed, stick+button multitouch
//   2. keyboard-only regression: overlay never appears
//   3. stubbed physical pad: overlay refuses to engage, fake pad owns pad(0)
//   4. displacement: physical pad connecting mid-session evicts the synthetic
//      pad from logical slot 0 the same tick
//   5. deep smokes via ONLY the overlay: powder-peak (title→run→steer→pause→
//      resume), island-forge (title→name→play→walk), nyan-cat-racing
//      (title→garage→race→mash; garage confirm proven via its localStorage
//      write — its race state lives in a closure)
//   6. shell: ARCADE_NO_TOUCHPAD keeps the launcher overlay-free
//   7. screenshots (landscape + portrait) for 4 games, saved for human review
//
// Run: /Users/johnstephens/.local/node/bin/node --experimental-websocket \
//        scripts/test-touchpad.mjs [suite-filter]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8941, CDP_PORT = 9341;
const SHOTS = '/Users/johnstephens/.claude/jobs/03098481/tmp/touchpad-shots';
const CONTROLLER_JS = fs.readFileSync(path.join(ROOT, 'lib', 'controller.js'), 'utf8');
const SKIP = new Set(['ghost-patrol', 'scream-rocket']);
const GAMES = fs.readdirSync(path.join(ROOT, 'games'))
  .filter(d => fs.existsSync(path.join(ROOT, 'games', d, 'index.html')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];   // { name, ok, detail }
let curName = '';

function ok(cond, what) {
  if (!cond) throw new Error('ASSERT: ' + what);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
function serveRepo() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
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
    let id = 0; const pending = new Map(); const handlers = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      on(method, fn) { handlers.set(method, fn); },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method && handlers.has(m.method)) {
        try { handlers.get(m.method)(m.params); } catch (e) { console.error('handler', e); }
      }
    };
  });
}

// Fake standard-mapping physical pad, installed before page scripts. The stub
// reads window.__fakeOn each call so tests can plug/unplug it at runtime, and
// a defineProperty trap on window.ArcadeController records connect/disconnect
// events from the REAL library (no game-side hooks).
const FAKE_PAD_STUB = (initiallyOn) => `
window.__fakeOn = ${initiallyOn};
window.__connects = [];
(function () {
  var fake = { index: 0, id: 'Fake DS4', connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, function () { return { pressed: false, value: 0, touched: false }; }),
    timestamp: 0 };
  navigator.getGamepads = function () { return window.__fakeOn ? [fake] : []; };
  var ac;
  Object.defineProperty(window, 'ArcadeController', { configurable: true,
    get: function () { return ac; },
    set: function (v) {
      ac = v;
      try {
        v.on('connect', function (e) { window.__connects.push({ ev: 'connect', padIndex: e.padIndex, id: e.id }); });
        v.on('disconnect', function (e) { window.__connects.push({ ev: 'disconnect', padIndex: e.padIndex }); });
      } catch (err) {}
    } });
})();`;

const PRESS_PROBE = `
window.__pressLog = window.__pressLog || [];
window.__sawJP = false;
if (window.ArcadeController) {
  ArcadeController.on('press', e => window.__pressLog.push(e.button));
  (function lp() {
    if (ArcadeController.pad(0).justPressed('south')) window.__sawJP = true;
    requestAnimationFrame(lp);
  })();
}`;

async function openTab({ width = 1180, height = 820, stub = null } = {}) {
  const r = await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await r.json();
  const c = await connect(target.webSocketDebuggerUrl);
  const errors = [];
  c.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error') errors.push('console.error: ' + p.args.map(a => a.value ?? a.description ?? '').join(' '));
  });
  c.on('Runtime.exceptionThrown', p => {
    errors.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  });
  c.on('Log.entryAdded', p => {
    // network-source entries are resource-load noise (GA offline etc.), not game errors
    if (p.entry.level === 'error' && p.entry.source !== 'network') errors.push('log: ' + p.entry.text);
  });
  c.on('Fetch.requestPaused', async p => {
    try {
      await c.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' },
                          { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(CONTROLLER_JS).toString('base64'),
      });
    } catch (e) { /* tab closing */ }
  });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Fetch.enable', { patterns: [{ urlPattern: '*controller.js*' }] });
  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await c.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  if (stub) await c.send('Page.addScriptToEvaluateOnNewDocument', { source: stub });

  let loaded;
  const loadedP = new Promise(r => { loaded = r; });
  c.on('Page.loadEventFired', () => loaded());

  const tab = {
    c, errors, target,
    async nav(url) {
      await c.send('Page.navigate', { url });
      await Promise.race([loadedP, sleep(15000)]);
      await tab.ev('new Promise(r => { let n = 0; (function f(){ if (++n >= 5) r(1); else requestAnimationFrame(f); })(); })');
    },
    async ev(expr) {
      const r2 = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 10000 });
      if (r2.exceptionDetails) throw new Error('eval failed: ' + (r2.exceptionDetails.exception?.description || r2.exceptionDetails.text));
      return r2.result.value;
    },
    async waitFor(expr, what, timeout = 4000) {
      const t0 = Date.now();
      for (;;) {
        if (await tab.ev(expr)) return;
        if (Date.now() - t0 > timeout) throw new Error('TIMEOUT waiting for ' + what + ' (' + expr.slice(0, 120) + ')');
        await sleep(60);
      }
    },
    // multi-touch session: active points tracked by id, CDP gets ALL active
    // points each event (that is the protocol contract).
    points: new Map(),
    dispatch(type) {
      const touchPoints = [...tab.points.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id }));
      return c.send('Input.dispatchTouchEvent', { type, touchPoints });
    },
    async tStart(id, x, y) { tab.points.set(id, { x, y }); await tab.dispatch('touchStart'); },
    async tMove(id, x, y) { tab.points.set(id, { x, y }); await tab.dispatch('touchMove'); },
    async tEnd(id) { tab.points.delete(id); await tab.dispatch('touchEnd'); },
    async tap(x, y, hold = 110) { await tab.tStart(7, x, y); await sleep(hold); await tab.tEnd(7); },
    async key(key, code, vk) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(60);
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    },
    async rectCenter(sel) {
      const r2 = await tab.ev(`(function(){ const el = document.querySelector('${sel}'); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      ok(r2, sel + ' exists');
      return r2;
    },
    async shot(file) {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    },
    assertNoErrors(stage) {
      ok(errors.length === 0, `zero console errors ${stage} — got: ${errors.slice(0, 3).join(' | ')}`);
    },
    async close() { c.close(); try { await fetch(`http://localhost:${CDP_PORT}/json/close/${target.id}`); } catch (e) {} },
  };
  return tab;
}

async function run(name, fn) {
  curName = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log('FAIL', name, '—', e.message);
  }
}

const OVERLAY = `!!document.getElementById('__arcade_touchpad')`;
const OVERLAY_VISIBLE = `(function(){ const o = document.getElementById('__arcade_touchpad'); return !!o && o.style.display !== 'none'; })()`;
const PAD0 = `(window.ArcadeController && ArcadeController.pad(0).connected) === true`;

// engage the overlay in a fresh tab: neutral center tap, then wait for the pad
async function engage(tab) {
  ok(!(await tab.ev(OVERLAY)), 'no overlay before any touch');
  await tab.ev(PRESS_PROBE);
  await tab.tap(590, 410);
  await tab.waitFor(OVERLAY_VISIBLE, 'overlay visible');
  await tab.waitFor(PAD0, 'pad(0) connected');
  await tab.waitFor(`document.body.classList.contains('input-pad')`, 'body.input-pad');
}

async function driveStick(tab) {
  const base = await tab.rectCenter('#__atp-base');
  const S = 8; // stick touch id
  const checks = [
    [-70, 0, `ArcadeController.pad(0).axis('lx') < -0.85 && ArcadeController.pad(0).button('left')`, 'stick left'],
    [70, 0, `ArcadeController.pad(0).axis('lx') > 0.85 && ArcadeController.pad(0).button('right') && !ArcadeController.pad(0).button('left')`, 'stick right'],
    [0, -70, `ArcadeController.pad(0).axis('ly') < -0.85 && ArcadeController.pad(0).button('up') && !ArcadeController.pad(0).button('right')`, 'stick up'],
    [0, 70, `ArcadeController.pad(0).axis('ly') > 0.85 && ArcadeController.pad(0).button('down') && !ArcadeController.pad(0).button('up')`, 'stick down'],
  ];
  await tab.tStart(S, base.x, base.y);
  for (const [dx, dy, expr, what] of checks) {
    await tab.tMove(S, base.x + dx, base.y + dy);
    await tab.waitFor(expr, what);
  }
  await tab.tEnd(S);
  await tab.waitFor(`ArcadeController.pad(0).axis('lx') === 0 && ArcadeController.pad(0).axis('ly') === 0 && !ArcadeController.pad(0).button('down')`, 'stick released');
}

async function tapSouth(tab) {
  const s = await tab.rectCenter('#__atp-s');
  const before = await tab.ev('window.__pressLog.length');
  await tab.tap(s.x, s.y);
  await tab.waitFor(`window.__pressLog.slice(${before}).includes('south')`, 'south press event');
  await tab.waitFor('window.__sawJP === true', 'justPressed(south) observed');
}

// jump+shoot: stick held left while south taps — both must register
async function multiTouch(tab) {
  const base = await tab.rectCenter('#__atp-base');
  const s = await tab.rectCenter('#__atp-s');
  await tab.tStart(8, base.x, base.y);
  await tab.tMove(8, base.x - 70, base.y);
  await tab.waitFor(`ArcadeController.pad(0).button('left')`, 'left held');
  const before = await tab.ev('window.__pressLog.length');
  await tab.tStart(9, s.x, s.y);
  await sleep(120);
  await tab.waitFor(`ArcadeController.pad(0).button('left') && ArcadeController.pad(0).button('south')`, 'left + south simultaneously');
  await tab.tEnd(9);
  await tab.tEnd(8);
  await tab.waitFor(`window.__pressLog.slice(${before}).includes('south')`, 'south press during stick hold');
}

async function suiteBasics() {
  for (const slug of GAMES) {
    await run(`basic ${slug}`, async () => {
      const tab = await openTab();
      try {
        await tab.nav(`http://localhost:${HTTP_PORT}/games/${slug}/`);
        await sleep(400);
        ok(!(await tab.ev(OVERLAY)), 'no overlay before any touch');
        await tab.ev(PRESS_PROBE);
        await tab.tap(590, 410);
        if (SKIP.has(slug)) {
          await sleep(600);
          ok(!(await tab.ev(OVERLAY)), 'overlay must NOT appear (skip list)');
        } else {
          await tab.waitFor(OVERLAY_VISIBLE, 'overlay visible');
          await tab.waitFor(PAD0, 'pad(0) connected');
          await tab.waitFor(`document.body.classList.contains('input-pad')`, 'body.input-pad');
          await driveStick(tab);
          await tapSouth(tab);
          await multiTouch(tab);
        }
        tab.assertNoErrors('at end');
      } finally { await tab.close(); }
    });
  }
}

async function suiteKeyboard() {
  for (const slug of GAMES) {
    await run(`keyboard ${slug}`, async () => {
      const tab = await openTab();
      try {
        await tab.nav(`http://localhost:${HTTP_PORT}/games/${slug}/`);
        await tab.key('ArrowRight', 'ArrowRight', 39);
        await tab.key('ArrowLeft', 'ArrowLeft', 37);
        await tab.key('Enter', 'Enter', 13);
        await tab.key(' ', 'Space', 32);
        await tab.key('ArrowUp', 'ArrowUp', 38);
        await sleep(600);
        ok(!(await tab.ev(OVERLAY)), 'no overlay after keyboard-only input');
        tab.assertNoErrors('after keys');
      } finally { await tab.close(); }
    });
  }
}

async function suiteFakePad() {
  for (const slug of GAMES) {
    await run(`fakepad ${slug}`, async () => {
      const tab = await openTab({ stub: FAKE_PAD_STUB(true) });
      try {
        await tab.nav(`http://localhost:${HTTP_PORT}/games/${slug}/`);
        await tab.waitFor(PAD0, 'fake pad claims pad(0)');
        await tab.tap(590, 410);
        await sleep(600);
        ok(!(await tab.ev(OVERLAY)), 'overlay must NOT engage with a physical pad connected');
        const connects = await tab.ev('window.__connects');
        ok(connects.some(e => e.ev === 'connect' && e.id === 'Fake DS4' && e.padIndex === 0), 'Fake DS4 connected at logical 0');
        ok(!connects.some(e => e.id === 'Arcade Touch Pad'), 'synthetic pad never connected');
        tab.assertNoErrors('at end');
      } finally { await tab.close(); }
    });
  }
}

async function suiteDisplacement() {
  await run('displacement hiss-and-run', async () => {
    const tab = await openTab({ stub: FAKE_PAD_STUB(false) });
    try {
      await tab.nav(`http://localhost:${HTTP_PORT}/games/hiss-and-run/`);
      await tab.tap(590, 410);
      await tab.waitFor(OVERLAY_VISIBLE, 'overlay engaged');
      await tab.waitFor(PAD0, 'synthetic pad at logical 0');
      let connects = await tab.ev('window.__connects');
      ok(connects.some(e => e.ev === 'connect' && e.id === 'Arcade Touch Pad' && e.padIndex === 0), 'touch pad took logical 0');
      // plug in the physical pad
      await tab.ev('window.__fakeOn = true');
      await tab.waitFor(`!${OVERLAY_VISIBLE}`, 'overlay hidden after physical connect', 2000);
      await tab.waitFor(PAD0, 'pad(0) still connected (now physical)');
      connects = await tab.ev('window.__connects');
      const last = connects[connects.length - 1];
      ok(last.ev === 'connect' && last.id === 'Fake DS4' && last.padIndex === 0, 'physical pad took logical 0 (not stuck at 1) — got ' + JSON.stringify(last));
      ok(connects.some(e => e.ev === 'disconnect' && e.padIndex === 0), 'synthetic pad freed slot 0 with a disconnect');
      tab.assertNoErrors('at end');
    } finally { await tab.close(); }
  });
}

async function suiteShell() {
  await run('shell launcher (ARCADE_NO_TOUCHPAD)', async () => {
    const tab = await openTab();
    try {
      await tab.nav(`http://localhost:${HTTP_PORT}/`);
      ok(await tab.ev('window.ARCADE_NO_TOUCHPAD === true'), 'shell sets ARCADE_NO_TOUCHPAD');
      await tab.tap(590, 100);
      await tab.tap(60, 620);
      await sleep(700);
      ok(!(await tab.ev(OVERLAY)), 'no overlay on the launcher');
      tab.assertNoErrors('at end');
    } finally { await tab.close(); }
  });
}

// hold the stick in a direction for ms, via a live touch session
async function holdStick(tab, dx, dy, ms) {
  const base = await tab.rectCenter('#__atp-base');
  await tab.tStart(8, base.x, base.y);
  await tab.tMove(8, base.x + dx, base.y + dy);
  await sleep(ms);
  await tab.tEnd(8);
}

async function tapButton(tab, sel, hold = 130) {
  const p = await tab.rectCenter(sel);
  await tab.tap(p.x, p.y, hold);
}

async function suiteDeep() {
  await run('deep powder-peak', async () => {
    const tab = await openTab();
    try {
      await tab.nav(`http://localhost:${HTTP_PORT}/games/powder-peak/`);
      await engage(tab);
      // Its game code is IIFE-wrapped, but setBodyState mirrors every state
      // to body classes (st-title/st-select/st-count/st-run/st-pause) — that
      // is the DOM-observable we assert on. NOTE: it also has a window-level
      // "tap anywhere = confirm on title", so the engage tap itself may
      // already have advanced title → select.
      const cls = c => `document.body.classList.contains('${c}')`;
      await tab.waitFor(`${cls('st-title')} || ${cls('st-select')}`, 'powder-peak title/select', 8000);
      if (await tab.ev(cls('st-title'))) await tapButton(tab, '#__atp-s');
      await tab.waitFor(cls('st-select'), 'mountain select', 5000);
      await tapButton(tab, '#__atp-s');
      await tab.waitFor(cls('st-count'), 'countdown', 5000);
      await tab.waitFor(cls('st-run'), 'run started', 8000);
      // steer both directions mid-run: hold the stick and assert the axis the
      // game polls, while the run stays alive (skier position is closure-
      // scoped, so the axis + surviving st-run + the screenshot are the check)
      const base = await tab.rectCenter('#__atp-base');
      await tab.tStart(8, base.x, base.y);
      await tab.tMove(8, base.x - 70, base.y);
      await tab.waitFor(`ArcadeController.pad(0).axis('lx') < -0.85`, 'steering left during run');
      await sleep(700);
      await tab.tMove(8, base.x + 70, base.y);
      await tab.waitFor(`ArcadeController.pad(0).axis('lx') > 0.85`, 'steering right during run');
      await sleep(700);
      await tab.tEnd(8);
      ok(await tab.ev(cls('st-run')), 'still running after steering');
      // pause via START pill, resume via south (pause item 0 = resume)
      await tapButton(tab, '#__atp-start');
      await tab.waitFor(cls('st-pause'), 'paused via START pill', 4000);
      await tapButton(tab, '#__atp-s');
      await tab.waitFor(cls('st-run'), 'resumed', 4000);
      await tab.shot(path.join(SHOTS, 'powder-peak-run-1180x820.png'));
      tab.assertNoErrors('at end');
    } finally { await tab.close(); }
  });

  await run('deep island-forge', async () => {
    const tab = await openTab();
    try {
      await tab.nav(`http://localhost:${HTTP_PORT}/games/island-forge/`);
      await engage(tab);
      await tab.waitFor(`typeof scene !== 'undefined' && scene === 'title'`, 'island-forge title', 10000);
      await tapButton(tab, '#__atp-s');                       // NEW ISLAND
      await tab.waitFor(`scene === 'name'`, 'name entry', 5000);
      await tapButton(tab, '#__atp-start');                   // finish name (default)
      await tab.waitFor(`scene === 'play'`, 'gameplay', 8000);
      await tab.waitFor(`players[0] && typeof players[0].x === 'number'`, 'player exists', 5000);
      const x0 = await tab.ev('players[0].x');
      await holdStick(tab, 70, 0, 900);
      await tab.waitFor(`Math.abs(players[0].x - ${x0}) > 4`, 'player walked with the stick', 4000);
      tab.assertNoErrors('at end');
    } finally { await tab.close(); }
  });

  await run('deep nyan-cat-racing', async () => {
    const tab = await openTab();
    try {
      await tab.nav(`http://localhost:${HTTP_PORT}/games/nyan-cat-racing/`);
      await engage(tab);
      // its state machine is closure-scoped; the garage confirm persists
      // p1 config to localStorage — that write is the observable proof the
      // south presses walked title → garage → startRace.
      await tab.ev(`localStorage.removeItem('nyanrace_p1config')`);
      await tapButton(tab, '#__atp-s');                       // title → garage
      await sleep(500);
      await tapButton(tab, '#__atp-s');                       // garage → race (writes config)
      await tab.waitFor(`localStorage.getItem('nyanrace_p1config') !== null`, 'garage confirm persisted (race starting)', 5000);
      await sleep(3600);                                      // 3.0s countdown
      const before = await tab.ev('window.__pressLog.length');
      for (let i = 0; i < 6; i++) await tapButton(tab, '#__atp-s', 80);   // mash!
      await holdStick(tab, -70, 0, 400);
      await holdStick(tab, 70, 0, 400);
      const log = await tab.ev(`window.__pressLog.slice(${before})`);
      ok(log.filter(b => b === 'south').length >= 5, 'mash presses fired during race, got ' + JSON.stringify(log));
      ok(log.includes('left') && log.includes('right'), 'dpad left/right press events fired during race');
      await tab.shot(path.join(SHOTS, 'nyan-cat-racing-race-1180x820.png'));
      tab.assertNoErrors('at end');
    } finally { await tab.close(); }
  });
}

async function suiteShots() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const slug of ['powder-peak', 'nyan-cat-racing', 'meteor-blaster', 'hiss-and-run']) {
    for (const [w, h] of [[1180, 820], [820, 1180]]) {
      await run(`shot ${slug} ${w}x${h}`, async () => {
        const tab = await openTab({ width: w, height: h });
        try {
          await tab.nav(`http://localhost:${HTTP_PORT}/games/${slug}/`);
          await sleep(1500);
          await tab.tap(w / 2, h / 2);
          await tab.waitFor(OVERLAY_VISIBLE, 'overlay visible');
          await sleep(400);
          await tab.shot(path.join(SHOTS, `${slug}-${w}x${h}.png`));
          tab.assertNoErrors('at end');
        } finally { await tab.close(); }
      });
    }
  }
}

async function main() {
  const filter = process.argv[2];
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serveRepo();
  const userDir = fs.mkdtempSync('/tmp/ses-touchpad-');
  // no --disable-gpu: powder-peak needs a WebGL context (SwiftShader in headless)
  const proc = spawn(CHROME, ['--headless=new', '--mute-audio', '--no-first-run', '--enable-unsafe-swiftshader',
    '--window-size=1180,820', '--force-device-scale-factor=1', '--hide-scrollbars',
    '--user-data-dir=' + userDir, '--remote-debugging-port=' + CDP_PORT, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://localhost:${CDP_PORT}/json/version`); if (r.ok) break; } catch (e) {} await sleep(100); }

  const suites = {
    basics: suiteBasics, keyboard: suiteKeyboard, fakepad: suiteFakePad,
    displacement: suiteDisplacement, shell: suiteShell, deep: suiteDeep, shots: suiteShots,
  };
  for (const [name, fn] of Object.entries(suites)) {
    if (filter && name !== filter) continue;
    console.log('── suite:', name);
    await fn();
  }

  proc.kill(); srv.close();
  const fails = results.filter(r => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  for (const f of fails) console.log('FAILED:', f.name, '—', f.detail);
  process.exit(fails.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
