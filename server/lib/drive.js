import { google } from 'googleapis';
import { getDriveAuth } from './auth.js';
import { badRequest } from './http.js';

/** Returns the public display URL for a Drive file. */
export function driveUrl(fileId, mimeType = '') {
  if (String(mimeType).includes('video')) return `https://drive.google.com/file/d/${fileId}/preview`;
  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

/** Escape a value for use inside a single-quoted Drive `q` query (backslash FIRST, then quote). */
export function escapeDriveQuery(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Make a user-supplied name safe to use as a Drive folder name. */
export function safeFolderName(name, fallback = 'unknown') {
  const s = String(name ?? '').replace(/[\\/'"`<>:*?|\u0000-\u001F]/g, '').trim().slice(0, 40);
  return s || fallback;
}

// ── File type checks (don't trust the browser-supplied mime type) ───────────

/** Detect the real type from the first bytes. Returns a mime string or null. */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
export function extForMime(mime) { return EXT[mime] || 'bin'; }

/**
 * Decode + validate an uploaded base64 file.
 * Returns { buffer, mimeType } where mimeType is the REAL detected type.
 */
export function decodeUpload(base64, allowedMimes, maxBytes) {
  if (!base64 || typeof base64 !== 'string') throw badRequest('No file data');
  const clean = base64.includes(',') ? base64.split(',').pop() : base64;
  if (clean.length * 0.75 > maxBytes * 1.05) throw badRequest(`File too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
  const buffer = Buffer.from(clean, 'base64');
  if (buffer.length > maxBytes) throw badRequest(`File too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
  const mimeType = sniffMime(buffer);
  if (!mimeType || !allowedMimes.includes(mimeType)) throw badRequest('Unsupported file type');
  return { buffer, mimeType };
}

// ── Drive operations ─────────────────────────────────────────────────────────

/**
 * Uploads a base64-encoded file to Drive and makes it readable by link.
 * Returns the file ID.
 *
 * NOTE: the Orders sheet shows proofs with =IMAGE(url), which needs the file to be
 * link-readable. File IDs are unguessable, but treat proof links as semi-private.
 */
export async function uploadToDrive(base64, mimeType, fileName, folderId) {
  const auth = getDriveAuth();
  const drive = google.drive({ version: 'v3', auth });
  const buffer = Buffer.isBuffer(base64) ? base64 : Buffer.from(base64, 'base64');
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
    supportsAllDrives: true,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return r.data.id;
}

/**
 * Finds a named subfolder inside a parent Drive folder, or creates it.
 * Returns the folder's file ID.
 */
export async function findOrCreateFolder(drive, folderName, parentId) {
  const name = safeFolderName(folderName);
  const search = await drive.files.list({
    q: `name='${escapeDriveQuery(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (search.data.files.length > 0) return search.data.files[0].id;

  const folder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return folder.data.id;
}
