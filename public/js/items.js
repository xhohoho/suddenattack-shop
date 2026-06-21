// ── Items data ─────────────────────────────
// ITEMS, DAYS, qtys are declared in config.js — we just populate them here.
// Reset to empty defaults; fetchItems() will load real data from sheet.
ITEMS.length = 0;
ITEMS.push({ id: 1, name: 'Item 1', desc: '', p: { 7: 0, 15: 0, 30: 0 } });
DAYS.forEach(d => { qtys[`1_${d}`] = 0; });

let currentOrderId = null;
let currentOrderTimestamp = null;

// ── Table render ───────────────────────────

function buildTable() {
  document.getElementById('itbody').innerHTML = ITEMS.map(it => `
    <tr>
      <td><div class="iname">${it.name}</div><div class="idesc">${it.desc}</div></td>
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
  const payload = {
    order_id: genId('ORD'), timestamp: new Date().toISOString(),
    name, phone: '', email: '', items: getLines(),
    total: (getTotal() + SERVICE_CHARGE).toFixed(2),
    note: document.getElementById('fno').value.trim(),
    status: 'New', proof: ''
  };
  const btn = document.getElementById('sbtn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, action: 'newOrder' }) });
    ['fn', 'fno'].forEach(id => document.getElementById(id).value = '');
    ITEMS.forEach(it => DAYS.forEach(d => { qtys[`${it.id}_${d}`] = 0; }));
    document.querySelectorAll('.qty-num').forEach(el => { el.textContent = '0'; el.className = 'qty-num zero'; });
    recalc();
    await fetchSheet();
    openModal(payload.total, payload.order_id, payload.timestamp);
  } catch (e) { showToast('Failed to submit. Check your connection.'); }
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
  const oidEl = document.getElementById('modal-order-id');
  if (oidEl) oidEl.textContent = currentOrderId || '—';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('upload-status-item').textContent = '';
  const ubtn = document.getElementById('upload-btn-item');
  ubtn.style.display = 'none'; ubtn.disabled = false; ubtn.textContent = 'Submit proof';
  document.getElementById('preview-img-item').style.display = 'none';
  const pdfTagItem = document.getElementById('preview-pdf-item');
  if (pdfTagItem) pdfTagItem.style.display = 'none';
  const fi = document.getElementById('proof-file-item');
  fi.value = ''; fi.disabled = false;
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  currentOrderId = null; currentOrderTimestamp = null;
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
  if (!file || !currentOrderId) { alert("Error: No file selected or Order ID not found. Try clicking 'Pay' again."); return; }
  const btn = document.getElementById('upload-btn-item');
  btn.disabled = true; btn.textContent = 'Uploading...';
  try {
    await uploadProofFile(file, currentOrderId, 'uploadProofItem');
    document.getElementById('upload-status-item').textContent = 'Submitted!';
    btn.textContent = 'Submitted ✓';
    setTimeout(() => { closeModal(); fetchSheet(); }, 3000);
  } catch (e) { btn.disabled = false; btn.textContent = 'Submit proof'; }
}

document.getElementById('modal-overlay').addEventListener('click', function (e) { if (e.target === this) closeModal(); });

// ── Fetch items from sheet ─────────────────

async function fetchItems() {
  try {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getShopItems' }) });
    const d = await r.json();
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
