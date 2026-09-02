#!/usr/bin/env python3
"""Referral app static-site generator. Run from referral-app/:

    python3 build.py

Writes public/index.html (the program page), public/friend.html (what a
referred friend lands on via /r/CODE), public/admin/index.html (the office
dashboard), plus public/_redirects and public/robots.txt. Netlify runs this
as the build command and publishes public/; the functions in
netlify/functions are bundled separately. See README.md.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")
sys.path.insert(0, os.path.join(HERE, "build"))

import chrome as C          # noqa: E402
import pages                # noqa: E402
import admin_page           # noqa: E402

ASSETS = ["assets/css/site.css", "assets/css/app.css", "assets/css/admin.css",
          "assets/js/app.js", "assets/js/admin.js"]


def asset_version():
    """Short hash of the CSS/JS so their URLs change whenever they do."""
    h = hashlib.md5()
    for rel in ASSETS:
        with open(os.path.join(PUBLIC, rel), "rb") as f:
            h.update(f.read())
    return h.hexdigest()[:8]


def write(rel, content):
    path = os.path.join(PUBLIC, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("  wrote", rel)


def main():
    C.ASSET_VER = asset_version()
    write("index.html", pages.referral_page())
    write("friend.html", pages.friend_page())
    write("admin/index.html", admin_page.referral_admin_page())
    # Short links texted to friends: /r/BARTA-7K3XQ is served by friend.html
    # (a 200 rewrite keeps the short URL in the address bar; the page reads
    # the code from the path). The API paths are the functions' own.
    write("_redirects", "\n".join([
        "# Referral short links: the code the office texts to a referred friend.",
        "/r/:code   /friend.html?code=:code   200",
        "",
    ]))
    write("robots.txt", "User-agent: *\nAllow: /\nDisallow: /admin/\n")
    print(f"✓ referral app built (assets v={C.ASSET_VER})")


if __name__ == "__main__":
    main()
