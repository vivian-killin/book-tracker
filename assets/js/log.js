/**
 * Controller for the log form (log.html).
 *
 * Saving writes the whole library back, which keeps the merge rules in one
 * place (store.js) instead of splitting them between an add path and an edit
 * path.
 */

import { loadLibrary, saveLibrary, hasSaveApi, serializeLibrary } from './store.js';
import { makeBook, exportCSV, bookId, splitList, todayISO, STATUS } from './formats.js';
import * as theme from './theme.js';

/** Shown in the recent list; matches the labels the shelf uses. */
const STATUS_LABELS = {
  [STATUS.READ]: 'Read',
  [STATUS.READING]: 'Reading',
  [STATUS.TO_READ]: 'To read',
  [STATUS.DNF]: 'Did not finish',
};

const state = { books: [], editingId: null };
const $ = (id) => document.getElementById(id);

theme.init();
buildRatingOptions();
bindForm();
await describeSaveTarget();

const loaded = await loadLibrary();
state.books = loaded.books;
renderRecent();

// Deep link from the shelf: log.html?id=<book id>
const wanted = new URLSearchParams(location.search).get('id');
if (wanted) startEdit(wanted);

// ---------------------------------------------------------------------------

/** Rating select in the quarter-star steps StoryGraph supports. */
function buildRatingOptions() {
  const sel = $('rating');
  sel.innerHTML = '<option value="">Unrated</option>';
  for (let v = 5; v >= 0.25; v -= 0.25) {
    const value = Math.round(v * 100) / 100;
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = `${value.toFixed(2).replace(/\.?0+$/, '')} ★`;
    sel.appendChild(opt);
  }
}

