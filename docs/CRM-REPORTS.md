# CRM module: reports

Milestone: M7b. Status: built (Nov 2026), waiting for the integrator's merge; the leaderboard and My performance since the Nov 2026 layout.

What it does: daily rollups, the Reports screen (revenue, sales, leads,
plans, jobs, team, money owed, payroll) with the period before, charts and
CSV, the dashboard feed (`dashboard-raw`) and the `cfg/dashboard.source`
switch.

Code: `netlify/lib/crm/modules/reports/` (server), `crm-app/modules/reports/` (client screens).
Record types: none (derived `ix/reports/daily/{yyyy-mm}` documents).
Tests: `tests/crm/reports/` (`reports.test.mjs`, `leaderboard.test.mjs`,
`budget-samples.mjs`).

## The Reports screen (`#/reports`, Menu → Reports; `reports:read`)

Owners and the office (a technician's "own" `reports:read` opens no
report). Tabs (scroll sideways on a phone): **Revenue · Sales · Leads ·
Plans · Jobs · Team · Owed · Payroll** (Payroll only with
`payroll:read_all`). A date range (This week, This month, Last month, Last
3 months, This year, Last 12 months, or any days up to a year) and By day /
week / month (Auto picks: up to a month by day, up to three by week, else
by month). Each tile shows the number, the period of the same length just
before it (▲/▼ and "was …", green when it moved the good way) or its goal
from barta-rules §5. A chart drawn like Home's (two lines, a readout on
tap, a hidden table for screen readers), the tables, and Export CSV.

| Tab | Tiles | Tables |
|---|---|---|
| Revenue | Collected, Invoiced, Work completed, Tips, Refunded, Payments | by period; work by service; collected by customer source; by method |
| Sales | Quotes sent, won, Sold $, Close rate (40-50%), Average ticket ($300), Plans sold | by person (`sold_by`: sent, won, sold $, close rate, plans started and their value); by lead source |
| Leads | New leads, New customers, Time to first touch (median, business hours), Plan adoption (50%+) | by source (leads, became customers, quotes, won, close rate); first-touch speed |
| Plans | Active, MRR, ARR, Started, Cancelled, Churn (under 2%) | by plan; active plans each night |
| Jobs | Jobs and visits completed, Work completed, Average ticket, Revenue per tech-hour ($125+), Callbacks (under 2%) | by period; per person |
| Team | Service hours, Job value, Revenue per hour, New reviews | the crew: hours, job value, per hour, reviews a week, callbacks |
| Owed | Owed, Past due, Open invoices, Over 60 days (right now) | aging (not due, 1-30, 31-60, 61-90, over 90 days late); largest balances (open the invoice) |
| Payroll | Total pay, Hours, Overtime hours, Tips paid out | pay periods starting in the range; per person |

Definitions (design §5.9): **Collected** = succeeded payments and their
tips − refunds, by `received_on` (the same count as GET /money/summary);
**Work completed** = billable jobs finished, totals after discounts, by the
day they finished; **Average ticket** = work completed ÷ billable jobs;
**Close rate** = quotes won (approved or converted) ÷ (won + declined), on
the day they last changed, by seller (`sold_by`, an imported Rotor rep
matched by name) and by the customer's source; a plan started counts for
the seller of that customer's latest sold quote; **MRR** = Σ active plans'
yearly value ÷ 12; **Churn** = plans cancelled in the period ÷ active at
its start; **Revenue per tech-hour** = job value split equally between the
crew ÷ their service hours; **Callbacks** = touch-up jobs ÷ (billable jobs
+ touch-ups); **Time to first touch** = business minutes (Mon-Fri 8-6, Sat
8-5, holidays off) from a lead coming in to its first text, call or
contact. Practice (simulated, dry-run) payments, a test contact's records
(`flags.test`, D35) and vendors never count. Imported Rotor records count
like the CRM's own.

## Rollups (`rollup.mjs`)

One row per local day (design §5.9's daily row: revenue, refunds, tips,
fees, by method and source; work completed, jobs, callbacks, by service;
visits; invoices issued; leads and customers new by source; first-touch
minutes; quotes sent, won, lost, by source and by seller; plans started,
cancelled; per person minutes, job value, jobs, callbacks, reviews;
reviews new and their rating), kept per month in
`ix/reports/daily/{yyyy-mm}` (derived: never backed up, rebuilt at will).
A month is built from the indexes only (payments, visits and timesheets
of the month; jobs, invoices and quotes of its year and the open shards;
plans, contacts, reviews and users; about 13 reads) the first time it is
asked for, then served from its copy: a past month for good, the current
month for 10 minutes. The `reports.rollup` sweep (bulk lane, daily 01:30)
rebuilds yesterday's month final and adds what only the night knows: the
active plans and MRR at the end of the day, and each of yesterday's leads'
first-touch minutes (from their contact's stats). A rebuild keeps those.
`POST /reports/rebuild {from, to}` builds months again (after an import
brings older records, for one).

Leads and customers by source read the contacts index row's `ca` (the
contact's `created_at`, Rotor's date for an imported one; added by M7b).
Rows written before it lack `ca` until the next reindex
(Settings → Data → Reindex) or their next change.

## The dashboard feed and its switch

