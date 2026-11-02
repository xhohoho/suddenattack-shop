import { google } from 'googleapis';
import crypto from 'crypto';
import { HttpError, unauthorized } from './http.js';

// ── Google clients (cached per warm instance) ────────────────────────────────

let _auth = null;

/**
 * Returns a GoogleAuth client using the service account credentials.
 * Used for Sheets (and Drive read) operations. Cached so we don't re-parse the
 * credentials and re-create the client on every request.
 */
export function getAuth() {
  if (_auth) return _auth;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    try {
      creds = JSON.parse(raw.replace(/\r?\n/g, '\\n'));
    } catch (e2) {
      throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ${e2.message}`);
    }
  }

  if (creds.private_key?.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  _auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  return _auth;
}

let _driveAuth = null;

/**
 * Returns an OAuth2 client for personal Drive uploads (cached).
 */
export function getDriveAuth() {
  if (_driveAuth) return _driveAuth;
  const {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
  } = process.env;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing OAuth env vars: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN');
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  _driveAuth = oauth2;
  return oauth2;
}

// ── Signing helpers ──────────────────────────────────────────────────────────

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Secret used to sign admin sessions and upload sessions (never sent to the browser). */
function signingKey() {
  const k = process.env.SESSION_SECRET || process.env.ADMIN_TOKEN;
  if (!k) throw new Error('Set SESSION_SECRET (or ADMIN_TOKEN) in the environment');
  return k;
}

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

// ── Admin sessions ───────────────────────────────────────────────────────────
// The browser used to receive the permanent ADMIN_TOKEN secret. Now it receives
// a short-lived signed token instead, so the secret itself never leaves the server.

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function issueAdminToken() {
  const exp = Date.now() + ADMIN_TTL_MS;
  return `a1.${exp}.${hmacHex(signingKey(), `admin.${exp}`)}`;
}

export function isValidAdminToken(token) {
  if (typeof token !== 'string') return false;
  const [ver, exp, sig] = token.split('.');
  if (ver !== 'a1' || !exp || !sig) return false;
  if (!(Number(exp) > Date.now())) return false;
  return safeEqual(sig, hmacHex(signingKey(), `admin.${exp}`));
}

/** Throws a 401 HttpError unless the body carries a valid admin token. */
export function requireToken(body) {
  if (!isValidAdminToken(body?._token)) throw unauthorized();
}

// ── Order tokens (proof-upload authorisation) ────────────────────────────────

function orderKey() {
  const k = process.env.ORDER_TOKEN_SECRET || process.env.ADMIN_TOKEN || process.env.SESSION_SECRET;
  if (!k) throw new Error('Set ORDER_TOKEN_SECRET in the environment');
  return k;
}

/** HMAC that binds an order_id to a server secret. Handed to the buyer who created the order. */
export function generateOrderToken(orderId) {
  return hmacHex(orderKey(), String(orderId));
}

/** Throws 401 unless body.order_token is the valid token for body.order_id. */
export function requireOrderToken(body) {
  const { order_id, order_token } = body || {};
  if (!order_id || !order_token) throw new HttpError(401, 'missing order_token');
  if (!safeEqual(order_token, generateOrderToken(order_id))) throw new HttpError(401, 'invalid order_token');
}

// ── Generic signed, expiring tokens (used for upload sessions) ───────────────

export function signToken(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${hmacHex(signingKey(), `sess.${body}`)}`;
}

/** Returns the payload, or throws 400/401 if the token is forged or expired. */
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) throw unauthorized('Invalid session token');
  const [body, sig] = token.split('.');
  if (!safeEqual(sig, hmacHex(signingKey(), `sess.${body}`))) throw unauthorized('Invalid session token');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { throw unauthorized('Invalid session token'); }
  if (!(payload.exp > Date.now())) throw unauthorized('Upload session expired');
  return payload;
}
