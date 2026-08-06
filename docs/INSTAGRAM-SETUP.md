# Instagram feed carousel — setup

The homepage "Follow along" section shows real Instagram posts pulled from
the `bartawindowwashing` account. This only works once two things are set up
in the GitHub repo (Settings → Secrets and variables → Actions):

## Required: `INSTAGRAM_ACCESS_TOKEN`

A long-lived Instagram access token for the `bartawindowwashing` account,
generated from the Meta developer app's Instagram API setup page
("Generate access tokens" → Add account → log in as `bartawindowwashing`).

Add it as a repository secret named `INSTAGRAM_ACCESS_TOKEN`.

This token expires after 60 days. Every run of the "Sync Instagram Feed"
workflow tries to refresh it automatically — if the optional `GH_PAT` secret
below is also set, the refreshed token gets saved back automatically and you
never have to think about it again. Without `GH_PAT`, you'll need to
generate a fresh token from the Meta dashboard and update this secret by
hand before the old one expires (roughly every 2 months).

## Optional: `GH_PAT` (enables automatic token refresh)

A GitHub personal access token that lets the workflow update the
`INSTAGRAM_ACCESS_TOKEN` secret itself after refreshing it, so it never
expires unattended.

To create one: GitHub → Settings (your account, not the repo) → Developer
settings → Personal access tokens → Fine-grained tokens → Generate new
token. Scope it to **this repository only**, with **Secrets: Read and
write** permission, and nothing else. Add the resulting token as a
repository secret named `GH_PAT`.

## How the sync works

- `.github/workflows/instagram-sync.yml` runs daily (and can be triggered
  manually from the Actions tab → "Sync Instagram Feed" → "Run workflow").
- It runs `build/instagram_sync.py`, which calls the Instagram API, downloads
  each post's image into `assets/img/instagram/`, and writes
  `build/instagram_feed.json`.
- It then runs `build/build.py` to regenerate the site (the homepage's
  carousel is built from that JSON file) and commits/pushes the result.
- That push triggers the existing `deploy.yml` workflow automatically, same
  as any other content change.

`build/build.py` itself never makes network calls — only
`build/instagram_sync.py` does, and only when run with a valid
`INSTAGRAM_ACCESS_TOKEN` in its environment (i.e. only in CI). If the
manifest file doesn't exist yet (a fresh checkout, before the first sync has
ever run), the carousel section simply doesn't render — the page falls back
to just the social icon row, no broken build.
