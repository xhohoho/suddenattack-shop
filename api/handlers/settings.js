import { getSheetData, sheetsRead, sheetsWrite } from '../lib/sheets.js';
import { uploadToDrive, driveUrl } from '../lib/drive.js';
import { requireToken } from '../lib/auth.js';

export async function handleGetSettings(auth, res) {
  try {
    const { data } = await getSheetData(auth, 'Settings');
    const slideshowRow = data.find(r => r.key === 'slideshow');
    const urls = slideshowRow ? [slideshowRow.slide1, slideshowRow.slide2] : ['', ''];
    return res.json({ slides: urls });
  } catch {
    return res.status(500).json({ error: 'Settings fetch failed' });
  }
}

export async function handleInitData(auth, res) {
  const [ordersResult, itemsResult, settingsRaw] = await Promise.all([
    getSheetData(auth, 'Orders'),
    getSheetData(auth, 'CurrentShop'),
    sheetsRead(auth, 'Settings!B2:C2'),
  ]);
  return res.json({
    orders: ordersResult.data,
    items: itemsResult.data,
    slides: settingsRaw[0] || ['', ''],
  });
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
