// ── Order feed ─────────────────────────────────

const AVC = [['#1a1230', '#9b7fe8'], ['#0d1f18', '#2ecc8a'], ['#0d1825', '#4a9eff'], ['#1f160a', '#e8b84b'], ['#0f1a12', '#5ecb7a']];

function renderFeed(orders) {
  const el = document.getElementById('feed');
  if (!orders.length) { el.innerHTML = '<div class="empty-feed">No orders yet</div>'; return; }

  const visible = orders.slice(0, 8);
  while (el.children.length > visible.length) el.removeChild(el.lastChild);

  visible.forEach((o, i) => {
    const [bg, fg] = AVC[i % AVC.length];
    const ini = escapeHtml(o.name).split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const ts = o.timestamp || '', oid = escapeHtml(o.order_id || '');
    const tot = parseFloat(o.total || 0);
    const actualStatus = (!o.status && isToday(ts)) ? 'New' : (o.status || 'New');
    const sc = statusClass(actualStatus);
    const showNewBadge = isToday(ts) && o.status && o.status !== 'New';
    const fp = `${oid}|${actualStatus}|${tot}|${o.comment || ''}|${adminUnlocked ? 1 : 0}`;

    let card = el.children[i];
    if (card && card.dataset.fp === fp) return; // unchanged, skip

    const commentHtml = adminUnlocked
      ? `<div class="fi" style="margin-top:4px;display:flex;align-items:center;gap:6px">
          <input type="text" id="feedcm-${oid}" value="${escapeHtml(o.comment || '').replace(/"/g, '&quot;')}" placeholder="Add comment — visible to everyone"
            style="flex:1;min-width:0;border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;font-family:'Inter',sans-serif;color:var(--text);background:var(--bg3);outline:none" />
          <button class="pay-btn" id="feedcmbtn-${oid}" onclick="saveFeedComment('${oid}')" style="cursor:pointer;border:none">💬 Save</button>
          <span id="feedcmind-${oid}" style="font-size:12px;width:14px;text-align:center;flex-shrink:0"></span>
        </div>`
      : (o.comment ? `<div class="fi" style="color:var(--accent)">💬 <strong>Admin:</strong> ${escapeHtml(o.comment)}</div>` : '');

    const html = `<div class="fcard" data-fp="${fp}">
      <div class="av" style="background:${bg};color:${fg}">${ini}</div>
      <div class="fb">
        <div class="fn2">${escapeHtml(o.name)}</div>
        <div class="fi">${escapeHtml(o.items)}</div>
        ${o.note ? `<div class="fi" style="font-style:italic;color:var(--text3)">${escapeHtml(o.note)}</div>` : ''}
        ${commentHtml}
        <span class="pill ${sc}">${escapeHtml(actualStatus)}</span>${showNewBadge ? `<span class="pill p-new" style="margin-left:4px">New</span>` : ''}${isPayable(o.status) ? `<button class="pay-btn" data-tot="${tot}" data-oid="${oid}" data-ts="${ts || new Date().toISOString()}" onclick="openModal(this)">Pay</button>` : ''}
      </div>
      <div class="fr"><div class="ft">${fmt(tot)}</div><div class="fa">${timeAgo(ts)}</div></div>
    </div>`;

    if (!card) { el.insertAdjacentHTML('beforeend', html); }
    else { card.outerHTML = html; }
  });
}

function isPayable(s) { return !s || s === 'New'; }

async function saveFeedComment(orderId) {
  const inp = document.getElementById('feedcm-' + orderId);
  const btn = document.getElementById('feedcmbtn-' + orderId);
  const ind = document.getElementById('feedcmind-' + orderId);
  if (!inp) return;
  btn.disabled = true; btn.textContent = '...'; ind.textContent = '';
  try {
    await adminFetch({ action: 'updateOrderComment', order_id: orderId, comment: inp.value });
    const o = allOrders.find(x => x.order_id === orderId);
    if (o) o.comment = inp.value;
    ind.textContent = '✔'; ind.style.color = 'var(--green)';
    btn.textContent = '💬 Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 3000);
    _lastFeedData = '';
    fetchSheet();
  } catch (e) {
    ind.textContent = '✘'; ind.style.color = 'var(--red)';
    btn.textContent = '💬 Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 4000);
  }
}

let _lastFeedData = '';
async function fetchSheet() {
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getOrders' })
    });
    const d = await r.json();
    const rows = (d.values || []).reverse();
    const fp = rows.length + '|' + (rows[0]?.order_id || '') + '|' + (rows[rows.length - 1]?.order_id || '') + '|' + (rows[0]?.status || '');
    if (_lastFeedData !== fp) {
      _lastFeedData = fp;
      renderFeed(rows);
      allOrders = rows.map(r => ({
        order_id: r.order_id, timestamp: r.timestamp, name: r.name,
        items: r.items, total: r.total, status: r.status,
        note: r.note, comment: r.comment
      }));
    }
    document.getElementById('sync-lbl').textContent = 'Synced ' + new Date().toLocaleTimeString();
  } catch (e) { document.getElementById('sync-lbl').textContent = 'Sync failed'; }
}
