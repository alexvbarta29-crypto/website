# CRM module: sales

Milestone: M2b (design §5.2, §5.7.4 `lead.*`, §7.6, §9.2, §10.2 rows 13-15,
§11.4; decisions D7, D8, D12, D20-D22, D25). Deals, follow-up cadences and
the leads in them (enrollments), calls, tasks and incidents; and Signs &
flyers (QR codes on yard signs, door hangers and flyers, their scans and
leads).

Code: `netlify/lib/crm/modules/sales/` (server),
`crm-app/modules/sales/` (screens), `netlify/functions/playbook.mjs` (the
office's Follow-ups page, see below), `netlify/functions/crm-q.mjs` (the
signs' `/q/` codes). Record types: `deal`, `cadence`, `enrollment`,
`task`, `qr_code`. Tests: `tests/crm/sales/`.

## What the office sees

- **Pipeline** (Menu → Pipeline, or the Sales tab's first screen for
  someone who pins Sales; Nov 2026, after Rotor's, in the app's two
  themes): a round search button on top (the field opens in place); a pipeline is one of the follow-up cadences (Rotor's imported
  pipelines, like Referrals, are board-only cadences) and its stages are
  the cadence's steps or board stages. A dropdown picks the pipeline; a
  list / board toggle (coral when on). List: a card per open follow-up
  with the name, the status (Open, a filled blue pill; Paused), the type
  (Lead, Customer), the stage on its own line, VALUE (the open deal) and
  DUE, and round Call, Text and a black (white in the dark)
  convert (⇄: start a quote, book a job, make them a customer). Board: a
  column per stage ("New 57 · $0"; "No opportunities" when empty)
  scrolling sideways, cards with a blue edge, the name, Open, the type and
  the amount. **Move on** (a card's button, or dragging it to the next
  column on a desk) marks its step done by hand (`POST
  /enrollments/:id/advance`), as the follow-up screen does; one stage at a
  time; a board-only pipeline's stages stay as Rotor had them. From `GET
  /cadences`, `GET /cadences/:id`, `GET /enrollments?cadence=`, `GET
  /deals` and the contacts index (no new route).
- **Leads** (Menu → Leads, `#/leads`, Rotor's; no Pipeline · Leads ·
  Calls · Quotes · Tasks switch on top): every lead as a two-tone card:
  the name, a priority pill (their open task's priority, when one has it;
  Medium a filled orange), a stage pill (the follow-up's step, else the
  deal's status, else New), a band with PV (the open deal's potential
  value) and FOLLOW UP (the next due day, or "-"), round Call, Text and
  convert. Round search and filter buttons on top (All, With a follow-up,
  New, Paused). Code:
  `crm-app/modules/sales/{pipeline,leads}.js`; tests:
  `tests/crm/sales/leads-pipeline.test.mjs`.
