import { google } from 'googleapis';
import { getSheetData, sheetsWrite, sheetsAppend, colLetter, sanitizeSheetValue } from '../lib/sheets.js';
import { uploadToDrive, driveUrl, findOrCreateFolder } from '../lib/drive.js';
import { getDriveAuth, requireToken, generateOrderToken } from '../lib/auth.js';
import crypto from 'crypto';

// Whitelist of fields returned to public callers
const PUBLIC_ACCOUNT_FIELDS = ['id', 'rank', 'price', 'ign', 'accid', 'kda', 'winRate', 'exp', 'ach', 'notes', 'status', 'img1', 'img2', 'img3', 'img4'];

// Allowed image URL patterns (Drive direct links)
const ALLOWED_IMAGE_URL_PATTERN = /^https:\/\/lh3\.googleusercontent\.com\/d\/[\w-]+$/;
const ALLOWED_DRIVE_PREVIEW_PATTERN = /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/preview$/;

export async function handleGetAccounts(auth, res) {
  const { data } = await getSheetData(auth, 'AccountList');
  // Return only whitelisted fields; hide seller info and pending listings
  const publicData = data
    .filter(row => row.status !== 'pending') // Hide pending from public
    .map(row => {
      const filtered = {};
      for (const field of PUBLIC_ACCOUNT_FIELDS) {
        filtered[field] = row[field];
      }
      return filtered;
    });
  return res.json({ values: publicData });
}

/**
 * Admin: save account (create or update)
 * - Requires admin token
 * - Whitelists fields, validates image URLs
 * - Cannot update existing row via public API
 */
export async function handleSaveAccount(auth, body, res) {
  requireToken(body);
  const acc = body.account;
  const { headers, data } = await getSheetData(auth, 'AccountList');

  // Whitelist allowed fields
  const allowedFields = ['id', 'rank', 'price', 'ign', 'accid', 'kda', 'winRate', 'exp', 'ach', 'notes', 'status', 'img1', 'img2', 'img3', 'img4', 'sellername', 'sellercontact', 'sellerign'];
  const row = headers.map(h => {
    const key = h.toLowerCase().trim();
    if (!allowedFields.includes(key)) return '';
    const val = acc[key];
    if (val === undefined) return '';
    // Validate image URLs
    if (['img1', 'img2', 'img3', 'img4'].includes(key) && val) {
      if (!ALLOWED_IMAGE_URL_PATTERN.test(val) && !ALLOWED_DRIVE_PREVIEW_PATTERN.test(val)) {
        return ''; // Reject invalid URLs
      }
    }
    return val !== undefined ? sanitizeSheetValue(val) : '';
  });

  const rowIdx = data.findIndex(r => String(r.id) === String(acc.id));
  if (rowIdx >= 0) {
    const rowNum = rowIdx + 2;
    const lastCol = colLetter(headers.length - 1);
    await sheetsWrite(auth, `AccountList!A${rowNum}:${lastCol}${rowNum}`, [row]);
  } else {
    await sheetsAppend(auth, 'AccountList!A1', [row]);
  }
  console.log(`✅ Account ${acc.id} saved`);
  return res.json({ result: 'ok' });
}

/**
 * Public: submit a new account listing (seller form)
 * - Server generates ID
 * - Forces status: 'pending'
 * - Only whitelisted fields accepted
 * - Validates image URLs
 * - Can NEVER update existing row
 */
