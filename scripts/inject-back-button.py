#!/usr/bin/env python3
"""Inject the back-to-arcade overlay into bundled game HTML files.

The original deployments on Render are untouched. Only the bundled copies
under /games/ get the overlay so users inside the home-screen PWA have a
way back to the launcher (iOS standalone mode has no browser chrome).

Idempotent: a marker (id="__arcade_back") prevents double-injection.
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
SNIPPET = (HERE / "back-button.html").read_text()
MARK = 'id="__arcade_back"'

for path in sys.argv[1:]:
    p = pathlib.Path(path)
    html = p.read_text()
    if MARK in html:
        print(f"  skipped (already injected): {path}")
        continue
    if "</body>" not in html:
        print(f"  warning: no </body> in {path}", file=sys.stderr)
        continue
    html = html.replace("</body>", SNIPPET + "\n</body>", 1)
    p.write_text(html)
    print(f"  injected: {path}")
