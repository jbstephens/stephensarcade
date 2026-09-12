#!/usr/bin/env bash
# ship.sh <slug> ["distinctive string"] ["commit message"]
#
# The distinctive string must exist IN THE SERVED GAME FILE — grep the
# game's built index.html for it before shipping. A commit-message-only
# tag polls forever (burned 15 min on PP-LOOK-3, which was never in code).
#
# Steps 2-3 of the ship pipeline in one command. Run AFTER committing and
# pushing the game's own repo (step 1). This script:
#   1. Looks up the game's source URL in games.json.
#   2. If a distinctive string was given, polls the source URL until the
#      Render deploy serves it (up to 15 min).
#   3. Runs bundle-games.sh (fetch + inject overlays + regen games.js).
#   4. Verifies the game's bundle has the three overlay markers (and the
#      distinctive string, if given).
#   5. Commits the bundle, pulls --rebase, pushes.
#
# Always operates from the repo root regardless of caller cwd (the cwd law).
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="${1:?usage: ship.sh <slug> [\"distinctive string\"] [\"commit message\"]}"
NEEDLE="${2:-}"
MSG="${3:-Bundle: $SLUG}"

SRC=$(python3 - "$SLUG" <<'PY'
import json, sys
for g in json.load(open("games.json")):
    if g["slug"] == sys.argv[1]:
        print(g["source"]); break
else:
    sys.exit(f"ship.sh: unknown slug {sys.argv[1]!r} — not in games.json")
PY
)

if [[ -n "$NEEDLE" ]]; then
  echo "ship.sh: polling $SRC for the distinctive string (Render deploy)..."
  deployed=0
  for i in $(seq 1 60); do
    # NOT `curl | grep -q`: under pipefail, grep -q matching CLOSES the pipe
    # early, curl exits 56, and the pipeline reports the match as a failure.
    # Bit us on the first live run (15 min of discarded matches). Buffer it.
    body=$(curl -fsSL --max-time 30 "$SRC" || true)
    if [[ "$body" == *"$NEEDLE"* ]]; then
      echo "ship.sh: deployed (found after ~$(( (i-1) * 15 ))s)."
      deployed=1
      break
    fi
    sleep 15
  done
  if [[ "$deployed" -ne 1 ]]; then
    echo "ship.sh: TIMEOUT — string not live at $SRC after 15 min. Check the Render deploy." >&2
    exit 1
  fi
fi

# bundle-games.sh exits non-zero if ANY game got skipped (kept last-good);
# that's fine for the fleet, but the slug we're shipping is hard-checked below.
bash scripts/bundle-games.sh \
  || echo "ship.sh: WARNING — bundle-games.sh skipped at least one game (see above); continuing, $SLUG is verified below." >&2

BUNDLE="games/$SLUG/index.html"
[[ -f "$BUNDLE" ]] || { echo "ship.sh: FAIL — $BUNDLE does not exist." >&2; exit 1; }
for m in __arcade_back __arcade_pad_exit __arcade_lowfx; do
  grep -qF "$m" "$BUNDLE" || { echo "ship.sh: FAIL — $BUNDLE missing overlay marker $m." >&2; exit 1; }
done
if [[ -n "$NEEDLE" ]] && ! grep -qF "$NEEDLE" "$BUNDLE"; then
  echo "ship.sh: FAIL — $BUNDLE lacks the distinctive string; the bundle didn't pick up the new deploy." >&2
  exit 1
fi
echo "ship.sh: bundle OK — overlay markers present${NEEDLE:+ + distinctive string}."

git add games/ games.js
if git diff --cached --quiet; then
  echo "ship.sh: nothing to commit — bundle unchanged (already shipped, or the 30-min sync Action beat us to it)."
  exit 0
fi
git commit -m "$MSG"
git pull --rebase --autostash   # unrelated dirty files must never block a ship
git push
echo "ship.sh: pushed. Live shortly at https://ses.q5labs.co/games/$SLUG/ ; the Pi's local mirror syncs within 30 min."
