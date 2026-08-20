/**
 * Test suite for the CSV engine, run in the browser (tests.html).
 *
 * In-page rather than under a test runner because the project deliberately has
 * no build step and no dependencies — `python3 tools/serve.py` then open
 * /tests.html is the whole setup, on any machine with a browser.
 */

import { parseCSV, toCSV, escapeField } from './csv.js';
import { serializeLibrary, collectNotes, attachNotes, computeStats, auditStats } from './store.js';
import {
  cleanISBN, toISODate, toGoodreadsDate, parseRating, parseDatesRead,
  detectFormat, importCSV, exportCSV, mergeBooks, makeBook, matchKey,
  goodreadsRowToBook, bookToGoodreadsRow,
  storygraphRowToBook, bookToStorygraphRow,
  GOODREADS_HEADERS, STORYGRAPH_HEADERS, STATUS,
} from './formats.js';

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, message: err.message });
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${what ? what + ': ' : ''}expected ${b}, got ${a}`);
  }
}

function ok(value, what = 'expected truthy') {
  if (!value) throw new Error(what);
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

test('parses a simple table', () => {
  const { headers, rows } = parseCSV('a,b\n1,2\n3,4\n');
  eq(headers, ['a', 'b']);
  eq(rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
});

test('keeps commas inside quoted fields', () => {
  const { rows } = parseCSV('Title,Review\nDune,"Sprawling, strange, great"\n');
  eq(rows[0].Review, 'Sprawling, strange, great');
});

test('unescapes doubled quotes', () => {
  const { rows } = parseCSV('Title,Review\nDune,"She said ""no"" twice"\n');
  eq(rows[0].Review, 'She said "no" twice');
});

test('keeps newlines inside quoted fields', () => {
  const { rows } = parseCSV('Title,Review\nDune,"line one\nline two"\n');
  eq(rows[0].Review, 'line one\nline two');
  eq(rows.length, 1, 'must not split the record');
});

test('handles CRLF line endings', () => {
  const { rows } = parseCSV('a,b\r\n1,2\r\n');
  eq(rows, [{ a: '1', b: '2' }]);
});

test('strips a UTF-8 BOM from the first header', () => {
  const { headers } = parseCSV('﻿Title,Author\nDune,Herbert\n');
  eq(headers[0], 'Title');
});

test('parses a final row with no trailing newline', () => {
  const { rows } = parseCSV('a,b\n1,2');
  eq(rows.length, 1);
});

test('ignores blank trailing lines', () => {
  const { rows } = parseCSV('a,b\n1,2\n\n');
  eq(rows.length, 1);
});

test('pads short rows instead of dropping columns', () => {
  const { rows } = parseCSV('a,b,c\n1,2\n');
  eq(rows[0], { a: '1', b: '2', c: '' });
});

// ---------------------------------------------------------------------------
// CSV writing
// ---------------------------------------------------------------------------

test('quotes only fields that need it', () => {
  eq(escapeField('plain'), 'plain');
  eq(escapeField('has,comma'), '"has,comma"');
  eq(escapeField('has"quote'), '"has""quote"');
  eq(escapeField('has\nnewline'), '"has\nnewline"');
  eq(escapeField(null), '');
});

test('round-trips writing then reading', () => {
  const headers = ['Title', 'Review'];
  const rows = [{ Title: 'Dune', Review: 'Long, odd,\n"quoted" even' }];
  const { rows: back } = parseCSV(toCSV(headers, rows));
  eq(back[0].Review, rows[0].Review);
});

// ---------------------------------------------------------------------------
// Field normalizers
// ---------------------------------------------------------------------------

test('unwraps the Goodreads ISBN armour', () => {
  eq(cleanISBN('="0439023483"'), '0439023483');
  eq(cleanISBN('="9780439023481"'), '9780439023481');
  eq(cleanISBN('=""'), '');
  eq(cleanISBN(''), '');
  eq(cleanISBN('043902348X'), '043902348X');
});

test('rejects junk in an ISBN cell', () => {
  eq(cleanISBN('="N/A"'), '');
  eq(cleanISBN('not an isbn'), '');
});

test('normalizes the date formats both services emit', () => {
  eq(toISODate('2024/03/15'), '2024-03-15');
  eq(toISODate('2024-03-15'), '2024-03-15');
  eq(toISODate('2024/3/5'), '2024-03-05');
  eq(toISODate(''), null);
  eq(toISODate('not a date'), null);
});

test('writes Goodreads slash dates', () => {
  eq(toGoodreadsDate('2024-03-15'), '2024/03/15');
  eq(toGoodreadsDate(null), '');
});

test('treats a Goodreads 0 rating as unrated', () => {
  eq(parseRating('0'), null);
  eq(parseRating(''), null);
  eq(parseRating('4'), 4);
});

test('keeps StoryGraph quarter stars', () => {
  eq(parseRating('4.25'), 4.25);
  eq(parseRating('3.75'), 3.75);
  eq(parseRating('6'), 5, 'clamps above five');
});

test('pulls the latest range out of Dates Read', () => {
  eq(parseDatesRead('2024/01/05-2024/01/20'),
    { started: '2024-01-05', finished: '2024-01-20' });
  eq(parseDatesRead('2022/02/01-2022/02/10, 2024/01/05-2024/01/20'),
    { started: '2024-01-05', finished: '2024-01-20' });
  eq(parseDatesRead(''), { started: null, finished: null });
});

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

test('detects a Goodreads export', () => {
  eq(detectFormat(GOODREADS_HEADERS), 'goodreads');
});

test('detects a StoryGraph export', () => {
  eq(detectFormat(STORYGRAPH_HEADERS), 'storygraph');
});

test('rejects an unrelated CSV', () => {
  eq(detectFormat(['Name', 'Email']), 'unknown');
});

test('importCSV throws a useful message on junk', () => {
  let msg = '';
  try {
    importCSV('Name,Email\nA,b@c.d\n');
  } catch (err) {
    msg = err.message;
  }
  ok(msg.includes('Goodreads or StoryGraph'), `unhelpful message: ${msg}`);
});

// ---------------------------------------------------------------------------
// Goodreads adapter
// ---------------------------------------------------------------------------

const GOODREADS_SAMPLE = [
  GOODREADS_HEADERS.join(','),
  [
    '17690', '"Dune (Dune, #1)"', '"Frank Herbert"', '"Herbert, Frank"', '""',
    '="0441013597"', '="9780441013593"', '5', '4.25', '"Ace"', '"Paperback"',
    '604', '2005', '1965', '2024/03/15', '2024/02/01',
    '"sci-fi, favourites"', '"sci-fi (#1), favourites (#2)"', 'read',
    '"Astonishing, and I put it off for years."', '', '"Reread before the film."',
    '1', '1',
  ].join(','),
].join('\r\n') + '\r\n';

test('imports a Goodreads row end to end', () => {
  const { format, books } = importCSV(GOODREADS_SAMPLE);
  eq(format, 'goodreads');
  eq(books.length, 1);

  const b = books[0];
  eq(b.title, 'Dune (Dune, #1)');
  eq(b.author, 'Frank Herbert');
  eq(b.isbn, '0441013597');
  eq(b.isbn13, '9780441013593');
  eq(b.rating, 5);
  eq(b.pages, 604);
  eq(b.originalYear, 1965);
  eq(b.status, STATUS.READ);
  eq(b.dateRead, '2024-03-15');
  eq(b.dateAdded, '2024-02-01');
  eq(b.tags, ['sci-fi', 'favourites']);
  eq(b.review, 'Astonishing, and I put it off for years.');
  eq(b.privateNotes, 'Reread before the film.');
  eq(b.owned, true);
});

test('does not turn the exclusive shelf into a tag', () => {
  const { books } = importCSV(GOODREADS_SAMPLE);
  ok(!books[0].tags.includes('read'), 'read leaked into tags');
});

test('Goodreads round-trips without losing a field', () => {
  const original = importCSV(GOODREADS_SAMPLE).books[0];
  const back = goodreadsRowToBook(bookToGoodreadsRow(original));

  for (const field of ['title', 'author', 'isbn', 'isbn13', 'pages', 'rating',
    'status', 'dateRead', 'dateAdded', 'review', 'privateNotes', 'owned',
    'yearPublished', 'originalYear', 'readCount']) {
    eq(back[field], original[field], field);
  }
  eq(back.tags, original.tags, 'tags');
});

test('re-armours ISBNs on export so Excel keeps leading zeros', () => {
  const row = bookToGoodreadsRow(makeBook({ title: 'X', isbn: '0439023483' }));
  eq(row.ISBN, '="0439023483"');
});

test('writes a missing ISBN as an empty cell, not escaped armour', () => {
  const row = bookToGoodreadsRow(makeBook({ title: 'X' }));
  eq(row.ISBN, '');
  // Goodreads' own `=""` would be quoted into `"="""""` by the writer.
  const csv = exportCSV([makeBook({ title: 'X' })], 'goodreads');
  ok(!csv.includes('"="""""'), 'emitted mangled empty-ISBN armour');
  eq(parseCSV(csv).rows[0].ISBN, '');
});

