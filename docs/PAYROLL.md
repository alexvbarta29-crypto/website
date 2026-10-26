# Payroll Sheets (/payroll)

The owner's crew pay sheets: pick a pay period and get a pay sheet for each
tech (hours by day, every shift, tips, bonuses, a note), then download them as
a PDF to print.

- **URL:** https://www.bartawindowwashing.com/payroll — not linked from the
  site, not in the sitemap, and served with `noindex`.
- **Served by** `netlify/functions/payroll.mjs`. The page is
  `netlify/lib/payroll-page.mjs`, generated from `build/payroll/payroll.html`
  by `python3 build/make_payroll_page.py` (edit the HTML, then regenerate).
  It is not a static file, so it can't be reached without signing in.
- **Data:** `GET /payroll/data?start=YYYY-MM-DD&end=YYYY-MM-DD` answers only a
  signed-in browser. It reads Rotor's open API (`netlify/lib/payroll-rotor.mjs`):
  `/open-api/timesheets` for hours and `/open-api/serviced-jobs` for tips.

## Setup (Netlify → Site configuration → Environment variables)

| Variable | What it is |
|---|---|
| `PAYROLL_PASSWORD` | **Required.** The sign-in password. Until it is set, /payroll says it isn't set up. Changing it signs every device out. |
| `ROTOR_PAYROLL_API_KEY` | **Required.** A Rotor API key (Rotor → Integrations) with the `timesheets:read` and `jobs:read` permissions. Falls back to `ROTOR_API_KEY` if unset, but that key is the lead form's and usually lacks these permissions. |
| `PAYROLL_DEFAULT_RATE` | Hourly rate in dollars for everyone. Default `20`. |
| `PAYROLL_RATES` | Per-person overrides as JSON, keyed by full name as in Rotor (or Rotor user id), e.g. `{"Gustov Huotari": 21}`. |
| `PAYROLL_OWNERS` | Comma-separated names hidden unless "Include owners" is ticked. Default `Alex Barta, Jacob Barta`. |

Redeploy after changing any of these.

## How pay is worked out

- **Hours:** each Rotor timesheet, clock-in to clock-out to the second.
- **Hourly pay:** hours × rate, rounded to the cent per shift, the same way
  Rotor's payroll run pays it.
- **Tips:** the tip on each succeeded payment for a job whose first visit is
  in the pay period, split evenly between the technicians on that job.
- Rotor's open API has no pay rates, commission or "paid" status, so rates
  come from the variables above, and commission isn't shown. Add anything
  else (a bonus, gas money, a deduction) as an adjustment on the sheet;
  adjustments and notes are kept in that browser only.
