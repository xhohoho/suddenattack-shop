import { google } from 'googleapis';

// ── Auth (Service Account — used for Sheets) ───────────────────────────────────
function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    try {
      const fixed = raw.replace(/\r?\n/g, '\\n');
      creds = JSON.parse(fixed);
    } catch (e2) {
      throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}.`);
    }
  }

  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

// ── OAuth2 Auth (Personal Account — used for Drive uploads) ────────────────────
function getDriveAuth() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing OAuth env vars: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN');
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

function checkToken(body) {
  if (!body._token || body._token !== process.env.ADMIN_TOKEN) {
    throw new Error('Unauthorized');
  }
}

const SHEET_ID = process.env.SHEET_ID;

// ── Sheet Helpers ──────────────────────────
async function getSheetData(auth, sheetName) {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1:Z1000`,
    });
    const rows = response.data.values;
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

function colLetter(idx) {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function driveUrl(fileId, mimeType = '') {
  const isVideo = mimeType.includes('video');
  const isGif = mimeType.includes('gif');
  if (isVideo) return `https://drive.google.com/file/d/${fileId}/preview`;
  if (isGif) return `https://lh3.googleusercontent.com/d/${fileId}`;
  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

async function sheetsRead(auth, range) {
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return r.data.values || [];
}

async function sheetsWrite(auth, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function sheetsAppend(auth, range, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// ── Drive Upload Helper (base64 — for small files / images) ───────────────────
async function uploadToDrive(base64, mimeType, fileName, folderId) {
  const auth = getDriveAuth();
  const drive = google.drive({ version: 'v3', auth });
  const buffer = Buffer.from(base64, 'base64');
  const { Readable } = await import('stream');
  const stream = Readable.from(buffer);
  const r = await drive.files.create({
    supportsAllDrives: true,
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: stream },
    fields: 'id',
  });
  await drive.permissions.create({
    fileId: r.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return r.data.id;
}

// ── Find or create a named subfolder inside a parent Drive folder ──────────────
async function findOrCreateFolder(drive, folderName, parentId) {
  const escapedName = folderName.replace(/'/g, "\\'");
  const search = await drive.files.list({
    q: `name='${escapedName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (search.data.files.length > 0) return search.data.files[0].id;
  const folder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return folder.data.id;
}

async function callGemini(base64, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: base64 } }] }]
    })
  });
  const d = await r.json();
  return d.candidates[0].content.parts[0].text;
}

// ══════════════════════════════════════════
// DIRECT UPLOAD HANDLERS
// Browser uploads file straight to Google Drive — bypasses Vercel's 4.5MB body limit.
// Flow:
//   1. Frontend calls getDirectUploadUrl  → gets { uploadUrl, fileId }
//   2. Frontend PUTs the raw file blob to uploadUrl (direct to Google Drive)
//   3. Frontend calls finalizeUpload(fileId) → sets public permission, returns display URL
// ══════════════════════════════════════════

async function handleGetDirectUploadUrl(body, res) {
  // Allowed for both admin and public (no token check needed — the returned URL
  // is a single-use resumable session URL that expires in 24h and only allows
  // uploading one specific file).
  const { fileName, mimeType, folderContext, ign } = body;
  if (!fileName || !mimeType) throw new Error('fileName and mimeType are required');

  const oauthClient = getDriveAuth();
  const { credentials } = await oauthClient.refreshAccessToken();
  const accessToken = credentials.access_token;

  // Determine target folder
  let folderId;
  const drive = google.drive({ version: 'v3', auth: oauthClient });

  if (folderContext === 'account' || folderContext === 'account_public') {
    const subfolderName = ign || 'unknown';
    folderId = await findOrCreateFolder(drive, subfolderName, process.env.DRIVE_FOLDER_ACCOUNTS);
  } else if (folderContext === 'receipt') {
    folderId = process.env.DRIVE_FOLDER_RECEIPT;
  } else if (folderContext === 'payment') {
    folderId = process.env.DRIVE_FOLDER_PAYMENT;
  } else {
    folderId = process.env.DRIVE_FOLDER_SA;
  }

  // Create a resumable upload session on Google Drive
  // This returns a session URI — the browser uploads the file directly to it.
  const initResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
      },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId],
      }),
    }
  );

  if (!initResp.ok) {
    const err = await initResp.text();
    throw new Error(`Drive resumable init failed: ${err}`);
  }

  const uploadUrl = initResp.headers.get('location');
  if (!uploadUrl) throw new Error('No upload URL returned from Drive');

  // We also need the fileId — Drive doesn't return it until after upload.
  // Instead, we return the uploadUrl and the folder context so finalizeUpload
  // can list recent files in the folder. Actually, a cleaner approach:
  // create the file metadata first (0 bytes), then return its ID + an update URL.

  // Better: use the files.create with uploadType=resumable to get both the fileId
  // and the resumable upload URL in one step via the Location header.
  // The fileId is embedded in the Location URL after ?upload_id=... is gone —
  // it's not directly exposed. So we return the uploadUrl and let finalizeUpload
  // find the file by its unique name.

  return res.json({ uploadUrl, folderId, fileName, mimeType });
}

async function handleFinalizeUpload(body, res) {
  // Called after the browser finishes a direct Drive upload.
  // Finds the newly uploaded file by name in the folder, sets it public, returns URL.
  const { fileName, mimeType, folderId } = body;
  if (!fileName || !folderId) throw new Error('fileName and folderId are required');

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const escapedFileName = fileName.replace(/'/g, "\\'");

  // Poll for the file — it should exist immediately after upload
  let fileId = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const search = await drive.files.list({
      q: `name='${escapedFileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id,createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (search.data.files.length > 0) {
      fileId = search.data.files[0].id;
      break;
    }
    // Wait 500ms before retry
    await new Promise(r => setTimeout(r, 500));
  }

  if (!fileId) throw new Error('Uploaded file not found in Drive after polling');

  // Make public
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const url = driveUrl(fileId, mimeType);
  console.log(`✅ finalizeUpload: ${fileName} → ${fileId} → ${url}`);
  return res.json({ url, fileId });
}

// ══════════════════════════════════════════
// ACTION HANDLERS
// ══════════════════════════════════════════

async function handleAdminAuth(body, res) {
  if (body.password !== process.env.ADMIN_PASSWORD) return res.status(200).json({ error: 'unauthorized' });
  return res.json({ token: process.env.ADMIN_TOKEN });
}

async function handleGetOrders(auth, res) {
  const { data } = await getSheetData(auth, 'Orders');
  return res.json({ values: data });
}

async function handleGetShopItems(auth, res) {
  const rows = await sheetsRead(auth, 'CurrentShop!A1:F1000');
  if (!rows || rows.length < 2) return res.json({ values: [] });
  const data = rows.slice(1)
    .filter(row => row.some(cell => cell !== ''))
    .map((row, i) => ({
      id: row[0] || String(i + 1),
      name: row[1] || '',
      desc: row[2] || '',
      p7: row[3] || '',
      p15: row[4] || '',
      p30: row[5] || '',
    }))
    .filter(it => it.name);
  return res.json({ values: data });
}

async function handleGetAccounts(auth, res) {
  const { data } = await getSheetData(auth, 'AccountList');
  return res.json({ values: data });
}

async function handleUpdateOrderStatus(auth, body, res) {
  checkToken(body);
  console.log(`📝 updateOrderStatus: ${body.order_id} → ${body.status}`);
  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}`, [[body.status]]);
  return res.json({ result: 'ok' });
}

async function handleNewOrder(auth, body, res) {
  let proofFormula = '';
  if (body.base64) {
    const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_RECEIPT);
    proofFormula = body.mimeType === 'application/pdf'
      ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
      : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  }
  const kl = new Date(body.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });
  const row = [
    body.order_id, kl, body.name, body.phone || '',
    body.email || '', body.items, body.total,
    body.note || '', body.status || 'New', proofFormula
  ];
  const { data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx >= 0) {
    await sheetsWrite(auth, `Orders!A${rowIdx + 2}:Z${rowIdx + 2}`, [row]);
  } else {
    await sheetsAppend(auth, 'Orders!A1', [row]);
  }
  return res.json({ result: 'ok' });
}

async function handleUploadProofItem(auth, body, res) {
  console.log(`📤 uploadProofItem: ${body.order_id}`);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_RECEIPT);
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  const proofCol = colLetter(headers.indexOf('proof'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}:${proofCol}${rowNum}`, [['Paid', proofFormula]]);
  console.log(`✅ proof uploaded for ${body.order_id}`);
  return res.json({ result: 'ok' });
}

async function handleAccountPurchase(auth, body, res) {
  console.log(`💰 accountPurchase: ${body.order_id}`);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_PAYMENT);
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  const kl = new Date(body.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });
  const row = [
    body.order_id, kl, body.name, body.phone || '',
    body.email || '', body.items, body.total,
    body.note || '', 'Paid', proofFormula
  ];
  await sheetsAppend(auth, 'Orders!A1', [row]);
  return res.json({ result: 'ok' });
}

async function handleSaveItems(auth, body, res) {
  checkToken(body);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'CurrentShop!A2:Z1000' });
  const rows = body.items.map(it => [it.id, it.name, it.desc || '', it.p[7] || '', it.p[15] || '', it.p[30] || '']);
  await sheetsAppend(auth, 'CurrentShop!A2', rows);
  return res.json({ result: 'ok' });
}

