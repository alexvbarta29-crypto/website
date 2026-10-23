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

- `.github/workflows/instagram-sync.yml` runs daily, plus three story checks a
  day (every 6 hours in all), and can be triggered manually from the Actions
  tab → "Sync Instagram Feed" → "Run workflow".
- It runs `build/instagram_sync.py`, which calls the Instagram API, downloads
  each post's image into `assets/img/instagram/`, and writes
  `build/instagram_feed.json`.
- It then runs `build/build.py` to regenerate the site (the homepage's
  carousel is built from that JSON file) and commits/pushes the result.
- Netlify publishes that push to the live site, same as any other content
  change.

`build/build.py` itself never makes network calls — only
`build/instagram_sync.py` does, and only when run with a valid
`INSTAGRAM_ACCESS_TOKEN` in its environment (i.e. only in CI). If the
manifest file doesn't exist yet (a fresh checkout, before the first sync has
ever run), the carousel section simply doesn't render — the page falls back
to just the social icon row, no broken build.

## Stories

- Every run also asks the API for the account's live stories (the API only
  returns stories posted in the last 24 hours, hence the 6-hourly checks).
  Each new story's photo, or video plus a still, is saved as
  `assets/img/instagram/story-<id>.*` and listed in
  `build/instagram_stories.json`, which keeps it after Instagram drops it.
  Story videos are re-encoded to 720px wide with ffmpeg to keep the repo lean.
- The homepage carousel mixes stories in among the posts by date: the newest
  12, at most 3 from any one day, none older than the oldest post shown
  (`MAX_CAROUSEL_STORIES` / `STORIES_PER_DAY` in `build/components.py`). A
  story's Instagram badge links to the profile, since story links expire.
  Stories are not added to the Gallery.
- Only the newest 24 stories are kept (`MAX_STORIES` in
  `build/instagram_sync.py`); older ones' files are deleted.
- To keep a story off the site, add its id to `EXCLUDED_STORY_IDS` in
  `build/instagram_sync.py` and rebuild.
- A story check only rebuilds and commits when the posts or stories changed,
  so it doesn't trigger a Netlify deploy for nothing.

## Story Highlights

The Instagram API has no way to read Highlights (only stories that are live
right now), so they can't sync automatically. To show Highlights, save their
photos and videos from the Instagram app and add them to the site by hand.
