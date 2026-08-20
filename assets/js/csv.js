/**
 * Minimal RFC 4180 CSV reader/writer.
 *
 * Goodreads and StoryGraph exports both contain review text with embedded
 * commas, quotes and newlines, so a naive `split(',')` corrupts real libraries.
 * This parser is a character-level state machine and handles all three.
 */

/**
 * Parse CSV text into a header array and an array of row objects.
 * Duplicate header names are suffixed (`Title`, `Title_2`) so no column is lost.
 *
 * @param {string} text
 * @returns {{headers: string[], rows: Object<string,string>[]}}
 */
export function parseCSV(text) {
  const table = parseRows(text);
  if (!table.length) return { headers: [], rows: [] };

  const seen = new Map();
  const headers = table[0].map((raw) => {
    const name = raw.trim();
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}_${n}`;
  });

  const rows = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    // Skip blank trailing lines rather than emitting phantom books.
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const row = {};
    headers.forEach((h, j) => {
      row[h] = cells[j] === undefined ? '' : cells[j];
    });
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Parse CSV text into a raw 2D array of strings.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseRows(text) {
  // Strip UTF-8 BOM — Goodreads exports sometimes carry one, which would
  // otherwise become part of the first header name.
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // Swallow CR; the following LF (or its absence) ends the record.
      if (src[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }

  // Flush the final record when the file has no trailing newline.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Serialize rows to CSV using an explicit, ordered header list.
 * Columns absent from a row are written as empty strings, which is what both
 * importers expect for "no value".
 *
 * @param {string[]} headers
 * @param {Object<string,any>[]} rows
 * @returns {string}
 */
export function toCSV(headers, rows) {
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h])).join(','));
  }
  // Trailing newline: some importers drop the last record without it.
  return lines.join('\r\n') + '\r\n';
}

/**
 * Quote a single CSV field if it contains a delimiter, quote or newline.
 * @param {any} value
 * @returns {string}
 */
export function escapeField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
