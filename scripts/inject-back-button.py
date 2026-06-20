#!/usr/bin/env python3
"""Inject arcade overlays into bundled game HTML files.

The original Render deployments are untouched. Only the bundled copies under
/games/ get these injections:

  - back-button.html → before </body>, so users inside the standalone PWA
    have a way back to the launcher (iOS standalone mode has no chrome).
  - ga.html → before </head>, so we can track which games people play
    under the launcher's GA property.

Each injection is keyed on a unique marker so re-running on already-injected
HTML is a no-op (idempotent).
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).parent

INJECTIONS = [
    {
        "snippet": (HERE / "back-button.html").read_text(),
        "marker":  'id="__arcade_back"',
        "anchor":  "</body>",
    },
    {
        "snippet": (HERE / "ga.html").read_text(),
        "marker":  'id="__arcade_ga"',
        "anchor":  "</head>",
    },
]

for path in sys.argv[1:]:
    p = pathlib.Path(path)
    html = p.read_text()
    changed = False
    for inj in INJECTIONS:
        if inj["marker"] in html:
            continue
        if inj["anchor"] not in html:
            print(f"  warning: no {inj['anchor']} in {path}", file=sys.stderr)
            continue
        html = html.replace(inj["anchor"], inj["snippet"] + "\n" + inj["anchor"], 1)
        changed = True
    if changed:
        p.write_text(html)
        print(f"  injected: {path}")
    else:
        print(f"  skipped (already injected): {path}")
