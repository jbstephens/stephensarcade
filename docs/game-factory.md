# The Game Factory on the console — design + build brief

Status: decided design (John, 2026-10-30). Implementation agents execute
this; they do not re-decide it. Read CLAUDE.md first for house rules.

## What we are doing

Ben (John's son) built his own arcade, **The Game Factory**: repo
`jbstephens/bensarcade` (public; GitHub Pages at
https://jbstephens.github.io/bensarcade/). 133 flat single-file HTML
pages: `index.html` (byte-identical to `arcade.html`) is a page-flipping
"book" launcher that opens each game in a full-screen `<iframe>` and
closes it with a global `closeGame()`. Every game loads Ben's shared
`touchpad.js`, which (a) draws a touch D-pad on touchscreens and (b) maps
standard gamepads to synthetic key presses: D-pad + left stick → arrow
keys, face buttons → each game's configured keys (via a `TOUCHPAD = {...}`
line before the script), SELECT → `Escape`, START → `Enter`, and ✕ → `Enter`
when no face keys are configured.

Goal: the Game Factory plays on the Raspberry Pi console (PS4 pads, no
keyboard/mouse, Chromium kiosk at 1280x720, online or offline) and the
two arcades link to each other.

## HARD RULES

1. **`jbstephens/bensarcade` is READ-ONLY. Never clone it into a writable
   project path, never commit to it, never open a PR, never edit it.** We
   fetch its `main` branch as a tarball and copy files. All changes live in
   THIS repo (`stephensarcade`, local checkout
   `~/Developer/stephensgames/gameconsole`), in copies under `factory/`,
   applied by scripts (never by hand), idempotent and marker-keyed exactly
   like `scripts/inject-back-button.py`.
2. Agents do NOT `git commit`/`git push` and do NOT touch the Pi (no ssh to
   `ses.local`). The orchestrator ships and verifies on hardware.
3. Re-running any script with no upstream change must produce **zero git
   diff** (no timestamps in generated files).

## UX (decided)

- The Pi boots into Stephens Arcade exactly as today.
- Stephens Arcade's carousel gets one card: **GAME FACTORY** (Ben's book
  icon, `factory/icon-512.png`). Launching it navigates to `/factory/`
  (same origin, so it works online at ses.q5labs.co and offline at
  localhost:8080).
- The book's existing **Wormhole** page (Ben's own link "to the FIRST
  arcade Ben made with Dad") returns to Stephens Arcade at `/`.
- **Holding PS (or SELECT+START) for 1s = up one level, everywhere.**
  In a Game Factory game → back to the book (`parent.closeGame()`). On the
  book → Stephens Arcade (`/`). (Stephens games already do this.)
- **Pad cursor**: a pad-driven mouse pointer so the ~79 tap/click-only
  games (Cookbook, Coloring Pages, Print Shop, Jigsaw…) are playable.
- Console-mode hazards neutralised in the copies: `window.print` (57
  games) becomes a toast; canvas `shadowBlur` no-op'd in low-fx mode;
  phantom DualShock sub-devices filtered out of `navigator.getGamepads()`.

## Layout in this repo

```
factory/                 mirror of bensarcade main (flat, same filenames)
factory/index.html       the book (+ console overlays injected)
factory/arcade.html      same file (keep it; touchpad.js regexes on the name)
factory/*.html           games (+ overlays injected)
factory/touchpad.js, manifest.json, icon-180.png, icon-512.png, og-image.png
factory/.mirror.json     {"repo": "jbstephens/bensarcade", "commit": "<sha>"}
lib/three-r128.min.js    vendored copy of the CDN three.js two games use
scripts/bundle-factory.sh      fetch + validate + copy + rewrite + inject
scripts/inject-factory.py      overlay injector (idempotent, marker-keyed)
scripts/factory-overlays/*.html  the overlay snippets
scripts/verify-factory.mjs     headless verification (lib/harness.mjs)
```

