// ── Admin fetch helper ─────────────────────────

// Throws on ANY failure (401 expired session, 400 bad input, 500 ...) so the UI can never
// show a green ✓ for a request the server rejected.
async function adminFetch(payload) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, _token: adminToken })
  });
  if (!resp.ok) {
    let msg = 'Request failed (' + resp.status + ')';
    try { const j = await resp.clone().json(); if (j && j.error) msg = j.error; } catch { /* non-JSON */ }
    if (resp.status === 401) {
      adminUnlocked = false; adminToken = null;
      // Clear sessionStorage on session expiry
      try { sessionStorage.removeItem('adminToken'); } catch { /* ignore */ }
      msg = 'Admin session expired. Please unlock again.';
      showToast(msg);
    }
    throw new Error(msg);
  }
  return resp;
}

// ── Shared constants ────────────────────────────
// (Moved to config.js: MAX_IMAGE_SIZE_MB, MAX_VIDEO_SIZE_MB, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES, validateFile)

function showFieldError(inputId, message) {
  const input = document.getElementById(inputId);
  if (!input) return;
  let err = input.parentNode.querySelector('.field-error');
  if (!err) {
    err = document.createElement('div');
    err.className = 'field-error';
    err.style.cssText = 'font-size:11px;color:var(--red);margin-top:4px;font-family:Inter,sans-serif';
    input.parentNode.appendChild(err);
  }
  err.textContent = message;
  input.style.borderColor = 'var(--red)';
}

function clearFieldError(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const err = input.parentNode.querySelector('.field-error');
  if (err) err.remove();
  input.style.borderColor = '';
}

// ── Loading skeletons ──────────────────────────
function renderOrderSkeleton(count = 5) {
  return Array(count).fill(`<div class="admin-skeleton order-skeleton" style="flex-direction:column;align-items:stretch;padding:12px;gap:8px">
    <div style="display:flex;gap:10px;align-items:center;width:100%">
      <div style="flex:1"><div class="skel-line short"></div><div class="skel-line med"></div></div>
      <div style="display:flex;gap:6px"><div class="skel-line" style="width:80px"></div><div class="skel-line" style="width:100px"></div></div>
    </div>
    <div class="skel-line" style="width:60%"></div>
  </div>`).join('');
}

function renderAccountSkeleton(count = 4) {
  return Array(count).fill(`<div class="admin-skeleton" style="flex-direction:column;align-items:stretch;padding:10px;gap:6px">
    <div style="display:flex;gap:8px;align-items:center"><div class="skel-line short"></div><div class="skel-line med"></div></div>
    <div class="skel-line" style="width:40%"></div>
    <div style="display:flex;gap:6px"><div class="skel-line" style="width:80px"></div><div class="skel-line" style="width:60px"></div></div>
  </div>`).join('');
}

function renderSlideSkeleton() {
  return `<div class="admin-skeleton" style="aspect-ratio:16/9;border-radius:8px"></div>`;
}

function setTabLoading(tabId, loading) {
  const content = document.getElementById('tab-' + tabId);
  if (!content) return;
  if (loading) {
    content.classList.add('tab-loading');
  } else {
    content.classList.remove('tab-loading');
  }
}

// ── Admin panel ────────────────────────────────

let _lastAdminTab = 'extract';

function toggleAdmin() {
  const p = document.getElementById('admin-panel');
  p.classList.toggle('open');
  if (!adminUnlocked) {
    document.getElementById('admin-gate').style.display = 'block';
    document.getElementById('admin-content').style.display = 'none';
    // Render Turnstile if not already rendered
    renderAdminTurnstile();
  } else if (p.classList.contains('open')) {
    // Session restored from sessionStorage after a refresh: show the panel instead of the login box.
    document.getElementById('admin-gate').style.display = 'none';
    document.getElementById('admin-content').style.display = 'block';
    initAdminSession();
    const btn = document.querySelector(`.admin-tab[data-tab="${_lastAdminTab}"]`);
    if (btn) switchTab(_lastAdminTab, btn);
  }
}

let _adminTurnstileWidgetId = null;

function renderAdminTurnstile() {
  const container = document.getElementById('admin-turnstile');
  if (!container || !window.TURNSTILE_SITE_KEY) return;
  if (_adminTurnstileWidgetId !== null) return; // already rendered
  try {
    _adminTurnstileWidgetId = window.turnstile.render(container, {
      sitekey: window.TURNSTILE_SITE_KEY,
      theme: 'dark',
      callback: (token) => { window._adminTurnstileToken = token; },
      'expired-callback': () => { window._adminTurnstileToken = null; },
    });
  } catch (e) {
    console.warn('Admin Turnstile render failed:', e);
  }
}

// Runs once per page load after the admin is unlocked (by password, or restored from sessionStorage).
let _adminSessionReady = false;
function initAdminSession() {
  if (_adminSessionReady) return;
  _adminSessionReady = true;
  slideUrls.forEach((url, i) => {
    if (!url) return;
    const thumb = document.getElementById('ss-img-' + i);
    const lbl = document.getElementById('ss-lbl-' + i);
    if (thumb) { thumb.src = url; thumb.style.display = 'block'; }
    if (lbl) lbl.style.display = 'none';
  });
  loadShopEditor();
  renderManageList();
  _lastAccountData = '';
  if (typeof fetchAccounts === 'function') fetchAccounts();
  initTickerSpeedControl();
  _lastFeedData = '';
  fetchSheet();
}

