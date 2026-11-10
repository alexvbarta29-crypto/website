# Barta Office (/office)

**One app: the CRM.** With a CRM sign-in (or the office password before the
first owner exists, to set it up) `/office` is the CRM, full screen, with no
tab row. The dashboards are the CRM's **Dashboard** tab (Overview, Money,
Sales, Plans, Jobs, switched in place) and the office tools are in **More**:
Lights, Follow-ups, Purchases, Giveaway and Rotor
(`crm-app/modules/system/{dashboard,tool}.js`, routes `/dashboard`,
`/dashboard/:view`, `/tools/:id`). They show only on a phone that also has
the office sign-in (the client's pseudo-permission `office:tools`); each
page checks the office cookie again on the server. Old tab links
(`/office#lights`, `#money`, ...) open the matching CRM screen
(`IN_CRM` in netlify/lib/office-page.mjs), only with the office cookie, so a
tool's own "sign in" bounce can never loop.

The tab layout below remains for the office password alone once the CRM has
owners (someone without a CRM login is never locked out of the tools), and
when the CRM's storage is unavailable. Your logo sits at the top, with one
row of tabs under it (beside it on a computer):

- **Overview · Money · Sales · Plans · Jobs**: the dashboards (docs/DASHBOARD.md)
- **CRM** → `/crm` (Barta's own CRM, each person's own login; see docs/CRM.md).
  Its Contacts tab is the CRM's own contact list (docs/CRM-CONTACTS.md);
  the first slice's customer list from Rotor stays one tap away at its
  bottom until the Rotor import goes live. Old `#customers` links open
  this tab.
- **Lights** → `/lights` (Light Studio)
- **Follow-ups** → `/playbook` (once the CRM is set up, its texts are the
  CRM's current wording from Templates; see docs/CRM-SALES.md)
- **Purchases** → `/purchases` (see docs/PURCHASES.md)
- **Giveaway** → `/admin/giveaway.html`
- **Rotor** → opens Rotor in a new tab

Served by `netlify/functions/office.mjs` from `netlify/lib/office-page.mjs`
(`VIEWS` and `TOOLS`). The dashboard is one frame (`/dashboard?embed=1`, which
hides its own title and tabs) that switches view by its #hash; each tool loads
in its own frame the first time it's opened and stays open in the background,
so switching never loses work. The page remembers the last tab, and
`/office#money`, `/office#lights` etc. open one directly. Inside the app each
tool's own logo, footer and sign-out are hidden (the `css` for each tool in
`office-page.mjs`), so it reads as one piece of software.

## The CRM tab, solo mode and Team sign-in

The CRM has its own logins (one per person); the office password keeps
opening everything else. `office.mjs` counts a request as signed in with
the office cookie **or** a CRM session:

- **Office cookie** (with or without a CRM sign-in): every tab.
- **CRM session only** (techs, and anyone without the office password):
  **solo mode**, no tab row and no other tool; the CRM fills the screen.
- **Signed out:** the sign-in page has **Team sign-in** (login + password,
  for the CRM) next to **Office password**. The installed app opens on Team
  sign-in; a browser remembers the last one used. Before the CRM is set up
  only the office password shows. Owners can type the office password into
  Team sign-in's optional field to open both at once (docs/CRM.md); if it
  isn't right (or isn't for that login), the page says so for a few seconds
  before the CRM opens on its own.

While the CRM still needs its Netlify setup, its tab shows "Setup needed"
with a button to the customer list, so nothing used today disappears. Once
the settings exist, the first owner sets it up from this tab (docs/CRM.md
"First owner").

The office and the CRM frame talk with `postMessage` (same origin only):
the CRM tells the office where it is (`/office#crm/<screen>` stays in step,
also after a trip to another tab, and opening such a link opens that
screen), shows a dot on the tab when something needs you, and asks the
office to reload on sign-out; the office tells the CRM the phone's safe
areas (frames don't get them) and the height of the "Get the app" card
(the CRM lifts its toasts above it), and hides its logo row on phones while
the CRM tab is open. Signed in with only the office password after the CRM
is set up, the CRM tab shows Team sign-in with an **Open the Customers
list** button.

**Notifications on the phone (web push).** New leads, replies, approvals
waiting and visit changes can pop up on a phone like a text. iOS lets only
the installed app's own page ask for that, so: CRM → My account → **Turn on
for this phone** asks the office, which shows its own "Allow notifications"
card at the top; tapping **Allow** asks the phone, subscribes on
`office-sw.js` and saves the subscription in the CRM. On an iPhone this
works only in the installed app (Add to Home Screen first). A notification
shows a title and a short line (never more about a customer than a first
name and a town); tapping it opens the app at that CRM screen
(`/office#crm/<path>`). It needs the VAPID keys in Netlify
(`CRM_VAPID_PUBLIC`, `CRM_VAPID_PRIVATE`, Production only); until then the
bell in the CRM still shows everything. "Send a test" on My account checks a
phone.

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
in `office-page.mjs`; to add a dashboard view, add it to `VIEWS` and to the
views in `netlify/lib/dashboard-page.mjs`.

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
- `office-sw.js`: service worker for `/office` only. It shows web push
  notifications and opens the app where one points when tapped. It never caches office
  pages, only the icon, the fonts and the data-free **launcher**
  (`/office/launch`: a full-screen CRM frame and an "Offline" strip). With
  no signal the app opens on the launcher when this phone has a CRM to
  start (someone signed in to the CRM, so `crm-sw.js` kept its shell), and
  the CRM starts from that cached copy; otherwise (office password only,
  signed out, nothing kept yet) it shows "No connection". Back online it
  reloads the real office.
- `APP_HEAD` in `netlify/lib/office-page.mjs`: manifest and iPhone tags, on
  both the office page and its sign-in page.
- Icons in `assets/img/app/`: the //BWW logo on white, drawn by
  `python3 build/make_app_icons.py`. A phone that installed the app earlier
  keeps its old icon until the app is removed and added to the home screen again.
  `/assets/` is cached for a year, so a new icon needs a new `.vN` name.
- `build/make_deploy.py` ships the manifest and service workers (and the
  CRM's `crm-app/` files); `netlify.toml` stops them being cached.
