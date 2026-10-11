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
import { insert } from '../src/server/model.mjs';

// All fixtures and mutations below use only this process's memory SQLite and random port.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/service-report-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [], readSegments = [], intentionalMutations = [], downloads = [];
const password = 'synthetic-service-report-password';
let totalMinutes = 1802;
const noteMinutes = n => n === 40 ? totalMinutes : n === 31 ? 1397 : n === 28 ? 1262 : n === 12 ? 540 : n * 45;
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
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const startReads = () => { readBaseline = counts(); stateBaseline = rawState(); };
const verifyReads = label => { assert.deepEqual(counts(), readBaseline); assert.deepEqual(rawState(), stateBaseline); readSegments.push({ label, before: readBaseline, after: counts(), allStateUnchanged: true }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const fail503 = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_RETRY', message: '合成報表暫時無法取得，請重試。' } }) });
const listPattern = '**/api/service-report?*', fullPattern = '**/api/service-report/export?*', csvPattern = '**/api/service-report.csv?*';
const region = page => page.getByRole('region', { name: '服務紀錄明細查詢', exact: true });
const resultRegion = page => page.getByRole('region', { name: '服務紀錄查詢結果', exact: true });
const previewTitle = '服務紀錄明細列印預覽';
const printCount = page => page.evaluate(() => window.__printCalls.length);
const closeDialog = async (page, trigger) => { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); if (trigger) assert.ok(await trigger.evaluate(node => node === document.activeElement)); };
const queryReport = async (page, expected, minutes = noteMinutes(expected)) => {
  await region(page).getByRole('button', { name: '查詢紀錄', exact: true }).click();
  await resultRegion(page).getByText(`符合條件共 ${expected} 筆紀錄；實際分鐘合計 ${minutes} 分鐘；本頁 ${Math.min(expected, 25)} 筆。`, { exact: true }).waitFor();
};
const setAllRange = async page => {
  await region(page).getByLabel('開始日期', { exact: true }).fill('2026-10-01');
  await region(page).getByLabel('結束日期', { exact: true }).fill('2026-11-09');
};
const loadReport = async page => {
  lastPage = page;
  if (page.url() === `${base}/#/reports`) await page.reload(); else await page.goto(`${base}/#/reports`);
  await page.getByRole('heading', { name: '報表中心', exact: true, level: 1 }).waitFor();
  await page.getByLabel('報表類型', { exact: true }).selectOption('services');
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
  for (const table of await page.locator('.service-report-table:visible').all()) {
    assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
    if (await table.evaluate(node => node.scrollWidth > node.clientWidth)) { await table.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert.ok(await table.evaluate(node => node.scrollLeft > 0)); await table.evaluate(node => { node.scrollLeft = 0; }); }
  }
};
const shot = async (page, name) => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
};
const openPreview = async page => { const trigger = region(page).getByRole('button', { name: '列印預覽', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.getByRole('region', { name: '完整服務紀錄明細', exact: true }).waitFor(); return { dialog, trigger }; };
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
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成服務報表管理員', email: 'service-report-admin@example.test', password, organizationName: '合成服務報表甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const fetchApi = (method, route, data, client = context, auth = admin, org = orgId) => client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => { const response = await fetchApi(method, route, data, client, auth, org); const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body; };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'SR-EA', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'SR-EB', role: 'caregiver', hourlyRateCents: 32000 });
  for (const [role, employee] of [['supervisor'], ['finance'], ['caregiver', employeeA]]) await post('users', { name: `合成報表${role}`, email: `service-report-${role}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const loginAs = async role => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true }); contexts.push(client); await stubPrint(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `service-report-${role}@example.test`, password } }); assert.equal(response.status(), 200);
    const auth = await response.json(), page = await client.newPage(); await page.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), finance = await loginAs('finance'), caregiver = await loginAs('caregiver');
  const page = await context.newPage(); await page.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(page); lastPage = page;
  const serviceA = await post('service-items', { code: 'SR-A', name: '合成生活照顧', minutes: 30, unitPriceCents: 12000 });
  const serviceB = await post('service-items', { code: 'SR-B', name: '合成陪同外出', minutes: 30, unitPriceCents: 18000 });
  const caseA = await post('cases', { name: '合成甲個案', caseNo: 'SR-CA', phone: '0000000000', address: '合成地址不應出現在報表' });
  let caseB = await post('cases', { name: '合成乙個案', caseNo: 'SR-CB' });
  const planFor = item => post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 100 }, { serviceItemId: serviceB.id, quantity: 100 }] });
  const planA = await planFor(caseA), planB = await planFor(caseB), shifts = [], records = [];
  for (let i = 0; i < 40; i++) {
    const date = new Date(Date.UTC(2026, 9, i + 1)).toISOString().slice(0, 10);
    shifts.push(await post('shifts', { caseId: i < 28 ? caseA.id : caseB.id, carePlanId: i < 28 ? planA.id : planB.id, employeeId: i < 28 ? employeeA.id : employeeB.id, date, startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 2 }], note: '合成排班60分鐘，數量1與2，不能當作實際紀錄' }));
    if (!i) { records.push(null); continue; }
    const marker = `REC-${String(i + 1).padStart(3, '0')}`;
    const note = i === 1 ? `=SUM(1,2)\n${marker} 合成"引號",逗號` : `${marker} 合成服務觀察：到宅完成照顧，已向家屬說明本次情形。`;
    const actualStart = i === 4 ? `${date}T09:05:29+08:00` : '09:05', actualEnd = i === 4 ? `${date}T09:50:59+08:00` : '09:50';
    let record = await post('service-records', { shiftId: shifts[i].id, caseId: shifts[i].caseId, employeeId: shifts[i].employeeId, date, actualStart, actualEnd, services: [{ serviceItemId: serviceA.id, quantity: 3 }, { serviceItemId: serviceB.id, quantity: 1 }], status: i <= 10 ? 'draft' : 'submitted', note });
    if (i >= 21) record = (await request('POST', `service-records/${record.id}/review`, { version: record.version, decision: i <= 30 ? 'returned' : 'approved', reviewNote: i <= 30 ? '合成督導退回：請補充服務情形。' : '合成督導確認紀錄完整。' }, 200, supervisor.client, supervisor.auth)).item;
    records.push(record);
  }
  // Real caregiver and supervisor UI exercise the whole lifecycle, never importing an approved state.
  const loadWork = async (p, route, title) => { lastPage = p; if (p.url() === `${base}/#${route}`) await p.reload(); else await p.goto(`${base}/#${route}`); await p.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor(); await p.waitForLoadState('networkidle'); };
  const saveForm = async p => { const d = p.getByRole('dialog'); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.waitFor({ state: 'detached' }); };
  const ownCard = caregiver.page.locator('.service-card').filter({ hasText: caseA.name });
  await loadWork(caregiver.page, '/my-services', '我的服務'); await caregiver.page.getByLabel('服務日期', { exact: true }).fill('2026-10-01'); await ownCard.getByRole('button', { name: '填寫服務紀錄', exact: true }).click();
  let form = caregiver.page.getByRole('dialog'); await form.getByLabel('實際開始時間', { exact: false }).fill('09:05'); await form.getByLabel('實際結束時間', { exact: false }).fill('09:50');
  await form.getByLabel('SR-A 合成生活照顧 數量', { exact: true }).fill('3'); await form.getByLabel('SR-B 合成陪同外出 數量', { exact: true }).fill('1'); await form.getByLabel('服務紀錄與觀察', { exact: true }).fill('REC-001 合成初版草稿'); await saveForm(caregiver.page);
  records[0] = (await request('GET', 'service-records?date=2026-10-01')).items.find(item => item.shiftId === shifts[0].id); assert.equal(records[0].status, 'draft'); assert.equal(records[0].version, 1);
  await ownCard.getByRole('button', { name: '繼續填寫草稿', exact: true }).click(); await caregiver.page.getByRole('dialog').getByLabel('儲存方式', { exact: false }).selectOption('submitted'); await saveForm(caregiver.page);
  await loadWork(supervisor.page, '/records', '服務紀錄與核閱'); await supervisor.page.getByLabel('日期範圍', { exact: true }).selectOption('day'); await supervisor.page.getByLabel('服務日期', { exact: true }).fill('2026-10-01'); await supervisor.page.getByRole('row').filter({ hasText: caseA.name }).getByRole('button', { name: '核閱', exact: true }).click();
  form = supervisor.page.getByRole('dialog'); await form.getByLabel('核閱結果', { exact: false }).selectOption('returned'); await form.getByLabel('核閱說明', { exact: true }).fill('合成督導退回：請補充實際結束時間與服務觀察。'); await saveForm(supervisor.page);
  await loadWork(caregiver.page, '/my-services', '我的服務'); await caregiver.page.getByLabel('服務日期', { exact: true }).fill('2026-10-01'); await ownCard.getByRole('button', { name: '修正退回紀錄', exact: true }).click();
  form = caregiver.page.getByRole('dialog'); await form.getByLabel('實際開始時間', { exact: false }).fill('09:04'); await form.getByLabel('實際結束時間', { exact: false }).fill('09:51'); await form.getByLabel('服務紀錄與觀察', { exact: true }).fill('REC-001 合成退回修正後實際47分鐘，照顧與交班已完成。'); await form.getByLabel('儲存方式', { exact: false }).selectOption('submitted'); await saveForm(caregiver.page);
  await loadWork(supervisor.page, '/records', '服務紀錄與核閱'); await supervisor.page.getByLabel('日期範圍', { exact: true }).selectOption('day'); await supervisor.page.getByLabel('服務日期', { exact: true }).fill('2026-10-01'); await supervisor.page.getByRole('row').filter({ hasText: caseA.name }).getByRole('button', { name: '核閱', exact: true }).click(); await supervisor.page.getByRole('dialog').getByLabel('核閱說明', { exact: true }).fill('合成督導再次核閱通過。'); await saveForm(supervisor.page);
  records[0] = (await request('GET', `service-records/${records[0].id}`)).item; assert.equal(records[0].status, 'approved'); assert.equal(records[0].version, 5); assert.equal(records[0].billingSnapshot.serviceMinutes, 47);
  const lifecycle = await request('GET', `service-records/${records[0].id}/history`); assert.deepEqual(lifecycle.items.map(row => row.snapshot.status), ['approved','submitted','returned','submitted','draft']);
  assert.equal((await request('GET', `shifts/${shifts[0].id}`)).item.status, 'completed');
  mark('真居服員與督導UI完整草稿v1→提交v2→退回v3→修正重送v4→核閱v5；實際47分鐘、3+1數量，不採排班60分鐘/1+2');
  const approved = structuredClone(records[0]), oldFee = await request('GET', 'reports/fees?month=2026-10'), oldPayroll = await request('GET', 'reports/payroll?month=2026-10');
  await patch('service-items', serviceA, { name: '合成生活照顧新版名稱', unitPriceCents: 99000 }); await patch('employees', employeeA, { hourlyRateCents: 88000 });
  assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), oldFee); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), oldPayroll); assert.deepEqual((await request('GET', `service-records/${records[0].id}`)).item, approved);
  caseB = await patch('cases', caseB, { status: 'closed' });
  mark('核閱後真API修改服務名稱/單價及員工時薪，原billingSnapshot與舊費用/薪資報表完全不變');
  const orgB = (await request('POST', 'organizations', { name: '合成服務報表乙機構' }, 201)).item;
  const foreignCase = (await request('POST', 'cases', { name: '合成跨機構案', caseNo: 'SR-X' }, 201, context, admin, orgB.id)).item;
  const foreignEmployee = (await request('POST', 'employees', { name: '合成跨機構員工', employeeNo: 'SR-X', role: 'caregiver' }, 201, context, admin, orgB.id)).item;
  // Historical-import fixtures are explicit exceptions, outside the 40-row main report range.
  const legacyShift = await post('shifts', { caseId: caseA.id, carePlanId: planA.id, employeeId: employeeA.id, date: '2026-12-10', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: serviceA.id, quantity: 1 }], note: '合成歷史匯入基礎班次' });
  const legacy = insert(app.db, orgId, 'service-records', { shiftId: legacyShift.id, caseId: caseA.id, employeeId: employeeA.id, date: legacyShift.date, actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: serviceA.id, quantity: 1 }], status: 'approved', note: '合成歷史匯入未保留計價快照，非正常核閱流程' });
  // Explicit invalid import is isolated under its own real membership/parents.
  // New complete-date readers must close this entire organization, even when the
  // bad row's December date is outside the requested October interval.
  const invalidOrg = (await request('POST', 'organizations', { name: '合成錯誤歷史匯入隔離機構' }, 201)).item;
  const invalidPost = async (entity, data) => (await request('POST', entity, data, 201, context, admin, invalidOrg.id)).item;
  const invalidCase = await invalidPost('cases', { name: '合成錯誤匯入個案', caseNo: 'SR-INVALID-C' });
  const invalidEmployee = await invalidPost('employees', { name: '合成錯誤匯入員工', employeeNo: 'SR-INVALID-E', role: 'caregiver' });
  const invalidService = await invalidPost('service-items', { code: 'SR-INVALID-S', name: '合成錯誤匯入服務', minutes: 30, unitPriceCents: 12000 });
  const invalidPlan = await invalidPost('care-plans', { caseId: invalidCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: invalidService.id, quantity: 100 }] });
  const invalidShift = await invalidPost('shifts', { caseId: invalidCase.id, carePlanId: invalidPlan.id, employeeId: invalidEmployee.id, date: '2026-12-10', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: invalidService.id, quantity: 1 }], note: '合成錯誤歷史匯入基礎班次' });
  const invalidLegacy = insert(app.db, invalidOrg.id, 'service-records', { shiftId: invalidShift.id, caseId: invalidCase.id, employeeId: invalidEmployee.id, date: '2026-12-11', actualStart: 'invalid', actualEnd: '09:50', services: [{ serviceItemId: invalidService.id, quantity: 1 }], status: 'draft', note: '合成錯誤歷史時間匯入，非正常寫入流程' });
  const allQuery = 'startDate=2026-10-01&endDate=2026-11-09';
  const full = () => request('GET', `service-report/export?${allQuery}`);
  // Keep full()/allQuery as the original legacy API oracle. Only UI transport opts in.
  const uiQuery = allQuery + '&spanMode=calendar-two-day-v1';
  const fullUi = () => request('GET', `service-report/export?${uiQuery}`);
  const masterState = app.db.prepare("SELECT * FROM records WHERE entity NOT IN ('shifts','service-records') ORDER BY id").all();
  startReads(); const initialCounts = counts();
  const legacyRead = await request('GET', 'service-report/export?startDate=2026-12-10&endDate=2026-12-10'); assert.equal(legacyRead.total, 1); assert.equal(legacyRead.rows[0].recordId, legacy.id); assert.equal(legacyRead.totals.serviceMinutes, 45);
  await request('GET', 'reports/fees?month=2026-12', undefined, 409); await request('GET', 'reports/payroll?month=2026-12', undefined, 409);
  for (const suffix of ['', '/export', '.csv']) { const response = await request('GET', `service-report${suffix}?startDate=2026-12-11&endDate=2026-12-11`, undefined, 409, context, admin, invalidOrg.id); assert.equal(response.error.code, 'REPORT_DATA_INVALID'); assert.ok(!JSON.stringify(response).includes(invalidLegacy.id)); }
  const invalidOutsideLegacy = await request('GET', `service-report/export?${allQuery}`, undefined, 200, context, admin, invalidOrg.id); assert.equal(invalidOutsideLegacy.total, 0, 'Original legacy date selection still excludes the bad outside-date row');
  for (const suffix of ['', '/export', '.csv']) {
    const rejected = await request('GET', `service-report${suffix}?${uiQuery}`, undefined, 409, context, admin, invalidOrg.id);
    assert.equal(rejected.error.code, 'SPAN_DATA_INVALID'); assert.ok(!JSON.stringify(rejected).includes(invalidLegacy.id), 'Closed opt-in error does not reveal the corrupt row');
    for (const actor of [supervisor, finance, caregiver]) await request('GET', `service-report${suffix}?${uiQuery}`, undefined, 403, actor.client, actor.auth, invalidOrg.id);
  }
  verifyReads('legacy-valid-without-pricing-and-invalid-time-and-opt-in-whole-org-closed'); mark('獨立歷史匯入fixture：缺計價快照仍可讀45分鐘的非財務報表，舊fees/payroll409；非法時間三端409無部分資料或寫入');

  let dialog, trigger;
  if (!process.env.SERVICE_REPORT_PDF_ONLY) {
  await loadReport(page); await resultRegion(page).getByText('符合條件共 31 筆紀錄；實際分鐘合計 1397 分鐘；本頁 25 筆。', { exact: true }).waitFor();
  await setAllRange(page); assert.ok(await region(page).getByRole('button', { name: '下載 CSV', exact: true }).isDisabled()); assert.ok(await region(page).getByRole('button', { name: '列印預覽', exact: true }).isDisabled());
  await region(page).getByText('條件已變更，請重新查詢後再下載或列印。', { exact: true }).waitFor(); await queryReport(page, 40);
  const firstRow = (await full()).rows[0]; assert.equal(firstRow.serviceMinutes, 47); assert.equal(firstRow.version, 5); assert.ok(firstRow.services.includes('× 3') && firstRow.services.includes('× 1')); assert.ok(firstRow.services.includes('合成生活照顧新版名稱')); const isoRow = (await full()).rows[4]; assert.equal(isoRow.serviceMinutes, 45); assert.ok(isoRow.actualStart.endsWith('+08:00'));
  assert.equal(await resultRegion(page).locator('tbody tr').count(), 25); await region(page).getByRole('button', { name: '下一頁', exact: true }).click(); await resultRegion(page).getByText('符合條件共 40 筆紀錄；實際分鐘合計 1802 分鐘；本頁 15 筆。', { exact: true }).waitFor(); assert.equal(await resultRegion(page).locator('tbody tr').count(), 15);
  const first = await request('GET', `service-report?${allQuery}&page=1&pageSize=25`), second = await request('GET', `service-report?${allQuery}&page=2&pageSize=25`), complete = await full(); assert.deepEqual([...first.rows, ...second.rows], complete.rows); assert.equal(complete.total, 40); assert.equal(complete.pageSize, 40);
  await shot(page, 'report-page-two-desktop.png'); mark('跨月40筆真API與25+15分頁聯集一致，總數不誤用當頁筆數；改範圍立即禁CSV/列印');

  await region(page).getByLabel('個案', { exact: true }).selectOption(caseA.id); await queryReport(page, 28);
  await region(page).getByLabel('服務人員', { exact: true }).selectOption(employeeB.id); await queryReport(page, 0); assert.ok(await region(page).getByRole('button', { name: '下載 CSV', exact: true }).isDisabled()); assert.ok(await region(page).getByRole('button', { name: '列印預覽', exact: true }).isDisabled()); await shot(page, 'report-empty-combination.png');
  await region(page).getByLabel('個案', { exact: true }).selectOption(caseB.id); await queryReport(page, 12); assert.ok(await region(page).getByLabel('個案', { exact: true }).locator(`option[value="${caseB.id}"]`).count());
  await region(page).getByLabel('個案', { exact: true }).selectOption(''); await region(page).getByLabel('服務人員', { exact: true }).selectOption('');
  for (const status of ['draft', 'submitted', 'returned', 'approved']) { await region(page).getByLabel('核閱狀態', { exact: true }).selectOption(status); await queryReport(page, 10, status === 'approved' ? 452 : 450); }
  await region(page).getByRole('button', { name: '清除條件', exact: true }).click(); await resultRegion(page).getByText('符合條件共 31 筆紀錄；實際分鐘合計 1397 分鐘；本頁 25 筆。', { exact: true }).waitFor();
  assert.equal(await region(page).getByLabel('開始日期', { exact: true }).inputValue(), '2026-10-01'); assert.equal(await region(page).getByLabel('結束日期', { exact: true }).inputValue(), '2026-10-31');
  for (const label of ['個案', '服務人員', '核閱狀態']) assert.equal(await region(page).getByLabel(label, { exact: true }).inputValue(), '');
  mark('個案/人員交集與四種核閱狀態篩選真結果；結案主檔仍可查歷史；空結果禁輸出，清除回本月/全部/第1頁');

  await region(page).getByLabel('結束日期', { exact: true }).fill('2026-09-30'); await region(page).getByRole('button', { name: '查詢紀錄', exact: true }).click(); assert.equal(await region(page).getByLabel('結束日期', { exact: true }).getAttribute('aria-invalid'), 'true'); assert.ok(await region(page).getByLabel('結束日期', { exact: true }).evaluate(node => node === document.activeElement));
  await shot(page, 'report-date-validation.png'); await setAllRange(page); await queryReport(page, 40); await inspectLayout(page); await shot(page, 'report-filters-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await shot(page, 'report-filters-mobile.png');
  await resultRegion(page).locator('.table-scroll').evaluate(node => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = node.scrollWidth; }); await shot(page, 'report-table-mobile-after.png'); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('日期倒置保留輸入且語意錯誤/焦點正確；1440/390所有控制有label、整頁不溢出且寬表自身捲動');

  const legacyCsvResponse = await fetchApi('GET', `service-report.csv?${allQuery}`); assert.equal(legacyCsvResponse.status(), 200);
  const legacyCsv = await legacyCsvResponse.body(); assert.deepEqual([...legacyCsv.subarray(0, 3)], [239, 187, 191]); assert.ok(legacyCsv.toString().includes('\r\n')); assert.ok(legacyCsv.toString().includes("'=SUM(1,2)")); assert.ok(legacyCsv.toString().includes('""引號""'));
  const csvResponse = await fetchApi('GET', `service-report.csv?${uiQuery}`); assert.equal(csvResponse.status(), 200); const expectedCsv = await csvResponse.body();
  assert.match(csvResponse.headers()['content-type'], /^text\/csv/); assert.match(csvResponse.headers()['content-disposition'], /service-report\.csv/); assert.equal(csvResponse.headers()['x-content-type-options'], 'nosniff'); assert.match(csvResponse.headers()['cache-control'], /no-store/);
  assert.deepEqual([...expectedCsv.subarray(0, 3)], [239, 187, 191]); assert.ok(expectedCsv.toString().includes('\r\n')); assert.ok(expectedCsv.toString().includes("'=SUM(1,2)")); assert.ok(expectedCsv.toString().includes('""引號""'));
  const downloadPromise = page.waitForEvent('download'); await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); const download = await downloadPromise; const csvFile = path.join(output, 'synthetic-service-report.csv'); await download.saveAs(csvFile); assert.deepEqual(await readFile(csvFile), expectedCsv);
  mark('真瀏覽器CSV下載逐位元等於fresh API全40筆，BOM/CRLF/中文/引號/換行與公式防護、下載headers正確');

  ({ dialog, trigger } = await openPreview(page)); assert.equal(await dialog.locator('tbody tr').count(), 40); await dialog.getByText('符合條件共 40 筆紀錄；實際分鐘合計 1802 分鐘；以下為完整資料。', { exact: true }).waitFor(); await inspectLayout(page); await shot(page, 'report-preview-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await shot(page, 'report-preview-mobile.png'); await dialog.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; node.scrollIntoView({ block: 'start' }); }); await shot(page, 'report-preview-mobile-after.png'); await page.setViewportSize({ width: 1440, height: 1050 }); await closeDialog(page, trigger);
  await trigger.focus(); await trigger.press('Enter'); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.locator('tbody tr').first().waitFor(); await closeDialog(page, trigger);
  verifyReads('filters/pagination/CSV/previews/keyboard'); mark('完整預覽顯示40筆/機構/條件/產生時間；1440/390內部捲動與鍵盤Enter/Escape焦點，所有讀取零DB寫入');

  ({ dialog, trigger } = await openPreview(page));
  const stages = [
    { status: 'returned', run: () => request('POST', `service-records/${records[11].id}/review`, { version: records[11].version, decision: 'returned', reviewNote: '合成預覽後督導退回，請核對分鐘。' }, 200, supervisor.client, supervisor.auth) },
    { status: 'submitted', run: () => request('PATCH', `service-records/${records[11].id}`, { version: records[11].version, status: 'submitted', actualStart: '09:03', actualEnd: '09:58', services: [{ serviceItemId: serviceA.id, quantity: 4 }, { serviceItemId: serviceB.id, quantity: 2 }], note: 'REC-012 合成預覽後修正55分鐘與數量，已重送。' }, 200, caregiver.client, caregiver.auth) },
    { status: 'approved', run: () => request('POST', `service-records/${records[11].id}/review`, { version: records[11].version, decision: 'approved', reviewNote: '合成督導核對55分鐘後核閱通過。' }, 200, supervisor.client, supervisor.auth) },
  ];
  for (const stage of stages) {
    verifyReads(`before-intentional-${stage.status}`); const before = counts(); records[11] = (await stage.run()).item; intentionalMutations.push({ recordId: records[11].id, status: stage.status, version: records[11].version, before, after: counts() }); startReads();
    const prints = await printCount(page); await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await page.waitForFunction(n => window.__printCalls.length === n, prints + 1);
    const printed = await page.evaluate(() => window.__printCalls.at(-1)); assert.ok(printed.text.includes(records[11].note)); const row = dialog.getByRole('row').filter({ hasText: 'REC-012' }); await row.getByText(String(records[11].version), { exact: true }).waitFor();
    await row.getByText({ returned: '退回修改', submitted: '待核閱', approved: '已核准' }[stage.status], { exact: true }).waitFor(); if (stage.status !== 'returned') await row.getByText('55', { exact: true }).waitFor();
    verifyReads(`fresh-print-${stage.status}`);
  }
  await dialog.getByText('符合條件共 40 筆紀錄；實際分鐘合計 1812 分鐘；以下為完整資料。', { exact: true }).waitFor();
  await dialog.getByRole('row').filter({ hasText: 'REC-012' }).evaluate(node => node.scrollIntoView({ block: 'center' })); await dialog.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; }); await shot(page, 'report-print-fresh-review.png');
  await closeDialog(page, trigger); totalMinutes = 1812; await queryReport(page, 40, 1812); ({ dialog, trigger } = await openPreview(page)); await dialog.getByText(records[11].reviewNote, { exact: true }).waitFor(); await closeDialog(page, trigger); verifyReads('fresh-approval-and-reopened-preview');
  mark('預覽後真API退回v2/修正55分鐘及數量重送v3/核閱v4，各次列印fresh後才print；最新總分鐘1812及核閱意見正確');

  let tries = 0; await page.route(listPattern, route => ++tries === 1 ? fail503(route) : route.continue());
  await region(page).getByRole('button', { name: '查詢紀錄', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.ok(await region(page).getByRole('button', { name: '列印預覽', exact: true }).isDisabled()); await shot(page, 'report-list-retry.png'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await resultRegion(page).waitFor(); assert.equal(tries, 2); await page.unroute(listPattern);
  tries = 0; await page.route(csvPattern, route => ++tries === 1 ? fail503(route) : route.continue()); const downloadsBeforeRetry = downloads.length;
  await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(downloads.length, downloadsBeforeRetry); await shot(page, 'report-csv-retry.png'); const retryDownload = page.waitForEvent('download'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await retryDownload; assert.equal(tries, 2); await page.unroute(csvPattern);
  await page.route(csvPattern, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>synthetic wrong type</html>' })); const beforeWrongType = downloads.length; await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(downloads.length, beforeWrongType); await page.unroute(csvPattern); await queryReport(page, 40);
  await page.route(csvPattern, route => route.fulfill({ status: 200, contentType: 'text/csv', body: '' })); const beforeEmptyBody = downloads.length;
  await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByText('報表回應為空，請重試。', { exact: true }).waitFor(); assert.equal(downloads.length, beforeEmptyBody); await page.unroute(csvPattern); await queryReport(page, 40);
  await page.route(csvPattern, fail503);
  await page.evaluate(() => {
    const original = window.fetch; window.__originalReportFetch = original; let interrupted = false;
    window.fetch = async (...args) => { const response = await original(...args); if (!interrupted && String(args[0]).includes('/api/service-report.csv?')) { interrupted = true; Object.defineProperty(response, 'json', { value: async () => { throw new DOMException('Synthetic response body interrupted', 'AbortError'); } }); } return response; };
  });
  const beforeBodyAbort = downloads.length; await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByText('報表下載逾時，請重試。', { exact: true }).waitFor(); assert.equal(downloads.length, beforeBodyAbort);
  await page.evaluate(() => { window.fetch = window.__originalReportFetch; delete window.__originalReportFetch; }); await page.unroute(csvPattern); await queryReport(page, 40);
  mark('查詢/CSV503可重試真API；錯誤MIME、空body與錯誤回應body AbortError均不下載，逾時提示且保留條件');

  ({ dialog, trigger } = await openPreview(page)); tries = 0; const printsBeforeRetry = await printCount(page); await page.route(fullPattern, route => ++tries === 1 ? fail503(route) : route.continue());
  await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(await printCount(page), printsBeforeRetry); await shot(page, 'report-print-retry.png'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.locator('tbody tr').first().waitFor(); assert.equal(await printCount(page), printsBeforeRetry); await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await page.waitForFunction(n => window.__printCalls.length === n, printsBeforeRetry + 1); assert.equal(tries, 3); await page.unroute(fullPattern); await closeDialog(page, trigger);
  ({ dialog, trigger } = await openPreview(page)); const empty = await fullUi(); empty.rows = []; empty.total = 0; empty.totals.count = 0; empty.totals.serviceMinutes = 0; empty.pageSize = 0; await page.route(fullPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(empty) })); const printBeforeEmpty = await printCount(page); await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await dialog.getByText('目前已無符合條件的紀錄，請重新查詢。', { exact: true }).waitFor(); assert.equal(await printCount(page), printBeforeEmpty); await closeDialog(page, trigger); await page.unroute(fullPattern);
  const malformed = await fullUi(); malformed.totals.serviceMinutes += 1; const beforeMalformed = await printCount(page);
  await page.route(fullPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(malformed) })); await region(page).getByRole('button', { name: '列印預覽', exact: true }).click(); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.getByRole('alert').waitFor(); assert.ok(await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).isDisabled()); assert.equal(await dialog.locator('tbody tr').count(), 0); assert.equal(await printCount(page), beforeMalformed); await closeDialog(page); await page.unroute(fullPattern);
  mark('列印fresh GET503不印舊快取；重讀只恢復預覽、再按列印再fresh；空結果與全數分鐘不符的DTO皆不列印');

  for (const action of ['preview', 'print']) {
    if (action === 'print') ({ dialog, trigger } = await openPreview(page)); else trigger = region(page).getByRole('button', { name: '列印預覽', exact: true });
    const delayed = await delayRoute(page, fullPattern), before = await printCount(page);
    if (action === 'preview') await trigger.click(); else await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click();
    await delayed.arrived.promise; await closeDialog(page, trigger); delayed.release.resolve(); await delayed.handled.promise; await settle(page); assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await printCount(page), before); await page.unroute(fullPattern);
  }
  const delayedList = await delayRoute(page, listPattern); await region(page).getByRole('button', { name: '查詢紀錄', exact: true }).click(); await delayedList.arrived.promise; await region(page).getByLabel('核閱狀態', { exact: true }).selectOption('approved'); await page.unroute(listPattern); await queryReport(page, 11, 507); delayedList.release.resolve(); await delayedList.handled.promise; await settle(page); assert.equal(await resultRegion(page).locator('tbody tr').count(), 11); await region(page).getByLabel('核閱狀態', { exact: true }).selectOption(''); await queryReport(page, 40);
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

  // Chromium print-media checks exercise the native event guard without generating another PDF.
  const suppressNativePrint = async () => {
    const count = await printCount(page); await page.evaluate(() => window.dispatchEvent(new Event('beforeprint'))); await page.emulateMedia({ media: 'print' });
    assert.ok(await page.evaluate(() => document.body.classList.contains('print-suppressed')));
    assert.deepEqual(await page.evaluate(() => [...document.body.children].filter(node => getComputedStyle(node).display !== 'none').map(node => node.tagName)), [], 'Invalid or unready native print hides every body child, including background app');
    assert.equal(await printCount(page), count); await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))); assert.equal(await page.evaluate(() => document.body.classList.contains('print-suppressed')), false); await page.emulateMedia({ media: null });
  };
  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page));
  await suppressNativePrint();
  await dialog.getByText('請使用「列印／另存 PDF」按鈕重新讀取資料後列印。', { exact: true }).waitFor();
  const printsAfterNativeBlock = await printCount(page);
  await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await page.waitForFunction(n => window.__printCalls.length === n, printsAfterNativeBlock + 1);
  await region(page).getByLabel('結束日期', { exact: true }).evaluate(node => { node.value = '2026-11-08'; }); await suppressNativePrint(); await dialog.waitFor({ state: 'detached' });
  await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page)); await closeDialog(page, trigger);
  const pendingPrint = await delayRoute(page, fullPattern); await region(page).getByRole('button', { name: '列印預覽', exact: true }).click(); await pendingPrint.arrived.promise; await suppressNativePrint();
  pendingPrint.release.resolve(); await pendingPrint.handled.promise; await page.unroute(fullPattern); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.locator('tbody tr').first().waitFor(); await closeDialog(page);
  await page.route(fullPattern, fail503); await region(page).getByRole('button', { name: '列印預覽', exact: true }).click(); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.getByRole('alert').waitFor(); await suppressNativePrint(); await page.unroute(fullPattern);
  await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.locator('tbody tr').first().waitFor(); await closeDialog(page);
  mark('原生beforeprint檢查：有效預覽也禁止快取列印且只能fresh按鈕輸出；靜默改filter撤除舊dialog；載入/錯誤全背景隱藏，afterprint可重查/重試');

  await page.goto(`${base}/#/reports`); tries = 0; await page.route('**/api/employees?page=*&pageSize=100', route => ++tries === 1 ? fail503(route) : route.continue()); await page.getByLabel('報表類型', { exact: true }).selectOption('services'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.ok(await region(page).getByRole('button', { name: '查詢紀錄', exact: true }).isDisabled()); await shot(page, 'report-lookup-retry.png'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await resultRegion(page).waitFor(); assert.equal(tries, 2); await page.unroute('**/api/employees?page=*&pageSize=100');
  for (const actor of [supervisor, finance]) { await loadReport(actor.page); await setAllRange(actor.page); await queryReport(actor.page, 40); }
  for (const actor of [{ client: context, auth: admin }, supervisor, finance, caregiver]) {
    const expected = actor === caregiver ? 28 : 40;
    for (const suffix of ['', '/export', '.csv']) {
      const response = await fetchApi('GET', `service-report${suffix}?${allQuery}`, undefined, actor.client, actor.auth); assert.equal(response.status(), 200);
      if (suffix !== '.csv') { const body = await response.json(); assert.equal(body.total, expected); for (const row of body.rows) assert.deepEqual(Object.keys(row).sort(), ['recordId','version','date','caseNo','case','employeeNo','employee','actualStart','actualEnd','serviceMinutes','services','status','statusLabel','note','reviewNote'].sort()); }
      for (const [key, value] of [['caseId', foreignCase.id], ['employeeId', foreignEmployee.id]]) assert.equal((await fetchApi('GET', `service-report${suffix}?${allQuery}&${key}=${value}`, undefined, actor.client, actor.auth)).status(), 404);
    }
  }
  for (const suffix of ['', '/export', '.csv']) assert.equal((await fetchApi('GET', `service-report${suffix}?${allQuery}&employeeId=${employeeB.id}`, undefined, caregiver.client, caregiver.auth)).status(), 404);
  await caregiver.page.goto(`${base}/#/reports`); await caregiver.page.waitForLoadState('networkidle'); assert.equal(await caregiver.page.getByLabel('報表類型', { exact: true }).count(), 0); assert.equal(await caregiver.page.getByRole('link', { name: '報表中心', exact: true }).count(), 0);
  const emptyApi = await request('GET', 'service-report/export?startDate=2026-12-01&endDate=2026-12-02'); assert.deepEqual(emptyApi.rows, []); assert.equal(emptyApi.pageSize, 0);
  verifyReads('retries-cancellation-context-and-roles'); mark('lookup503先禁查詢可重試；管理/督導/財務40筆、居服員僅28筆且無報表入口；三端跨機構/他人filter404，投影不含電話/地址/計價');

  }
  // One QA-only PDF from DOM captured synchronously inside a fresh authorized print.
  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page)); await dialog.getByText(records[11].note, { exact: true }).waitFor();
  const expectedPdf = await fullUi(); await writeFile(path.join(output, 'pdf-expected.json'), JSON.stringify(expectedPdf, null, 2));
  const marker = process.env.HOME_CARE_QA_PDF_MARKER;
  if (marker && !process.env.PDF_OPERATION_ALREADY_MARKED) {
    const markerResult = spawnSync(process.execPath, [marker, '--operation-kind', 'create', '--expected-output-count', '1', '--output-format', 'pdf'], { encoding: 'utf8' }); assert.equal(markerResult.status, 0, markerResult.stderr);
    await writeFile(path.join(output, 'pdf-operation.json'), JSON.stringify({ operation: 'create', expectedOutputCount: 1, outputFormat: 'pdf', marker, completedAt: new Date().toISOString(), exitStatus: markerResult.status }, null, 2)); console.log(markerResult.stdout.trim());
  }
  const pdfPath = path.join(output, 'synthetic-service-report.pdf');
  const pdfProvenance = await renderCapturedReportPdf({ browser, page, path: pdfPath });
  await writeFile(path.join(output, 'pdf-provenance.json'), JSON.stringify(pdfProvenance, null, 2));
  const py = process.env.HOME_CARE_QA_PYTHON || 'python3';
  const audit = spawnSync(py, ['-c', `import json, pathlib, re, sys, logging, unicodedata, pdfplumber
logging.getLogger('pdfminer').setLevel(logging.ERROR)
p=pathlib.Path(sys.argv[1]); expected=json.loads((p/'pdf-expected.json').read_text()); findings=[]
with pdfplumber.open(p/'synthetic-service-report.pdf') as pdf:
 texts=[unicodedata.normalize('NFKC',page.extract_text(use_text_flow=True) or '') for page in pdf.pages]
 assert len(texts)>1, 'Expected multi-page QA PDF'
 combined='\\n\\n'.join(texts); compact=re.sub(r'\\s+','',combined)
 for row in expected['rows']:
  for key in ['note','reviewNote','actualStart','actualEnd','services']:
   if row[key]: assert re.sub(r'\\s+','',unicodedata.normalize('NFKC',row[key])) in compact, ('Missing full saved value',row['recordId'],key)
 for row in expected['rows']:
  assert row['actualEndDate'].replace('-','/') in compact, ('Missing explicit ending date',row['actualEndDate'])
 for index in range(1,41):
  marker=f'REC-{index:03d}'; assert compact.count(marker)==1, (marker,compact.count(marker))
 assert f'實際分鐘合計{expected["totals"]["serviceMinutes"]}分鐘' in compact, 'Missing whole-result minutes'
 for i,page in enumerate(pdf.pages):
  text=re.sub(r'\\s+','',texts[i]); assert text and len(text)>80, ('Blank page',i+1)
  assert page.width>page.height and abs(page.width-841.89)<3 and abs(page.height-595.28)<3, ('Not landscape A4',i,page.width,page.height)
  for header in ['日期','案號','員工編號','實際分鐘','核閱意見','結束日期']: assert header in text, ('Missing repeated table header',i+1,header)
  for forbidden in ['報表中心','列印／另存PDF','查詢紀錄','清除條件','測試工作空間']: assert forbidden not in text, ('Background UI',i+1,forbidden)
  assert '\\ufffd' not in text and '\\u25a1' not in text, ('Missing glyph',i+1)
  chars=page.chars
  assert all(c['x0']>=20 and c['x1']<=page.width-20 and c['top']>=15 and c['bottom']<=page.height-15 for c in chars), ('Text outside safe printable bounds',i+1)
  findings.append({'page':i+1,'width':page.width,'height':page.height,'characters':len(chars),'rowMarkers':re.findall(r'REC-\\d{3}',text),'headersRepeated':True,'boundsSafe':True})
 (p/'pdf-text.txt').write_text(combined)
 (p/'pdf-review.json').write_text(json.dumps({'passed':True,'pages':findings,'all40RowMarkersExactlyOnce':True,'latestVersionIncluded':'REC-012合成預覽後修正55分鐘' in compact,'noBackgroundUI':True,'visualReviewRequired':True},ensure_ascii=False,indent=2))
 print(json.dumps({'pageCount':len(texts),'rowCount':40}))`, output], { encoding: 'utf8' }); assert.equal(audit.status, 0, audit.stderr); console.log(audit.stdout.trim());
  const poppler = process.env.HOME_CARE_QA_PDFTOPPM || 'pdftoppm';
  for (const name of await readdir(output)) if (/^pdf-(?:page|initial)-\d+\.png$/.test(name)) await rm(path.join(output, name));
  const render = spawnSync(poppler, ['-r', '110', '-png', pdfPath, path.join(output, 'pdf-page')], { encoding: 'utf8' }); assert.equal(render.status, 0, render.stderr);
  await closeDialog(page, trigger); verifyReads('PDF-generation-and-full-text-validation'); assert.deepEqual(app.db.prepare("SELECT * FROM records WHERE entity NOT IN ('shifts','service-records') ORDER BY id").all(), masterState); assert.deepEqual((await request('GET', `service-records/${records[0].id}`)).item, approved);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /503/.test(message)), JSON.stringify(consoleErrors));
  mark('單一合成多頁PDF文字驗40筆各一次、每頁表頭、A4橫向安全邊界、無背景UI/空白頁；所有讀取完整DB與billing不變，僅明確3次狀態/修正寫入');
  await rm(path.join(output, 'failure.png'), { force: true }); await rm(path.join(output, 'pdf-diagnostic-text.txt'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, pdfOnly: Boolean(process.env.SERVICE_REPORT_PDF_ONLY), completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium / intercepted window.print', checks, screenshots, pdf: 'synthetic-service-report.pdf', pdfPages: (await readdir(output)).filter(name => /^pdf-page-\d+\.png$/.test(name)), pageErrors, consoleErrors, failedResponses, downloads, initialCounts, finalCounts: counts(), readSegments, intentionalMutations, mastersAndOriginalBillingSnapshotUnchanged: true, visualReviewPending: true }, null, 2));
  console.log(`Service report E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, intentionalMutations, error: error.stack }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
