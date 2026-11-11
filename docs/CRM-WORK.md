# CRM module: work

Milestones: M4a (office: scheduling) and M4b (field: the tech app). Design
§3.3 (job, visit), §4.5-§4.6 (who sees what), §5.5, §5.7.4 `visit.*`, §7.6,
§9.2 (Schedule, Route, Job, Visit, contact tab Work, Settings →
Checklists), §10.2 rows 3, 22, 23, §11.4. Jobs, visits, the schedule,
assignment, checklists, availability; timers, timesheets and the tech's day
come with M4b.

Code: `netlify/lib/crm/modules/work/` (server), `crm-app/modules/work/`
(screens). Record types: `job`, `visit`, `checklist_template`, `time_off`
(`types.mjs`, M4a); `timer`, `timesheet` (`types-field.mjs`, M4b). Tests:
`tests/crm/work-office/` (M4a), `tests/crm/work-field/` (M4b), phone checks
`tests/e2e/work-office.spec.mjs`.

| File | Track | What it holds |
|---|---|---|
| `index.mjs` | M4a | composes the office part and M4b's `field.mjs` part |
| `states.mjs` | M4a | both state machines, the field transitions included (M4b only reads it) |
| `types.mjs` | M4a | job, visit, checklist_template, time_off: validation, index rows, rels, pointers, techFields |
| `office.mjs` | M4a | writing jobs and visits: `createJobs`, `createVisit`, `changeVisit`, `syncJob`, cancel / reopen / complete, listeners, the `work` stats part, merge, seeds |
| `office-schedule.mjs` | M4a | what the schedule reads and works out: arrival windows, warnings, town hints, route order |
| `office-moveday.mjs` | M4a | the rain-day move (preview, op, run) |
| `office-sync.mjs` | M4a | the `work.sync` and `work.summaries` sweeps (jobs in step with their visits; visits' copies) |
| `office-routes.mjs` | M4a | the office API |
| `automations.mjs` | M4a | `visit.confirm`, the reminders, `work.stale`, `work.stats`, templates |
| `import-rotor.mjs` | M4a | import phases `work.time_off`, `work.jobs`, `work.visits` |
| `field.mjs`, `types-field.mjs`, ... | M4b | the field part |

## What the office sees

- **Schedule** (bottom tab; `schedule:read`): **Day** (a day bar, a chip per
  person, the day's visits and timed tasks (estimate visits, meetings) in
  time order; each visit shows its slot, the town and job, the people as
  colored initials and a warning badge: someone off, outside the hours, a
  holiday, two things at once), **Week** (each person's count of visits per
  day; tap a day to open it), **List** (the next 14 days) and **To book**
  (jobs with no visit, due by the month: plan visits and takedowns once
  their month comes; **Book** opens the book sheet). From a day: one
  person's **Route**, **Rain day** and **Time off**. The top button is
  **Book** (a new job with its first visit).
  A technician holds `schedule:read` only as "own": the tab is the office's,
  their day lives on Today (M4b).
- **The book / move sheet**: day, start, end, what the customer is told
  (a 2-hour or 1-hour arrival window, an exact time, anytime that day) and
  who goes. While you pick, `GET /schedule/check` shows the warnings (never
  blocking) and a hint when someone is already in that town that day.
- **Visit** (`#/visits/:id`, one screen for everyone; M4a owns it; its
  parent is the Schedule, and a tech landing there gets "Open Today"): when,
  status, who; rows for the customer, Call, Directions and the job; for
  the crew (gate code, pets, access notes, crew notes); the work (prices
  only with `visits:prices`); the checklist; notes from the visit; the
  office notes; **Texts and emails** (the confirmation and both reminders:
  sent, would have sent (dry-run), skipped, not yet). Office buttons:
  **Move or reassign**, **Mark done**, **No access**, **Cancel visit** (with
  "the customer cancelled less than 24 hours before": an approval task for
  the late-cancel fee), **Reopen** (within `reopen_days`; not when it would
  reopen a job with a paid invoice).
  M4b's field panel and Money's "Collect payment" arrive through
  `visitActions` (below).
- **Job** (`#/jobs/:id`): title, number, kind, status, total; rows for the
  customer and directions; its visits; the work; notes. **Book** (top),
  **Edit** (title, kind, due month, the lines, notes), **Mark done** (its
  open visits too), **Cancel job** (its open visits too), **Reopen** (not
  once a paid invoice exists).
- **Jobs** (More; `#/jobs?status=open|stale|done|cancelled`): open jobs (under
  way, booked, to book), **Needs a look** (booked but the date went by;
  under way for days), done and cancelled by year, a filter box.
- **New job** (create button, or the contact's Work tab): the customer,
  which property, the kind, the lines (title, price, quantity, service),
  notes, and either the first visit (day, time, window, who) or the month
  it's due by. A retry never makes a second job (client id).
- **Route** (`#/schedule/route/:date/:user`): the stops in order with a
  sketch, **Optimize** (nearest first inside each arrival window, from the
  company's base), move a stop up or down and **Save**, directions per stop
  and the whole day in Google Maps.
- **Rain day** (`#/schedule/move-day`): the day and the day it moves to,
  optionally only some people or services, **See what moves** (the
  preview: the visits, the people pushed, the customers told, a warning
  when the new day is closed), then **Move N visits**. The customers' text
  waits in **Approvals** for an owner's test and confirm.
- **Time off** (`#/schedule/time-off`): whole days or part of one day per
  person; the schedule warns, never blocks.
- **Contact → Work**: coming up, open jobs, recent visits, done and
  cancelled jobs, **New job**.
- **Home** (the office's first screen, docs/CRM.md): today's visits from
  the visits index (`visitRows`), the to-book count by the tray's own rule
  (`toBookRows` in office-schedule.mjs, which `GET /schedule/unscheduled`
  uses too), stale jobs as a "Needs you" row. The office Today card
  (today's visits per person) is `home: false`.
- **Settings → Checklists** (`settings:general`): each list's name, on or
  off, which jobs get it (kinds of job, else services), its items (tick,
  photo, count, note; required or not). A job gets the first active list by
  order whose kinds include its kind, else (regular, touch-up, warranty)
  whose services match its lines. Visits copy the list when booked.

## The rules

- **Job status follows its visits** (`syncJob`, `states.mjs`
  `jobStatusFromVisits`): no live visit → `unscheduled`; any visit started
  → `in_progress`; every live visit done → `completed`; cancelled only by
  hand. One job event per change (`job.scheduled`, `job.completed`,
  `job.reopened`, `job.cancelled`).
- **Visit transitions** (`VISIT_STATES`): scheduled → en_route (on my way)
  → in_progress (start) ⇄ paused → completed (finish, the required
  checklist items done) · scheduled/en_route → no_access · any open →
  cancelled · the office's `office_complete` from any open state · a
  completed visit reopens (in_progress) within `reopen_days`. Only a
  `scheduled` visit moves; people can change until it's done. Every change
  goes through `changeVisit(id, event, opts)` and emits one event
  (`visit.scheduled`, `.rescheduled`, `.assigned`, `.cancelled`,
  `.completed`, `.no_access`) with the previous people, date and start.
- **A visit write and its job's sync are two writes.** The visit write
  carries the event it makes (`last_event`: name, the write's `wv`, the
  payload's extra fields). The same request sent again (same `client_id`,
  a cancel sent twice) finds nothing to change, syncs the job and emits
  that event again unless the module's listener already handled it (event
  ids are record id + wv, so nothing runs twice). `syncJob` reads the job's
  list and the `job-visits` relation, so a visit the job never heard of is
  found; `cancelJob` and `completeJob` walk both too. The hourly `work.sync`
  sweep finishes what nobody retried.
- **What a visit copies** (job number, kind, title, services, plan, the
  customer's name, town, address line, map point) follows a job edit at
  once (and a booked visit whose checklist nobody touched gets the job's
  list again); contact and property edits reach it through the nightly
  `work.summaries` sweep. Route reads a property's map point when the visit
  has none yet, and Optimize keeps it on the visit.
- **Job lines on Edit**: the sheet sends `lines` only when the lines editor
  changed. The server merges them by id onto the stored lines: a line keeps
  everything the form doesn't show (scope, override, optional, tier,
  upsell, show, rotor, its total) while its price and quantity stay as they
  were; a changed price or quantity is priced again; a new line gets a new
  id; totals and overrides in a request are ignored.
- **Route order** is per person: `visit.route_order` is `{ user id: stop }`
  (two people on one visit keep their own order; a plain number from before
  is read as everyone's).
- **Times**: `date`, `start`, `end` are Delano local; `start_utc` /
  `end_utc` are always worked out from them (DST-safe). A `date_only` visit
  (an imported placeholder) has no real time: "anytime".
- **Numbers**: while Rotor is the system of record new jobs take shadow
  numbers (`S-000001`, seq `job-shadow`); after cutover the job sequence
  continues after Rotor's highest imported number (7 digits).
- **Pushes** (`visit_assigned`, `visit_changed`, `visit_cancelled`): exactly
  the techs a change affects; a rain-day move pushes each tech once, linking
  to their Today.
- **Parallel run**: an automation may make jobs or visits only for a
  sandboxed contact (`ParallelRunGuard`); people, the import and the portal
  are exempt. Automated `work.cancelJobs` checks the job and its open
  visits before writing anything: one Rotor still owns is skipped (in
  `skipped`) with one `would-cancel` row, never half cancelled. Every text and email is dry-run before cutover.

## Endpoints

All `auth: "session"`. `schedule:read` lists (subject "none") need the
unscoped permission: a technician gets 403 on lists, and `GET /visits/:id`
/ `GET /jobs/:id` answer a technician only for their own visit dated within
[today − 7, today + 30] (404 otherwise), with `techFields` only, the
contact's `display_name`, `first_name` and phones, and line prices only with
`visits:prices`.

| Route | Perm | What |
|---|---|---|
| `GET /schedule?from&to&users` | schedule:read | visits, timed tasks, time off and warnings for up to 42 days |
| `GET /schedule/unscheduled?month` | schedule:read | the tray: unscheduled jobs due by the month, and how many later |
| `GET /schedule/check?date&start&end&users&visit&town` | schedule:read | warnings and hints for a slot |
| `GET /schedule/route?date&user` · `POST /schedule/route` | read · write | a person's stops; Optimize (no `order`) or save an order |
| `POST /schedule/move-day` | schedule:write (run) | preview, or `{ confirm: true, token }` → 202 `{ run_id }` |
| `GET /stale` | schedule:read | jobs that need a look (and M4b's open timers) |
| `GET /jobs?status&year&contact` · `POST /jobs` | read · write | the list; a new job (lines, notes, optional first `visit`, `client_id`) |
| `GET/PATCH /jobs/:id` | read · write | one job (+ visits, contact, property, people, `can`); edit (If-Match) |
| `POST /jobs/:id/cancel` · `/reopen` · `/complete` | schedule:write | with its open visits |
| `POST /visits` | schedule:write | book (`client_id` makes a retry the same visit) |
| `GET/PATCH /visits/:id` | read · write | one visit (+ job, contact, property, people, arrival text, reminders, `can`); move or reassign (If-Match) |
| `POST /visits/:id/cancel` · `/mark-no-access` · `/done` · `/reopen` | schedule:write | the office's changes (`/visits/:id/no-access` is left for the tech app) |
| `GET/POST /time-off` · `PATCH/DELETE /time-off/:id` | read · write | whole days (`date`, `end_date`) or part of a day (`date`, `start`, `end`) |
| `GET /checklists` · `GET/PATCH /checklists/:id` · `POST /checklists` | read · settings:general | Settings → Checklists |
| `GET /work/contacts/:id` | schedule:read | the contact's Work tab |

Services for other modules (§11.3): `work.createJobs(jobs, opId, scope,
ctx) → job_ids` (ids `deriveId("job", opId, "work.createJobs@" + scope, n)`,
numbers journaled: a re-run creates nothing twice; plans and quotes use
different scopes in one op without colliding) and `work.cancelJobs(job_ids,
reason, opId, ctx) → { cancelled, skipped }`.

## Settings

`cfg/work` (`settings:general`): `stale_in_progress_days` (2),
`timer_autoclose_after_min` (120), `reopen_days` (7), `clock_flag_at`
("19:00"), `clock_autoclose_at` ("21:00"), `default_window_minutes` (120),
`default_duration_min` (120), `confirm_skip_within_days` (2),
`late_cancel_hours` (24). The schedule also reads `cfg/hours` and the
holiday calendar, and Route reads the company's base (`cfg/company.base`).

## Sweeps, queue kinds and listeners

- `visit.reminder_14d`, `visit.reminder_2d` (fast lane, daily 10:00): queue
  the reminders (below).
- `work.stale` (fast lane, hourly): the "needs a look" flags as a derived
  part of the `jobs/open` index rows (never the record).
- `work.sync` (fast lane, hourly): the visits index (a month back, six
  ahead) against `jobs/open`: a job whose status or next visit doesn't match
  its visits, or a live visit whose job is closed or doesn't list it, is
  synced again and the visits' last events emitted again; a cancelled job's
  leftover visits are cancelled. A job Rotor still owns is left alone
  (counted).
- `work.summaries` (bulk lane, daily 02:30): open visits from yesterday on
  whose copied customer name, town, address or map point no longer match
  the contact and property get them again, with the job's own copy of the
  name.
- `work.stats` (bulk lane, daily 02:15): contacts whose next visit date went
  by get their `work` stats part worked out again (`nv` next visit, `ls`
  last service, `svc_d` service dates).
- Run kind `work.moveday` (bulk lane): the rain-day op (`move` → `push` →
  `notice`), resumable; a double tap on Move is the same run.
- Listeners (`visit.*`, `job.completed/reopened/cancelled`): the pushes,
  `visit.confirm` for a moved visit, the contact's stats.

## Automations

- `visit.confirm` (on `visit.scheduled` and `visit.rescheduled`, 10 minutes
  later so a quick correction sends one text): `visit_confirm` (+ email).
  Never for an imported visit, one moved by a rain-day move, or one within
  2 days. One per visit, date and start.
- `visit.reminder_14d` (10:00, 7-14 days out, text + email; not for a visit
  booked less than 14 days ahead; one per visit and day) and
  `visit.reminder_2d` (10:00, 1-2 days out, text; one per visit, day and
  start time, so a time change inside the 2 days, whose confirmation is
  skipped that close, is reminded again at the new time). Imported future visits are eligible; a marker seeded from
  Rotor's own reminders stops a second one.
- At send time each step re-reads the visit: moved, cancelled or changed →
  skipped. Templates: `visit_confirm`, `visit_confirm_email`,
  `visit_reminder_14d`, `visit_reminder_14d_email`, `visit_reminder_2d`,
  `visit_weather_move`. Before cutover everything is dry-run (the Outbox).

## Import phases

`work.time_off` (after `system.users`; availability exceptions),
`work.jobs` (after `contacts.leads`; Rotor's job number kept, statuses
mapped, lines in cents and thousandths, a custom-price line at quantity 1
with Rotor's quantity in `line.rotor.qty_milli`, notes → crew notes, a pending job
due in its month), `work.visits` (after `work.jobs` and
`contacts.properties_visits`; local dates and times, placeholders →
date-only, arrival windows, assignees from the visit's job, the property by
address, the job's visit list and schedule brought up to date). A re-run of
the same export changes nothing. The phases read an export someone made;
nothing calls Rotor.

## Extension points (for M4b and Money)

- Server: `changeVisit(id, event, opts)` in `office.mjs` for every visit
  change (field events `on_my_way`, `running_late`, `start`, `pause`,
  `finish`, `no_access` are in `states.mjs`); `opts.mutate(next)` sets the
  field data (checklist, photos, completion) in the same write;
  `checklistMissing(visit)` gates `finish`.
- Client: `visitActions` in a module's client manifest (`work/manifest.js`
  documents the contract): `{ key, label, when: "assignee" | "office" |
  "any", order?, perm?, icon?, panel?, load }`. On the Visit screen a
  checklist item counts as done with `done_at` (or a value), as the finish
  gate reads it. A panel renders inline on
  the Visit screen with its own state and events; a button runs
  `run(data, ctx)`. The work manifest keeps M4b's entries in its own `field`
  object.

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails); logs carry counts and codes, never a name, phone, email, address
or amount tied to a person.