export async function handleSubmitListing(auth, body, res) {
  const acc = body.account;
  if (!acc) return res.status(400).json({ error: 'Missing account data' });

  // Validate required fields
  const required = ['rank', 'price', 'ign', 'accid', 'sellername', 'sellercontact', 'sellerign'];
  for (const field of required) {
    if (!acc[field]) return res.status(400).json({ error: `Missing required field: ${field}` });
  }

  // Validate price
  const price = parseFloat(acc.price);
  if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'Invalid price' });

  // Validate image URLs
  for (let i = 1; i <= 4; i++) {
    const url = acc[`img${i}`];
    if (url && !ALLOWED_IMAGE_URL_PATTERN.test(url) && !ALLOWED_DRIVE_PREVIEW_PATTERN.test(url)) {
      return res.status(400).json({ error: `Invalid image URL format for img${i}` });
    }
  }

  // Server-generated ID
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  const { headers } = await getSheetData(auth, 'AccountList');
  const row = headers.map(h => {
    const key = h.toLowerCase().trim();
    switch (key) {
      case 'id': return id;
      case 'rank': return sanitizeSheetValue(acc.rank);
      case 'price': return price;
      case 'ign': return sanitizeSheetValue(acc.ign);
      case 'accid': return sanitizeSheetValue(acc.accid);
      case 'kda': return sanitizeSheetValue(acc.kda || '');
      case 'winrate': return sanitizeSheetValue(acc.winRate || '');
      case 'exp': return sanitizeSheetValue(acc.exp || '');
      case 'achievement': return sanitizeSheetValue(acc.ach || '');
      case 'notes': return sanitizeSheetValue(acc.notes || '');
      case 'status': return 'pending'; // Server forces
      case 'img1': return sanitizeSheetValue(acc.img1 || '');
      case 'img2': return sanitizeSheetValue(acc.img2 || '');
      case 'img3': return sanitizeSheetValue(acc.img3 || '');
      case 'img4': return sanitizeSheetValue(acc.img4 || '');
      case 'sellername': return sanitizeSheetValue(acc.sellername);
      case 'sellercontact': return sanitizeSheetValue(acc.sellercontact);
      case 'sellerign': return sanitizeSheetValue(acc.sellerign);
      case 'createdat': return createdAt;
      default: return '';
    }
  });

  await sheetsAppend(auth, 'AccountList!A1', [row]);
  console.log(`✅ Public listing submitted: ${id}`);
  return res.json({ result: 'ok', id });
}

export async function handleDeleteAccount(auth, body, res) {
  requireToken(body);
  const accountIGN = body.ign;
  console.log(`🗑 deleteAccount: ${accountIGN}`);
  const { data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(body.acc_id));
  if (rowIdx === -1) throw new Error('Account not found');

  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === 'AccountList');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIdx + 1, endIndex: rowIdx + 2 },
        },
      }],
    },
  });

  // Delete Drive folder for this IGN (store folderId in sheet in future)
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const escapedIGN = accountIGN.replace(/'/g, "\\'");
  const search = await drive.files.list({
    q: `name='${escapedIGN}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (search.data.files?.length > 0) {
    await drive.files.delete({ fileId: search.data.files[0].id, supportsAllDrives: true });
    console.log(`🗑 Drive folder deleted: ${accountIGN}`);
  }
  return res.json({ result: 'ok' });
}

export async function handleUpdateAccountStatus(auth, body, res) {
  requireToken(body);
  const accId = body.id || body.account?.id;
  const newStatus = body.status || body.account?.status;
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(accId));
  if (rowIdx === -1) throw new Error('Account not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `AccountList!${statusCol}${rowNum}`, [[newStatus]]);
  return res.json({ result: 'ok' });
}

/**
 * REMOVED: handleReserveAccount - folded into accountPurchase flow in orders.js
 */

export async function handleUploadAccountImage(auth, body, res) {
  requireToken(body);
  const accountIGN = body.ign;
  console.log(`📤 uploadAccountImage: ${accountIGN}`);
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const folderId = await findOrCreateFolder(drive, accountIGN, process.env.DRIVE_FOLDER_ACCOUNTS);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, folderId);
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ uploaded: ${fileId} → ${url}`);
  return res.json({ url });
}

/**
 * Public: upload image for account listing (seller form)
 * - Validates file size, type
 * - Returns Drive URL
 */
export async function handleUploadPublicAccountImage(auth, body, res) {
  const accountIGN = body.ign;
  console.log(`📤 uploadPublicAccountImage: ${accountIGN}`);

  // Validate file size (max 5MB) and type
  if (!body.base64) return res.status(400).json({ error: 'No file data' });
  const base64Size = body.base64.length * 0.75; // approximate bytes
  if (base64Size > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 5MB)' });

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (body.mimeType && !allowedTypes.includes(body.mimeType)) {
    return res.status(400).json({ error: 'Invalid file type' });
  }

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const folderId = await findOrCreateFolder(drive, accountIGN, process.env.DRIVE_FOLDER_ACCOUNTS);
  const fileId = await uploadToDrive(body.base64, body.mimeType || 'image/jpeg', body.fileName || `acc_${Date.now()}.jpg`, folderId);
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ public upload: ${fileId} → ${url}`);
  return res.json({ url });
}