Ben's pages reference everything relatively (`touchpad.js?v=2`,
`platformer.html`), so a `/factory/` subpath just works. `.nojekyll` is
not copied.

## Agent A — mirror pipeline (`scripts/bundle-factory.sh` + hooks)

Bash + inline python3, same style/robustness as `scripts/bundle-games.sh`.

1. Download `https://codeload.github.com/jbstephens/bensarcade/tar.gz/refs/heads/main`
   to a temp dir (curl -fsSL, retries). Extract. Look up the commit sha via
   `https://api.github.com/repos/jbstephens/bensarcade/commits/main`
   (unauthenticated; on failure write `"unknown"` — never fail the run on it).
2. VALIDATE before touching `factory/`: `index.html` and `touchpad.js`
   exist; `index.html` contains `The Game Factory`; `*.html` count ≥ 100
   and ≥ 90% of the existing `factory/*.html` count (truncation guard).
   On validation/fetch failure: print a loud `SKIP`, keep the existing
   `factory/` untouched, exit 0 (fail-safe, like bundle-games.sh). Exit 1
   only if there is no existing `factory/` at all.
3. Build into a temp dir: copy `*.html`, `*.js`, `*.json`, `*.png`
   (top level only; skip `.nojekyll`, `.git*`). Write `.mirror.json`
   (sha only, no timestamps). Rewrite in every copied html:
   `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`
   → `/lib/three-r128.min.js` (absolute path: valid at both origins; the
   offline tree copies `lib/`). Vendor the file once: download that exact
   CDN URL to `lib/three-r128.min.js` if missing; verify it contains
   `REVISION="128"`; commit it as a repo asset. Do NOT reuse
   `lab/three.min.js` (different revision).
4. Run `python3 scripts/inject-factory.py <tempdir>` (Agent B's script;
   contract: takes a directory, injects into every `.html` in it, prints
   per-file injected/skipped, exits non-zero on any error). If the script
   does not exist yet, print a warning and continue (so A is testable
   before B lands).
5. Atomic swap: `rm -rf factory && mv tmp factory`. Print a summary
   (files copied, sha, three.js rewrites, injection result).
6. Hooks:
   - `.github/workflows/sync-games.yml`: add a step
     `Mirror the Game Factory` running `./scripts/bundle-factory.sh` after
     the Render re-bundle; include `factory/` and `lib/three-r128.min.js`
     in the porcelain check, `git add`, and the commit message
     (`Auto-sync: ... + factory`).
   - `scripts/build-local.sh`: add `factory` to `DIRS`. Nothing else: the
     Pi's sync timer pulls this repo and rebuilds; it never fetches Ben's
     repo itself.
   - Do NOT call bundle-factory from `bundle-games.sh`/`ship.sh`; they stay
     game-scoped.
7. Verify: run it twice; second run → `git status --porcelain factory lib`
   shows no churn beyond the first. Serve the repo
   (`python3 -m http.server 8975 --bind 127.0.0.1`) and `curl -I` the book,
   a game, `touchpad.js`, `icon-512.png`, and `/lib/three-r128.min.js`.
   Grep that no `cdnjs` three.js reference survives in `factory/`.

## Agent B — console overlays (`scripts/inject-factory.py` + overlays + verify)

Model: `scripts/inject-back-button.py` (marker in file → skip; anchor
missing → warn). Ben's files are minimal HTML: only 70 of 133 have
`<head>`/`</head>`/`<body>`/`</body>` tags. Anchors therefore:

- **HEAD-position** overlays (must run before `touchpad.js`): insert
  immediately BEFORE the first `<script src="touchpad.js` tag; if absent,
  before the first `<script`; if absent, after the first `<meta charset…>`
  tag; else after `<!doctype html>`.
- **END-position** overlays: insert before `</body>` if present, else
  append at end of file.

