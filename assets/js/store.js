/**
 * Library persistence and derived statistics.
 *
 * Two runtimes, one codebase:
 *   - Local (`python3 tools/serve.py`): a save API is present, so edits write
 *     straight to data/books.json and you commit them like any other change.
 *   - Hosted (GitHub Pages, or someone else's fork): no save API, so edits live
 *     in localStorage and are exported by downloading books.json.
 *
 * The UI asks `hasSaveApi()` rather than sniffing the hostname, so a fork works
 * without configuration.
 */

import { makeBook, todayISO, STATUS } from './formats.js';

const LOCAL_KEY = 'book-tracker:library';
const NOTES_KEY = 'book-tracker:notes';
const DATA_URL = 'data/books.json';
const NOTES_URL = 'data/notes.json';
const PUBLIC_URL = 'data/public.json';

let saveApiAvailable = null;

/**
 * Probe for the local save API exactly once per page load.
 * @returns {Promise<boolean>}
 */
export async function hasSaveApi() {
  if (saveApiAvailable !== null) return saveApiAvailable;
  try {
    const res = await fetch('api/status', { method: 'GET' });
    saveApiAvailable = res.ok;
  } catch {
    saveApiAvailable = false;
  }
  return saveApiAvailable;
}

/**
 * Load the library. A locally-imported library (localStorage) takes precedence
 * over the committed one, so a visitor who drops in their own CSV keeps seeing
 * their own data on reload.
 *
 * Private notes are stored separately and reattached here. On a published site
 * the notes file simply isn't there, so the graph renders without them —
 * which is the entire point.
 *
 * @returns {Promise<{books: Object[], isLocal: boolean}>}
 */
export async function loadLibrary() {
  const local = readLocal();
  if (local) {
    return { books: attachNotes(local, readLocalNotes()), isLocal: true };
  }

  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    const json = await res.json();
    const books = (json.books || []).map((b) => makeBook(b));
    return { books: attachNotes(books, await fetchNotes()), isLocal: false };
  } catch {
    // books.json is gitignored, so on any published copy it is absent. Fall
    // back to the aggregates, which are all a visitor is ever meant to get.
    const stats = await fetchPublicStats();
    if (stats) return { books: [], isLocal: false, stats };
    // A fresh fork with no data at all is a valid empty state, not an error.
    return { books: [], isLocal: false };
  }
}

/** @returns {Promise<Object|null>} the published aggregates, if deployed */
async function fetchPublicStats() {
  try {
    const res = await fetch(PUBLIC_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Persist the library. Writes to data/books.json when the local server is
 * running, otherwise to localStorage.
 *
 * Private notes are peeled off first and written to their own destination, so
 * that no code path can put them in the file that gets committed and served.
 *
 * @param {Object[]} books
 * @returns {Promise<{target: 'file'|'browser', notes: number}>}
 */
export async function saveLibrary(books) {
  const notes = collectNotes(books);
  const payload = serializeLibrary(books);
  const noteCount = Object.keys(notes).length;

  if (await hasSaveApi()) {
    const res = await fetch('api/books', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (!res.ok) {
      throw new Error(`Save failed (${res.status}): ${await res.text()}`);
    }

    const notesRes = await fetch('api/notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, notes }, null, 2) + '\n',
    });
    if (!notesRes.ok) {
      throw new Error(
        `Books saved, but notes failed (${notesRes.status}): ${await notesRes.text()}`,
      );
    }

    // Regenerate the publishable aggregates on every save, so the committed
    // file can never lag behind the library it summarises.
    const stats = computeStats(books);
    const unsafe = auditStats(stats);
    if (unsafe.length) {
      throw new Error(`Refusing to publish: ${unsafe.join('; ')}`);
    }
    const pubRes = await fetch('api/public', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stats, null, 2) + '\n',
    });
    if (!pubRes.ok) {
      throw new Error(
        `Books saved, but the public file failed (${pubRes.status}): ${await pubRes.text()}`,
      );
    }

    // Clear any stale browser copies so the files stay the single source.
    localStorage.removeItem(LOCAL_KEY);
    localStorage.removeItem(NOTES_KEY);
    return { target: 'file', notes: noteCount };
  }

  localStorage.setItem(LOCAL_KEY, payload);
  localStorage.setItem(NOTES_KEY, JSON.stringify({ version: 1, notes }));
  return { target: 'browser', notes: noteCount };
}

/**
 * Republish the aggregates if they no longer match the committed file.
 *
 * The genre backfill runs outside the browser and edits books.json directly,
 * so without this the published summary would quietly lag behind the library
 * until the next time a book happened to be logged. Opening the site locally
 * is enough to bring it back in step.
 *
 * The date stamps are excluded from the comparison, so simply opening the page
 * on a new day does not manufacture a diff.
 *
 * @param {Object[]} books
 * @returns {Promise<boolean>} whether anything was rewritten
 */
export async function syncPublicIfStale(books) {
  if (!books.length || !(await hasSaveApi())) return false;

  const fresh = computeStats(books);
  const unsafe = auditStats(fresh);
  if (unsafe.length) throw new Error(`Refusing to publish: ${unsafe.join('; ')}`);

  const strip = (o) => {
    if (!o) return null;
    const { generated, updated, ...rest } = o;
    return JSON.stringify(rest);
  };
  const current = await fetchPublicStats();
  if (current && strip(current) === strip(fresh)) return false;

  const res = await fetch('api/public', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fresh, null, 2) + '\n',
  });
  if (!res.ok) throw new Error(`Publish failed (${res.status}): ${await res.text()}`);
  return true;
}

