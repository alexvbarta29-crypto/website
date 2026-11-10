# Barta Office → Customers (/crm)

The first slice of Barta Window Washing's own CRM: every customer from
Rotor, in the Barta Office app, made for a phone. **Read-only for now**;
editing, new customers, jobs and the rest arrive when the CRM's own records
land (Rotor stays the system of record until then).

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

- Page: `netlify/functions/crm.mjs` (`GET /crm`, office sign-in, never
  cached or indexed, framed by `/office` as the **Customers** tab).
  `GET /crm?import=1` is the Import screen even when there is a list, and
  even when the saved list can't be read; a list blob that isn't JSON shows
  the Import screen too, so it can always be imported over.
- Import API: `netlify/functions/crm-import.mjs` (`GET`/`POST
  /api/crm/import`, office cookie or `401`; refuses with `403` on a deploy
  preview or branch deploy, which share the live store, unless
  `CRM_ALLOW_PREVIEW_WRITES=1`).
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

1. Open Barta Office → **Customers**. Before the first import the tab is the
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
"Storage didn't answer" page, or open `/crm?import=1`) and upload a newer
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
  open any store (the screens arriving in M1.2 say "Setup needed"), while
  the office tools and the Customers list keep working as today.
- **No lost or doubled writes.** Every shared write is conditional
  (`onlyIfNew` / `onlyIfMatch`) and carries a writer nonce. Blobs is opened
  with its own `fetch` that gives each attempt a timeout and turns 429/5xx
  into one quick failure (the Blobs client would otherwise sleep 5 s per
  retry inside a request); the store retries itself and, when an outcome is
  unclear, re-reads the key: its own nonce means the write landed. If even
  that read fails, a `fix/` marker names the key for the worker and the API
  answers "Storage didn't answer" (safe to retry).
- **No personal data in keys.** Phones and emails are keyed by an HMAC
  (`hk()`, salt `CRM_KEY_SALT`), never by digits or addresses.
- **Rotor stays in charge until cutover.** Automation may only create or
  change sandboxed records (made in the CRM and never imported, or a test
  contact); the store throws `ParallelRunGuard` otherwise (`core/guard.mjs`).

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
  (stubs; the app itself arrives in M1.2).

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

`build/no_data_scan.mjs` fails on phone numbers outside 555 and the
business's own numbers, real email addresses, data exports (`.jsonl`,
`*.sealed.json`, anything in `netlify/data/` but the dashboard snapshot)
and Stripe/Twilio secret or id shapes. It runs:

1. before every `git push`: `npm install` sets `core.hooksPath` to
   `.githooks`, whose `pre-push` scans every outgoing commit (files and
   messages, including history a later commit removed);
2. on GitHub for every push and pull request (`.github/workflows/no-data.yml`);
3. in `npm test` (`tests/crm/no-data.test.mjs`).

`npm run scan` runs it by hand. It prints file:line and the kind of
finding, never the value.

### Tests

`npm test` runs everything; `npm run test:crm` only the CRM's. The CRM
tests use `tests/helpers/crm-memory-store.mjs`, an in-memory copy of the
Blobs store with fault hooks (a write that lands but reports failure, a
slow write, a hang, a 503), and pin the clock. `CRM_IT=1 npm test` also
runs the store contract against a local Blobs server (it opens a local
port).

### Owner setup (Netlify, Production context only)

Until these exist the new CRM stays in "setup needed" and changes nothing:

- `CRM_PRODUCTION` = `1` (marks the real production deploy),
- `CRM_KEY_SALT` = a long random string (keys phone and email lookups;
  keep a copy in the password manager: a restore needs it),
- `CRM_SETUP_CODE` = a one-time code for creating the first owner account
  (M1.2; delete it after setup).

Set each one for the **Production** context only (empty for deploy
previews, branch deploys and local development), and turn **Deploy
Previews** and **branch deploys** off (Site configuration → Build & deploy):
every deploy's functions can reach the site's stores, so only the
production branch should build.