test('numbers the Bookshelves positions from one', () => {
  const row = bookToGoodreadsRow(makeBook({ title: 'X', tags: ['sci-fi', 'owned'] }));
  eq(row['Bookshelves with positions'], 'sci-fi (#1), owned (#2)');
});

test('rounds a quarter star to a whole star for Goodreads', () => {
  eq(bookToGoodreadsRow(makeBook({ title: 'X', rating: 4.25 }))['My Rating'], '4');
  eq(bookToGoodreadsRow(makeBook({ title: 'X', rating: 4.75 }))['My Rating'], '5');
  eq(bookToGoodreadsRow(makeBook({ title: 'X', rating: null }))['My Rating'], '0');
});

test('carries did-not-finish through Goodreads as a shelf', () => {
  const dnf = makeBook({ title: 'Unfinished', status: STATUS.DNF });
  const row = bookToGoodreadsRow(dnf);
  eq(row['Exclusive Shelf'], 'read', 'Goodreads has no DNF shelf');
  ok(row['Bookshelves'].includes('did-not-finish'), 'DNF marker missing');
  eq(goodreadsRowToBook(row).status, STATUS.DNF, 'DNF did not survive the trip');
});

test('reads did-not-finish as a custom Goodreads exclusive shelf', () => {
  // Goodreads lets you add exclusive shelves beyond the standard three, and
  // real exports put the custom name in Exclusive Shelf, not just Bookshelves.
  const row = { Title: 'Abandoned', Author: 'A', 'Exclusive Shelf': 'did-not-finish', Bookshelves: '' };
  eq(goodreadsRowToBook(row).status, STATUS.DNF);
});