// A Turnstile token works only once, so get a fresh one after every login attempt.
function resetAdminTurnstile() {
  window._adminTurnstileToken = null;
  try { if (_adminTurnstileWidgetId !== null && window.turnstile) window.turnstile.reset(_adminTurnstileWidgetId); } catch { /* ignore */ }
}

async function checkPass() {
  const pw = document.getElementById('admin-pw').value;
  const st = document.getElementById('gate-status');
  st.textContent = 'Verifying...'; st.style.color = 'var(--text2)';

  // Get Turnstile token if widget rendered
  const turnstileToken = window._adminTurnstileToken || null;
  if (window.TURNSTILE_SITE_KEY && !turnstileToken) { st.textContent = 'Please complete the CAPTCHA first.'; st.style.color = 'var(--red)'; return; }

  try {
    const resp = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adminAuth', password: pw, turnstile_token: turnstileToken }) });
    const result = await resp.json();
    if (result.token) {
      adminToken = result.token;
      adminUnlocked = true;
      _adminSessionReady = true; // the login code below does the setup itself
      // Persist in sessionStorage (survives page refresh, cleared on tab close)
      try { sessionStorage.setItem('adminToken', adminToken); } catch { /* ignore */ }

      document.getElementById('admin-gate').style.display = 'none';
      document.getElementById('admin-content').style.display = 'block';
      st.textContent = '';

      // Populate slideshow thumbnails now that admin is open
      slideUrls.forEach((url, i) => {
        if (!url) return;
        const thumb = document.getElementById('ss-img-' + i);
        const lbl = document.getElementById('ss-lbl-' + i);
        if (thumb) { thumb.src = url; thumb.style.display = 'block'; }
        if (lbl) lbl.style.display = 'none';
      });

      loadShopEditor();
      renderManageList();
      // Reload accounts with the admin token so pending listings + seller details appear.
      _lastAccountData = '';
      if (typeof fetchAccounts === 'function') fetchAccounts();
      initTickerSpeedControl();

      // Re-render the public feed now so inline comment boxes appear immediately
      _lastFeedData = '';
      fetchSheet();
    } else {
      st.textContent = (result.error && /too many/i.test(result.error)) ? result.error : 'Wrong password or CAPTCHA.'; st.style.color = 'var(--red)';
      resetAdminTurnstile();
    }
  } catch (e) {
    st.textContent = 'Auth failed. Check connection.'; st.style.color = 'var(--red)';
    resetAdminTurnstile();
  }
}

// ── Admin tab switcher ─────────────────────────

