// ── State ──────────────────────────────────
let currentFilter = 'all';
let editingId = null;
let newAccId = null;
let currentAccId = null;
let slotUrls = ['', '', '', ''];
let tempFiles = [null, null, null, null];
let sellTempFiles = [null, null, null, null];
let _carouselIdx = 0;
let _carouselItems = [];
let _touchStartX = 0;
const _videoBlobCache = {};
const _blobRefCount   = {};
const _blobCacheOrder = [];
const _BLOB_CACHE_MAX = 20;

// ── Rank helpers ───────────────────────────────
// Canonical Sudden Attack rank order, lowest to highest (used for sorting/reference)
const RANK_ORDER = [
  'skull', '1 bar', '2 bar', '3 bar', '4 bar',
  '1v', '2v', '3v',
  '1 diamond', '2 diamond', '3 diamond',
  '1 major', '2 major', '3 major',
  '1 star', '2 star', '3 star', '4 star', '5 star', '5 star kotak',
  'supreme general of the army'
];

function getRankIcon(rank) {
  if (!rank) return '🎮';
  const r = rank.toLowerCase().trim();
  if (r.includes('supreme')) return '👑';
  const lead = r.match(/^(\d+)/);
  const n = lead ? parseInt(lead[1], 10) : 1;
  if (r.includes('kotak')) return '⭐⭐⭐⭐⭐📦';
  if (r.includes('star')) return '⭐'.repeat(Math.min(n, 5));
  if (r.includes('major')) {
    let icon = '✳️'.repeat(Math.min(n, 3));
    const paku = r.match(/(\d+)\s*paku/);
    if (paku) icon += ' ' + '📌'.repeat(Math.min(parseInt(paku[1], 10), 3));
    return icon;
  }
  if (r.includes('diamond')) return '💎'.repeat(Math.min(n, 3));
  if (/\d\s*v\b/.test(r)) return 'V'.repeat(Math.min(n, 3));
  if (r.includes('bar')) return '▬'.repeat(Math.min(n, 4));
  if (/\bskull\b/.test(r)) return '💀';
  return '🎮';
}

function getRankColor(rank) {
  if (!rank) return 'var(--text2)';
  const r = rank.toLowerCase().trim();
  const lead = r.match(/^(\d+)/);
  const n = lead ? parseInt(lead[1], 10) : 1;
  if (r.includes('supreme')) return '#ff4d6d';
  if (r.includes('kotak')) return '#ff8a3d';
  if (r.includes('star')) return ['#f5d98c', '#f0c873', '#e8b84b', '#d9a233', '#c78a1d'][Math.min(n, 5) - 1];
  if (r.includes('major')) return ['#c7b8f5', '#9b7fe8', '#7a56d6'][Math.min(n, 3) - 1];
  if (r.includes('diamond')) return ['#7ec8ff', '#4a9eff', '#1f6fcc'][Math.min(n, 3) - 1];
  if (/\d\s*v\b/.test(r)) return ['#7be0ae', '#2ecc8a', '#1f9e68'][Math.min(n, 3) - 1];
  if (r.includes('bar')) return ['#b9c0cc', '#9099a8', '#717a87', '#545b66'][Math.min(n, 4) - 1];
  if (/\bskull\b/.test(r)) return 'var(--text3)';
  return 'var(--text2)';
}

// ── Fetch accounts ─────────────────────────
let _lastAccountData = '';
async function fetchAccounts() {
  if (!accounts.length) showGridSkeleton();
  try {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getAccounts' }) });
    const d = await r.json();
    const rows = d.values || [];
    if (!rows.length) return;

    const newData = rows.map(item => ({
      id: item['id'] || '',
      rank: item['rank'] || '',
      price: parseFloat(item['price']) || 0,
      ign: item['ign'] || '',
      accid: item['accid'] || item['accountid'] || '',
      kda: item['kda'] || '',
      winRate: item['winrate'] || '',
      exp: item['exp'] || '',
      ach: item['achievement'] || '',
      notes: item['notes'] || '',
      status: (item['status'] || 'pending').toLowerCase().trim(),
      createdat: parseInt(item['createdat']) || Date.now(),
      img1: item['img1'] || '', img2: item['img2'] || '', img3: item['img3'] || '', img4: item['img4'] || '',
      sellername: item['sellername'] || '',
      sellercontact: item['sellercontact'] || item['sellerphone'] || '',
      sellerign: item['sellerign'] || ''
    })).filter(a => a.id && a.rank);

    const hash = JSON.stringify(newData);
    if (hash === _lastAccountData) return;
    _lastAccountData = hash;
    accounts = newData;
    renderGrid();
    if (adminUnlocked) renderManageList();
  } catch (e) { console.error('Fetch error:', e); }
}

function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  renderGrid();
}