`GET /reports/dashboard-raw?as_of=YYYY-MM-DD` (and the service
`reports.dashboardRaw`) returns exactly the `raw.json` keys
`build/office_dashboard.mjs` reads (docs/DASHBOARD.md), each in Rotor's
`report_*` shape (`{ range, totals, buckets: [{ key, count, sum_cents }] }`):
`payments_by_month(_prev)`, `payments_ytd_by_type(_prev)` (`invoice` gross,
`refund`), `payments_by_week` and `leads_by_week` (12 Monday weeks),
`leads_by_source`, `customers_by_source`, `invoices_by_status` (Rotor's
words: draft, open, sent, overdue, partially_paid, paid, void, failed),
`jobs_by_status` (Pending, Scheduled, In Progress, Completed, Cancelled),
`visits_by_month`, `visits_next_weeks`, `plans_created_by_month`,
`plan_cancellations`, `quotes_by_status`, `members` (the team's names) and
`service_plans_active` (frequency, sale value in dollars, seller id).
Aggregates only: no customer names.

`netlify/functions/dashboard.mjs` reads `cfg/dashboard.source`: `"rotor"`
(the default) opens the sealed Rotor snapshot as before; `"crm"` builds
the picture live with `buildSnapshot(dashboardRaw(today))`, kept in memory
10 minutes. If the CRM can't answer (its stores not set up, an error) the
sealed snapshot is shown, so the Dashboard tab never breaks. The owner
flips it on **Settings → Dashboard numbers** (`#/settings/dashboard`).

## Services

- `reports.dashboardRaw(as_of)` → the raw keys above.
- `reports.series` (Home's charts from the rollups, `core/services.mjs`
  contract) is written (`reports.mjs` `seriesFor`) but not provided yet:
  Home doesn't ask for it, and core's registry test keeps one contract
  service unprovided.

## The leaderboard and My performance (Nov 2026)

- **Leaderboard** (`#/leaderboard`; the Menu, or a tab; `reports:read`, so
  never a technician's list): Rotor's podium, in Flyra's cards and the
  app's two themes. A period (Today, This week,
  This month, This year) and the measure: Sales, Revenue, Avg,
  Agreements, Auto-pay, Techs. The top three on a podium (initials), then
  every rep: rank, name, "n sales · x% signed" and the amount; you are
  outlined in coral; Unassigned last when it has anything.
- **My performance** (`#/performance`; the Menu; anyone, their own):
  Flyra's (its dark card with a soft glow at the top right and "Barta" in
  the corner). "Sold in November" with the big amount (or "Nothing sold this
  month"), the running total from the 1st to today as a line, three tiles
  (Jobs: $ and how many; Plans: $ and how many; Average job and the yearly
  plan money, ARR), the streak (days in a row with a sale) with this
  month's days as a grid ("3 of 12 days with a sale"), a period (This
  week, This month, This year) and Share (the phone's share sheet, else a
  copied summary).
- Where the numbers come from (`leaderboard.mjs`; indexes only, about 6
  to 10 storage calls): **sold** is a quote approved or turned into work
  (the quotes index's "open" shard and the year's), on the day it last
  changed, credited to its seller (`sold_by`: a user id, or for an
  imported quote Rotor's rep name, matched to a person by name or first
  name; anyone else is Unassigned); its value is the plan's yearly amount
  for a plan option, else the first visit. **Plans** set up in the period
  are credited to the seller of that customer's latest sold quote
  (signed: the agreement signed; autopay; ARR: the plan's sale value).
  **Techs**: jobs finished in the period (the jobs index's year), their
  total split between the people on them, and visits done (the visits
  index's months). Imported Rotor records count like the CRM's own.

## Services (the leaderboard)

- `reports.leaderboard({ metric, from, to })` → `{ metric, from, to,
  people: [{ id, name, first_name, initials, color, role, sales,
  sold_cents, plans_sold, jobs_sold, avg_cents, plans, signed, signed_pct,
  agreements, autopay, arr_cents, jobs, visits, done_cents, value, rank }],
  unassigned, rows }` (metric: sales, revenue, avg, agreements, autopay,
  techs). The Leaderboard uses `people`.
- Home's card (`has()`/`call()`) asks the same service as
  `{ board: "sales" | "techs", period, month: "yyyy-mm", from, to }`:
  board sales is the sold money (a plan's yearly amount, else the first
  visit), techs the jobs done in dollars; `from`/`to` win, then `month`
  (that calendar month, up to today), then `period` (default this month).
  It reads `rows: [{ user_id, name, first_name, initials, color, count,
  value_cents, arr_cents, note, rank }]`: only the people with something
  to show, best first, the note a short line ("2 plans sold, 1 job sold",
  "5 jobs done"). Both shapes come back on every call.

## Endpoints

| Route | Who | What |
|---|---|---|
| `GET /leaderboard?metric=&period=today\|week\|month\|year` | `reports:read` | the board, plus `period` and `me` |
| `GET /me/performance?period=week\|month\|year` | anyone (their own) | sold, the running total by day, jobs, plans, average, ARR, the streak |
| `GET /reports/summary?from=&to=` | `reports:read` | the headline tiles with the period before |
| `GET /reports/:name?from=&to=&group=day\|week\|month` | `reports:read` (payroll: also `payroll:read_all`) | revenue, sales, leads, plans, jobs (`ops`), team, owed, payroll (`money` = revenue) |
| `GET /reports/:name.csv?...` | the same | the report's tables and series as CSV (an audited export) |
| `POST /reports/rebuild {from, to}` | `reports:read` | those months' rollups built again (up to 36) |
| `GET /reports/dashboard-raw?as_of=` | `reports:read` | the dashboard feed |

## Settings

`cfg/dashboard` (owner only): `{ source: "rotor" | "crm" }`, default `"rotor"`.

## Sweeps, queue kinds and listeners

`reports.rollup` (bulk lane, daily 01:30; derived `ix/` rows only, so
`mutates: false`).

## Automations

None yet.

## Import phases

None yet.

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com` emails); logs carry counts and codes, never a name, phone, email, address or amount tied to a person.
