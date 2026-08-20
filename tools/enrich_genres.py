#!/usr/bin/env python3
"""
Fill in book genres from the Google Books API.

Neither service gives you a usable genre. Goodreads exports only your own
shelves, and StoryGraph has no genre column at all, so a genre chart has to be
built from somewhere else. Google Books returns a `categories` list for most
ISBNs, which this maps onto a small, readable set of genres.

    export GOOGLE_BOOKS_API_KEY=...        # or write data/.google-books-key
    python3 tools/enrich_genres.py         # add genres to books missing them
    python3 tools/enrich_genres.py --limit 20 --dry-run

The key is read from the environment or from data/.google-books-key, both of
which stay out of the repo. It is never written into any file this produces.

Responses are cached in data/genre-cache.json, so re-running is nearly free and
an interrupted run resumes where it stopped. Both files are gitignored.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOOKS = ROOT / "data" / "books.json"
CACHE = ROOT / "data" / "genre-cache.json"
KEY_FILE = ROOT / "data" / ".google-books-key"
API = "https://www.googleapis.com/books/v1/volumes"

# Ordered rules: the first substring found in a raw category wins, so the more
# specific entries must come before the generic ones ("romantic comedy" before
# "romance", "fiction" last of all).
GENRE_RULES = [
    ("romantic comedy", "Romantic comedy"),
    ("romance", "Romance"),
    ("fantasy", "Fantasy"),
    ("science fiction", "Science fiction"),
    ("mystery", "Mystery"),
    ("detective", "Mystery"),
    ("thriller", "Thriller"),
    ("suspense", "Thriller"),
    ("horror", "Horror"),
    ("historical", "Historical fiction"),
    ("young adult", "Young adult"),
    ("juvenile", "Young adult"),
    ("comics", "Comics"),
    ("graphic novel", "Comics"),
    ("poetry", "Poetry"),
    ("drama", "Drama"),
    ("biography", "Memoir"),
    ("autobiography", "Memoir"),
    ("memoir", "Memoir"),
    ("history", "History"),
    ("science", "Science"),
    ("psychology", "Psychology"),
    ("self-help", "Self-help"),
    ("business", "Business"),
    ("cooking", "Cooking"),
    ("travel", "Travel"),
    ("essays", "Essays"),
    ("literary criticism", "Criticism"),
    ("short stories", "Short stories"),
    ("fiction", "Fiction"),
]


# Genres that imply a broader one. The specific label wins.
SUBSUMES = {
    "Romantic comedy": "Romance",
    "Short stories": "Fiction",
    "Historical fiction": "Fiction",
}


def read_key() -> str:
    """Read the API key from the environment or the gitignored key file."""
    key = os.environ.get("GOOGLE_BOOKS_API_KEY", "").strip()
    if key:
        return key
    if KEY_FILE.exists():
        return KEY_FILE.read_text(encoding="utf-8").strip()
    sys.exit(
        "No API key found.\n"
        "  Create one (free) at https://console.cloud.google.com/apis/credentials\n"
        "  after enabling the Books API, then either:\n"
        f"    echo 'YOUR_KEY' > {KEY_FILE.relative_to(ROOT)}\n"
        "  or:\n"
        "    export GOOGLE_BOOKS_API_KEY=YOUR_KEY"
    )


# Set once a TLS failure proves this Python has no usable CA bundle, so the
# remaining hundreds of lookups skip straight to curl instead of failing first.
_use_curl = False


def _curl_json(url: str) -> dict | None:
    """Fetch via curl, which carries its own trusted roots on macOS."""
    out = subprocess.run(
        ["curl", "-s", "--max-time", "30", url],
        capture_output=True, text=True,
    )
    if out.returncode != 0 or not out.stdout:
        return None
    try:
        data = json.loads(out.stdout)
    except json.JSONDecodeError:
        return None
    if isinstance(data.get("error"), dict) and data["error"].get("code") == 429:
        raise RateLimited()
    return data


def http_json(url: str) -> dict | None:
    """
    GET a URL and parse JSON.

    Falls back to curl when Python has no CA bundle, which is the default state
    of a python.org install on macOS until "Install Certificates.command" is
    run. Returning the data rather than making the user fix their Python first
    is the friendlier trade.

    urlopen wraps a certificate failure inside URLError rather than raising
    SSLCertVerificationError directly, so the fallback has to inspect
    `.reason`. Catching the SSL class alone silently turns every request into
    a miss, which looks exactly like "this book has no genre".
    """
    global _use_curl
    if _use_curl:
        return _curl_json(url)

    try:
        with urllib.request.urlopen(url, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RateLimited() from exc
        return None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLCertVerificationError):
            _use_curl = True
            print("  (Python has no CA bundle — using curl for lookups)")
            return _curl_json(url)
        return None
    except (TimeoutError, json.JSONDecodeError):
        return None


class RateLimited(Exception):
    """Google's per-day or per-minute quota was hit."""


