import { getSheetData, sheetsRead, sheetsWrite, sanitizeSheetValue } from '../lib/sheets.js';
import { uploadToDrive, driveUrl, decodeUpload, extForMime } from '../lib/drive.js';
import { requireToken } from '../lib/auth.js';
import { badRequest, cleanText } from '../lib/http.js';
import { publicOrders } from './orders.js';
import { getShopItems } from './shop.js';

const CACHE_MS = 10_000;

export async function handleGetSettings(auth, res) {
  const { data } = await getSheetData(auth, 'Settings', { ttl: CACHE_MS });
  const slideshowRow = data.find(r => r.key === 'slideshow');
  const urls = slideshowRow ? [slideshowRow.slide1, slideshowRow.slide2] : ['', ''];
  const tickerRaw = await sheetsRead(auth, 'Settings!D2', { ttl: CACHE_MS });
  const ticker = tickerRaw[0]?.[0] || '';
  return res.json({ slides: urls, ticker });
}

/**
 * Public: everything the page needs on first load.
 * - orders: whitelisted fields only (no phone / email / proof)
 * - items:  canonical { id, name, desc, p7, p15, p30 } (same parser the order endpoint prices with)
 */
export async function handleInitData(auth, res) {
  const [ordersResult, items, settingsRaw] = await Promise.all([
    getSheetData(auth, 'Orders', { ttl: 5000 }),
    getShopItems(auth),
    sheetsRead(auth, 'Settings!B2:D2', { ttl: CACHE_MS }),
  ]);
  const settingsRow = settingsRaw[0] || [];
  return res.json({
    orders: publicOrders(ordersResult.data.slice(-20)), // newest 20 (sheet is oldest-first); the page reverses them
    items,
    slides: [settingsRow[0] || '', settingsRow[1] || ''],
    ticker: settingsRow[2] || '',
  });
}

export async function handleUpdateTicker(auth, body, res) {
  requireToken(body);
  const text = sanitizeSheetValue(cleanText(body.text, 500));
  await sheetsWrite(auth, 'Settings!D2', [[text]]);
  return res.json({ result: 'ok', text });
}

// Only two slide cells exist in the sheet (Settings!B2 and C2).
const SLIDE_COLS = ['B', 'C'];
const SLIDE_URL = /^https:\/\/(?:lh3\.googleusercontent\.com\/d\/[\w-]+(?:=[\w-]+)?|drive\.google\.com\/uc\?export=(?:download|view)&id=[\w-]+(?:&confirm=t)?)$/;

export async function handleUploadSlideImg(auth, body, res) {
  requireToken(body);
  const idx = Number(body.slideIndex);

  // Drag-to-reorder sends slideIndex -1 + the new ordered list of urls.
  if (idx === -1 && Array.isArray(body.urls)) {
    const urls = body.urls.slice(0, 2).map(u => {
      const s = String(u || '').trim();
      if (s && !SLIDE_URL.test(s)) throw badRequest('Invalid slide URL');
      return s;
    });
    while (urls.length < 2) urls.push('');
    await sheetsWrite(auth, 'Settings!B2:C2', [urls]);
    return res.json({ result: 'ok' });
  }

  if (!Number.isInteger(idx) || idx < 0 || idx >= SLIDE_COLS.length) {
    throw badRequest(`Only ${SLIDE_COLS.length} slides are supported (slide index 0-${SLIDE_COLS.length - 1}).`);
  }

  let url = body.url;
  if (body.base64) {
    const { buffer, mimeType } = decodeUpload(body.base64, ['image/jpeg', 'image/png', 'image/webp'], 4 * 1024 * 1024);
    console.log(`📤 uploadSlideImg: uploading file for slide ${idx}`);
    const fileId = await uploadToDrive(buffer, mimeType, `shop_${idx}_${Date.now()}.${extForMime(mimeType)}`, process.env.DRIVE_FOLDER_SA);
    url = driveUrl(fileId, mimeType);
  } else if (typeof url === 'string' && url !== '' && !SLIDE_URL.test(url)) {
    throw badRequest('Invalid slide URL');
  }
  if (url === undefined || url === null) throw badRequest('No URL or file provided');

  await sheetsWrite(auth, `Settings!${SLIDE_COLS[idx]}2`, [[url]]);
  return res.json({ result: 'ok', url });
}
