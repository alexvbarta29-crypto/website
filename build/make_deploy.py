#!/usr/bin/env python3
"""Assemble the deployable site into _deploy/.

The Pages workflow used to upload the entire repo (`path: .`), which had two
real problems:

1. Weight. ~145 MB per deploy, most of it full-size original photos that no
   page references (the pages use the -640w/-1200w/-1920w derivatives), which
   made the artifact upload/publish slow and timeout-prone.
2. Exposure. Everything in the repo was publicly served — including
   docs/OWNER-VERIFICATION.md (internal notes on unverified business claims),
   build/sitedata.py (which will eventually carry the lead-form access key),
   README/DEPLOY docs, and config/. None of that belongs on the live site.

This script builds _deploy/ from a whitelist of site files plus exactly the
assets those files reference, found by scanning the built output itself —
not by guessing. Anything unreferenced stays out.

Run after build.py. The workflow uploads _deploy/ instead of the repo root.
"""
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "_deploy")

# Directories that are never part of the served site.
SKIP_DIRS = {".git", ".github", ".claude", "build", "docs", "config",
             "node_modules", "_deploy", "__pycache__"}

# Root-level non-HTML files the site genuinely serves.
ROOT_FILES = ["robots.txt", "sitemap.xml", "site.webmanifest", "CNAME"]

# Any local asset path appearing anywhere in a shipped text file. Scanning the
# raw text (not just src/href) also catches srcset entries, poster attrs,
# inline style url(...) backgrounds, JSON-LD image fields, og:image absolute
# URLs (the assets/... substring still matches), and data-* attributes used by
# the Instagram lightbox.
ASSET_RE = re.compile(
    r"assets/[A-Za-z0-9_\-./]+?\.(?:jpe?g|png|webp|svg|gif|ico|mp4|css|js|json|webmanifest)",
    re.I)


def site_html_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and not d.startswith(".")]
        for f in filenames:
            if f.endswith(".html"):
                out.append(os.path.relpath(os.path.join(dirpath, f), ROOT))
    return sorted(out)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)

    ship = [p for p in site_html_files()]
    ship += [f for f in ROOT_FILES if os.path.exists(os.path.join(ROOT, f))]

    # Fixpoint scan: shipped text files reference assets; referenced .css/.js
    # may reference further assets of their own.
    referenced, queue, scanned = set(), list(ship), set()
    while queue:
        rel = queue.pop()
        if rel in scanned:
            continue
        scanned.add(rel)
        full = os.path.join(ROOT, rel)
        if not os.path.exists(full):
            continue
        if not rel.endswith((".html", ".css", ".js", ".webmanifest", ".xml", ".txt", ".json")):
            continue
        try:
            text = open(full, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        for m in ASSET_RE.findall(text):
            m = m.replace("\\/", "/")
            if m not in referenced:
                referenced.add(m)
                queue.append(m)

    missing = sorted(r for r in referenced
                     if not os.path.exists(os.path.join(ROOT, r)))
    to_copy = sorted(set(ship) | (referenced - set(missing)))

    total = 0
    for rel in to_copy:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        total += os.path.getsize(src)

    print(f"_deploy: {len(to_copy)} files, {total/1e6:.1f} MB "
          f"({len(referenced)} referenced assets)")
    if missing:
        # Referenced-but-absent files 404 on the live site exactly as they
        # would from a full-repo upload, so warn loudly rather than fail —
        # but list every one so it can't hide.
        print(f"WARNING: {len(missing)} referenced files missing on disk:")
        for r in missing:
            print("   ", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
