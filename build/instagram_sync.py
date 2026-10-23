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
import glob, json, os, shutil, subprocess, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IMG_DIR = os.path.join(ROOT, "assets", "img", "instagram")
MANIFEST_PATH = os.path.join(HERE, "instagram_feed.json")
MAX_POSTS = 10
API_BASE = "https://graph.instagram.com"

# Stories (owner's request, October 2026). The API only returns stories that
# are live right now (they vanish after 24 hours), so every run saves any it
# hasn't seen into STORIES_PATH, which keeps them after Instagram drops them.
# The workflow runs four times a day so no 24-hour story is ever missed.
# Files are named story-<id> straight in IMG_DIR so build.py's responsive
# image pipeline picks them up like any post photo. Only the newest
# MAX_STORIES are kept; older ones' files are deleted to keep the repo lean.
STORIES_PATH = os.path.join(HERE, "instagram_stories.json")
MAX_STORIES = 24
# Stories never shown on the site, by story id (same idea as the post sets).
EXCLUDED_STORY_IDS = set()

# Posts never shown on the site, by Instagram post id. The site-launch
# announcement carousel lives here — no point advertising the website on
# the website itself. The sync skips these entirely (no media downloaded,
# nothing written to the manifest), and components.py filters by the same
# set at render time as a backstop against a stale manifest.
EXCLUDED_POST_IDS = {"17878396158527541"}

# Single photos or videos never shown on the site, by slide id: the post id,
# plus "_<n>" (counting from 0) for a slide inside a multi-photo post. Use
# this rather than EXCLUDED_POST_IDS when the rest of the post is fine. These
# show the crew washing house siding, a service the business stopped
# offering in October 2026. The sync downloads nothing for them and writes
# an {"excluded": true} placeholder in their place, so the other slides keep
# their real position for the "view on Instagram" links; components.py
# filters by the same set at render time as a backstop.
EXCLUDED_SLIDE_IDS = {"18111014425971457_1", "18110294294515814_2"}


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


def fetch_stories(token):
    """The account's live stories (posted in the last 24 hours)."""
    fields = "id,media_type,media_url,thumbnail_url,permalink,timestamp"
    url = f"{API_BASE}/me/stories?fields={fields}&access_token={token}"
    return _get_json(url).get("data", [])


def _ffmpeg():
    return shutil.which("ffmpeg")


def _shrink_video(path):
    """Story videos arrive as full 1080x1920 files of several MB each. If
    ffmpeg is available (it is on GitHub's runners), re-encode to at most 720px
    wide, which looks the same in a carousel card at a fraction of the size.
    Keeps the original if anything goes wrong or the result isn't smaller."""
    ff = _ffmpeg()
    if not ff:
        return
    tmp = path + ".tmp.mp4"
    try:
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", path,
                        "-vf", "scale='min(720,iw)':-2", "-c:v", "libx264", "-crf", "27",
                        "-preset", "veryfast", "-c:a", "aac", "-b:a", "96k",
                        "-movflags", "+faststart", tmp], check=True, timeout=180)
        if os.path.getsize(tmp) < os.path.getsize(path):
            os.replace(tmp, path)
    except Exception as e:
        print(f"  (video re-encode skipped for {os.path.basename(path)}: {e})")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _poster_from_video(video, dest):
    """A still for a video story that came without a thumbnail: its first
    frame, if ffmpeg is available."""
    ff = _ffmpeg()
    if not ff:
        return False
    try:
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", video, "-frames:v", "1",
                        "-q:v", "3", dest], check=True, timeout=60)
        return os.path.exists(dest)
    except Exception as e:
        print(f"  (poster frame skipped for {os.path.basename(video)}: {e})")
        return False


def _remove_story_files(story_id):
    for path in glob.glob(os.path.join(IMG_DIR, f"story-{story_id}*")):
        os.remove(path)


def sync_stories(token):
    """Adds any live story not saved yet to STORIES_PATH (newest first),
    downloading its media; keeps the newest MAX_STORIES. Best-effort: if the
    stories call fails, posts still sync and the saved stories stay."""
    try:
        with open(STORIES_PATH, encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, ValueError):
        saved = []
    try:
        live = fetch_stories(token)
    except Exception as e:
        detail = e.read().decode()[:300] if isinstance(e, urllib.error.HTTPError) else str(e)
        print(f"  (stories skipped: {detail})")
        return
    known = {s["id"] for s in saved}
    added = 0
    for st in live:
        sid = st.get("id")
        if not sid or sid in known or sid in EXCLUDED_STORY_IDS:
            continue
        media_type = st.get("media_type")
        name = f"story-{sid}"
        slide = _save_slide(media_type, st.get("media_url"), st.get("thumbnail_url"), name)
        video = os.path.join(IMG_DIR, f"{name}.mp4")
        if slide is None and media_type == "VIDEO" and os.path.exists(video):
            if _poster_from_video(video, os.path.join(IMG_DIR, f"{name}.jpg")):
                slide = {"type": media_type, "image": f"assets/img/instagram/{name}.jpg",
                         "video": f"assets/img/instagram/{name}.mp4"}
        if slide is None:
            _remove_story_files(sid)
            continue
        if slide.get("video"):
            _shrink_video(os.path.join(ROOT, slide["video"]))
        saved.append({"id": sid, "source": "story", **slide, "timestamp": st.get("timestamp")})
        known.add(sid)
        added += 1
    saved.sort(key=lambda s: s.get("timestamp") or "", reverse=True)
    for old in saved[MAX_STORIES:]:
        _remove_story_files(old["id"])
    saved = [s for s in saved[:MAX_STORIES] if s["id"] not in EXCLUDED_STORY_IDS]
    with open(STORIES_PATH, "w", encoding="utf-8") as f:
        json.dump(saved, f, indent=2)
    print(f"  Stories: {len(live)} live, {added} new saved, {len(saved)} kept.")


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
        if post_id in EXCLUDED_POST_IDS or post_id in EXCLUDED_SLIDE_IDS:
            continue

        slides = []
        if media_type == "CAROUSEL_ALBUM":
            for i, child in enumerate(fetch_children(post_id, token)):
                if f"{post_id}_{i}" in EXCLUDED_SLIDE_IDS:
                    slides.append({"excluded": True})
                    continue
                slide = _save_slide(child.get("media_type"), child.get("media_url"),
                                     child.get("thumbnail_url"), f"{post_id}_{i}")
                if slide:
                    slides.append(slide)
        else:
            slide = _save_slide(media_type, item.get("media_url"), item.get("thumbnail_url"), post_id)
            if slide:
                slides.append(slide)

        shown = [s for s in slides if not s.get("excluded")]
        if not shown:
            continue

        manifest.append({
            "id": post_id,
            "image": shown[0]["image"],
            "type": media_type,
            "slides": slides,
            "caption": (item.get("caption") or "").strip(),
            "permalink": item.get("permalink"),
            "timestamp": item.get("timestamp"),
        })

    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"Synced {len(manifest)} Instagram posts.")

    sync_stories(token)

    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        print(f"::add-mask::{token}")
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write(f"refreshed_token={token}\n")


if __name__ == "__main__":
    main()