function switchMainTab(viewId, btn) {
  document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

let shopEditorDirty = false;

function switchTab(tab, btn) {
  if (tab !== 'edit-shop' && shopEditorDirty) {
    if (!confirm('You have unsaved changes in Edit Shop. Leave anyway?')) return;
    shopEditorDirty = false;
  }
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active', 'dirty'));
  document.querySelectorAll('.admin-tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (shopEditorDirty && tab === 'edit-shop') btn.classList.add('dirty');
  document.getElementById('tab-' + tab).classList.add('active');
  _lastAdminTab = tab;
  if (tab === 'edit-shop') { loadShopEditor(); shopEditorDirty = false; }
  if (tab === 'orders') loadOrderMgmt();
  if (tab === 'ticker') loadTickerEditor();
}

// Call this when edit shop inputs change
function markShopEditorDirty() {
  shopEditorDirty = true;
  const editShopTab = document.querySelector(`.admin-tab[data-tab="edit-shop"]`);
  if (editShopTab) editShopTab.classList.add('dirty');
}

// ── Order management (admin) ───────────────────

let allOrders = [];
let ordersPageSize = 30;
let ordersLoaded = 0;
let selectedOrderIds = new Set();

async function loadOrderMgmt() {
  const el = document.getElementById('order-mgmt-list');
  el.innerHTML = renderOrderSkeleton(5);
  selectedOrderIds.clear();
  ordersLoaded = 0;
  if (allOrders.length) { renderOrderMgmt(); return; }
  await fetchSheet();
  renderOrderMgmt();
}

function renderOrderMgmt() {
  const el = document.getElementById('order-mgmt-list');
  if (!allOrders.length) { el.innerHTML = '<div class="admin-loading">No orders</div>'; return; }
  const esc = escapeHtml;
  const pageOrders = allOrders.slice(0, ordersLoaded + ordersPageSize);
  const hasMore = ordersLoaded + ordersPageSize < allOrders.length;

  el.innerHTML = `
    ${pageOrders.map(o => `
      <div class="order-mgmt-item" id="row-${esc(o.order_id)}" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;width:100%">
          <div style="display:flex;align-items:center;gap:10px;width:100%">
            <input type="checkbox" class="order-bulk-check" data-order-id="${esc(o.order_id)}" style="width:16px;height:16px;accent-color:var(--accent);flex-shrink:0" />
            <div class="order-mgmt-info">
              <div class="order-mgmt-id">${esc(o.order_id)}</div>
              <div class="order-mgmt-name">${esc(o.name)}</div>
              <div class="order-mgmt-items">${esc(o.items)}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <span class="order-mgmt-total">${o.total ? 'RM ' + parseFloat(o.total).toFixed(2) : ''}</span>
            <select class="status-select" id="st-${esc(o.order_id)}">
              <option ${o.status === 'New' ? 'selected' : ''}>New</option>
              <option value="ProofSubmitted" ${o.status === 'ProofSubmitted' ? 'selected' : ''}>Proof sent</option>
              <option ${o.status === 'Paid' ? 'selected' : ''}>Paid</option>
              <option ${o.status === 'Verified' ? 'selected' : ''}>Verified</option>
              <option ${o.status === 'Completed' ? 'selected' : ''}>Completed</option>
              <option ${o.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
            </select>
            <button class="save-status-btn" id="stbtn-${esc(o.order_id)}" onclick="saveOrderStatus('${esc(o.order_id)}')">Save</button>
            <span id="ind-${esc(o.order_id)}" style="font-size:13px;width:16px;text-align:center;flex-shrink:0"></span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px;width:100%">
          <input type="text" id="cm-${esc(o.order_id)}" placeholder="Add a comment — visible to everyone" value="${esc(o.comment || '').replace(/"/g, '"')}"
            style="flex:1;min-width:0;border:1px solid var(--border);border-radius:6px;padding:6px 9px;font-size:12px;font-family:'Inter',sans-serif;color:var(--text);background:var(--bg2);outline:none" />
          <button class="save-status-btn" id="cmbtn-${esc(o.order_id)}" onclick="saveOrderComment('${esc(o.order_id)}')">Save</button>
          <span id="cmind-${esc(o.order_id)}" style="font-size:13px;width:16px;text-align:center;flex-shrink:0"></span>
        </div>
      </div>`).join('')}
    ${hasMore ? `
      <div class="admin-row" style="justify-content:center;margin-top:12px">
        <button class="admin-btn sec" onclick="loadMoreOrders()" style="width:auto">Load more (${allOrders.length - pageOrders.length} remaining)</button>
      </div>` : ''}
    <div id="bulk-actions-bar" style="display:none;margin-top:12px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;gap:8px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text2);font-family:Rajdhani,sans-serif">Selected: <strong id="bulk-count">0</strong> orders</span>
      <select id="bulk-status-select" class="status-select" style="width:auto">
        <option value="">— Set status —</option>
        <option value="Paid">Paid</option>
        <option value="Verified">Verified</option>
        <option value="Completed">Completed</option>
        <option value="Cancelled">Cancelled</option>
      </select>
      <button class="admin-btn" onclick="applyBulkStatus()">Apply to selected</button>
      <button class="admin-btn sec" onclick="clearBulkSelection()">Clear selection</button>
    </div>`;

  // Attach checkbox listeners
  pageOrders.forEach(o => {
    const cb = document.querySelector(`.order-bulk-check[data-order-id="${esc(o.order_id)}"]`);
    if (cb) cb.addEventListener('change', () => toggleBulkSelect(esc(o.order_id), cb.checked));
  });

  updateBulkBar();
}

function loadMoreOrders() {
  ordersLoaded += ordersPageSize;
  renderOrderMgmt();
}

function toggleBulkSelect(orderId, checked) {
  if (checked) selectedOrderIds.add(orderId);
  else selectedOrderIds.delete(orderId);
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-actions-bar');
  const count = document.getElementById('bulk-count');
  if (!bar || !count) return;
  if (selectedOrderIds.size > 0) {
    bar.style.display = 'flex';
    count.textContent = selectedOrderIds.size;
  } else {
    bar.style.display = 'none';
  }
}

function clearBulkSelection() {
  selectedOrderIds.clear();
  document.querySelectorAll('.order-bulk-check').forEach(cb => cb.checked = false);
  updateBulkBar();
}

async function applyBulkStatus() {
  const sel = document.getElementById('bulk-status-select');
  const status = sel.value;
  if (!status) { showToast('Select a status'); return; }
  if (selectedOrderIds.size === 0) { showToast('No orders selected'); return; }

  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Applying...';
  let success = 0, failed = 0;
  for (const orderId of selectedOrderIds) {
    try {
      await adminFetch({ action: 'updateOrderStatus', order_id: orderId, status });
      const o = allOrders.find(x => x.order_id === orderId);
      if (o) o.status = status;
      success++;
    } catch (e) { failed++; }
  }
  showToast(`Bulk update: ${success} updated${failed ? `, ${failed} failed` : ''}`);
  btn.disabled = false; btn.textContent = 'Apply to selected';
  clearBulkSelection();
  renderOrderMgmt();
  fetchSheet();
}

async function saveOrderStatus(orderId) {
  const sel = document.getElementById('st-' + orderId);
  const btn = document.getElementById('stbtn-' + orderId);
  const ind = document.getElementById('ind-' + orderId);
  btn.disabled = true; btn.textContent = '...'; ind.textContent = '';
  try {
    await adminFetch({ action: 'updateOrderStatus', order_id: orderId, status: sel.value });
    const o = allOrders.find(x => x.order_id === orderId);
    if (o) o.status = sel.value;
    ind.textContent = '✓'; ind.style.color = 'var(--green)';
    btn.textContent = 'Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 2000);
    fetchSheet();
  } catch (e) {
    ind.textContent = '✕'; ind.style.color = 'var(--red)';
    btn.textContent = 'Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 3000);
  }
}

async function updateOrderStatus(orderId) {
  const sel = document.getElementById('st-' + orderId);
  const btn = document.getElementById('btn-' + orderId);
  const ind = document.getElementById('ind-' + orderId);
  btn.disabled = true; btn.textContent = '...'; ind.textContent = '';
  try {
    await adminFetch({ action: 'updateOrderStatus', order_id: orderId, status: sel.value });
    const o = allOrders.find(x => x.order_id === orderId);
    if (o) o.status = sel.value;
    ind.textContent = '✓'; ind.style.color = 'var(--green)';
    btn.textContent = 'Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 3000);
    fetchSheet();
  } catch (e) {
    ind.textContent = '✕'; ind.style.color = 'var(--red)';
    btn.textContent = 'Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 4000);
  }
}

async function saveOrderComment(orderId) {
  const inp = document.getElementById('cm-' + orderId);
  const btn = document.getElementById('cmbtn-' + orderId);
  const ind = document.getElementById('cmind-' + orderId);
  btn.disabled = true; btn.textContent = '...'; ind.textContent = '';
  try {
    await adminFetch({ action: 'updateOrderComment', order_id: orderId, comment: inp.value });
    const o = allOrders.find(x => x.order_id === orderId);
    if (o) o.comment = inp.value;
    ind.textContent = '✓'; ind.style.color = 'var(--green)';
    btn.textContent = 'Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 3000);
    fetchSheet();
  } catch (e) {
    ind.textContent = '✕'; ind.style.color = 'var(--red)';
    btn.textContent = 'Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 4000);
  }
}

// ── Shop extract (admin) ───────────────────────

let shopExtractFiles = [null, null];

function handleShopSlotFile(input, idx) {
  const file = input.files[0]; if (!file) return;
  const validation = validateFile(file);
  if (!validation.ok) {
    showToast(validation.error);
    input.value = '';
    return;
  }
  shopExtractFiles[idx] = file;
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('sslot-img-' + idx);
    img.src = e.target.result; img.style.display = 'block';
    document.getElementById('sslot-rm-' + idx).style.display = 'block';
    document.getElementById('sslot-lbl-' + idx).style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function removeShopSlot(e, idx) {
  e.stopPropagation();
  shopExtractFiles[idx] = null;
  const img = document.getElementById('sslot-img-' + idx);
  img.src = ''; img.style.display = 'none';
  document.getElementById('sslot-rm-' + idx).style.display = 'none';
  document.getElementById('sslot-lbl-' + idx).style.display = 'block';
  document.getElementById('sslot-' + idx).querySelector('input').value = '';
}

async function extractItems() {
  if (!shopExtractFiles[0] && !shopExtractFiles[1]) { showToast('Please select at least one shop image.'); return; }
  const btn = document.getElementById('extract-btn');
  const status = document.getElementById('extract-status');
  const progress = document.getElementById('extract-progress');
  btn.disabled = true; btn.textContent = 'Extracting...';
  status.textContent = 'Uploading images...'; status.style.color = 'var(--text2)';
  if (progress) { progress.style.width = '10%'; progress.style.display = 'block'; }
  try {
    const filesToUpload = shopExtractFiles.filter(Boolean);
    const allItems = []; let uploadedUrls = [];
    const slides = document.querySelectorAll('#slideshow img');
    for (let i = 0; i < shopExtractFiles.length; i++) {
      const file = shopExtractFiles[i];
      if (!file) continue;
      status.textContent = `Processing image ${i + 1}/${filesToUpload.length}...`;
      if (progress) progress.style.width = `${20 + i * 30}%`;
      const base64 = await compressImage(file, 1200, 0.8);
      const dateStr = new Date().toLocaleDateString('en-GB', {timeZone: 'Asia/Kuala_Lumpur'}).replace(/\//g, '');
      const resp = await adminFetch({ action: 'extractItems', fileName: `shop_${i}_${dateStr}.jpg`, base64 });
      const result = await resp.json();
      const items = result.items || [];
      if (items.length) allItems.push(...items);
      if (result.url) {
        await adminFetch({ action: 'uploadSlideImg', slideIndex: i, url: result.url });
        if (slides[i]) slides[i].src = result.url;
      }
    }
    if (progress) progress.style.width = '80%';
    status.textContent = 'Saving slides...';
    for (let i = 0; i < uploadedUrls.length; i++) {
      if (slides[i]) slides[i].src = uploadedUrls[i];
      try { await adminFetch({ action: 'uploadSlideImg', slideIndex: i, url: uploadedUrls[i] }); } catch (_) { showToast('Slide ' + (i+1) + ' saved to Drive but sheet update failed'); }
    }
    if (progress) progress.style.width = '90%';
    status.textContent = 'Finalizing...';
    startSlideshow();
    const seen = new Set();
    const deduped = allItems.filter(it => { const k = (it.name || '').toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; });
    renderExtracted(deduped);
    if (progress) progress.style.width = '100%';
    status.textContent = 'Extracted ' + deduped.length + ' items from ' + filesToUpload.length + ' image(s). Review and apply.';
    status.style.color = 'var(--green)';
    setTimeout(() => { if (progress) progress.style.display = 'none'; }, 3000);
  } catch (e) { status.textContent = 'Failed: ' + e.message; status.style.color = 'var(--red)'; if (progress) progress.style.display = 'none'; }
  btn.disabled = false; btn.textContent = 'Upload & Extract items';
}

function renderExtracted(items) {
  const tbody = document.getElementById('extracted-tbody');
  const esc = escapeHtml;
  tbody.innerHTML = items.map((it, i) => `<tr>
    <td>${i + 1}</td>
    <td><input id="ext-name-${i}" value="${esc(it.name || '')}" data-field="name" data-idx="${i}"/></td>
    <td><input id="ext-desc-${i}" value="${esc(it.desc || '')}" data-field="desc" data-idx="${i}"/></td>
    <td><input id="ext-p7-${i}" value="${esc(it.p7 || '')}" data-field="p7" data-idx="${i}" style="width:60px"/></td>
    <td><input id="ext-p15-${i}" value="${esc(it.p15 || '')}" data-field="p15" data-idx="${i}" style="width:60px"/></td>
    <td><input id="ext-p30-${i}" value="${esc(it.p30 || '')}" data-field="p30" data-idx="${i}" style="width:60px"/></td>
  </tr>`).join('');
  document.getElementById('admin-extracted').style.display = 'block';
}

function addExtractedRow() {
  const tbody = document.getElementById('extracted-tbody');
  const i = tbody.rows.length;
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${i + 1}</td><td><input id="ext-name-${i}" value="" data-field="name" data-idx="${i}"/></td><td><input id="ext-desc-${i}" value="" data-field="desc" data-idx="${i}"/></td><td><input id="ext-p7-${i}" value="" data-field="p7" data-idx="${i}" style="width:60px"/></td><td><input id="ext-p15-${i}" value="" data-field="p15" data-idx="${i}" style="width:60px"/></td><td><input id="ext-p30-${i}" value="" data-field="p30" data-idx="${i}" style="width:60px"/></td>`;
  tbody.appendChild(tr);
}

function applyNewItems(items) {
  ITEMS.length = 0;
  items.forEach(it => ITEMS.push(it));
  qtys = {};
  ITEMS.forEach(it => DAYS.forEach(d => { qtys[`${it.id}_${d}`] = 0; }));
  buildTable();
  recalc();
}

async function applyItems() {
  const rows = document.querySelectorAll('#extracted-tbody tr');
  const newItems = [];
  let hasErrors = false;
  rows.forEach((row, i) => {
    const get = f => row.querySelector(`[data-field="${f}"]`)?.value.trim() || '';
    const name = get('name');
    if (!name) return;
    const p7 = parseFloat(get('p7'));
    const p15 = parseFloat(get('p15'));
    const p30 = parseFloat(get('p30'));
    // Validate prices
    [['p7', p7], ['p15', p15], ['p30', p30]].forEach(([field, val]) => {
      const input = row.querySelector(`[data-field="${field}"]`);
      if (input) {
        if (get(field) && (isNaN(val) || val < 0)) {
          showFieldError(input.id || '', `Invalid price`);
          hasErrors = true;
        } else {
          clearFieldError(input.id || '');
        }
      }
    });
    newItems.push({ id: newItems.length + 1, name, desc: get('desc'), p: { 7: p7 || 0, 15: p15 || 0, 30: p30 || 0 } });
  });
  if (hasErrors) { showToast('Please fix invalid prices'); return; }
  if (!newItems.length) return;
  applyNewItems(newItems);
  try { await adminFetch({ action: 'saveItems', items: newItems }); showToast('Items updated & saved!'); }
  catch (e) { showToast('Items updated (save failed)'); }
  document.getElementById('admin-panel').classList.remove('open');
}

// ── Shop editor (admin) ────────────────────────

function loadShopEditor() {
  const tbody = document.getElementById('shop-editor-tbody');
  const esc = escapeHtml;
  tbody.innerHTML = ITEMS.map((it, i) => `<tr>
    <td class="se-td"><input id="se-name-${i}" class="se-input" value="${esc(it.name)}" data-se="name" data-i="${i}"/></td>
    <td class="se-td"><input id="se-desc-${i}" class="se-input" value="${esc(it.desc || '')}" data-se="desc" data-i="${i}"/></td>
    <td class="se-td"><input id="se-p7-${i}" class="se-input" value="${esc(it.p[7] || '')}" data-se="p7" data-i="${i}" style="width:56px"/></td>
    <td class="se-td"><input id="se-p15-${i}" class="se-input" value="${esc(it.p[15] || '')}" data-se="p15" data-i="${i}" style="width:56px"/></td>
    <td class="se-td"><input id="se-p30-${i}" class="se-input" value="${esc(it.p[30] || '')}" data-se="p30" data-i="${i}" style="width:56px"/></td>
    <td class="se-td"><button class="se-rm" onclick="removeShopEditorRow(this)">✕</button></td>
  </tr>`).join('');
  tbody.addEventListener('input', markShopEditorDirty, { once: false });
}

function addShopEditorRow() {
  const tbody = document.getElementById('shop-editor-tbody');
  const i = tbody.rows.length;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="se-td"><input id="se-name-${i}" class="se-input" value="" data-se="name"/></td>
    <td class="se-td"><input id="se-desc-${i}" class="se-input" value="" data-se="desc"/></td>
    <td class="se-td"><input id="se-p7-${i}" class="se-input" value="" data-se="p7" style="width:56px"/></td>
    <td class="se-td"><input id="se-p15-${i}" class="se-input" value="" data-se="p15" style="width:56px"/></td>
    <td class="se-td"><input id="se-p30-${i}" class="se-input" value="" data-se="p30" style="width:56px"/></td>
    <td class="se-td"><button class="se-rm" onclick="removeShopEditorRow(this)">✕</button></td>`;
  tbody.appendChild(tr);
  markShopEditorDirty();
}

function removeShopEditorRow(btn) {
  btn.closest('tr').remove();
  markShopEditorDirty();
}

async function saveShopEdit() {
  const rows = document.querySelectorAll('#shop-editor-tbody tr');
  const newItems = [];
  let hasErrors = false;
  rows.forEach((row, i) => {
    const get = f => row.querySelector(`[data-se="${f}"]`)?.value.trim() || '';
    const name = get('name');
    if (!name) return;
    const p7 = parseFloat(get('p7'));
    const p15 = parseFloat(get('p15'));
    const p30 = parseFloat(get('p30'));
    // Validate prices
    [['p7', p7], ['p15', p15], ['p30', p30]].forEach(([field, val]) => {
      const input = row.querySelector(`[data-se="${field}"]`);
      if (input) {
        if (get(field) && (isNaN(val) || val < 0)) {
          showFieldError(input.id || '', `Invalid price`);
          hasErrors = true;
        } else {
          clearFieldError(input.id || '');
        }
      }
    });
    newItems.push({ id: newItems.length + 1, name, desc: get('desc'), p: { 7: p7 || 0, 15: p15 || 0, 30: p30 || 0 } });
  });
  if (hasErrors) { showToast('Please fix invalid prices'); return; }
  if (!newItems.length) return;
  const st = document.getElementById('shop-edit-status');
  st.textContent = 'Saving...'; st.style.color = 'var(--text2)';
  applyNewItems(newItems);
  try {
    await adminFetch({ action: 'saveItems', items: newItems });
    shopEditorDirty = false;
    st.textContent = 'Saved!'; st.style.color = 'var(--green)';
    setTimeout(() => { st.textContent = ''; }, 3000);
  } catch (e) { st.textContent = 'Save failed'; st.style.color = 'var(--red)'; }
}

// ── Ticker text (admin) ────────────────────────

function loadTickerEditor() {
  const inp = document.getElementById('ticker-text-input');
  if (!inp) return;
  inp.value = window._tickerBaseText || '';
  updateTickerCharCount(inp);
  // Add live character count
  inp.removeEventListener('input', onTickerInput);
  inp.addEventListener('input', onTickerInput);
  // Load saved speed
  const sel = document.getElementById('ticker-speed-select');
  if (sel) {
    const saved = localStorage.getItem('tickerSpeed') || '2';
    sel.value = saved;
    if (typeof window.setTickerSpeed === 'function') window.setTickerSpeed(parseFloat(saved));
  }
}

function onTickerInput(e) {
  updateTickerCharCount(e.target);
}

function updateTickerCharCount(inp) {
  let counter = document.getElementById('ticker-char-count');
  if (!counter) {
    counter = document.createElement('div');
    counter.id = 'ticker-char-count';
    counter.style.cssText = 'font-size:11px;color:var(--text3);font-family:Rajdhani,sans-serif;letter-spacing:.05em;text-align:right;margin-top:4px';
    inp.parentNode.appendChild(counter);
  }
  const len = inp.value.length;
  const max = 500; // reasonable limit
  counter.textContent = `${len} / ${max} characters`;
  counter.style.color = len > max ? 'var(--red)' : len > max * 0.8 ? 'var(--accent)' : 'var(--text3)';
}

async function saveTickerText() {
  const inp = document.getElementById('ticker-text-input');
  const st = document.getElementById('ticker-status');
  const text = inp.value.trim();
  if (!text) { st.textContent = 'Enter some ticker text.'; st.style.color = 'var(--red)'; return; }
  st.textContent = 'Saving...'; st.style.color = 'var(--text2)';
  try {
    const resp = await adminFetch({ action: 'updateTicker', text });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);
    if (typeof window.setTickerText === 'function') window.setTickerText(text);
    st.textContent = 'Saved!'; st.style.color = 'var(--green)';
    setTimeout(() => { st.textContent = ''; }, 3000);
  } catch (e) {
    st.textContent = 'Save failed: ' + e.message; st.style.color = 'var(--red)';
  }
}

function resetTickerText() {
  const inp = document.getElementById('ticker-text-input');
  const st = document.getElementById('ticker-status');
  const defaultText = 'Welcome to Hohoh0 Shop — fast delivery, trusted seller!';
  if (!confirm('Reset ticker to default text?')) return;
  inp.value = defaultText;
  updateTickerCharCount(inp);
  saveTickerText();
}

// Ticker speed control
function initTickerSpeedControl() {
  const sel = document.getElementById('ticker-speed-select');
  if (!sel) return;
  // Load saved speed
  const saved = localStorage.getItem('tickerSpeed') || '2';
  sel.value = saved;
  sel.addEventListener('change', () => {
    localStorage.setItem('tickerSpeed', sel.value);
    if (typeof window.setTickerSpeed === 'function') window.setTickerSpeed(parseFloat(sel.value));
    showToast('Ticker speed updated');
  });
}

// Call init on admin unlock - add to checkPass() after adminUnlocked = true
// initTickerSpeedControl();

// ── Slideshow ──────────────────────────────────

let slideshowTimer = null;
let slideshowIdx = 0;
let slideUrls = []; // Dynamic array - populated from settings
let slideDragSrc = null; // For drag-to-reorder

function startSlideshow() {
  if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
  const slides = document.querySelectorAll('#slideshow img');
  const loaded = slideUrls.filter(u => u);
  slides.forEach(img => img.classList.remove('active'));
  if (loaded.length === 0) {
    const area = document.getElementById('slideshow-area');
    if (area && !area.querySelector('.ss-placeholder')) {
      const ph = document.createElement('div');
      ph.className = 'ss-placeholder';
      ph.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;pointer-events:none';
      ph.innerHTML = '<div style="font-size:28px;opacity:.3">🖼</div><div style="font-family:Rajdhani,sans-serif;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text3)">No slides uploaded</div>';
      area.appendChild(ph);
    }
    return;
  }
  document.querySelector('#slideshow-area .ss-placeholder')?.remove();
  if (loaded.length === 1) {
    const activeIdx = slideUrls.findIndex(u => u);
    if (slides[activeIdx]) slides[activeIdx].classList.add('active');
    slideshowIdx = activeIdx;
    return;
  }
  if (slideUrls[slideshowIdx]) {
    slides[slideshowIdx].classList.add('active');
  } else { slides[0].classList.add('active'); slideshowIdx = 0; }
  slideshowTimer = setInterval(() => {
    const imgs = document.querySelectorAll('#slideshow img');
    imgs.forEach(img => img.classList.remove('active'));
    slideshowIdx = (slideshowIdx + 1) % imgs.length;
    imgs[slideshowIdx].classList.add('active');
  }, 4000);

  // Pause slideshow when tab is hidden
  if (!window._slideshowVisHandler) {
    window._slideshowVisHandler = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
      } else if (slideUrls.filter(u => u).length > 1) {
        startSlideshow();
      }
    });
  }
}

