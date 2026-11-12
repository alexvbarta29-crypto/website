# Barta CRM (/crm) and the Customers list (/crm/legacy)

Barta Window Washing's own CRM, built in milestones (design: the CRM
design document, §11). Live so far: the **Customers list** (the first
slice), the **foundations** (M1.1), **sign-in and the app shell** (M1.2),
the **platform engine** and **messaging, automations, the client portal
frame and the owner's screens** (M1.3), **Contacts** (M2a), **Sales**
(M2b), **Import from Rotor** (M2c) and the **guards and phone checks**
(M1.4). Barta Office is one app: with a CRM sign-in `/office` is the CRM,
with the dashboards and office tools inside (docs/OFFICE.md). Rotor stays
exactly as it is and the CRM never calls it; nothing the CRM decides to
send reaches a customer yet: it lands in the Outbox.

## Start here

### Modules

Each module keeps its own page (design §0 rule 14); this page keeps the
core: storage, sign-in, the shell, the engine, messaging and the portal.

| Page | Milestone | What it covers | Status |
|---|---|---|---|
| [CRM-CONTACTS.md](CRM-CONTACTS.md) | M2a | people, properties, intake from the website and Meta, merge review | live |
| [CRM-SALES.md](CRM-SALES.md) | M2b | deals, follow-up cadences, Leads & calls, tasks, the Follow-ups wording | live |
| [CRM-IMPORT.md](CRM-IMPORT.md) | M2c | the Rotor export: pack, upload, phases, conflicts, report | live |
| [CRM-QUOTES.md](CRM-QUOTES.md) | M3a | price book, pricing, quotes and portal approval | live |
| [CRM-PLANS.md](CRM-PLANS.md) | M3b | care plans, agreements, Christmas lights seasons | live (in review) |
| [CRM-WORK.md](CRM-WORK.md) | M4a, M4b | jobs, visits, scheduling; the tech app | live |
| [CRM-MONEY.md](CRM-MONEY.md) | M5 | invoices, payments, tips, autopay | stub |
| [CRM-COMMS.md](CRM-COMMS.md) | M6 | the Inbox and conversations, inbound texts, campaigns, reviews, Rotor's messages | live (in review) |
| [CRM-PAYROLL.md](CRM-PAYROLL.md) | M7a | pay periods and pay lines | stub |
| [CRM-REPORTS.md](CRM-REPORTS.md) | M7b | rollups, the dashboard feed | stub |
| [CRM-MCP.md](CRM-MCP.md) | M7c | Claude's tools over the CRM | stub |
| [CRM-MAP.md](CRM-MAP.md) | maps | Door to door (the knock map, pins, areas, convert to lead, the report) and the live Team map; the map stack, geocoding, outside hosts | live (in review) |

The office side (tabs, the launcher for a start with no signal, web push,
where the Follow-ups wording comes from): [OFFICE.md](OFFICE.md).

### Tests

- `npm test`: everything under `tests/**/*.test.mjs` (unit, API, guards),
  no network, a pinned clock, under 30 s. `npm run test:crm` only the CRM's;
  `CRM_IT=1 npm test` adds the store contract against a local Blobs server.
- `tests/crm/routes-meta.test.mjs` (the route guard, generated from the
  registry): every route declares `auth`, `perm`, `subject` and `mode` with
  a real permission; every route is called as nobody, the office cookie,
  an owner, an admin, two techs, two API keys and an import upload key,
  and must answer what its perm and the role defaults say (403 without the
  permission, 401 for the wrong credential, a list never on an "own"
  permission); every JSON answer to a tech is crawled for contact ids
  outside that tech's ±7/30-day visit window, office-only text and fields
  beyond a type's `techFields`. A module adds nothing for a plain route.
  It extends the test only when its route checks credentials itself
  (`auth: "hook"`: list it in `HOOKS`), applies a stricter rule inside the
  handler than its `perm` (a `GATES` entry that reads the rule from its
  source), or takes a path param of a new record type (a fixture in
  `byType`).
- `npm run e2e`: the phone checks (`tests/e2e/*.spec.mjs`, not part of
  `npm test`). They use the machine's own Playwright with Chromium (not a
  dependency of the site: Netlify installs `package.json`'s dependencies on
  every deploy); on a new machine `npm i -g playwright && npx playwright
  install chromium` first. Each spec starts `tests/e2e/server.mjs` (every
  function and static file of the working tree on the memory stores, a
  clock from Tuesday 2026-11-17 09:00, a throwaway office data key so the
  first-owner setup works with the office password `test-password`, no
  network) and `seed.mjs` (the team, 200 contacts, the sales data).
  `core.spec` walks the one app, back and the edge swipe, sheets, the
  offline start, links that leave, the insets message, a 2 s round trip and
  every client route of the manifests at iPhone 13 and SE sizes;
  `contacts.spec` and `sales.spec` their modules' flows. `E2E_SHOTS=<dir>`
  saves screenshots. `node tests/e2e/server.mjs` runs the seeded server by
  hand on port 8796 (sign in as olive, ada, theo or tess with "a long
  synthetic passphrase"). Chromium can't check what only WebKit does (the
  installed iPhone app, iOS zoom and safe areas): each gate still ends with
  the §9.4 checklist on an iPhone. The tap-target check (`screenProblems`
  in `kit.mjs`) wants 44 px on a phone or a tablet and 32 px on a desk
  with a mouse (900 px and up, a fine pointer).

### Releasing a client change

