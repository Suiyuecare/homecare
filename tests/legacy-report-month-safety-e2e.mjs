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

// A single real Chromium run against private memory SQLite and a random localhost
// port. Imports below are explicit synthetic historical fixtures, not valid API writes.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.QA_OUTPUT_DIR || path.join(root, 'outputs/software/legacy-report-month-safety-qa/new-browser-work'));
assert(!existsSync(path.join(output, 'e2e.json')), 'Preserve the prior attempt before starting another run');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const collectSources = async () => {
  const names = ['tests/legacy-report-month-safety-e2e.mjs', 'tests/attachment-fixtures.mjs'];
  const walk = async dir => { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else names.push(file); } };
  for (const dir of ['public', 'src']) await walk(dir);
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, digest(await readFile(path.join(root, file)))])));
};
const app = createApp({ dbPath: ':memory:', host: '127.0.0.1', port: 0 });
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const month = today.slice(0, 7), year = Number(month.slice(0, 4));
const otherMonth = new Date(Date.UTC(year, Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);
const emptyMonth = new Date(Date.UTC(year, Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
const password = 'synthetic-legacy-month-password';
const checks = [], screenshots = [], readSegments = [], writeSegments = [], apiChecks = [], uiQueries = [], importedFixtures = [], blobDownloads = [];
const pageErrors = [], consoleErrors = [], failedResponses = [], downloads = [], contexts = [];
let browser, base, orgId, lastPage, sourceHashesBefore;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const counts = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, ...Object.fromEntries(['audit', 'records', 'record_versions', 'idempotency'].map(table => [table, app.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n])) });
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const triggers = () => app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
const readOnly = async (label, work) => { const before = counts(), raw = rawState(), definitions = triggers(); assert.equal(Object.keys(raw).length, 11); assert.equal(definitions.length, 6); const value = await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); assert.deepEqual(triggers(), definitions, label); readSegments.push({ label, before, after: counts(), all11TablesUnchanged: true, all6TriggersUnchanged: true, rawBeforeSha256: digest(JSON.stringify(raw)), rawAfterSha256: digest(JSON.stringify(rawState())) }); return value; };
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
const loadReport = async page => { lastPage = page; await page.goto(`${base}/#/reports`); await page.getByRole('heading', { name: '報表中心', exact: true, level: 1 }).waitFor(); await selection(page).waitFor(); };
const matches = (response, kind, selectedMonth) => { const url = new URL(response.url()); return response.request().method() === 'GET' && url.pathname === `/api/reports/${kind}` && url.searchParams.get('month') === selectedMonth && url.searchParams.get('spanMode') === 'calendar-two-day-v1'; };
const display = async (page, kind, selectedMonth, action) => {
  const waiting = page.waitForResponse(response => matches(response, kind, selectedMonth));
  await action(); const response = await waiting; assert.equal(response.status(), 200); const result = await response.json();
  await body(page).getByRole('heading', { name: result.title, exact: true, level: 2 }).waitFor();
  await body(page).getByText(`${selectedMonth} · ${result.rows.length} 筆`, { exact: true }).waitFor();
  assert.equal(await body(page).locator('.error-state').count(), 0); assert.equal(await csvButton(page).isEnabled(), true);
  const firstTable = body(page).locator('table').first();
  if (result.rows.length) assert.equal(await firstTable.locator('tbody tr').count(), result.rows.length);
  else await body(page).getByText('此月份沒有符合條件的資料。', { exact: true }).waitFor();
  uiQueries.push({ role: await page.locator('.role-tag').textContent(), kind, month: selectedMonth, status: response.status(), rows: result.rows.length, totals: result.totals }); return result;
};
const changeMonth = async (page, value) => { await monthControl(page).fill(value); await monthControl(page).press('Tab'); };
const inspectLayout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.outerHTML)), []);
  for (const table of await body(page).locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => { if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 }); await inspectLayout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

