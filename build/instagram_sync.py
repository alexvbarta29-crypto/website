#!/usr/bin/env python3
"""
Fetches the latest posts from the Barta Window Washing Instagram account via
the Instagram API (Instagram Login) and caches them locally for the homepage
carousel — the actual page build (build.py) never makes network calls, it
only reads the JSON manifest this script writes.

This script needs real internet access to graph.instagram.com, so it's meant
to run in the "Sync Instagram Feed" GitHub Action (.github/workflows/
instagram-sync.yml), not in a network-sandboxed environment. Run manually
with:  INSTAGRAM_ACCESS_TOKEN=... python3 build/instagram_sync.py
"""
import json, os, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IMG_DIR = os.path.join(ROOT, "assets", "img", "instagram")
MANIFEST_PATH = os.path.join(HERE, "instagram_feed.json")
MAX_POSTS = 10
API_BASE = "https://graph.instagram.com"


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "barta-site-instagram-sync/1"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def refresh_token(token):
    """Long-lived Instagram tokens last 60 days and can be refreshed for
    another 60 any time before they expire. Best-effort: if this fails (too
    soon to refresh, token already expired, network hiccup) we just carry on
    with the token we were given."""
    url = f"{API_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token={token}"
    try:
        data = _get_json(url)
        new_token = data.get("access_token")
        if new_token:
            print("  Token refreshed.")
            return new_token
    except Exception as e:
        print(f"  (token refresh skipped: {e})")
    return token


def fetch_media(token):
    fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp"
    url = f"{API_BASE}/me/media?fields={fields}&access_token={token}&limit={MAX_POSTS}"
    return _get_json(url).get("data", [])


def download_image(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
        f.write(r.read())


def main():
    token = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "").strip()
    if not token:
        print("INSTAGRAM_ACCESS_TOKEN not set — skipping Instagram sync.")
        return

    token = refresh_token(token)
    os.makedirs(IMG_DIR, exist_ok=True)

    try:
        items = fetch_media(token)
    except urllib.error.HTTPError as e:
        print(f"Instagram API error: {e.code} {e.read().decode()[:300]}")
        sys.exit(1)

    manifest = []
    for item in items[:MAX_POSTS]:
        media_type = item.get("media_type")
        # Carousel albums and videos don't expose a directly-usable still
        # image in media_url the same way photos do — thumbnail_url covers
        # video; a CAROUSEL_ALBUM's cover comes back as its own media_url.
        img_url = item.get("thumbnail_url") if media_type == "VIDEO" else item.get("media_url")
        if not img_url:
            continue
        post_id = item["id"]
        local_name = f"{post_id}.jpg"
        local_path = os.path.join(IMG_DIR, local_name)
        try:
            download_image(img_url, local_path)
        except Exception as e:
            print(f"  (skipped post {post_id}: {e})")
            continue
        manifest.append({
            "id": post_id,
            "image": f"assets/img/instagram/{local_name}",
            "caption": (item.get("caption") or "").strip(),
            "permalink": item.get("permalink"),
            "timestamp": item.get("timestamp"),
            "type": media_type,
        })

    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Synced {len(manifest)} Instagram posts.")

    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        print(f"::add-mask::{token}")
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write(f"refreshed_token={token}\n")


if __name__ == "__main__":
    main()
