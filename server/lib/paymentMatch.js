/**
 * Decides which unpaid order (if any) an incoming bank payment belongs to.
 * Pure functions (no I/O) so they can be unit-tested.
 *
 * Rules:
 *  - candidate = order still open (New / ProofSubmitted / blank), created within the time window,
 *    whose total equals the received amount (compared in whole cents)
 *  - exactly 1 candidate  -> auto_paid (the order becomes Paid). Account orders are held for review
 *                            unless AUTO_APPROVE_ACCOUNTS=true.
 *  - 2+ candidates        -> ambiguous, admin matches it by hand. (An uploaded proof is NOT used to pick
 *                            one: proofs can be faked and orders with their totals are public, so a
 *                            tie-break would let someone steal another buyer's payment.)
 *  - 0 candidates         -> unmatched, admin reviews it
 */
export const OPEN_STATUSES = new Set(['', 'new', 'proofsubmitted']);

/** "50.5", "50.50", "RM 1,234.50" -> integer cents. NaN if unreadable. */
export function toCents(v) {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Account orders are saved as "Rank · IGN · ID <accid>" (and may have an acc_id column). */
export function isAccountOrder(order) {
  return !!String(order.acc_id || '').trim() || /·\s*ID\s+\S/.test(String(order.items || ''));
}

export function findCandidates(orders, amountCents, now = Date.now(), windowMs = 30 * 60_000) {
  return orders.filter(o => {
    if (!OPEN_STATUSES.has(String(o.status ?? '').trim().toLowerCase())) return false;
    if (toCents(o.total) !== amountCents) return false;
    const t = Date.parse(o.timestamp);
    return Number.isFinite(t) && now - t >= -60_000 && now - t <= windowMs;
  });
}

/** @returns {{action:'unmatched'|'ambiguous'|'account_review'|'auto_paid', order?:object}} */
export function decide(candidates, { autoApproveAccounts = false } = {}) {
  if (candidates.length === 0) return { action: 'unmatched' };
  if (candidates.length > 1) return { action: 'ambiguous' };
  const order = candidates[0];
  if (isAccountOrder(order) && !autoApproveAccounts) return { action: 'account_review', order };
  return { action: 'auto_paid', order };
}

/**
 * True when the Payments log already holds the SAME notification (same text and amount) logged within
 * `windowMs`. Catches MacroDroid retrying one notification, without blocking a genuine second payment:
 * the bank REF can be typed by the sender, so it is never used on its own to drop a payment.
 * `rows` = Payments sheet data (headers normalised: time, amount, message).
 */
export function isDuplicate(rows, text, amountCents, now = Date.now(), windowMs = 2 * 60_000) {
  const msg = String(text ?? '').trim();
  return rows.some(r => {
    const t = Date.parse(r.time);
    return Number.isFinite(t) && now - t >= -60_000 && now - t <= windowMs
      && toCents(r.amount) === amountCents && String(r.message ?? '').trim() === msg;
  });
}
