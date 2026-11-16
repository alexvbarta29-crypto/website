# CRM module: contacts

Milestone: M2a (design §5.1, §6.7, §6.8, §10.2 rows 6-12 and 36, §11.4).
People and businesses, their properties, tags, sources and consent;
matching and merging duplicates; and lead intake: the website's quote
form, the giveaway, referrals and referral claims, and Meta lead ads
through Zapier.

Code: `netlify/lib/crm/modules/contacts/` (server),
`netlify/lib/crm/adapters/maps-google.mjs` (geocoding),
`crm-app/modules/contacts/` (screens). Record types: `contact`,
`property`, `merge_candidate`. Tests: `tests/crm/contacts/`.

## What the office sees

- **Customers** (Menu → Customers; the list was titled Contacts): each
  person a two-tone card (Rotor's): the name, a filled status pill (Active
  green, Lead blue, Former orange), their plan or service in a grey pill,
  a lower band with FREQUENCY (the plan's, or One-time) and SINCE (customer
  since), round Call and Text buttons. On a phone the header has Rotor's
  round buttons (search, filter, archived, the coral +): the search field
  opens in place, the chips, the count and "possible duplicates" are in
  the filter sheet, and there are no letter headings or letter rail; a
  desk keeps them all on screen. Instant search over every contact on
  the phone (name, phone, email, street, tags; every word must match),
  chips All · Leads · Customers · Plan members · Former · Archived and the
  common sources, letter groups with a letter rail. Archived contacts only
  show under Archived. "Search notes and messages" runs a deeper search in
  the background. The first slice's Customers list stays one tap away at
  the bottom until the Rotor import goes live. On a computer (1,000 px and
  up) a contact opens beside the list, which keeps its search and scroll
  (`split: true`, docs/CRM.md "Home and navigation").
