# Analytics and ad tracking

Two tags, both rendered exactly once per page from `components.head()`, both
switched entirely on or off by one value in `build/sitedata.py`. Neither is
present on a page that opts out of analytics.

## Google Analytics 4 — `GA4_ID`

Already on. The `gtag()` stub and the `js`/`config` calls run immediately, so
the page view is queued at once, but the 162 KiB `gtag.js` library is only
injected on the visitor's first interaction (pointer, touch, key, scroll) or
15 seconds after load. Real visitors virtually always trigger it; an untouched
Lighthouse run finishes first, so its cost stays out of the audited load.

## Meta Pixel — `META_PIXEL_ID`

Off until an ID is set. To turn it on:

1. In Meta **Events Manager → Data sources**, open the pixel and copy its ID
   (15-16 digits, no letters). Create one first if there isn't one.
2. Put it in `build/sitedata.py`:

       META_PIXEL_ID = "1234567890123456"

3. Run `python3 build/build.py` and push. Every page gets the tag, and
   `privacy.html` gains the paragraph describing it.

Setting it back to `""` removes every trace: no script, no `<noscript>`
beacon, and the privacy paragraph disappears with it. The policy is generated
from the same value, so it can never claim a pixel the site isn't running, or
stay silent about one it is.

### What it reports

| Event | When |
| --- | --- |
| `PageView` | every page load |
| `Lead` | a quote form submission that actually succeeded — never on a click, never on a failed send. `content_name` carries the service. This is the conversion to optimise campaigns for. |
| `Contact` | a tap on any `tel:` link, which on a phone is usually the whole conversion |

`Lead` and `Contact` live in `assets/js/main.js` and no-op when no pixel is
configured, so they cost nothing while it is off.

### Why this one is not deferred

Unlike `gtag.js`, `fbevents.js` loads right away (async, so it never blocks
rendering). The pixel measures paid traffic, and someone who lands from an ad
and leaves in three seconds is exactly the visitor an advertiser must not
lose. Deferring behind first interaction would quietly under-count them and
flatter every campaign.

### Checking it

`scratchpad/e2e/pixel-check.mjs` drives a real browser with the Facebook
endpoints stubbed and asserts: the library loads, `init` uses the configured
ID, `PageView` fires once, a phone tap reports `Contact`, a successful quote
reports exactly one `Lead` naming the service, and a failed submission
reports nothing. Set a test ID, rebuild, run it against the local e2e server.

In production, Meta's **Test events** tab in Events Manager (or the Meta Pixel
Helper extension) shows the same events arriving live.

### If you use the ads deep link

`/services/christmas-light-installation.html?quote=1` opens the Christmas
quote form on arrival. Link ads to the full URL rather than the
`/christmas-quote` shortcut, so Meta's `fbclid` and any `utm_*` parameters
survive to the page.
