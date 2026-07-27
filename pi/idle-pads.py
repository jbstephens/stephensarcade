#!/usr/bin/env python3
"""Power off idle DualShock pads by dropping their Bluetooth link.

A DS4 shuts itself down when its BT connection closes; pressing PS wakes
it back up (pads are bonded by pair-controller.sh). We watch ONLY the
gamepad event node of each pad — the DS4 also exposes Motion Sensors and
a Touchpad as separate input devices, and the motion node streams
constantly, which would defeat any idle detection.

Runs as a systemd service (see setup.sh). Logs to journald via stdout.
"""
import os
import re
import select
import subprocess
import time

IDLE_SECS = 15 * 60
SCAN_SECS = 30          # how often to re-enumerate devices


def gamepad_nodes():
    """Yield (event_path, bt_mac, name) for real pad nodes only."""
    try:
        blocks = open("/proc/bus/input/devices").read().split("\n\n")
    except OSError:
        return
    for blk in blocks:
        name_m = re.search(r'N: Name="([^"]*)"', blk)
        ev_m = re.search(r"H: Handlers=.*?(event\d+)", blk)
        mac_m = re.search(r"U: Uniq=([0-9a-f:]{17})", blk, re.I)
        if not (name_m and ev_m and mac_m):
            continue
        name = name_m.group(1)
        # gamepad node: "Wireless Controller" / "DualSense" etc., but never
        # the Motion Sensors or Touchpad sub-devices.
        if re.search(r"motion sensors|touchpad", name, re.I):
            continue
        if not re.search(r"controller|dualshock|dualsense|8bitdo|8bit|sn30|x-box|xbox", name, re.I):
            continue
        yield f"/dev/input/{ev_m.group(1)}", mac_m.group(1), name


def disconnect(mac, name):
    print(f"idle-pads: {name} ({mac}) idle {IDLE_SECS}s — disconnecting", flush=True)
    subprocess.run(["bluetoothctl", "disconnect", mac],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    fds = {}        # path -> (fd, mac, name)
    last_seen = {}  # path -> last event time
    last_scan = 0.0
    poller = select.poll()

    while True:
        now = time.monotonic()

        if now - last_scan > SCAN_SECS:
            last_scan = now
            current = {p: (m, n) for p, m, n in gamepad_nodes()}
            for path in list(fds):
                if path not in current:
                    fd, _, name = fds.pop(path)
                    poller.unregister(fd)
                    os.close(fd)
                    last_seen.pop(path, None)
                    print(f"idle-pads: {name} gone ({path})", flush=True)
            for path, (mac, name) in current.items():
                if path in fds:
                    continue
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                except OSError:
                    continue
                fds[path] = (fd, mac, name)
                last_seen[path] = now
                poller.register(fd, select.POLLIN)
                print(f"idle-pads: watching {name} on {path}", flush=True)

        for fd, _ in poller.poll(5000):
            for path, (f, mac, name) in fds.items():
                if f == fd:
                    try:
                        while os.read(f, 4096):
                            pass
                    except BlockingIOError:
                        pass
                    except OSError:
                        break
                    last_seen[path] = time.monotonic()
                    break

        now = time.monotonic()
        for path in list(fds):
            if now - last_seen.get(path, now) >= IDLE_SECS:
                _, mac, name = fds[path]
                disconnect(mac, name)
                last_seen[path] = now   # device node will vanish on next scan


if __name__ == "__main__":
    main()