- **A contact** (Nov 2026: the screen open while a customer is on the
  line, so its top answers the call; Nov 13: laid out like **Flyra's lead
  page**). On a phone the round back button sits alone at the top; then
  the avatar, the name big and "Lead since Nov 12, 2026" / "Customer since
  ..." with an **Edit** pill, a plan badge ("Quarterly plan", "Christmas
  lights plan +1", or "..., not signed yet"); plain rows with grey labels:
  **Mobile** (round Message and Call buttons), **Email**, **Address** on
  two lines (a round Directions button); the property **from above** (the
  map module's keyless aerial, USGS by default, centred on the property's
  map point with a coral dot and a small "Satellite" label, for someone
  who may open the map, `canvass:use`; the tiles are fetched through the
  map's `connect-src` hosts and shown as `blob:` images, so the CSP needs
  nothing new; no map point or no tiles: no picture); Flyra's **action
  bar**, four cells with thin lines between: **Call · Message · Quote ·
  Book** (**Mark lost**, red, on a lead with an open deal: it opens the
  deal, whose screen asks why; Email and Directions take Quote's and
  Book's places for someone who may not quote or book); then **Lead
  details** (the open deal's Value, the follow-up as Pipeline and its
  step as Stage, the next visit, the Source) or **Customer details** (the
  plan, **Balance owed**, **Lifetime spend**, **Next visit**, the Source),
  a card with an Edit pill. "-" when not known; the money two only with
  `invoices:read_all`, and `GET /contacts/:id` leaves `stats.money` out for
  anyone else. The numbers come from the contact's stats (one read, the
  contact's own route budget); a nearer next visit from the work section,
  the deal and follow-up from the sales section (its `header()`). On a
  computer the header stays compact (the name, the plan, the buttons; the
  rows are in Details). **A street-level photo** of the house (Nov 2026):
  Google Street View, else the satellite, with a Street | Aerial switch,
  in the CONTACT card (docs/CRM-MAP.md "The house picture"); without
  Google, the keyless satellite as before.
  Then ONE scrolling page of headed sections, no sideways tabs, in this
  order: **Upcoming visits** (work: the visits ahead, a plan's marked
  "Plan"; one-time jobs; recent visits); **Service plan** (plans, apart
  from one-time work, a green edge); **Quotes and invoices** (quotes, then
  invoices and payments); **Properties** with their access notes (gate
  code, pets, stories, parking, notes); **About to be sent** (what the
  modules know is queued: the visit reminders still to go out at their
  default 10:00 two weeks and two days before, the follow-up texts and
  emails due; "Automated texts are paused" when they are); **Follow-ups and
  tasks** (sales); **Details** (notes, how to reach them, texts and email
  consent, about: source, owner, customer since, Rotor link; Edit, Merge
  with…, Pause automated texts, Archive / Restore, owners' "Mark as test
  contact"); **Messages** and **Activity** (calls, texts, visits, payments,
  website requests and notes in one list). A long list shows the latest
  four and **Show all**. With 680 px of room (a container query: a contact
  may sit beside the list) the messages and activity get their own column,
  and on a desk the header stays put while the page scrolls. Old links to
  a tab (`#/contacts/{id}?tab=money`, or a tab remembered from before)
  scroll to its section. A technician sees the header (name, town, Call,
  Text, Email, Directions) and the properties of their visits.
- **New lead** (the coral + button): name, phones, email, address, where
  they came from, how they heard, tags, text consent, notes. A phone or an
  email already on file (or the same name and ZIP) shows **Possible
  duplicate** with the matches first.
- **Quick lead** (technicians, from the + on Today): name, phone, address,
  what they want, a note. The lead goes to the office; the tech never sees
  whether that number is already on file (a merge candidate goes to the
  office instead).
- **Property**: address and Directions, where it sits in the service area
  (distance from Delano, once Maps is live), access notes (gate code, pets,
  parking), **Counts for quoting**, the lights profile.
- **Counts for quoting** (`assets.mjs`, `property.assets`): windows by type
  outside and inside (standard, slider, large, sliding door, French, front
  door, small garage: the builder's types), the weighted pane totals the
  engine prices (`panes_ext`, `panes_int`), screens, tracks and premium
  tracks, stories, square feet, gutter feet, downspouts, roofline feet for
  lights, the ladder, notes (ladder, access), the services and plan last
  quoted, and where they came from (`from`: by hand, or the approved quote).
  **Edit counts** (`contacts:write`) saves them with the totals worked out
  from the windows. An approved quote fills them by itself (`quote.approved`:
  the builder's measure and the approved option's ticked lines; stories,
  gutters, the ladder and the notes stay as counted). **Re-quote**
  (`quotes:write`) opens a new quote for the property already measured,
  ticked and priced (one tap): `#/quotes/new/<contact>?property=<id>&requote=1`.
- **Merge review** (Menu → Customers): possible duplicates, most certain first; each
  pair stacked with the differing fields highlighted. Keep the first /
  Keep the second / Not the same person. Bulk: dismiss every unlikely pair
  (type DISMISS), merge every very likely pair whose first names match
  (type MERGE; the customer, or the older contact, is kept).
- **Settings → Lead webhooks** (owners): the links Zapier posts Meta leads
  to. Shown once, kept only as a hash, revocable.
- **Settings → Intake mode** (owners): where website leads go. See below.

## Website leads (the dual-write)

`netlify/functions/lead.mjs`, `claim.mjs`, `netlify/lib/giveaway-rotor.mjs`
and `referral-notify.mjs` call **Rotor first, exactly as before**. Then
`contacts/hook.mjs` decides about the CRM:

| Situation | What happens |
|---|---|
| Production without `CRM_PRODUCTION` / `CRM_KEY_SALT` (setup needed), or no CRM store | Nothing at all, not even a read |
| Intake mode **Rotor only** (the default) | Nothing (one settings read a minute, while Rotor answers; a failed read counts as "Rotor only" for 15 s) |
| **Rotor and the CRM** (`dual`) or **the CRM only** (`crm`) | The same lead goes through `intakeLead()` in process, with Rotor's lead id |

The visitor's answer: when Rotor accepted the lead it is Rotor's, and the
CRM write runs after the answer (`context.waitUntil`). When Rotor failed,
`dual`/`crm` try the CRM before answering: a lead the CRM kept answers 200
("kept" means a durable write for this request: the contact created or
changed, or its `intake` event written). Rotor's own call has no timeout
(and keeps none in "Rotor only"); in `dual`/`crm`, `watchRotor()` starts
the CRM write when Rotor has taken 5 s, without stopping Rotor's call, and
if Rotor still hasn't answered at 9 s (the platform stops the function at
10 s) a lead the CRM kept is answered 200. A lead that reached only one
side raises one owner alert per side on Today (`intake:crm_only` /
`intake:rotor_only`) that counts them and lists the latest ten with their
contact id and `intake` event (Settings → Data links each one), plus a
notification per lead that opens the contact ("Lead missing in Rotor", or
the reverse). Giveaway entries and coupon claims get tags, notes and the
coupon-texts opt-in only, never the new-lead cadence.

Bundling: `lead.mjs` now carries the CRM (about 700 KB unminified, 200 KB
gzipped, against 52 KB before). The CRM's modules are wrapped lazily by the
bundler, so nothing of them runs until a write is due; the cost is parsing,
about 40 ms more on a cold start (none on a warm one).

Turn it on when the first contacts import is in: Settings → Intake mode →
"Rotor and the CRM".

A quote form sent after a scan of a sign's or flyer's QR code (Sales →
Signs & flyers, docs/CRM-SALES.md) carries the `barta_q` cookie the scan
left; `hook.mjs` (`withScan`, the quote form only) hands it to the CRM's
copy of the lead, and intake gives a new contact `source.campaign` ("Yard
sign: Maple Grove") and `source.qr_code` through the sales services
`sales.qrResolve` / `sales.qrLead`. Rotor's request is built before and
never sees it.

## Intake (`intake.mjs`)

`intakeLead(input, { origin, rotor })` → `{ ok, contact_id, created,
event?, enrollment_id?, error? }`, never throws. `ok` only after a durable
write for this request (see above); `event` is the `intake` event's key. One address, one contact, even for
a double submit, the giveaway's two writes, a Zapier retry, or Meta and the
website for one person:

1. normalize; the address key is the HMAC of the phone (else the email);
2. a Meta leadgen id seen before → its contact, nothing else
   (`ptr/meta-lead/{sha256 of the id}`);
3. a lease per address, `lock/intake/{hk}` = `{ holder, lease_until, n }`
   (30 s); a request that finds it held waits up to 2 s, then goes on;
4. match by phone, then email (following merges); upsert onto the most
   recently updated non-archived match: only empty fields are filled, the
   note block is appended once, tags merged, consent granted only where it
   is unknown (a "no" is never overturned by a form); a write that keeps
   losing its CAS to other requests for the same person tries again (the
   upsert is fill-only, so a retry is safe);
5. else create, id `deriveId(contact, intake--{hk}, n)`, a shadow while
   Rotor is in charge; a retried request that lost its lease lands on the
   same id; when the only matches were archived, a merge candidate too; a
   new contact takes `owner_id` from the input when it names a user (a
   door-to-door canvasser's lead, docs/CRM-MAP.md; a match keeps its owner);
6. Rotor's lead id claims `ptr/rotor/lead/{id}`; without one the contact is
   marked `intake_pending_rotor` and the import links it by phone or email;
7. a new lead (or a returning customer whose request changed their record:
   new words, a new number) → `sales.enroll` once (when Sales is there) and
   `lead.created`; the same request again changes nothing and enrolls nothing;
8. the lease is released.

Before cutover, intake is automation (design §0 rule 12): on a contact the
import brought in it changes no field Rotor owns. It writes a
`would-update` row, keeps the request on the contact's timeline (an
`intake` event with the note) and still links Rotor's lead id.

## Merging (`merge.mjs`)

A merge is a background run around an op, `op/merge--{a}--{b}--{n}`
(survivor a): `b.merging_into = a` first (from then on everything that
resolves a contact lands on a), then a gains b's phones, emails, tags,
notes (under a dated heading), the earlier source, consent ("no" wins, else
the latest "yes") and whatever it was missing; each module's `onMerge`
runs once (this module moves b's properties and dismisses b's other merge
candidates); stragglers that arrived meanwhile are moved; stats are folded
(two Stripe customers are both kept, with an owner approval "Two Stripe
customers after merge"); b becomes a tombstone (`merged_into`, archived as a
duplicate), its portal links are revoked and `contact.merged` is emitted.
A merge started by a person is that person's action, also when the worker
finishes it.

Two contacts whose union the contact type would refuse (more than 10 phone
numbers, say) are not merged: the merge answers 409 before anything moves
(and the op's first step checks again). An op that still fails for good
(not a storage hiccup, which the run retries) releases b: `merging_into` is
cleared, its Rotor pointers come back from a, and a `merge_undone` event
says why, so b can be edited and merged again. What already moved to a
stays there.

## Endpoints

| Route | Who | What |
|---|---|---|
| `GET /contacts/index` | `contacts:read_all` (not techs) | every contact's index row; `If-None-Match` → 304 |
| `GET /contacts?q=&lifecycle=&tag=&source=&town=&plan=&cursor=&limit=` | `contacts:read_all` | filtered, sorted rows |
| `POST /contacts` | `leads:create` | office: a contact (409 `possible_duplicate` with the matches unless `force`); tech: a quick lead → `{ contact_id }` only |
| `GET /contacts/:id` | `contacts:read` (techs: their visits' contacts, tech fields only) | contact, stats, properties, and what other modules add |
| `PATCH /contacts/:id` | `contacts:write` | If-Match; 412 when someone else changed it |
| `POST /contacts/:id/archive` · `/restore` | `contacts:write` | archive revokes portal links; restore goes back to the lifecycle before |
| `GET /contacts/:id/activity?before=` | `contacts:read` | the timeline |
| `POST /contacts/:id/notes` | `contacts:write` | `{ text }`, appended under a dated heading |
| `PATCH /contacts/:id/consent` | `consent:edit` | `{ channel, state, source }`; emits `consent.changed` |
| `PATCH /contacts/:id/automations-paused` | `consent:edit` | `{ channel, paused, reason }` |
| `PATCH /contacts/:id/flags` | owners | `{ test }`: a test contact (the bulk-send test contact needs one) |
| `GET/POST /contacts/:id/properties`, `GET/PATCH /properties/:id` | `contacts:read` / `contacts:write` | a new address goes back in line for a map point |
| `POST /properties/:id/geocode` | `contacts:write` | Google once Maps is live; `{ skipped: "dry_run" }` before |
| `GET /properties/:id/requote` | `quotes:write` | what a new quote for the property starts from: `{ start: { measure, services, counts, plan, ready }, assets, counted_from }` |
| `GET /merge-candidates` | `contacts:merge` | pending pairs with both contacts' rows |
| `POST /merge-candidates/:id/merge` · `/dismiss` · `/merge-candidates/bulk` · `/contacts/:id/merge` | `contacts:merge` | merges run in the background (`GET /runs/:id`) |
| `POST /hooks/lead/:token` | the token | Zapier's Meta lead → intake → `{ ok: true }` and nothing more, so a token can't tell whether a number is on file (401 for a wrong or revoked token) |
| `GET/POST /intake/webhook-tokens`, `DELETE /intake/webhook-tokens/:id` | owners | the webhook links (the new one is shown once) |

Services: `contacts.intake`, `contacts.resolve`, `contacts.findMatches`,
`contacts.ensureProperty`. Events: `lead.created`, `contact.merged`,
`consent.changed`.

## Settings

- `cfg/intake` (owners): `mode` (`rotor` default, `dual`, `crm`) and
  `webhook_tokens` ([{ id, label, source, hash, created_at, created_by }]).
- `cfg/integrations.maps.mode` (owners, Settings → Integrations): `live`
  lets the server geocode with `GOOGLE_MAPS_API_KEY` (production only).
- `cfg/service_area` decides the tier: inside the radius "in the service
  area", up to a quarter past it "edge of the area", beyond it "outside"
  (flagged, never refused).

## Sweeps and listeners

- `contacts.stats` (bulk, daily 02:30, mutates): `customer_since` for
  customers without one; customer → former customer after 24 months
  without service, with no active plan and no visit ahead (it needs the
  Scheduling and Plans stats parts; report-only on imported contacts before
  cutover).
- `contacts.geocode` (bulk, every chunk, mutates derived fields only): up to
  10 properties waiting for a map point. Dry-run or off: no call. (Until
  Google Maps is live, the map module's `map.geocode` fills them from the
  US Census Bureau's batch geocoder, source `census`; a door-to-door pin
  converted to a lead gives its property the pin's point, source `pin`:
  docs/CRM-MAP.md.) Every property with a map point is a row of the
  `places` index (`{ c, la, ln, a }`), what the door-to-door map reads.
- Listeners `job.completed`, `payment.succeeded`, `quote.converted`,
  `plan.activated` (mutates): a lead or former customer becomes a customer
  (report-only on imported contacts before cutover) and `customer_since` is
  set.
- Listener `quote.approved` (mutates): the property's counts from the
  approved quote (`assets.mjs` `onQuoteApproved`); a would- row on a
  property the import brought in, before cutover.

## Automations

None of its own (`lead.ack`, `lead.alert` and `lead.attention` are Sales').
For the automation builder (docs/CRM-AUTOMATIONS.md), `tags.mjs`: the event
`contact.tagged` (`{ contact_id, tags: [the ones added] }`, event id from
`tags:{contact id}` and the write counter) after a person's edit adds tags
or a service call does, and the services `contacts.tag(contact_id, { add?,
remove? }, ctx)` and `contacts.setOwner(contact_id, user_id, ctx)` (store
writes: the backstop guards an automation's write to a contact Rotor owns).
Today's "Possible duplicates" count comes from this module's attention row.

## Import phases (design §10.2)

`import-rotor.mjs` exports `phases` for M2c's runner:
`contacts.customers` (row 6), `contacts.quote_contacts` (row 7: customers'
rows, before the leads, so a converted lead's pointer names its customer;
`contacts.quote_contacts_leads` does the leads' rows after
`contacts.leads`; both fill the contact's empty notes, the Meta lead form
and ad into `source.form` / `source.ad`, and Rotor's last call into the
sales stats; a converted lead an earlier import made a contact of its own
becomes a high-confidence merge candidate, never a silent move),
`contacts.leads` (row 8), `contacts.properties_quotes` /
`_plans` / `_visits` (row 10), `contacts.suppressions` (row 12: exact STOP
replies, before any comms phase), `contacts.giveaway` and
`contacts.referrals` (row 36). `placeholderContact()` (row 9) is for other
modules' phases. Row 10's phases run before the phases that make
placeholder contacts (opportunities, quotes, jobs, plans), so for an
address whose contact the export doesn't list they make the placeholder
and its pointer themselves: the property exists from the first import that
sees it, and the quote or visit is made at it. They match an address
against ALL of the contact's properties (`propertiesOf()` reads every one,
in batches; a screen asks for the newest 16), and they patch the row's own
quote, plan or visit with the property where an earlier import left it
without one (a fill, applied also when that record is otherwise
unchanged). Row 8 gives the lead's deal its `opened_at` (the lead's
creation) and keeps Rotor's `priority` and `stage` in `rotor` (a high
priority also as the tag "High priority"). Row 11 (the tag catalog) is derived from the contacts index
(`tagCatalog()`), not stored. Besides `records`, `pointers` and
`mergeCandidates`, a phase's output may carry `patches` (fill-only, list
unions, CRM-owned fields), `stats` and `suppressions`; `applyExtras()`
writes those (`only_if` guards a patch's `set` alone, so a guarded consent
grant is its own patch: row 7's muted channels pause automations whatever
consent says). Row 8 gives a lead that resolves to its own contact (an
earlier run's, or the website's dual-write with or without Rotor's id) the
full mapped record, so the runner applies field ownership (§10.7: a re-run
takes Rotor's edits, a linked intake contact fills its empty fields and
gains `import`); a lead that joins a customer's contact stays patch-only.
Rotor ids are lower-cased in pointer keys; Stripe customer
ids are hashed (keys are lower case and never hold an id that is itself a
secret-shaped value).

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails); logs carry counts and codes, never a name, phone, email, address
or amount tied to a person. No key holds phone digits or an email
(`tests/crm/contacts/keys.test.mjs`).

## The contact page's cards (extension point)

The contact page is Rotor's customer and lead profile (Nov 2026, Rotor's
screenshots 10-13 and 17). The profile (on a phone the top of the page; on
a desk with 760 px of room a 320 px left column that stays put): the name
with its pill (Active; a lead's priority, else the deal's stage), the
summary box (a customer: Lifetime value, Sale value, Frequency, Service
type; a lead: Stage, Est. value, Follow-up, Next visit), email and phone
rows (text, call, copy, send), Mute, "About to be sent", the primary
property and its satellite, notes, Source / Assigned / Tags / Created /
Converted (the rest under More details), then Create Customer (a lead),
Edit, Portal and `...`. Then Rotor's tabs (`PANES`, `LEAD_PANES`): Service
(tiles; Service Plans, Scheduled Jobs, Pending Jobs with Delay and
Schedule, Quotes, Requests, each with a red "+ New" pill; Properties),
Payments, Conversation (Messages, consent), Opportunities (Follow-ups,
Deals, Tasks), Activity (timeline, Calls), Files. Every other action is in
the header's round `...` (`more()` in `contact.js`; Archive and Mark lost
red at the end). A module adds its part
through its client manifest's `contactTabs` (the name stays from the tabs it
replaced): `{ key, label, order, load, place?, heading?, title?, perm? }`.
The module default-exports `{ load(params, ctx), cards?(state, ctx),
actions?(state, ctx), render(state, ctx), header?(state) → { plan?,
next_visit?, deal_id?, deal_status?, stage?, pipeline?, follow_up?,
enrollment_id? }, queued?(state) → [{ at, label, sub?, href?, icon? }] }`:

