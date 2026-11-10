# CRM module: import

Milestone: M2c (+ M8 cutover). Status: stub (created in M1.1; the import track fills it in).

What it does: the Rotor import framework: staging, id map, dedupe review, reconciliation report, parallel run and cutover.

Code: `netlify/lib/crm/modules/import/` (server), `crm-app/modules/import/` (client screens).
Record types: import_run.

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
