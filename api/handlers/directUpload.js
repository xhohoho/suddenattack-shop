import { google } from 'googleapis';
import { getDriveAuth } from '../lib/auth.js';
import { findOrCreateFolder, driveUrl } from '../lib/drive.js';

/**
 * Step 1 of the browser-to-Drive direct upload flow.
 * Returns a single-use resumable upload session URL so the browser can PUT
 * the file straight to Google Drive, bypassing Vercel's 4.5 MB body limit.
 */
export async function handleGetDirectUploadUrl(body, res) {
  const { fileName, mimeType, folderContext, ign } = body;
  if (!fileName || !mimeType) throw new Error('fileName and mimeType are required');

  const oauthClient = getDriveAuth();
  const { credentials } = await oauthClient.refreshAccessToken();
  const accessToken = credentials.access_token;
  const drive = google.drive({ version: 'v3', auth: oauthClient });

  let folderId;
  if (folderContext === 'account' || folderContext === 'account_public') {
    folderId = await findOrCreateFolder(drive, ign || 'unknown', process.env.DRIVE_FOLDER_ACCOUNTS);
  } else if (folderContext === 'receipt') {
    folderId = process.env.DRIVE_FOLDER_RECEIPT;
  } else if (folderContext === 'payment') {
    folderId = process.env.DRIVE_FOLDER_PAYMENT;
  } else {
    folderId = process.env.DRIVE_FOLDER_SA;
  }

  const initResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
        Origin: 'https://suddenattack.safie.cc',
      },
      body: JSON.stringify({ name: fileName, parents: [folderId] }),
    },
  );

  if (!initResp.ok) {
    const err = await initResp.text();
    throw new Error(`Drive resumable init failed: ${err}`);
  }

  const uploadUrl = initResp.headers.get('location');
  if (!uploadUrl) throw new Error('No upload URL returned from Drive');

  return res.json({ uploadUrl, folderId, fileName, mimeType });
}

/**
 * Step 2 of the direct upload flow.
 * Polls Drive for the newly uploaded file, makes it public, and returns the display URL.
 */
export async function handleFinalizeUpload(body, res) {
  const { fileName, mimeType, folderId } = body;
  if (!fileName || !folderId) throw new Error('fileName and folderId are required');

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const escapedFileName = fileName.replace(/'/g, "\\'");

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
    await new Promise(r => setTimeout(r, 500));
  }

  if (!fileId) throw new Error('Uploaded file not found in Drive after polling');

  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const url = driveUrl(fileId, mimeType);
  console.log(`✅ finalizeUpload: ${fileName} → ${fileId} → ${url}`);
  return res.json({ url, fileId });
}
