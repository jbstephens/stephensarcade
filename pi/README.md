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

## What's inside

| File | Lives at (on the Pi) | Does |
| --- | --- | --- |
| `pi/setup.sh` | — (run once) | Installs and wires up everything below. |
| `pi/kiosk.sh` | `/usr/local/bin/ses-kiosk` | Waits for network, launches Chromium in kiosk mode, restarts it if it dies. |
| `pi/pair-controller.sh` | `/usr/local/bin/ses-pair-controller` | Scans, pairs, and trusts Bluetooth gamepads. |
| — | `/etc/ses-kiosk.conf` | `SES_URL` — which arcade the console boots into. |

## Later (out of scope for v1)

- Offline play: serve the bundled `games/` straight off the Pi so it works
  with no internet, syncing updates from the live site in the background.
- Per-game saves, leaderboards, accounts (needs a real database).
- NVMe SSD if the data ever gets heavy.
