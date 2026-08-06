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


def fetch_children(media_id, token):
    fields = "id,media_type,media_url,thumbnail_url"
    url = f"{API_BASE}/{media_id}/children?fields={fields}&access_token={token}"
    try:
        return _get_json(url).get("data", [])
    except Exception as e:
        print(f"  (children fetch skipped for {media_id}: {e})")
        return []


def download_file(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        f.write(r.read())


def _save_slide(media_type, media_url, thumbnail_url, name):
    """Downloads one slide's assets (a still image always, plus the actual
    video file when it's a video) and returns its manifest dict, or None if
    nothing usable was downloaded."""
    slide = {"type": media_type}
    still_url = thumbnail_url if media_type == "VIDEO" else media_url
    if still_url:
        try:
            download_file(still_url, os.path.join(IMG_DIR, f"{name}.jpg"))
            slide["image"] = f"assets/img/instagram/{name}.jpg"
        except Exception as e:
            print(f"  (skipped image for {name}: {e})")
    if media_type == "VIDEO" and media_url:
        try:
            download_file(media_url, os.path.join(IMG_DIR, f"{name}.mp4"))
            slide["video"] = f"assets/img/instagram/{name}.mp4"
        except Exception as e:
            print(f"  (skipped video for {name}: {e})")
    return slide if slide.get("image") else None


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
        post_id = item["id"]

        slides = []
        if media_type == "CAROUSEL_ALBUM":
            for i, child in enumerate(fetch_children(post_id, token)):
                slide = _save_slide(child.get("media_type"), child.get("media_url"),
                                     child.get("thumbnail_url"), f"{post_id}_{i}")
                if slide:
                    slides.append(slide)
        else:
            slide = _save_slide(media_type, item.get("media_url"), item.get("thumbnail_url"), post_id)
            if slide:
                slides.append(slide)

        if not slides:
            continue

        manifest.append({
            "id": post_id,
            "image": slides[0]["image"],
            "type": media_type,
            "slides": slides,
            "caption": (item.get("caption") or "").strip(),
            "permalink": item.get("permalink"),
            "timestamp": item.get("timestamp"),
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
