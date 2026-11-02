import { google } from 'googleapis';
import crypto from 'crypto';
import { getDriveAuth, requireToken, signToken, verifyToken } from '../lib/auth.js';
import { findOrCreateFolder, driveUrl, extForMime, escapeDriveQuery } from '../lib/drive.js';
import { badRequest, notFound, cleanText } from '../lib/http.js';

/**
 * Browser -> Google Drive direct upload (bypasses Vercel's 4.5MB body limit).
 *
 *   1. getDirectUploadUrl  -> server validates type/size, creates a Drive resumable session
 *                             and returns { uploadUrl, sessionToken }.
 *   2. browser PUTs the file straight to uploadUrl.
 *   3. finalizeUpload      -> server verifies the signed sessionToken, finds the file,
 *                             checks its size, makes it viewable and returns the display URL.
 *
 * The sessionToken is HMAC-signed and expires, so the browser can no longer choose the
 * folder or file name (the old version trusted those from the client).
 */

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
];
const SESSION_TTL_MS = 15 * 60 * 1000;

export async function handleGetDirectUploadUrl(body, res) {
  const mimeType = String(body.mimeType || '');
  const fileSize = Number(body.fileSize);
  const context = String(body.folderContext || '');

  if (!ALLOWED_MIME_TYPES.includes(mimeType)) throw badRequest(`File type not allowed: ${mimeType || 'unknown'}`);
  if (!Number.isFinite(fileSize) || fileSize <= 0) throw badRequest('fileSize is required');
  if (fileSize > MAX_FILE_SIZE) throw badRequest('File too large (max 50MB)');

  // 'account' is the admin form; 'account_public' is the seller form. Nothing else is allowed.
  if (context === 'account') requireToken(body);
  else if (context !== 'account_public') throw badRequest('Invalid upload context');
  if (!process.env.DRIVE_FOLDER_ACCOUNTS) throw new Error('DRIVE_FOLDER_ACCOUNTS is not set');

  const oauthClient = getDriveAuth();
  const { token: accessToken } = await oauthClient.getAccessToken();
  const drive = google.drive({ version: 'v3', auth: oauthClient });
  const folderId = await findOrCreateFolder(drive, cleanText(body.ign, 40) || 'unknown', process.env.DRIVE_FOLDER_ACCOUNTS);

  // File name is chosen by the SERVER (the client-provided name is ignored).
  const fileName = `acc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${extForMime(mimeType)}`;

  const initResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(fileSize), // Drive rejects uploads that don't match this
        Origin: process.env.SITE_URL || 'https://suddenattack.safie.cc',
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

  const sessionToken = signToken({ folderId, fileName, mimeType, fileSize }, SESSION_TTL_MS);
  return res.json({ uploadUrl, sessionToken });
}

export async function handleFinalizeUpload(body, res) {
  const session = verifyToken(body.sessionToken); // throws 401 if forged/expired
  const { folderId, fileName, mimeType, fileSize } = session;

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });

  let file = null;
  for (let attempt = 0; attempt < 8 && !file; attempt++) {
    const search = await drive.files.list({
      q: `name='${escapeDriveQuery(fileName)}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id,size)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    file = search.data.files?.[0] || null;
    if (!file) await new Promise(r => setTimeout(r, 600));
  }
  if (!file) throw notFound('Uploaded file not found yet. Please try again.');

  // Verify what actually landed in Drive.
  if (Number(file.size) > MAX_FILE_SIZE || (fileSize && Number(file.size) !== Number(fileSize))) {
    await drive.files.delete({ fileId: file.id, supportsAllDrives: true }).catch(() => {});
    throw badRequest('Uploaded file size did not match. Please try again.');
  }

  // Listing media must be viewable by visitors.
  await drive.permissions.create({
    fileId: file.id,
    supportsAllDrives: true,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const url = driveUrl(file.id, mimeType);
  console.log(`✅ finalizeUpload: ${fileName} → ${file.id}`);
  return res.json({ url, fileId: file.id });
}