test('strips a custom exclusive shelf from the tag list', () => {
  const row = {
    Title: 'Abandoned', Author: 'A',
    'Exclusive Shelf': 'did-not-finish',
    Bookshelves: 'did-not-finish, romance',
  };
  eq(goodreadsRowToBook(row).tags, ['romance']);
});

test('imports a Goodreads export that omits Average Rating', () => {
  // Goodreads dropped that column; the importer reads by name, so it must not
  // depend on the full historical header set.
  const headers = GOODREADS_HEADERS.filter((h) => h !== 'Average Rating');
  const csv = headers.join(',') + '\r\n' +
    headers.map((h) => (h === 'Title' ? 'Solo' : h === 'My Rating' ? '4.0' : '')).join(',') + '\r\n';
  const { format, books } = importCSV(csv);
  eq(format, 'goodreads');
  eq(books[0].title, 'Solo');
  eq(books[0].rating, 4, 'a "4.0" rating must parse');
});

test('exports the exact Goodreads header row', () => {
  const csv = exportCSV([makeBook({ title: 'X' })], 'goodreads');
  eq(parseCSV(csv).headers, GOODREADS_HEADERS);
});

// ---------------------------------------------------------------------------
// StoryGraph adapter
// ---------------------------------------------------------------------------

const STORYGRAPH_SAMPLE = [
  STORYGRAPH_HEADERS.join(','),
  [
    '"Piranesi"', '"Susanna Clarke"', '""', '9781635575637', '"Hardcover"',
    'read', '2024/01/02', '2024/04/09', '"2024/04/01-2024/04/09"', '1',
    '"mysterious, reflective"', 'Medium', '', '', '', '', '',
    '4.75', '"Strange and lovely."', '""', '""', '"book club"', 'Yes',
  ].join(','),
].join('\r\n') + '\r\n';

