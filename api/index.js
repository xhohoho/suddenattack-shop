import { getAuth, requireAdminToken, verifyOrderToken } from './lib/auth.js';
import crypto from 'crypto';

/** Check admin token and return 401 if missing/invalid. */
function requireAdmin(body, res) {
  return requireAdminToken(body, res);
}
import {
  handleGetOrders, handleNewOrder, handleAccountPurchase,
  handleUpdateOrderStatus, handleUpdateOrderComment, handleUploadProofItem,
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
const ALLOWED_ORIGIN = 'https://suddenattack.safie.cc';
const WRITE_ACTIONS = new Set([
  'newOrder', 'accountPurchase', 'submitListing', 'uploadPublicAccountImage',
  'uploadProofItem', 'getDirectUploadUrl', 'finalizeUpload',
  'adminAuth', 'updateOrderStatus', 'updateOrderComment', 'saveItems',
  'extractItems', 'extractAccountStats', 'uploadAccountImage', 'saveAccount',
  'deleteAccount', 'updateAccountStatus', 'uploadSlideImg', 'updateTicker'
]);

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Origin validation for write actions ───────────────
  const origin = req.headers.origin || req.headers.referer;
  const action = req.body?.action;
  if (req.method === 'POST' && WRITE_ACTIONS.has(action)) {
    if (!origin || !origin.startsWith(ALLOWED_ORIGIN)) {
      return res.status(403).json({ error: 'Forbidden: Invalid origin' });
    }
  }

  // ── GET → default to getOrders ────────────────────────
  if (req.method === 'GET') {
    const auth = await getAuth().getClient();
    return handleGetOrders(auth, res);
  }

  // ── POST → route by action ────────────────────────────
  const body = req.body;
  const { action } = body;

  try {
    const auth = await getAuth().getClient();

    // ── Public actions (no token) ──────────────────────
    if (action === 'adminAuth') {
      const a = Buffer.from(body.password || '');
      const b = Buffer.from(process.env.ADMIN_PASSWORD || '');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(200).json({ error: 'unauthorized' });
      }
      return res.json({ token: process.env.ADMIN_TOKEN });
    }
    if (action === 'getOrders')                return handleGetOrders(auth, res);
    if (action === 'getShopItems')             return handleGetShopItems(auth, res);
    if (action === 'getAccounts')              return handleGetAccounts(auth, res);
    if (action === 'getSettings')              return handleGetSettings(auth, res);
    if (action === 'initData')                 return handleInitData(auth, res);
    if (action === 'newOrder')                 return handleNewOrder(auth, body, res);
    if (action === 'accountPurchase')          return handleAccountPurchase(auth, body, res);
    if (action === 'submitListing')            return handleSubmitListing(auth, body, res);
    if (action === 'uploadPublicAccountImage') return handleUploadPublicAccountImage(auth, body, res);
    if (action === 'uploadProofItem')          return handleUploadProofItem(auth, body, res);
    // REMOVED: reserveAccount (folded into accountPurchase)
    // REMOVED: saveAccount with isNew (replaced by submitListing)

    // ── Direct upload (browser → Drive) ───────────────
    if (action === 'getDirectUploadUrl')       return handleGetDirectUploadUrl(body, res);
    if (action === 'finalizeUpload')           return handleFinalizeUpload(body, res);

    // ── Admin-only actions (centralized token guard) ──
    if (action === 'updateOrderStatus')        { if (!requireAdmin(body, res)) return; return handleUpdateOrderStatus(auth, body, res); }
    if (action === 'updateOrderComment')       { if (!requireAdmin(body, res)) return; return handleUpdateOrderComment(auth, body, res); }
    if (action === 'saveItems')                { if (!requireAdmin(body, res)) return; return handleSaveItems(auth, body, res); }
    if (action === 'extractItems')             { if (!requireAdmin(body, res)) return; return handleExtractItems(auth, body, res); }
    if (action === 'extractAccountStats')      { if (!requireAdmin(body, res)) return; return handleExtractAccountStats(body, res); }
    if (action === 'uploadAccountImage')       { if (!requireAdmin(body, res)) return; return handleUploadAccountImage(auth, body, res); }
    if (action === 'saveAccount')              { if (!requireAdmin(body, res)) return; return handleSaveAccount(auth, body, res); }
    if (action === 'deleteAccount')            { if (!requireAdmin(body, res)) return; return handleDeleteAccount(auth, body, res); }
    if (action === 'updateAccountStatus')      { if (!requireAdmin(body, res)) return; return handleUpdateAccountStatus(auth, body, res); }
    if (action === 'uploadSlideImg')           { if (!requireAdmin(body, res)) return; return handleUploadSlideImg(auth, body, res); }
    if (action === 'updateTicker')             { if (!requireAdmin(body, res)) return; return handleUpdateTicker(auth, body, res); }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('❌ API error:', err);
    // Don't expose internal error details in production
    const isDev = process.env.NODE_ENV === 'development';
    return res.status(500).json({
      error: 'Internal Server Error',
      ...(isDev && { details: err.message })
    });
  }
}
