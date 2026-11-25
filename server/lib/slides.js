// Slideshow storage in the Settings sheet.
//
// The full ordered list lives in ONE cell as JSON (Settings!F2), so the number of slides is not tied to the
// number of columns. B2:C2 still mirror the first two slides so the sheet looks the same as before and an old
// deploy keeps working. D2 is the ticker. A sheet that was never saved with the new code has an empty F2,
// in which case the list is read from B2:C2.

export const MAX_SLIDES = 10; // keep in sync with MAX_SLIDES in public/js/admin.js
export const SLIDE_RANGE = 'Settings!B2:F2'; // B, C = first two slides · D = ticker · E = unused · F = JSON list
export const SLIDE_JSON_CELL = 'Settings!F2';
export const SLIDE_LEGACY_RANGE = 'Settings!B2:C2';

const trimTrailing = list => { const out = list.slice(); while (out.length && !out[out.length - 1]) out.pop(); return out; };

/** cells = the row read from Settings!B2:F2 (trailing blanks may be missing). Returns the slide URL list. */
export function parseSlides(cells) {
  const row = Array.isArray(cells) ? cells : [];
  const raw = typeof row[4] === 'string' ? row[4].trim() : '';
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return trimTrailing(arr.map(u => (typeof u === 'string' ? u.trim() : '')).slice(0, MAX_SLIDES));
    } catch { /* fall through to the legacy cells */ }
  }
  return trimTrailing([row[0], row[1]].map(u => (typeof u === 'string' ? u.trim() : '')));
}

/** The two writes that store a slide list: the JSON cell + the B2:C2 mirror. */
export function slideWrites(urls) {
  const list = trimTrailing(urls.slice(0, MAX_SLIDES).map(u => String(u || '').trim()));
  return [
    { range: SLIDE_LEGACY_RANGE, values: [[list[0] || '', list[1] || '']] },
    { range: SLIDE_JSON_CELL, values: [[JSON.stringify(list)]] },
    { range: 'Settings!F1', values: [['slides_json']] }, // header so the extra cell is self-explanatory in the sheet
  ];
}