/**
 * Pull private notes out of a book list into an id-keyed map.
 * @param {Object[]} books
 * @returns {Object<string,string>}
 */
export function collectNotes(books) {
  const notes = {};
  for (const b of books) {
    const text = (b.privateNotes || '').trim();
    if (text) notes[b.id] = b.privateNotes;
  }
  return notes;
}

/**
 * Reattach notes to books by id. Returns the same array for convenience.
 * @param {Object[]} books
 * @param {Object<string,string>} notes
 * @returns {Object[]}
 */
export function attachNotes(books, notes) {
  if (!notes) return books;
  for (const b of books) {
    if (notes[b.id]) b.privateNotes = notes[b.id];
  }
  return books;
}

/** @returns {Promise<Object<string,string>|null>} */
async function fetchNotes() {
  try {
    const res = await fetch(NOTES_URL, { cache: 'no-store' });
    // A 404 is the normal, expected case on any published copy of the site.
    if (!res.ok) return null;
    return (await res.json()).notes || null;
  } catch {
    return null;
  }
}

/** @returns {Object<string,string>|null} */
function readLocalNotes() {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    return raw ? (JSON.parse(raw).notes || null) : null;
  } catch {
    return null;
  }
}

/** Discard the browser-local library and fall back to the committed one. */
export function clearLocal() {
  localStorage.removeItem(LOCAL_KEY);
}

/** @returns {Object[]|null} */
function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const json = JSON.parse(raw);
    return (json.books || []).map((b) => makeBook(b));
  } catch {
    return null;
  }
}

/**
 * Canonical on-disk shape for books.json. Sorted by finish date so git diffs
 * stay small and readable when you add one book at a time.
 *
 * **`privateNotes` is always blanked here.** This is the single chokepoint
 * every write and every download goes through, so emptying the field at this
 * one place is what makes "notes are never published" true rather than merely
 * intended. Notes travel separately, via `collectNotes`.
 *
 * @param {Object[]} books
 * @returns {string}
 */
export function serializeLibrary(books) {
  const sorted = books
    .map((b) => (b.privateNotes ? { ...b, privateNotes: '' } : b))
    .sort((a, b) => {
      const ad = a.dateRead || a.dateAdded || '';
      const bd = b.dateRead || b.dateAdded || '';
      if (ad !== bd) return bd.localeCompare(ad);
      return a.title.localeCompare(b.title);
    });
  return JSON.stringify(
    { version: 1, updated: todayISO(), books: sorted },
    null,
    2,
  ) + '\n';
}

// ---------------------------------------------------------------------------
// Derived statistics
// ---------------------------------------------------------------------------

