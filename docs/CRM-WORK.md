# CRM module: work

Milestone: M4a (office) + M4b (field). Status: stub (created in M1.1; the work track fills it in).

What it does: jobs, visits, scheduling, assignment, checklists, photos, timers, timesheets and availability.

Code: `netlify/lib/crm/modules/work/` (server), `crm-app/modules/work/` (client screens).
Record types: job, visit, checklist_template, time_off (types.mjs, M4a); timer, timesheet (types-field.mjs, M4b).

The CRM build rules (docs/CRM.md, "Modules") ask this file to stay current with:

## Endpoints

None yet.

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
