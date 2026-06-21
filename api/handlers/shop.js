import { google } from 'googleapis';
import { sheetsRead, sheetsAppend, sheetsWrite } from '../lib/sheets.js';
import { uploadToDrive, driveUrl } from '../lib/drive.js';
import { callGemini, parseGeminiJson } from '../lib/gemini.js';
import { requireToken } from '../lib/auth.js';
import { sanitizeSheetValue } from '../lib/sheets.js';

export async function handleGetShopItems(auth, res) {
  const rows = await sheetsRead(auth, 'CurrentShop!A1:F1000');
  if (!rows || rows.length < 2) return res.json({ values: [] });
  const data = rows.slice(1)
    .filter(row => row.some(cell => cell !== ''))
    .map((row, i) => ({
      id:  row[0] || String(i + 1),
      name: row[1] || '',
      desc: row[2] || '',
      p7:  row[3] || '',
      p15: row[4] || '',
      p30: row[5] || '',
    }))
    .filter(it => it.name);
  return res.json({ values: data });
}

export async function handleSaveItems(auth, body, res) {
  requireToken(body);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.clear({ spreadsheetId: process.env.SHEET_ID, range: 'CurrentShop!A2:Z1000' });
  const rows = body.items.map(it => [it.id, sanitizeSheetValue(it.name), sanitizeSheetValue(it.desc || ''), it.p[7] || '', it.p[15] || '', it.p[30] || '']);
  await sheetsAppend(auth, 'CurrentShop!A2', rows);
  return res.json({ result: 'ok' });
}

export async function handleExtractItems(auth, body, res) {
  requireToken(body);
  console.log('🖼 extractItems: uploading image to Drive...');
  const fileId = await uploadToDrive(body.base64, body.mimeType, body.fileName, process.env.DRIVE_FOLDER_SA);
  const url = driveUrl(fileId, body.mimeType);
  console.log(`✅ uploaded: ${fileId}`);

  console.log('🤖 calling Gemini for item extraction...');
  const prompt = `Extract all game item names from this shop image. Return ONLY a JSON array of strings like: ['Item Name 1', 'Item Name 2']. No descriptions, no prices, no markdown, no explanation.`;
  const text = await callGemini(body.base64, prompt);
  const names = parseGeminiJson(text);
  const items = names.map((name, i) => ({ id: i + 1, name, desc: '', p7: 0, p15: 0, p30: 0 }));
  console.log(`✅ Gemini extracted ${items.length} items`);
  return res.json({ items, url });
}

export async function handleExtractAccountStats(body, res) {
  requireToken(body);
  console.log('🤖 extractAccountStats: calling Gemini...');
  const prompt = `Extract player stats from this Sudden Attack game profile screenshot. Return ONLY a valid JSON object with these exact keys: ign, Id, kda(%), winRate(%), exp(%). If a field is not visible return empty string. No symbol just value. No markdown, no explanation, only JSON.`;
  const text = await callGemini(body.base64, prompt);
  let stats = {};
  try { stats = parseGeminiJson(text); } catch { /* return partial if parse fails */ }
  console.log(`✅ stats extracted: ${JSON.stringify(stats)}`);
  return res.json(stats);
}