async function handleExtractItems(auth, body, res) {
  checkToken(body);
  console.log('🖼 extractItems: uploading image to Drive...');
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_SA);
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ uploaded: ${fileId}`);
  console.log('🤖 calling Gemini for item extraction...');
  const prompt = `Extract all game item names from this shop image. Return ONLY a JSON array of strings like: ['Item Name 1', 'Item Name 2']. No descriptions, no prices, no markdown, no explanation.`;
  const text = await callGemini(body.base64, prompt);
  const clean = text.replace(/```json|```/g, '').trim();
  const names = JSON.parse(clean);
  const items = names.map((name, i) => ({ id: i + 1, name, desc: '', p7: 0, p15: 0, p30: 0 }));
  console.log(`✅ Gemini extracted ${items.length} items`);
  return res.json({ items, url });
}

async function handleExtractAccountStats(body, res) {
  checkToken(body);
  console.log('🤖 extractAccountStats: calling Gemini...');
  const prompt = `Extract player stats from this Sudden Attack game profile screenshot. Return ONLY a valid JSON object with these exact keys: ign, accId, kda, winRate, exp. If a field is not visible return empty string. No markdown, no explanation, only JSON.`;
  const text = await callGemini(body.base64, prompt);
  const clean = text.replace(/```json|```/g, '').trim();
  let stats = {};
  try { stats = JSON.parse(clean); } catch (e) { }
  console.log(`✅ stats extracted: ${JSON.stringify(stats)}`);
  return res.json(stats);
}

async function handleUploadAccountImage(auth, body, res) {
  checkToken(body);
  const accountIGN = body.ign;
  console.log(`📤 uploadAccountImage: ${accountIGN}`);
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const folderId = await findOrCreateFolder(drive, accountIGN, process.env.DRIVE_FOLDER_ACCOUNTS);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, folderId);
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ uploaded: ${fileId} → ${url}`);
  return res.json({ url });
}