async function fetchSlideUrls() {
  try {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getSettings' }) });
    const d = await r.json();
    const row = d.slides || [];
    const slides = document.querySelectorAll('#slideshow img');
    // Reset slideUrls to match actual data
    slideUrls = row.filter(u => u);
    row.forEach((url, i) => {
      if (!url) return;
      if (slides[i]) slides[i].src = url;
      if (adminUnlocked) {
        const thumb = document.getElementById('ss-img-' + i);
        const lbl = document.getElementById('ss-lbl-' + i);
        if (thumb) { thumb.src = url; thumb.style.display = 'block'; }
        if (lbl) lbl.style.display = 'none';
      }
    });
    // Rebuild admin slideshow tab with current slides
    if (adminUnlocked) rebuildSlideshowTab();
    document.getElementById('slideshow-area')?.classList.remove('loading');
    slideshowIdx = 0;
    startSlideshow();
    initImgFadeIn();
  } catch (e) { console.error('Failed to load slides:', e); }
}

// Rebuild slideshow admin tab with current slides + drag-to-reorder
function rebuildSlideshowTab() {
  const container = document.querySelector('#tab-slideshow .slide-grid') || createSlideshowGrid();
  const esc = escapeHtml;
  container.innerHTML = slideUrls.map((url, i) => `
    <div class="slide-item" draggable="true" data-index="${i}" id="slide-item-${i}"
      style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;position:relative">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="slide-label">Slide ${i + 1}</span>
        <span class="drag-handle" style="cursor:grab;color:var(--text3);font-size:18px;user-select:none" title="Drag to reorder">⋮⋮</span>
      </div>
      <div class="img-slot" id="ss-slot-${i}"
        style="aspect-ratio:16/9;border:1px dashed var(--border2);border-radius:8px;cursor:pointer;position:relative;overflow:hidden;background:var(--bg2);display:flex;align-items:center;justify-content:center;transition:border-color .2s">
        <input type="file" accept="image/*" onchange="uploadSlide(this,${i})"
          style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;z-index:5" />
        <img id="ss-img-${i}" src="${esc(url)}" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:7px" />
        <div id="ss-lbl-${i}" style="text-align:center;pointer-events:none;display:none">
          <div style="font-size:22px;margin-bottom:4px">📷</div>
          <div style="font-size:11px;color:var(--text3);font-family:'Rajdhani',sans-serif;letter-spacing:.04em">Tap to upload</div>
        </div>
        <div id="ss-prog-${i}" style="position:absolute;bottom:0;left:0;height:3px;background:var(--accent);width:0%;transition:width .3s"></div>
        <div id="ss-overlay-${i}" style="position:absolute;inset:0;background:rgba(10,11,15,.6);display:none;align-items:center;justify-content:center;font-family:'Rajdhani',sans-serif;font-size:12px;color:var(--text2);letter-spacing:.05em">Uploading…</div>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end">
        <button class="admin-btn sec" onclick="clearSlideUpload(${i})" style="font-size:11px;padding:5px 10px">✕ Clear</button>
      </div>
    </div>`).join('') + `
    <div class="slide-item slide-add" id="slide-add-btn"
      style="background:var(--bg3);border:1px dashed var(--border2);border-radius:8px;padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;min-height:200px"
      onclick="addSlideSlot()">
      <div style="font-size:32px;color:var(--accent);opacity:.5">+</div>
      <div style="font-size:11px;color:var(--text3);font-family:'Rajdhani',sans-serif;letter-spacing:.05em;text-transform:uppercase">Add Slide</div>
    </div>`;

  // Attach drag events
  attachSlideDragEvents();
}

