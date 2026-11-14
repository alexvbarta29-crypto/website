# Switching from Rotor to the CRM

Milestone: M8 (design §10.9, §11.4, §11.6). This page is the owner's
runbook in plain words, then how it works.

**Rotor stays exactly as it is.** Nothing in the CRM calls Rotor, changes
it or cancels it. Everything that changes Rotor (switching off its
automations, moving the texting number, cancelling the subscription) is
something you do yourself, in Rotor or at Twilio, and then tick on the
CRM's checklist. Until you type SWITCH TO CRM, every text, email and charge
the CRM would make stays in the Outbox as "would have sent".

Where it is: **Settings → Import & data → Import from Rotor → Switch from
Rotor** (owners only). The page has the checklist, the preview, the
documents in flight, the switch, going back, and a **Runbook** button with
the steps below.

## Before switch day

1. **Turn on the daily import.** Import from Rotor → **Automatic daily
   import** → Make the key. It is shown once: copy it into the scheduled
   job's key file on the computer that holds the exports (outside the
   website's folder). Every day that job exports Rotor (read-only), packs it
   and runs `build/crm_import_upload.mjs` with the key. Each import adds
   what's new and applies Rotor's changes; nothing is deleted; anything
   changed on both sides waits for you on the Conflicts screen. You get a
   note when each one is done. Revoke the key there any time.
