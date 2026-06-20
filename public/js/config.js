// ── Global configuration ──────────────────────────────
const API_URL = '/api/index';

// ── Shared item state (used by admin + items.js) ──────
const ITEMS = [];
const DAYS = [7, 15, 30];
let qtys = {};
ITEMS.forEach(it => DAYS.forEach(d => { qtys[`${it.id}_${d}`] = 0; }));

// ── Safe fn registry ─────────────────────────────────
// items.js and account.js call registerFn() to install real implementations.
// Calls made before registration are queued and replayed once the fn registers.
const _fnRegistry = {};
function registerFn(name, fn) {
  _fnRegistry[name] = fn;
  const queue = _fnRegistry['__q_' + name] || [];
  delete _fnRegistry['__q_' + name];
  queue.forEach(args => fn(...args));
}
function _callRegistered(name, ...args) {
  if (_fnRegistry[name]) { _fnRegistry[name](...args); return; }
  if (!_fnRegistry['__q_' + name]) _fnRegistry['__q_' + name] = [];
  _fnRegistry['__q_' + name].push(args);
}
function buildTable() { _callRegistered('buildTable'); }
function recalc() { _callRegistered('recalc'); }
function renderManageList() { _callRegistered('renderManageList'); }

// ── Shared account state ─────────────────────────────
let accounts = [];

// ── Admin auth state ─────────────────────────────────
let adminUnlocked = false;
let adminToken = null;
