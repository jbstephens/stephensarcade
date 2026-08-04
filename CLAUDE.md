# Stephens Arcade — house rules

Family web arcade (ses.q5labs.co) that boots on a Raspberry Pi 5 console
(Chromium kiosk, 1280x720@60, PS4 pads) and also runs on iPads/desktops.
Built by John and his two sons. Kid-proof and 60fps-on-the-Pi are the two
non-negotiables.

## Repo map (siblings of this repo)

Each game is a SINGLE self-contained HTML file in its own repo under
`~/Documents/Projects/stephensgames/`:
`fightinggame` (Phaser Wars), `meteorblaster`, `blockquarry`, `ghostpatrol`,
`screamrocket`, `sportsgame` (Ninth Inning — index.html and baseball.html
must stay byte-identical), `hissandrun`. This repo (`gameconsole`) is the
launcher shell; its root is the web root on Render.

## Ship pipeline (always this order)

1. Commit+push the game repo → its Render service auto-deploys
   (`<name>.onrender.com`). Poll the live URL for a distinctive new string.
2. In THIS repo: `bash scripts/bundle-games.sh` (fetches every game's live
   HTML into games/<slug>/, injects overlays, regenerates games.js).
3. Verify the bundle got the change + overlay markers (`__arcade_back`,
   `__arcade_pad_exit`, `__arcade_lowfx`), commit+push → arcade deploys.
4. Verify ON THE CONSOLE (see below). A GitHub Action also re-syncs bundles
   every 30 min — never hand-edit files under games/.

New game: `games.json` entry (slug/title/genre/icon/source) + an
ICON_BUILDERS canvas icon in index.html. The menu carousel scales to any
count. Use the `/new-game` skill for the full checklist.

## Game conventions (every game, no exceptions)

- `<script src="https://ses.q5labs.co/lib/controller.js"></script>` in
  <head>; guard ALL uses with `if (window.ArcadeController)`. pad(0)=P1,
  pad(1)=P2 (logical slots; phantom DS4 sub-devices already filtered).
- Every interactive state reachable by pad alone (console has no
  keyboard/mouse). Menu/pause edges via the press-EVENT stream; held
  movement via state polling. START = pause. South = confirm.
- NEVER bind SELECT+START held together or the PS/home button — the shell
  reserves them for quit-to-menu (injected overlay).
- Keyboard + touch also supported (iPad/desktop still first-class). Touch
  movement/buttons come FREE: controller.js injects a standard virtual pad
  overlay (left stick + △○✕□ + SELECT/START) on first touch that drives
  pad(0) — do NOT build per-game touch d-pads/joysticks. DO keep
  direct-manipulation gestures (tap-to-walk, board swipes, drag-to-aim);
  they coexist. Opt a page out with `window.ARCADE_NO_TOUCHPAD = true`
  before controller.js loads (the launcher, ghost-patrol, scream-rocket).
- Drop-in 2P where it makes sense: "P2 PRESS ✕ TO JOIN" on title + START
  joins mid-game; shared score; down-then-respawn rather than hard death.
- localStorage for best scores. WebAudio synth SFX, context created lazily.
- Don't add analytics/back-button/quit/low-fx code — the bundler injects it.

## Performance commandments (learned on real hardware)

- NEVER canvas `shadowBlur` (console overlay no-ops it → invisible glows;
  it's also the #1 GPU killer). Bake glows with gradients.
- NEVER CSS `backdrop-filter` (measured 17→60fps by removing it — each
  frosted panel re-blurs the canvas every frame on the Pi).
- Pre-render EVERYTHING at load into offscreen canvases; per-frame hot path
  = drawImage + transforms only. Budget: <150 drawImage, ~0 path ops/frame.
  (Meteor Blaster went 770 path-ops → 0 and 13fps → 60 this way.)
- No per-frame allocations in hot loops; pool particles/entities; hoist
  gradients into bakes.
- Desktop/headless op counts MISS DOM compositing costs — final perf
  verdicts come from the Pi itself.

## Verification standard (before anything ships)

- `node --check` the extracted inline JS.
- Headless Chrome + CDP harness with stubbed `navigator.getGamepads`
  (fake standard-mapping pads injected before page scripts) — ALWAYS
  launch test Chrome with `--mute-audio` (headless still plays sound
  through the host Mac's speakers otherwise): drive every state — menus, gameplay, pause/resume, death, restart, 2P join/down —
  asserting zero console errors. Keyboard-only regression too.
- Instrument the 2D context prototype to count per-frame ops vs budget.
- CDP screenshots at 1280x720 (plus tablet/phone if UI changed) — actually
  LOOK at them and iterate; overlapping HUD boxes and programmer-art are
  the recurring failure modes.

## Console operations

- `ssh arcade@ses.local` (passwordless key; passwordless sudo). Config in
  `/etc/ses-kiosk.conf` (SES_URL has `?fx=low`, SES_MODE=1280x720@60,
  SES_DEBUG_PORT=9222). `pi/README.md` = build guide; `pi/setup.sh`
  provisions; kiosk self-heals display-mode drift (TV HDMI renegotiation)
  and waits for real audio at boot.
- Drive/measure the live kiosk: `ssh -f -N -L 9223:localhost:9222
  arcade@ses.local`, then `CDP_PORT=9223 node pi/cdp.mjs targets|nav|eval|fps`.
  Check `targets` FIRST — never hijack the console mid-game; park it back
  on https://ses.q5labs.co/ when done.
- Chromium on the Pi spoofs its UA as "CrOS x86_64" — never UA-sniff.
  Console mode = the `?fx=low` flag (persisted to localStorage
  `arcade_lowfx`), which kills glows/cursor/backdrop-filter site-wide.

## How to build here (any model)

Decide the design FIRST (mechanics, controls, rules — written down), then
delegate implementation to an agent whose brief contains: the decided
design, the conventions above, and the mandatory self-verification loop.
The quality comes from the brief + verification, not model heroics. Ship
only what passed verification; measure performance on the Pi after deploy.
