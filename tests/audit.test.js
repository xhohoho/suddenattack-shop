import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { google } from 'googleapis';

// Fake Google Sheets: starts with only an "Orders" tab (i.e. the AuditLog tab is missing).
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
process.env.SHEET_ID = 'sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: 'service_account', client_email: 't@t.iam.gserviceaccount.com', private_key: privateKey });

const tabs = ['Orders'];
const log = [];
google.sheets = () => ({
  spreadsheets: {
    get: async () => ({ data: { sheets: tabs.map(title => ({ properties: { title } })) } }),
    batchUpdate: async ({ requestBody }) => { const t = requestBody.requests[0].addSheet.properties.title; tabs.push(t); log.push(['addSheet', t]); return {}; },
    values: {
      update: async ({ range, requestBody }) => { log.push(['update', range, requestBody.values[0]]); return {}; },
      append: async ({ range, requestBody }) => {
        if (!tabs.includes(range.split('!')[0])) throw new Error(`Unable to parse range: ${range}`);
        log.push(['append', range, requestBody.values[0]]); return {};
      },
    },
  },
});

const { auditLog } = await import('../server/lib/audit.js');

test('audit log creates the missing AuditLog tab once, with a header, then appends', async () => {
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    await auditLog('admin', 'saveItems', { target: 'x' }, '1.2.3.4', 'UA');
    await auditLog('admin', 'saveItems', { target: 'y' }, '1.2.3.4', 'UA');
  } finally { console.error = orig; }
  assert.deepEqual(errors, [], 'no "Audit log failed" errors');
  assert.equal(log.filter(l => l[0] === 'addSheet').length, 1, 'tab created exactly once');
  assert.deepEqual(log.find(l => l[0] === 'update')[2], ['Time', 'Admin', 'Action', 'Details', 'IP', 'User agent']);
  const appends = log.filter(l => l[0] === 'append');
  assert.equal(appends.length, 2);
  assert.equal(appends[0][1], 'AuditLog!A1');
  assert.equal(appends[0][2][2], 'saveItems');
});
