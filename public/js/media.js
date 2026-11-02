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
  // 1) ask the server for a Drive upload session (server validates type + size and picks the file name)
  const init = { action: 'getDirectUploadUrl', mimeType: file.type, fileSize: file.size, folderContext, ign };
  if (folderContext === 'account' && adminToken) init._token = adminToken; // admin-only context
  const urlResult = await apiPost(init).catch(e => { throw new Error('Upload init failed: ' + e.message); });

  // 2) send the file straight to Drive
  const uploadResp = await fetch(urlResult.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file
  });
  if (!uploadResp.ok) throw new Error(`Direct upload to Drive failed: ${uploadResp.status}`);

  // 3) tell the server to verify + publish it (the signed sessionToken says which file to look for)
  const finalResult = await apiPost({ action: 'finalizeUpload', sessionToken: urlResult.sessionToken })
    .catch(e => { throw new Error('Finalize failed: ' + e.message); });
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
