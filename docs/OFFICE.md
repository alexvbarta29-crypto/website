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
