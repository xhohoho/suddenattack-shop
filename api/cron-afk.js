/**
 * POST/GET /api/cron-afk   (called once a day by Vercel Cron, see vercel.json)
 *
 * Sets the status of every unpaid order older than 24 hours to "AFK" in the Orders sheet.
 * Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; without CRON_SECRET set the endpoint refuses everything.
 */
import { getAuth, safeEqual } from '../server/lib/auth.js';
import { getSheetData, sheetsWriteBatch, colLetter } from '../server/lib/sheets.js';
import { findAfkOrders } from '../server/lib/afk.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).send('CRON_SECRET is not configured');
  if (!safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) return res.status(401).send('unauthorized');

  try {
    const auth = await getAuth().getClient();
    const { headers, data } = await getSheetData(auth, 'Orders'); // fresh read
    const statusIdx = headers.indexOf('status');
    if (statusIdx < 0) throw new Error('Orders sheet has no "status" column');

    const stale = findAfkOrders(data);
    const updates = stale.map(o => ({ range: `Orders!${colLetter(statusIdx)}${o._row}`, values: [['AFK']] }));
    for (let i = 0; i < updates.length; i += 200) await sheetsWriteBatch(auth, updates.slice(i, i + 200));

    console.log(`cron-afk: ${stale.length} unpaid order(s) older than 24h set to AFK (of ${data.length} read)`);
    return res.status(200).json({ afk: stale.length });
  } catch (e) {
    console.error('cron-afk error:', e);
    return res.status(500).send('error');
  }
}
