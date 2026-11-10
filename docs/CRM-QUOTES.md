# CRM module: quotes

Milestone: M3a (design §5.3, §8.1-§8.5, §9.2 quote screens, §10.2 rows 4,
5 and 18, §11.4 "M3a Quotes"; decisions D15, D26, D30). The price book, the
Barta pricing engine, discounts scoped by visit, quotes with one-time and
plan options side by side, frozen versions, the customer's quote page with
one signature, Present to customer, approval by phone, and conversion into
a plan or jobs once those modules exist.

Code: `netlify/lib/crm/modules/quotes/` (server), `crm-app/modules/quotes/`
(screens), `crm-app/portal/quotes-quote.js` (the customer's page script).
Record types: `quote`, `quote_version`, `price_item`, `discount_def`.
Tests: `tests/crm/quotes/` (`npm test`) and the phone checks in
`tests/e2e/quotes.spec.mjs` (`npm run e2e`).

## What the office sees

- **Quotes** (More → Quotes; `quotes:read`): chips Open (draft, sent,
  viewed, changes asked), Draft, Sent, Viewed, Changes asked, Approved,
  Booked, Declined, Archived, with counts; a search by name or number. Each
  row: name, number, sent / viewed when, the first-visit price, the status.
- **A contact's Quotes tab**: that contact's quotes and **New quote**.
- **New quote / Edit** (`quotes:write`), phone first:
  1. Who and where: the contact and one of their properties.
  2. Measure: **Count panes** (a counter per window type with its weight
     from `pane_weights`: standard 1, slider 2, large 2, sliding door 2,
     French 0.4, front door 1, small garage window free; the total rounds
     up and updates as you tap) or **By square feet** (gives the tier "Up
     to 40 panes (2500 to 3499 sq ft). Confirm the panes on site.").
  3. Services: exterior, interior, screens (estimated at half the panes
     unless counted), tracks (standard / premium, how many), gutters (a
     typed price), and "also offer a plan" (none, biannual, quarterly,
     monthly). Anything else comes from the price book.
  4. **Price it**: the engine fills a one-time option and, with a plan,
     a plan option next to it (quarterly: exterior on visits 1, 3, 4,
     interior on visit 2, the plan discount every visit). Warnings say what
     to confirm on site (screens estimated, over the last tier, sq ft only).
  5. Options (up to 3, one recommended): lines from the price book or
     custom, each with which visits it covers, optional add-ons the
     customer can tick; discounts from the catalog (or a typed amount for a
     price match); the totals per visit, for the term and for a year. A
     line's total can be changed only with `prices:override` and a reason.
  6. Notes for the customer, notes for the office, photos and the Light
     Studio mockup.
  The card and deposit section is hidden until the Money module (M5).
- **Lights quote** (`#/quotes/:id/lights`): runs in feet from Light Studio,
  or one package price; colors; Early Bird (until the deadline in effect),
  3-year contract; every season (a lights plan) or this season only. "Add
  to the quote" puts it on the quote as its own option.
- **A quote**: number, status, who, where, good through; the timeline
  (made, sent, opened, changes asked, approved, booked); the actions its
  status allows: **Send** (text and/or email), **Present to customer**,
  **Approved by phone**, **Edit**, **Declined**, **Archive** / Restore,
  **Duplicate**, **Customer view** (the customer's page, opened in a new
  tab), **Book it** (only once Plans or Scheduling exist; until then it
  says "Turning this into a job arrives with Scheduling"). Then what the
  customer sees (the latest version) and the version list.
- **Settings → Pricing & price book** (owners): the exterior tiers, interior
  per 20 panes, screens, tracks, the plan discount per visit, lights per
  foot, Early Bird percent and deadlines, the 3-year discount, how long a
  quote is good, "book it right after the customer approves"; the price
  book's items (price, unit, description, on/off, sellable).
- **Settings → Discounts**: the catalog (amount or percent, which visits by
  default, one per option for the plan discounts), and the Rotor names kept
  for history.

## What the customer sees

- **`/p/quote/:id`** (a quote link from the text or email, portal cookie
  scope `quote`): "Hi Jordan, here's your quote", good through, the options
  as cards (the recommended one picked), line by line with which visits
  each covers, add-ons to tick with the price changing as they tick, a
  plan's visit prices and what a year costs, a note from us, the plan
  agreement (for a plan) and the terms, then **Approve your quote**: full
  name, one signature with a finger, "I agree", Approve. "Processing your
  approval…" follows the run; then "You're all set!" (and, once Money
  exists, a link to add a card). "Want something changed?" and "Not
  interested?" send their answer. An approved, declined, expired or
  archived quote says so instead of offering Approve.
- **`/p/present/:token`** (Present to customer): the same page on the
  staff phone, "Hand the phone to Morgan", no cookie, single use, 15
  minutes; approval is recorded as in person by that staff member; then
  "Back to the quote (staff)". The link is used up once the approval went
  through (later requests get 410).
- Every page passes the portal CSP (`script-src 'self'`, no inline script:
  the page's data rides in an escaped `data-quote` attribute) and the
  portal headers (no-store, noindex, no referrer, frame-ancestors none).
  GET pages never change anything; "viewed" is the page beacon
  (`definePortalBeacon("quote")`).

## Endpoints

Staff API (`/api/crm`), all `quotes:*` unless noted:

| Method and path | What |
| --- | --- |
| `GET /pricing/context` | pricing, price book, discounts, features (deposits, convert), SMS mode, the Early Bird deadline |
| `POST /pricing/suggest` | engine lines for windows or square feet, services and a plan |
| `POST /pricing/totals` | totals of one option |
| `POST /pricing/lights` | lights lines, Early Bird and 3-year discounts |
| `GET/POST /pricebook`, `GET/PATCH /pricebook/:id` | price book (`pricebook:edit` to change) |
| `GET/POST /discounts`, `GET/PATCH /discounts/:id` | discount catalog (`pricebook:edit` to change) |
| `GET /quotes?status=&contact=&year=`, `POST /quotes` | list, create (`client_id` makes a retried create land once) |
| `GET /quotes/:id`, `PATCH /quotes/:id` (If-Match) | a quote with contact, properties, versions, features; edit (a sent quote goes back to draft) |
| `POST /quotes/:id/send {channels}` | freezes a version, emits `quote.sent` (`quotes:send`) |
| `POST /quotes/:id/approve {option_id, by_phone}` | approved by phone: a run |
| `POST /quotes/:id/convert` | a run: `plans.fromQuoteOption` or `work.createJobs` |
| `POST /quotes/:id/present` | `{url, expires_at}`: single use, 15 minutes |
| `GET /quotes/:id/versions[/:vid]` | frozen versions |
| `POST /quotes/:id/archive · restore · decline · duplicate` | lifecycle |
| `GET /quotes/:id/preview` | the customer's page for staff (portal CSP) |

Portal (module `portalRoutes`):

| Method and path | Scope |
| --- | --- |
| `GET /p/quote/:id` | quote |
| `POST /api/portal/quotes/:id/approve` | quote (body up to 400 KB: the signature PNG, at most 200 KB) |
| `GET /api/portal/quotes/:id/runs/:run` | quote |
| `POST /api/portal/quotes/:id/changes`, `/decline` | quote |
| `GET /api/portal/quotes/:id/files/:file` | quote (the quote's photos and mockups only) |
| `GET /p/present/:token`, `POST /api/portal/present/:token/approve`, `GET .../runs/:run`, `GET .../files/:file` | present |

Services provided: `quotes.price`, `quotes.totals`,
`quotes.approvedVersion`, `quotes.applyOffer(quote_id, offer,
{enrollment_id}, ctx)` (offers `followup_50`, `ten_free_screens`; adds the
discount to every option and freezes a new version when the quote was
sent) and `quotes.archive(quote_id, {reason: "no_response",
enrollment_id}, ctx)` (Sales' day-4 archive; removes the offers).

Services used when present (feature-gated, faked in tests):
`plans.agreementForOption`, `plans.fromQuoteOption` (M3b),
`work.createJobs` (M4a), `money.createDepositInvoice` (M5). Before M4 a
one-time quote stays approved and makes no jobs; before M5 deposits and
"require card" are hidden and refused.

Events: `quote.sent`, `quote.viewed`, `quote.approved`, `quote.declined`,
`quote.changes_requested`, `quote.archived`, `quote.converted` (payload
`{quote_id, version_id, contact_id, ...}`; Sales listens).

## Approval

- The customer approves the version they saw: the POST carries
  `version_id` and `version_sha256`; a newer version answers 409
  `updated` and the page reloads.
- The approval is an op with a deterministic id
  (`approve--{quote}--{version}`) and a run with an id derived from it:
  double taps, retries and replays land on the same run and record once.
  The signature PNG is stored once under an id derived from the op.
- Steps: record the approval (status `approved`, who, how, when, IP hash,
  the option and ticked add-ons), then the deposit (only with Money), then,
  with "book it right after approval" on and a module to book it, the
  convert run (`convert--{quote}`), which is idempotent the same way.
- The approved version is what conversion uses (`quotes.approvedVersion`).

## Settings

`cfg/pricing` (owner; `settings:owner`): `exterior_tiers` (max panes,
cents: $275 / $295 / $395 / $495 / $595 up to 20 / 40 / 60 / 80 / 100),
`sqft_tiers`, `interior.per_segment_cents` ($80 per 20 panes),
`screens.{each_cents, estimate_ratio}`, `tracks.{standard_cents,
premium_cents}` ($8 / $15, D26), `pane_weights`,
`plan_discount_per_visit_cents.{biannual, quarterly, monthly}` ($50 /
$100 / $150), `lights.{install_per_ft_cents, materials_per_ft_cents,
early_bird_bp, deadlines, three_year_off_cents, colors}`,
`discount_floor_cents` (a visit's floor, $0), `quote_expiry_days` (30),
`auto_convert` (true). A change applies to the
next quote; sent and imported quotes keep their prices.

## Sweeps, queue kinds and listeners

- `quotes.expire` (fast lane, daily 02:10 Chicago, mutates): open quotes
  past `expires_on` are archived with reason `expired` (imported quotes
  under the parallel-run guard get a would- row instead).
- Attention: "Quote changes requested" (count of open quotes with changes
  asked).
- Pushes: `quote_approved`, `changes_requested`.

## Automations

- `quote.sent`: mints the quote link (good until the quote expires plus
  `lifetimes.quote_after_expiry_days`) and sends one message per channel
  the office picked (`quote_sent` text, `quote_sent_email` email) through
  the core sender; until cutover they land in the Outbox (dry-run). Each
  send's key is `{quote}--{event}--{channel}`, so a retried event sends
  once; it rechecks that the quote is still open before sending.

## Import phases

Against the M2c runner (docs/CRM-IMPORT.md):

- `quotes.price_book` (after `contacts.leads`; source `pricebook:fold`):
  every Rotor price-book template id seen on a quote line is attached to
  the seeded item its title names (`rotor_template_ids`); one already
  attached stays where it is.
- `quotes.discounts` (after `quotes.price_book`; source
  `discounts:fold`): every discount name seen lands on the seeded
  catalog's `rotor_names` (D15); a name nothing matches becomes a
  non-sellable definition.
- `quotes.quotes` (after `contacts.properties_quotes`,
  `sales.opportunities`, `quotes.discounts`): quotes with their options,
  lines (ids kept), discounts and status; prices stay as Rotor had them
  (`override.reason: "imported"`); Rotor's one option per quote becomes a
  one-time or plan option by its frequency; a warning
  `quote_total_differs` when our first-visit total doesn't match Rotor's.
  Imported quotes get no frozen versions. A contact with no deal gets
  one. An
  unchanged re-run writes nothing. Imported quotes carry `rotor_id`, are
  mirrored, and the parallel-run guard keeps automation from changing them.

## Data rules

- Money is integer cents; quantities are thousandths (`qty_milli`);
  rounding is half-up; percentages apply before fixed amounts; a visit
  never goes below the floor.
- Quote numbers: `SQ-0001` (shadow numbers) until the CRM is the system of
  record, then `Q-n` from the shared sequence.
- An approved quote never changes; a sent quote edited goes back to draft
  and the next send freezes a new version (an unchanged quote reuses its
  version).
- Customer-facing text in Barta's voice: no em dashes, "insured", the
  satisfaction guarantee is a free re-clean.
- Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
  emails); logs carry counts and codes, never a name, phone, email,
  address or amount tied to a person.
- No Rotor calls: the import reads files the owner exported; nothing here
  writes to Rotor.
