# CRM module: map (door to door and the team map)

Two Flyra-style map screens on one interactive map: **Door to door** (the
knock map: pins, pin types, areas, Convert to lead, the leaderboard and
canvassing report) and the live **Team map** (where the people on the
clock are). Both are laid out like Rotor's phone map, in Flyra's look
(Nov 13): the map is the whole screen (under the status bar and Flyra's
floating tab bar, where the Map is the fourth place; satellite first when
the aerial is on), round glass buttons across the top-left (**search**,
**locate**, **filter**, **street ↔ satellite**), the controls in a
floating glass bar just above the tab bar, details in sheets that slide
up. With the streets style unreachable the blank map takes the theme's
color (`--map-blank`).

Code: `netlify/lib/crm/modules/map/` (server), `crm-app/modules/map/`
(screens), `crm-app/vendor/maplibre-gl/` (the map library),
`netlify/lib/crm/core/map-sources.mjs` (which map services, the CSP's
hosts). Record types: `pin`, `territory`. Tests: `tests/crm/map/`, phone
checks `tests/e2e/map.spec.mjs` (with `map-seed.mjs` and `map-stub.mjs`).

| File | What it holds |
|---|---|
| `index.mjs` | the manifest: types, permissions, the `map` setting, routes, sweeps |
| `types.mjs` | pin and territory: validation, index rows (`pins/{yyyy}`, `territories`), pin types and outcomes |
| `pins.mjs` | the knock map's routes, Convert to lead, the report |
| `territories.mjs` | drawn areas |
| `team.mjs` | location sharing while clocked in, the team map, retention |
| `geocode.mjs` | the Census batch geocoder (sweep) and Nominatim for a dropped pin |
| `geo.mjs` | point in polygon, boxes, thinning a breadcrumb (pure) |

Client: `knock.js` (Door to door, also `#/map`), `team.js`, `report.js`,
`areas.js`, `settings-knock.js`, `settings-maps.js`, `sharing.js` (the
phone's side of the team map, started by `main.js` through the manifest's
`start()`), `today-card.js`, `mapview.js` (the map wrapper), `kit.js`,
`map.css`.

## The map stack

- **Library: MapLibre GL JS 5.24.0** (BSD-3-Clause), vendored byte for byte
  in `crm-app/vendor/maplibre-gl/` with its `LICENSE.txt`: its CSP build
  (`maplibre-gl-csp.js` + `maplibre-gl-csp-worker.js`, so the worker is a
  file of ours and the CSP keeps `worker-src 'self'`, no `blob:`) and its
  stylesheet. Loaded only when a map screen opens (about 1.4 MB, about
  400 KB compressed; the service worker precaches it with the rest of
  `crm-app/`, so it is there with no signal). `tests/crm/map/client.test.mjs`
  pins the four files' sha256; `csp.test.mjs` (core) skips `crm-app/vendor/`
  in the "no innerHTML" scan (the library's own popups and attribution
  control use it; the CRM uses neither: `attributionControl: false`, our
  own credits line from the server's words).
- **Streets: OpenFreeMap** (`tiles.openfreemap.org`, the "liberty" style):
  free, no key, no sign-up, commercial use allowed; data © OpenStreetMap
  contributors (ODbL). Credit shown at the bottom of the map and in More →
  Map credits.
- **Satellite: USGS The National Map orthoimagery** (`basemap.nationalmap.gov`,
  `USGSImageryOnly`, USDA NAIP photos): U.S. public domain, no key, "no
  use restrictions"; cached to zoom 16 (the map stretches it past that, so
  a house is a soft shape, not a sharp roof). Door to door opens on
  satellite (with the street names on top) when a satellite source is set
  up; one tap on the layers button switches to streets and back. The team
  map opens on streets.
- **One config swaps them** (Netlify env, Production; redeploy after):
  `CRM_MAP_STREETS` = `openfreemap` (default) | `maptiler` (+
  `CRM_MAP_STREETS_KEY`), `CRM_MAP_AERIAL` = `usgs` (default) | `esri` (+
  `CRM_MAP_AERIAL_KEY`, an ArcGIS Location Platform key: Esri World Imagery,
  sharp to the roof) | `off`. A keyed provider without its key stays on the
  default (Settings → Maps says it waits for its key). A tile key travels
  to the browser by design: restrict it to the site's address in the
  provider's console.
