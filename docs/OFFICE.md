# Barta Office (/office)

One page with tabs for the office's tools, so you can switch back and forth
without losing your place:

- **Christmas Lights** → `/lights` (Light Studio)
- **Follow-ups** → `/playbook`
- **Referrals** → `/admin/referrals.html`
- **Giveaway** → `/admin/giveaway.html`
- **Rotor** → opens Rotor in a new tab

Served by `netlify/functions/office.mjs` from `netlify/lib/office-page.mjs`.
Each tool loads in its own frame the first time its tab is opened and stays
open in the background. The page remembers the last tab, and `/office#lights`
etc. opens a tab directly.

The page itself holds no customer data. Every tool keeps its own sign-in
(its own password, remembered for a year), exactly as when opened on its own.
Not linked from the site and never indexed. To add a tool, add it to `TOOLS`
in `office-page.mjs`.
