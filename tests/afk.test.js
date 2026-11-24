import test from 'node:test';
import assert from 'node:assert/strict';
import { findAfkOrders } from '../server/lib/afk.js';

const now = Date.parse('2026-11-25T00:00:00Z');
const o = (id, status, hoursAgo) => ({ order_id: id, status, timestamp: new Date(now - hoursAgo * 3600_000).toISOString() });

test('unpaid orders older than 24h become AFK', () => {
  const r = findAfkOrders([o('a', 'New', 25), o('b', '', 30), o('c', 'New', 23), o('d', 'New', 24)], now);
  assert.deepEqual(r.map(x => x.order_id), ['a', 'b']);
});
test('orders that are paid, have proof, or were cancelled are never touched', () => {
  const r = findAfkOrders(['Paid', 'ProofSubmitted', 'Verified', 'Completed', 'Cancelled', 'AFK'].map((s, i) => o('x' + i, s, 100)), now);
  assert.equal(r.length, 0);
});
test('legacy and unreadable timestamps', () => {
  const legacy = { order_id: 'l', status: 'New', timestamp: '10/23/2026, 3:08:13 AM' };
  const junk = { order_id: 'j', status: 'New', timestamp: 'not a date' };
  assert.deepEqual(findAfkOrders([legacy, junk], now).map(x => x.order_id), ['l']);
});
