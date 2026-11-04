import { getAuth, isValidAdminToken, issueAdminToken, safeEqual } from './lib/auth.js';
import { HttpError, unauthorized } from './lib/http.js';
import { rateLimit, clientIp } from './lib/ratelimit.js';
import { auditLog, withAudit } from './lib/audit.js';
import {
  handleGetOrders, handleNewOrder, handleAccountPurchase,
  handleUpdateOrderStatus, handleUpdateOrderComment, handleUploadProofItem,
  handleFindOrder,
} from './handlers/orders.js';
import {
  handleGetAccounts, handleSaveAccount, handleDeleteAccount,
  handleUpdateAccountStatus, handleUploadAccountImage, handleUploadPublicAccountImage, handleSubmitListing,
} from './handlers/accounts.js';
import {
  handleGetShopItems, handleSaveItems, handleExtractItems, handleExtractAccountStats,
} from './handlers/shop.js';
import {
  handleGetSettings, handleInitData, handleUploadSlideImg, handleUpdateTicker,
} from './handlers/settings.js';
import {
  handleGetDirectUploadUrl, handleFinalizeUpload,
} from './handlers/directUpload.js';

// ══════════════════════════════════════════
// MAIN HANDLER — slim router
// ══════════════════════════════════════════

/** Origins allowed to call the API from a browser. Add more with ALLOWED_ORIGINS="https://a.com,https://b.com". */
function allowedOrigins() {
  const set = new Set(['https://suddenattack.safie.cc']);
  const add = v => { try { if (v) set.add(new URL(v.startsWith('http') ? v : `https://${v}`).origin); } catch { /* ignore bad value */ } };
  add(process.env.SITE_URL);
  (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).forEach(add);
  // Preview deployments (and local dev) may call their own API; production may not.
  if (process.env.VERCEL_ENV !== 'production') {
    add(process.env.VERCEL_URL);
    add(process.env.VERCEL_BRANCH_URL);
    set.add('http://localhost:3000');
  }
  return set;
}

function requestOrigin(req) {
  const o = req.headers.origin;
  if (o) return o === 'null' ? null : o;
  if (req.headers.referer) { try { return new URL(req.headers.referer).origin; } catch { return null; } }
  return null;
}

/**
 * Route table.
 *   admin:  requires a valid admin token
 *   limit:  [maxRequests, windowMs] per IP (best effort, see lib/ratelimit.js)
 * Each run() receives (auth, body, res, ctx) and MUST send the response.
 */
const MIN = 60_000, HOUR = 60 * MIN;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) return true; // not configured, skip
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

