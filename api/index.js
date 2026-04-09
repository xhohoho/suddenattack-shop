import { google } from 'googleapis';

// ── Auth ───────────────────────────────────
function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

function checkToken(body) {
  if (!body._token || body._token !== process.env.ADMIN_TOKEN) {
    throw new Error('Unauthorized');
  }
}

const SHEET_ID = process.env.SHEET_ID;

// ── Sheet Helper ───────────────────────────
async function getSheetData(sheetName) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${sheetName}?key=${process.env.SHEETS_API_KEY}`
  );
  const d = await r.json();
  if (!d.values || d.values.length < 2) return { headers: [], data: [] };

  const [headers, ...rows] = d.values;
  const data = rows
    .filter(row => row.some(cell => cell !== ''))
    .map(row =>
      Object.fromEntries(headers.map((key, i) => [key.toLowerCase().trim().replace(/\s+/g, ''), row[i] || '']))
    );

  return { headers, data };
}

// ── Column Letter Helper ───────────────────
// converts index to sheet column letter: 0=A, 1=B, 25=Z, 26=AA
function colLetter(idx) {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

// ── Drive URL Builder ──────────────────────
// one function for all Drive URLs — consistent across entire codebase
function driveUrl(fileId, mimeType = '') {
  const isVideo = mimeType.includes('video');
  const isGif   = mimeType.includes('gif');

  if (isVideo) {
    // videos → Google's iframe embed player (no CORS issues)
    return `https://drive.google.com/file/d/${fileId}/preview`;
  }

  if (isGif) {
    // GIFs → must use export=view to preserve animation
    // thumbnail URL kills the animation
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  }

  // all other images → thumbnail (fast, resizable, mobile friendly)
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
}

// ── Sheet Read/Write Helpers ───────────────
async function sheetsRead(auth, range) {
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
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
async function uploadToDrive(auth, base64, mimeType, fileName, folderId) {
  const drive = google.drive({ version: 'v3', auth });
  const buffer = Buffer.from(base64, 'base64');
  const { Readable } = await import('stream');
  const stream = Readable.from(buffer);
  const r = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: stream },
    fields: 'id',
  });
  return r.data.id;
}

// ── Gemini Helper ──────────────────────────
async function callGemini(base64, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } }
        ]
      }]
    })
  });
  const d = await r.json();
  return d.candidates[0].content.parts[0].text;
}

// ══════════════════════════════════════════
// ACTION HANDLERS
// ══════════════════════════════════════════

async function handleAdminAuth(body, res) {
  if (body.password !== process.env.ADMIN_PASSWORD) {
    return res.status(200).json({ error: 'unauthorized' });
  }
  return res.json({ token: process.env.ADMIN_TOKEN });
}

// ── Read Handlers (public) ─────────────────
async function handleGetOrders(res) {
  const { data } = await getSheetData('Orders');
  return res.json({ values: data });
}

async function handleGetShopItems(res) {
  const { data } = await getSheetData('CurrentShop');
  return res.json({ values: data });
}

async function handleGetAccounts(res) {
  const { data } = await getSheetData('AccountList');
  return res.json({ values: data });
}

// ── Order Handlers ─────────────────────────
async function handleUpdateOrderStatus(auth, body, res) {
  checkToken(body);
  console.log(`📝 updateOrderStatus: ${body.order_id} → ${body.status}`);

  const { headers, data } = await getSheetData('Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');

  const rowNum    = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}`, [[body.status]]);
  console.log(`✅ order ${body.order_id} updated to ${body.status}`);
  return res.json({ result: 'ok' });
}

async function handleNewOrder(auth, body, res) {
  console.log(`🛒 newOrder: ${body.order_id} from ${body.name}`);
  let proofFormula = '';
  if (body.base64) {
    const fileId = await uploadToDrive(
      auth, body.base64, body.mimeType,
      body.fileName, process.env.DRIVE_FOLDER_RECEIPT
    );
    proofFormula = body.mimeType === 'application/pdf'
      ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
      : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
    console.log(`📎 proof uploaded: ${fileId}`);
  }

  const kl  = new Date(body.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });
  const row = [
    body.order_id, kl, body.name, body.phone || '',
    body.email || '', body.items, body.total,
    body.note || '', body.status || 'New', proofFormula
  ];

  const { data } = await getSheetData('Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx >= 0) {
    const rowNum = rowIdx + 2;
    await sheetsWrite(auth, `Orders!A${rowNum}:Z${rowNum}`, [row]);
  } else {
    await sheetsAppend(auth, 'Orders!A1', [row]);
  }
  console.log(`✅ order ${body.order_id} saved`);
  return res.json({ result: 'ok' });
}

async function handleUploadProofItem(auth, body, res) {
  console.log(`📤 uploadProofItem: ${body.order_id}`);
  const fileId = await uploadToDrive(
    auth, body.base64, body.mimeType,
    body.fileName, process.env.DRIVE_FOLDER_RECEIPT
  );
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;

  const { headers, data } = await getSheetData('Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum    = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  const proofCol  = colLetter(headers.indexOf('proof'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}:${proofCol}${rowNum}`, [['Paid', proofFormula]]);
  console.log(`✅ proof uploaded for ${body.order_id}`);
  return res.json({ result: 'ok' });
}

