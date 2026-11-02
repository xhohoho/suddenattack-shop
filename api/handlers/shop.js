import { sheetsRead, sheetsWrite, sheetsClear, sanitizeSheetValue } from '../lib/sheets.js';
import { uploadToDrive, driveUrl, decodeUpload, extForMime } from '../lib/drive.js';
import { callGemini, parseGeminiJson } from '../lib/gemini.js';
import { requireToken } from '../lib/auth.js';
import { badRequest, cleanText } from '../lib/http.js';

const SHOP_RANGE = 'CurrentShop!A1:F1000';
const PUBLIC_CACHE_MS = 10_000;

const num = v => parseFloat(String(v ?? '').replace(/,/g, '')) || 0;

/**
 * SINGLE SOURCE OF TRUTH for reading the CurrentShop sheet.
 * Columns are positional:  A=#  B=itemname  C=description  D=7d  E=15d  F=30d
 * (the header names in the sheet are NOT id/name/p7/..., so never read them by name).
 * The browser and the order-pricing code both go through this, so ids always match.
 */
export function parseShopRows(rows) {
  const items = [];
  (rows || []).slice(1).forEach(row => {
    if (!row || !row.some(c => c !== '' && c != null)) return;
    const name = String(row[1] ?? '').trim();
    if (!name) return;
    items.push({
      id: String(parseInt(row[0], 10) || items.length + 1),
      name,
      desc: String(row[2] ?? ''),
      p7: num(row[3]),
      p15: num(row[4]),
      p30: num(row[5]),
    });
  });
  return items;
}

/** Items as an array. Pass { fresh: true } to bypass the short cache (used when pricing orders). */
export async function getShopItems(auth, { fresh = false } = {}) {
  const rows = await sheetsRead(auth, SHOP_RANGE, { ttl: fresh ? 0 : PUBLIC_CACHE_MS });
  return parseShopRows(rows);
}

export async function handleGetShopItems(auth, res) {
  const items = await getShopItems(auth);
  return res.json({ values: items });
}

export async function handleSaveItems(auth, body, res) {
  requireToken(body);
  const list = body.items;
  if (!Array.isArray(list) || list.length === 0) throw badRequest('No items provided');
  if (list.length > 300) throw badRequest('Too many items (max 300)');

  const rows = list.map((it, i) => {
    const name = cleanText(it?.name, 100);
    if (!name) throw badRequest(`Item ${i + 1} has no name`);
    const price = d => {
      const v = Number(it?.p?.[d]);
      if (!Number.isFinite(v) || v < 0 || v > 100000) throw badRequest(`Invalid ${d}d price for "${name}"`);
      return v || '';
    };
    return [i + 1, sanitizeSheetValue(name), sanitizeSheetValue(cleanText(it?.desc, 200)), price(7), price(15), price(30)];
  });

  // 1) overwrite the new rows in place, 2) clear whatever is left BELOW them.
  // (The old code cleared first, so a failure in between left the shop empty.)
  await sheetsWrite(auth, `CurrentShop!A2:F${rows.length + 1}`, rows);
  await sheetsClear(auth, `CurrentShop!A${rows.length + 2}:F1000`);
  return res.json({ result: 'ok' });
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function handleExtractItems(auth, body, res) {
  requireToken(body);
  const { buffer, mimeType } = decodeUpload(body.base64, IMAGE_TYPES, 8 * 1024 * 1024);
  console.log('🖼 extractItems: uploading image to Drive...');
  const fileId = await uploadToDrive(buffer, mimeType, `shop_${Date.now()}.${extForMime(mimeType)}`, process.env.DRIVE_FOLDER_SA);
  const url = driveUrl(fileId, mimeType);

  console.log('🤖 calling Gemini for item extraction...');
  const prompt = `Extract all game item names from this shop image. Return ONLY a JSON array of strings like: ['Item Name 1', 'Item Name 2']. No descriptions, no prices, no markdown, no explanation.`;
  const text = await callGemini(buffer.toString('base64'), prompt, mimeType);
  const names = parseGeminiJson(text);
  if (!Array.isArray(names)) throw badRequest('Could not read items from this image');
  const items = names.map((name, i) => ({ id: i + 1, name: cleanText(name, 100), desc: '', p7: 0, p15: 0, p30: 0 }))
    .filter(it => it.name);
  console.log(`✅ Gemini extracted ${items.length} items`);
  return res.json({ items, url });
}

export async function handleExtractAccountStats(body, res) {
  requireToken(body);
  const { buffer, mimeType } = decodeUpload(body.base64, IMAGE_TYPES, 8 * 1024 * 1024);
  console.log('🤖 extractAccountStats: calling Gemini...');
  // Ask for the exact key names the admin form reads (ign, accid, kda, winRate, exp).
  const prompt = `Extract player stats from this Sudden Attack game profile screenshot. Return ONLY a valid JSON object with exactly these keys: ign, accid, kda, winRate, exp. Values are plain text/numbers with no % or other symbols. If a field is not visible return an empty string. No markdown, no explanation, only JSON.`;
  const text = await callGemini(buffer.toString('base64'), prompt, mimeType);
  let raw = {};
  try { raw = parseGeminiJson(text); } catch { /* return partial if parse fails */ }

  // Tolerate the model echoing older key spellings.
  const pick = (...keys) => { for (const k of keys) if (raw[k] != null && raw[k] !== '') return cleanText(raw[k], 40); return ''; };
  const stats = {
    ign: pick('ign', 'IGN'),
    accid: pick('accid', 'Id', 'id', 'ID'),
    kda: pick('kda', 'kda(%)', 'KDA'),
    winRate: pick('winRate', 'winRate(%)', 'winrate', 'win_rate'),
    exp: pick('exp', 'exp(%)', 'EXP'),
  };
  console.log(`✅ stats extracted: ${JSON.stringify(stats)}`);
  return res.json(stats);
}
