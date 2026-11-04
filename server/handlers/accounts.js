import { google } from 'googleapis';
import {
  getSheetData, sheetsWrite, sheetsWriteBatch, sheetsAppend, colLetter, sanitizeSheetValue, publicRow, invalidateCache,
} from '../lib/sheets.js';
import {
  uploadToDrive, driveUrl, findOrCreateFolder, decodeUpload, extForMime, escapeDriveQuery, safeFolderName,
} from '../lib/drive.js';
import { getDriveAuth, requireToken } from '../lib/auth.js';
import { badRequest, notFound, conflict, cleanText, requiredText } from '../lib/http.js';
import crypto from 'crypto';

// 30 minutes in milliseconds
const RESERVATION_TTL_MS = 30 * 60 * 1000;
let _lastReleaseCheck = 0; // the public list only re-checks for stale reservations once a minute (saves Sheets reads)

// Turnstile verification
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) return true; // not configured, skip verification
  if (!token) return false;
  try {
    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token }),
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    console.error('Turnstile verification error:', e.message);
    return false;
  }
}

// Column keys are the sheet headers, lower-cased with spaces removed (see getSheetData).
// NOTE: they must be lowercase: `winrate`, `achievement`, `createdat` (NOT winRate / ach).
// Seller name / contact / ign are intentionally NOT public.
const PUBLIC_ACCOUNT_FIELDS = [
  'id', 'rank', 'price', 'ign', 'accid', 'kda', 'winrate', 'exp', 'achievement',
  'notes', 'status', 'createdat', 'img1', 'img2', 'img3', 'img4',
];

const STATUSES = ['pending', 'available', 'reserved', 'sold'];

/**
 * Releases accounts that have been stuck in 'reserved' status for >30 minutes.
 * Called lazily on relevant reads/writes — no cron needed.
 */
export async function releaseStaleReservations(auth) {
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const statusIdx = headers.indexOf('status');
  const reservedAtIdx = headers.indexOf('reserved_at');
  if (statusIdx < 0) return; // no status column, nothing to do

  const now = Date.now();
  const updates = [];

  for (const acc of data) {
    if (String(acc.status).trim().toLowerCase() !== 'reserved') continue;
    const reservedAt = reservedAtIdx >= 0 ? Number(acc.reserved_at) : 0;
    if (reservedAt && now - reservedAt > RESERVATION_TTL_MS) {
      updates.push({
        range: `AccountList!${colLetter(statusIdx)}${acc._row}`,
        values: [['available']],
      });
      // Also clear reserved_at
      if (reservedAtIdx >= 0) {
        updates.push({
          range: `AccountList!${colLetter(reservedAtIdx)}${acc._row}`,
          values: [['']],
        });
      }
    }
  }

  if (updates.length) {
    await sheetsWriteBatch(auth, updates);
    console.log(`🔓 Released ${updates.length / (reservedAtIdx >= 0 ? 2 : 1)} stale reservation(s)`);
  }
}

// Only these media URL shapes may ever be stored (they are later put into HTML, so this also blocks XSS).
// Accepts the formats already in your sheet, e.g. ...googleusercontent.com/d/ID=w1200 and drive.google.com/uc?export=download&id=ID
const MEDIA_URL = /^https:\/\/(?:lh3\.googleusercontent\.com\/d\/[\w-]+(?:=[\w-]+)?|drive\.google\.com\/(?:file\/d\/[\w-]+\/(?:preview|view)|uc\?export=(?:download|view)&id=[\w-]+(?:&confirm=t)?))$/;

