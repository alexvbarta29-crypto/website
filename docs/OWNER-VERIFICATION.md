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
- **Incorrect membership system removed (this pass):** at the owner's explicit direction, the
  Clear View / Crystal Plus / Signature Estate monthly-membership system (`PLANS` in
  `build/sitedata.py`, `build.build_plans()`, `service-plans.html`) has been **permanently
  deleted** — it was created by mistake and was never the correct program. See Section 1 below.

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
| 15 | Liability insurance | Footer (every page), homepage, Why Choose Us, About, every service `why_barta`, every area/landing page | `build/components.py` (`footer()`), `build/build.py` (multiple), `build/sitedata.py` (`why_barta` fields) | "Licensed & insured in Minnesota" (footer); "fully licensed and carries liability and workers' compensation insurance" (FAQ) | Needs Owner Verification | If not currently true, this is the single highest-priority item to fix before launch — it appears sitewide. |
| 16 | Workers' compensation insurance | Same pages as #15 | Same | "workers' compensation insurance" / "workers' comp coverage" | Needs Owner Verification | Same as #15. |
| 17 | Licensed status | Same pages as #15 | Same | "fully licensed" | Needs Owner Verification | Same as #15. |
| 18 | Bonded status | `services/commercial-cleaning.html` only | `build/sitedata.py` → `commercial-cleaning.benefits` | "Fully insured &amp; bonded" | Needs Owner Verification | Confirm bonding actually applies (it's not claimed anywhere else on the site, only here). |
| 19 | Founding year (2024) | Homepage stats ("Since 2024"), schema.org `foundingDate` | `build/sitedata.py` → `BIZ["founded"]` | `"founded": "2024"` | Needs Owner Verification | Single source — update once in `BIZ` if wrong. |
| 20 | Business hours | Footer (every page), Contact page, LocalBusiness schema | `build/sitedata.py` → `BIZ["hours"]` | "Mon–Fri 8am–7pm, Sat 8am–5pm, Sun Closed" | Needs Owner Verification | Single source — update once in `BIZ`. |
| 21 | Address, phone, email | Footer (every page), Contact page, About, LocalBusiness schema, manifest | `build/sitedata.py` → `BIZ["street"/"city"/"state"/"zip"/"phone_display"/"phone_href"/"email"]` | 320 3rd St S, Delano, MN 55328 · (763) 314-3400 · office@bartawindowwashing.com | Needs Owner Verification | Single source, internally consistent everywhere checked — only the underlying facts need confirming. |
| 22 | Service-area claims | Every area page (36), service-area hub, footer | `build/sitedata.py` → `AREAS` | 36 named western-Twin-Cities-metro communities, each with real neighborhood names | Needs Owner Verification | Confirm Barta genuinely services all 36 today; consider trimming any that aren't actually served yet. |
| 23 | 5.0★ rating / 100+ reviews | Homepage hero, stat counters, Reviews page title/meta/H1, every landing page, OG share image | `build/sitedata.py` → `BIZ["rating"]`, `BIZ["review_count"]` | "5.0★ from 100+ reviews" | Needs Owner Verification | Flagged in the prior SEO pass too — still unresolved. An exact 5.0 average with a round 100-review count reads as a placeholder; confirm against the real Google Business Profile figure. |

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
