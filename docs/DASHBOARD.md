# Barta Office → Dashboard (/dashboard)

The first tab in Barta Office. KPI dashboards built from Rotor, in five views:

- **Overview**: money collected this year vs last, weekly trend, a "Needs
  attention" list (draft invoices, overdue payments, quotes waiting, quotes
  never sent, sold jobs with no date), and the headline KPIs with the MiNT
  targets (close rate 40–50%, average ticket $300+, 50%+ recurring).
- **Money**: collected by month (each month vs the same month a year earlier),
  per week, this month so far, average ticket, refunds.
- **Sales**: leads per week, close rate, how quotes turned out, where leads and
  new customers come from.
- **Plans**: recurring plans, plan value on the books, plan mix, who sold them,
  new agreements per month, cancellations.
- **Jobs**: visits this week and the next 4 weeks, sold jobs not scheduled,
  draft invoices, jobs by status, visits by month (seasons).

Every chart has hover/tap details and a "Show table" view.

## How the numbers stay private

This repo is **public**, so the numbers are never committed in the clear.

- `build/office_dashboard.mjs` turns Rotor's report results into one snapshot
  of totals only (no customer names, phones, emails or addresses) and
  **encrypts** it with the public key `build/office-dashboard-public.pem` into
  `netlify/data/office-dashboard.sealed.mjs`.
- Only the site's server can open it, with the private key in the Netlify
  environment variable **`OFFICE_DATA_KEY`** (`netlify/lib/office-data.mjs`).
  It's an X25519 key, 44 characters. Keep it that short: Netlify gives all of
  a site's function environment variables 4KB **in total** (an AWS Lambda
  limit), and going over it makes every deploy fail. The first version of
  this used a 3.3KB RSA key and did exactly that.
- `/dashboard` needs the office sign-in and is never cached or indexed.

### One-time setup

In Netlify: **Site configuration → Environment variables → Add**
`OFFICE_DATA_KEY` = the key Claude gave you (44 characters). Redeploy. Until
then the Dashboard tab says "Almost there". If the key is ever lost, make a
new pair with `newKeyPair()` from `netlify/lib/office-data.mjs`, put its
`publicKeyPem` in `build/office-dashboard-public.pem`, set its `privateKey` in
Netlify, and refresh the snapshot.

## Refreshing the numbers

The snapshot is a picture of Rotor at one moment ("updated …" at the top).
To refresh, Claude runs these Rotor connector reports (company time zone,
America/Chicago), saves each result under its key in a `raw.json` **outside
the repo**, then runs `node build/office_dashboard.mjs raw.json` and commits
the new sealed file:

| key in raw.json | Rotor call |
|---|---|
| `as_of` | today, `YYYY-MM-DD` |
| `payments_by_month` | report_payments, last 12 months (1st of the month 11 months back → end of this month), group_by month |
| `payments_by_month_prev` | the same, one year earlier |
| `payments_ytd_by_type` | report_payments, Jan 1 → today, group_by type |
| `payments_ytd_by_type_prev` | the same dates one year earlier |
| `payments_by_week` | report_payments, the last 12 weeks (Monday start) → today, group_by week |
| `leads_by_week` | report_leads, the same 12 weeks, group_by week |
| `leads_by_source` | report_leads, last 12 months, group_by source |
| `customers_by_source` | report_customers, last 12 months, group_by source |
| `invoices_by_status` | report_invoices, last 12 months, group_by status |
| `jobs_by_status` | report_jobs, last 12 months, group_by status |
| `visits_by_month` | report_visits, last 12 months, group_by month |
| `visits_next_weeks` | report_visits, next Monday-start week → 4 weeks out, group_by week |
| `plans_created_by_month` | report_service_plans, last 12 months, group_by month (empty months may be dropped) |
| `plan_cancellations` | report_service_plans, last 12 months, date_field cancelled_at |
| `quotes_by_status` | list_quotes limit 1 for each status (draft, sent, approved, converted, rejected, modification_requested); use `pagination.total` → `{ "draft": n, ... }` |
| `members` | list_company_members → `[{ user_id, name }]` |
| `service_plans_active` | list_service_plans active=true, limit 100 (all pages) → `{ "data": [...] }` |

Rotor's own data starts when Rotor went live (Aug 2026), so leads and plans
only go back that far; payments go back further.
