/**
 * Controller for the reading graph (index.html).
 */

import {
  loadLibrary, saveLibrary, clearLocal, hasSaveApi, serializeLibrary,
  finished, readBooks, undatedCount, yearsWithReading, booksPerMonth, cumulativeByMonth,
  ratingHistogram, topAuthors, yearSummary, monthYearGrid, computeStats,
  syncPublicIfStale,
} from './store.js';
import { columnChart, lineChart, barChart, heatmap, heatmapLegend, smallMultiples, MONTHS } from './charts.js';
import { importCSV, exportCSV, mergeBooks, STATUS } from './formats.js';

const STATUS_LABELS = {
  [STATUS.READ]: 'Read',
  [STATUS.READING]: 'Reading',
  [STATUS.TO_READ]: 'To read',
  [STATUS.DNF]: 'Did not finish',
};

/** Subtitles for the three banded distributions. */
const BAND_SUBS = {
  length: (n) => `Page counts across ${n} books.`,
  age: (n) => `Years between publication and you finishing it, across ${n} books.`,
};

const state = {
  books: [],
  // Aggregates. Locally these are computed from `books`; on a published copy
  // there are no books at all and these come straight from data/public.json.
  stats: null,
  // True when only aggregates are available, so the shelf and the CSV tools
  // have nothing to work with and are hidden.
  aggregateOnly: false,
  isLocal: false,
  year: 'all',
  shelfQuery: '',
  shelfStatus: 'all',
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initTheme();
bindChrome();

const loaded = await loadLibrary();
state.books = loaded.books;
state.isLocal = loaded.isLocal;
refreshStats(loaded.stats);
const years = state.stats ? state.stats.years : [];
state.year = years.length ? years[0] : 'all';
render();

// The genre backfill edits books.json from outside the browser, so bring the
// published summary back in step whenever the site is opened locally.
try {
  if (await syncPublicIfStale(state.books)) {
    showBanner('data/public.json was out of date and has been regenerated — commit it to publish.');
  }
} catch (err) {
  showBanner(`Could not refresh data/public.json: ${err.message}`, 'warn');
}

/**
 * Recompute the aggregates from the library, or adopt published ones when
 * there is no library to compute from.
 * @param {Object} [published]
 */
function refreshStats(published) {
  if (state.books.length) {
    state.stats = computeStats(state.books);
    state.aggregateOnly = false;
  } else if (published) {
    state.stats = published;
    state.aggregateOnly = true;
  } else {
    state.stats = null;
    state.aggregateOnly = false;
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem('book-tracker:theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current =
      root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('book-tracker:theme', next);
    // Charts read colors from CSS custom properties at draw time, so a theme
    // flip needs a redraw to pick up the new steps.
    render();
  });
}

// ---------------------------------------------------------------------------
// Chrome: import, export, table toggles, shelf controls
// ---------------------------------------------------------------------------

function bindChrome() {
  const fileInput = $('fileInput');
  const pick = () => fileInput.click();

  $('importBtn').addEventListener('click', pick);
  $('emptyImportBtn').addEventListener('click', pick);
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  const zone = $('dropzone');
  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    }));
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    }));
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  // Sample data goes to localStorage only — never to data/books.json, so a
  // curious click can't scribble demo books into a real library.
  $('sampleBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('data/books.sample.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      localStorage.setItem('book-tracker:library', JSON.stringify(json));
      const fresh = await loadLibrary();
      state.books = fresh.books;
      state.isLocal = true;
      refreshStats(fresh.stats);
      const years = state.stats ? state.stats.years : [];
      state.year = years.length ? years[0] : 'all';
      render();
      showBanner('Loaded the sample library. Reset to clear it.');
    } catch (err) {
      showBanner(`Could not load the sample data: ${err.message}`, 'warn');
    }
  });

  $('exportGr').addEventListener('click', () =>
    download('goodreads-import.csv', exportCSV(state.books, 'goodreads'), 'text/csv'));
  $('exportSg').addEventListener('click', () =>
    download('storygraph-import.csv', exportCSV(state.books, 'storygraph'), 'text/csv'));
  $('exportJson').addEventListener('click', () =>
    download('books.json', serializeLibrary(state.books), 'application/json'));

  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle;
      const table = $(`${key}Table`);
      const chart = $(`${key}Chart`);
      const showTable = table.hidden;
      table.hidden = !showTable;
      chart.hidden = showTable;
      const legend = $(`${key}Legend`);
      if (legend) legend.hidden = showTable;
      btn.textContent = showTable ? 'Chart' : 'Table';
      btn.setAttribute('aria-pressed', String(showTable));
    });
  });

  $('shelfSearch').addEventListener('input', (e) => {
    state.shelfQuery = e.target.value.trim().toLowerCase();
    renderShelf();
  });
}

