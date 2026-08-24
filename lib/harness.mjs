// Stephens Arcade — reusable headless-verification harness.
//
// The house rules (CLAUDE.md "Verification standard") mandate a committed
// headless-Chrome + CDP harness with stubbed gamepads and 2D-context op-count
// instrumentation. This module is that harness, deduped from the three
// hand-rolled copies that used to live in scripts/capture-screens.mjs,
// scripts/test-touchpad.mjs and pi/cdp.mjs. Build tooling on top of it
// (see scripts/verify-game.mjs) instead of re-authoring CDP glue in /tmp.
//
// DEPENDENCIES: none — node stdlib + the built-in WebSocket only. That
// WebSocket is behind a flag on node 20/22, so every entrypoint MUST run under
//     node --experimental-websocket <script>
// (globalThis.WebSocket is asserted below so misruns fail loudly, not weirdly).
//
// Exports:
//   sleep(ms)
//   serveRepo({ root, port })            -> { server, port, url, close() }
//   launchChrome({ port, extraArgs })    -> { proc, port, kill() }
//   connectCDP(wsUrl)                    -> { send(method,params), on(evt,fn), close() }
//   openPage(cdpPort, opts)              -> high-level page driver (see below)
//   GAMEPAD_STUB, OPCOUNT_STUB           -> injected-before-page-scripts source
//   CONTROLLER_JS                        -> local lib/controller.js text (for Fetch fulfill)
//   NOISE_RE                             -> offline-resource error filter

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

if (typeof globalThis.WebSocket !== 'function') {
  throw new Error('lib/harness.mjs needs the built-in WebSocket — run node with --experimental-websocket');
}

// The bundled games hard-reference https://ses.q5labs.co/lib/controller.js.
// Offline that 404s; we fulfill it with the local copy so the REAL input path
// (stub gamepad -> controller.js -> ArcadeController -> game) is exercised.
export const CONTROLLER_JS = fs.readFileSync(path.join(ROOT, 'lib', 'controller.js'), 'utf8');

// ── static file server rooted at the repo (loads games/<slug>/ same-origin) ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

export function serveRepo({ root = ROOT, port = 8971 } = {}) {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        rsp.writeHead(404); rsp.end(); return;
      }
      rsp.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(rsp);
    });
    srv.listen(port, () => res({
      server: srv, port, url: `http://localhost:${port}`,
      close: () => new Promise(r => srv.close(r)),
    }));
  });
}

// ── headless Chrome launcher (waits for the CDP endpoint to answer) ──────────
export async function launchChrome({ port = 9371, extraArgs = [], window = [1280, 720] } = {}) {
  const userDir = fs.mkdtempSync('/tmp/ses-harness-');
  const proc = spawn(CHROME, [
    '--headless=new', '--mute-audio', '--no-first-run', '--enable-unsafe-swiftshader',
    `--window-size=${window[0]},${window[1]}`, '--force-device-scale-factor=1', '--hide-scrollbars',
    '--user-data-dir=' + userDir, '--remote-debugging-port=' + port, ...extraArgs, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://localhost:${port}/json/version`); if (r.ok) break; } catch {}
    await sleep(100);
  }
  return {
    proc, port,
    kill() { try { proc.kill(); } catch {} try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {} },
  };
}

// ── raw CDP client over the built-in WebSocket ───────────────────────────────
export function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map(); const handlers = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      on(method, fn) { handlers.set(method, fn); },
      close() { try { ws.close(); } catch {} },
    });
    ws.onerror = () => reject(new Error('CDP ws error ' + wsUrl));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method && handlers.has(m.method)) {
        try { handlers.get(m.method)(m.params); } catch (e) { console.error('CDP handler', e); }
      }
    };
  });
}

// ── standard-mapping gamepad stub (injected before page scripts) ─────────────
// Copied from capture-screens.mjs's INJECT: 17-button standard pad, plus
// __connectPad(i) / __press(i,name,down) helpers keyed by button name.
export const GAMEPAD_STUB = `
window.__pads=[null,null,null,null];
var __N={south:0,east:1,west:2,north:3,l1:4,r1:5,l2:6,r2:7,select:8,start:9,l3:10,r3:11,up:12,down:13,left:14,right:15,home:16};
function __mkPad(i){return {index:i,id:'Stub Standard Pad',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},function(){return {pressed:false,value:0,touched:false};}),timestamp:performance.now()};}
window.__connectPad=function(i){if(!window.__pads[i])window.__pads[i]=__mkPad(i);window.dispatchEvent(new Event('gamepadconnected'));};
window.__press=function(i,name,down){if(!window.__pads[i])window.__pads[i]=__mkPad(i);var b=window.__pads[i].buttons[__N[name]];b.pressed=down;b.value=down?1:0;window.__pads[i].timestamp=performance.now();};
window.__axis=function(i,ax,v){if(!window.__pads[i])window.__pads[i]=__mkPad(i);window.__pads[i].axes[ax]=v;window.__pads[i].timestamp=performance.now();};
navigator.getGamepads=function(){return window.__pads;};
`;

