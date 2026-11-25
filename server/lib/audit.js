/**
 * Admin audit logger. Appends one row per admin action to the "AuditLog" tab:
 *   A timestamp | B admin_id | C action | D details (JSON) | E ip | F user_agent
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

/**
 * Wrapper for admin actions: logs success or failure of each one.
 * Usage: run: withAudit((a, b, r) => handler(a, b, r), 'actionName')
 */
export function withAudit(handler, actionName) {
  return async (auth, body, res, ctx) => {
    const adminId = 'admin'; // could be extended with multiple admins
    const ip = ctx?.ip || '';
    const userAgent = body._ua || '';
    const target = body.order_id || body.acc_id || body.id || body.account?.id || 'unknown';

    try {
      await handler(auth, body, res, ctx);
    } catch (e) {
      await auditLog(adminId, actionName + '_failed', { error: e.message, target, params: sanitizeForAudit(body) }, ip, userAgent);
      throw e;
    }
    await auditLog(adminId, actionName, { target, params: sanitizeForAudit(body) }, ip, userAgent);
  };
}

function sanitizeForAudit(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // Skip sensitive or huge fields
    if (['_token', 'password', 'turnstile_token', 'order_token', 'base64', 'sessionToken'].includes(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeForAudit(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
