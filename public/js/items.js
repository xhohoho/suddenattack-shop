// ── Items data ─────────────────────────────
// ITEMS, DAYS, qtys are declared in config.js — we just populate them here.
// Reset to empty defaults; fetchItems() will load real data from sheet.
ITEMS.length = 0;
ITEMS.push({ id: 1, name: 'Item 1', desc: '', p: { 7: 0, 15: 0, 30: 0 } });
DAYS.forEach(d => { qtys[`1_${d}`] = 0; });

let currentOrderId = null;
let currentOrderTimestamp = null;
let currentOrderToken = null;

// ── Item cards render ──────────────────────
// (kept the name buildTable(): boot.js / admin.js call buildTable() + recalc() after loading items)

function buildTable() {
  document.getElementById('itgrid').innerHTML = ITEMS.map(it => {
    const rows = DAYS.filter(d => it.p[d]).map(d => {
      const q = qtys[`${it.id}_${d}`] || 0;
      const who = escapeHtml(`${d} days, ${it.name}`);
      return `<div class="drow">
        <div class="drow-label"><span class="drow-days">${d} days</span><span class="unit-price">${fmt(it.p[d])} / unit</span></div>
        <div class="qty-wrap">
          <button type="button" class="qty-btn" data-action="qty" data-id="${it.id}" data-day="${d}" data-delta="-1" aria-label="Decrease ${who}"${q === 0 ? ' disabled' : ''}>−</button>
          <span class="qty-num${q === 0 ? ' zero' : ''}" id="q${it.id}_${d}">${q}</span>
          <button type="button" class="qty-btn" data-action="qty" data-id="${it.id}" data-day="${d}" data-delta="1" aria-label="Increase ${who}">+</button>
        </div>
      </div>`;
    }).join('');
    return `<article class="icard" id="ic${it.id}" data-search="${escapeHtml((it.name + ' ' + it.desc).toLowerCase())}">
      <div class="icard-head">
        <div><div class="iname">${escapeHtml(it.name)}</div>${it.desc ? `<div class="idesc">${escapeHtml(it.desc)}</div>` : ''}</div>
        <span class="row-amt zero" id="ra${it.id}"></span>
      </div>
      ${rows ? `<div class="drows">${rows}</div>` : '<div class="icard-na">Currently unavailable</div>'}
    </article>`;
  }).join('');
  filterTable();
}

function changeQty(id, day, delta) {
  const item = ITEMS.find(it => it.id === id);
  if (!item || !item.p[day]) return;
  const k = `${id}_${day}`;
  qtys[k] = Math.max(0, (qtys[k] || 0) + delta);
  recalc();
}

// Brings every part of the UI in line with `qtys`: the steppers on the cards, the cart preview,
// the totals and the mobile checkout bar.
function recalc() {
  let tot = 0, units = 0;
  const lines = [];
  ITEMS.forEach(it => {
    let r = 0;
    DAYS.forEach(d => {
      const q = qtys[`${it.id}_${d}`] || 0;
      const num = document.getElementById(`q${it.id}_${d}`);
      if (num) {
        num.textContent = q;
        num.className = 'qty-num' + (q === 0 ? ' zero' : '');
        const minus = num.previousElementSibling;
        if (minus) minus.disabled = q === 0;
      }
      if (q > 0) { r += q * it.p[d]; units += q; lines.push({ it, d, q, amt: q * it.p[d] }); }
    });
    tot += r;
    const amtEl = document.getElementById('ra' + it.id);
    if (amtEl) { amtEl.textContent = r > 0 ? fmt(r) : ''; amtEl.className = 'row-amt' + (r > 0 ? '' : ' zero'); }
    const card = document.getElementById('ic' + it.id);
    if (card) card.classList.toggle('has-qty', r > 0);
  });

  const has = lines.length > 0;
  const grand = has ? tot + SERVICE_CHARGE : 0;

  // cart preview
  document.getElementById('cart-list').innerHTML = lines.map(l => `
    <li class="cart-line">
      <div><div class="cart-line-name">${escapeHtml(l.it.name)}</div><div class="cart-line-meta">${l.d} days × ${l.q}</div></div>
      <div class="cart-line-amt">${fmt(l.amt)}</div>
      <button type="button" class="cart-line-rm" data-action="removeLine" data-id="${l.it.id}" data-day="${l.d}" aria-label="Remove ${escapeHtml(`${l.it.name}, ${l.d} days`)} from cart">✕</button>
    </li>`).join('');
  document.getElementById('cart-list').style.display = has ? '' : 'none';
  document.getElementById('cart-empty').style.display = has ? 'none' : '';
  document.getElementById('cart-count').textContent = units;

  // totals (sticky card) + mobile bar
  document.getElementById('co-sub').textContent = fmt(tot);
  document.getElementById('co-fee').textContent = fmt(SERVICE_CHARGE);
  document.getElementById('co-sub-row').style.display = has ? '' : 'none';
  document.getElementById('co-fee-row').style.display = has ? '' : 'none';
  document.getElementById('gtotal').textContent = fmt(grand);
  document.getElementById('co-bar-total').textContent = fmt(grand);
  document.getElementById('co-bar-count').textContent = has ? `${units} item${units === 1 ? '' : 's'} in cart` : 'Your cart is empty';
  document.getElementById('sumhint').textContent = has ? 'You will get a payment QR after placing your order.' : 'Add quantity to place an order.';
  if (has) setCheckoutError('');
}

