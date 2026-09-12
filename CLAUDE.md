# Stephens Arcade — house rules

Family web arcade (ses.q5labs.co) that boots on a Raspberry Pi 5 console
(Chromium kiosk, 1280x720@60, PS4 pads) and also runs on iPads/desktops.
Built by John and his two sons. Kid-proof and 60fps-on-the-Pi are the two
non-negotiables.

## Repo map (siblings of this repo)

Each game is a SINGLE self-contained HTML file in its own repo under
`~/Developer/stephensgames/`. This repo (`gameconsole`) is the launcher
shell; its root is the web root on Render. The authoritative game list
is `games.json` (18 entries), not this map.

Local source repos: `bubbledeep`, `castleforge`, `fallenmoon`,
`islandforge`, `ninthinning`, `nyancatracing`, `phaserwars`,
`phaserwars2`, `powderpeak`, `ringracer`, `shatteredsun`. Name gotchas:
`phaserwars` is Phaser Wars 1 (serves `fightinggame.html`; index.html is
a meta-refresh loader); `ninthinning` is Ninth Inning (index.html and
baseball.html must stay byte-identical).

STILL IN iCLOUD, sandbox-unreachable — re-clone from `jbstephens/<name>`
before working on one: `meteorblaster`, `blockquarry`, `ghostpatrol`,
`screamrocket`, `hissandrun`, `broforce`, `candybattle`. The old
`~/Documents/Projects/stephensgames/` path is dead.

Fallen Moon builds `index.html` from `test/src/p*.html` via
`bash test/build.sh` — never hand-edit its index.html. Powder Peak and
Ring Racer use the same parts+build.sh pattern (in `test/`).

## Change tiers — match the process to the change

Decide the tier FIRST. It sets who does the work and how much
verification is owed. The full standard exists for changes that can
break the console; don't spend it on changes that can't. When unsure,
ask "can this plausibly drop the Pi below 60fps or break pad
reachability?" — if no, it's Tier 1 or 2. Pick the lighter tier and
escalate only on evidence.

- **Tier 1 — tuning, text, small fix** (no new state/UI, render path
  untouched): edit directly in the session. Verify: `node --check` the
  inline JS, `node --experimental-websocket scripts/verify-game.mjs
  <slug>`, exercise the changed behavior once. Ship. No screenshots, no
  Pi run.
- **Tier 2 — feature in an existing game** (new UI/state — save slots,
  a new menu, a new mode — hot render path untouched): edit directly in
  the session. Verify: Tier 1 + drive the NEW feature end-to-end with
  real input (pad stub + keyboard) + one 1280x720 screenshot of the new
  state that you actually look at. Pi FPS check only if per-frame code
  changed.
- **Tier 3 — new game, render/perf work, engine refactors, anything
  touching the per-frame hot path**: the full verification standard
  below, design-first, agent build with a complete brief, mandatory Pi
  verification. Use the `/new-game` skill for new games.

## Ship pipeline (always this order)

1. Commit+push the game repo → its Render service auto-deploys
   (`<name>.onrender.com`).
2. In THIS repo (cwd MUST be gameconsole): `bash scripts/ship.sh <slug>
   ["distinctive string"]` — polls the deploy for the string, re-bundles
   via bundle-games.sh, verifies the overlay markers (`__arcade_back`,
   `__arcade_pad_exit`, `__arcade_lowfx`), commits and pushes. Don't sit
   idle while it polls — a GitHub Action re-syncs bundles every 30 min,
   so a pushed game ships itself eventually; ship.sh just makes it
   immediate. Never hand-edit files under games/.
3. Console check per tier: Tier 1–2 = optional spot-check next time the
   console is free; Tier 3 = mandatory Pi verification (fps + feel)
   before calling it shipped.

The Pi itself serves the arcade from a local mirror (lighttpd on
localhost:8080, git-pull sync every 30 min when online) — pushed changes
reach the console within the sync window without any manual step.

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
- No world-sized canvases; bake per-region/per-island. And measure the
  COST OF EACH BAKE on the Pi, not just steady-state fps — bakes fire on
  gameplay events, and a big canvas makes every bake super-linearly
  slower (Island Forge: 6.5ms → 5.25s for 4x area). Static 60fps ≠
  shippable.
- Desktop/headless op counts MISS DOM compositing costs — final perf
  verdicts come from the Pi itself.

## Verification standard (Tier 3 — the full bar)

- `node --check` the extracted inline JS.
- Headless Chrome + CDP harness with stubbed `navigator.getGamepads`
  (fake standard-mapping pads injected before page scripts) — ALWAYS
  launch test Chrome with `--mute-audio` (headless still plays sound
  through the host Mac's speakers otherwise): drive every state — menus,
  gameplay, pause/resume, death, restart, 2P join/down — asserting zero
  console errors. Keyboard-only regression too.
- Instrument the 2D context prototype to count per-frame ops vs budget.
- CDP screenshots at 1280x720 (plus tablet/phone if UI changed) — actually
  LOOK at them and iterate; overlapping HUD boxes and programmer-art are
  the recurring failure modes.
- The committed fast harness (`scripts/verify-game.mjs <slug>|all`) is
  the regression floor for every tier — Tier 3 builds on it, never
  replaces it.

## Console operations

- `ssh arcade@ses.local` (passwordless key; passwordless sudo). Config in
  `/etc/ses-kiosk.conf` (SES_URL has `?fx=low`, SES_MODE=1280x720@60,
  SES_DEBUG_PORT=9222). `pi/README.md` = build guide; `pi/setup.sh`
  provisions; kiosk self-heals display-mode drift (TV HDMI renegotiation)
  and waits for real audio at boot.
- Drive/measure the live kiosk: `ssh -f -N -L 9223:localhost:9222
  arcade@ses.local`, then `CDP_PORT=9223 node pi/cdp.mjs targets|nav|eval|fps`.
  Check `targets` FIRST — never hijack the console mid-game; park it back
  on the menu when done.
- A game reading ~30fps on the Pi = check display mode, then reboot,
  BEFORE blaming code (TV drifts to 4K@30; long-uptime compositor rot
  locks ~30 and only a reboot cures it). Watchdog crons already reboot a
  parked idle console; never declare a perf regression off an un-rebooted
  Pi.
- Chromium on the Pi spoofs its UA as "CrOS x86_64" — never UA-sniff.
  Console mode = the `?fx=low` flag (persisted to localStorage
  `arcade_lowfx`), which kills glows/cursor/backdrop-filter site-wide.

## How to build here (any model)

**Tier 1–2: work directly in the session.** No design doc, no delegation
ceremony, no agent brief — edit, verify per tier, ship via ship.sh. The
1.5-hour save-slots change should be a 15-minute change (John,
2026-09-11).

**Tier 3: design first, then delegate.** Decide the design (mechanics,
controls, rules — written down), then delegate implementation to an
agent whose brief contains: the decided design, the conventions above,
and the mandatory self-verification loop. The quality comes from the
brief + verification, not model heroics. Agent model tiers (John,
2026-09-03; scoped to Tier 3 on 2026-09-11): OPUS for anything that
might need to diagnose or fix — verification closers, triage, audits (a
red result is an investigation, not a re-run). SONNET for mechanical
chores with crisp pass/fail — deploy polling, marker checks, screenshot
batches. Avoid many parallel agents on this Mac: CPU contention fakes
test regressions. Ship only what passed verification; measure
performance on the Pi after deploy.