// ── 2D-context op-count instrumenter (injected before page scripts) ──────────
// Wraps drawImage + path/geometry/fill/stroke/text ops + gradient/pattern
// creation on CanvasRenderingContext2D.prototype, bucketing counts per animation
// frame. Frame boundaries come from the rAF timestamp: every game rAF callback
// in the same frame shares one timestamp, so the first callback of a new frame
// finalizes the previous frame's tally (peak + reset). Read via window.__opcounts:
//   { peakDraw, peakPath, peakGrad, peakText, frames, curDraw, ... }
// clearRect is deliberately NOT counted as a path op (clearing the frame is
// mandatory, not the pre-render smell the budget targets).
//
// Besides the absolute per-frame peak we keep the top-K highest per-frame
// counts (topDraw/topPath). The absolute max over a whole session includes
// one-off transients — a boot frame, a scene-transition, a full-map redraw —
// that do NOT represent the sustained 60fps hot path the budget is about. The
// Kth-highest value ("sustained peak") ignores up to K-1 such spikes, so it is
// the fair number to gate on. window.__opReset() re-zeros everything so the
// driver can measure only the steady gameplay window.
export const OPCOUNT_STUB = `
(function(){
  var K=8, z=function(){return [0,0,0,0,0,0,0,0];};
  window.__opcounts={peakDraw:0,peakPath:0,peakGrad:0,peakText:0,curDraw:0,curPath:0,curGrad:0,curText:0,frames:0,lastTs:-1,topDraw:z(),topPath:z()};
  var oc=window.__opcounts;
  window.__opReset=function(){oc.peakDraw=0;oc.peakPath=0;oc.peakGrad=0;oc.peakText=0;oc.curDraw=0;oc.curPath=0;oc.curGrad=0;oc.curText=0;oc.frames=0;oc.lastTs=-1;oc.topDraw=z();oc.topPath=z();};
  function push(arr,v){ if(v<=arr[K-1])return; arr[K-1]=v; for(var i=K-1;i>0&&arr[i]>arr[i-1];i--){var t=arr[i];arr[i]=arr[i-1];arr[i-1]=t;} }
  var P=(window.CanvasRenderingContext2D||{}).prototype;
  if(P){
    function wrap(name,bump){var o=P[name];if(typeof o!=='function')return;P[name]=function(){bump();return o.apply(this,arguments);};}
    wrap('drawImage',function(){oc.curDraw++;});
    ['beginPath','closePath','moveTo','lineTo','bezierCurveTo','quadraticCurveTo','arc','arcTo','ellipse','rect','roundRect','fill','stroke','clip','fillRect','strokeRect']
      .forEach(function(m){wrap(m,function(){oc.curPath++;});});
    ['fillText','strokeText'].forEach(function(m){wrap(m,function(){oc.curText++;});});
    ['createLinearGradient','createRadialGradient','createConicGradient','createPattern']
      .forEach(function(m){wrap(m,function(){oc.curGrad++;});});
  }
  var raf=window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  if(raf){
    window.requestAnimationFrame=function(cb){
      return raf(function(t){
        if(oc.lastTs<0)oc.lastTs=t;
        if(t!==oc.lastTs){
          if(oc.curDraw>oc.peakDraw)oc.peakDraw=oc.curDraw;
          if(oc.curPath>oc.peakPath)oc.peakPath=oc.curPath;
          if(oc.curGrad>oc.peakGrad)oc.peakGrad=oc.curGrad;
          if(oc.curText>oc.peakText)oc.peakText=oc.curText;
          push(oc.topDraw,oc.curDraw); push(oc.topPath,oc.curPath);
          oc.frames++;
          oc.curDraw=0;oc.curPath=0;oc.curGrad=0;oc.curText=0;
          oc.lastTs=t;
        }
        return cb(t);
      });
    };
  }
})();
`;