Overlays live in `scripts/factory-overlays/` and are plain
`<script id="__gf_…">` snippets (plus minimal inline CSS where needed).
All are self-contained IIFEs, zero dependencies, no `shadowBlur`, no
`backdrop-filter`, no per-frame allocations beyond a single rAF loop
(coalesce polling: ONE rAF loop per page may read `navigator.getGamepads()`
for exit + cursor + idle together). "Console mode" below means
`localStorage.getItem('arcade_lowfx') === '1'` (the Stephens launcher
sets it from `?fx=low`; same origin, so the book and its iframes see it).

Classification at inject time: `is_book` = filename is `index.html` or
`arcade.html`; `has_dpad` = file matches `/dpad:\s*true/`.

Overlays (marker id → behaviour):

1. `__gf_padfilter` (HEAD, every file). Wrap `navigator.getGamepads` so
   it returns the same-length array with entries nulled when
   `/motion sensors|touchpad/i.test(pad.id)` or when at least one pad has
   `mapping === 'standard'` and this one does not. Keep original indices.
   Must be installed before `touchpad.js` runs its poll.
2. `__gf_pad_exit` (END, every file). Hold PS (button 16) or SELECT+START
   (8 and 9) for 1000 ms → in a game (`window.parent !== window` and
   `typeof parent.closeGame === 'function'`) call `parent.closeGame()`;
   standalone game (opened directly) → `location.href = '/factory/'`;
   book (not in a game) → `location.href = '/'`. The BOOK must ignore the
   hold while `#player` has class `open` (the iframe's overlay handles it)
   and must require a full release before counting a new hold (so the hold
   that closed the game does not also leave the book). Show a small fixed
   badge (`◄ BOOK` in a game, `◄ ARCADE` on the book; Stephens Arcade's
   yellow `#ffd23f` on dark navy) that appears and swells during the hold,
   like `scripts/pad-exit.html`. Never navigate twice.
3. `__gf_lowfx` (END, every file). Console mode only: no-op
   `CanvasRenderingContext2D.prototype.shadowBlur` and inject
   `* { backdrop-filter:none!important; -webkit-backdrop-filter:none!important; }`
   (copy of `scripts/low-fx.html` minus the `cursor:none`, which the pad
   cursor handles itself — set `cursor:none` only while the pad cursor is
   installed).
4. `__gf_print` (END, every file). Console mode only: replace
   `window.print` with a function that shows a 2.5 s toast
   "🖨️ Printing works on the iPad — not on the TV!" and returns.
5. `__gf_cursor` (END, every file) — the pad cursor. Installed on
   `gamepadconnected` (or if a standard pad is already present at load).
   - A fixed-position arrow cursor element (DOM, ~28 px, white with dark
     outline, `pointer-events:none`, z-index above everything incl.
     Ben's `#tp` at 99999 → use 2147483000). Hidden until moved; sleeps
     (fades out) after 4 s without stick motion; while asleep, buttons do
     NOT click.
   - Movement: RIGHT stick (axes 2/3) always. LEFT stick (axes 0/1) too,
     but only when `!is_book && !has_dpad` (the injector sets
     `window.__GF_CURSOR_LEFT = true` in the snippet for those files;
     in D-pad games the left stick is movement, and on the book it flips
     pages). Deadzone 0.2, speed ~900 px/s at full tilt with a mild ease
     (square the magnitude), clamp to the viewport.
   - Click: ✕ (button 0) or R1 (button 5) while awake. On press dispatch
     `pointermove`+`mousemove` then `pointerdown`+`mousedown` (button 0,
     buttons 1) at `document.elementFromPoint`; while held, moving sends
     `pointermove`/`mousemove` (buttons 1) to the SAME target (drag); on
     release `pointerup`/`mouseup` and, if the cursor moved < 12 px since
     press, `click`. Mirrors how `touchpad.js` turns touches into mouse
     events, so canvas games and DOM-button games both respond. Also send
     plain `mousemove` (no buttons) while moving, throttled to the rAF, so
     hover states work. Events are `bubbles:true, cancelable:true` with
     correct `clientX/Y`, `screenX/Y`, `view`.
   - Book: inactive (hidden, no events) while `#player.open`.
   - Never intercept or consume pad events; `touchpad.js` keeps working.
6. `__gf_idle` (END, every file). Port of `scripts/idle-return.html`:
   15 min with no key/pointer/touch/pad activity → `parent.closeGame()`
   in a game, else `location.href = '/'`.
7. `__gf_book` (END, book only). `window.open` override: if the URL
   contains `ses.q5labs.co`, schedule `location.href = '/'` after 1300 ms
   (Ben's `jumpWormhole` plays its whoosh for 1.3 s and then calls
   `show(cur)` when `window.open` returned truthy — so return `{}`);
   any other URL → return `null` (no popups in kiosk). Leave GA alone
   (hostname-guarded off anyway).

CLI: `python3 scripts/inject-factory.py <dir>` → processes every `*.html`
in `<dir>` (non-recursive). Also accepts explicit file paths. Idempotent;
deterministic output; exit 1 on any exception.

Verification — write `scripts/verify-factory.mjs` on `lib/harness.mjs`
(`node --experimental-websocket`, Chrome launched with `--mute-audio`,
stubbed standard pad; `addScriptToEvaluateOnNewDocument` applies to
iframes too — confirm). Serve the repo root on a free port and drive:

- The book (`/factory/`): loads with zero non-noise console errors; pad
  D-pad right flips a page; ✕ on a game page opens an iframe
  (`#player.open`); PS held 1.1 s inside the game closes it
  (`#player` loses `open`, iframe removed); PS held on the book with no
  game open navigates to `/`; the wormhole: calling `window.open('https://ses.q5labs.co')`
  returns truthy and the page navigates to `/` within ~2 s.
- Three games standalone: `platformer.html` (D-pad game: left stick must
  NOT move the cursor, right stick must), `cookbook.html` (pointer game:
  left + right stick move the cursor; ✕ dispatches a `click` at the cursor
  — verify with an injected capture listener; `window.print()` in console
  mode shows the toast and returns), `jigsaw.html` (drag: press, move,
  release yields mousedown/mousemove/mouseup on the same element).
- Phantom filter: stub a second pad with id `Wireless Controller Motion
  Sensors`; assert the wrapped `getGamepads()` nulls it.
- Determinism: inject twice → identical bytes. Marker count per file: 6
  (+1 for the book).
- 1280x720 screenshots of the book and each of the three games into
  `verify-shots/factory-*.png`; LOOK at them (the cursor must be visible
  and the exit badge not overlapping Ben's UI badly).

Print a summary table; exit non-zero on any failure.

## Agent C (orchestrator does this) — Stephens Arcade card

`games.json` entry without `source`:
`{"slug":"game-factory","title":"GAME FACTORY","genre":"BY BEN · 130+ GAMES","status":"PRESS START","icon":"gamefactory","iconSrc":"/factory/icon-512.png","href":"/factory/"}`.
`bundle-games.sh`, `verify-game.mjs all`, `build-landing.mjs`, `ship.sh`
skip entries with no `source`. `index.html`: card uses `g.iconSrc` when
present, else `buildIcon`; `launch()` goes to `game.href` when present.

## Ship + hardware (orchestrator)

Commit on `main`, push → Render deploys ses.q5labs.co; the Pi's sync timer
pulls within 30 min (or force: `sudo systemctl start ses-arcade-sync`).
On the Pi (check `curl localhost:9222/json` first; never hijack a game):
book fps at 720p, PS-hold at each level, pointer game with the cursor,
D-pad game, print stub, wormhole, phantom-pad check with a real DualShock,
offline boot. Park the console on the Stephens menu afterwards.
