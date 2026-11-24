/**
 * TEMPORARY capture endpoint: logs whatever MacroDroid sends so we can see the real notification format.
 * It does NOT touch Sheets, orders or any other data. Delete this file once the parser is written.
 *
 * Test:  open https://<your-domain>/api/payment-capture in a browser (should say "capture endpoint alive").
 * Send:  MacroDroid -> HTTP Request -> POST (or GET) to the same URL.
 * Look for log lines starting with PAYMENT_CAPTURE in Vercel runtime logs.
 */
import { rateLimit, clientIp } from '../server/lib/ratelimit.js';

// Keep Vercel from parsing the body: invalid JSON (quotes/newlines in notification text) must not hide the raw data.
export const config = { api: { bodyParser: false } };

const MAX_BYTES = 16 * 1024;

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET' && !req.url.includes('?')) {
    return res.status(200).send('capture endpoint alive');
  }

  try {
    await rateLimit(`capture:${clientIp(req)}`, 30, 10 * 60_000);
  } catch {
    return res.status(429).send('slow down');
  }

  try {
    const raw = req.method === 'GET' ? '' : await readRaw(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const h = req.headers;
    console.log('PAYMENT_CAPTURE', JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      query: Object.fromEntries(url.searchParams),
      headers: {
        'content-type': h['content-type'],
        'content-length': h['content-length'],
        'user-agent': h['user-agent'],
      },
      raw_body: raw, // JSON.stringify shows quotes/newlines/unicode exactly as received
    }));
  } catch (e) {
    console.error('PAYMENT_CAPTURE error:', e.message);
  }
  return res.status(200).send('ok');
}
