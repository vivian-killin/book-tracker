# book-tracker

A reading tracker you host yourself. Import your Goodreads and StoryGraph
history, see it as a graph you can share, and export a CSV that goes back into
both — so finishing a book is one entry instead of three.

No build step, no dependencies, no accounts, no server. It is HTML, CSS and
plain JavaScript modules, plus one optional Python script from the standard
library. Your library is a single JSON file in the repo.

## Why it works this way

Goodreads retired its public API in December 2020 and StoryGraph has never had
one, so nothing can write to those accounts on your behalf. CSV is the only
route that doesn't involve handing a script your password — and StoryGraph
explicitly documents Goodreads' CSV layout as the format to migrate with.

That constraint shapes the whole design, and it's written up in
[docs/SYNC.md](docs/SYNC.md) along with exactly which fields survive each hop.

## Getting started

```bash
python3 tools/serve.py
```

That serves the site at <http://127.0.0.1:8000> and — the one thing a static
host can't do — lets the pages write back to `data/books.json`, so logging a
book produces a normal file change you review and commit.

Then:

1. Export your library from
   [Goodreads](https://www.goodreads.com/review/import) (My Books → Import and
   Export) and from StoryGraph (Profile → Manage Account → Export
   StoryGraph Library).
2. Import both. Doing both is worth it — Goodreads carries page counts and
   private notes, StoryGraph carries quarter-star ratings, start dates, moods
   and pace. Books in both are matched and merged into one record.
3. Commit `data/public.json`. Your library stays on your machine.

To see it working before importing anything, open the site and choose **Load
sample data** — four years of invented reading, stored only in your browser.

## Publishing your graph

Push the repo and turn on GitHub Pages (Settings → Pages → deploy from
`main`, root). The site is static, so it just works; `.nojekyll` stops GitHub
mangling the asset paths.

Anyone with the link sees your graph. Visitors can also drop their own CSV onto
the page to view their own reading — that stays in their browser and never
touches your data or any server.

### What a visitor can see

Your library is never published. `data/books.json` is gitignored, and the only
data file that gets committed is `data/public.json` — counts and nothing else:

```
totals, books per month and year, rating distribution, the heatmap grid,
author and genre names with counts, genre counts per year,
length and book-age distributions, average rating per genre
```

No titles, no ISBNs, no per-book dates, no reviews, no notes. It is about 8 KB
against a 740 KB library. The published page renders every chart from it and
hides the shelf, because there are no book records to list.

It is regenerated automatically on every save, by the same code that draws your
local charts, so the two cannot drift apart. `serve.py` refuses to write it at
all if it finds a book-identifying field.

Two things are published by name, both on purpose:

- **Author names, as counts** — "Ali Hazelwood ×8". That is the authors chart,
  but it does describe your taste fairly precisely.
- **Your non-fiction, by title**, in a collapsed section. `NONFICTION_GENRES`
  in `store.js` defines it, on the grounds that non-fiction is not personal in
  the way the rest of a reading history is. Anything also carrying a fiction
  genre is excluded, because Google's categories are loose enough to return a
  romance novel tagged "Science" — without that rule a mislabel would put a
  novel on a public list. Empty the set to publish no titles at all.

The audit permits titles at exactly one path, `$.spotlight.books[]`, rather
than by relaxing the rule — so a title appearing anywhere else still fails,
in the browser and again in `serve.py`.

## Genres

Neither service gives you one. Goodreads exports only your own shelves, and
StoryGraph has no genre column, so if you have never shelved by genre there is
nothing to chart and the genre card stays hidden.

`tools/enrich_genres.py` fills the gap from the Google Books API:

```bash
echo 'YOUR_KEY' > data/.google-books-key
python3 tools/enrich_genres.py --limit 20 --dry-run   # try it on 20 books
python3 tools/enrich_genres.py                        # then the whole library
```