2. **Work through the checklist.** Green items the CRM checks itself:
   - the CRM's Netlify settings (Production only),
   - the background worker running,
   - an off-site backup in the last 8 days,
   - Stripe, Twilio and email connected and set to live (Settings →
     Integrations),
   - the final import done in the last 24 hours with nothing to settle,
   - the preview approved.

   Tick boxes only you can confirm (you do these outside the CRM):
   - Netlify: Deploy Previews and branch deploys off, the CRM's secrets set
     for Production only,
   - texting for (763) 314-3400 moved to Twilio (the hosting order active),
     10DLC approved, HELP text set, YES removed from the opt-in keywords,
   - autopay cards checked in Stripe (95% or more verified, card links sent
     to the rest),
   - a Meta lead path live and tested (Zapier into the CRM's lead webhook),
   - agreement templates approved,
   - the Jan 1 billing comparison matched (the CRM's preview against
     Rotor's Jan 1 charges, line by line),
   - Claude's Barta skill and scheduled tasks use the CRM connector,
   - the website's Client Portal links point to /p/login,
   - the documents in flight sent,
   - **Rotor's automations switched off by you** (do this last, right
     before the switch).

   The switch button stays grey until every item is green.

## Switch day (Monday January 4, Central time)

| When | What |
|---|---|
| Sun 18:00 | The final full export from Rotor (read-only), the photo copy (below), pack and upload. |
| Mon 06:00 | A last export since Sunday and the final import. Settle anything on the Conflicts screen. Twilio moves 314-3400's texting at 06:00: from then on Rotor can't text from it. |
| 06:30 | **Make the preview** on the final import. Read the counts per day; approve them when they look right. |
| 07:00 | **Documents in flight**: make each list (quotes sent in the last 30 days, Rotor's open invoices, unsigned agreements). Each becomes a bulk send under Approvals: test-send it to yourself, then confirm. The texts point the customer to bartawindowwashing.com/p/login, which texts them their own link. |
| Before 09:45 | In Rotor, switch off its workflows yourself (new-lead text, reminders, overdue texts) and tick that box. Then, in one sitting, tap **Switch to the CRM** and type **SWITCH TO CRM**. |
| Right after | Smoke tests: a text and an email to your test contact, the one-dollar live charge and its refund, a website test lead, a text and a STOP from a staff phone, a push to each owner. |
| 10:00 | The first reminder batch goes out from the CRM. Watch the Outbox, the automation log and Settings → Data today. |
| First 48 hours | If something is badly wrong: **Switch back to Rotor** (type **SWITCH BACK TO ROTOR**). The CRM goes back to report-only. Turn Rotor's workflows back on. What the CRM made meanwhile is listed on the page for you to enter in Rotor. |
| Until Jan 11 | Check Rotor's inbox twice a day for replies that landed before the number moved. |
| Feb 3 | Cancel Rotor yourself, only after the last messages import (keep Rotor readable at least 30 days). |

## What the preview tells you

For the 72 hours from the switch, per automation and per day: how many
texts, emails, invoices and charges would go out. The counts already
leave out:

- anything Rotor already sent: its REMINDER texts (matched to the visit on
  the date they name), overdue texts (the invoice they name), receipts (the
  payment that day) and agreement reminders count as sent;
- anything the import brought in that was done or due before the switch:
  jobs Rotor completed are never asked for a review, Rotor's invoices
  are never sent overdue reminders, and agreements Rotor sent get no
  automatic unsigned reminders (both go in the in-flight list instead: the
  switch-day re-request is their one);
- follow-ups and sends that were waiting in dry-run: they are cancelled at
  the switch, never resumed.

Jobs Rotor scheduled are counted with review requests: once the CRM
completes them after the switch, the customer is asked like for any CRM
job. An agreement the CRM sends after the switch gets its daily reminders
(up to 7) as usual.

It also shows the next job, invoice and quote numbers (they continue after
Rotor's), and lists the automations that only run on new activity (a new
lead, a booking, a payment). Counts come before quiet hours and opt-outs:
the CRM can only send fewer.

## Photos and attachments (switch day)

Rotor keeps photos and message attachments in its file storage. The copy
tool downloads them into the export folder so the last pack carries them:

```bash
node build/crm_media_copy.mjs ~/barta-private/rotor-export --urls ~/barta-private/rotor-export/media-urls.jsonl --switch-day
```

- It **refuses to run without `--switch-day`** and refuses any folder inside
  the website's repository.
- The URL list has one line per file: `{ "url", "source":
  "message_attachment" | "quote_photo", "ref_id", "name" }` (written by the
  export next to the entity files).
- Each file is saved as `media/<sha256 of the URL>` with its checksum in
  `media/index.jsonl` (the shape the pack reads). Three tries a file on a
  network error or a busy answer; failures are counted, never fatal; run it
  again and it fetches only what is missing or damaged.
- https only, file-storage hosts only (`*.supabase.co`, or `--allow-host`),
  never Rotor's app or API, at most 25 MB a file. It prints counts only.
- Then pack and upload as usual: the pack copies the files of 4 MB or less.

## How it works (for the integrator)

Code: `netlify/lib/crm/modules/import/{cutover,cutover-preview,autokey}.mjs`,
screens `crm-app/modules/import/{cutover-checklist,cutover-preview,cutover-runbook,auto-key}.js`,
scripts `build/crm_import_upload.mjs` (the automatic key) and
`build/crm_media_copy.mjs`. Tests: `tests/crm/flows/cutover.test.mjs`,
`tests/crm/flows/rehearsal.test.mjs`, `tests/crm/import/{autokey,media-copy,cutover-screens}.test.mjs`.

### State

- `sys/mode` (core): `system_of_record`, `cutover_n`, `cutover_at`
  (`rolled_back_at`, `rolled_back_n` after a rollback).
- `sys/cutover` (CAS): `ticks` (the owner's items, `{ at, by }`), `preview`
  (`run_id`, `status`, `at`, `import_run_id`, `computed_at`, `totals`,
  `approved_at`, `approved_by`), `history` (each switch and rollback: kind,
  n, op id, lane run id, status), `in_flight` (each list's bulk run),
  `rollback_list` (what the CRM made since the switch, after a rollback).
- `cutover/preview/{runId}`: one preview's full result (write-once).
- Every tick, switch and rollback is also an event on `evt/sys/cutover/`.

### The checklist

`checklist()` works the auto items out on every read: `setupStatus()`, the
lanes' last pass (`sys/health`, 3 hours), `offsite_at` (8 days), each
integration live with its live keys (`INTEGRATION_SECRETS`), the latest
finished import (24 hours, 0 conflicts along its chain, none running), and
the preview (`previewCurrent`: made on that import, in the last 24 hours,
approved). Off the production site (a rehearsal on a test copy) the
production-only items read "rehearsal" and pass, and the integrations pass
in test mode with test keys. `POST /cutover/run` checks the same list
again; any red item answers 409 with the keys.

### The switch: op `cutover--{n}`

A bulk-lane run (`cutover.switch`, id derived from the op) steps the
journaled op (`defineOp("cutover")`, `core/ops.mjs`), as the owner who
typed SWITCH TO CRM (a person's op: exempt from the parallel-run guard).
Steps, each journaled: `numbers` (next = 1 + the highest number taken in
`ptr/{job,invoice,quote}-no/`, invoices below 100000 only, never lower than
`seq/*` is; `setSequence`), `seed` (`seedPlan`: Rotor's texts of the last 30
days through the inbox index and each conversation's messages, matched by
indexes; `done/` markers written onlyIfNew with `result:
"seeded_from_rotor"`), `dry_sends` (deletes every queue item whose marker is
in `done-dry/`), `follow_ups` (`sales.stopAll` for each contact with an open
enrollment that isn't a test contact), `settings` (`cfg/automations.
effective_from`, `cfg/intake.mode = "crm"`, `cfg/dashboard.source = "crm"`),
`mode` (`sys/mode`). A storage error leaves the op running; the next pass
(or `ops.resume`) goes on from the journal, so nothing is done twice.

The seeded keys are the automations' own step keys:
`done/visit.reminder_14d|2d/{visitId}--{date}` (14-day when Rotor's text
went out 5 or more days before the visit), `done/invoice.overdue/{invoiceId}--{n}`,
`done/payment.receipt/{paymentId}`, `done/agreement.unsigned/{agreementId}--{date}`.
Live sends check `done/`; dry-run markers (`done-dry/`) are never read by a
live send.

### Rollback and re-cutover

`POST /cutover/rollback` (SWITCH BACK TO ROTOR, within 48 hours of
`cutover_at`) runs `rollback--{n}`: `sys/mode` back to rotor, intake
`dual`, the dashboard on Rotor, the list of invoices, quotes and visits made
or changed since the switch (indexes only) for re-entry in Rotor, and the
`rotor_off` tick and the preview's approval cleared. A later switch is
`cutover--{n+1}`: a newer import first, the checklist again, and the
numbers step re-seats each sequence above every number taken meanwhile
(Rotor's, through the import, and the CRM's own).

### In-flight documents

`GET /cutover/in-flight` counts the contacts on each list (quotes sent or
viewed in the last 30 days, Rotor's open invoices with a balance, sent and
unsigned agreements); `POST /cutover/in-flight/:kind` makes one bulk run
(`core/bulk.mjs`: preview, a required test send, an owner's confirm) with
the module's template `cutover_quote`, `cutover_invoice` or
`cutover_agreement` (and `cutover_new_number` for the D1 fallback number).
The texts carry no per-document link (links are bearer secrets and never
stored on a record): they send the customer to `/p/login`.

### Endpoints (owners: `cutover:run`)

| Route | What |
|---|---|
| `GET /cutover` · `POST /cutover/check` | the checklist, mode, preview state, history, rollback window, the typed words |
| `POST /cutover/ticks` | `{ key, done }` an owner item |
| `POST /cutover/preview` | `{ at? }` → 202 `{ run_id }` (bulk lane) |
| `GET /cutover/preview` | `{ state, result }` |
| `POST /cutover/approve-preview` | the preview must be done and current |
| `POST /cutover/run` | `{ confirm: "SWITCH TO CRM" }` → 202 `{ run_id, op_id, n }` |
| `POST /cutover/rollback` | `{ confirm: "SWITCH BACK TO ROTOR" }` → 202 `{ run_id, op_id, n }` |
| `GET /cutover/in-flight` · `POST /cutover/in-flight/:kind` | the lists; a bulk run for one |

### Not built here (on purpose)

- Anything that changes Rotor: the owner does it and ticks it.
- Switching the integrations to live: the owner connects each provider in
  Settings → Integrations; the checklist requires it on the production site,
  so the switch never turns on a provider nobody connected.
- The office's "Rotor (read-only)" label and the public site's Client
  Portal links: integrator changes (shared files).
