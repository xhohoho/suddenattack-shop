// ── Media helpers ──────────────────────────────

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