test('imports a StoryGraph row end to end', () => {
  const { format, books } = importCSV(STORYGRAPH_SAMPLE);
  eq(format, 'storygraph');

  const b = books[0];
  eq(b.title, 'Piranesi');
  eq(b.author, 'Susanna Clarke');
  eq(b.isbn13, '9781635575637');
  eq(b.rating, 4.75, 'quarter star lost');
  eq(b.status, STATUS.READ);
  eq(b.dateStarted, '2024-04-01');
  eq(b.dateRead, '2024-04-09');
  eq(b.moods, ['mysterious', 'reflective']);
  eq(b.pace, 'Medium');
  eq(b.tags, ['book club']);
  eq(b.owned, true);
});

test('StoryGraph round-trips including moods, pace and quarter stars', () => {
  const original = importCSV(STORYGRAPH_SAMPLE).books[0];
  const back = storygraphRowToBook(bookToStorygraphRow(original));

  for (const field of ['title', 'author', 'isbn13', 'rating', 'status',
    'dateStarted', 'dateRead', 'pace', 'review', 'owned', 'readCount']) {
    eq(back[field], original[field], field);
  }
  eq(back.moods, original.moods, 'moods');
  eq(back.tags, original.tags, 'tags');
});

test('did-not-finish survives StoryGraph natively', () => {
  const dnf = makeBook({ title: 'Unfinished', status: STATUS.DNF });
  const row = bookToStorygraphRow(dnf);
  eq(row['Read Status'], 'did-not-finish');
  eq(storygraphRowToBook(row).status, STATUS.DNF);
});

test('exports the exact StoryGraph header row', () => {
  const csv = exportCSV([makeBook({ title: 'X' })], 'storygraph');
  eq(parseCSV(csv).headers, STORYGRAPH_HEADERS);
});

// ---------------------------------------------------------------------------
// Cross-service behaviour
// ---------------------------------------------------------------------------

test('a Goodreads book exported for StoryGraph keeps its dates', () => {
  const gr = importCSV(GOODREADS_SAMPLE).books[0];
  const viaSg = importCSV(exportCSV([gr], 'storygraph')).books[0];
  eq(viaSg.title, gr.title);
  eq(viaSg.dateRead, gr.dateRead);
  eq(viaSg.rating, gr.rating);
  eq(viaSg.status, gr.status);
});

test('matches the same book across services by ISBN13', () => {
  const a = makeBook({ title: 'Dune (Dune, #1)', author: 'Frank Herbert', isbn13: '9780441013593' });
  const b = makeBook({ title: 'Dune', author: 'Frank Herbert', isbn13: '9780441013593' });
  eq(matchKey(a), matchKey(b));
});

test('matches on title and author when no ISBN is present', () => {
  const a = makeBook({ title: 'Dune (Dune, #1)', author: 'Frank Herbert' });
  const b = makeBook({ title: 'Dune', author: 'Frank Herbert' });
  eq(matchKey(a), matchKey(b), 'series parenthetical broke the match');
});

test('does not match two different books', () => {
  const a = makeBook({ title: 'Dune', author: 'Frank Herbert' });
  const b = makeBook({ title: 'Piranesi', author: 'Susanna Clarke' });
  ok(matchKey(a) !== matchKey(b));
});

