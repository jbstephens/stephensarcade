#!/usr/bin/env bash
# Stephens Entertainment System — one-shot Raspberry Pi setup.
#
# Run this ON THE PI (Raspberry Pi OS with desktop, 64-bit) as the normal
# user, either from a terminal on the Pi or over SSH:
#
#   curl -fsSL https://ses.q5labs.co/pi/setup.sh | bash
#
# What it does:
#   1. Installs Chromium if it's missing.
#   2. Turns on desktop autologin and disables screen blanking.
#   3. Installs ses-kiosk (boot-to-arcade Chromium launcher) and
#      ses-pair-controller (Bluetooth gamepad pairing helper).
#   4. Hooks ses-kiosk into the desktop session autostart (labwc — the
#      Raspberry Pi OS default — plus wayfire/LXDE fallbacks if present).
#
# Safe to re-run; every step is idempotent.
set -euo pipefail

BASE_URL="${SES_BASE_URL:-https://ses.q5labs.co/pi}"
ARCADE_URL="${SES_URL:-https://ses.q5labs.co}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-/}")" 2>/dev/null && pwd || true)"

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user (it uses sudo where needed), not as root." >&2
  exit 1
fi

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }

# Grab a sibling script: from the repo checkout if we're running from one,
# otherwise from the live site.
fetch() { # fetch <name> <dest>
  if [ -n "$HERE" ] && [ -f "$HERE/$1" ]; then
    sudo install -m 755 "$HERE/$1" "$2"
  else
    curl -fsSL "$BASE_URL/$1" | sudo tee "$2" >/dev/null
    sudo chmod 755 "$2"
  fi
}

# Like fetch, but with an explicit mode (units/configs want 0644, not 0755).
getfile() { # getfile <name> <dest> <mode>
  if [ -n "$HERE" ] && [ -f "$HERE/$1" ]; then
    sudo install -m "$3" "$HERE/$1" "$2"
  else
    curl -fsSL "$BASE_URL/$1" | sudo tee "$2" >/dev/null
    sudo chmod "$3" "$2"
  fi
}

say "Checking for Chromium"
if ! command -v chromium-browser >/dev/null && ! command -v chromium >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
fi

say "Enabling desktop autologin and disabling screen blanking"
sudo raspi-config nonint do_boot_behaviour B4   # boot to desktop, logged in
sudo raspi-config nonint do_blanking 1          # never blank the screen

say "Installing ses-kiosk and ses-pair-controller"
fetch kiosk.sh /usr/local/bin/ses-kiosk
fetch pair-controller.sh /usr/local/bin/ses-pair-controller

if [ ! -f /etc/ses-kiosk.conf ]; then
  sudo tee /etc/ses-kiosk.conf >/dev/null <<EOF
# Stephens Entertainment System kiosk settings.
SES_URL=$ARCADE_URL
EOF
fi
# Local offline server port the kiosk health-checks (see "offline mode" below).
# Idempotent: only appended if not already present.
grep -q '^SES_LOCAL_PORT=' /etc/ses-kiosk.conf \
  || echo 'SES_LOCAL_PORT=8080' | sudo tee -a /etc/ses-kiosk.conf >/dev/null

say "Hooking the kiosk into session autostart"
KIOSK_LINE="/usr/local/bin/ses-kiosk &"

# labwc — the default Wayland compositor on current Raspberry Pi OS.
LABWC_AUTOSTART="$HOME/.config/labwc/autostart"
mkdir -p "$(dirname "$LABWC_AUTOSTART")"
if [ ! -f "$LABWC_AUTOSTART" ]; then
  cat > "$LABWC_AUTOSTART" <<'EOF'
# Created by Stephens Arcade pi/setup.sh.
# labwc runs the system autostart (/etc/xdg/labwc/autostart) as well as this
# file, so do NOT source it here — that would start the panel twice.
EOF
fi
grep -qF "$KIOSK_LINE" "$LABWC_AUTOSTART" || echo "$KIOSK_LINE" >> "$LABWC_AUTOSTART"

# wayfire — default on some older Bookworm images.
WAYFIRE_INI="$HOME/.config/wayfire.ini"
if [ -f "$WAYFIRE_INI" ] && ! grep -q "ses-kiosk" "$WAYFIRE_INI"; then
  if grep -q '^\[autostart\]' "$WAYFIRE_INI"; then
    sed -i '/^\[autostart\]/a ses_kiosk = /usr/local/bin/ses-kiosk' "$WAYFIRE_INI"
  else
    printf '\n[autostart]\nses_kiosk = /usr/local/bin/ses-kiosk\n' >> "$WAYFIRE_INI"
  fi
fi

# Current-mode helper for the kiosk drift watchdog (JSON-based; the
# human-readable wlr-randr output is unreliable to parse).
sudo install -m 0755 "$(dirname "$0")/ses-curmode" /usr/local/bin/ses-curmode

# Idle-pad watchdog — powers off DualShocks idle for 15 min by dropping
# their Bluetooth link (press PS to wake). Watches only the gamepad event
# node, never the motion-sensor/touchpad sub-devices.
sudo install -m 0755 "$(dirname "$0")/idle-pads.py" /usr/local/bin/ses-idle-pads
sudo tee /etc/systemd/system/ses-idle-pads.service >/dev/null <<'UNIT'
[Unit]
Description=Stephens Arcade — power off idle controllers
After=bluetooth.target

