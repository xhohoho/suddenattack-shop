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

// ── Business constants ────────────────────────────────
const SERVICE_CHARGE = 0.50;          // RM service fee for item orders
const ACCOUNT_SERVICE_RATE = 0.10;    // 10% service charge for account listings

// Turnstile CAPTCHA (set at build time via env var, defaults to empty = disabled)
// (window.TURNSTILE_SITE_KEY is set by a small inline script in main.html, filled in by build.js)

// ── Shared validation constants ──────────────────────
const MAX_IMAGE_SIZE_MB = 5;
const MAX_VIDEO_SIZE_MB = 50;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

function validateFile(file, { maxSizeMB = MAX_IMAGE_SIZE_MB, allowedTypes = ALLOWED_IMAGE_TYPES } = {}) {
  if (!file) return { ok: false, error: 'No file selected' };
  if (file.size > maxSizeMB * 1024 * 1024) {
    return { ok: false, error: `File too large (max ${maxSizeMB}MB)` };
  }
  if (!allowedTypes.includes(file.type)) {
    return { ok: false, error: `Invalid file type. Allowed: ${allowedTypes.join(', ')}` };
  }
  return { ok: true };
}

// ── Admin auth state ─────────────────────────────────
let adminUnlocked = false;
let adminToken = (() => {
  try { return sessionStorage.getItem('adminToken'); } catch { return null; }
})();
if (adminToken) adminUnlocked = true; // will be validated on first adminFetch
