#!/usr/bin/env python3
"""Inject the console overlays into the Game Factory mirror (factory/*.html).

    python3 scripts/inject-factory.py <dir>            # every *.html in <dir> (non-recursive)
    python3 scripts/inject-factory.py <file.html> ...  # explicit files (dirs and files may mix)

Ben's repo (jbstephens/bensarcade) is READ-ONLY; this only ever runs on the
copies under factory/ (or a temp dir that becomes factory/). Design:
docs/game-factory.md, "Agent B — console overlays".

Each overlay is keyed on its marker id: marker present -> skip, so re-running
is a no-op, and output is byte-for-byte deterministic (no timestamps, no
randomness). Ben's pages are minimal HTML (many have no <head>/<body>), so:

  HEAD-position (must run before touchpad.js): immediately before the first
    <script src="touchpad.js ; else before the first <script ; else after the
    first <meta charset...> ; else after <!doctype html> ; else file start.
  END-position: before </body> if present, else appended at end of file.

Per-file classification (from the file as found):
  is_book  = filename is index.html or arcade.html  -> __gf_book overlay +
             IS_BOOK flag in pad-exit / cursor / idle
  has_dpad = file matches /dpad:\\s*true/           -> no left-stick cursor
  The cursor's left stick is on only when not is_book and not has_dpad.

Exit 1 on any exception.
"""
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
OVERLAYS = HERE / "factory-overlays"

BOOK_FLAG_OFF = "var IS_BOOK = false; /*@gf:is_book*/"
BOOK_FLAG_ON = "var IS_BOOK = true; /*@gf:is_book*/"
LEFT_FLAG_OFF = "window.__GF_CURSOR_LEFT = false; /*@gf:cursor_left*/"
LEFT_FLAG_ON = "window.__GF_CURSOR_LEFT = true; /*@gf:cursor_left*/"

# (marker id, snippet file, position, book-only). Order = order in the page.
OVERLAY_SPECS = [
    ("__gf_padfilter", "padfilter.html", "head", False),
    ("__gf_pad_exit", "pad-exit.html", "end", False),
    ("__gf_lowfx", "low-fx.html", "end", False),
    ("__gf_print", "print.html", "end", False),
    ("__gf_cursor", "cursor.html", "end", False),
    ("__gf_idle", "idle.html", "end", False),
    ("__gf_book", "book.html", "end", True),
]

DPAD_RE = re.compile(r"dpad:\s*true")
META_CHARSET_RE = re.compile(r"<meta\s[^>]*charset[^>]*>", re.I)
DOCTYPE_RE = re.compile(r"<!doctype\s+html\s*>", re.I)


def load_snippets():
    out = []
    for marker, name, pos, book_only in OVERLAY_SPECS:
        text = (OVERLAYS / name).read_bytes().decode("utf-8").rstrip("\n")
        tag = f'id="{marker}"'
        if text.count(tag) != 1:
            raise RuntimeError(f"{name}: expected exactly one {tag}")
        if "</body>" in text.lower():
            raise RuntimeError(f"{name}: snippet must not contain </body>")
        out.append({"marker": tag, "name": name, "pos": pos, "book_only": book_only, "text": text})
    return out


def personalise(text, is_book, cursor_left):
    if BOOK_FLAG_OFF in text and is_book:
        text = text.replace(BOOK_FLAG_OFF, BOOK_FLAG_ON)
    if LEFT_FLAG_OFF in text and cursor_left:
        text = text.replace(LEFT_FLAG_OFF, LEFT_FLAG_ON)
    return text


def insert_head(html, snippet, path):
    i = html.find('<script src="touchpad.js')
    if i < 0:
        i = html.find("<script")
    if i >= 0:
        return html[:i] + snippet + "\n" + html[i:]
    m = META_CHARSET_RE.search(html) or DOCTYPE_RE.search(html)
    if m:
        return html[:m.end()] + "\n" + snippet + html[m.end():]
    print(f"  warning: no <script>/<meta charset>/<!doctype> in {path}; prepending", file=sys.stderr)
    return snippet + "\n" + html


def insert_end(html, snippet):
    i = html.find("</body>")
    if i >= 0:
        return html[:i] + snippet + "\n" + html[i:]
    sep = "" if (html == "" or html.endswith("\n")) else "\n"
    return html + sep + snippet + "\n"


def process(path, snippets):
    p = pathlib.Path(path)
    raw = p.read_bytes()
    html = raw.decode("utf-8")
    is_book = p.name in ("index.html", "arcade.html")
    has_dpad = bool(DPAD_RE.search(html))
    cursor_left = not is_book and not has_dpad
    added = []
    for s in snippets:
        if s["book_only"] and not is_book:
            continue
        if s["marker"] in html:
            continue
        text = personalise(s["text"], is_book, cursor_left)
        html = insert_head(html, text, path) if s["pos"] == "head" else insert_end(html, text)
        added.append(s["marker"][4:-1])
    if added:
        out = html.encode("utf-8")
        if out != raw:
            p.write_bytes(out)
        kind = "book" if is_book else ("dpad" if has_dpad else "pointer")
        print(f"  injected ({kind}, {len(added)}): {path}")
    else:
        print(f"  skipped (already injected): {path}")
    return len(added)


def main(argv):
    if not argv:
        print("usage: inject-factory.py <dir | file.html> ...", file=sys.stderr)
        return 2
    files = []
    for a in argv:
        p = pathlib.Path(a)
        if p.is_dir():
            files.extend(sorted(q for q in p.glob("*.html") if q.is_file()))
        elif p.is_file():
            files.append(p)
        else:
            raise FileNotFoundError(a)
    snippets = load_snippets()
    injected = 0
    for f in files:
        if process(f, snippets):
            injected += 1
    print(f"inject-factory: {len(files)} file(s), {injected} injected, {len(files) - injected} already done")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except BaseException as e:  # contract: any exception -> exit 1
        print(f"inject-factory: ERROR: {e}", file=sys.stderr)
        sys.exit(1)
