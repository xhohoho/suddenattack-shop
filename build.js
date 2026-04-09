import fs from 'fs';

const main    = fs.readFileSync('public/main.html', 'utf8');
const items   = fs.readFileSync('public/item.html', 'utf8');
const accounts= fs.readFileSync('public/account.html', 'utf8');

const merged = main
  .replace('<!-- INJECT:ITEMS -->', items)
  .replace('<!-- INJECT:ACCOUNTS -->', accounts);

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', merged);
console.log('✅ Built dist/index.html');