#!/usr/bin/env bash
# Stephens Entertainment System — Bluetooth gamepad pairing helper.
# Installed to /usr/local/bin/ses-pair-controller by pi/setup.sh.
# Pairs and *trusts* controllers so they reconnect on their own from then on.
set -u

SCAN_SECONDS=${1:-30}

cat <<'EOT'

  ── PAIR A CONTROLLER ─────────────────────────────────────
  Put the controller in pairing mode NOW:

    PS4 (DualShock 4):  hold SHARE + PS together until the
                        light bar starts double-flashing white.

    Most other pads:    hold the pairing/sync button until
                        the lights flash rapidly.

  Scanning for 30 seconds...
  ──────────────────────────────────────────────────────────

EOT

bluetoothctl power on >/dev/null
bluetoothctl agent NoInputNoOutput >/dev/null 2>&1 || true
bluetoothctl default-agent >/dev/null 2>&1 || true
bluetoothctl pairable on >/dev/null

# Scan; discovered devices land in bluetoothctl's device list.
bluetoothctl --timeout "$SCAN_SECONDS" scan on >/dev/null

MACS=$(bluetoothctl devices | grep -iE 'controller|dualshock|dualsense|gamepad|joy-con' | awk '{print $2}')

if [ -z "$MACS" ]; then
  echo "No controllers found. Make sure the light bar is double-flashing, then run this again."
  exit 1
fi

FAILED=0
for MAC in $MACS; do
  NAME=$(bluetoothctl devices | grep "$MAC" | cut -d' ' -f3-)
  if bluetoothctl info "$MAC" | grep -q "Connected: yes"; then
    echo "✓ $NAME ($MAC) is already connected."
    continue
  fi
  echo "Pairing $NAME ($MAC)..."
  bluetoothctl pair "$MAC" >/dev/null 2>&1 || true   # harmless if already paired
  bluetoothctl trust "$MAC" >/dev/null                # auto-reconnect from now on
  bluetoothctl connect "$MAC" >/dev/null 2>&1 || true
  sleep 2
  if bluetoothctl info "$MAC" | grep -q "Connected: yes"; then
    echo "✓ $NAME connected! It will reconnect by itself from now on (just press PS)."
  else
    echo "✗ $NAME didn't connect. Put it back in pairing mode and run this again."
    FAILED=1
  fi
done

exit $FAILED
