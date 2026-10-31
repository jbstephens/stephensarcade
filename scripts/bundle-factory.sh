#!/usr/bin/env bash
# Mirror Ben's arcade, The Game Factory (jbstephens/bensarcade, main branch),
# into ./factory/ so it is served same-origin at /factory/ — online at
# ses.q5labs.co and offline on the Pi (build-local.sh copies factory/).
# Design: docs/game-factory.md ("Agent A — mirror pipeline").
#
# HARD RULE: jbstephens/bensarcade is Ben's repo and is READ-ONLY. We only
# download its main branch as a TARBALL and copy files out of it. Never clone,
# commit, push or PR to it. All changes live in THIS repo under factory/, and
# are applied here by scripts (never by hand).
#
# ROBUSTNESS (mirrors bundle-games.sh): the sync Action commits the result
# straight to main, so a bad fetch must never replace a good mirror.
#   1. fetch the tarball to a temp dir (curl -f, retries) and extract it
#   2. VALIDATE before touching factory/: index.html + touchpad.js present,
#      index.html is really The Game Factory, >=100 *.html and >=90% of the
#      current factory/ html count (truncation guard)
#   3. build the new tree in a temp dir: copy top-level *.html *.js *.json
#      *.png, write .mirror.json (sha only — NO timestamps), rewrite the CDN
#      three.js r128 reference to the vendored /lib/three-r128.min.js
#   4. inject the console overlays (scripts/inject-factory.py)
#   5. atomic swap: rm -rf factory && mv tmp factory
# Any fetch/validation failure prints a loud SKIP, keeps the existing
# factory/ untouched and exits 0 (fail-safe). Exit 1 only when there is no
# existing factory/ at all (nothing to fall back to) or the overlay injector
# fails (a broken console build must surface).
#
# Deterministic: with no upstream change a re-run produces zero git diff.
#
# Env overrides (testing the fail-safe only):
#   GF_TARBALL_URL  default https://codeload.github.com/jbstephens/bensarcade/tar.gz/refs/heads/main
#   GF_API_URL      default https://api.github.com/repos/jbstephens/bensarcade/commits/main
#
#   Usage:  bash scripts/bundle-factory.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARBALL_URL="${GF_TARBALL_URL:-https://codeload.github.com/jbstephens/bensarcade/tar.gz/refs/heads/main}"
API_URL="${GF_API_URL:-https://api.github.com/repos/jbstephens/bensarcade/commits/main}"
THREE_CDN='https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
THREE_LOCAL='/lib/three-r128.min.js'
THREE_FILE="$ROOT/lib/three-r128.min.js"
OUT="$ROOT/factory"
# Build dir lives inside the repo so the final mv is a same-filesystem rename.
TMP="$ROOT/.factory.tmp.$$"
DL="$(mktemp -d)"

cleanup() { rm -rf "$DL" "$TMP"; }
trap cleanup EXIT

# Fail-safe exit: keep the existing mirror, exit 0 — unless there is none.
skip() {
  echo
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "SKIP game-factory: $1"
  if [ -d "$OUT" ]; then
    echo "     keeping existing factory/ untouched"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    exit 0
  fi
  echo "     and there is NO existing factory/ to fall back to — failing"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  exit 1
}

echo "▸ Mirroring The Game Factory  ←  $TARBALL_URL"

# ── 1. fetch + extract ──────────────────────────────────────────────────────
if ! curl -fsSL --max-time 120 --retry 3 --retry-delay 5 --retry-all-errors \
     -o "$DL/bensarcade.tar.gz" "$TARBALL_URL"; then
  skip "tarball fetch failed ($TARBALL_URL)"
fi
mkdir -p "$DL/x"
if ! tar -xzf "$DL/bensarcade.tar.gz" -C "$DL/x"; then
  skip "tarball extract failed"
fi
# codeload tarballs have a single top-level dir (bensarcade-main/).
SRC="$(find "$DL/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$SRC" ] || skip "tarball contained no top-level directory"

# Commit sha — informational only; never fail the run on it. Read it from the
# tarball itself first (codeload writes the commit into the pax global header):
# it is exactly the commit we mirror, and it needs no extra request, so a
# rate-limited / flaky api.github.com can't flip .mirror.json to "unknown"
# (which would be a no-op upstream change committed by the sync Action).
SHA="$(python3 -I - "$DL/bensarcade.tar.gz" <<'PY' 2>/dev/null
import re, sys, tarfile
try:
    with tarfile.open(sys.argv[1]) as t:
        s = t.pax_headers.get("comment", "")
except Exception:
    s = ""
print(s if re.fullmatch(r"[0-9a-f]{40}", s or "") else "")
PY
)"
[ -n "$SHA" ] || SHA="$(curl -fsSL --max-time 30 --retry 2 --retry-delay 3 \
        -H 'Accept: application/vnd.github+json' "$API_URL" 2>/dev/null \
      | python3 -I -c 'import json,sys
try:
    s = json.load(sys.stdin).get("sha", "")
except Exception:
    s = ""
print(s if isinstance(s, str) and len(s) == 40 else "unknown")' 2>/dev/null)"
[ -n "$SHA" ] || SHA="unknown"
echo "  commit: $SHA"

# ── 2. validate (before touching factory/) ─────────────────────────────────
WHY="$(python3 -I - "$SRC" "$OUT" <<'PY'
import pathlib, sys
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def htmls(d):
    return [p for p in d.glob("*.html") if p.is_file() and not p.is_symlink()]
