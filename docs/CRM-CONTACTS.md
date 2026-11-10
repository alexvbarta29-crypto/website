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

- **Contacts** (the Contacts tab): instant search over every contact on
  the phone (name, phone, email, street, tags; every word must match),
  chips All · Leads · Customers · Plan members · Former · Archived and the
  common sources, letter groups with a letter rail. Archived contacts only
  show under Archived. "Search notes and messages" runs a deeper search in
  the background. The first slice's Customers list stays one tap away at
  the bottom until the Rotor import goes live.
- **A contact**: Call · Text · Email · Directions, then Overview (how to
  reach them, texts and email consent, source, owner, tags, notes, and what
  other modules know: next visit, balance, plans), Activity (website
  requests with the words they typed, notes, edits, merges) and
  Properties; other modules add tabs (Sales, Work, Money, Messages).
  Edit, Add note, Merge with…, Pause automated texts, Archive / Restore,
  and for owners "Mark as test contact".
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
  parking), the counts quotes reuse, the lights profile.
- **Merge review** (More): possible duplicates, most certain first; each
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
| Intake mode **Rotor only** (the default) | Nothing (one cached settings read, after the answer) |
| **Rotor and the CRM** (`dual`) or **the CRM only** (`crm`) | The same lead goes through `intakeLead()` in process, with Rotor's lead id |

The visitor's answer: when Rotor accepted the lead it is Rotor's, and the
CRM write runs after the answer (`context.waitUntil`). When Rotor failed,
`dual`/`crm` try the CRM before answering: a lead the CRM kept answers 200.
A lead that reached only one side raises an owner alert on Today and a
notification ("A website lead saved to the CRM but not Rotor", or the
reverse). Giveaway entries and coupon claims get tags, notes and the
coupon-texts opt-in only, never the new-lead cadence.

Turn it on when the first contacts import is in: Settings → Intake mode →
"Rotor and the CRM".

## Intake (`intake.mjs`)

`intakeLead(input, { origin, rotor })` → `{ ok, contact_id, created,
enrollment_id?, error? }`, never throws. One address, one contact, even for
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
   is unknown (a "no" is never overturned by a form);
5. else create, id `deriveId(contact, intake--{hk}, n)`, a shadow while
   Rotor is in charge; a retried request that lost its lease lands on the
   same id; when the only matches were archived, a merge candidate too;
6. Rotor's lead id claims `ptr/rotor/lead/{id}`; without one the contact is
   marked `intake_pending_rotor` and the import links it by phone or email;
7. a new lead (or a returning customer asking again) → `sales.enroll`
   once (when Sales is there) and `lead.created`;
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
| `GET /merge-candidates` | `contacts:merge` | pending pairs with both contacts' rows |
| `POST /merge-candidates/:id/merge` · `/dismiss` · `/merge-candidates/bulk` · `/contacts/:id/merge` | `contacts:merge` | merges run in the background (`GET /runs/:id`) |
| `POST /hooks/lead/:token` | the token | Zapier's Meta lead → intake (401 for a wrong or revoked token) |
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
  10 properties waiting for a map point. Dry-run or off: no call.
- Listeners `job.completed`, `payment.succeeded`, `quote.converted`,
  `plan.activated` (mutates): a lead or former customer becomes a customer
  (report-only on imported contacts before cutover) and `customer_since` is
  set.

## Automations

None of its own (`lead.ack`, `lead.alert` and `lead.attention` are Sales').
Today's "Possible duplicates" count comes from this module's attention row.

## Import phases (design §10.2)

`import-rotor.mjs` exports `phases` for M2c's runner:
`contacts.customers` (row 6), `contacts.quote_contacts` (row 7),
`contacts.leads` (row 8), `contacts.properties_quotes` /
`_plans` / `_visits` (row 10), `contacts.suppressions` (row 12: exact STOP
replies, before any comms phase), `contacts.giveaway` and
`contacts.referrals` (row 36). `placeholderContact()` (row 9) is for other
modules' phases. Row 11 (the tag catalog) is derived from the contacts index
(`tagCatalog()`), not stored. Besides `records`, `pointers` and
`mergeCandidates`, a phase's output may carry `patches` (fill-only, list
unions, CRM-owned fields), `stats` and `suppressions`; `applyExtras()`
writes those. Rotor ids are lower-cased in pointer keys; Stripe customer
ids are hashed (keys are lower case and never hold an id that is itself a
secret-shaped value).

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails); logs carry counts and codes, never a name, phone, email, address
or amount tied to a person. No key holds phone digits or an email
(`tests/crm/contacts/keys.test.mjs`).
