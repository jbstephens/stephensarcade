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
  const NAME_FOR_INDEX = Object.fromEntries(
    Object.entries(BUTTONS).map(([name, i]) => [i, name])
  );

  // padState[i] = { connected, prev: bool[], curr: bool[], axes: number[] }
  const padState = [];
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

  function readPads() {
    const raw = (navigator.getGamepads && navigator.getGamepads()) || [];
    for (let i = 0; i < 4; i++) {
      const g = raw[i];
      const prev = padState[i] || { connected: false, curr: [], axes: [0,0,0,0] };

      if (!g) {
        if (prev.connected) {
          padState[i] = { connected: false, prev: prev.curr, curr: [], axes: [0,0,0,0] };
          fire('disconnect', { padIndex: i });
        }
        continue;
      }

      const curr = g.buttons.map(b => b.pressed || b.value > 0.5);
      const axes = (g.axes || []).map(applyDeadzone);
      padState[i] = { connected: true, prev: prev.curr, curr, axes, id: g.id, mapping: g.mapping };

      if (!prev.connected) {
        fire('connect', { padIndex: i, id: g.id, mapping: g.mapping });
      }

      for (let b = 0; b < curr.length; b++) {
        const was = prev.curr[b] || false;
        const is = curr[b];
        if (is && !was) {
          markSource('gamepad');
          fire('press', { padIndex: i, button: NAME_FOR_INDEX[b] || ('b' + b), index: b });
        } else if (!is && was) {
          fire('release', { padIndex: i, button: NAME_FOR_INDEX[b] || ('b' + b), index: b });
        }
      }
      for (let a = 0; a < axes.length; a++) {
        if (Math.abs(axes[a]) > 0.5) { markSource('gamepad'); break; }
      }
    }
  }

  function tick() {
    readPads();
    requestAnimationFrame(tick);
  }

  function makePad(i) {
    return {
      get connected() { return !!(padState[i] && padState[i].connected); },
      button(name) {
        const s = padState[i];
        if (!s || !s.connected) return false;
        const idx = BUTTONS[name];
        return idx == null ? false : !!s.curr[idx];
      },
      justPressed(name) {
        const s = padState[i];
        if (!s || !s.connected) return false;
        const idx = BUTTONS[name];
        if (idx == null) return false;
        return !!s.curr[idx] && !(s.prev[idx] || false);
      },
      justReleased(name) {
        const s = padState[i];
        if (!s || !s.connected) return false;
        const idx = BUTTONS[name];
        if (idx == null) return false;
        return !s.curr[idx] && !!(s.prev[idx] || false);
      },
      axis(name) {
        const s = padState[i];
        if (!s || !s.connected) return 0;
        const idx = AXES[name];
        return idx == null ? 0 : (s.axes[idx] || 0);
      },
    };
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
