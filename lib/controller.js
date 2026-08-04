/* Stephens Arcade — shared gamepad controller library.
 *
 * Loaded by the arcade launcher (same-origin) and by each game's source repo
 * cross-origin from https://ses.q5labs.co/lib/controller.js. Auto-polls
 * navigator.getGamepads() each animation frame; consumers can read state in
 * their own update loops, or subscribe to press / release events.
 *
 * Standard Gamepad mapping — PS4/PS5/Xbox all report as "standard" on macOS
 * (Safari + Chromium) and on a Raspberry Pi running Chromium.
 *
 * Logical vs raw slots: navigator.getGamepads() returns up to 4 raw slots,
 * and the OS / browser sometimes shoves a pad into slot 1 (or 2) when slot 0
 * is held by a phantom Bluetooth device. To keep games sane, this library
 * exposes LOGICAL indices: pad(0) is always the first connected pad, pad(1)
 * the second, etc., regardless of raw slot. Assignment is sticky — once a
 * pad has logical index 0, it keeps it until it disconnects.
 *
 * Public API (window.ArcadeController):
 *   pad(i)                   → { connected, button(name), justPressed(name),
 *                                justReleased(name), axis(name) }
 *   on('press' | 'release' | 'connect' | 'disconnect', handler)
 *   off(event, handler)
 *   currentInputSource()     → 'gamepad' | 'touch' | 'keyboard'
 *   BUTTONS                  → name → standard-gamepad index map
 *
 * Button names use the layout-neutral convention (south/east/west/north)
 * so games don't have to think about X-vs-A.
 *
 * Virtual touch gamepad (touchpad-v1): on the first real touchstart — on a
 * device with no physical pad connected, outside console/low-fx mode — the
 * library injects an on-screen pad overlay (#__arcade_touchpad): a fixed
 * left stick (axes lx/ly + synthesized dpad), a △○✕□ diamond, and
 * SELECT/START pills. It registers as a synthetic standard-mapping pad
 * ('Arcade Touch Pad') in the normal logical-slot machinery, so pad(0)
 * polling and 'press'/'release' events work in every game with zero game
 * changes. While engaged the input source is pinned to 'gamepad'
 * (body.input-pad), so games show pad glyphs and hide bespoke touch UIs.
 * A physical pad connecting always wins: the synthetic pad disengages the
 *   same tick and the physical pad takes logical slot 0.
 * Opt out per page with  window.ARCADE_NO_TOUCHPAD = true  (checked at
 * engage time, so it can be set any time before the first touch).
 */