async function handleUploadPublicAccountImage(auth, body, res) {
  const accountIGN = body.ign;
  console.log(`📤 uploadPublicAccountImage: ${accountIGN}`);
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const folderId = await findOrCreateFolder(drive, accountIGN, process.env.DRIVE_FOLDER_ACCOUNTS);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, folderId);
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ public upload: ${fileId} → ${url}`);
  return res.json({ url });
}

async function handleSaveAccount(auth, body, res) {
  if (!body.isNew) checkToken(body);
  const acc = body.account;
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const row = headers.map(h => {
    const key = h.toLowerCase().trim();
    return acc[key] !== undefined ? acc[key] : '';
  });
  const rowIdx = data.findIndex(r => String(r.id) === String(acc.id));
  if (rowIdx >= 0) {
    const rowNum = rowIdx + 2;
    const lastCol = colLetter(headers.length - 1);
    await sheetsWrite(auth, `AccountList!A${rowNum}:${lastCol}${rowNum}`, [row]);
  } else {
    await sheetsAppend(auth, 'AccountList!A1', [row]);
  }
  console.log(`✅ Account ${acc.id} saved via Auto-Mapping`);
  return res.json({ result: 'ok' });
}

async function handleDeleteAccount(auth, body, res) {
  checkToken(body);
  const accountIGN = body.ign;
  console.log(`🗑 deleteAccount: ${accountIGN}`);
  const { data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(body.acc_id));
  if (rowIdx === -1) throw new Error('Account not found');
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === 'AccountList');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIdx + 1, endIndex: rowIdx + 2 } } }]
    }
  });
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const search = await drive.files.list({
    q: `name='${accountIGN}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (search.data.files && search.data.files.length > 0) {
    await drive.files.delete({ fileId: search.data.files[0].id, supportsAllDrives: true });
    console.log(`🗑 Drive folder deleted: ${accountIGN}`);
  }
  return res.json({ result: 'ok' });
}

