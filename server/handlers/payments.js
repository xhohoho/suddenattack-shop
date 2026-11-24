/**
 * Admin tools for bank payments that the webhook could not match on its own.
 * The webhook logs every payment to the "Payments" tab:
 *   Time | Amount | Result | Orders | Sender | Ref | Message | Resolved
 * Rows whose Result is ambiguous / unmatched / account_review and whose Resolved cell is empty need a decision.
 */
import { getSheetData, sheetsWriteBatch, colLetter, sanitizeSheetValue } from '../lib/sheets.js';
import { requireToken } from '../lib/auth.js';
import { badRequest, notFound, conflict, cleanText, requiredText } from '../lib/http.js';
import { toCents } from '../lib/paymentMatch.js';

const REVIEW_RESULTS = new Set(['ambiguous', 'unmatched', 'account_review']);
const ASSIGNABLE = new Set(['', 'new', 'proofsubmitted', 'afk']);
const norm = v => String(v ?? '').trim().toLowerCase();

async function readPayments(auth) {
  try {
    return await getSheetData(auth, 'Payments'); // fresh read
  } catch {
    return { headers: [], data: [] }; // tab not created yet = nothing to review
  }
}

/** Payments waiting for a decision (newest first) + the orders they could belong to. */
export async function handleGetPayments(auth, body, res) {
  requireToken(body);
  const { data: pay } = await readPayments(auth);
  const pending = pay
    .filter(p => REVIEW_RESULTS.has(norm(p.result)) && !String(p.resolved || '').trim())
    .reverse().slice(0, 50)
    .map(p => ({
      row: p._row, time: p.time, amount: p.amount, result: norm(p.result),
      orders: p.orders, sender: p.sender, ref: p.ref,
    }));

  const { data: orders } = await getSheetData(auth, 'Orders');
  const open = orders
    .filter(o => ASSIGNABLE.has(norm(o.status)))
    .reverse().slice(0, 100)
    .map(o => ({ order_id: o.order_id, name: o.name, items: o.items, total: o.total, status: o.status || 'New', timestamp: o.timestamp }));

  return res.json({ payments: pending, orders: open });
}

/**
 * body: { payment_row, mode: 'assign' | 'dismiss', order_id? }
 *  assign  -> marks the chosen order Paid (same as an automatic match)
 *  dismiss -> marks the payment as handled (e.g. unrelated money in).
 */
export async function handleMatchPayment(auth, body, res) {
  requireToken(body);
  const action = body.mode === 'dismiss' ? 'dismiss' : body.mode === 'assign' ? 'assign' : null; // (body.action is the route name)
  if (!action) throw badRequest('Unknown action');
  const row = Number(body.payment_row);
  if (!Number.isInteger(row) || row < 2) throw badRequest('Invalid payment row');

  const { headers, data: pay } = await readPayments(auth);
  const payment = pay.find(p => p._row === row);
  if (!payment) throw notFound('Payment not found');
  if (!REVIEW_RESULTS.has(norm(payment.result))) throw conflict('This payment does not need review.');
  if (String(payment.resolved || '').trim()) throw conflict('This payment was already handled.');

  const updates = [];
  // Make sure the "Resolved" column exists (tabs created by an older version have only 7 columns).
  let resolvedIdx = headers.indexOf('resolved');
  if (resolvedIdx < 0) {
    resolvedIdx = headers.length;
    updates.push({ range: `Payments!${colLetter(resolvedIdx)}1`, values: [['Resolved']] });
  }

  let resolvedText, newStatus = null;
  if (action === 'dismiss') {
    resolvedText = `Dismissed ${new Date().toISOString()}`;
  } else {
    const orderId = requiredText(body.order_id, 'order_id', 80);
    const { headers: oh, data: orders } = await getSheetData(auth, 'Orders'); // fresh read
    const order = orders.find(o => o.order_id === orderId);
    if (!order) throw notFound('Order not found');
    if (!ASSIGNABLE.has(norm(order.status))) throw conflict(`Order is already "${order.status}".`);
    const statusIdx = oh.indexOf('status');
    if (statusIdx < 0) throw new Error('Orders sheet has no "status" column');

    newStatus = 'Paid';
    updates.push({ range: `Orders!${colLetter(statusIdx)}${order._row}`, values: [[newStatus]] });
    const commentIdx = oh.indexOf('comment');
    if (commentIdx >= 0 && !String(order.comment || '').trim()) {
      const amt = (toCents(payment.amount) / 100).toFixed(2);
      const note = `Auto-paid: bank payment RM ${amt} matched by admin`;
      updates.push({ range: `Orders!${colLetter(commentIdx)}${order._row}`, values: [[note]] });
    }
    resolvedText = `Matched ${orderId}`;
  }
  updates.push({ range: `Payments!${colLetter(resolvedIdx)}${row}`, values: [[sanitizeSheetValue(cleanText(resolvedText, 120))]] });
  await sheetsWriteBatch(auth, updates);
  return res.json({ result: 'ok', status: newStatus });
}
