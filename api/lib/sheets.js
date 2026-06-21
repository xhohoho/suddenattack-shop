import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;

// ── Low-level wrappers ──────────────────────────────────────────────────────

export async function sheetsRead(auth, range) {
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return r.data.values || [];
}

export async function sheetsWrite(auth, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
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
}

// ── Higher-level helper ─────────────────────────────────────────────────────

/**
 * Reads an entire named sheet and returns { headers, data }.
 * Headers are normalised to lowercase, trimmed, with spaces removed.
 * Data rows are returned as objects keyed by header.
 */
export async function getSheetData(auth, sheetName) {
  try {
    const rows = await sheetsRead(auth, `${sheetName}!A1:Z1000`);
    if (!rows || rows.length < 2) return { headers: [], data: [] };
    const headers = rows[0].map(h => h.toLowerCase().trim().replace(/\s+/g, ''));
    const data = rows.slice(1)
      .filter(row => row.some(cell => cell !== ''))
      .map(row => Object.fromEntries(headers.map((key, i) => [key, row[i] || ''])));
    return { headers, data };
  } catch (err) {
    console.error(`❌ getSheetData fail (${sheetName}):`, err.message);
    throw err;
  }
}

// ── Utility ─────────────────────────────────────────────────────────────────

/** Sanitize a value before writing to Google Sheets to prevent formula injection.
 *  Values starting with =, +, -, @ are prefixed with a single quote so Sheets
 *  treats them as plain text instead of evaluating them as formulas. */
export function sanitizeSheetValue(val) {
  if (val == null) return '';
  const s = String(val);
  if (/^[=+\-@]/.test(s)) return "'" + s;
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
