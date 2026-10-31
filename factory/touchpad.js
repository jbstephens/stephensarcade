// touchpad.js: shared iPad / touchscreen + game controller support for Ben's games.
//
// Each game loads it in <head>, BEFORE its own script, with an optional setup line:
//   <script>TOUCHPAD = { dpad: true, south: [' ', 'JUMP'], west: ['x', 'HIT'] };</script>
//   <script src="touchpad.js"></script>
//
// Options (all optional):
//   dpad:  true to show the D-pad (it presses the arrow keys)
//   south / east / west / north:  [key, label] for the four face buttons
//   start: key for the START pill (default 'Enter'),  back: key for the BACK pill (default 'Escape')
//   Set start or back to null to hide that pill.
//   two: { p1: {...}, p2: {...} }  optional 2-player layout; the game calls touchpadMode('two' | 'one') to switch.
//
// What it does:
//   - On touchscreens, draws the D-pad + buttons over the game. They send the same key presses the keyboard would,
//     so games just keep reading e.key like normal.
//   - Turns finger touches on a <canvas> into mouse events, so dragging and press-and-hold work on the iPad.
//   - Reads game controllers (like 8BitDo) on any device and sends the same key presses.
//   - Wakes up game sounds on the iPad (Safari only allows sound after a real tap).
//   - Add ?touch=1 to the address to see the touch controls on a laptop.
(function () {
  const T = window.TOUCHPAD || {}, hasPad = T.dpad || T.south || T.east || T.west || T.north;
  // tap-only games get no START / BACK pills unless they ask for them
  const cfg = Object.assign({ dpad: false, start: hasPad ? 'Enter' : null, back: hasPad ? 'Escape' : null }, T);
  const forced = /[?&]touch=1/.test(location.search);

  // ---------- 👾 Glitch Mode: a secret from the Game Factory book's Glitch Hole makes every game look glitchy ----------
  let glitchOn = false; try { glitchOn = localStorage.getItem('gfGlitch') === 'true'; } catch (_) {}
  if (glitchOn && !/(arcade|index)\.html$|\/$/.test(location.pathname)) {
    const st = document.createElement('style');
    st.textContent = `canvas { animation: tpGlitch 2.2s infinite steps(1); }
      @keyframes tpGlitch { 0%, 100% { transform: none; filter: none; }
        12% { transform: translate(-10px, 3px) skewX(6deg); filter: drop-shadow(8px 0 #ff00ff) drop-shadow(-8px 0 #00e5ff); }
        15% { transform: none; filter: none; }
        40% { transform: translate(8px, -4px); filter: hue-rotate(150deg) saturate(2); }
        44% { transform: none; filter: none; }
        66% { transform: scaleY(.94) translateY(6px); filter: drop-shadow(-6px 0 #76ff03) contrast(1.6); }
        68% { transform: translate(-4px, 0); filter: invert(1); }
        70% { transform: none; filter: none; }
        86% { transform: skewY(-2deg) translateX(12px); filter: drop-shadow(10px 0 #ff1744) drop-shadow(-10px 0 #2979ff); }
        90% { transform: none; filter: none; } }
      .tpScan { position: fixed; inset: 0; pointer-events: none; z-index: 99998;
        background: repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 2px, rgba(255,255,255,.04) 2px 4px); mix-blend-mode: multiply; }
      .tpBar { position: fixed; left: 0; right: 0; height: 26px; pointer-events: none; z-index: 99999; background: rgba(0,255,208,.22);
        box-shadow: 0 0 12px rgba(255,0,255,.6); animation: tpBar 3s linear infinite; }
      @keyframes tpBar { from { top: -30px; } to { top: 100%; } }
      .tpBit { position: fixed; pointer-events: none; z-index: 99999; }
      .tpTag { position: fixed; left: 8px; bottom: 8px; z-index: 99999; pointer-events: none; font: bold 14px monospace; color: #00ffd0;
        text-shadow: 2px 0 #ff00ff, -2px 0 #00e5ff; animation: tpGlitch 1.3s infinite steps(1); }`;
    document.head.appendChild(st);
    const addFx = () => {
      for (const [cls, txt] of [['tpScan', ''], ['tpBar', ''], ['tpTag', '👾 GL1TCH M0DE']]) { const d = document.createElement('div'); d.className = cls; d.textContent = txt; document.body.appendChild(d); }
      const cols = ['#ff00ff', '#00e5ff', '#76ff03', '#ff1744', '#ffea00', '#fff'];
      setInterval(() => {   // little glitchy pixel blocks pop up all over the screen
        const n = Math.random() < 0.35 ? 6 + Math.floor(Math.random() * 10) : 0;
        for (let k = 0; k < n; k++) {
          const b = document.createElement('div'); b.className = 'tpBit';
          const w = 8 + Math.random() * 70, h = 4 + Math.random() * 18;
          b.style.cssText = `left:${Math.random() * 100}vw;top:${Math.random() * 100}vh;width:${w}px;height:${h}px;background:${cols[k % cols.length]};opacity:${0.5 + Math.random() * 0.4}`;
          document.body.appendChild(b); setTimeout(() => b.remove(), 90 + Math.random() * 160);
        }
      }, 260);
    };
    if (document.body) addFx(); else addEventListener('DOMContentLoaded', addFx);
  }
  const isTouch = forced || (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches);

  // ---------- pretend key presses ----------
  const down = new Set();
  function press(key, on) {
    if (!key || down.has(key) === on) return;
    on ? down.add(key) : down.delete(key);
    document.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { key, bubbles: true, cancelable: true }));
  }

  // ---------- sound on iPad: resume every AudioContext after a real tap ----------
  const AC = window.AudioContext || window.webkitAudioContext, contexts = [];
  if (AC) {
    const Wrapped = function (...a) { const c = new AC(...a); contexts.push(c); return c; };
    Wrapped.prototype = AC.prototype;
    window.AudioContext = window.webkitAudioContext = Wrapped;
    const wake = () => contexts.forEach(c => { if (c.state !== 'running') c.resume(); });
    addEventListener('touchend', wake, true);
    addEventListener('pointerup', wake, true);
  }

  // ---------- touchscreen setup ----------
  if (isTouch) {
    let vp = document.querySelector('meta[name=viewport]');
    if (!vp) { vp = document.createElement('meta'); vp.name = 'viewport'; document.head.appendChild(vp); }
    vp.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    const st = document.createElement('style');
    st.textContent = `
      html, body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: none; overscroll-behavior: none; }
      canvas { touch-action: none; }
      #tp { position: fixed; inset: 0; pointer-events: none; z-index: 99999; font-family: 'Arial Rounded MT Bold', 'Trebuchet MS', sans-serif; }
      #tp [hidden] { display: none !important; }
      #tp .tp-btn, #tp .tp-dpad { pointer-events: auto; touch-action: none; position: absolute; }
      #tp .tp-dpad { left: calc(18px + env(safe-area-inset-left)); bottom: calc(18px + env(safe-area-inset-bottom)); width: 170px; height: 170px; }
      #tp .tp-arm { position: absolute; background: rgba(30,30,50,.45); border: 3px solid rgba(255,255,255,.55); border-radius: 14px; }
      #tp .tp-arm.on { background: rgba(255,215,64,.75); }
      #tp .tp-arm::after { content: ''; position: absolute; left: 50%; top: 50%; border: 11px solid transparent; transform: translate(-50%, -50%); }
      #tp .tp-up    { left: 57px; top: 0;    width: 56px; height: 64px; } #tp .tp-up::after    { border-bottom-color: #fff; margin-top: -6px; }
      #tp .tp-down  { left: 57px; bottom: 0; width: 56px; height: 64px; } #tp .tp-down::after  { border-top-color: #fff;    margin-top: 6px; }
      #tp .tp-left  { top: 57px; left: 0;    width: 64px; height: 56px; } #tp .tp-left::after  { border-right-color: #fff;  margin-left: -6px; }
      #tp .tp-right { top: 57px; right: 0;   width: 64px; height: 56px; } #tp .tp-right::after { border-left-color: #fff;   margin-left: 6px; }
      #tp .tp-face { width: 66px; height: 66px; border-radius: 50%; border: 3px solid rgba(255,255,255,.7); color: #fff; font-size: 13px; font-weight: bold;
                     display: flex; align-items: center; justify-content: center; text-align: center; line-height: 1.05; text-shadow: 0 1px 2px #000; }
      #tp .tp-face.on, #tp .tp-pill.on { filter: brightness(1.5); transform: scale(.92); }
      #tp .tp-pill { top: calc(10px + env(safe-area-inset-top)); padding: 9px 16px; border-radius: 20px; background: rgba(30,30,50,.55);
                     border: 2px solid rgba(255,255,255,.6); color: #fff; font-size: 14px; font-weight: bold; }`;
    document.head.appendChild(st);
    const build = () => {
      const root = document.createElement('div'); root.id = 'tp';
      const hold = (el, key) => {
        const on = e => { e.preventDefault(); el.classList.add('on'); press(key, true); };
        const off = e => { e.preventDefault(); el.classList.remove('on'); press(key, false); };
        el.addEventListener('pointerdown', on); ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, off));
      };
      // a D-pad that presses the keys in KEY (arrow keys unless a game says otherwise)
      const makeDpad = (KEY, css, parent) => {
        const pad = document.createElement('div'); pad.className = 'tp-dpad'; if (css) pad.style.cssText = css;
        const arms = {};
        for (const d of ['up', 'down', 'left', 'right']) { const a = document.createElement('div'); a.className = 'tp-arm tp-' + d; pad.appendChild(a); arms[d] = a; }
        let held = new Set(), finger = null;
        const aim = e => {   // works out the direction(s) from where the finger is, so sliding and diagonals work
          const r = pad.getBoundingClientRect(), x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
          const want = new Set();
          if (Math.hypot(x, y) > 18) {
            const ang = Math.atan2(y, x) * 180 / Math.PI;   // 0 = right, 90 = down
            if (ang > -67.5 && ang < 67.5) want.add('right'); if (ang > 112.5 || ang < -112.5) want.add('left');
            if (ang > 22.5 && ang < 157.5) want.add('down'); if (ang < -22.5 && ang > -157.5) want.add('up');
          }
          for (const d of held) if (!want.has(d)) { press(KEY[d], false); arms[d].classList.remove('on'); }
          for (const d of want) if (!held.has(d)) { press(KEY[d], true); arms[d].classList.add('on'); }
          held = want;
        };
        const stop = e => { if (e.pointerId !== finger) return; e.preventDefault(); finger = null; for (const d of held) { press(KEY[d], false); arms[d].classList.remove('on'); } held = new Set(); };
        pad.addEventListener('pointerdown', e => { e.preventDefault(); finger = e.pointerId; try { pad.setPointerCapture(e.pointerId); } catch (_) {} aim(e); });
        pad.addEventListener('pointermove', e => { if (e.pointerId === finger) aim(e); });
        pad.addEventListener('pointerup', stop); pad.addEventListener('pointercancel', stop);
        parent.appendChild(pad);
      };
      const makeBtn = (key, label, css, cls, parent) => {
        const b = document.createElement('div'); b.className = 'tp-btn ' + cls; b.textContent = label || ''; b.style.cssText = css;
        hold(b, key); parent.appendChild(b);
      };
      const ARROWS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

      // ----- one-player controls: D-pad bottom left, face buttons in a diamond bottom right -----
      const one = document.createElement('div'); one.className = 'tp-set';
      if (cfg.dpad) makeDpad(ARROWS, '', one);
      const FACE = { north: [86, 150, '#fbc02d'], west: [150, 86, '#1e88e5'], east: [22, 86, '#e53935'], south: [86, 22, '#43a047'] };
      for (const side in FACE) {
        if (!cfg[side]) continue;
        const [key, label] = cfg[side], [right, bottom, col] = FACE[side];
        makeBtn(key, label, `right: calc(${right}px + env(safe-area-inset-right)); bottom: calc(${bottom}px + env(safe-area-inset-bottom)); background: ${col}cc;`, 'tp-face', one);
      }
      root.appendChild(one);

      // ----- two-player controls (if the game has them): each player gets a D-pad + buttons on their own side -----
      //   TOUCHPAD.two = { p1: { dpad: {up, down, left, right}, buttons: [[key, label], ...] }, p2: { ... } }
      //   The game switches with touchpadMode('two') / touchpadMode('one').
      let two = null;
      if (cfg.two) {
        two = document.createElement('div'); two.className = 'tp-set'; two.hidden = true;
        [['p1', 'left', '#1e88e5'], ['p2', 'right', '#e53935']].forEach(([who, side, col]) => {
          const P = cfg.two[who]; if (!P) return;
          makeDpad(P.dpad || ARROWS, `${side}: calc(14px + env(safe-area-inset-${side})); left: ${side === 'left' ? '' : 'auto'}; width: 150px; height: 150px; transform: scale(.88); transform-origin: bottom ${side};`, two);
          (P.buttons || []).forEach(([key, label], i) => makeBtn(key, label,
            `${side}: calc(${10 + i * 62}px + env(safe-area-inset-${side})); bottom: calc(${150 + (i === 1 ? 36 : 0)}px + env(safe-area-inset-bottom)); width: 58px; height: 58px; font-size: 11px; background: ${col}cc;`, 'tp-face', two));
          makeBtn(null, who.toUpperCase(), `${side}: calc(12px + env(safe-area-inset-${side})); bottom: calc(${250}px + env(safe-area-inset-bottom)); padding: 2px 8px; border-radius: 8px; background: ${col}; color: #fff; font: bold 13px sans-serif; pointer-events: none;`, '', two);
        });
        root.appendChild(two);
      }
      window.touchpadMode = m => { if (!two) return; for (const k of [...down]) press(k, false); one.hidden = m === 'two'; two.hidden = m !== 'two'; };

      const pills = [[cfg.back, '✕ BACK'], [cfg.start, 'START ▶']].filter(p => p[0]);
      pills.forEach(([key, label], i) => makeBtn(key, label, `right: calc(${12 + (pills.length - 1 - i) * 112}px + env(safe-area-inset-right))`, 'tp-pill', root));
      document.body.appendChild(root);
      // paint the page's back layer the game's color, so no white strip shows around the edges on the iPad
      const bg = getComputedStyle(document.body).backgroundColor;
      document.documentElement.style.background = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#14102a';
      document.body.style.minHeight = '100dvh';
    };
    document.body ? build() : addEventListener('DOMContentLoaded', build);

    // stop the iPad from zooming in on the game when you tap fast (double-tap zoom) or pinch.
    // (Safari ignores user-scalable=no, so this has to be done here.)
    ['gesturestart', 'gesturechange', 'gestureend', 'dblclick'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
    let lastTouchEnd = 0;
    document.addEventListener('touchend', e => { const now = Date.now(); if (now - lastTouchEnd < 350) e.preventDefault(); lastTouchEnd = now; }, { passive: false });
    document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

    // finger on a canvas = mouse (so drag, hover and press-and-hold work, not just taps)
    let finger = null, target = null, sx = 0, sy = 0;
    const mouse = (type, t, el, buttons) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY, button: 0, buttons, view: window }));
    addEventListener('touchstart', e => {
      const t = e.changedTouches[0];
      if (finger !== null || !(t.target instanceof HTMLCanvasElement)) return;
      e.preventDefault(); finger = t.identifier; target = t.target; sx = t.clientX; sy = t.clientY;
      mouse('mousemove', t, target, 0); mouse('mousedown', t, target, 1);
    }, { passive: false });
    addEventListener('touchmove', e => {
      const t = [...e.changedTouches].find(t => t.identifier === finger); if (!t) return;
      e.preventDefault(); mouse('mousemove', t, target, 1);
    }, { passive: false });
    const lift = e => {
      const t = [...e.changedTouches].find(t => t.identifier === finger); if (!t) return;
      e.preventDefault(); mouse('mouseup', t, target, 0);
      if (e.type === 'touchend' && Math.hypot(t.clientX - sx, t.clientY - sy) < 12) mouse('click', t, target, 0);
      finger = null; target = null;
    };
    addEventListener('touchend', lift, { passive: false }); addEventListener('touchcancel', lift, { passive: false });
  }

  // ---------- game controllers (8BitDo etc., standard mapping) ----------
  // 0 = bottom (south), 1 = right (east), 2 = left (west), 3 = top (north), 8 = select, 9 = start, 12-15 = D-pad
  const PADMAP = () => ({ 0: cfg.south && cfg.south[0], 1: cfg.east && cfg.east[0], 2: cfg.west && cfg.west[0], 3: cfg.north && cfg.north[0],
                          8: cfg.back, 9: cfg.start, 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight' });
  const padDown = new Set();
  function poll() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    if (pads.length) {
      const want = new Set(), map = PADMAP();
      for (const gp of pads) {
        gp.buttons.forEach((b, i) => { if (b.pressed && map[i]) want.add(map[i]); });
        const [ax, ay] = gp.axes;
        if (ax < -0.5) want.add('ArrowLeft'); if (ax > 0.5) want.add('ArrowRight');
        if (ay < -0.5) want.add('ArrowUp'); if (ay > 0.5) want.add('ArrowDown');
      }
      // with no face buttons set up, A still means "OK"
      if (!cfg.south && pads.some(gp => gp.buttons[0] && gp.buttons[0].pressed)) want.add('Enter');
      for (const k of padDown) if (!want.has(k)) { padDown.delete(k); press(k, false); }
      for (const k of want) if (!padDown.has(k)) { padDown.add(k); press(k, true); }
    }
    requestAnimationFrame(poll);
  }
  addEventListener('gamepadconnected', () => { if (!poll.on) { poll.on = true; requestAnimationFrame(poll); } });
  addEventListener('blur', () => { for (const k of [...down]) press(k, false); padDown.clear(); });
})();
