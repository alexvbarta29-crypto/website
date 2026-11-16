# Barta Light Studio (/lights)

The owner's Christmas light mockup tool: paste a Street View screenshot, draw
light lines on the house, and download the photo named for the customer.

- **URL:** https://www.bartawindowwashing.com/lights — not linked from the site,
  not in the sitemap, and served with `noindex`.
- **Served by** `netlify/functions/lights.mjs`. The page itself is
  `netlify/lib/lights-page.mjs` (generated from the Light Studio build; replace
  the whole string to update the tool). It is not a static file, so it can't be
  reached without signing in.
- **Password:** the owner's chosen default (the owner has it; the code keeps
  only a digest). To change it, set `OFFICE_PASSWORD` in Netlify → Site
  configuration → Environment variables and redeploy. Changing it signs every
  device out.
- **Staying signed in:** the right password sets a year-long HttpOnly cookie
  (`barta_office`, path `/`, shared by all office tools; see docs/OFFICE.md) that renews on every visit, so each device
  types the password once.

## Street View by address

Type an address on /lights and Street View opens aimed at the house; turn,
zoom and tilt (or drag the picture), then **Use this view** to start drawing.

- **Served by** `netlify/functions/lights-streetview.mjs` at `/lights/streetview`.
  It only answers a browser signed in to /lights, so nobody else can spend the
  Google key.
- **Needs** `GOOGLE_MAPS_API_KEY` in Netlify → Environment variables, from a
  Google Cloud project with billing on and two APIs enabled: **Geocoding API**
  and **Street View Static API**. Restrict the key to those two APIs. Until the
  key is set, the page says Street View isn't switched on yet; pasting
  screenshots always works.
- **Cost:** each address lookup is one geocode (Street View metadata is free);
  each view shown is one Static Street View image. Google's free monthly
  allowance per API covers thousands of each.
- **Size:** Google serves Street View at most 640 px wide, so these photos are
  softer than a full-screen screenshot. The download is upscaled to 1920 px so
  the bulbs stay sharp.

## Bulb size

Rooflines and bushes/trees/pillars each have their own bulb size per photo.
The size slider changes the roofline bulbs while the Roofline tool is picked
(or a line is selected), and the bush/tree/pillar bulbs while one of those
tools is picked (or one of those shapes is selected). Their slider goes up to
500, which takes the mini lights past full C9 size without touching the
roofline.

**Pure white** is a bulb color matched to the cool white C9s on Barta's own
installs (the Christmas page photos).

**Pillar wrap:** with the Pillar tool picked (or a pillar selected) a second
slider appears, from thin diagonal wraps to a super thick, solid column of
lights. Pair it with a smaller bulb size for the packed look.

## Measure roof (satellite)

The **Measure roof** tab shows the address from above (Maps Static API,
satellite, 2× scale). Click each corner along a roofline to get the feet for
every section and the total; **New line** starts a separate run, drag to move
the map, zoom 17–21. Points are kept as latitude/longitude, so they stay put
when the map moves or zooms. Needs the **Maps Static API** enabled for the
same Google key (and added to the key's API restrictions).

## Live Street View and live map

With `GOOGLE_MAPS_BROWSER_KEY` set in Netlify, the signed-in page gets real,
live Google Street View (drag, walk along the road, zoom) and a live
satellite map for measuring. **Crop** captures exactly the view on screen
(as a Street View Static picture of the same panorama, heading, pitch and
zoom). Without the key, or if Google refuses it, the page falls back to the
picture-by-picture view.

Make it a **separate** key: Application restriction **Websites** →
`https://www.bartawindowwashing.com/*` and `https://bartawindowwashing.com/*`;
API restriction **Maps JavaScript API**. (The server key can't be
website-restricted, because Google's server APIs refuse such keys.)
Free monthly allowance: 10,000 dynamic map loads and 5,000 dynamic Street
View loads.

## From a lights quote (the CRM's automatic mockup)

On a Christmas lights quote in the CRM, **Mockup** makes the mockup by
itself: the house from Street View (the same `GOOGLE_MAPS_API_KEY` and aim
as above, fetched by the CRM's server), Claude's vision model marking the
rooflines, and the same C9 bulbs drawn on it (the drawing is ported to
`crm-app/modules/quotes/bulbs.js`). **Edit in Light Studio** opens this
tool with that photo and those lines ready to adjust: the CRM leaves them
in the tab's sessionStorage (`bls-preload`, read once) and the page's
`blsPreload()` (added after the build: keep it when the page is replaced)
adds the photo, turns each line into roofline runs (bushes and trees into
shapes), and sets the colors, bulb size and a dusk look.

- **Needs** `ANTHROPIC_API_KEY` in Netlify → Environment variables (an
  Anthropic API key, server-side only, never logged). Without it the CRM's
  own edge finder draws the lines, or the owner draws them here.
- **Cost:** about 2 to 4 cents of Claude per mockup, plus one Street View
  image; a second look at the same house is free (cached). At most
  `CRM_MOCKUP_DAILY_MAX` (default 40) Claude calls a day.
- Only the photo goes to Claude: never the customer's name, phone or
  address. See docs/CRM-QUOTES.md "Estimate templates and the lights mockup".
