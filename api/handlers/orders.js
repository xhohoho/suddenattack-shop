import {
  getSheetData, getHeaders, sheetsWrite, sheetsWriteBatch, sheetsAppend,
  colLetter, sanitizeSheetValue, publicRow,
} from '../lib/sheets.js';
import { uploadToDrive, driveUrl, decodeUpload, extForMime } from '../lib/drive.js';
import { requireToken, requireOrderToken, generateOrderToken } from '../lib/auth.js';
import { getShopItems } from './shop.js';
import { badRequest, notFound, conflict, cleanText, requiredText } from '../lib/http.js';
import crypto from 'crypto';

const KL_LOCALE = { timeZone: 'Asia/Kuala_Lumpur' };

/** Flat RM fee added once per item order (matches SERVICE_CHARGE in public/js/config.js). */
export const SERVICE_CHARGE = 0.50;
/** 10% fee added on top of account prices (matches ACCOUNT_SERVICE_RATE in config.js). */
export const ACCOUNT_SERVICE_RATE = 0.10;

// Fields the public may see. Never phone, email or proof links.
export const PUBLIC_ORDER_FIELDS = ['order_id', 'timestamp', 'name', 'items', 'total', 'status', 'comment'];
export const publicOrders = rows => rows.map(r => publicRow(r, PUBLIC_ORDER_FIELDS));

const round2 = n => Math.round(n * 100) / 100;

/** Short, readable, unique id e.g. ORD-MVXQEN66-1A2B3C (same look as the old client-made ids). */
function newOrderId() {
  return `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Build a sheet row in the sheet's own column order, from an object keyed by header name. */
function rowFromHeaders(headers, values) {
  if (!headers.length) {
    return [values.order_id, values.timestamp, values.name, values.phone, values.email,
      values.items, values.total, values.note, values.status, values.proof];
  }
  return headers.map(h => values[h] ?? '');
}

const klTime = () => new Date().toLocaleString('en-US', KL_LOCALE);

// ── Public reads ─────────────────────────────────────────────────────────────

export async function handleGetOrders(auth, res, isAdmin = false) {
  const { data } = await getSheetData(auth, 'Orders', { ttl: 5000 });
  return res.json({ values: isAdmin ? data.map(r => publicRow(r)) : publicOrders(data) });
}

// ── Public: create an item order ─────────────────────────────────────────────
/**
 * The browser sends ONLY what the buyer chose: [{ id, days, qty }] + name/note.
 * The server looks up prices itself, so a tampered request cannot change the total.
 */
export async function handleNewOrder(auth, body, res) {
  const name = requiredText(body.name, 'name', 60);
  const note = cleanText(body.note, 300);
  const phone = cleanText(body.phone, 30);
  const email = cleanText(body.email, 80);

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) throw badRequest('No items provided');
  if (items.length > 60) throw badRequest('Too many items in one order');

  const shop = new Map((await getShopItems(auth, { fresh: true })).map(i => [i.id, i]));

  let subtotal = 0;
  const lines = [];
  for (const raw of items) {
    const id = String(parseInt(raw?.id, 10));
    const days = Number(raw?.days);
    const qty = Number(raw?.qty);
    const item = shop.get(id);
    if (!item) throw badRequest('An item in your cart is no longer available. Please refresh the page.');
    if (![7, 15, 30].includes(days)) throw badRequest('Invalid duration');
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw badRequest('Invalid quantity');
    const unit = days === 7 ? item.p7 : days === 15 ? item.p15 : item.p30;
    if (!(unit > 0)) throw badRequest(`"${item.name}" is not available for ${days} days`);
    const line = round2(unit * qty);
    subtotal += line;
    lines.push(`${item.name} ${days}d x${qty} (RM ${line.toFixed(2)})`);
  }
  const total = round2(subtotal + SERVICE_CHARGE);
  const itemsStr = lines.join('; ');

  // If prices changed while the buyer was browsing, tell them instead of charging a surprise.
  if (body.total != null && Math.abs(Number(body.total) - total) > 0.01) {
    throw conflict(`Prices have changed (new total RM ${total.toFixed(2)}). Please refresh the page and try again.`);
  }

  const orderId = newOrderId();
  const headers = await getHeaders(auth, 'Orders');
  const row = rowFromHeaders(headers, {
    order_id: orderId, timestamp: klTime(), name: sanitizeSheetValue(name),
    phone: sanitizeSheetValue(phone), email: sanitizeSheetValue(email),
    items: sanitizeSheetValue(itemsStr), total, note: sanitizeSheetValue(note),
    status: 'New', proof: '',
  });
  await sheetsAppend(auth, 'Orders!A1', [row]);

  return res.json({ result: 'ok', order_id: orderId, total, items: itemsStr, order_token: generateOrderToken(orderId) });
}

// ── Public: buy an account ───────────────────────────────────────────────────
// Reserve first (so nobody else can buy it), then log the order; if logging
// fails the reservation is rolled back. The buyer then uploads proof with the
// returned order_token via uploadProofItem.

const accountLocks = new Set(); // stops two simultaneous buys of one account on this instance

export async function handleAccountPurchase(auth, body, res) {
  const accId = requiredText(body.acc_id, 'acc_id', 80);
  const buyerIgn = requiredText(body.buyer_ign, 'in-game name', 40);
  const buyerName = cleanText(body.buyer_name, 60);
  const phone = requiredText(body.phone || body.buyer_phone, 'phone', 30);
  const display = buyerName ? `${buyerName} (${buyerIgn})` : buyerIgn;

  if (accountLocks.has(accId)) throw conflict('Another purchase for this account is in progress. Please try again in a moment.');
  accountLocks.add(accId);
  try {
    const { headers, data } = await getSheetData(auth, 'AccountList'); // fresh read
    const acc = data.find(r => String(r.id) === accId);
    if (!acc) throw notFound('Account not found');
    if (String(acc.status).trim().toLowerCase() !== 'available') throw conflict('Sorry, this account is no longer available.');

    const price = parseFloat(acc.price);
    if (!(price > 0)) throw badRequest('This account has no valid price');
    const total = round2(price * (1 + ACCOUNT_SERVICE_RATE));

    const statusIdx = headers.indexOf('status');
    if (statusIdx < 0) throw new Error('AccountList sheet has no "status" column');
    const statusRange = `AccountList!${colLetter(statusIdx)}${acc._row}`;
    await sheetsWrite(auth, statusRange, [['reserved']]);

    const orderId = newOrderId();
    try {
      const orderHeaders = await getHeaders(auth, 'Orders');
      const row = rowFromHeaders(orderHeaders, {
        order_id: orderId, timestamp: klTime(), name: sanitizeSheetValue(display),
        phone: sanitizeSheetValue(phone), email: '',
        items: sanitizeSheetValue(`${acc.rank} · ${acc.ign || ''} · ID ${acc.accid || ''}`),
        total, note: sanitizeSheetValue(`Buyer IGN: ${buyerIgn}`), status: 'New', proof: '',
      });
      await sheetsAppend(auth, 'Orders!A1', [row]);
    } catch (err) {
      await sheetsWrite(auth, statusRange, [['available']]).catch(() => {});
      throw err;
    }

    return res.json({ result: 'ok', order_id: orderId, total, order_token: generateOrderToken(orderId) });
  } finally {
    accountLocks.delete(accId);
  }
}

// ── Public: upload payment proof (needs the order_token from newOrder/accountPurchase) ──

const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const OPEN_STATUSES = ['', 'new', 'proofsubmitted']; // once admin sets Paid/Verified/... proof is locked

export async function handleUploadProofItem(auth, body, res) {
  requireOrderToken(body);
  const orderId = String(body.order_id);

  const { headers, data } = await getSheetData(auth, 'Orders'); // fresh read
  const order = data.find(r => r.order_id === orderId);
  if (!order) throw notFound('Order not found');
  if (!OPEN_STATUSES.includes(String(order.status).trim().toLowerCase())) {
    throw conflict('This order has already been processed.');
  }

  const { buffer, mimeType } = decodeUpload(body.base64, PROOF_TYPES, 4 * 1024 * 1024);
  const statusIdx = headers.indexOf('status');
  const proofIdx = headers.indexOf('proof');
  if (statusIdx < 0 || proofIdx < 0) throw new Error('Orders sheet needs "status" and "proof" columns');

  console.log(`📤 uploadProofItem: ${orderId}`);
  const fileId = await uploadToDrive(buffer, mimeType, `${orderId}.${extForMime(mimeType)}`, process.env.DRIVE_FOLDER_RECEIPT);
  const proofFormula = mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, mimeType)}")`;

  await sheetsWriteBatch(auth, [
    { range: `Orders!${colLetter(statusIdx)}${order._row}`, values: [['ProofSubmitted']] },
    { range: `Orders!${colLetter(proofIdx)}${order._row}`, values: [[proofFormula]] },
  ]);
  console.log(`✅ proof uploaded for ${orderId}`);
  return res.json({ result: 'ok' });
}

