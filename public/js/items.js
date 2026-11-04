// ── Items data ─────────────────────────────
// ITEMS, DAYS, qtys are declared in config.js — we just populate them here.
// Reset to empty defaults; fetchItems() will load real data from sheet.
ITEMS.length = 0;
ITEMS.push({ id: 1, name: 'Item 1', desc: '', p: { 7: 0, 15: 0, 30: 0 } });
DAYS.forEach(d => { qtys[`1_${d}`] = 0; });

let currentOrderId = null;
let currentOrderTimestamp = null;
let currentOrderToken = null;

// ── Table render ───────────────────────────

function buildTable() {
  document.getElementById('itbody').innerHTML = ITEMS.map(it => `
    <tr>
      <td><div class="iname">${escapeHtml(it.name)}</div><div class="idesc">${escapeHtml(it.desc)}</div></td>
      ${DAYS.map(d => {
        if (!it.p[d]) return `<td><div style="text-align:center;color:var(--text3);font-size:12px">—</div></td>`;
        return `<td>
          <div class="qty-wrap">
            <button class="qty-btn" onclick="changeQty(${it.id},${d},-1)" disabled>−</button>
            <span class="qty-num zero" id="q${it.id}_${d}">0</span>
            <button class="qty-btn" onclick="changeQty(${it.id},${d},1)">+</button>
          </div>
          <div class="unit-price">${fmt(it.p[d])}/unit</div>
        </td>`;
      }).join('')}
      <td class="row-amt zero" id="ra${it.id}">—</td>
    </tr>`).join('');
}

function changeQty(id, day, delta) {
  const item = ITEMS.find(it => it.id === id);
  if (!item || !item.p[day]) return;
  const k = `${id}_${day}`;
  qtys[k] = Math.max(0, (qtys[k] || 0) + delta);
  const el = document.getElementById(`q${id}_${day}`);
  el.textContent = qtys[k];
  el.className = 'qty-num' + (qtys[k] === 0 ? ' zero' : '');
  const minusBtn = el.previousElementSibling;
  if (minusBtn) minusBtn.disabled = qtys[k] === 0;
  recalc();
}

function recalc() {
  let tot = 0;
  ITEMS.forEach(it => {
    let r = 0;
    DAYS.forEach(d => { r += qtys[`${it.id}_${d}`] * it.p[d]; });
    tot += r;
    const el = document.getElementById('ra' + it.id);
    if (r > 0) { el.textContent = fmt(r); el.className = 'row-amt'; }
    else { el.textContent = '—'; el.className = 'row-amt zero'; }
  });
  const serviceText = tot > 0 ? ` + ${fmt(SERVICE_CHARGE)}(service charge)` : '';
  const displayTotal = tot > 0 ? `${fmt(tot)}${serviceText}` : 'RM0.00';
  document.getElementById('gtotal').textContent = displayTotal;
  const has = Object.values(qtys).some(v => v > 0);
  const hintTotal = tot > 0 ? `${fmt(tot)}${serviceText}` : 'RM0.00';
  document.getElementById('sumhint').textContent = has ? `Total ${hintTotal}` : 'Add quantity to place an order.';
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
  const q = document.getElementById('item-search').value.toLowerCase();
  document.querySelectorAll('#itbody tr').forEach(row => {
    const name = row.querySelector('.iname')?.textContent.toLowerCase() || '';
    const desc = row.querySelector('.idesc')?.textContent.toLowerCase() || '';
    row.style.display = (name.includes(q) || desc.includes(q)) ? '' : 'none';
  });
}

// ── Order submit ───────────────────────────

async function submitOrder() {
  const name = document.getElementById('fn').value.trim();
  if (!name) { showToast('Please enter your in-game name.'); return; }
  if (!Object.values(qtys).some(v => v > 0)) { showToast('Add at least one item.'); return; }
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
    document.querySelectorAll('.qty-num').forEach(el => { el.textContent = '0'; el.className = 'qty-num zero'; });
    recalc();
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
}

function closeModal() {
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
    await uploadProofFile(file, currentOrderId, 'uploadProofItem', {}, currentOrderToken);
    status.textContent = 'Submitted! We will verify your payment soon.'; status.style.color = 'var(--green)';
    btn.textContent = 'Submitted ✓';
    setTimeout(() => { closeModal(); _lastFeedData = ''; fetchSheet(); }, 3000);
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