function cleanMediaUrl(val, label) {
  const u = String(val ?? '').trim();
  if (!u) return '';
  if (!MEDIA_URL.test(u)) throw badRequest(`Invalid media URL for ${label}`);
  return u;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ── Reads ────────────────────────────────────────────────────────────────────

export async function handleGetAccounts(auth, res, isAdmin = false) {
  // Release stale reservations on every relevant read
  if (Date.now() - _lastReleaseCheck > 60_000) {
    _lastReleaseCheck = Date.now();
    await releaseStaleReservations(auth);
  }

  const { data } = await getSheetData(auth, 'AccountList', { ttl: 5000 });
  if (isAdmin) return res.json({ values: data.map(r => publicRow(r)) });
  const visible = data
    .filter(r => String(r.status).trim().toLowerCase() !== 'pending') // pending listings are admin-only
    .map(r => publicRow(r, PUBLIC_ACCOUNT_FIELDS));
  return res.json({ values: visible });
}

// ── Admin: create / update an account ────────────────────────────────────────

export async function handleSaveAccount(auth, body, res) {
  requireToken(body);
  const acc = body.account;
  if (!acc || typeof acc !== 'object') throw badRequest('Missing account data');

  const id = requiredText(acc.id, 'id', 80);
  const price = Number(acc.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) throw badRequest('Invalid price');
  const status = String(acc.status || 'available').toLowerCase().trim();
  if (!STATUSES.includes(status)) throw badRequest('Invalid status');

  const { headers, data } = await getSheetData(auth, 'AccountList'); // fresh read
  const existing = data.find(r => String(r.id) === id);
  if (body.isNew && existing) throw conflict('An account with this ID already exists');
  if (!body.isNew && !existing) throw notFound('Account not found');

  // Only include a field when the request actually carries it, so an edit never
  // wipes columns the form didn't send.
  const has = k => acc[k] !== undefined;
  const incoming = { id, rank: requiredText(acc.rank, 'rank', 40), price, status };
  const text = (key, max, ...aliases) => {
    for (const k of [key, ...aliases]) if (has(k)) { incoming[key] = cleanText(acc[k], max); return; }
  };
  text('ign', 40); text('accid', 40); text('kda', 20); text('exp', 20); text('notes', 300);
  text('winrate', 20, 'winRate'); text('achievement', 20, 'ach');
  text('sellername', 60); text('sellercontact', 40); text('sellerign', 40);
  for (let i = 1; i <= 4; i++) if (has(`img${i}`)) incoming[`img${i}`] = cleanMediaUrl(acc[`img${i}`], `img${i}`);

  // createdat is set once and never overwritten by later edits.
  incoming.createdat = existing?.createdat || String(Number(acc.createdat) || Date.now());

  const row = headers.map(h => {
    if (Object.prototype.hasOwnProperty.call(incoming, h)) {
      const v = incoming[h];
      return typeof v === 'number' ? v : sanitizeSheetValue(v);
    }
    return existing ? (existing[h] ?? '') : '';
  });

  if (existing) {
    await sheetsWrite(auth, `AccountList!A${existing._row}:${colLetter(headers.length - 1)}${existing._row}`, [row]);
  } else {
    await sheetsAppend(auth, 'AccountList!A1', [row]);
  }
  console.log(`✅ Account ${id} saved`);
  return res.json({ result: 'ok', id });
}

// ── Public: seller submits a listing (always starts as "pending") ────────────

export async function handleSubmitListing(auth, body, res) {
  // Verify Turnstile CAPTCHA first
  const turnstileToken = body.turnstile_token;
  const turnstileOk = await verifyTurnstile(turnstileToken);
  if (!turnstileOk) throw badRequest('CAPTCHA verification failed. Please try again.');

  const acc = body.account;
  if (!acc || typeof acc !== 'object') throw badRequest('Missing account data');

  const price = Number(acc.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) throw badRequest('Invalid price');

  const clean = {
    rank: requiredText(acc.rank, 'rank', 40),
    sellername: requiredText(acc.sellername, 'seller name', 60),
    sellercontact: requiredText(acc.sellercontact, 'seller contact', 40),
    sellerign: requiredText(acc.sellerign, 'seller in-game name', 40),
    ign: cleanText(acc.ign, 40),
    accid: cleanText(acc.accid, 40),
    kda: cleanText(acc.kda, 20),
    winrate: cleanText(acc.winrate ?? acc.winRate, 20),
    exp: cleanText(acc.exp, 20),
    achievement: cleanText(acc.achievement ?? acc.ach, 20),
    notes: cleanText(acc.notes, 300),
  };
  const imgs = [1, 2, 3, 4].map(i => cleanMediaUrl(acc[`img${i}`], `img${i}`));

  const id = `ACC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const { headers } = await getSheetData(auth, 'AccountList');
  const values = {
    id, price, status: 'pending', createdat: Date.now(),
    ...Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, sanitizeSheetValue(v)])),
    img1: imgs[0], img2: imgs[1], img3: imgs[2], img4: imgs[3],
  };
  const row = headers.map(h => values[h] ?? '');

  await sheetsAppend(auth, 'AccountList!A1', [row]);
  console.log(`✅ Public listing submitted: ${id}`);
  return res.json({ result: 'ok', id });
}

// ── Admin: delete / status ───────────────────────────────────────────────────

export async function handleDeleteAccount(auth, body, res) {
  requireToken(body);
  const { data } = await getSheetData(auth, 'AccountList');
  const acc = data.find(r => String(r.id) === String(body.acc_id));
  if (!acc) throw notFound('Account not found');
  console.log(`🗑 deleteAccount: ${acc.id}`);

  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === 'AccountList');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: acc._row - 1, endIndex: acc._row },
        },
      }],
    },
  });
  invalidateCache();

  // Remove the Drive folder only if no OTHER account shares this IGN (folders are named by IGN).
  const ign = safeFolderName(acc.ign, '');
  const sharedByOthers = data.some(r => r !== acc && safeFolderName(r.ign, '') === ign);
  if (ign && !sharedByOthers && process.env.DRIVE_FOLDER_ACCOUNTS) {
    try {
      const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
      const search = await drive.files.list({
        q: `name='${escapeDriveQuery(ign)}' and '${process.env.DRIVE_FOLDER_ACCOUNTS}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      if (search.data.files?.length > 0) {
        await drive.files.delete({ fileId: search.data.files[0].id, supportsAllDrives: true });
        console.log(`🗑 Drive folder deleted: ${ign}`);
      }
    } catch (e) {
      console.error('Drive folder cleanup failed (row already deleted):', e.message);
    }
  }
  return res.json({ result: 'ok' });
}

