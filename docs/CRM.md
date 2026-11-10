# Barta CRM (/crm) and the Customers list (/crm/legacy)

Barta Window Washing's own CRM, built in milestones (design: the CRM
design document, §11). This page covers what is live so far: the
**Customers list** (the first slice, below), the **foundations** (M1.1) and
**sign-in and the app shell** (M1.2). Each module keeps its own
`docs/CRM-<MODULE>.md`. Rotor stays the system of record until cutover.

## The Customers list (/crm/legacy)

The first slice: every customer from Rotor, made for a phone. **Read-only**;
editing, new customers, jobs and the rest arrive with the Contacts module
(M2a), which replaces this list. Since M1.2 it lives at `/crm/legacy` (the
CRM's app shell took `/crm`) and opens from the CRM's **Contacts** tab, or
from the "Open the Customers list" button while the CRM still needs its
setup. It opens for the office password's cookie and for owners and
office staff signed in to the CRM (`contacts:read_all`); technicians get
"Not for this login".

What's on the page:

- A sticky search bar (name, company, phone, address, email, tags, notes:
  every word you type has to match), filter chips (All · Active · Inactive,
  plus the six most common sources; several can be on at once), and the
  count of who matches.
- The list, grouped by last name with sticky letters and a letter rail on the
  right (tap or slide to jump). Each row: name, company, phone, town.
- Tap a row for the detail sheet (slides up on a phone, a side panel on a
  laptop): Call, Text, Email and Directions buttons, then address, source,
  tags, who it's assigned to, customer since, notes, and **Open in Rotor**.
  Close it with ✕, Escape, or the phone's back gesture.
- Under the list, a quiet line: "Imported Nov 8, 2026 · Re-import".

## Where the data lives

In **Netlify Blobs**, on the site, in a store called `crm` (strong
consistency, shared by every deploy). Nothing about a customer is in the
repo: the repo is public, and even an encrypted copy of the customer list
does not belong in it. The data gets onto the site through the app's
**Import** screen (below), once, and stays there until the next import.

One key (`netlify/lib/crm-store.mjs`):

| Key | What |
|---|---|
| `idx/customers` | what the page renders: `{ v: 1, imported_at, exported_at, count, members: [{ user_id, name }], customers: [every row] }`. Each row keeps only the fields the page uses (`id, first_name, last_name, company_name, email, phone, status, source, assigned_to, address, tags, notes, created_at`); members' names only, never their emails |

An import is **one write** of that blob, so the list is always one whole
export: an import that fails or times out leaves the previous list as it
was, and a customer dropped from a later export (including anyone removed
from Rotor at their own request) is gone from the store with that write.
No per-customer copies are kept until a feature reads them. `GET
/api/crm/import` answers from the same blob, so its summary can't disagree
with the list. (An early draft also wrote `customer/{id}` and
`meta/import`; it never shipped, so no store holds those keys.)

The index is one blob for now (the real export is under a thousand rows,
about 400-500 KB; the list page needs every row anyway). It will shard into
summaries when the real CRM lands and records change one at a time. Every
Blobs call has an 8-second timeout, and an import's storage work (one read,
one write) shares a 9-second budget; if storage doesn't answer, the tab
says so instead of crashing. Two imports at the very same moment: the last
write wins, and it is still one whole export.

What an import takes (`normalizeBundle()` in `netlify/lib/crm-data.mjs`,
which the seal script runs too, so a file that seals is a file the site
takes):

- Rotor's UUID ids, unique; a real calendar `exported_at`, not in the future.
- Strings (or null) only, each within `LIMITS` (names 60, email 120, phone
  25, address parts 200, notes 10,000, tags 20 × 40, …). Fields the page
  doesn't use are dropped; a known field of the wrong type or size refuses
  the whole file ("That is not a Barta export file", with the row and field
  in `field`, never the value).
- At most 5,000 customers and 200 members (413 "too-many"), at most 3 MB
  once decrypted, and a list page under 5 MB (Netlify serves 6 MB at most;
  413 "too-big"). An export with no customers is refused ("empty").

Pieces:

