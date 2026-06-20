// ── Admin fetch helper ─────────────────────────

function adminFetch(payload) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, _token: adminToken })
  });
}

// ── Admin panel ────────────────────────────────

let _lastAdminTab = 'extract';

function toggleAdmin() {
  const p = document.getElementById('admin-panel');
  p.classList.toggle('open');
  if (!adminUnlocked) {
    document.getElementById('admin-gate').style.display = 'block';
    document.getElementById('admin-content').style.display = 'none';
  } else if (p.classList.contains('open')) {
    const btn = document.querySelector(`.admin-tab[onclick*="'${_lastAdminTab}'"]`);
    if (btn) switchTab(_lastAdminTab, btn);
  }
}

async function checkPass() {
  const pw = document.getElementById('admin-pw').value;
  const st = document.getElementById('gate-status');
  st.textContent = 'Verifying...'; st.style.color = 'var(--text2)';
  try {
    const resp = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adminAuth', password: pw }) });
    const result = await resp.json();
    if (result.token) {
      adminToken = result.token;
      adminUnlocked = true;
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

      // Re-render the public feed now so inline comment boxes appear immediately
      _lastFeedData = '';
      fetchSheet();
    } else {
      st.textContent = 'Wrong password.'; st.style.color = 'var(--red)';
    }
  } catch (e) {
    st.textContent = 'Auth failed. Check connection.'; st.style.color = 'var(--red)';
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
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  _lastAdminTab = tab;
  if (tab === 'edit-shop') { loadShopEditor(); shopEditorDirty = false; }
  if (tab === 'orders') loadOrderMgmt();
}

// ── Order management (admin) ───────────────────

let allOrders = [];

async function loadOrderMgmt() {
  const el = document.getElementById('order-mgmt-list');
  el.innerHTML = '<div class="admin-loading">Loading...</div>';
  if (allOrders.length) { renderOrderMgmt(); return; }
  await fetchSheet();
  renderOrderMgmt();
}

function renderOrderMgmt() {
  const el = document.getElementById('order-mgmt-list');
  if (!allOrders.length) { el.innerHTML = '<div class="admin-loading">No orders</div>'; return; }
  el.innerHTML = allOrders.slice(0, 30).map(o => `
    <div class="order-mgmt-item" id="row-${o.order_id}" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;width:100%">
        <div class="order-mgmt-info">
          <div class="order-mgmt-id">${o.order_id}</div>
          <div class="order-mgmt-name">${o.name}</div>
          <div class="order-mgmt-items">${o.items}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <span class="order-mgmt-total">${o.total ? 'RM ' + parseFloat(o.total).toFixed(2) : ''}</span>
          <select class="status-select" id="st-${o.order_id}">
            <option ${o.status === 'New' ? 'selected' : ''}>New</option>
            <option ${o.status === 'Paid' ? 'selected' : ''}>Paid</option>
            <option ${o.status === 'Verified' ? 'selected' : ''}>Verified</option>
            <option ${o.status === 'Completed' ? 'selected' : ''}>Completed</option>
          </select>
          <button class="save-status-btn" id="btn-${o.order_id}" onclick="updateOrderStatus('${o.order_id}')">Save</button>
          <span id="ind-${o.order_id}" style="font-size:13px;width:16px;text-align:center;flex-shrink:0"></span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px;width:100%">
        <input type="text" id="cm-${o.order_id}" placeholder="Add a comment — visible to everyone" value="${(o.comment || '').replace(/"/g, '&quot;')}"
          style="flex:1;min-width:0;border:1px solid var(--border);border-radius:6px;padding:6px 9px;font-size:12px;font-family:'Inter',sans-serif;color:var(--text);background:var(--bg2);outline:none" />
        <button class="save-status-btn" id="cmbtn-${o.order_id}" onclick="saveOrderComment('${o.order_id}')">Save</button>
        <span id="cmind-${o.order_id}" style="font-size:13px;width:16px;text-align:center;flex-shrink:0"></span>
      </div>
    </div>`).join('');
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
  btn.disabled = true; btn.textContent = 'Extracting...';
  status.textContent = 'Uploading and sending to AI...'; status.style.color = 'var(--text2)';
  try {
    const filesToUpload = shopExtractFiles.filter(Boolean);
    const allItems = []; let uploadedUrls = [];
    const slides = document.querySelectorAll('#slideshow img');
    for (let i = 0; i < shopExtractFiles.length; i++) {
      const file = shopExtractFiles[i];
      if (!file) continue;
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
    for (let i = 0; i < uploadedUrls.length; i++) {
      if (slides[i]) slides[i].src = uploadedUrls[i];
      try { await adminFetch({ action: 'uploadSlideImg', slideIndex: i, url: uploadedUrls[i] }); } catch (_) { }
    }
    startSlideshow();
    const seen = new Set();
    const deduped = allItems.filter(it => { const k = (it.name || '').toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; });
    renderExtracted(deduped);
    status.textContent = 'Extracted ' + deduped.length + ' items from ' + filesToUpload.length + ' image(s). Review and apply.';
    status.style.color = 'var(--green)';
  } catch (e) { status.textContent = 'Failed: ' + e.message; status.style.color = 'var(--red)'; }
  btn.disabled = false; btn.textContent = 'Upload & Extract items';
}

function renderExtracted(items) {
  const tbody = document.getElementById('extracted-tbody');
  tbody.innerHTML = items.map((it, i) => `<tr>
    <td>${i + 1}</td>
    <td><input value="${it.name || ''}" data-field="name" data-idx="${i}"/></td>
    <td><input value="${it.desc || ''}" data-field="desc" data-idx="${i}"/></td>
    <td><input value="${it.p7 || ''}" data-field="p7" data-idx="${i}" style="width:60px"/></td>
    <td><input value="${it.p15 || ''}" data-field="p15" data-idx="${i}" style="width:60px"/></td>
    <td><input value="${it.p30 || ''}" data-field="p30" data-idx="${i}" style="width:60px"/></td>
  </tr>`).join('');
  document.getElementById('admin-extracted').style.display = 'block';
}

function addExtractedRow() {
  const tbody = document.getElementById('extracted-tbody');
  const i = tbody.rows.length;
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${i + 1}</td><td><input value="" data-field="name" data-idx="${i}"/></td><td><input value="" data-field="desc" data-idx="${i}"/></td><td><input value="" data-field="p7" data-idx="${i}" style="width:60px"/></td><td><input value="" data-field="p15" data-idx="${i}" style="width:60px"/></td><td><input value="" data-field="p30" data-idx="${i}" style="width:60px"/></td>`;
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
  rows.forEach((row, i) => {
    const get = f => row.querySelector(`[data-field="${f}"]`)?.value.trim() || '';
    if (get('name')) newItems.push({ id: i + 1, name: get('name'), desc: get('desc'), p: { 7: parseFloat(get('p7')) || 0, 15: parseFloat(get('p15')) || 0, 30: parseFloat(get('p30')) || 0 } });
  });
  if (!newItems.length) return;
  applyNewItems(newItems);
  try { await adminFetch({ action: 'saveItems', items: newItems }); showToast('Items updated & saved!'); }
  catch (e) { showToast('Items updated (save failed)'); }
  document.getElementById('admin-panel').classList.remove('open');
}

// ── Shop editor (admin) ────────────────────────

function loadShopEditor() {
  const tbody = document.getElementById('shop-editor-tbody');
  tbody.innerHTML = ITEMS.map((it, i) => `<tr>
    <td class="se-td"><input class="se-input" value="${it.name}" data-se="name" data-i="${i}"/></td>
    <td class="se-td"><input class="se-input" value="${it.desc || ''}" data-se="desc" data-i="${i}"/></td>
    <td class="se-td"><input class="se-input" value="${it.p[7] || ''}" data-se="p7" data-i="${i}" style="width:56px"/></td>
    <td class="se-td"><input class="se-input" value="${it.p[15] || ''}" data-se="p15" data-i="${i}" style="width:56px"/></td>
    <td class="se-td"><input class="se-input" value="${it.p[30] || ''}" data-se="p30" data-i="${i}" style="width:56px"/></td>
    <td class="se-td"><button class="se-rm" onclick="removeShopEditorRow(this)">✕</button></td>
  </tr>`).join('');
  tbody.addEventListener('input', () => { shopEditorDirty = true; }, { once: false });
}

function addShopEditorRow() {
  const tbody = document.getElementById('shop-editor-tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="se-td"><input class="se-input" value="" data-se="name"/></td>
    <td class="se-td"><input class="se-input" value="" data-se="desc"/></td>
    <td class="se-td"><input class="se-input" value="" data-se="p7" style="width:56px"/></td>
    <td class="se-td"><input class="se-input" value="" data-se="p15" style="width:56px"/></td>
    <td class="se-td"><input class="se-input" value="" data-se="p30" style="width:56px"/></td>
    <td class="se-td"><button class="se-rm" onclick="removeShopEditorRow(this)">✕</button></td>`;
  tbody.appendChild(tr);
  shopEditorDirty = true;
}

function removeShopEditorRow(btn) {
  btn.closest('tr').remove();
  shopEditorDirty = true;
}

async function saveShopEdit() {
  const rows = document.querySelectorAll('#shop-editor-tbody tr');
  const newItems = [];
  rows.forEach((row, i) => {
    const get = f => row.querySelector(`[data-se="${f}"]`)?.value.trim() || '';
    if (get('name')) newItems.push({ id: i + 1, name: get('name'), desc: get('desc'), p: { 7: parseFloat(get('p7')) || 0, 15: parseFloat(get('p15')) || 0, 30: parseFloat(get('p30')) || 0 } });
  });
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

// ── Slideshow ──────────────────────────────────

let slideshowTimer = null;
let slideshowIdx = 0;
let slideUrls = ['', ''];

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
}

async function fetchSlideUrls() {
  try {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getSettings' }) });
    const d = await r.json();
    const row = d.slides || [];
    const slides = document.querySelectorAll('#slideshow img');
    row.forEach((url, i) => {
      if (!url) return;
      slideUrls[i] = url;
      if (slides[i]) slides[i].src = url;
      if (adminUnlocked) {
        const thumb = document.getElementById('ss-img-' + i);
        const lbl = document.getElementById('ss-lbl-' + i);
        if (thumb) { thumb.src = url; thumb.style.display = 'block'; }
        if (lbl) lbl.style.display = 'none';
      }
    });
    document.getElementById('slideshow-area')?.classList.remove('loading');
    slideshowIdx = 0;
    startSlideshow();
    initImgFadeIn();
  } catch (e) { }
}

async function uploadSlide(input, idx) {
  const file = input.files[0]; if (!file) return;
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

// ── Admin account form ─────────────────────────

// ── Clock ──────────────────────────────────────

function tick() {
  const n = new Date();
  document.getElementById('ct').textContent = n.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  document.getElementById('cd').textContent = n.toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
tick(); setInterval(tick, 1000);