A track never touches `crm-sw.js`, `crm-app/version.js` or `MIN_CLIENT`;
the integrator, after merging:

1. `npm test` (only `precache.test.mjs` may fail: new client files).
2. Bump `APP_VERSION` in `crm-app/version.js` (`YYYY.MM.DD-n`), then
   `node build/crm_precache.mjs` (rewrites `crm-sw.js`: `VERSION` and the
   precache list; `--check` says whether it is current). `npm test` is green.
3. `npm run e2e` and `npm run scan`.
4. `python3 build/make_deploy.py`, look through `_deploy/` (nothing private,
   no `tests/`, `docs/` or `build/`), `rm -rf _deploy`.
5. Commit "CRM: release client <version> (...)" and push. Phones pick the
   new version up on their next start ("New version, tap to reload"; never
   under someone's thumb). Raise `MIN_CLIENT` in `core/http.mjs` only when
   older clients must stop (426); offline replays still get one version of
   grace (`MIN_REPLAY_CLIENT`).
6. On an iPhone, in the installed app: the §9.4 checklist for what changed.

## The Customers list (/crm/legacy)

The first slice: every customer from Rotor, made for a phone. **Read-only**.
Since M2a the CRM's **Contacts** tab is the Contacts module's own list
(docs/CRM-CONTACTS.md); this one stays at `/crm/legacy`, linked at the
bottom of Contacts and from the "Open the Customers list" button while the
CRM still needs its setup, until the Rotor import goes live (then it is
deleted with `crm-page.mjs`, `crm-data.mjs` and the seal script). Its
display helpers live in `netlify/lib/crm/modules/contacts/display.mjs`. It opens for the office password's cookie and for owners and
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
- **The office password** keeps opening the office tools (Lights,
  Purchases, Follow-ups, Giveaway, the dashboards) and the Customers list.
  With a CRM sign-in, `/office` is the CRM full screen (one app); on a
  phone that also has the office cookie the dashboards are its Dashboard
  tab and the tools are in More (docs/OFFICE.md). A CRM sign-in alone
  (techs) opens the CRM only.
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

**Automatic setup (the default today).** A production deploy that already
has `OFFICE_DATA_KEY` (the dashboard's key) counts as set up: that key is the
second production signal, the key salt is derived from it with HKDF, and the
first-owner screen asks for the **office password** typed again instead of a
setup code. Nothing to add in Netlify. `CRM_PRODUCTION`, `CRM_KEY_SALT` and
`CRM_SETUP_CODE`, when set, still win; `CRM_AUTO_SETUP=0` turns this off.
Never add `CRM_KEY_SALT` after data exists, and never change
`OFFICE_DATA_KEY` without a planned re-key: the phone and email lookups are
keyed with the salt. Only a function that sees the production deploy context
counts the key (with no context at all, `CRM_PRODUCTION` alone decides).
Tests: `tests/crm/core/auto-setup.test.mjs`.

The manual path, for reference:

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
  from `/crm-app/` (no build step). Tabs at the bottom: Home · Schedule ·
  Customers · Sales · Menu for owners and admins (Inbox appears when its
  module ships); Today · Time · Pay · Me for techs (Inbox appears with M6).
  See "Home and navigation" below. **My account**: name, mobile, password,
  the phones you're signed in on.
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
- **Wider screens** (900 px and up: an iPad, the office desk): a desktop
  layout, the same code (see "Home and navigation"). Screens load behind
  grey skeletons, not spinners.
- **The look** (`crm-app/styles/crm.css`, its tokens on `:root`): the
  website's brand (coral #fb4d3d, AA text coral #d0331f, ink, mist, line;
  self-hosted Cabinet Grotesk 700/800 and General Sans 400/500/600) with a
  field-service app's treatment: a spacing and type scale, Cabinet Grotesk
  800 only for page titles and big numbers and 700 for section titles,
  General Sans for the rest with muted secondary text, tabular figures for
  money, counts and times; white cards with a hairline border, a 12 px
  radius and a soft shadow; 10 px rounded-rectangle buttons (a coral
  primary whose white text is AA, `--coral-btn`; quiet white secondaries);
  soft-filled status pills (green, amber, blue, red, grey) the same in
  every module; a coral focus ring for the keyboard. A phone keeps 44 px
  tap targets and 16 px inputs; a desk with a mouse (900 px and up, a fine
  pointer) has 40 px buttons and 34 px chips. Modules style only their own
  pieces on top of these. Light only.
- **Security:** every CRM page sends `Content-Security-Policy` with
  `script-src 'self'` (and `connect-src` adds exactly the map hosts of
  `core/map-sources.mjs`, docs/CRM-MAP.md) and has no inline script; screens build markup only
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
| `GET /api/crm/me` · `/me/badges` | signed in | who am I, permissions, tabs · badge counts (approvals since M1.3; inbox and notifications when they ship) |
| `GET /api/crm/home` | signed in (each part by its own permission; a tech gets nothing) | Home in one read: the numbers, today's visits, Needs you |
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

## Home and navigation (the office's first screen)

The owner judges the CRM by the screen it opens on, so it opens on
**Home**: the business at a glance, like Rotor's and Flyra's dashboards,
in one scroll of cards on a phone and one grid on a computer.

### What Home shows (owners and the office; `#/today`)

- The date, a greeting and the bell.
- **Money this month** (a dark card): collected so far, the year against
  the same dates last year, and the weekly columns (12 weeks).
- **Quick actions**: New lead, New quote, Book a visit (New job), Log a
  call, each shown only with its permission.
- **Today**: visits today, done, to book (the Schedule's tray), plan
  visits due this month, then the day's visits in time order (time,
  customer, town, the work, who goes, status), each opening the visit.
- **Needs you**: one row per kind with its count, each opening its list:
  leads that need a call, calls due, tasks for you, quote changes, quotes
  waiting on the customer, unsigned agreements, plan visits to book,
  requests waiting for an owner's OK, bulk sends waiting for a test,
  agreement texts to approve, clawbacks to bill, possible duplicates,
  stale jobs, import conflicts, system alerts. "You're all caught up"
  when there's nothing.
- **This month**: Jobs completed, Average ticket (goal $300+), Close rate
  (goal 40-50%), Active plans ($ on the books), New leads (this week),
  Quotes out; each tile opens the matching Dashboard view.
- **Sales, Plans, Jobs** cards (new leads in 4 weeks, close rate, quotes
  out and leads per week; active plans, on the books, visits to book and
  the plan mix; jobs this month, not scheduled, visits today and the next
  four weeks) and **Collected by month** (this year beside last year).
  "See more" opens the Dashboard's view on a phone or computer with the
  office sign-in, else the module's own screen.

Charts are drawn in the CRM (`home-charts.js`; no frame of /dashboard):
coral columns on one baseline, last year in gray, a readout that follows a
tap, the pointer or the arrow keys, and every value in a hidden table.

**Where the numbers come from.** From the CRM's own records once they cover
the business (a finished Rotor import, or the CRM is the system of
record): jobs completed, average ticket (work completed ÷ billable jobs,
§5.9), close rate (quotes won ÷ won + lost, this year), active plans, quotes
out, visits ahead. Until then, and for money and weekly leads (the CRM
keeps no payments until Money, M5, and no lead rollups until Reports,
M7b), from the office dashboard's sealed Rotor snapshot
(`loadDashboard()`, opened once per warm instance), labelled "From Rotor ·
updated <date>". When the reports module provides the service
`reports.series` (`{ metric, group, keys } → { since, values }`), its weeks
and months replace Rotor's from the day its data starts. A number nobody
has is left out, never shown as 0.

**Who sees what.** The numbers: `reports:read` (owners and the office) or
a phone with the office sign-in, never a technician. Today's visits:
`schedule:read` (unscoped). Each Needs-you row: its own permission. A
technician's Today is unchanged (their own day; the tech app, M4b, fills
it) and `GET /home` answers them with nothing in it.