- Page: `netlify/functions/crm.mjs` (`GET /crm/legacy`, office cookie or a
  CRM session with `contacts:read_all`, never cached or indexed; its CSP
  allows exactly its own inline scripts by hash: the fixed script sources
  in `crm-page.mjs` `LEGACY_SCRIPTS`, hashed once, so a script that a
  missed escape let into a row would not run). `GET
  /crm/legacy?import=1` is the Import screen even when there is a list, and
  even when the saved list can't be read; a list blob that isn't JSON shows
  the Import screen too, so it can always be imported over.
- Import API: `GET`/`POST /api/crm/import`, moved unchanged from the
  deleted `crm-import.mjs` into the CRM's dispatcher
  (`netlify/lib/crm/modules/system/legacy.mjs`, served by `crm-api.mjs`):
  the office cookie or an owner's session (`import:run`), `401` otherwise,
  and the CSRF header `X-CRM: 1` like every CRM write. The deploy picks the
  store (`crm` in production, `crm--deploy-preview` on a preview), which
  replaced the first slice's preview refusal. While production still waits
  for its CRM settings, the office cookie reads and writes `crm` exactly as
  before. `GET /api/crm/legacy/customers` returns the same rows as JSON.
- Rendering: `netlify/lib/crm-page.mjs` (`customersHtml(data)`,
  `importHtml({ current })`, `setupHtml(reason)`); the list is rendered on
  the server, and the same customers are embedded as JSON for instant
  search and the sheet.
- Data: `netlify/lib/crm-data.mjs` (`loadCustomers()` reads the index;
  `normalizeBundle()` checks an export; helpers for names, phones,
  addresses, maps links, members) over `netlify/lib/crm-store.mjs`
  (`openLegacyStore()`, `readCustomerIndex()`, `buildCustomerIndex()`,
  `writeCustomerIndex()`, `indexSummary()`; these keep using the `crm`
  store exactly as before while the full CRM is built next to them).
- Tests: `tests/crm.test.mjs`, `tests/crm-import.test.mjs` (made-up people,
  555 numbers; the store is a Map).

## Making the sealed file (Claude, outside the repo)

Claude exports the customers and members from Rotor (`list_customers` and
`list_company_members`, one JSON row per line) into a folder **outside the
repo**, holding `customers.jsonl` and `members.jsonl`, then seals it:

```bash
node build/crm_seal_import.mjs /path/to/export /path/to/barta-customers-2026-11-08.sealed.json --as-of 2026-11-08
```

The script dedupes by id, repairs the few names Rotor hands back
double-encoded (like "Oâ€™Connor"), keeps only what the site keeps (the 13
customer fields above; members as `{ user_id, name }`, so member emails
never go into the file), stops with the row and field if anything doesn't
fit (exit 2, no values printed), builds the bundle
`{ v: 1, exported_at, customers, members }`, encrypts it with the office
public key (`build/office-dashboard-public.pem`: X25519 + AES-256-GCM, the
same scheme as the dashboard snapshot) and writes the sealed box
`{ v: 2, epk, iv, tag, data }` as JSON to the output path. It prints
counts only. **The output path must be outside the repo**: the script
refuses (exit 2) otherwise, judging the folder the way the filesystem
resolves it (so a symlink, or a symlinked folder plus `..`, can't point it
back in), refusing a symlink as the output, and writing through a fresh
temporary file renamed into place (so a hard link is replaced, not written
through). The file is created readable by its owner only. `--print` writes counts and field names to
stdout and seals nothing. With `OFFICE_DATA_KEY` in the environment (never
in a file in the repo) it also proves the file opens.

Only the site's server can open the file, with the Netlify environment
variable **`OFFICE_DATA_KEY`**, the same 44-character key the Dashboard
uses (docs/DASHBOARD.md). So the sealed file can travel to a phone through
AirDrop, Files or a chat without anyone else being able to read it. The
seal gives secrecy, not proof of origin: the public key is in the repo, so
anyone can make a file the site will open (see Rules).

## Importing in the app

