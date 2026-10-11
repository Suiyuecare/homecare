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

// Frozen contract: docs/LEGACY_FINANCIAL_REPORT_CONFIRMATION_SCOPE.md.
// One explicit real Chromium run, synthetic memory SQLite and a random port.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.QA_OUTPUT_DIR || path.join(root, 'outputs/software/legacy-financial-report-confirmation-qa/new-browser-work'));
assert(!existsSync(path.join(output, 'e2e.json')), 'Preserve the prior attempt before an explicit new run');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const collectSources = async () => {
  const names = ['tests/financial-report-response-confirmation-e2e.mjs', 'tests/attachment-fixtures.mjs'];
  const walk = async dir => { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else names.push(file); } };
  for (const dir of ['public', 'src']) await walk(dir);
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const app = createApp({ dbPath: ':memory:', host: '127.0.0.1', port: 0 });
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const month = today.slice(0, 7), year = Number(month.slice(0, 4));
const relativeMonth = delta => new Date(Date.UTC(year, Number(month.slice(5, 7)) - 1 + delta, 1)).toISOString().slice(0, 7);
const otherMonth = relativeMonth(1), zeroMonth = relativeMonth(-2), emptyMonth = relativeMonth(-3);
const password = 'synthetic-financial-confirmation-password';
const checks = [], screenshots = [], readSegments = [], writeSegments = [], apiChecks = [], uiQueries = [], rejectedBodies = [], invalidations = [], downloads = [], blobDownloads = [];
const pageErrors = [], consoleErrors = [], failedResponses = [], contexts = [], importedFixtures = [];
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
    if (confirmedErrorMessage) await body(page).getByText(confirmedErrorMessage, { exact: true }).waitFor();
    assert.equal(await selection(page).inputValue(), kind); assert.equal(await monthControl(page).inputValue(), awaitMonth);
    assert.equal(await body(page).locator('table').count(), 0); assert.equal(await body(page).getByText('此月份沒有符合條件的資料。', { exact: true }).count(), 0);
    assert(await csvButton(page).isDisabled()); await csvButton(page).evaluate(node => node.click()); await settle(page);
    assert.equal(csvRequests, 0); assert.equal(downloads.length, n);
    rejectedBodies.push({ kind, label, httpStatus: response.status(), bodySha256: sha(JSON.stringify(supplied)), monthPreserved: true, typePreserved: true, inlineError: true, noFalseZeroTable: true, csvDisabled: true, csvRequests: 0 });
    if (screenshot) await shot(page, screenshot);
  } finally { page.off('request', countRequest); await page.unroute(pattern); }
};
let awaitMonth = month;