/**
 * Parse a dropped or chosen CSV and merge it into the library.
 * Reports what actually changed rather than claiming a blanket success.
 */
async function handleFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (err) {
    return showBanner(`Could not read ${file.name}: ${err.message}`, 'warn');
  }

  let result;
  try {
    result = importCSV(text);
  } catch (err) {
    return showBanner(err.message, 'warn');
  }

  const merged = mergeBooks(state.books, result.books);
  state.books = merged.books;

  refreshStats();
  const years = state.stats ? state.stats.years : [];
  if (state.year === 'all' && years.length) state.year = years[0];

  let where;
  try {
    where = (await saveLibrary(state.books)).target;
  } catch (err) {
    return showBanner(`Imported, but saving failed: ${err.message}`, 'warn');
  }
  state.isLocal = where === 'browser';

  const bits = [
    `Imported ${result.books.length} rows from your ${label(result.format)} export`,
    `${merged.added} new`,
    `${merged.updated} updated`,
  ];
  if (result.skipped) bits.push(`${result.skipped} skipped (no title)`);
  bits.push(where === 'file'
    ? 'written to data/books.json'
    : 'saved in this browser');

  showBanner(bits.join(' · '));
  render();
}

function label(format) {
  return format === 'goodreads' ? 'Goodreads' : 'StoryGraph';
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

function showBanner(message, kind = '') {
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

async function renderPersistenceBanner() {
  const host = $('banners');
  host.querySelectorAll('[data-persistent]').forEach((n) => n.remove());
  if (!state.isLocal) return;

  const div = document.createElement('div');
  div.dataset.persistent = 'true';
  div.className = 'banner';
  const saveable = await hasSaveApi();
  div.innerHTML =
    `<span>Showing a library saved in this browser${saveable ? '' : ' only'}. ` +
    `Download <strong>books.json</strong> to keep it, or reset to the published library.</span>` +
    `<span class="spacer"></span>`;
  const reset = document.createElement('button');
  reset.className = 'btn btn-small';
  reset.type = 'button';
  reset.textContent = 'Reset';
  reset.addEventListener('click', async () => {
    clearLocal();
    const fresh = await loadLibrary();
    state.books = fresh.books;
    state.isLocal = fresh.isLocal;
    refreshStats(fresh.stats);
    render();
  });
  div.appendChild(reset);
  host.appendChild(div);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const hasStats = !!state.stats;
  $('dashboard').hidden = !hasStats;
  $('filterRow').hidden = !hasStats;
  $('emptyState').hidden = hasStats;

  renderPersistenceBanner();
  renderModeChrome();

  if (!hasStats) {
    $('siteSub').textContent = 'Import a Goodreads or StoryGraph export to begin.';
    return;
  }

  const t = state.stats.totals;
  $('siteSub').textContent =
    `${t.tracked} books tracked · ${t.read} read` +
    (t.read > t.dated ? ` · ${t.dated} with a finish date` : '');

  resetToggles();
  renderYearButtons();
  renderHero();
  renderTiles();
  renderMonthCard();
  renderPaceCard();
  renderRatingCard();
  renderHeatCard();
  renderAuthorCard();
  renderGenreCard();
  renderTrendCard();
  renderShapeTiles();
  renderBandCard('length', 'Book length', 'books');
  renderBandCard('age', 'How old a book was when you read it', 'books');
  renderGenreRatingCard();

  // The shelf lists individual books, so it exists only where the individual
  // books do — never on a published copy.
  $('shelfCard').hidden = state.aggregateOnly;
  if (!state.aggregateOnly) {
    renderShelfControls();
    renderShelf();
  }
}

/**
 * Show or hide the controls that need a real library behind them.
 * A published copy has aggregates only, so importing, exporting and the
 * shelf have nothing to act on.
 */
function renderModeChrome() {
  const libraryOnly = ['importBtn', 'exportGr', 'exportSg', 'exportJson'];
  libraryOnly.forEach((id) => { $(id).hidden = state.aggregateOnly; });
  $('privacyNote').hidden = !state.aggregateOnly;
}

/**
 * Put every card back into chart view before a re-render. Without this, a card
 * left in table view keeps its chart hidden and can end up showing nothing
 * when the new data changes which half is populated.
 */
function resetToggles() {
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    const key = btn.dataset.toggle;
    $(`${key}Table`).hidden = true;
    $(`${key}Chart`).hidden = false;
    const legend = $(`${key}Legend`);
    if (legend) legend.hidden = false;
    btn.textContent = 'Table';
    btn.setAttribute('aria-pressed', 'false');
  });
}