- **CSP** (`core/http.mjs`): `connect-src 'self'` plus exactly the hosts of
  the providers the env picks (default `https://tiles.openfreemap.org
  https://basemap.nationalmap.gov`). Nothing else changed. A phone running
  the previous version's cached shell gets the new CSP on its next reload
  ("New version, tap to reload").
- **No signal:** the map falls back to a plain background (pins, areas and
  your dot still draw; the streets come back with signal), and pins wait
  on the phone (below).

## Door to door

Menu → Sales → **Door to door** (`#/knock`), or **Map** as a top-level
screen (`#/map`, no back arrow: what a pinned "Map" tab opens). Owners and
the office (`canvass:use`); a technician when an owner turns it on for
them (Settings → Door to door → Who can knock doors, a per-person grant:
they sign in again once), who then gets a **Door to door** card on Today.

- **On the map:** customers (green houses) and open leads (blue houses)
  with a map point; pins in their type's color (a ring when its go-back
  date has come, faded while it waits on the phone); areas (yours bold).
  Only the office sees a customer's name and address; a canvasser sees
  only that someone there is a customer or a lead.
- **Round buttons:** **Search** (an area, a street you knocked, and for the
  office a customer's name or street), **Locate** (where you are; asks for
  location once), **Filter** (pins, only mine, customers, open leads,
  areas, each pin type, whose pins), **Layers** (street ↔ satellite).
- **Drop a pin:** tap a house. The sheet shows the address (looked up from
  the map point, see Outside hosts; editable under Details) and the pin
  types as big buttons; one tap saves. Details adds a note, a go-back date
  and a typed address.
