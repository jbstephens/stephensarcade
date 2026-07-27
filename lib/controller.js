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

  function tick() {
    readRaw();
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
  // them even if a child element calls stopPropagation.
  window.addEventListener('keydown',    () => markSource('keyboard'), { capture: true });
  window.addEventListener('touchstart', () => markSource('touch'),    { capture: true, passive: true });

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