// Offline-resource noise: hosted controller.js (we fulfill it, but belt+braces),
// analytics, favicons, and generic resource-load failures are never game bugs.
export const NOISE_RE = /controller\.js|gtag|google-analytics|googletagmanager|analytics|favicon|Failed to load resource|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|net::ERR/i;

// ── high-level page driver ───────────────────────────────────────────────────
// openPage(cdpPort, { width, height, inject, fulfillController }) resolves to:
//   { c, errors, target,
//     nav(url), eval(expr), waitFor(expr, what, timeout),
//     connectPad(i), pressPad(name, holdMs, i), axisPad(ax, v, i),
//     key(key, code, vk, holdMs), screenshot(file), opcounts(), close() }
export async function openPage(cdpPort, { width = 1280, height = 720, inject = [], fulfillController = true } = {}) {
  const r = await fetch(`http://localhost:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
  const target = await r.json();
  const c = await connectCDP(target.webSocketDebuggerUrl);
  const errors = [];        // real errors only (noise filtered)
  const rawErrors = [];     // everything, for debugging

  c.on('Runtime.consoleAPICalled', p => {
    if (p.type !== 'error') return;
    const text = 'console.error: ' + (p.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    rawErrors.push(text);
    if (!NOISE_RE.test(text)) errors.push(text);
  });
  c.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails;
    const text = 'exception: ' + (d.exception?.description || d.text || '');
    rawErrors.push(text);
    if (!NOISE_RE.test(text)) errors.push(text);
  });
  c.on('Log.entryAdded', p => {
    if (p.entry.level !== 'error') return;
    const text = 'log: ' + p.entry.text;
    rawErrors.push(text);
    // network-source entries are resource-load noise (offline GA/controller/favicon)
    if (p.entry.source !== 'network' && !NOISE_RE.test(text)) errors.push(text);
  });
  if (fulfillController) {
    c.on('Fetch.requestPaused', async p => {
      try {
        await c.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: Buffer.from(CONTROLLER_JS).toString('base64'),
        });
      } catch {}
    });
  }

  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  if (fulfillController) await c.send('Fetch.enable', { patterns: [{ urlPattern: '*controller.js*' }] });
  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  for (const src of [GAMEPAD_STUB, OPCOUNT_STUB, ...inject]) {
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  }

  let loaded; const loadedP = new Promise(res => { loaded = res; });
  c.on('Page.loadEventFired', () => loaded());

  const page = {
    c, errors, rawErrors, target,
    async nav(url) {
      await c.send('Page.navigate', { url });
      await Promise.race([loadedP, sleep(15000)]);
      // settle a few real animation frames so first paint + game boot happen
      await page.eval('new Promise(r=>{let n=0;(function f(){if(++n>=5)r(1);else requestAnimationFrame(f);})();})');
    },
    async eval(expr) {
      const res = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 10000 });
      if (res.exceptionDetails) throw new Error('eval failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
      return res.result.value;
    },
    async waitFor(expr, what, timeout = 5000) {
      const t0 = Date.now();
      for (;;) {
        if (await page.eval(expr)) return;
        if (Date.now() - t0 > timeout) throw new Error('TIMEOUT waiting for ' + what);
        await sleep(60);
      }
    },
    async connectPad(i = 0) { await page.eval(`__connectPad(${i})`); },
    async pressPad(name, holdMs = 120, i = 0) {
      await page.eval(`__connectPad(${i});__press(${i},'${name}',true)`);
      await sleep(holdMs);
      await page.eval(`__press(${i},'${name}',false)`);
    },
    async axisPad(ax, v, i = 0) { await page.eval(`__axis(${i},${ax},${v})`); },
    // synthetic keyboard: held key = keydown, hold, keyup (polling games need the hold)
    async key(key, code, vk, holdMs = 90) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(holdMs);
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    },
    async screenshot(file) {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    },
    async opcounts() { return page.eval('window.__opcounts || null'); },
    async close() { c.close(); try { await fetch(`http://localhost:${cdpPort}/json/close/${target.id}`); } catch {} },
  };
  return page;
}

// Extract inline (non-src) JS <script> blocks from an HTML string. Returns
// [{ module:bool, code:string, index:number }] — src=/json/template scripts skipped.
export function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;                       // external
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(module|text\/javascript|application\/javascript|text\/ecmascript)$/i.test(type)) continue; // json/template
    const code = m[2];
    if (!code.trim()) continue;
    out.push({ module: /module/i.test(type || ''), code, index: i++ });
  }
  return out;
}

export { spawn };
