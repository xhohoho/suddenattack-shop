import fs from 'fs';
import https from 'https';

// --- CONFIG -------------------------------------------------
const OUTPUT_DIR = 'dist';                 // where the site builds
const IMG_DIR    = `${OUTPUT_DIR}/images`; // folder for cached Drive images
// -----------------------------------------------------------------

// Ensure output folders exist
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

// Read source HTML fragments
const main    = fs.readFileSync('public/main.html', 'utf8');
const items   = fs.readFileSync('public/item.html', 'utf8');
const accounts= fs.readFileSync('public/account.html', 'utf8');

// Merge fragments
const merged = main
  .replace('<!-- INJECT:ITEMS -->', items)
  .replace('<!-- INJECT:ACCOUNTS -->', accounts);

// -----------------------------------------------------------------
// Helper: download a Google‑Drive “direct link” into the local cache
// -----------------------------------------------------------------
function cacheGoogleDriveImage(url, destPath) {
  // Skip if we already cached it
  if (fs.existsSync(destPath)) return;

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, response => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', err => {
      file.close();
      reject(err);
    });
  });
}

// -----------------------------------------------------------------
// Extract all Google‑Drive image URLs from the final HTML
// -----------------------------------------------------------------
// We assume any URL that ends with “/d/…/preview” or “/uc?export=view&id=…”
// is a Drive preview image. Adjust the RegExp if your markup differs.
const driveImgPattern = /https?:\/\/(?:lh3|go\.googleusercontent\.com)\/d\/([\w-_]+)/gi;
const imageUrls = [...merged.matchAll(driveImgPattern)].map(m => m[0]);

Promise.all(
  imageUrls.map(async (url, i) => {
    // Use a deterministic filename – e.g. first 12 chars of the id + extension
    const match   = url.match(/\/d\/([\w-_]+)/);
    const fileId  = match ? match[1] : `img${i}`;
    const ext     = url.split('.').pop().split(/[?#]/)[0]; // “jpg”, “png”, etc.
    const dest    = `${IMG_DIR}/${fileId}.${ext}`;

    try {
      await cacheGoogleDriveImage(url, dest);
      console.log(`✅ Cached ${url} → ${dest}`);
    } catch (e) {
      console.error(`❌ Failed to cache ${url}:`, e.message);
    }
  })
).finally(async () => {
  // -----------------------------------------------------------------
  // Write the merged HTML (with placeholders still intact) to /dist
  // -----------------------------------------------------------------
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(`${OUTPUT_DIR}/index.html`, merged);

  // Copy static assets (audio, etc.) that aren’t Drive images
  fs.cpSync('public/audio', `${OUTPUT_DIR}/audio`, { recursive: true });

  console.log('✅ Built dist/index.html');
});