1. Open Barta Office → **CRM** → **Contacts** (before the CRM's setup: the
   "Open the Customers list" button). Before the first import it is the
   Import screen: "Import your customers".
2. **Choose file** → pick the `.sealed.json` file → **Import**. The browser
   reads the file and POSTs it to `/api/crm/import`; the server opens it
   with `OFFICE_DATA_KEY`, checks and trims every row, replaces the
   customer index with one write, and the page reloads as the list.
3. If something is wrong, the screen says what: "The site has no
   OFFICE_DATA_KEY yet" (set it in Netlify → Site configuration →
   Environment variables, redeploy, try again), "That file was sealed for a
   different key", "That is not a Barta export file", "That export has no
   customers in it", "That file is too big" (6 MB, Netlify's request limit;
   the real export is about 0.5 MB), or that the export has more than the
   Customers tab can hold or show.
4. If the file would replace a list with a noticeably shorter one (more
   than 1% fewer customers: a Rotor export that stopped half way) or with
   an older export, the screen asks first: "This file has … The list has
   … Replace it anyway?", with a **Replace anyway** button. Uploading the
   same file twice (say, after "Storage didn't answer") never asks.

To refresh the list, tap **Re-import** under the list (or on the
"Storage didn't answer" page, or open `/crm/legacy?import=1`) and upload a newer
sealed file. **A re-import replaces everything** the page shows; it never
merges.

## Rules

- **Never commit customer data**, sealed or not. `tests/crm-import.test.mjs`
  fails if anything but `office-dashboard.sealed.mjs` appears under
  `netlify/data/`, and the seal script refuses to write inside the repo.
- **A sealed file proves nothing about who made it** (the public key is
  public): only import files you made with `crm_seal_import.mjs`. The
  office sign-in is the only thing guarding the import.
- Logs carry counts and HTTP statuses only, never a name or a phone number.
- Member emails stay on the server; the browser gets display strings only.
- If the key is ever lost, make a new pair with `newKeyPair()` from
  `netlify/lib/office-data.mjs`, put its `publicKeyPem` in
  `build/office-dashboard-public.pem`, set its `privateKey` in Netlify, and
  re-seal both the dashboard snapshot and a fresh customer export, then
  re-import.

## The full CRM: foundations (M1.1)

The Customers list above is the first slice. The full CRM (contacts, sales,
quotes, plans, scheduling, the tech app, money, messages, payroll, reports,
Claude's MCP access) is being built in milestones next to it; nothing a
customer or the office sees changes until each part ships, and Rotor stays
the system of record until cutover. M1.1 lays the foundations; it adds no
screen.

### Storage: `netlify/lib/crm-store.mjs`

The only file that talks to Netlify Blobs. Besides the legacy functions
above it now has the CRM's store API: records (`createRecord`,
`updateRecord`, `patchRecord`, `softDelete`, `hardDelete`, `getRecord`),
pointers, relations, index blobs, audit events and the activity feed,
counters, settings, exactly-once markers, leases, idempotency records, the
`contact_stats` sidecar (`updateStats`) and file bytes. What it guarantees:

- **Production data only in production.** `openStore(kind, deploy)` needs
  the deploy object from `core/context.mjs` `deployContext()`. Production
  means the deploy context is `production` **and** the Production-only env
  var `CRM_PRODUCTION=1`; only then are the stores `crm`, `crm-files`,
  `crm-backups` used. Deploy previews, branch deploys and local runs get
  `crm--deploy-preview`, `crm--branch-deploy`, `crm--dev`. A production
  deploy without `CRM_PRODUCTION` is "setup needed": the new CRM refuses to
  open any store (its screens say "Setup needed"), while the office tools
  and the Customers list keep working as today.
- **No lost or doubled writes.** Every shared write is conditional
  (`onlyIfNew` / `onlyIfMatch`) and carries a writer nonce (process id +
  request id + counter, so two function instances never share one). A
  conditional write without `onlyIfNew` or a real etag is refused, never
  sent unconditionally. Blobs is opened with its own `fetch` that gives each
  attempt a timeout and turns 429/5xx into one quick failure (the Blobs
  client would otherwise sleep 5 s per retry inside a request); the store
  retries itself. A clean 412 or a 401/403 is a definite "not written". When
  an outcome is unclear (a timeout, a 5xx, a blank answer) the store
  re-reads the key: its own nonce means the write landed. Once an attempt
  was unclear, any later failure (of a retry or of that read) means "maybe
  saved": a `fix/` marker names the key for the worker and the API answers
  "Storage didn't answer" (safe to retry with the same Idempotency-Key).