function renderGrid() {
  const q = document.getElementById('acc-search').value.toLowerCase();
  const sort = document.getElementById('sort-select').value;
  let list = [...accounts];
  if (currentFilter !== 'all') list = list.filter(a => (a.status || '').toLowerCase().trim() === currentFilter.toLowerCase());
  if (q) list = list.filter(a => (a.rank + (a.ign || '') + (a.accid || '') + (a.notes || '')).toLowerCase().includes(q));
  if (sort === 'price-asc') list.sort((a, b) => a.price - b.price);
  else if (sort === 'price-desc') list.sort((a, b) => b.price - a.price);
  else list.sort((a, b) => (b.createdat || 0) - (a.createdat || 0));

  document.getElementById('results-count').textContent = list.length + ' account' + (list.length !== 1 ? 's' : '');
  const el = document.getElementById('acc-grid');
  if (!list.length) { el.innerHTML = '<div style="text-align:center;padding:24px;font-size:12px;color:var(--text3);font-family:Rajdhani,sans-serif">No accounts found</div>'; return; }

  el.innerHTML = list.map(a => {
    const rankColor = getRankColor(a.rank);
    const rankIcon = getRankIcon(a.rank);
    const status = (a.status || 'pending').toLowerCase().trim();
    const isSold = status === 'sold';
    const isReserved = status === 'reserved';
    const isPending = status === 'pending';
    const displayPrice = a.price * 1.10;
    const statusPill = isSold ? '<span class="acc-status-pill s-sold">Sold</span>'
      : isReserved ? '<span class="acc-status-pill s-reserved">Reserved</span>'
      : isPending ? '<span class="acc-status-pill s-pending">Pending Review</span>'
      : '<span class="acc-status-pill s-available">Available</span>';
    const esc = escapeHtml;
    const details = [];
    if (a.ign) details.push(`<div class="detail-row"><span class="detail-label">IGN</span><span class="detail-val hl">${esc(a.ign)}</span></div>`);
    if (a.accid) details.push(`<div class="detail-row"><span class="detail-label">ID</span><span class="detail-val">${esc(a.accid)}</span></div>`);
    if (a.kda) details.push(`<div class="detail-row"><span class="detail-label">KDA</span><span class="detail-val hl">${esc(a.kda)}</span></div>`);
    const tags = a.notes ? a.notes.split(',').filter(t => t.trim()).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('') : '';
    let actionHtml = '';
    if (isPending) {
      actionHtml = `<span style="font-size:10px;color:var(--blue);font-family:Rajdhani,sans-serif;letter-spacing:.05em;text-transform:uppercase;opacity:0.7">Awaiting Verification</span>`;
    } else if (isSold || isReserved) {
      actionHtml = `<span style="font-size:11px;color:var(--text3);font-family:Rajdhani,sans-serif;letter-spacing:.05em;text-transform:uppercase">${isSold ? 'Sold out' : 'Reserved'}</span>`;
    } else {
      actionHtml = `<button class="buy-btn" onclick="event.stopPropagation();openPay('${esc(a.id)}')">Buy now</button>`;
    }
    return `<div class="acc-card${isSold ? ' sold' : ''}${isPending ? ' pending' : ''}" onclick="openDetail('${esc(a.id)}')">
      <div class="card-header"><span class="acc-id">${esc(a.id)}</span>${statusPill}</div>
      <div class="card-rank"><div class="rank-icon">${rankIcon}</div><div><div class="rank-name" style="color:${rankColor}">${esc(a.rank)}</div><div class="rank-tier">Sudden Attack</div></div></div>
      ${details.length ? `<div class="card-details">${details.join('')}</div>` : ''}
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      <hr class="card-divider"/>
      <div class="card-footer"><span class="acc-price">${fmt(displayPrice)}</span>${actionHtml}</div>
      ${isSold ? '<div class="sold-overlay"><span class="sold-stamp">Sold</span></div>' : ''}
    </div>`;
  }).join('');
}

// ── Carousel ───────────────────────────────
function _buildCarouselItems(a) {
  return [a.img1, a.img2, a.img3, a.img4].filter(Boolean).map((url, i) => ({ url, type: isVideoUrl(url) ? 'video' : 'img', isStats: i === 0 }));
}

