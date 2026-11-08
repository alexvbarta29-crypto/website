#!/usr/bin/env python3
"""Draw the Barta Office home-screen app icons into assets/img/app/.

The icon is the BWW logo mark (the //BWW part of assets/img/logo-bww.png,
without the BARTA WINDOW WASHING line, which is unreadable at icon size) on
white, like the van. Full bleed: iPhone and Android round the corners
themselves. The maskable icon keeps the logo inside the middle 80% so any
Android mask shape fits it.

Run by hand when the icon changes, then bump the .vN in the file names (and in
office.webmanifest, office-sw.js and APP_ICON in netlify/lib/office-page.mjs):
/assets/ is cached for a year, so a changed icon must get a new URL.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "img", "app")
VERSION = "v2"
BG = (255, 255, 255)


def logo_mark():
    lg = Image.open(os.path.join(ROOT, "assets", "img", "logo-bww.png")).convert("RGBA")
    alpha = lg.split()[3]
    # The first empty row below the letters separates BWW from the tagline.
    cut = next(y for y in range(100, lg.height) if not any(alpha.getpixel((x, y)) > 40 for x in range(lg.width)))
    top = lg.crop((0, 0, lg.width, cut))
    return top.crop(top.getbbox())


def icon(size, width_share):
    big = 1024
    mark = logo_mark()
    canvas = Image.new("RGB", (big, big), BG)
    w = int(big * width_share)
    h = int(mark.height * w / mark.width)
    m = mark.resize((w, h), Image.LANCZOS)
    canvas.paste(m, ((big - w) // 2, (big - h) // 2), m)
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, share in [
        (f"office-icon-180.{VERSION}.png", 180, 0.78),  # iPhone home screen
        (f"office-icon-192.{VERSION}.png", 192, 0.78),
        (f"office-icon-512.{VERSION}.png", 512, 0.78),
        (f"office-icon-maskable-512.{VERSION}.png", 512, 0.66),
    ]:
        icon(size, share).save(os.path.join(OUT, name), optimize=True)
        print("wrote", name)


if __name__ == "__main__":
    main()
