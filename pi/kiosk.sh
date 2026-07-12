#!/usr/bin/env bash
# Stephens Entertainment System — Chromium kiosk launcher.
# Installed to /usr/local/bin/ses-kiosk by pi/setup.sh and started by the
# desktop session's autostart. Runs Chromium full-screen on the arcade and
# restarts it if it ever crashes or gets closed.
set -u

CONF=/etc/ses-kiosk.conf
[ -f "$CONF" ] && . "$CONF"
URL="${SES_URL:-https://ses.q5labs.co}"
PROFILE="${SES_PROFILE:-$HOME/.config/ses-kiosk}"

BROWSER=$(command -v chromium-browser || command -v chromium)
if [ -z "$BROWSER" ]; then
  echo "ses-kiosk: chromium not found — run pi/setup.sh first" >&2
  exit 1
fi

# Give Wi-Fi a moment to come up so we don't boot into an error page.
# After ~60s we launch anyway; Chromium will show its retry page.
for _ in $(seq 1 30); do
  curl -fsI --max-time 2 "$URL" >/dev/null 2>&1 && break
  sleep 2
done

mkdir -p "$PROFILE"
while true; do
  # Chromium nags about restoring tabs after any unclean exit (power switch
  # off counts). Mark the profile clean so the arcade always boots straight in.
  PREFS="$PROFILE/Default/Preferences"
  if [ -f "$PREFS" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
  fi

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
    --ozone-platform-hint=auto

  sleep 2
done