function _renderCarousel(items) {
  if (!items.length) return '<div class="carousel-no-media">No media uploaded</div>';
  const total = items.length;
  const slides = items.map((item, i) => {
    const statsTag = item.isStats ? '<span class="carousel-badge">📊 Stats</span>' : '';
    const counter = total > 1 ? `<span class="carousel-counter">${i + 1} / ${total}</span>` : '';
    const isDrive = item.url.includes('drive.google.com');
    const isVid = item.type === 'video' || isDrive;
    const fileId = item.url.match(/\/d\/([^/?]+)/)?.[1] || item.url.match(/[?&]id=([^&]+)/)?.[1] || '';
    if (isVid && !fileId) return `<div class="carousel-slide">${statsTag}${counter}<div style="color:var(--red);text-align:center;padding:20px;font-size:12px">Invalid video URL</div></div>`;
    let media;
    if (isVid && fileId) {
      const drivePreviewUrl = `https://drive.google.com/file/d/${fileId}/preview`;
      media = `<div class="video-container" style="position:relative;width:100%;height:340px;background:#000" data-file-id="${fileId}"><iframe id="vid-${fileId}" src="${drivePreviewUrl}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none" frameborder="0" allow="autoplay" allowfullscreen></iframe></div>`;
    } else {
      media = `<img src="${item.url}" alt="Account media ${i + 1}" onclick="openLightbox('${item.url}','img')" style="cursor:zoom-in;width:100%;height:340px;object-fit:contain;display:block;background:var(--bg3)" />`;
    }
    return `<div class="carousel-slide">${statsTag}${counter}${media}</div>`;
  }).join('');
  const arrows = total > 1 ? `<button class="carousel-arrow prev" onclick="carouselGoTo(_carouselIdx-1)">‹</button><button class="carousel-arrow next" onclick="carouselGoTo(_carouselIdx+1)">›</button>` : '';
  const dots = total > 1 ? `<div class="carousel-dots" id="det-dots">${items.map((_, i) => `<button class="carousel-dot${i === 0 ? ' active' : ''}" onclick="carouselGoTo(${i})"></button>`).join('')}</div>` : '';
  return `<div class="carousel-wrap" id="det-carousel" ontouchstart="carouselTouchStart(event)" ontouchend="carouselTouchEnd(event)"><div class="carousel-track" id="det-track">${slides}</div>${arrows}${dots}</div>`;
}

function carouselGoTo(idx) {
  _carouselIdx = Math.max(0, Math.min(idx, _carouselItems.length - 1));
  const track = document.getElementById('det-track'); if (track) track.style.transform = `translateX(-${_carouselIdx * 100}%)`;
  document.querySelectorAll('#det-dots .carousel-dot').forEach((d, i) => d.classList.toggle('active', i === _carouselIdx));
}
function carouselTouchStart(e) { _touchStartX = e.changedTouches[0].clientX; }
function carouselTouchEnd(e) { const dx = e.changedTouches[0].clientX - _touchStartX; if (Math.abs(dx) < 40) return; dx < 0 ? carouselGoTo(_carouselIdx + 1) : carouselGoTo(_carouselIdx - 1); }

// ── Detail modal ───────────────────────────
let _lastDetailId = null;
let _lastDetailHTML = '';

function openDetail(id) {
  const a = accounts.find(x => x.id === id); if (!a) return;
  if (id === _lastDetailId && _lastDetailHTML) { document.getElementById('detail-content').innerHTML = _lastDetailHTML; document.getElementById('detail-overlay').classList.add('open'); return; }
  const rankColor = getRankColor(a.rank); const rankIcon = getRankIcon(a.rank);
  const isSold = a.status === 'sold'; const isReserved = a.status === 'reserved'; const isPending = a.status === 'pending';
  _carouselItems = _buildCarouselItems(a); _carouselIdx = 0;
  const esc = escapeHtml;
  const rows = [];
  if (a.ign) rows.push(['IGN', esc(a.ign)]);
  if (a.accid) rows.push(['Account ID', esc(a.accid)]);
  if (a.kda) rows.push(['KDA', esc(a.kda)]);
  if (a.winRate) rows.push(['Win Rate', esc(a.winRate) + '%']);
  if (a.exp) rows.push(['EXP Progress', esc(a.exp) + '%']);
  if (a.ach) rows.push(['Achievement', esc(a.ach) + '%']);
  const tags = a.notes ? a.notes.split(',').filter(t => t.trim()).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('') : '';
  const displayPrice = a.price * 1.10;
  const statusPill = isSold ? '<span class="acc-status-pill s-sold" style="font-size:11px;padding:3px 10px">Sold</span>' : isReserved ? '<span class="acc-status-pill s-reserved" style="font-size:11px;padding:3px 10px">Reserved</span>' : isPending ? '<span class="acc-status-pill s-pending" style="font-size:11px;padding:3px 10px">Pending Review</span>' : '<span class="acc-status-pill s-available" style="font-size:11px;padding:3px 10px">Available</span>';

  _lastDetailHTML = `
    <div class="detail-modal-media">${_renderCarousel(_carouselItems)}</div>
    <div class="detail-modal-body">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;margin-top:4px">
        <div style="display:flex;align-items:center;gap:12px"><div class="detail-modal-rank-icon">${rankIcon}</div><div><div class="detail-modal-rank-name" style="color:${rankColor}">${esc(a.rank)}</div><div class="detail-modal-rank-sub">Sudden Attack · ${esc(a.id)}</div></div></div>
        ${statusPill}
      </div>
      ${rows.length ? `<div class="modal-details" style="margin-bottom:12px">${rows.map(([l, v]) => `<div class="modal-detail-row"><span class="modal-detail-label">${esc(l)}</span><span class="modal-detail-val">${esc(v)}</span></div>`).join('')}</div>` : ''}
      ${tags ? `<div class="modal-tags" style="margin-bottom:14px">${tags}</div>` : ''}
      <div class="modal-price-row">
        <span class="modal-price">${fmt(displayPrice)}</span>
        ${!isSold && !isReserved && !isPending ? `<button class="buy-btn" style="padding:9px 22px;font-size:13px" onclick="closeDetail();openPay('${esc(a.id)}')">Buy now</button>` : isPending ? `<span style="font-size:11px;color:var(--blue);font-family:Rajdhani,sans-serif;letter-spacing:.05em;text-transform:uppercase">Under Verification</span>` : `<span style="font-size:11px;color:var(--text3);font-family:Rajdhani,sans-serif;letter-spacing:.05em;text-transform:uppercase">${isSold ? 'Sold out' : 'Reserved'}</span>`}
      </div>
    </div>`;
  _lastDetailId = id;
  document.getElementById('detail-content').innerHTML = _lastDetailHTML;
  document.getElementById('detail-overlay').classList.add('open');
}

