import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const OUTPUT_DIR = 'dist';

// Start from a clean output folder so stale files from older builds never ship.
fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Read source HTML fragments
const main     = fs.readFileSync('public/main.html', 'utf8');
const items    = fs.readFileSync('public/item.html', 'utf8');
const accounts = fs.readFileSync('public/account.html', 'utf8');

// Turnstile site key injection (for seller form CAPTCHA)
const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || '';

// Merge fragments
let html = main
  .replace('<!-- INJECT:ITEMS -->', items)
  .replace('<!-- INJECT:ACCOUNTS -->', accounts);

// ── Cache busting ────────────────────────────────────────────────────────────
// /js and /css files have fixed names, so browsers can keep an old copy for a long time.
// Appending ?v=<hash of the file's content> makes every changed file a brand-new URL,
// and an unchanged file keeps its URL (so it stays cached). Fixes "half old / half new" sites.
const hashes = [];
html = html.replace(/(src|href)="(\.?\/?(?:js|css)\/[^"?#]+)"/g, (full, attr, url) => {
  const file = path.join('public', url.replace(/^\.?\//, ''));
  if (!fs.existsSync(file)) return full;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  hashes.push(hash);
  return `${attr}="${url}?v=${hash}"`;
});

// The Turnstile site key is public by design; the page needs it BEFORE config.js loads, so it goes into the HTML.
html = html.replaceAll('%%TURNSTILE_SITE_KEY%%', turnstileSiteKey.replace(/[^\w-]/g, ''));
fs.writeFileSync(`${OUTPUT_DIR}/index.html`, html);

// ── Static assets ────────────────────────────────────────────────────────────
// Skip editor backups / scratch files so they are never publicly downloadable.
const SKIP = /\.(bak|orig|tmp|map)$|backup|\.emoji-/i;
const copyDir = dir => {
  if (!fs.existsSync(`public/${dir}`)) return;
  fs.cpSync(`public/${dir}`, `${OUTPUT_DIR}/${dir}`, {
    recursive: true,
    filter: src => !SKIP.test(path.basename(src)),
  });
};
['audio', 'css', 'js'].forEach(copyDir);

// Inject Turnstile site key into copied config.js
const configPath = `${OUTPUT_DIR}/js/config.js`;
if (fs.existsSync(configPath)) {
  let configJs = fs.readFileSync(configPath, 'utf8');
  configJs = configJs.replace("const TURNSTILE_SITE_KEY = '';", `const TURNSTILE_SITE_KEY = '${turnstileSiteKey.replace(/'/g, "\\'")}';`);
  fs.writeFileSync(configPath, configJs);
}

// Tiny version stamp so you can check which build is live: https://yoursite/version.json
const build = crypto.createHash('sha1').update(hashes.join('')).digest('hex').slice(0, 10);
fs.writeFileSync(`${OUTPUT_DIR}/version.json`, JSON.stringify({ build, builtAt: new Date().toISOString() }));

console.log(`Built dist/index.html (build ${build})`);