- `cards()` → `[{ key, tab?, title, add?: { label, short?, href | data },
  edit?, count?, body | null, empty? }]`: one card each (the round `+` is
  `add`; with `short` ("New Plan") it is Rotor's red "+ New Plan" pill; a
  `null` body shows the one-line `empty`). The card's key picks its tab and
  its place in Rotor's order (`PANE_CARDS`; an unknown key goes by `tab`,
  else Service); the first card of a module carries `#ct-mod-<key>`.
- `header()` may also give `sale_value` (cents), `frequency` and
  `service_type` (the plans part does) for the summary box; `tiles()` the
  Service tab's tiles.
- `actions()` → `[{ key, label, icon, href | run, data?, hint?, danger? }]`:
  rows of the `...`, grouped by `key` (call, follow, task / quote, book,
  plan, invoice, credit, cardlink; a lead's follow-up group first, a
  customer's booking group first).
- A module without `cards()` shows its `render()` as one card (Conversation
  for `place: "aside"`).

A state of `{ denied: true }` leaves the module out; `ctx.section` is true
and `ctx.contact` is the contact; setting `ctx.state.tabMod = null` and
calling `ctx.rerender()` loads that part again. Old `?tab=` links open the
module's card. Today: work (Scheduled Jobs, Pending Jobs), plans (Service
Plans), quotes (Quotes), service (Requests), money (Invoices, and a
customer's Payment), sales (Follow-ups, Deals, Tasks; Calls on Activity),
comms (Messages on Conversation). The Customers list: two-line rows on a
phone (LV; town, SV, assigned; Owes or the status), Rotor's table on a desk
(`tableColumns`, `tableRow` in `list.js`). Code:
`crm-app/modules/contacts/contact.js` (`contactSections`, `headerNumbers`,
`topPill`); tests: `tests/crm/contacts/sections.test.mjs`,
`tests/crm/contacts/screens.test.mjs`, `tests/e2e/layout.spec.mjs`,
`tests/e2e/contacts.spec.mjs`.

### A customer on a phone (Rotor's phone app)

Under 900 px a customer's page (not a lead's, not a technician's) follows
Rotor's phone app (the owner's Nov 15 screenshots), with Flyra's best bits:
three tabs, `PHONE_PANES` Details | Service | Activity, each part a caps
label (its count, a "+ New" pill) over a card (`phoneCard`), in
`PHONE_CARDS` order; a card not named there goes by its desk tab.

