# CRM module: plans

Milestone: M3b (design §5.4, §8.1, §9.2 plan screens, §10.2 rows 17, 19-21
and 25, §11.4 "M3b Plans"; decisions D9, D10, D27, D29, D30). Service plans
(biannual, quarterly, monthly, Christmas lights every season, custom), the
plan state machine and its visits, agreement texts the owner approves, the
customer's agreement page with one signature, Christmas lights seasons
(install, takedown, the bin), the customer's account page and "text me a
link", the plan sweeps and automations, and the Rotor import of plans,
agreement templates and lights seasons.

Code: `netlify/lib/crm/modules/plans/` (server), `crm-app/modules/plans/`
(screens), `crm-app/portal/plans-agreement.js`, `account.js` (the hub; `plans-hub.js` is no longer loaded),
`plans-login.js` (the customer's page scripts).
Record types: `plan`, `agreement_template`, `agreement`, `season_install`.
Tests: `tests/crm/plans/` and `tests/crm/flows/quote-to-plan.test.mjs`
(`npm test`), the phone checks in `tests/e2e/plans.spec.mjs` (`npm run e2e`).

Money (M5) is not built: a plan records its billing mode and whether a
card on file is wanted (autopay), nothing more. No charge, no invoice, no
card check happens here; "card" as a reason a plan waits shows only once
the `money.cardStatus` service exists.

## What the office sees

- **Plans** (Menu → Work → Plans; `plans:read`, owners and the office): chips
  Active, Waiting (signature or card), Paused, Ending, Due this month,
  Clawbacks, Cancelled, Ended, with counts; a search by name or plan. Each
  row: the customer, the plan, the next visit's month, autopay.
- **A contact's Plans tab**: that contact's plans, agreements waiting to be
  signed, and **New plan**.
- **New plan** (`plans:write`): for a customer who signs up without a
  quote. The plan from the catalog (its visits a year and plan discount
  fill in), the price of a visit (quarterly: exterior on visits 1, 3, 4 and
  interior on visit 2, inside glass only, each with the plan discount), the
  start, the term, autopay. The plan waits for
  its agreement; its first term's jobs are made at once. A retry never
  makes two (client id).
- **A plan**: status, the customer, why it waits; the visits by term, each
  with its job (**Book** opens the job, **Skip** takes the visit off and
  cancels its job; a skip is never a credit); the agreement (**Send to
  sign** by text and/or email, **Sign on this phone** for one 15-minute
  in-person signature, **Read it**); the terms (term dates, renewal, price
  lock, billing, autopay, perks, this term's value). The buttons follow the
  status: Activate anyway (with how they agreed: paper, phone), Pause
  (from, back on, why: booked visits from that day come off and the
  customer gets a text), Resume, Change price (from the first renewal on or
  after a date at least 30 days out and after the price lock), Renew, Cancel
  (the calculator first: when it ends, why then, the visits still
  happening, the first-visit discount that comes back; an admin adds a
  note), Keep the plan, and for a clawback Billed or Waived (waiving needs
  `fees:waive` and a reason). A lights plan shows its seasons and, for a
  season after the first, **They said yes to {year}**: the next install is
  made only then. A plan that automation couldn't move on (Rotor still owns
  the customer, see the guard below) says so, to be done by hand.
- **Plan visits to book** (`#/plans/due`): the visits due by this month or
  next that have nothing booked, grouped by town so a day in one town
  fills up; tap one to book its job.
- **Lights season** (Menu → Work → Lights season): the season's houses by status
  (sold, install booked, installed, takedown booked, taken down, stored),
  feet of lights, houses that need a bin, and **Waiting for a yes**: last
  season's plan customers whose season isn't confirmed yet. A row's sheet
  opens the install or takedown job, saves the feet, adds a $0 warranty
  visit and, once the lights are taken down, the bin (taken down + bin =
  stored, and the property remembers the bin; no bin before that).
- **Home** ("Needs you", docs/CRM.md): plan visits to book, agreements not
  signed, agreement texts to approve (owners), clawbacks to bill, from the
  module's attention and approvals rows (the Today card is `home: false`).
- **Settings → Plans catalog & perks** (owners): each plan's visits a
  year, plan discount a visit, renewal months, billing, autopay default and
  perks; the cancel notice days and the late-cancel fee; the lights rebook
  and install-by dates; and **Request signatures for N plans** (imported
  plans have no signature on file: one bulk text, tested and confirmed
  under Approvals first; each agreement counts as sent only once the run
  sent that person's text).
- **Settings → Agreement templates**: the six texts (Biannual, Quarterly,
  Monthly, Custom, Christmas lights, one-time) with their state. An owner
  edits a text (variable chips, a preview with a made-up customer) and
  approves it; any change is a new version that needs approving again.
  Lines starting ">> Owner check:" mark wording nobody has confirmed; a
  text can't be approved while one is left. The owner's answers of Nov 12
  settled all but one (the legal name, the $50 late cancel fee, what each
  perk covers, the Monthly payback, lights' 3-year seasons and early exit):
  only the lights text still has one (how the crew hangs the lights). A
  text the owner had edited keeps the owner's words and shows **New
  suggested wording** beside them (Use it puts it in the box to read and
  save, Keep mine puts it away; the list marks it "New wording"). Nothing
  is sent, or shown on a quote, from a text that isn't approved.

Technicians see none of this (`plans:*` is office only). Their visits come
from the jobs a plan makes, like any other job.

## What the customer sees

- **/p/agreement/{id}** (from a texted or emailed link): the agreement,
  their name, an optional finger signature (required on nothing; a typed
  name and the box are the signature), "I agree", Sign. The text's hash is
  checked: if the office changed it while the page was open, the page
  reloads instead of signing something they didn't read. After signing:
  the signed copy, printable.
- **/p/sign/{token}** (Sign on this phone): the same page for an in-person
  signature on the tech's or the office's phone; one use, 15 minutes.
- **/p/hub** (their account; `netlify/lib/crm/portal/account.mjs`, with
  `account-render.mjs` and `crm-app/portal/account.js`, registered here):
  the next visit (date, arrival window, service, who; "On the way" while the
  tech drives; "Need to move it?"), invoices to pay (each opens through a
  fresh one-day link that the hub session takes on, so going back to the
  account still works; the invoice page has Pay and the receipts), agreements
  to sign, open quotes (the same kind of link), their plans, and "What do you
  need?": Request work, Upcoming visits, History, Your plan, Your info.
- **/p/visits**: every visit coming up (the next three months), each with
  its arrival window, service and who, and "Need to move it?".
- **/p/history** (`?before=yyyy-mm` pages back six months at a time): past
  visits, newest first, with the before and after photos the tech marked
  for the customer (an issue photo stays with the office; photos show only
  once the visit is done, through `GET /api/portal/hub/files/:file`, which
  answers 404 for any other file), then invoices and receipts (Pay or
  Receipt) and the free re-clean promise.
- **/p/plan**: each plan's name and status, the next visit, visits a year,
  the price a visit, the term, what's included (each line and which visits
  it covers) and the perks in the agreement's words (Quarterly and Monthly);
  the rules: free moves with 24 hours' notice, the $50 late fee inside them
  (cfg/work `late_cancel_hours`, cfg/plans_catalog `late_cancel_fee_cents`),
  the notice to change or end a plan, the free re-clean.
- **/p/request** (Request work): services to tick, which place (by its
  label, never the address), when, a note and up to 3 photos (shrunk on the
  phone to 1600 px). It becomes a task for the office ("Work request: Gutter
  cleaning, Screen cleaning", kind follow-up, due now, assigned to the
  owners and admins, `source: "portal"`, the photos on it as files of the
  task) and a bell for the office; the task screen shows the photos.
- **/p/visits/{id}/reschedule**: 24 hours or more before the arrival window
  opens, a day or two that work and a note; it becomes a task ("Reschedule
  request: Fri, Nov 20", linked to the visit and job) and the visit stays
  where it is until the office moves it. Inside 24 hours (or once the tech
  is on the way): the $50 late fee in plain words and Call us / Text us,
  no form (the API answers 409 `late`).
- **/p/account** (Your info): the name, the mobile and email masked, the
  text and email switches (visit texts `sms_service`, deals by text
  `sms_marketing`, deals by email `email_marketing`; saved at once with
  source `portal`, `consent.changed` for sales and comms), and "Update your
  info": a new name, number or email becomes a task. Nothing on the contact
  changes by itself, so a forwarded link can never take over the account's
  number.
- Every account page and API answers for the hub session's contact only
  (anyone else's visit, invoice, photo or place is a 404), needs a hub link
  (a document link's cookie gets 401), shows no address, and stays inside
  the portal's 30 storage calls (a request with photos gets 90). Requests,
  reschedules and info updates: at most 5 a day per customer (a keyed
  bucket, `thr/preq/`), a double tap (the same client id) lands once.
- **/p/login** ("Text me a link"): their mobile number; if it is on file
  they get a text with a link to their account. The answer is the same
  whether or not the number is on file, and so is the work behind it: the
  request only counts the try and queues the number's keyed hash; who has
  that number is looked up on the fast lane. At most 3 a day (rolling) and
  one every 10 minutes per number and per person, 20 an hour per network
  address (a salted key, a rolling hour).

All of it is dry-run while messaging is: texts and emails land in the
Outbox.

## Endpoints

Staff API under `/api/crm` (session; permission in brackets):

| Method and path | What |
| --- | --- |
| GET /plans `?status=active\|pending\|paused\|cancelling\|cancelled\|expired\|due\|clawback\|all&catalog=&contact=` [plans:read] | rows and counts |
| POST /plans {contact_id, catalog_key, lines, discounts, start_on, term_months, autopay, client_id} [plans:write] | a staff plan (a run) |
| GET /plans/catalog [plans:read] | the catalog and lights settings with defaults |
| GET /plans/due `?month=YYYY-MM` [plans:read] | visits to book, by town |
| POST /plans/request-signatures {plan_ids} [agreements:send] | a run that ends in one bulk run |
| GET /plans/:id [plans:read] | plan, ordinals with their jobs, contact, agreements, seasons, readiness |
| PATCH /plans/:id If-Match [plans:write] | name, property, autopay, auto_renew; clawback billed / waived (+reason, fees:waive) |
| POST /plans/:id/activate {override_reason?} [plans:write] | a run |
| POST /plans/:id/pause {from, until?, reason?} · /resume · /skip {term, n} · /renew [plans:write] | runs |
| POST /plans/:id/cancel {reason, note?} · /withdraw [plans:cancel] | runs (admins add a note) |
| POST /plans/:id/confirm-season {season} [plans:write] | a lights customer said yes: that season's install and takedown are made (a run) |
| POST /plans/:id/change-price {effective_on, new_lines} [plans:write] | 30 days' notice, not inside the lock |
| GET /plans/:id/cancel-quote `?requested_on=` [plans:read] | the calculator |
| POST /plans/:id/send-agreement {channels} [agreements:send] | make (or reuse) and send |
| GET /agreement-templates · GET /agreement-templates/:id · POST /agreement-templates/preview [plans:read] | texts |
| POST /agreement-templates · PATCH /agreement-templates/:id If-Match · POST /agreement-templates/:id/approve [agreement_templates:edit, owners] | edit and approve |
| GET /agreements `?plan=&contact=&status=` · GET /agreements/:id [plans:read] | agreements |
| POST /agreements {plan_id} · /agreements/:id/send · /void · /present [agreements:send] | make, send, void, present link |
| GET /lights/seasons/:season [plans:read] | the board, with to_confirm |
| PATCH /lights/installs/:id {bin_id?, footage_ft?, colors?, notes?} · POST /lights/installs/:id/warranty [plans:write] | season edits |

Portal (`/p/*` pages, `/api/portal/*` POSTs with `X-CRM-Portal`): GET
/p/agreement/:id and POST /api/portal/agreements/:id/sign (scope
agreement); GET /p/hub, /p/visits, /p/history, /p/plan, /p/request,
/p/visits/:id/reschedule, /p/account, /api/portal/hub/files/:file, GET
/p/hub/agreements/:id, POST /api/portal/hub/agreements/:id/sign, POST
/api/portal/hub/open {kind: quote | invoice, id}, POST /api/portal/requests
{client_id, services, timing, notes, property_id?, photos?},
/api/portal/visits/:id/reschedule-request {client_id, dates, note?},
/api/portal/preferences {channel, on}, /api/portal/contact-info
{client_id, name?, phone?, email?, note?} (scope hub);
GET /p/login and POST /api/portal/login (public: no session, rate limited);
GET /p/sign/:token and POST /api/portal/sign/:token/sign (present). The view
beacon is kind `agreement`.

Services: `plans.agreementForOption(quote, version, option)` (the approved
text for a plan option, rendered, with its hash; null when the text isn't
approved) and `plans.fromQuoteOption(quote, version, option, opId, {
signature }, ctx)` (inside the quote's convert op: the plan, the signed
agreement when the customer signed the same text, the first term's jobs,
then active or pending; a retry makes nothing twice). Needs
`work.createJobs`, `work.cancelJobs`, `bulk.create`, `notify.users`, and
later `money.cardStatus`; each is checked with `has()` first.

MCP tools: list_plans, get_plan, list_plan_visits_due, preview_plan_cancel
(read); skip_plan_visit, pause_plan, cancel_plan, send_agreement (write,
through the same runs).

## Plan rules

- States: pending → active ⇄ paused → cancelling → cancelled; active →
  expired at the end of a term without auto-renew; expired → active on
  Renew. A pending plan waits for its signature (and, with Money, a card);
  Activate with a reason skips that.
- Visits ("ordinals") are numbered per term. The first term has
  `visits_per_year × initial_months / 12` of them; a renewal term
  `visits_per_year × renews_every_months / 12`. Lines and discounts carry a
  scope: all, initial (visit 1 of the first term only), after_initial, or
  specific visits (by their place in the year). A lights plan's lines,
  Early Bird and 3-year discount cover every season, so seasons 2 and 3 of
  a 3-year plan cost what season 1 costs (the owner, Nov 12; lights plans
  made earlier keep the first-season scopes they were sold with). Add-ons
  (screens, tracks, gutters) sold with a plan cover its first visit only:
  later visits get them when the customer asks. Quarterly visit 2 is the
  interior visit (inside glass only) and gets the plan discount like the
  others.
- Each visit gets its job (kind `standard`; lights `lights_install` and
  `lights_takedown`, warranty `lights_warranty`) through `work.createJobs`
  with scope "plans"; booking a visit re-spaces the later unbooked ones;
  the job's status keeps the visit's (booked, done, cancelled). A batch of
  jobs is noted on the plan (`jobs_pending`) before it is made, so a retry
  finishes that batch instead of making a second one; a job whose visit no
  longer needs one by then is cancelled, and `plans.ordinal_sync` adopts or
  cancels any stray job carrying the plan's id.
- Christmas lights: a season after the first is made (install, takedown,
  record) only once the customer said yes to it (the September rebook
  text) and the office marked it (`confirm-season`; `confirmed_seasons` on
  the plan). The text says so.
- Pause: booked visits from that day come off; unbooked ones move by the
  paused months when it resumes. Skip: one visit off, no credit.
- Cancel: inside the first term with the notice days (7 by default), else
  at the end of the renewal term. Cancelled inside the first term after
  visit 1 was done: the plan discount visit 1 actually got comes back (the
  clawback: a quote's plan discount or a staff plan's, never a first-visit
  offer, Early Bird or the 3-year discount; the calculator, the cancel and
  the agreement text all use the same figure) as a draft "to bill" for an
  owner's OK, billed or waived. A 3-year lights contract cancelled inside
  its first 36 months adds the storage fee ($400, `policy.storage_fee_cents`,
  from the catalog when the plan is made; a contract without one uses
  $400) the same way (`cancel.storage_fee_cents`; the plan screen says
  "Storage fee for leaving the contract early"). The $50 late cancel or
  reschedule fee (less than 24 hours' notice, or no access and no notice;
  plans and one-time jobs alike) is only ever charged with an owner's OK,
  never when we move a visit.
- Price change: not inside the price lock (the first term), at least 30
  days out, from the next renewal; the customer gets a notice with it.
- Rotor owns imported plans until the switch: listeners and sweeps acting
  on them write would-rows instead (the parallel-run guard). Staff can
  still change them on purpose. Jobs are the customer's records, so
  automation asks the guard about the customer before making one, even on
  a plan the CRM made: for a customer Rotor owns the backfill writes a
  would-create row and goes on with the next plan, and an automated resume
  or renewal that would need such jobs leaves the plan as it is
  (would-resume / would-renew), marks it `held` and tells the office once.
- The agreement states the plan's real terms (texts.mjs): each line and
  discount with its price and visits (an add-on the customer may pick on
  the quote is listed with its own price), the price ("$195.00 a visit
  (visit 2 of each year: $60.00)", or "first visit $145.00, then $245.00 a
  visit" when something is for the first visit only), how often, renewal,
  billing and autopay, and the clawback. The quote's approval page, the
  signed text and the jobs agree to the cent.

## Settings

- `cfg/plans_catalog` (owners): per plan (biannual, quarterly, monthly,
  lights_annual, custom) name, visits a year, frequency, plan discount a
  visit, clawback (for reference only: a plan's clawback is the discount
  its first visit got), initial and renewal months (Custom renews as often
  as it comes), billing (`barta_standard`,
  `after_visit`, `first_of_month`), autopay default, agreement template
  key, perks (touch-ups, rain guarantee days, hard water), interior visits;
  `notice_days` (7), `late_cancel_fee_cents` (5000),
  `lights_storage_fee_cents` (40000), `perk_names`, `rotor_template_ids`
  (from the import).
- What each perk covers (the owner, Nov 12; the agreement's
  `{{perks_details}}`, Quarterly and Monthly only): Unlimited Touch-Ups,
  any glass on the plan, any time between visits; 7-Day Rain Guarantee,
  weather spots on exterior glass within 7 days, a free touch-up; Free
  Hard Water Removal, a light spot treatment on up to 5 panes a visit,
  more is an add-on and deep or etched staining is quoted separately.
- `cfg/lights` (owners): `rebook_on` ("09-01"), `install_by` ("12-15"),
  `takedown_month` (1), `client_cap` (none).

## Sweeps, queue kinds and listeners

| Sweep | When | What |
| --- | --- | --- |
| plans.due | daily 06:00 | pauses that end, cancels that take effect, terms that end (renew or expire) |
| plans.jobs_backfill | hourly | jobs for visits that have none (once Scheduling is there) |
| plans.ordinal_sync | hourly | visits vs their jobs' status |
| lights.takedown_due | Jan 2, 06:00 | a takedown job for each installed season without one; the office hears how many to book |
| agreement.unsigned | daily 10:00 | the reminder automation below |
| plan.renewal_notice | daily 10:00 | the renewal and price-change notices below |
| lights.rebook | daily 08:40 | on `rebook_on`, the lights rebook bulk runs |
| plans.agreement_sends | hourly | agreements queued on a Request signatures bulk run: sent once the run sent that person's text, back to a draft if it didn't |

Runs: `plans.make` (a plan, its agreement, jobs, status), `plans.act`
(one action), `plans.request_signatures`. Queue kind `plans.login` (the
"text me a link" lookup and text, carrying only the number's keyed hash).
Listeners: `quote.converted`
(a one-time lights job gets its season and takedown), `job.scheduled`,
`job.completed`, `job.reopened`, `job.cancelled`, `visit.*` (the visits
follow their jobs; the season follows its jobs), `agreement.signed` (the
signature's follow-ups, then a pending plan activates), `card.saved`.
Emits `plan.activated`, `plan.paused`, `plan.cancelled`, `plan.renewed`,
`agreement.sent`, `agreement.signed`. Seeds: v1 the six drafts, v2 the
untouched first drafts upgraded to the current ones (a new version for the
owner to approve again), the Custom text, and the price-change text; v3
(the owner's answers of Nov 12) the same for every earlier seeded draft
(`PREVIOUS_DRAFT_SHAS`: Nov 10 and Nov 11), never approving anything; a
draft an owner edited keeps their text and gets `suggested_body_md`; a
saved Settings → Company page still holding "BARTA WINDOW WASHING LLC"
moves to "Barta Window Washing LLC" (`putSetting`, journaled), a legal name
someone typed stays. The owners get one notice (a marker: never twice)
naming what was left to them. Idempotent.

## Automations

| Key | Trigger | What |
| --- | --- | --- |
| agreement.sent | event agreement.sent | the link by text and/or email |
| agreement.unsigned | sweep, daily | a reminder a day for a sent, unsigned agreement, up to 7 |
| plan.renewal_notice | sweep, daily | for an auto-renewing plan, one notice in the 30 days before its term ends (a price change rides with it); more than 5 at once go as one bulk run |
| lights.rebook | sweep, on the rebook date | last season's lights customers: a rebook text (one bulk run) and a confirm text for 3-year customers (another); nothing goes until someone tests and confirms it, and no install is made until the customer says yes |

## Import phases

Against the M2c runner (`netlify/lib/crm/modules/plans/import-rotor.mjs`).
They read an export someone made; Rotor itself is never called.

- `plans.agreement_templates` (row 17): Rotor's templates by name onto the
  seeded drafts (their bodies stay the CRM's: Rotor exposes none; the CRM
  adds a sixth, Custom).
- `plans.plans` (rows 19, 20, 21; after contacts, quotes and jobs):
  recurring and lights plans become plans with their Rotor ids and
  numbers; a One-Time container with several jobs a hidden
  `one_time_series` plan; lines per visit (a client-optional line ticked:
  Rotor's prices count it), the five discount shapes (every `multi` entry,
  whatever `enabled` says), billing, autopay, auto-renew, status and
  dates; the term from the dates, else from a contract discount ("3-Year
  Contract": 36 months; Rotor's sale value of such a lights plan is three
  seasons); visits from the jobs in Rotor's visit order, by job number
  (the jobs get the plan and their visit number); each job, a one-time
  container's too, gets the plan's discounts for its place as a partial
  record (only the job's `discounts`, so a discount someone set on the job
  in the CRM stays: docs/CRM-IMPORT.md): the job's total is Rotor's due
  amount; the plan's own notes and monthly price in `rotor`; the quote by
  identical line ids. Imported plans say "imported_unknown" for the
  agreement (Rotor doesn't expose signatures): Settings → Plans can request
  them.
- `plans.lights` (row 25): each lights plan's season (the year of its
  install job, the status from that job, the feet from the per-foot
  lines) and, for this season's installs, a January takedown job (D9).

A second run of an unchanged export changes nothing.

## Owner actions

1. Read the six agreement texts (Settings → Agreement templates) and
   approve them. Only the lights text still has an "Owner check" (how the
   crew attaches the lights): keep, change or remove that wording, delete
   the check, then approve. A text you had edited shows the Nov 12 wording
   as a suggestion: use it or keep yours. Until a text is approved, plan
   options on quotes show no agreement and Send to sign is refused.
2. Check the catalog numbers and the lights dates (Settings → Plans
   catalog & perks).
3. When ready, Request signatures for the imported plans; test the bulk
   run on the test contact and confirm it under Approvals.
4. For each Christmas lights plan customer who says yes to a new season,
   mark it on the plan (or from Lights season, Waiting for a yes): only then
   are the install and takedown made.

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails); logs carry counts and codes, never a name, phone, email, address
or amount tied to a person. Agreement texts are Barta's voice: no em
dashes, "insured" (never "licensed"), the guarantee is a free re-clean.