/**
 * Books marked read, whether or not they carry a finish date.
 *
 * This is the honest answer to "how many books have I read". Goodreads
 * libraries built up over years are full of books shelved as read with no
 * date — anything added before you started dating them, or imported in bulk.
 */
export function readBooks(books) {
  return books.filter((b) => b.status === STATUS.READ);
}

/**
 * Books that can be placed on a timeline — read *and* dated.
 *
 * Every time-based chart uses this, so it is deliberately narrower than
 * `readBooks`. The gap between the two is surfaced in the UI rather than
 * left for the reader to discover by noticing the totals disagree.
 */
export function finished(books) {
  return books.filter((b) => b.status === STATUS.READ && b.dateRead);
}

/** How many read books carry no finish date, and so sit outside the charts. */
export function undatedCount(books) {
  return readBooks(books).length - finished(books).length;
}

/** @returns {number} calendar year of a finish date */
function yearOf(iso) {
  return Number(iso.slice(0, 4));
}

/** @returns {number} 0-indexed month of a finish date */
function monthOf(iso) {
  return Number(iso.slice(5, 7)) - 1;
}

/**
 * Every year that has at least one finished book, newest first.
 * @param {Object[]} books
 * @returns {number[]}
 */
export function yearsWithReading(books) {
  const set = new Set(finished(books).map((b) => yearOf(b.dateRead)));
  return Array.from(set).sort((a, b) => b - a);
}

/**
 * Books finished in each month of a year.
 * @param {Object[]} books
 * @param {number} year
 * @returns {number[]} 12 counts, January first
 */
export function booksPerMonth(books, year) {
  const counts = new Array(12).fill(0);
  finished(books)
    .filter((b) => yearOf(b.dateRead) === year)
    .forEach((b) => { counts[monthOf(b.dateRead)]++; });
  return counts;
}

/**
 * Running total of books finished through each day of a year, sampled monthly.
 * Used to compare this year's pace against last year's on one axis.
 *
 * @param {Object[]} books
 * @param {number} year
 * @returns {number[]} 12 cumulative totals
 */
export function cumulativeByMonth(books, year) {
  const monthly = booksPerMonth(books, year);
  let total = 0;
  return monthly.map((n) => (total += n));
}

/**
 * Distribution of star ratings, bucketed to whole stars.
 * Quarter stars round to the nearest whole so the histogram stays readable;
 * the exact value is always visible in the table view.
 *
 * @param {Object[]} books
 * @returns {number[]} 5 counts, one star first
 */
export function ratingHistogram(books) {
  const counts = new Array(5).fill(0);
  books
    .filter((b) => b.rating)
    .forEach((b) => {
      const bucket = Math.min(5, Math.max(1, Math.round(b.rating)));
      counts[bucket - 1]++;
    });
  return counts;
}

/**
 * Most-read authors by finished-book count.
 * @param {Object[]} books
 * @param {number} [limit]
 * @returns {{author: string, count: number}[]}
 */
export function topAuthors(books, limit = 8) {
  const counts = new Map();
  finished(books).forEach((b) => {
    if (!b.author) return;
    counts.set(b.author, (counts.get(b.author) || 0) + 1);
  });
  return Array.from(counts, ([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count || a.author.localeCompare(b.author))
    .slice(0, limit);
}

/**
 * Headline numbers for a given year.
 * @param {Object[]} books
 * @param {number} year
 * @returns {{books: number, pages: number, avgRating: number|null, authors: number, medianDays: number|null}}
 */
export function yearSummary(books, year) {
  const read = finished(books).filter((b) => yearOf(b.dateRead) === year);
  const pages = read.reduce((sum, b) => sum + (b.pages || 0), 0);

  const rated = read.filter((b) => b.rating);
  const avgRating = rated.length
    ? rated.reduce((sum, b) => sum + b.rating, 0) / rated.length
    : null;

  // Only books with both a start and finish date can contribute a duration.
  const durations = read
    .filter((b) => b.dateStarted && b.dateRead && b.dateRead >= b.dateStarted)
    .map((b) => daysBetween(b.dateStarted, b.dateRead))
    .sort((a, b) => a - b);

  return {
    books: read.length,
    pages,
    avgRating,
    authors: new Set(read.map((b) => b.author).filter(Boolean)).size,
    medianDays: durations.length ? median(durations) : null,
  };
}

function daysBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86400000));
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Month-by-year grid for the heatmap.
 * @param {Object[]} books
 * @returns {{years: number[], grid: number[][], max: number}}
 */
