# CRM module: comms

Milestone: M6. Status: built; texting, email and review reading stay off until an owner connects them (see "What an owner does").

What it does: the Inbox and every conversation, the record of each message that really went out or came in, inbound texts and delivery statuses, STOP / START / HELP, campaigns, Google reviews (read only) and the review request sequence, and the import of Rotor's messages, campaigns and message templates.

Code: `netlify/lib/crm/modules/comms/` (server), `netlify/lib/crm/adapters/{sms-twilio,email-postmark,gbp}.mjs` (providers), `crm-app/modules/comms/` (screens).
Record types: conversation (`cv_`), message (`ms_`), campaign (`cm_`), review (`rv_`).
Tests: `tests/crm/comms/*.test.mjs`, `tests/e2e/comms.spec.mjs`.

Nothing in this module reaches a customer by itself today. With no keys every send is a dry run (an Outbox item), the webhooks answer 403, and Google is not asked for anything. Rotor still owns the real texting number; the CRM never registers a number or a webhook with a provider.

## What the office sees

- **Inbox**, titled **Messages** (`#/inbox`, its own tab for the office and for techs; Nov 2026: Flyra's header, Rotor's rows): every conversation, newest first; a search field over the names and last words, **All | Customers | Leads**, an **Unread** switch and a dropdown (All Messages, Needs reply, Mine); the narrowest goes to the server's filter, the rest is applied on the phone. A row: a pastel initials circle, the name, the last words, the time and a coral count of what's unread. A technician gets All Messages, Needs reply and Unread. The + in the header writes to someone (`#/inbox/new`). It refreshes every 30 s (ETag, so an unchanged list costs one small read). On a wide screen the thread opens beside the list.
- **A thread** (`#/inbox/{conversation id}`, or `#/inbox/{contact id}` before the first message): bubbles with the time, the status ("Delivered", "Not delivered (30007)") and where a text came from ("automatic", "campaign", "from Rotor"); what is waiting in the Outbox shows as grey "Not sent (dry run)" bubbles; a long email is cut with "Show the whole message". The composer sends your own words or a template (with its preview and a warning when the contact lacks something the template needs). It refreshes every 10 s. A text needs signal: offline nothing is sent and nothing is queued, the words stay in the box.
- **Contact → Messages**: that person's threads (texts, email) and the latest messages.
- **Campaigns** (Menu → Messages & automations): Rotor's 31 campaigns as history, and new ones: who gets it (with a live count and who is left out, by reason), the template with sample texts, the required test send, then Send now or a time.
- **Reviews**: the Google reviews the CRM has read, which customer wrote each (a person confirms), and this week's count per tech.
- **Settings → Texting, email & reviews**: what is connected and what is missing (never a key's value), and the webhook addresses to paste into Twilio and Postmark when the number moves.

A technician's Inbox holds only the conversations of contacts on their own visits (7 days back, 30 ahead) and only each record's tech fields; anything else answers 403. No New button, no campaigns, no reviews.

## Records

- **conversation**: one per (contact, channel). Its id is derived from the two, so two messages at the same moment make one conversation and the import lands on the same record every run. Holds the last message, `unread`, `needs_reply`, `state` (open / done), `assignee_id`.
- **message**: written once. Its body never changes afterwards; only `status` moves, and only forward (queued → sent → delivered; failed and undelivered are final). `provider` is `twilio`, `postmark` or `rotor_import`.
- **campaign**: a name, notes, an audience, a template, and the id of the core bulk run that sends it. Per-recipient results stay on the bulk run.
- **review**: one Google review (`ptr/gbp-review` makes each land once), its suggested matches and the confirmed match.

The inbox index (`ix/inbox`) is sharded: `open` (what still needs someone) and one shard per year of handled threads, so a new text rewrites a small blob. A campaign batch of 25 writes each touched shard once.

## Endpoints

All under `/api/crm`. Sending itself is core's `POST /messages`; this module provides its sink.

| Route | Who | What |
| --- | --- | --- |
| `GET /inbox?filter=&cursor=` | `inbox:read` | conversations (ETag/304) |
| `GET /inbox/contact/:id?channel=` | `inbox:read` | a contact's threads, the thread on one channel, what waits in the Outbox |
| `GET /conversations/:id?before=&since=` | `inbox:read` | one thread, newest first, and the contact's threads (ETag/304) |
| `POST /conversations/:id/read`, `/done`, `/assign` | `inbox:read` (assign: office only) | unread → 0; handled or reopened; who owns it |
| `GET /messages/:id` | `inbox:read` | one message, whole |
| `GET/POST /campaigns`, `GET/PATCH /campaigns/:id` | `campaigns:write` | list, create, read (with its run), edit |
| `POST /campaigns/:id/preview` | `campaigns:write` | count, who is left out and why, sample texts |
| `POST /campaigns/:id/test` | `campaigns:send` | the test send (202 "preparing" until the audience is prepared) |
| `POST /campaigns/:id/schedule` | `campaigns:send` | `{ send_at: null }` now, an ISO time, or `"unschedule"` |
| `POST /campaigns/:id/cancel`, `GET /campaigns/:id/recipients` | `campaigns:write` | stop it; results per person |
| `GET /reviews`, `GET /reviews/:id`, `POST /reviews/:id/match` | `reviews:read`, `reviews:match` | the reviews; match one to a customer |
| `GET /comms/setup` | `settings:messaging` | what is connected (booleans), the webhook addresses |
| `POST /hooks/twilio/sms`, `/hooks/twilio/status` | Twilio's signature | an inbound text; a delivery status |
| `POST /hooks/email/postmark` | a token in the address | delivery, bounce, spam complaint, unsubscribe |

Services: `messages.sink`, `reviews.isReviewed(contact_id)`, `comms.unread(ctx)` (the Inbox badge and Home's "Unread conversations" row: one read of the small `open` shard).
MCP (read only): `comms_inbox`, `comms_thread`, `comms_campaigns`, `comms_reviews`; anything a customer wrote is wrapped as untrusted text.

## Sending and receiving

- **Dry run** (today): a send is an Outbox item and nothing else. No message record, no conversation change.
- **Test or live**: every send that really reached a provider, whoever started it (a person, an automation, a follow-up step, a campaign batch), becomes a message in its conversation with a timeline row. A provider's refusal is recorded too, with its code.
- **The Twilio adapter** refuses on its own, whatever the settings say: no keys → not configured; test mode → only numbers on the test allowlist, from the test number; live → refused while `system_of_record` is "rotor".
- **An inbound text**: signature checked over the canonical address; once per MessageSid; the contact is found by the sender's number (several: the most recently active that is not archived; none: a new lead named after the number, source "Inbound text", no follow-up started); the conversation reopens, needs a reply and counts one more unread; media is fetched afterwards from a queue item.
- **Keywords** (the whole text and nothing else): STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE opt the number out at once; START and UNSTOP opt back in; HELP and INFO get one answer (Twilio's Advanced Opt-Out when it is on, else the `help_reply` template). YES is never an opt-in.
- **A status callback** only moves that message's status forward. It never touches the conversation or the inbox. Twilio's 21610 also opts the number out.
- **Email**: Postmark's bounce and spam complaint opt the address out; the unsubscribe link (core) does the same. Emails go out in Barta's layout (`email-layout.mjs`).
- **Before cutover** the parallel-run guard applies: a text from a customer Rotor still owns is not recorded. Test phones are test contacts.

## Campaigns

A campaign's send is a core bulk run, the same machinery as a rain-day notice, so the rules cannot drift apart: preview → test to the test contact (`cfg/messaging_test`) → Send now or schedule → 25 at a time, each recipient checked again at send time. Sending before the test is always refused ("Send the test first, then confirm."). A changed audience or template needs a new test. At most 2,000 people per campaign.

Always left out, with the reason counted: archived, spam, test and vendor contacts; no number or email; opted out; a second contact on the same number; anyone a campaign reached in the last 3 days. Marketing consent is checked contact by contact when the send is prepared and again at send time, so the builder's count is the upper bound. The test contact needs marketing consent too when the template is a marketing one.

Filters: lifecycle, towns, tags, lead source, services quoted, has an open quote, plan status (active / none), no Google review yet. Filters that need a column no module keeps in the contact list yet (services done, last service date, lights season, service area tier, created between, cancelled plans) match nobody and say so on the screen.

Templates never contain a STOP line: the sender adds the opt-out footer where the rules ask for one.

## Reviews

The CRM only reads Google reviews. It never replies and never posts: public words stay with a person.

- `reviews.poll` (hourly; only when the reviews integration is live on the production deploy with Google's keys) stores new reviews with suggested matches: jobs completed in the 21 days before the review whose contact's name fits the reviewer's display name.
- A match is a person's tap. It sets the contact's `review_left_at`, stops that contact's review sequence, credits the job's techs and emits `review.matched`.
- `review.sequence` (automation, trigger `job.completed`): three texts (`review_1` about 90 minutes later inside 09:00 to 19:00, `review_2` on day 3 at 11:00, `review_3` on day 8 at 11:00). Each step is checked again when due and skipped when the customer replied, opted out, was matched to a review, or was asked in the last 180 days. Not for touch-ups, warranty work or lights takedowns. Before cutover every step is a dry run and imported jobs are never asked.

## Settings

| Name | Who | What |
| --- | --- | --- |
| `reviews` | `settings:messaging` | `link` (the review page), `match_days` (21), `ask_again_days` (180) |
| `pin_types` | `settings:general` | Rotor's map pin types: the door-to-door map's (docs/CRM-MAP.md); each also keeps its `key` and `outcome`, and a later export keeps those and the types made in the CRM |
| `integrations` (core) | owners | `sms.mode`, `sms.test_from`, `sms.test_allowlist`, `sms.advanced_opt_out`, `email.mode`, `email.from`, `email.test_allowlist`, `reviews.mode` |
| `messaging_test` (core) | owners | the test contact every campaign's test goes to |
| `comms.reply_keywords` (core `comms`) | `settings:messaging` | words that tag the contact and note the notification; none by default |

## Sweeps, queue kinds and listeners

- Sweep `reviews.poll` (fast lane, hourly).
- Queue `media.fetch` (an MMS's files after the webhook answered), `campaign.start` (a scheduled campaign, as the person who scheduled it).
- Listeners: `message.inbound` and `consent.changed` stop the review sequence for that contact.
- Emits `message.inbound`, `review.matched`.
- `onMerge`: a merged contact's threads move to the contact that survives.
- Settlers for a send whose answer never came: Twilio by number, time and body; Postmark by the marker in its metadata. Found → done; not found → unknown (the owners are told; nothing is sent twice).

## Automations

`review.sequence` (above). Built-in templates: `review_1`, `review_2`, `review_3`, `review_personal` (marketing, for a batch), `help_reply`.

## Import phases

They read an export someone made. They never call Rotor. They run after `contacts.suppressions`.

| Phase | Rotor rows | Becomes |
| --- | --- | --- |
| `comms.templates` | 45 message templates | Barta's own (Rotor's examples are skipped) under keys `rotor_<name>_<id>`, so a seeded or edited CRM template is never overwritten; a typed "Reply STOP to opt out." tail is stripped; Review 1/2/3 are service texts, the rest marketing; giveaway, referral and test ones arrive inactive; HTML emails keep their sanitized HTML |
| `comms.campaigns` | 31 campaigns | campaigns with status "sent" (history, never sent again) |
| `comms.messages` | 10,927 messages | messages and their conversations |
| `comms.pin_types` | 8 pin types | `cfg/pin_types` |

Messages are written once and there are many, so this phase writes them directly: one write for the record, one for its place in the thread; no per-field base, no Rotor pointer (the id is a pure function of Rotor's id). `prepare()` groups the staged rows by contact and channel, finds each group's contact and conversation side by side, and saves one summary per group; a group the conversation already holds is skipped without a storage call. A contact the export lacks becomes a placeholder. A conversation is open and unread only when its last message is inbound, under 14 days old and unanswered; everything older arrives handled. The contact's Activity gets one row per imported thread. Attachments are the files the upload already stored; the import never fetches an address.

Measured on the synthetic export at full scale (`tests/crm/fixtures/rotor-synthetic.mjs --scale 1`, `CRM_IMPORT_FULL=1 node --test tests/crm/comms/import.test.mjs`):

| | |
| --- | --- |
| Messages / conversations | 10,927 / 2,294 (the synthetic export has about twice the real number of threads) |
| Storage calls, first run | 46,890 (4.29 per message): about 39 minutes at 20 calls a second |
| Bulk-lane passes | 70, each checkpointed (450 rows a step), every message written exactly once |
| Second run, unchanged export | 4,991 reads (three per conversation, twelve side by side), no writes |
| Estimate for the real export (about 1,240 threads) | about 36,000 calls, about 30 minutes |
| Biggest inbox shard / biggest message | 613 KB / 18 KB |
| Campaign audience preview over 1,265 contacts | 23 storage calls |

## What an owner does

Nothing is needed for the import or the Inbox. To switch real texting on later (after the number moves; Rotor keeps it until then):

1. Add `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` to the site's environment. For email, `POSTMARK_SERVER_TOKEN` and `POSTMARK_WEBHOOK_TOKEN`. Reviews use the Google keys the site already has (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `ACCOUNT_ID`, `LOCATION_ID`).
2. Settings → Integrations: texting to **test**, with a test number and the team's own phones on the allowlist. Test mode reaches only those phones.
3. Settings → Texting, email & reviews shows the two webhook addresses. Paste them into the Twilio number (and Postmark) by hand. The CRM never does this itself.
4. Pick the test contact (a contact flagged test, with marketing consent if campaigns will use marketing templates).
5. Live is refused until the CRM is the system of record.

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com` emails); logs carry counts and codes, never a name, phone, email, address, message text or amount tied to a person. Message bodies live only in message records and the Outbox. A webhook that fails its signature reads and writes nothing.
