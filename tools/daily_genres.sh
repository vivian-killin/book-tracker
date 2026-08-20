#!/bin/bash
#
# Daily job: fill in missing genres, rebuild the published summary, and push it.
#
#   1. enrich   — look up genres for books that still lack one
#   2. aggregate — rebuild data/public.json from the library, headlessly
#   3. publish  — commit and push, but ONLY public.json, and only if it changed
#
# Google's free quota is about a thousand requests a day and each book costs
# two, so a large library takes several days. The job resumes from its cache
# and becomes a cheap no-op once everything has been looked up.
#
# What it will never do:
#   - commit anything but data/public.json. The library, the private notes and
#     the API key are gitignored, and this stages that one path explicitly
#     rather than trusting `git add -A` to keep respecting .gitignore.
#   - push a file that names a book. tools/aggregate.py refuses to write one,
#     and this checks its exit code before going near git.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/data/genre-run.log"
cd "$ROOT" || exit 1

# Tell someone. A job that publishes to a public repo unattended should not do
# it silently, and a failure nobody sees is the same as no job at all.
notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"book-tracker\"" \
    >/dev/null 2>&1 || true
}

# Trim the log rather than let it grow without limit.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ]; then
  tail -c 60000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

{
  echo
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="

  if [ ! -s data/.google-books-key ]; then
    echo "no API key at data/.google-books-key — skipping enrichment"
  else
    /usr/bin/env python3 tools/enrich_genres.py
  fi

  echo "--- rebuilding data/public.json ---"
  if ! /usr/bin/env python3 tools/aggregate.py; then
    echo "aggregate.py refused or failed — nothing published"
    notify "Publish blocked — see data/genre-run.log"
    exit 1
  fi

  if git diff --quiet -- data/public.json; then
    echo "public.json unchanged — nothing to publish"
    exit 0
  fi

  # Stage exactly one path. Anything else that is dirty stays untouched.
  git add data/public.json
  if ! git diff --cached --quiet; then
    staged="$(git diff --cached --name-only | tr '\n' ' ')"
    if [ "$staged" != "data/public.json " ]; then
      echo "REFUSING to commit: unexpected staged paths -> $staged"
      notify "Publish blocked — unexpected files staged"
      git reset >/dev/null
      exit 1
    fi
    git commit -q -m "Update reading stats ($(date '+%Y-%m-%d'))"
    if git push -q origin main 2>&1; then
      echo "published: $(git log --oneline -1)"
      read_count=$(/usr/bin/env python3 -c \
        "import json;print(json.load(open('data/public.json'))['totals']['read'])" 2>/dev/null)
      tagged=$(/usr/bin/env python3 -c \
        "import json;print(json.load(open('data/public.json'))['genreCoverage']['tagged'])" 2>/dev/null)
      notify "Published: ${read_count:-?} books read, ${tagged:-?} genre-tagged"
    else
      echo "commit made but push failed — will retry tomorrow, or push by hand"
      notify "Push failed — commit is local, push by hand"
      exit 1
    fi
  fi
} >> "$LOG" 2>&1