export function monthYearGrid(books) {
  const years = yearsWithReading(books).sort((a, b) => a - b);
  const grid = years.map((y) => booksPerMonth(books, y));
  const max = Math.max(1, ...grid.flat());
  return { years, grid, max };
}

// ---------------------------------------------------------------------------
// Public aggregates
// ---------------------------------------------------------------------------

/**
 * Reduce the library to the numbers the charts need, and nothing else.
 *
 * This is what gets committed and published. It deliberately contains no book
 * records at all — no titles, no ISBNs, no dates attached to anything
 * identifiable — so a public copy of the site can render the whole graph
 * without disclosing what was read. Author and genre names appear only as
 * aggregate counts, never joined to a book or a date.
 *
 * Computing it here rather than in a separate script means the published
 * numbers come from exactly the same code as the local ones, so the two can
 * never drift apart.
 *
 * @param {Object[]} books
 * @returns {Object}
 */
export function computeStats(books) {
  const years = yearsWithReading(books);
  const read = readBooks(books);
  const dated = finished(books);

  const perYear = {};
  const monthly = {};
  const ratings = { all: ratingHistogram(dated) };
  const authors = { all: rankAuthors(dated) };
  const genres = { all: rankGenres(dated) };

  for (const y of years) {
    const inYear = dated.filter((b) => Number(b.dateRead.slice(0, 4)) === y);
    const summary = yearSummary(books, y);
    perYear[y] = {
      books: summary.books,
      pages: summary.pages,
      authors: summary.authors,
      rated: inYear.filter((b) => b.rating).length,
      avgRating: summary.avgRating,
      medianDays: summary.medianDays,
      pagesCounted: inYear.filter((b) => b.pages).length,
      // The page count of the longest book, without naming it.
      longestPages: inYear.reduce((m, b) => Math.max(m, b.pages || 0), 0) || null,
    };
    monthly[y] = booksPerMonth(books, y);
    ratings[y] = ratingHistogram(inYear);
    authors[y] = rankAuthors(inYear);
    genres[y] = rankGenres(inYear);
  }

  const allRated = dated.filter((b) => b.rating);
  const grid = monthYearGrid(books);

  // Genre trends: one series per genre, counts per year. Rendered as small
  // multiples rather than a stack, so each genre keeps its own baseline and
  // no reader has to compare segments floating at different heights.
  const topGenres = genres.all.slice(0, 6).map((g) => g.name);
  const genreYears = years.slice().sort((a, b) => a - b);
  const genreTrend = topGenres.map((name) => ({
    name,
    values: genreYears.map((y) =>
      dated.filter((b) => Number(b.dateRead.slice(0, 4)) === y
        && (b.genres || []).includes(name)).length),
  }));

  return {
    version: 1,
    generated: todayISO(),
    totals: {
      tracked: books.length,
      read: read.length,
      dated: dated.length,
      undated: read.length - dated.length,
      pages: dated.reduce((s, b) => s + (b.pages || 0), 0),
      pagesCounted: dated.filter((b) => b.pages).length,
      authors: new Set(dated.map((b) => b.author).filter(Boolean)).size,
      rated: allRated.length,
      avgRating: allRated.length
        ? allRated.reduce((s, b) => s + b.rating, 0) / allRated.length
        : null,
      longestPages: dated.reduce((m, b) => Math.max(m, b.pages || 0), 0) || null,
    },
    years,
    perYear,
    monthly,
    ratings,
    authors,
    genres,
    heat: { years: grid.years, grid: grid.grid, max: grid.max },
    genreTrend: { years: genreYears, series: genreTrend },
    genreCoverage: {
      tagged: dated.filter((b) => (b.genres || []).length).length,
      total: dated.length,
      noIsbn: books.filter((b) => !b.isbn13 && !b.isbn).length,
    },
    lengths: bandCounts(dated, LENGTH_BANDS, (b) => b.pages),
    ages: bandCounts(
      dated.filter((b) => b.originalYear || b.yearPublished),
      AGE_BANDS,
      (b) => Number(b.dateRead.slice(0, 4)) - (b.originalYear || b.yearPublished),
    ),
    ratingByGenre: avgRatingByGenre(dated),
    rereads: dated.filter((b) => (b.readCount || 1) > 1).length,
  };
}