test('merges field by field across the two services', () => {
  // StoryGraph knows the mood and the precise rating; Goodreads knows the
  // page count and the private note. The merged record should hold both.
  const fromSg = importCSV(STORYGRAPH_SAMPLE).books;
  const fromGr = [makeBook({
    title: 'Piranesi',
    author: 'Susanna Clarke',
    isbn13: '9781635575637',
    pages: 245,
    privateNotes: 'Lent to Sam.',
    rating: 5,
  })];

  const { books, added, updated } = mergeBooks(fromSg, fromGr);
  eq(books.length, 1, 'should have merged, not duplicated');
  eq(added, 0);
  eq(updated, 1);

  const b = books[0];
  eq(b.pages, 245, 'page count from Goodreads');
  eq(b.privateNotes, 'Lent to Sam.', 'note from Goodreads');
  eq(b.rating, 4.75, 'existing quarter star must not be overwritten');
  eq(b.moods, ['mysterious', 'reflective'], 'moods from StoryGraph');
});

test('merging adds genuinely new books', () => {
  const { books, added } = mergeBooks(
    importCSV(GOODREADS_SAMPLE).books,
    importCSV(STORYGRAPH_SAMPLE).books,
  );
  eq(added, 1);
  eq(books.length, 2);
});

test('a newer finish date wins and brings its status', () => {
  const older = [makeBook({ title: 'X', author: 'Y', status: STATUS.READ, dateRead: '2023-01-01' })];
  const newer = [makeBook({ title: 'X', author: 'Y', status: STATUS.READ, dateRead: '2025-06-01' })];
  const { books } = mergeBooks(older, newer);
  eq(books[0].dateRead, '2025-06-01');
});

test('re-importing the same file changes nothing', () => {
  const first = importCSV(GOODREADS_SAMPLE).books;
  const { books, added, updated } = mergeBooks(first, importCSV(GOODREADS_SAMPLE).books);
  eq(added, 0);
  eq(updated, 0, 'a no-op import reported an update');
  eq(books.length, 1);
});

test('a full library survives export and re-import unchanged', () => {
  const library = [
    ...importCSV(GOODREADS_SAMPLE).books,
    ...importCSV(STORYGRAPH_SAMPLE).books,
  ];
  const reimported = importCSV(exportCSV(library, 'storygraph')).books;
  eq(reimported.length, library.length);
  eq(
    reimported.map((b) => b.title).sort(),
    library.map((b) => b.title).sort(),
  );
  eq(reimported.map((b) => b.rating).sort(), library.map((b) => b.rating).sort());
});

test('skips rows with no title rather than inventing books', () => {
  const csv = GOODREADS_SAMPLE + ',,,,,,,,,,,,,,,,,,,,,,,\r\n';
  const { books, skipped } = importCSV(csv);
  eq(books.length, 1);
  eq(skipped, 1);
});

// ---------------------------------------------------------------------------
// Private notes never reach the published file
// ---------------------------------------------------------------------------

test('serializeLibrary blanks private notes', () => {
  const json = JSON.parse(serializeLibrary([
    makeBook({ title: 'A', privateNotes: 'lent to Sam' }),
    makeBook({ title: 'B' }),
  ]));
  eq(json.books.map((b) => b.privateNotes), ['', '']);
});

test('the serialized library contains no trace of the note text', () => {
  const text = serializeLibrary([makeBook({ title: 'A', privateNotes: 'SECRET-TOKEN' })]);
  ok(!text.includes('SECRET-TOKEN'), 'note text leaked into books.json');
});

test('serializeLibrary does not mutate the in-memory books', () => {
  // The shelf and the Goodreads export still need the notes after a save.
  const books = [makeBook({ title: 'A', privateNotes: 'keep me' })];
  serializeLibrary(books);
  eq(books[0].privateNotes, 'keep me');
});

test('collectNotes keys only the non-empty notes by id', () => {
  const a = makeBook({ title: 'A', privateNotes: 'one' });
  const b = makeBook({ title: 'B', privateNotes: '   ' });
  const c = makeBook({ title: 'C' });
  eq(collectNotes([a, b, c]), { [a.id]: 'one' });
});

test('attachNotes restores notes onto the right books', () => {
  const a = makeBook({ title: 'A' });
  const b = makeBook({ title: 'B' });
  attachNotes([a, b], { [b.id]: 'only B' });
  eq(a.privateNotes, '');
  eq(b.privateNotes, 'only B');
});

