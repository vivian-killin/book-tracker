# Keeping Goodreads and StoryGraph in sync

## Why there is no "sync" button

Neither service will let a program write to your account.

- **Goodreads** stopped issuing developer keys on 8 December 2020 and retired
  the public API. There is no application process, no waitlist, and no
  replacement. Existing integrations have been breaking ever since.
- **StoryGraph** has never had a public API. It sits on their public roadmap as
  a request with no ETA, and the team has said it is not a priority.

So the options for "update both at once" are:

1. **Drive the websites with a script**, logged in as you. This needs your
   session cookies on disk, breaks whenever either site changes its HTML, and
   looks like bot traffic to both services. Not what this repo does.
2. **CSV.** Both services import CSV, and StoryGraph explicitly documents
   Goodreads' column layout as the format to use when migrating from anywhere
   else. That is what this repo does.

The result is not one click, but it is two uploads instead of three manual
entries, and nothing about it can silently break.

## The workflow

1. Finish a book. Log it once, in `log.html`.
2. Download the CSV — Goodreads format, StoryGraph format, or both.
3. Upload to <https://www.goodreads.com/review/import> and
   <https://app.thestorygraph.com/import>.

Both importers match on title, author and ISBN and update existing entries
rather than creating duplicates, so re-uploading the whole library is safe.
Adding an ISBN-13 when you log a book makes that matching considerably more
reliable, especially for reissues and audiobooks.

## Which file to upload where

| | Goodreads CSV | StoryGraph CSV |
|---|---|---|
| Goodreads import | **use this** | not its native layout |
| StoryGraph import | works — documented as the migration format | **use this** |

The StoryGraph file is the richer of the two. Prefer it for StoryGraph.

## What each format can carry

The canonical record in `data/books.json` is a superset of both services, so
importing from one never discards what the other knows. Fidelity is only lost
on the way *out*:

| Field | Goodreads CSV | StoryGraph CSV |
|---|---|---|
| Title, author, ISBN | yes | yes |
| Star rating | **whole stars only** — 4.25 becomes 4 | quarter stars, exact |
| Date finished | yes | yes |
| Date started | no column | yes, via `Dates Read` |
| Page count | yes | no column |
| Review | yes | yes |
| **Private notes** | yes, `Private Notes` | **no column — dropped** |
| Shelves / tags | yes, `Bookshelves` | yes, `Tags` |
| Moods, pace | no columns | yes |
| Did not finish | no such shelf — see below | yes, native |
| Owned | yes | yes |

Two consequences worth knowing:

- **Your private notes never reach StoryGraph.** They are in the Goodreads file
  and in your own `books.json`. If the notes are the point, keep them here.
- **Goodreads has no did-not-finish state.** A DNF book is exported with the
  exclusive shelf `read` plus a `did-not-finish` bookshelf, which is the
  convention Goodreads users already follow. This app reads that convention
  back, so a DNF survives a full Goodreads round-trip.

## Getting your existing library in

You are not starting from scratch — export what you already have and import it
here. The merge is field-by-field, so doing **both** is worthwhile: Goodreads
contributes page counts and private notes, StoryGraph contributes quarter-star
ratings, start dates, moods and pace. Books present in both are matched on
ISBN-13, then ISBN, then normalised title + author, and combined into one
record.

- Goodreads: My Books → Import and Export → Export Library, then wait for the
  email or refresh until the download link appears.
- StoryGraph: Profile → Manage Account → Export StoryGraph Library.

Existing values are never overwritten by a re-import, with one deliberate
exception: a **newer finish date wins**, and brings its reading status with it.
That makes re-importing a fresh export the correct way to catch up after
logging books elsewhere.

## Sources

- [Goodreads API deprecation announcement](https://www.goodreads.com/topic/show/21788520-api-deprecation)
- [Goodreads developer keys thread](https://www.goodreads.com/topic/show/22303603-developer-keys)
- [StoryGraph roadmap: an API](https://roadmap.thestorygraph.com/features/posts/an-api)
