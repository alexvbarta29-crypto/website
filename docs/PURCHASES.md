# Purchases (Barta Office → Purchases, /purchases)

The family's shared buy list, so Alex, Jacob and Dad are on the same page
about everything the business buys.

1. **Ask to buy:** what it is, the link, price each, how many, and why we need it.
2. **Vote:** everyone can thumbs-up or thumbs-down. **Dad decides:** his
   Approve/Deny sets the status; Alex's and Jacob's votes are input.
3. **Mark ordered** (only once Dad has approved): order number, what we
   actually paid, and the tracking link (a **Track package** button).
4. **Mark delivered.**

Anyone can add notes, edit, or delete an item. Tabs: Needs a decision ·
Approved, to order · Ordered · Delivered · Denied · All, with totals for
what's waiting, approved but not ordered, and ordered this month. The list
refreshes itself every 20 seconds.

"Who are you" is picked once per browser (Alex / Jacob / Dad); it's not a
separate login, since everyone signs in with the one office password.

- Page: `netlify/functions/purchases.mjs` + `netlify/lib/purchases-page.mjs`
- API: `netlify/functions/purchases-api.mjs` (`GET`/`POST /api/purchases`),
  logic in `netlify/lib/purchases.mjs` (people and who decides are
  `PEOPLE` / `DECIDER` there)
- Storage: Netlify Blobs store `purchases`, one record per item at `item/{id}`
- Tests: `tests/purchases.test.mjs`