async function handleAccountPurchase(auth, body, res) {
  console.log(`💰 accountPurchase: ${body.order_id}`);
  const fileId = await uploadToDrive(
    auth, body.base64, body.mimeType,
    body.fileName, process.env.DRIVE_FOLDER_PAYMENT
  );
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  const kl  = new Date(body.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });
  const row = [
    body.order_id, kl, body.name, body.phone || '',
    body.email || '', body.items, body.total,
    body.note || '', 'Paid', proofFormula
  ];
  await sheetsAppend(auth, 'Orders!A1', [row]);
  console.log(`✅ account purchase logged: ${body.order_id}`);
  return res.json({ result: 'ok' });
}

// ── Shop Item Handlers ─────────────────────
async function handleSaveItems(auth, body, res) {
  checkToken(body);
  console.log(`💾 saveItems: ${body.items.length} items`);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'CurrentShop!A2:Z1000',
  });
  const rows = body.items.map(it => [
    it.id, it.name, it.desc || '',
    it.p[7] || '', it.p[15] || '', it.p[30] || ''
  ]);
  await sheetsAppend(auth, 'CurrentShop!A2', rows);
  console.log(`✅ saved ${rows.length} items`);
  return res.json({ result: 'ok' });
}

async function handleExtractItems(auth, body, res) {
  checkToken(body);
  console.log('🖼 extractItems: uploading image to Drive...');
  const fileId = await uploadToDrive(
    auth, body.base64, body.mimeType,
    body.fileName, process.env.DRIVE_FOLDER_SA
  );
  const url = driveUrl(fileId, body.mimeType); // ← consistent
  console.log(`✅ uploaded: ${fileId}`);

  console.log('🤖 calling Gemini for item extraction...');
  const prompt = `Extract all game item names from this shop image. Return ONLY a JSON array of strings like: ['Item Name 1', 'Item Name 2']. No descriptions, no prices, no markdown, no explanation.`;
  const text  = await callGemini(body.base64, prompt);
  const clean = text.replace(/```json|```/g, '').trim();
  const names = JSON.parse(clean);
  const items = names.map((name, i) => ({
    id: i + 1, name, desc: '', p7: 0, p15: 0, p30: 0
  }));
  console.log(`✅ Gemini extracted ${items.length} items`);
  return res.json({ items, url });
}

// ── Account Handlers ───────────────────────
async function handleExtractAccountStats(body, res) {
  checkToken(body);
  console.log('🤖 extractAccountStats: calling Gemini...');
  const prompt = `Extract player stats from this Sudden Attack game profile screenshot. Return ONLY a valid JSON object with these exact keys: ign, accId, kda, winRate, exp. If a field is not visible return empty string. No markdown, no explanation, only JSON.`;
  const text  = await callGemini(body.base64, prompt);
  const clean = text.replace(/```json|```/g, '').trim();
  let stats = {};
  try { stats = JSON.parse(clean); } catch (e) {}
  console.log(`✅ stats extracted: ${JSON.stringify(stats)}`);
  return res.json(stats);
}

