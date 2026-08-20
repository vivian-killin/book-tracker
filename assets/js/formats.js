/**
 * Format adapters: Goodreads CSV <-> canonical <-> StoryGraph CSV.
 *
 * The canonical record is the superset. It keeps StoryGraph's quarter-star
 * ratings and DNF status alongside Goodreads' page counts and private notes,
 * so importing from one service never silently discards what the other knows.
 * Downgrades happen only at export time, and are documented in docs/SYNC.md.
 */

import { parseCSV, toCSV } from './csv.js';

/** Exact Goodreads export header order. StoryGraph's importer matches on these names. */
export const GOODREADS_HEADERS = [
  'Book Id', 'Title', 'Author', 'Author l-f', 'Additional Authors',
  'ISBN', 'ISBN13', 'My Rating', 'Average Rating', 'Publisher', 'Binding',
  'Number of Pages', 'Year Published', 'Original Publication Year',
  'Date Read', 'Date Added', 'Bookshelves', 'Bookshelves with positions',
  'Exclusive Shelf', 'My Review', 'Spoiler', 'Private Notes',
  'Read Count', 'Owned Copies',
];

/** Exact StoryGraph export header order. */
export const STORYGRAPH_HEADERS = [
  'Title', 'Authors', 'Contributors', 'ISBN/UID', 'Format', 'Read Status',
  'Date Added', 'Last Date Read', 'Dates Read', 'Read Count', 'Moods', 'Pace',
  'Character- or Plot-Driven?', 'Strong Character Development?',
  'Loveable Characters?', 'Diverse Characters?', 'Flawed Characters?',
  'Star Rating', 'Review', 'Content Warnings', 'Content Warning Description',
  'Tags', 'Owned?',
];

/** Canonical reading states. */
export const STATUS = {
  READ: 'read',
  READING: 'reading',
  TO_READ: 'to-read',
  DNF: 'dnf',
};

// Goodreads ships three exclusive shelves but lets you add your own, and
// `did-not-finish` is the one people actually add. Real exports carry it in
// `Exclusive Shelf`, so match it there as well as in `Bookshelves`.
const GR_SHELF_TO_STATUS = {
  'read': STATUS.READ,
  'currently-reading': STATUS.READING,
  'to-read': STATUS.TO_READ,
  'did-not-finish': STATUS.DNF,
  'dnf': STATUS.DNF,
  'abandoned': STATUS.DNF,
};

const SG_STATUS_TO_STATUS = {
  'read': STATUS.READ,
  'currently-reading': STATUS.READING,
  'currently reading': STATUS.READING,
  'to-read': STATUS.TO_READ,
  'to read': STATUS.TO_READ,
  'did-not-finish': STATUS.DNF,
  'did not finish': STATUS.DNF,
  'dnf': STATUS.DNF,
};

// ---------------------------------------------------------------------------
// Field-level normalizers
// ---------------------------------------------------------------------------

/**
 * Strip Goodreads' spreadsheet-armour from an ISBN cell.
 * Goodreads writes `="0439023483"` so Excel won't eat the leading zero.
 * @param {string} value
 * @returns {string} bare ISBN, or '' when absent
 */
