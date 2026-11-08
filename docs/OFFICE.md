# Barta Office (/office)

The office's tools as one app: a frosted-glass header across the top (like the website's)
to switch between

- **Christmas Lights** → `/lights` (Light Studio)
- **Follow-ups** → `/playbook`
- **Purchases** → `/purchases` (see docs/PURCHASES.md)
- **Giveaway** → `/admin/giveaway.html`
- **Rotor** → opens Rotor in a new tab

Served by `netlify/functions/office.mjs` from `netlify/lib/office-page.mjs`.
Each tool loads in its own frame the first time it's opened and stays open in
the background, so switching never loses work. The page remembers the last
tool, and `/office#lights` etc. opens one directly. Inside the app each tool's
own logo, footer and sign-out are hidden (the `css` for each tool in
`office-page.mjs`), so it reads as one piece of software.

## One password

One office password, asked for only at `/office`, opens everything:
`/lights` and `/playbook` send a signed-out visitor to `/office` instead of
asking for a password themselves, and the giveaway (and referral) dashboards
accept the same sign-in instead of their admin key. The password is the owner's chosen one (kept only as a PBKDF2
digest in `netlify/lib/lights-auth.mjs`), or `OFFICE_PASSWORD` in Netlify if
set. The year-long cookie (`barta_office`, path `/`) renews on every visit.
Changing the password signs every device out. The dashboards' admin key
(`REFERRAL_ADMIN_KEY`) still works on its own too.

Not linked from the site and never indexed. To add a tool, add it to `TOOLS`
in `office-page.mjs`.

## The phone app

Barta Office installs on a phone like an app, with its own icon, full screen
and no browser bar. No App Store needed.

- **iPhone:** open bartawindowwashing.com/office in Safari, sign in, tap Share,
  then Add to Home Screen. The home-screen app keeps its own sign-in, so sign
  in once more the first time it opens.
- **Android / Chrome:** open /office and tap Install on the "Get the app"
  card (or Chrome's menu → Install app).

A "Get the app" card shows in a browser tab until it's installed or closed
with ×, and never inside the installed app. Every update to the site reaches
the app on its own; there is nothing to reinstall.

Pieces:
- `office.webmanifest`: name, icons, start page `/office`, scope `/office`.
- `office-sw.js`: service worker for `/office` only. Shows a "No connection"
  screen with no signal. It never caches office pages, only the icon and fonts.
- `APP_HEAD` in `netlify/lib/office-page.mjs`: manifest and iPhone tags, on
  both the office page and its sign-in page.
- Icons in `assets/img/app/`, drawn by `python3 build/make_app_icons.py`.
  `/assets/` is cached for a year, so a new icon needs a new `.vN` name.
- `build/make_deploy.py` ships the manifest and service worker; `netlify.toml`
  stops them being cached.