- The header: round back, Flyra's **Automations** switch (a header tool
  `{ switch, label, run }`, drawn by `topSwitch` in `core/router.js`; on:
  automated texts go out; off is Mute, the same pause sheet), the pencil,
  the `...`.
- **Details**: the name, Active and "Customer since"; TYPE ("Residential"
  or "Commercial" and the plan's service type), SALE VALUE (no money: the
  next visit), FREQUENCY, SOURCE; CONTACT (each phone: copy, text, call;
  each email: copy, the address mails; the primary property, a tap opens it,
  navigate; the satellite inside the card); Flyra's quick row Schedule ·
  Estimate · Invoice · Plan (a new job, quote, invoice, plan for them, each
  behind its permission); PAYMENT (Money's method on file: a BANK tile or
  the brand, "... ending in 1234", Bank account (ACH) or Card and its
  expiry, Added (`cardStatus().pm.added`), a black round button that texts
  a card link; none: Add Payment Method); Customer notes; About to be sent,
  More details (Source, Assigned, Tags, Lifetime value, the dates and the
  rest), Their portal; Properties; Files; Convert to Lead (back to Leads,
  everything kept) and Delete Customer (the archive sheet: they leave the
  lists, keep their history, can be restored; an archived one shows
  Restore).
- **Service**: SERVICE PLAN (the plan, its frequency, Duration, Sale Value,
  how it bills: "Start of Month" for `first_of_month`, "Start of Month after
  the first visit" for `barta_standard`, "After each visit"; Auto-Pay; the
  agreement's round icon opens the plan, whose Agree tab has the
  agreements), SCHEDULED JOBS (the last two visits done, then the booked
  ones, by date), PENDING JOBS (the month in italics, Pending, the $; a red
  Schedule on the next one, a round `...` on the others; a long press on any
  opens Schedule and Delay), BILLING CYCLES, INVOICES (#number, the pill,
  the amount, due or paid and how), Quotes, Requests, then the desk's tiles.