function renderYearButtons() {
  const host = $('yearButtons');
  host.textContent = '';
  for (const opt of ['all', ...state.stats.years]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.textContent = opt === 'all' ? 'All time' : String(opt);
    btn.setAttribute('aria-pressed', String(String(state.year) === String(opt)));
    btn.addEventListener('click', () => {
      state.year = opt === 'all' ? 'all' : Number(opt);
      render();
    });
    host.appendChild(btn);
  }
}

/** Aggregates for the selected year, or the all-time totals. */
function scope() {
  return state.year === 'all'
    ? state.stats.totals
    : (state.stats.perYear[state.year] || {});
}

function renderHero() {
  const delta = $('heroDelta');
  const t = state.stats.totals;

  if (state.year === 'all') {
    // Count every book marked read, not just the dated ones. Showing only
    // what the charts can plot would understate a long Goodreads history by
    // hundreds of books and quietly look like data loss.
    $('heroValue').textContent = String(t.read);
    $('heroLabel').textContent = 'books read, all time';
    delta.textContent = t.undated
      ? `${t.undated} have no finish date on Goodreads, so they are counted here but not on the charts below.`
      : '';
    return;
  }

  const count = scope().books || 0;
  $('heroValue').textContent = String(count);
  $('heroLabel').textContent = `books finished in ${state.year}`;

  const prevYear = state.stats.perYear[state.year - 1];
  if (!prevYear) {
    delta.textContent = '';
    return;
  }

  // Compare like with like. Eight months of this year against twelve of last
  // year reports a collapse that is really just a year still in progress, so
  // for the current year the previous one is truncated to the same months.
  const now = new Date();
  const partial = state.year === now.getFullYear();
  const prevMonthly = state.stats.monthly[state.year - 1] || [];
  const prev = partial
    ? prevMonthly.slice(0, now.getMonth() + 1).reduce((a, b) => a + b, 0)
    : prevYear.books;

  const period = partial ? `${state.year - 1} by this month` : String(state.year - 1);
  const tail = partial ? `, a year that ended on ${prevYear.books}` : '';
  const diff = count - prev;

  if (diff === 0) {
    delta.textContent = `Level with ${period} (${prev})${tail}.`;
    return;
  }
  const dir = diff > 0 ? 'up' : 'down';
  const sign = diff > 0 ? '+' : '';
  delta.innerHTML =
    `<span class="${dir}">${sign}${diff}</span> vs ${escapeHTML(period)} (${prev})${escapeHTML(tail)}`;
}

function renderTiles() {
  const host = $('tiles');
  host.textContent = '';

  const s = scope();
  const inYear = state.year !== 'all';
  const pages = s.pages || 0;
  const counted = s.pagesCounted || 0;

  const tiles = [
    {
      label: 'Pages',
      value: pages ? compact(pages) : '—',
      note: pages ? `across ${counted} books with page counts` : 'no page counts',
    },
    {
      label: 'Average rating',
      value: s.avgRating ? s.avgRating.toFixed(2) : '—',
      note: s.rated ? `${s.rated} rated` : 'nothing rated yet',
    },
    { label: 'Distinct authors', value: String(s.authors ?? 0), note: '' },
    {
      label: 'Typical read',
      value: inYear && s.medianDays != null ? `${s.medianDays}d` : '—',
      note: inYear && s.medianDays != null
        ? 'median days, start to finish'
        : 'needs start dates',
    },
    {
      label: 'Longest book',
      value: s.longestPages ? compact(s.longestPages) : '—',
      note: s.longestPages ? 'pages' : '',
    },
  ];

  for (const t of tiles) {
    const div = document.createElement('div');
    div.className = 'tile';
    div.innerHTML =
      `<div class="tile-label">${escapeHTML(t.label)}</div>` +
      `<div class="tile-value">${escapeHTML(t.value)}</div>` +
      (t.note ? `<div class="tile-note">${escapeHTML(t.note)}</div>` : '');
    host.appendChild(div);
  }
}

