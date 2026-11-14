# CRM module: payroll

Milestone: M7a. Status: built (Nov 2026), waiting for the integrator's merge.

What it does: works out everyone's pay from approved time, finished jobs and
tips; pay periods (Sunday to Saturday) that are open, locked or paid; the
owner's bonuses and adjustments; late time that lands after a week was
locked; printable pay sheets and a CSV; the crew scoreboard; the person's
own Pay screen. The CRM computes pay. It never runs payroll or moves money:
"Mark paid" only records that the owner paid.

Code: `netlify/lib/crm/modules/payroll/` (server), `crm-app/modules/payroll/`
(client screens). Record types: `pay_period` (`pp`), `pay_line` (`py`).
Tests: `tests/crm/payroll/` (`compute.test.mjs` hand-worked weeks,
`api.test.mjs` the API and the gate, `budget-samples.mjs`).

## Screens

- **Payroll** (`#/payroll`, Menu → Work → Payroll; `payroll:read_all`, so
  owners and the office): this week's pay so far (each person's total,
  hours, overtime, tips), "Start this week's pay period" when there is
  none, a warning when a period is over and still open, the crew
  scoreboard for this week, and every pay period with its status, people,
  hours and total.
- **A pay period** (`#/payroll/:id`): the total, the status, what still
  waits on Timesheets (entries pending a decision, shifts not approved,
  shifts still clocked in), then one card per person: their pay model,
  total, hours / overtime / commission / tips, bonuses and adjustments, and
  every line (struck-out lines are not paid, each with why). Buttons
  (owners, `payroll:run`): Add bonus or adjustment (who, kind, amount, a
  note the person sees), Lock (once the period is over), Unlock, Mark
  paid, strike out an adjustment; Pay sheet (a printable page per person)
  and Export CSV for anyone who may read payroll.
- **Pay** (`#/pay`, the work module's screen, every person, only their
  own): once payroll is here GET `/me/pay` answers from payroll and the
  screen draws `pay-view.js`: the period's pay so far (or final once
  locked, or paid), what it is made of line by line, time still waiting
  for the office, their own scoreboard row (revenue per hour, reviews,
  upsells, callbacks against the goals), the four weeks before, and "My
  pay sheet" (printable). Week arrows move a week at a time.
- **Settings → Team & permissions → Payroll & pay rates** (`#/settings/payroll`, owners): overtime after how
  many hours and at what rate, how a job's commission is shared, one- or
  two-week periods, who is on the scoreboard; and each person's pay: the
  model, hourly rates for service, sales and office time, commission rates
  for jobs, sales and upsells, overtime on or off (saved on the user with
  If-Match; `users:manage`).

## How pay is worked out (`compute.mjs`, pure)

1. **Hours**: closed, approved and locked shifts whose start falls in the
   period, each in its Sunday-to-Saturday week (America/Chicago). One
   hourly line per shift at its category's rate (straight time). A week
   over 40 h adds one overtime line: hours over 40 × the week's weighted
   rate × (1.5 − 1). So the week pays its regular hours at their rates and
   its overtime hours at 1.5 × the weighted rate (the regular-rate method).
   Minutes come from the two instants, so a shift across a daylight-saving
   change counts the real time. Shifts pending approval, rejected or
   adjusted don't count (pending minutes show as "waits for the office").
2. **Technician commission**: each billable job finished in the period,
   its total after discounts (tips are never in it), shared between the
   people on it: by the minutes each ran the visit timer (`by_hours`,
   segments under a minute ignored; equal shares when no timer ran),
   equally, or each at the full job (`each_full`, Rotor's way). Share ×
   the person's technician rate. Line key `technician:{uid}:{visitId}-{jobId}`.
3. **Salesman commission**: the job's seller (its plan's, else its quote's
   `sold_by`; an imported Rotor rep name matched to a person) × their
   salesman rate. `salesman:{uid}:{planId}:{jobId}`.
4. **Upsell commission**: job lines with `upsell_user_id` × the upsell rate.
5. **Tips**: each succeeded payment's `tip_split` in the period (a refund's
   comes off; simulated, dry-run payments never count). `tip:{uid}:{paymentId}`.
6. **The model per person** (`user.pay.model`): `hourly` (hours, overtime,
   tips), `commission` (commissions, tips), `greater_of` (each week the
   higher of hours + overtime and that week's commissions, plus tips; the
   losing side is kept as struck-out lines with the comparison),
   `hourly_plus_commission` (all of it: what Rotor paid).
7. **Adjustments and bonuses**: `pay_line` records as they are (void ones
   don't pay).

Rates: a person's own rate for the category; a technician with no rate at
all gets their service rate, else D3's $20 an hour ("standard $20 rate" on
the sheet); an owner or the office is paid only the rates set for them.
Commission rates are basis points (2500 = 25%).

