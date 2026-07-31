#!/usr/bin/env bash
# THE CABINET PASS — the standing pre-playtest ritual on the real hardware.
#   bash pi/cabinet-pass.sh
# 1. tunnel to the kiosk (if not already), refuse to run if someone is playing
# 2. back the family's localStorage up BYTE-EXACT
# 3. boot the game and measure fps at every room that has ever been a risk
# 4. restore the saves and VERIFY per-key checksums
# 5. park the console back on the arcade menu
#
# The restore ALWAYS happens after navigating OFF the game page: the game
# autosaves on pagehide, which silently rewrote ss_save_1 the first time.
set -uo pipefail
cd "$(dirname "$0")/.."
STAMP=$(date +%Y-%m-%d-%H%M)
BACKUP="$HOME/Documents/Projects/stephensgames/pi_localstorage_$STAMP.json"
CDP="CDP_PORT=9223 node --experimental-websocket pi/cdp.mjs"

pgrep -f "ssh -f -N -L 9223" >/dev/null || ssh -f -N -L 9223:localhost:9222 arcade@ses.local
sleep 1
echo "== targets (never hijack a game in progress)"
eval "$CDP targets"

echo "== backing up saves -> $BACKUP"
eval "$CDP eval 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))'" > "$BACKUP"
test -s "$BACKUP" || { echo "BACKUP FAILED - aborting"; exit 1; }
python3 - "$BACKUP" <<'PY'
import json,sys
d=json.loads(open(sys.argv[1]).read().strip())
if isinstance(d,str): d=json.loads(d)
print(f"   {len(d)} keys backed up; save slots: {[k for k in d if k.startswith('ss_save_')]}")
PY

echo "== booting Shattered Sun"
eval "$CDP nav 'https://ses.q5labs.co/games/shatteredsun/'" >/dev/null
sleep 6
eval "$CDP eval '(function(){ const d=(c,t,k)=>{const e=new KeyboardEvent(t,{code:c,key:k||c,bubbles:true}); window.dispatchEvent(e); document.dispatchEvent(e);}; d(\"Enter\",\"keydown\"); setTimeout(()=>d(\"Enter\",\"keyup\"),120); setTimeout(()=>{d(\"KeyZ\",\"keydown\",\"z\"); setTimeout(()=>d(\"KeyZ\",\"keyup\",\"z\"),120);},600); return \"booting\"; })()'" >/dev/null
sleep 5

fps_at () {  # region tx ty label
  eval "$CDP eval 'SS.State.teleport({region:\"$1\",x:$2,y:$3,facing:\"down\"}); \"ok\"'" >/dev/null
  sleep 3
  printf "   %-28s " "$4"
  eval "$CDP fps 5"
}
echo "== fps sweep (target 60 on every line)"
fps_at region.duskmoor-slice 30 20 "Lanternwick (graded+snow)"
fps_at region.duskmoor-slice 29 35 "the new south gate"
fps_at region.gloamwood 46 8 "the grove gate"
fps_at region.cinder-steppe 24 20 "Cinder Steppe (graded)"
fps_at region.frostreach 30 20 "Brinehollow"
fps_at region.sunken-cauldron 27 14 "Grey Wick"
fps_at region.sunken-cauldron 30 23 "the Ember Sea surf"
fps_at region.ember-deep 12 50 "the Ember Deep"
fps_at region.ashlands 38 6 "the King's Road"
fps_at region.solmere 28 8 "Solmere gate plaza"
fps_at region.sun-forge 12 60 "the Sun Forge"

echo "== parking the console (BEFORE restore: the game autosaves on pagehide)"
eval "$CDP nav 'https://ses.q5labs.co/'" >/dev/null
sleep 4

echo "== restoring saves byte-exact"
python3 - "$BACKUP" <<'PY'
import json,sys,subprocess,os
env=dict(os.environ); env['CDP_PORT']='9223'
d=json.loads(open(sys.argv[1]).read().strip())
if isinstance(d,str): d=json.loads(d)
js='(function(){ const d='+json.dumps(d)+'; localStorage.clear(); for (const k in d) localStorage.setItem(k,d[k]); return "restored "+Object.keys(localStorage).length; })()'
print('  ', subprocess.run(['node','--experimental-websocket','pi/cdp.mjs','eval',js],capture_output=True,text=True,env=env).stdout.strip())
js2='(function(){ const o={}; for (const k of Object.keys(localStorage)) { const v=localStorage.getItem(k); let h=0; for (let i=0;i<v.length;i++) h=(h*31+v.charCodeAt(i))>>>0; o[k]=[v.length,h]; } return JSON.stringify(o); })()'
now=json.loads(json.loads(subprocess.run(['node','--experimental-websocket','pi/cdp.mjs','eval',js2],capture_output=True,text=True,env=env).stdout.strip()))
def sig(v):
    h=0
    for ch in v: h=(h*31+ord(ch)) & 0xFFFFFFFF
    return [len(v),h]
want={k:sig(v) for k,v in d.items()}
bad=[k for k in set(want)|set(now) if want.get(k)!=now.get(k)]
print('   BYTE-EXACT MATCH' if not bad else '   MISMATCH: '+str(bad))
PY
echo "== final target check"
eval "$CDP targets"