// ── Checkout card: mobile sheet + inline errors ──

function setCheckoutOpen(open) {
  const side = document.getElementById('checkout');
  side.classList.toggle('open', open);
  document.getElementById('co-bar').setAttribute('aria-expanded', String(open));
  document.getElementById('co-cta-text').textContent = open ? 'Close' : 'Checkout';
}

function setCheckoutError(msg) {
  document.getElementById('co-error').textContent = msg || '';
}

function getLines() {
  const l = [];
  ITEMS.forEach(it => DAYS.forEach(d => { const q = qtys[`${it.id}_${d}`]; if (q > 0) l.push(`${it.name} ${d}d x${q} (${fmt(it.p[d] * q)})`); }));
  return l.join('; ');
}

function getOrderItems() {
  const items = [];
  ITEMS.forEach(it => DAYS.forEach(d => {
    const q = qtys[`${it.id}_${d}`];
    if (q > 0) items.push({ id: it.id, days: d, qty: q });
  }));
  return items;
}

function getTotal() {
  return ITEMS.reduce((s, it) => s + DAYS.reduce((ss, d) => ss + qtys[`${it.id}_${d}`] * it.p[d], 0), 0);
}

function filterTable() {
  const q = document.getElementById('item-search').value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#itgrid .icard').forEach(card => {
    const match = !q || card.dataset.search.includes(q);
    card.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  const empty = document.getElementById('item-empty');
  empty.classList.toggle('hide', shown > 0);
  empty.textContent = !document.querySelector('#itgrid .icard') ? 'Loading items…' : 'No items match your search.';
}

// ── Order submit ───────────────────────────

async function submitOrder() {
  const nameEl = document.getElementById('fn');
  const name = nameEl.value.trim();
  if (!Object.values(qtys).some(v => v > 0)) { setCheckoutError('Add at least one item.'); showToast('Add at least one item.'); return; }
  if (!name) {
    nameEl.classList.add('invalid'); nameEl.focus();
    setCheckoutError('Please enter your in-game name.'); showToast('Please enter your in-game name.'); return;
  }
  setCheckoutError('');
  const items = getOrderItems();
  // The server prices the order itself from the shop sheet. `total` is only what the buyer
  // saw on screen: if prices changed meanwhile, the server refuses instead of charging a surprise.
  const shownTotal = (getTotal() + SERVICE_CHARGE).toFixed(2);
  const note = document.getElementById('fno').value.trim();
  const btn = document.getElementById('sbtn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const result = await apiPost({ action: 'newOrder', name, note, items, total: shownTotal });
    if (!result.order_id || !result.order_token) throw new Error('Order was not saved. Please try again.');
    // Remember the token: it is required to upload payment proof (and survives a page refresh).
    saveOrderToken(result.order_id, result.order_token);
    currentOrderToken = result.order_token;
    ['fn', 'fno'].forEach(id => document.getElementById(id).value = '');
    ITEMS.forEach(it => DAYS.forEach(d => { qtys[`${it.id}_${d}`] = 0; }));
    recalc();
    setCheckoutOpen(false);
    _lastFeedData = '';
    await fetchSheet();
    openModal(result.total, result.order_id, new Date().toISOString());
  } catch (e) {
    const offline = e instanceof TypeError; // fetch() itself failed
    showToast(offline ? 'Failed to submit. Check your connection.' : e.message);
  }
  btn.disabled = false; btn.textContent = 'Place order';
}