def categories_for(isbn: str, key: str) -> tuple[list[str], bool]:
    """
    Raw Google Books categories for one ISBN.

    Two requests, because the search endpoint flattens `categories` to the
    top-level BISAC heading — every novel comes back as plain "Fiction". The
    per-volume endpoint returns the full paths ("Fiction / Romance / Romantic
    Comedy"), which is the only place the subgenre actually lives.

    Returns (categories, completed). `completed` is False when a request
    failed, so a transient error is never cached as "this book has no genre".
    """
    q = urllib.parse.quote(isbn)
    k = urllib.parse.quote(key)

    found = http_json(f"{API}?q=isbn:{q}&key={k}")
    if found is None:
        return [], False
    items = found.get("items") or []
    if not items:
        return [], True  # genuinely not in Google Books

    volume_id = items[0].get("id")
    if not volume_id:
        return items[0].get("volumeInfo", {}).get("categories", []) or [], True

    detail = http_json(f"{API}/{urllib.parse.quote(volume_id)}?key={k}")
    if detail is None:
        # Fall back to the flattened categories rather than losing the book.
        return items[0].get("volumeInfo", {}).get("categories", []) or [], True
    return detail.get("volumeInfo", {}).get("categories", []) or [], True


def to_genres(raw: list[str]) -> list[str]:
    """
    Map raw categories onto the curated genre set.

    Google returns paths like "Fiction / Romance / Contemporary", so each
    segment is matched separately and the specific rules are tried first.
    """
    found = []
    for entry in raw:
        for segment in str(entry).split("/"):
            seg = segment.strip().lower()
            for needle, genre in GENRE_RULES:
                if needle in seg and genre not in found:
                    found.append(genre)
                    break
    # A book should be counted once per genre, not once for a genre and again
    # for its parent, which would inflate every umbrella category on the chart.
    for child, parent in SUBSUMES.items():
        if child in found and parent in found:
            found.remove(parent)

    # "Fiction" alongside anything specific adds nothing.
    if len(found) > 1 and "Fiction" in found:
        found.remove("Fiction")
    return found[:3]


def fetch_with_backoff(isbn: str, key: str, attempts: int = 4):
    """
    Look up one ISBN, waiting out Google's per-minute rate limit.

    The quota that bites here is per-minute, not per-day: it refuses for a
    little while and then serves again. Abandoning the whole run on the first
    429 turned a pause into a dead stop halfway through the library.
    """
    for attempt in range(attempts):
        try:
            return categories_for(isbn, key)
        except RateLimited:
            if attempt == attempts - 1:
                raise
            wait = 30 * (attempt + 1)
            print(f"  rate limited — waiting {wait}s (attempt {attempt + 1}/{attempts})")
            time.sleep(wait)
    return [], False


def load_cache() -> dict:
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_cache(cache: dict) -> None:
    CACHE.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + "\n",
                     encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=0,
                    help="only look up this many books (for a trial run)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing books.json")
    ap.add_argument("--delay", type=float, default=1.1,
                    help="seconds between books (default 0.3); each book costs "
                         "two API requests")
    ap.add_argument("--refresh", action="store_true",
                    help="re-fetch books that already have genres")
    args = ap.parse_args()

    if not BOOKS.exists():
        sys.exit(f"No library at {BOOKS.relative_to(ROOT)} — import a CSV first.")

    key = read_key()
    doc = json.loads(BOOKS.read_text(encoding="utf-8"))
    books = doc["books"]
    cache = load_cache()

    todo = [
        b for b in books
        if (b.get("isbn13") or b.get("isbn"))
        and (args.refresh or not b.get("genres"))
    ]
    no_isbn = sum(1 for b in books if not (b.get("isbn13") or b.get("isbn")))

    print(f"{len(books)} books · {len(todo)} to look up · "
          f"{no_isbn} have no ISBN and cannot be matched")
    if args.limit:
        todo = todo[: args.limit]
        print(f"limited to {len(todo)} for this run")

    fetched = hit = miss = 0
    try:
        for i, b in enumerate(todo, 1):
            isbn = b.get("isbn13") or b.get("isbn")
            if isbn in cache:
                raw = cache[isbn]
            else:
                raw, completed = fetch_with_backoff(isbn, key)
                # Only remember answers we actually got. Caching a failed
                # request would bake a network blip in as a permanent "no
                # genre" that a re-run would never revisit.
                if completed:
                    cache[isbn] = raw
                fetched += 1
                time.sleep(args.delay)

            genres = to_genres(raw)
            if genres:
                b["genres"] = genres
                hit += 1
            else:
                miss += 1

            if i % 25 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)} — {hit} with genres, {miss} without")
                save_cache(cache)
    except RateLimited:
        print("\nGoogle returned 429 (quota exceeded). Progress is cached; "
              "re-run later to continue where this stopped.", file=sys.stderr)
    except KeyboardInterrupt:
        print("\nInterrupted. Progress is cached.", file=sys.stderr)

    save_cache(cache)
    print(f"\nlooked up {fetched} new · {hit} got a genre · {miss} had none")

    if args.dry_run:
        print("dry run — books.json not written")
    elif hit:
        doc["books"] = books
        BOOKS.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")
        print(f"wrote genres into {BOOKS.relative_to(ROOT)}")
        print("Reload the site (or save once) to regenerate data/public.json.")

    counts: dict[str, int] = {}
    for b in books:
        for g in b.get("genres", []):
            counts[g] = counts.get(g, 0) + 1
    if counts:
        print("\ngenres so far:")
        for g, n in sorted(counts.items(), key=lambda kv: -kv[1])[:12]:
            print(f"  {n:5}  {g}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
