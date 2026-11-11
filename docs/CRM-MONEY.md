# CRM module: money

Milestone: M5 (design §5.6, §6.2, §8.1, §8.5, §9.2 money screens, §10.2
rows 27-30, §10.8, §11.4 "M5 Money"; decisions D2, D3, D28, D31-D33).
Invoices, payments, tips, refunds, deposits, account credit, the card on
file, the 1st-of-month autopay run and its preview, the customer's pay and
card pages, "Collect payment" on a visit, the texts about money, and the
Rotor import of invoices and payments, reconciled to the cent.

Code: `netlify/lib/crm/modules/money/` (server),
`netlify/lib/crm/adapters/payments-stripe.mjs` (the Stripe driver),
`crm-app/modules/money/` (screens), `crm-app/portal/money-invoice.js`,
`money-card.js`, `money-dry.js` (the customer's page scripts).
Record types: `invoice`, `payment`, `credit`, `autopay_run`.
Tests: `tests/crm/money/` and `tests/crm/flows/quote-to-invoice.test.mjs`
(`npm test`), the phone checks in `tests/e2e/money.spec.mjs` (`npm run e2e`).

## The owner's Stripe rules

Rotor stays exactly as it is, and Barta's Stripe account may be the one
Rotor charges through. So, whatever else this page says:

1. **Nothing calls Stripe** unless payments are explicitly in **Test** with
   a test key (`sk_test_` / `rk_test_`) or **Live** after the switch from
   Rotor with a live key. Until the owner connects keys everything is **Dry
   run**: a practice Checkout page (`/p/dry-checkout/...`) stands in for
   Stripe and nothing leaves the site. A live key in the test slot is never
   used; "Live" picked while Rotor is in charge stays dry run (it is never
   quietly turned into test), and Settings → Payments refuses the switch.
2. **In any mode** the CRM never updates or deletes a Stripe customer or
   payment method, never attaches or detaches a card, and never touches a
   charge it didn't make. The only Stripe customers it reads back or takes
   events for are its own (made by the CRM, or by Stripe for the CRM's own
   Checkout). Webhook events about anything else (Rotor's charges, refunds,
   disputes, sessions) are ignored and counted
   (`sys/health.stripe_foreign_events`, shown in Settings → Payments).
3. The Stripe driver is tested only against a mocked fetch
   (`tests/crm/money/stripe.test.mjs`, `shared-account.test.mjs`).
4. **Before the switch, money moves only for a sandboxed customer**: a test
   contact, or a contact made in the CRM that the import never linked.
   Everyone Rotor bills gets "would" rows: no Checkout, no charge, no
   invoice made by the worker, no reminder. Rotor's own invoices and
   payments (the import's) are read-only here until the switch.

`money/gate.mjs` decides the mode on every path; `mayMoveMoney()` is the
rule in point 4.

## What the office sees

Menu → **Money**: Invoices, Payments, Autopay. (Money has no bottom tab.)

- **Invoices** (`#/invoices`): what's waiting to be paid and what's past
  due, in dollars; chips Open · Overdue · Draft · Card failed · Overpaid ·
  Paid · Void with counts; search by name or number. On a wide screen an
  invoice opens beside the list.
- **Invoice** (`#/invoices/:id`): lines, totals, payments, the card on
  file, history (issued, sent, reminders, card tries). Buttons by state
  and login: Send (text, email), Record a payment (cash, check, other, a
  tip), Charge the card, Text a card link, Refund (owners), Keep the extra
  as credit (owners), Write off and Void (owners). An invoice from Rotor
  says so and has no buttons until the switch. An invoice typed in for a
  customer Rotor bills can have cash written down on it; its card button is
  off.
- **New invoice** (`#/invoices/new`): the customer, lines, a draft or
  "Issue and send". Invoices for finished jobs make themselves.
- **Payments** (`#/payments`): a month at a time: what came in after
  refunds, tips, card fees, refunds, by method. Practice payments are
  listed, marked "test", never counted.
- **Autopay** (`#/autopay`): what the 1st would bill, plan by plan (Card
  charged, Invoice only, No card, Paused, Billed by Rotor), and past runs.
- **Contact → Money**: open balance, account credit, the card on file,
  invoices, payments; New invoice, Add credit, Text a card link.
- **Visit → Collect payment** (the office and the visit's own techs):
  what's left, cash or a check with a tip, or a QR code the customer scans
  to pay by card on their own phone. A payment needs signal: it is never
  kept for later.
- **Home**: Needs-you rows "Card payments that failed", "Invoices past
  due", "Invoices waiting to be paid", and for owners "Overpayments to
  refund or keep"; a strip with what's owed, what's past due and what came
  in this month. The tech's Today shows "Balance due" on a stop whose
  customer owes money.
- **Settings → Payments** (owners): the mode and why, which Stripe keys
  Netlify has (kinds only, never a value), the webhook addresses, how many
  of Rotor's events were ignored, and the money settings below.

## What the customer sees

All through the portal (a link in a text or email; no Stripe URL is ever
sent):

- `/p/invoice/{id}`: the invoice, what's been paid, a tip for the crew
  (No tip, 10%, 15%, 20%, Other), "Save this card for my plan" when they
  have a plan, **Pay**. Pay starts a fresh hosted Checkout (1 hour). While
  a card charge is running or a bank payment is clearing, Pay is off and
  the page says why.
- `/p/invoice/{id}/receipt/{payment}` and `/p/receipt/{id}`: a receipt.
- `/p/card`: add or replace the card (or bank account) on file.
- `/p/return?cs=`: after Checkout ("Paid. Thank you!", "Your bank payment
  is on its way", "You're all set").
- `/p/dry-checkout/{session}`: the practice Checkout (dry run only): pay
  with a test card, by bank (clears on the next pass), by a bank payment
  that fails, a declined card, cancel.

## Rules

- **Money is integer cents.** An invoice's `applied` map has one entry per
  payment or refund; paid, refunded, tips, balance, excess and the status
  (`open` ⇄ `paid`) are worked out from it by one pure function
  (`balance.mjs derive`). Only `succeeded` entries count. `draft`, `void`
  and `uncollectible` are a person's.
- **One payment, one record.** A payment's id derives from its provider
  object (`pi:` PaymentIntent, `re:` refund, `c:` the request's uuid for
  cash and checks), so the charge's own answer, Stripe's events and the
  return page all land on one record. A status only moves forward (pending
  → processing → succeeded | failed | canceled); receipts and tips fire on
  the write that moved it, once.
- **When invoices are made**: a finished billable job gets one (its id
  derives from the job), issued and sent at once unless
  `cfg/money.auto_issue` is off. Plan visits follow the plan's billing
  mode: `after_visit` every visit when done; `barta_standard` the first
  visit when done and the rest on the 1st of their month; `first_of_month`
  all on the 1st. A visit already billed by the 1st's run is not billed
  again; one done before its run is billed when done.
- **Numbers** continue Rotor's after the switch (`INV-`, start
  `invoices.mjs INVOICE_START`, deposits `D-`); before it the CRM's own
  practice invoices are `SINV-`, `SD-`.
- **Charging the card on file** is one resumable attempt: lock the invoice
  (10 minutes), expire the customer's open Checkout Sessions, re-read the
  balance, charge it with Idempotency-Key `charge:{attempt}`, record. A
  failed autopay charge is tried again after `retry_days` (3 and 7), then
  an owner gets a task. The customer gets the card link text.
- **Bank payments (ACH)** are `processing` for days: no receipt, no second
  Checkout, no charge meanwhile. Cleared → paid and the receipt; failed →
  open again and the "card didn't go through" text.
- **Refunds** (owners): partial or full, never more than amount + tip (the
  amount is reserved on the payment first, so two owners can't pass it);
  the invoice amount first, then the tip; a card refund goes through
  Stripe, cash and checks are only recorded.
- **Tips** are worked out on the server from the choice and the balance
  (a custom tip is capped at the balance and at
  `tip_custom_max_cents`), never part of the invoice, and split evenly
  across the techs on the visit (`payment.tip_split`: Payroll reads it).
  Deposits and fees take no tip.
- **Overpayment**: an invoice paid twice keeps the extra as a held credit
  row and one task for the owners: refund it, or keep it as credit.
- **Account credit** comes off the next invoice by itself. An admin can
  give up to `credit_cap_admin_cents`; owners any amount.
- **Deposits** (`money.createDepositInvoice`, called when a quote with a
  deposit is approved): a deposit invoice and its Checkout; the job's
  invoice later takes it off (a `deposit_credit` line), once.
- **The card on file** remembers where it was saved (practice, Stripe's
  test data, live): it is never charged in another mode.
  `money.cardStatus` is what lets a plan that wants a card turn active.

## Endpoints

Staff API (`/api/crm/...`; session, permission in brackets):

| Method and path | What |
|---|---|
| GET `/invoices` [invoices:read_all] | `?status=open\|overdue\|draft\|failed\|overpaid\|paid\|void\|uncollectible\|closed\|all`, `?year=`, `?contact=`; counts and totals in `meta` |
| POST `/invoices` [invoices:write] | `{ contact_id, lines[{ description, unit_cents, kind? }], kind?, job_ids?, issue?, channels?, use_credit?, client_id }` |
| POST `/jobs/:id/invoice` [invoices:write] | the job's invoice now |
| GET `/invoices/:id` [invoices:read] | the invoice, payments, card, flags, what this login can do |
| PATCH `/invoices/:id` [invoices:write] | If-Match; a draft's lines, `due_on`, notes |
| POST `/invoices/:id/issue` · `/send` [invoices:send] | `{ channels }` |
| POST `/invoices/:id/void` · `/write-off` [invoices:void] | owners; void needs `{ reason }` |
| POST `/invoices/:id/charge` [payments:charge] | 202 `{ run_id }` |
| POST `/invoices/:id/payments` [payments:record] | `{ method: cash\|check\|other, amount_cents, tip_cents?, reference?, client_id }` |
| GET `/payments` [invoices:read_all] | `?month=`, `?method=`; the month's totals in `meta` |
| GET `/payments/:id` [invoices:read_all] | with its refunds |
| POST `/payments/:id/refund` [payments:refund] | `{ amount_cents, reason, client_id }` |
| GET · POST `/contacts/:id/credits` [invoices:read_all · credits:issue] | `{ kind, amount_cents, note, client_id }` |
| POST `/credits/:id/keep` [payments:refund] | keep a held overpayment |
| POST `/contacts/:id/card-link` [invoices:send] | text the card link |
| GET `/money/contacts/:id` · `/money/summary` [invoices:read_all] | the contact's tab; a period's money |
| GET `/money/status` · POST `/money/payments-mode` [settings:owner] | the mode; `{ mode: dry_run\|test\|live\|off }` |
| GET `/autopay/preview` · `/autopay/runs` · `/autopay/runs/:id` [invoices:read_all] | `?month=` |
| GET `/visits/:id/payment` · POST `/visits/:id/payments` · `/visits/:id/pay-link` [payments:record] | Collect payment (a tech: their own visits only) |

Webhooks (Stripe's signature; open only while payments run in that mode):
POST `/api/crm/hooks/stripe` (live), `/api/crm/hooks/stripe-test` (test).

Portal: GET `/p/invoice/:id`, `/p/invoice/:id/receipt/:payment`,
`/p/receipt/:id`, `/p/card`, `/p/dry-checkout/:session`; POST
`/api/portal/invoices/:id/checkout` `{ tip_choice, custom_tip_cents?,
save_card? }`, `/api/portal/card/checkout`,
`/api/portal/dry-checkout/:session` `{ action, method }`.

Services: `money.createDepositInvoice`, `money.cardStatus`,
`money.reconcileImport`. Events: `invoice.issued`, `invoice.sent`,
`invoice.paid`, `payment.processing`, `payment.succeeded`,
`payment.failed`, `payment.refunded`, `card.saved`.

## Settings

`cfg/money` (Settings → Payments, owners): `auto_issue` (true),
`receipt_email` (true), `overdue_every_days` (3), `overdue_max` (5),
`tip_options_bp` ([0, 1000, 1500, 2000]), `tip_custom_max_cents` (50000),
`ach` (true), `retry_days` ([3, 7]), `statement_descriptor`,
`credit_cap_admin_cents` (10000), `late_cancel_fee_cents` (5000).
The payments mode is `cfg/integrations.payments.mode` (set through
`/money/payments-mode`, which checks the keys and the switch).

## Sweeps

| Key | When | What |
|---|---|---|
| `money.autopay` | the 1st, 9:00 | the month's run (resumed every pass until done; late if the 1st was missed) |
| `money.autopay_preview` | the 28th, 9:00 | next month's preview kept on the run; the owners are told |
| `money.retry` | daily 9:00 | failed autopay charges whose retry day came |
| `money.invoice_backfill` | hourly | finished jobs of the last 30 days with no invoice |
| `invoice.overdue` | daily 10:00 | reminders |
| `card.expiring` | daily 10:05 | off by default |
| `money.dry_settle` | every pass | practice bank payments clear or fail |
| `money.reconcile` | daily 3:30 (bulk) | every invoice's `applied` map against its payment records |
| `money.stats` · `money.stats_lifetime` | hourly · daily 3:40 (bulk) | each customer's open balance and lifetime paid, from the indexes |
| `payments.verify_cards` | Mondays 5:00 (bulk) | read-only card check; only with a real driver |

## Automations and templates

`invoice.sent` (`invoice_sent`, `invoice_sent_email`; an autopay invoice
waits for its charge instead), `invoice.overdue` (`invoice_overdue`),
`payment.receipt` (`payment_receipt`, `payment_receipt_email`),
`payment.failed` (`payment_failed`), `card.expiring` (`card_update`, off),
and `card_link` for the office's "Text a card link". All go through the
core sender (the Outbox while texts are in dry run).

## Import phases

`money.invoices` (row 27), `money.credits` (row 30: credits on Rotor's
invoice lines, as history), `money.payments` (row 28). Row 29 (Stripe
customer ids) comes in with contacts. Invoices keep Rotor's number, lines,
status and dates; each payment lands in its invoice's `applied` map, so
paid and balance are worked out here and compared: the import report's
money section must show no difference in count or cents by status, method
and year (`money.reconcileImport`; a difference fails the report).
Payments with no customer or invoice go on one placeholder contact so the
sums still add up. A second run of the same export changes nothing.

## Owner actions

1. Nothing is needed for dry run: it is the default.
2. To try Stripe's test mode: in Netlify (Production context only) set
   `STRIPE_TEST_SECRET_KEY` to a **test** key and
   `STRIPE_TEST_WEBHOOK_SECRET` to the signing secret of a test-mode
   webhook pointing at
   `https://www.bartawindowwashing.com/api/crm/hooks/stripe-test`, then
   Settings → Payments → Test. Only test contacts and customers Rotor
   doesn't bill can be used.
3. For the switch from Rotor: `STRIPE_SECRET_KEY` (a restricted live key)
   and `STRIPE_WEBHOOK_SECRET` for
   `https://www.bartawindowwashing.com/api/crm/hooks/stripe`; Live can be
   picked only after the switch.
4. Before the switch, compare the Autopay preview for January with
   Rotor's January 1 charges, line by line.

## Data rules

- No card number ever reaches the CRM (hosted Checkout only; no Stripe
  script on Barta's pages). A long account number typed into a payment's
  reference is masked.
- Key values are never shown, logged or stored outside Netlify's settings.
- Practice payments (`simulated`) never count in any total.
- Fixtures and tests are synthetic; nothing in git is a customer's.