async function describeSaveTarget() {
  const saveable = await hasSaveApi();
  $('saveTarget').textContent = saveable
    ? 'Saving to data/books.json — commit the change when you are done.'
    : 'No local server detected, so books save in this browser. Run python3 tools/serve.py to write to the file instead.';
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

function bindForm() {
  $('bookForm').addEventListener('submit', onSubmit);
  $('resetBtn').addEventListener('click', clearForm);
  $('deleteBtn').addEventListener('click', onDelete);

  $('exportGr').addEventListener('click', () =>
    download('goodreads-import.csv', exportCSV(state.books, 'goodreads')));
  $('exportSg').addEventListener('click', () =>
    download('storygraph-import.csv', exportCSV(state.books, 'storygraph')));

  // Finishing a book today is the common case; prefill it once the status
  // says "read" and no date has been chosen yet.
  $('status').addEventListener('change', (e) => {
    if (e.target.value === STATUS.READ && !$('dateRead').value) {
      $('dateRead').value = todayISO();
    }
  });
}

async function onSubmit(event) {
  event.preventDefault();

  const values = readForm();
  if (!values.title) return;

  if (state.editingId) {
    const idx = state.books.findIndex((b) => b.id === state.editingId);
    if (idx >= 0) {
      // Preserve fields the form does not expose (publisher, contentWarnings).
      state.books[idx] = makeBook({ ...state.books[idx], ...values });
    }
  } else {
    const book = makeBook({
      ...values,
      dateAdded: todayISO(),
      source: 'manual',
    });
    book.id = uniqueId(bookId(book));
    state.books.push(book);
  }

  let target;
  try {
    target = (await saveLibrary(state.books)).target;
  } catch (err) {
    return banner(`Save failed: ${err.message}`, 'warn');
  }

  banner(
    `“${values.title}” saved · ${state.books.length} books in the library · ` +
      (target === 'file' ? 'written to data/books.json' : 'stored in this browser'),
  );
  clearForm();
  renderRecent();
}

/** Avoid two books colliding on the same slug. */
function uniqueId(base) {
  const taken = new Set(state.books.map((b) => b.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function readForm() {
  const val = (id) => $(id).value.trim();
  const rating = $('rating').value ? Number($('rating').value) : null;
  const pages = $('pages').value ? Number($('pages').value) : null;

  return {
    title: val('title'),
    author: val('author'),
    status: $('status').value,
    rating,
    pages,
    dateStarted: val('dateStarted') || null,
    dateRead: val('dateRead') || null,
    isbn13: val('isbn13').replace(/[^0-9Xx]/g, ''),
    format: val('format'),
    binding: val('format'),
    tags: splitList(val('tags')),
    moods: splitList(val('moods')),
    pace: $('pace').value,
    review: $('review').value,
    privateNotes: $('privateNotes').value,
    owned: $('owned').checked,
  };
}

function startEdit(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;

  state.editingId = id;
  $('formTitle').textContent = `Editing “${book.title}”`;
  $('submitBtn').textContent = 'Update book';
  $('deleteBtn').hidden = false;

  $('title').value = book.title;
  $('author').value = book.author;
  $('status').value = book.status;
  $('rating').value = book.rating ? String(book.rating) : '';
  $('pages').value = book.pages ?? '';
  $('dateStarted').value = book.dateStarted || '';
  $('dateRead').value = book.dateRead || '';
  $('isbn13').value = book.isbn13 || '';
  $('format').value = book.format || '';
  $('tags').value = book.tags.join(', ');
  $('moods').value = book.moods.join(', ');
  $('pace').value = book.pace || '';
  $('review').value = book.review || '';
  $('privateNotes').value = book.privateNotes || '';
  $('owned').checked = !!book.owned;

  $('bookForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearForm() {
  state.editingId = null;
  $('bookForm').reset();
  $('formTitle').textContent = 'New book';
  $('submitBtn').textContent = 'Save book';
  $('deleteBtn').hidden = true;
}

async function onDelete() {
  const book = state.books.find((b) => b.id === state.editingId);
  if (!book) return;
  // Deleting a book is destructive and easy to mis-click from an edit form.
  if (!window.confirm(`Remove “${book.title}” from your library?`)) return;

  state.books = state.books.filter((b) => b.id !== state.editingId);
  try {
    await saveLibrary(state.books);
  } catch (err) {
    return banner(`Delete failed: ${err.message}`, 'warn');
  }
  banner(`“${book.title}” removed.`);
  clearForm();
  renderRecent();
}

// ---------------------------------------------------------------------------
// Recent list
// ---------------------------------------------------------------------------

function renderRecent() {
  const host = $('recent');
  host.textContent = '';

  const rows = state.books
    .slice()
    .sort((a, b) =>
      (b.dateRead || b.dateAdded || '').localeCompare(a.dateRead || a.dateAdded || ''))
    .slice(0, 15);

  if (!rows.length) {
    host.innerHTML = '<p class="muted" style="padding:12px 0">Nothing logged yet.</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'data';
  table.innerHTML =
    '<thead><tr><th>Title</th><th>Author</th><th>Status</th>' +
    '<th class="num">Rating</th><th class="num">Finished</th><th></th></tr></thead>';

  const tbody = document.createElement('tbody');
  for (const b of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${escapeHTML(b.title)}</td>` +
      `<td>${escapeHTML(b.author || '—')}</td>` +
      `<td>${escapeHTML(STATUS_LABELS[b.status] || b.status)}</td>` +
      `<td class="num">${b.rating ? b.rating : '—'}</td>` +
      `<td class="num">${b.dateRead || '—'}</td>`;

    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.textContent = 'Edit';
    btn.addEventListener('click', () => startEdit(b.id));
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function banner(message, kind = '') {
  const div = document.createElement('div');
  div.className = `banner ${kind}`.trim();
  div.innerHTML = `<span>${escapeHTML(message)}</span><span class="spacer"></span>`;
  const close = document.createElement('button');
  close.className = 'btn btn-small';
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => div.remove());
  div.appendChild(close);
  $('banners').prepend(div);
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { serializeLibrary };
