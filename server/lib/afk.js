/**
 * AFK = an order that was placed but not paid within 24 hours (the buyer went away).
 * Pure helper (no I/O) so it can be unit-tested; api/cron-afk.js writes the result to the sheet.
 *
 * Only plain unpaid orders (status "New" or blank) become AFK. ProofSubmitted / Paid / Cancelled / ... are never touched.
 */
export const AFK_AFTER_MS = 24 * 60 * 60_000;

/** @returns the orders that should be switched to AFK now */
export function findAfkOrders(orders, now = Date.now(), afterMs = AFK_AFTER_MS) {
  return orders.filter(o => {
    const status = String(o.status ?? '').trim().toLowerCase();
    if (status !== '' && status !== 'new') return false;
    const t = Date.parse(o.timestamp);
    return Number.isFinite(t) && now - t > afterMs; // unreadable timestamps are left alone
  });
}