- **No orphan pointers.** A create or update claims its unique pointers
  first; if anything fails before the record write (a taken key, a
  storage error on `pend/`, a later claim), the claimed pointers are
  released once a read proves the record does not hold them, on a short
  budget of their own; a release that fails leaves a `fix/` marker.
  Pointers stay only when the record write itself is "maybe saved".
- **Listings and files.** A listing walks page by page, each page its own
  attempt (a prefix with many pages is not cut off by one attempt's
  timeout). A streamed file read is timed to its headers; its body gets
  25 s, so a photo sent to a slow phone is not cut off.
- **Index blobs stay small and honest.** A row that leaves a shard becomes a
  tombstone for a day (so a late writer cannot bring it back) and is then
  pruned. A rebuild reads the shard's dirty marker before it lists the
  records, so a dirty mark written while it runs keeps the shard dirty.
- **Envelope fields belong to the import.** `import`, `shadow`,
  `deleted_at`, `deleted_by` and `merged_into` in a create from anywhere
  but the import are dropped; an update keeps the stored `import` and
  `shadow` whatever its mutator returns.
- **No personal data in keys.** Phones and emails are keyed by an HMAC
  (`hk()`, salt `CRM_KEY_SALT`), never by digits or addresses.
- **Rotor stays in charge until cutover.** Automation may only create or
  change sandboxed records (made in the CRM and never imported, or a test
  contact); the store throws `ParallelRunGuard` otherwise (`core/guard.mjs`).
  The check fails closed: a write that does not set `ctx.actor_kind` counts
  as automation unless it comes from the API or MCP with a signed-in user
  (`by` = a user id), the portal or the import.

### Code layout

- `netlify/lib/crm/core/`: ids, clock (America/Chicago, DST-safe, pinned
  in tests), money (integer cents), errors, validators, text helpers,
  deploy context and the side-effect gate, the guard, the marker state
  machine, the module registry, services, events, stats, and the platform
  probe.
- `netlify/lib/crm/modules/<module>/`: one directory per module (system,
  contacts, sales, import, quotes, plans, work, money, comms, payroll,
  reports, mcp), each a `defineModule()` manifest registered by
  `modules/index.mjs`; all but `system` are stubs until their milestone.
  Each has its own `docs/CRM-<MODULE>.md`.
- `crm-app/modules/<module>/manifest.js`: the client side of each module
  (stubs until each module's milestone; the app's core is below).

### The platform probe (until the M1 gate)

Three probe-only functions record what Netlify actually gives each kind of
function into a scratch store, `crm-probe` (no customer data, safe before
any setup):

- `GET /api/crm-probe` (office sign-in): records the request function's
  facts and shows the whole report: per function kind (request, scheduled,
  background) whether the deploy-context signal and `CRM_PRODUCTION` are
  there, the Node version, write latency, and which Production-only
  settings are still missing (yes/no only, never a value).
  `POST /api/crm-probe` with header `X-CRM: 1` times 20 conditional writes.
- `crm-cron` (every 15 minutes, production only): records the scheduled
  function's facts and wakes the background function with a shared secret
  kept in the probe store.
- `crm-worker-background`: records the background function's facts and,
  at most hourly, times 20 conditional writes.

If p95 is over 150 ms, the request budget's default of 25 Blobs calls is
lowered (`suggested_max_calls` in the report).

### No customer data in git: three guards

`build/no_data_scan.mjs` reads every text file in the repository (UTF-8 or
UTF-16; images and fonts by name only) and fails on phone numbers outside
555 and the business's own numbers (formatted or `+1` numbers anywhere,
bare 10-digit Minnesota numbers anywhere, other bare runs after a word like
"phone"), real email addresses, data exports (`.jsonl` and `*.sealed.json`,
also compressed; spreadsheets and archives outside `assets/`; anything in
`netlify/data/` but the dashboard snapshot) and Stripe/Twilio secret or id
shapes. It runs:

