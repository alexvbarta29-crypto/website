#!/usr/bin/env python3
"""
Refreshes build/google_reviews.json with the live Google review count and
average rating, read from the site's own /api/review-stats Netlify Function
(netlify/functions/review-stats.mjs), which holds the Google credentials.
sitedata.py reads the JSON, so the next build.py run prints the exact count
everywhere the site says "N reviews".

Run by the "Sync Google review count" GitHub Action
(.github/workflows/review-sync.yml). Prints changed=true|false to
$GITHUB_OUTPUT. On any error it leaves the file alone and exits 0, so a
Google hiccup never breaks the workflow or blanks the number.
"""
import json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "google_reviews.json")
URL = os.environ.get("REVIEW_STATS_URL", "https://www.bartawindowwashing.com/api/review-stats")


def output(changed):
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")


def main():
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "barta-review-sync"})
        with urllib.request.urlopen(req, timeout=30) as r:
            live = json.load(r)
        count, rating = int(live["count"]), round(float(live["rating"]), 1)
        if count <= 0 or not (1.0 <= rating <= 5.0):
            raise ValueError(f"implausible stats: {live}")
    except Exception as e:  # keep the last good numbers
        print(f"Could not fetch review stats ({e}); leaving {PATH} unchanged.")
        output(False)
        return 0

    try:
        with open(PATH) as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}

    if old.get("count") == count and float(old.get("rating", 0)) == rating:
        print(f"No change: {count} reviews, {rating:.1f} stars.")
        output(False)
        return 0

    with open(PATH, "w") as f:
        json.dump({"count": count, "rating": rating, "updated": live.get("updated")}, f)
        f.write("\n")
    print(f"Updated: {old.get('count')} -> {count} reviews, {rating:.1f} stars.")
    output(True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
