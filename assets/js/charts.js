/**
 * SVG chart renderers.
 *
 * Hand-rolled rather than pulled from a library: the whole site is meant to run
 * with no build step and no dependencies, so a fork works by opening it.
 *
 * Shared conventions, applied by every renderer here:
 *   - bars cap at 24px with a 4px rounded data-end, square at the baseline
 *   - lines are 2px; end markers are >=8px with a 2px surface ring
 *   - gridlines and axes are solid 1px hairlines, one step off the surface
 *   - touching marks are separated by a 2px surface gap, never a stroke
 *   - labels are selective (the extreme, the endpoint) and wear text tokens
 *   - every chart has a hover tooltip AND a table-view twin, so no value is
 *     reachable only by pointing at it
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let tooltipEl = null;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function svgRoot(container, width, height) {
  container.textContent = '';
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    class: 'chart-svg',
  }, container);
  return svg;
}

/** Lazily create the single shared tooltip element. */
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chart-tooltip';
    tooltipEl.setAttribute('role', 'status');
    tooltipEl.hidden = true;
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTip(evt, html) {
  const tip = tooltip();
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 12;
  const rect = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTip() {
  if (tooltipEl) tooltipEl.hidden = true;
}

/**
 * Attach hover + keyboard focus to a mark, so pointer and keyboard users
 * reach the same value.
 */
function bindTip(node, html) {
  node.addEventListener('mousemove', (e) => showTip(e, html));
  node.addEventListener('mouseleave', hideTip);
  node.setAttribute('tabindex', '0');
  node.addEventListener('focus', (e) => {
    const box = e.target.getBoundingClientRect();
    showTip({ clientX: box.left + box.width / 2, clientY: box.top }, html);
  });
  node.addEventListener('blur', hideTip);
}

/** Path for a bar with a rounded data-end and a square baseline. */
function barPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return [
    `M${x},${y + h}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h}`,
    'Z',
  ].join(' ');
}

/**
 * Pick a clean integer axis scale.
 *
 * Every value these charts plot is a count of books, so the step is forced to
 * a whole number — dividing the max by a fixed tick count produced axes like
 * 0 / 2 / 5 / 7 / 9, which read as arbitrary.
 *
 * @param {number} maxValue
 * @param {number} [targetTicks]
 * @returns {{max: number, ticks: number[]}}
 */
function niceScale(maxValue, targetTicks = 5) {
  const m = Math.max(1, Math.ceil(maxValue));
  const raw = m / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const norm = raw / mag;
  const step = Math.max(
    1,
    Math.round((norm <= 1 ? 1 : norm <= 2.5 ? 2 : norm <= 5 ? 5 : 10) * mag),
  );
  const max = Math.ceil(m / step) * step;
  const ticks = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  return { max, ticks };
}

// ---------------------------------------------------------------------------
// Column chart — a single series of counts over an ordered axis
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {{labels: string[], values: number[], unit?: string, ariaLabel?: string}} data
 */
