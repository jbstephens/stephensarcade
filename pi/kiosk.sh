#!/usr/bin/env bash
# Stephens Entertainment System — Chromium kiosk launcher.
# Installed to /usr/local/bin/ses-kiosk by pi/setup.sh and started by the
# desktop session's autostart. Runs Chromium full-screen on the arcade and
# restarts it if it ever crashes or gets closed.
#
# Tunables in /etc/ses-kiosk.conf:
#   SES_URL=https://ses.q5labs.co     which arcade to boot into
#   SES_MODE=1920x1080@60             force a display mode every launch (the
#                                     Pi 5 GPU drowns at 4K/ultrawide-100Hz;
#                                     the games are built for 1080p60)
#   SES_DEBUG_PORT=9222               Chromium remote debugging on localhost
#                                     (reach it from another machine via
#                                     `ssh -L 9222:localhost:9222 ...`)
#   SES_EXTRA_FLAGS="--foo --bar"     extra Chromium flags, space-separated
set -u

CONF=/etc/ses-kiosk.conf
[ -f "$CONF" ] && . "$CONF"
URL="${SES_URL:-https://ses.q5labs.co}"
PROFILE="${SES_PROFILE:-$HOME/.config/ses-kiosk}"
MODE="${SES_MODE:-}"
DEBUG_PORT="${SES_DEBUG_PORT:-}"
EXTRA_FLAGS="${SES_EXTRA_FLAGS:-}"

BROWSER=$(command -v chromium-browser || command -v chromium)
if [ -z "$BROWSER" ]; then
  echo "ses-kiosk: chromium not found — run pi/setup.sh first" >&2
  exit 1
fi

# Force the display mode BEFORE Chromium launches, every time — mode changes
# don't persist across reboots on their own. Compositor-level, so it applies
# whether Chromium runs on Wayland or Xwayland.
if [ -n "$MODE" ] && [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wlr-randr >/dev/null 2>&1; then
  OUTPUT=$(wlr-randr 2>/dev/null | awk 'NR==1 {print $1}')
  if [ -n "$OUTPUT" ]; then
    wlr-randr --output "$OUTPUT" --mode "$MODE" 2>/dev/null \
      || echo "ses-kiosk: could not set mode $MODE on $OUTPUT" >&2
  fi
fi

# The TV can renegotiate HDMI mid-session (TV power-cycle, input switch),
# silently resetting the mode to its 4K@30 preferred and leaving Chromium
# pacing on stale timings (tiny window + half frame rate). Watchdog: check
# every 10s; on drift, reassert the mode and bounce Chromium — the launch
# loop below brings it back with fresh timings in seconds.
if [ -n "$MODE" ] && [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wlr-randr >/dev/null 2>&1; then
  (
    while true; do
      sleep 10
      CUR=$(wlr-randr 2>/dev/null | awk '/\(current\)/ { split($3, hz, "."); print $1 "@" hz[1]; exit }')
      if [ -n "$CUR" ] && [ "$CUR" != "$MODE" ]; then
        echo "ses-kiosk: display drifted to $CUR — reasserting $MODE" >&2
        OUT=$(wlr-randr 2>/dev/null | awk 'NR==1 {print $1}')
        wlr-randr --output "$OUT" --mode "$MODE" 2>/dev/null
        sleep 2
        pkill -f "$BROWSER" 2>/dev/null || pkill chromium 2>/dev/null
      fi
    done
  ) &
fi

# Give Wi-Fi a moment to come up so we don't boot into an error page.
# After ~60s we launch anyway; Chromium will show its retry page.
for _ in $(seq 1 30); do
  curl -fsI --max-time 2 "$URL" >/dev/null 2>&1 && break
  sleep 2
done

# HDMI audio races the TV at boot: if PipeWire probes the port before the TV
# advertises audio, the only sink is the dummy one and games play into the
# void. Wait for a real sink, restarting wireplumber (which re-probes) if it
# doesn't appear — a slow TV needs a second look, not a reboot.
have_real_sink() {
  wpctl status 2>/dev/null | sed -n '/Sinks:/,/Sources:/p' | grep 'vol:' | grep -qv 'Dummy Output'
}
if command -v wpctl >/dev/null 2>&1; then
  for _attempt in 1 2 3; do
    FOUND=""
    for _ in $(seq 1 10); do
      have_real_sink && { FOUND=1; break; }
      sleep 1
    done
    [ -n "$FOUND" ] && break
    systemctl --user restart wireplumber 2>/dev/null || true
    sleep 3
  done
fi

mkdir -p "$PROFILE"
while true; do
  # Chromium nags about restoring tabs after any unclean exit (power switch
  # off counts). Mark the profile clean so the arcade always boots straight in.
  PREFS="$PROFILE/Default/Preferences"
  if [ -f "$PREFS" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
  fi

  # shellcheck disable=SC2086 — EXTRA_FLAGS is intentionally word-split
  "$BROWSER" \
    --kiosk "$URL" \
    --user-data-dir="$PROFILE" \
    --no-first-run \
    --noerrdialogs \
    --password-store=basic \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --disable-features=Translate \
    --disable-component-update \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    --overscroll-history-navigation=0 \
    --disable-pinch \
    --ozone-platform-hint=auto \
    ${DEBUG_PORT:+--remote-debugging-port=$DEBUG_PORT} \
    $EXTRA_FLAGS

  sleep 2
done
