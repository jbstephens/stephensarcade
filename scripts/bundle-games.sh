#!/usr/bin/env bash
# Re-bundle the latest games from Render into ./games/ so they're served
# same-origin as the arcade launcher. This is the fix for iOS standalone
# mode (home-screen install) popping cross-origin links into Safari.
#
# Run this whenever a game is updated on Render:
#   ./scripts/bundle-games.sh
#
# Then `git diff` will show what changed; commit and push.
set -euo pipefail

cd "$(dirname "$0")/.."

# slug | source URL on Render
GAMES=(
  "phaser-wars|https://phaser-wars.onrender.com/fightinggame.html"
  "ninth-inning|https://ninthinning.onrender.com/"
)

for entry in "${GAMES[@]}"; do
  slug="${entry%%|*}"
  url="${entry#*|}"
  echo "→ $slug  ←  $url"
  mkdir -p "games/$slug"
  curl -fsSL --max-time 30 -o "games/$slug/index.html" "$url"
done

python3 scripts/inject-back-button.py games/*/index.html
echo "done."
