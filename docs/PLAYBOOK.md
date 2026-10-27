# Follow-up playbook (/playbook)

The office's call-first text sequences (New Quote Requests and Estimate Follow-Ups),
modeled on Mint's follow-up templates. Served by `netlify/functions/playbook.mjs` from
`netlify/lib/playbook-page.mjs`. Not linked from the site, never indexed.

- **Password:** the `PLAYBOOK_PASSWORD` Netlify env var if set; otherwise the same password
  as Barta Light Studio. Changing it signs every device out.
- **Remembered device:** the right password sets a year-long HttpOnly cookie scoped to
  `/playbook`, renewed on every visit.
- **Review count:** read live from `/api/review-stats` (falls back to 150).
- **Rep names:** Alex or Jacob, remembered per browser.
