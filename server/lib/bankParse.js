/**
 * Parses the "money received" push notification (sent as plain text by MacroDroid).
 * Supported formats:
 *   Maybank:      You've received RM 23.60 from SYAHIR FARHAN BIN SHAMSUD. REF: 060911366Q.
 *   Touch 'n Go:  You've just received RM 15.50 in your account ending ***0052. REF: 20261125TNGDMYNB010ORM08101733
 * (apostrophe may be ' or ’; "just" is optional; "from SENDER" is optional)
 *
 * ANCHORED to the start of the text, so debit alerts, OTPs, or a sender who types
 * "RM 50" in their reference can never be read as a payment.
 * Sender and REF are untrusted display text: never use them to approve anything.
 * The Touch 'n Go format has no sender name, so sender is '' there.
 */
const RECEIVED_RE = /^\s*You['’]ve\s+(?:just\s+)?received RM\s*(\d[\d,]*\.\d{2})(?:\s+from\s+(.+?))?(?:\s+in your account(?:\s+ending\s*[*\w]+)?)?\s*\.?(?:\s*REF:\s*(.*?))?\.?\s*$/is;

/** @returns {{amountCents:number, sender:string, ref:string}|null} */
export function parseReceived(text) {
  const m = RECEIVED_RE.exec(String(text ?? '').slice(0, 500));
  if (!m) return null;
  const amountCents = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  return { amountCents, sender: (m[2] || '').trim(), ref: (m[3] || '').trim() };
}
