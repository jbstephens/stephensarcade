#!/usr/bin/env bash
# Stephens Arcade — offline-tree sync.
#
# Run periodically by ses-arcade-sync.timer. When the Pi is ONLINE this pulls
# the latest arcade repo and rebuilds local-arcade/ so the offline cabinet gets
# the newest games. When OFFLINE it does nothing and leaves the last good build
# serving — the cabinet keeps playing whatever it last synced.
#
# Non-destructive and logged (to the systemd journal). It NEVER touches the
# running server directly: build-local.sh swaps the tree in atomically, and
# lighttpd serves static files with no restart needed.
#
# Repo checkout path (documented, overridable):
#   SES_REPO_DIR   default: $HOME/stephensarcade  (where setup.sh clones it)
set -uo pipefail

REPO_DIR="${SES_REPO_DIR:-$HOME/stephensarcade}"
BRANCH="${SES_SYNC_BRANCH:-main}"
REMOTE_PROBE="${SES_SYNC_PROBE:-https://github.com}"

log() { printf '%s ses-arcade-sync: %s\n' "$(date -Is)" "$*"; }

if [ ! -d "$REPO_DIR/.git" ]; then
  log "no git checkout at $REPO_DIR — nothing to sync (offline build is served as-is)"
  exit 0
fi

# Offline? Do nothing, successfully. The cabinet keeps serving the last build.
if ! curl -fsI --max-time 5 "$REMOTE_PROBE" >/dev/null 2>&1; then
  log "offline ($REMOTE_PROBE unreachable) — keeping last offline build"
  exit 0
fi

cd "$REPO_DIR" || { log "cannot cd $REPO_DIR"; exit 1; }

before="$(git rev-parse HEAD 2>/dev/null || echo none)"

# Fetch + fast-forward only. --ff-only guarantees we never clobber or merge —
# if local history ever diverged, we skip rather than fight it.
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  log "git fetch failed — keeping last offline build"
  exit 0
fi
if ! git merge --ff-only --quiet "origin/$BRANCH" 2>/dev/null; then
  log "cannot fast-forward $BRANCH (local diverged?) — keeping last offline build"
  exit 0
fi

after="$(git rev-parse HEAD 2>/dev/null || echo none)"

if [ "$before" = "$after" ]; then
  log "already up to date at ${after:0:12} — offline build unchanged"
  # Still ensure a build exists (first-run / manual wipe safety).
  [ -f "$REPO_DIR/local-arcade/index.html" ] && exit 0
  log "no offline build present — building now"
fi

log "updated ${before:0:12} -> ${after:0:12}; rebuilding offline tree"
if bash "$REPO_DIR/scripts/build-local.sh"; then
  log "offline tree rebuilt OK"
else
  log "build-local.sh FAILED — the previous offline build is still in place"
  exit 1
fi
