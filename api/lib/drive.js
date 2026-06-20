import { google } from 'googleapis';
import { getDriveAuth } from './auth.js';

/** Returns the public display URL for a Drive file. */
export function driveUrl(fileId, mimeType = '') {
  if (mimeType.includes('video')) return `https://drive.google.com/file/d/${fileId}/preview`;
  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

/**
 * Uploads a base64-encoded file to Drive and makes it publicly readable.
 * Returns the file ID.
 */
export async function uploadToDrive(base64, mimeType, fileName, folderId) {
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

/**
 * Finds a named subfolder inside a parent Drive folder, or creates it.
 * Returns the folder's file ID.
 */
export async function findOrCreateFolder(drive, folderName, parentId) {
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
