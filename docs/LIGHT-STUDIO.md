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
  only a digest). To change it, set `LIGHTS_PASSWORD` in Netlify → Site
  configuration → Environment variables and redeploy. Changing it signs every
  device out.
- **Staying signed in:** the right password sets a year-long HttpOnly cookie
  (`barta_lights`, path `/lights`) that renews on every visit, so each device
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
