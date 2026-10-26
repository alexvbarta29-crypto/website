#!/usr/bin/env python3
"""
Refreshes build/google_reviews.json with the live Google review count,
average rating and the reviews themselves, read from the site's own Netlify
Functions, which hold the Google credentials:
  /api/reviews       (netlify/functions/reviews.mjs): count, rating, reviews
  /api/review-stats  (netlify/functions/review-stats.mjs): count and rating
                     only, used if /api/reviews is unavailable
sitedata.py reads the JSON, so the next build.py run prints the exact count
everywhere the site says "N reviews", and the review sections (components
google_reviews) show the latest reviews as plain HTML.

Run by the "Sync Google review count" GitHub Action
(.github/workflows/review-sync.yml). Prints changed=true|false to
$GITHUB_OUTPUT. On any error it keeps what's on file and exits 0, so a
Google hiccup never breaks the workflow, blanks the number or empties the
reviews.
"""
import json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "google_reviews.json")
STATS_URL = os.environ.get("REVIEW_STATS_URL", "https://www.bartawindowwashing.com/api/review-stats")
REVIEWS_URL = os.environ.get("REVIEWS_URL", "https://www.bartawindowwashing.com/api/reviews")
REVIEW_FIELDS = ("id", "name", "stars", "text", "created", "reply")


def output(changed):
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "barta-review-sync"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def plausible(count, rating):
    return count > 0 and 1.0 <= rating <= 5.0


def main():
    try:
        with open(PATH) as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}

    reviews = None
    try:
        live = fetch(REVIEWS_URL)
        count, rating = int(live["count"]), round(float(live["rating"]), 1)
        got = [{k: r.get(k) for k in REVIEW_FIELDS} for r in live["reviews"]]
        if not plausible(count, rating) or not got:
            raise ValueError("implausible reviews response")
        reviews = got
    except Exception as e:
        print(f"Could not fetch reviews ({e}); trying the count only.")
        try:
            live = fetch(STATS_URL)
            count, rating = int(live["count"]), round(float(live["rating"]), 1)
            if not plausible(count, rating):
                raise ValueError(f"implausible stats: {live}")
        except Exception as e2:  # keep the last good data
            print(f"Could not fetch review stats ({e2}); leaving {PATH} unchanged.")
            output(False)
            return 0

    if reviews is None:
        reviews = old.get("reviews") or []

    if (old.get("count") == count and float(old.get("rating", 0)) == rating
            and (old.get("reviews") or []) == reviews):
        print(f"No change: {count} reviews, {rating:.1f} stars, {len(reviews)} saved.")
        output(False)
        return 0

    with open(PATH, "w") as f:
        json.dump({"count": count, "rating": rating, "updated": live.get("updated"),
                   "reviews": reviews}, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"Updated: {old.get('count')} -> {count} reviews, {rating:.1f} stars, "
          f"{len(old.get('reviews') or [])} -> {len(reviews)} saved.")
    output(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
