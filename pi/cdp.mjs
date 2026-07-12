#!/usr/bin/env node
// Minimal Chrome DevTools Protocol client for driving the SES kiosk.
// Usage:
//   node cdp.mjs targets                       — list open pages
//   node cdp.mjs nav <url>                     — navigate the kiosk page
//   node cdp.mjs eval '<js expression>'        — evaluate in the page (await-aware)
//   node cdp.mjs fps [seconds]                 — measure requestAnimationFrame FPS
// Talks to localhost:9223 (ssh -L 9223:localhost:9222 arcade@ses.local).

const PORT = process.env.CDP_PORT || 9223;
const [, , cmd, ...args] = process.argv;

async function pages() {
  const res = await fetch(`http://localhost:${PORT}/json/list`);
  const list = await res.json();
  return list.filter(t => t.type === 'page');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res2, rej2 });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = e => reject(new Error('ws error'));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej2(new Error(JSON.stringify(msg.error))) : res2(msg.result);
      }
    };
  });
}

async function evalIn(expr) {
  const [page] = await pages();
  if (!page) throw new Error('no page target');
  const c = await connect(page.webSocketDebuggerUrl);
  const r = await c.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  });
  c.close();
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails, null, 2));
  return r.result.value;
}

const FPS_EXPR = secs => `new Promise(done => {
  let n = 0;
  const t0 = performance.now();
  (function loop() {
    n++;
    if (performance.now() - t0 < ${secs * 1000}) requestAnimationFrame(loop);
    else done({ fps: Math.round(n / ((performance.now() - t0) / 1000) * 10) / 10, frames: n, url: location.pathname });
  })();
})`;

try {
  if (cmd === 'targets') {
    console.log((await pages()).map(p => `${p.title} — ${p.url}`).join('\n'));
  } else if (cmd === 'nav') {
    const [page] = await pages();
    const c = await connect(page.webSocketDebuggerUrl);
    await c.send('Page.enable');
    await c.send('Page.navigate', { url: args[0] });
    await new Promise(r => setTimeout(r, 4000));
    c.close();
    console.log('navigated to', args[0]);
  } else if (cmd === 'eval') {
    console.log(JSON.stringify(await evalIn(args[0]), null, 2));
  } else if (cmd === 'fps') {
    console.log(JSON.stringify(await evalIn(FPS_EXPR(Number(args[0] || 3)))));
  } else {
    console.log('commands: targets | nav <url> | eval <expr> | fps [secs]');
  }
  process.exit(0);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
