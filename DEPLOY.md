# Deploying the site

The live site, **www.bartawindowwashing.com**, is hosted on **Netlify**. Every push to the
`claude/barta-window-washing-site-f51v9x` branch publishes automatically, including the daily
Instagram-sync commit.

## How a deploy works

1. Pages are generated locally with `python3 build/build.py`, and the generated HTML is committed.
   Netlify does not run the page build itself.
2. On each push, Netlify runs the build command in `netlify.toml`, `python3 build/make_deploy.py`.
   It assembles `_deploy/` from the site pages plus only the assets they reference, so `docs/`,
   `build/`, `config/` and unused full-size photo originals are never served.
3. Netlify publishes `_deploy/`, the redirects in the generated `_redirects` file, the headers in
   `netlify.toml`, and the serverless functions in `netlify/functions/`.

The quote form (`/api/lead`) and the customer referral program (`/api/referral`, the
`admin/referrals.html` dashboard) run on Netlify Functions + Netlify Blobs, so they only work on
Netlify. Required environment variables (Netlify → Site configuration → Environment variables):
`ROTOR_API_KEY` and `REFERRAL_ADMIN_KEY` (see `docs/LEAD-FORM-SETUP.md` and
`docs/REFERRAL-PROGRAM.md`).

## No second copy

A GitHub Pages copy at `alexvbarta29-crypto.github.io/website/` used to be published on every push
as well. It was switched off in October 2026, and its workflow (`.github/workflows/deploy.yml`) was
deleted. Its quote form could never work, because GitHub Pages can't run the Netlify functions.
Don't re-enable it. To take down the last published copy: GitHub → this repo → **Settings →
Pages** → **Unpublish site**.

## Domain

`BIZ["domain"]` in `build/sitedata.py` sets every canonical, Open Graph, sitemap and schema URL.
If the domain ever changes, update it there, rebuild, and update the domain in Netlify's
**Domain management**.