// ── Payment modal ──────────────────────────

// While the popup is open it asks the server for this order's status every few seconds, so the buyer
// sees "Payment confirmed" without refreshing. (Needs the order_token.)
let orderPollTimer = null;
const DONE_STATES = ['Paid', 'Verified', 'Completed'];

function stopOrderPoll() { if (orderPollTimer) { clearInterval(orderPollTimer); orderPollTimer = null; } }

function setModalMessage(text, color) {
  const el = document.getElementById('upload-status-item');
  el.textContent = text; el.style.color = color || '';
}

function showPaidState() {
  stopOrderPoll();
  const oid = currentOrderId;
  setModalMessage('✅ Payment confirmed! Thank you.', 'var(--green)');
  document.getElementById('upload-area').style.display = 'none';
  document.getElementById('upload-btn-item').style.display = 'none';
  setTimeout(() => { if (currentOrderId === oid) { closeModal(); _lastFeedData = ''; fetchSheet(); } }, 4000);
}

function applyOrderStatus(st) {
  if (DONE_STATES.includes(st)) showPaidState();
  else if (st === 'ProofSubmitted') setModalMessage('Proof received. We will verify your payment soon. This page updates by itself once it is confirmed.', 'var(--green)');
  else if (st === 'Cancelled') { stopOrderPoll(); setModalMessage('This order was cancelled.', 'var(--red)'); }
}

function startOrderPoll() {
  stopOrderPoll();
  if (!currentOrderId || !currentOrderToken) return;
  const oid = currentOrderId;
  let busy = false, ticks = 0;
  const tick = async () => {
    if (busy || currentOrderId !== oid) return;
    if (++ticks > 170) { stopOrderPoll(); return; } // gives up after ~20 minutes
    busy = true;
    try {
      const r = await apiPost({ action: 'orderStatus', order_id: oid, order_token: currentOrderToken });
      if (currentOrderId === oid) applyOrderStatus(r.status);
    } catch { /* network hiccup or rate limit: try again next time */ }
    busy = false;
  };
  orderPollTimer = setInterval(tick, 7000);
  tick();
}

function openModal(total, orderId, timestamp) {
  if (typeof total === 'object' && total.dataset) {
    currentOrderId = total.dataset.oid;
    currentOrderTimestamp = total.dataset.ts;
    document.getElementById('modal-amt-item').textContent = fmt(+total.dataset.tot);
  } else {
    currentOrderId = orderId;
    currentOrderTimestamp = timestamp;
    document.getElementById('modal-amt-item').textContent = fmt(+total);
  }
  // Always look the token up for THIS order (never reuse the previous order's token).
  currentOrderToken = getOrderToken(currentOrderId);
  const oidEl = document.getElementById('modal-order-id');
  if (oidEl) oidEl.textContent = currentOrderId || '—';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('upload-status-item').textContent = currentOrderToken ? '' : 'This order was placed in another browser, so proof can only be uploaded there. Please contact us with your Order ID.';
  // Show "Find my order" link if no token
  const findLink = document.getElementById('find-order-link-item');
  if (findLink) findLink.style.display = currentOrderToken ? 'none' : 'block';
  const ubtn = document.getElementById('upload-btn-item');
  ubtn.style.display = 'none'; ubtn.disabled = false; ubtn.textContent = 'Submit proof';
  document.getElementById('preview-img-item').style.display = 'none';
  const pdfTagItem = document.getElementById('preview-pdf-item');
  if (pdfTagItem) pdfTagItem.style.display = 'none';
  const fi = document.getElementById('proof-file-item');
  fi.value = ''; fi.disabled = !currentOrderToken;
  document.getElementById('upload-area').style.display = '';
  startOrderPoll();
}