function renderMonthCard() {
  if (state.year === 'all') {
    const years = state.stats.years.slice().sort((a, b) => a - b);
    const values = years.map((y) => state.stats.perYear[y].books);
    $('monthTitle').textContent = 'Books finished per year';
    $('monthSub').textContent = `${years.length} years of reading.`;
    columnChart($('monthChart'), {
      labels: years.map(String), values, unit: 'books',
      ariaLabel: 'Books finished per year',
    });
    renderTable($('monthTable'), ['Year', 'Books'],
      years.map((y, i) => [String(y), values[i]]));
    return;
  }

  const values = state.stats.monthly[state.year] || new Array(12).fill(0);
  $('monthTitle').textContent = 'Books finished per month';
  $('monthSub').textContent = `${values.reduce((a, b) => a + b, 0)} in ${state.year}.`;
  columnChart($('monthChart'), {
    labels: MONTHS, values, unit: 'books',
    ariaLabel: `Books finished per month in ${state.year}`,
  });
  renderTable($('monthTable'), ['Month', 'Books'],
    MONTHS.map((m, i) => [m, values[i]]));
}

/** Running total across a year's monthly counts. */
function cumulative(monthly) {
  let total = 0;
  return monthly.map((n) => (total += n));
}

function renderPaceCard() {
  const card = $('paceCard');
  if (state.year === 'all') {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  // The current year has months that have not happened yet. Blanking them
  // stops the line short instead of running it flat to December, which would
  // read as several months of reading nothing.
  const now = new Date();
  const lastMonth = state.year === now.getFullYear() ? now.getMonth() : 11;
  const thisYear = cumulative(state.stats.monthly[state.year] || new Array(12).fill(0))
    .map((v, i) => (i <= lastMonth ? v : null));

  const prevMonthly = state.stats.monthly[state.year - 1];
  const series = [{ name: String(state.year), values: thisYear }];
  if (prevMonthly) {
    series.push({ name: String(state.year - 1), values: cumulative(prevMonthly) });
  }

  $('paceSub').textContent = prevMonthly
    ? `Running total of books finished, ${state.year} against ${state.year - 1}.`
    : `Running total of books finished in ${state.year}.`;

  lineChart($('paceChart'), {
    labels: MONTHS, series,
    ariaLabel: `Cumulative books finished in ${state.year}`,
  });

  // A legend is always present for two or more series.
  const legend = $('paceLegend');
  legend.textContent = '';
  if (series.length >= 2) {
    series.forEach((s, i) => {
      const item = document.createElement('span');
      item.className = 'legend-item';
      item.innerHTML =
        `<span class="legend-key" style="background:var(--series-${i + 1})"></span>` +
        escapeHTML(s.name);
      legend.appendChild(item);
    });
  }

  renderTable($('paceTable'),
    ['Month', ...series.map((s) => s.name)],
    MONTHS.map((m, i) => [m, ...series.map((s) => s.values[i] ?? '—')]));
}

function renderRatingCard() {
  const counts = (state.year === 'all'
    ? state.stats.ratings.all
    : state.stats.ratings[state.year]) || new Array(5).fill(0);
  const rated = counts.reduce((a, b) => a + b, 0);

  $('ratingSub').textContent = rated
    ? `${rated} rated ${rated === 1 ? 'book' : 'books'}${state.year === 'all' ? '' : ` in ${state.year}`}. Quarter stars are rounded here.`
    : 'No ratings yet.';

  columnChart($('ratingChart'), {
    labels: ['1★', '2★', '3★', '4★', '5★'], values: counts, unit: 'books',
    ariaLabel: 'Distribution of star ratings',
  });
  renderTable($('ratingTable'), ['Rating', 'Books'],
    counts.map((c, i) => [`${i + 1} star${i ? 's' : ''}`, c]));
}

function renderHeatCard() {
  const { years, grid, max } = state.stats.heat;
  const card = $('heatCard');
  if (!years.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  heatmap($('heatChart'), {
    years, grid, max,
    ariaLabel: 'Books finished per month across every year',
  });
  heatmapLegend($('heatLegend'), max);
  renderTable($('heatTable'), ['Year', ...MONTHS, 'Total'],
    years.map((y, r) => [String(y), ...grid[r], grid[r].reduce((a, b) => a + b, 0)]));
}

/** Shared renderer for the two ranked-name cards, which behave identically. */
function renderRankedCard(key, items, { emptyText, repeatText, ariaLabel, unit }) {
  const card = $(`${key}Card`);
  if (!items || !items.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  // A chart of identical one-book bars carries no information. When nothing
  // repeats, say so in a sentence and skip the chart entirely.
  const repeats = items.filter((i) => i.count > 1).length;
  const toggle = card.querySelector('[data-toggle]');

  if (!repeats) {
    $(`${key}Sub`).textContent = emptyText;
    $(`${key}Chart`).textContent = '';
    $(`${key}Table`).hidden = true;
    toggle.hidden = true;
    return;
  }

  toggle.hidden = false;
  $(`${key}Sub`).textContent = repeatText(repeats);
  barChart($(`${key}Chart`), {
    items: items.map((i) => ({ label: i.name, value: i.count })),
    unit, ariaLabel,
  });
  renderTable($(`${key}Table`), [key === 'author' ? 'Author' : 'Genre', 'Books'],
    items.map((i) => [i.name, i.count]));
}

function renderAuthorCard() {
  const items = (state.year === 'all'
    ? state.stats.authors.all
    : state.stats.authors[state.year]) || [];
  const suffix = state.year === 'all' ? '' : ` in ${state.year}`;
  renderRankedCard('author', items, {
    unit: 'books',
    ariaLabel: 'Most-read authors',
    emptyText: `Every author read${suffix} appears exactly once — nothing to rank yet.`,
    repeatText: (n) => `${n} ${n === 1 ? 'author' : 'authors'} read more than once${suffix}.`,
  });
}

function renderGenreCard() {
  const items = (state.year === 'all'
    ? state.stats.genres?.all
    : state.stats.genres?.[state.year]) || [];
  const suffix = state.year === 'all' ? '' : ` in ${state.year}`;
  renderRankedCard('genre', items, {
    unit: 'books',
    ariaLabel: 'Most-read genres',
    emptyText: `Every genre${suffix} appears once — nothing to rank yet.`,
    repeatText: (n) => `${n} ${n === 1 ? 'genre' : 'genres'} with more than one book${suffix}.`,
  });
}

/** Genre counts over the years, one panel per genre. */
function renderTrendCard() {
  const t = state.stats.genreTrend;
  const card = $('trendCard');
  // Needs at least two years and something tagged, or there is no trend.
  if (!t || !t.series.length || t.years.length < 2
      || !t.series.some((s) => s.values.some((v) => v > 0))) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const cov = state.stats.genreCoverage;
  $('trendSub').textContent =
    `Each panel shares the same scale, so heights compare across genres. ` +
    `Based on the ${cov.tagged} books that carry a genre.`;

  smallMultiples($('trendChart'), {
    labels: t.years.map(String),
    series: t.series,
    ariaLabel: 'Books per genre per year',
  });

  renderTable($('trendTable'), ['Genre', ...t.years.map(String), 'Total'],
    t.series.map((s) => [s.name, ...s.values, s.values.reduce((a, b) => a + b, 0)]));
}

/** Headline facts about the books themselves rather than the reading. */
function renderShapeTiles() {
  const host = $('shapeTiles');
  host.textContent = '';
  const st = state.stats;

  const lengths = st.lengths || [];
  const commonLength = lengths.slice().sort((a, b) => b.count - a.count)[0];
  const ages = st.ages || [];
  const sameYear = ages.find((a) => a.name === 'Same year');
  const agedTotal = ages.reduce((n, a) => n + a.count, 0);
  const cov = st.genreCoverage || { tagged: 0, total: 0 };

  const tiles = [
    {
      label: 'Most common length',
      value: commonLength ? commonLength.name : '—',
      note: commonLength ? `${commonLength.count} books` : '',
    },
    {
      label: 'Read the year it came out',
      value: agedTotal && sameYear ? `${Math.round((sameYear.count / agedTotal) * 100)}%` : '—',
      note: sameYear ? `${sameYear.count} books` : '',
    },
    {
      label: 'Rereads',
      value: String(st.rereads ?? 0),
      note: 'books read more than once',
    },
    {
      label: 'Genre coverage',
      value: cov.total ? `${Math.round((cov.tagged / cov.total) * 100)}%` : '—',
      note: `${cov.tagged} of ${cov.total} tagged`,
    },
  ];

  for (const t of tiles) {
    const div = document.createElement('div');
    div.className = 'tile';
    div.innerHTML =
      `<div class="tile-label">${escapeHTML(t.label)}</div>` +
      `<div class="tile-value">${escapeHTML(t.value)}</div>` +
      (t.note ? `<div class="tile-note">${escapeHTML(t.note)}</div>` : '');
    host.appendChild(div);
  }
}

/** One renderer for the format / length / age distributions. */
function renderBandCard(key, _title, unit) {
  const items = state.stats[key === 'length' ? 'lengths' : 'ages'] || [];
  const card = $(`${key}Card`);
  const total = items.reduce((n, i) => n + i.count, 0);

  if (!total) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $(`${key}Sub`).textContent = BAND_SUBS[key](total);

  // Length and age are ordered scales, so they keep their own order — sorting
  // them by size would make the axis meaningless.
  columnChart($(`${key}Chart`), {
    labels: items.map((i) => i.name),
    values: items.map((i) => i.count),
    unit, ariaLabel: _title,
  });

  renderTable($(`${key}Table`), ['Band', 'Books'], items.map((i) => [i.name, i.count]));
}

/** Average rating per genre, for genres with enough ratings to mean anything. */
function renderGenreRatingCard() {
  const items = state.stats.ratingByGenre || [];
  const card = $('genreRatingCard');
  if (items.length < 2) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  $('genreRatingSub').textContent =
    'Average star rating, for genres with at least three rated books. ' +
    'Fewer than that is noise dressed up as a finding.';

  barChart($('genreRatingChart'), {
    items: items.map((g) => ({ label: `${g.name} (${g.count})`, value: g.avg })),
    unit: 'stars', ariaLabel: 'Average rating by genre',
  });

  renderTable($('genreRatingTable'), ['Genre', 'Rated books', 'Average'],
    items.map((g) => [g.name, g.count, g.avg.toFixed(2)]));
}

function renderShelfControls() {
  const host = $('statusFilters');
  host.textContent = '';
  const counts = new Map();
  state.books.forEach((b) => counts.set(b.status, (counts.get(b.status) || 0) + 1));

  const options = [['all', `All (${state.books.length})`]];
  for (const [key, name] of Object.entries(STATUS_LABELS)) {
    if (counts.get(key)) options.push([key, `${name} (${counts.get(key)})`]);
  }

  for (const [key, text] of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.textContent = text;
    btn.setAttribute('aria-pressed', String(state.shelfStatus === key));
    btn.addEventListener('click', () => {
      state.shelfStatus = key;
      renderShelfControls();
      renderShelf();
    });
    host.appendChild(btn);
  }
}

function renderShelf() {
  const q = state.shelfQuery;
  const rows = state.books
    .filter((b) => state.shelfStatus === 'all' || b.status === state.shelfStatus)
    .filter((b) => {
      if (!q) return true;
      return [b.title, b.author, ...b.tags, ...b.moods, b.review, b.privateNotes]
        .join(' ')
        .toLowerCase()
        .includes(q);
    })
    .sort((a, b) => (b.dateRead || b.dateAdded || '').localeCompare(a.dateRead || a.dateAdded || ''));

  $('shelfSub').textContent = `${rows.length} of ${state.books.length} books. This card is local only — it is never published.`;

  const host = $('shelfTable');
  host.textContent = '';

  if (!rows.length) {
    host.innerHTML = '<p class="muted" style="padding:14px 0">No matches.</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'data';
  table.innerHTML =
    '<thead><tr>' +
    '<th>Title</th><th>Author</th><th>Status</th>' +
    '<th class="num">Rating</th><th class="num">Finished</th>' +
    '<th class="num">Pages</th><th>Notes</th>' +
    '</tr></thead>';

  const tbody = document.createElement('tbody');
  for (const b of rows) {
    const tr = document.createElement('tr');
    const notes = [b.review, b.privateNotes].filter(Boolean).join(' — ');
    tr.innerHTML =
      `<td>${escapeHTML(b.title)}${b.tags.length ? ` <span class="pill">${escapeHTML(b.tags[0])}</span>` : ''}</td>` +
      `<td>${escapeHTML(b.author || '—')}</td>` +
      `<td>${escapeHTML(STATUS_LABELS[b.status] || b.status)}</td>` +
      `<td class="num">${b.rating ? b.rating.toFixed(2).replace(/\.00$/, '') : '—'}</td>` +
      `<td class="num">${b.dateRead || '—'}</td>` +
      `<td class="num">${b.pages ?? '—'}</td>` +
      `<td class="notes">${escapeHTML(truncate(notes, 90)) || ''}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTable(host, headers, rows) {
  host.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'data';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  headers.forEach((h, i) => {
    const th = document.createElement('th');
    if (i > 0) th.className = 'num';
    th.textContent = h;
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.forEach((cell, i) => {
      const td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.textContent = String(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

function compact(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