// ── Admin ────────────────────────────────────────────────────────────────────

export async function handleUpdateOrderStatus(auth, body, res) {
  requireToken(body);
  const status = requiredText(body.status, 'status', 30);
  const { headers, data } = await getSheetData(auth, 'Orders');
  const order = data.find(r => r.order_id === body.order_id);
  if (!order) throw notFound('Order not found');
  const statusIdx = headers.indexOf('status');
  if (statusIdx < 0) throw new Error('Orders sheet has no "status" column');
  console.log(`📝 updateOrderStatus: ${body.order_id} → ${status}`);
  await sheetsWrite(auth, `Orders!${colLetter(statusIdx)}${order._row}`, [[sanitizeSheetValue(status)]]);
  return res.json({ result: 'ok' });
}

export async function handleUpdateOrderComment(auth, body, res) {
  requireToken(body);
  const comment = cleanText(body.comment, 300);
  const { headers, data } = await getSheetData(auth, 'Orders');
  const order = data.find(r => r.order_id === body.order_id);
  if (!order) throw notFound('Order not found');
  let commentIdx = headers.indexOf('comment');
  if (commentIdx === -1) {
    commentIdx = headers.length;
    await sheetsWrite(auth, `Orders!${colLetter(commentIdx)}1`, [['Comment']]);
  }
  await sheetsWrite(auth, `Orders!${colLetter(commentIdx)}${order._row}`, [[sanitizeSheetValue(comment)]]);
  console.log(`✅ comment saved for ${body.order_id}`);
  return res.json({ result: 'ok' });
}