async function handleUploadAccountImage(auth, body, res) {
  checkToken(body);
  console.log(`📤 uploadAccountImage: ${body.fileName}`);
  const drive = google.drive({ version: 'v3', auth });

  // find or create account subfolder
  let folderId;
  const search = await drive.files.list({
    q: `name='${body.folder_id}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });
  if (search.data.files.length > 0) {
    folderId = search.data.files[0].id;
    console.log(`📁 found existing folder: ${folderId}`);
  } else {
    const folder = await drive.files.create({
      requestBody: {
        name: body.folder_id,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.DRIVE_FOLDER_ACCOUNTS],
      },
      fields: 'id',
    });
    folderId = folder.data.id;
    console.log(`📁 created new folder: ${folderId}`);
  }

  const fileId = await uploadToDrive(
    auth, body.base64, body.mimeType, body.fileName, folderId
  );
  const url = driveUrl(fileId, body.mimeType); // ← consistent
  console.log(`✅ uploaded: ${fileId} → ${url}`);
  return res.json({ url });
}

async function handleSaveAccount(auth, body, res) {
  checkToken(body);
  const acc = body.account;
  console.log(`💾 saveAccount: ${acc.id} ${acc.rank}`);

  const { data } = await getSheetData('AccountList');
  const rowIdx = data.findIndex(r => r.id === acc.id);
  // handleSaveAccount — add seller fields to the row
  const row = [
    acc.id, acc.rank, acc.price, acc.ign, acc.accId,
    acc.kda, acc.winRate, acc.exp, acc.ach, acc.notes,
    acc.status, acc.createdAt,
    acc.img1 || '', acc.img2 || '', acc.img3 || '', acc.img4 || '',
    acc.sellerName || '', acc.sellerPhone || '', acc.sellerIgn || ''  // ✅ add these
  ];
  if (rowIdx >= 0) {
    const rowNum = rowIdx + 2;
    await sheetsWrite(auth, `AccountList!A${rowNum}:Z${rowNum}`, [row]);
    console.log(`✅ updated account row ${rowNum}`);
  } else {
    await sheetsAppend(auth, 'AccountList!A1', [row]);
    console.log(`✅ appended new account`);
  }
  return res.json({ result: 'ok' });
}

async function handleDeleteAccount(auth, body, res) {
  checkToken(body);
  console.log(`🗑 deleteAccount: ${body.acc_id}`);

  const { data } = await getSheetData('AccountList');
  const rowIdx = data.findIndex(r => r.id === body.acc_id);
  if (rowIdx === -1) throw new Error('Account not found');
  const rowNum = rowIdx + 2;

  // get sheetId dynamically — no hardcoded gid
  const sheets = google.sheets({ version: 'v4', auth });
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet  = meta.data.sheets.find(s => s.properties.title === 'AccountList');
  const sheetGid = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetGid,
            dimension: 'ROWS',
            startIndex: rowNum - 1,
            endIndex: rowNum,
          }
        }
      }]
    }
  });

  // delete Drive folder for this account
  const drive  = google.drive({ version: 'v3', auth });
  const search = await drive.files.list({
    q: `name='${body.acc_id}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });
  if (search.data.files.length > 0) {
    await drive.files.delete({ fileId: search.data.files[0].id });
    console.log(`🗑 Drive folder deleted`);
  }
  console.log(`✅ account ${body.acc_id} deleted`);
  return res.json({ result: 'ok' });
}

async function handleUpdateAccountStatus(auth, body, res) {
  checkToken(body);
  console.log(`📝 updateAccountStatus: ${body.account.id} → ${body.account.status}`);

  const { headers, data } = await getSheetData('AccountList');
  const rowIdx = data.findIndex(r => r.id === body.account.id);
  if (rowIdx === -1) throw new Error('Account not found');
  const rowNum    = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `AccountList!${statusCol}${rowNum}`, [[body.account.status]]);
  console.log(`✅ status updated`);
  return res.json({ result: 'ok' });
}

// ── Slideshow Handler ──────────────────────
async function handleUploadSlideImg(auth, body, res) {
  checkToken(body);
  console.log(`🖼 uploadSlideImg: slide ${body.slideIndex}`);
  const existing   = await sheetsRead(auth, 'Settings!A2:C2');
  const currentRow = existing[0] || ['slideshow', '', ''];
  if (body.slideIndex === 0) currentRow[1] = body.url || '';
  if (body.slideIndex === 1) currentRow[2] = body.url || '';
  await sheetsWrite(auth, 'Settings!A2:C2', [currentRow]);
  console.log(`✅ slide ${body.slideIndex} updated`);
  return res.json({ result: 'ok' });
}

async function handleGetSettings(res) {
  // We use SheetsRead (which uses auth) to get the slide URLs
  const auth = await getAuth().getClient();
  const rows = await sheetsRead(auth, 'Settings!B2:C2');
  const settings = rows[0] || ['', ''];
  return res.json({ slides: settings });
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

  const body     = req.body;
  const { action } = body;
  console.log(`\n▶ action: ${action} — ${new Date().toISOString()}`);

  try {
    // ── Public actions (no Google auth needed) ──
    if (action === 'adminAuth')    return await handleAdminAuth(body, res);
    if (action === 'getOrders')    return await handleGetOrders(res);
    if (action === 'getShopItems') return await handleGetShopItems(res);
    if (action === 'getAccounts')  return await handleGetAccounts(res);
	if (action === 'getSettings')  return await handleGetSettings(res);

    // ── Protected actions (Google auth required) ──
    const auth = await getAuth().getClient();

    if (action === 'updateOrderStatus')   return await handleUpdateOrderStatus(auth, body, res);
    if (action === 'newOrder')            return await handleNewOrder(auth, body, res);
    if (action === 'uploadProofItem')     return await handleUploadProofItem(auth, body, res);
    if (action === 'accountPurchase')     return await handleAccountPurchase(auth, body, res);
    if (action === 'saveItems')           return await handleSaveItems(auth, body, res);
    if (action === 'extractItems')        return await handleExtractItems(auth, body, res);
    if (action === 'extractAccountStats') return await handleExtractAccountStats(body, res);
    if (action === 'uploadAccountImage')  return await handleUploadAccountImage(auth, body, res);
    if (action === 'saveAccount')         return await handleSaveAccount(auth, body, res);
    if (action === 'deleteAccount')       return await handleDeleteAccount(auth, body, res);
    if (action === 'updateAccountStatus') return await handleUpdateAccountStatus(auth, body, res);
    if (action === 'uploadSlideImg')      return await handleUploadSlideImg(auth, body, res);

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error(`❌ action=${action} failed:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
