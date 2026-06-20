import { google } from 'googleapis';
import { getSheetData, sheetsWrite, sheetsAppend, colLetter } from '../lib/sheets.js';
import { uploadToDrive, driveUrl } from '../lib/drive.js';
import { requireToken } from '../lib/auth.js';

const KL_LOCALE = { timeZone: 'Asia/Kuala_Lumpur' };

export async function handleGetOrders(auth, res) {
  const { data } = await getSheetData(auth, 'Orders');
  return res.json({ values: data });
}

export async function handleNewOrder(auth, body, res) {
  let proofFormula = '';
  if (body.base64) {
    const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_RECEIPT);
    proofFormula = body.mimeType === 'application/pdf'
      ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
      : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  }
  const kl = new Date(body.timestamp).toLocaleString('en-US', KL_LOCALE);
  const row = [
    body.order_id, kl, body.name, body.phone || '',
    body.email || '', body.items, body.total,
    body.note || '', body.status || 'New', proofFormula,
  ];

  const { data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx >= 0) {
    await sheetsWrite(auth, `Orders!A${rowIdx + 2}:Z${rowIdx + 2}`, [row]);
  } else {
    await sheetsAppend(auth, 'Orders!A1', [row]);
  }
  return res.json({ result: 'ok' });
}

export async function handleAccountPurchase(auth, body, res) {
  console.log(`💰 accountPurchase: ${body.order_id}`);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_PAYMENT);
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  const kl = new Date(body.timestamp).toLocaleString('en-US', KL_LOCALE);
  const row = [
    body.order_id, kl, body.name, body.phone || '',
    body.email || '', body.items, body.total,
    body.note || '', 'Paid', proofFormula,
  ];
  await sheetsAppend(auth, 'Orders!A1', [row]);
  return res.json({ result: 'ok' });
}

export async function handleUpdateOrderStatus(auth, body, res) {
  requireToken(body);
  console.log(`📝 updateOrderStatus: ${body.order_id} → ${body.status}`);
  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}`, [[body.status]]);
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
  await sheetsWrite(auth, `Orders!${colLetter(commentColIdx)}${rowNum}`, [[body.comment || '']]);
  console.log(`✅ comment saved for ${body.order_id}`);
  return res.json({ result: 'ok' });
}

export async function handleUploadProofItem(auth, body, res) {
  console.log(`📤 uploadProofItem: ${body.order_id}`);
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_RECEIPT);
  const proofFormula = body.mimeType === 'application/pdf'
    ? `=HYPERLINK("https://drive.google.com/file/d/${fileId}/view","📄 View PDF")`
    : `=IMAGE("${driveUrl(fileId, body.mimeType)}")`;
  const { headers, data } = await getSheetData(auth, 'Orders');
  const rowIdx = data.findIndex(r => r.order_id === body.order_id);
  if (rowIdx === -1) throw new Error('Order not found');
  const rowNum = rowIdx + 2;
  const statusCol = colLetter(headers.indexOf('status'));
  const proofCol = colLetter(headers.indexOf('proof'));
  await sheetsWrite(auth, `Orders!${statusCol}${rowNum}:${proofCol}${rowNum}`, [['Paid', proofFormula]]);
  console.log(`✅ proof uploaded for ${body.order_id}`);
  return res.json({ result: 'ok' });
}
