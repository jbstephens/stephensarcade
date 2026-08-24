# Stephens Entertainment System — Console Build Guide

Turn a Raspberry Pi 5 into the family console: flip it on, and Stephens Arcade
(ses.q5labs.co) is just *there* on the TV, full screen, controller in hand.
No desktop, no mouse, no keyboard.

## What you need

- Raspberry Pi 5 (4GB)
- Official Raspberry Pi 27W USB-C power supply
- Micro-HDMI → HDMI cable (the Pi 5's video ports are **micro**-HDMI)
- microSD card, 32GB+ (A2-rated is snappier)
- A way to plug the microSD into your Mac
- PS4 (DualShock 4) controllers, charged
- Wi-Fi network name + password

No keyboard or mouse needed — setup happens over SSH from the Mac.

## Step 1 — Flash the SD card (on the Mac, ~10 min)

1. Install **Raspberry Pi Imager** from <https://www.raspberrypi.com/software/>.
2. Choose Device: **Raspberry Pi 5**.
3. Choose OS: **Raspberry Pi OS (64-bit)** (the regular one, *with* desktop).
4. Choose Storage: the microSD card.
5. Click **Next**, then **Edit Settings** when it offers OS customisation:
   - **Hostname:** `ses`
   - **Username / password:** `arcade` / (pick a family password)
   - **Wi-Fi:** your network name and password
   - **Locale:** your time zone and keyboard
   - Services tab → **Enable SSH** (password authentication)
6. Write it. Grab a snack — this takes a few minutes.

## Step 2 — First boot

1. Put the microSD in the Pi, connect it to the TV (micro-HDMI port closest to
   the USB-C power jack = HDMI0), and plug in power.
2. Wait for the desktop to appear on the TV (first boot takes a minute or two
   and may reboot itself once).

## Step 3 — Install the arcade (one command)

From the Mac's Terminal:

```sh
ssh arcade@ses.local
```

(say `yes` to the fingerprint prompt, enter the family password), then on the Pi:

```sh
curl -fsSL https://ses.q5labs.co/pi/setup.sh | bash
```

That installs Chromium kiosk mode, autologin, screen-blanking off, and the
controller pairing helper. Safe to re-run any time.

## Step 4 — Pair the controllers

Still in the SSH session:

```sh
ses-pair-controller
```

Then hold **SHARE + PS** on the DualShock 4 until its light bar
**double-flashes white**, and wait for the ✓. Run it again for the second
controller. Paired controllers are *trusted* — from then on, tapping the PS
button reconnects them automatically.

## Step 5 — Reboot into the arcade

```sh
sudo reboot
```

The Pi now boots straight into Stephens Arcade, every time.

## Daily use

- **Turn it on:** power the Pi (and the TV). The arcade appears by itself.
- **Wake a controller:** tap the PS button.
- **Pick a game:** D-pad to move, ✕ (or START) to launch.
- **Quit a game:** hold the **PS button** (or **SELECT + START**) for one
  second — the yellow ◄ ARCADE badge swells, then you're back at the menu.
- **Turn it off:** just cut the power. Nothing on the box minds.

High scores live on the console itself and survive reboots.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Controller won't connect | Tap PS once. Still nothing? Charge it, then re-run `ses-pair-controller`. |
| No sound | SSH in and run `wpctl status` — if HDMI isn't the default sink, `wpctl set-default <HDMI sink id>`. |
| "Site can't be reached" | Wi-Fi hiccup. It retries at boot for ~60s; check the network, then power-cycle. |
| Need to escape the kiosk | SSH in: `pkill -f ses-kiosk; pkill -f chromium` gives you the desktop until next reboot. |
| Point it at a different URL | Edit `/etc/ses-kiosk.conf` on the Pi, reboot. |

## Offline mode

The console serves the whole arcade from a **local web server on the Pi**, so it
plays with **no internet** — faster boot, and it works anywhere (car, cabin, a
dead Wi-Fi day). `pi/setup.sh` sets this up automatically; there's nothing extra
to do.

### How it works

- A checkout of this repo lives on the Pi (default `~/stephensarcade`).
- `scripts/build-local.sh` copies the web root into `local-arcade/` and rewrites
  each game's `https://ses.q5labs.co/lib/controller.js` reference to the
  repo-relative `/lib/controller.js`, so controllers work with no network. Every
  game is otherwise a single self-contained HTML file, so that's the only fixup
  needed.
- **`ses-webserver.service`** runs `lighttpd` serving `local-arcade/` on
  **`127.0.0.1:8080`** (localhost only — never exposed to the network).
- **`ses-arcade-sync.timer`** runs every 30 min: when online it `git pull`s and
  re-runs `build-local.sh` so the offline copy stays current; when offline it
  does nothing and keeps serving the last good build.

### The fallback guarantee (why this can't brick the boot)

Before every launch, `ses-kiosk` health-checks the local server
(`curl http://localhost:8080/` and confirms it's really the arcade). If it
answers, Chromium opens `http://localhost:8080/?fx=low` (offline). If it does
**not** answer — server down, mid-rebuild, not installed, anything — the kiosk
falls back to the online `https://ses.q5labs.co/?fx=low`, **exactly as before
offline mode existed**. The check re-runs on every Chromium relaunch, so a local
server that dies mid-session is caught and the next launch goes online. Worst
case, the console behaves like the old online-only build — never a black screen.

### Common tasks

- **Force online (ignore the local server):** set `SES_DISABLE_LOCAL=1` in
  `/etc/ses-kiosk.conf` and reboot (or `pkill -f ses-kiosk`). To go back, remove
  that line.
- **Rebuild the offline copy now:** `cd ~/stephensarcade && bash scripts/build-local.sh`
  (safe to re-run; it swaps the new tree in atomically).
- **Force a sync now:** `sudo systemctl start ses-arcade-sync.service`, then
  `journalctl -u ses-arcade-sync -n 20` to see what it did.
- **Change the port:** edit `SES_LOCAL_PORT` in `/etc/ses-kiosk.conf`,
  `server.port` in `/etc/lighttpd/ses-arcade.conf`, and restart both
  `ses-webserver` and the kiosk.

### Troubleshooting offline mode

| Problem | Fix |
| --- | --- |
| Boots online when I expected offline | `curl -I http://localhost:8080/` — if it fails, `systemctl status ses-webserver` and `journalctl -u ses-webserver`. The kiosk is *correctly* falling back until the server is healthy. |
| Games load but controllers are dead offline | The `controller.js` rewrite didn't run — re-run `bash scripts/build-local.sh` and check `local-arcade/lib/controller.js` exists. |
| Offline copy is stale | `journalctl -u ses-arcade-sync` — it only updates when online and fast-forwardable. Run `git -C ~/stephensarcade pull` by hand if history diverged. |

## What's inside

| File | Lives at (on the Pi) | Does |
| --- | --- | --- |
| `pi/setup.sh` | — (run once) | Installs and wires up everything below. |
| `pi/kiosk.sh` | `/usr/local/bin/ses-kiosk` | Waits for network, health-checks the local server, launches Chromium (local if up, else online), restarts it if it dies. |
| `pi/pair-controller.sh` | `/usr/local/bin/ses-pair-controller` | Scans, pairs, and trusts Bluetooth gamepads. |
| `scripts/build-local.sh` | (in the checkout) | Builds `local-arcade/` — the offline copy of the web root. |
| `pi/lighttpd-arcade.conf` | `/etc/lighttpd/ses-arcade.conf` | lighttpd config: serve `local-arcade/` on `127.0.0.1:8080`. |
| `pi/ses-webserver.service` | `/etc/systemd/system/` | Runs the local offline web server; auto-restarts. |
| `pi/ses-arcade-sync.sh` | `/usr/local/bin/ses-arcade-sync` | When online: `git pull` + rebuild `local-arcade/`. When offline: no-op. |
| `pi/ses-arcade-sync.{service,timer}` | `/etc/systemd/system/` | Runs the sync every 30 min. |
| — | `/etc/ses-kiosk.conf` | `SES_URL` (online fallback), `SES_LOCAL_PORT`, `SES_DISABLE_LOCAL`. |

## Later (out of scope for v1)

- Per-game saves, leaderboards, accounts (needs a real database).
- NVMe SSD if the data ever gets heavy.
