# CRM module: import

Milestone: M2c (design §10.1-10.8, §10.10, §11.4); M8 adds the cutover.
The Rotor import framework: a Rotor export is packed and sealed on the
integrator's computer, uploaded with a key bound to one run, staged on the
site, and turned into CRM records phase by phase on the bulk lane, with
field ownership (a field someone changed in the CRM is never silently
overwritten), identity resolution (a lead that Rotor converts stays one
contact), conflicts the owner settles, a reconciliation report and an id
map. Imports can be repeated as often as needed: weekly during the
parallel run, daily before the switch-over, a last delta at cutover. What
an export holds for a part of the CRM that isn't built yet waits on the
site and comes in by itself when that part goes live, without a new
upload ("Bringing in the rest" below).

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
   symlinks followed), refuses an output folder, `chunks/` or `media/` that
   is a symbolic link (each is checked before anything is written), refuses
   to overwrite an earlier pack without
   `--force`, writes files readable by their owner only, and prints counts
   only. `--print` counts and writes nothing. With `OFFICE_DATA_KEY` in the
   environment it also proves every chunk opens.
3. **Make the run**: an owner opens **Menu → Customers → Import from Rotor → Start an
   import** and copies the upload key (shown once, `bimp_...`, good for 24
   hours, only for this run) and the command the sheet shows.
4. **Upload**:
   ```bash
   node build/crm_import_upload.mjs ~/barta-private/import-pack --site https://www.bartawindowwashing.com
   ```
   It asks for the upload key at a prompt that doesn't echo it (so it
   never lands in the shell history); `--key-file FILE` reads it from a
   file outside every worktree instead, and `CRM_UPLOAD_KEY` in the
   environment still works. It asks the site what the run has, sends the
   manifest, each chunk the site doesn't have yet (PUT with
   `X-Content-SHA256`; three tries on a network error, a 429 or a 5xx) and
   each media file the site doesn't hold yet (from any earlier run). Run it
   again after an interruption: it picks up where it stopped. It does
   **not** start the run: the owner checks the team map on the Import
   screen and taps Start the import (`--start` starts it from the script
   instead). The key is never printed; the site address may be the
   production site or `http://localhost:PORT` only.
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
  until an owner sends its invite link; the map shown is fixed when the
  run starts and is exactly what the run applies), Start the import, the steps as
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
- **The rest of this export** (on the list and on the latest finished
  import): what of that export can be brought in now because a part of
  the CRM went live since ("Ready to bring in", rows per part, **Bring in
  the rest now**), what still waits and for which part, and until when the
  export's rows are kept. An import that brings in the rest says which
  import it continues, lists only its own steps, and has no upload and no
  team map. If the rows are gone it says so: "This export's rows were
  cleared. Start a new import to bring in the rest."
- **Settings, Data** (owners): "Bring in the rest of the Rotor export by
  itself as each part of the CRM goes live" (on unless turned off).

## Field ownership (§10.7)

A type's `rotorFields` are the fields the import owns; everything else on
a record is the CRM's. One record may be written by several Rotor rows,
its **sources** (`customers:<id>`, `leads:<id>`, `opportunities:<id>`: the
phase's entity and the row's id): a lead Rotor converted to a customer,
two Rotor customers the owner merged into one contact, Sales' deal that
both the lead and its opportunities describe. So the import base is kept
**per source**:

```
ib/{type}/{id}  = { v: 2, primary, sources: { [source]: { fields, hash, rank, run_id, at } } }
record.import   = { run_id, at, source: primary, hash, src: { [source]: hash } }
```

