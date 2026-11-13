# CRM module: work

Milestones: M4a (office: scheduling) and M4b (field: the tech app). Design
§3.3 (job, visit), §4.5-§4.6 (who sees what), §5.5, §5.7.4 `visit.*`, §7.6,
§9.2 (Schedule, Route, Job, Visit, contact tab Work, Settings →
Checklists), §10.2 rows 3, 22, 23, §11.4. Jobs, visits, the schedule,
assignment, checklists, availability (M4a); the tech app: the tech's day,
the field panel on a visit, timers, timesheets, clock in and out, the
office's Timesheets and working with no signal (M4b; design §2.5, §5.5,
§9.3, §10.2 rows 24 and 26). The field sections are marked (M4b).

Code: `netlify/lib/crm/modules/work/` (server), `crm-app/modules/work/`
(screens). Record types: `job`, `visit`, `checklist_template`, `time_off`
(`types.mjs`, M4a); `timer`, `timesheet` (`types-field.mjs`, M4b). Tests:
`tests/crm/work-office/` (M4a), `tests/crm/work-field/` (M4b), phone checks
`tests/e2e/work-office.spec.mjs`, `work-field.spec.mjs` and
`offline.spec.mjs`.

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
| `weather.mjs` | Schedule | the forecast on the schedule: the National Weather Service read and cached on the server (`GET /schedule/weather`) |
| `automations.mjs` | M4a | `visit.confirm`, the reminders, `work.stale`, `work.stats`, templates |
| `import-rotor.mjs` | M4a | import phases `work.time_off`, `work.jobs`, `work.visits` |
| `field.mjs` | M4b | composes the field part: routes, sweeps, the two manual automations, templates, import phases |
| `types-field.mjs` | M4b | timer, timesheet: validation (minutes derived from the times), index rows (`timers/active`, `timesheets/{month}`, and `timesheets-todo`: what waits for the office, read once for Home's rows and the badge), rels |
| `techday.mjs` | M4b | `GET /tech/day`, the day payload the phone keeps |
| `visit-actions.mjs` | M4b | what the people on a visit do (texts, timer, checklist, photos, notes, lines, complete, no access, incident) and `POST /clock`; the `visit` file owner |
| `timers.mjs` | M4b | segments, the `work.timers` sweep, import phase `work.timers` |
| `timesheets.mjs` | M4b | shifts, device times, pending entries, weekly approval, the pay estimate, the `work.clock` sweep, the person's and the office's time routes, import phase `work.timesheets` |

Client (M4a): `office-schedule.js` (the Schedule: Month, List, Day, 3 Day,
Week and To book, the head and its sheets), `office-board.js` (the desk's
Week board, the Day and 3 Day time grids, the To book tray, drag and drop,
undo, how full a day is, what the cards show), `office-vpanel.js` (the
visit's side panel, Move, Assign), `office-weather.js` (the forecast's
icons and words), `office-kit.js`, `visit.js` (two columns from 1,200 px:
the visit on the left; the customer, call, directions, the job, the buttons
and the texts on the right), `office-styles.css`.

Client (M4b): `tech-today.js` (the person's day on Today), `visit-field.js`
(the field panel on the Visit screen), `tech-time.js`, `tech-pay.js`,
`tech-timesheets.js` (the office's Timesheets), `tech-timesheets-card.js`
(time on the office's Today), `tech-kit.js` (sending online or later, the
overlay of what waits, copies for no signal, Delano times),
`tech-styles.css`.

## What the office sees

- **Schedule** (bottom tab; `schedule:read`), laid out like Rotor's phone
  schedule with Flyra's extras (the owner's choice, Nov 12-13):
  - **The head**: the month as a big title ("Nov ▾" on a phone, "November
    2026 ▾" on a computer; tap: a month picker with Today and any day), and
    round buttons: **Find** (a visit by customer, address, town or job
    number among what's on screen; on a desk it opens in the side panel),
    **Map of the day** (each person's Route that day, with its sketch and
    Google Maps; the live team map joins it later), **Go to a date**
    (a day, or Today), **Who** (everyone or one person; a chip under the
    views shows everyone again) and the **gear**: Flyra's "Show on cards"
    (Customer name, Service, Price with `visits:prices`, Address) and
    "Hide cancelled jobs", saved per person on that device (localStorage
    `crm-sched-cards:<user id>`) and applied to every view's chips, rows and
    blocks.
  - **The views**: Month (the default when nothing is kept) · List · Day ·
    3 Day · Week, with a **week strip** on List, Day and 3 Day (Sunday
    first; today in a coral circle, the chosen day in ink, 3 Day's other two
    shaded; tap a day; swipe for another week on a phone, the arrows or the
    arrow keys on a computer). To book (the tray) opens from the month's
    "N to book". Old links keep working (`?view=day&date=`, `?date=` alone
    opens the month on it, `?view=tray`), and `?visit=` opens a visit's
    panel (a phone: the Visit screen).
  - **Month**: the grid (Sunday first), one read (`GET
    /schedule?month=`), each day showing **how full it is**: the count and
    a thin bar against what the crew can do that day (green, amber from
    75%, coral full or over; striped amber for visits on a closed day or a
    holiday; one person shown: their share), the **forecast** for the next
    7 days (an icon and the high; the chance of rain or snow when it's 40%
    or more), an amber mark on a **past day with visits nobody closed**
    (booked, on the way or under way), and on a computer the chips (start
    time and the customer, in the color of the first person on it; "+N
    more" past three). Under the grid: what the bar and the mark mean, the
    forecast's source, and **Change** (`settings:general`: the crew's
    visits a day, the forecast on or off). The card's head: the month's
    count, **N to book** (the tray's own rule, `toBookRows`), Today and the
    arrows. Picking a day (a tap, or the arrow keys on a computer: a day, a
    week, Home and End, Page Up and Page Down a month) shows **that day's
    list** under the grid on a phone and beside it from 1,100 px: "Thursday,
    Nov 12 · 6 visits" and Flyra's **Open day ›**, the day's forecast and
    "5 of 8 booked", "2 visits here aren't marked done yet" on a past day,
    **Route** (one person), **Book** and **Move this day** (the rain-day
    move, today and later), then a row per visit (the time, the customer,
    the address, the work, the status, the amount, the people) and timed
    task; an empty day says "No jobs on Thu, Nov 12" with **Add job** (New
    job booked for that day). Picking a day inside the grid never reads
    again.
  - **Day**: **Technician** (the default): a column per person, Unassigned
    first, on a time grid (the open hours, stretched to every visit), each
    head with the name, visits done of all ("2/3"), money done of all
    ("$1,105 / $1,500", only with `visits:prices`) and a thin bar (done
    green, under way blue); each visit a block in its person's color with
    the customer, the town, the service, the time, the status and the
    amount (as the gear says); done ones faded and struck through with a
    check, a red **$** when the job isn't paid (Money's invoices index:
    an open invoice with a balance, or none yet); timed tasks on their
    person's column; a red line at the server's current time today. More
    than two columns scroll sideways on a phone (the hours stay). **Sales
    rep**: the same columns for the sales side: each owner's and office
    person's estimate visits, meetings, calls and follow-ups with a time
    (open tasks, `?sales=1`, `tasks:read`), Unassigned first; those due "any
    time" listed under the grid. Under it: Route (one person), Rain day,
    Time off, Today.
  - **3 Day**: three days side by side on the same grid, each visit in its
    first person's color; each day's head (weekday, date, forecast, done of
    all, the money) opens that Day. On a phone, more than two visits at once
    in a day show as one block ("3 visits, 10a to 12p") that opens the day.
  - **Week** (Sunday first, as the month): on a phone each person's count
    of visits per day (tap a day to open it); on a desk a board (below).
    **List**: the next 14 days from the chosen day as an agenda.
    **To book**: jobs with no visit, due by the month (plan visits and
    takedowns once their month comes); **Book** opens the book sheet.
  - **On a desk (1,100 px and up)**: a click on a visit (the month's day
    list, Week, Day, 3 Day, List, Find) opens a **side panel** instead of
    leaving: the customer, when (and the arrival window), where, the work
    and job number, who, the status, the amount (`visits:prices`), the
    crew's access and notes, the visit's notes, the office notes, and
    **Open visit**, **Move** (the book / move sheet), **Assign** (the
    people only, with the warnings while you pick), **Navigate** and
    **Call**. Esc or ✕ closes it (a sheet on top closes first; focus goes
    back to the visit); the frame's address and the office shell's become
    `#/schedule?…&visit=<id>`, so the link can be shared. **Week** is a
    board (a row per person and Unassigned, a column per day with its fill
    and forecast) and **Day** and **3 Day** are the grids above; a visit
    that hasn't started **drags** to another day (the board keeps its
    time), another time (the grids snap to 15 minutes) or onto another
    person's row or column (that person replaces the one it was dragged
    from; onto Unassigned takes them off); a job from the **To book tray**
    beside them drags onto a day (the person's first free slot that day in
    the open hours, else the opening time) or a time on a column (the
    default length and arrival window). A drop runs the same checks as the
    sheets: `GET /schedule/check` first (any warning is asked: "Tess is
    off. Go ahead anyway?"), then a fresh `GET /visits/:id` (a visit someone
    changed meanwhile is never moved on old information) and `PATCH` with
    If-Match, or `POST /visits` with a client id. An **undo bar** says what
    changed ("Pat S. moved to Wed, Nov 25 at 8:00 AM, now with Tess.") for
    12 seconds: Undo puts a move or assignment back while nobody changed it
    since, and cancels a booking (the job goes back to To book). A visit
    under way only changes people (Assign). The keyboard way is the
    panel's Move and Assign and the tray's Book. A phone has no drag: a
    tap opens the visit, as before.
  From a day: one person's **Route**, **Rain day** and **Time off**. The top
  button is **Book** (a new job with its first visit). A technician holds
  `schedule:read` only as "own": the tab is the office's ("Your day is on
  Today"), and every schedule route answers them 403.
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
  (today's visits per person) is `home: false`. An owner or office person
  who goes out on visits gets **My visits** there (M4b: the clock bar and
  their own day, the same card as a tech's Today), and the Timesheets card.
- **Timesheets** (M4b; Menu, `time:edit_others`; `#/timesheets`): the week
  (Sunday to Saturday) per person with each shift and its flags (closed for
  them, edited, a timer stopped for them, on the clock, waiting), hours and
  overtime, **Approve the week** (it names the shifts the app closed for
  them first); above it the entries **waiting for a decision** from any
  recent week (a phone's time the server didn't take, an offline change
  that no longer fit its visit, a week payroll locked): **Decide** approves
  as claimed or with edited times, or doesn't count it; an entry that only
  reports an offline change shows what the phone sent (its words, a held
  photo) and is marked **Seen it**. Each shift's pencil edits the day,
  start, end and category, always with a reason. Home's "Needs you" shows
  how many entries wait and weeks to approve (the module's `approvals`
  rows `work.time_entries` and `work.time_weeks`); the badge counts them
  too.
- **Settings → Checklists** (`settings:general`): each list's name, on or
  off, which jobs get it (kinds of job, else services), its items (tick,
  photo, count, note; required or not). A job gets the first active list by
  order whose kinds include its kind, else (regular, touch-up, warranty)
  whose services match its lines. Visits copy the list when booked.

## What a tech sees (M4b)

A technician's tabs are **Today · Inbox · Time · Pay · Me** (Inbox arrives
with Messages). Owners and the office who go out on visits (`is_technician`)
get **My visits** on their Today and **Time** and **Pay** in More; the
office gets **Timesheets** in More.

- **Today** (`tech-today.js`, a Today card): the clock bar (**Clock in**, or
  "On the clock 3 h 12 m" with **Clock out**; owners pick service, sales or
  office), Yesterday · Today · Tomorrow, and the visits in the person's
  route order: the time and arrival window, first name and last initial,
  town, services, badges (plan member with perks, balance due, gate code,
  pets, first visit, lights), the status; **Directions** (the maps app,
  outside the frame), **Call**, **Text**. The day is the server's (the
  phone's clock may be off).
- **Visit** (`#/visits/:id`, M4a's screen): for anyone on the visit, the
  **field panel** (`visit-field.js`, the `visitActions` panel "field") sits
  under the crew's notes and shows the checklist, the work and the notes
  itself (`replaces`): the status and the big buttons (**On my way**,
  **Start**, **Pause**, **Resume**, **Complete**; **Running late**, **No
  access**), the running timer, "last time here" (the newest finished
  visit's notes at the place), the checklist to tick (a photo item is done
  by its photo; a count or a note asks for it), photos (**Before**,
  **After**, **Issue**; before and after are for the customer's history,
  issue photos stay with the office), the work (prices only with
  `visits:prices`) and **Add to the job** from the price book (credited to
  the tech), notes, **Report an incident**. **Complete** waits until the
  required items are done; it stops everyone's timer on the visit.
- **On my way** asks how many minutes (from where the phone is to the
  house, straight line × 1.3 at 35 mph; editable) and texts the customer
  `on_my_way`; **Running late** texts `running_late` with a new time. Both
  need signal. While texts are dry-run the panel says nothing went out and
  offers **Open in Messages** with the words (without the opt-out line).
- **Time** (`#/time`): this week (Sunday to Saturday) in hours a day, the
  total with the open shift, a warning near and over 40 hours, the shifts
  (flags: closed for you, edited by the office, waiting for the office),
  the visit timers, **Clock in** / **Clock out**, **Add a note** to a shift.
- **Pay** (`#/pay`): their own pay only, an estimate until payroll ships
  (M7a): the week's hours, overtime over 40 hours at 1.5x, their rate (D3:
  $20 an hour for service when none is set), regular and overtime pay;
  time waiting for the office isn't counted; earlier weeks.
- **Me**: My account (core).

### With no signal

The tech app works at a house with no signal (§2.5):

- The service worker starts the app; Today reads `/tech/day?date=` with
  the phone's own today, so the last good copy of that day shows ("No
  signal. Your day as of Tue, Nov 17, 7:42 PM": the copy's day when it isn't
  today) and never yesterday's as today; with no copy of today it says so
  plainly. While there is signal the app also keeps tomorrow's day and a
  copy of each of the day's visits (and its timers), so the next morning
  and a visit open offline too. One line says it (when the copy is from,
  what waits): the app's own offline banner steps aside for it, and so
  does the office shell's bar (the screen posts `crm:offline` to it). A
  phone whose date is far off the server's gets the server's today while
  it has signal.
- Every field change (timer, checklist, photo, note, line, incident,
  complete, no access, clock in and out) goes through `send()`: straight to
  the server when there is signal and nothing waits, else into the phone's
  outbox (`core/outbox.js`) with a client id, `queued_offline`, `queued_at`
  and `client_at`; it replays in order (a sequence number kept with the
  items, never the phone's clock) when signal comes back (on `online`, on
  focus and every 30 s). A direct attempt that timed out or met a 5xx is
  queued too, under the same Idempotency-Key and client id, so it's a
  no-op if it had landed. Once anything waits, new changes queue behind
  it, so the order holds. Each replay says the phone's clock as it sends
  (header `X-CRM-Sent-At`).
- Every item belongs to the person who made it. A 401 (the session ran
  out) stops the replay and keeps everything; the items wait for the next
  sign-in on that phone: the same person's go out, anyone else's are
  deleted unseen. Sign out warns "N changes haven't gone out yet" and
  deletes them. When the phone's storage is full the change waits in the
  page only and the tech is told plainly ("This phone is full; this change
  isn't saved").
- A photo has the time its size needs to go (10 s plus a second per
  24 KB); one that can't get through holds back only its own visit's later
  changes, never another visit's or the clock.
- Photos travel as JSON (`POST /visits/:id/photos`, base64) so they wait in
  the same outbox, in order: the photo for a required item always lands
  before the completion that needs it.
- The screens lay what waits over the last copy (`overlayVisit`,
  `overlayDay`): ticks, notes, photos (from the phone), the timer,
  completion and the clock show as done, with "N changes wait for signal".
  When the outbox empties the screen reads the server again.
- On my way and Running late never queue ("needs signal"): a late "on my
  way" is worse than none, and the server refuses a replayed one.
- Items older than 6 days aren't replayed, and an item the server refuses
  (a 4xx) isn't dropped: both go to `POST /outbox-review` (core) for the
  owners, in batches under its caps (200 items, 8,000 characters an item,
  512 KB a request), photo bytes left out; a week-old photo is first kept
  on an entry for the office (`POST /visits/:id/photos` with `hold: true`).
  A batch the server turns down for one item loses only that item, and the
  tech is told.

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

### The field rules (M4b)

- **Who**: every field route is for the visit's people, whatever their
  role. Someone else gets 409 (the office: "add yourself first") or 404 (a
  technician: ids can't be probed); a technician only inside [today − 7,
  today + 30]. Answers to a technician carry each type's `techFields`
  only; prices only with `visits:prices` (D11).
- **Client ids**: every field write carries the phone's `client_id`; a
  repeat (a double tap, a replay of a change that landed) is one change:
  timers, shifts, incidents and photos get ids derived from it, notes,
  lines and completions remember it.
- **Device times** (`judgeTime`): a live request is recorded at the
  server's time. A replay (`queued_offline`) is recorded at its
  `client_at` only when `|client_at − queued_at| < 2 min`, `client_at` is
  within the last 7 days and not ahead of the server; otherwise the time
  is a claim: a shift with it becomes a **pending entry** (status
  `pending_approval`, `pending.reason` = `queued_mismatch`, `too_old`,
  `future` or `no_device_time`), a timer segment is marked `unverified`.
  A phone whose clock is off by more than 2 minutes (server time minus its
  `X-CRM-Sent-At`) has its times moved by that much, and they wait for the
  office the same way (`clock_skew`, `skew_ms` kept).
- **Conflicts**: a replayed change the visit no longer allows (the office
  cancelled it, the checklist wasn't done, the job closed before an upsell
  line came in) is never forced: it becomes a pending entry
  (`pending.reason: "conflict"`, the action, what the phone said and when,
  and its words or values in `pending.payload`) and the answer is 202. A
  clock-out replay with no open shift does the same. Live, the same is a
  plain refusal. The other reasons:
  - `lost`: a replay for a visit the person lost meanwhile (given to
    someone else, moved past the window, deleted). The entry keeps what the
    phone sent (a photo is held on the entry, `pending.file_ids`, readable
    by the office and the person); the answer and the person's view carry
    nothing of the visit. An incident still becomes the owners' task.
  - `moved`: a replay done on another local day than the visit's date
    (the office moved it). Time, completion, no access, ticks and lines
    wait; notes and photos go in (`applied: true`) and the office hears.
  - `cancelled`: ticks, notes and photos on a cancelled visit go in
    (`applied: true`) and the office hears.
  - `overlap`: two phones of one person. A replayed clock-in over the open
    shift, or a shift over a closed one, is kept as a pending entry (never
    the open shift, never counted until approved); the phone's clock-out
    names its shift (`shift_client_id`) and ends that entry, never another
    phone's shift. A replayed timer start over a segment of the same person
    on the visit is the same (its pause names it: `timer_client_id`); a
    timer entry never counts as time.
  - `stale`: a week-old photo held for the office (above).
  The office hears once an hour per person and visit, and decides each on
  Timesheets; an entry that only reports a change spans no time and is
  marked seen.
- **Locked weeks** (§5.8): a shift that closes into a week payroll locked
  (the `payroll.periodStatus` service, or a locked shift of the person's
  that week) never changes it: with `payroll.addAdjustment` it becomes
  status `adjusted` and an adjustment line in the next open period;
  without it, a pending entry (`locked_period`). The owners are told.
- **Timers**: one running segment per (visit, person)
  (`ptr/timer/{visitId}--{uid}`). Start opens one (a booked, en-route or
  paused visit goes in progress; a second person joins a visit already
  under way) and clocks the person in (service) when they aren't; pause
  closes theirs (the visit pauses when nobody's runs); finish / complete
  closes everyone's at the completion time. `visit.minutes_worked` is the
  sum of closed segments of a minute or more. A visit done without the
  timer goes under way and done in one tap.
- **Shifts**: one open per person (`ptr/clock/{uid}`, a "one open"
  pointer). A shift forgotten on an earlier day is closed at its deadline
  before a new clock-in, so a stale pointer never blocks it. Clocking out
  pauses the person's running timers. A shift begun at or after 21:00 (an
  evening's lights work) runs to its start + 6 h before `work.clock`
  closes it, and is asked "Still clocked in?" an hour before that.
- **Visit files**: a visit photo is a picture (JPEG, PNG, WebP by its magic
  bytes); a PDF the office attaches is an attachment (`visit.attachments`),
  never a photo, never shown to the customer.
- **Weekly approval**: the office approves a person's week (closed shifts
  → approved, 20 a request); an edit says why and keeps `edits[]` (who,
  when, the field, before, after, why), and an edited approved shift needs
  approving again. Pending entries are decided one by one (approve as
  claimed or with edited times, or don't count it).
- **Texts**: `visit.on_my_way` and `visit.running_late` are manual
  automations (Automations can turn them off or change the template); the
  text is the person's (origin user) through `messages.sink`, category
  service: consent, opt-outs and the opt-out footer as the sender does
  them. Outside quiet hours' service window it is blocked, never
  scheduled. Templates `on_my_way`, `running_late`: no "Reply STOP" (the
  sender adds it), no em dashes.
- **Photos**: through core's files (the type from the magic bytes),
  stored exactly as sent. The app keeps a photo's EXIF, location included
  (the owner's rule): a small JPEG goes up untouched, a big one is shrunk
  to 2048 px with its EXIF and XMP put back (orientation upright).
  `defineFileOwner("visit")`: the office reads and adds; a technician on
  the visit inside the window too. A photo for a checklist item (`item`,
  also `?item=` on `POST /files`) ticks it.
- **Incident** (barta-rules §8): a task, kind incident, high priority, no
  due date, reported today, for the owners, linked to the visit and job.
- **Upsell lines**: from the price book (active, sellable, priced), added
  to the job with `upsell_user_id` = the tech; the job's totals follow.

## Endpoints

All `auth: "session"`. `schedule:read` lists (subject "none") need the
unscoped permission: a technician gets 403 on lists, and `GET /visits/:id`
/ `GET /jobs/:id` answer a technician only for their own visit dated within
[today − 7, today + 30] (404 otherwise), with `techFields` only, the
contact's `display_name`, `first_name` and phones, and line prices only with
`visits:prices`.

| Route | Perm | What |
|---|---|---|
| `GET /schedule?from&to&users` | schedule:read | visits, timed tasks, time off and warnings for up to 42 days; `today` is the server's day |
| `GET /schedule?month=yyyy-mm\|now&amounts=1` | schedule:read | the month view's grid in one read (`monthGridRange`: the Sunday on or before the 1st to the Saturday on or after the last day, 28 to 42 days); `amounts=1` adds each visit's job total (`amt`, cents, from the jobs index: open jobs and the years closed ones are filed under; none for a no-charge job) for people with `visits:prices` |
| `GET /schedule?…&pay=1&sales=1` | schedule:read | every answer also carries `capacity` (`per_day`, `per_person`, `days` {date: visits it can take}, `off` {date: [user ids off all day]}), `defaults` (`duration_min`, `window_min`), `weather` (on or off) and `now_min` (the server's time of day); a month carries `to_book`; `pay=1` with amounts (not a month) adds `pd` (1 paid, 0 not) to finished visits; `sales=1` (not a month, `tasks:read`) adds `sales` (open estimate visits, meetings, calls, follow-ups and personal blocks with a time) |
| `GET /schedule/weather` | schedule:read | the next 7 days' forecast `{ days: { date: { hi, lo, pop, icon, text } }, as_of, state: ok \| stale \| off \| none, source }`; never an error |
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

### Field endpoints (M4b)

All `auth: "session"`; the visit routes are `replaySafe` (an app one
version old may still replay), except the texts.

| Route | Perm | What |
|---|---|---|
| `GET /tech/day?date` | time:own | the person's day (window: today − 7 to + 30); no date: the server's today |
| `POST /visits/:id/on-my-way` · `/running-late` | visits:work | `{eta_min, lat?, lng?}`; the text (needs signal) |
| `POST /visits/:id/timer` | visits:work | `{action: start\|pause\|finish}` |
| `GET /visits/:id/field` | visits:work | the visit's segments, whose runs, minutes, the last notes at the place |
| `PATCH /visits/:id/checklist` | visits:work | `{key, done, value?}` |
| `POST /visits/:id/notes` · `/photos` | visits:work | `{text}` · `{data, thumb?, tag, item?, caption?}` (base64, 3 MB) |
| `GET /visits/:id/pricebook` · `POST /visits/:id/lines` | visits:add_line | what can be added · `{price_item_id, qty}` |
| `POST /visits/:id/complete` · `/no-access` | visits:work | `{signature_file_id?}` · `{note}` |
| `POST /visits/:id/incident` | incidents:create | `{text, photo_ids?}` |
| `POST /clock` | time:own | `{action: in\|out, category?}` |
| `GET /me/timesheets?week` · `POST /me/timesheets/:id/notes` | time:own | the person's week · a note on their shift |
| `GET /me/pay?period` | payroll:read_own | the estimate (or `payroll.myPay` when payroll provides it) |
| `GET /timesheets?week&user` · `GET/PATCH /timesheets/:id` | time:edit_others | the office's week and pending entries · one entry; edit with a reason (If-Match) |
| `POST /timesheets/approve` · `/timesheets/:id/decide` | time:edit_others | `{user_id, week_start}` · `{decision: approve\|reject, start_at?, end_at?, reason?}` |

Writes carry `client_id` (400 without one), and replays `queued_offline`,
`queued_at` and `client_at`.

## Settings

`cfg/work` (`settings:general`): `stale_in_progress_days` (2),
`timer_autoclose_after_min` (120), `reopen_days` (7), `clock_flag_at`
("19:00"), `clock_autoclose_at` ("21:00"), `default_window_minutes` (120),
`default_duration_min` (120), `confirm_skip_within_days` (2),
`late_cancel_hours` (24), `visits_per_day` (8: the visits the whole crew
can do in a day, what the month's bars fill against; Schedule → Change),
`weather` (true: the forecast on the schedule). The schedule also reads
`cfg/hours` and the holiday calendar, and Route reads the company's base
(`cfg/company.base`).

**How full a day is** (`capacityOf` in office-schedule.mjs): a closed day
(the hours) or a holiday takes 0; otherwise `visits_per_day`, less the share
of each active technician off the whole working day (an all-day time off,
or one covering the day's hours; an "available" exception never counts):
the crew's number × the share still working, rounded. One person's share
(`per_person`) is the crew's number over the technicians, at least 1.

## The forecast (api.weather.gov)

The schedule's weather comes from the **National Weather Service API**,
host **`api.weather.gov`** (free, no key, no account), read on the server
only (`weather.mjs`, `GET /schedule/weather`): the app's CSP is unchanged
and a phone never calls it.

- What is sent: the forecast point only, the service area's center
  (Settings → Service area, else the company's base), rounded to 4
  decimals; no customer, address or person. The request carries
  `User-Agent: BartaCRM/1.0 (https://www.bartawindowwashing.com; schedule
  forecast)` (NWS asks for one; no email) and `Accept:
  application/geo+json`.
- Two calls, each cached in storage and in the warm instance:
  `GET /points/{lat},{lng}` (the forecast office and grid; kept 30 days in
  `sys/weather-point/{lat}_{lng}`) and `GET /gridpoints/{office}/{x},{y}/forecast`
  (kept 3 hours per office and grid in `sys/weather/{office}-{x}-{y}`).
  The forecast URL is built from the office and grid, never taken from the
  answer. Each call has 3.5 s (less when the request's 8 s budget is
  running out); one refresh at a time per instance; the route's storage
  budget is 12 calls.
- Calls go out only on a Netlify deploy (production, a deploy preview or a
  branch deploy) with `cfg/work.weather` on; local dev and tests (context
  "dev") never call: they serve what a cache already holds (the phone
  checks put a synthetic answer there).
- A failure (a timeout, a 4xx or 5xx, a shape we don't know) answers no
  days (never an error) and isn't tried again for 15 minutes; a forecast
  already kept keeps showing, marked stale. The days are each date's
  daytime period (this evening: tonight's): the high, the low, the chance
  of precipitation, the words, and an icon (sun, partly, cloud, rain, snow,
  storm, fog, wind; rain, or snow at or below 32°F, when the chance is 40%
  or more).
- Turning it off: Schedule → Change → "Show the forecast" (cfg/work.weather).

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
- `work.timers` (M4b; fast lane, every pass, mutates): a segment still
  running past its visit's end + `timer_autoclose_after_min` (2 h; never
  before the visit's planned length + 2 h, so a late start isn't cut
  short), 20:00 for one with no visit, or on a visit already done or
  cancelled, is closed at that deadline with `auto_closed`; the visit
  pauses when nobody's timer runs; the person and the office are told; the
  shift is flagged `timer_auto_closed`. On a visit Rotor still owns (an
  imported one, before cutover) the CRM's own segment closes but the visit
  is never written: its `minutes_worked` and pause go to would- rows.
- `work.clock` (M4b; fast lane, every pass, mutates): from
  `clock_flag_at` (19:00) one push "Still clocked in?" (kind
  `clock_reminder`); at the later of the day's last visit end + 2 h and
  `clock_autoclose_at` (21:00) the shift closes with `auto_closed` for
  review (flag `auto_closed`), the person and the office told; a shift
  begun at or after 21:00 runs to its start + 6 h (asked an hour before).
  A shift from an earlier day is closed whenever the sweep finds it. The
  office's "Approve the week" names the shifts the app closed before it
  approves them.
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
- `visit.on_my_way`, `visit.running_late` (M4b; trigger manual, service):
  a tech's tap sends them right away or not at all; the owner can turn
  them off or change the template. Templates `on_my_way`, `running_late`.
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

`work.timers` (M4b, after `work.visits` and `system.users`; visit timers:
people from `assigned_to`, geo, minutes, segments with no visit kept, one
still running closed at its deadline with `auto_closed`, reported) and
`work.timesheets` (M4b, after `system.users`; shifts closed, `approved`
when before Rotor's last payroll run (Oct 1), one still open closed at
21:00 for review; no clock pointer is made).

## Extension points

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

- Today cards (core, M4b): a module's Today card may have `events` and
  `mount` (delegated inside its own wrapper); a tech's "No visits today"
  shows only when no card has anything to show.
- Visit panels (M4b): a `visitActions` panel may say which of the Visit
  screen's cards it shows itself (`replaces: ["checklist", "lines",
  "notes"]`) and may have `mount`; the Visit screen opens from the last
  good copy when there's no signal (`data.offline`, `data.as_of`).
- Payroll (M7a) services the field part calls when they exist:
  `payroll.periodStatus({ user_id, at }) → "open" | "locked" | "paid"`,
  `payroll.addAdjustment({ user_id, minutes, category, start_at, end_at,
  timesheet_id, note }) → { id }`, `payroll.myPay({ user_id, period })`
  (replaces the estimate behind `GET /me/pay`).

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails); logs carry counts and codes, never a name, phone, email, address
or amount tied to a person.
