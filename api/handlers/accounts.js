import { google } from 'googleapis';
import { getSheetData, sheetsWrite, sheetsAppend, colLetter, sanitizeSheetValue } from '../lib/sheets.js';
import { uploadToDrive, driveUrl, findOrCreateFolder } from '../lib/drive.js';
import { getDriveAuth, requireToken } from '../lib/auth.js';

export async function handleGetAccounts(auth, res) {
  const { data } = await getSheetData(auth, 'AccountList');
  return res.json({ values: data });
}

export async function handleSaveAccount(auth, body, res) {
  if (!body.isNew) requireToken(body);
  const acc = body.account;
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const row = headers.map(h => {
    const key = h.toLowerCase().trim();
    return acc[key] !== undefined ? sanitizeSheetValue(acc[key]) : '';
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

  // Delete Drive folder for this IGN
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

export async function handleUploadPublicAccountImage(auth, body, res) {
  const accountIGN = body.ign;
  console.log(`📤 uploadPublicAccountImage: ${accountIGN}`);
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const folderId = await findOrCreateFolder(drive, accountIGN, process.env.DRIVE_FOLDER_ACCOUNTS);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, folderId);
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ public upload: ${fileId} → ${url}`);
  return res.json({ url });
}
