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
(screens), `crm-app/portal/plans-agreement.js`, `plans-hub.js`,
`plans-login.js` (the customer's page scripts).
Record types: `plan`, `agreement_template`, `agreement`, `season_install`.
Tests: `tests/crm/plans/` and `tests/crm/flows/quote-to-plan.test.mjs`
(`npm test`), the phone checks in `tests/e2e/plans.spec.mjs` (`npm run e2e`).

Money (M5) is not built: a plan records its billing mode and whether a
card on file is wanted (autopay), nothing more. No charge, no invoice, no
card check happens here; "card" as a reason a plan waits shows only once
the `money.cardStatus` service exists.

## What the office sees

- **Plans** (More → Plans; `plans:read`, owners and the office): chips
  Active, Waiting (signature or card), Paused, Ending, Due this month,
  Clawbacks, Cancelled, Ended, with counts; a search by name or plan. Each
  row: the customer, the plan, the next visit's month, autopay.
- **A contact's Plans tab**: that contact's plans, agreements waiting to be
  signed, and **New plan**.
- **New plan** (`plans:write`): for a customer who signs up without a
  quote. The plan from the catalog (its visits a year and plan discount
  fill in), the price of a visit (quarterly: exterior on visits 1, 3, 4 and
  interior on visit 2), the start, the term, autopay. The plan waits for
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
  `fees:waive` and a reason).
- **Plan visits to book** (`#/plans/due`): the visits due by this month or
  next that have nothing booked, grouped by town so a day in one town
  fills up; tap one to book its job.
- **Lights season** (More → Lights season): the season's houses by status
  (sold, install booked, installed, takedown booked, taken down, stored),
  feet of lights, houses that need a bin. A row's sheet opens the install
  or takedown job, saves the bin (taken down + bin = stored, and the
  property remembers the bin) and the feet, and adds a $0 warranty visit.
- **Today**: plan visits to book, agreements not signed, agreement texts
  to approve (owners), clawbacks to bill.
- **Settings → Plans catalog & perks** (owners): each plan's visits a
  year, plan discount a visit, early-cancel payback (clawback), renewal
  months, billing, autopay default and perks; the cancel notice days and
  the late-cancel fee; the lights rebook and install-by dates; and
  **Request signatures for N plans** (imported plans have no signature on
  file: one bulk text, tested and confirmed under Approvals first).
- **Settings → Agreement templates**: the five texts (Biannual, Quarterly,
  Monthly, Christmas lights, one-time lights) with their state. An owner
  edits a text (variable chips, a preview with a made-up customer) and
  approves it; any change is a new version that needs approving again.
  Nothing is sent, or shown on a quote, from a text that isn't approved.

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
- **/p/hub** (their account): the next visit, agreements to sign, open
  quotes (each opens through a fresh one-day link), their plans.
- **/p/login** ("Text me a link"): their mobile number; if it is on file
  they get a text with a link to their account. The answer is the same
  whether or not the number is on file. At most 3 a day per number, one
  every 10 minutes, 20 an hour per network address.

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
| POST /plans/:id/change-price {effective_on, new_lines} [plans:write] | 30 days' notice, not inside the lock |
| GET /plans/:id/cancel-quote `?requested_on=` [plans:read] | the calculator |
| POST /plans/:id/send-agreement {channels} [agreements:send] | make (or reuse) and send |
| GET /agreement-templates · GET /agreement-templates/:id · POST /agreement-templates/preview [plans:read] | texts |
| POST /agreement-templates · PATCH /agreement-templates/:id If-Match · POST /agreement-templates/:id/approve [agreement_templates:edit, owners] | edit and approve |
| GET /agreements `?plan=&contact=&status=` · GET /agreements/:id [plans:read] | agreements |
| POST /agreements {plan_id} · /agreements/:id/send · /void · /present [agreements:send] | make, send, void, present link |
| GET /lights/seasons/:season [plans:read] | the board |
| PATCH /lights/installs/:id {bin_id?, footage_ft?, colors?, notes?} · POST /lights/installs/:id/warranty [plans:write] | season edits |

Portal (`/p/*` pages, `/api/portal/*` POSTs with `X-CRM-Portal`): GET
/p/agreement/:id and POST /api/portal/agreements/:id/sign (scope
agreement); GET /p/hub, GET /p/hub/agreements/:id, POST
/api/portal/hub/agreements/:id/sign, POST /api/portal/hub/open (scope hub);
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
  specific visits (by their place in the year). Early Bird, the 3-year
  discount and the lights materials are initial: renewals never bring them
  back. Quarterly add-ons go on the exterior visits 1, 3, 4.