export function columnChart(container, { labels, values, unit = '', ariaLabel = '' }) {
  const W = 720, H = 260;
  const M = { top: 20, right: 16, bottom: 34, left: 40 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const svg = svgRoot(container, W, H);
  svg.setAttribute('aria-label', ariaLabel);

  const { max, ticks } = niceScale(Math.max(1, ...values));
  const y = (v) => M.top + plotH - (v / max) * plotH;

  // Gridlines first, so marks sit above them.
  for (const t of ticks) {
    const gy = y(t);
    el('line', {
      x1: M.left, x2: W - M.right, y1: gy, y2: gy,
      stroke: 'var(--gridline)', 'stroke-width': 1,
    }, svg);
    el('text', {
      x: M.left - 8, y: gy + 4, 'text-anchor': 'end',
      class: 'axis-text',
    }, svg).textContent = String(t);
  }

  el('line', {
    x1: M.left, x2: W - M.right, y1: y(0), y2: y(0),
    stroke: 'var(--baseline)', 'stroke-width': 1,
  }, svg);

  const band = plotW / labels.length;
  // Cap bar thickness and let the leftover band be air, per the mark spec.
  const barW = Math.min(24, band - 8);
  const peak = Math.max(...values);

  labels.forEach((label, i) => {
    const v = values[i];
    const x = M.left + i * band + (band - barW) / 2;
    const h = (v / max) * plotH;

    // An invisible full-height target keeps the hit area usable for zero and
    // near-zero bars, which are otherwise a few pixels tall.
    const hit = el('rect', {
      x: M.left + i * band, y: M.top, width: band, height: plotH,
      fill: 'transparent', class: 'hit',
    }, svg);
    bindTip(hit, `<strong>${label}</strong><br>${v} ${unit}`.trim());

    if (v > 0) {
      el('path', {
        d: barPath(x, y(v), barW, h, 4),
        fill: 'var(--series-1)',
        'pointer-events': 'none',
      }, svg);
    }

    // Direct-label only the peak; the axis carries the rest.
    if (v === peak && v > 0) {
      el('text', {
        x: x + barW / 2, y: y(v) - 8, 'text-anchor': 'middle',
        class: 'value-label',
        'pointer-events': 'none',
      }, svg).textContent = String(v);
    }

    el('text', {
      x: M.left + i * band + band / 2, y: H - 12,
      'text-anchor': 'middle', class: 'axis-text',
    }, svg).textContent = label;
  });
}

// ---------------------------------------------------------------------------
// Line chart — cumulative pace, one or two series on a single axis
// ---------------------------------------------------------------------------

/**
 * A series may hold `null` for positions that have not happened yet (the
 * remaining months of the current year). The line simply stops there — drawing
 * it flat to December would read as a stalled year rather than an unfinished
 * one.
 *
 * @param {HTMLElement} container
 * @param {{labels: string[], series: {name: string, values: (number|null)[]}[], ariaLabel?: string}} data
 */
export function lineChart(container, { labels, series, ariaLabel = '' }) {
  const W = 720, H = 280;
  const M = { top: 20, right: 56, bottom: 34, left: 40 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const svg = svgRoot(container, W, H);
  svg.setAttribute('aria-label', ariaLabel);

  const allValues = series.flatMap((s) => s.values).filter((v) => v !== null);
  const { max, ticks } = niceScale(Math.max(1, ...allValues));
  const x = (i) => M.left + (i / Math.max(1, labels.length - 1)) * plotW;
  const y = (v) => M.top + plotH - (v / max) * plotH;

  for (const t of ticks) {
    const gy = y(t);
    el('line', {
      x1: M.left, x2: W - M.right, y1: gy, y2: gy,
      stroke: 'var(--gridline)', 'stroke-width': 1,
    }, svg);
    el('text', {
      x: M.left - 8, y: gy + 4, 'text-anchor': 'end', class: 'axis-text',
    }, svg).textContent = String(t);
  }

  labels.forEach((label, i) => {
    el('text', {
      x: x(i), y: H - 12, 'text-anchor': 'middle', class: 'axis-text',
    }, svg).textContent = label;
  });

  // Colors follow the entity by index into a fixed slot order — never by rank,
  // so toggling a year off never repaints the other one.
  const endpoints = [];

  series.forEach((s, si) => {
    const color = `var(--series-${si + 1})`;
    const drawn = s.values
      .map((v, i) => ({ v, i }))
      .filter((p) => p.v !== null && p.v !== undefined);
    if (!drawn.length) return;

    el('polyline', {
      points: drawn.map((p) => `${x(p.i)},${y(p.v)}`).join(' '),
      fill: 'none', stroke: color,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, svg);

    const last = drawn[drawn.length - 1];
    // 2px surface ring keeps the end markers legible where the series cross.
    el('circle', {
      cx: x(last.i), cy: y(last.v), r: 5,
      fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2,
    }, svg);

    endpoints.push({ x: x(last.i), y: y(last.v), value: last.v });
  });

  // Direct end-labels only when they will not sit on top of each other.
  // Nudging collided labels apart detaches them from their lines, so the
  // legend and tooltip carry identity in that case instead.
  const collides = endpoints.some((a, i) =>
    endpoints.some((b, j) =>
      i !== j && Math.abs(a.x - b.x) < 24 && Math.abs(a.y - b.y) < 14));

  if (!collides) {
    for (const p of endpoints) {
      el('text', {
        x: p.x + 10, y: p.y + 4, class: 'value-label',
      }, svg).textContent = String(p.value);
    }
  }

  // One shared crosshair column per x position, reporting every series at once.
  labels.forEach((label, i) => {
    const bandW = plotW / Math.max(1, labels.length - 1);
    const hit = el('rect', {
      x: x(i) - bandW / 2, y: M.top, width: bandW, height: plotH,
      fill: 'transparent', class: 'hit',
    }, svg);
    const rows = series
      .filter((s) => s.values[i] !== null && s.values[i] !== undefined)
      .map((s, si) => `<span class="key" style="background:var(--series-${series.indexOf(s) + 1})"></span>${s.name}: ${s.values[i]}`)
      .join('<br>');
    bindTip(hit, `<strong>${label}</strong>${rows ? `<br>${rows}` : ''}`);
  });
}

// ---------------------------------------------------------------------------
// Horizontal bar chart — ranked categories with long names
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {{items: {label: string, value: number}[], unit?: string, ariaLabel?: string}} data
 */
export function barChart(container, { items, unit = '', ariaLabel = '' }) {
  const rowH = 30;
  const W = 720;
  const M = { top: 8, right: 48, bottom: 8, left: 190 };
  const H = M.top + M.bottom + items.length * rowH;
  const plotW = W - M.left - M.right;

  const svg = svgRoot(container, W, Math.max(H, 40));
  svg.setAttribute('aria-label', ariaLabel);

  const max = Math.max(1, ...items.map((d) => d.value));
  const barH = Math.min(24, rowH - 8);

  items.forEach((d, i) => {
    const y = M.top + i * rowH + (rowH - barH) / 2;
    const w = (d.value / max) * plotW;

    const hit = el('rect', {
      x: 0, y: M.top + i * rowH, width: W, height: rowH,
      fill: 'transparent', class: 'hit',
    }, svg);
    bindTip(hit, `<strong>${d.label}</strong><br>${d.value} ${unit}`.trim());

    el('text', {
      x: M.left - 12, y: y + barH / 2 + 4, 'text-anchor': 'end',
      class: 'axis-text', 'pointer-events': 'none',
    }, svg).textContent = truncate(d.label, 26);

    // Rotated bar path: rounded at the value end, square at the baseline.
    el('path', {
      d: hBarPath(M.left, y, Math.max(w, 2), barH, 4),
      fill: 'var(--series-1)', 'pointer-events': 'none',
    }, svg);

    el('text', {
      x: M.left + Math.max(w, 2) + 10, y: y + barH / 2 + 4,
      class: 'value-label', 'pointer-events': 'none',
    }, svg).textContent = String(d.value);
  });
}

function hBarPath(x, y, w, h, r) {
  const radius = Math.min(r, h / 2, w);
  return [
    `M${x},${y}`,
    `L${x + w - radius},${y}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `L${x + w},${y + h - radius}`,
    `Q${x + w},${y + h} ${x + w - radius},${y + h}`,
    `L${x},${y + h}`,
    'Z',
  ].join(' ');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Heatmap — books finished per month, one row per year
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {{years: number[], grid: number[][], max: number, ariaLabel?: string}} data
 */
export function heatmap(container, { years, grid, max, ariaLabel = '' }) {
  const cell = 40, gap = 2, labelW = 48, headerH = 22;
  const W = labelW + 12 * cell;
  const H = headerH + years.length * cell;

  const svg = svgRoot(container, W, Math.max(H, 40));
  svg.setAttribute('aria-label', ariaLabel);

  MONTHS.forEach((m, i) => {
    el('text', {
      x: labelW + i * cell + cell / 2, y: 14,
      'text-anchor': 'middle', class: 'axis-text',
    }, svg).textContent = m;
  });

  years.forEach((year, r) => {
    el('text', {
      x: labelW - 12, y: headerH + r * cell + cell / 2 + 4,
      'text-anchor': 'end', class: 'axis-text',
    }, svg).textContent = String(year);

    grid[r].forEach((v, c) => {
      const rect = el('rect', {
        // The 2px gap is the separator; cells never get a stroke.
        x: labelW + c * cell + gap / 2,
        y: headerH + r * cell + gap / 2,
        width: cell - gap,
        height: cell - gap,
        rx: 3,
        fill: rampColor(v, max),
      }, svg);
      bindTip(rect, `<strong>${MONTHS[c]} ${year}</strong><br>${v} ${v === 1 ? 'book' : 'books'}`);
    });
  });
}

/**
 * Number of filled steps on the sequential ramp. Five, because that is the
 * widest run of this blue scale that clears the ordinal gates (>=0.06 OKLCH
 * lightness between adjacent steps, lightest step >=2:1 against the surface)
 * in both light and dark. seq-0 is a neutral gray, off-ramp on purpose.
 */
const RAMP_STEPS = 5;

/** Bucket a value onto the sequential ramp; 0 gets the off-ramp gray. */
function rampColor(value, max) {
  if (value <= 0) return 'var(--seq-0)';
  const step = Math.ceil((value / max) * RAMP_STEPS);
  return `var(--seq-${Math.min(RAMP_STEPS, Math.max(1, step))})`;
}

/** Discrete legend for the heatmap ramp. */
export function heatmapLegend(container, max) {
  container.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'ramp-legend';
  const swatches = Array.from({ length: RAMP_STEPS + 1 }, (_, i) =>
    `<span class="ramp-swatch" style="background:var(--seq-${i})"></span>`).join('');
  wrap.innerHTML =
    `<span class="ramp-end">0</span>${swatches}<span class="ramp-end">${max}</span>`;
  container.appendChild(wrap);
}

export { MONTHS };

// ---------------------------------------------------------------------------
// Small multiples — one miniature chart per category, shared scale
// ---------------------------------------------------------------------------

/**
 * A grid of miniature column charts, one per series, all on the same y-scale.
 *
 * Chosen over a stacked bar for genre-over-time on purpose. A stack answers
 * "what share of that year was romance", but every segment above the first
 * floats off a moving baseline, so comparing any single genre across years
 * means eyeballing lengths that never start in the same place. Small multiples
 * give each genre its own baseline, and — because they need only one hue — they
 * sidestep handing six categories six colours that then have to survive a
 * colour-blindness check.
 *
 * @param {HTMLElement} container
 * @param {{labels: string[], series: {name: string, values: number[]}[], ariaLabel?: string}} data
 */
export function smallMultiples(container, { labels, series, ariaLabel = '' }) {
  container.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'multiples';
  wrap.setAttribute('role', 'group');
  if (ariaLabel) wrap.setAttribute('aria-label', ariaLabel);

  // One shared maximum, so a tall bar means the same thing in every panel.
  const max = Math.max(1, ...series.flatMap((s) => s.values));

  for (const s of series) {
    const cell = document.createElement('div');
    cell.className = 'multiple';

    const head = document.createElement('div');
    head.className = 'multiple-head';
    head.innerHTML =
      `<span class="multiple-name"></span>` +
      `<span class="multiple-total">${s.values.reduce((a, b) => a + b, 0)}</span>`;
    head.querySelector('.multiple-name').textContent = s.name;
    cell.appendChild(head);

    const plot = document.createElement('div');
    cell.appendChild(plot);
    wrap.appendChild(cell);

    miniColumns(plot, labels, s.values, max, s.name);
  }

  container.appendChild(wrap);
}

/** One panel of the grid: bare columns, no axis furniture. */
function miniColumns(host, labels, values, max, seriesName) {
  const W = 220, H = 74, pad = 2;
  const svg = svgRoot(host, W, H + 14);
  svg.setAttribute('aria-label', `${seriesName} per year`);

  const band = W / labels.length;
  const barW = Math.min(18, band - 4);

  el('line', {
    x1: 0, x2: W, y1: H, y2: H,
    stroke: 'var(--baseline)', 'stroke-width': 1,
  }, svg);

  labels.forEach((label, i) => {
    const v = values[i];
    const h = (v / max) * (H - pad);
    const x = i * band + (band - barW) / 2;

    const hit = el('rect', {
      x: i * band, y: 0, width: band, height: H,
      fill: 'transparent', class: 'hit',
    }, svg);
    bindTip(hit, `<strong>${seriesName}</strong><br>${label}: ${v} ${v === 1 ? 'book' : 'books'}`);

    if (v > 0) {
      el('path', {
        d: barPath(x, H - h, barW, h, 3),
        fill: 'var(--series-1)',
        'pointer-events': 'none',
      }, svg);
    }

    // Only the ends of the axis are labelled; a tick under every column would
    // out-ink the data at this size.
    if (i === 0 || i === labels.length - 1) {
      el('text', {
        x: i * band + band / 2, y: H + 12,
        'text-anchor': 'middle', class: 'axis-text',
      }, svg).textContent = label;
    }
  });
}
