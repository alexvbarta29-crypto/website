#!/usr/bin/env python3
"""Draw the Barta Office home-screen app icons into assets/img/app/.

The icon is the favicon's mark (two coral slashes) on the ink background,
full bleed: iPhone and Android round the corners themselves. The maskable
icon keeps the mark inside the middle 80% so any Android mask shape fits it.

Run by hand when the icon changes, then bump the .vN in the file names (and in
office.webmanifest and netlify/lib/office-page.mjs): /assets/ is cached for a
year, so a changed icon must get a new URL.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "img", "app")
INK, CORAL = (22, 22, 27), (251, 77, 61)
# The favicon's two slashes, in its 64x64 viewBox, centered on (36.5, 32).
SLASHES = [[(27, 14), (38, 14), (27, 50), (16, 50)], [(46, 14), (57, 14), (46, 50), (35, 50)]]
SS = 4  # supersample for smooth edges


def icon(size, scale):
    big = size * SS
    img = Image.new("RGB", (big, big), INK)
    d = ImageDraw.Draw(img)
    unit = big / 64
    for poly in SLASHES:
        d.polygon([((32 + scale * (x - 36.5)) * unit, (32 + scale * (y - 32)) * unit) for x, y in poly], fill=CORAL)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, scale in [
        ("office-icon-180.v1.png", 180, 0.95),  # iPhone home screen
        ("office-icon-192.v1.png", 192, 0.95),
        ("office-icon-512.v1.png", 512, 0.95),
        ("office-icon-maskable-512.v1.png", 512, 0.72),
    ]:
        icon(size, scale).save(os.path.join(OUT, name), optimize=True)
        print("wrote", name)


if __name__ == "__main__":
    main()