(function () {
  const BUTTONS = {
    south:  0, east:   1, west:   2, north:  3,
    l1:     4, r1:     5, l2:     6, r2:     7,
    select: 8, start:  9, l3:    10, r3:    11,
    up:    12, down:  13, left:  14, right: 15,
    home:  16,
  };
  const AXES = { lx: 0, ly: 1, rx: 2, ry: 3 };
  const DEADZONE = 0.18;
  const MAX_SLOTS = 4;
  // Raw slot reserved for the synthetic touch-overlay pad — well above any
  // slot navigator.getGamepads() can return, so it never collides.
  const TOUCH_RI = 32;
  const NAME_FOR_INDEX = Object.fromEntries(
    Object.entries(BUTTONS).map(([name, i]) => [i, name])
  );

  // Raw state, one slot per navigator.getGamepads() slot.
  // rawState[i] = { connected, prev: bool[], curr: bool[], axes: number[], id, mapping }
  const rawState = [];

  // Sticky logical→raw mapping. logicalToRaw[li] = ri or null.
  // A pad keeps its logical index until it disconnects; the slot is then
  // freed and the next new pad fills the lowest empty logical slot.
  const logicalToRaw = new Array(MAX_SLOTS).fill(null);

  const listeners = { press: [], release: [], connect: [], disconnect: [] };

  let source = 'keyboard';

  function applyDeadzone(v) {
    return Math.abs(v) < DEADZONE ? 0 : v;
  }

  function fire(event, payload) {
    for (const fn of listeners[event]) {
      try { fn(payload); } catch (e) { console.error('[ArcadeController]', e); }
    }
  }

  function markSource(s) {
    if (s !== source) {
      source = s;
      updateBodyClass();
    }
  }

  function updateBodyClass() {
    if (!document.body) return;
    const cls = document.body.classList;
    cls.remove('input-pad', 'input-touch', 'input-kbd');
    cls.add(source === 'gamepad' ? 'input-pad'
          : source === 'touch'   ? 'input-touch'
          :                        'input-kbd');
  }

  // Pass 1: refresh raw state from navigator.getGamepads(). Scan ALL raw
  // slots, not just the first MAX_SLOTS — on Linux a single DualShock also
  // exposes its motion sensors and touchpad as separate devices, so two
  // physical pads can occupy six raw slots.
  function readRaw() {
    const raw = (navigator.getGamepads && navigator.getGamepads()) || [];
    const n = Math.max(raw.length, rawState.length);
    for (let i = 0; i < n; i++) {
      if (i === TOUCH_RI) continue; // synthetic slot is owned by syncTouchPad
      const g = raw[i];
      const prev = rawState[i] || { connected: false, curr: [], axes: [0,0,0,0] };
      if (!g) {
        if (prev.connected) {
          rawState[i] = { connected: false, prev: prev.curr, curr: [], axes: [0,0,0,0] };
        }
        continue;
      }
      const wasConnected = prev.connected;
      const curr = g.buttons.map(b => b.pressed || b.value > 0.5);
      const axes = (g.axes || []).map(applyDeadzone);
      // On a pad's FIRST observed frame — a fresh connect, or a page load
      // where a button is still held from the previous screen's quit gesture
      // — seed prev = curr. You can't have "just pressed" a button on the very
      // frame the pad first exists; without this, a held button fires a
      // phantom press edge on frame one. That's what made the launcher
      // auto-launch the highlighted game when START/home was still held while
      // quitting a game back to the menu.
      rawState[i] = {
        connected: true,
        prev: wasConnected ? prev.curr : curr,
        curr, axes, id: g.id, mapping: g.mapping,
      };
    }
  }

  // A raw slot is a real, playable pad — not a phantom sub-device. DualShock
  // motion sensors / touchpads enumerate as extra "gamepads" on Linux; they
  // must never claim a player slot or games end up polling a gyroscope.
  function isRealPad(ri) {
    const s = rawState[ri];
    if (!s || !s.connected) return false;
    if (ri === TOUCH_RI) return true; // synthetic touch pad, valid while engaged
    if (/motion sensors|touchpad/i.test(s.id || '')) return false;
    return true;
  }

  // Pass 2: keep the sticky logical→raw map in sync. Free slots whose pad
  // disconnected; assign new connections to the lowest free logical slot.
  // Standard-mapping pads get priority: non-standard devices are only
  // considered when no standard pad is connected at all (exotic controllers
  // on unusual browsers still work, but they can't shadow a real pad).
  function syncLogicalMap() {
    for (let li = 0; li < MAX_SLOTS; li++) {
      const ri = logicalToRaw[li];
      if (ri !== null && (!rawState[ri] || !rawState[ri].connected)) {
        logicalToRaw[li] = null;
        fire('disconnect', { padIndex: li });
      }
    }
    const candidates = [];
    for (let ri = 0; ri < rawState.length; ri++) {
      if (isRealPad(ri)) candidates.push(ri);
    }
    const anyStandard = candidates.some(ri => rawState[ri].mapping === 'standard');
    for (const ri of candidates) {
      if (anyStandard && rawState[ri].mapping !== 'standard') continue;
      if (logicalToRaw.indexOf(ri) !== -1) continue;
      for (let li = 0; li < MAX_SLOTS; li++) {
        if (logicalToRaw[li] === null) {
          logicalToRaw[li] = ri;
          fire('connect', { padIndex: li, id: rawState[ri].id, mapping: rawState[ri].mapping });
          break;
        }
      }
    }
  }

  // Pass 3: fire press/release edges, addressing pads by LOGICAL index so
  // event consumers see the same numbering as pad(i).
  function fireEdges() {
    for (let li = 0; li < MAX_SLOTS; li++) {
      const ri = logicalToRaw[li];
      if (ri === null) continue;
      const s = rawState[ri];
      if (!s || !s.connected) continue;
      const curr = s.curr;
      const prev = s.prev || [];
      for (let b = 0; b < curr.length; b++) {
        const was = prev[b] || false;
        const is = curr[b];
        if (is && !was) {
          markSource('gamepad');
          fire('press', { padIndex: li, button: NAME_FOR_INDEX[b] || ('b' + b), index: b });
        } else if (!is && was) {
          fire('release', { padIndex: li, button: NAME_FOR_INDEX[b] || ('b' + b), index: b });
        }
      }
      for (let a = 0; a < (s.axes || []).length; a++) {
        if (Math.abs(s.axes[a]) > 0.5) { markSource('gamepad'); break; }
      }
    }
  }

  // ── Virtual touch gamepad (touchpad-v1) ─────────────────────────────────
  // A standard-mapping synthetic pad driven by an injected DOM overlay, fed
  // through the same rawState/logical-slot machinery as physical pads. The
  // overlay does not exist (no DOM, no listeners beyond the page-level
  // touchstart already present) until the first real touch engages it.

  const STICK_R = 50;           // px of knob travel = full axis deflection
  const DPAD_ON = 0.5;          // dpad synth hysteresis: press above…
  const DPAD_OFF = 0.35;        // …release below (crisp menu edges, no jitter)

  const touch = {
    engaged: false,
    built: false,
    fresh: false,               // first engaged tick → seed prev = curr
    layoutDirty: true,
    buttons: new Array(17).fill(false),
    latch: new Array(17).fill(false),   // taps shorter than one frame still land
    axes: [0, 0, 0, 0],
    // double-buffered curr/prev for the rawState entry — the tick swaps and
    // copies bools into these, so the hot path allocates nothing.
    bufA: new Array(17).fill(false),
    bufB: new Array(17).fill(false),
    entry: null,                // the rawState[TOUCH_RI] object, mutated in place
    overlayEl: null, baseEl: null, knobEl: null,
    btns: [],                   // { el, idx, zone, cx, cy, hw, hh }
  };
  const stick = { id: null, cx: 0, cy: 0 };
  const btnTouches = {};        // touch identifier -> btn record | null
  const pressCount = new Array(17).fill(0);

  function anyPhysicalPad() {
    for (let ri = 0; ri < rawState.length; ri++) {
      if (ri !== TOUCH_RI && isRealPad(ri)) return true;
    }
    return false;
  }

  function touchpadBlocked() {
    if (window.ARCADE_NO_TOUCHPAD) return true;   // per-page opt-out
    try {
      // Console / low-fx mode: the Pi cabinet has no touchscreen and must
      // never pay for the overlay.
      if (/[?&]fx=low\b/.test(location.search)) return true;
      if (localStorage.getItem('arcade_lowfx') === '1') return true;
    } catch (e) {}
    // Temporary built-in skip list until these games opt out themselves via
    // ARCADE_NO_TOUCHPAD: ghost-patrol's bespoke touch scheme (floating
    // stick + drag-to-look) suits its FPS controls better than this overlay,
    // and scream-rocket is microphone-driven with native menu buttons.
    if (/ghost-?patrol|ghostpatrol|scream-?rocket|screamrocket/i
        .test(location.hostname + location.pathname)) return true;
    if (anyPhysicalPad()) return true;            // physical pads always win
    return false;
  }

  function setBtn(idx, down) {
    touch.buttons[idx] = down;
    if (down) touch.latch[idx] = true;
  }

  function dpadDir(idx, v) {
    if (touch.buttons[idx]) { if (v < DPAD_OFF) setBtn(idx, false); }
    else if (v > DPAD_ON) setBtn(idx, true);
  }

  function updateDpad() {
    dpadDir(14, -touch.axes[0]);   // left
    dpadDir(15,  touch.axes[0]);   // right
    dpadDir(12, -touch.axes[1]);   // up (screen-up = negative ly, standard)
    dpadDir(13,  touch.axes[1]);   // down
  }

  function ensureLayout() {
    if (!touch.layoutDirty || !touch.built) return;
    const b = touch.baseEl.getBoundingClientRect();
    stick.cx = b.left + b.width / 2;
    stick.cy = b.top + b.height / 2;
    for (const btn of touch.btns) {
      const r = btn.el.getBoundingClientRect();
      btn.cx = r.left + r.width / 2;
      btn.cy = r.top + r.height / 2;
      btn.hw = r.width / 2 + 14;   // slop: kid thumbs are not precise
      btn.hh = r.height / 2 + 14;
    }
    touch.layoutDirty = false;
  }

  function moveStick(x, y) {
    let dx = (x - stick.cx) / STICK_R;
    let dy = (y - stick.cy) / STICK_R;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    touch.axes[0] = dx;
    touch.axes[1] = dy;
    touch.knobEl.style.transform =
      'translate(' + (dx * STICK_R).toFixed(1) + 'px,' + (dy * STICK_R).toFixed(1) + 'px)';
    updateDpad();
  }

  function endStick() {
    stick.id = null;
    touch.axes[0] = 0;
    touch.axes[1] = 0;
    touch.knobEl.style.transform = '';
    touch.baseEl.classList.remove('__atp-on');
    updateDpad();
  }

  function hitBtn(zone, x, y) {
    for (const b of touch.btns) {
      if (b.zone !== zone) continue;
      if (Math.abs(x - b.cx) <= b.hw && Math.abs(y - b.cy) <= b.hh) return b;
    }
    return null;
  }

  function pressB(b) {
    if (++pressCount[b.idx] === 1) {
      setBtn(b.idx, true);
      b.el.classList.add('__atp-on');
    }
  }

  function releaseB(b) {
    if (pressCount[b.idx] > 0 && --pressCount[b.idx] === 0) {
      touch.buttons[b.idx] = false;
      b.el.classList.remove('__atp-on');
    }
  }

  // Diamond + pills: multi-touch, and on touchmove a finger re-targets to
  // whichever button it is over (kids slide thumbs); leaving all releases.
  function makeBtnZone(zoneEl, zoneName) {
    function retarget(t) {
      const cur = btnTouches[t.identifier];
      const hit = hitBtn(zoneName, t.clientX, t.clientY);
      if (cur === hit) return;
      if (cur) releaseB(cur);
      if (hit) pressB(hit);
      btnTouches[t.identifier] = hit;
    }
    zoneEl.addEventListener('touchstart', ev => {
      ev.preventDefault();
      ensureLayout();
      for (const t of ev.changedTouches) { btnTouches[t.identifier] = null; retarget(t); }
    }, { passive: false });
    zoneEl.addEventListener('touchmove', ev => {
      ev.preventDefault();
      for (const t of ev.changedTouches) {
        if (btnTouches[t.identifier] !== undefined) retarget(t);
      }
    }, { passive: false });
    const end = ev => {
      ev.preventDefault();
      for (const t of ev.changedTouches) {
        const cur = btnTouches[t.identifier];
        if (cur !== undefined) {
          if (cur) releaseB(cur);
          delete btnTouches[t.identifier];
        }
      }
    };
    zoneEl.addEventListener('touchend', end, { passive: false });
    zoneEl.addEventListener('touchcancel', end, { passive: false });
  }

  function buildTouchpad() {
    const style = document.createElement('style');
    style.id = '__arcade_touchpad_css';
    style.textContent =
      '#__arcade_touchpad{position:fixed;inset:0;pointer-events:none;z-index:2147483000;' +
        'opacity:.9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
      '#__arcade_touchpad,#__arcade_touchpad *{box-sizing:border-box;-webkit-user-select:none;' +
        'user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;}' +
      '#__arcade_touchpad .__atp-zone{position:absolute;pointer-events:auto;touch-action:none;}' +
      '#__atp-stickzone{left:calc(6px + env(safe-area-inset-left,0px));' +
        'bottom:calc(6px + env(safe-area-inset-bottom,0px));width:200px;height:200px;}' +
      '#__atp-base{position:absolute;left:30px;top:30px;width:140px;height:140px;border-radius:50%;' +
        'background:rgba(18,22,40,.28);border:2px solid rgba(255,255,255,.35);}' +
      '#__atp-knob{position:absolute;left:41px;top:41px;width:54px;height:54px;border-radius:50%;' +
        'background:rgba(255,255,255,.25);border:2px solid rgba(255,255,255,.55);}' +
      '#__atp-btnzone{right:calc(6px + env(safe-area-inset-right,0px));' +
        'bottom:calc(10px + env(safe-area-inset-bottom,0px));width:196px;height:196px;}' +
      '.__atp-btn{position:absolute;width:62px;height:62px;border-radius:50%;' +
        'background:rgba(18,22,40,.28);border:2px solid rgba(255,255,255,.35);' +
        'color:rgba(255,255,255,.85);font-size:26px;line-height:58px;text-align:center;}' +
      '#__atp-n{left:67px;top:0;}#__atp-s{left:67px;top:134px;}' +
      '#__atp-w{left:0;top:67px;}#__atp-e{left:134px;top:67px;}' +
      '#__atp-pills{top:calc(8px + env(safe-area-inset-top,0px));' +
        'right:calc(8px + env(safe-area-inset-right,0px));display:flex;gap:8px;}' +
      '.__atp-pill{padding:7px 14px 6px;border-radius:999px;background:rgba(18,22,40,.28);' +
        'border:2px solid rgba(255,255,255,.35);color:rgba(255,255,255,.85);' +
        'font-size:11px;font-weight:700;letter-spacing:1.5px;}' +
      '.__atp-on{background:rgba(255,255,255,.38)!important;border-color:rgba(255,255,255,.8)!important;}';
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = '__arcade_touchpad';
    root.innerHTML =
      '<div class="__atp-zone" id="__atp-stickzone">' +
        '<div id="__atp-base"><div id="__atp-knob"></div></div></div>' +
      '<div class="__atp-zone" id="__atp-btnzone">' +
        '<div class="__atp-btn" id="__atp-n">&#9651;</div>' +   // △ north
        '<div class="__atp-btn" id="__atp-e">&#9675;</div>' +   // ○ east
        '<div class="__atp-btn" id="__atp-w">&#9633;</div>' +   // □ west
        '<div class="__atp-btn" id="__atp-s">&#10005;</div>' +  // ✕ south
      '</div>' +
      '<div class="__atp-zone" id="__atp-pills">' +
        '<div class="__atp-pill" id="__atp-select">SELECT</div>' +
        '<div class="__atp-pill" id="__atp-start">START</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(root);

    touch.overlayEl = root;
    touch.baseEl = root.querySelector('#__atp-base');
    touch.knobEl = root.querySelector('#__atp-knob');
    touch.btns = [
      { el: root.querySelector('#__atp-n'), idx: 3, zone: 'diamond', cx: 0, cy: 0, hw: 0, hh: 0 },
      { el: root.querySelector('#__atp-e'), idx: 1, zone: 'diamond', cx: 0, cy: 0, hw: 0, hh: 0 },
      { el: root.querySelector('#__atp-w'), idx: 2, zone: 'diamond', cx: 0, cy: 0, hw: 0, hh: 0 },
      { el: root.querySelector('#__atp-s'), idx: 0, zone: 'diamond', cx: 0, cy: 0, hw: 0, hh: 0 },
      { el: root.querySelector('#__atp-select'), idx: 8, zone: 'pills', cx: 0, cy: 0, hw: 0, hh: 0 },
      { el: root.querySelector('#__atp-start'),  idx: 9, zone: 'pills', cx: 0, cy: 0, hw: 0, hh: 0 },
    ];

    const stickZone = root.querySelector('#__atp-stickzone');
    stickZone.addEventListener('touchstart', ev => {
      ev.preventDefault();
      ensureLayout();
      for (const t of ev.changedTouches) {
        if (stick.id === null) {
          stick.id = t.identifier;
          touch.baseEl.classList.add('__atp-on');
          moveStick(t.clientX, t.clientY);
        }
      }
    }, { passive: false });
    stickZone.addEventListener('touchmove', ev => {
      ev.preventDefault();
      for (const t of ev.changedTouches) {
        if (t.identifier === stick.id) moveStick(t.clientX, t.clientY);
      }
    }, { passive: false });
    const stickEnd = ev => {
      ev.preventDefault();
      for (const t of ev.changedTouches) {
        if (t.identifier === stick.id) endStick();
      }
    };
    stickZone.addEventListener('touchend', stickEnd, { passive: false });
    stickZone.addEventListener('touchcancel', stickEnd, { passive: false });

    makeBtnZone(root.querySelector('#__atp-btnzone'), 'diamond');
    makeBtnZone(root.querySelector('#__atp-pills'), 'pills');

    const dirty = () => { touch.layoutDirty = true; };
    window.addEventListener('resize', dirty);
    window.addEventListener('orientationchange', dirty);

    touch.built = true;
  }

  function resetTouchInputs() {
    stick.id = null;
    for (const k in btnTouches) delete btnTouches[k];
    for (let i = 0; i < 17; i++) {
      touch.buttons[i] = false;
      touch.latch[i] = false;
      pressCount[i] = 0;
    }
    touch.axes[0] = 0;
    touch.axes[1] = 0;
    if (touch.built) {
      touch.knobEl.style.transform = '';
      touch.baseEl.classList.remove('__atp-on');
      for (const b of touch.btns) b.el.classList.remove('__atp-on');
    }
  }

  function maybeEngageTouchpad() {
    if (touch.engaged || touchpadBlocked()) return;
    if (!touch.built) buildTouchpad();
    resetTouchInputs();
    touch.overlayEl.style.display = 'block';
    touch.layoutDirty = true;
    touch.engaged = true;
    touch.fresh = true;
    if (!touch.entry) {
      touch.entry = {
        connected: false, prev: touch.bufA, curr: touch.bufB,
        axes: [0, 0, 0, 0], id: 'Arcade Touch Pad', mapping: 'standard',
      };
    }
  }

  function disengageTouchpad() {
    touch.engaged = false;
    resetTouchInputs();
    if (touch.overlayEl) touch.overlayEl.style.display = 'none';
    if (touch.entry) touch.entry.connected = false;
  }

  // Runs each tick between readRaw and syncLogicalMap. Sticky-slot
  // displacement guard: if a physical pad is connected, disengage BEFORE the
  // logical map assigns anything — the synthetic pad's slot frees (with a
  // 'disconnect' event) and the physical pad claims logical 0 the same tick.
  function syncTouchPad() {
    if (touch.engaged && anyPhysicalPad()) disengageTouchpad();
    const e = touch.entry;
    if (!e) return;
    if (!touch.engaged) return;   // entry.connected already false after disengage
    const tmp = e.prev;
    e.prev = e.curr;
    e.curr = tmp;
    for (let b = 0; b < 17; b++) {
      e.curr[b] = touch.buttons[b] || touch.latch[b];
      touch.latch[b] = false;
    }
    e.axes[0] = touch.axes[0];
    e.axes[1] = touch.axes[1];
    if (touch.fresh) {
      // First engaged frame: seed prev = curr (mirrors the phantom-press
      // protection real pads get on their first observed frame).
      for (let b = 0; b < 17; b++) e.prev[b] = e.curr[b];
      touch.fresh = false;
      e.connected = true;
      rawState[TOUCH_RI] = e;
    }
  }

  function tick() {
    readRaw();
    syncTouchPad();
    syncLogicalMap();
    fireEdges();
    requestAnimationFrame(tick);
  }

  function makePad(li) {
    function rawSlot() { return logicalToRaw[li]; }
    return {
      get connected() {
        const ri = rawSlot();
        return ri !== null && !!(rawState[ri] && rawState[ri].connected);
      },
      button(name) {
        const ri = rawSlot();
        if (ri === null) return false;
        const s = rawState[ri];
        if (!s || !s.connected) return false;
        const idx = BUTTONS[name];
        return idx == null ? false : !!s.curr[idx];
      },
      justPressed(name) {
        const ri = rawSlot();
        if (ri === null) return false;
        const s = rawState[ri];
        if (!s || !s.connected) return false;
        const idx = BUTTONS[name];
        if (idx == null) return false;
        return !!s.curr[idx] && !((s.prev || [])[idx] || false);
      },
      justReleased(name) {
        const ri = rawSlot();
        if (ri === null) return false;
        const s = rawState[ri];
        if (!s || !s.connected) return false;
        const idx = BUTTONS[name];
        if (idx == null) return false;
        return !s.curr[idx] && !!((s.prev || [])[idx] || false);
      },
      axis(name) {
        const ri = rawSlot();
        if (ri === null) return 0;
        const s = rawState[ri];
        if (!s || !s.connected) return 0;
        const idx = AXES[name];
        return idx == null ? 0 : (s.axes[idx] || 0);
      },
    };
  }

  // Haptics. rumble(logicalPadIndex, { duration, strong, weak }) buzzes the
  // pad in that logical slot via the Gamepad vibrationActuator. It's a silent
  // no-op when the slot is empty, or the pad / browser / Bluetooth stack has
  // no working actuator (keyboard, touch, exotic pads) — so game code can fire
  // it freely on every hit/explosion without feature-checking. Magnitudes are
  // 0..1; duration is ms (capped so a bug can't leave a motor stuck on).
  // Returns true only if an effect was actually dispatched.
  function rumble(li, opts) {
    opts = opts || {};
    const ri = logicalToRaw[li];
    if (ri === null || ri === undefined) return false;
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    const g = pads[ri];
    const va = g && g.vibrationActuator;
    if (!va || typeof va.playEffect !== 'function') return false;
    const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
    const duration = Math.min(Math.max(opts.duration || 200, 0), 5000);
    const strong = clamp01(opts.strong != null ? opts.strong : 0.6);
    const weak   = clamp01(opts.weak   != null ? opts.weak   : 0.4);
    try {
      const p = va.playEffect('dual-rumble', {
        duration, startDelay: 0,
        strongMagnitude: strong, weakMagnitude: weak,
      });
      // playEffect returns a promise that rejects if the effect is preempted
      // by a later call — expected during rapid fire, so swallow it.
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { return false; }
    return true;
  }

  // non-pad sources for the body-class swap. capture-phase so we always see
  // them even if a child element calls stopPropagation. The touchstart
  // listener is also the touch-overlay engage hook: the overlay DOM does not
  // exist until the first real touch, and while it is engaged the input
  // source stays pinned to 'gamepad' so games show pad prompts and hide
  // their bespoke touch UIs (body.input-pad). Stays passive — the overlay's
  // own zone listeners are the ones that preventDefault.
  window.addEventListener('keydown',    () => markSource('keyboard'), { capture: true });
  window.addEventListener('touchstart', () => {
    maybeEngageTouchpad();
    markSource(touch.engaged ? 'gamepad' : 'touch');
  }, { capture: true, passive: true });

  if (document.body) updateBodyClass();
  else document.addEventListener('DOMContentLoaded', updateBodyClass);

  requestAnimationFrame(tick);

  window.ArcadeController = {
    pad: makePad,
    rumble,
    currentInputSource: () => source,
    on(event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    off(event, handler) {
      const arr = listeners[event] || [];
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    },
    BUTTONS,
  };
})();
