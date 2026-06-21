// ── Helpers ────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmt(n) {
  return 'RM ' + parseFloat(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let _toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  clearTimeout(_toastTimer);
  t.textContent = msg;
  t.setAttribute('role', 'alert');
  t.setAttribute('aria-live', 'polite');
  t.classList.add('show');
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 172800) return 'Yesterday';
  return Math.floor(s / 86400) + 'd ago';
}

function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts), n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

function statusClass(s) {
  if (!s || s === 'New') return 'p-new';
  if (s === 'Paid') return 'p-paid';
  if (s === 'Verified') return 'p-verified';
  if (s === 'Completed') return 'p-completed';
  if (s === 'Confirmed') return 'p-conf';
  return 'p-done';
}

function genId(prefix, isAccount = false) {
  const coreId = prefix + '-' + Date.now().toString(36).toUpperCase();
  if (isAccount) return coreId;
  return coreId + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

// ── Shared image compress util ─────────────────

function compressImage(file, maxSize, quality) {
  return new Promise((res, rej) => {
    const im = new Image();
    const r2 = new FileReader();

    function cleanup() {
      im.onload = im.onerror = null;
      r2.onload = r2.onerror = null;
    }

    r2.onload = ev => {
      im.onload = () => {
        try {
          const c = document.createElement('canvas');
          let w = im.width, h = im.height;
          if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
          if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; }
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(im, 0, 0, w, h);
          res(c.toDataURL('image/jpeg', quality).split(',')[1]);
        } catch (e) { rej(e); } finally { cleanup(); }
      };
      im.onerror = e => { cleanup(); rej(e); };
      im.src = ev.target.result;
    };
    r2.onerror = e => { cleanup(); rej(e); };
    r2.readAsDataURL(file);
  });
}

// ── Image fade in ──────────────────────────────

function initImgFadeIn() {
  document.querySelectorAll('.img-area img, #slideshow img').forEach(img => {
    const done = () => { img.classList.add('img-loaded'); };
    if (img.complete && img.naturalWidth) done();
    else { img.addEventListener('load', done); img.addEventListener('error', done); }
  });
}

// ── Proof file preview ─────────────────────────

function previewProofFile(inputEl, imgId, pdfId, btnId) {
  const file = inputEl.files[0]; if (!file) return;
  const isPdf = file.type === 'application/pdf';
  const img = document.getElementById(imgId);
  const pdfTag = document.getElementById(pdfId);
  if (isPdf) {
    img.style.display = 'none';
    pdfTag.style.display = 'block';
    pdfTag.textContent = '📄 ' + file.name + ' — ready to upload';
  } else {
    pdfTag.style.display = 'none';
    const reader = new FileReader();
    reader.onload = e => { img.src = e.target.result; img.style.display = 'block'; };
    reader.readAsDataURL(file);
  }
  document.getElementById(btnId).style.display = 'block';
}

// ── Proof file upload ──────────────────────────

async function uploadProofFile(file, idToUse, action, extraPayload = {}) {
  console.log("Starting upload for Action:", action, "ID:", idToUse);
  const isPdf = file.type === 'application/pdf';
  let base64, mimeType, fileName;

  try {
    if (isPdf) {
      base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => { res(e.target.result.split(',')[1]); };
        r.onerror = () => rej(new Error("Failed to read PDF file"));
        r.readAsDataURL(file);
      });
      mimeType = 'application/pdf';
      fileName = `${idToUse}.pdf`;
    } else {
      base64 = await compressImage(file, 1200, 0.7);
      mimeType = 'image/jpeg';
      fileName = `${idToUse}.jpg`;
    }

    if (!base64) throw new Error("File conversion failed - base64 is empty");

    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, order_id: idToUse, fileName, mimeType, base64, ...extraPayload })
    });

    if (!resp.ok) throw new Error("Server Error: " + resp.status);
    const result = await resp.json().catch(() => ({}));
    if (result.error) throw new Error(result.error);
    return result;
  } catch (err) {
    console.error("Upload Error:", err);
    alert("Critical Error: " + err.message);
    throw err;
  }
}

// ── Debounce ───────────────────────────────────

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
