import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceived } from '../server/lib/bankParse.js';
import { findCandidates, decide, toCents } from '../server/lib/paymentMatch.js';

test('parses the real Maybank format', () => {
  const p = parseReceived("You've received RM 1.00 from TEST NAME BINTI M. REF: 974380032Q.");
  assert.deepEqual(p, { amountCents: 100, sender: 'TEST NAME BINTI M', ref: '974380032Q' });
});
test('thousands separator and curly apostrophe', () => {
  assert.equal(parseReceived('You’ve received RM 1,234.50 from A B. REF: X.').amountCents, 123450);
});
test('works without REF', () => {
  assert.equal(parseReceived("You've received RM 5.00 from A B.").amountCents, 500);
});
test('rejects anything not starting with the template', () => {
  assert.equal(parseReceived("You've sent RM 5.00 to A B."), null);
  assert.equal(parseReceived("Hi. You've received RM 5.00 from A. REF: x"), null);
  assert.equal(parseReceived('Your OTP is 123456'), null);
});
test('amount typed in the reference cannot change the amount', () => {
  assert.equal(parseReceived("You've received RM 1.00 from A. REF: RM 50.37.").amountCents, 100);
});

const now = Date.parse('2026-11-24T10:00:00Z');
const mk = (id, total, minsAgo, status = 'New', items = 'Item x1') =>
  ({ order_id: id, total, status, items, timestamp: new Date(now - minsAgo * 60_000).toISOString() });

test('toCents', () => { assert.equal(toCents('30.5'), 3050); assert.equal(toCents(12.35), 1235); });
test('one match is auto-paid', () => {
  const c = findCandidates([mk('A', '30.00', 5), mk('B', '31.00', 5)], 3000, now);
  assert.equal(c.length, 1);
  const d = decide(c);
  assert.equal(d.action, 'auto_paid'); assert.equal(d.order.order_id, 'A');
});
test('an order that already has proof uploaded is matched too', () => {
  const c = findCandidates([mk('A', '30.00', 5, 'ProofSubmitted')], 3000, now);
  assert.equal(decide(c).action, 'auto_paid');
});
test('proof on a same-amount order does NOT break a tie (it could be faked)', () => {
  const c = findCandidates([mk('A', '30', 5, 'ProofSubmitted'), mk('B', '30', 2, 'New')], 3000, now);
  assert.equal(decide(c).action, 'ambiguous');
});
test('two same-amount orders are ambiguous', () => {
  const c = findCandidates([mk('A', '30', 5), mk('B', '30.00', 2)], 3000, now);
  assert.equal(decide(c).action, 'ambiguous');
});
test('old (over 24h), paid, cancelled or AFK orders are ignored', () => {
  const c = findCandidates([mk('A', '30', 25 * 60), mk('B', '30', 5, 'Paid'), mk('C', '30', 5, 'Cancelled'), mk('D', '30', 5, 'AFK')], 3000, now);
  assert.equal(decide(c).action, 'unmatched');
});
test('an order placed 23 hours ago can still be auto-matched (24h window)', () => {
  const c = findCandidates([mk('A', '30', 23 * 60)], 3000, now);
  assert.equal(decide(c).action, 'auto_paid');
});
test('account orders need manual review unless enabled', () => {
  const c = findCandidates([mk('A', '300', 5, 'New', 'Rank · IGN · ID 12345')], 30000, now);
  assert.equal(decide(c).action, 'account_review');
  assert.equal(decide(c, { autoApproveAccounts: true }).action, 'auto_paid');
});

test('same notification logged moments ago is a duplicate; later or different is not', async () => {
  const { isDuplicate } = await import('../server/lib/paymentMatch.js');
  const msg = "You've received RM 30.00 from A B. REF: X.";
  const row = (minsAgo, m = msg) => ({ time: new Date(now - minsAgo * 60_000).toISOString(), amount: '30', message: m });
  assert.equal(isDuplicate([row(1)], msg, 3000, now), true);
  assert.equal(isDuplicate([row(10)], msg, 3000, now), false);
  assert.equal(isDuplicate([row(1, "You've received RM 30.00 from C D.")], msg, 3000, now), false);
  assert.equal(isDuplicate([], msg, 3000, now), false);
});
