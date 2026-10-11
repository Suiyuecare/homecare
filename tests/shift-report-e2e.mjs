import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { installReportPrintCapture, renderCapturedReportPdf } from './helpers/report-print.mjs';

// All fixtures and mutations below use only this process's memory SQLite and random port.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/shift-report-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [], readSegments = [], intentionalMutations = [], downloads = [];
const password = 'synthetic-shift-report-password';
let browser, base, lastPage, readBaseline, stateBaseline;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: response.status() === 503 }); });
  page.on('download', download => downloads.push(download.suggestedFilename()));
};
const counts = () => Object.fromEntries([
  ['changes', 'SELECT total_changes() AS n'], ['audit', 'SELECT COUNT(*) AS n FROM audit'],
  ['records', 'SELECT COUNT(*) AS n FROM records'], ['versions', 'SELECT COUNT(*) AS n FROM record_versions'],
  ['idempotency', 'SELECT COUNT(*) AS n FROM idempotency'],
].map(([key, sql]) => [key, app.db.prepare(sql).get().n]));
const rawState = () => ({
  records: app.db.prepare('SELECT * FROM records ORDER BY id').all(),
  versions: app.db.prepare('SELECT * FROM record_versions ORDER BY record_id,version').all(),
  audit: app.db.prepare('SELECT * FROM audit ORDER BY rowid').all(),
  idempotency: app.db.prepare('SELECT * FROM idempotency ORDER BY rowid').all(),
});
const startReads = () => { readBaseline = counts(); stateBaseline = rawState(); };
const verifyReads = label => { assert.deepEqual(counts(), readBaseline); assert.deepEqual(rawState(), stateBaseline); readSegments.push({ label, before: readBaseline, after: counts(), allStateUnchanged: true }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const fail503 = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_RETRY', message: '合成報表暫時無法取得，請重試。' } }) });
const listPattern = '**/api/shift-report?*', fullPattern = '**/api/shift-report/export?*', csvPattern = '**/api/shift-report.csv?*';
const region = page => page.getByRole('region', { name: '排班明細查詢', exact: true });
const resultRegion = page => page.getByRole('region', { name: '班表查詢結果', exact: true });
const previewTitle = '班表明細列印預覽';
const printCount = page => page.evaluate(() => window.__printCalls.length);
const closeDialog = async (page, trigger) => { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); if (trigger) assert.ok(await trigger.evaluate(node => node === document.activeElement)); };
const queryReport = async (page, expected) => {
  await region(page).getByRole('button', { name: '查詢排班', exact: true }).click();
  await resultRegion(page).getByText(`符合條件共 ${expected} 班次；本頁 ${Math.min(expected, 25)} 筆。`, { exact: true }).waitFor();
};
const setAllRange = async page => {
  await region(page).getByLabel('開始日期', { exact: true }).fill('2026-10-01');
  await region(page).getByLabel('結束日期', { exact: true }).fill('2026-11-09');
};
const loadReport = async page => {
  lastPage = page;
  if (page.url() === `${base}/#/reports`) await page.reload(); else await page.goto(`${base}/#/reports`);
  await page.getByRole('heading', { name: '報表中心', exact: true, level: 1 }).waitFor();
  await page.getByLabel('報表類型', { exact: true }).selectOption('shifts');
  await resultRegion(page).waitFor(); await page.waitForLoadState('networkidle');
};
const inspectLayout = async page => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page horizontal overflow');
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), []);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    const box = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, window: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
    assert.ok(box.left >= 0 && box.right <= box.window && box.scroll <= box.client + 1, 'Dialog fits viewport, table owns scroll');
  }
  for (const table of await page.locator('.shift-report-table:visible').all()) {
    assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
    if (await table.evaluate(node => node.scrollWidth > node.clientWidth)) { await table.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert.ok(await table.evaluate(node => node.scrollLeft > 0)); await table.evaluate(node => { node.scrollLeft = 0; }); }
  }
};
const shot = async (page, name) => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
};
const openPreview = async page => { const trigger = region(page).getByRole('button', { name: '列印預覽', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.getByRole('region', { name: '完整班表明細', exact: true }).waitFor(); return { dialog, trigger }; };
const delayRoute = async (page, pattern) => {
  const arrived = deferred(), release = deferred(), handled = deferred();
  await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } });
  return { arrived, release, handled };
};
await mkdir(output, { recursive: true });

