---
name: new-game
description: Scaffold, build, verify, and ship a new game for Stephens Arcade end-to-end — from empty directory to playable on the Pi console. Use when the user wants to add a new game (or do major feature work on an existing one; skip the scaffold steps).
---

# New game for Stephens Arcade

Read CLAUDE.md in this repo first — it holds the conventions, performance
commandments, and verification standard this skill assumes. Follow the
phases in order; do not skip verification gates.

## Phase 0 — Design on paper (with the user)

Lock these BEFORE any code: core mechanic and central tension; controls
(gamepad hold/press mapping + keyboard; touch comes free via the shared
virtual pad overlay — only design touch if the game wants extra
direct-manipulation gestures like tap-to-walk or board swipes); rules for
death/damage/growth/score; single-player vs drop-in 2P; visual direction
(one reference, e.g. "Crossy Road angle"). Kid-friendly defaults: shorten
don't kill, respawn don't end, mercy mechanics when pinned. Write the
decided design into the build brief verbatim — implementation agents
execute decisions, they don't make them.

## Phase 1 — Scaffold

```sh
cd ~/Documents/Projects/stephensgames
mkdir <name> && cd <name> && git init
git remote add origin https://github.com/jbstephens/<name>.git  # user creates the GH repo
```
Ask the user to create the GitHub repo (if missing) and, before Phase 4,
the Render Static Site named `<name>` (URL becomes `<name>.onrender.com`).

## Phase 2 — Build via agent

One general-purpose agent, one self-contained `index.html`, no external
assets. The brief MUST contain, verbatim where applicable:
1. The Phase-0 design, marked "decided — implement as written, tune numbers for fun".
2. The game conventions + performance commandments from CLAUDE.md
   (controller.js include + guards, pad-reachability, reserved combos,
   no shadowBlur, no backdrop-filter, prebaked sprites, <150 drawImage
   budget, pooling, lazy WebAudio, localStorage best under `<slug>_best`).
   Explicitly include: "Do NOT build touch d-pads/joysticks/buttons —
   controller.js injects a standard virtual pad overlay (touchpad-v1)
   that drives pad(0) on touch devices. Direct-manipulation gestures
   (tap/swipe/drag on the game itself) are welcome and coexist with it.
   The <head> MUST have the standard metas: viewport
   `width=device-width, initial-scale=1.0, maximum-scale=1.0,
   user-scalable=no, viewport-fit=cover` plus the three
   apple-mobile-web-app-* metas (capable=yes, black-translucent, title)."
3. The verification loop as a RETURN CONDITION (Phase 3 list) — "do not
   return until all of this passes", including "LOOK at your screenshots
   and iterate until it meets the visual bar".
4. "Do NOT commit" and "do NOT add analytics/back-button/quit overlays
   (the bundler injects them)".
Point it at an existing game as a conventions reference
(meteorblaster/meteorblaster.html is the exemplar) and at
gameconsole/lib/controller.js for the pad API.

## Phase 3 — Verification gate (the agent runs it; you audit it)

- `node --check` extracted inline JS.
- Headless Chrome + CDP, stubbed `navigator.getGamepads` (fake
  standard-mapping pads injected before page scripts): drive title →
  gameplay → damage/death → game over → restart, pause/resume from pad,
  keyboard-only regression, 2P join/down/respawn if applicable — zero
  console errors, every state pad-reachable.
- 2D-context prototype instrumentation: per-frame op counts within budget.
- Touch pass (CDP touch emulation, no gamepad stub): first tap engages
  `#__arcade_touchpad`; drive title → gameplay with only the virtual
  stick/✕; body gets `input-pad`; zero console errors. (Pattern:
  gameconsole/scripts/test-touchpad.mjs — needs --experimental-websocket
  on node 20 and --enable-unsafe-swiftshader if the game uses WebGL.)
- Screenshots of title / busy gameplay / game over at 1280x720, plus one
  gameplay shot at 1180x820 with the touch overlay engaged — YOU read
  the report AND look at the screenshots yourself before shipping.

## Phase 4 — Ship

```sh
# game repo: review diff, commit, push, then poll until deployed
curl -fsSL https://<name>.onrender.com/ | grep -q "<distinctive-string>"
# gameconsole repo:
#   1. games.json entry: {slug, title, genre, status: "PRESS START", icon, source}
#   2. index.html: add an ICON_BUILDERS.<icon>(cx) canvas icon (180x180,
#      chunky, matches the game's art; no external images)
bash scripts/bundle-games.sh   # fetch + inject overlays + regen games.js
# verify bundle has the game + __arcade_back/__arcade_pad_exit/__arcade_lowfx
git add -A && git commit && git pull --rebase && git push
# poll https://ses.q5labs.co/games/<slug>/index.html until live
```

## Phase 5 — Verify on the console

```sh
ssh -f -N -L 9223:localhost:9222 arcade@ses.local
# node 20 needs: node --experimental-websocket pi/cdp.mjs …
CDP_PORT=9223 node pi/cdp.mjs targets   # NEVER hijack an active game
CDP_PORT=9223 node pi/cdp.mjs nav https://ses.q5labs.co/games/<slug>/
CDP_PORT=9223 node pi/cdp.mjs fps 4     # want ~60; if low, instrument ops live
CDP_PORT=9223 node pi/cdp.mjs nav https://ses.q5labs.co/   # park on menu
```
If the Pi is slow but desktop was fine: check DOM costs (backdrop-filter!)
before touching the canvas code. Report results to the user with the
screenshots' paths and the measured console fps.
