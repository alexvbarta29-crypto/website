# CRM module: import

Milestone: M2c (design §10.1-10.8, §10.10, §11.4); M8 adds the cutover.
The Rotor import framework: a Rotor export is packed and sealed on the
integrator's computer, uploaded with a key bound to one run, staged on the
site, and turned into CRM records phase by phase on the bulk lane, with
field ownership (a field someone changed in the CRM is never silently
overwritten), identity resolution (a lead that Rotor converts stays one
contact), conflicts the owner settles, a reconciliation report and an id
map. Imports can be repeated as often as needed: weekly during the
parallel run, daily before the switch-over, a last delta at cutover.

Code: `netlify/lib/crm/modules/import/` (server), `crm-app/modules/import/`
(screens), `build/crm_import_pack.mjs`, `build/crm_import_upload.mjs`.
Record type: `import_run` (`ir_`). Tests: `tests/crm/import/`, with the
synthetic Rotor export generator `tests/crm/fixtures/rotor-synthetic.mjs`.

## The whole path, for the integrator

The real export lives only on the integrator's computer, outside every
worktree of this repository (`~/barta-private/`). Nothing in it, sealed or
not, ever goes into git.

1. **Export** (Claude, through the Rotor connector): one JSONL file per
   entity (`members.jsonl`, `customers.jsonl`, `leads.jsonl`,
   `quote_contacts.jsonl`, `messages.jsonl`, ...; the list is in
   `catalog.mjs` `ENTITIES` and design §10.1), customers exported last.
   The media fetch script (not repo code) saves message attachments and
   quote photos in `<export>/media/` with `media/index.jsonl`
   (`{url_sha256, source, ref_id, name, content_type, bytes, file}`).
   The giveaway and referral stores (row 36) go in as
   `giveaway_entrants.jsonl` and `referrals.jsonl` when they are exported
   too; without them those two steps say "nothing to import".