[Service]
ExecStart=/usr/local/bin/ses-idle-pads
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now ses-idle-pads.service

# Silence the panel's Bluetooth widget. Its plugin pops a modal "Connection
# successful" dialog on every connect — and since our pads are *trusted* and
# auto-reconnect on wake, that dialog would grab input focus off the kiosk
# every time a kid taps a button to wake a pad. We manage Bluetooth entirely
# over SSH (ses-pair-controller), so the tray widget earns its keep nowhere.
# Drop it from the panel's widget list AND move its .so out of the load path
# (the panel dlopens every plugin to enumerate them, so config alone isn't
# enough). Both steps are idempotent.
mkdir -p "$HOME/.config"
PANEL_INI="$HOME/.config/wf-panel-pi.ini"
if ! grep -q '^widgets_right=' "$PANEL_INI" 2>/dev/null; then
  printf '[panel]\nwidgets_right=volumepulse squeek\n' >> "$PANEL_INI"
fi
for BT_PLUGIN in /usr/lib/*/wf-panel-pi/libbluetooth.so; do
  [ -e "$BT_PLUGIN" ] && sudo mv "$BT_PLUGIN" "$BT_PLUGIN.disabled"
done
pkill -x wf-panel-pi 2>/dev/null || true   # lwrespawn brings it back sans BT

# ── Offline mode: local web server + background sync ────────────────────────
# Serve the arcade from a local static server so the cabinet plays with NO
# internet. This is layered UNDER the kiosk's fail-safe: if any of this is
# missing or broken, kiosk.sh health-checks the local server and falls back to
# the online URL, so the console can never end up worse than online-only.
say "Setting up offline mode (local web server + background sync)"

# 1. A repo checkout on the Pi to build the offline tree from and to sync.
#    Use the checkout we're running from if there is one; else clone it.
SES_REPO_DIR="${SES_REPO_DIR:-$HOME/stephensarcade}"
if [ -n "$HERE" ] && git -C "$HERE" rev-parse --show-toplevel >/dev/null 2>&1; then
  SES_REPO_DIR="$(git -C "$HERE" rev-parse --show-toplevel)"
elif [ ! -d "$SES_REPO_DIR/.git" ]; then
  git clone --depth 1 https://github.com/jbstephens/stephensarcade.git "$SES_REPO_DIR"
fi
DOCROOT="$SES_REPO_DIR/local-arcade"
ARCADE_USER="$(id -un)"

# 2. lighttpd — the tiny, rock-solid static server. We run our OWN instance
#    (localhost:8080) via ses-webserver.service, so disable the packaged one.
if ! command -v lighttpd >/dev/null; then
  sudo apt-get install -y lighttpd
fi
sudo systemctl disable --now lighttpd 2>/dev/null || true
sudo mkdir -p /etc/lighttpd
getfile lighttpd-arcade.conf /etc/lighttpd/ses-arcade.conf 0644

# 3. The offline web-server unit (docroot patched to this Pi's checkout).
getfile ses-webserver.service /etc/systemd/system/ses-webserver.service 0644
sudo sed -i "s#^Environment=SES_ARCADE_DOCROOT=.*#Environment=SES_ARCADE_DOCROOT=$DOCROOT#" \
  /etc/systemd/system/ses-webserver.service

# 4. The sync script + oneshot service + timer (user/path patched to this Pi).
getfile ses-arcade-sync.sh /usr/local/bin/ses-arcade-sync 0755
getfile ses-arcade-sync.service /etc/systemd/system/ses-arcade-sync.service 0644
sudo sed -i "s#^User=.*#User=$ARCADE_USER#; s#^Environment=SES_REPO_DIR=.*#Environment=SES_REPO_DIR=$SES_REPO_DIR#" \
  /etc/systemd/system/ses-arcade-sync.service
getfile ses-arcade-sync.timer /etc/systemd/system/ses-arcade-sync.timer 0644

# 5. Build the offline tree once, then enable the server + sync timer.
#    A failed build is non-fatal: the kiosk just serves online until the next
#    successful sync.
bash "$SES_REPO_DIR/scripts/build-local.sh" \
  || echo "  (build-local failed — kiosk will use the online fallback for now)"
sudo systemctl daemon-reload
sudo systemctl enable --now ses-webserver.service
sudo systemctl enable --now ses-arcade-sync.timer

# LXDE/X11 — fallback if Wayland is ever switched off.
if [ -d /etc/xdg/lxsession/LXDE-pi ]; then
  LXDE_AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"
  mkdir -p "$(dirname "$LXDE_AUTOSTART")"
  [ -f "$LXDE_AUTOSTART" ] || cp /etc/xdg/lxsession/LXDE-pi/autostart "$LXDE_AUTOSTART"
  grep -qF "@/usr/local/bin/ses-kiosk" "$LXDE_AUTOSTART" || echo "@/usr/local/bin/ses-kiosk" >> "$LXDE_AUTOSTART"
fi

cat <<'EOT'

  ══════════════════════════════════════════════════════════
   SETUP COMPLETE
  ══════════════════════════════════════════════════════════

   Next steps:

     1. Pair your controllers:   ses-pair-controller
     2. Reboot into the arcade:  sudo reboot

   The Pi now boots straight into Stephens Arcade.
   In a game, hold the PS button (or SELECT+START) for one
   second to get back to the menu.

EOT
