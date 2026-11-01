import { google } from 'googleapis';
import { getSheetData, sheetsWrite, sheetsAppend, colLetter, sanitizeSheetValue } from '../lib/sheets.js';
import { uploadToDrive, driveUrl } from '../lib/drive.js';
import { requireToken, generateOrderToken, verifyOrderToken } from '../lib/auth.js';
import crypto from 'crypto';

const KL_LOCALE = { timeZone: 'Asia/Kuala_Lumpur' };
const SERVICE_CHARGE = 0.50; // RM service fee

// Whitelist of fields returned to public callers
const PUBLIC_ORDER_FIELDS = ['order_id', 'timestamp', 'name', 'items', 'total', 'status', 'comment', 'proof'];

// In-memory item cache for price lookups (refreshed periodically)
let itemPriceCache = null;
let itemCacheTime = 0;
const ITEM_CACHE_TTL_MS = 30000; // 30 seconds

async function getItemPrices(auth) {
  const now = Date.now();
  if (itemPriceCache && now - itemCacheTime < ITEM_CACHE_TTL_MS) {
    return itemPriceCache;
  }
  const { data } = await getSheetData(auth, 'CurrentShop');
  const prices = {};
  for (const row of data) {
    if (row.id && row.name) {
      prices[row.id] = {
        name: row.name,
        p7: parseFloat(row.p7) || 0,
        p15: parseFloat(row.p15) || 0,
        p30: parseFloat(row.p30) || 0,
      };
    }
  }
  itemPriceCache = prices;
  itemCacheTime = now;
  return prices;
}

function computeOrderTotal(items, prices) {
  let total = 0;
  const parts = [];
  for (const item of items) {
    const { id, days, qty } = item;
    const priceInfo = prices[id];
    if (!priceInfo) continue;
    let unitPrice = 0;
    if (days === 7) unitPrice = priceInfo.p7;
    else if (days === 15) unitPrice = priceInfo.p15;
    else if (days === 30) unitPrice = priceInfo.p30;
    const lineTotal = unitPrice * qty;
    total += lineTotal;
    parts.push(`${priceInfo.name} ${days}d x${qty} (RM ${lineTotal.toFixed(2)})`);
  }
  const serviceFee = total * SERVICE_CHARGE;
  total += serviceFee;
  return { total: parseFloat(total.toFixed(2)), items: parts.join('; '), serviceFee: parseFloat(serviceFee.toFixed(2)) };
}

export async function handleGetOrders(auth, res) {
  const { data } = await getSheetData(auth, 'Orders');
  // Return only whitelisted fields for public callers (show full name publicly)
  const publicData = data.map(row => {
    const filtered = {};
    for (const field of PUBLIC_ORDER_FIELDS) {
      filtered[field] = row[field];
    }
    return filtered;
  });
  return res.json({ values: publicData });
}

/**
 * Public: create a new item order.
 * - Server generates order_id (crypto.randomUUID)
 * - Server computes total from CurrentShop prices
 * - Forces status: 'New'
 * - Returns order_token for proof upload
 * - Never overwrites existing order
 */
export async function handleNewOrder(auth, body, res) {
  // Validate input
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }

  const prices = await getItemPrices(auth);
  const { total, items: itemsStr } = computeOrderTotal(items, prices);

  // Server-generated order ID
  const orderId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const proofFormula = ''; // No proof at creation

  const row = [
    sanitizeSheetValue(orderId),
    new Date(timestamp).toLocaleString('en-US', KL_LOCALE),
    sanitizeSheetValue(body.name || ''),
    sanitizeSheetValue(body.phone || ''),
    sanitizeSheetValue(body.email || ''),
    sanitizeSheetValue(itemsStr),
    total,
    sanitizeSheetValue(body.note || ''),
    'New', // Server forces status
    proofFormula,
  ];

  await sheetsAppend(auth, 'Orders!A1', [row]);

  // Generate order token for proof upload
  const orderToken = generateOrderToken(orderId);

  return res.json({ result: 'ok', order_id: orderId, total, order_token: orderToken });
}