- **Calls** (the Sales switch's Calls, Menu → Sales → Calls; was "Leads & calls"; `sales:work`): today's calls in the day's windows
  (9-10, 12-1, 4-5), overdue first, then texts waiting to be sent by hand,
  paused follow-ups and leads that need attention. Each row: name, town,
  step ("Day 1 · Call 2 of 3"), when it's due. **Call** opens `tel:` and
  remembers the call; coming back to the app asks **How did it go?**
  (No answer · Left a voicemail · Talked · Booked · Not interested ·
  Wrong number, a note, "double dial").
- **No answer on a call-then-text step**: the step's text, filled in for
  this lead. While texts are dry-run (until Phase 1 cutover) the CRM sends
  nothing: the sheet shows **Copy text** and **Open in Messages** (an
  `sms:` link with the text) and asks **Did you send it?** "Yes" logs the
  step as sent by hand (`sent_by_hand`) and moves on; "Not yet" leaves it
  waiting on the list. Hand-sent texts carry no "Reply STOP" line (D5: the
  sender adds it to texts the CRM sends). Only a text the app prepared (a
  call logged with no answer) can be marked sent (409 otherwise). Outside
  the sender's hours for follow-up texts (08:00-20:00, D12) the sheet says
  it's too late to text, shows when it can go (the list says "Text waits
  until 8:00 AM") and offers **Remind me at 8:00 AM** (a task), not Copy or
  Messages; "I sent it" is refused until then.
- **Estimate follow-up steps are read before sending** (D21): no answer
  opens the compose sheet with the text to adjust; nothing goes out until a
  person sends it (and while dry-run, that "send" is again Copy / Messages
  / Did you send it?).
- **One follow-up** (`#/enrollments/:id`): the steps with what happened at
  each, Pause / Resume / Stop / Skip this step / Next step, the deal.
- **A deal** (`#/deals/:id`): services, value, status (by hand: logged,
  `status_set_by_hand`), Lost with a reason, its follow-ups.
- **Tasks** (nav): open tasks, mine first; New task (office); one task with
  Done. Technicians see their own tasks only, without the contact unless
  it's on one of their visits, and can only move a task's status;
  **Report an incident** (techs too) makes a high-priority task for the
  owners.
- **A contact's Sales tab**: deals, follow-ups, tasks, and Start a
  follow-up.
- **Home** (the office's first screen, docs/CRM.md): "Needs you" rows for
  leads that need a call (`sales.attention`, lights the tab's dot), calls
  due now (`sales.calls_due`) and tasks for you (`sales.tasks_mine`), both
  `badge: false`. The Today card (calls due, overdue, attention, my tasks)
  stays for a tech's Today (`home: false`).
- **Signs & flyers** (Menu → Sales; `signs:manage`): QR codes for yard
  signs, door hangers and flyers, their scans, leads, bookings and money.
  See "Signs & flyers" below.
- **Settings → Cadences** (`cadences:configure`): each cadence (name, on
  or off, which sources join, tags that keep a lead out, what a reply does,
  what happens when a call window passes with no call, its steps: day,
  window, action, text, read before sending, offer, archive the quote) and
  the sales settings. The texts' words live in Templates.

## Signs & flyers (QR codes)

Flyra's "QR code tracking for signs and flyers": a QR code for each yard
sign, door hanger, flyer, the truck or a business card, what each scan
brought in, and leads that say where they came from.

**The screen** (Menu → Sales → **Signs & flyers**, `#/signs`;
`signs:manage`, the module's own permission: owners and the office by
default, never a technician; an owner can take it from the office in
Settings → Team permissions):

- The list: every code in use with its **scans, leads, booked and paid**,
  the totals on top, the last scan; Retired codes under their own chip.
- **New** (`#/signs/new`): a name ("Yard sign, Maple Grove", only the
  office sees it), what it goes on (yard sign, door hanger, flyer, truck,
  business card, something else), the town or area and the day it went up
  (optional), and where it sends people: **the quote page** (the default)
  or another page of the website (`/services/gutter-cleaning.html`,
  `/landing/...`, `/`; never the CRM, the office, the portal or another
  site).
- **One code** (`#/signs/:id`): the QR code (level Q, for print that lives
  outdoors), its short address (`bartawindowwashing.com/q/abcd2345`), where
  it sends people, **Print it** at two sizes, an 18 × 24 in yard sign and a
  quarter-page flyer (4.25 × 5.5 in), each as a picture (PNG, shared on a
  phone) or an SVG for the print shop, with the code's name and short
  address under it; the scans of the last 30 days, by kind of phone; the
  leads (each opens the contact) with Booked and what they paid; Edit;
  Retire (off the list; the code keeps working and counting, a sign may
  still be out there).

**The short path** `/q/{8 characters}` (`netlify/functions/crm-q.mjs`,
`sales/signs-scan.mjs`, Netlify's rate limit in front): 8 characters a
person can read and type (no 0/o, 1/l/i; about 40 bits, so codes can't be
guessed), case doesn't matter, claimed by a pointer so two codes never
share one, and never changed by an edit. A scan:

- counts (a daily count for 120 days, first and last scan, iPhone /
  Android / other) in `ptr/qr-stats/{id}` (compare-and-swap; backed up with
  `ptr/`), after the answer when the platform allows;
- answers 302 to the code's page with `?utm_source=qr&utm_medium={kind}&utm_campaign={code}`
  and sets `barta_q` (first party, HttpOnly, Secure, Lax, 30 days): which
  code and when, signed with the site's key salt;
- keeps nothing personal: no IP address, no browser string. The rate limit
  (30 counted scans a minute from one connection, then a "One moment" page
  with Retry-After) keys a day-salted hash of the address under `thr/qr/`,
  which the nightly sweep deletes after a day;
- HEAD and link previews (the portal's bot list) go on uncounted, with no
  cookie; an unknown or malformed code is a 404 page with a link to the
  quote page; before the CRM's setup, or with storage down, every scan
  still lands on the quote page (uncounted). A printed sign never breaks.

**Leads from a code** (attribution in the CRM only; `lead.mjs` and
everything Rotor gets stay byte for byte as they were): the quote form's
POST to `/api/lead` carries the cookie; `contacts/hook.mjs` reads it
(`withScan`, the quote form only) into the CRM's copy of the lead;
`intake.mjs` asks `sales.qrResolve` (a signed, recent cookie of a code
that's still there) and gives a new contact `source.campaign = "Yard sign:
Maple Grove"` (the kind and the area, else the code's name) and
`source.qr_code` (the code's id); `source.source` stays "Website quote
form", so the new-lead follow-up starts as always. Then `sales.qrLead`
counts the lead for the code (once per person). The label shows on the
contact ("Yard sign: Maple Grove (QR code) · Website quote form · heard
from Yard Sign"), on its deal (Source), on its follow-up and the call list
("From Yard sign: Maple Grove"). Booked (a visit ahead or done, or a
customer now) and paid (lifetime, practice money never counted) are worked
out when the screen asks, from the contacts index, so they include what
the CRM learns later (Money, the import). Only while Settings → Intake
mode sends website leads to the CRM ("Rotor and the CRM"); before that the
scans count and leads don't.

Routes (all `signs:manage`): `GET /qr-codes?archived=1` (the list with
numbers and totals), `POST /qr-codes` `{ name, kind, area?, placed_on?,
dest: { kind: "quote" | "page", path? }, note?, client_id }` (the same
request twice is one code), `GET /qr-codes/:id`, `PATCH /qr-codes/:id`
(If-Match), `POST /qr-codes/:id/archive` · `/restore`. Record type
`qr_code` (prefix `qr`, index `qr-codes`, pointer `qr-slug`). Services
`sales.qrResolve`, `sales.qrLead`. Screens `crm-app/modules/sales/signs.js`,
`sign.js`, `sign-form.js`, `signs-kit.js`. Tests:
`tests/crm/sales/signs.test.mjs` (the codes and who may, `/q`: counts,
404, rate limit, nothing personal, a sign that never breaks; a scan to a
lead end to end through `lead.mjs`; the cookie's checks; the screens),
`tests/e2e/signs.spec.mjs`.

## Cadences (seeded, `seed.mjs`)

| Key | Starts | Steps |
|---|---|---|
| `new_lead` "New lead - no estimate yet" | `lead.created` from Website quote form, Meta Ads, Referral, Phone Call, Email, Facebook Messenger, Inbound text, Other; not tagged `Giveaway - New Lead` | days 1-3 × 9-10 / 12-1 / 4-5, each call-then-text with texts `cad_new_1..9`; step 10 a task "Send estimate". Ends on quote sent (hands over), booked, opted out, won, lost. A reply pauses. Unattended: wait. |
| `estimate_followup` "Estimate sent - not scheduled" | the first `quote.sent` of a quote | day 1 9-10 `cad_est_1`, day 1 4-5 `cad_est_2`, day 2 `cad_est_3` + offer `followup_50`, day 3 `cad_est_4` + `ten_free_screens`, day 4 `cad_est_5` + archive the quote. Every step read before sending; text-anyway refused. |
| `giveaway`, `referrals` | (boards only) | Rotor's boards, kept for the import; `referrals` is off. |

Texts (`TEMPLATES`, category service): `lead_ack`, `cad_new_1..9`,
`cad_est_1..5` from the office Follow-ups page's wording (texts 5 and 8 per
D25: "fully insured", "we'll come back and re-clean it free of charge"),
and `staff_new_lead` (staff). None has an opt-out line; the core sender
adds it. Variables: `{{first_name|}}` (an empty fallback: with no first
name on file the text reads "Good morning! This is..." and "Hey, just
missed you", core's fill takes the space before an empty fill-in along),
`{{sender_first_name}}`, `{{review_count|150}}`, `{{review_link}}`.
Settings → Cadences shows texts 5 and 8 with one tap to put the
playbook's older words back (or the website's again), and a link to each in
Templates.

### When a step is due (`cadence.mjs`, pure)

- Open days: Monday-Saturday, not a holiday in `cfg/calendar` (Thanksgiving,
  Christmas by default). A lead after `day_cutoff` (17:00) or on a closed
  day starts on the next open day.
- Step 1 is due in the first window on day 1 that hasn't ended (a lead at
  08:55 Tuesday: 9-10 Tuesday; 17:30: 9-10 Wednesday; Saturday evening:
  Monday; the day before Thanksgiving at 17:30: Friday).
- A step keeps its own window on its own day when it can; a step pushed
  later (the previous one logged late) takes the next open window after the
  previous step's. Day N is counted in open days from day 1, and the days
  between steps stay: when day 1's last call slips into the next morning,
  day 2's calls start the open day after (a lead at 10:30 the day before
  Thanksgiving: Wednesday 12 and 4, Friday 9, then Saturday, then Monday).
- Steps have ids (`s1`, `s2`, ... assigned when a cadence is saved, never
  reused; `step_seq`). An enrollment keeps its current step's id
  (`step_id`; `step_n` is its position when planned), so inserting,
  removing or reordering steps never moves a lead onto another step's
  text. A removed step's id maps to the next step that survived
  (`moved`); a lead on it goes there (planned from now), or completes when
  nothing survived. `steps_v` counts changes to the steps: the
  `sales.cadence` sweep brings each open enrollment of a changed cadence up
  to date (its position, label and text; its time as planned). A client
  that sends steps without ids keeps the old ids by position; seed v2 gave
  ids to cadences stored before them.
- Changes to a cadence apply from each lead's next step; an edit to the
  current step's text applies to that step's text.
- Resuming plans the current step from now (from the later of its day and
  today), however long it was paused; an enrollment without a day 1 (as
  Rotor's come) gets today as day 1.
- A text never goes out in quiet hours (core sender: 08:00-20:00 for
  cadence texts).

## Enrollments (`enroll.mjs`)

One open (active or paused) enrollment per contact and cadence: the
pointer `ptr/enroll/{contact}--{cadence}` is claimed first, so two intakes
for one phone, a double submit or a retry make one follow-up (a second one
that slips through stops as `duplicate`). Each enrollment opens (or reuses)
the contact's open deal. History is capped at 60 entries.

Statuses: `active`, `paused` (reply, inbound call, talked, by hand),
`completed` (last step, booked), `stopped` (`replied`, `inbound_call`,
`booked`, `opted_out`, `won`, `lost`, `manual`, `expired`, `duplicate`,
`quote_sent`, `wrong_number`), `archived` (imported from Rotor).

Outcomes of a call (`POST /calls`, `calls.mjs`): no answer / voicemail →
the step's text (call-then-text) or the next step; talked → paused with a
follow-up task (the note on it); booked → completed (the deal is won when
the job or quote is approved); not interested → stopped, deal lost;
wrong number → stopped, the phone flagged `wrong_number` and not for texts;
`calling` → a provisional 30-minute hold (holds `lead.ack` off). An
inbound call pauses the follow-ups and is not an outbound touch.

## Deals (`deals.mjs`)

Derived from events, overridable by hand (logged): intake → `open`; first
quote sent → `quoted`; quote approved or converted, or a job done without
a quote → `won`; quote declined or archived by the estimate follow-up →
`lost` (`no_response`); open or quoted with nothing for `abandon_days`
(30) and no open follow-up → `abandoned` (a call or text to the contact
counts as activity, also one logged outside a follow-up). A won deal isn't lost by an
event (only by hand).

## Endpoints

| Route | Who | What |
|---|---|---|
| `GET /calls/list?date=` | `sales:work` | the call list (windows, overdue, waiting texts, paused, attention) |
| `GET /calls/summary` | `sales:work` | counts for Today |
| `POST /calls` | `sales:work` | `{ contact_id, enrollment_id?, direction, outcome, double_dial, note, client_id }`; emits `call.logged`; answers what's next (`hand` / `compose` sheet) |
| `POST /cadence-steps/:id/:n/sent-by-hand` | `sales:work` | `{ how: "copy" \| "sms_link" }`: the waiting text was sent by hand |
| `POST /cadence-steps/:id/:n/send` | `sales:work` | `{ body, hand? }`: a read-before-sending step (dry-run: logged as sent by hand) |
| `GET /attention` | `sales:work` | leads that need a call |
| `GET /deals?status=&contact=` · `GET /deals/:id` · `PATCH /deals/:id` (If-Match) · `POST /deals/:id/lose` | `sales:work` | |
| `GET /enrollments?status=&cadence=&contact=` · `POST /enrollments` `{ contact_id, cadence_key }` | `sales:work` | starting one by hand skips the entry rules; the open one comes back if there is one |
| `GET /enrollments/:id` | `sales:work` | with the step's text preview and the SMS mode |
| `POST /enrollments/:id/pause` · `resume` · `stop` · `advance` · `skip` | `sales:work` | |
| `POST /enrollments/bulk-resume` `{ ids }` | `sales:work` | up to 15 at once → `{ resumed, skipped, failed: [{ id, error }] }` (one that can't resume doesn't stop the rest) |
| `GET /cadences` · `GET /cadences/:id` | `sales:work` | |
| `POST /cadences` · `PATCH /cadences/:id` (If-Match) | `cadences:configure` | |
| `GET /tasks?assignee=me&kind=&status=&contact=` | the office | |
| `GET /tasks/mine` · `GET /tasks/:id` | `tasks:read` (techs: their own) | |
| `POST /tasks` · `PATCH /tasks/:id` · `POST /tasks/:id/done` | `tasks:write` (techs: status only) | |
| `POST /incidents` | `incidents:create` | a high-priority task for the owners |
| `GET /sales/contacts/:id` | `sales:work` | the contact's Sales tab |

Services: `sales.enroll(contact_id, cadence_key, { quote_id?, deal_id? },
ctx)`, `sales.stopAll(contact_id, reason, ctx)`, `sales.markDeal(deal_id,
status, opts, ctx)`. Optional needs from Quotes (M3a): `quotes.applyOffer`
and `quotes.archive` (until they exist, an offer or archive step is logged
as waiting: `offer_waits` / `archive_waits`). Emits `call.logged`.
Claude's tools (MCP): `sales_call_list`, `sales_lead` (read),
`sales_log_call` (write).

## Settings

`cfg/sales` (`cadences:configure`): `attention_hours` (24),
`paused_attention_days` (2), `expire_days` (14: a step this late ends its
follow-up), `abandon_days` (30), `day_cutoff` ("17:00"), `ack_delay_min`
(5), `calling_minutes` (30). The cadences themselves are records
(`rec/cadence/`), edited in Settings → Cadences.

## Sweeps and listeners

- `sales.cadence` (fast lane, every pass, mutates): enrollments of a
  cadence whose steps changed are brought up to date first; task steps make
  their task; a call step whose window passed runs its text only when the cadence
  says `text_anyway` and the step isn't read before sending; a step more
  than `expire_days` late ends the follow-up (`expired`); a follow-up
  without a plan gets one.
- `sales.attention` (hourly): leads untouched for `attention_hours`, paused
  longer than `paused_attention_days`, or with a missed window; one push per
  lead per day (`lead.attention`), at most 10 a pass; the Today count.
- `sales.deal_abandon` (daily 02:00, mutates, cursor): idle open deals →
  abandoned.
- Listeners (queue items, each with its own marker, re-reading what they
  act on): `lead.created` (join each active new-lead cadence: a backstop
  for the intake's own enrollment), `quote.sent` (deal quoted; the new-lead
  follow-up hands over to the estimate follow-up, once per quote),
  `quote.approved` / `quote.converted` (won), `quote.declined` (lost),
  `quote.changes_requested` (stop with a task), `quote.archived` (lost: no
  response), `job.completed` (won without a quote, ends the new-lead
  follow-up), `consent.changed` (STOP or texts revoked: stop every
  follow-up), `message.inbound` (STOP keywords stop; any other reply pauses
  or stops per the cadence, with one task), `call.logged` (an inbound call
  logged elsewhere pauses).

## Automations

| Key | When | What |
|---|---|---|
| `lead.ack` (service, not for imported contacts) | `lead.created` from the website form, a webhook, a referral or a claim | `lead_ack` after `delay` minutes (5) in business hours, else right away (quiet hours then hold it to 08:00); re-checked when due: a call in progress, any call or text since the lead came in, or an archived contact holds it off |
| `lead.alert` (staff) | `lead.created` | a notification to the owners (and the lead's owner): first name and town only, linked to the contact |
| `lead.attention` (staff) | the `sales.attention` sweep | "Lead needs a call", once per lead per day |

All of them send through the core sender: dry-run until cutover (the text
lands in the Outbox and nowhere else).

## Parallel run (before cutover)

Every automated path (listeners, sweeps, automations, task steps, and the
deal's last activity when a follow-up ends) asks the guard first: on a deal or follow-up the import brought in it changes nothing and
writes a `would-<action>` row (`would-mark_won`, `would-mark_abandoned`,
`would-enroll`, `would-text`, ...). What the CRM made itself (shadow
records) it changes. People's actions in the app are theirs.

## The Follow-ups page (`/playbook`)

`netlify/functions/playbook.mjs` keeps its built-in texts. Once the CRM is
set up (`CRM_PRODUCTION` in production, a store, and the seeded
templates), the page shows the CRM's current wording of `cad_new_1..9` and
`cad_est_1..5` (Templates), cached a minute, in the page's own fill-ins
(`{first}`, `{rep}`, `{co}` for the company's name, `{reviews}`,
`{link}`). A step keeps the built-in text when its template is missing,
switched off, or holds `<`, `>` or `&` (the page renders texts as HTML and
has no CSP, so markup never gets in). The page waits at most 1.3 s for the
store; a failed or slow read is remembered for 30 s (the built-in page
right away meanwhile). Before setup the page is byte for byte what it
was.

## Import phases (design §10.2)

`import-rotor.mjs` exports `phases` for M2c's runner: `sales.pipelines`
(row 13: Rotor's four boards land on the seeded cadences, with
`rotor.pipeline_id`), `sales.pipeline_stages` (stage → step maps),
`sales.opportunities` (row 14: one archived enrollment per contact and
pipeline, the stage history in it, and the deal with Rotor's status and
value; a placeholder contact when the lead wasn't imported),
`sales.tasks` (row 15: by kind, incidents with their reported date), and
`sales.lead_follow_ups` (row 8's follow-up date → a task). Imported
enrollments are `archived` and never run. A record these phases fold from
many rows names its import source, so the rows share one import base
(docs/CRM-IMPORT.md, Field ownership): a cadence from its board and stages
(`pipelines:board`), a deal or an enrollment from a contact's opportunities
(`opportunities:fold`, rank 3: over the lead's deal values from
`contacts.leads`, rank 2). A folded enrollment keeps the owner it has
(two opportunities of one contact on one board may name two people).

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails); logs carry counts and codes, never a name, phone, email, address
or amount tied to a person. Notifications that can show on a lock screen
carry a first name and a town only.