## Periods, lock and late time

- A `pay_period` per start date (`ptr/period/{start_on}`; one or two
  weeks). The `payroll.recompute` sweep (bulk lane, daily 04:00) makes
  this week's period, works the open ones out again (their cached
  `totals`, for the list) and finishes locking shifts a lock left.
- **Open**: lines are worked out live on every read. **Lock** (only once
  the period is over): the lines and totals are frozen into the period
  record in one write (a crash can never leave half a pay run), its
  adjustments become approved, then its counted shifts become `locked` a
  batch at a time (`more: true` asks again; the screen does). **Unlock**
  (not once paid) reopens it, adjustments back to draft, shifts back to
  approved, the unlock kept in `unlocks`. **Mark paid**: the frozen lines
  and adjustments become paid.
- **Late time**: a shift that closes into a locked or paid week (a late
  clock-out, an offline replay, an approval) never changes it. The work
  module asks `payroll.periodStatus`, sets the shift `adjusted` and calls
  `payroll.addAdjustment`, which writes an adjustment line ("Late time", the
  hours at the person's rate) in the next open period, idempotent by
  `late:{timesheetId}`; the owners are told.

## Endpoints

| Route | Who | What |
|---|---|---|
| `GET /payroll/periods` | `payroll:read_all` | periods newest first, the current week |
| `POST /payroll/periods {start_on}` | `payroll:run` | start a period (a Sunday; one per week) |
| `GET /payroll/periods/:id` | `payroll:read_all` | totals, lines, people, warnings |
| `GET /payroll/periods/:id/sheet/:userId` | `payroll:read_all` | printable pay sheet (HTML; audited) |
| `GET /payroll/periods/:id/export.csv` | `payroll:read_all` | every line and each person's total (audited) |
| `POST /payroll/periods/:id/recompute\|lock\|unlock\|paid` | `payroll:run` | see above |
| `POST /payroll/periods/:id/adjustments {user_id, amount_cents, note, type, label?, client_id?}` | `payroll:run` | bonus or adjustment (open periods) |
| `POST /payroll/lines/:id/void` | `payroll:run` | strike an adjustment out |
| `GET /payroll/scoreboard?from=&to=` | `payroll:read_own` | the crew scoreboard; without `payroll:read_all`/`reports:read`, one's own row |
| `GET /me/pay?period=` (work's route) | `payroll:read_own` | one's own pay (payroll.myPay) |
| `GET /me/pay/sheet?period=` | `payroll:read_own` | one's own printable pay sheet |

Services: `payroll.addAdjustment`, `payroll.periodStatus`, `payroll.myPay`.
Home's "Needs you": "Pay periods to lock" (`payroll:run`).

## Settings

`cfg/payroll` (owner only): `week_starts: "sunday"`, `period_weeks: 1`,
`ot_threshold_hours: 40`, `ot_multiplier: 1.5`,
`commission_basis: "job_total_after_discounts"`, `commission_split:
"by_hours" | "equal" | "each_full"`, `tip_split: "equal"`,
`min_segment_minutes: 1`, `model_default: "hourly"`,
`scoreboard_user_ids: []` (empty: the people with the technician role, so
an owner who also goes out is left off), `scoreboard_pool_bp: 2000` and
`scoreboard_upsell_bp: 1000` (the "20% pooled by hours, +10% on upsells"
comparison, information only), `goals: { revenue_per_hour_cents: 12500,
reviews_per_week: 2, callbacks_pct: 2 }`. Each person's pay is
`user.pay = { model, hourly_cents: { service, sales, office },
commission_pct: { technician, salesman, upsell } (basis points), overtime }`.

## The scoreboard

Per person on it, over the dates: jobs finished and their value (shared by
timer minutes; equally over ranges longer than a month), service hours,
revenue per hour (goal $125), reviews credited to them (goal 2 a week),
upsells and their share, callbacks (touch-up jobs; goal under 2%), and what
the pooled comparison would pay.

## Sweeps, queue kinds and listeners

`payroll.recompute` (bulk, daily 04:00, CRM-only records). No listeners:
tips are read from the payments when a sheet is worked out.

## Automations

None.

## Import phases

`payroll.payroll` (row 31, entity `payroll`, after the team, jobs and
timesheets): each Rotor payroll **run** (`paid_at`) becomes one paid
`pay_period` spanning the weeks its lines fall in (totals per person), and
each paid line a `pay_line` with Rotor's `line_key` and type kept
(`line_type`; a record's own `type` is "pay_line"), label "Job #0000516"
(never the customer's name), `rotor.payroll_line_id`. Estimated (unpaid)
hourly lines are skipped: the CRM works those out. Pay rates come from the
team phase (`system.rates`).

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com` emails); logs carry counts and codes, never a name, phone, email, address or amount tied to a person.
