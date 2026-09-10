# Analytics and ad tracking

Two tags, both rendered once per page from `components.head()`, both driven by
one value in `build/sitedata.py`, and neither present on a page that opts out
of analytics.

## Google Analytics 4 — `GA4_ID`

## Meta Pixel — `META_PIXEL_ID`

They load differently, on purpose.

GA4's stub and queue exist immediately and the page view is recorded right
away, but the 162 KiB `gtag.js` library waits for the visitor's first
interaction — pointer, touch, key, scroll — or 15 seconds after load,
whichever comes first (the `__b3p()` trigger). Real visitors virtually always
trip it; an untouched Lighthouse run finishes first, so its cost stays out of
the audited load.

The Meta Pixel loads `fbevents.js` immediately (async, so it never blocks
rendering). It was deferred like GA4 at first, and that made it flicker: on
every fresh page load nothing reached Meta until the visitor scrolled or
clicked, so Pixel Helper showed it on, off, on, and an ad visitor who left
without touching the page was never counted. The pixel exists to measure paid
traffic, so it has to be there the moment the page is. Meta's `<noscript>`
beacon covers visitors without JavaScript.

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
so they cost nothing when no pixel is configured.

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
