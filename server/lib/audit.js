/**
 * Admin audit logger. Appends one row per admin action to the "AuditLog" tab:
 *   A timestamp | B admin_id | C action | D details (JSON) | E ip | F user_agent
 *
 * Create a tab named AuditLog in your Google Sheet (a header row is optional).
 * Logging never breaks the request: if the tab is missing the error is only logged.
 */
import { sheetsAppend, sanitizeSheetValue } from './sheets.js';
import { getAuth } from './auth.js';

const AUDIT_SHEET = 'AuditLog';

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export async function auditLog(adminId, action, details = {}, ip = '', userAgent = '') {
  try {
    const auth = await getAuth().getClient();
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