/** Page-count bands, in the order they should appear on an axis. */
const LENGTH_BANDS = [
  ['Under 200', (n) => n < 200],
  ['200–299', (n) => n < 300],
  ['300–399', (n) => n < 400],
  ['400–499', (n) => n < 500],
  ['500+', () => true],
];

/** How old a book was when it was read. */
const AGE_BANDS = [
  ['Same year', (n) => n <= 0],
  ['1 year', (n) => n <= 1],
  ['2–3 years', (n) => n <= 3],
  ['4–9 years', (n) => n <= 9],
  ['10+ years', () => true],
];

/**
 * Bucket books into ordered bands.
 * @returns {{name: string, count: number}[]}
 */
function bandCounts(books, bands, valueOf) {
  const counts = bands.map(([name]) => ({ name, count: 0 }));
  for (const b of books) {
    const v = valueOf(b);
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    for (let i = 0; i < bands.length; i++) {
      if (bands[i][1](v)) { counts[i].count++; break; }
    }
  }
  return counts;
}

/*
 * Format is deliberately not aggregated or published.
 *
 * Goodreads records the binding of the *edition* it matched, not the copy you
 * actually read, so a library read almost entirely on a Kindle reports itself
 * as mostly paperback. The number is wrong rather than merely uninteresting,
 * and a wrong number on a chart is worse than an absent one. The raw field is
 * still kept on each book, where it is at least labelled as coming from the
 * import.
 */

/**
 * Average rating per genre, for genres with enough rated books to mean
 * anything. A one-book average is noise dressed up as a finding.
 */
function avgRatingByGenre(books, minRated = 3) {
  const sums = new Map();
  for (const b of books) {
    if (!b.rating) continue;
    for (const g of (b.genres || [])) {
      const cur = sums.get(g) || { total: 0, n: 0 };
      cur.total += b.rating;
      cur.n += 1;
      sums.set(g, cur);
    }
  }
  return Array.from(sums, ([name, v]) => ({
    name, count: v.n, avg: Math.round((v.total / v.n) * 100) / 100,
  }))
    .filter((g) => g.count >= minRated)
    .sort((a, b) => b.avg - a.avg || b.count - a.count);
}

/** Top authors by count. Names only, never joined to a title or a date. */
function rankAuthors(books, limit = 8) {
  const counts = new Map();
  books.forEach((b) => {
    if (b.author) counts.set(b.author, (counts.get(b.author) || 0) + 1);
  });
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Top genres by count. Empty until books carry genre tags. */
function rankGenres(books, limit = 8) {
  const counts = new Map();
  books.forEach((b) => {
    (b.genres || []).forEach((g) => counts.set(g, (counts.get(g) || 0) + 1));
  });
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Assert that an aggregate payload carries nothing book-identifying.
 * Used as a guard before publishing, and by the tests.
 * @param {Object} stats
 * @returns {string[]} reasons it is unsafe; empty means safe
 */
export function auditStats(stats) {
  const problems = [];
  const banned = ['title', 'isbn', 'isbn13', 'privateNotes', 'review', 'dateRead'];

  // No exceptions. Nothing published names a book, so any of these keys
  // carrying text anywhere in the payload is a leak, full stop.
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        // `books` as a plain count is fine; `books` as a list of records is not.
        if (k === 'books' && Array.isArray(v) && v.some((x) => x && typeof x === 'object')) {
          problems.push(`${path}.books is an array of records`);
        } else if (banned.includes(k) && typeof v === 'string' && v.trim()) {
          problems.push(`${path}.${k} contains text`);
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(stats, '$');
  return problems;
}

