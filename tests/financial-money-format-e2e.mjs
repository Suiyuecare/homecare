import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { insert, business } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

// Private author draft; install after root freezes v0.38 formatter-only scope.
// One explicit real Chromium run, synthetic memory SQLite and a random port.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.QA_OUTPUT_DIR || path.join(root, 'outputs/software/financial-money-format-qa/new-browser-work'));
assert(!existsSync(path.join(output, 'e2e.json')), 'Preserve the prior attempt before an explicit new run');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const collectSources = async () => {
  const names = ['tests/financial-money-format-e2e.mjs', 'tests/attachment-fixtures.mjs'];
  const walk = async dir => { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else names.push(file); } };
  for (const dir of ['public', 'src']) await walk(dir);
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const app = createApp({ dbPath: ':memory:', host: '127.0.0.1', port: 0 });
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const month = today.slice(0, 7), year = Number(month.slice(0, 4));
const relativeMonth = delta => new Date(Date.UTC(year, Number(month.slice(5, 7)) - 1 + delta, 1)).toISOString().slice(0, 7);
const otherMonth = relativeMonth(1), emptyMonth = relativeMonth(-3);
const MAX_CENTS = Number.MAX_SAFE_INTEGER, MAX_DISPLAY = '$90,071,992,547,409.91';
const password = 'synthetic-financial-money-format-password';
const checks = [], screenshots = [], readSegments = [], writeSegments = [], apiChecks = [], uiQueries = [], rejectedBodies = [], invalidations = [], downloads = [], blobDownloads = [];
const pageErrors = [], consoleErrors = [], failedResponses = [], contexts = [], importedFixtures = [], formatterChecks = [], serverDTOs = [], csvChecks = [];
let browser, base, orgId, lastPage, sourceHashesBefore;
const confirmedErrorMessage = '未取得完整且一致的試算報表，請重新讀取。';
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const counts = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, ...Object.fromEntries(['audit', 'records', 'record_versions', 'idempotency'].map(table => [table, app.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n])) });
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const triggers = () => app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
const readOnly = async (label, work) => {
  const before = counts(), raw = rawState(), definitions = triggers(); assert.equal(Object.keys(raw).length, 11); assert.equal(definitions.length, 6);
  const value = await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); assert.deepEqual(triggers(), definitions, label);
  readSegments.push({ label, before, after: counts(), all11TablesUnchanged: true, all6TriggersUnchanged: true, rawBeforeSha256: sha(JSON.stringify(raw)), rawAfterSha256: sha(JSON.stringify(rawState())) }); return value;
};
const written = async (label, work) => { const before = counts(); const result = await work(); writeSegments.push({ label, phase: 'pre-read-synthetic-fixture-or-real-login-only', before, after: counts() }); return result; };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('download', download => downloads.push(download.suggestedFilename()));
};
const body = page => page.locator('.report-body');
const selection = page => page.getByLabel('報表類型', { exact: true });
const monthControl = page => page.getByLabel('報表月份', { exact: true });
const csvButton = page => page.getByRole('button', { name: '下載 CSV', exact: true }).first();
const reloadButton = page => page.getByRole('button', { name: '重新查詢', exact: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const loadReport = async page => { lastPage = page; await page.goto(`${base}/#/reports`); await page.getByRole('heading', { name: '報表中心', exact: true, level: 1 }).waitFor(); await selection(page).waitFor(); };
const matches = (response, kind, selectedMonth) => { const url = new URL(response.url()); return response.request().method() === 'GET' && url.pathname === `/api/reports/${kind}` && url.searchParams.get('month') === selectedMonth; };
const display = async (page, kind, selectedMonth, action) => {
  const waiting = page.waitForResponse(response => matches(response, kind, selectedMonth)); await action(); const response = await waiting; assert.equal(response.status(), 200); const result = await response.json();
  await body(page).getByRole('heading', { name: result.title, exact: true, level: 2 }).waitFor(); await body(page).getByText(`${selectedMonth} · ${result.rows.length} 筆`, { exact: true }).waitFor();
  assert.equal(await body(page).locator('.error-state').count(), 0); assert(await csvButton(page).isEnabled());
  if (result.rows.length) assert.equal(await body(page).locator('table').first().locator('tbody tr').count(), result.rows.length);
  else await body(page).getByText('此月份沒有符合條件的資料。', { exact: true }).waitFor();
  uiQueries.push({ role: await page.locator('.role-tag').textContent(), kind, month: selectedMonth, status: response.status(), rows: result.rows.length, totals: result.totals }); return result;
};
const changeMonth = async (page, value) => { await monthControl(page).fill(value); await monthControl(page).press('Tab'); };
const selectReport = (page, kind, selectedMonth = month) => display(page, kind, selectedMonth, () => selection(page).selectOption(kind));
const inspectLayout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.outerHTML)), []);
  for (const table of await body(page).locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => { if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 }); await inspectLayout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delayRoute = async (page, pattern) => {
  const arrived = deferred(), release = deferred(), handled = deferred();
  await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } });
  return { arrived, release, handled, async finish() { release.resolve(); await handled.promise; await page.unroute(pattern); } };
};
const rejectBody = async (page, kind, label, mutate, { screenshot } = {}) => {
  const pattern = new RegExp(`/api/reports/${kind}\\?`); let supplied;
  const n = downloads.length; let csvRequests = 0;
  const countRequest = request => { if (new URL(request.url()).pathname.endsWith('.csv')) csvRequests++; }; page.on('request', countRequest);
  await page.route(pattern, async route => { const response = await route.fetch(); assert.equal(response.status(), 200); const good = await response.json(); supplied = mutate(structuredClone(good)); await route.fulfill({ response, json: supplied }); });
  try {
    const waiting = page.waitForResponse(response => matches(response, kind, awaitMonth));
    // Both report kind and original input month must survive every invalid 2xx.
    await reloadButton(page).click(); const response = await waiting; assert.equal(response.status(), 200);
    await body(page).locator('.error-state').waitFor(); await body(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor();
    await body(page).getByText(confirmedErrorMessage, { exact: true }).waitFor();
    assert.equal(await selection(page).inputValue(), kind); assert.equal(await monthControl(page).inputValue(), awaitMonth);
    assert.equal(await body(page).locator('table').count(), 0); assert.equal(await body(page).getByText('此月份沒有符合條件的資料。', { exact: true }).count(), 0);
    assert(await csvButton(page).isDisabled()); await csvButton(page).evaluate(node => node.click()); await settle(page);
    assert.equal(csvRequests, 0); assert.equal(downloads.length, n);
    rejectedBodies.push({ kind, label, httpStatus: response.status(), bodySha256: sha(JSON.stringify(supplied)), monthPreserved: true, typePreserved: true, inlineError: true, noFalseZeroTable: true, csvDisabled: true, csvRequests: 0 });
    if (screenshot) await shot(page, screenshot);
  } finally { page.off('request', countRequest); await page.unroute(pattern); }
};
let awaitMonth = month;

// Fixed independently specified decimal text, without Number division by100.
const exactMoneyText = cents => {
  assert(Number.isSafeInteger(cents)); const negative = cents < 0;
  const digits = String(Math.abs(cents)).padStart(3, '0'), fraction = digits.slice(-2);
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${whole}.${fraction}`;
};
const assertFinancialMoney = async (page, kind, result) => {
  const table = body(page).locator('table').first();
  const keys = result.columns.map(column => column.key);
  for (const [i, row] of result.rows.entries()) for (const key of keys.filter(name => /cents$/i.test(name))) {
    const expected = exactMoneyText(row[key]); assert.equal(await table.locator('tbody tr').nth(i).locator('td').nth(keys.indexOf(key)).textContent(), expected);
  }
  const totalKeys = Object.keys(result.totals); assert.equal(await body(page).locator('table').last().locator('tbody tr').first().locator('td').nth(totalKeys.indexOf('amountCents')).textContent(), exactMoneyText(result.totals.amountCents));
  serverDTOs.push({ kind, selectedMonth: await monthControl(page).inputValue(), observedApiRows: result.rows, observedApiTotals: result.totals, formattedRowsAndTotalsMatchIndependentDecimalText: true, backendComputationPrecisionClaimed: false });
};

await mkdir(output, { recursive: true });
try {
  sourceHashesBefore = await collectSources(); const initialCounts = counts();
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const setupClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(setupClient);
  const setup = await written('normal-admin-setup', async () => { const response = await setupClient.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成金額格式管理員', email: 'money-format-admin@example.test', password, organizationName: '合成金額格式甲機構' } }); assert.equal(response.status(), 201); return response.json(); });
  orgId = setup.organizations[0].id; const setupActor = { client: setupClient, auth: setup };
  const request = async (method, route, data, expected = 200, actor = setupActor, org = orgId) => {
    const response = await actor.client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': actor.auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const result = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(result)}`); apiChecks.push({ role: actor.auth.user.role, method, route, requestedOrganization: org, status: response.status(), code: result.error?.code || null }); return result;
  };
  const post = async (entity, data, org) => (await request('POST', entity, data, 201, setupActor, org)).item;
  const users = { admin: { email: setup.user.email } };
  let employee, otherEmployee, caseItem, normalRecord, caseAttachment, certAttachment, foreignOrg;
  await written('normal-five-small-cent-prices-approval-frozen-current-change-and-two-BLOBs', async () => {
    employee = await post('employees', { name: '合成原凍結時薪員工', employeeNo: 'MF-E-9007199254740992', role: 'caregiver', hourlyRateCents: 21000 });
    otherEmployee = await post('employees', { name: '合成另一員工', employeeNo: 'MF-OTHER', role: 'caregiver', hourlyRateCents: 21000 });
    for (const role of ['finance', 'supervisor', 'caregiver']) users[role] = await post('users', { name: '合成金額格式' + role, email: `money-format-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    caseItem = await post('cases', { name: '合成金額格式個案', caseNo: 'MF-C-9007199254740992' });
    const services = [];
    for (const cents of [0, 1, 99, 100, 101]) services.push(await post('service-items', { code: 'MF-S-' + cents, name: '合成保存單價' + cents + '分', minutes: 60, unitPriceCents: cents }));
    const plan = await post('care-plans', { caseId: caseItem.id, validFrom: `${year - 1}-01-01`, validTo: `${year + 1}-12-31`, status: 'active', services: services.map(item => ({ serviceItemId: item.id, quantity: 100 })) });
    const shift = await post('shifts', { caseId: caseItem.id, employeeId: employee.id, carePlanId: plan.id, date: `${otherMonth}-01`, startTime: '09:00', endTime: '10:00', services: services.map(item => ({ serviceItemId: item.id, quantity: 1 })) });
    const submitted = await post('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd: '09:45', services: shift.services, status: 'submitted', note: '合成正常核閱0/1/99/100/101分服務' });
    normalRecord = (await request('POST', `service-records/${submitted.id}/review`, { version: submitted.version, decision: 'approved', reviewNote: '合成保存核閱價格與時薪' })).item;
    const fees = await request('GET', `reports/fees?month=${otherMonth}`), payroll = await request('GET', `reports/payroll?month=${otherMonth}`); assert.deepEqual(fees.totals, { count: 5, amountCents: 301 }); assert.deepEqual(payroll.totals, { count: 1, amountCents: 15750, minutes: 45 });
    await request('PATCH', `service-items/${services[1].id}`, { version: services[1].version, unitPriceCents: 99999 });
    employee = (await request('PATCH', `employees/${employee.id}`, { version: employee.version, hourlyRateCents: 88888 })).item;
    assert.deepEqual(await request('GET', `reports/fees?month=${otherMonth}`), fees); assert.deepEqual(await request('GET', `reports/payroll?month=${otherMonth}`), payroll);
    caseAttachment = await post('case-attachments/upload', { caseId: caseItem.id, title: '合成金額格式只讀附件', category: 'other', ...filePayload(PDF_BYTES, '合成金額格式.pdf', 'application/pdf') });
    const cert = await post('employee-certifications', { employeeId: employee.id, name: '合成金額格式證照', issuedOn: `${year}-01-01` });
    certAttachment = await post('certification-attachments/upload', { certificationId: cert.id, title: '合成金額格式證照附件', ...filePayload(PNG_BYTES, '合成金額格式.png', 'image/png') });
    foreignOrg = await post('organizations', { name: '合成金額格式乙機構' });
  });
  await written('explicit-INSERT-only-historical-MAX-cents-frozen-snapshot-exception', async () => {
    const data = { ...structuredClone(business(normalRecord)), date: `${month}-01`, note: '合成歷史匯入最大安全整數分；非正常核閱計價契約證據' };
    data.billingSnapshot.items = [{ ...data.billingSnapshot.items[0], code: 'MF-MAX', name: '合成歷史保存最大分金額', quantity: 1, unitPriceCents: 1000000000, amountCents: MAX_CENTS }];
    data.billingSnapshot.employee = { ...data.billingSnapshot.employee, hourlyRateCents: 60 }; data.billingSnapshot.serviceMinutes = MAX_CENTS;
    const item = insert(app.db, orgId, 'service-records', data);
    assert.deepEqual(JSON.parse(app.db.prepare('SELECT snapshot FROM record_versions WHERE record_id=? AND version=1').get(item.id).snapshot), item);
    importedFixtures.push({ id: item.id, date: item.date, version: 1, feeAmountCents: MAX_CENTS, minutes: MAX_CENTS, hourlyRateCents: 60, quantity: 1, unitPriceCents: 1000000000, insertOnly: true, normalPriceProductClaimed: false, normalServiceDurationClaimed: false });
    insert(app.db, foreignOrg.id, 'service-records', { ...structuredClone(data), note: '合成外機構歷史匯入' });
  });
  const actors = {};
  for (const role of ['admin', 'finance', 'supervisor', 'caregiver']) {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(client);
    const auth = await written(`normal-${role}-login-before-read-phase`, async () => { const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: users[role].email, password } }); assert.equal(response.status(), 200); return response.json(); });
    const page = await client.newPage(); observe(page); actors[role] = { client, auth, page };
  }
  const rawReadBaseline = rawState(), readPhaseCounts = counts(), triggerBaseline = triggers();
  const page = actors.admin.page;
  await readOnly('real-current-MAX-fees-row-total-and-payroll-observed-DTO-exact-decimal', async () => {
    for (const role of ['admin', 'finance']) {
      const p = actors[role].page; await loadReport(p); const fees = await selectReport(p, 'fees'); assert.equal(fees.rows.length, 1); assert.equal(fees.rows[0].amountCents, MAX_CENTS); assert.equal(fees.totals.amountCents, MAX_CENTS); await assertFinancialMoney(p, 'fees', fees);
      assert.equal(await body(p).getByText(MAX_DISPLAY, { exact: true }).count(), 2);
      const payroll = await selectReport(p, 'payroll'); assert.equal(payroll.rows.length, 1); assert(Number.isSafeInteger(payroll.rows[0].amountCents)); await assertFinancialMoney(p, 'payroll', payroll); assert.equal(payroll.rows[0].employeeNo, 'MF-E-9007199254740992');
      await body(p).getByText('試算，未核定規則', { exact: true }).waitFor(); await p.getByText('費用與薪資僅供試算', { exact: true }).waitFor();
    }
    await selectReport(page, 'fees'); await shot(page, 'money-MAX-fees-desktop.png'); await shot(actors.finance.page, 'money-payroll-observed-DTO-desktop.png');
  }); mark('費用MAX_SAFE_INTEGER分的列與合計精確.91；薪資按實際DTO逐格格式化，不宣稱前段薪資運算精度');

  await readOnly('normal-small-cent-values-frozen-prices-and-empty-month', async () => {
    await selectReport(page, 'fees'); const fees = await display(page, 'fees', otherMonth, () => changeMonth(page, otherMonth)); assert.deepEqual(fees.rows.map(r => r.amountCents), [0, 1, 99, 100, 101]); assert.deepEqual(fees.totals, { count: 5, amountCents: 301 }); await assertFinancialMoney(page, 'fees', fees); await shot(page, 'money-small-cents-desktop.png');
    const payroll = await selectReport(page, 'payroll', otherMonth); assert.equal(payroll.rows[0].hourlyRateCents, 21000); assert.equal(payroll.totals.amountCents, 15750); await assertFinancialMoney(page, 'payroll', payroll);
    const empty = await display(page, 'payroll', emptyMonth, () => changeMonth(page, emptyMonth)); assert.equal(empty.rows.length, 0); assert.equal(empty.totals.amountCents, 0); await assertFinancialMoney(page, 'payroll', empty); assert(await csvButton(page).isEnabled());
    await display(page, 'payroll', month, () => changeMonth(page, month));
  }); mark('正常核閱0/1/99/100/101分與3.01元合計精確，時薪快照及合法空月$0.00保持');

  await readOnly('browser-import-primitive-boundaries-negative-values-and-exact-old-fallback', async () => {
    const results = await page.evaluate(async () => {
      const { formatMoney } = await import('/ui.js');
      const old = cents => new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 2 }).format(Number(cents || 0) / 100);
      const exactCases = [[0, '$0.00'], [1, '$0.01'], [99, '$0.99'], [100, '$1.00'], [101, '$1.01'], [-1, '-$0.01'], [-99, '-$0.99'], [-100, '-$1.00'], [-101, '-$1.01'], [Number.MAX_SAFE_INTEGER, '$90,071,992,547,409.91'], [Number.MIN_SAFE_INTEGER, '-$90,071,992,547,409.91'], [-0, '$0.00']];
      const exact = exactCases.map(([input, expected]) => ({ label: Object.is(input, -0) ? '-0' : String(input), expected, actual: formatMoney(input) }));
      const fallbackCases = [['numeric-string', '9007199254740991'], ['decimal-string', '123.45'], ['null', null], ['undefined', undefined], ['true', true], ['false', false], ['NaN', NaN], ['Infinity', Infinity], ['negative-Infinity', -Infinity], ['noninteger', 1.5], ['unsafe-positive', Number.MAX_SAFE_INTEGER + 1], ['unsafe-negative', Number.MIN_SAFE_INTEGER - 1], ['MAX-bigint', 9007199254740991n], ['negative-bigint', -9007199254740991n], ['zero-bigint', 0n], ['boxed-number', new Number(101)], ['valueOf-object', { valueOf: () => 101 }]];
      const fallback = fallbackCases.map(([label, input]) => ({ label, expected: old(input), actual: formatMoney(input) }));
      return { exact, fallback };
    });
    for (const item of [...results.exact, ...results.fallback]) assert.equal(item.actual, item.expected, item.label);
    formatterChecks.push(...results.exact.map(item => ({ ...item, contract: 'primitive-safeinteger-fixed-independent-decimal-text' })), ...results.fallback.map(item => ({ ...item, contract: 'exact-previous-coercion-fallback' })));
  }); mark('真瀏覽器import核對正負MAX/MIN、小額與-0；bigint/數字字串/非整數/非安全值保留舊Intl/coercion行為');

  await readOnly('037-malformed-2xx-failclosed-retry-and-no-export-regression', async () => {
    await selectReport(page, 'fees');
    for (const [label, mutate] of [['null', () => null], ['numeric-string', r => { r.rows[0].amountCents = String(MAX_CENTS); return r; }], ['unsafe-amount', r => { r.rows[0].amountCents = MAX_CENTS + 1; r.totals.amountCents = MAX_CENTS + 1; return r; }]]) await rejectBody(page, 'fees', label, mutate, label === 'null' ? { screenshot: 'money-unconfirmed-response-desktop.png' } : {});
    const result = await display(page, 'fees', month, () => body(page).getByRole('button', { name: '重新讀取', exact: true }).click()); await assertFinancialMoney(page, 'fees', result); assert(await csvButton(page).isEnabled());
  }); mark('0.37非法2xx/字串/非安全金額仍inline拒絕禁CSV，重新讀取真回應後精確恢復');

  await readOnly('fresh-CSV-byte-identical-endpoint-and-raw-cent-value-not-yuan', async () => {
    for (const [role, kind] of [['admin', 'fees'], ['finance', 'payroll']]) {
      const actor = actors[role]; await selectReport(actor.page, kind); const response = await actor.client.request.get(`${base}/api/reports/${kind}.csv?month=${month}&spanMode=calendar-two-day-v1`, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), 200); const expected = await response.body(); assert.match(response.headers()['content-type'], /^text\/csv/); assert.deepEqual([...expected.subarray(0, 3)], [239, 187, 191]); assert(expected.toString().includes('\r\n')); assert(expected.toString().includes('未核定規則'));
      const dto = await request('GET', `reports/${kind}?month=${month}&spanMode=calendar-two-day-v1`, undefined, 200, actor); assert(expected.toString().includes('"' + dto.rows[0].amountCents + '"')); assert(!expected.toString().includes(MAX_DISPLAY));
      const waiting = actor.page.waitForEvent('download'); await csvButton(actor.page).click(); const download = await waiting; assert.equal(download.suggestedFilename(), `歲悅-${kind}-${month}.csv`); const filename = `synthetic-${kind}-${month}.csv`; await download.saveAs(path.join(output, filename)); assert.deepEqual(await readFile(path.join(output, filename)), expected);
      csvChecks.push({ kind, filename, bytes: expected.length, sha256: sha(expected), matchesFreshEndpoint: true, rawAmountCents: dto.rows[0].amountCents, currencyYuanInserted: false, screenSnapshotConsistencyClaimed: false });
    }
  }); mark('真CSV逐位元等於fresh伺服器輸出，保留原始分值/BOM/CRLF與註記；未改成畫面元或快取資料');

  await readOnly('pending-JSON-month-and-kind-real-abort-exact-money-new-body-wins', async () => {
    await selectReport(page, 'fees'); const pattern = `**/api/reports/fees?month=${month}&spanMode=calendar-two-day-v1`, slow = await delayRoute(page, pattern);
    try { await reloadButton(page).click(); await slow.arrived.promise; assert(await csvButton(page).isDisabled());
      const aborted = page.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname === '/api/reports/fees' && new URL(r.url()).searchParams.get('month') === month, timeout: 10000 });
      const newer = await display(page, 'fees', otherMonth, () => changeMonth(page, otherMonth)); assert.match((await aborted).failure().errorText, /ABORTED|FAILED|cancel/i); await slow.finish(); await settle(page); await assertFinancialMoney(page, 'fees', newer);
      await display(page, 'fees', month, () => changeMonth(page, month));
    } finally { await slow.finish(); }
    const slowKind = await delayRoute(page, pattern);
    try { await reloadButton(page).click(); await slowKind.arrived.promise; const aborted = page.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname === '/api/reports/fees', timeout: 10000 });
      const newer = await selectReport(page, 'payroll'); assert.match((await aborted).failure().errorText, /ABORTED|FAILED|cancel/i); await slowKind.finish(); await settle(page); await assertFinancialMoney(page, 'payroll', newer);
    } finally { await slowKind.finish(); }
  }); mark('月份與類型更換觸發真Abort，晚到MAX舊JSON不覆蓋新資料，確認後的元格式保持精確');

  await readOnly('pending-CSV-month-change-real-abort-no-late-download', async () => {
    await selectReport(page, 'fees'); const pattern = '**/api/reports/fees.csv?*', slow = await delayRoute(page, pattern), n = downloads.length;
    try { await csvButton(page).click(); await slow.arrived.promise; assert(await csvButton(page).isDisabled()); const aborted = page.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname === '/api/reports/fees.csv', timeout: 10000 });
      const newer = await display(page, 'fees', otherMonth, () => changeMonth(page, otherMonth)); assert.match((await aborted).failure().errorText, /ABORTED|FAILED|cancel/i); await slow.finish(); await settle(page); assert.equal(downloads.length, n); await assertFinancialMoney(page, 'fees', newer); await display(page, 'fees', month, () => changeMonth(page, month));
    } finally { await slow.finish(); }
  }); mark('CSV待回換月真Abort且不晚下載；新月確認與逐格金額保持');

  await readOnly('four-roles-two-organizations-and-existing-identity-guards', async () => {
    await loadReport(actors.supervisor.page); assert.equal(await selection(actors.supervisor.page).locator('option[value="fees"],option[value="payroll"]').count(), 0);
    for (const actor of [actors.supervisor, actors.caregiver]) for (const kind of ['fees', 'payroll']) for (const suffix of ['', '.csv']) { const response = await request('GET', `reports/${kind}${suffix}?month=invalid`, undefined, 403, actor); assert.equal(response.error.code, 'ROLE_FORBIDDEN'); }
    await request('GET', `reports/fees?month=${month}`, undefined, 403, actors.finance, foreignOrg.id); const fee = await request('GET', `reports/fees?month=${month}`, undefined, 200, actors.admin); assert.equal(fee.rows.length, 1);
    await actors.caregiver.page.goto(`${base}/#/reports`); lastPage = actors.caregiver.page; await actors.caregiver.page.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor();
    for (const mode of ['role', 'staleRead']) {
      await loadReport(page); await selectReport(page, 'fees'); const pattern = `**/api/reports/fees?month=${month}&spanMode=calendar-two-day-v1`, slow = await delayRoute(page, pattern), n = downloads.length;
      try { await reloadButton(page).click(); await slow.arrived.promise; await page.evaluate(async mode => { const { getContext, setContext } = await import('/ui.js'); const c = structuredClone(getContext()); if (mode === 'role') c.organizations.find(o => o.id === c.organizationId).role = 'supervisor'; setContext(c, c.organizationId); }, mode); await slow.finish(); await settle(page); assert.equal(await body(page).getByRole('heading', { name: '費用試算（未核定規則）', exact: true }).count(), 0); assert.equal(await body(page).locator('.error-state').count(), 0); assert.equal(downloads.length, n); invalidations.push({ pending: true, mode, noLateTableOrErrorOrDownload: true, clientFixture: true });
      } finally { await slow.finish(); }
      await page.reload(); await page.waitForLoadState('networkidle');
    }
  }); mark('四角色/兩機構與原錯誤次序保持，身份/同identity新context讓待回讀取失效，不冒稱server撤權');

  await readOnly('390px-long-currency-focus-own-horizontal-scroll-and-error', async () => {
    const p = actors.finance.page; await p.setViewportSize({ width: 390, height: 844 }); await selectReport(p, 'fees'); await monthControl(p).focus(); assert(await monthControl(p).evaluate(n => n === document.activeElement));
    const table = body(p).locator('.table-scroll').first(); assert(await table.evaluate(n => n.scrollWidth > n.clientWidth)); await table.evaluate(n => { n.scrollIntoView({ block: 'start' }); n.scrollLeft = n.scrollWidth; }); assert(await table.evaluate(n => n.scrollLeft > 0)); await body(p).getByText(MAX_DISPLAY, { exact: true }).last().scrollIntoViewIfNeeded(); await shot(p, 'money-MAX-fees-mobile.png');
    await rejectBody(p, 'fees', 'mobile-null', () => null, { screenshot: 'money-unconfirmed-response-mobile.png' }); await display(p, 'fees', month, () => body(p).getByRole('button', { name: '重新讀取', exact: true }).click()); await p.setViewportSize({ width: 1440, height: 1050 });
  }); mark('390px超長金額於表內橫捲、頁面無溢出/真焦點，錯誤回應仍有inline重試與停用CSV');

  await readOnly('unchanged-sibling-employee-advanced-report', async () => {
    await loadReport(page); await selection(page).selectOption('employees'); await page.getByRole('heading', { name: '員工總表查詢', exact: true }).waitFor(); await shot(page, 'money-sibling-employees-advanced.png'); assert(await reloadButton(page).isHidden()); await body(page).getByText('MF-E-9007199254740992', { exact: true }).waitFor();
  }); mark('既有進階員工報表持續掛載，超出安全整數形狀的員編原字串完整保持');

  await readOnly('final-all-tables-triggers-versions-snapshots-and-two-nonempty-BLOBs', async () => {
    assert.deepEqual(rawState(), rawReadBaseline); assert.deepEqual(counts(), readPhaseCounts); assert.deepEqual(triggers(), triggerBaseline); assert.deepEqual((await request('GET', `service-records/${normalRecord.id}`, undefined, 200, actors.admin)).item, normalRecord);
    for (const [entity, item, bytes] of [['case-attachments', caseAttachment, PDF_BYTES], ['certification-attachments', certAttachment, PNG_BYTES]]) for (const exact of [false, true]) { const response = await actors.admin.client.request.get(`${base}/api/${entity}/${item.id}/download${exact ? '?recordVersion=' + item.version : ''}`, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), 200); const actual = await response.body(); assert.deepEqual(actual, bytes); assert.equal(sha(actual), item.sha256); blobDownloads.push({ entity, recordVersion: exact ? item.version : null, bytes: actual.length, sha256: sha(actual), matchesOriginal: true }); }
    assert(rawReadBaseline.attachment_files.length && rawReadBaseline.certification_attachment_files.length);
  });
  const accountedChanges = writeSegments.reduce((total, segment) => total + segment.after.changes - segment.before.changes, 0); assert.equal(counts().changes - initialCounts.changes, accountedChanges);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses, []); assert(consoleErrors.every(message => /ERR_ABORTED|ERR_FAILED/.test(message)), JSON.stringify(consoleErrors));
  assert.equal(readSegments.length, 11); assert.equal(screenshots.length, 7); assert.equal(downloads.length, 2); assert.equal(blobDownloads.length, 4); assert.equal(rejectedBodies.length, 4); assert.equal(invalidations.length, 2); assert.equal(formatterChecks.length, 29);
  const sourceHashesAfter = await collectSources(); assert.deepEqual(sourceHashesAfter, sourceHashesBefore); mark('十一段十一表零寫/六trigger/全版本/凍結快照/四BLOB下載保持，前置fixture/login寫入精確對帳');
  const fixtureNotes = [
    'Normal five small-price services, one approval, later current price/rate changes, two nonempty attachment uploads and four real logins are separately accounted before reads.',
    'The current-month MAX record is an explicit INSERT-only historical snapshot exception. It stores amountMAX alongside valid bounded unitPrice/quantity and minutesMAX/rate60; it does not establish normal price*quantity, payroll calculation precision, service duration or formal financial rule acceptance.',
    'Fees use fixed independent MAX decimal text and row/total values; payroll output is compared only with the actual observed DTO integers. No backend mathematical precision or official financial correctness is inferred.',
    'Direct browser formatter checks cover primitive safe integers exactly; coercion/nonsafe/bigint cases compare only the old fallback, preserving compatibility rather than claiming new exact-money support.',
    'CSV remains fresh authenticated server output with original raw cents, BOM/CRLF and trial caveat; no DOM/JSON currency values replace CSV and no screen snapshot consistency is asserted.',
    'All reads compare eleven raw tables, six triggers, versions and two BLOB tables. Visual review is separately required. No PDF/printing, native OS popup geometry, actual4310, original credentials, deployment or formal payment/claim action is established.',
  ];
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base, actual4310Touched: false, checks, screenshots, month, otherMonth, emptyMonth, readSegments, writeSegments, initialCounts, readPhaseCounts, finalCounts: counts(), accountedChanges, apiChecks, uiQueries, formatterChecks, serverDTOs, csvChecks, rejectedBodies, invalidations, importedFixtures, fixtureNotes, blobDownloads, downloads, pageErrors, consoleErrors, failedResponses, all11TablesUnchangedDuringReads: true, entireReadPhaseRawTablesUnchanged: true, rawReadPhaseBeforeSha256: sha(JSON.stringify(rawReadBaseline)), rawReadPhaseAfterSha256: sha(JSON.stringify(rawState())), immutableTriggers: 6, allRecordVersionsUnchanged: true, approvedBillingSnapshotsUnchanged: true, blobTablesNonempty: { attachment_files: rawReadBaseline.attachment_files.length, certification_attachment_files: rawReadBaseline.certification_attachment_files.length }, sourceHashesBefore, sourceHashesAfter, sourceCount: Object.keys(sourceHashesBefore).length, pdfOperations: 0, printOperations: 0, visualReviewPending: true }, null, 2));
  console.log(`Financial money format E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); const sourceHashesAfter = await collectSources().catch(() => null);
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base, actual4310Touched: false, checks, screenshots, readSegments, writeSegments, apiChecks, uiQueries, formatterChecks, serverDTOs, csvChecks, rejectedBodies, invalidations, importedFixtures, downloads, pageErrors, consoleErrors, failedResponses, sourceHashesBefore, sourceHashesAfter, error: error.stack, pdfOperations: 0, printOperations: 0, visualReviewPending: true }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
