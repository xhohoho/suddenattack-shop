// ── Media helpers ──────────────────────────────

const _videoBlobCache = {};
const _blobRefCount = {};
const _blobCacheOrder = [];
const _BLOB_CACHE_MAX = 20;

function _tryRevoke(fileId) {
  const url = _videoBlobCache[fileId];
  if (!url) return;
  if ((_blobRefCount[url] || 0) > 0) return;
  URL.revokeObjectURL(url);
  delete _videoBlobCache[fileId];
  delete _blobRefCount[url];
}

function _blobRetain(url) {
  if (!url || !url.startsWith('blob:')) return;
  _blobRefCount[url] = (_blobRefCount[url] || 0) + 1;
}

function _blobRelease(url) {
  if (!url || !url.startsWith('blob:')) return;
  _blobRefCount[url] = Math.max(0, (_blobRefCount[url] || 1) - 1);
}

function getVideoDriveUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

async function getVideoBlobUrl(fileId) {
  return getVideoDriveUrl(fileId);
}

function isVideoUrl(url) {
  if (!url) return false;
  if (/\.gif(\?|$)/i.test(url)) return false;
  if (url.includes('drive.google.com')) return true;
  return /\.(mp4|mov|webm|avi|mkv)(\?|$)/i.test(url);
}

// ── Direct-to-Drive upload ─────────────────────
// Bypasses Vercel's 4.5MB body limit for large files (videos, GIFs).
// Flow: getDirectUploadUrl → PUT blob to Drive → finalizeUpload

async function uploadDirectToDrive(file, fileName, folderContext, ign) {
  const urlResp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getDirectUploadUrl', fileName, mimeType: file.type, folderContext, ign })
  });
  const urlResult = await urlResp.json();
  if (urlResult.error) throw new Error('Upload init failed: ' + urlResult.error);

  const uploadResp = await fetch(urlResult.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file
  });
  if (!uploadResp.ok) throw new Error(`Direct upload to Drive failed: ${uploadResp.status}`);

  const finalResp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'finalizeUpload', fileName, mimeType: file.type, folderId: urlResult.folderId })
  });
  const finalResult = await finalResp.json();
  if (finalResult.error) throw new Error('Finalize failed: ' + finalResult.error);
  return finalResult.url;
}

// ── Rank helpers ───────────────────────────────

const RANK_ICONS = { bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💎', diamond: '💎', master: '👑', grandmaster: '👑', challenger: '🏆', default: '🎮' };

function getRankIcon(rank) {
  if (!rank) return RANK_ICONS.default;
  const r = rank.toLowerCase();
  for (const [k, v] of Object.entries(RANK_ICONS)) { if (r.includes(k)) return v; }
  return RANK_ICONS.default;
}

function getRankColor(rank) {
  if (!rank) return 'var(--text2)';
  const r = rank.toLowerCase();
  if (r.includes('challenger') || r.includes('grandmaster')) return '#e8b84b';
  if (r.includes('master')) return '#9b7fe8';
  if (r.includes('diamond')) return '#4a9eff';
  if (r.includes('platinum')) return '#2ecc8a';
  if (r.includes('gold')) return '#f0c040';
  if (r.includes('silver')) return '#9099a8';
  if (r.includes('bronze')) return '#cd7f32';
  return 'var(--text2)';
}

// ── Lightbox ───────────────────────────────────

function openLightbox(url, type = 'img') {
  const img = document.getElementById('lightbox-img'), vid = document.getElementById('lightbox-vid'), lb = document.getElementById('lightbox');
  if (type === 'video' || url.includes('/preview')) {
    img.style.display = 'none'; vid.style.display = 'none';
    lb.querySelector('iframe')?.remove();
    const ifr = document.createElement('iframe'); ifr.src = url; ifr.style.cssText = 'width:90vw;height:80vh;border:none'; ifr.setAttribute('allowfullscreen', 'true'); lb.appendChild(ifr);
  } else {
    lb.querySelector('iframe')?.remove();
    img.src = url; img.style.display = 'block'; vid.style.display = 'none';
  }
  lb.classList.add('open');
}

function closeLightbox() {
  const v = document.getElementById('lightbox-vid'); v.pause(); v.src = '';
  document.getElementById('lightbox').querySelector('iframe')?.remove();
  document.getElementById('lightbox').classList.remove('open');
}
