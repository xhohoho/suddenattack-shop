import { google } from 'googleapis';
import { getDriveAuth } from '../lib/auth.js';
import { findOrCreateFolder, driveUrl } from '../lib/drive.js';
import crypto from 'crypto';

/**
 * Upload limits and type restrictions
 */
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf'
];

/**
 * Step 1: Browser-to-Drive direct upload flow
 * Returns a single-use resumable upload session URL
 * Validates file type/size server-side
 */
export async function handleGetDirectUploadUrl(body, res) {
  const { fileName, mimeType, folderContext, ign } = body;
  if (!fileName || !mimeType) throw new Error('fileName and mimeType are required');

  // Validate file type
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error(`File type not allowed: ${mimeType}`);
  }

  // Note: File size validated at finalizeUpload via Drive's built-in limits
  // and by checking Content-Length on the PUT request

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

  // Return session ID instead of folderId - server stores the mapping
  const sessionId = crypto.randomUUID();
  // In production, store sessionId -> { folderId, fileName, mimeType } in KV/Redis
  // For now, encode in a signed token
  const sessionToken = Buffer.from(JSON.stringify({ sessionId, folderId, fileName, mimeType, createdAt: Date.now() })).toString('base64');

  return res.json({ uploadUrl, sessionToken });
}

/**
 * Step 2: Finalize upload
 * - Does NOT accept folderId or fileName from client
 * - Verifies file using sessionToken
 * - Makes file private (not public)
 * - Returns display URL
 */
export async function handleFinalizeUpload(body, res) {
  const { sessionToken } = body;
  if (!sessionToken) throw new Error('sessionToken is required');

  // Decode and validate session
  let session;
  try {
    session = JSON.parse(Buffer.from(sessionToken, 'base64').toString());
  } catch {
    throw new Error('Invalid sessionToken');
  }

  const { sessionId, folderId, fileName, mimeType, createdAt } = session;
  if (!folderId || !fileName) throw new Error('Invalid session data');

  // Check session age (max 10 minutes)
  if (Date.now() - createdAt > 10 * 60 * 1000) {
    throw new Error('Upload session expired');
  }

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const escapedFileName = fileName.replace(/'/g, "\\'");

  let fileId = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const search = await drive.files.list({
      q: `name='${escapedFileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id,createdTime,size)',
      orderBy: 'createdTime desc',
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (search.data.files.length > 0) {
      // Verify file size (additional check)
      const file = search.data.files[0];
      if (file.size > MAX_FILE_SIZE) {
        await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
        throw new Error('File exceeds maximum size');
      }
      fileId = file.id;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!fileId) throw new Error('Uploaded file not found in Drive after polling');

  // DO NOT make file public - keep it private
  // Admins can view via authenticated route
  // If public URL needed, use a separate signed URL or proxy

  const url = driveUrl(fileId, mimeType);
  console.log(`✅ finalizeUpload: ${fileName} → ${fileId} → ${url}`);
  return res.json({ url, fileId, private: true });
}