await mkdir(output, { recursive: true });
try {
  sourceHashesBefore = await collectSources(); const initialCounts = counts();
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const setupClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(setupClient);
  const setup = await written('normal-admin-setup', async () => { const response = await setupClient.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成財務回應管理員', email: 'financial-confirmation-admin@example.test', password, organizationName: '合成財務回應甲機構' } }); assert.equal(response.status(), 201); return response.json(); });
  orgId = setup.organizations[0].id; const setupActor = { client: setupClient, auth: setup };
  const request = async (method, route, data, expected = 200, actor = setupActor, org = orgId) => {
    const response = await actor.client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': actor.auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const result = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(result)}`); apiChecks.push({ role: actor.auth.user.role, method, route, requestedOrganization: org, status: response.status(), code: result.error?.code || null }); return result;
  };
  const post = async (entity, data, org) => (await request('POST', entity, data, 201, setupActor, org)).item;
  const users = { admin: { email: setup.user.email } }, normalRecords = [];
  let employee, otherEmployee, caseItem, service, caseAttachment, certAttachment, foreignOrg;
  await written('normal-validated-fixtures-approved-frozen-and-zero-prices-two-BLOBs', async () => {
    employee = await post('employees', { name: '合成凍結時薪員工', employeeNo: 'FC-E', role: 'caregiver', hourlyRateCents: 21000 });
    otherEmployee = await post('employees', { name: '合成零時薪員工', employeeNo: 'FC-ZERO', role: 'caregiver', hourlyRateCents: 0 });
    for (const role of ['finance', 'supervisor', 'caregiver']) users[role] = await post('users', { name: '合成財務回應' + role, email: `financial-confirmation-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    caseItem = await post('cases', { name: '合成財務回應個案', caseNo: 'FC-C' });
    service = await post('service-items', { code: 'FC-S', name: '合成原價格服務', minutes: 60, unitPriceCents: 12345 });
    const zeroService = await post('service-items', { code: 'FC-ZERO-S', name: '合成零價格服務', minutes: 30, unitPriceCents: 0 });
    const plan = await post('care-plans', { caseId: caseItem.id, validFrom: `${year - 1}-01-01`, validTo: `${year + 1}-12-31`, status: 'active', services: [{ serviceItemId: service.id, quantity: 100 }, { serviceItemId: zeroService.id, quantity: 100 }] });
    for (const [selectedMonth, selectedEmployee, selectedService, quantity, actualEnd] of [[month, employee, service, 2, '09:45'], [otherMonth, employee, service, 1, '09:30'], [zeroMonth, otherEmployee, zeroService, 1, '09:30']]) {
      const shift = await post('shifts', { caseId: caseItem.id, employeeId: selectedEmployee.id, carePlanId: plan.id, date: `${selectedMonth}-01`, startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: selectedService.id, quantity }] });
      const submitted = await post('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: selectedEmployee.id, date: shift.date, actualStart: '09:00', actualEnd, services: shift.services, status: 'submitted', note: '合成正常核閱的凍結快照' });
      normalRecords.push((await request('POST', `service-records/${submitted.id}/review`, { version: submitted.version, decision: 'approved', reviewNote: '合成財務回應凍結價格與時薪' })).item);
    }
    const oldFees = await request('GET', `reports/fees?month=${month}`), oldPayroll = await request('GET', `reports/payroll?month=${month}`);
    assert.deepEqual(oldFees.totals, { count: 1, amountCents: 24690 }); assert.deepEqual(oldPayroll.totals, { count: 1, amountCents: 15750, minutes: 45 });
    service = (await request('PATCH', `service-items/${service.id}`, { version: service.version, name: '合成目前新版服務', unitPriceCents: 99999 })).item;
    employee = (await request('PATCH', `employees/${employee.id}`, { version: employee.version, hourlyRateCents: 88888 })).item;
    assert.deepEqual(await request('GET', `reports/fees?month=${month}`), oldFees); assert.deepEqual(await request('GET', `reports/payroll?month=${month}`), oldPayroll);
    caseAttachment = await post('case-attachments/upload', { caseId: caseItem.id, title: '合成財務回應只讀附件', category: 'other', ...filePayload(PDF_BYTES, '合成財務回應.pdf', 'application/pdf') });
    const cert = await post('employee-certifications', { employeeId: employee.id, name: '合成財務回應證照', issuedOn: `${year}-01-01` });
    certAttachment = await post('certification-attachments/upload', { certificationId: cert.id, title: '合成財務回應證照附件', ...filePayload(PNG_BYTES, '合成財務回應.png', 'image/png') });
    foreignOrg = await post('organizations', { name: '合成財務回應乙機構' });
  });
  await written('explicit-INSERT-only-month-prefix-ISO-0000-date-snapshots', async () => {
    const template = business(normalRecords[0]);
    for (const [label, date] of [['prefix', `${month}-not-calendar`], ['ISO', `${month}-02T09:00:00+08:00`], ['0000', '0000-01-arbitrary']]) {
      const item = insert(app.db, orgId, 'service-records', { ...structuredClone(template), date, note: '合成歷史匯入 FC-' + label });
      assert.deepEqual(JSON.parse(app.db.prepare('SELECT snapshot FROM record_versions WHERE record_id=? AND version=1').get(item.id).snapshot), item);
      importedFixtures.push({ label, id: item.id, date, version: 1, insertOnly: true });
    }
    insert(app.db, foreignOrg.id, 'service-records', { ...structuredClone(template), date: `${month}-03`, note: '合成外機構核閱匯入' });
  });
  const actors = {};
  for (const role of ['admin', 'finance', 'supervisor', 'caregiver']) {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(client);
    const auth = await written(`normal-${role}-login-before-read-phase`, async () => { const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: users[role].email, password } }); assert.equal(response.status(), 200); return response.json(); });
    const page = await client.newPage(); observe(page); actors[role] = { client, auth, page };
  }
  const rawReadBaseline = rawState(), readPhaseCounts = counts(), triggerBaseline = triggers();
  const page = actors.admin.page;
  await readOnly('valid-admin-finance-real-month-confirmation-frozen-price-and-rate', async () => {
    for (const role of ['admin', 'finance']) {
      const p = actors[role].page; await loadReport(p); const fee = await selectReport(p, 'fees'); assert.deepEqual(fee.totals, { count: 3, amountCents: 74070 });
      assert.deepEqual(fee.rows.map(row => row.date).sort(), [`${month}-01`, `${month}-02T09:00:00+08:00`, `${month}-not-calendar`].sort()); assert(fee.rows.every(row => row.unitPriceCents === 12345 && row.amountCents === 24690 && row.service === '合成原價格服務'));
      const payroll = await selectReport(p, 'payroll'); assert.deepEqual(payroll.totals, { count: 1, amountCents: 47250, minutes: 135 }); assert.equal(payroll.rows[0].hourlyRateCents, 21000);
      await body(p).getByText('試算，未核定規則', { exact: true }).waitFor(); await p.getByText('費用與薪資僅供試算', { exact: true }).waitFor();
    }
    await selectReport(page, 'fees'); await shot(page, 'financial-fees-confirmed-desktop.png'); await shot(actors.finance.page, 'financial-payroll-confirmed-desktop.png');
  }); mark('管理者與財務真月費用/薪資確認後呈現；保留prefix/ISO日期與核閱價格/時薪快照');

  await readOnly('valid-zero-money-empty-month-and-0000-api-existing-prefix-rule', async () => {
    for (const kind of ['fees', 'payroll']) {
      await selectReport(page, kind); const zero = await display(page, kind, zeroMonth, () => changeMonth(page, zeroMonth)); assert.equal(zero.totals.count, 1); assert.equal(zero.totals.amountCents, 0); assert(await csvButton(page).isEnabled());
      const empty = await display(page, kind, emptyMonth, () => changeMonth(page, emptyMonth)); assert.equal(empty.rows.length, 0); assert.equal(empty.totals.count, 0); assert.equal(empty.totals.amountCents, 0); if (kind === 'payroll') assert.equal(empty.totals.minutes, 0); assert(await csvButton(page).isEnabled());
      if (kind === 'fees') await shot(page, 'financial-fees-confirmed-empty.png');
      const ancient = await request('GET', `reports/${kind}?month=0000-01`, undefined, 200, actors.admin); assert.equal(ancient.totals.count, 1); assert.equal(ancient.totals.amountCents, kind === 'fees' ? 24690 : 15750);
      assert(await page.evaluate(async ({ kind, ancient }) => { const { confirmFinancialReport } = await import('/data/financial-report-confirmation.js'); return confirmFinancialReport(kind, ancient, '0000-01') === ancient; }, { kind, ancient }));
      await display(page, kind, month, () => changeMonth(page, month));
    }
  }); mark('真零金額及空月確認後可CSV，API 0000與原字串prefix語意維持；不假稱原生month接受0000');

  const sharedBad = [
    ['null', () => null], ['array', () => []], ['wrong-title', r => ({ ...r, title: 'SECRET_WRONG_REPORT' })],
    ['columns-null', r => ({ ...r, columns: null })], ['columns-reordered', r => ({ ...r, columns: [...r.columns].reverse() })],
    ['column-extra-key', r => { r.columns[0].internal = 'SECRET_INTERNAL'; return r; }], ['rows-null', r => ({ ...r, rows: null })],
    ['row-extra-key', r => { r.rows[0].internal = 'SECRET_ROW'; return r; }], ['numeric-string', r => { r.rows[0].amountCents = String(r.rows[0].amountCents); return r; }],
    ['negative-amount', r => { r.rows[0].amountCents = -1; return r; }], ['fraction-amount', r => { r.rows[0].amountCents = 0.5; return r; }],
    ['totals-null', r => ({ ...r, totals: null })], ['count-mismatch', r => { r.totals.count++; return r; }],
    ['amount-total-mismatch', r => { r.totals.amountCents++; return r; }], ['totals-extra-key', r => { r.totals.internal = 'SECRET_TOTAL'; return r; }],
    ['note-missing', r => { delete r.note; return r; }], ['note-altered', r => ({ ...r, note: 'SECRET_FALSE_FORMAL_APPROVAL' })],
    ['envelope-extra-key', r => ({ ...r, internal: 'SECRET_ENVELOPE' })],
  ];
  await readOnly('fees-malformed-success-shape-numeric-date-total-and-extra-fields', async () => {
    await selectReport(page, 'fees');
    const specific = [['wrong-kind-columns', r => ({ ...r, columns: [{ key: 'employeeNo', label: '員工編號' }] })], ['date-other-month', r => { r.rows[0].date = `${otherMonth}-01`; return r; }], ['date-object', r => { r.rows[0].date = { date: `${month}-01` }; return r; }], ['quantity-string', r => { r.rows[0].quantity = '2'; return r; }], ['unit-price-negative', r => { r.rows[0].unitPriceCents = -1; return r; }], ['case-object', r => { r.rows[0].case = { secret: 'SECRET_CASE' }; return r; }]];
    for (const [index, [label, mutate]] of [...sharedBad, ...specific].entries()) await rejectBody(page, 'fees', label, mutate, index === 0 ? { screenshot: 'financial-fees-unconfirmed-desktop.png' } : {});
  }); mark('24種費用非法2xx整份拒絕、inline錯誤可重試；月份/類型保留，零金額表與CSV均不誤呈現');

  await readOnly('payroll-malformed-success-shape-minutes-rate-total-and-extra-fields', async () => {
    await selectReport(page, 'payroll');
    const specific = [['wrong-kind-columns', r => ({ ...r, columns: [{ key: 'date', label: '日期' }] })], ['minutes-string', r => { r.rows[0].minutes = '135'; return r; }], ['minutes-negative', r => { r.rows[0].minutes = -1; return r; }], ['minutes-total-mismatch', r => { r.totals.minutes++; return r; }], ['hourly-rate-string', r => { r.rows[0].hourlyRateCents = '21000'; return r; }], ['employee-null', r => { r.rows[0].employee = null; return r; }]];
    for (const [label, mutate] of [...sharedBad, ...specific]) await rejectBody(page, 'payroll', label, mutate);
  }); mark('24種薪資非法2xx整份拒絕含分鐘/時薪/合計；不以字串轉數字或缺值補零確認');

  await readOnly('existing-inline-retry-real-response-restores-current-input-and-export', async () => {
    const result = await display(page, 'payroll', month, () => body(page).getByRole('button', { name: '重新讀取', exact: true }).click()); assert.equal(result.totals.amountCents, 47250);
    assert.equal(await selection(page).inputValue(), 'payroll'); assert.equal(await monthControl(page).inputValue(), month); assert(await csvButton(page).isEnabled());
    await body(page).getByText('試算，未核定規則', { exact: true }).waitFor();
  }); mark('錯誤inline重新讀取恢復真200，原month/kind與核閱試算註記保留，只有確認完成可匯出');

  await readOnly('loading-disabled-and-true-month-abort-new-body-wins', async () => {
    await selectReport(page, 'fees'); const pattern = `**/api/reports/fees?month=${month}&spanMode=calendar-two-day-v1`, slow = await delayRoute(page, pattern);
    try {
      await reloadButton(page).click(); await slow.arrived.promise; await body(page).getByText('正在整理報表…', { exact: true }).waitFor(); assert(await csvButton(page).isDisabled()); await shot(page, 'financial-fees-confirmation-loading.png');
      const abort = page.waitForEvent('requestfailed', { predicate: r => matches({ url: () => r.url(), request: () => r }, 'fees', month), timeout: 10000 });
      await display(page, 'fees', otherMonth, () => changeMonth(page, otherMonth)); const failed = await abort; assert.match(failed.failure().errorText, /ABORTED|FAILED|cancel/i);
      await slow.finish(); await settle(page); await body(page).getByText(`${otherMonth} · 1 筆`, { exact: true }).waitFor(); assert.equal(await body(page).locator('table').first().locator('tbody tr').count(), 1);
      await display(page, 'fees', month, () => changeMonth(page, month));
    } finally { await slow.finish(); }
  }); mark('待確認期間CSV停用；改月份觸發真實Abort，新月結果不被晚到舊JSON覆蓋');

  await readOnly('kind-change-pending-fees-aborts-and-payroll-reconfirms', async () => {
    await selectReport(page, 'fees'); const pattern = '**/api/reports/fees?*', slow = await delayRoute(page, pattern);
    try { const abort = page.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname === '/api/reports/fees', timeout: 10000 }); await reloadButton(page).click(); await slow.arrived.promise;
      await selectReport(page, 'payroll'); assert.match((await abort).failure().errorText, /ABORTED|FAILED|cancel/i); await slow.finish(); await settle(page); await body(page).getByRole('heading', { name: '薪資試算（未核定規則）', exact: true }).waitFor(); assert(await csvButton(page).isEnabled());
    } finally { await slow.finish(); }
  }); mark('待回費用換薪資真Abort，薪資重新確認後才開CSV，舊費用不能混入');

  await readOnly('real-csv-current-fresh-bytes-not-constructed-from-json', async () => {
    for (const [role, kind] of [['admin', 'fees'], ['finance', 'payroll']]) {
      const actor = actors[role]; await selectReport(actor.page, kind); const response = await actor.client.request.get(`${base}/api/reports/${kind}.csv?month=${month}&spanMode=calendar-two-day-v1`, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), 200); const expected = await response.body(); assert.match(response.headers()['content-type'], /^text\/csv/);
      assert.deepEqual([...expected.subarray(0, 3)], [239, 187, 191]); assert(expected.toString().includes('\r\n')); assert(expected.toString().includes('未核定規則'));
      const waiting = actor.page.waitForEvent('download'); await csvButton(actor.page).click(); const download = await waiting; assert.equal(download.suggestedFilename(), `歲悅-${kind}-${month}.csv`);
      const filename = `synthetic-${kind}-${month}.csv`; await download.saveAs(path.join(output, filename)); assert.deepEqual(await readFile(path.join(output, filename)), expected);
    }
  }); mark('確認後費用/薪資真Chromium下載逐位元等於fresh月CSV，保留BOM/CRLF/註記/檔名');

  await readOnly('existing-pending-csv-month-change-real-abort-no-late-download', async () => {
    await selectReport(page, 'fees'); const pattern = '**/api/reports/fees.csv?*', slow = await delayRoute(page, pattern), n = downloads.length;
    try { const abort = page.waitForEvent('requestfailed', { predicate: r => new URL(r.url()).pathname === '/api/reports/fees.csv', timeout: 10000 }); await csvButton(page).click(); await slow.arrived.promise; assert(await csvButton(page).isDisabled());
      await display(page, 'fees', otherMonth, () => changeMonth(page, otherMonth)); assert.match((await abort).failure().errorText, /ABORTED|FAILED|cancel/i); await slow.finish(); await settle(page); assert.equal(downloads.length, n); assert(await csvButton(page).isEnabled());
      await display(page, 'fees', month, () => changeMonth(page, month));
    } finally { await slow.finish(); }
  }); mark('確認結果的CSV待回時換月真Abort，不下載晚到檔；新月再確認後原匯出功能可用');

  await readOnly('four-roles-organization-scope-role-before-invalid-month', async () => {
    await loadReport(actors.supervisor.page); assert.equal(await selection(actors.supervisor.page).locator('option[value="fees"],option[value="payroll"]').count(), 0);
    for (const actor of [actors.supervisor, actors.caregiver]) for (const kind of ['fees', 'payroll']) for (const suffix of ['', '.csv']) { const response = await request('GET', `reports/${kind}${suffix}?month=invalid`, undefined, 403, actor); assert.equal(response.error.code, 'ROLE_FORBIDDEN'); }
    await request('GET', `reports/fees?month=${month}`, undefined, 403, actors.finance, foreignOrg.id);
    const own = await request('GET', `reports/services?month=${zeroMonth}`, undefined, 200, actors.caregiver); assert.equal(own.rows.length, 0); const all = await request('GET', `reports/services?month=${zeroMonth}`, undefined, 200, actors.supervisor); assert.equal(all.rows.length, 1);
    await actors.caregiver.page.goto(`${base}/#/reports`); lastPage = actors.caregiver.page; await actors.caregiver.page.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor(); assert.equal(await actors.caregiver.page.getByLabel('報表類型', { exact: true }).count(), 0);
  }); mark('四角色與機構隔離維持，督導無財務選項/居服員頁受限，API角色先於month驗證且本人範圍不變');

  await readOnly('pending-context-hash-org-role-employee-render-staleRead-and-loaded-download', async () => {
    for (const pending of [true, false]) for (const mode of pending ? ['hash', 'organization', 'role', 'employee', 'render', 'staleRead'] : ['role', 'employee', 'staleRead']) {
      await loadReport(page); await selectReport(page, 'fees'); const n = downloads.length; let slow; const pattern = '**/api/reports/fees?*';
      if (pending) { slow = await delayRoute(page, pattern); await reloadButton(page).click(); await slow.arrived.promise; }
      if (mode === 'hash') await page.evaluate(() => { location.hash = '/employees'; });
      else if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).selectOption(foreignOrg.id);
      else if (mode === 'render') await page.evaluate(() => window.dispatchEvent(new Event('session-updated')));
      else await page.evaluate(async ({ mode, employeeId }) => { const { getContext, setContext } = await import('/ui.js'); const c = structuredClone(getContext()), org = c.organizations.find(o => o.id === c.organizationId); if (mode === 'role') org.role = 'supervisor'; if (mode === 'employee') org.employeeId = employeeId; setContext(c, c.organizationId); }, { mode, employeeId: otherEmployee.id });
      if (slow) await slow.finish(); await settle(page);
      if (pending && await body(page).count()) { assert.equal(await body(page).getByRole('heading', { name: '費用試算（未核定規則）', exact: true }).count(), 0); assert.equal(await body(page).locator('.error-state').count(), 0); }
      if (!pending) { let csvRequests = 0; const listener = request => { if (new URL(request.url()).pathname.endsWith('.csv')) csvRequests++; }; page.on('request', listener); await csvButton(page).evaluate(node => node.click()); await settle(page); assert.equal(csvRequests, 0); page.off('request', listener); }
      assert.equal(downloads.length, n); invalidations.push({ pending, mode, noLateFinancialTable: pending, noLateDownload: true, clientFixture: ['role', 'employee', 'staleRead'].includes(mode) });
      await page.reload(); await page.waitForLoadState('networkidle'); if (mode === 'organization') { await page.getByLabel('目前機構', { exact: true }).selectOption(orgId); await page.waitForLoadState('networkidle'); }
    }
  }); mark('六種待回context失效禁晚表/晚錯誤；三種已載入身份替換禁下載，不冒稱伺服器撤權');

  await readOnly('390px-confirmed-and-unconfirmed-focus-label-scroll-sibling-advanced', async () => {
    const p = actors.finance.page; await p.setViewportSize({ width: 390, height: 844 }); await selectReport(p, 'fees'); await monthControl(p).focus(); assert(await monthControl(p).evaluate(node => node === document.activeElement));
    const scroll = body(p).locator('.table-scroll').first(); assert(await scroll.evaluate(node => node.scrollWidth > node.clientWidth)); await scroll.evaluate(node => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = node.scrollWidth; }); assert(await scroll.evaluate(node => node.scrollLeft > 0)); await shot(p, 'financial-fees-confirmed-mobile.png');
    await rejectBody(p, 'fees', 'mobile-null', () => null, { screenshot: 'financial-fees-unconfirmed-mobile.png' }); await display(p, 'fees', month, () => body(p).getByRole('button', { name: '重新讀取', exact: true }).click()); await p.setViewportSize({ width: 1440, height: 1050 });
    await loadReport(page); await selection(page).selectOption('employees'); await page.getByRole('heading', { name: '員工總表查詢', exact: true }).waitFor(); await shot(page, 'financial-sibling-employees-advanced.png'); assert(await reloadButton(page).isHidden());
  }); mark('390px有label/真焦點、寬表自身橫捲/頁面無溢出，錯誤可恢復；sibling進階員工報表仍掛載');

  await readOnly('final-all-tables-triggers-versions-snapshots-and-two-nonempty-BLOBs', async () => {
    assert.deepEqual(rawState(), rawReadBaseline); assert.deepEqual(counts(), readPhaseCounts); assert.deepEqual(triggers(), triggerBaseline);
    for (const record of normalRecords) assert.deepEqual((await request('GET', `service-records/${record.id}`, undefined, 200, actors.admin)).item, record);
    for (const [entity, item, bytes] of [['case-attachments', caseAttachment, PDF_BYTES], ['certification-attachments', certAttachment, PNG_BYTES]]) for (const exact of [false, true]) {
      const response = await actors.admin.client.request.get(`${base}/api/${entity}/${item.id}/download${exact ? '?recordVersion=' + item.version : ''}`, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), 200); const actual = await response.body(); assert.deepEqual(actual, bytes); assert.equal(sha(actual), item.sha256); blobDownloads.push({ entity, recordVersion: exact ? item.version : null, bytes: actual.length, sha256: sha(actual), matchesOriginal: true });
    }
    assert(rawReadBaseline.attachment_files.length && rawReadBaseline.certification_attachment_files.length);
  });
  const accountedChanges = writeSegments.reduce((total, segment) => total + segment.after.changes - segment.before.changes, 0); assert.equal(counts().changes - initialCounts.changes, accountedChanges);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses, []); assert(consoleErrors.every(message => /ERR_ABORTED|ERR_FAILED/.test(message)), JSON.stringify(consoleErrors));
  assert.equal(readSegments.length, 13); assert.equal(screenshots.length, 8); assert.equal(downloads.length, 2); assert.equal(blobDownloads.length, 4); assert.equal(rejectedBodies.length, 49); assert.equal(invalidations.length, 9);
  const sourceHashesAfter = await collectSources(); assert.deepEqual(sourceHashesAfter, sourceHashesBefore);
  mark('十三段十一表零寫/六trigger/全版本/核閱快照/四BLOB下載不變，前置fixture/login寫入精確對帳');
  const fixtureNotes = [
    'Normal setup, three approvals, later current price/rate changes, two nonempty attachment uploads and four real logins are separately accounted before reads.',
    'Three INSERT-only typed string dates preserve original prefix/ISO/0000 semantics and matching version-one snapshots. They are historical-import exceptions and do not establish normal API date-write acceptance.',
    'Malformed bodies are Playwright 200-response substitution fixtures after fetching a real monthly report; no server financial data, money rule, frozen snapshot or history is edited.',
    'All malformed-body reads preserve kind/month and require a full inline error, retry action, no table/false-empty/zero fallback and no CSV request. Successful JSON never supplies CSV bytes; CSV remains a separate fresh authenticated endpoint request.',
    'Context role/employee/same-identity replacement fixtures are browser-local context substitutions, not server role revocation. Hash/org/render changes and real requestfailed month/type/CSV cancellation prevent stale output.',
    'Each segment and the whole read phase compare all eleven raw tables, six triggers, record_versions and two BLOB tables. Screenshots require an independent visual review; no printing, PDF generation or native popup geometry is established.',
  ];
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base, actual4310Touched: false, checks, screenshots, month, otherMonth, zeroMonth, emptyMonth, readSegments, writeSegments, initialCounts, readPhaseCounts, finalCounts: counts(), accountedChanges, apiChecks, uiQueries, rejectedBodies, invalidations, importedFixtures, fixtureNotes, blobDownloads, downloads, pageErrors, consoleErrors, failedResponses, all11TablesUnchangedDuringReads: true, entireReadPhaseRawTablesUnchanged: true, rawReadPhaseBeforeSha256: sha(JSON.stringify(rawReadBaseline)), rawReadPhaseAfterSha256: sha(JSON.stringify(rawState())), immutableTriggers: 6, allRecordVersionsUnchanged: true, approvedBillingSnapshotsUnchanged: true, blobTablesNonempty: { attachment_files: rawReadBaseline.attachment_files.length, certification_attachment_files: rawReadBaseline.certification_attachment_files.length }, sourceHashesBefore, sourceHashesAfter, sourceCount: Object.keys(sourceHashesBefore).length, pdfOperations: 0, printOperations: 0, visualReviewPending: true }, null, 2));
  console.log(`Financial response confirmation E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const sourceHashesAfter = await collectSources().catch(() => null);
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base, actual4310Touched: false, checks, screenshots, readSegments, writeSegments, importedFixtures, apiChecks, uiQueries, rejectedBodies, invalidations, downloads, pageErrors, consoleErrors, failedResponses, sourceHashesBefore, sourceHashesAfter, error: error.stack, pdfOperations: 0, printOperations: 0, visualReviewPending: true }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
