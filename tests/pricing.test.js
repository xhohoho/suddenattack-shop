import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceItemOrder, priceAccount, SERVICE_CHARGE, ACCOUNT_SERVICE_RATE } from '../server/lib/pricing.js';

const shop = [
  { id: '1', name: 'AK47', p7: 10, p15: 18, p30: 30 },
  { id: '2', name: 'M4A1', p7: 12.5, p15: 0, p30: 40 },   // not sold for 15 days
  { id: '3', name: 'Knife', p7: 0.1, p15: 0.2, p30: 0.3 },
];

const status = fn => { try { fn(); } catch (e) { return e.status; } return null; };

test('constants match the frontend (public/js/config.js)', () => {
  assert.equal(SERVICE_CHARGE, 0.5);
  assert.equal(ACCOUNT_SERVICE_RATE, 0.1);
});

test('single item: price x qty + service charge once', () => {
  const r = priceItemOrder([{ id: 1, days: 7, qty: 2 }], shop);
  assert.equal(r.total, 20.5);
  assert.equal(r.itemsStr, 'AK47 7d x2 (RM 20.00)');
});

test('multiple lines add up, service charge is added only once', () => {
  const r = priceItemOrder([{ id: 1, days: 30, qty: 1 }, { id: 2, days: 7, qty: 2 }], shop);
  assert.equal(r.total, 30 + 25 + 0.5);
  assert.equal(r.itemsStr, 'AK47 30d x1 (RM 30.00); M4A1 7d x2 (RM 25.00)');
});

test('ids may arrive as strings; client-sent prices are ignored', () => {
  const r = priceItemOrder([{ id: '1', days: 7, qty: 1, price: 0.01, total: 0 }], shop);
  assert.equal(r.total, 10.5);
});

test('rounding: no floating point drift (0.1 x 3)', () => {
  const r = priceItemOrder([{ id: 3, days: 7, qty: 3 }], shop);
  assert.equal(r.total, 0.8); // 0.30 + 0.50, not 0.8000000000000002
});

test('unknown item is rejected', () => {
  assert.equal(status(() => priceItemOrder([{ id: 99, days: 7, qty: 1 }], shop)), 400);
});

test('duration that is not sold for that item is rejected', () => {
  assert.equal(status(() => priceItemOrder([{ id: 2, days: 15, qty: 1 }], shop)), 400);
});

test('invalid duration is rejected', () => {
  assert.equal(status(() => priceItemOrder([{ id: 1, days: 10, qty: 1 }], shop)), 400);
});

test('invalid quantities are rejected (0, negative, 100, decimal, text)', () => {
  for (const qty of [0, -1, 100, 1.5, 'abc', undefined]) {
    assert.equal(status(() => priceItemOrder([{ id: 1, days: 7, qty }], shop)), 400, `qty ${qty}`);
  }
});

test('account price = net price + 10%, rounded to 2 decimals', () => {
  assert.equal(priceAccount(350), 385);
  assert.equal(priceAccount(99.99), 109.99);
});
