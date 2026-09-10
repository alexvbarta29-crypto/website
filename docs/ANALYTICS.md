# Analytics and ad tracking

Two tags, both rendered once per page from `components.head()`, both driven by
one value in `build/sitedata.py`, and neither present on a page that opts out
of analytics.

## Google Analytics 4 — `GA4_ID`

## Meta Pixel — `META_PIXEL_ID`

Both load the same way. The stub and queue exist immediately and the page view
is recorded right away, while the heavy library (`gtag.js`, `fbevents.js`)
waits for the visitor's first interaction — pointer, touch, key, scroll — or
15 seconds after load, whichever comes first. That shared trigger lives in
`__b3p()` so both tags register with one implementation and neither can inject
twice. Meta's `<noscript>` beacon covers visitors without JavaScript.

Changing `META_PIXEL_ID` to `""` removes the script and the beacon. The
privacy policy's description of the pixel is written into `build_privacy()`,
so if the pixel is ever switched off that paragraph has to be removed by hand
in the same change.

### What the pixel reports

| Event | When |
| --- | --- |
| `PageView` | every page load |
| `Lead` | a quote form submission that actually succeeded — never on a click, never on a failed send. `content_name` carries the service. This is the conversion to optimise campaigns for. |
| `Contact` | a tap on any `tel:` link, which on a phone is usually the whole conversion |

`Lead` and `Contact` live in `assets/js/main.js`, guarded on `fbq` existing,
so they cost nothing when no pixel is configured. Both fire after the visitor
has already interacted with the page, so the deferred library is always loaded
(or about to be, with the call safely queued) by the time they run.

### One thing to know about the deferral

`PageView` is queued instantly but only *sent* when `fbevents.js` loads. A
visitor who lands from an ad and leaves within 15 seconds without touching the
page never sends one, so Meta's Landing Page Views will read a little lower
than the true number. That is the deliberate trade for keeping third-party
JavaScript out of the audited page load (Lighthouse: desktop 99, mobile 86-87).
To measure paid traffic exactly instead, drop the `__b3p(...)` wrapper around
the Meta tag in `components.head()` so `fbevents.js` loads immediately — it is
`async` either way, so it never blocks rendering.

### Checking it

`scratchpad/e2e/pixel-check.mjs` drives a real browser with the Facebook
endpoints stubbed, so no test ever calls Meta. It asserts the library loads,
`init` uses the configured ID, `PageView` fires once, a phone tap reports
`Contact`, a successful quote reports exactly one `Lead` naming the service,
and a failed submission reports nothing.

In production, Events Manager's **Test events** tab (or the Meta Pixel Helper
extension) shows the same events arriving live.

### The ads deep link

`/services/christmas-light-installation.html?quote=1` opens the Christmas quote
form on arrival. Point ads at the full URL rather than the `/christmas-quote`
shortcut, so Meta's `fbclid` and any `utm_*` parameters survive to the page.