function closeDetail() {
  document.querySelectorAll('#det-carousel .video-container iframe').forEach(ifr => { ifr.src = 'about:blank'; });
  document.getElementById('detail-overlay').classList.remove('open');
}

// ── Buy modal ──────────────────────────────
function openPay(id) {
  const a = accounts.find(x => x.id === id); if (!a) return;
  currentAccId = id;
  const finalPrice = a.price * 1.10;
  document.getElementById('modal-acc-info').textContent = a.rank + (a.ign ? ' · ' + a.ign : '') + (a.accid ? ' · ID ' + a.accid : '');
  document.getElementById('modal-amt-acc').textContent = fmt(finalPrice);
  document.getElementById('pay-overlay').classList.add('open');
  document.getElementById('upload-status-acc').textContent = '';
  const ubtn = document.getElementById('upload-btn-acc');
  ubtn.style.display = 'none'; ubtn.disabled = false; ubtn.textContent = 'Submit payment';
  document.getElementById('preview-img-acc').style.display = 'none';
  document.getElementById('preview-pdf-acc').style.display = 'none';
  document.getElementById('proof-file-acc').value = '';
  document.getElementById('buyer-ign').value = '';
  document.getElementById('buyer-name').value = '';
  document.getElementById('buyer-phone').value = '';
}
function closePay() { document.getElementById('pay-overlay').classList.remove('open'); currentAccId = null; }

function previewFileAcc(input) { previewProofFile(input, 'preview-img-acc', 'preview-pdf-acc', 'upload-btn-acc'); }

async function submitPurchase() {
  const buyerIgn = document.getElementById('buyer-ign').value.trim();
  const buyerName = document.getElementById('buyer-name').value.trim();
  const buyerPhone = document.getElementById('buyer-phone').value.trim();
  const file = document.getElementById('proof-file-acc').files[0];
  if (!buyerIgn) { showToast('Please enter your in-game name.'); return; }
  if (!buyerName) { showToast('Please enter your full name.'); return; }
  if (!buyerPhone) { showToast('Please enter your phone number.'); return; }
  if (!file) { showToast('Please upload payment screenshot or PDF.'); return; }
  const btn = document.getElementById('upload-btn-acc'), status = document.getElementById('upload-status-acc');
  btn.disabled = true; btn.textContent = 'Uploading...';
  status.textContent = 'Uploading proof...'; status.style.color = 'var(--text2)';
  try {
    const acc = accounts.find(x => x.id === currentAccId);
    const orderId = genId('ACC'); const timestamp = new Date().toISOString();
    const details = [acc?.rank, acc?.ign ? 'IGN:' + acc.ign : '', acc?.accid ? 'ID:' + acc.accid : ''].filter(Boolean).join(' · ');
    await uploadProofFile(file, orderId, 'accountPurchase', { acc_id: currentAccId, timestamp, name: buyerIgn, buyer_name: buyerName, phone: buyerPhone, email: '', items: details, total: acc?.price || 0, note: '', status: 'Paid' });
    status.textContent = 'Logging order...';
    await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'newOrder', order_id: orderId, timestamp, name: buyerName + ' (' + buyerIgn + ')', phone: buyerPhone, email: '', items: details, total: acc?.price || 0, note: 'Buyer IGN: ' + buyerIgn, status: 'Paid', proof: '' }) });
    status.textContent = 'Marking account reserved...';
    try { await adminFetch({ action: 'updateAccountStatus', account: { id: currentAccId, status: 'reserved' } }); } catch (_) { showToast('Order placed but account status update failed'); }
    status.textContent = 'Payment submitted! We will contact you soon.'; status.style.color = 'var(--green)';
    btn.textContent = 'Submitted ✓';
    setTimeout(() => { closePay(); fetchAccounts(); fetchSheet(); }, 4000);
  } catch (e) { status.textContent = 'Failed: ' + e.message; status.style.color = 'var(--red)'; btn.disabled = false; btn.textContent = 'Submit payment'; }
}

