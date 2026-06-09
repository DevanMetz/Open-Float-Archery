#!/usr/bin/env python3
"""Generate docs/index.json: a tree of every Markdown file under docs/.

The in-app Guide tab renders this tree as its sidebar. Static hosts such as
Cloudflare Pages do not expose directory listings, so the browser cannot
discover files at runtime; this script produces a portable index instead.

Run it whenever you add, rename, or remove a guide page:

    python tools/build_docs_index.py

Conventions:
- Folder and file display names come from the first Markdown `# H1` heading
  (for files) or a prettified folder name; a leading numeric prefix like
  `01-` is used only for ordering and stripped from the displayed title.
- Each file gets a stable `id` (its path under docs/ without the .md suffix),
  used by the Guide for deep links (`#/guide/<id>`).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = REPO_ROOT / "docs"
OUTPUT = DOCS_DIR / "index.json"

ORDER_PREFIX = re.compile(r"^\d+[-_.]\s*")
H1 = re.compile(r"^#\s+(.+?)\s*$")


def prettify(name: str) -> str:
    """Turn a slug-ish folder/file stem into a readable title."""
    name = ORDER_PREFIX.sub("", name)
    name = name.replace("-", " ").replace("_", " ").strip()
    return name.title() if name else name


def first_heading(md_path: Path) -> str | None:
    try:
        with md_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                match = H1.match(line)
                if match:
                    return match.group(1)
                # Stop scanning once real content starts without a heading.
                if line.strip() and not line.startswith("#"):
                    break
    except OSError:
        pass
    return None


def sort_key(path: Path):
    """Folders before files, then by name (numeric prefix respected)."""
    return (path.is_file(), path.name.lower())


def build_node(path: Path) -> dict | None:
    rel = path.relative_to(DOCS_DIR).as_posix()

    if path.is_dir():
        children = []
        for child in sorted(path.iterdir(), key=sort_key):
            node = build_node(child)
            if node:
                children.append(node)
        if not children:
            return None
        return {
            "type": "folder",
            "name": prettify(path.name),
            "path": rel,
            "children": children,
        }

    if path.suffix.lower() != ".md":
        return None

    stem_id = rel[: -len(path.suffix)]  # e.g. "build/assembly"
    title = first_heading(path) or prettify(path.stem)
    return {
        "type": "file",
        "name": title,
        "id": stem_id,
        "path": f"docs/{rel}",
    }


def main() -> None:
    if not DOCS_DIR.is_dir():
        raise SystemExit(f"docs directory not found: {DOCS_DIR}")

    tree = []
    for child in sorted(DOCS_DIR.iterdir(), key=sort_key):
        if child.name == "index.json":
            continue
        node = build_node(child)
        if node:
            tree.append(node)

    index = {"tree": tree}
    OUTPUT.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    file_count = json.dumps(tree).count('"type": "file"')
    print(f"Wrote {OUTPUT.relative_to(REPO_ROOT)} ({file_count} pages).")


if __name__ == "__main__":
    main()
