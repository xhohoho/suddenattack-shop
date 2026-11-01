import { getSheetData, sheetsRead, sheetsWrite, sanitizeSheetValue } from '../lib/sheets.js';
import { uploadToDrive, driveUrl } from '../lib/drive.js';
import { requireToken } from '../lib/auth.js';

// Whitelist for public settings reads
const PUBLIC_SETTINGS_FIELDS = ['slides', 'ticker'];

export async function handleGetSettings(auth, res) {
  try {
    const { data } = await getSheetData(auth, 'Settings');
    const slideshowRow = data.find(r => r.key === 'slideshow');
    const urls = slideshowRow ? [slideshowRow.slide1, slideshowRow.slide2] : ['', ''];
    const tickerRaw = await sheetsRead(auth, 'Settings!D2');
    const ticker = tickerRaw[0]?.[0] || '';
    return res.json({ slides: urls, ticker });
  } catch {
    return res.status(500).json({ error: 'Settings fetch failed' });
  }
}

/**
 * Public: initData - returns only public-safe data
 * - Orders: whitelisted fields, masked names
 * - Items: CurrentShop data
 * - Settings: slides + ticker
 * Does NOT return phone, email, seller info, or pending accounts
 */
export async function handleInitData(auth, res) {
  const PUBLIC_ORDER_FIELDS = ['order_id', 'timestamp', 'name', 'items', 'total', 'status', 'comment', 'proof'];

  const [ordersResult, itemsResult, settingsRaw] = await Promise.all([
    getSheetData(auth, 'Orders'),
    getSheetData(auth, 'CurrentShop'),
    sheetsRead(auth, 'Settings!B2:D2'),
  ]);

  // Return orders for public (show full name publicly)
  const publicOrders = ordersResult.data.map(row => {
    const filtered = {};
    for (const field of PUBLIC_ORDER_FIELDS) {
      filtered[field] = row[field];
    }
    return filtered;
  });

  const settingsRow = settingsRaw[0] || [];
  return res.json({
    orders: publicOrders,
    items: itemsResult.data,
    slides: [settingsRow[0] || '', settingsRow[1] || ''],
    ticker: settingsRow[2] || '',
  });
}

export async function handleUpdateTicker(auth, body, res) {
  requireToken(body);
  const text = sanitizeSheetValue((body.text || '').toString().slice(0, 500));
  await sheetsWrite(auth, 'Settings!D2', [[text]]);
  return res.json({ result: 'ok', text });
}

export async function handleUploadSlideImg(auth, body, res) {
  requireToken(body);
  const idx = body.slideIndex;
  if (idx === undefined || idx === null) throw new Error('Missing slideIndex');

  let url = body.url;
  if (body.base64) {
    console.log(`📤 uploadSlideImg: Uploading file to Drive for slide ${idx}`);
    const fileId = await uploadToDrive(
      body.base64,
      body.mimeType || 'image/jpeg',
      body.fileName || `shop_${idx}.jpg`,
      process.env.DRIVE_FOLDER_SA,
    );
    url = driveUrl(fileId, body.mimeType);
  }
  if (url === undefined || url === null) throw new Error('No URL or Base64 provided');

  console.log(`📝 uploadSlideImg: slide ${idx} → "${url}"`);
  const col = parseInt(idx) === 0 ? 'B' : 'C';
  await sheetsWrite(auth, `Settings!${col}2`, [[url]]);
  return res.json({ result: 'ok', url });
}