function closeModal() {
  stopOrderPoll();
  document.getElementById('modal-overlay').classList.remove('open');
  currentOrderId = null; currentOrderTimestamp = null; currentOrderToken = null;
}

// ── Find My Order modal ──────────────────────
// Shared state for which tab (item/account) the user came from
let _findOrderOrigin = 'item';

function openFindOrderModal(origin) {
  _findOrderOrigin = origin;
  document.getElementById('find-ign').value = '';
  document.getElementById('find-phone').value = '';
  document.getElementById('find-email').value = '';
  document.getElementById('find-order-results').innerHTML = '';
  document.getElementById('find-order-results').style.display = 'none';
  document.getElementById('find-order-status').textContent = '';
  document.getElementById('find-submit-btn').disabled = false;
  document.getElementById('find-submit-btn').textContent = 'Find my order';
  document.getElementById('find-order-overlay').classList.add('open');
}

function closeFindOrderModal() {
  document.getElementById('find-order-overlay').classList.remove('open');
}

async function submitFindOrder() {
  const ign = document.getElementById('find-ign').value.trim();
  const phone = document.getElementById('find-phone').value.trim();
  const email = document.getElementById('find-email').value.trim();
  const statusEl = document.getElementById('find-order-status');
  const resultsEl = document.getElementById('find-order-results');
  const btn = document.getElementById('find-submit-btn');

  if (!ign || (!phone && !email)) {
    statusEl.textContent = 'Please enter your IGN and phone or email.';
    statusEl.style.color = 'var(--red)';
    return;
  }

  btn.disabled = true; btn.textContent = 'Searching...';
  statusEl.textContent = ''; statusEl.style.color = '';
  resultsEl.innerHTML = ''; resultsEl.style.display = 'none';

  try {
    const res = await apiPost({ action: 'findOrder', name: ign, phone, email });
    const orders = res.orders || [];
    if (!orders.length) {
      statusEl.textContent = 'No matching orders found. Check your details and try again.';
      statusEl.style.color = 'var(--red)';
      btn.disabled = false; btn.textContent = 'Find my order';
      return;
    }

    // Show matches with "Use this order" buttons
    resultsEl.innerHTML = orders.map(o => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:var(--bg3)">
        <div style="font-family:'Rajdhani',sans-serif;font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">${escapeHtml(o.order_id)}</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:2px">${escapeHtml(o.items)}</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:2px">Total: ${fmt(o.total)} · Status: ${escapeHtml(o.status)}</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:8px">${timeAgo(o.timestamp)}</div>
        <button data-use-order="${escapeHtml(o.order_id).replace(/"/g, '"')}" data-use-token="${escapeHtml(o.order_token).replace(/"/g, '"')}" style="padding:6px 12px;background:var(--accent);color:#0a0b0f;border:none;border-radius:4px;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:700;cursor:pointer">Use this order</button>
      </div>
    `).join('');
    resultsEl.style.display = 'block';
    statusEl.textContent = `Found ${orders.length} order(s). Click "Use this order" to continue.`;
    statusEl.style.color = 'var(--green)';
  } catch (e) {
    statusEl.textContent = 'Search failed: ' + e.message;
    statusEl.style.color = 'var(--red)';
  }
  btn.disabled = false; btn.textContent = 'Find my order';
}

function useFoundOrder(orderId, orderToken) {
  saveOrderToken(orderId, orderToken);
  closeFindOrderModal();
  closeModal();
  // Re-open payment modal with the found order
  openModal({ dataset: { oid: orderId, tot: 0, ts: new Date().toISOString() } });
  // The modal will pick up the token from localStorage
  setTimeout(() => {
    const fi = document.getElementById('proof-file-item');
    fi.disabled = false;
    const findLink = document.getElementById('find-order-link-item');
    if (findLink) findLink.style.display = 'none';
  }, 50);
}

function copyOrderId() {
  if (!currentOrderId) return;
  navigator.clipboard.writeText(currentOrderId).then(() => { showToast('Order ID copied!'); }).catch(() => { showToast(currentOrderId); });
}

function previewFileItem(input) {
  previewProofFile(input, 'preview-img-item', 'preview-pdf-item', 'upload-btn-item');
}

async function uploadProofItem() {
  const file = document.getElementById('proof-file-item').files[0];
  const status = document.getElementById('upload-status-item');
  if (!file || !currentOrderId) { showToast("No file selected or Order ID not found. Try clicking 'Pay' again."); return; }
  if (!currentOrderToken) { status.textContent = 'Cannot upload from this browser. Please contact us with your Order ID.'; status.style.color = 'var(--red)'; return; }
  const btn = document.getElementById('upload-btn-item');
  btn.disabled = true; btn.textContent = 'Uploading...';
  status.textContent = ''; status.style.color = '';
  try {
    const result = await uploadProofFile(file, currentOrderId, 'uploadProofItem', {}, currentOrderToken);
    btn.textContent = 'Submitted ✓';
    _lastFeedData = ''; fetchSheet();
    // If the bank notification already marked the order Paid, say so; otherwise the page keeps watching.
    if (result && DONE_STATES.includes(result.status)) showPaidState();
    else {
      status.textContent = 'Submitted! We will verify your payment soon. This page updates by itself once it is confirmed.';
      status.style.color = 'var(--green)';
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Submit proof';
    status.textContent = 'Failed: ' + e.message; status.style.color = 'var(--red)';
  }
}

document.getElementById('modal-overlay').addEventListener('click', function (e) { if (e.target === this) closeModal(); });

// ── Event delegation for data-action (replaces onclick) ─────────────────
document.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const origin = btn.dataset.origin;

  switch (action) {
    case 'filterTable':
      filterTable();
      break;
    case 'qty':
      changeQty(+btn.dataset.id, +btn.dataset.day, +btn.dataset.delta);
      break;
    case 'removeLine':
      qtys[`${btn.dataset.id}_${btn.dataset.day}`] = 0;
      recalc();
      break;
    case 'toggleCheckout':
      setCheckoutOpen(!document.getElementById('checkout').classList.contains('open'));
      break;
    case 'submitOrder':
      submitOrder();
      break;
    case 'closeModal':
      closeModal();
      break;
    case 'copyOrderId':
      copyOrderId();
      break;
    case 'openFindOrderModal':
      openFindOrderModal(origin || 'item');
      break;
    case 'uploadProofItem':
      uploadProofItem();
      break;
    case 'closeFindOrderModal':
      closeFindOrderModal();
      break;
    case 'submitFindOrder':
      submitFindOrder();
      break;
    case 'useFoundOrder':
      // Handled separately via dynamic buttons in results
      break;
  }
});

// Filter the item list as the user types (the click handler above only fires on mouse click)
document.addEventListener('input', function (e) {
  if (e.target.closest('[data-action="filterTable"]')) filterTable();
  if (e.target.id === 'fn') { e.target.classList.remove('invalid'); setCheckoutError(''); }
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') setCheckoutOpen(false);
});

// Handle file input changes
document.addEventListener('change', function (e) {
  const input = e.target.closest('[data-action="previewFileItem"]');
  if (input) previewFileItem(input);
});

// Dynamic "Use this order" buttons in find-order results
document.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-use-order]');
  if (btn) {
    useFoundOrder(btn.dataset.useOrder, btn.dataset.useToken);
  }
});

// ── Fetch items from sheet ─────────────────

async function fetchItems() {
  try {
    const d = await apiPost({ action: 'getShopItems' });
    if (!d.values || !d.values.length) return;
    const loaded = d.values.map((row, i) => ({
      id: parseInt(row.id) || i + 1,
      name: row.name || '',
      desc: row.desc || row.description || '',
      p: {
        7:  parseFloat((row['7d']  || row['p7']  || '0').toString().replace(/,/g, '')) || 0,
        15: parseFloat((row['15d'] || row['p15'] || '0').toString().replace(/,/g, '')) || 0,
        30: parseFloat((row['30d'] || row['p30'] || '0').toString().replace(/,/g, '')) || 0,
      }
    })).filter(it => it.name);
    if (loaded.length) {
      ITEMS.length = 0; loaded.forEach(it => ITEMS.push(it));
      qtys = {}; ITEMS.forEach(it => DAYS.forEach(d => { qtys[`${it.id}_${d}`] = 0; }));
    }
  } catch (e) { /* keep defaults */ }
}
// NOTE: boot call (fetchItems + buildTable + recalc) is in boot.js unified boot