1. before every `git push`: `npm install` sets `core.hooksPath` to
   `.githooks`, whose `pre-push` scans every outgoing commit (files and
   messages, including history a later commit removed; for a new branch,
   every commit that remote does not have yet);
2. on GitHub for every push and pull request (`.github/workflows/no-data.yml`):
   the tree, then the pushed commits; the first push of a new branch and a
   force push scan every commit that is not on another branch;
3. in `npm test` (`tests/crm/no-data.test.mjs`).

`npm run scan` runs it by hand. It prints file:line and the kind of
finding, never the value. If a bot-updated public file (Google reviews,
the Instagram feed) ever trips it, allowlist that exact value, never a
whole file type.

**Integrator checklist before the first push from a checkout:** make sure
the hook is active (`git config --get core.hooksPath` prints `.githooks`;
if not, run `npm install`, or `git config core.hooksPath .githooks`, or push
with `git -c core.hooksPath=.githooks push ...`). Prove it once: commit a
planted fixture (a made-up gmail address) on a throwaway branch, push it to
a local bare repository, see the push refused, then delete the branch.

### Tests

`npm test` runs everything; `npm run test:crm` only the CRM's. The CRM
tests use `tests/helpers/crm-memory-store.mjs`, an in-memory copy of the
Blobs store with fault hooks (a write that lands but reports failure, a
slow write, a hang, a 503), and pin the clock. `CRM_IT=1 npm test` also
runs the store contract against a local Blobs server (it opens a local
port). That server answers a read without an etag, so it cannot exercise
read-then-CAS (the store refuses such a write rather than sending it
unconditionally); the run proves that every write carries `if-match` or
`if-none-match` and that the server itself answers 412 to a stale etag.

### Owner setup (Netlify, Production context only)

Until these exist the new CRM stays in "setup needed" and changes nothing:

- `CRM_PRODUCTION` = `1` (marks the real production deploy),
- `CRM_KEY_SALT` = a long random string (keys phone and email lookups;
  keep a copy in the password manager: a restore needs it),
- `CRM_SETUP_CODE` = a one-time code for creating the first owner account
  (delete it after setup; see "First owner" below).

Set each one for the **Production** context only (empty for deploy
previews, branch deploys and local development), and turn **Deploy
Previews** and **branch deploys** off (Site configuration → Build & deploy):
every deploy's functions can reach the site's stores, so only the
production branch should build.

## Sign-in and the app shell (M1.2)

### Who signs in how