2. **Pack**:
   ```bash
   node build/crm_import_pack.mjs ~/barta-private/rotor-export ~/barta-private/import-pack --as-of 2026-11-10
   ```
   Checks every `*.jsonl` parses (one JSON object a line), drops repeated
   rows by `id` (the last copy wins; Rotor's paging repeats rows), splits
   each entity into chunks of at most ~2.9 MB of JSON, seals each with the
   office public key (`build/office-dashboard-public.pem`, X25519 +
   AES-256-GCM: only the site's `OFFICE_DATA_KEY` opens them; every sealed
   chunk stays under the site's 4.5 MB upload limit), copies the media
   files of 4 MB or less (bigger ones are skipped and counted) and writes
   `manifest.json` (entity names, row counts, chunk names, the SHA-256 of
   each sealed chunk, the export date: no personal data) and `media.json`
   (checksum, source, Rotor ref id, size). It **refuses (exit 2) an export
   or output folder inside any worktree** (`git worktree list --porcelain`,
   symlinks followed), refuses to overwrite an earlier pack without
   `--force`, writes files readable by their owner only, and prints counts
   only. `--print` counts and writes nothing. With `OFFICE_DATA_KEY` in the
   environment it also proves every chunk opens.
3. **Make the run**: an owner opens **More → Import from Rotor → Start an
   import** and copies the upload key (shown once, `bimp_...`, good for 24
   hours, only for this run) or the whole command the sheet shows.
4. **Upload**:
   ```bash
   CRM_UPLOAD_KEY=bimp_... node build/crm_import_upload.mjs ~/barta-private/import-pack --site https://www.bartawindowwashing.com
   ```
   It asks the site what the run has, sends the manifest, each chunk the
   site doesn't have yet (PUT with `X-Content-SHA256`; three tries on a
   network error, a 429 or a 5xx), each media file the site doesn't hold
   yet (from any earlier run), then starts the run. Run it again after an
   interruption: it picks up where it stopped. `--no-start` uploads only
   (the owner then checks the team map and taps Start). The key comes from
   the environment, never an argument, and is never printed; the site
   address may be the production site or `http://localhost:PORT` only.
5. **Watch and settle**: the Import screen shows the upload, the team map,
   each step, then the report. Conflicts are settled on the Conflicts
   screen. The report and the id map download as CSV.

A small pack can also go up from a phone: on the run's screen, "Upload a
small pack from this phone" takes `manifest.json` and the `.sealed.json`
files (media only go up with the script).

## What the office sees

- **Import from Rotor** (More, and Settings; owners: `import:run`): every
  import with its export date and state (Waiting for the upload,
  Importing, Done, Done · N to settle, Stopped, Cancelled) and Start an
  import. One import runs at a time.
- **An import**: the upload (chunks and media received, the key's last
  four characters and when it runs out, New upload key), the **team map**
  (each Rotor member and the CRM user it becomes; a dropdown changes one
  before the start; "New user (invited)" makes a new login nobody can use
  until an owner sends its invite link), Start the import, the steps as
  they run (refreshed every 4 s while it runs; leaving the screen is
  fine), Resume when the lane gave up, Cancel. Once done, the **report**:
  added / updated / unchanged / linked / to settle / skipped, what waits
  for a part of the CRM that isn't built yet (rows per part), Rotor's own
  money totals (invoices by count and total, payments, refunds, tips: to
  compare with Rotor's reports), data quality (phones with 12 digits,
  states repaired from the ZIP, ...), and the downloads.
- **Conflicts**: a field changed both in the CRM and in Rotor since the
  last import: the value at the last import, the CRM's and Rotor's, and
  "Keep the CRM's" or "Take Rotor's". Everything else on the record has
  already taken Rotor's new values.

## Field ownership (§10.7)

A type's `rotorFields` are the fields the import owns; everything else on
a record is the CRM's. Each import write stores `record.import =
{ run_id, at, hash, source }` (the hash of the mapped rotorFields as
canonical JSON; `source` is the Rotor row, like `customers:<id>`) and the
mapped values in `ib/{type}/{id}` (the import base). Per mapped row:

| The record | What happens |
|---|---|
| not there | created (`onlyIfNew`) |
| untouched (its rotorFields still hash to `import.hash`), Rotor sent the same | **nothing is written** |
| untouched, Rotor changed | Rotor's values go into those fields only (CAS) |
| edited | three-way, field by field, against the base: CRM = base → Rotor's value; Rotor = base → the CRM's; equal → nothing; both changed → a **conflict** (the CRM's value stays; the base keeps its old value for that field, so it comes back next run until it is settled) |
| made in the CRM, matched by identity (an intake contact; no `import`) | **linked**: only its empty fields are filled, its values kept, no conflicts, then `import` and the base are set |
| its base came from another Rotor row (a lead Rotor converted to a customer) | **relinked**: three-way, but where both changed the CRM's value is kept quietly (the conversion itself is not an edit) |
| a placeholder (`flags.placeholder`, row 9) | the real row overwrites it in place and clears the flag; an edited placeholder conflicts like any record |

Two kinds of fields never conflict: `rotor` (the import's own bag of Rotor
ids and raw values: Rotor's changed values win, lists named `*_ids` are
unions, so a converted customer keeps its lead id), and lists of plain
values such as tags (merged as sets: Rotor's additions and removals apply,
the CRM's own additions stay). Fields outside rotorFields that a mapped
record carries are filled only where the record has nothing. A record
missing from a newer export is never deleted.

Settling a conflict: "Take Rotor's" writes Rotor's value as the owner (a
person's write, audited); "Keep the CRM's" changes nothing on the record.
Either way the base takes Rotor's value, so the field stays quiet until
Rotor changes it again.

Writes run as the import (`origin: "import"`, exempt from the parallel-run
guard), with `bulk` (no index rows: the run rebuilds every index and
relation family it touched at the end) and without per-record audit events
(one `phase_done` summary event per phase on the run).

## Identity (§10.3)

Every row resolves through `ptr/rotor/{type}/{rotorId}` first (map()'s
`ctx.lookup(type, rotorId)`, following merges for contacts), then the
module's own rules (contacts: a converted customer finds its lead by the
quote row's `converted_from_lead_id` or by "Converted from lead on" plus
the same phone or email; a lead finds a dual-write contact marked
`intake_pending_rotor`), else `idForRotor(type, rotorId)`, a pure function
of the type and the Rotor id (no timestamps). A dual-write lead, a weekly
import, the conversion in Rotor and the next import leave exactly one
contact with its website note, calls, enrollment and both Rotor ids.

## The runner (§10.1 steps 5-7)

`runner.mjs`: a lane run of kind `import` on the bulk lane steps one
import run. The plan is every registered phase (`importPhases` of every
module), ordered by `after`, plus the phases the design expects from
modules not built yet (`catalog.mjs` `EXPECTED_PHASES`): those, and any
phase whose `after` names one of them, **wait** ("Waits for Sales"; the
report counts the staged rows waiting for each part). The plan is fixed
when the run starts; the next run picks up a module that shipped since.

Per row: `normalize()` (a `RowError` skips the row with its field),
`map(row, ctx)`, then records with field ownership, then pointers (unique
ones claimed `onlyIfNew`, lookup lists through `updatePointerList`), then
the extras (patches, stats parts, suppressions, merge candidates:
contacts' `applyExtras()`). The cursor (`imp/{runId}/state`: phase, chunk,
row, counts) is saved every 5 seconds (or 50 rows), at the end of each step
(steps stop 25 s before the 2-minute chunk budget), and before a storage
error is passed on, so a resumed run starts at the row that failed: a
finished phase or row is never done again. A storage error after some
rows ends the step quietly; with none it is thrown and the lane backs off
(1, 4, 9 ... minutes; after 8 tries the lane gives up and the screen
offers Resume, which starts a fresh lane run at the saved cursor). A bad
row (a mapper bug, a value the type refuses, a taken pointer) is skipped
with a code, never the run. A function killed between checkpoints redoes
at most those rows, which changes nothing twice.

ctx for `map()`: `{ runId, idForRotor, lookup, users (Map of Rotor user id
→ CRM user id), settings.get(name), report.warn(code), cache, phase }`.

Finish steps: rebuild the indexes and verify the relation families of the
types written, write the id map in parts, write the report, mark the run
done.

## Phases this module owns (§10.2 rows 1-3)

| Phase | Entity | What |
|---|---|---|
| `system.users` | `members` | each Rotor member → a CRM user: the owner's choice on the screen, an earlier mapping (`ptr/rotor/user/{rid}`), the same full name, a first name only one user has; only a member with no match becomes a new user (`invited`, no password, role owner/admin/member → owner/admin/tech, login from the first name). Rotor's facts go in `user.rotor` (the type's only rotorField); a matched user's role, password and settings are never changed |
| `system.availability` | `member_availability` | weekly slots fill an empty `availability`; `is_technician` only on a user the import created |
| `system.rates` | `rate_settings` | hourly cents per category and commission percent (→ basis points) fill a rate that is still 0; one rate row or a `{hourly_rates, commission_rates}` row |

Row 2 (roles) is the role mapping; row 3's time off waits for Scheduling
(`work.time_off`) and crew ids stay on the visits Scheduling imports.
Contacts' phases (rows 6-12, 36) are in docs/CRM-CONTACTS.md; M6's
messages phase lists `contacts.suppressions` in its `after`.

## Endpoints

| Route | Who | What |
|---|---|---|
| `POST /import/runs` | `import:run` | `{ manifest?, note? }` → `{ run, upload_key }` (the key once) |
| `GET /import/runs` · `/import/runs/:id` | `import:run` | the runs; one run with its upload, phases, team map, lane |
| `POST /import/runs/:id/key` | `import:run` | a fresh upload key (the old one stops working) |
| `GET /import/upload` | the upload key | `{ run_id, status, manifest, received, missing }` |
| `PUT /import/runs/:id/manifest` | key or owner | the pack's `manifest.json` |
| `PUT /import/runs/:id/chunks/:name` | key or owner | one sealed chunk (≤ 4.5 MB, `X-Content-SHA256`), after the manifest; it must match the manifest's checksum and row count → `{ entity, rows, invalid }` |
| `PUT /import/runs/:id/media/:urlSha256` | key or owner | raw bytes ≤ 4 MB, `X-Media-Ref: <source>:<rotor id>` → `{ file_id }` |
| `POST /import/runs/:id/media-check` | key or owner | `{ hashes }` → `{ have }` |
| `POST /import/runs/:id/user-map` | `import:run` | `{ map: { rotorUserId: crmUserId \| null } }` |
| `POST /import/runs/:id/start` | key or owner | every chunk the manifest lists must be there |
| `POST /import/runs/:id/resume` · `/cancel` | `import:run` | |
| `GET /import/runs/:id/report` · `/report.csv` · `/idmap.csv` | `import:run` | the id map download is audited (`idmap_download`) |
| `GET /import/runs/:id/conflicts` | `import:run` | `?status=open&after=` |
| `POST /import/conflicts/:key/resolve` | `import:run` | `{ take: "rotor" \| "crm" }` |

The upload key is not an API key: it is `bimp_` + 32 base62 characters,
stored only as its SHA-256 (on the run and as `ptr/import-key/{sha256}`),
checked by the upload routes themselves (`auth: "hook"`), useless on any
other route, for any other run, or after 24 hours. On the same routes an
owner's session works with the usual CSRF checks (the phone upload).

Staging: `imp/{runId}/raw/{entity}/{nnnn}` (the opened rows; a row no
phase takes is counted, kept and skipped later with its field),
`imp/{runId}/media/{urlSha256}`, `imp/{runId}/state`,
`imp/{runId}/conflicts/{type}--{id}--{field}`, `imp/{runId}/report`,
`imp/{runId}/idmap/{nnnn}`, and `ib/{type}/{id}`. Media bytes go to
`crm-files` as `f/{idForRotor("file", url_sha256)}` with a `file` record
owned by the run (kind `import_media`; the type comes from the magic
bytes; anything outside JPEG/PNG/WebP/PDF is download-only). The site
never fetches a media URL.

## Settings

None.

## Sweeps, queue kinds and listeners

- `import.staging_gc` (bulk, daily 04:40, maintenance): the staged rows of
  a run that finished more than 30 days ago are deleted (the run, its
  report, conflicts and id map stay).
- Run kind `import` (bulk lane).
- Today: "Import conflicts to settle" (owners).

## Automations

None.

## Tests

`tests/crm/import/`: `ownership.test.mjs` (the three-way rules; a stats or
listener update between runs gives zero conflicts and no write; a human
edit to one field gives exactly one conflict while the others take
Rotor's values; settling sticks; a linked intake contact keeps its
values), `identity.test.mjs` (dual-write lead → conversion → one contact
with all its history; placeholders; ids need no `created_at`),
`week.test.mjs` (a simulated week of every sweep, then the same export:
0 conflicts, rotorFields byte-identical, nothing mirrored created),
`upload.test.mjs` (keys for one run only, 24 hours, upload routes only;
pack refuses a path in any worktree; media uploaded, never fetched; pack →
upload → run end to end with a throwaway key pair), `runner.test.mjs`
(the gate: repeated passes, no row or finished phase done twice; a crash
mid-phase; waiting phases; money sums; the audited id map; cancel and
resume), `users.test.mjs`, `screens.test.mjs`.

The gate at full size: `CRM_IMPORT_FULL=1 node --test --test-name-pattern
"the gate" tests/crm/import/runner.test.mjs` (14,268 synthetic rows, about
25 bulk passes, under 15 s in memory). The generator alone:
`node tests/crm/fixtures/rotor-synthetic.mjs <out-dir> --scale 1 --media`
(the folder must be empty; keep it outside the repo).

## Data rules

Synthetic fixtures only (made-up names, `555` numbers, `example.com`
emails). Logs carry counts and codes, never a name, phone, email, address
or amount tied to a person; the report and the manifest hold counts only;
the pack and upload scripts print counts only and refuse any path inside a
worktree. Real exports, packs and media stay in `~/barta-private/`.
