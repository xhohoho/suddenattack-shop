/**
 * Receives Maybank "money received" notifications forwarded by MacroDroid (plain-text body).
 *
 * MacroDroid HTTP Request: POST https://<domain>/api/payment-webhook
 *   Header  X-Secret: <PAYMENT_WEBHOOK_SECRET>
 *   Content type text/plain, body = the notification text variable only.
 *
 * Env vars:
 *   PAYMENT_WEBHOOK_SECRET   required (endpoint refuses everything without it)
 *   PAYMENT_WINDOW_MIN       optional, minutes an unpaid order stays matchable (default 30)
 *   AUTO_APPROVE_ACCOUNTS    optional, "true" to auto-pay account orders too (default: manual review)
 *   WEBHOOK_URL              optional, existing Discord webhook, used for alerts
 *
 * A repeat of the same notification within 2 minutes is answered with "duplicate" and changes nothing.
 *
 * Optional "Payments" tab (header row): Time | Amount | Result | Orders | Sender | Ref | Message
 */
import { getAuth, safeEqual } from '../server/lib/auth.js';
import { rateLimit, clientIp } from '../server/lib/ratelimit.js';
import { getSheetData, sheetsWriteBatch, sheetsAppend, colLetter, sanitizeSheetValue, ensureSheetTab } from '../server/lib/sheets.js';
import { sendWebhook } from '../server/lib/webhook.js';
import { parseReceived } from '../server/lib/bankParse.js';
import { findCandidates, decide, isDuplicate, toCents } from '../server/lib/paymentMatch.js';

// Read the raw body ourselves so odd characters can never break parsing.
export const config = { api: { bodyParser: false } };

const MAX_BYTES = 8 * 1024;

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// One payment at a time per server instance (Sheets has no transactions).
let chain = Promise.resolve();
const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

// Create the optional "Payments" log tab on first use (once per server instance).
let paymentsTabReady = false;
async function ensurePaymentsTab(auth) {
  if (paymentsTabReady) return;
  try {
    if (await ensureSheetTab(auth, 'Payments', ['Time', 'Amount', 'Result', 'Orders', 'Sender', 'Ref', 'Message'])) {
      console.log('payment-webhook: created the "Payments" tab');
    }
    paymentsTabReady = true;
  } catch (e) {
    console.error('payment-webhook: could not create the Payments tab:', e.message);
  }
}

async function logPayment(auth, row) {
  try {
    await sheetsAppend(auth, 'Payments!A1', [row.map(v => (typeof v === 'number' ? v : sanitizeSheetValue(v)))]);
  } catch (e) {
    console.error('Could not write to Payments sheet (does the tab exist?):', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send('not configured'); // fail closed

  try {
    await rateLimit(`payhook:${clientIp(req)}`, 60, 10 * 60_000);
  } catch (e) {
    return res.status(e.status || 429).send('slow down');
  }
  if (!safeEqual(String(req.headers['x-secret'] || ''), secret)) {
    console.warn(`payment-webhook: 401 secret mismatch (header ${req.headers['x-secret'] ? 'present, ' + String(req.headers['x-secret']).length + ' chars' : 'missing'})`);
    return res.status(401).send('unauthorized');
  }

  const raw = (await readRaw(req)).trim();
  let text = raw;
  if (raw.startsWith('{')) { try { const j = JSON.parse(raw); text = String(j.text ?? j.message ?? raw); } catch { /* keep raw */ } }

  const parsed = parseReceived(text);
  if (!parsed) {
    console.log('payment-webhook: ignored (not a "received" notification):', JSON.stringify(text.slice(0, 160)));
    return res.status(200).send('ignored'); // not an incoming-payment notification
  }

  const amount = parsed.amountCents / 100;
  const windowMs = (Number(process.env.PAYMENT_WINDOW_MIN) || 30) * 60_000;
  const autoApproveAccounts = process.env.AUTO_APPROVE_ACCOUNTS === 'true';

  try {
    const result = await serial(async () => {
      const auth = await getAuth().getClient();
      await ensurePaymentsTab(auth);
      // Ignore a retry of a notification we already handled (Payments tab is optional).
      const logged = await getSheetData(auth, 'Payments').catch(() => ({ data: [] }));
      if (isDuplicate(logged.data, text, parsed.amountCents)) { console.log(`payment-webhook: duplicate of a payment logged moments ago, RM ${amount.toFixed(2)}`); return 'duplicate'; }

      const { headers, data } = await getSheetData(auth, 'Orders'); // fresh read
      const candidates = findCandidates(data, parsed.amountCents, Date.now(), windowMs);
      const { action } = decide(candidates, { autoApproveAccounts });
      const ids = candidates.map(o => o.order_id).join(', ');

      // Why did (or didn't) it match? Lists orders with the same total so a miss can be explained.
      const sameTotal = data.filter(o => toCents(o.total) === parsed.amountCents).slice(-5)
        .map(o => `${o.order_id} status=${JSON.stringify(o.status)} ts=${JSON.stringify(o.timestamp)} ageMin=${((Date.now() - Date.parse(o.timestamp)) / 60000).toFixed(1)}`);
      console.log(`payment-webhook: RM ${amount.toFixed(2)} from "${parsed.sender.slice(0, 40)}" -> ${action}; ${data.length} orders read, ${candidates.length} candidate(s) [${ids}]; same-total orders: ${sameTotal.length ? sameTotal.join(' | ') : 'none'}`);

      if (action === 'auto_paid') {
        const order = candidates[0];
        const statusIdx = headers.indexOf('status');
        if (statusIdx < 0) throw new Error('Orders sheet has no "status" column');
        const updates = [{ range: `Orders!${colLetter(statusIdx)}${order._row}`, values: [['Paid']] }];
        const commentIdx = headers.indexOf('comment');
        if (commentIdx >= 0 && !String(order.comment || '').trim()) {
          updates.push({ range: `Orders!${colLetter(commentIdx)}${order._row}`, values: [[`Auto-paid: bank notification RM ${amount.toFixed(2)}`]] });
        }
        await sheetsWriteBatch(auth, updates);
        await logPayment(auth, [new Date().toISOString(), amount, 'auto_paid', ids, parsed.sender, parsed.ref, text]);
        await sendWebhook('payment.auto_paid', { order_id: order.order_id, amount: amount.toFixed(2) });
      } else {
        await logPayment(auth, [new Date().toISOString(), amount, action, ids, parsed.sender, parsed.ref, text]);
        await sendWebhook('payment.needs_review', { result: action, amount: amount.toFixed(2), orders: ids || 'none', sender: parsed.sender.slice(0, 40) });
      }
      return action;
    });
    return res.status(200).send(result);
  } catch (e) {
    console.error('payment-webhook error:', e.message);
    // Never lose a payment silently: raise an alert with the raw text.
    await sendWebhook('payment.error', { amount: amount.toFixed(2), message: text.slice(0, 200) });
    return res.status(500).send('error');
  }
}
