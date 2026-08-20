#!/usr/bin/env python3
"""
Build data/public.json from data/books.json without a browser.

This is a deliberate second implementation of `computeStats` in
assets/js/store.js. The JavaScript one has to stay, because a visitor who
drops their own CSV onto the published site has no server to ask; this one has
to exist, because the daily job runs headless and there is no JavaScript
runtime on the machine.

Two implementations of the same arithmetic will drift unless something checks.
`tests.html` compares the file this writes against what the JavaScript
computes from the same library and fails loudly if they disagree, so a change
made in one place and not the other is caught rather than silently published.

    python3 tools/aggregate.py            # write data/public.json
    python3 tools/aggregate.py --check    # report drift, write nothing
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOOKS = ROOT / "data" / "books.json"
PUBLIC = ROOT / "data" / "public.json"

LENGTH_BANDS = [
    ("Under 200", lambda n: n < 200),
    ("200–299", lambda n: n < 300),
    ("300–399", lambda n: n < 400),
    ("400–499", lambda n: n < 500),
    ("500+", lambda n: True),
]

AGE_BANDS = [
    ("Same year", lambda n: n <= 0),
    ("1 year", lambda n: n <= 1),
    ("2–3 years", lambda n: n <= 3),
    ("4–9 years", lambda n: n <= 9),
    ("10+ years", lambda n: True),
]


def js_round(x: float) -> int:
    """
    Round the way JavaScript's Math.round does: halves go up, always.

    Python's built-in round() is banker's rounding, so round(2.5) is 2 while
    Math.round(2.5) is 3. Using it here would put a handful of ratings in a
    different histogram bucket than the browser puts them in, and the parity
    check would fail for a reason that looks like nothing.
    """
    return math.floor(x + 0.5)


def year_of(iso: str) -> int:
    return int(iso[:4])


def month_of(iso: str) -> int:
    return int(iso[5:7]) - 1


def read_books(books):
    return [b for b in books if b.get("status") == "read"]


def finished(books):
    return [b for b in books if b.get("status") == "read" and b.get("dateRead")]


def years_with_reading(books):
    return sorted({year_of(b["dateRead"]) for b in finished(books)}, reverse=True)


def books_per_month(books, year):
    counts = [0] * 12
    for b in finished(books):
        if year_of(b["dateRead"]) == year:
            counts[month_of(b["dateRead"])] += 1
    return counts


def rating_histogram(books):
    counts = [0] * 5
    for b in books:
        r = b.get("rating")
        if not r:
            continue
        counts[min(5, max(1, js_round(r))) - 1] += 1
    return counts


def rank(pairs, limit=8):
    """Most common first, ties broken by name, as the JavaScript does."""
    return [
        {"name": n, "count": c}
        for n, c in sorted(pairs.items(), key=lambda kv: (-kv[1], kv[0]))
    ][:limit]


def rank_authors(books, limit=8):
    counts = Counter(b["author"] for b in books if b.get("author"))
    return rank(counts, limit)


def rank_genres(books, limit=8):
    counts = Counter(g for b in books for g in (b.get("genres") or []))
    return rank(counts, limit)


def days_between(a: str, b: str) -> int:
    return max(0, (date.fromisoformat(b) - date.fromisoformat(a)).days)


def median(sorted_vals):
    mid = len(sorted_vals) // 2
    if len(sorted_vals) % 2:
        return sorted_vals[mid]
    return js_round((sorted_vals[mid - 1] + sorted_vals[mid]) / 2)


def year_summary(books, year):
    read = [b for b in finished(books) if year_of(b["dateRead"]) == year]
    pages = sum(b.get("pages") or 0 for b in read)
    rated = [b for b in read if b.get("rating")]
    avg = sum(b["rating"] for b in rated) / len(rated) if rated else None
    durations = sorted(
        days_between(b["dateStarted"], b["dateRead"])
        for b in read
        if b.get("dateStarted") and b.get("dateRead")
        and b["dateRead"] >= b["dateStarted"]
    )
    return {
        "books": len(read),
        "pages": pages,
        "avgRating": avg,
        "authors": len({b["author"] for b in read if b.get("author")}),
        "medianDays": median(durations) if durations else None,
    }


def band_counts(books, bands, value_of):
    counts = [{"name": n, "count": 0} for n, _ in bands]
    for b in books:
        v = value_of(b)
        if v is None:
            continue
        for i, (_, test) in enumerate(bands):
            if test(v):
                counts[i]["count"] += 1
                break
    return counts


def avg_rating_by_genre(books, min_rated=3):
    sums = {}
    for b in books:
        if not b.get("rating"):
            continue
        for g in (b.get("genres") or []):
            cur = sums.setdefault(g, {"total": 0.0, "n": 0})
            cur["total"] += b["rating"]
            cur["n"] += 1
    out = [
        {"name": g, "count": v["n"], "avg": js_round((v["total"] / v["n"]) * 100) / 100}
        for g, v in sums.items()
        if v["n"] >= min_rated
    ]
    out.sort(key=lambda g: (-g["avg"], -g["count"]))
    return out


def compute_stats(books: list) -> dict:
    """Mirror of computeStats() in assets/js/store.js. Keep the two in step."""
    years = years_with_reading(books)
    read = read_books(books)
    dated = finished(books)

    per_year, monthly = {}, {}
    ratings = {"all": rating_histogram(dated)}
    authors = {"all": rank_authors(dated)}
    genres = {"all": rank_genres(dated)}

    for y in years:
        in_year = [b for b in dated if year_of(b["dateRead"]) == y]
        s = year_summary(books, y)
        per_year[str(y)] = {
            "books": s["books"],
            "pages": s["pages"],
            "authors": s["authors"],
            "rated": len([b for b in in_year if b.get("rating")]),
            "avgRating": s["avgRating"],
            "medianDays": s["medianDays"],
            "pagesCounted": len([b for b in in_year if b.get("pages")]),
            "longestPages": max((b.get("pages") or 0) for b in in_year) or None
            if in_year else None,
        }
        monthly[str(y)] = books_per_month(books, y)
        ratings[str(y)] = rating_histogram(in_year)
        authors[str(y)] = rank_authors(in_year)
        genres[str(y)] = rank_genres(in_year)

    all_rated = [b for b in dated if b.get("rating")]
    heat_years = sorted(years)
    grid = [books_per_month(books, y) for y in heat_years]
    heat_max = max([1] + [n for row in grid for n in row])

    top_genres = [g["name"] for g in genres["all"][:6]]
    genre_trend = [
        {
            "name": name,
            "values": [
                len([b for b in dated
                     if year_of(b["dateRead"]) == y and name in (b.get("genres") or [])])
                for y in heat_years
            ],
        }
        for name in top_genres
    ]

    return {
        "version": 1,
        "generated": date.today().isoformat(),
        "totals": {
            "tracked": len(books),
            "read": len(read),
            "dated": len(dated),
            "undated": len(read) - len(dated),
            "pages": sum(b.get("pages") or 0 for b in dated),
            "pagesCounted": len([b for b in dated if b.get("pages")]),
            "authors": len({b["author"] for b in dated if b.get("author")}),
            "rated": len(all_rated),
            "avgRating": (sum(b["rating"] for b in all_rated) / len(all_rated))
            if all_rated else None,
            "longestPages": max([0] + [b.get("pages") or 0 for b in dated]) or None,
        },
        "years": years,
        "perYear": per_year,
        "monthly": monthly,
        "ratings": ratings,
        "authors": authors,
        "genres": genres,
        "heat": {"years": heat_years, "grid": grid, "max": heat_max},
        "genreTrend": {"years": heat_years, "series": genre_trend},
        "genreCoverage": {
            "tagged": len([b for b in dated if (b.get("genres") or [])]),
            "total": len(dated),
            "noIsbn": len([b for b in books
                           if not b.get("isbn13") and not b.get("isbn")]),
        },
        "lengths": band_counts(dated, LENGTH_BANDS, lambda b: b.get("pages")),
        "ages": band_counts(
            [b for b in dated if b.get("originalYear") or b.get("yearPublished")],
            AGE_BANDS,
            lambda b: year_of(b["dateRead"])
            - (b.get("originalYear") or b.get("yearPublished")),
        ),
        "ratingByGenre": avg_rating_by_genre(dated),
        "rereads": len([b for b in dated if (b.get("readCount") or 1) > 1]),
    }


# --- the leak gate ----------------------------------------------------------

BANNED_KEYS = {"title", "isbn", "isbn13", "privatenotes", "review", "dateread",
               "datestarted", "dateadded", "contentwarnings"}


def identifying_fields(node, path="$"):
    """Any book-identifying value outside the one permitted path."""
    found = []
    if isinstance(node, list):
        for i, v in enumerate(node):
            found += identifying_fields(v, f"{path}[{i}]")
    elif isinstance(node, dict):
        for k, v in node.items():
            here = f"{path}.{k}"
            if k.lower() in BANNED_KEYS and isinstance(v, str) and v.strip():
                found.append(here)
            if (k == "books" and isinstance(v, list)
                    and any(isinstance(x, dict) for x in v)):
                found.append(f"{here} (records)")
            found += identifying_fields(v, here)
    return found


def audit(stats: dict, books: list) -> list[str]:
    """
    Refuse to publish anything that names a book it should not.

    Two checks, because they fail differently: the structural one catches a
    field that should never be there, and the title sweep catches a real title
    reaching the file through some path nobody thought of.
    """
    problems = identifying_fields(stats)

    # Sweep only the free text, not the labels. Genre and author names are
    # published on purpose, and one of them ("Romantic comedy") is also the
    # title of a real book — searching the whole file would flag that forever
    # and train everyone to ignore the alarm.
    haystack = " ".join(free_text(stats)).lower()
    for b in books:
        t = b.get("title", "")
        if len(t) > 8 and t.lower() in haystack:
            problems.append(f"title present in output: {t!r}")

    return problems


# Keys whose values are deliberately published names rather than free text.
LABEL_KEYS = {"name"}


def free_text(node, path="$"):
    """Every string in the output that is not an intentional label."""
    out = []
    if isinstance(node, list):
        for i, v in enumerate(node):
            out += free_text(v, f"{path}[{i}]")
    elif isinstance(node, dict):
        for k, v in node.items():
            here = f"{path}.{k}"
            if isinstance(v, str):
                if k not in LABEL_KEYS:
                    out.append(v)
            else:
                out += free_text(v, here)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="report whether public.json is up to date; write nothing")
    args = ap.parse_args()

    if not BOOKS.exists():
        print(f"No library at {BOOKS.relative_to(ROOT)}", file=sys.stderr)
        return 1

    books = json.loads(BOOKS.read_text(encoding="utf-8"))["books"]
    stats = compute_stats(books)

    problems = audit(stats, books)
    if problems:
        print("REFUSING to write public.json — it would disclose:", file=sys.stderr)
        for p in problems[:10]:
            print(f"  {p}", file=sys.stderr)
        return 2

    text = json.dumps(stats, indent=2, ensure_ascii=False) + "\n"

    if args.check:
        current = PUBLIC.read_text(encoding="utf-8") if PUBLIC.exists() else ""
        same = strip_dates(current) == strip_dates(text)
        print("up to date" if same else "stale — rerun without --check")
        return 0 if same else 1

    PUBLIC.write_text(text, encoding="utf-8")
    t = stats["totals"]
    print(f"wrote {PUBLIC.relative_to(ROOT)} — {t['read']} read, "
          f"{stats['genreCoverage']['tagged']} genre-tagged, 0 titles")
    return 0


def strip_dates(text: str) -> str:
    """Compare content, not the day it was generated."""
    try:
        d = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text
    d.pop("generated", None)
    d.pop("updated", None)
    return json.dumps(d, sort_keys=True, ensure_ascii=False)


if __name__ == "__main__":
    raise SystemExit(main())
