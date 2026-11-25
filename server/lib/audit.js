/**
 * Admin audit logger. Appends one row per admin action to the "AuditLog" tab:
 *   A Time | B Admin | C Action | D Details (JSON) | E IP | F User agent
 *
 * Details is a small JSON object: { target, params, error? }
 *   - target : what was changed, in plain words (an order id, "slide 3", "ticker", ...)
 *   - params : the request fields that matter (secrets removed, noise dropped, Drive links shortened to file ids)
 *
 * The tab is created automatically (with a header row) the first time it is needed.
 * Logging never breaks the request: if anything goes wrong the error is only logged.
 */
import { sheetsAppend, sanitizeSheetValue, ensureSheetTab } from './sheets.js';
import { getAuth } from './auth.js';

const AUDIT_SHEET = 'AuditLog';

// Create the "AuditLog" tab on first use (once per server instance).
let auditTabReady = false;
async function ensureAuditTab(auth) {
  if (auditTabReady) return;
  await ensureSheetTab(auth, AUDIT_SHEET, ['Time', 'Admin', 'Action', 'Details', 'IP', 'User agent']);
  auditTabReady = true;
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export async function auditLog(adminId, action, details = {}, ip = '', userAgent = '') {
  try {
    const auth = await getAuth().getClient();
    await ensureAuditTab(auth);
    await sheetsAppend(auth, `${AUDIT_SHEET}!A1`, [[
      new Date().toISOString(),
      sanitizeSheetValue(String(adminId)),
      sanitizeSheetValue(String(action)),
      sanitizeSheetValue(clip(JSON.stringify(details), 3000)),
      sanitizeSheetValue(String(ip)),
      sanitizeSheetValue(clip(userAgent, 200)), // user agents are attacker-controlled: sanitized against sheet formulas
    ]]);
  } catch (e) {
    // Never fail the main request because of audit logging
    console.error('Audit log failed:', e.message);
  }
}

// ── What goes into the Details column ───────────────────────────────────────

// Dropped entirely: the action name and user agent have their own columns, the token/base64 add nothing.
const NOISE_KEYS = new Set(['action', '_ua', '_token', 'base64']);
// Kept, but the value is hidden.
const SECRET_KEYS = new Set(['password', 'turnstile_token', 'order_token', 'sessionToken']);
// Google Drive image links -> just the file id.
const DRIVE_URL = /^https:\/\/(?:lh3\.googleusercontent\.com\/d\/|drive\.google\.com\/uc\?export=(?:download|view)&id=)([\w-]+).*$/;

function cleanValue(v) {
  if (typeof v === 'string') return v.replace(DRIVE_URL, '$1');
  if (Array.isArray(v)) return v.map(cleanValue); // arrays stay arrays (they used to turn into {"0":...,"1":...})
  if (v && typeof v === 'object') return cleanObject(v);
  return v;
}

function cleanObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (NOISE_KEYS.has(k)) continue;
    out[k] = SECRET_KEYS.has(k) ? '[REDACTED]' : cleanValue(v);
  }
  return out;
}

function sanitizeForAudit(obj) {
  return obj && typeof obj === 'object' ? cleanObject(obj) : obj;
}

/** Plain-words description of what the action touched. */
function targetOf(actionName, body) {
  if (actionName === 'uploadSlideImg') {
    const i = Number(body.slideIndex);
    return i === -1 ? 'slides' : `slide ${i + 1}`;
  }
  if (actionName === 'updateTicker') return 'ticker';
  if (actionName === 'saveItems') return 'shop items';
  return String(body.order_id || body.acc_id || body.id || body.account?.id || '');
}

/** uploadSlideImg is also used to reorder (slideIndex -1) and to clear a slide (url ""): log what really happened. */
function actionLabel(actionName, body) {
  if (actionName !== 'uploadSlideImg') return actionName;
  if (Number(body.slideIndex) === -1) return 'reorderSlides';
  if (body.url === '' && !body.base64) return 'clearSlide';
  return actionName;
}

/**
 * Wrapper for admin actions: logs success or failure of each one.
 * Usage: run: withAudit((a, b, r) => handler(a, b, r), 'actionName')
 * ctx comes from the router: { ip, ua, isAdmin }.
 */
export function withAudit(handler, actionName) {
  return async (auth, body, res, ctx) => {
    const adminId = 'admin'; // could be extended with multiple admins
    const ip = ctx?.ip || '';
    const userAgent = ctx?.ua || body._ua || '';
    const action = actionLabel(actionName, body);
    const target = targetOf(actionName, body);
    const params = sanitizeForAudit(body);
    const details = target ? { target, params } : { params };

    try {
      await handler(auth, body, res, ctx);
    } catch (e) {
      await auditLog(adminId, action + '_failed', { ...details, error: e.message }, ip, userAgent);
      throw e;
    }
    await auditLog(adminId, action, details, ip, userAgent);
  };
}
