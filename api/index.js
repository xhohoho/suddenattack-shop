import { google } from 'googleapis';

// ── Auth (Service Account — used for Sheets) ───────────────────────────────────
function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    // Common Vercel issue: private_key newlines stored as literal \n (two chars)
    // instead of JSON escape sequence — fix by re-escaping them inside string values
    try {
      // Replace actual newlines inside the JSON string with \n escape sequences
      const fixed = raw.replace(/\r?\n/g, '\\n');
      creds = JSON.parse(fixed);
    } catch (e2) {
      throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}. Make sure the env var contains the full JSON object from your service account key file.`);
    }
  }

  // Additional safety: ensure private_key newlines are proper escape sequences
  // (some paste methods turn \\n into actual newlines inside the already-parsed object)
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
// Files uploaded via OAuth are owned by YOUR Google account → uses your quota.
// Service accounts have no quota, so Drive uploads must go through OAuth instead.
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

// ── Sheet Helper ───────────────────────────
async function getSheetData(auth, sheetName) {
  try {
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1:Z1000`,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) return { headers: [], data: [] };

    // Process headers: "Item Name" -> "itemname"
    const headers = rows[0].map(h => h.toLowerCase().trim().replace(/\s+/g, ''));

    const data = rows.slice(1)
      .filter(row => row.some(cell => cell !== ''))
      .map(row =>
        Object.fromEntries(headers.map((key, i) => [key, row[i] || '']))
      );

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

  if (isVideo) {
    // videos → Google's iframe embed player (no CORS issues)
    return `https://drive.google.com/file/d/${fileId}/preview`;
  }

  if (isGif) {
    // GIFs → must use export=view to preserve animation
    // thumbnail URL kills the animation
    return `https://lh3.googleusercontent.com/d/${fileId}`;
  }

  // all other images → thumbnail (fast, resizable, mobile friendly)
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

// ── Drive Upload Helper ────────────────────
// Uses OAuth (personal account) so uploads count against your own Drive quota,
// not the service account (which has none).
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
  // Make the file publicly readable so thumbnail/embed URLs work
  await drive.permissions.create({
    fileId: r.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return r.data.id;
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
// ACTION HANDLERS
// ══════════════════════════════════════════

async function handleAdminAuth(body, res) {
  if (body.password !== process.env.ADMIN_PASSWORD) return res.status(200).json({ error: 'unauthorized' });
  return res.json({ token: process.env.ADMIN_TOKEN });
}

// ── Read Handlers (public) ─────────────────
async function handleGetOrders(auth, res) {
  const { data } = await getSheetData(auth, 'Orders');
  return res.json({ values: data });
}

async function handleGetShopItems(auth, res) {
  // Read raw rows so we're not dependent on the exact header names in the sheet
  const rows = await sheetsRead(auth, 'CurrentShop!A1:F1000');
  if (!rows || rows.length < 2) return res.json({ values: [] });

  // Skip header row (row 0), map data rows by position
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
    const fileId = await uploadToDrive(
      body.base64, body.mimeType,
      body.fileName, process.env.DRIVE_FOLDER_RECEIPT
    );
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
  const fileId = await uploadToDrive(
    body.base64, body.mimeType,
    body.fileName, process.env.DRIVE_FOLDER_RECEIPT
  );
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
  const fileId = await uploadToDrive(
    body.base64, body.mimeType,
    body.fileName, process.env.DRIVE_FOLDER_PAYMENT
  );
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
  const fileId = await uploadToDrive(
    body.base64, body.mimeType,
    body.fileName, process.env.DRIVE_FOLDER_SA
  );
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ uploaded: ${fileId}`);

  console.log('🤖 calling Gemini for item extraction...');
  const prompt = `Extract all game item names from this shop image. Return ONLY a JSON array of strings like: ['Item Name 1', 'Item Name 2']. No descriptions, no prices, no markdown, no explanation.`;
  const text = await callGemini(body.base64, prompt);
  const clean = text.replace(/```json|```/g, '').trim();
  const names = JSON.parse(clean);
  const items = names.map((name, i) => ({
    id: i + 1, name, desc: '', p7: 0, p15: 0, p30: 0
  }));
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

// Standardization: Directly uses body.folder_id
async function handleUploadAccountImage(auth, body, res) {
  checkToken(body);
  const accountIGN = body.ign;
  console.log(`📤 uploadAccountImage: ${accountIGN}`);
  // Use OAuth drive client so folder creation is owned by your personal account
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });

  // find or create account subfolder
  let folderId;
  const search = await drive.files.list({
    q: `name='${accountIGN}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (search.data.files.length > 0) {
    folderId = search.data.files[0].id;
  } else {
    const folder = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: accountIGN,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.DRIVE_FOLDER_ACCOUNTS],
      },
      fields: 'id',
    });
    folderId = folder.data.id;
  }

  const fileId = await uploadToDrive(
    body.base64, body.mimeType, body.fileName, folderId
  );
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ uploaded: ${fileId} → ${url}`);
  return res.json({ url });
}

// Public version — no admin token required (for seller listings)
async function handleUploadPublicAccountImage(auth, body, res) {
  const accountIGN = body.ign;
  console.log(`📤 uploadPublicAccountImage: ${accountIGN}`);
  // Use OAuth drive client so folder/file is owned by your personal account
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });

  let folderId;
  const search = await drive.files.list({
    q: `name='${accountIGN}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (search.data.files.length > 0) {
    folderId = search.data.files[0].id;
  } else {
    const folder = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: accountIGN,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.DRIVE_FOLDER_ACCOUNTS],
      },
      fields: 'id',
    });
    folderId = folder.data.id;
  }

  const fileId = await uploadToDrive(
    body.base64, body.mimeType, body.fileName, folderId
  );
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ public upload: ${fileId} → ${url}`);
  return res.json({ url });
}

async function handleSaveAccount(auth, body, res) {
  if (!body.isNew) checkToken(body);
  const acc = body.account;

  // 1. Get current headers (sanitized to lowercase/no-space by your getSheetData)
  const { headers, data } = await getSheetData(auth, 'AccountList');

  // 2. AUTO MAPPING: Loop through headers and pull matching key from 'acc'
  // This ensures data always goes into the correct column regardless of order.
  const row = headers.map(h => {
    const key = h.toLowerCase().trim();
    // If the standardized key exists in 'acc', use it. Otherwise, empty string.
    return acc[key] !== undefined ? acc[key] : '';
  });

  // 3. Find row index by ID
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

// Standardization: Uses body.acc_id directly for both Sheet and Drive deletion
async function handleDeleteAccount(auth, body, res) {
  checkToken(body);
  const accountIGN = body.ign; 
  console.log(`🗑 deleteAccount: ${accountIGN}`);

  // 1. Find the row in Sheets
  const { data } = await getSheetData(auth, 'AccountList');
  // Use String() to ensure IDs match even if one is a number in the sheet
  const rowIdx = data.findIndex(r => String(r.id) === String(body.acc_id));
  if (rowIdx === -1) throw new Error('Account not found');

  // 2. Delete from Sheets (Uses Service Account 'auth')
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === 'AccountList');

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ 
        deleteDimension: { 
          range: { 
            sheetId: sheet.properties.sheetId, 
            dimension: 'ROWS', 
            startIndex: rowIdx + 1, 
            endIndex: rowIdx + 2 
          } 
        } 
      }]
    }
  });

  // 3. Delete from Drive (Uses OAuth 'getDriveAuth()')
  // Root Fix: You must use the same auth used to CREATE the folder to DELETE it
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  
  const search = await drive.files.list({
    q: `name='${accountIGN}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (search.data.files && search.data.files.length > 0) {
    await drive.files.delete({ 
      fileId: search.data.files[0].id, 
      supportsAllDrives: true 
    });
    console.log(`🗑 Drive folder deleted: ${accountIGN}`);
  }
  
  return res.json({ result: 'ok' });
}

