# Image guide & recommended photography

The site currently uses lightweight **SVG placeholders** so it looks complete and the before/after
sliders work out of the box. Replace them with real, high-resolution photography before launch —
nothing builds trust for a home-service brand faster than authentic, well-lit job photos.

## Files in this folder

| File | Used for | Replace with |
| --- | --- | --- |
| `favicon.svg` | Browser tab / PWA icon | On-brand: coral // mark on black. Swap for your exact icon if desired |
| `<img width="915" height="768" alt="Artboard 4" src="https://github.com/user-attachments/assets/9b1f0ba4-36f0-4dfc-ae3d-44b8f1ec981a" />
` | Standalone logo (email sigs, docs) | The // mark + BARTA wordmark. Drop in your original vector to be pixel-perfect |
| `og-cover.svg` | Social share preview | On-brand black + coral card. Optionally export a 1200×630 `og-cover.jpg` photo version |

> **Brand note:** the nav/footer logo is rendered as crisp inline SVG (the coral **//** mark +
> "BARTA" wordmark) so it scales perfectly and stays editable. If you want the wordmark to match your
> logo's exact typeface, drop your original logo file here and we can swap the nav to use it as an
> `<img>` instead.
| `ba1-before.svg` / `ba1-after.svg` | Window before/after slider | Real window job, same camera angle |
| `ba2-before.svg` / `ba2-after.svg` | House/siding before/after | Real soft-wash job, same angle |
| `ba3-before.svg` / `ba3-after.svg` | Roof before/after | Real roof job, same angle |

> **Before/after tip:** shoot from a tripod or fixed spot so the "before" and "after" line up
> perfectly when the slider moves. Same framing, same lighting, same crop.

## Wired content photos (drop these in to go live)

These exact filenames are already referenced on the site. Add the file and it appears
automatically — until then, a branded placeholder shows in its place (no broken images).

| File | Appears on | Suggested shot |
| --- | --- | --- |
| `hero-home.jpg` | Homepage hero | A bright, freshly cleaned home with spotless windows (landscape) |
| `team-barta.jpg` | About page | The team / owner, friendly and professional |
| `service-van.jpg` | About page ("Look for the Barta van") | Your branded BWW service van |
| `window-cleaning-main.jpg` | Window Cleaning page | A tech cleaning a window, sun-lit glass |
| `commercial-building-cleaning.jpg` | Commercial page | Crew cleaning a commercial storefront/building |

Recommended: export as JPG (or WebP) ~1600px wide, landscape, under ~250 KB.

## The `.imgph` placeholders

Throughout the HTML you'll see `<div class="imgph" …>` blocks with descriptive labels (e.g.
"Commercial storefront window cleaning"). Each marks a spot for a real photo. Swap them for:

```html
<img src="assets/img/your-photo.webp" alt="Descriptive alt text" width="800" height="640" loading="lazy">
```

## Recommended shot list

**Hero / lifestyle**
- Crew member squeegeeing a sun-lit window (clean reflection)
- Wide shot of a beautiful clean home exterior, blue sky
- Branded vehicle / uniformed crew arriving (trust signal)

**Per service** (one strong before/after + one action shot each)
- Window cleaning · Gutter cleaning · Pressure washing (driveway) · House washing (siding)
- Soft washing · Roof cleaning (black-streak removal) · Solar panels · Screens
- Hard-water stain removal (glass close-up) · Holiday lighting (dusk, lights glowing)

**Team & trust**
- Individual headshots of each team member (consistent background) → `team.html`
- Group team photo → `about.html`
- Equipment / pure-water system close-up

**Local SEO**
- Recognizable shots in each service-area city when possible (geo-tag the files)

## Performance

- Export as **WebP** (or AVIF) at ~1600px wide max for full-bleed, smaller for cards.
- Always set `width`/`height` to prevent layout shift (good CLS / Core Web Vitals).
- Keep `loading="lazy"` on below-the-fold images (already applied to slider images).
- Compress to keep most images under ~150 KB.
