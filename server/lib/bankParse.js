/**
 * Parses the Maybank "money received" push notification (sent as plain text by MacroDroid).
 * Real sample (name shortened):  You've received RM 1.00 from SOME NAME BINTI M. REF: 974380032Q.
 *
 * The pattern is ANCHORED to the start of the text, so anything else (debit alerts, OTPs, login alerts,
 * or a sender who types "RM 50" in their reference) can never be read as a payment.
 * The sender name and REF are untrusted display text: never use them to approve anything.
 */
const RECEIVED_RE = /^\s*You['’]ve received RM\s*(\d[\d,]*\.\d{2})\s+from\s+(.+?)\.?(?:\s+REF:\s*(.*?))?\.?\s*$/is;

/** @returns {{amountCents:number, sender:string, ref:string}|null} */
export function parseReceived(text) {
  const m = RECEIVED_RE.exec(String(text ?? '').slice(0, 500));
  if (!m) return null;
  const amountCents = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  return { amountCents, sender: m[2].trim(), ref: (m[3] || '').trim() };
}
