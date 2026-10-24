# Barta Light Studio (/lights)

The owner's Christmas light mockup tool: paste a Street View screenshot, draw
light lines on the house, and download the photo named for the customer.

- **URL:** https://www.bartawindowwashing.com/lights — not linked from the site,
  not in the sitemap, and served with `noindex`.
- **Served by** `netlify/functions/lights.mjs`. The page itself is
  `netlify/lib/lights-page.mjs` (generated from the Light Studio build; replace
  the whole string to update the tool). It is not a static file, so it can't be
  reached without signing in.
- **Password:** the `LIGHTS_PASSWORD` environment variable in Netlify → Site
  configuration → Environment variables (redeploy afterwards). It is never in
  the repo. Until it's set, the page stays locked. Changing it signs every
  device out.
- **Staying signed in:** the right password sets a year-long HttpOnly cookie
  (`barta_lights`, path `/lights`) that renews on every visit, so each device
  types the password once.