await mkdir(output, { recursive: true });
try {
  sourceHashesBefore = await collectSources(); const initialCounts = counts();
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const setupClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(setupClient);
  const setup = await written('normal-admin-setup', async () => { const response = await setupClient.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成舊報表管理員', email: 'legacy-admin@example.test', password, organizationName: '合成舊報表甲機構' } }); assert.equal(response.status(), 201); return response.json(); });
  orgId = setup.organizations[0].id; const setupActor = { client: setupClient, auth: setup };
  const request = async (method, route, data, expected = 200, actor = setupActor, org = orgId) => {
    const response = await actor.client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': actor.auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const result = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(result)}`); apiChecks.push({ role: actor.auth.user.role, method, route, requestedOrganization: org, status: response.status(), code: result.error?.code || null }); return result;
  };
  const post = async (entity, data, org) => (await request('POST', entity, data, 201, setupActor, org)).item;
  const users = { admin: { email: setup.user.email } }, normalRecords = [];
  let employee, otherEmployee, caseItem, service, caseAttachment, certAttachment, foreignOrg;
  await written('normal-validated-fixtures-approval-frozen-prices-and-two-nonempty-BLOBs', async () => {
    employee = await post('employees', { name: '合成凍結時薪員工', employeeNo: 'LM-E', role: 'caregiver', hourlyRateCents: 21000 });
    otherEmployee = await post('employees', { name: '合成另一員工', employeeNo: 'LM-OTHER', role: 'caregiver', hourlyRateCents: 21000 });
    for (const role of ['finance', 'supervisor', 'caregiver']) users[role] = await post('users', { name: '合成舊報表' + role, email: `legacy-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    caseItem = await post('cases', { name: '合成舊報表個案', caseNo: 'LM-C' });
    service = await post('service-items', { code: 'LM-S', name: '合成原價格服務', minutes: 60, unitPriceCents: 12345 });
    const plan = await post('care-plans', { caseId: caseItem.id, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, status: 'active', services: [{ serviceItemId: service.id, quantity: 100 }] });
    for (const [selectedMonth, quantity, actualEnd] of [[month, 2, '09:45'], [otherMonth, 1, '09:30']]) {
      const shift = await post('shifts', { caseId: caseItem.id, employeeId: employee.id, carePlanId: plan.id, date: `${selectedMonth}-01`, startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity }] });
      const submitted = await post('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd, services: shift.services, status: 'submitted', note: '合成正常核閱的凍結快照' });
      normalRecords.push((await request('POST', `service-records/${submitted.id}/review`, { version: submitted.version, decision: 'approved', reviewNote: '合成凍結價格與時薪' })).item);
    }
    const oldFees = await request('GET', `reports/fees?month=${month}`), oldPayroll = await request('GET', `reports/payroll?month=${month}`);
    assert.deepEqual(oldFees.totals, { count: 1, amountCents: 24690 }); assert.deepEqual(oldPayroll.totals, { count: 1, amountCents: 15750, minutes: 45 });
    service = (await request('PATCH', `service-items/${service.id}`, { version: service.version, name: '合成目前新版服務', unitPriceCents: 99999 })).item;
    employee = (await request('PATCH', `employees/${employee.id}`, { version: employee.version, hourlyRateCents: 88888 })).item;
    assert.deepEqual(await request('GET', `reports/fees?month=${month}`), oldFees); assert.deepEqual(await request('GET', `reports/payroll?month=${month}`), oldPayroll);
    caseAttachment = await post('case-attachments/upload', { caseId: caseItem.id, title: '合成舊報表只讀附件', category: 'other', ...filePayload(PDF_BYTES, '合成舊報表.pdf', 'application/pdf') });
    const cert = await post('employee-certifications', { employeeId: employee.id, name: '合成舊報表證照', issuedOn: `${year}-01-01` });
    certAttachment = await post('certification-attachments/upload', { certificationId: cert.id, title: '合成舊報表證照附件', ...filePayload(PNG_BYTES, '合成舊報表.png', 'image/png') });
    foreignOrg = await post('organizations', { name: '合成舊報表乙機構' });
  });
  await written('INSERT-only-imported-approved-typed-dates-with-identical-version-one', async () => {
    const template = business(normalRecords[0]);
    for (const [label, date] of [['object', { date: `${month}-01` }], ['array', [`${month}-01`]], ['number-zero', 0], ['number-positive', 20261001], ['true', true], ['false', false], ['null', null], ['missing', undefined], ['empty-string', ''], ['prefix-string', `${month}-not-a-calendar-date`], ['ISO-string', `${month}-02T09:00:00+08:00`]]) {
      const data = { ...structuredClone(template), note: '合成歷史匯入 LM-' + label, date, validFrom: `${month}-01` }; if (date === undefined) delete data.date;
      const item = insert(app.db, orgId, 'service-records', data);
      assert.deepEqual(JSON.parse(app.db.prepare('SELECT snapshot FROM record_versions WHERE record_id=? AND version=1').get(item.id).snapshot), item);
      importedFixtures.push({ label, id: item.id, ownDate: Object.hasOwn(item, 'date'), date: item.date, validFrom: item.validFrom, matchingVersion: 1, insertOnly: true });
    }
    // A valid same-org other-employee record and a malformed foreign-org record
    // demonstrate that financial org scoping and caregiver own scoping survive.
    const otherRecord = { ...structuredClone(template), employeeId: otherEmployee.id, date: `${otherMonth}-02`, note: '合成另一員工匯入' };
    otherRecord.billingSnapshot.employee = { id: otherEmployee.id, name: otherEmployee.name, employeeNo: otherEmployee.employeeNo, hourlyRateCents: 21000 };
    insert(app.db, orgId, 'service-records', otherRecord);
    insert(app.db, foreignOrg.id, 'service-records', { ...structuredClone(template), date: { source: month }, note: '合成外機構匯入' });
  });
  const actors = {};
  for (const role of ['admin', 'finance', 'supervisor', 'caregiver']) {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(client);
    const auth = await written(`normal-${role}-login-before-read-phase`, async () => { const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: users[role].email, password } }); assert.equal(response.status(), 200); return response.json(); });
    const page = await client.newPage(); observe(page); actors[role] = { client, auth, page };
  }
  const rawReadBaseline = rawState(), readPhaseCounts = counts(), triggerBaseline = triggers();
  const currentFeeTotals = { count: 3, amountCents: 74070 }, currentPayrollTotals = { count: 1, amountCents: 47250, minutes: 135 };
  await readOnly('admin-finance-monthly-fees-payroll-nonstring-exclusion-prefix-and-ISO-kept', async () => {
    for (const role of ['admin', 'finance']) {
      const page = actors[role].page; await loadReport(page);
      const fee = await display(page, 'fees', month, () => selection(page).selectOption('fees')); assert.deepEqual(fee.totals, currentFeeTotals);
      assert.deepEqual(fee.rows.map(row => row.date).sort(), [`${month}-01`, `${month}-02T09:00:00+08:00`, `${month}-not-a-calendar-date`].sort());
      assert(fee.rows.every(row => row.unitPriceCents === 12345 && row.amountCents === 24690 && row.service === '合成原價格服務'));
      await body(page).getByText('試算，未核定規則', { exact: true }).waitFor();
      await page.getByText('費用與薪資僅供試算', { exact: true }).waitFor();
      const payroll = await display(page, 'payroll', month, () => selection(page).selectOption('payroll')); assert.deepEqual(payroll.totals, currentPayrollTotals); assert.equal(payroll.rows[0].hourlyRateCents, 21000);
    }
    await display(actors.admin.page, 'fees', month, () => selection(actors.admin.page).selectOption('fees'));
    await shot(actors.admin.page, 'legacy-fees-desktop.png');
  }); mark('管理者與財務真月查詢200；非字串不納入，原prefix/ISO字串維持，快照價格/時薪不採現值');

  await readOnly('admin-finance-month-change-and-empty-month-legacy-download-enabled', async () => {
    for (const role of ['admin', 'finance']) {
      const page = actors[role].page;
      const kind = role === 'admin' ? 'fees' : 'payroll';
      const result = await display(page, kind, otherMonth, () => changeMonth(page, otherMonth)); assert.equal(result.totals.count, 2);
      const empty = await display(page, kind, emptyMonth, () => changeMonth(page, emptyMonth)); assert.equal(empty.rows.length, 0); assert.equal(empty.totals.amountCents, 0); assert(await csvButton(page).isEnabled());
      await display(page, kind, month, () => changeMonth(page, month));
    }
  }); mark('真月份切換只取該月份；空月份顯示零筆零金額並維持原CSV可下載行為');

  await readOnly('fresh-real-Chromium-financial-CSV-downloads-byte-for-byte-monthly-API', async () => {
    for (const [role, kind] of [['admin', 'fees'], ['finance', 'payroll']]) {
      const actor = actors[role], response = await actor.client.request.get(`${base}/api/reports/${kind}.csv?month=${month}&spanMode=calendar-two-day-v1`, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), 200); const expected = await response.body();
      assert.match(response.headers()['content-type'], /^text\/csv/); assert.match(response.headers()['content-disposition'], new RegExp(`${kind}\\.csv`));
      assert.deepEqual([...expected.subarray(0, 3)], [239, 187, 191]); assert(expected.toString().includes('\r\n')); assert(expected.toString().includes('未核定規則'));
      const waiting = actor.page.waitForEvent('download'); await csvButton(actor.page).click(); const download = await waiting;
      assert.equal(download.suggestedFilename(), `歲悅-${kind}-${month}.csv`); const filename = `synthetic-${kind}-${month}.csv`; await download.saveAs(path.join(output, filename)); assert.deepEqual(await readFile(path.join(output, filename)), expected);
    }
  }); mark('費用與薪資真Chromium下載逐位元等於fresh月篩CSV；BOM/CRLF/試算註記及原檔名保留');

  await readOnly('absent-empty-month-API-keeps-all-typed-dates-without-coercion-or-fallback', async () => {
    for (const actor of [actors.admin, actors.finance]) for (const kind of ['fees', 'payroll']) {
      const absent = await request('GET', `reports/${kind}`, undefined, 200, actor), empty = await request('GET', `reports/${kind}?month=`, undefined, 200, actor); assert.deepEqual(absent, empty);
      assert.equal(absent.totals.amountCents, kind === 'fees' ? 13 * 24690 + 12345 : 13 * 15750 + 10500);
      if (kind === 'fees') { assert.equal(absent.rows.length, 14); for (const fixture of importedFixtures) if (fixture.label !== 'missing') assert(absent.rows.some(row => JSON.stringify(row.date) === JSON.stringify(fixture.date))); }
      const noMonth = await actor.client.request.get(`${base}/api/reports/${kind}.csv`, { headers: { 'X-Org-Id': orgId } }), emptyMonthResponse = await actor.client.request.get(`${base}/api/reports/${kind}.csv?month=`, { headers: { 'X-Org-Id': orgId } }); assert.equal(noMonth.status(), 200); assert.equal(emptyMonthResponse.status(), 200); assert.deepEqual(await noMonth.body(), await emptyMonthResponse.body());
    }
  }); mark('API未提供/空month完全一致；保留所有原日期值及既有CSV轉字串，未修補日期或使用validFrom');

  await readOnly('supervisor-caregiver-role-org-scope-and-error-precedence', async () => {
    const page = actors.supervisor.page; await loadReport(page);
    assert.equal(await selection(page).locator('option[value="fees"],option[value="payroll"]').count(), 0); await shot(page, 'legacy-supervisor-report-options.png');
    const own = await request('GET', `reports/services?month=${otherMonth}`, undefined, 200, actors.caregiver); assert.equal(own.rows.length, 1); assert(own.rows.every(row => row.employee === employee.name));
    const supervisor = await request('GET', `reports/services?month=${otherMonth}`, undefined, 200, actors.supervisor); assert.equal(supervisor.rows.length, 2);
    for (const actor of [actors.supervisor, actors.caregiver]) for (const kind of ['fees', 'payroll']) for (const suffix of ['', '.csv']) { const response = await request('GET', `reports/${kind}${suffix}?month=invalid`, undefined, 403, actor); assert.equal(response.error.code, 'ROLE_FORBIDDEN'); }
    await request('GET', `reports/fees?month=${month}`, undefined, 403, actors.finance, foreignOrg.id);
    await actors.caregiver.page.goto(`${base}/#/reports`); lastPage = actors.caregiver.page; await actors.caregiver.page.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor(); assert.equal(await actors.caregiver.page.getByLabel('報表類型', { exact: true }).count(), 0); await shot(actors.caregiver.page, 'legacy-caregiver-report-denied.png');
  }); mark('督導無費用/薪資選項、居服員報表頁仍403；API角色先於month驗證、本人與跨機構隔離維持');

  await readOnly('390px-financial-tables-labels-focus-own-scroll-and-caveat', async () => {
    const page = actors.finance.page; await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await monthControl(page).focus(); assert(await monthControl(page).evaluate(node => node === document.activeElement)); await shot(page, 'legacy-payroll-mobile.png');
    await display(page, 'fees', month, () => selection(page).selectOption('fees')); const region = body(page).locator('.table-scroll').first(); assert(await region.evaluate(node => node.scrollWidth > node.clientWidth)); await region.evaluate(node => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = node.scrollWidth; }); assert(await region.evaluate(node => node.scrollLeft > 0)); await shot(page, 'legacy-fees-mobile-after.png'); await page.setViewportSize({ width: 1440, height: 1050 });
  }); mark('390px控制有label及真焦點、頁面不溢出、費用寬表自行橫捲；試算待核定文字保留');

  await readOnly('pending-JSON-reread-and-CSV-month-change-abort-and-blank-UI-month-no-request', async () => {
    const page = actors.admin.page; lastPage = page;
    // Hold a real JSON response from the existing reread button. A newer month
    // must abort the old query and keep its own result after the held body returns.
    const queryPattern = `**/api/reports/fees?month=${month}&spanMode=calendar-two-day-v1`;
    const queryArrived = deferred(), queryRelease = deferred(), queryHandled = deferred();
    await page.route(queryPattern, async route => { try { const response = await route.fetch(); queryArrived.resolve(); await queryRelease.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { queryHandled.resolve(); } });
    try {
      const abortedQuery = page.waitForEvent('requestfailed', { predicate: request => { const url = new URL(request.url()); return url.pathname === '/api/reports/fees' && url.searchParams.get('month') === month; }, timeout: 10000 });
      await page.getByRole('button', { name: '重新查詢', exact: true }).click(); await queryArrived.promise;
      await body(page).getByText('正在整理報表…', { exact: true }).waitFor(); assert(await csvButton(page).isDisabled());
      const newer = await display(page, 'fees', otherMonth, () => changeMonth(page, otherMonth)); assert.equal(newer.rows.length, 2);
      const failedQuery = await abortedQuery; assert.match(failedQuery.failure().errorText, /ABORTED|FAILED|cancel/i);
      queryRelease.resolve(); await queryHandled.promise; await page.unroute(queryPattern);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await body(page).getByText(`${otherMonth} · 2 筆`, { exact: true }).waitFor(); assert.equal(await body(page).locator('table').first().locator('tbody tr').count(), 2); assert(await csvButton(page).isEnabled());
    } finally { queryRelease.resolve(); await queryHandled.promise; await page.unroute(queryPattern).catch(() => {}); }
    await display(page, 'fees', month, () => changeMonth(page, month));
    const pattern = '**/api/reports/fees.csv?*', arrived = deferred(), release = deferred(), handled = deferred();
    await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } });
    const beforeDownloads = downloads.length;
    try {
      const aborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/api/reports/fees.csv', timeout: 10000 });
      await csvButton(page).click(); await arrived.promise; assert(await csvButton(page).isDisabled());
      await display(page, 'fees', otherMonth, () => changeMonth(page, otherMonth)); const failed = await aborted; assert.match(failed.failure().errorText, /ABORTED|FAILED|cancel/i);
      release.resolve(); await handled.promise; await page.unroute(pattern); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(downloads.length, beforeDownloads);
    } finally { release.resolve(); await handled.promise; await page.unroute(pattern).catch(() => {}); }
    let monthlyRequests = 0; const countRequest = request => { if (/\/api\/reports\/fees(?:\?|$)/.test(request.url())) monthlyRequests++; }; page.on('request', countRequest);
    await changeMonth(page, ''); await body(page).getByText('請選擇有效月份', { exact: true }).waitFor(); assert(await csvButton(page).isDisabled()); assert.equal(monthlyRequests, 0); page.off('request', countRequest);
    await display(page, 'fees', month, () => changeMonth(page, month));
  }); mark('重新查詢與CSV待回時月份切換真Abort；新月結果不受舊JSON污染/無遲到下載，空月提示且不發查詢');

  await readOnly('final-all-eleven-tables-six-triggers-versions-frozen-snapshot-and-two-BLOBs', async () => {
    assert.deepEqual(rawState(), rawReadBaseline); assert.deepEqual(counts(), readPhaseCounts); assert.deepEqual(triggers(), triggerBaseline);
    for (const record of normalRecords) assert.deepEqual((await request('GET', `service-records/${record.id}`, undefined, 200, actors.admin)).item, record);
    for (const [entity, item, bytes] of [['case-attachments', caseAttachment, PDF_BYTES], ['certification-attachments', certAttachment, PNG_BYTES]]) for (const exact of [false, true]) { const response = await actors.admin.client.request.get(`${base}/api/${entity}/${item.id}/download${exact ? '?recordVersion=' + item.version : ''}`, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), 200); const actual = await response.body(); assert.deepEqual(actual, bytes); assert.equal(digest(actual), item.sha256); blobDownloads.push({ entity, recordVersion: exact ? item.version : null, bytes: actual.length, sha256: digest(actual), matchesOriginal: true }); }
    assert(rawReadBaseline.attachment_files.length && rawReadBaseline.certification_attachment_files.length);
  });
  const accountedChanges = writeSegments.reduce((total, segment) => total + segment.after.changes - segment.before.changes, 0); assert.equal(counts().changes - initialCounts.changes, accountedChanges);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses, []); assert(consoleErrors.every(message => /ERR_ABORTED|ERR_FAILED/.test(message)), JSON.stringify(consoleErrors));
  assert.equal(readSegments.length, 8); assert.equal(screenshots.length, 5); assert.equal(downloads.length, 2); assert.equal(blobDownloads.length, 4);
  const sourceHashesAfter = await collectSources(); assert.deepEqual(sourceHashesAfter, sourceHashesBefore);
  mark('八段十一表零寫、六trigger/全部版本/兩筆核閱快照/四BLOB下載不變；前置fixture/login寫入精確對帳');
  const fixtureNotes = [
    'Only private memory SQLite, a random 127.0.0.1 port and real Chromium; no actual4310, workspace data, source-platform credentials, real people or deployment.',
    'Normal setup, fixture creation, two approvals, subsequent current-price/rate patches, two nonempty attachment uploads and all four real logins are separately accounted before the read phase.',
    'Eleven INSERT-only imported approved records preserve typed dates and version-one snapshots. These imports are exceptions outside normal payload/date validation, not evidence the API accepts malformed dates; validFrom is a decoy and never a fallback.',
    'A valid imported other-employee record and malformed foreign-org import test scope. Monthly string-prefix semantics, snapshot pricing, absent/empty month API behavior and its existing CSV String conversion remain unchanged.',
    'Blank UI month retains the original invalid-month prompt and disabled CSV; the API accepts absent/empty month as an unfiltered query. Empty valid monthly data retains the original enabled CSV behavior.',
    'The pending JSON reread and CSV fixtures use fetched real API responses held by Playwright. Month change triggers the application AbortController; actual requestfailed is observed before fixture release, preserving the new-month JSON result and preventing a late download. These are browser response-delay fixtures, not server failures.',
    'Every read segment and the entire read phase compare all eleven raw tables, all six trigger definitions, all record_versions and two nonempty BLOB tables. No UPDATE/DELETE, history repair or price recalculation is issued during reads.',
    'Only fees/payroll legacy UI is exercised; other legacy endpoint types and advanced reports require separate API/regression proof. No new page, UI, print preview, PDF or formal financial rule is introduced. OS native popup geometry and human UAT remain unverified.',
    'Every screenshot requires separate visual inspection; execution alone leaves visualReviewPending true.',
  ];
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base, actual4310Touched: false, checks, screenshots, month, otherMonth, emptyMonth, readSegments, writeSegments, initialCounts, readPhaseCounts, finalCounts: counts(), accountedChanges, apiChecks, uiQueries, importedFixtures, fixtureNotes, blobDownloads, downloads, pageErrors, consoleErrors, failedResponses, all11TablesUnchangedDuringReads: true, entireReadPhaseRawTablesUnchanged: true, rawReadPhaseBeforeSha256: digest(JSON.stringify(rawReadBaseline)), rawReadPhaseAfterSha256: digest(JSON.stringify(rawState())), immutableTriggers: 6, allRecordVersionsUnchanged: true, approvedBillingSnapshotsUnchanged: true, blobTablesNonempty: { attachment_files: rawReadBaseline.attachment_files.length, certification_attachment_files: rawReadBaseline.certification_attachment_files.length }, sourceHashesBefore, sourceHashesAfter, sourceCount: Object.keys(sourceHashesBefore).length, pdfOperations: 0, pdfMarkers: 0, printOperations: 0, visualReviewPending: true }, null, 2));
  console.log(`Legacy report month safety E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const sourceHashesAfter = await collectSources().catch(() => null);
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base, actual4310Touched: false, checks, screenshots, readSegments, writeSegments, importedFixtures, apiChecks, uiQueries, downloads, pageErrors, consoleErrors, failedResponses, sourceHashesBefore, sourceHashesAfter, error: error.stack, pdfOperations: 0, printOperations: 0, visualReviewPending: true }, null, 2));
  throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