async function handleUpdateAccountStatus(auth, body, res) {
  checkToken(body);
  const accId = body.id || (body.account && body.account.id);
  const newStatus = body.status || (body.account && body.account.status);
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(accId));
  if (rowIdx === -1) throw new Error('Account not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `AccountList!${statusCol}${rowNum}`, [[newStatus]]);
  return res.json({ result: 'ok' });
}

async function handleUploadSlideImg(auth, body, res) {
  checkToken(body);
  const idx = body.slideIndex;
  if (idx === undefined || idx === null) throw new Error('Missing slideIndex');
  let url = body.url;
  if (body.base64) {
    console.log(`📤 uploadSlideImg: Uploading file to Drive for slide ${idx}`);
    const fileId = await uploadToDrive(
      body.base64,
      body.mimeType || 'image/jpeg',
      body.fileName || `shop_${idx}.jpg`,
      process.env.DRIVE_FOLDER_SA
    );
    url = driveUrl(fileId, body.mimeType);
  }
  if (url === undefined || url === null) throw new Error('No URL or Base64 provided');
  console.log(`📝 uploadSlideImg: Updating Sheet for slide ${idx} with value: "${url}"`);
  const col = parseInt(idx) === 0 ? 'B' : 'C';
  await sheetsWrite(auth, `Settings!${col}2`, [[url]]);
  return res.json({ result: 'ok', url });
}

async function handleGetSettings(auth, res) {
  try {
    const { data } = await getSheetData(auth, 'Settings');
    const slideshowRow = data.find(r => r.key === 'slideshow');
    const urls = slideshowRow ? [slideshowRow.slide1, slideshowRow.slide2] : ['', ''];
    return res.json({ slides: urls });
  } catch (err) {
    return res.status(500).json({ error: 'Settings fetch failed' });
  }
}

async function handleInitData(auth, res) {
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

// ══════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  const { action } = body;
  try {
    const auth = await getAuth().getClient();

    // ── Public actions ──────────────────────
    if (action === 'adminAuth')               return await handleAdminAuth(body, res);
    if (action === 'getOrders')               return await handleGetOrders(auth, res);
    if (action === 'getShopItems')            return await handleGetShopItems(auth, res);
    if (action === 'getAccounts')             return await handleGetAccounts(auth, res);
    if (action === 'getSettings')             return await handleGetSettings(auth, res);
    if (action === 'initData')                return await handleInitData(auth, res);
    if (action === 'newOrder')                return await handleNewOrder(auth, body, res);
    if (action === 'accountPurchase')         return await handleAccountPurchase(auth, body, res);
    if (action === 'saveAccount' && body.isNew) return await handleSaveAccount(auth, body, res);
    if (action === 'uploadPublicAccountImage') return await handleUploadPublicAccountImage(auth, body, res);

    // ── Direct upload (browser → Drive) ────
    // These two are called for large video/file uploads to bypass Vercel's 4.5MB limit.
    // getDirectUploadUrl is public (no token needed — session URL is single-use, 24h TTL).
    // finalizeUpload is also public (just sets permissions + resolves URL).
    if (action === 'getDirectUploadUrl')      return await handleGetDirectUploadUrl(body, res);
    if (action === 'finalizeUpload')          return await handleFinalizeUpload(body, res);

    // ── Admin-only actions ──────────────────
    if (action === 'updateOrderStatus')       return await handleUpdateOrderStatus(auth, body, res);
    if (action === 'uploadProofItem')         return await handleUploadProofItem(auth, body, res);
    if (action === 'saveItems')               return await handleSaveItems(auth, body, res);
    if (action === 'extractItems')            return await handleExtractItems(auth, body, res);
    if (action === 'extractAccountStats')     return await handleExtractAccountStats(body, res);
    if (action === 'uploadAccountImage')      return await handleUploadAccountImage(auth, body, res);
    if (action === 'saveAccount')             return await handleSaveAccount(auth, body, res);
    if (action === 'deleteAccount')           return await handleDeleteAccount(auth, body, res);
    if (action === 'updateAccountStatus')     return await handleUpdateAccountStatus(auth, body, res);
    if (action === 'uploadSlideImg')          return await handleUploadSlideImg(auth, body, res);

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('❌ CRITICAL ERROR:', err);
    return res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
}
