/**
 * Webhook dispatcher for order events (Discord, or any URL that accepts JSON).
 *
 * Set WEBHOOK_URL in Vercel to turn it on. Nothing is sent when it is not set.
 *   - Discord webhook URL  -> a readable chat message is posted.
 *   - Any other URL        -> JSON { event, timestamp, payload }, signed with
 *                             X-Webhook-Signature (HMAC-SHA256) when WEBHOOK_SECRET is set.
 *
 * These functions NEVER throw and are short-lived (3s timeout), so a broken or slow
 * webhook can never stop an order from being saved. Callers should `await` them:
 * on Vercel a request that is not awaited can be cut off when the response is sent.
 */
import crypto from 'crypto';

const TIMEOUT_MS = 3000;

function isDiscord(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'discord.com' || h.endsWith('.discord.com') || h === 'discordapp.com' || h.endsWith('.discordapp.com');
  } catch { return false; }
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function discordText(event, p) {
  if (event === 'order.created') {
    return `🛒 **New order** \`${p.order_id}\`\n`
      + `Buyer: ${clip(p.name, 60)}\n`
      + `Items: ${clip(p.items, 600)}\n`
      + `Total: RM ${Number(p.total).toFixed(2)}`
      + (p.note ? `\nNote: ${clip(p.note, 300)}` : '');
  }
  if (event === 'proof.uploaded') {
    return `📎 **Payment proof uploaded** for \`${p.order_id}\`\n${p.proof_url}`;
  }
  return `${event}: ${clip(JSON.stringify(p), 1500)}`;
}

/**
 * Send a webhook event. Never throws.
 * @param {string} event - e.g. 'order.created', 'proof.uploaded'
 * @param {object} payload
 */
export async function sendWebhook(event, payload) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return; // not configured: do nothing

  try {
    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (isDiscord(url)) {
      // allowed_mentions: [] stops buyer-typed text like @everyone from pinging your server.
      body = JSON.stringify({ content: clip(discordText(event, payload), 1900), allowed_mentions: { parse: [] } });
    } else {
      body = JSON.stringify({ event, timestamp: new Date().toISOString(), payload });
      const secret = process.env.WEBHOOK_SECRET;
      if (secret) headers['X-Webhook-Signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex');
    }

    const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) console.warn(`Webhook ${event} failed: ${r.status} ${r.statusText}`);
  } catch (e) {
    console.error(`Webhook ${event} error:`, e.message);
  }
}

/** order.created */
export async function sendOrderCreatedWebhook(order) {
  await sendWebhook('order.created', {
    order_id: order.order_id,
    total: order.total,
    name: order.name,
    items: order.items,
    note: order.note,
    timestamp: order.timestamp,
  });
}

/** proof.uploaded */
export async function sendProofUploadedWebhook(orderId, proofUrl) {
  await sendWebhook('proof.uploaded', {
    order_id: orderId,
    proof_url: proofUrl,
    timestamp: new Date().toISOString(),
  });
}