// ── Sell modal (public) ────────────────────
function openSellModal() {
  document.getElementById('sell-overlay').classList.add('open');
  document.getElementById('sell-status').textContent = '';
  for (let i = 0; i < 4; i++) {
    sellTempFiles[i] = null;
    const img = document.getElementById('ss-slot-img-' + i); if (img) { img.src = ''; img.style.display = 'none'; }
    const lbl = document.getElementById('ss-slot-lbl-' + i); if (lbl) lbl.style.display = '';
    const rm = document.getElementById('ss-slot-rm-' + i); if (rm) rm.style.display = 'none';
    const inp = document.getElementById('ss-slot-' + i)?.querySelector('input'); if (inp) inp.value = '';
  }
  ['sell-seller-name', 'sell-seller-contact', 'sell-seller-ign', 'sell-rank', 'sell-price', 'sell-ign', 'sell-accid', 'sell-kda', 'sell-wr', 'sell-exp', 'sell-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const btn = document.getElementById('sell-submit-btn'); btn.disabled = false; btn.textContent = 'Submit listing';
}
function closeSellModal() { document.getElementById('sell-overlay').classList.remove('open'); }

function handleSellSlot(input, idx) {
  const file = input.files[0]; if (!file) return;
  sellTempFiles[idx] = file;
  const reader = new FileReader();
  reader.onload = e => { const img = document.getElementById('ss-slot-img-' + idx); if (img) { img.src = e.target.result; img.style.display = 'block'; } const lbl = document.getElementById('ss-slot-lbl-' + idx); if (lbl) lbl.style.display = 'none'; const rm = document.getElementById('ss-slot-rm-' + idx); if (rm) rm.style.display = 'block'; };
  reader.readAsDataURL(file);
}

function removeSellSlot(e, idx) {
  e.stopPropagation(); sellTempFiles[idx] = null;
  const img = document.getElementById('ss-slot-img-' + idx); if (img) { img.src = ''; img.style.display = 'none'; }
  const lbl = document.getElementById('ss-slot-lbl-' + idx); if (lbl) lbl.style.display = '';
  const rm = document.getElementById('ss-slot-rm-' + idx); if (rm) rm.style.display = 'none';
  const inp = document.getElementById('ss-slot-' + idx)?.querySelector('input'); if (inp) inp.value = '';
}

async function submitSellAccount() {
  const g = id => document.getElementById(id)?.value.trim() || '';
  const sellername = g('sell-seller-name'); const sellercontact = g('sell-seller-contact'); const sellerign = g('sell-seller-ign');
  const rank = g('sell-rank'); const ign = g('sell-ign'); const price = parseFloat(g('sell-price'));
  if (!sellername) { showToast('Please enter your full name.'); return; }
  if (!sellercontact) { showToast('Please enter your phone number.'); return; }
  if (!sellerign) { showToast('Please enter your in-game name.'); return; }
  if (!rank) { showToast('Please enter the account rank.'); return; }
  if (!price || price <= 0) { showToast('Please enter a valid asking price.'); return; }
  const btn = document.getElementById('sell-submit-btn'); const status = document.getElementById('sell-status');
  btn.disabled = true; btn.textContent = 'Submitting...';
  status.textContent = 'Preparing listing...'; status.style.color = 'var(--text2)';
  const systemid = genId('ACC'); const uploadedUrls = ['', '', '', ''];
  try {
    const filesToUpload = sellTempFiles.map((f, i) => ({ file: f, idx: i })).filter(x => x.file);
    for (const { file, idx } of filesToUpload) {
      status.textContent = `Uploading media ${idx + 1}...`;
      const isVid = file.type.startsWith('video/') || file.type === 'image/gif';
      const fileName = `acc_${idx}_${Date.now()}.${file.name.split('.').pop()}`;
      if (isVid) { status.textContent = `Uploading video ${idx + 1} directly to Drive...`; uploadedUrls[idx] = await uploadDirectToDrive(file, fileName, 'account_public', ign); }
      else { const base64 = await compressImage(file, 1200, 0.8); const resp = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'uploadPublicAccountImage', ign, fileName, mimeType: 'image/jpeg', base64 }) }); const res = await resp.json(); if (res.error) throw new Error(res.error); uploadedUrls[idx] = res.url || ''; }
    }
    status.textContent = 'Saving listing...';
    const acc = { id: systemid, rank, price, ign: g('sell-ign'), accid: g('sell-accid'), sellername, sellercontact, sellerign, kda: g('sell-kda'), winrate: g('sell-wr'), exp: g('sell-exp'), achievement: '', notes: g('sell-notes'), status: 'pending', createdat: Date.now(), img1: uploadedUrls[0], img2: uploadedUrls[1], img3: uploadedUrls[2], img4: uploadedUrls[3] };
    const resp = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'saveAccount', account: acc, isNew: true }) });
    const result = await resp.json(); if (result.error) throw new Error(result.error);
    status.textContent = 'Listing submitted! We will review and contact you soon.'; status.style.color = 'var(--green)';
    btn.textContent = 'Submitted ✓';
    setTimeout(() => { closeSellModal(); fetchAccounts(); }, 3500);
  } catch (e) { status.textContent = 'Failed: ' + e.message; status.style.color = 'var(--red)'; btn.disabled = false; btn.textContent = 'Submit listing'; }
}

