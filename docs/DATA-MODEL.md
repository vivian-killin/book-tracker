# The book record

Everything lives in `data/books.json`. One file, plain JSON, versioned in git —
so every change to your reading history is a normal diff you can read and
revert.

```json
{
  "version": 1,
  "updated": "2026-08-16",
  "books": [ /* ... */ ]
}
```

Books are sorted newest-finished-first on save, which keeps the diff for
"I read one more book" to a single added block.

## Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | `title-slug--author-slug`, unique within the file. Stable once assigned. |
| `title` | string | The only required field. |
| `author` | string | Primary author, as the service spells it. |
| `additionalAuthors` | string[] | Co-authors, translators, illustrators. |
| `isbn` | string | ISBN-10, digits only. `''` when unknown. |
| `isbn13` | string | ISBN-13, digits only. The best cross-service match key. |
| `pages` | number \| null | Goodreads is the usual source; StoryGraph has no column for it. |
| `publisher` | string | Goodreads only. |
| `binding` | string | Goodreads' term. |
| `format` | string | StoryGraph's term. Both are kept because the two services use different vocabularies. |
| `yearPublished` | number \| null | This edition. |
| `originalYear` | number \| null | First publication. |
| `status` | enum | `read`, `reading`, `to-read`, `dnf`. |
| `rating` | number \| null | 0–5 in 0.25 steps. `null` means unrated — never `0`. |
| `dateAdded` | ISO date \| null | |
| `dateStarted` | ISO date \| null | StoryGraph or manual entry; Goodreads has no column. |
| `dateRead` | ISO date \| null | Finish date. Drives every chart. |
| `readCount` | number | Defaults to 1. |
| `review` | string | Public on both services. |
| `privateNotes` | string | **Never written to `books.json`.** Kept in the gitignored `data/notes.json` and rejoined by id at load time. |
| `tags` | string[] | Goodreads bookshelves and StoryGraph tags, merged. |
| `moods` | string[] | StoryGraph only. |
| `pace` | string | `Slow`, `Medium`, `Fast`. StoryGraph only. |
| `contentWarnings` | string | StoryGraph only. |
| `owned` | boolean | |
| `source` | string | `goodreads`, `storygraph`, or `manual`. Provenance, not behaviour. |

## Conventions worth knowing

**Dates are ISO `YYYY-MM-DD`, always.** Both services export `YYYY/MM/DD`;
conversion happens at the format boundary, never in storage. Dates are stamped
in your local timezone, not UTC — otherwise an evening entry west of Greenwich
lands in tomorrow, and occasionally in the wrong month on the charts.

**`rating` is `null`, not `0`, when unrated.** Goodreads writes `0` for "no
rating", which would otherwise drag every average down.

**Status is separate from tags.** Goodreads stores reading state in
`Exclusive Shelf` and everything else in `Bookshelves`. On import the exclusive
shelf becomes `status` and is stripped from `tags`, so you don't end up with a
tag called "read" on every book.

**`dnf` has no Goodreads equivalent.** See [SYNC.md](SYNC.md) for how it
survives the round-trip.

## Private notes live in a second file

`books.json` is committed, and on GitHub Pages it is served to anyone with the
link — so anything inside it is published. Notes are the one field that is
meant only for you, so they are stored apart:

```
data/books.json   committed, published, privateNotes always ""
data/notes.json   gitignored, never committed, { "<book id>": "the note" }
```

`serializeLibrary()` blanks the field on the way out, and it is the single
function every save and every download passes through, so the separation holds
by construction rather than by remembering. `tools/serve.py` strips the field
again server-side as a backstop. Loading rejoins the two by book id, so the
shelf shows your notes normally when you run the site locally; on the published
copy the notes file simply 404s and the column is empty.

The Goodreads CSV export **does** carry notes — that column is private to your
Goodreads account, and it is what makes the export a real backup of them.
Deleting `data/notes.json` without one loses the notes for good.

## Identity and merging

Two records are the same book if they agree on, in order of preference:

1. `isbn13`
2. `isbn`
3. normalised title + first author — lowercased, punctuation stripped, and
   parentheticals removed, so `Dune (Dune, #1)` matches `Dune`

Merging is field-level, not record-level: an incoming record fills gaps in the
existing one rather than replacing it. Existing non-empty values win, so a
manual edit is never clobbered by a re-import. The exception is a newer
`dateRead`, which wins and brings its `status` with it.
