#!/usr/bin/env node
// Look-lab smoke check: boots lab/index.html headless, sweeps every toggle,
// asserts zero console errors and sane call/tri counts, screenshots the
// flat vs pretty presets. Desktop fps is meaningless — the Pi is the meter.
//   node --experimental-websocket lab/verify.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const LAB = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const gate = (ok, label, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!ok) fails++;
};

const srv = http.createServer((req, res) => {
  const f = path.join(LAB, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(LAB) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'looklab-'));
const proc = spawn(CHROME, [
  '--headless=new', '--mute-audio', '--remote-debugging-port=0',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', '--force-device-scale-factor=1',
  '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('no devtools')), 15000);
});
const list = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let mid = 0; const pending = new Map(); const errs = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value || a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evl = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: base + '/' });
await sleep(4500);

gate(await evl('!!window.__lab'), 'lab boots, __lab exposed');
gate(await evl('__lab.tris') > 20000, 'workload calibrated', `${await evl('__lab.calls')} calls / ${await evl('__lab.tris')} tris baseline`);

const SWEEP = [
  { tone: 'aces' }, { ao: 1 }, { sky: 1 }, { glow: 1 }, { post: 1 },
  { mat: 'lambert' }, { shadow: 1024 }, { shadow: 2048 },
  { shadow: 0, mat: 'basic', density: 4 }, { density: 16 },
  { scenery: 'instanced', density: 16 }, { scenery: 'instanced', density: 4 },
];
for (const c of SWEEP) {
  await evl(`__lab.set(${JSON.stringify(c)})`);
  await sleep(900);
  const calls = await evl('__lab.calls'), tris = await evl('__lab.tris');
  gate(calls > 0 && errs.length === 0, `toggle ${JSON.stringify(c)}`, `${calls} calls / ${(tris / 1000).toFixed(1)}k tris`);
}
for (const p of ['flat', 'pretty']) {
  await evl(`__lab.preset('${p}')`);
  await sleep(1400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(LAB, `shot-${p}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`   shot → lab/shot-${p}.png  (${await evl('__lab.calls')} calls / ${((await evl('__lab.tris')) / 1000).toFixed(1)}k tris)`);
}
gate(errs.length === 0, 'zero console errors across the sweep', errs.slice(0, 3).join(' | '));
console.log(fails === 0 ? 'ALL GREEN' : `${fails} FAILURES`);
proc.kill(); srv.close();
process.exit(fails ? 1 : 0);