export async function handleUpdateAccountStatus(auth, body, res) {
  requireToken(body);
  const accId = body.id || body.account?.id;
  const newStatus = String(body.status || body.account?.status || '').toLowerCase().trim();
  if (!STATUSES.includes(newStatus)) throw badRequest('Invalid status');
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const acc = data.find(r => String(r.id) === String(accId));
  if (!acc) throw notFound('Account not found');
  const statusIdx = headers.indexOf('status');
  if (statusIdx < 0) throw new Error('AccountList sheet has no "status" column');
  await sheetsWrite(auth, `AccountList!${colLetter(statusIdx)}${acc._row}`, [[newStatus]]);
  return res.json({ result: 'ok' });
}

// ── Image uploads (base64, <= ~4MB; larger files use directUpload.js) ────────

async function saveImage(body, maxBytes) {
  const { buffer, mimeType } = decodeUpload(body.base64, IMAGE_TYPES, maxBytes);
  const drive = google.drive({ version: 'v3', auth: getDriveAuth() });
  const folderId = await findOrCreateFolder(drive, body.ign, process.env.DRIVE_FOLDER_ACCOUNTS);
  const name = `acc_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${extForMime(mimeType)}`;
  const fileId = await uploadToDrive(buffer, mimeType, name, folderId);
  return driveUrl(fileId, mimeType);
}

export async function handleUploadAccountImage(auth, body, res) {
  requireToken(body);
  const url = await saveImage(body, 4 * 1024 * 1024);
  console.log(`✅ uploaded (admin): ${url}`);
  return res.json({ url });
}

/** Public (seller form). Rate limited in the router. */
export async function handleUploadPublicAccountImage(auth, body, res) {
  const url = await saveImage(body, 4 * 1024 * 1024);
  console.log(`✅ public upload: ${url}`);
  return res.json({ url });
}
