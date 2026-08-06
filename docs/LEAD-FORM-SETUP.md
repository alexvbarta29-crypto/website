# Quote form — where leads go

Every quote form on the site (45 pages: the quote wizard, each service page,
each landing page, and the holiday-lighting modal) posts to one place, set in
`build/sitedata.py` → `LEAD_FORM`.

```python
LEAD_FORM = {
    "endpoint": "",     # the URL submissions are POSTed to
    "access_key": "",   # only for services that use a public submit key
    "subject": "New quote request from bartawindowwashing.com",
}
```

Set `endpoint`, run `python3 build/build.py`, commit, push. That's the whole
change — no markup edits, and the form keeps its current design.

## Until an endpoint is set

The forms **do not show a success message**. They show the phone number and
email instead, with everything the visitor typed still on screen.

This is deliberate. Before this was wired up the form displayed "Thank you!
Your request is in." and then silently discarded the submission — so people
believed they'd reached the business when they hadn't. An honest failure is
better than a false confirmation.

## What gets sent

A JSON POST containing every field the visitor filled in:

`name`, `phone`, `email`, `address`, `address_verified`, `services` (array),
`preferred_date`, `preferred_time`, `referral_source`, `notes`, `reminders`,
`plan_info`, `plan`, plus `page` (which page it came from) and `subject`.

## Choosing an endpoint

This is a static site on GitHub Pages — there is no server. The browser posts
directly to whatever URL is configured, which means:

> **Never put a secret API key in `LEAD_FORM`.** Everything in it is visible in
> the page source. Only use endpoints that are safe to call publicly.

In order of preference:

1. **A CRM inbound-lead / webhook URL.** If Rotor (or whatever CRM is in use)
   exposes a URL that accepts a POST without a secret, use it directly. Leads
   land in the CRM natively, no middleman.

2. **A Zapier or Make "catch hook".** Create a webhook trigger, paste its URL
   here, and have the automation create the record in the CRM. Also safe to
   expose. Note Zapier puts webhooks on a paid tier; Make includes them free.

3. **A form-to-email service** (Web3Forms, Formspree, Basin). Gives you an
   email per submission at `office@bartawindowwashing.com`, which you enter
   into the CRM by hand. Web3Forms uses a public access key — that one is
   designed to be exposed, so it goes in `access_key` safely.

4. **API key required, no public option.** Then the key needs to live somewhere
   the browser can't see it — a small Cloudflare Worker or similar proxy that
   holds the key and forwards to the CRM. `endpoint` points at the proxy. Extra
   moving part; only worth it if 1–3 aren't available.

## After setting it

Submit a real test from the live site and confirm the lead arrives. The form
only shows the success screen when the endpoint returns a 2xx response, so if
you see the phone-number fallback, the POST failed — check the browser console
for the status code.