- **A pin:** its knocks, **Knocked again** (a new knock), **Change type**
  (corrects that day's knock), **Note and go-back date**, **Convert to
  lead**, **Open** the lead (office), **Delete** (whoever dropped it, the
  same day, or a manager; never once it is a lead).
- **Convert to lead:** name, mobile or email, the address, what they want,
  and "they said we can text them about this quote". It goes through
  `contacts.intake` (origin `app`, source **Door to Door**, tag "Door to
  door", the canvasser as the new contact's owner, the pin's map point on
  its property). The follow-up is the sales module's rule: the seeded New
  lead cadence takes other sources, so it starts only once an owner adds
  Door to Door to its sources (Settings → Cadences); otherwise the lead
  waits on Calls. A phone already on file joins that contact (its
  owner unchanged). Every text stays in the Outbox (dry run).
- **Knocking mode** (Start knocking): the map follows you, a cross marks
  where **Pin here** drops, the screen stays on (the Wake Lock API, Safari
  16.4+; older phones are told to lengthen Auto-Lock). One hand, 56 px
  buttons.
- **No signal:** a pin, a knock or a change goes into the phone's outbox
  (the tech app's, `core/outbox.js` through `work/tech-kit.js send()`),
  shows as waiting ("N changes wait for signal"), and goes out in order
  when signal comes back; each carries the phone's client id, so a replay
  is one pin. Its time is the phone's when it adds up (`judgeTime`), else
  the knock is marked unverified. Convert to lead needs signal.
- **Areas:** More → Draw an area (owners and the office, `canvass:manage`):
  tap the corners (3 to 100), Done, a name, a color, who knocks it. Areas
  (`#/knock/areas`) lists them with this month's doors; Edit renames,
  recolors, reassigns or deletes. Pins count toward an area by where they
  are, worked out when read, so a redrawn area recounts at once.
- **Leaderboard and report** (`#/knock/report`; More → Leaderboard and
  report): doors knocked (every knock: a pin dropped or Knocked again),
  conversations (knocks whose type counts as someone answering), leads
  (pins converted), booked; per person, per day or week, per area; Today,
  This week, Last 7 days, This month, Last 30 days, This year (from the
  server's today) or any dates.
- **Pin types** (Settings → Door to door, `settings:general`): Rotor's eight
  from the import (`cfg/pin_types`, comms' setting), or Barta's seven
  until then (Not home, Not interested, Interested, Come back, Booked,
  Renter, Never knock). Each has a name, a color, what it **counts as**
  (No answer, Talked, Interested, Not interested, Booked, Don't knock:
  worked out from the name until someone picks) and on or off. Keys are
  stable (from Rotor's id, else kept once saved), so renaming a type never
  loses its pins; a later Rotor export keeps the keys, the "counts as" and
  the types made in the CRM.

## Team map

Menu → Work → **Team map** (`#/team-map`, owners and the office,
`team_map:read`). The same full-screen map: each person on the clock as a
round dot with their initials and how fresh it is ("2 min ago"; amber past
5 minutes, grey past 30), their trail today, their visits and route; the
people as cards along the bottom (now or next visit). Tap one for their
day (the visits in route order with their status, Open the route). Round
buttons: find someone, show everyone, filter (people, trails, routes, an
earlier day within the retention days), street ↔ satellite. It reads
`GET /map/team` every 30 s while on screen.

**Consent and limits:**

- Off until an owner turns it on (Settings → Maps and the team map: the
  company, and each person by name; how often, 1 to 5 minutes; how long
  positions are kept, 7 to 90 days, default 30).
- A phone shares only while its person is **clocked in and the app is open
  on screen**: about every 2 minutes, at clock in, and when a visit starts
  or finishes. The phone asks once ("Share your location while on the
  clock?"), the browser asks for location permission, and a green bar says
  **"Sharing your location while on the clock"** across the top of every
  screen while it's on; its Details stop it on that phone for the day.
- The server keeps nothing from someone who isn't clocked in (an open
  shift, `ptr/clock/{uid}`), isn't turned on, or whose company switch is
  off; a timed position closer than 25 s to the last is skipped.
- **The web limit, plainly:** an installed iPhone web app can't share its
  location in the background. When the phone is locked or another app is
  in front, nothing is sent; the office sees the last dot and its age. The
  screen's "How it works" says so.
- **Storage:** one small blob per person per day,
  `loc/day/{yyyy-mm-dd}/{uid}` = `{ pts: [[lat, lng, epoch s, accuracy m,
  why]] }`, at most 240 points (an older half thinned, the newest kept
  whole); the latest position is its last point. Raw keys, not records:
  never audited, never in a backup (`core/backup.mjs` lists prefixes), and
  `map.retention` deletes days older than the setting every night (a
  maintenance sweep, so also while the CRM is paused). **Delete every
  stored position now** in Settings empties it at once.

## Geocoding

Properties need a map point to show on the map.

- **Addresses → map points: the US Census Bureau's batch geocoder** (free,
  no key, public data), the `map.geocode` sweep (bulk lane, every pass):
  up to 50 properties waiting for a map point (`rel/geo-pending`, the list
  Google's `contacts.geocode` walks) in one POST of a CSV with the row
  number, street, city, state and ZIP and nothing else; a match fills
  `geo` (source `census`), the service-area tier and distance; no match (or
  no street to send) marks `geo_tried_at`, so nothing blocks the list. At
  most 1,000 addresses a day; a failure backs off 30 minutes; 45 s timeout;
  only on the production deploy, never while paused, and never once Google
  Maps is live (Google does it then). About 1,300 addresses take a few
  hours of background passes. Settings → Maps shows how many wait, and
  **Find map points now** wakes the bulk lane.
- **A dropped pin's address: OpenStreetMap's Nominatim** (reverse), through
  the server (`GET /map/reverse`): only when someone drops a pin, the two
  coordinates only, at most one request a second for the whole site
  (`geo/gate/nominatim`), an identifying User-Agent (its usage policy),
  cached by month (`geo/rev/{yyyy-mm}/…`, deleted after two months), 4 s
  timeout, production only. No answer: the canvasser types it.
- A pin converted to a lead gives its property the pin's own map point
  (source `pin`) when the property has none.
- Existing data: the customers' map points come from these, so the map
  fills in over the first night; the `places` index (every property with a
  map point) is built by the nightly check, or at once with Settings → Data
  → Rebuild the lists.

## The house picture

The owner (Nov 2026): "make sure every lead and customer has a Google
Street View or a Google Earth view or something of the house."

- **Where it shows.** The customer's and the lead's page, inside the
  CONTACT card where the satellite was (a phone; on a desk a customer's is
  inside the PRIMARY PROPERTY card, a lead's inside CONTACT), with Rotor's
  small **Street | Aerial** switch; the property page; a job's and a
  visit's address card as a small square; a small square on each row of
  the Customers and Leads lists (lazy: only rows on screen ask). A tap
  opens Google Maps in a new tab: Street View at the house
  (`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=LAT,LNG`)
  or the satellite map (`map_action=map&basemap=satellite&zoom=20`); with
  no map point, a Google Maps search for the address.
- **What it is.** Street View first: the Street View metadata endpoint
  (free) finds the nearest outdoor panorama (50 m, then 120 m), and the
  picture is taken from there with the heading pointed at the house (the
  bearing from the panorama to the property's map point; a closer house
  gets a wider, higher view). No coverage: never Google's grey "no
  imagery" tile (the metadata says so first, and the image call uses
  `return_error_code`); the screen switches to the aerial: Maps Static,
  `maptype=satellite`, zoom 20 (a thumb 19), scale 2, a red pin. Neither:
  a plain square with a pin, "No picture of the house yet".
- **Every lead and customer.** A property with no map point is geocoded
  once through the existing `geocodeProperty` (Google's Geocoding API,
  stored as the property's derived `geo`, the same as `contacts.geocode`;
  the parallel-run guard allows it on imported properties). A contact with
  no property yet (a lead typed in by hand) gets its billing address's
  picture, kept under the contact's id, with Google aiming at the address.
  The `contacts.house` sweep (bulk lane, every pass) walks every property
  (`rec/property/`, resumable after its last key), then every contact with
  no property, warming the default picture (street, else aerial; full and
  thumb), at most 5 needing Google and 40 looked at a pass, once a day;
  the first view of anything it hasn't reached makes it then.
- **Paid once per address.** Pictures are kept in the `crm-files` store at
  `h/{propertyId or contactId}/{hash}-{street|aerial}-{full|thumb}` (never
  backed up: they come back from Google); the hash is of the one-line
  address and the map point, so only a new address (or a moved point) asks
  Google again, and the old pictures are deleted then. `geo/house/p/{id}`
  remembers the panorama, its aim, and "no Street View here". A deleted
  property's (or a merged-away contact's) pictures go with the sweep.
  Browsers keep a picture an hour (`private`, with an ETag; a 304 after).
- **Budget.** Every billed Google call (an image or a geocode) is counted
  before it is made, in `geo/house/use/{yyyy-mm}` (one CAS'd counter), and
  refused past 9,000 a month, 600 a day, the sweep 450 of those, one
  person 150 a day (a 429; the screen shows the satellite or the plain
  square). A storage error spends nothing and calls nothing.
- **Off** (no `GOOGLE_MAPS_API_KEY`, Maps not `live` in Settings →
  Integrations, any deploy but production: local, tests, previews):
  `GET /house/status` says `{ on: false }`, no picture is asked for, and
  the pages show the keyless satellite (the map's aerial, as before) or
  nothing. Nothing breaks.
- **Privacy.** Google gets the property's map point (or its one-line
  address when it has none) and the server's key; never a name, phone or
  email. Logs carry Google's status word or HTTP status only, never an
  address or the key. The page's CSP is unchanged: the pictures come from
  the CRM's own route (`img-src 'self'`).
- Files: `netlify/lib/crm/modules/contacts/house.mjs` (routes, cache,
  budget, sweep), `netlify/lib/crm/adapters/maps-google.mjs` (`streetMeta`,
  `streetImage`, `aerialImage`), `crm-app/modules/contacts/house.js` (the
  picture, the switch, the fallbacks). Tests:
  `tests/crm/contacts/house.test.mjs`, `tests/crm/core/address-hold.test.mjs`.

## The address hold

The owner (Nov 2026): "make addresses copyable whenever you hold down on
them." Every address the CRM shows carries `data-address="<one line>"`
(`core/ui.js`: `addressAttrs()`, `addressHold()`, and an `address` option
on `contactRows`, `addressCard`, `listRow`, `boardCard`, `personCard` and a
`dataTable` column). A long press on it (450 ms; a right click or the mouse
held on a desk) copies the one line (the Clipboard API, else a hidden
textarea and `execCommand("copy")` for older iPhones, tried again as the
finger lifts if the browser refused during the hold), buzzes lightly where
the phone can (`navigator.vibrate`; an iPhone doesn't) and says **Address
copied**. A tap still does what it did (open the property, directions); the
click that ends a hold is swallowed. On a row whose long press opens its
"..." (`data-hold`), the address is on its second line, so a hold there
copies and a hold elsewhere still opens the "...". Never the gate code.
Where: the customer and lead pages (CONTACT, PRIMARY PROPERTY, Properties),
the property page, a job's and a visit's address card, an invoice's Bill
To, the schedule (Day rows, the board's cards, Find a visit, a route's
stops, the visit panel), the tech's Today and visit, the Inbox's person
panel, the map's pin and place sheets and its search, the Customers,
Leads and Jobs lists, a quote's and a plan's property, the create forms'
property row, and search results (the header's, the +, the pickers).
Tests: `tests/crm/core/address-hold.test.mjs`, `tests/e2e/address.spec.mjs`.

## Outside hosts and what they get (privacy)

| Host | From | What it gets | When |
|---|---|---|---|
| `tiles.openfreemap.org` | the browser | the style, map tiles and fonts for the part of the map on screen (tile coordinates and zoom), the browser's IP and user agent; no referrer (the CRM's `same-origin` policy) | while a map screen is open |
| `basemap.nationalmap.gov` | the browser | aerial tiles for the part of the map on screen, the same as above | while satellite is on |
| `geocoding.geo.census.gov` | the server (`map.geocode`) | street, city, state and ZIP of properties without a map point, with a row number; nothing else | background passes, production, Settings → Maps on |
| `nominatim.openstreetmap.org` | the server (`GET /map/reverse`) | the two coordinates of a dropped pin and the CRM's User-Agent | a pin dropped, production, Settings → Maps on |
| `maps.googleapis.com` | the server (the house picture, `contacts.geocode`) | a property's map point (or its one-line address when it has none) and the server key: Street View metadata and images, Maps Static satellite images, Geocoding | Google Maps `live`, production; once per address (then Blobs), inside the budget |
| (owner-added) `ibasemaps-api.arcgis.com`, `api.maptiler.com` | the browser | tiles, as above, with the owner's browser key | only once set in Netlify |

No customer's name, phone or email ever goes to a map host. Positions of
the team map never leave the site.

## Endpoints

All `auth: "session"`.

| Route | Perm | What |
|---|---|---|
| `GET /map/knock` | canvass:use | the screen's start: map sources, the service area's center, pin types, areas, who I am (people for managers) |
| `GET /map/places?bbox=` | canvass:use | customers and open leads with a map point (`ix/places` + the contacts index); names and addresses only with `contacts:read_all` |
| `GET /map/pins?bbox=` | canvass:use | this year's and last year's pins (`ix/pins/{yyyy}`), at most 4,000 |
| `POST /map/pins` | canvass:use | `{ client_id, lat, lng, type_key, note?, follow_up_on?, address?, address_source? }` (replay-safe) |
| `GET /map/pins/:id` | canvass:use | one pin: knocks with names, its areas, its type, what you may do, its lead (office) |
| `PATCH /map/pins/:id` | canvass:use | `{ client_id, type_key?, knock?, note?, follow_up_on?, address? }` (replay-safe) |
| `DELETE /map/pins/:id` | canvass:use | who dropped it (same day) or canvass:manage |
| `POST /map/pins/:id/convert` | canvass:use | Convert to lead (120 storage calls: intake with a follow-up) |
| `GET /map/reverse?lat&lng` | canvass:use | a dropped pin's address |
| `GET /map/report?preset\|from&to&group&territory` | canvass:use | the leaderboard and report |
| `GET/POST /map/territories`, `GET/PATCH/DELETE /map/territories/:id` | canvass:use (read) · canvass:manage | areas (PATCH with If-Match) |
| `GET /map/sharing` · `POST /map/position` | time:own | is my phone to share now · `{ lat, lng, acc?, why? }` |
| `GET /map/team?date` | team_map:read | people, positions, trails, visits (40 storage calls) |
| `POST /map/team/forget` | settings:owner | delete stored positions (18 a call; the button repeats) |
| `GET/POST /map/geocode` | settings:owner | the geocoder's status · wake the bulk lane |
| `GET /properties/:id/house.jpg?kind=street\|aerial&size=full\|thumb` | contacts:read (a tech: their visits' properties) | the house picture (contacts module); 404 when there is none (or Google is off), 429 past the budget |
| `GET /contacts/:id/house.jpg?...` | contacts:read (scoped) | the contact's primary (else first) property's picture; no property: the billing address's |
| `GET /house/status` | contacts:read | `{ on }`: whether pictures can come at all |

Permissions: `canvass:use` (owner, office; technicians per person),
`canvass:manage` (owner, office), `team_map:read` (owner, office).

## Records, settings, sweeps

- `pin` (`pn_`): `lat, lng, type_key, type_label, type_color, outcome,
  note?, follow_up_on?, address?, address_source?, knocks: [{ at, by,
  type_key, outcome, note?, unverified? }] (≤ 60), canvasser_id,
  contact_id?, property_id?, converted_at?, converted_by?, client_id, ops`
  (client ids applied, ≤ 40). Its id derives from the canvasser and the
  phone's client id. Index `pins/{yyyy}` (the year of its first knock):
  `{ la, ln, t, o, c, k: [[date, uid, outcome]], fu?, a? (street), cv?, cb? }`,
  no notes. `rotorFields: []`: CRM-only (Rotor had 0 pins).
- `territory` (`tr_`): `name, color, polygon: [[lng, lat]] (3-100),
  assignee_ids, active, notes?`. Index `territories`.
- `cfg/map` (owners): `team_map: { enabled, people, every_s, retention_days }`,
  `geocoding: { batch: census | off, reverse: nominatim | off }`.
- `cfg/pin_types` (comms' setting, `settings:general`): each type now keeps
  `key` and `outcome` too.
- Sweeps: `map.geocode` (bulk, every pass, mutates derived property fields
  only, so the parallel-run guard lets it fill imported properties),
  `contacts.house` (the contacts module's, bulk, every pass: house
  pictures, a few a pass, once a day; it changes no record but a
  property's derived `geo`),
  `map.retention` (bulk, daily 03:20, maintenance).
- Export: `pin`, `territory` (Settings → Data CSV). Positions are not
  exportable (they are not kept long).

## Owner actions

1. Decide whether to keep the geocoders on (Settings → Maps and the team
   map: "Map points for customers' addresses" sends street, city, state
   and ZIP to the US Census Bureau; "Fill in a dropped pin's address" sends
   the pin's coordinates to OpenStreetMap). Both are on by default in
   production.
2. After the deploy: Settings → Data → **Rebuild the lists** once, so the
   customers already geocoded show at once (else the nightly check does it).
3. To use the team map: turn it on and tick each person (Settings → Maps
   and the team map); tell the team what it shares and when.
4. For a sharper satellite view: an ArcGIS Location Platform account (free
   tier), a browser key restricted to the site, then `CRM_MAP_AERIAL=esri`
   and `CRM_MAP_AERIAL_KEY` in Netlify (Production) and a redeploy.
5. If door-to-door leads should get the 9-touch New lead follow-up: Settings
   → Cadences → New lead → add **Door to Door** to its sources.
6. Turn on door to door for a technician who knocks (Settings → Door to
   door → Who can knock doors).
7. The house picture needs three Google APIs on the project that owns
   `GOOGLE_MAPS_API_KEY`: **Street View Static API**, **Maps Static API**
   and **Geocoding API**. To check: console.cloud.google.com → pick the
   project → APIs & Services → Enabled APIs & services: all three listed
   (else Library → search each → Enable); then APIs & Services →
   Credentials → the key: under API restrictions either "Don't restrict
   key" or all three ticked, and Application restrictions **None** (a
   server key; "Websites" would refuse the server). A shortcut: if Light
   Studio's house photo and its satellite measuring view both work, all
   three already are. Then Settings → Integrations → Google Maps: **Live**
   (production; this also makes Google, not the Census Bureau, find new
   properties' map points). Pictures start at once on the pages opened and
   the sweep fills the rest over a few days.
8. Cost (Google's list prices as last published, 2025: Street View Static
   $7, Maps Static $2 and Geocoding $5 per 1,000, each with 10,000 free
   calls a month; the metadata call is free; check
   mapsplatform.google.com/pricing for 2026): about 1,300 properties once
   is about 2,600 Street View pictures (full and thumb), a few hundred
   satellite ones and up to 1,300 geocodes, inside the free calls; without
   them about $30 once. New customers after that: cents a month. The
   budget never lets it pass 9,000 billed calls a month. A Google Cloud
   budget alert (Billing → Budgets & alerts, say $10) is a good belt and
   braces.

## Data rules

Synthetic fixtures only (placeholder names, `555` numbers, `example.com`
emails, made-up "Example" streets on a made-up grid); logs carry counts and
statuses, never an address, a name or a position.