**One read, inside the budget.** `GET /api/crm/home`
(`netlify/lib/crm/modules/system/home.mjs`, pure parts in `home-kpis.mjs`)
counts from index blobs only, never by listing records, and reads each
index once for the whole request: its store scope carries `ixMemo`, which
crm-store's `readIndex()` honours (no dirty marker read either). About 20
storage calls cold (24 once the CRM's numbers are used, with the tech
app's time rows), under the 25 of §2.2; `tests/crm/core/home.test.mjs`
holds it there. `GET /me/badges` reads its counts in the same kind of
scope, so every module's rows fit its budget too.

**Adding to Home (modules).** A module's manifest `attention` and
`approvals` rows (`{ key, label, perm, count(ctx), link }`) are Home's
Needs-you rows; `badge: false` lists a row on Home without lighting the
tab's dot (calls due, quotes waiting, tasks for you). A client
`todayCards` entry renders on Home under Needs you unless it says
`home: false` (the sales, plans and work cards do: their counts are
Needs-you rows). One card lands there today: the tech app's My visits
with the clock, for an owner or office person who goes out on visits.
A card may have its own `events` and `mount` (delegated inside its
wrapper, `modules/system/cards.js`), on Home as on a tech's Today.
Money's and the inbox's rows arrive with their modules.

### The bar, the Sales switch and the Menu

- Owners and the office: **Home · Inbox (M6) · Schedule · Customers · Sales
  · Menu**. Sales is Leads & calls with **Calls · Quotes · Tasks** in a
  switch under the header (the tab stays lit on each). A shell cached
  before this bar (Dashboard and More tabs) shows the new one.
- **Menu** (`#/menu`) is a full page of sections with large tiles, built
  from the manifests' `nav: [{ where: "more", section, ... }]` entries:
  Work, Sales, Customers, Money, Messages & automations, Office tools,
  Admin (an entry without a known `section` lands in "More"). My account
  is the card at the top, Sign out at the bottom.
- The coral create button is on Customers, Schedule and Sales (Home has
  its quick actions).

### On a computer (900 px and up)

- A **sidebar** in the website's deep ink: the white logo, Home (and
  Inbox), then every Menu section as a collapsible group under a small
  label (remembered on that browser), the current screen lit with a coral
  bar, badges, and who is signed in.
- The slim white **header**: the title, a **search** box (`GET /search`:
  names, phones, streets, Q-/INV- numbers; office only), the screen's own
  button (white, so New is the one coral button), **New** (the creates)
  and the person's menu (My account, Sign out).
- Screens sit on the mist canvas and use the width (up to 1,160 px; the
  Schedule's month up to 1,480 px with the day's list beside it from
  1,100 px; a Visit in two columns from 1,200 px; full-width lists such as
  Jobs, Plans and Payments read as a table from 1,100 px; Home up to
  1,440 px as a grid:
  the month's tiles in a row, money beside money by month, today beside
  Needs you, Sales, Plans and Jobs side by side). Sheets are dialogs.