A row's source is `<entity>:<row id>`; a second phase of the same entity
adds `~<phase name>` (Sales' `sales.lead_follow_ups` after
`contacts.leads`), so two phases never share one base. A record that
`map()` folds from many rows (it reads the record and returns its whole
new state: a cadence from its board and stages, a deal or an enrollment
from all of a contact's opportunities) names its source itself
(`{ type, data, source: "fold" }` → `opportunities:fold`; a name with `:`
is taken as it is, so two phases can fold one record: `pipelines:board`),
so those rows share one base: with a base per row, each would hold the
record as that row first saw it, an unchanged export would rewrite it, and
of two rows of equal rank the first would keep its status.

`fields` are what that source last wrote (its mapped rotorFields), `hash`
names that version and `record.import.src` repeats it; `record.import.hash`
is the hash of the record's rotorFields as the import left them. Per
mapped row (source S, Rotor's values N, the record C, S's base B):

| The record | What happens |
|---|---|
| not there | created (`onlyIfNew`) |
| S sent exactly what B holds | **nothing is written**, whatever other sources or people did |
| per field S maps | N = B → the record keeps its value; C = N → nothing; C empty → filled; C = B → Rotor's value; C = another source's base value → that source holds the field: S takes it only when it **ranks** higher, else it stays quietly; otherwise C is a person's value: a **conflict** when S changed the field since B (the CRM's value stays; B keeps its old value for that field, so it comes back next run until it is settled) |
| S never wrote this record (an intake contact matched by identity, a merged duplicate, a new facet) | **linked**: only empty fields are filled, the record's values kept quietly, then S's base is set |
| a placeholder (`flags.placeholder`, row 9) | the real row takes over the placeholder's base and clears the flag; a placeholder row (rank 0) never overrides anything; an edited placeholder conflicts like any record |
| no base at all (backups skip `ib/`, so every record after a restore) | the primary source trusts the record when its rotorFields still hash to `import.hash` (nobody edited it: Rotor's changes apply); otherwise every field that differs from Rotor's is a conflict, never a quiet keep |

Ranks (by the source's entity, the part before `:`): customers and
opportunities 3, leads 2, any other entity 1, a placeholder row 0; a phase
may set `rank` itself. So a lead row still in
`leads.jsonl` after Rotor converted it (the export ran while the owner
converted it) never turns its customer back into a lead, and a contact the
owner kept after merging two Rotor customers keeps its own values (the
merged-away row's source is recorded and stays quiet).

Two kinds of fields never conflict: `rotor` (the import's own bag of Rotor
ids and raw values: S's changed values win where the bag still holds S's
old value, nothing, or a lower-ranked source's; lists named `*_ids` are
unions, so a converted customer keeps its lead id; a key S stops sending
goes only if it still holds S's value, never another source's), and lists
of plain values such as tags (merged as sets: S's additions and removals
apply, everyone else's additions stay). Fields outside rotorFields that a
mapped record carries are filled only where the record has nothing. A
record missing from a newer export is never deleted.

Crash safety: before a record write that moves S's base, the new base is
written into `ib/` as `sources[S].pending`; then the record (whose
`import.src[S]` names the new hash); then the base proper. A crash between
the record write and the base write leaves a pending base the record
names, and the next run takes it as the base (a pending base the record
doesn't name never happened). A base the record names but `ib/` lacks is
rebuilt from the record when nobody edited it since, else it conflicts
where it differs.

Settling a conflict: "Take Rotor's" writes Rotor's value as the owner (a
person's write, audited); "Keep the CRM's" changes nothing on the record.
Either way the conflicting source's base takes Rotor's value, so the field
stays quiet until Rotor changes it again.

Writes run as the import (`origin: "import"`, exempt from the parallel-run
guard), with `bulk` (no index rows: the run rebuilds the indexes and
relation families of the types it really created or changed records of; an
unchanged run rebuilds none) and without per-record audit events (one
`phase_done` summary event per phase on the run). A run that stops before
its finish steps (cancelled, or given up by the lane) queues a `reindex`
run for the indexes of the types it wrote, so its records are listed
anyway.

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
→ CRM user id), settings.get(name), report.warn(code), cache, phase,
prepared }`. A phase may have `prepare(rows, ctx)`: it runs once, before
the phase's first row, over all the phase's staged rows, and its answer is
saved with the run's state (`ctx.prepared`, the same after a resume);
`system.users` uses it to fix the team map at the start. A phase may set
`rank` (see Field ownership).

Finish steps: rebuild the indexes and verify the relation families of the
types written, write the id map in parts, write the report, mark the run
done.

## Bringing in the rest (continuations)

A run leaves the phases of modules that aren't built yet **waiting**, and
its staged rows stay. When such a module ships, nobody uploads anything
again: a **continuation** is a new import run that reuses the staged rows
of the latest finished run and runs only what is still open
(`continue.mjs`).

- **What it is.** An `import_run` with `continues` (the latest finished
  run: the first upload, or the continuation before it), `staging_run`
  (the run whose `imp/{id}/raw/` holds the rows; a continuation has no
  upload, no key, no manifest of its own), the same `as_of`, and `auto`
  when the hourly check started it. Its id is derived from the run it
  continues, so two callers at the same moment make one run.
- **What it runs.** Today's whole plan (`phasePlan()`), with every phase
  the chain already finished marked done (`earlier: <run>`): those are
  never read again, and they count as done for the `after` lists. So it
  runs exactly the phases that waited and are registered now, plus the
  phases that come after them; what still isn't registered keeps waiting
  for the next continuation. The state starts from the continued run's
  (`imp/{id}/state`): the same chunk list, row counts and team map
  (`ctx.users`). Everything else is an ordinary run: pointers
  (`ctx.lookup`) and import bases are the ones the earlier runs made, so a
  later phase can patch or link records an earlier run created (an
  invoice finds its contact and job and adds itself to the job; a message
  finds its contact); writes, field ownership, conflicts
  (`imp/{continuation}/conflicts/`), checkpoints, Resume and Cancel work
  the same; one import at a time still holds (no new upload starts while
  it runs, and it doesn't start while another run does).
- **Sources stay the same.** A row's source comes from the whole plan
  (the first phase of an entity owns `<entity>:<id>`, a later one adds
  `~<phase>`), so a continuation and a later full run give a phase the
  same source and the same import base: a fresh full import after any
  number of continuations finds everything as it is and writes nothing.
  A phase added later for an entity another phase already reads must come
  after it (name it in `after`); `continue.test.mjs` pins the owner of
  every entity already imported.
- **The report** of a continuation counts what that run did
  (`summary.phases_run`), names the run it continues (`continues`) and
  carries the chain (`chain.runs`, `chain.totals`: every run since the
  upload, summed). Phases done earlier are listed with `earlier`. Rotor's
  money and the integrity counts come from the staged rows, which are the
  same rows: they are taken from the continued run's report, so nothing
  staged is read twice.
- **Never an older export.** The base is the latest finished run, and it
  is checked by the hourly check and by the button alike: when any import
  that isn't of the same upload was started after that upload's import
  (finished, cancelled or stopped: it may have brought newer values in
  before it ended), or names a later export date, nothing more of the older
  export is brought in ("A newer import was started after that export's
  ..."; the card says so and offers no button). A new import brings the
  rest in.
- **By itself.** The sweep `import.continue` (bulk lane, hourly) starts a
  continuation when the setting is on, the CRM isn't paused, no import is
  queued or running, no new upload is under way (an uploading run whose
  newest key still works), the base isn't an older export, the latest
  finished run has open phases that can run now with rows staged for them,
  and those rows are still there. If the setting can't be read it starts
  nothing that hour: "on" is never assumed. It is cheap when there is
  nothing to do: the runs' index, the setting and the latest run's record
  (four reads). A finished run keeps `waiting` and `phases_sig` (the
  registered phases of its plan), and the check stamps `checked_sig` on it
  once it has looked at its state and found nothing to bring in for the
  phases registered today. It tells the owners when it starts and when it
  is done, in records made ("Timesheets and visit timers from your Rotor
  export of Nov 10 are in: 85 timesheets, 197 timers."; rows that made
  nothing are mentioned only when there are some): counts only, in the
  app, push by each owner's choice (a note may come twice after a crash,
  never not at all: the run is stamped `noted_at` once it went out). A
  continuation an owner cancelled, or one that stopped, is not started
  again by itself (`auto_off_at` on the run it continued; the button still
  works). "Import conflicts to settle" (Home) counts the latest finished
  import's conflicts and those of the imports it continues.
- **On demand.** `POST /import/continue` ("Bring in the rest now") does
  the same, whatever the setting says. It answers 409 with a plain message
  when there is nothing to go on from: "Nothing new to bring in yet. The
  rest of the export waits for parts of the CRM that aren't built.",
  "That export's rows were cleared. Start a new import.", "A newer import
  was started after that export's ...", "An import is already running.
  Wait for it to finish first.", or that the CRM is paused.
- **A run that stops for good** (any import, not only a continuation):
  when the lane gives up after its 8 tries the import run is marked
  `failed` with `stopped: { code, at }` and a `finished_at` (it no longer
  says "running" for ever, no longer blocks new imports, and its staged
  rows are cleaned up like any run's); the owners get "Rotor import
  stopped", Settings, Data shows an alert (`import:{id}`) until it is
  resumed, cancelled or done, and the screen offers Resume. The hourly
  check and the nightly clean-up also catch a run whose lane run ended
  failed or cancelled without the run being told, and queue a lane run for
  one that never got one (after 10 minutes).
- **Staged rows that are gone.** A chunk the run's state lists that reads
  as missing FAILS the run at once (`stopped.code: "staging_gone"`, "that
  export's rows were cleared", no Resume): a phase is never recorded done
  with nothing read, so the next import still brings it in.
- **How long the rows are kept.** 30 days from their last use: making and
  finishing a continuation stamps `staging_used_at` on the run that holds
  them. `import.staging_gc` leaves rows a queued or running continuation
  reads (for at most 30 days from when it was made), stamps the run
  `staging_cleared_at` BEFORE it deletes, and re-reads the runs index
  before each run's deletes; a continuation stamps its use on the same
  record before it is made and refuses when it finds the cleared stamp,
  so the two can't cross. A continuation needs every staged chunk of the
  phases it would run; one missing chunk is "cleared".
- **Older code.** A continuation is stepped by a lane run of its own kind
  (`import.continue`): code from before this feature (a rollback, an old
  instance still warm after the deploy) doesn't know the kind and leaves
  it alone; it would have stepped it as an upload with no rows and marked
  it done with nothing. Should older code step one anyway (Resume during a
  rollback), this code never takes it as a base: a "done" continuation
  without `phases_sig` is retired (cancelled, `old_version`) and the run
  it continued is the base again; a state older code began (no
  `staging_run`) is started over.
- **For module authors.** A phase that waits needs nothing special: when
  its module registers it, the next hourly check brings its rows in. Don't
  switch a part of a mapper's output on whether another module exists (a
  finished phase is not run again by a continuation): put that part in a
  phase of its own that names the other module's phase in `after`. Give a
  record every value it should have (a default taken from the clock is
  another value on every run: the lead's deal names its `opened_at`).

## Phases this module owns (§10.2 rows 1-3)

| Phase | Entity | What |
|---|---|---|
| `system.users` | `members` | each Rotor member → a CRM user, computed once when the phase starts (exactly the map the screen showed): the owner's choice on the screen (a user, or "new"), an earlier mapping (`ptr/rotor/user/{rid}`), the same full name, a first name only one user has, never a CRM user another member already took; only a member with no match (or the owner's "new") becomes a new user (`invited`, no password, role owner/admin/member → owner/admin/tech, login from the first name). Rotor's facts go in `user.rotor` (the type's only rotorField); a matched user's role, password and settings are never changed. Rotor ids made of dots only are refused |
| `system.availability` | `member_availability` | weekly slots fill an empty `availability`; `is_technician` only on a user the import created |
| `system.rates` | `rate_settings` | hourly cents per category and commission percent (→ basis points) fill a rate that is still 0; one rate row or a `{hourly_rates, commission_rates}` row |

Row 2 (roles) is the role mapping; row 3's time off waits for Scheduling
(`work.time_off`) and crew ids stay on the visits Scheduling imports.
Contacts' phases (rows 6-12, 36) are in docs/CRM-CONTACTS.md. Messages,
campaigns, message templates and pin types (rows 16, 32, 33, 35) are in
docs/CRM-COMMS.md with the measured cost of the full message import; they
run after `contacts.suppressions`.

## Endpoints

| Route | Who | What |
|---|---|---|
| `POST /import/runs` | `import:run` | `{ manifest?, note? }` → `{ run, upload_key }` (the key once) |
| `GET /import/runs` · `/import/runs/:id` | `import:run` | the runs; one run with its upload, phases, team map, lane |
| `POST /import/runs/:id/key` | `import:run` | a fresh upload key (the old one stops working) |
| `GET /import/upload` | the upload key | `{ run_id, status, as_of, manifest, received, missing }` while uploading; `{ run_id, status, as_of }` after |
| `PUT /import/runs/:id/manifest` | key or owner | the pack's `manifest.json` |
| `PUT /import/runs/:id/chunks/:name` | key or owner | one sealed chunk (≤ 4.5 MB, `X-Content-SHA256`), after the manifest; it must match the manifest's checksum and row count → `{ entity, rows, invalid }` |
| `PUT /import/runs/:id/media/:urlSha256` | key or owner | raw bytes ≤ 4 MB, `X-Media-Ref: <source>:<rotor id>` → `{ file_id }`; only while uploading |
| `POST /import/runs/:id/media-check` | key or owner | `{ hashes }` → `{ have }`; only while uploading |
| `POST /import/runs/:id/user-map` | `import:run` | `{ map: { rotorUserId: crmUserId \| "new" \| null } }` (null: back to the proposal); only while uploading |
| `POST /import/runs/:id/start` | key or owner | every chunk the manifest lists must be there |
| `POST /import/runs/:id/resume` · `/cancel` | `import:run` | |
| `GET /import/rest` | `import:run` | the latest finished run: `{ run, ready, waiting, staging: "ok" \| "cleared", keep_until, active, auto }` (`ready` / `waiting`: `{ phase, label, module_label, entity, rows }`) |
| `POST /import/continue` | `import:run` | "bring in the rest now": a continuation of the latest finished run → `{ run, phases }` (201; 409 with a plain message when there is nothing to go on from) |
| `GET /import/runs/:id/report` · `/report.csv` · `/idmap.csv` | `import:run` | the id map download is audited (`idmap_download`) |
| `GET /import/runs/:id/conflicts` | `import:run` | `?status=open&after=` |
| `POST /import/conflicts/:key/resolve` | `import:run` | `{ take: "rotor" \| "crm" }` |

The upload key is not an API key: it is `bimp_` + 32 base62 characters,
stored only as its SHA-256 (on the run and as `ptr/import-key/{sha256}`),
checked by the upload routes themselves (`auth: "hook"`), useless on any
other route, for any other run, or after 24 hours, and it takes nothing
once its run has left "uploading" (chunks, manifest and media are refused;
`GET /import/upload` then says only the status). On the same routes an
owner's session works with the usual CSRF checks (the phone upload).
Store keys never hold a `.` or `..` segment (`crm-store` refuses them:
the Blobs client puts the key in the request path, where such a segment
would be folded into another key).

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

`import` (`cfg/import`, owners: `settings:owner`): `{ auto_continue }`,
true unless an owner turns it off in Settings, Data: whether the rest of
an export is brought in by itself as each part of the CRM goes live.

## Sweeps, queue kinds and listeners

- `import.staging_gc` (bulk, daily 04:40, maintenance): the staged rows of
  a run are deleted 30 days after their last use (when it finished or
  stopped, or when a continuation last used them), not while a
  continuation made in the last 30 days that reads them is queued or
  running (the run, its report, conflicts and id map stay); a run still
  waiting for its upload a week after its key ran out is cancelled
  ("abandoned") and its staged rows deleted; a run whose lane run ended
  without it knowing is marked stopped.
- Run kinds `import` and `import.continue` (bulk lane).
- `import.continue` (bulk, hourly; not while paused; `mutates: true`: it
  starts a run that writes): starts a continuation when a part of the CRM
  went live since the latest finished import, and marks stuck runs stopped
  (see "Bringing in the rest").
- After a stopped or cancelled run: a `reindex` run for what it wrote.
- Today: "Import conflicts to settle" (owners).

## Automations

None.

## Tests

`tests/crm/import/`: `ownership.test.mjs` (the per-source rules; a stats
or listener update between runs gives zero conflicts and no write; a human
edit to one field gives exactly one conflict while the others take
Rotor's values; settling sticks; a linked intake contact keeps its
values), `sources.test.mjs` (a lead converted during the export stays the
customer; merged Rotor customers stay quiet; two phases writing one record
merge per field by rank; a crash between the record write and the base
write; no base after a restore; an unchanged run rebuilds no index),
`hardening.test.mjs` (the team map is the screen's; a key takes nothing
after the start; abandoned uploads; dot-only ids and keys; a cancelled or
given-up run's records are listed; symlinked pack folders; the scan flags
pack media), `identity.test.mjs` (dual-write lead → conversion → one contact
with all its history; placeholders; ids need no `created_at`),
`week.test.mjs` (a simulated week of every sweep, then the same export:
0 conflicts, rotorFields byte-identical, nothing mirrored created),
`upload.test.mjs` (keys for one run only, 24 hours, upload routes only;
pack refuses a path in any worktree, the upload script a key file in one;
the key asked at a prompt; no start without `--start`; media uploaded,
never fetched; pack → upload → run end to end with a throwaway key pair), `runner.test.mjs`
(the gate: repeated passes, no row or finished phase done twice; a crash
mid-phase; waiting phases; money sums; the audited id map; cancel and
resume), `continue.test.mjs` (the rest of an export comes in as each part
goes live: first the tech app's real timesheet and timer phases, hidden
from the first run's plan with `runner.__hidePhasesForTests` as before
their deploy, then Money, then Messages as fixtures: each time one
continuation runs only the phases that waited and are registered now,
nothing staged is read twice, timesheets find the first run's team map
and timers its visits, invoices land on its contacts and jobs, the
report's chain, the owners' notes, and a fresh full import days later
writes nothing; the rows cleared; kept 30 days from the last use; the
hourly check starts exactly one; the setting; paused; a crash mid-way and
Resume; the pinned source owners), `continue-guards.test.mjs` (never an
older export after a newer import was started; the setting unreadable; a
run the lane gives up on is marked stopped, told, alerted, cleaned up and
resumable; a missing staged chunk fails the run; the clean-up and the
button can't cross; the lane run kind and a continuation older code
stepped; four reads in an idle hour), `users.test.mjs`,
`screens.test.mjs`.

The gate at full size: `CRM_IMPORT_FULL=1 node --test --test-name-pattern
"the gate" tests/crm/import/runner.test.mjs` (14,268 synthetic rows, about
25 bulk passes, under 15 s in memory; by default the gate runs scale 0.1).
The generator alone: `node tests/crm/fixtures/rotor-synthetic.mjs <out-dir>
--scale 1 --media` (the folder must be empty; keep it outside the repo).
At scale 1 it matches the real export's size: about 40 MB, of which
messages are about 34 MB (10,927 rows; outbound emails are whole HTML
documents of 12-16 KB, like Rotor's).

## Data rules

Synthetic fixtures only (made-up names, `555` numbers, `example.com`
emails). Logs carry counts and codes, never a name, phone, email, address
or amount tied to a person; the report and the manifest hold counts only;
the pack and upload scripts print counts only and refuse any path inside a
worktree. Real exports, packs and media stay in `~/barta-private/`. The
no-data scan also flags, outside `assets/`, a file named like a pack's
media (64 hex characters) and a photo or PDF hidden under another name.
