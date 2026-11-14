# Barta Office (/office)

**One app: the CRM, and its sign-in is the only way in** (the owner, Nov
2026: "When I'm on the desktop version I want it to be a legit CRM. Remove
all the headers and have the sign in be the only thing allowing you into
the CRM"). With a CRM sign-in (or the office password before the first
owner exists, to set it up) `/office` is the CRM, full screen, with no
header, logo bar or tab row; on a computer (900 px and up) not even the
"Get the app" card, so the CRM's own sidebar and top bar are all there is.
It looks like Flyra's iPhone app (Rotor's where Flyra shows
nothing), dark by default with a Light / Dark / Automatic choice per phone
(the Menu's sun button, My account → Appearance), in the iPhone's own font
and Barta's coral (docs/CRM.md "What the app is", the look). It opens on
**Home** (docs/CRM.md "Home and navigation"): Flyra's Home, "Good evening"
and the name big, the money (Collected, Scheduled or ARR over a period) on
the canvas, then cards each person shows, hides and orders with Edit
Home: the Leaderboard, Today (the day's, week's or month's visits and
tasks without a due date), Inbox, Tasks and Goals, with Clock in for
someone who goes out on visits. The office's bar is Flyra's floating glass
pill, Home · Schedule · Inbox · Map · Menu (each person may pick their
own: Settings → Appearance → Tab bar), with a round + beside it; the Menu
is a sheet of five groups (Work, Sales, Customers, Money, Marketing &
messages) and Settings, every screen once (docs/CRM.md "The bar, the Menu
and the +"); every setting is in one Settings hub (docs/CRM.md
"Settings: one hub"). On a computer (900 px and up) the same app has a
sidebar (the same places first, then the same five groups, Settings at
the bottom), a search box and a New button. In solo mode the office shell's backdrop and status bar color
follow the CRM's Light or Dark (`crm:theme`).
The full dashboards (Overview, Money, Sales, Plans, Jobs, switched in
place) are **Reports**: they open from the money card's "See more" and
Menu → Money → Reports. The office tools sit with the work they serve:
Light Studio in Menu → Sales, Purchases in Menu → Money, Giveaway in
Menu → Marketing & messages, Rotor in Settings → Import & data, and
Follow-ups on Settings → Follow-up cadences
(`crm-app/modules/system/{dashboard,tool}.js`, routes `/dashboard`,
`/dashboard/:view`, `/tools/:id`). Owners and the office
(admin) get them with their own CRM sign-in, no second password: the
sign-in also sets the office cookie (below); techs never get it. The
client's pseudo-permission `office:tools` is "an owner or admin whose
browser holds the office cookie", and each tool page still checks the
office cookie on the server. Old tab links
(`/office#lights`, `#money`, ...) open the matching CRM screen
(`IN_CRM` in netlify/lib/office-page.mjs), only with the office cookie, so a
tool's own "sign in" bounce can never loop.

The tab layout below is gone for everyday use: the office password alone
no longer opens it once the CRM has owners (it shows Team sign-in). It is
kept only as an emergency path while the CRM's storage can't be used at all
(then Team sign-in can't work either, and the office password still opens
the tools). Your logo sits at the top, with one row of tabs under it
(beside it on a computer):

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

## Who sees what, sign-in and setup

The CRM sign-in (each person's own login) is the only way in. `office.mjs`:

- **A CRM session:** the one app, the CRM full screen. **Owners and the
  office (admin)** also get the office cookie with the sign-in (and a fresh
  one on every visit to `/office`), so the dashboards behind the money
  card's "See more" and the office tools in the Menu open with no second
  password. **Techs** get only the CRM: a tech's sign-in or visit clears an
  office cookie that browser held, a tech never sees a number, a dashboard
  or an office tool, and an old `#lights` link opens the CRM's Today.
- **Signed out, or the office cookie alone:** the sign-in page, in the
  CRM's look (dark by default, or the phone's Light / Dark / Automatic
  choice from My account; the phone's own font, Barta's coral): **Login**,
  **Password**, **Sign in**, and **Forgot password?** (below). There is no
  "Office password" tab and no optional office password field any more. A
  CRM-issued office cookie whose session is gone (signed out elsewhere,
  login turned off) is cleared here.
- **Before the CRM has an owner:** the page asks only for the office
  password (Team sign-in can't work yet); it opens the CRM full screen with
  **Set up the CRM** (the first owner types the office password again, a
  name, a login and a password: automatic setup, nothing to add in Netlify;
  docs/CRM.md "First owner"). This form is throttled like sign-in.

**Forgot password?** On the sign-in page (and linked from the CRM's own
sign-in page, `/office#forgot`): your login, the **office password** (the
owners' shared secret), a new password and the same again. If the office
password is right and the login is on, the new password is set (the usual
rules: at least 10 characters, not your login or name), you're signed out
on every other phone and signed in here, the other owners get a bell
notice ("Alex reset their password with the office password") and it is in
the audit log. Anything wrong (the office password, an unknown login, a
login that's turned off) gets the same answer, "That didn't match.", and
tries are throttled like sign-in (they count in sign-in's buckets). Owners
can still send a reset link from Team.

**Guessing the office password.** Every form that takes it (this page,
`/lights`, `/playbook`, Forgot password, setup) is throttled the same way:
per phone, per address, and 40 wrong tries in an hour from anywhere stop
every one of them for an hour ("Too many tries. Wait ..."). With the CRM's
storage down a new office-password sign-in waits ("Sign-in can't be
checked right now"); phones already signed in keep their tools. This
limits online guessing; it doesn't make a short password hard to guess
from a leaked copy. See docs/CRM.md "The office password's remaining uses".

**The office cookie at sign-in.** `barta_office` (path `/`, HttpOnly, a
year in the browser, like the office password's): for a CRM sign-in its
value is `c1.{userId}.{issued}.{mac}`, an HMAC the server alone can make
(a key derived from the CRM's key salt) over the person, the time and the
office password's digest. The server takes it for 30 days from `issued`;
`/office` issues a fresh one on every visit with a CRM session (a tool's
own "sign in" bounce lands there too), so nobody active ever notices, and a
login that's turned off or a role changed to tech loses the tools within
30 days even on a browser that never opens `/office` again. Changing the
office password signs these out too. Signing out (this phone or
everywhere) clears it. Outside production with no key salt (a deploy
preview) the key is random per function instance, so the tools inside the
CRM may not open there. Code: `netlify/lib/lights-auth.mjs`
(`crmOfficeToken`, `signedIn` takes either form), `core/auth.mjs`
(`OFFICE_ROLES`, `officeCookieOnSignIn`).

If the CRM's storage can't be used, the office password still opens the tab
row, with the customer list one tap away, so the tools never disappear in an
outage.

The office and the CRM frame talk with `postMessage` (same origin only):
the CRM tells the office where it is (`/office#crm/<screen>` stays in step,
and opening such a link opens that screen), shows a dot when something
needs you, and asks the office to reload on sign-out; the office tells the
CRM the phone's safe areas (frames don't get them) and the height of the
"Get the app" card (the CRM lifts its toasts, its Create button and the
bottom of its sheets above it). `npm run e2e` checks these on phone sizes
(docs/CRM.md "Tests").

**Where the Follow-ups wording comes from.** `/playbook` (Settings →
Follow-up cadences → Follow-ups page) keeps its built-in texts until the CRM is set up; then each
step shows the CRM's current wording of that text (Templates `cad_new_1..9`
and `cad_est_1..5`, cached a minute), so an edit in the CRM shows on the
page within a minute. Details: docs/CRM-SALES.md "The Follow-ups page".

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

The office password is now the owners' shared master secret, used in two
places: **setting up the CRM** (before the first owner exists) and
**Forgot password**. Day to day nobody types it: owners and the office get
the office cookie with their own sign-in. `/lights` and `/playbook` send a
signed-out visitor to `/office` instead of asking for a password
themselves, and the giveaway (and referral) dashboards accept the office
cookie instead of their admin key. The password is the owner's chosen one
(kept only as a PBKDF2 digest in `netlify/lib/lights-auth.mjs`), or
`OFFICE_PASSWORD` in Netlify if set. A cookie made from the password itself
(older phones, setup) still opens the tool pages directly as before, but
not `/office` once the CRM has owners. Changing the password signs every
office cookie out, the sign-in's too. The dashboards' admin key
(`REFERRAL_ADMIN_KEY`) still works on its own too.

**Changing the office password without Netlify:** `OFFICE_NEW_PASSWORD='...' node build/office_password.mjs` seals the new password's check to the office key into `netlify/data/office-password.sealed.mjs` (the repo is public; only the site's server, holding `OFFICE_DATA_KEY`, can open it, so nobody can test guesses offline). Order: `OFFICE_PASSWORD` in Netlify if set, else the sealed check, else the built-in digest. Commit and deploy; every office cookie (and every CRM-issued one) then signs out once.

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
- **A computer (Chrome or Edge):** open /office and click the install icon
  in the address bar (no card on a computer: the CRM is the whole window).
  It opens in its own window with the desktop layout. `npm run e2e`
  (home.spec) asks Chrome itself whether /office can be installed (no
  installability errors).

On a phone, a "Get the app" card shows in a browser tab until it's
installed or closed with ×, and never inside the installed app; on a
computer (a mouse, or 900 px and up) it never shows. Every update to the site reaches
the app on its own; there is nothing to reinstall.

Pieces:
- `office.webmanifest`: name, icons, start page `/office`, scope `/office`.
- `office-sw.js`: service worker for `/office` only. It shows web push
  notifications and opens the app where one points when tapped. It never caches office
  pages, only the icon, the fonts and the data-free **launcher**
  (`/office/launch`: a full-screen CRM frame and an "Offline" strip). With
  no signal the app opens on the launcher when this phone has a CRM to
  start (someone signed in to the CRM: after one online visit the CRM keeps
  its shell in the `crm-shell` cache), and the CRM starts from that cached
  copy; otherwise (office password only, signed out, nothing kept yet) it
  shows "No connection". Back online it reloads the real office.
- `APP_HEAD` in `netlify/lib/office-page.mjs`: manifest and iPhone tags, on
  both the office page and its sign-in page.
- Icons in `assets/img/app/`: the //BWW logo on white, drawn by
  `python3 build/make_app_icons.py`. A phone that installed the app earlier
  keeps its old icon until the app is removed and added to the home screen again.
  `/assets/` is cached for a year, so a new icon needs a new `.vN` name.
- `build/make_deploy.py` ships the manifest and service workers (and the
  CRM's `crm-app/` files); `netlify.toml` stops them being cached.