- **Billing Cycles** (both layouts; Payments on a desk) are the live plans
  billed on the 1st (`first_of_month`, or `barta_standard` after the first
  visit): Money's 1st-of-month run makes one `plan_cycle` invoice per plan
  per month from them (`money/autopay.mjs`). "+ New" is New plan (a cycle
  belongs to a plan). The plans part reads each live plan's own terms
  (`GET /plans/:id`, at most four) for how it bills.
- **Activity**: the timeline, Messages, Calls, Follow-ups, Deals, Tasks,
  Texts and email.

A module's `cards(state, ctx)` sees `ctx.phone` (true on this page) and may
give phone rows (plans, money and work do). The page draws again when the
window crosses 900 px. Tests: `tests/crm/contacts/phone.test.mjs`.

## A lead's priority

`contact.priority`: `low`, `medium` or `high` (Rotor's Low / Medium / High,
the owner's Nov 2026 "copy Rotor"), optional. Set from the lead editor and
the lead page's `...` (PATCH `/contacts/:id { priority }`, `null` clears
it; anything else is a 400); the pill right of the lead's name; on the
contacts index as `pr`, so the Leads list shows it as its pill (before an
open task's priority or the "High priority" tag) and filters by it. The
Rotor import sets it from the lead's own priority when it makes the lead
(and fills it when the lead joins a customer); it is not a Rotor-owned
field, so a later import never undoes a person's change. Rotor's
`rotor.priority` and the "High priority" tag stay as they were.

One-time backfill for leads imported before this field existed (an owner
runs it by hand, once; nothing runs it automatically): for each contact
whose `rotor.priority` is `low`, `medium` or `high` and that has no
`priority`, set `priority` to it (PATCH `/contacts/:id` with the record's
version, or a script over `rec/contact/*` with `updateRecord`). It is safe
to run twice (it only fills an empty field), touches nothing Rotor sees,
and a contact someone already gave a priority keeps theirs.
