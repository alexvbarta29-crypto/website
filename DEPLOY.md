# Deploying the site

This is a **static site** (plain HTML/CSS/JS at the repo root), so it runs on any static host with
no build step. Three ready-to-go options are included.

---

## Option A — GitHub Pages (no signup, deploys from this repo)

A workflow at `.github/workflows/deploy.yml` publishes the site automatically.

**One-time setup:**
1. On GitHub, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. That's it. Every push to the `claude/barta-window-washing-site-f51v9x` branch now builds and
   deploys automatically (you can also trigger it from the **Actions** tab → *Deploy site to GitHub
   Pages* → *Run workflow*).

**Your live URL** will be:
`https://alexvbarta29-crypto.github.io/website/`

(The Actions run also prints the URL in the deploy step.) All internal links are relative, so the
site works correctly under the `/website/` subpath.

---

## Option B — Netlify (custom domain in minutes)

1. Create a free account at [netlify.com](https://netlify.com).
2. **Add new site → Import an existing project →** connect this GitHub repo.
3. Netlify reads `netlify.toml` — no build command needed. Click **Deploy**.
4. You'll get a `*.netlify.app` URL instantly; add your real domain under **Domain settings**.

Drag-and-drop alternative: zip the repo (minus `.git`) and drop it on Netlify's **Deploys** page.

---

## Option C — Vercel

1. Create a free account at [vercel.com](https://vercel.com).
2. **Add New → Project →** import this repo. Framework preset: **Other**.
3. Vercel reads `vercel.json` (clean URLs, asset caching). Click **Deploy**.

---

## Pointing your real domain

Once live on any host above, add `www.bartawindowwashing.com` in the host's domain settings and
update your DNS (the host gives you the exact records). The site's canonical/SEO URLs already use
that domain — set the final domain in `build/sitedata.py` (`BIZ["domain"]`) and rebuild if it
changes.

> Tip: GitHub Pages is the fastest way to get a shareable preview link today. Netlify or Vercel are
> better long-term homes if you want a custom domain, form handling, and analytics.

> The quote form (`/api/lead`) and the customer referral program (`/api/referral`, the
> `admin/referrals.html` dashboard) run on Netlify Functions + Netlify Blobs, so they only work on
> the Netlify deployment. Required environment variables: `ROTOR_API_KEY` and `REFERRAL_ADMIN_KEY`
> (see `docs/LEAD-FORM-SETUP.md` and `docs/REFERRAL-PROGRAM.md`).