try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true }); contexts.push(context);
  const stubPrint = installReportPrintCapture;
  await stubPrint(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成班表報表管理員', email: 'shift-report-admin@example.test', password, organizationName: '合成班表報表甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const fetchApi = (method, route, data, client = context, auth = admin, org = orgId) => client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => { const response = await fetchApi(method, route, data, client, auth, org); const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body; };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'SR-EA', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'SR-EB', role: 'caregiver', hourlyRateCents: 32000 });
  for (const [role, employee] of [['supervisor'], ['finance'], ['caregiver', employeeA]]) await post('users', { name: `合成報表${role}`, email: `shift-report-${role}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const loginAs = async role => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true }); contexts.push(client); await stubPrint(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `shift-report-${role}@example.test`, password } }); assert.equal(response.status(), 200);
    const auth = await response.json(), page = await client.newPage(); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), finance = await loginAs('finance'), caregiver = await loginAs('caregiver');
  const page = await context.newPage(); observe(page); lastPage = page;
  const serviceA = await post('service-items', { code: 'SR-A', name: '合成生活照顧', minutes: 30, unitPriceCents: 12000 });
  const serviceB = await post('service-items', { code: 'SR-B', name: '合成陪同外出', minutes: 30, unitPriceCents: 18000 });
  const caseA = await post('cases', { name: '合成甲個案', caseNo: 'SR-CA', phone: '0000000000', address: '合成地址不應出現在報表' });
  let caseB = await post('cases', { name: '合成乙個案', caseNo: 'SR-CB' });
  const planFor = item => post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 100 }, { serviceItemId: serviceB.id, quantity: 100 }] });
  const planA = await planFor(caseA), planB = await planFor(caseB), shifts = [];
  for (let i = 0; i < 40; i++) {
    const date = new Date(Date.UTC(2026, 9, i + 1)).toISOString().slice(0, 10), marker = `ROW-${String(i + 1).padStart(3, '0')}`;
    const note = i === 1 ? `=SUM(1,2)\n${marker} 合成"引號",逗號` : `${marker} 合成交班：到宅前先確認服務安排，離開前完成紀錄。`;
    shifts.push(await post('shifts', { caseId: i < 28 ? caseA.id : caseB.id, carePlanId: i < 28 ? planA.id : planB.id, employeeId: i < 28 ? employeeA.id : employeeB.id, date, startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 2 }], note }));
  }
  shifts[1] = await patch('shifts', shifts[1], { status: 'cancelled' });
  const record = await post('service-records', { shiftId: shifts[0].id, caseId: caseA.id, employeeId: employeeA.id, date: shifts[0].date, actualStart: '09:00', actualEnd: '10:00', services: shifts[0].services, status: 'submitted', note: '合成核閱計價快照保護' });
  await request('POST', `service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成督導核閱' }, 200, supervisor.client, supervisor.auth);
  const approved = (await request('GET', `service-records/${record.id}`)).item; assert.ok(approved.billingSnapshot);
  caseB = await patch('cases', caseB, { status: 'closed' });
  const orgB = (await request('POST', 'organizations', { name: '合成班表報表乙機構' }, 201)).item;
  const foreignCase = (await request('POST', 'cases', { name: '合成跨機構案', caseNo: 'SR-X' }, 201, context, admin, orgB.id)).item;
  const foreignEmployee = (await request('POST', 'employees', { name: '合成跨機構員工', employeeNo: 'SR-X', role: 'caregiver' }, 201, context, admin, orgB.id)).item;
  const allQuery = 'startDate=2026-10-01&endDate=2026-11-09';
  const full = () => request('GET', `shift-report/export?${allQuery}`);
  // Keep full()/allQuery as the original legacy API oracle. Only UI transport opts in.
  const uiQuery = allQuery + '&spanMode=calendar-two-day-v1&rangeMode=starts';
  const fullUi = () => request('GET', `shift-report/export?${uiQuery}`);
  const masterState = app.db.prepare("SELECT * FROM records WHERE entity != 'shifts' ORDER BY id").all();
  startReads(); const initialCounts = counts();
  let dialog, trigger;
  if (!process.env.SHIFT_REPORT_PDF_ONLY) {
  await loadReport(page); await resultRegion(page).getByText('符合條件共 31 班次；本頁 25 筆。', { exact: true }).waitFor();
  await setAllRange(page); assert.ok(await region(page).getByRole('button', { name: '下載 CSV', exact: true }).isDisabled()); assert.ok(await region(page).getByRole('button', { name: '列印預覽', exact: true }).isDisabled());
  await region(page).getByText('條件已變更，請重新查詢後再下載或列印。', { exact: true }).waitFor(); await queryReport(page, 40);
  assert.equal(await resultRegion(page).locator('tbody tr').count(), 25); await region(page).getByRole('button', { name: '下一頁', exact: true }).click(); await resultRegion(page).getByText('符合條件共 40 班次；本頁 15 筆。', { exact: true }).waitFor(); assert.equal(await resultRegion(page).locator('tbody tr').count(), 15);
  const first = await request('GET', `shift-report?${allQuery}&page=1&pageSize=25`), second = await request('GET', `shift-report?${allQuery}&page=2&pageSize=25`), complete = await full(); assert.deepEqual([...first.rows, ...second.rows], complete.rows); assert.equal(complete.total, 40); assert.equal(complete.pageSize, 40);
  await shot(page, 'report-page-two-desktop.png'); mark('跨月40班真API與25+15分頁聯集一致，總數不誤用當頁筆數；改範圍立即禁CSV/列印');

  await region(page).getByLabel('個案', { exact: true }).selectOption(caseA.id); await queryReport(page, 28);
  await region(page).getByLabel('服務人員', { exact: true }).selectOption(employeeB.id); await queryReport(page, 0); assert.ok(await region(page).getByRole('button', { name: '下載 CSV', exact: true }).isDisabled()); assert.ok(await region(page).getByRole('button', { name: '列印預覽', exact: true }).isDisabled()); await shot(page, 'report-empty-combination.png');
  await region(page).getByLabel('個案', { exact: true }).selectOption(caseB.id); await queryReport(page, 12); assert.ok(await region(page).getByLabel('個案', { exact: true }).locator(`option[value="${caseB.id}"]`).count());
  await region(page).getByLabel('個案', { exact: true }).selectOption(''); await region(page).getByLabel('服務人員', { exact: true }).selectOption('');
  for (const status of ['completed', 'cancelled']) { await region(page).getByLabel('班次狀態', { exact: true }).selectOption(status); await queryReport(page, 1); }
  await region(page).getByRole('button', { name: '清除條件', exact: true }).click(); await resultRegion(page).getByText('符合條件共 31 班次；本頁 25 筆。', { exact: true }).waitFor();
  assert.equal(await region(page).getByLabel('開始日期', { exact: true }).inputValue(), '2026-10-01'); assert.equal(await region(page).getByLabel('結束日期', { exact: true }).inputValue(), '2026-10-31');
  for (const label of ['個案', '服務人員', '班次狀態']) assert.equal(await region(page).getByLabel(label, { exact: true }).inputValue(), '');
  mark('個案/人員交集與已完成/已取消篩選真結果；結案主檔仍可查歷史；空結果禁輸出，清除回本月/全部/第1頁');

  await region(page).getByLabel('結束日期', { exact: true }).fill('2026-09-30'); await region(page).getByRole('button', { name: '查詢排班', exact: true }).click(); assert.equal(await region(page).getByLabel('結束日期', { exact: true }).getAttribute('aria-invalid'), 'true'); assert.ok(await region(page).getByLabel('結束日期', { exact: true }).evaluate(node => node === document.activeElement));
  await shot(page, 'report-date-validation.png'); await setAllRange(page); await queryReport(page, 40); await inspectLayout(page); await shot(page, 'report-filters-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await shot(page, 'report-filters-mobile.png');
  await resultRegion(page).locator('.table-scroll').evaluate(node => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = node.scrollWidth; }); await shot(page, 'report-table-mobile-after.png'); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('日期倒置保留輸入且語意錯誤/焦點正確；1440/390所有控制有label、整頁不溢出且寬表自身捲動');

  const legacyCsvResponse = await fetchApi('GET', `shift-report.csv?${allQuery}`); assert.equal(legacyCsvResponse.status(), 200);
  const legacyCsv = await legacyCsvResponse.body(); assert.deepEqual([...legacyCsv.subarray(0, 3)], [239, 187, 191]); assert.ok(legacyCsv.toString().includes('\r\n')); assert.ok(legacyCsv.toString().includes("'=SUM(1,2)")); assert.ok(legacyCsv.toString().includes('""引號""'));
  const csvResponse = await fetchApi('GET', `shift-report.csv?${uiQuery}`); assert.equal(csvResponse.status(), 200); const expectedCsv = await csvResponse.body();
  assert.match(csvResponse.headers()['content-type'], /^text\/csv/); assert.match(csvResponse.headers()['content-disposition'], /shift-report\.csv/); assert.equal(csvResponse.headers()['x-content-type-options'], 'nosniff'); assert.match(csvResponse.headers()['cache-control'], /no-store/);
  assert.deepEqual([...expectedCsv.subarray(0, 3)], [239, 187, 191]); assert.ok(expectedCsv.toString().includes('\r\n')); assert.ok(expectedCsv.toString().includes("'=SUM(1,2)")); assert.ok(expectedCsv.toString().includes('""引號""'));
  const downloadPromise = page.waitForEvent('download'); await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); const download = await downloadPromise; const csvFile = path.join(output, 'synthetic-shift-report.csv'); await download.saveAs(csvFile); assert.deepEqual(await readFile(csvFile), expectedCsv);
  mark('真瀏覽器CSV下載逐位元等於fresh API全40筆，BOM/CRLF/中文/引號/換行與公式防護、下載headers正確');

  ({ dialog, trigger } = await openPreview(page)); assert.equal(await dialog.locator('tbody tr').count(), 40); await dialog.getByText('符合條件共 40 班次；以下為完整資料。', { exact: true }).waitFor(); await inspectLayout(page); await shot(page, 'report-preview-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await shot(page, 'report-preview-mobile.png'); await dialog.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; node.scrollIntoView({ block: 'start' }); }); await shot(page, 'report-preview-mobile-after.png'); await page.setViewportSize({ width: 1440, height: 1050 }); await closeDialog(page, trigger);
  await trigger.focus(); await trigger.press('Enter'); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.locator('tbody tr').first().waitFor(); await closeDialog(page, trigger);
  verifyReads('filters/pagination/CSV/previews/keyboard'); mark('完整預覽顯示40筆/機構/條件/產生時間；1440/390內部捲動與鍵盤Enter/Escape焦點，所有讀取零DB寫入');

  ({ dialog, trigger } = await openPreview(page));
  shifts[2] = await patch('shifts', shifts[2], { employeeId: employeeB.id, note: 'ROW-003 合成預覽後改派，列印必須取最新版本。' }); intentionalMutations.push({ shiftId: shifts[2].id, version: shifts[2].version, fields: ['employeeId', 'note'] }); startReads();
  await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await page.waitForFunction(() => window.__printCalls.length === 1);
  const printed = await page.evaluate(() => window.__printCalls[0]); assert.ok(printed.text.includes(shifts[2].note)); const updatedRow = dialog.getByRole('row').filter({ hasText: 'ROW-003' }); await updatedRow.getByText(employeeB.name, { exact: true }).waitFor(); await updatedRow.getByText('2', { exact: true }).waitFor(); await shot(page, 'report-print-fresh-reassignment.png');
  assert.equal((await request('GET', `shift-report/export?${allQuery}`, undefined, 200, caregiver.client, caregiver.auth)).total, 27);
  await closeDialog(page, trigger); ({ dialog, trigger } = await openPreview(page)); await dialog.getByText(shifts[2].note, { exact: true }).waitFor(); await closeDialog(page, trigger); verifyReads('fresh-print-and-reopened-preview');
  mark('預覽後真API改派/升版，按列印前重新GET才呼叫攔截print，顯示新員工/v2/備註；重開預覽亦fresh且居服員scope即縮小');

  let tries = 0; await page.route(listPattern, route => ++tries === 1 ? fail503(route) : route.continue());
  await region(page).getByRole('button', { name: '查詢排班', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.ok(await region(page).getByRole('button', { name: '列印預覽', exact: true }).isDisabled()); await shot(page, 'report-list-retry.png'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await resultRegion(page).waitFor(); assert.equal(tries, 2); await page.unroute(listPattern);
  tries = 0; await page.route(csvPattern, route => ++tries === 1 ? fail503(route) : route.continue()); const downloadsBeforeRetry = downloads.length;
  await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(downloads.length, downloadsBeforeRetry); await shot(page, 'report-csv-retry.png'); const retryDownload = page.waitForEvent('download'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await retryDownload; assert.equal(tries, 2); await page.unroute(csvPattern);
  await page.route(csvPattern, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>synthetic wrong type</html>' })); const beforeWrongType = downloads.length; await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(downloads.length, beforeWrongType); await page.unroute(csvPattern); await queryReport(page, 40);
  await page.route(csvPattern, route => route.fulfill({ status: 200, contentType: 'text/csv', body: '' })); const beforeEmptyBody = downloads.length;
  await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByText('報表回應為空，請重試。', { exact: true }).waitFor(); assert.equal(downloads.length, beforeEmptyBody); await page.unroute(csvPattern); await queryReport(page, 40);
  await page.route(csvPattern, fail503);
  await page.evaluate(() => {
    const original = window.fetch; window.__originalReportFetch = original; let interrupted = false;
    window.fetch = async (...args) => { const response = await original(...args); if (!interrupted && String(args[0]).includes('/api/shift-report.csv?')) { interrupted = true; Object.defineProperty(response, 'json', { value: async () => { throw new DOMException('Synthetic response body interrupted', 'AbortError'); } }); } return response; };
  });
  const beforeBodyAbort = downloads.length; await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByText('報表下載逾時，請重試。', { exact: true }).waitFor(); assert.equal(downloads.length, beforeBodyAbort);
  await page.evaluate(() => { window.fetch = window.__originalReportFetch; delete window.__originalReportFetch; }); await page.unroute(csvPattern); await queryReport(page, 40);
  mark('查詢/CSV503可重試真API；錯誤MIME、空body與錯誤回應body AbortError均不下載，逾時提示且保留條件');

  ({ dialog, trigger } = await openPreview(page)); tries = 0; const printsBeforeRetry = await printCount(page); await page.route(fullPattern, route => ++tries === 1 ? fail503(route) : route.continue());
  await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(await printCount(page), printsBeforeRetry); await shot(page, 'report-print-retry.png'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.locator('tbody tr').first().waitFor(); assert.equal(await printCount(page), printsBeforeRetry); await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await page.waitForFunction(n => window.__printCalls.length === n, printsBeforeRetry + 1); assert.equal(tries, 3); await page.unroute(fullPattern); await closeDialog(page, trigger);
  ({ dialog, trigger } = await openPreview(page)); const empty = await fullUi(); empty.rows = []; empty.total = 0; empty.totals.count = 0; empty.pageSize = 0; await page.route(fullPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(empty) })); const printBeforeEmpty = await printCount(page); await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await dialog.getByText('目前已無符合條件的班次，請重新查詢。', { exact: true }).waitFor(); assert.equal(await printCount(page), printBeforeEmpty); await closeDialog(page, trigger); await page.unroute(fullPattern);
  mark('列印fresh GET503不印舊快取；重讀只恢復預覽、再按列印再fresh；當下空結果不列印');

  for (const action of ['preview', 'print']) {
    if (action === 'print') ({ dialog, trigger } = await openPreview(page)); else trigger = region(page).getByRole('button', { name: '列印預覽', exact: true });
    const delayed = await delayRoute(page, fullPattern), before = await printCount(page);
    if (action === 'preview') await trigger.click(); else await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click();
    await delayed.arrived.promise; await closeDialog(page, trigger); delayed.release.resolve(); await delayed.handled.promise; await settle(page); assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await printCount(page), before); await page.unroute(fullPattern);
  }
  const delayedList = await delayRoute(page, listPattern); await region(page).getByRole('button', { name: '查詢排班', exact: true }).click(); await delayedList.arrived.promise; await region(page).getByLabel('班次狀態', { exact: true }).selectOption('completed'); await page.unroute(listPattern); await queryReport(page, 1); delayedList.release.resolve(); await delayedList.handled.promise; await settle(page); assert.equal(await resultRegion(page).locator('tbody tr').count(), 1); await region(page).getByLabel('班次狀態', { exact: true }).selectOption(''); await queryReport(page, 40);
  mark('慢預覽/慢列印Escape取消且焦點回復、晚回應不復活/不印；舊查詢晚回應不覆蓋新status結果');

  for (const mode of ['cancel', 'type', 'route', 'organization']) {
    await loadReport(page); await setAllRange(page); await queryReport(page, 40); const delayed = await delayRoute(page, csvPattern), before = downloads.length;
    await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await delayed.arrived.promise;
    if (mode === 'cancel') await region(page).getByRole('button', { name: '取消下載', exact: true }).click();
    if (mode === 'type') await page.getByLabel('報表類型', { exact: true }).selectOption('cases');
    if (mode === 'route') await page.evaluate(() => { location.hash = '/cases'; });
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).selectOption(orgB.id);
    delayed.release.resolve(); await delayed.handled.promise; await settle(page); assert.equal(downloads.length, before); await page.unroute(csvPattern);
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).selectOption(orgId);
  }
  mark('CSV慢回應於取消/切報表類型/換route/換機構後均不下載，沒有跨條件或跨scope晚輸出');

  for (const mode of ['type', 'route', 'organization']) {
    await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page)); const delayed = await delayRoute(page, fullPattern), before = await printCount(page);
    await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await delayed.arrived.promise;
    if (mode === 'type') await page.getByLabel('報表類型', { exact: true }).evaluate(node => { node.value = 'cases'; node.dispatchEvent(new Event('change', { bubbles: true })); });
    if (mode === 'route') await page.evaluate(() => { location.hash = '/cases'; });
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, orgB.id);
    delayed.release.resolve(); await delayed.handled.promise; await settle(page); assert.equal(await printCount(page), before); await dialog.waitFor({ state: 'detached' }); await page.unroute(fullPattern);
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).selectOption(orgId);
  }
  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page));
  await page.evaluate(() => { location.hash = '/cases'; }); await dialog.waitFor({ state: 'detached' });
  mark('列印重讀期間切報表類型/route/機構不晚印且自動關閉；已載入預覽route失效亦立即撤除，不能留下舊內容供CtrlP');

  // A valid preview is still cached data: native print must not bypass the fresh-print button.
  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page));
  const beforeNativePrint = await printCount(page);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint'))); await page.emulateMedia({ media: 'print' });
  assert.ok(await page.evaluate(() => document.body.classList.contains('print-suppressed')));
  assert.deepEqual(await page.evaluate(() => [...document.body.children].filter(node => getComputedStyle(node).display !== 'none').map(node => node.tagName)), [], 'Native print hides cached report and background even when preview remains valid');
  assert.equal(await printCount(page), beforeNativePrint);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))); await page.emulateMedia({ media: null });
  assert.equal(await page.evaluate(() => document.body.classList.contains('print-suppressed')), false);
  await dialog.getByText('請使用「列印／另存 PDF」按鈕重新讀取資料後列印。', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await page.waitForFunction(n => window.__printCalls.length === n, beforeNativePrint + 1);
  await closeDialog(page, trigger);
  mark('有效預覽仍禁止原生beforeprint印快取；afterprint恢復畫面，必須按列印按鈕fresh重讀才允許輸出');

  await page.goto(`${base}/#/reports`); tries = 0; await page.route('**/api/employees?page=*&pageSize=100', route => ++tries === 1 ? fail503(route) : route.continue()); await page.getByLabel('報表類型', { exact: true }).selectOption('shifts'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.ok(await region(page).getByRole('button', { name: '查詢排班', exact: true }).isDisabled()); await shot(page, 'report-lookup-retry.png'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await resultRegion(page).waitFor(); assert.equal(tries, 2); await page.unroute('**/api/employees?page=*&pageSize=100');
  for (const actor of [supervisor, finance]) { await loadReport(actor.page); await setAllRange(actor.page); await queryReport(actor.page, 40); }
  for (const actor of [{ client: context, auth: admin }, supervisor, finance, caregiver]) {
    const expected = actor === caregiver ? 27 : 40;
    for (const suffix of ['', '/export', '.csv']) {
      const response = await fetchApi('GET', `shift-report${suffix}?${allQuery}`, undefined, actor.client, actor.auth); assert.equal(response.status(), 200);
      if (suffix !== '.csv') { const body = await response.json(); assert.equal(body.total, expected); for (const row of body.rows) assert.deepEqual(Object.keys(row).sort(), ['shiftId','version','date','caseNo','case','employeeNo','employee','startTime','endTime','services','status','statusLabel','note'].sort()); }
      for (const [key, value] of [['caseId', foreignCase.id], ['employeeId', foreignEmployee.id]]) assert.equal((await fetchApi('GET', `shift-report${suffix}?${allQuery}&${key}=${value}`, undefined, actor.client, actor.auth)).status(), 404);
    }
  }
  for (const suffix of ['', '/export', '.csv']) assert.equal((await fetchApi('GET', `shift-report${suffix}?${allQuery}&employeeId=${employeeB.id}`, undefined, caregiver.client, caregiver.auth)).status(), 404);
  await caregiver.page.goto(`${base}/#/reports`); await caregiver.page.waitForLoadState('networkidle'); assert.equal(await caregiver.page.getByLabel('報表類型', { exact: true }).count(), 0); assert.equal(await caregiver.page.getByRole('link', { name: '報表中心', exact: true }).count(), 0);
  const emptyApi = await request('GET', 'shift-report/export?startDate=2026-12-01&endDate=2026-12-02'); assert.deepEqual(emptyApi.rows, []); assert.equal(emptyApi.pageSize, 0);
  verifyReads('retries-cancellation-context-and-roles'); mark('lookup503先禁查詢可重試；管理/督導/財務40班、居服員僅27班且無報表入口；三端跨機構/他人filter404，投影不含電話/地址/計價');

  }
  // One QA-only PDF from DOM captured synchronously inside a fresh authorized print.
  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page)); await dialog.getByText(shifts[2].note, { exact: true }).waitFor();
  const expectedPdf = await fullUi(); await writeFile(path.join(output, 'pdf-expected.json'), JSON.stringify(expectedPdf, null, 2));
  const marker = process.env.HOME_CARE_QA_PDF_MARKER;
  if (marker && !process.env.PDF_OPERATION_ALREADY_MARKED) { const markerResult = spawnSync(process.execPath, [marker, '--operation-kind', 'create', '--expected-output-count', '1', '--output-format', 'pdf'], { encoding: 'utf8' }); assert.equal(markerResult.status, 0, markerResult.stderr); console.log(markerResult.stdout.trim()); }
  const pdfPath = path.join(output, 'synthetic-shift-report.pdf');
  const pdfProvenance = await renderCapturedReportPdf({ browser, page, path: pdfPath });
  await writeFile(path.join(output, 'pdf-provenance.json'), JSON.stringify(pdfProvenance, null, 2));
  const py = process.env.HOME_CARE_QA_PYTHON || 'python3';
  const audit = spawnSync(py, ['-c', `import json, pathlib, re, sys, logging, unicodedata, pdfplumber
logging.getLogger('pdfminer').setLevel(logging.ERROR)
p=pathlib.Path(sys.argv[1]); expected=json.loads((p/'pdf-expected.json').read_text()); findings=[]
with pdfplumber.open(p/'synthetic-shift-report.pdf') as pdf:
 texts=[unicodedata.normalize('NFKC',page.extract_text() or '') for page in pdf.pages]
 assert len(texts)>1, 'Expected multi-page QA PDF'
 combined='\\n\\n'.join(texts); compact=re.sub(r'\\s+','',combined)
 for row in expected['rows']:
  assert row['endDate'].replace('-','/') in compact, ('Missing explicit ending date',row['endDate'])
 for index in range(1,41):
  marker=f'ROW-{index:03d}'; assert compact.count(marker)==1, (marker,compact.count(marker))
 for i,page in enumerate(pdf.pages):
  text=re.sub(r'\\s+','',texts[i]); assert text and len(text)>80, ('Blank page',i+1)
  assert page.width>page.height and abs(page.width-841.89)<3 and abs(page.height-595.28)<3, ('Not landscape A4',i,page.width,page.height)
  for header in ['日期','案號','員工編號','交班備註','結束日期']: assert header in text, ('Missing repeated table header',i+1,header)
  for forbidden in ['報表中心','列印／另存PDF','查詢排班','清除條件','測試工作空間']: assert forbidden not in text, ('Background UI',i+1,forbidden)
  assert '\\ufffd' not in text and '\\u25a1' not in text, ('Missing glyph',i+1)
  chars=page.chars
  assert all(c['x0']>=20 and c['x1']<=page.width-20 and c['top']>=15 and c['bottom']<=page.height-15 for c in chars), ('Text outside safe printable bounds',i+1)
  findings.append({'page':i+1,'width':page.width,'height':page.height,'characters':len(chars),'rowMarkers':re.findall(r'ROW-\\d{3}',text),'headersRepeated':True,'boundsSafe':True})
 (p/'pdf-text.txt').write_text(combined)
 (p/'pdf-review.json').write_text(json.dumps({'passed':True,'pages':findings,'all40RowMarkersExactlyOnce':True,'latestVersionIncluded':'ROW-003合成預覽後改派' in compact,'noBackgroundUI':True,'visualReviewRequired':True},ensure_ascii=False,indent=2))
 print(json.dumps({'pageCount':len(texts),'rowCount':40}))`, output], { encoding: 'utf8' }); assert.equal(audit.status, 0, audit.stderr); console.log(audit.stdout.trim());
  const poppler = process.env.HOME_CARE_QA_PDFTOPPM || 'pdftoppm';
  for (const name of await readdir(output)) if (/^pdf-(?:page|initial)-\d+\.png$/.test(name)) await rm(path.join(output, name));
  const render = spawnSync(poppler, ['-r', '110', '-png', pdfPath, path.join(output, 'pdf-page')], { encoding: 'utf8' }); assert.equal(render.status, 0, render.stderr);
  await closeDialog(page, trigger); verifyReads('PDF-generation-and-full-text-validation'); assert.deepEqual(app.db.prepare("SELECT * FROM records WHERE entity != 'shifts' ORDER BY id").all(), masterState); assert.deepEqual((await request('GET', `service-records/${record.id}`)).item, approved);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /503/.test(message)), JSON.stringify(consoleErrors));
  mark('單一合成多頁PDF文字驗40筆各一次、每頁表頭、A4橫向安全邊界、無背景UI/空白頁；所有讀取完整DB與billing不變，僅1次刻意改派寫入');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, pdfOnly: Boolean(process.env.SHIFT_REPORT_PDF_ONLY), completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium / intercepted window.print', checks, screenshots, pdf: 'synthetic-shift-report.pdf', pdfPages: (await readdir(output)).filter(name => /^pdf-page-\d+\.png$/.test(name)), pageErrors, consoleErrors, failedResponses, downloads, initialCounts, finalCounts: counts(), readSegments, intentionalMutations, nonShiftMastersAndBillingUnchanged: true, visualReviewPending: true }, null, 2));
  console.log(`Shift report E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, intentionalMutations, error: error.stack }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
