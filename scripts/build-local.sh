#!/usr/bin/env bash
# Stephens Arcade — build an OFFLINE-capable copy of the web root.
#
# Produces ./local-arcade/ : a serve-ready, fully self-contained copy of the
# arcade web root that needs NOTHING from the network. This is what the Pi's
# local web server (pi/ses-webserver.service) serves at http://localhost:8080/
# so the cabinet plays with no internet.
#
# The ONE thing that isn't offline-safe in the shipped bundles is that every
# game hard-references the hosted controller lib:
#     <script src="https://ses.q5labs.co/lib/controller.js"></script>
# Offline that fetch 404s and the pads die. controller.js already lives in this
# repo at lib/controller.js, so we copy it into the offline tree and rewrite
# each game's reference to the repo-relative "/lib/controller.js".
#
# Analytics / gtag references are left alone on purpose — they're non-essential
# and already guarded, so a failed offline fetch is harmless.
#
# Idempotent and re-runnable. Builds into a temp dir and atomically swaps it in,
# so a live server never sees a half-copied tree.
#
#   Usage:  bash scripts/build-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/local-arcade"
TMP="$ROOT/.local-arcade.tmp.$$"
HOSTED='https://ses.q5labs.co/lib/controller.js'
LOCALREF='/lib/controller.js'

# Web-root assets that are actually served. Anything not here (pi/, scripts/,
# node_modules/, .git/, CLAUDE.md, verify-shots/ …) is build/tooling and is
# intentionally NOT shipped into the offline tree.
FILES=(index.html games.js games.json humans.txt robots.txt sitemap.xml)
DIRS=(games lib site arcade)

command -v perl >/dev/null 2>&1 || { echo "build-local: needs perl (present on Pi OS + macOS)" >&2; exit 1; }

echo "▸ Building offline arcade from: $ROOT"
rm -rf "$TMP"
mkdir -p "$TMP"

copied=0
for f in "${FILES[@]}"; do
  if [ -f "$ROOT/$f" ]; then
    cp -p "$ROOT/$f" "$TMP/$f"
    copied=$((copied + 1))
  else
    echo "  (skip missing file: $f)"
  fi
done
for d in "${DIRS[@]}"; do
  if [ -d "$ROOT/$d" ]; then
    cp -R "$ROOT/$d" "$TMP/$d"
    n=$(find "$TMP/$d" -type f | wc -l | tr -d ' ')
    copied=$((copied + n))
  else
    echo "  (skip missing dir: $d)"
  fi
done

# Sanity: controller.js MUST be present in the offline tree, or every game is
# controller-less. Fail loudly rather than ship a broken offline build.
if [ ! -f "$TMP/lib/controller.js" ]; then
  echo "build-local: FATAL — lib/controller.js missing from offline tree" >&2
  rm -rf "$TMP"
  exit 1
fi

# Rewrite the hosted controller reference -> repo-relative, in every game.
# perl -pi is used (not sed -i) because it behaves identically on the Pi's GNU
# sed and macOS's BSD sed, which differ on the -i syntax.
rewrote_files=0
rewrote_refs=0
for g in "$TMP"/games/*/index.html; do
  [ -f "$g" ] || continue
  before=$( { grep -o "$HOSTED" "$g" || true; } | wc -l | tr -d ' ')
  if [ "$before" -gt 0 ]; then
    perl -pi -e "s#\Q$HOSTED\E#$LOCALREF#g" "$g"
    rewrote_files=$((rewrote_files + 1))
    rewrote_refs=$((rewrote_refs + before))
  fi
done

# Verify no hosted controller references survived anywhere in the offline tree.
leftover=$( { grep -rl "$HOSTED" "$TMP/games" 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$leftover" -ne 0 ]; then
  echo "build-local: FATAL — $leftover game(s) still reference the hosted controller" >&2
  grep -rl "$HOSTED" "$TMP/games" >&2 || true
  rm -rf "$TMP"
  exit 1
fi

# Atomic swap: old tree is replaced only once the new one is fully built.
rm -rf "$OUT"
mv "$TMP" "$OUT"

echo
echo "  ✔ offline arcade ready: $OUT"
echo "    files/assets copied : $copied"
echo "    games rewritten     : $rewrote_files  ($rewrote_refs controller refs -> $LOCALREF)"
echo "    controller.js served: $OUT/lib/controller.js"
echo
echo "  Serve it with:  (cd \"$OUT\" && python3 -m http.server 8080 --bind 127.0.0.1)"
echo "  Or on the Pi it is served by the ses-webserver systemd unit (lighttpd)."