- **List + detail** from 1,000 px: a list route marked `split: true`
  (Contacts, Quotes) stays on the left while what it opens (a contact, a
  quote, a new one) shows beside it, the list keeping its search and
  scroll and lighting the open row (`core/router.js`).
- `/office` installs as an app on Chrome and Edge (docs/OFFICE.md).

Code: `crm-app/modules/system/{home,home-charts,menu,today}.js`,
`home.css`, `crm-app/core/{nav,router}.js`, `crm.css`. Tests:
`tests/crm/core/home.test.mjs` (the numbers, who sees what, the budget,
the extension points) and `tests/e2e/home.spec.mjs` (iPhone 13 and SE,
1440 x 900 and 1024 x 768: Home on a real day and empty, the taps, a tech,
the Sales switch, the Menu, the sidebar, search, list + detail, Chrome's
installability check, the office password's tab row). The route walk in
`core.spec` covers every screen at the two desk sizes too.

## The platform engine (M1.3, part A)

What runs behind the screens: the two worker lanes and their cron, the
scheduled-work queue, events between modules, multi-record operations, the
nightly maintenance, backups and restore, files, settings, approvals and
API keys. Nothing here contacts a customer: sending, templates,
automations, bulk runs, notifications and web push (part B, next section)
are built on these pieces.

### Before and after the owner's setup

Scheduled and background functions run on the production deploy whether
or not the CRM is set up. **Before** the owner sets `CRM_PRODUCTION` and
`CRM_KEY_SALT` they do exactly what the M1.1 probe did and nothing else:
the cron records its facts in `crm-probe` and wakes the fast worker, which
records the background facts and (hourly) times 20 writes there; the bulk
worker does nothing; no CRM store is opened. **After** setup the cron also
makes `sys/worker-secret` (once), notes `sys/health.cron_at` and wakes
both lanes. The probe facts are still recorded until the M1 gate.

### Lanes (`core/lanes.mjs`, `core/worker.mjs`)

- **Fast lane** (`crm-worker-background`): due queue items, fast sweeps,
  fast runs, then maintenance (operations whose lease ran out, `pend/`
  repairs, `fix/` settling). **Bulk lane** (`crm-bulk-background`): runs
  (reindex, the nightly check, backups, CSV exports, later imports and bulk
  sends) one checkpointed step at a time, then bulk sweeps.
- Each lane has its own lease (`lock/worker-fast`, `lock/worker-bulk`, 5
  minutes, renewed by CAS after every pass); a second invocation exits at
  once. Passes are at most 2 minutes; no new pass starts after 13. A pass
  that made no progress ends the invocation, except that the fast lane
  sleeps until the next queue item when it is due inside its budget (so a
  5-minute `lead.ack` goes out at 5 minutes, re-checking the queue head
  every 30 s; a due item the pass could not run, such as a kind this deploy
  has no handler for or a step held elsewhere, does not wake it). Work left
  at the end makes the lane kick itself, at most 3
  times in a row (`sys/health.lanes.<lane>.self_kicks`; a cron kick resets it).
- Kicks: `kickWorker(lane, reason)` POSTs to the lane on the canonical host
  with `x-crm-worker: <sys/worker-secret>` and a 1.5 s timeout, through
  `context.waitUntil`; failures are ignored (the 15-minute cron catches up).
  `POST /api/crm/hooks/cron` with the same header does the cron's work when
  scheduled functions are unavailable (D39).
- `sys/health`: per lane `last_pass_at`, `last_progress_at`,
  `last_invocation`, `self_kicks`, `last_error`; the queue's depth and next
  item; the nightly check; the last snapshot and off-site copy; `alerts`.
  `GET /api/crm/admin/health` adds `status.fast|bulk` = ok / stuck (no
  finished pass in 3 hours) / never, and `mode` (`sys/mode`: paused, since
  when, by whom, why, the system of record), so Today and Settings → Data
  say plainly when the CRM is paused.
- Runs (`stepRun`) get the pass's `sys/mode` in their write context and the
  automation helpers (`mayAct`, `would`, `log`). A step the parallel-run
  backstop stops writes a `would-<action>` row and ends its run (done,
  `result.would`), never a retry loop.

### Queue and events (`core/queue.mjs`, `core/events.mjs`)

- `enqueue(kind, subject, expect, dueAt, marker)` writes
  `q/{utcDate}/{utcHHMM}--{qid}`: UTC keys, so the 01:00-01:59 hour that
  happens twice on 2026-11-01 cannot run anything early. An item holds the
  subject and the state it expects, never a rendered body.
- Running one: claim its marker (`done/` or `done-dry/`, §7.3) with a lease;
  the kind's handler re-reads the subject and acts on its current state;
  `{ defer: at }` (quiet hours) keeps the same marker and moves the item;
  a failure retries after 1, 5, 30 and 120 minutes, then the marker is
  failed and the owners get an alert; a `ParallelRunGuard` becomes a
  `would-<action>` row in `alog/`. The `q/` key is deleted only once the
  marker is final.
- `emit(event, payload)` queues one `evt` item per listener with marker
  `done/evt/{event_id}--{module}` and kicks the fast lane; the event id is
  derived from the record's write counter, so "reopen and complete again"
  is a second event and a retried request is the same one.

### Operations (`core/ops.mjs`)

`runOp(opId, kind | steps, { input })` with the journal `op/{opId}`:
versioned ids (`opIdFor("approve--{quoteId}", n)`), a 2-minute lease
renewed after each step, children made once (`s.createOnce(type, scope, n,
data)` with ids derived from the op), numbers journaled before use
(`s.number(childId, seq)`: an intent first, then `nextNumber`, which
claims `ptr/{seq}-no/{n}` for the child, then the number; a resume after a
crash in between finds the pointer naming its child and reuses that
number, so there is never a gap), and resume by the fast lane only after
the lease ran out. A double tap gets `{ status: "running" }` and runs
nothing. Ops the worker must be able to resume are defined by kind with
`defineOp(kind, { steps(input) })`. The journal keeps who started the op
(`actor`: by, origin, actor_kind); the worker finishes it as that actor
with the pass's `sys/mode`, so a customer's portal approval or a person's
merge keeps the exemption people have from the parallel-run guard.

### Sweeps (`core/sweeps.mjs`)

Modules register sweeps in their manifests (`every: pass | hourly | daily |
weekly | monthly`, `at_local`, `dow`, `day`, `mutates`, `maintenance`).
A periodic sweep claims `done/sweep/{key}--{instance}` when it starts and,
if it stops half way, hands the claim back with its cursor until it
finishes. While `sys/mode.paused` only maintenance sweeps run. Core
catalog: `system.seed` (each module's seeds once, each as a resumable op
of kind `system.seed`: a storage error is finished on a later pass; a seed
that fails for good raises one alert), `auth.sessions` (03:15: expired
sessions and portal sessions, throttle records older than a day (sign-in
and API key counters), expired idempotency records, sweep claims older
than 90 days, the sender's duplicate-guard markers older than a day, stale
leases, CSV exports 3 days after their run (and any whose run is gone),
finished runs older than 60 days), `pending.requeue` (hourly: an approved
action whose run was never queued is queued again), `backup.nightly`
(03:00), `index.verify` (03:45: rebuilds
every index and declared relation family from the records, diffs, repairs,
reports; a banner after two nights in a row with repairs), `files.backup`
(04:15), `files.purge` (04:30), `backup.offsite` (Sundays 04:00: alerts
when no off-site copy is newer than 8 days).

### Repair (`crm-store.mjs`)

A record write leaves `pend/{type}/{id}` with its side plan (and, for an
update, the previous version's). If the function dies before the index
rows, relations and pointers land, the fast lane finishes them after 60 s
(`repairPending`), moving rows an update left in the old shard; a create
whose record never landed gets its claimed pointers released. `fix/`
markers (writes whose outcome storage never confirmed) are settled by
`settleFix`. `verifyIndex` and `verifyRels` are the nightly check.

### Backups, the off-site copy and restore (`core/backup.mjs`)

- Nightly snapshot into `crm-backups`: partitions `sys` (`sys/mode`,
  `sys/bootstrap`), `cfg/`, `seq/`, `ptr/`, `sup/`, one per `rec/{type}/`,
  `rel/`, `op/`, `plk/`, `apikey/`, `push/`, `done/`, `evt/`, `q/`,
  `alog/`, `idx/`; never sessions, throttles, idempotency records, leases,
  intents, staging, dry-run markers or the derivable indexes and activity
  feed. Parts `snap/{date}/{partition}/part-{nnnn}.jsonl` (≤ 4 MB);
  the run checkpoints after each part and resumes from `last_key`. Kept:
  35 dailies and each 1st-of-month for 12 months.
- **Off-site copy (weekly, until the Drive upload exists):** an owner makes
  a **backup key** (My account → API keys → kind "backup": it carries
  `export:all` and nothing else, owners only, 90 days by default). Then:

  ```bash
  CRM_BACKUP_KEY=bcrm_... node build/crm_backup_pull.mjs --site https://www.bartawindowwashing.com
  ```

  It downloads the newest snapshot through `GET /api/crm/admin/export`,
  seals every part with the office public key and writes
  `~/barta-private/backups/{date}/...sealed.json` (refusing any folder
  inside a worktree), then marks the copy on the site (the "no off-site
  copy" alert clears).
- **Restore** (each step with the owner's yes):

  ```bash
  NETLIFY_AUTH_TOKEN=... node build/crm_restore.mjs --site-id SITE_ID --date 2026-11-17 --check
  NETLIFY_AUTH_TOKEN=... node build/crm_restore.mjs --site-id SITE_ID --date 2026-11-17 --apply
  # or from the sealed copy: add --from-dir ~/barta-private/backups with OFFICE_DATA_KEY set
  ```

  `--check` restores into the scratch store `crm-restore-check` and
  compares keys per partition and the invoice/payment money sums.
  `--apply` (type RESTORE) writes `sys/mode` paused first, then every
  partition (conditional writes; counters never go back, and neither does
  a step's marker that moved on since the snapshot or an operation that
  finished: their live values are kept, and a queued step whose marker is
  final is not brought back, so nothing runs twice), then re-seats every
  sequence past the highest issued number + 100. Records go back to the
  snapshot's version: that is what a restore is for. Then, in the app:
  rebuild the lists (`POST /api/crm/admin/reindex`), let the nightly check
  run, review, and resume with RESUME.
- Owner export: `GET /api/crm/admin/export?date=&partition=&part=` (a
  snapshot part, never a live listing, audited) and
  `POST /api/crm/admin/export.csv?type=` (a run; CSV of one record type
  from the latest snapshot, without password hashes; download from
  `GET /api/crm/admin/export.csv/{runId}` for 3 days, then the nightly
  clean-up deletes it). Settings → Data's **Download everything** lists
  every part of the latest snapshot as a download (each one audited).

### Files (`core/files.mjs`)

Upload `POST /api/crm/files?owner_type=&owner_id=&kind=&tag=` with the raw
bytes (≤ 4,000,000; JPEG, PNG, WebP or PDF); the type comes from the magic
bytes, never the header. Download `GET /api/crm/files/{id}[?thumb=1]`:
`nosniff`, `Content-Security-Policy: sandbox`, inline for images and
`attachment` for PDFs and anything else, ETag and 304. Imported media
outside the allowlist (HTML, SVG, unknown) is stored download-only and
served as `application/octet-stream` attachments. Who may read and edit
follows the owner record, declared by its module with
`defineFileOwner(type, { canRead, canEdit, attach? })`. Delete is soft; the
bytes go 30 days later and only once `files.backup` has copied them.
`files.backup` decides what to copy from listings only (the bytes in
crm-files against the copies in crm-backups) and keeps its position, so a
night with nothing new reads no file record.

### Settings, system mode, approvals, API keys

- `GET /api/crm/settings` (what this person may open), `GET/PUT
  /api/crm/settings/{name}` with `If-Match` (`"new"` before the first
  save; 412 with the current value when stale). Each document has one
  permission (§4.12): company, hours, calendar and service area
  (`settings:general`), messaging (`settings:messaging`), automations
  (`automations:configure`); messaging_test, integrations, numbering,
  storage, permissions and auth are owner-only (`settings:owner`). Saving
  `permissions` or `auth` moves `sys/auth-epoch`, so every server picks it
  up within seconds; a failed read of `cfg/permissions` still answers 503.
  Every validator keeps only the fields it knows (automation settings get
  the same checks as `PATCH /automations/{key}`), a page is at most 16 KB
  (the portal page, with its terms, 64 KB), and the bulk-send test contact
  must be a contact flagged test (the page shows its name).
- `sys/mode` is never guessed: a failed read answers 503 busy in a request
  and throws in the worker. A record a person creates after cutover is
  never a shadow (crm-store reads `sys/mode` when the write context does
  not carry it), and purge-shadow deletes only shadows created before
  `cutover_at`.
- `POST /api/crm/admin/pause` / `resume` (owners, typed PAUSE / RESUME):
  `sys/mode.paused` stops every side effect, the queue, automations and
  non-maintenance sweeps. `POST /api/crm/admin/reindex` and
  `/admin/purge-shadow` (typed PURGE SHADOW) are owner runs; `GET
  /api/crm/runs/{id}` follows a run.
- Approvals: `GET /api/crm/pending-actions`, `POST
  /pending-actions/{id}/approve|reject` (owners). A phone's offline work
  older than 6 days arrives through `POST /api/crm/outbox-review` as one
  pending action. Claude's actions through an API key (M7c) will arrive the
  same way; an approved action runs once on the fast lane as the approver.
  If the queue write after the approval failed, approving again queues it
  (and the hourly `pending.requeue` does too); its marker keeps it to one
  run. `/me/badges` counts them for whoever may approve.
- API keys: `GET/POST /api/crm/api-keys`, `DELETE /api-keys/{id}` (owners
  and admins, their own keys). A key is shown once (the create route is
  secret and never kept for replay), read-only unless write scopes are
  ticked (the new-key sheet lists the person's read permissions, ticked,
  and write permissions to tick one by one; `GET /api-keys` gives them in
  `meta.scopes`), and some permissions can never be on a key. The
  owner-only backup kind is the one exception for `export:all`. Each key
  has a rate (120 calls a minute; path keys 30): one small blob per call
  under `thr/key/{keyId}/`, counted by one listing; over it answers 429
  with Retry-After. The "path" kind is hidden in the app until the MCP
  connector (M7c).
- Audit: `GET /api/crm/audit?date=&user=&type=` (who did what that day),
  `GET /audit/event?key=`, `GET /records/{type}/{id}/history`.

### Code and tests

- Core: `netlify/lib/crm/core/{settings,activity,audit,lanes,queue,ops,sweeps,worker,backup,files,pending}.mjs`;
  routes in `netlify/lib/crm/modules/system/{settings,admin,audit,files,pending,apikeys}.mjs`;
  types `file`, `run`, `pending_action` in `modules/system/types.mjs`.
- Functions: `crm-cron.mjs`, `crm-worker-background.mjs`,
  `crm-bulk-background.mjs`. Scripts: `build/crm_backup_pull.mjs`,
  `build/crm_restore.mjs`.
- Tests: `tests/crm/core/{worker,ops,events,index,backup,backup-tools,files,platform,budget,schema-compat}.test.mjs`,
  with `tests/helpers/crm-fixtures.mjs` (`fakeServices`, `fixtureModule`,
  `fixtureType`, `virtualSleep`, `recordKicks`, synthetic people and file
  bytes) and `t.runWorker()` / `t.kicks()` in `crm-http.mjs`.
  `budget.test.mjs` calls every route under a strict budget; a module adds
  its samples in `tests/crm/<module>/budget-samples.mjs`.
  `schema-compat.test.mjs` runs the previous commit's validators over
  records the current code writes.

## Messaging, automations, the portal and the screens (M1.3, part B)

### What the owner sees

More (the Menu since Home: Messages & automations and Admin) gains
**Approvals**, **Automations**, **Templates**, **Outbox**, **Activity** and
**Settings**; Today (now Home) gains the bell (notifications), the
approvals and the workers' alerts.

- **Outbox**: every text, email, push or charge the CRM would have made
  ("Not sent": dry run) or held back (with the reason: opted out, no
  consent, a blank in the template, sent the same a moment ago...), by
  day; tap one for the whole message. Beside it, the **automation log**:
  sent, dry-run, skipped and the **would have** rows (what an automation
  would have changed on a record Rotor still owns).
- **Automations**: the built-in catalog (design §5.7.4). Each one on or
  off, its channels, delay, time of day and templates, the last 7 days and
  today's log. Automations of modules that haven't shipped show "Arrives
  with Sales / Scheduling / ...". **Pause all** stops every automation
  (people's own messages still go).
- **Templates**: the library by category; the editor has variable chips,
  a live preview (made-up values, or a chosen contact's) and the server's
  warnings. A template never says "Reply STOP to opt out": the sender adds
  it. Built-in templates (each module brings its own) are written once by
  the worker and never overwritten afterwards.
- **Approvals**: bulk sends waiting for their test send and a confirm, and
  (owners) pending actions: a phone's offline work older than 6 days, and
  later Claude's requests. The owners get a notification for each.
- **Activity**: who did what, by day, by person and kind of record (by
  name: the office sees the team's names too); tap a row for that record's
  history.
- **Settings**: Company; Hours & holidays; Service area; Messaging (quiet
  hours, the opt-out footer, the bulk threshold, the duplicate window,
  reply keywords, and for owners the **test contact** every bulk send goes
  to first); Team permissions (owners: office and technician defaults, Yes /
  Own / No, and whose Team sign-in may open the office tools); Integrations
  (owners: the mode of each service and the mode it really runs in, and
  which secrets Netlify has, by name only); Intake mode (owners; "Rotor and
  the CRM" arrives with Contacts); Data (whether the CRM is paused, since
  when and why; workers, backups, the off-site copy, Download everything,
  CSV export, rebuild the lists, and Pause or Resume: only the one that
  applies).
- **My account**: notification channels per kind, **push on this phone**
  (see docs/OFFICE.md), API keys (make one, shown once; revoke).

### Sending (`core/send.mjs`, `adapters/`)

`sendMessage()` is the only way anything texts or emails a customer:
suppression (`sup/{channel}/{hk}`, beats consent), consent per category
(marketing texts need "granted"; service texts and marketing email only
"not revoked"), a contact's `automations_paused`, the test allowlist in
test mode, the template rendered at send time (a blank without a fallback
blocks the send), **quiet hours** (service 08:00-21:00, cadence
08:00-20:00, marketing 09:00-20:00 Monday-Saturday and never on holidays;
a queued step keeps its marker and waits, a person's send of a template is
scheduled; a person's own words go any time), the **opt-out footer**
(" Reply STOP to opt out." on the first text to a phone from each sending
number, and on every marketing text), the step's **marker**
(`done-dry/` in dry-run, `done/` when real) and the **duplicate guard**
(the same body to the same address within 10 minutes).

It fails closed. A failed read of the suppression list or of `sys/mode` is
never "not opted out" or "not paused": a person's send answers 503 busy
and a queued step retries. A person's send claims its own marker: a retry
with the same `client_id` answers "already" (with its outbox item) only
once that step finished; while the step is held it answers busy, and a
send that failed before reaching the provider hands its claim back so the
retry goes out. The footer's first-text rule counts by the number the text
really goes out from (`sms.test_from` in test mode, else `sms.from` when
set, else the main number). Category "staff" is internal only (a text to a
staff phone with no customer contact); templates people make can't be
"staff", and a staff send that reaches a customer follows the service
rules. A quiet-hours window with no allowed minute (no day ticked; the
settings page refuses it) blocks the send instead of failing.

Opting out goes through `core/suppressions.mjs` (the portal unsubscribe,
`POST /suppressions`, later inbound STOP): `sup/{channel}/{hk}`, a dated
row so Settings → Messaging lists the newest first, and the
`consent.changed` event for sales and comms. Unsubscribe links are never
revoked with a contact's other links: opting out always works.

The adapter layer picks dry-run, test or live per integration
(`cfg/integrations`, Settings → Integrations): live only on the production
deploy with the secrets, never paused, and before cutover live acts as
test (staff numbers only). Automated sends to a contact Rotor still owns
are always dry-run before cutover. The Twilio and Postmark drivers are
Messages' (M6, docs/CRM-COMMS.md): without their keys a live or test mode
stays dry-run, test reaches only the allowlisted staff phones, and the
Twilio driver refuses live while Rotor is the system of record. **Dry-run writes only an outbox item and its `done-dry/` marker**:
no message, conversation, stats or activity. Magic values test the failure
paths: a text to (763) 555-0199 fails with 30007, email to
bounce@example.com bounces, `dry_pm_decline`/`dry_pm_auth`/`dry_pm_ach`
for payments. Marketing email gets an unsubscribe link and RFC 8058
`List-Unsubscribe` headers when it really goes out.

### Automations and bulk sends (`core/automations.mjs`, `core/bulk.mjs`)

Modules declare automations in their manifests; the engine gives them
settings (`cfg/automations.{key}`), eligibility (the triggering fact at or
after `cfg/automations.effective_from`, written at cutover; nothing the
import created unless the automation says `imported: "eligible"`, and then
only for subjects still in the future), the step marker (never twice), the
parallel-run guard (would- rows) and the run log (`alog/`). Event-triggered
automations are queued by the event dispatcher (marker
`done/evt/{event_id}--auto.{key}`); a send is a queue item
(`automation.send`) re-checked when it is due.

Anything addressed to more than `cfg/messaging.bulk_threshold` (5)
people becomes a **bulk run** (`rec/bulk_run`): a preview in the bulk lane
(how many, who is left out and why, 10 sample texts), a required **test
send** to the test contact, then an owner's or the office's **confirm**
(`campaigns:send`); the bulk lane then sends 25 at a time, about one a
second when real. At send time each recipient is checked again for what
the preview left out (archived, test, vendor and spam contacts, a second
contact on the same phone or email, opted out, no consent), so the count
the owner confirmed is who gets it, and then by the sender. The test send
keeps the version of the template it rendered: a template changed after
the test sends the run back to "ready" (test again), and the send renders
the tested version. A write that fails half way never strands a run: the
preview and send runs have ids derived from the bulk run, confirming again
finishes a confirm whose run was not created, and a test whose save failed
counts once its marker shows it went out.

### Notifications and web push (`core/notify.mjs`, `core/webpush.mjs`)

`notify(userIds, { kind, title, body, link })` (the `notify.users`
service) writes one queue item; the fast lane writes one notification per
person (the bell; `rel/user-unread/{uid}` is the badge's count) and pushes
it to each of their phones whose channels include push. Web push is
RFC 8291 (aes128gcm) and RFC 8292 (VAPID, ES256) with `node:crypto`, live
on the production deploy once `CRM_VAPID_PUBLIC` and `CRM_VAPID_PRIVATE`
exist (staff only, so before cutover too); a 404/410 deletes the
subscription; only Apple, Google, Mozilla and Microsoft push services are
ever called (exact hosts: fcm.googleapis.com, the Mozilla push hosts,
web.push.apple.com, and Windows' `*.notify.windows.com`). Old
notifications go after 60 days (`notifications.prune`). "Mark all read"
marks 8 at a time (`{ read, more }`; the app asks again while `more`), so
it fits the route's budget however many are unread.

### The client portal frame (`/p/*`, `/api/portal/*`)

`netlify/functions/crm-portal.mjs` (rate limited) and
`netlify/lib/crm/portal/core.mjs`: magic links (`/p/{10 characters}`, kept
only as a hash, expiring per `cfg/portal`, revocable, locked after too
many opens a day), the entry page whose script POSTs `/api/portal/open`
(a GET changes nothing: link previews and email scanners open nothing),
the scoped cookie `barta_portal` (one link's scope only: a quote link
never opens the hub or another invoice), the view beacon, the
unsubscribe page and its RFC 8058 one-click POST (writes the
suppression), the Checkout return page and present links (no cookie,
single use, 15 minutes). Headers: no-store, noindex,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a strict CSP with
only `/crm-app/portal/*.js` scripts. The pages themselves (quote,
agreement, invoice, card, hub) arrive with their modules through
`portalRoutes`.

### Endpoints added in part B

| Route | Who | What |
|---|---|---|
| `GET /templates`, `GET /templates/:id`, `POST /templates/preview` | `messages:send` (techs: active service/personal) | the library, one template, a preview with warnings |
| `POST /templates`, `PATCH /templates/:id` | `templates:edit` | create, edit (If-Match) |
| `GET /automations`, `PATCH /automations/:key`, `POST /automations/pause` · `resume` | `automations:configure` | the catalog and settings |
| `GET /automations/log?date=&key=` | `outbox:read` | the run log |
| `GET /outbox?date=&contact=&kind=&before=` | `outbox:read` | what would have gone out |
| `GET /notifications`, `POST /notifications/read` | yourself | the bell |
| `GET /suppressions`, `POST /suppressions` | `consent:edit` | opt-outs by address (masked) |
| `GET/POST /bulk-runs`, `GET /bulk-runs/:id`, `POST …/cancel` | `campaigns:write` | bulk sends |
| `POST /bulk-runs/:id/test` · `confirm` | `campaigns:send` | the test send, the confirm |
| `POST /messages` | `messages:send` (techs: their visits' contacts) | a person's text or email (the `messages.sink` service) |
| `GET/POST /push/subscriptions`, `DELETE /push/subscriptions/:hash`, `POST /push/test` | yourself | push on this phone |
| `GET /search?q=`, `POST /search/deep` | `contacts:read_all` | numbers and contacts; a run over notes and messages |
| `GET /permissions`, `GET /admin/integrations` | owners | Team permissions, Integrations |
| `GET/PUT /settings/portal`, `/settings/intake` (owners), `/settings/comms` (`settings:messaging`) | | new settings documents |

### Code and tests

- Core: `netlify/lib/crm/core/{templates,send,outbox,automations,bulk,notify,webpush,suppressions}.mjs`,
  `netlify/lib/crm/adapters/{index,dry-run,webpush}.mjs`,
  `netlify/lib/crm/portal/core.mjs`; routes in
  `modules/system/{comms,search,permissions}.mjs`; the comms part of the
  contact stats (`first_sms` per sending number, `last_contacted_at`) is
  registered by the system module because core's sender writes it.
- App: `crm-app/core/{poll,outbox,camera,signature,pickers,map}.js`,
  `crm-app/portal/core.js`, the screens in `crm-app/modules/system/`;
  `office-sw.js` shows pushes; the office shell asks for permission.
- Tests: `tests/crm/core/{send,automations,bulk,webpush,templates,messaging,portal,push-shell,screens}.test.mjs`,
  and `recovery.test.mjs` (a write that fails half way: seeds, the sleeping
  lane, run steps under the guard, lost approvals, restore and markers,
  shadows after cutover, the file backup);
  fixtures `seedContact`, `seedImportedContact`, `seedStats` (contacts
  before M2a) and `t.portal()` in the harness.