Get a free key at [Google Cloud
credentials](https://console.cloud.google.com/apis/credentials) with the Books
API enabled. The key file and the response cache are both gitignored, and the
key is never written into anything the script produces.

Lookups are cached in `data/genre-cache.json`, so re-runs are almost free and
an interrupted run resumes where it stopped. Books without an ISBN cannot be
matched. Raw categories like `Fiction / Romance / Romantic Comedy` are mapped
onto a small readable set, with the specific label winning over its parent so
no book is counted twice.

Open Library was the obvious free alternative and is not worth it: on a sample
of this library it had usable subjects for 20% of books, and returned tags like
"Engagement rings".

## Running the genre backfill daily

Google's free quota is about a thousand requests a day and each book costs two,
so a large library takes several days to fill in. A LaunchAgent runs the job
once a day and resumes from the cache; once every book has been looked up it
becomes a no-op that only catches newly added ones.

```bash
cp tools/com.book-tracker.genres.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.book-tracker.genres.plist
launchctl start com.book-tracker.genres          # run it now
launchctl list com.book-tracker.genres           # LastExitStatus 0 is good
```

The paths inside the plist are absolute — launchd does not expand `~` — so
edit them if the project lives somewhere else.

**Keep the project out of `~/Documents`, `~/Desktop` and `~/Downloads.** Those
are privacy-protected on macOS, and a LaunchAgent reading them fails with

```
/bin/bash: .../daily_genres.sh: Operation not permitted
```

even though the identical command works when you run it yourself — your shell
inherits Terminal's permissions and a background agent inherits none. Granting
Full Disk Access to `/bin/bash` also fixes it, at the cost of giving every
shell script on the machine unrestricted access to everything. Keeping the
project in your home directory is the cheaper answer.

The job runs end to end: it fills in genres, rebuilds `data/public.json` with
`tools/aggregate.py`, and pushes **only that file** if it changed. Your
library, notes and API key are gitignored and it stages the one path
explicitly rather than trusting `git add -A`.

Two things stand between it and a bad publish. `tools/aggregate.py` refuses to
write a file that names a book outside the spotlight, and the script checks
its exit code before going near git; and it aborts if anything other than
`data/public.json` ends up staged.

### Why the aggregation exists twice

`computeStats` is written in both JavaScript and Python. The JavaScript one is
needed because a visitor who drops a CSV onto the published site has no server
to ask; the Python one is needed because the daily job runs headless with no
JavaScript runtime. Two implementations of the same arithmetic drift unless
something checks, so `tests.html` compares the committed file against what the
JavaScript computes from the same library and fails if they disagree. That
test is skipped — loudly, not silently — on the published site, where
`books.json` is absent.

## What is deliberately not shown

**Format.** Goodreads records the binding of the edition it matched, not the
copy you actually read, so a library read almost entirely on a Kindle reports
itself as mostly paperback. It is not aggregated or published, because a wrong
number on a chart is worse than an absent one. The raw field stays on each
book, where it is at least labelled as having come from the import.

## Keeping it unpublished while you work on it

GitHub Pages has no password option, and a JavaScript prompt would not be one:
the page source is readable, and `data/books.json` is a plain URL that `curl`
will happily fetch without ever loading the page. To actually hide the site,
make the repository private (Settings → General → Change visibility). On a free
plan that takes the Pages site down automatically; confirm under Settings →
Pages that the source reads "None".

Everything still works while private. `python3 tools/serve.py` does not care,
and `git push` keeps working over SSH.

### When you are ready to launch

1. Settings → General → Change visibility → Public.
2. Settings → Pages → Source: Deploy from a branch → `main` → `/ (root)`.
3. Wait for the "pages build and deployment" run to finish, then check that
   the site loads and that both `data/books.json` and `data/notes.json` return
   404. Those two 404s are what confirm your library and your notes did not
   ship; `data/public.json` should return 200.

## Day to day

| I want to… | Do this |
|---|---|
| Log a finished book | `log.html` |
| Push it to Goodreads and StoryGraph | Download a CSV from `log.html`, upload it to each |
| Pull in changes made on either site | Export from there, import here — merging is safe to repeat |
| See the graph | `index.html` |
| Check nothing broke | `tests.html` |

## Layout

```
index.html          the reading graph
log.html            add and edit books
tests.html          test suite, runs in the browser
data/books.json     your library — gitignored, never published
data/notes.json     private notes — gitignored, never published
data/public.json    aggregate counts — the only data file that is committed
assets/js/csv.js    RFC 4180 parser and writer
assets/js/formats.js  Goodreads and StoryGraph adapters, both directions
assets/js/store.js  persistence and the derived statistics
assets/js/charts.js SVG renderers
assets/js/theme.js  theme switching, and the Barbie cursor trail
assets/js/palette.js  colour-blindness and contrast checks
tools/serve.py      local server with the save endpoint
tools/enrich_genres.py  fetch genres from Google Books
tools/daily_genres.sh   the daily wrapper launchd runs
tools/aggregate.py      rebuild public.json headlessly, with a leak gate
docs/SYNC.md        what survives each hop, and why there is no sync button
docs/DATA-MODEL.md  the book record, field by field
```

## Tests

Open `tests.html` with the server running. 79 tests covering CSV edge cases
(quoted commas, embedded newlines, doubled quotes, BOMs, CRLF), both format
adapters in both directions, the merge rules, and the guarantees that private
notes never reach `books.json` and that no book is named in `public.json`.

They run in the page rather than under a test runner so that the project keeps
its promise of no build step and no dependencies — a browser is the only
requirement.

## Themes

Everything visual lives in `assets/theme.css` as tokens — colours, type, radii,
the shape of a bar. Three themes ship: **Barbie** (default), **Warm** and
**Night**, switched from the picker in the header and remembered per browser.
Nothing in the charts or the controllers knows which theme is on, so a new look
is an edit to one file.

Barbie adds butterflies and glitter that follow the cursor. They stop entirely
under `prefers-reduced-motion` — a particle trail chasing the pointer is
exactly what that setting exists to prevent.

**A theme that fails its colour checks fails the test run.** `tests.html` reads
each theme's real tokens out of the stylesheet and puts them through
`assets/js/palette.js`: colour-blind separation between series colours
(simulating protanopia and deuteranopia), contrast against that theme's own
surface, and that the heatmap ramp is monotone with visible steps. The maths is
self-contained, so this stays dependency-free. Two of the tests check the
checks — a palette that should fail must actually fail.

## On a phone

Controls get 44px targets, form fields are 16px so iOS does not zoom in when
you tap one, and long rows of buttons scroll sideways in a single line rather
than wrapping into four rows of chrome above the reading.

Chart text is sized in viewBox units, so it shrinks with the chart: an 11px
label on a 720-wide chart renders at about 5px on a 375px screen — fine on the
desktop it was measured on, unreadable on a phone. The scaled charts declare
larger type on small screens so it lands back near 11px. The heatmap cannot
shrink at all (squeezed, it ran the months together into "JanFebMar" and
clipped "2018" to "018"), so it keeps its natural size and scrolls sideways
inside its card.

## Notes on the charts

Counts only ever get whole-numbered axes. The current year's pace line stops at
the present month rather than running flat to December, which would read as
having stopped reading. Every chart has a table view, because a value should
never be reachable only by hovering. Colours come from a palette checked for
colour-blind separation and contrast against both the light and dark surfaces.

## Licence

MIT. Fork it, drop your own export in, and it is yours.
