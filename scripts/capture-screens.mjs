#!/usr/bin/env node
// Capture real title-screen + gameplay frames from every bundled game for
// the landing pages (site/shots/<slug>-title.png, -play.png). Serves the
// repo over localhost so same-origin assets load exactly as on the arcade,
// boots each game in headless Chrome at 1280x720, waits for the attract/
// title screen, snaps, then (best-effort) presses Start/Enter and snaps a
// gameplay frame. Pads are stubbed before page scripts so controller.js
// never blocks. Run: node --experimental-websocket scripts/capture-screens.mjs [slug]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site', 'shots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8931, CDP_PORT = 9331;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

const INJECT = `
window.__pads=[null,null,null,null];
var __N={south:0,east:1,west:2,north:3,l1:4,r1:5,l2:6,r2:7,select:8,start:9,l3:10,r3:11,up:12,down:13,left:14,right:15,home:16};
function __mkPad(i){return {index:i,id:'Stub Standard Pad',connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},function(){return {pressed:false,value:0,touched:false};}),timestamp:performance.now()};}
window.__connectPad=function(i){if(!window.__pads[i])window.__pads[i]=__mkPad(i);window.dispatchEvent(new Event('gamepadconnected'));};
window.__press=function(i,name,down){if(!window.__pads[i])window.__pads[i]=__mkPad(i);var b=window.__pads[i].buttons[__N[name]];b.pressed=down;b.value=down?1:0;window.__pads[i].timestamp=performance.now();};
navigator.getGamepads=function(){return window.__pads;};
`;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const games = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
  const only = process.argv[2];
  const srv = await serveRepo();
  const userDir = fs.mkdtempSync('/tmp/ses-shots-');
  const proc = spawn(CHROME, ['--headless=new', '--mute-audio', '--disable-gpu', '--no-first-run',
    '--window-size=1280,720', '--force-device-scale-factor=1', '--hide-scrollbars',
    '--user-data-dir=' + userDir, '--remote-debugging-port=' + CDP_PORT, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://localhost:${CDP_PORT}/json/version`); if (r.ok) break; } catch (e) {} await sleep(100); }

  for (const g of games) {
    if (only && g.slug !== only) continue;
    const r = await fetch(`http://localhost:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await r.json();
    const c = await connect(target.webSocketDebuggerUrl);
    await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
    await c.send('Page.navigate', { url: `http://localhost:${HTTP_PORT}/games/${g.slug}/` });
    await sleep(5000);                                   // attract/title settles
    // the kiosk back-button is chrome, not game - strip it from marketing shots
    await c.send('Runtime.evaluate', { expression: `for (const id of ['__arcade_back','__arcade_pad_exit']) { const el = document.getElementById(id); if (el) el.remove(); }` });
    const shot = async name => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${g.slug}-${name}.png`), Buffer.from(s.data, 'base64'));
    };
    await shot('title');
    // best effort gameplay: connect a pad, press start, then confirm, wait, snap
    const press = async (name, holdMs) => {
      await c.send('Runtime.evaluate', { expression: `__connectPad(0);__press(0,'${name}',true)` });
      await sleep(holdMs || 120);
      await c.send('Runtime.evaluate', { expression: `__press(0,'${name}',false)` });
    };
    const key = async code => {
      for (const type of ['keyDown', 'keyUp']) {
        await c.send('Input.dispatchKeyEvent', { type, key: code, code, windowsVirtualKeyCode: code === 'Enter' ? 13 : 90 });
        await sleep(80);
      }
    };
    await press('start'); await sleep(700); await key('Enter'); await sleep(700);
    await press('south'); await sleep(700); await key('KeyZ'); await sleep(2500);
    await shot('play');
    console.log('captured', g.slug);
    c.close();
    await fetch(`http://localhost:${CDP_PORT}/json/close/${target.id}`);
  }
  proc.kill(); srv.close();
  console.log('done ->', OUT);
}
main().catch(e => { console.error(e); process.exit(1); });
