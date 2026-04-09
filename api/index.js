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
      throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}`);
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
    throw new Error('Missing OAuth env vars');
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

async function handleGetOrders(auth, res) {
  const { data } = await getSheetData(auth, 'Orders');
  return res.json({ values: data });
}

async function handleGetShopItems(auth, res) {
  const rows = await sheetsRead(auth, 'CurrentShop!A1:F1000');
  if (!rows || rows.length < 2) return res.json({ values: [] });
  const data = rows.slice(1).filter(row => row.some(cell => cell !== '')).map((row, i) => ({
    id: row[0] || String(i + 1),
    name: row[1] || '',
    desc: row[2] || '',
    p7: row[3] || '',
    p15: row[4] || '',
    p30: row[5] || '',
  })).filter(it => it.name);
  return res.json({ values: data });
}

async function handleGetAccounts(auth, res) {
  const { data } = await getSheetData(auth, 'AccountList');
  return res.json({ values: data });
}

async function handleUpdateOrderStatus(auth, body, res) {
  checkToken(body);
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
  const row = [body.order_id, kl, body.name, body.phone || '', body.email || '', body.items, body.total, body.note || '', body.status || 'New', proofFormula];
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
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_RECEIPT);
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const statusCol = colLetter(headers.indexOf('status'));
  const proofCol = colLetter(headers.indexOf('proof'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowIdx + 2}:${proofCol}${rowIdx + 2}`, [['Paid', proofFormula]]);
  return res.json({ result: 'ok' });
}

async function handleAccountPurchase(auth, body, res) {
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_PAYMENT);
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  const kl = new Date(body.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });
  const row = [body.order_id, kl, body.name, body.phone || '', body.email || '', body.items, body.total, body.note || '', 'Paid', proofFormula];
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
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_SA);
  const url = driveUrl(fileId, body.mimeType);
  const prompt = `Extract all game item names from this shop image. Return ONLY a JSON array of strings.`;
  const text = await callGemini(body.base64, prompt);
  const names = JSON.parse(text.replace(/```json|```/g, '').trim());
  const items = names.map((name, i) => ({ id: i + 1, name, desc: '', p7: 0, p15: 0, p30: 0 }));
  return res.json({ items, url });
}

async function handleExtractAccountStats(body, res) {
  checkToken(body);
  const prompt = `Extract player stats from this Sudden Attack game profile screenshot. Return ONLY JSON object with keys: ign, accId, kda, winRate, exp.`;
  const text = await callGemini(body.base64, prompt);
  const stats = JSON.parse(text.replace(/```json|```/g, '').trim());
  return res.json(stats);
}

// Standardization: Directly uses body.folder_id
async function handleUploadAccountImage(auth, body, res) {
  checkToken(body);
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  let folderId;
  const search = await drive.files.list({
    q: `name='${body.folder_id}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (search.data.files.length > 0) {
    folderId = search.data.files[0].id;
  } else {
    const folder = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: body.folder_id,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.DRIVE_FOLDER_ACCOUNTS],
      },
      fields: 'id',
    });
    folderId = folder.data.id;
  }

  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, folderId);
  return res.json({ url: driveUrl(fileId, body.mimeType) });
}

async function handleUploadPublicAccountImage(auth, body, res) {
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  let folderId;
  const search = await drive.files.list({
    q: `name='${body.folder_id}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (search.data.files.length > 0) {
    folderId = search.data.files[0].id;
  } else {
    const folder = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: body.folder_id,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.DRIVE_FOLDER_ACCOUNTS],
      },
      fields: 'id',
    });
    folderId = folder.data.id;
  }

  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, folderId);
  return res.json({ url: driveUrl(fileId, body.mimeType) });
}

// Standardization: acc.id is already the clean ID from frontend
async function handleSaveAccount(auth, body, res) {
  if (!body.isNew) checkToken(body);
  const acc = body.account;
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const row = headers.map(h => acc[h.toLowerCase().trim()] !== undefined ? acc[h.toLowerCase().trim()] : '');
  const rowIdx = data.findIndex(r => String(r.id) === String(acc.id));

  if (rowIdx >= 0) {
    const lastCol = colLetter(headers.length - 1);
    await sheetsWrite(auth, `AccountList!A${rowIdx + 2}:${lastCol}${rowIdx + 2}`, [row]);
  } else {
    await sheetsAppend(auth, 'AccountList!A1', [row]);
  }
  return res.json({ result: 'ok' });
}

// Standardization: Uses body.acc_id directly for both Sheet and Drive deletion
async function handleDeleteAccount(auth, body, res) {
  checkToken(body);
  const accId = body.acc_id;
  const { data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(accId));
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
    q: `name='${accId}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (search.data.files && search.data.files.length > 0) {
    await drive.files.delete({ fileId: search.data.files[0].id, supportsAllDrives: true });
  }
  return res.json({ result: 'ok' });
}

async function handleUpdateAccountStatus(auth, body, res) {
  //checkToken(body);
  const accId = body.id || (body.account && body.account.id);
  const newStatus = body.status || (body.account && body.account.status);
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(accId));
  if (rowIdx === -1) throw new Error('Account not found');
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `AccountList!${statusCol}${rowIdx + 2}`, [[newStatus]]);
  return res.json({ result: 'ok' });
}

async function handleUploadSlideImg(auth, body, res) {
  checkToken(body);
  const existing = await sheetsRead(auth, 'Settings!A2:C2');
  const currentRow = existing[0] || ['slideshow', '', ''];
  if (body.slideIndex === 0) currentRow[1] = body.url || '';
  if (body.slideIndex === 1) currentRow[2] = body.url || '';
  await sheetsWrite(auth, 'Settings!A2:C2', [currentRow]);
  return res.json({ result: 'ok' });
}

async function handleGetSettings(auth, res) {
  const { data } = await getSheetData(auth, 'Settings');
  const row = data.find(r => r.key === 'slideshow');
  return res.json({ slides: row ? [row.slide1, row.slide2] : ['', ''] });
}

async function handleInitData(auth, res) {
  const [ordersResult, itemsResult, settingsRaw] = await Promise.all([
    getSheetData(auth, 'Orders'),
    getSheetData(auth, 'CurrentShop'),
    sheetsRead(auth, 'Settings!B2:C2'),
  ]);
  return res.json({ orders: ordersResult.data, items: itemsResult.data, slides: settingsRaw[0] || ['', ''] });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const body = req.body;
  const { action } = body;
  try {
    const auth = await getAuth().getClient();
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
    return res.status(500).json({ error: err.message });
  }
}
