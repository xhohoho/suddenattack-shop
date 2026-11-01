// playwright-debug.js - Debug local dev server or production
// Run: node playwright-debug.js

import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'; // or 3001
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function main() {
  console.log(`🌐 Testing: ${BASE_URL}`);

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();

  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('🔴 Console:', msg.text());
  });
  page.on('pageerror', err => console.log('🔴 Page Error:', err.message));

  // Capture failed network requests
  page.on('response', async resp => {
    if (resp.status() >= 400) {
      const url = resp.url();
      const text = await resp.text().catch(() => 'could not read body');
      console.log(`🔴 ${resp.status()} ${url}: ${text.slice(0, 300)}`);
    }
  });

  try {
    // 1. Load main page
    console.log('\n📄 Loading main page...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: 'debug-01-main.png', fullPage: true });
    console.log('✅ Main page loaded');

    // 2. Test API directly
    console.log('\n🔌 Testing API endpoint...');
    const apiResp = await page.request.post(`${BASE_URL}/api/index`, {
      data: { action: 'getOrders' },
      headers: { 'Content-Type': 'application/json' }
    });
    const apiText = await apiResp.text();
    console.log(`API Status: ${apiResp.status()}`);
    console.log(`API Response: ${apiText.slice(0, 500)}`);

    // 3. Test admin login if password provided
    if (ADMIN_PASSWORD) {
      console.log('\n🔐 Testing admin login...');
      await page.click('.admin-toggle');
      await page.waitForSelector('#admin-gate:not([style*="display: none"])');
      await page.fill('#admin-pw', ADMIN_PASSWORD);
      await page.click('.admin-btn:has-text("Unlock")');
      await page.waitForSelector('#admin-content:not([style*="display: none"])');
      await page.screenshot({ path: 'debug-02-admin.png', fullPage: true });
      console.log('✅ Admin unlocked');

      // Test each tab
      const tabs = [
        { id: 'extract', label: 'Extract items' },
        { id: 'edit-shop', label: 'Edit shop' },
        { id: 'orders', label: 'Orders' },
        { id: 'manage-accounts', label: 'Accounts' },
        { id: 'slideshow', label: 'Slideshow' },
        { id: 'ticker', label: 'Ticker' },
      ];
      for (const tab of tabs) {
        console.log(`\n📋 Testing tab: ${tab.id}`);
        await page.click(`.admin-tab:has-text("${tab.label}")`);
        await page.waitForSelector(`#tab-${tab.id}:not([style*="display: none"])`, { timeout: 5000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `debug-03-${tab.id}.png`, fullPage: true });
      }
    } else {
      console.log('\n⚠️  No ADMIN_PASSWORD env var - skipping admin tests');
    }

    console.log('\n✅ Done! Check debug-*.png screenshots');
  } catch (e) {
    console.error('❌ Fatal:', e);
    await page.screenshot({ path: 'debug-error.png', fullPage: true });
  } finally {
    await browser.close();
  }
}

main().catch(console.error);