idx = src / "index.html"
if not idx.is_file():
    print("index.html missing from upstream"); sys.exit()
if not (src / "touchpad.js").is_file():
    print("touchpad.js missing from upstream"); sys.exit()
if "The Game Factory" not in idx.read_text("utf-8", "replace"):
    print("index.html does not contain 'The Game Factory'"); sys.exit()
n = len(htmls(src))
if n < 100:
    print(f"only {n} *.html upstream (< 100 floor)"); sys.exit()
if out.is_dir():
    have = len(htmls(out))
    if have and n * 10 < have * 9:
        print(f"only {n} *.html upstream vs {have} in factory/ (< 90% truncation guard)"); sys.exit()
PY
)"
[ -z "$WHY" ] || skip "validation failed: $WHY"

# ── 3a. vendor three.js r128 once (repo asset) ─────────────────────────────
# The minified r128 build never spells REVISION="128" literally: it declares
# const <v>="128" up front and later sets <ns>.REVISION=<v>. Accept either.
is_r128() {
  python3 -I - "$1" <<'PY'
import re, sys
t = open(sys.argv[1], encoding="utf-8", errors="replace").read()
if 'REVISION="128"' in t or "REVISION='128'" in t:
    sys.exit(0)
m = re.search(r'const ([A-Za-z_$][\w$]*)="128"', t)
ok = m and re.search(r'\.REVISION=' + re.escape(m.group(1)) + r'(?![\w$])', t)
sys.exit(0 if ok else 1)
PY
}
if [ ! -f "$THREE_FILE" ]; then
  echo "  vendoring three.js r128  ←  $THREE_CDN"
  if ! curl -fsSL --max-time 60 --retry 3 --retry-delay 5 --retry-all-errors \
       -o "$DL/three.min.js" "$THREE_CDN"; then
    skip "three.js r128 download failed (two games need it)"
  fi
  is_r128 "$DL/three.min.js" || skip "downloaded three.js is not r128"
  mkdir -p "$ROOT/lib"
  mv "$DL/three.min.js" "$THREE_FILE"
fi
is_r128 "$THREE_FILE" || skip "lib/three-r128.min.js is not three.js r128"

# ── 3b. build the new tree ─────────────────────────────────────────────────
rm -rf "$TMP"
mkdir -p "$TMP"
SUMMARY="$(python3 -I - "$SRC" "$TMP" "$SHA" "$THREE_CDN" "$THREE_LOCAL" <<'PY'
import json, pathlib, shutil, sys
src, dst, sha, cdn, local = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), *sys.argv[3:]
copied = rew_files = rew_refs = 0
for p in sorted(src.iterdir()):
    # top level only, regular files only (no symlinks), wanted extensions only;
    # .nojekyll / .git* fall out naturally.
    if p.is_symlink() or not p.is_file() or p.name.startswith("."):
        continue
    if p.suffix.lower() not in (".html", ".js", ".json", ".png"):
        continue
    shutil.copyfile(p, dst / p.name)  # copyfile: no mtimes/modes carried over
    copied += 1
    if p.suffix.lower() == ".html":
        data = (dst / p.name).read_bytes()
        n = data.count(cdn.encode())
        if n:
            (dst / p.name).write_bytes(data.replace(cdn.encode(), local.encode()))
            rew_files += 1
            rew_refs += n
(dst / ".mirror.json").write_text(
    json.dumps({"repo": "jbstephens/bensarcade", "commit": sha}, indent=2) + "\n")
left = [p.name for p in dst.glob("*.html") if cdn.encode() in p.read_bytes()]
if left:
    print("FATAL leftover cdn three.js refs: " + ", ".join(left)); sys.exit(1)
html = len(list(dst.glob("*.html")))
print(f"{copied} {html} {rew_files} {rew_refs}")
PY
)" || skip "build step failed: $SUMMARY"
read -r COPIED HTMLN REWF REWR <<<"$SUMMARY"

# ── 4. inject console overlays (Agent B's injector) ────────────────────────
INJECT="scripts/inject-factory.py"
if [ -f "$INJECT" ]; then
  echo "  injecting console overlays ($INJECT)"
  if ! INJ_OUT="$(python3 "$INJECT" "$TMP" 2>&1)"; then
    echo "$INJ_OUT" | tail -n 40
    echo
    echo "FAIL game-factory: $INJECT exited non-zero — keeping existing factory/ untouched" >&2
    exit 1
  fi
  inj_n=$(printf '%s\n' "$INJ_OUT" | grep -c '^  injected (' || true)
  skp_n=$(printf '%s\n' "$INJ_OUT" | grep -c '^  skipped (' || true)
  INJ_RESULT="ok ($inj_n injected, $skp_n skipped lines)"
else
  echo "  WARNING: $INJECT not found — mirroring WITHOUT console overlays"
  INJ_RESULT="NOT RUN (injector missing)"
fi

# ── 5. atomic swap ─────────────────────────────────────────────────────────
rm -rf "$OUT"
mv "$TMP" "$OUT"

echo
echo "  ✔ factory/ mirrored from jbstephens/bensarcade@$SHA"
echo "    files copied      : $COPIED  ($HTMLN html)"
echo "    three.js rewrites : $REWF file(s), $REWR ref(s) -> $THREE_LOCAL"
echo "    overlay injection : $INJ_RESULT"
echo "done."