async function handleUpdateAccountStatus(auth, body, res) {
  checkToken(body);

  // Extract ID and Status safely from body or body.account
  const accId = body.id || (body.account && body.account.id);
  const newStatus = body.status || (body.account && body.account.status);

  const { headers, data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(accId));

  if (rowIdx === -1) throw new Error('Account not found');

  const rowNum = rowIdx + 2;
  // Use the helper to find the exact column letter for 'status'
  const statusCol = colLetter(headers.indexOf('status'));

  await sheetsWrite(auth, `AccountList!${statusCol}${rowNum}`, [[newStatus]]);
  return res.json({ result: 'ok' });
}

async function handleUploadSlideImg(auth, body, res) {
  checkToken(body);
  let url = body.url;

  // If a base64 string is provided, upload it to Drive first
  if (body.base64) {
    console.log(`📤 uploadSlideImg: Uploading file to Drive for slide ${body.slideIndex}`);
    const fileId = await uploadToDrive(
      body.base64, 
      body.mimeType || 'image/jpeg', 
      body.fileName || `slide_${body.slideIndex}.jpg`, 
      process.env.DRIVE_FOLDER_SA // Using same folder as shop assets
    );
    url = driveUrl(fileId, body.mimeType);
  }

  if (!url) throw new Error("No URL or Base64 provided");

  console.log(`📝 uploadSlideImg: Updating Sheet for slide ${body.slideIndex}`);
  
  // Use the safe single-cell update method
  const col = body.slideIndex === 0 ? 'B' : 'C';
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

// ── initData — fetch everything at once ────
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
    // Get auth once, reuse everywhere
    const auth = await getAuth().getClient();

    // ── Public actions ──────────────────────
    if (action === 'adminAuth') return await handleAdminAuth(body, res);
    if (action === 'getOrders') return await handleGetOrders(auth, res);
    if (action === 'getShopItems') return await handleGetShopItems(auth, res);
    if (action === 'getAccounts') return await handleGetAccounts(auth, res);
    if (action === 'getSettings') return await handleGetSettings(auth, res);
    if (action === 'initData') return await handleInitData(auth, res);
    if (action === 'newOrder') return await handleNewOrder(auth, body, res);
    if (action === 'accountPurchase') return await handleAccountPurchase(auth, body, res);
    if (action === 'saveAccount' && body.isNew) return await handleSaveAccount(auth, body, res);
    if (action === 'uploadPublicAccountImage') return await handleUploadPublicAccountImage(auth, body, res);

    // ── Admin-only actions ──────────────────
    if (action === 'updateOrderStatus') return await handleUpdateOrderStatus(auth, body, res);
    if (action === 'uploadProofItem') return await handleUploadProofItem(auth, body, res);
    if (action === 'saveItems') return await handleSaveItems(auth, body, res);
    if (action === 'extractItems') return await handleExtractItems(auth, body, res);
    if (action === 'extractAccountStats') return await handleExtractAccountStats(body, res);
    if (action === 'uploadAccountImage') return await handleUploadAccountImage(auth, body, res);
    if (action === 'saveAccount') return await handleSaveAccount(auth, body, res);
    if (action === 'deleteAccount') return await handleDeleteAccount(auth, body, res);
    if (action === 'updateAccountStatus') return await handleUpdateAccountStatus(auth, body, res);
    if (action === 'uploadSlideImg') return await handleUploadSlideImg(auth, body, res);

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("❌ CRITICAL ERROR:", err); // This will show up in Vercel logs
    return res.status(500).json({ 
      error: "Internal Server Error", 
      details: err.message 
    });
  }
}
