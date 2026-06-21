import { getAuth } from './lib/auth.js';
import crypto from 'crypto';
import {
  handleGetOrders, handleNewOrder, handleAccountPurchase,
  handleUpdateOrderStatus, handleUpdateOrderComment, handleUploadProofItem,
} from './handlers/orders.js';
import {
  handleGetAccounts, handleSaveAccount, handleDeleteAccount,
  handleUpdateAccountStatus, handleUploadAccountImage, handleUploadPublicAccountImage,
} from './handlers/accounts.js';
import {
  handleGetShopItems, handleSaveItems, handleExtractItems, handleExtractAccountStats,
} from './handlers/shop.js';
import {
  handleGetSettings, handleInitData, handleUploadSlideImg,
} from './handlers/settings.js';
import {
  handleGetDirectUploadUrl, handleFinalizeUpload,
} from './handlers/directUpload.js';

// ══════════════════════════════════════════
// MAIN HANDLER — slim router
// ══════════════════════════════════════════
export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', 'https://suddenattack.safie.cc');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
    if (action === 'saveAccount' && body.isNew) return handleSaveAccount(auth, body, res);
    if (action === 'uploadPublicAccountImage') return handleUploadPublicAccountImage(auth, body, res);

    // ── Direct upload (browser → Drive) ───────────────
    if (action === 'getDirectUploadUrl')       return handleGetDirectUploadUrl(body, res);
    if (action === 'finalizeUpload')           return handleFinalizeUpload(body, res);

    // ── Admin-only actions (token checked in handlers) ─
    if (action === 'updateOrderStatus')        return handleUpdateOrderStatus(auth, body, res);
    if (action === 'updateOrderComment')       return handleUpdateOrderComment(auth, body, res);
    if (action === 'uploadProofItem')          return handleUploadProofItem(auth, body, res);
    if (action === 'saveItems')                return handleSaveItems(auth, body, res);
    if (action === 'extractItems')             return handleExtractItems(auth, body, res);
    if (action === 'extractAccountStats')      return handleExtractAccountStats(body, res);
    if (action === 'uploadAccountImage')       return handleUploadAccountImage(auth, body, res);
    if (action === 'saveAccount')              return handleSaveAccount(auth, body, res);
    if (action === 'deleteAccount')            return handleDeleteAccount(auth, body, res);
    if (action === 'updateAccountStatus')      return handleUpdateAccountStatus(auth, body, res);
    if (action === 'uploadSlideImg')           return handleUploadSlideImg(auth, body, res);

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('❌ API error:', err);
    return res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
}
