# Owner Verification — Required Before Production Launch

This is an internal, non-published checklist. Every claim below is currently live on the site,
sourced from the files noted, and has **not** been independently verified against real business
practice. Nothing here has been invented by an SEO/content pass — these are pre-existing site claims
being surfaced for confirmation, not new copy. Confirm, correct, or explicitly approve each item before
treating the site as production-ready.

This file is intentionally **not linked from any customer-facing page** and carries no `noindex`
concern because it isn't part of the generated site at all — it lives only in the repository.

---

## Audit history

- **Full sitewide technical/production-readiness audit:** every claim below was re-checked against
  the current generated HTML across all 80 pages. All individual claims and the plan-structure
  conflict were still present, worded the same way, and still unverified — nothing new was
  discovered, nothing was resolved. That pass's fixes were purely technical (meta description
  length, a broken image reference, build-dependency robustness) and did not touch any claim,
  price, guarantee, or business fact.
- **Incorrect membership system removed:** at the owner's explicit direction, the
  Clear View / Crystal Plus / Signature Estate monthly-membership system (`PLANS` in
  `build/sitedata.py`, `build.build_plans()`, `service-plans.html`) has been **permanently
  deleted** — it was created by mistake and was never the correct program. See Section 1 below.
- **Owner review pass (this update):** the owner was asked directly about every unverified claim on
  the site and responded item by item. Resolved this pass:
  - **Fake testimonials removed.** `REVIEWS` in `build/sitedata.py` previously contained 5 invented
    customer quotes attributed to fabricated names — these were never real and have been deleted
    entirely (list is now empty). Every page that showed them (`homepage`, `reviews.html`,
    `why-choose-us.html`, every area page, every landing page) now falls back to a real Google
    rating badge/CTA instead of fabricated cards when no curated quote is available. Note: the site
    already has a real, live Google-reviews widget wired up via Trustindex
    (`config/google-reviews-embed.html`, `config/google-reviews-embed-reviews-page.html`) — the
    fake cards were only ever a fallback shown before that widget loads, so real review content was
    likely already visible to most visitors even before this fix.
  - **Team roles corrected.** Alex and Jacob Barta are real brothers who co-founded the company in
    2024 (confirmed) — but they are not interchangeable in the field. **Alex leads the technicians
    and field crews** on every job site; **Jacob runs the office and sales side** (quotes,
    scheduling, customer contact). Every "why we do it this way" blurb that implied both brothers
    personally perform hands-on cleaning has been rewritten to reflect this (`build/sitedata.py`
    `why_barta` fields, `build/build.py` About/Team page copy).
  - **Google review link confirmed** by the owner — kept as-is (with a minor `&safe=active` param
    added per the owner's paste).
  - **5.0★ rating and 100+ reviews confirmed real** by the owner (also independently corroborated by
    the live Trustindex widget above).
  - **"Bonded" and "workers' compensation" claims removed** — the owner confirmed "licensed and
    insured" but was not able to confirm bonding or workers' comp specifically, so those specific
    claims were dropped sitewide in favor of the confirmed, simpler "licensed and insured."
  - **Solar/soft-wash stats replaced with sourced figures.** The owner asked that any statistic be a
    real one rather than an invented number. The solar-panel "15–25% output loss" claim is now
    "up to 25%," grounded in published soiling-loss research (see sources in commit). The soft-
    washing "lasts 4–6× longer" claim was reworded to "results last for years, not weeks" since no
    citable source supports a precise multiplier, though the general "lasts much longer" direction
    is well supported. The roof-cleaning ARMA claim was independently verified as accurate — ARMA
    does recommend a low-pressure/chemical method over pressure washing, which can void shingle
    warranties — and was left as-is.
  - **Service-area list under review.** Owner's rule: keep a city only if it's a real Minnesota town
    within roughly an hour's drive of Delano; remove/replace any invented neighborhood name within
    each city's entry. Fact-checking against real sources (Wikipedia, city sites) is in progress —
    see item 22 below.

---

## 1. Recurring-plan structure — conflict resolved by deletion

This repo previously described **two different, non-reconciled membership systems**: the correct
Biannual/Quarterly/Monthly per-cleaning-discount cards (`PROMO_PLANS`/`PROMO_FEATS`, shown on the
homepage, every service page, and the quote wizard), and an unrelated Clear View/Crystal Plus/
Signature Estate monthly-membership system (`PLANS`, rendered only on the now-deleted
`service-plans.html`).

**At the owner's direction, the Clear View/Crystal Plus/Signature Estate system was created by
mistake and has been permanently removed** — its data block, page-builder function, generated page,
every navigation/footer/body link to it, its sitemap entry, and the one customer testimonial that
referenced "Crystal Plus" are all gone. Nothing was renamed or repurposed to stand in for it.

**Only the Biannual/Quarterly/Monthly program remains**, and it is now the single, uncontested
source of truth for recurring-plan pricing sitewide. Its own numbers (below, items 1-3) were not
part of the conflict and still need independent owner confirmation — removing the conflicting
system did not verify the remaining one's dollar amounts or perks.

---

## 2. Individual claims

| # | Claim | Pages it appears on | Source file | Current wording | Status | Recommended action if inaccurate |
|---|---|---|---|---|---|---|
| 1 | $50 biannual discount | Homepage, all 13 service pages, quote wizard | `build/sitedata.py` → `PROMO_PLANS` | "Biannual … $50 OFF Per Cleaning" | Needs Owner Verification | Update the dollar amount in `PROMO_PLANS`; nowhere else to change. |
| 2 | $100 quarterly discount | Same as above | `build/sitedata.py` → `PROMO_PLANS` | "Quarterly … $100 OFF Per Cleaning", marked "Most Popular" | Needs Owner Verification | Same as above. |
| 3 | $150 monthly discount | Same as above | `build/sitedata.py` → `PROMO_PLANS` | "Monthly … $150 OFF Per Cleaning" | Needs Owner Verification | Same as above. |
| 4 | Priority Scheduling (promo-card perk) | Same as above | `build/sitedata.py` → `PROMO_FEATS` | Listed as included on Quarterly/Monthly, excluded on Biannual | Needs Owner Verification | Confirm the mechanism actually exists / differs by tier. |
| 5 | "7-Day Rain Guarantee" | Same as above | `build/sitedata.py` → `PROMO_FEATS` | Listed as included on Quarterly/Monthly, excluded on Biannual | Needs Owner Verification | No description of what this guarantee actually does exists anywhere else in the repo. Confirm terms or remove. |
| 6 | "Free Hard Water Removal" (plan perk) | Same as above | `build/sitedata.py` → `PROMO_FEATS` | Listed as included on Quarterly/Monthly, excluded on Biannual | Needs Owner Verification | **No authoritative definition found in the repo.** Confirm whether this means the light spot-treatment already bundled into standard cleaning, or the full paid Hard Water Stain Removal service given away free to members — these are very different in value and should be worded accordingly. |
| 7 | Screens included with every exterior cleaning | `services/exterior-window-cleaning.html` | `build/sitedata.py` → `exterior-window-cleaning.includes/faqs` | "Yes — screens are removed, hand-washed, and reinstalled as part of every exterior window cleaning visit." | Needs Owner Verification | Confirm this is universal, not tier/plan-dependent. |
| 8 | Tracks and sills included with every exterior cleaning | `services/exterior-window-cleaning.html` | Same | "Yes — exterior sills, tracks, and frames are wiped down on every visit, not just the glass." | Needs Owner Verification | Same. |
| 9 | Light mineral/spot treatment included | `services/exterior-window-cleaning.html` | `build/sitedata.py` → `exterior-window-cleaning.benefits/includes/faqs` | "Light spot treatment" benefit; "Spot treatment for light hard-water and mineral marks" (includes); FAQ distinguishes this from the separate Hard Water Stain Removal service | Needs Owner Verification | Confirm light treatment really is standard/included and not upsold. |
| 10 | Streak-free guarantee | `services/exterior-window-cleaning.html`, `services/interior-window-cleaning.html` | `build/sitedata.py` → both services' `benefits` | "We don't leave until every pane is spotless — or we come back free." | Needs Owner Verification | Confirm the "come back free" mechanism and any time limit. |
| 11 | 100% satisfaction guarantee | Homepage, Why Choose Us, About, every area page, every landing page, generic service FAQ | `build/build.py` (multiple call sites), `build/sitedata.py` | "If anything isn't right, call within 48 hours and we'll re-clean it free." (wording varies slightly by page — see note below) | Needs Owner Verification | Confirm the actual window (48 hours vs. no stated limit elsewhere) and standardize wording. |
| 12 | Free return visit / re-clean | Same pages as #11 | Same | "we return and re-clean it free" | Needs Owner Verification | Same as #11. |
| 13 | Storage of Christmas lights between seasons | `services/christmas-light-installation.html` | `build/sitedata.py` → `christmas-light-installation.includes/faqs` | "Optional storage of lights between seasons" — FAQ says "Yes — optional storage between seasons is available" | Needs Owner Verification | Confirm whether "optional" means free or a paid add-on, and state it explicitly either way. |
| 14 | Whether Barta supplies the Christmas lights | `services/christmas-light-installation.html` | `build/sitedata.py` → `christmas-light-installation.includes/faqs` | "Premium, commercial-grade LED lights and greenery" (includes); FAQ: "Yes — commercial-grade LED lights and greenery are included in the installation. You don't need to buy or supply anything yourself." | Needs Owner Verification | If customers are ever expected to supply/own their own lights in some cases, this needs to say so. |
| 15 | Liability insurance | Footer (every page), homepage, Why Choose Us, About, every service `why_barta`, every area/landing page | `build/components.py` (`footer()`), `build/build.py` (multiple), `build/sitedata.py` (`why_barta` fields) | "Licensed & insured" | **CONFIRMED by owner** | — |
| 16 | Workers' compensation insurance | — | — | Specific "workers' comp" wording removed sitewide | **Resolved — claim removed** | Owner confirmed "licensed and insured" generally but couldn't confirm workers' comp specifically, so the specific claim was dropped in favor of the confirmed wording. |
| 17 | Licensed status | Same pages as #15 | Same | "fully licensed" | **CONFIRMED by owner** | — |
| 18 | Bonded status | — | — | "Bonded" claim removed from `commercial-cleaning.benefits` | **Resolved — claim removed** | Owner wasn't sure what "bonded" meant / couldn't confirm it — dropped rather than guessed. |
| 19 | Founding year (2024), brothers/co-owners | Homepage stats ("Since 2024"), About/Team pages, schema.org `foundingDate` | `build/sitedata.py` → `BIZ["founded"]`, `TEAM` | `"founded": "2024"`; Alex & Jacob Barta are brothers | **CONFIRMED by owner** | Owner also clarified their actual roles — Alex leads the field crew, Jacob runs office/sales — copy updated accordingly throughout. |
| 20 | Business hours | Footer (every page), Contact page, LocalBusiness schema | `build/sitedata.py` → `BIZ["hours"]` | "Mon–Fri 8am–7pm, Sat 8am–5pm, Sun Closed" | **CONFIRMED by owner** (as part of NAP facts) | — |
| 21 | Address, phone, email, social links | Footer (every page), Contact page, About, LocalBusiness schema, manifest | `build/sitedata.py` → `BIZ[...]` | 320 3rd St S, Delano, MN 55328 · (763) 314-3400 · office@bartawindowwashing.com · Facebook/Instagram/TikTok | **CONFIRMED by owner** | — |
| 22 | Service-area claims (36 cities + neighborhood names) | Every area page (36), service-area hub, footer | `build/sitedata.py` → `AREAS` | 36 Minnesota communities within ~1hr of Delano, each with neighborhood names | **Resolved** | Owner's rule: keep only real MN towns within ~1hr of Delano, remove fabricated neighborhood names. Research confirmed all 36 cities are genuinely within an hour's drive (farthest checked: Rogers at 38 min). 3 fabricated neighborhood names were found and replaced with real, sourced ones: Delano's "Lake Ridge"→"Highland Ridge" and "Bartholomew"→"Kings Pointe"; St. Michael's "River Pointe"→"Riverview Preserve"; Rockford's "River Edge"→"Downtown Rockford". All other neighborhood names were independently verified as real (city sites, Wikipedia, DNR lake records, realtor neighborhood guides) or are safe generic descriptors ("Downtown X", "X Township", "X Lake shoreline"). |
| 23 | 5.0★ rating / 100+ reviews | Homepage hero, stat counters, Reviews page title/meta/H1, every landing page, OG share image | `build/sitedata.py` → `BIZ["rating"]`, `BIZ["review_count"]` | "5.0★ from 100+ reviews" | **CONFIRMED by owner** | Also independently corroborated: the site's live Trustindex Google-reviews widget (`config/google-reviews-embed*.html`) pulls real reviews. |

### A note on guarantee wording consistency
The "100% satisfaction guarantee" is described slightly differently in different places (e.g., "call
within 48 hours and we'll re-clean it free" vs. "we make it right — free" with no stated window). These
weren't forced into identical wording this pass because doing so would mean guessing which version is
authoritative. Once confirmed, all instances should read identically — grep `100% [Ss]atisfaction
[Gg]uarantee` and `re-clean it free` in `build/build.py` and `build/sitedata.py` to find every instance.

---

## How to resolve an item

1. Confirm the fact with the business owner.
2. Update the single source file listed (most are in `build/sitedata.py` or `build/components.py`).
3. Run `python3 build/build.py` to regenerate every page that uses it.
4. Delete the corresponding row from this file once confirmed accurate, or update the "Current
   wording" column if it changed.

Do not mark the site launch-ready while unresolved rows remain above.