export function cleanISBN(value) {
  if (!value) return '';
  const m = String(value).trim().match(/^="?(.*?)"?$/);
  const bare = (m ? m[1] : String(value)).replace(/["\s-]/g, '').trim();
  return /^[0-9]{9,12}[0-9Xx]$/.test(bare) ? bare.toUpperCase() : '';
}

/**
 * Normalize a date cell to ISO `YYYY-MM-DD`.
 * Accepts Goodreads' `YYYY/MM/DD`, ISO, and `MM/DD/YYYY`.
 * @param {string} value
 * @returns {string|null}
 */
export function toISODate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[1])}-${pad2(m[2])}`;

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return null;
}

/**
 * Render an ISO date as Goodreads' `YYYY/MM/DD`.
 * @param {string|null} iso
 * @returns {string}
 */
export function toGoodreadsDate(iso) {
  return iso ? iso.replace(/-/g, '/') : '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Today's date in the reader's own timezone.
 *
 * `new Date().toISOString()` is UTC, so anyone west of Greenwich logging a book
 * in the evening would have it dated tomorrow — which then lands it in the
 * wrong month, and occasionally the wrong year, on every chart.
 *
 * @returns {string} `YYYY-MM-DD`
 */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Parse a rating cell. Goodreads uses integers 1-5 with 0 meaning "unrated";
 * StoryGraph uses 0.25 steps. Both collapse to a float or null here.
 * @param {string|number} value
 * @returns {number|null}
 */
export function parseRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(5, Math.round(n * 4) / 4);
}

/**
 * Split a delimited multi-value cell (shelves, moods, tags) into trimmed parts.
 * @param {string} value
 * @returns {string[]}
 */
export function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntOrNull(value) {
  const n = parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function truthy(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'yes' || s === 'true' || (Number(s) > 0);
}

/** `Le Guin, Ursula K.` from `Ursula K. Le Guin`, for Goodreads' `Author l-f`. */
function toLastFirst(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return name || '';
  const last = parts.pop();
  return `${last}, ${parts.join(' ')}`;
}

/**
 * Pull the reading dates out of StoryGraph's `Dates Read` cell.
 * The cell holds one or more `start-end` ranges; we take the most recent one.
 * Matching date tokens directly avoids splitting on the `-` inside ISO dates.
 * @param {string} value
 * @returns {{started: string|null, finished: string|null}}
 */
export function parseDatesRead(value) {
  const tokens = String(value || '').match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}/g);
  if (!tokens || !tokens.length) return { started: null, finished: null };
  if (tokens.length === 1) return { started: null, finished: toISODate(tokens[0]) };
  return {
    started: toISODate(tokens[tokens.length - 2]),
    finished: toISODate(tokens[tokens.length - 1]),
  };
}

// ---------------------------------------------------------------------------
// Canonical record
// ---------------------------------------------------------------------------

/**
 * Build a canonical book record, filling every field with a stable default so
 * downstream code never has to guard against `undefined`.
 * @param {Object} [partial]
 * @returns {Object}
 */
export function makeBook(partial = {}) {
  const book = {
    id: '',
    title: '',
    author: '',
    additionalAuthors: [],
    isbn: '',
    isbn13: '',
    pages: null,
    publisher: '',
    binding: '',
    format: '',
    yearPublished: null,
    originalYear: null,
    status: STATUS.TO_READ,
    rating: null,
    dateAdded: null,
    dateStarted: null,
    dateRead: null,
    readCount: 1,
    review: '',
    privateNotes: '',
    tags: [],
    // Neither service exports a usable genre: Goodreads has only your own
    // shelves, and StoryGraph has no column for it. Populated by hand or by an
    // enrichment pass; safe to publish because it aggregates to a count.
    genres: [],
    moods: [],
    pace: '',
    contentWarnings: '',
    owned: false,
    source: 'manual',
    ...partial,
  };
  if (!book.id) book.id = bookId(book);
  return book;
}

/**
 * Stable, human-readable id derived from title and author.
 * @param {Object} book
 * @returns {string}
 */
export function bookId(book) {
  const slug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const base = [slug(book.title), slug(book.author)].filter(Boolean).join('--');
  return base || 'untitled';
}

/**
 * Identity key used to recognise the same book arriving from two services.
 * ISBN13 is most reliable; title+author is the fallback when a service
 * exports no identifier (common for ebooks and audiobooks).
 * @param {Object} book
 * @returns {string}
 */
export function matchKey(book) {
  if (book.isbn13) return `isbn13:${book.isbn13}`;
  if (book.isbn) return `isbn:${book.isbn}`;
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      // Drop subtitles and series parentheticals so "Dune" matches
      // "Dune (Dune, #1)" across services.
      .replace(/\s*[([].*?[)\]]\s*/g, ' ')
      .replace(/[^a-z0-9]+/g, '')
      .trim();
  return `ta:${norm(book.title)}|${norm(firstAuthor(book.author))}`;
}

function firstAuthor(author) {
  return String(author || '').split(/\s*,\s*/)[0];
}

// ---------------------------------------------------------------------------
// Goodreads adapter
// ---------------------------------------------------------------------------

/**
 * Convert one Goodreads export row to a canonical record.
 * @param {Object<string,string>} row
 * @returns {Object}
 */
export function goodreadsRowToBook(row) {
  const shelf = String(row['Exclusive Shelf'] || '').trim().toLowerCase();
  const shelves = splitList(row['Bookshelves']);

  // Goodreads has no DNF state, so a `did-not-finish` custom shelf is the
  // convention. Honour it, otherwise the round-trip loses the distinction.
  const dnfShelf = shelves.find((s) => /^(dnf|did-?not-?finish)$/i.test(s));
  const status = dnfShelf
    ? STATUS.DNF
    : (GR_SHELF_TO_STATUS[shelf] || STATUS.TO_READ);

  return makeBook({
    title: (row['Title'] || '').trim(),
    author: (row['Author'] || '').trim(),
    additionalAuthors: splitList(row['Additional Authors']),
    isbn: cleanISBN(row['ISBN']),
    isbn13: cleanISBN(row['ISBN13']),
    pages: parseIntOrNull(row['Number of Pages']),
    publisher: (row['Publisher'] || '').trim(),
    binding: (row['Binding'] || '').trim(),
    format: (row['Binding'] || '').trim(),
    yearPublished: parseIntOrNull(row['Year Published']),
    originalYear: parseIntOrNull(row['Original Publication Year']),
    status,
    rating: parseRating(row['My Rating']),
    dateAdded: toISODate(row['Date Added']),
    dateRead: toISODate(row['Date Read']),
    readCount: parseIntOrNull(row['Read Count']) || 1,
    review: row['My Review'] || '',
    privateNotes: row['Private Notes'] || '',
    // The exclusive shelf is a status, not a tag — keep only real shelves.
    tags: shelves.filter(
      (s) => s.toLowerCase() !== shelf && !/^(dnf|did-?not-?finish)$/i.test(s),
    ),
    owned: truthy(row['Owned Copies']),
    source: 'goodreads',
  });
}

/**
 * Render a canonical record as a Goodreads export row.
 *
 * Lossy by necessity: Goodreads stores whole stars only, so a 4.25 becomes a 4.
 * @param {Object} book
 * @returns {Object<string,string>}
 */
export function bookToGoodreadsRow(book) {
  const isDNF = book.status === STATUS.DNF;
  const shelfFor = {
    [STATUS.READ]: 'read',
    [STATUS.READING]: 'currently-reading',
    [STATUS.TO_READ]: 'to-read',
    // Goodreads has no DNF shelf; `read` + a `did-not-finish` tag is the
    // convention that survives a round-trip back into this app.
    [STATUS.DNF]: 'read',
  };
  const shelf = shelfFor[book.status] || 'to-read';
  const tags = isDNF ? ['did-not-finish', ...book.tags] : book.tags.slice();

  return {
    'Book Id': '',
    'Title': book.title,
    'Author': book.author,
    'Author l-f': toLastFirst(book.author),
    'Additional Authors': book.additionalAuthors.join(', '),
    // Re-armour the ISBN so Excel and Goodreads both read it back intact.
    // A missing ISBN is written as a plain empty cell rather than Goodreads'
    // own `=""`, which the CSV quoter would have to escape into `"="""""` —
    // valid, but needlessly fragile for a value that means "nothing".
    'ISBN': book.isbn ? `="${book.isbn}"` : '',
    'ISBN13': book.isbn13 ? `="${book.isbn13}"` : '',
    'My Rating': book.rating ? String(Math.round(book.rating)) : '0',
    'Average Rating': '',
    'Publisher': book.publisher,
    'Binding': book.binding || book.format,
    'Number of Pages': book.pages ?? '',
    'Year Published': book.yearPublished ?? '',
    'Original Publication Year': book.originalYear ?? '',
    'Date Read': toGoodreadsDate(book.dateRead),
    'Date Added': toGoodreadsDate(book.dateAdded),
    'Bookshelves': tags.join(', '),
    'Bookshelves with positions': tags.map((t, i) => `${t} (#${i + 1})`).join(', '),
    'Exclusive Shelf': shelf,
    'My Review': book.review,
    'Spoiler': '',
    'Private Notes': book.privateNotes,
    'Read Count': String(book.readCount || 1),
    'Owned Copies': book.owned ? '1' : '0',
  };
}

// ---------------------------------------------------------------------------
// StoryGraph adapter
// ---------------------------------------------------------------------------

/**
 * Convert one StoryGraph export row to a canonical record.
 * @param {Object<string,string>} row
 * @returns {Object}
 */
export function storygraphRowToBook(row) {
  const uid = cleanISBN(row['ISBN/UID']);
  const statusRaw = String(row['Read Status'] || '').trim().toLowerCase();
  const dates = parseDatesRead(row['Dates Read']);

  return makeBook({
    title: (row['Title'] || '').trim(),
    author: (row['Authors'] || '').trim(),
    additionalAuthors: splitList(row['Contributors']),
    isbn: uid.length === 13 ? '' : uid,
    isbn13: uid.length === 13 ? uid : '',
    format: (row['Format'] || '').trim(),
    binding: (row['Format'] || '').trim(),
    status: SG_STATUS_TO_STATUS[statusRaw] || STATUS.TO_READ,
    rating: parseRating(row['Star Rating']),
    dateAdded: toISODate(row['Date Added']),
    dateStarted: dates.started,
    dateRead: toISODate(row['Last Date Read']) || dates.finished,
    readCount: parseIntOrNull(row['Read Count']) || 1,
    review: row['Review'] || '',
    tags: splitList(row['Tags']),
    moods: splitList(row['Moods']),
    pace: (row['Pace'] || '').trim(),
    contentWarnings: row['Content Warnings'] || '',
    owned: truthy(row['Owned?']),
    source: 'storygraph',
  });
}

/**
 * Render a canonical record as a StoryGraph export row.
 * Lossless for everything StoryGraph models, including quarter stars and DNF.
 * @param {Object} book
 * @returns {Object<string,string>}
 */
export function bookToStorygraphRow(book) {
  const statusFor = {
    [STATUS.READ]: 'read',
    [STATUS.READING]: 'currently-reading',
    [STATUS.TO_READ]: 'to-read',
    [STATUS.DNF]: 'did-not-finish',
  };
  const range =
    book.dateStarted && book.dateRead
      ? `${toGoodreadsDate(book.dateStarted)}-${toGoodreadsDate(book.dateRead)}`
      : toGoodreadsDate(book.dateRead);

  return {
    'Title': book.title,
    'Authors': book.author,
    'Contributors': book.additionalAuthors.join(', '),
    'ISBN/UID': book.isbn13 || book.isbn,
    'Format': book.format || book.binding,
    'Read Status': statusFor[book.status] || 'to-read',
    'Date Added': toGoodreadsDate(book.dateAdded),
    'Last Date Read': toGoodreadsDate(book.dateRead),
    'Dates Read': range,
    'Read Count': String(book.readCount || 1),
    'Moods': book.moods.join(', '),
    'Pace': book.pace,
    'Character- or Plot-Driven?': '',
    'Strong Character Development?': '',
    'Loveable Characters?': '',
    'Diverse Characters?': '',
    'Flawed Characters?': '',
    'Star Rating': book.rating === null ? '' : String(book.rating),
    'Review': book.review,
    'Content Warnings': book.contentWarnings,
    'Content Warning Description': '',
    'Tags': book.tags.join(', '),
    'Owned?': book.owned ? 'Yes' : 'No',
  };
}

// ---------------------------------------------------------------------------
// Detection and top-level conversion
// ---------------------------------------------------------------------------

/**
 * Identify which service produced a CSV, from its header row.
 * @param {string[]} headers
 * @returns {'goodreads'|'storygraph'|'unknown'}
 */
export function detectFormat(headers) {
  const set = new Set(headers.map((h) => h.trim()));
  if (set.has('Exclusive Shelf') || set.has('Bookshelves with positions')) {
    return 'goodreads';
  }
  if (set.has('Read Status') || set.has('ISBN/UID') || set.has('Star Rating')) {
    return 'storygraph';
  }
  // A hand-rolled CSV using Goodreads column names is still a Goodreads CSV.
  if (set.has('Title') && (set.has('My Rating') || set.has('Date Read'))) {
    return 'goodreads';
  }
  return 'unknown';
}

/**
 * Parse a CSV export from either service into canonical records.
 * @param {string} text raw CSV
 * @param {string} [forceFormat] override detection
 * @returns {{format: string, books: Object[], skipped: number}}
 */
export function importCSV(text, forceFormat) {
  const { headers, rows } = parseCSV(text);
  const format = forceFormat || detectFormat(headers);
  if (format === 'unknown') {
    throw new Error(
      'Unrecognised CSV. Expected a Goodreads or StoryGraph export ' +
        `(saw columns: ${headers.slice(0, 6).join(', ')}).`,
    );
  }
  const convert =
    format === 'goodreads' ? goodreadsRowToBook : storygraphRowToBook;

  const books = [];
  let skipped = 0;
  for (const row of rows) {
    const book = convert(row);
    // A row with no title is a formatting artefact, not a book.
    if (!book.title) {
      skipped++;
      continue;
    }
    books.push(book);
  }
  return { format, books, skipped };
}

/**
 * Serialize canonical records to a CSV in the requested service's format.
 * @param {Object[]} books
 * @param {'goodreads'|'storygraph'} format
 * @returns {string}
 */
export function exportCSV(books, format) {
  if (format === 'storygraph') {
    return toCSV(STORYGRAPH_HEADERS, books.map(bookToStorygraphRow));
  }
  return toCSV(GOODREADS_HEADERS, books.map(bookToGoodreadsRow));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge incoming books into an existing library.
 *
 * Field-level rather than record-level: a Goodreads row that carries a page
 * count fills that gap on a record StoryGraph contributed, and vice versa.
 * Existing non-empty values win, so a manual edit is never clobbered by a
 * re-import — except for status and dates, where the newer read wins.
 *
 * @param {Object[]} existing
 * @param {Object[]} incoming
 * @returns {{books: Object[], added: number, updated: number}}
 */
export function mergeBooks(existing, incoming) {
  const byKey = new Map();
  const books = existing.map((b) => makeBook(b));
  books.forEach((b) => byKey.set(matchKey(b), b));

  let added = 0;
  let updated = 0;

  for (const raw of incoming) {
    const book = makeBook(raw);
    const key = matchKey(book);
    const current = byKey.get(key);

    if (!current) {
      books.push(book);
      byKey.set(key, book);
      added++;
      continue;
    }
    if (mergeInto(current, book)) updated++;
  }

  return { books, added, updated };
}

/**
 * Copy any field the target is missing from the source. Returns whether
 * anything actually changed, so callers can report an honest update count.
 * @param {Object} target
 * @param {Object} source
 * @returns {boolean}
 */
function mergeInto(target, source) {
  let changed = false;
  const setIfEmpty = (field, isEmpty = (v) => !v) => {
    if (isEmpty(target[field]) && !isEmpty(source[field])) {
      target[field] = source[field];
      changed = true;
    }
  };

  const scalars = [
    'author', 'isbn', 'isbn13', 'pages', 'publisher', 'binding', 'format',
    'yearPublished', 'originalYear', 'rating', 'dateAdded', 'dateStarted',
    'review', 'privateNotes', 'pace', 'contentWarnings',
  ];
  scalars.forEach((f) => setIfEmpty(f));

  const lists = ['additionalAuthors', 'tags', 'genres', 'moods'];
  for (const f of lists) {
    const before = target[f].length;
    target[f] = Array.from(new Set([...target[f], ...source[f]]));
    if (target[f].length !== before) changed = true;
  }

  // A finish date is the strongest signal that this record is the newer one.
  if (source.dateRead && (!target.dateRead || source.dateRead > target.dateRead)) {
    target.dateRead = source.dateRead;
    target.status = source.status;
    changed = true;
  } else if (target.status === STATUS.TO_READ && source.status !== STATUS.TO_READ) {
    target.status = source.status;
    changed = true;
  }

  if ((source.readCount || 1) > (target.readCount || 1)) {
    target.readCount = source.readCount;
    changed = true;
  }
  if (source.owned && !target.owned) {
    target.owned = true;
    changed = true;
  }

  return changed;
}
