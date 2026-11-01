// playwright-admin-audit.js
// Run locally: npx playwright install && node playwright-admin-audit.js
// Requires: ADMIN_PASSWORD env var or pass --password=xxx

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://suddenattack.safie.cc';
const OUT_DIR = 'playwright-audit';

async function main() {
  const password = process.env.ADMIN_PASSWORD || process.argv.find(a => a.startsWith('--password='))?.split('=')[1];
  if (!password) {
    console.error('❌ Set ADMIN_PASSWORD env var or pass --password=xxx');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();

  // Capture console errors
  page.on('console', msg => msg.type() === 'error' && console.log('🔴 Console error:', msg.text()));
  page.on('pageerror', err => console.log('🔴 Page error:', err.message));

  console.log('🌐 Opening site...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  // === ADMIN LOGIN ===
  console.log('🔐 Opening admin panel...');
  await page.click('.admin-toggle');
  await page.waitForSelector('#admin-gate:not([style*="display: none"])');

  console.log('🔑 Entering password...');
  await page.fill('#admin-pw', password);
  await page.click('.admin-btn:has-text("Unlock")');
  await page.waitForSelector('#admin-content:not([style*="display: none"])');
  await page.screenshot({ path: path.join(OUT_DIR, '01-admin-unlocked.png'), fullPage: true });

  // === TAB AUDIT ===
  const tabs = [
    { id: 'extract', name: 'Extract Items', btn: 'admin-tab:has-text("Extract items")' },
    { id: 'edit-shop', name: 'Edit Shop', btn: 'admin-tab:has-text("Edit shop")' },
    { id: 'orders', name: 'Orders', btn: 'admin-tab:has-text("Orders")' },
    { id: 'manage-accounts', name: 'Manage Accounts', btn: 'admin-tab:has-text("Accounts")' },
    { id: 'slideshow', name: 'Slideshow', btn: 'admin-tab:has-text("Slideshow")' },
    { id: 'ticker', name: 'Ticker', btn: 'admin-tab:has-text("Ticker")' },
  ];

  for (const tab of tabs) {
    console.log(`\n📋 Auditing tab: ${tab.name}`);
    await page.click(tab.btn);
    await page.waitForSelector(`#tab-${tab.id}:not([style*="display: none"])`, { timeout: 5000 });
    await page.waitForTimeout(500); // let animations settle

    // Screenshot tab
    await page.screenshot({ path: path.join(OUT_DIR, `02-tab-${tab.id}.png`), fullPage: true });

    // Analyze tab-specific elements
    await auditTab(page, tab.id, OUT_DIR);
  }

  // === CUSTOMER-FACING PAGES ===
  console.log('\n🛍️ Auditing customer-facing tabs...');
  await page.click('.main-tab:has-text("Game Items")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '03-customer-items.png'), fullPage: true });

  await page.click('.main-tab:has-text("Accounts")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '04-customer-accounts.png'), fullPage: true });

  // Test "Sell Your Account" modal
  await page.click('button:has-text("List account")');
  await page.waitForSelector('#sell-modal:not([style*="display: none"])');
  await page.screenshot({ path: path.join(OUT_DIR, '05-sell-account-modal.png'), fullPage: true });

  console.log(`\n✅ Done! Screenshots saved to ${OUT_DIR}/`);
  console.log('📋 Open them to review UX/UI issues.');

  await browser.close();
}

async function auditTab(page, tabId, outDir) {
  switch (tabId) {
    case 'extract':
      // Check shop image slots
      const slots = await page.$$('#sslot-0, #sslot-1');
      console.log(`   Shop image slots: ${slots.length}`);
      // Check extract button state
      const extractBtn = await page.$('#extract-btn');
      const disabled = await extractBtn?.getAttribute('disabled');
      console.log(`   Extract button disabled: ${!!disabled}`);
      break;

    case 'edit-shop':
      // Check if table loads
      const rows = await page.$$('#shop-editor-tbody tr');
      console.log(`   Shop editor rows: ${rows.length}`);
      break;

    case 'orders':
      // Wait for orders to load
      await page.waitForSelector('#order-mgmt-list .order-row, #order-mgmt-list .empty-feed', { timeout: 10000 });
      const orderRows = await page.$$('#order-mgmt-list .order-row');
      console.log(`   Order rows: ${orderRows.length}`);
      break;

    case 'manage-accounts':
      // Check account list
      const accRows = await page.$$('#acc-manage-list .acc-row, #acc-manage-list .empty');
      console.log(`   Account rows: ${accRows.length}`);
      // Check media slots
      const mediaSlots = await page.$$('#img-slots .img-slot');
      console.log(`   Media slots: ${mediaSlots.length}`);
      break;

    case 'slideshow':
      const slideSlots = await page.$$('#ss-slot-0, #ss-slot-1');
      console.log(`   Slideshow slots: ${slideSlots.length}`);
      break;

    case 'ticker':
      const tickerText = await page.inputValue('#ticker-text-input');
      console.log(`   Current ticker: "${tickerText.slice(0, 50)}..."`);
      break;
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});