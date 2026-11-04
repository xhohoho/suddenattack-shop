/**
 * Order pricing. Pure functions only (no Google Sheets, no network), so they can be unit-tested.
 * The server always prices orders itself; the browser's total is only a "did prices change?" check.
 */
import { badRequest } from './http.js';

/** Flat RM fee added once per item order (matches SERVICE_CHARGE in public/js/config.js). */
export const SERVICE_CHARGE = 0.50;
/** 10% fee added on top of account prices (matches ACCOUNT_SERVICE_RATE in config.js). */
export const ACCOUNT_SERVICE_RATE = 0.10;

export const round2 = n => Math.round(n * 100) / 100;

/**
 * Price an item order.
 * @param {Array<{id, days, qty}>} items  what the buyer chose
 * @param {Array<{id, name, p7, p15, p30}>} shopItems  current shop (from getShopItems)
 * @returns {{ total: number, itemsStr: string }}  total includes the service charge
 */
export function priceItemOrder(items, shopItems) {
  const shop = new Map(shopItems.map(i => [i.id, i]));

  let subtotal = 0;
  const lines = [];
  for (const raw of items) {
    const id = String(parseInt(raw?.id, 10));
    const days = Number(raw?.days);
    const qty = Number(raw?.qty);
    const item = shop.get(id);
    if (!item) throw badRequest('An item in your cart is no longer available. Please refresh the page.');
    if (![7, 15, 30].includes(days)) throw badRequest('Invalid duration');
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw badRequest('Invalid quantity');
    const unit = days === 7 ? item.p7 : days === 15 ? item.p15 : item.p30;
    if (!(unit > 0)) throw badRequest(`"${item.name}" is not available for ${days} days`);
    const line = round2(unit * qty);
    subtotal += line;
    lines.push(`${item.name} ${days}d x${qty} (RM ${line.toFixed(2)})`);
  }
  return { total: round2(subtotal + SERVICE_CHARGE), itemsStr: lines.join('; ') };
}

/** Public price of an account = seller's net price + 10% service charge. */
export const priceAccount = netPrice => round2(netPrice * (1 + ACCOUNT_SERVICE_RATE));
