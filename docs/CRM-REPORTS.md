# CRM module: reports

Milestone: M7b. Status: stub (created in M1.1; the reports track fills it in), with the leaderboard and My performance since the Nov 2026 layout.

What it does: daily rollups, KPI reports and the dashboard feed.

Code: `netlify/lib/crm/modules/reports/` (server), `crm-app/modules/reports/` (client screens).
Record types: none (derived ix/reports rows).

The CRM build rules (docs/CRM.md, "Modules") ask this file to stay current with:

## The leaderboard and My performance (Nov 2026)

- **Leaderboard** (`#/leaderboard`; the Menu, or a tab; `reports:read`, so
  never a technician's list): Rotor's podium. A period (Today, This week,
  This month, This year) and the measure: Sales, Revenue, Avg,
  Agreements, Auto-pay, Techs. The top three on a podium (initials), then
  every rep: rank, name, "n sales · x% signed" and the amount; you are
  outlined in coral; Unassigned last when it has anything.
- **My performance** (`#/performance`; the Menu; anyone, their own):
  Flyra's. "Sold in November" with the big amount (or "Nothing sold this
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

## Services

- `reports.leaderboard({ metric, from, to })` → `{ metric, from, to,
  people: [{ id, name, first_name, initials, color, role, sales,
  sold_cents, avg_cents, plans, signed, signed_pct, agreements, autopay,
  arr_cents, jobs, visits, done_cents, value, rank }], unassigned }`
  (metric: sales, revenue, avg, agreements, autopay, techs). The
  Leaderboard and Home's card (`has()`/`call()`) use it.

## Endpoints

| Route | Who | What |
|---|---|---|
| `GET /leaderboard?metric=&period=today\|week\|month\|year` | `reports:read` | the board, plus `period` and `me` |
| `GET /me/performance?period=week\|month\|year` | anyone (their own) | sold, the running total by day, jobs, plans, average, ARR, the streak |

Tests: `tests/crm/reports/leaderboard.test.mjs` (and budget samples).

## Settings

None yet.

## Sweeps, queue kinds and listeners

None yet.

## Automations

None yet.

## Import phases

None yet.

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com` emails); logs carry counts and codes, never a name, phone, email, address or amount tied to a person.
