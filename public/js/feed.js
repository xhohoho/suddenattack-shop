// ── Order feed ─────────────────────────────────

const AVC = [['#1a1230', '#9b7fe8'], ['#0d1f18', '#2ecc8a'], ['#0d1825', '#4a9eff'], ['#1f160a', '#e8b84b'], ['#0f1a12', '#5ecb7a']];

function renderFeed(orders) {
  const el = document.getElementById('feed');
  if (!orders.length) { el.innerHTML = '<div class="empty-feed">No orders yet</div>'; return; }

  const visible = orders.slice(0, 8);
  while (el.children.length > visible.length) el.removeChild(el.lastChild);

  visible.forEach((o, i) => {
    const [bg, fg] = AVC[i % AVC.length];
    const ini = o.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const ts = o.timestamp || '', oid = o.order_id || '';
    const tot = parseFloat(o.total || 0);
    const actualStatus = (!o.status && isToday(ts)) ? 'New' : (o.status || 'New');
    const sc = statusClass(actualStatus);
    const showNewBadge = isToday(ts) && o.status && o.status !== 'New';
    const fp = `${oid}|${actualStatus}|${tot}`;

    let card = el.children[i];
    if (card && card.dataset.fp === fp) return;

    const html = `<div class="fcard" data-fp="${fp}">
      <div class="av" style="background:${bg};color:${fg}">${ini}</div>
      <div class="fb">
        <div class="fn2">${o.name}</div>
        <div class="fi">${o.items}</div>
        ${o.note ? `<div class="fi" style="font-style:italic;color:var(--text3)">${o.note}</div>` : ''}
        <span class="pill ${sc}">${actualStatus}</span>${showNewBadge ? `<span class="pill p-new" style="margin-left:4px">New</span>` : ''}${isPayable(o.status) ? `<button class="pay-btn" data-tot="${tot}" data-oid="${oid}" data-ts="${ts || new Date().toISOString()}" onclick="openModal(this)">Pay</button>` : ''}
      </div>
      <div class="fr"><div class="ft">${fmt(tot)}</div><div class="fa">${timeAgo(ts)}</div></div>
    </div>`;

    if (!card) { el.insertAdjacentHTML('beforeend', html); }
    else { card.outerHTML = html; }
  });
}

function isPayable(s) { return !s || s === 'New'; }

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
        note: r.note
      }));
    }
    document.getElementById('sync-lbl').textContent = 'Synced ' + new Date().toLocaleTimeString();
  } catch (e) { document.getElementById('sync-lbl').textContent = 'Sync failed'; }
}