- **Each person has their own login** (Alex, Jacob, Eric, Gustov,
  Bennett): a handle like `alex` and a password of at least 10 characters
  (PBKDF2-SHA256, 600,000 iterations; nobody can read anyone's password).
  Roles: **owner** (everything), **admin** (the office: everything but the
  owner-only settings, voids, refunds, payroll runs and the team), **tech**
  (their own visits, time and pay). An owner can also tick a person as
  "goes out on visits".
- **The office password** keeps opening the old tools (Lights, Purchases,
  Follow-ups, Giveaway, the dashboards) exactly as before, and the
  Customers list. A CRM sign-in alone opens the CRM only: the office shows
  it full screen (**solo mode**, techs).
- **Owners get both with one sign-in (D14):** Team sign-in has an optional
  "Office password" field. Filled in by an owner (the roles in the
  owner-only setting `cfg/auth.office_cookie_roles`, default owners only)
  with the right office password, it also sets the office cookie on that
  phone. The CRM never stores the office password or its token.
- **Sessions** last a year at most and end after 60 days without use; "Sign
  out everywhere", a password change, a role change, a reset or turning a
  login off signs that person out on every phone within seconds.
- **Sign-in throttling:** after 5 wrong passwords in 15 minutes on one
  phone, each further try waits (30 s, then doubling, at most 15 minutes);
  someone else guessing can't lock Alex out of his own phone. The phone is
  known by a device id the server signs (`barta_dev`, an HMAC with
  `CRM_KEY_SALT`), so made-up ids count as a new browser. A browser that
  has never signed in shares one bucket per login (an hour's lock after 20
  failures), and one address gets an hour off after 30 failures. Each
  failure is its own small record under `thr/` (so 30 at the same moment
  all count), and a bucket's state is worked out from them. Netlify's own
  rate limit (30 a minute) comes first. The answer never says whether a
  login exists, in its words or in its timing (the same storage reads for
  a known and an unknown login; the failure's audit event is written after
  the answer).
- **Permissions** come from the role, the person's grants and denies, and
  the owner-only `cfg/permissions`. If that setting can't be read, the
  request answers "Storage didn't answer" (503); it never falls back to the
  role defaults.

### First owner (once), then the team

1. In Netlify (Production context only) set `CRM_PRODUCTION=1`,
   `CRM_KEY_SALT` (a long random string, kept in the password manager too)
   and `CRM_SETUP_CODE` (a one-time code), then redeploy. Until then the
   CRM tab says **Setup needed**, names what is missing, and links to the
   Customers list; nothing else changes.
2. Sign in to Barta Office with the office password and open the **CRM**
   tab: it shows **Set up the CRM**. Type the setup code, your name, a
   login and a password. That makes the first owner (it works once, even
   if two phones try at the same moment) and signs you in. A typo (a name
   over 60 characters, a taken login) is refused before setup is claimed,
   so fixing it and tapping again just works; and if setup's last write is
   lost, the next page view sees the owner and finishes it.
3. Delete `CRM_SETUP_CODE` in Netlify. Setup now answers "Setup is done".
4. **More → Team → Add** for each person (name, login, role). Each gets a
   one-time **invite link** (7 days) to send by text or AirDrop. Opening it
   asks for a password; then they add Barta Office to their home screen
   and use **Team sign-in** there (the installed app keeps its own
   sign-in). Forgotten password: Team → the person → **Password reset
   link** (it signs them out and the old password stops working until they
   use it). Invite and reset links are kept only as a hash: never in an
   idempotency record or anywhere else in Blobs (their routes are `secret`,
   so a retry makes a fresh link). **Turn off their login** ends their
   access at once.
5. If both owners are ever locked out: someone with Netlify access deletes
   `sys/bootstrap` from the `crm` store (`netlify blobs:delete crm
   sys/bootstrap`) and sets a new `CRM_SETUP_CODE`; setup opens once more
   for an office-password holder. Existing accounts are untouched.

### What the app is

- `/crm` is the **app shell**: a data-free page (only the signed-in
  person's id, name, role and permissions) that loads plain ES modules
  from `/crm-app/` (no build step). Tabs at the bottom: Today · Contacts ·
  More for owners and admins (Inbox and Schedule appear when their modules
  ship); Today · Me for techs (Inbox, Time and Pay appear later). Today is
  empty until the modules add their cards. More holds Team, My account and
  Sign out. **My account**: name, mobile, password, the phones you're
  signed in on.
- Inside the office the CRM is the **CRM** tab (the first tool); `/office#crm/<screen>`
  opens a screen, and the office mirrors where you are. The back arrow and a
  swipe from the left edge go back (home-screen apps have no browser back),
  sheets close with ✕ or a swipe down.
- **Offline:** the CRM's service worker (`crm-sw.js`, scope `/crm`) keeps
  the app's files and the shell, so it starts with no signal; the office's
  service worker keeps a data-free launcher (`/office/launch`) for a cold
  start with no signal, used only when this phone has a CRM shell to start
  (otherwise "No connection"). Data needs signal (the tech's offline day
  arrives with the tech app, M4b). The last good copy of what a screen read
  is kept per person (keyed by the user id), and signing out, being signed
  out (a 401) and a new sign-in all wipe it.
- **Wider screens** (900 px and up: an iPad, the office desk): the tab bar
  becomes a left rail and the screens sit centred beside it. Screens load
  behind grey skeletons, not spinners.
- **Security:** every CRM page sends `Content-Security-Policy` with
  `script-src 'self'` and has no inline script; screens build markup only
  through `html```, which escapes everything and refuses inline handlers,
  `javascript:` links and links that leave the CRM (those go through
  `openExternal()`: a new tab). A path is judged by where the browser would
  really go (resolved against `/crm`), so `/\evil.example`, `/./p/x` and
  the like are refused. Every write needs the `X-CRM: 1` header and a
  same-site (or absent) `Origin`, and JSON when it has a body (a `DELETE`
  has none), so another site can't post with your cookie.
- **Signed in with only the office password** (Jacob before his invite,
  or anyone without a login): the CRM tab shows Team sign-in with an
  **Open the Customers list** button; the old list still opens on the
  office cookie.

### Endpoints (all JSON, `{ ok, data }` or `{ ok: false, error: { code, message } }`)

| Route | Who | What |
|---|---|---|
| `POST /api/crm/auth/login` | anyone (throttled) | `{login, password, office_password?, to?}` → signs in |
| `POST /api/crm/auth/logout` · `logout-all` | signed in | this phone · every phone |
| `POST /api/crm/auth/password` | signed in | `{current, next}`; other phones signed out |
| `POST /api/crm/auth/setup` | office cookie + `CRM_SETUP_CODE`, once | first owner |
| `GET /api/crm/auth/invite/:token` · `POST /api/crm/auth/invite` | the link | set a password from an invite or reset link |
| `GET /api/crm/me` · `/me/badges` | signed in | who am I, permissions, tabs · badge counts (0 until M1.3) |
| `GET/POST /api/crm/users`, `GET/PATCH /users/:id` | owners (names only for schedule readers; yourself for name, phone, notifications) | the team |
| `POST /users/:id/invite` · `reset` · `disable` · `enable` | owners | links and access |
| `GET /users/:id/sessions` · `DELETE /users/:id/sessions/:hash` | yourself or owners | phones signed in |
| `GET /api/crm/legacy/customers`, `GET/POST /api/crm/import` | office cookie, owners/admins (import: owners) | the Customers list |

Every route goes through one dispatcher (`netlify/lib/crm/core/router.mjs`):
auth, CSRF, the client version (an app older than `MIN_CLIENT` gets 426 and
"New version, tap to reload"), `Idempotency-Key` replay for POSTs, a
256 KB body cap, permissions (a technician's "own" permissions never open a
list), an 8-second and 25-Blobs-call budget per request, and plain-English
errors with no stack or record data.

### Code

- Functions: `crm.mjs` (pages), `crm-api.mjs` (the dispatcher),
  `crm-auth.mjs` (sign-in, with Netlify's rate limit), `office.mjs`.
- Core: `netlify/lib/crm/core/{router,http,auth,passwords,sessions,throttle,perms,apikeys,shell-html}.mjs`;
  the team, `/me` and the legacy routes in `netlify/lib/crm/modules/system/`.
- App: `crm-app/main.js`, `crm-app/version.js`, `crm-app/core/*`,
  `crm-app/styles/crm.css`, the system screens in
  `crm-app/modules/system/`; `crm-sw.js`. `build/make_deploy.py` ships
  `crm-app/` and `crm-sw.js`; `netlify.toml` has them re-checked on every
  load.
- **Releasing a client change (integrator):** bump `APP_VERSION` in
  `crm-app/version.js`, run `node build/crm_precache.mjs` (rewrites
  `PRECACHE` and `VERSION` in `crm-sw.js`; `--check` only checks), and
  raise `MIN_CLIENT` in `core/http.mjs` only when old apps must stop.
  `tests/crm/core/precache.test.mjs` fails when they disagree.
- Tests: `tests/crm/core/{auth,perms,router,csp,precache,client}.test.mjs`,
  `tests/office.test.mjs`, `tests/crm.test.mjs`,
  `tests/crm-import.test.mjs`, with the harness
  `tests/helpers/crm-http.mjs` (fresh memory stores, pinned clock, strict
  fetch, real handlers), `crm-clock.mjs` and `crm-fetch.mjs`.