- Each visit gets its job (kind `standard`; lights `lights_install` and
  `lights_takedown`, warranty `lights_warranty`) through `work.createJobs`
  with scope "plans"; booking a visit re-spaces the later unbooked ones;
  the job's status keeps the visit's (booked, done, cancelled).
- Pause: booked visits from that day come off; unbooked ones move by the
  paused months when it resumes. Skip: one visit off, no credit.
- Cancel: inside the first term with the notice days (7 by default), else
  at the end of the renewal term. Cancelled inside the first year after
  visit 1 was done: the first-visit discount comes back (the plan's
  clawback) as a draft "to bill" for an owner's OK, billed or waived. The
  late-cancel fee is only ever charged with an owner's OK, never when we
  move a visit.
- Price change: not inside the price lock (the first term), at least 30
  days out, from the next renewal; the customer gets a notice with it.
- Rotor owns imported plans until the switch: listeners and sweeps acting
  on them write would-rows instead (the parallel-run guard). Staff can
  still change them on purpose.

## Settings

- `cfg/plans_catalog` (owners): per plan (biannual, quarterly, monthly,
  lights_annual, custom) name, visits a year, frequency, plan discount a
  visit, clawback, initial and renewal months, billing (`barta_standard`,
  `after_visit`, `first_of_month`), autopay default, agreement template
  key, perks (touch-ups, rain guarantee days, hard water), interior visits;
  `notice_days` (7), `late_cancel_fee_cents` (5000), `perk_names`,
  `rotor_template_ids` (from the import).
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

Runs: `plans.make` (a plan, its agreement, jobs, status), `plans.act`
(one action), `plans.request_signatures`. Listeners: `quote.converted`
(a one-time lights job gets its season and takedown), `job.scheduled`,
`job.completed`, `job.reopened`, `job.cancelled`, `visit.*` (the visits
follow their jobs; the season follows its jobs), `agreement.signed` (the
signature's follow-ups, then a pending plan activates), `card.saved`,
`portal.login_requested` (the "text me a link" text: a hub link, sent from
the fast lane because a portal request has a small storage budget).
Emits `plan.activated`, `plan.paused`, `plan.cancelled`, `plan.renewed`,
`agreement.sent`, `agreement.signed`, `portal.login_requested` (the
contact's id only).

## Automations

| Key | Trigger | What |
| --- | --- | --- |
| agreement.sent | event agreement.sent | the link by text and/or email |
| agreement.unsigned | sweep, daily | a reminder a day for a sent, unsigned agreement, up to 7 |
| plan.renewal_notice | sweep, daily | for an auto-renewing plan, one notice in the 30 days before its term ends (a price change rides with it); more than 5 at once go as one bulk run |
| lights.rebook | sweep, on the rebook date | last season's lights customers: a rebook text (one bulk run) and a confirm text for 3-year customers (another); nothing goes until someone tests and confirms it |

## Import phases

Against the M2c runner (`netlify/lib/crm/modules/plans/import-rotor.mjs`).
They read an export someone made; Rotor itself is never called.

- `plans.agreement_templates` (row 17): Rotor's templates by name onto the
  seeded drafts (their bodies stay the CRM's: Rotor exposes none).
- `plans.plans` (rows 19, 20, 21; after contacts, quotes and jobs):
  recurring and lights plans become plans with their Rotor ids and
  numbers; a One-Time container with several jobs a hidden
  `one_time_series` plan; lines per visit, the five discount shapes,
  billing, autopay, auto-renew, status and dates; visits from the jobs in
  order (the jobs get the plan and their visit number); the quote by
  identical line ids. Imported plans say "imported_unknown" for the
  agreement (Rotor doesn't expose signatures): Settings → Plans can request
  them.
- `plans.lights` (row 25): each lights plan's season (the year of its
  install job, the status from that job, the feet from the per-foot
  lines) and, for this season's installs, a January takedown job (D9).

A second run of an unchanged export changes nothing.

## Owner actions

1. Read and approve the five agreement texts (Settings → Agreement
   templates). Until then, plan options on quotes show no agreement and
   Send to sign is refused.
2. Check the catalog numbers and the lights dates (Settings → Plans
   catalog & perks).
3. When ready, Request signatures for the imported plans; test the bulk
   run on the test contact and confirm it under Approvals.

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails); logs carry counts and codes, never a name, phone, email, address
or amount tied to a person. Agreement texts are Barta's voice: no em
dashes, "insured" (never "licensed"), the guarantee is a free re-clean.
