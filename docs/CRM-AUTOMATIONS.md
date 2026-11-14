# Custom automations (the builder)

Barta's own "when this happens, if that, then do these steps" automations,
the way Flyra and Rotor build them, on top of the CRM's automation engine
(docs/CRM.md "Automations and bulk sends"). Owners and the office build
them on **Messages & automations → Automations**; a technician never sees
them. Like everything else before the switch-over, a text or email they
send lands in the **Outbox** (dry run), and a change to a customer Rotor
still owns is only reported (a "would have" row in the automation log).

Module: `netlify/lib/crm/modules/automations/` (server) and
`crm-app/modules/automations/` (client). Record types `flow` (prefix `af`)
and `flow_run` (`ar`). Settings document `flows`.

## What an automation says

| Part | What it holds |
|---|---|
| **When** (trigger) | An event: a new lead comes in, a tag is added (which tag), a quote is sent, approved or declined, a visit is booked, starts or is finished, a job is completed, an invoice is sent or paid, a plan starts, renews or is cancelled, a review comes in. Or a daily check at a time on chosen days: an invoice is N days overdue, a plan is N days from renewal, a task is due today, or **On a schedule** (everyone in the contacts list who matches the conditions). Not yet: a birthday (contacts keep no such date). |
| **Only if** (conditions, all must hold) | Lead source, tags, town, owner, lead or customer, service (the record's, else the services they were quoted), plan type, has a plan, amount (the quote's first visit, the invoice's balance, the plan's sale value), the record's status, they replied (after the run started), has a quote, left a review, weekday or weekend, a time of day, a date window (month and day, across New Year too). |
| **Then** (steps, in order) | Send a text or an email from a template; make a task for the contact's owner, the owners, the office or one person (due in N days); add or remove a tag; move the deal (open, quoted, won, lost, abandoned); assign an owner; tell the team (the bell and push); start a follow-up cadence; stop if a condition is true. Up to 12 steps. |
| **Wait** (each step) | N minutes, hours or days, then optionally a time of day ("3 days, then 10:00"), then optionally moved into business hours (Settings → Hours & holidays, holidays skipped). Minutes and hours are elapsed time; days keep the wall clock across DST (1 day from Saturday 10:00 before the fall-back night is Sunday 10:00, 25 hours later). The sender still applies quiet hours to texts and emails. |
| **Stop when** | Any of these conditions ends the run. Checked before every step and again right before every text or email goes (the engine's `recheck`). |
| **Limits** | Not again for the same customer within N days (default 1; 0 for none). |

The editor writes the automation in plain English as you edit (the server
writes the sentence, `POST /automations/flows/check`), for example: *"When a
quote is sent, if no reply in 3 days, text the Day 3 follow-up at 10 AM (in
business hours), then make a task for the owner. Stops when the quote is
approved or the quote is declined."*

**Test run** picks a customer and shows, step by step, what would happen
now: whether it would start (each condition), when each step would run
(after quiet hours for texts), the text as it would read, blocked reasons
(no consent: a marketing text needs a yes; no mobile number; a variable the
record can't fill), the daily text limit, who a task or notice is for, and
"report only" for Rotor's customers. It writes nothing and sends nothing.

**Run history** lists every start (newest first) with where it is or why
it stopped; tap one for each step's outcome, and for a text the sender's
own outcome (in the Outbox as a dry run, sent, held for quiet hours, or
skipped and why).

New automations are made **off** (from scratch or from a starter), pause
and resume from the list's switch, duplicate (the copy is off), delete with
a confirm (soft: the runs stop at their next step, the history stays).
Turning one on needs every template, cadence and person it names to exist.

### Starters

| Starter | What it does |
|---|---|
| Quote follow-up | 3 days after a quote is sent with no reply, at 10:00 in business hours, text "Day 3 follow-up"; then a task for the owner to call. Stops on a reply, an approval or a decline. |
| Review request after a visit | 2 hours after a visit is finished (in business hours), "Review ask after a visit", unless they already left a review. Once per 180 days. |
| Overdue invoice reminder | Weekdays at 10:00, invoices 7 days past due: "Overdue invoice nudge", then a task to call 3 days later. Stops when it's paid or void. Once per 14 days. |
| Win-back for lapsed plans | 60 days after a plan is cancelled: "Win-back for a lapsed plan" (marketing: needs their yes), then a Win-back tag. Stops if they have a plan again or reply. |
| Lights season rebook | Weekdays at 10:00 from Sep 15 to Oct 15, everyone quoted for Christmas lights: "Lights season rebook". More than 5 at once is a bulk run. Once per 300 days. |

Some overlap a built-in automation (the review sequence, overdue reminders,
the lights rebook): turn one of the two off, or the customer could hear
twice (the daily text limit below still holds).

## Safety

- **Every send goes through the engine and the sender**: a step queues
  one `automation.send` item under its marker (`done-dry/flow.service/…`
  while texting is dry-run; `flow.marketing` for a marketing template), so
  consent, opt-outs, quiet hours, the opt-out footer, the duplicate guard,
  dry run and the Outbox all apply, and a text never goes twice.
- **Bulk sends**: a step that would text more than
  `cfg/messaging.bulk_threshold` (5) people at once (a daily trigger's
  list) becomes one bulk run: preview, a required test send, then an
  owner's or the office's confirm (Approvals). Nothing goes before that.
- **The parallel-run guard**: every change (task, tag, deal, owner,
  cadence) first asks the guard; for a record Rotor still owns it writes a
  `would-<action>` row and changes nothing. The store's backstop catches
  anything else. A run started before the switch-over stops at its next
  step after it (like the engine's dry-run sequences).
- **Daily text limit**: at most `cfg/flows.max_texts_per_day` (2) automated
  texts to one customer a day, counting every automation: these
  (`flowt/{date}/{contact}/…` claims, made when the text is due) and the
  built-in ones (their dry-run texts in the Outbox). Over it, the text is
  skipped (`skipped:daily_cap` in the log).
- **Per-customer limit**: the automation's own "not again within N days"
  (`flowc/{flow}/{contact}/…` rows, one per start).
- **Loop guard**: an event caused by an automation's own step never starts
  that automation again (`skipped:loop`); one automation starts at most 3
  times a day for one customer, whatever its limit says
  (`skipped:loop_guard`); more than `cfg/flows.max_runs_per_day` (200)
  starts in a day switches it off and tells the owners.
- **Idempotent**: a run's id comes from the automation and the event (or
  the day), so a retried listener or sweep starts nothing twice; each step
  is a queue item with its own marker; a task's id comes from the run and
  the step, tags are a set, a notice claims its own marker, so a step that
  crashed half way and runs again does nothing twice.
- **Pause**: while an automation (or every automation: Pause all) is
  paused, its runs hold at their next step, re-checked hourly, and stop
  after 14 days held. Starts are skipped while paused.
- **Eligibility**: an event before `cfg/automations.effective_from` (written
  at the switch-over) starts nothing.

## How it runs

- Events: the module listens to every trigger event
  (`done/evt/{event}--automations`); the listener reads the automations
  with that trigger (`rel/flows-by-trigger/{trigger}`), checks the loop
  guard, the floor, the conditions and the limits, and starts a run.
- Daily triggers: the sweep `flows.daily` (fast lane, every pass) starts
  each due one once a day (`done/flowday/{flow}--{date}`) at its time on its
  days, for at most 100 people (the rest are picked up the next day; their
  limit keeps the ones already reached out).
- Steps: queue kind `flow.step`, marker `done/flow/{run}--{i}`, due at the
  wait. Contacts emits `contact.tagged` (a person's edit or the "add a tag"
  step) and gives `contacts.tag` and `contacts.setOwner`; Sales gives
  `sales.createTask` and `sales.dealOf`; Scheduling emits `visit.started`
  when a tech starts a visit's timer.
- A step a record refuses (a contact merged away, a rule the record keeps)
  is skipped for that record (`skipped:conflict`, `skipped:input`), never
  retried; a store or network failure retries like any queue item.
- `flows.prune` (bulk lane, daily 03:40): the daily text claims of days
  before yesterday go.
- Restores: `flowc/` and `flowt/` are not in the nightly snapshot; after a
  restore the per-customer and daily limits start fresh.

## Endpoints (all `automations:configure`: owners and the office)

| Route | What |
|---|---|
| `GET /automations/flows` | the list (on/off, runs, last run, sentence, problems), starters, the catalog, choices (templates, people, cadences), the limits |
| `POST /automations/flows` | `{ recipe }` or a definition → a new automation (off) |
| `POST /automations/flows/check` | `{ flow }` → `{ summary, problems }` (never a 400) |
| `POST /automations/flows/test` | `{ flow, contact_id }` → what would happen (no writes) |
| `GET /automations/flows/:id[?catalog=1]` | one (with the editor's catalog and choices, plus the tags, sources and towns in use) |
| `PATCH /automations/flows/:id` | If-Match; a definition |
| `POST /automations/flows/:id/pause` · `resume` · `duplicate` | |
| `DELETE /automations/flows/:id` | soft delete |
| `GET /automations/flows/:id/runs[?before=]` · `/runs/:run` | run history; one run with its sends' outcomes |
| `GET/PUT /settings/flows` | `{ max_texts_per_day (1-10), max_runs_per_day (1-2000) }` |

## Tests

`tests/crm/automations/`: `units.test.mjs` (definitions, the sentence, the
starters' texts, waits with a pinned clock across both 2026 DST changes,
business hours and holidays, conditions, the new events), `engine.test.mjs`
(an event to a run, the wait, the Outbox, the task once after a crash; a
reply stopping it at the step and at the send; would- rows for Rotor's
customers; the loop guard; the limits; pause, delete, the switch-over; the
daily trigger and its bulk run), `api.test.mjs` (who may, CRUD, the test
run writes nothing), `budget-samples.mjs`; the phone checks
`tests/e2e/automations.spec.mjs` (iPhone 13 and a 1440 desk;
`E2E_DEVICES=iphone13,iphonese,desk1440` for the SE too).