const ROUTES = {
  // ── public reads ──
  getOrders:       { run: (a, b, r, c) => handleGetOrders(a, r, c.isAdmin, b.limit) },
  getShopItems:    { run: (a, b, r) => handleGetShopItems(a, r) },
  getAccounts:     { run: (a, b, r, c) => handleGetAccounts(a, r, c.isAdmin) },
  getSettings:     { run: (a, b, r) => handleGetSettings(a, r) },
  initData:        { run: (a, b, r) => handleInitData(a, r) },
  findOrder:       { limit: [5, 15 * MIN], run: (a, b, r) => handleFindOrder(a, b, r) },

  // ── public writes ──
  newOrder:                 { limit: [10, 10 * MIN], run: (a, b, r) => handleNewOrder(a, b, r) },
  accountPurchase:          { limit: [10, 10 * MIN], run: (a, b, r) => handleAccountPurchase(a, b, r) },
  uploadProofItem:          { limit: [20, 10 * MIN], run: (a, b, r) => handleUploadProofItem(a, b, r) },
  submitListing:            { limit: [5, HOUR],      run: (a, b, r) => handleSubmitListing(a, b, r) },
  uploadPublicAccountImage: { limit: [20, HOUR],     run: (a, b, r) => handleUploadPublicAccountImage(a, b, r) },
  getDirectUploadUrl:       { limit: [20, HOUR],     run: (a, b, r) => handleGetDirectUploadUrl(b, r) }, // 'account' context checks the admin token itself
  finalizeUpload:           { limit: [40, HOUR],     run: (a, b, r) => handleFinalizeUpload(b, r) },

  // ── admin ──
  updateOrderStatus:   { admin: true, run: withAudit((a, b, r) => handleUpdateOrderStatus(a, b, r), 'updateOrderStatus') },
  updateOrderComment:  { admin: true, run: withAudit((a, b, r) => handleUpdateOrderComment(a, b, r), 'updateOrderComment') },
  saveItems:           { admin: true, run: withAudit((a, b, r) => handleSaveItems(a, b, r), 'saveItems') },
  extractItems:        { admin: true, run: withAudit((a, b, r) => handleExtractItems(a, b, r), 'extractItems') },
  extractAccountStats: { admin: true, run: withAudit((a, b, r) => handleExtractAccountStats(b, r), 'extractAccountStats') },
  uploadAccountImage:  { admin: true, run: withAudit((a, b, r) => handleUploadAccountImage(a, b, r), 'uploadAccountImage') },
  saveAccount:         { admin: true, run: withAudit((a, b, r) => handleSaveAccount(a, b, r), 'saveAccount') },
  deleteAccount:       { admin: true, run: withAudit((a, b, r) => handleDeleteAccount(a, b, r), 'deleteAccount') },
  updateAccountStatus: { admin: true, run: withAudit((a, b, r) => handleUpdateAccountStatus(a, b, r), 'updateAccountStatus') },
  uploadSlideImg:      { admin: true, run: withAudit((a, b, r) => handleUploadSlideImg(a, b, r), 'uploadSlideImg') },
  updateTicker:        { admin: true, run: withAudit((a, b, r) => handleUpdateTicker(a, b, r), 'updateTicker') },
};

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  return body && typeof body === 'object' ? body : {};
}

export default async function handler(req, res) {
  const origin = requestOrigin(req);
  const origins = allowedOrigins();
  const originOk = !!origin && origins.has(origin);

  // ── CORS (only reflect an allowed origin) ─────────────
  if (originOk) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── GET → legacy default: the public order list ─────
    if (req.method === 'GET') {
      const auth = await getAuth().getClient();
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : undefined;
      return await handleGetOrders(auth, res, false, limit);
    }

    // ── POST → route by action ──────────────────────────
    // (Origin is defense-in-depth against other websites; it is NOT authentication.)
    if (!originOk) throw new HttpError(403, 'Forbidden: Invalid origin');

    const body = parseBody(req);
    const action = typeof body.action === 'string' ? body.action : '';
    const ip = clientIp(req);

    // Admin login: constant-time password check + brute-force limit + Turnstile. Returns a SIGNED, expiring
    // session token; the permanent ADMIN_TOKEN secret never leaves the server.
    if (action === 'adminAuth') {
      await rateLimit(`login:${ip}`, 8, 15 * MIN);
      const turnstileToken = body.turnstile_token;
      const turnstileOk = await verifyTurnstile(turnstileToken);
      if (!turnstileOk) throw unauthorized('CAPTCHA verification failed');
      const expected = process.env.ADMIN_PASSWORD;
      if (!expected || !safeEqual(body.password || '', expected)) throw unauthorized();

      // Log successful admin login
      auditLog('admin', 'login', { ip, userAgent: req.headers['user-agent'] });

      return res.json({ token: issueAdminToken() });
    }

    const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null;
    if (!route) throw new HttpError(400, `Unknown action: ${action}`);

    if (route.admin && !isValidAdminToken(body._token)) throw unauthorized();
    if (route.limit) await rateLimit(`${action}:${ip}`, route.limit[0], route.limit[1]);

    const auth = await getAuth().getClient();
    const ctx = { isAdmin: isValidAdminToken(body._token), ip };
    // `await` matters: without it a rejected promise escapes this try/catch and crashes the function.
    return await route.run(auth, body, res, ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('❌ API error:', err);
    // Never expose internal error details to the browser.
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