// ── Admin: manage list ─────────────────────
function renderManageList() {
  const el = document.getElementById('acc-manage-list');
  if (!el) return;
  if (!accounts.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text3);font-family:Rajdhani,sans-serif;text-align:center;padding:16px">No accounts yet</div>'; return; }
  const sortedAccounts = [...accounts].sort((a, b) => (b.createdat || 0) - (a.createdat || 0));
  const esc = escapeHtml;
  el.innerHTML = sortedAccounts.map(a => {
    const sellerInfo = a.sellername ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">Seller: ${esc(a.sellername)}${a.sellercontact ? ' · ' + esc(a.sellercontact) : ''}</div>` : '';
    const publicPrice = a.price * 1.10;
    return `<div class="acc-list-item" id="acc-row-${esc(a.id)}">
      <div class="acc-list-info">
        <div style="display:flex; align-items:center; gap:8px"><strong>${esc(a.rank)}</strong><span style="color:var(--text3); font-size:11px;">(Net: ${fmt(a.price)} → Sell: ${fmt(publicPrice)})</span></div>
        <div style="font-size:12px;color:var(--text2);margin-top:2px">${a.ign ? esc(a.ign) : ''}${a.accid ? ' · ID ' + esc(a.accid) : ''}</div>
        ${sellerInfo}<div class="acc-mgmt-id" style="margin-top:3px">${esc(a.id)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
        <select class="status-select" id="acc-st-${esc(a.id)}">
          <option value="pending" ${a.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="available" ${a.status === 'available' ? 'selected' : ''}>Available</option>
          <option value="reserved" ${a.status === 'reserved' ? 'selected' : ''}>Reserved</option>
          <option value="sold" ${a.status === 'sold' ? 'selected' : ''}>Sold</option>
        </select>
        <button class="save-status-btn" id="acc-btn-${esc(a.id)}" onclick="updateAccStatus('${esc(a.id)}')">Save</button>
        <span id="acc-ind-${esc(a.id)}" style="font-size:13px;width:16px;text-align:center;flex-shrink:0"></span>
        <button class="icon-btn" onclick="showAddForm('${esc(a.id)}')" title="Edit">✎</button>
        <button class="icon-btn danger" onclick="deleteAccount('${esc(a.id)}')" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function updateAccStatus(id) {
  const sel = document.getElementById('acc-st-' + id); const btn = document.getElementById('acc-btn-' + id); const ind = document.getElementById('acc-ind-' + id);
  btn.disabled = true; btn.textContent = '...'; ind.textContent = '';
  try {
    await adminFetch({ action: 'updateAccountStatus', account: { id, status: sel.value } });
    const a = accounts.find(x => x.id === id); if (a) a.status = sel.value;
    ind.textContent = '✓'; ind.style.color = 'var(--green)'; btn.textContent = 'Save'; btn.disabled = false;
    setTimeout(() => { if (ind) ind.textContent = ''; }, 3000);
    renderGrid();
  } catch (e) { ind.textContent = '✕'; ind.style.color = 'var(--red)'; btn.textContent = 'Save'; btn.disabled = false; setTimeout(() => { if (ind) ind.textContent = ''; }, 4000); }
}

// ── Admin: account form ────────────────────
function showAddForm(id = null) {
  editingId = id; newAccId = id ? null : genId('ACC');
  document.getElementById('acc-form-label').textContent = id ? 'Edit account' : 'New account';
  document.getElementById('cancel-form-btn').style.display = '';
  resetSlots();
  if (id) {
    const a = accounts.find(x => x.id === id);
    if (a) {
      document.getElementById('f-rank').value = a.rank || ''; document.getElementById('f-price').value = a.price || '';
      document.getElementById('f-ign').value = a.ign || ''; document.getElementById('f-id').value = a.accid || '';
      document.getElementById('f-kda').value = a.kda || ''; document.getElementById('f-wr').value = a.winRate || '';
      document.getElementById('f-exp').value = a.exp || ''; document.getElementById('f-ach').value = a.ach || '';
      document.getElementById('f-notes').value = a.notes || ''; document.getElementById('f-status').value = a.status || 'available';
      document.getElementById('f-sellername').value = a.sellername || ''; document.getElementById('f-sellercontact').value = a.sellercontact || ''; document.getElementById('f-sellerign').value = a.sellerign || '';
      populateSlots(a);
    }
  }
  document.getElementById('acc-form').style.display = 'block';
  document.getElementById('acc-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideAddForm() { document.getElementById('acc-form').style.display = 'none'; document.getElementById('cancel-form-btn').style.display = 'none'; editingId = null; newAccId = null; resetSlots(); }

function clearSlot(i) {
  const img = document.getElementById('slot-img-' + i), vid = document.getElementById('slot-vid-' + i);
  if (img) { img.src = ''; img.style.display = 'none'; } if (vid) { vid.src = ''; vid.style.display = 'none'; }
  document.getElementById('slot-rm-' + i)?.style && (document.getElementById('slot-rm-' + i).style.display = 'none');
  const lbl = document.getElementById('slot-' + i)?.querySelector('.slot-lbl'); if (lbl) lbl.style.display = '';
  const inp = document.getElementById('slot-' + i)?.querySelector('input'); if (inp) inp.value = '';
}

function resetSlots() { slotUrls = ['','','','']; tempFiles = [null,null,null,null]; for (let i = 0; i < 4; i++) clearSlot(i); document.getElementById('stats-review-panel').style.display = 'none'; document.getElementById('stats-extract-status').textContent = ''; }

function populateSlots(a) {
  slotUrls = [a.img1, a.img2, a.img3, a.img4];
  slotUrls.forEach((url, i) => {
    if (!url) return;
    const isVid = isVideoUrl(url), img = document.getElementById('slot-img-' + i), vid = document.getElementById('slot-vid-' + i);
    if (isVid) { if (vid) { vid.src = url; vid.style.display = 'block'; } } else { if (img) { img.src = url; img.style.display = 'block'; } }
    document.getElementById('slot-rm-' + i).style.display = 'block';
    document.getElementById('slot-' + i).querySelector('.slot-lbl').style.display = 'none';
  });
}

function applyStatsToForm() {
  const g = id => document.getElementById(id).value.trim();
  document.getElementById('f-ign').value = g('rv-ign'); document.getElementById('f-id').value = g('rv-accid');
  document.getElementById('f-kda').value = g('rv-kda'); document.getElementById('f-wr').value = g('rv-wr'); document.getElementById('f-exp').value = g('rv-exp');
  document.getElementById('stats-review-panel').style.display = 'none'; showToast('Stats applied to form.');
}

async function handleSlotFile(input, idx) {
  const file = input.files[0]; if (!file) return;
  tempFiles[idx] = file;
  const reader = new FileReader();
  reader.onload = e => {
    const isVid = file.type.startsWith('video/'), isGif = file.type === 'image/gif';
    const img = document.getElementById('slot-img-' + idx), vid = document.getElementById('slot-vid-' + idx);
    if (isVid && !isGif) { if (vid) { vid.src = e.target.result; vid.style.display = 'block'; } if (img) img.style.display = 'none'; }
    else { if (img) { img.src = e.target.result; img.style.display = 'block'; } if (vid) vid.style.display = 'none'; }
    document.getElementById('slot-' + idx).querySelector('.slot-lbl').style.display = 'none';
    document.getElementById('slot-rm-' + idx).style.display = 'block';
  };
  reader.readAsDataURL(file);
  if (idx === 0) {
    const st = document.getElementById('stats-extract-status'), rv = document.getElementById('stats-review-panel');
    st.textContent = 'Extracting data...'; st.style.color = 'var(--text2)';
    try { const base64 = await compressImage(file, 1400, 0.85); const resp = await adminFetch({ action: 'extractAccountStats', base64 }); const result = await resp.json(); document.getElementById('rv-ign').value = result.ign || ''; document.getElementById('rv-accid').value = result.accid || ''; document.getElementById('rv-kda').value = result.kda || ''; document.getElementById('rv-wr').value = result.winRate || ''; document.getElementById('rv-exp').value = result.exp || ''; rv.style.display = 'block'; st.textContent = 'Stats extracted.'; st.style.color = 'var(--green)'; }
    catch (e) { st.textContent = 'Data extraction failed.'; st.style.color = 'var(--red)'; }
  }
}

function removeSlot(e, idx) {
  e.stopPropagation(); tempFiles[idx] = null; slotUrls[idx] = '';
  const img = document.getElementById('slot-img-' + idx); if (img) { img.src = ''; img.style.display = 'none'; }
  const vid = document.getElementById('slot-vid-' + idx); if (vid) { vid.src = ''; vid.style.display = 'none'; }
  document.getElementById('slot-rm-' + idx).style.display = 'none';
  document.getElementById('slot-' + idx).querySelector('.slot-lbl').style.display = '';
  document.getElementById('slot-' + idx).querySelector('input').value = '';
  if (idx === 0) { document.getElementById('stats-review-panel').style.display = 'none'; document.getElementById('stats-extract-status').textContent = ''; }
}

async function saveAccount() {
  const rank = document.getElementById('f-rank').value.trim(); const ign = document.getElementById('f-ign').value.trim();
  const price = parseFloat(document.getElementById('f-price').value);
  const st = document.getElementById('save-acc-status'), btn = document.getElementById('save-acc-btn');
  if (!rank) { showToast('⚠️ Rank is required!'); return; }
  if (isNaN(price) || price <= 0) { showToast('⚠️ Price is required!'); return; }
  if (!adminToken) { showToast('Admin session expired.'); return; }
  btn.disabled = true; btn.textContent = 'Uploading...';
  if (st) { st.textContent = 'Initializing...'; st.style.color = 'var(--text2)'; }

  async function uploadSlot(i) {
    if (!tempFiles[i]) return;
    const file = tempFiles[i]; const ext = file.name.split('.').pop(); const fileName = `acc_${i}_${Date.now()}.${ext}`;
    const isVid = file.type.startsWith('video/'); const isGif = file.type === 'image/gif';
    if (isVid || isGif) { if (st) st.textContent = `Uploading video (slot ${i + 1}) directly to Drive...`; slotUrls[i] = await uploadDirectToDrive(file, fileName, 'account', ign); }
    else { const base64 = await compressImage(file, 1200, 0.8); const resp = await adminFetch({ action: 'uploadAccountImage', ign, fileName, mimeType: 'image/jpeg', base64 }); const res = await resp.json(); if (res.error) throw new Error('Upload error: ' + res.error); slotUrls[i] = res.url; }
  }

  try {
    if (tempFiles[0]) { if (st) st.textContent = 'Uploading stats screenshot...'; await uploadSlot(0); }
    const pending = [1, 2, 3].filter(i => tempFiles[i]);
    if (pending.length) { for (const i of pending) { if (st) st.textContent = `Uploading media file ${i + 1} of ${pending.length}...`; await uploadSlot(i); } }
    if (st) st.textContent = 'Saving account data...';
    const acc = { id: editingId || newAccId, rank: document.getElementById('f-rank').value.trim(), price: parseFloat(document.getElementById('f-price').value), ign: document.getElementById('f-ign').value.trim(), accid: document.getElementById('f-id').value.trim(), sellername: document.getElementById('f-sellername').value.trim(), sellercontact: document.getElementById('f-sellercontact').value.trim(), sellerign: document.getElementById('f-sellerign').value.trim(), kda: document.getElementById('f-kda').value.trim(), winrate: document.getElementById('f-wr').value.trim(), exp: document.getElementById('f-exp').value.trim(), achievement: document.getElementById('f-ach').value.trim(), notes: document.getElementById('f-notes').value.trim(), status: document.getElementById('f-status').value, createdat: Date.now(), img1: slotUrls[0], img2: slotUrls[1], img3: slotUrls[2], img4: slotUrls[3] };
    const finalResp = await adminFetch({ action: 'saveAccount', account: acc, isNew: !editingId });
    const result = await finalResp.json(); if (result.error) throw new Error(result.error);
    if (st) { st.textContent = 'Saved successfully!'; st.style.color = 'var(--green)'; }
    btn.textContent = 'Saved ✓'; showToast(editingId ? 'Account updated!' : 'Account added!');
    setTimeout(() => { hideAddForm(); fetchAccounts(); btn.disabled = false; btn.textContent = 'Save account'; if (st) st.textContent = ''; }, 1200);
  } catch (e) { if (st) { st.textContent = 'Error: ' + e.message; st.style.color = 'var(--red)'; } showToast('Save failed: ' + e.message); btn.disabled = false; btn.textContent = 'Save account'; }
}

function showGridSkeleton() { document.getElementById('acc-grid').innerHTML = Array(4).fill(`<div class="skeleton"><div class="skel-line short"></div><div class="skel-line med"></div><div class="skel-line full"></div><div class="skel-line full"></div><div class="skel-line short"></div></div>`).join(''); }

function deleteAccount(id) {
  const a = accounts.find(x => x.id === id); if (!a) return;
  if (!confirm('Are you absolutely sure you want to delete this account?')) return;
  (async () => {
    try {
      const resp = await adminFetch({ action: 'deleteAccount', acc_id: id, ign: a.ign }); const result = await resp.json();
      if (result.error) throw new Error(result.error);
      _lastDetailId = null; _lastDetailHTML = '';
      const detailEl = document.getElementById('detail-content'); if (detailEl) detailEl.innerHTML = '';
      _lastAccountData = ''; showToast('Account deleted successfully.'); await fetchAccounts();
    } catch (e) { showToast('Delete failed: ' + e.message); }
  })();
}

registerFn('renderManageList', renderManageList);

// ── Overlay close handlers ─────────────────
document.getElementById('pay-overlay').addEventListener('click', function (e) { if (e.target === this) closePay(); });
document.getElementById('sell-overlay').addEventListener('click', function (e) { if (e.target === this) closeSellModal(); });
document.getElementById('lightbox').addEventListener('click', function (e) { if (e.target === this) closeLightbox(); });
document.getElementById('acc-search').addEventListener('input', debounce(renderGrid, 200));

	// Close modals with Escape key
	document.addEventListener('keydown', function (e) {
	  if (e.key === 'Escape') {
	    if (document.getElementById('detail-overlay').classList.contains('open')) closeDetail();
	    else if (document.getElementById('pay-overlay').classList.contains('open')) closePay();
	    else if (document.getElementById('sell-overlay').classList.contains('open')) closeSellModal();
	    else if (document.getElementById('lightbox').classList.contains('open')) closeLightbox();
	    else if (document.getElementById('modal-overlay').classList.contains('open')) closeModal();
	  }
	});
