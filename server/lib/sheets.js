import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;

// Rows read per sheet. The old limit (1000) silently hid every order after row 1000.
const MAX_ROWS = 5000;

// ── Tiny TTL cache (per warm instance) ──────────────────────────────────────
// Public read endpoints are polled by every visitor; Google Sheets only allows
// ~60 reads/minute, so reads that can tolerate a few seconds of staleness are
// cached. ANY write clears the whole cache. Handlers that read-then-write never
// use the cache (they call without `ttl`).

const cache = new Map();

export function invalidateCache() { cache.clear(); }

// ── Low-level wrappers ──────────────────────────────────────────────────────

export async function sheetsRead(auth, range, { ttl = 0 } = {}) {
  if (ttl > 0) {
    const hit = cache.get(range);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
  }
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const values = r.data.values || [];
  if (ttl > 0) cache.set(range, { t: Date.now(), v: values });
  return values;
}

export async function sheetsWrite(auth, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  invalidateCache();
}

/** Write several ranges in ONE API call: data = [{ range, values }, ...] */
export async function sheetsWriteBatch(auth, data) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  invalidateCache();
}

export async function sheetsAppend(auth, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  invalidateCache();
}

export async function sheetsClear(auth, range) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range });
  invalidateCache();
}

// ── Higher-level helper ─────────────────────────────────────────────────────

/**
 * Reads an entire named sheet and returns { headers, data }.
 * Headers are normalised to lowercase, trimmed, with spaces removed.
 * Data rows are objects keyed by header, plus `_row` = the REAL spreadsheet row
 * number (so blank rows in the middle of a sheet can't shift updates onto the
 * wrong row). `_row` is internal: never send it to the browser.
 *
 * Pass { ttl: ms } for a cached read (public, read-only endpoints only).
 */
export async function getSheetData(auth, sheetName, opts = {}) {
  try {
    const rows = await sheetsRead(auth, `${sheetName}!A1:Z${MAX_ROWS}`, opts);
    if (!rows || rows.length < 2) return { headers: (rows?.[0] || []).map(normHeader), data: [] };
    const headers = rows[0].map(normHeader);
    const data = [];
    rows.slice(1).forEach((row, i) => {
      if (!row.some(cell => cell !== '')) return;
      const obj = Object.fromEntries(headers.map((key, c) => [key, row[c] ?? '']));
      obj._row = i + 2; // +1 for header, +1 because sheets are 1-indexed
      data.push(obj);
    });
    return { headers, data };
  } catch (err) {
    console.error(`❌ getSheetData fail (${sheetName}):`, err.message);
    throw err;
  }
}

function normHeader(h) {
  return String(h ?? '').toLowerCase().trim().replace(/\s+/g, '');
}

/** Normalised header names of a sheet (cached for a minute; headers rarely change). */
export async function getHeaders(auth, sheetName) {
  const rows = await sheetsRead(auth, `${sheetName}!A1:Z1`, { ttl: 60_000 });
  return (rows[0] || []).map(normHeader);
}

/** Copy of a row without internal fields (`_row`). */
export function publicRow(row, fields) {
  const out = {};
  if (fields) { for (const f of fields) out[f] = row[f] ?? ''; return out; }
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

// ── Utility ─────────────────────────────────────────────────────────────────

/** Sanitize a value before writing to Google Sheets to prevent formula injection.
 *  Values starting with =, +, -, @ (or a tab/CR) are prefixed with a single quote
 *  so Sheets treats them as plain text instead of evaluating them as formulas. */
export function sanitizeSheetValue(val) {
  if (val == null) return '';
  const s = String(val);
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

/** Converts a 0-based column index to a spreadsheet letter (A, B, …, AA, …). */
export function colLetter(idx) {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}
