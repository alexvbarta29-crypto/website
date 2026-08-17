# Quote form — where leads go

Every quote form on the site (the quote wizard, each service page, each
landing page, and the holiday-lighting modal) posts to one place, set in
`build/sitedata.py` → `LEAD_FORM`.

**Current wiring: Rotor CRM via a Netlify Function.** `endpoint` is
`/api/lead`, a same-origin serverless function (`netlify/functions/lead.mjs`)
that forwards each submission to Rotor's open API
(`POST https://api.getrotor.com/open-api/leads`). Rotor upserts by phone
first, then email, and merges tags — so a returning visitor updates their
existing lead instead of creating a duplicate.

## The one manual step: the API key

The function reads the key from the `ROTOR_API_KEY` environment variable.
It is **not** in the repo and must never be — anything in the repo or the
pages is public.

1. In Rotor: **Settings → Integrations → generate/copy API key**
   (limit: 1,000 requests/day — far above any realistic lead volume).
2. In Netlify: **Site configuration → Environment variables → Add**
   `ROTOR_API_KEY` = the key. Redeploy.

Until the variable is set (and on the GitHub Pages preview, which has no
functions at all), the POST fails and the form shows the phone/email
fallback — visitors are never shown a false "we got it" confirmation.

## What lands in Rotor (API version 1.1.0, `rotor-api-version` header)

- `name` (or first + last), `phone`, `email`
- Structured address: `address_street1/street2/city/state/zip/country` —
  Nominatim selection fills city/state (two-letter)/zip/country into hidden
  form fields; the function falls back to MN/US only when they're missing
- `service_type`: the selected service(s), capped at Rotor's 100-character
  limit (whole names only — overflow services still arrive via tags)
- `tags`: exactly one — `Website`
- `source`: "Website quote form"
- `notes` (≤2,000 chars): three things only, per the owners — the
  customer's own message first ("Customer notes:"), then "Services: …"
  and "Plan: …" lines when selected. The customer's message survives any
  truncation ahead of those lines. Other form answers (promo code,
  preferred date/time, referral source, lights location) are deliberately
  NOT transmitted to Rotor. Empty optional fields are omitted from the
  payload entirely.

## After setting the key

Submit a test from the live Netlify site and confirm the lead appears in
Rotor with its tags and notes. The form only shows the success screen when
`/api/lead` returns 2xx — if you see the phone-number fallback instead, check
the function log in the Netlify dashboard (it records Rotor's status code and
error body whenever a lead is rejected).