test('a note survives a split and rejoin', () => {
  const books = [makeBook({ title: 'A', privateNotes: 'the typhoon bit' })];
  const notes = collectNotes(books);
  const published = JSON.parse(serializeLibrary(books)).books.map((b) => makeBook(b));
  eq(published[0].privateNotes, '', 'published copy must be clean');
  attachNotes(published, notes);
  eq(published[0].privateNotes, 'the typhoon bit', 'note lost on rejoin');
});

test('the Goodreads export still carries notes', () => {
  // Notes are private from StoryGraph and from the repo, not from Goodreads —
  // that export is the backup path for them.
  const csv = exportCSV([makeBook({ title: 'A', privateNotes: 'lent to Sam' })], 'goodreads');
  ok(csv.includes('lent to Sam'), 'notes must survive to Goodreads');
});

test('the StoryGraph export never carries notes', () => {
  const csv = exportCSV([makeBook({ title: 'A', privateNotes: 'lent to Sam' })], 'storygraph');
  ok(!csv.includes('lent to Sam'), 'notes leaked into the StoryGraph export');
});

// ---------------------------------------------------------------------------
// The published aggregates disclose no individual book
// ---------------------------------------------------------------------------

const LIBRARY = [
  makeBook({ title: 'Dune', author: 'Frank Herbert', isbn13: '9780441013593',
    status: STATUS.READ, rating: 5, pages: 604, dateRead: '2026-03-15',
    dateStarted: '2026-03-01', review: 'a review', privateNotes: 'a note',
    genres: ['sci-fi'] }),
  makeBook({ title: 'Piranesi', author: 'Susanna Clarke', status: STATUS.READ,
    rating: 4.75, pages: 245, dateRead: '2026-04-09', genres: ['fantasy'] }),
  makeBook({ title: 'Middlemarch', author: 'George Eliot', status: STATUS.TO_READ }),
];

test('computeStats reports the right totals', () => {
  const s = computeStats(LIBRARY);
  eq(s.totals.tracked, 3);
  eq(s.totals.read, 2);
  eq(s.totals.dated, 2);
  eq(s.totals.pages, 849);
  eq(s.monthly[2026][2], 1, 'March');
  eq(s.monthly[2026][3], 1, 'April');
});

test('the aggregates name no book', () => {
  const raw = JSON.stringify(computeStats(LIBRARY));
  for (const t of ['Dune', 'Piranesi', 'Middlemarch', '9780441013593', 'a review', 'a note']) {
    ok(!raw.includes(t), `"${t}" leaked into the published aggregates`);
  }
});

test('the aggregates carry no per-book records', () => {
  eq(auditStats(computeStats(LIBRARY)), []);
});

test('auditStats catches a list of book records', () => {
  const bad = { totals: {}, books: [{ title: 'Dune' }] };
  ok(auditStats(bad).length, 'a records array should have been rejected');
});

test('auditStats catches a stray title', () => {
  ok(auditStats({ totals: { title: 'Dune' } }).length, 'a title should have been rejected');
});

test('authors survive as counts only', () => {
  const s = computeStats(LIBRARY);
  eq(s.authors.all.map((a) => a.name).sort(), ['Frank Herbert', 'Susanna Clarke']);
  eq(s.authors.all.every((a) => Object.keys(a).length === 2), true, 'author entries carry only name and count');
});

test('the longest book is a page count, not a title', () => {
  const s = computeStats(LIBRARY);
  eq(s.totals.longestPages, 604);
  ok(!JSON.stringify(s).includes('Dune'), 'the longest book was named');
});

test('unread books are excluded from the reading stats', () => {
  const s = computeStats(LIBRARY);
  eq(s.perYear[2026].books, 2, 'the to-read book must not count as finished');
});

