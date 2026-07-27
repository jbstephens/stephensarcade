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