function createSlideshowGrid() {
  const hint = document.querySelector('#tab-slideshow > div[style*="text-transform:uppercase"]');
  const grid = document.createElement('div');
  grid.className = 'slide-grid';
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-bottom:12px';
  hint.insertAdjacentElement('afterend', grid);
  return grid;
}

function attachSlideDragEvents() {
  document.querySelectorAll('.slide-item[data-index]').forEach(item => {
    item.addEventListener('dragstart', handleSlideDragStart);
    item.addEventListener('dragend', handleSlideDragEnd);
    item.addEventListener('dragover', handleSlideDragOver);
    item.addEventListener('drop', handleSlideDrop);
    item.addEventListener('dragenter', handleSlideDragEnter);
    item.addEventListener('dragleave', handleSlideDragLeave);
  });
}

function handleSlideDragStart(e) {
  if (e.target.closest('.slide-add')) return;
  slideDragSrc = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.index);
}

function handleSlideDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.slide-item').forEach(el => el.classList.remove('drag-over'));
  slideDragSrc = null;
}

function handleSlideDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (this !== slideDragSrc && !this.classList.contains('slide-add')) {
    this.classList.add('drag-over');
  }
}

function handleSlideDragLeave(e) {
  if (!this.contains(e.relatedTarget)) this.classList.remove('drag-over');
}

function handleSlideDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  if (this === slideDragSrc || this.classList.contains('slide-add')) return;

  const fromIdx = parseInt(slideDragSrc.dataset.index);
  const toIdx = parseInt(this.dataset.index);
  if (fromIdx === toIdx) return;

  // Reorder slideUrls array
  const [moved] = slideUrls.splice(fromIdx, 1);
  slideUrls.splice(toIdx, 0, moved);

  // Save new order to backend
  saveSlideOrder();

  // Rebuild UI
  rebuildSlideshowTab();
  startSlideshow();
}

async function saveSlideOrder() {
  try {
    await adminFetch({ action: 'uploadSlideImg', slideIndex: -1, urls: slideUrls });
  } catch (e) {
    showToast('Failed to save slide order: ' + e.message);
  }
}

function addSlideSlot() {
  slideUrls.push('');
  rebuildSlideshowTab();
  // Focus the new file input
  setTimeout(() => {
    const newIdx = slideUrls.length - 1;
    const input = document.getElementById(`ss-slot-${newIdx}`)?.querySelector('input');
    if (input) input.click();
  }, 100);
}

// Preview live slides in a modal
function previewLiveSlides() {
  const loaded = slideUrls.filter(u => u);
  if (!loaded.length) { showToast('No slides to preview'); return; }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.style.zIndex = '2000';
  modal.innerHTML = `
    <div class="modal" style="max-width:90vw;max-height:90vh;padding:20px">
      <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      <div style="font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:700;color:var(--accent);letter-spacing:.05em;text-transform:uppercase;margin-bottom:16px">Live Slides Preview</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;max-height:70vh;overflow-y:auto">
        ${loaded.map((url, i) => `
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;overflow:hidden">
            <img src="${escapeHtml(url)}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block" />
            <div style="padding:8px;font-size:11px;color:var(--text2);font-family:'Rajdhani',sans-serif;text-align:center">Slide ${slideUrls.indexOf(url) + 1}</div>
          </div>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function uploadSlide(input, idx) {
  const file = input.files[0]; if (!file) return;
  const validation = validateFile(file);
  if (!validation.ok) {
    showToast(validation.error);
    input.value = '';
    return;
  }
  const prog = document.getElementById('ss-prog-' + idx);
  const overlay = document.getElementById('ss-overlay-' + idx);
  const ssImg = document.getElementById('ss-img-' + idx);
  const ssLbl = document.getElementById('ss-lbl-' + idx);
  const reader = new FileReader();
  reader.onload = e => { ssImg.src = e.target.result; ssImg.style.display = 'block'; ssLbl.style.display = 'none'; };
  reader.readAsDataURL(file);
  prog.style.width = '20%'; overlay.style.display = 'flex';
  showSlideStatus('Uploading slide ' + (idx + 1) + '...', true);
  try {
    const base64 = await compressImage(file, 1400, 0.82);
    const dateStr = new Date().toLocaleDateString('en-GB', {timeZone: 'Asia/Kuala_Lumpur'}).replace(/\//g, '');
    prog.style.width = '50%';
    const resp = await adminFetch({ action: 'uploadSlideImg', slideIndex: idx, fileName: `shop_${idx}_${dateStr}.jpg`, mimeType: 'image/jpeg', base64 });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);
    const finalUrl = result.url;
    prog.style.width = '100%';
    const slides = document.querySelectorAll('#slideshow img');
    if (slides[idx]) { slides[idx].src = finalUrl; slideUrls[idx] = finalUrl; }
    ssImg.src = finalUrl;
    showSlideStatus('Slide ' + (idx + 1) + ' updated ✓', true);
    slideshowIdx = 0;
    startSlideshow();
  } catch (e) { showSlideStatus('Upload failed: ' + e.message, false); }
  finally { setTimeout(() => { prog.style.width = '0%'; overlay.style.display = 'none'; }, 1000); }
}

async function clearSlideUpload(idx) {
  if (!slideUrls[idx]) return;
  if (!confirm(`Clear slide ${idx + 1}? This cannot be undone.`)) return;
  try {
    showSlideStatus('Clearing slide...', true);
    const resp = await adminFetch({ action: 'uploadSlideImg', slideIndex: idx, url: '' });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);
    slideUrls[idx] = '';
    const slides = document.querySelectorAll('#slideshow img');
    if (slides[idx]) { slides[idx].src = ''; slides[idx].classList.remove('active'); }
    const ssImg = document.getElementById('ss-img-' + idx); if (ssImg) { ssImg.src = ''; ssImg.style.display = 'none'; }
    const ssLbl = document.getElementById('ss-lbl-' + idx); if (ssLbl) ssLbl.style.display = '';
    const inp = document.getElementById('ss-slot-' + idx)?.querySelector('input'); if (inp) inp.value = '';
    startSlideshow();
    showSlideStatus('Slide ' + (idx + 1) + ' cleared.', true);
  } catch (e) { showSlideStatus('Failed to clear: ' + e.message, false); }
}

function showSlideStatus(msg, ok) {
  const el = document.getElementById('slide-status'); if (!el) return;
  el.textContent = msg; el.style.color = ok ? 'var(--green)' : 'var(--red)';
  setTimeout(() => { el.textContent = ''; }, 4000);
}

// ── Admin account form ────────────────────────

// ── Clock ──────────────────────────────────────

function tick() {
  const n = new Date();
  document.getElementById('ct').textContent = n.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  document.getElementById('cd').textContent = n.toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
tick(); setInterval(tick, 1000);