test('no book is named anywhere in the aggregates', () => {
  const stats = computeStats([
    makeBook({ title: 'Shoe Dog', author: 'Phil Knight', status: STATUS.READ,
      dateRead: '2026-01-05', genres: ['Memoir'] }),
    makeBook({ title: 'A Secret Romance', author: 'Someone', status: STATUS.READ,
      dateRead: '2026-02-05', genres: ['Romance'] }),
    makeBook({ title: 'An Untagged Book', author: 'Nobody', status: STATUS.READ,
      dateRead: '2026-03-05' }),
  ]);
  const raw = JSON.stringify(stats);
  for (const t of ['Shoe Dog', 'A Secret Romance', 'An Untagged Book']) {
    ok(!raw.includes(t), `"${t}" leaked into the published aggregates`);
  }
  eq(auditStats(stats), []);
});

test('the audit now has no exceptions', () => {
  // There used to be one permitted path for titles. There is none now, so a
  // title is a failure wherever it appears.
  ok(auditStats({ totals: {}, spotlight: { books: [{ title: 'Dune' }] } }).length,
    'the old carve-out path is still being allowed');
  ok(auditStats({ totals: { title: 'Dune' } }).length, 'a stray title was allowed');
  ok(auditStats({ totals: {}, books: [{ title: 'Dune' }] }).length,
    'a records array was allowed');
});

test('authors are still published, as counts', () => {
  // Removing the title list should not have removed the author chart.
  const stats = computeStats([
    makeBook({ title: 'Shoe Dog', author: 'Phil Knight', status: STATUS.READ,
      dateRead: '2026-01-05' }),
  ]);
  eq(stats.authors.all, [{ name: 'Phil Knight', count: 1 }]);
});

// ---------------------------------------------------------------------------
// The two aggregators agree
// ---------------------------------------------------------------------------

// computeStats() exists twice: here in JavaScript, for a visitor who drops a
// CSV onto the published site and has no server to ask, and in
// tools/aggregate.py, for the daily job which runs with no JavaScript
// runtime available. Two implementations of the same arithmetic drift unless
// something checks, so this compares the committed file against what this
// code computes from the same library. It runs only where both files exist,
// which means locally; on the published site books.json is absent and the
// check reports itself as skipped rather than passing quietly.
const parity = await (async () => {
  try {
    const [booksRes, pubRes] = await Promise.all([
      fetch('data/books.json', { cache: 'no-store' }),
      fetch('data/public.json', { cache: 'no-store' }),
    ]);
    if (!booksRes.ok || !pubRes.ok) return null;
    return {
      books: (await booksRes.json()).books.map((b) => makeBook(b)),
      published: await pubRes.json(),
    };
  } catch {
    return null;
  }
})();

/** Order-insensitive, date-insensitive canonical form. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k === 'generated' || k === 'updated') continue;
      out[k] = canonical(value[k]);
    }
    return out;
  }
  // Both languages print shortest round-trip floats; trim anyway so a last-bit
  // difference cannot fail the run.
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return Number(value.toFixed(9));
  }
  return value;
}

test('tools/aggregate.py agrees with computeStats', () => {
  if (!parity) {
    // Not a silent pass: say so, so nobody reads a green run as proof.
    throw new Error('SKIPPED — needs data/books.json, so run this locally');
  }
  const mine = JSON.stringify(canonical(computeStats(parity.books)));
  const theirs = JSON.stringify(canonical(parity.published));
  if (mine !== theirs) {
    throw new Error('public.json does not match computeStats — '
      + 'the two implementations have drifted; run tools/aggregate.py');
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

const summary = document.getElementById('summary');
summary.textContent = failed
  ? `${failed} failing · ${passed} passing`
  : `All ${passed} tests passing`;
summary.className = failed ? 'hero-value fail' : 'hero-value pass';

const list = document.getElementById('results');
for (const r of results) {
  const li = document.createElement('li');
  li.className = r.pass ? 'ok' : 'bad';
  li.innerHTML =
    `<span class="mark">${r.pass ? '✓' : '✕'}</span> ${escapeHTML(r.name)}` +
    (r.pass ? '' : `<div class="why">${escapeHTML(r.message)}</div>`);
  list.appendChild(li);
}

// Surface the count for a quick check from the console or an automated run.
window.__testResults = { passed, failed, results };

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