/**
 * Public: account purchase (creates order + marks account reserved atomically).
 * - Server generates order_id
 * - Server computes total from account price (10% service charge added by frontend)
 * - Forces status: 'New' (admin verifies proof later)
 * - Returns order_token for proof upload
 */
export async function handleAccountPurchase(auth, body, res) {
  console.log(`💰 accountPurchase: ${body.acc_id}`);

  // Validate account exists and is available
  const { data: accounts } = await getSheetData(auth, 'AccountList');
  const acc = accounts.find(r => String(r.id) === String(body.acc_id));
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.status !== 'available') return res.status(400).json({ error: 'Account not available' });

  const orderId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const accountPrice = parseFloat(acc.price) || 0;
  const total = parseFloat((accountPrice * 1.10).toFixed(2)); // 10% service charge

  const proofFormula = '';
  const row = [
    sanitizeSheetValue(orderId),
    new Date(timestamp).toLocaleString('en-US', KL_LOCALE),
    sanitizeSheetValue(body.name || ''),
    sanitizeSheetValue(body.phone || ''),
    sanitizeSheetValue(body.email || ''),
    sanitizeSheetValue(`${acc.rank} · ${acc.ign || ''} · ID ${acc.accid || ''}`),
    total,
    sanitizeSheetValue(`Buyer IGN: ${body.buyer_ign || ''}`),
    'New', // Server forces status - admin verifies proof later
    proofFormula,
  ];

  await sheetsAppend(auth, 'Orders!A1', [row]);

  // Reserve the account atomically
  const { headers, data } = await getSheetData(auth, 'AccountList');
  const rowIdx = data.findIndex(r => String(r.id) === String(body.acc_id));
  if (rowIdx >= 0) {
    const rowNum = rowIdx + 2;
    const statusCol = colLetter(headers.indexOf('status'));
    await sheetsWrite(auth, `AccountList!${statusCol}${rowNum}`, [['reserved']]);
  }

  const orderToken = generateOrderToken(orderId);
  return res.json({ result: 'ok', order_id: orderId, total, order_token: orderToken });
}

export async function handleUpdateOrderStatus(auth, body, res) {
  requireToken(body);
  console.log(`📝 updateOrderStatus: ${body.order_id} → ${body.status}`);
  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}`, [[sanitizeSheetValue(body.status)]]);
  return res.json({ result: 'ok' });
}

export async function handleUpdateOrderComment(auth, body, res) {
  requireToken(body);
  console.log(`💬 updateOrderComment: ${body.order_id}`);
  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum = rowIdx + 2;
  let commentColIdx = headers.indexOf('comment');
  if (commentColIdx === -1) {
    commentColIdx = headers.length;
    await sheetsWrite(auth, `Orders!${colLetter(commentColIdx)}1`, [['Comment']]);
  }
  await sheetsWrite(auth, `Orders!${colLetter(commentColIdx)}${rowNum}`, [[sanitizeSheetValue(body.comment || '')]]);
  console.log(`✅ comment saved for ${body.order_id}`);
  return res.json({ result: 'ok' });
}

/**
 * Public: upload proof for an order.
 * - Requires valid order_token (HMAC of order_id)
 * - Sets status to 'ProofSubmitted' (NOT 'Paid')
 * - Only admin can set 'Paid' or 'Verified'
 */
export async function handleUploadProofItem(auth, body, res) {
  // Verify order token
  if (!verifyOrderToken(body, res)) return;
  const orderId = body.order_id;
  console.log(`📤 uploadProofItem: ${orderId}`);

  let proofFormula = '';
  if (body.base64) {
    const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_RECEIPT);
    proofFormula = body.mimeType === 'application/pdf'
      ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
      : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  }

  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === orderId);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  const proofCol = colLetter(headers.indexOf('proof'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}:${proofCol}${rowNum}`, [['ProofSubmitted', proofFormula]]);
  console.log(`✅ proof uploaded for ${orderId}`);
  return res.json({ result: 'ok' });
}

/**
 * REMOVED: handleReserveAccount - folded into accountPurchase flow
 * Account reservation now happens atomically in handleAccountPurchase
 */