import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, insert, saveVersion } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

// Synthetic data, actual browser/API and a random port. Never opens the disk database.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/service-item-history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-service-item-history-password';
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: [403, 404, 409, 422, 503].includes(response.status()) });
  });
};
const load = async (page, route, heading) => {
  lastPage = page;
  if (page.url() === `${base}/#${route}`) await page.reload(); else await page.goto(`${base}/#${route}`);
  await page.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.error-state').count(), 0, `route ${route}`);
};
const inspectLayout = async page => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No full-page horizontal overflow');
  const unlabelled = await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name));
  assert.deepEqual(unlabelled, [], 'Visible controls have semantic labels');
  if (await page.getByRole('dialog').count()) {
    const geometry = await page.getByRole('dialog').evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, 'Dialog is inside the viewport');
    assert.ok(geometry.scroll <= geometry.client + 1, 'Only nested table regions may scroll horizontally');
    for (const region of await page.getByRole('dialog').locator('.table-scroll').all()) {
      if (!await region.isVisible()) continue;
      const data = await region.evaluate(node => ({ overflow: getComputedStyle(node).overflowX, width: node.clientWidth, scroll: node.scrollWidth }));
      assert.equal(data.overflow, 'auto');
      if (data.scroll > data.width) {
        await region.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        assert.ok(await region.evaluate(node => node.scrollLeft > 0), 'Wide comparison table scrolls within its container');
        await region.evaluate(node => { node.scrollLeft = 0; });
      }
    }
  }
};
const screenshot = async (page, name) => {
  assert.ok(await page.locator('.toast:visible').count() <= 2);
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
};
const rowNamed = (page, name) => page.getByRole('row').filter({ hasText: name });
const versionCard = (dialog, version) => dialog.locator('.history-version').filter({ has: dialog.page().getByText(`第 ${version} 版`, { exact: true }) });
const openHistory = async (page, trigger, title, version = 2) => {
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByText(`第 ${version} 版`, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|刪除|還原/ }).count(), 0, 'History is read-only');
  return dialog;
};
const closeHistory = async (page, trigger) => {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  if (trigger) assert.ok(await trigger.evaluate(node => node === document.activeElement), 'Escape restores trigger focus');
};
const saveDialog = async page => {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
};
const counts = () => ({
  changes: app.db.prepare('SELECT total_changes() AS n').get().n,
  audit: app.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,
  records: app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n,
  versions: app.db.prepare('SELECT COUNT(*) AS n FROM record_versions').get().n,
  idempotency: app.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n,
});
await mkdir(output, { recursive: true });

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

const readSegments = [], fixtureNotes = [], invalidationChecks = [], writeSegments = [];
const entity = 'service-items', title = '服務項目版本歷程';
const price = cents => `新臺幣 ${BigInt(cents) / 100n}.${String(BigInt(cents) % 100n).padStart(2, '0')} 元（保存 ${cents} 分）`;
const readOnly = async (label, work) => { const before = counts(), raw = rawState(); assert.equal(Object.keys(raw).length, 11); await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); readSegments.push({ label, all11TablesUnchanged: true, before, after: counts() }); };
const written = async (label, work) => { const before = counts(); const result = await work(); writeSegments.push({ label, before, after: counts() }); return result; };
const delayRoute = async (page, pattern) => { const arrived = deferred(), release = deferred(), handled = deferred(); await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (e) { if (!/closed|cancel|abort|disposed|already handled/i.test(e.message)) throw e; } finally { handled.resolve(); } }); return { arrived, release, handled }; };
const findItem = async (page, item) => { await load(page, '/service-items', '服務項目'); const search = page.getByLabel('搜尋資料', { exact: true }); await search.fill(item.code); await search.press('Enter'); await rowNamed(page, item.code).waitFor(); return rowNamed(page, item.code).getByRole('button', { name: '版本歷程', exact: true }); };
const fill = async (page, data) => { const d = page.getByRole('dialog'); for (const [key, label] of [['code', '服務代碼'], ['name', '服務名稱'], ['minutes', '預設服務分鐘'], ['unitPrice', '測試單價（新臺幣元）'], ['validFrom', '有效起日'], ['validTo', '有效迄日'], ['note', '備註']]) if (key in data) await d.getByLabel(label, { exact: false }).fill(String(data[key])); if (data.status) await d.getByLabel('狀態', { exact: false }).selectOption(data.status); };
try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成項目管理員', email: 'service-item-admin@example.test', password, organizationName: '合成項目甲機構' } }); assert.equal(setup.status(), 201);
  const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => { const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) }); const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body; };
  const post = async (kind, data) => (await request('POST', kind, data, 201)).item;
  const patch = async (kind, item, data) => (await request('PATCH', `${kind}/${item.id}`, { version: item.version, ...data })).item;
  const get = async (kind, item) => (await request('GET', `${kind}/${item.id}`)).item;
  const history = (item, actor = { client: context, auth: admin }, compare = true, extra = '') => request('GET', `${entity}/${item.id}/history${compare ? '?compare=previous' : '?'}${extra}`, undefined, 200, actor.client, actor.auth);
  let employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'SI-EA', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'SI-EB', role: 'caregiver', hourlyRateCents: 32000 });
  const users = {};
  for (const [role, name, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['caregiver', 'caregiver', employeeA]]) users[name] = await post('users', { name: `合成項目${name}`, email: `service-item-${name}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const login = async name => { const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client); const r = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `service-item-${name}@example.test`, password } }); assert.equal(r.status(), 200); const auth = await r.json(), page = await client.newPage(); observe(page); return { client, auth, page }; };
  const supervisor = await login('supervisor'), finance = await login('finance'), caregiver = await login('caregiver');
  const adminPage = await context.newPage(); observe(adminPage);
  const dataFor = (code, name, extra = {}) => ({ code, name, minutes: 30, unitPriceCents: 12345, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', note: '合成原始項目備註', ...extra });
  let main = await written('管理者真UI新增v1／123.45元精確保存12345分', async () => { await load(adminPage, '/service-items', '服務項目'); await adminPage.getByRole('button', { name: '新增服務項目', exact: true }).click(); await fill(adminPage, { code: 'SI-ORIGINAL', name: '合成原始服務項目', minutes: 30, unitPrice: '123.45', validFrom: '2026-01-01', validTo: '2026-12-31', note: '合成原始項目備註' }); await saveDialog(adminPage); return (await request('GET', `${entity}?q=SI-ORIGINAL`)).items[0]; }); assert.equal(main.unitPriceCents, 12345);
  const careCase = await post('cases', { name: '合成項目個案', caseNo: 'SI-CASE' });
  const plan = await post('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: main.id, quantity: 10 }] });
  const shift = await post('shifts', { caseId: careCase.id, employeeId: employeeA.id, carePlanId: plan.id, date: '2026-10-20', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: main.id, quantity: 2 }] });
  let record = await post('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: main.id, quantity: 2 }], status: 'submitted' });
  record = (await request('POST', `service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成項目快照基準' })).item;
  const approvedRecord = structuredClone(record), fees = await request('GET', 'reports/fees?month=2026-10'), payroll = await request('GET', 'reports/payroll?month=2026-10');
  const caseAttachment = await post('case-attachments/upload', { caseId: careCase.id, title: '合成既有個案檔案', category: 'general', ...filePayload(PDF_BYTES) });
  const cert = await post('employee-certifications', { employeeId: employeeA.id, name: '合成既有證照', issuedOn: '2026-01-01' });
  const certAttachment = await post('certification-attachments/upload', { certificationId: cert.id, title: '合成既有證照檔案', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM attachment_files').get().n, 1); assert.equal(app.db.prepare('SELECT COUNT(*) n FROM certification_attachment_files').get().n, 1);
  main = await written('督導真UI改代碼/名稱/分鐘/價格/清空日期v2', async () => { await findItem(supervisor.page, main); await rowNamed(supervisor.page, main.code).getByRole('button', { name: '編輯', exact: true }).click(); await fill(supervisor.page, { code: 'SI-MAIN', name: '合成服務項目已更新', minutes: 45, unitPrice: '234.56', validFrom: '', validTo: '', note: '合成督導更新備註' }); await saveDialog(supervisor.page); return get(entity, main); }); assert.equal(main.unitPriceCents, 23456); assert.equal(main.version, 2);
  await findItem(adminPage, main); await rowNamed(adminPage, main.code).getByRole('button', { name: '停用', exact: true }).click(); const cancelCounts = counts(); await adminPage.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); assert.deepEqual(counts(), cancelCounts);
  for (const [page, action, expected] of [[adminPage, '停用', 'inactive'], [supervisor.page, '啟用', 'active']]) main = await written(`真UI${action}`, async () => { await findItem(page, main); await rowNamed(page, main.code).getByRole('button', { name: action, exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: `確認${action}`, exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); const item = await get(entity, main); assert.equal(item.status, expected); return item; });
  assert.equal(main.version, 4); assert.deepEqual((await history(main)).items.map(r => r.actor.id), [users.supervisor.id, admin.user.id, users.supervisor.id, admin.user.id]);
  mark('真UI管理者v1→督導v2→管理者停用v3→督導啟用v4、取消零寫與精確實際actor；元轉整數分準確');
  await findItem(adminPage, main); await rowNamed(adminPage, main.code).getByRole('button', { name: '編輯', exact: true }).click(); await fill(adminPage, { note: '合成本機尚未儲存價格備註', unitPrice: '345.67' });
  main = await written('模擬真競爭更新原項目v5', () => patch(entity, main, { note: '合成伺服器競爭備註' }));
  await readOnly('real-cas-retains-input', async () => { const d = adminPage.getByRole('dialog'); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.getByText('資料已更新，請重新讀取', { exact: true }).waitFor(); assert.equal(await d.getByLabel('測試單價（新臺幣元）', { exact: false }).inputValue(), '345.67'); assert.equal(await d.getByLabel('備註', { exact: true }).inputValue(), '合成本機尚未儲存價格備註'); await screenshot(adminPage, 'service-item-cas-preserved.png'); await d.getByRole('button', { name: '取消', exact: true }).click(); await adminPage.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).getByRole('button', { name: '放棄修改', exact: true }).click(); await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); });
  const duplicate = await post(entity, dataFor('SI-DUPLICATE', '合成重複碼基準'));
  await findItem(adminPage, main); await rowNamed(adminPage, main.code).getByRole('button', { name: '編輯', exact: true }).click();
  await readOnly('invalid-ui-and-api-writes-preserved', async () => { const d = adminPage.getByRole('dialog'); await fill(adminPage, { validFrom: '2026-12-01', validTo: '2026-01-01' }); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.getByText('結束日期不可早於開始日期', { exact: true }).waitFor(); assert.equal(await d.getByLabel('有效起日', { exact: true }).inputValue(), '2026-12-01'); await screenshot(adminPage, 'service-item-date-error.png'); await fill(adminPage, { validFrom: '', validTo: '', code: duplicate.code }); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.getByText('同機構編號已存在', { exact: true }).waitFor(); await d.getByRole('button', { name: '取消', exact: true }).click(); await adminPage.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).getByRole('button', { name: '放棄修改', exact: true }).click(); await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); for (const payload of [{ unitPriceCents: -1 }, { unitPriceCents: 1.1 }, { unitPriceCents: '12345' }, { minutes: 0 }, { minutes: 1.5 }]) await request('PATCH', `${entity}/${main.id}`, { version: main.version, ...payload }, 422); }); mark('真CAS409保留本機價格/備註；倒置日期/重複代碼與非法分/分鐘拒絕，無版本或audit寫入');
  let pageItem = await post(entity, dataFor('SI-HISTORY-28', '合成28版服務項目', { note: '合成第1版' })); for (let v = 2; v <= 28; v++) pageItem = await patch(entity, pageItem, { note: `合成第${v}版` });
  let oneCent = await post(entity, dataFor('SI-CENTS', '合成零與一分', { unitPriceCents: 0 })); oneCent = await patch(entity, oneCent, { unitPriceCents: 1 });
  const scopeItem = await post(entity, dataFor('SI-SCOPE', '合成動態引用授權')); let scopeVersion = await patch(entity, scopeItem, { unitPriceCents: 7777 }); scopeVersion = await patch(entity, scopeVersion, { name: '合成動態引用已更名', validTo: '' });
  const planOnly = await post(entity, dataFor('SI-PLAN-ONLY', '合成僅計畫引用'));
  const cancelItem = await post(entity, dataFor('SI-CANCEL', '合成取消班仍引用'));
  const scopePlan = await post('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [scopeItem, planOnly, cancelItem].map(item => ({ serviceItemId: item.id, quantity: 1 })) });
  let scopeShift = await post('shifts', { caseId: careCase.id, employeeId: employeeA.id, carePlanId: scopePlan.id, date: '2026-10-21', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: scopeItem.id, quantity: 1 }] });
  let cancelledShift = await post('shifts', { caseId: careCase.id, employeeId: employeeA.id, carePlanId: scopePlan.id, date: '2026-10-22', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: cancelItem.id, quantity: 1 }] }); cancelledShift = await patch('shifts', cancelledShift, { status: 'cancelled' }); const inactiveService = await patch(entity, cancelItem, { status: 'inactive', validFrom: '2025-01-01', validTo: '2025-12-31' });
  const expectAccess = async (item, status) => { for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `${entity}/${item.id}${suffix}`, undefined, status, caregiver.client, caregiver.auth); };
  await readOnly('own-current-reference-before-reassignment', async () => { await expectAccess(scopeVersion, 200); await expectAccess(planOnly, 404); assert.deepEqual((await history(scopeVersion, caregiver)).items.map(r => r.version), [3, 2, 1]); await expectAccess(inactiveService, 200); await expectAccess(main, 200); });
  scopeShift = await written('真API班次A改派B使全部引用消失', () => patch('shifts', scopeShift, { employeeId: employeeB.id })); await readOnly('scope-lost-on-real-reassignment', () => expectAccess(scopeVersion, 404));
  scopeShift = await written('真API班次B改派回A恢復引用', () => patch('shifts', scopeShift, { employeeId: employeeA.id })); await readOnly('scope-restored-on-real-reassignment', async () => { await expectAccess(scopeVersion, 200); assert.deepEqual((await history(scopeVersion, caregiver)).items.map(r => r.version), [3, 2, 1]); });
  scopeShift = await written('真API移除班次服務項目引用', () => patch('shifts', scopeShift, { services: [{ serviceItemId: planOnly.id, quantity: 1 }] })); await readOnly('scope-lost-on-reference-removal', async () => { await expectAccess(scopeVersion, 404); await expectAccess(planOnly, 200); });
  scopeShift = await written('真API恢復班次服務項目引用', () => patch('shifts', scopeShift, { services: [{ serviceItemId: scopeItem.id, quantity: 1 }] }));
  employeeA = await written('真API修改員工測試時薪不重算已核閱快照', () => patch('employees', employeeA, { hourlyRateCents: 99000 }));
  await readOnly('financial-snapshot-after-master-edits', async () => { assert.deepEqual(await get('service-records', record), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll); });
  mark('caregiver引用隨真改派/移除/恢復決定current/raw/compare；取消及完成班保留、僅計畫引用不授權；改價/時薪不重算費薪快照');
  const otherOrg = (await request('POST', 'organizations', { name: '合成項目乙機構' }, 201)).item;
  const foreign = (await request('POST', entity, dataFor('SI-FOREIGN', '合成跨機構項目'), 201, context, admin, otherOrg.id)).item;
  const time = now();
  const imported = (code, name, snapshots, currentOverride = {}) => { const data = dataFor(code, name, currentOverride); const item = { ...data, id: id(), orgId, version: Math.max(1, ...snapshots.map(r => r.version)), createdAt: time, updatedAt: time }; app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, orgId, entity, JSON.stringify(data), item.version, time, time); for (const entry of snapshots) { const snapshot = { ...item, ...entry }; for (const key of entry.omit || []) delete snapshot[key]; delete snapshot.omit; app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, item.id, entry.version, JSON.stringify(snapshot), time, 'baseline'); } return item; };
  const baseline = imported('SI-BASELINE', '合成未知操作者', [{ version: 1 }]);
  const gap = imported('SI-GAP', '合成精確缺前版', [{ version: 1 }, { version: 3, note: '合成第3版但缺第2版' }]);
  const empty = imported('SI-EMPTY', '合成空歷程', []);
  const nullable = imported('SI-NULL', '合成缺失與零價格', [{ version: 1, omit: ['unitPriceCents'] }, { version: 2, unitPriceCents: null }, { version: 3, unitPriceCents: '' }, { version: 4, unitPriceCents: 0 }], { unitPriceCents: 0 });
  const invalid = imported('SI-INVALID', '合成異常價格保存值', [{ version: 1, unitPriceCents: -1 }, { version: 2, unitPriceCents: 1.5 }, { version: 3, unitPriceCents: '12345' }, { version: 4, unitPriceCents: { credential: 'NEVER_RENDER_EMBEDDED_SECRET' } }, { version: 5, unitPriceCents: Number.MAX_SAFE_INTEGER + 1 }, { version: 6, unitPriceCents: Number.MAX_SAFE_INTEGER }, { version: 7, unitPriceCents: 12345 }]);
  const projection = imported('SI-PROJECT', '合成公共投影欄位', [{ version: 1, unitPriceCents: 1, fileId: 'INTERNAL_FILE_ID', billingSnapshot: { secret: 'SYNTHETIC_BILLING_DATA' } }, { version: 2, unitPriceCents: 0, fileId: 'INTERNAL_FILE_ID', billingSnapshot: { secret: 'SYNTHETIC_BILLING_DATA' } }], { unitPriceCents: 0 });
  insert(app.db, orgId, 'shifts', { caseId: id(), carePlanId: id(), employeeId: employeeA.id, date: '2026-10-24', startTime: '09:00', endTime: '10:00', status: 'cancelled', services: [{ serviceItemId: projection.id, quantity: 1 }] });
  for (let i = 1; i <= 28; i++) await post(entity, dataFor(`SI-LIST-${String(i).padStart(2, '0')}`, `合成清單分頁${String(i).padStart(2, '0')}`));
  fixtureNotes.push('Only disposable memory SQLite, synthetic data and random localhost port. No actual 4310/data/original platform or production actions.', 'Lifecycle, 28-version history, 28 list items, scope reassignment/reference changes, approvals, two BLOB uploads and other normal fixtures use validated APIs/UI. Missing/gap/baseline/invalid scalar or object price and missing-case/plan scope fixtures are explicit INSERT-only imports; immutable versions/BLOBs are never modified/deleted.', 'Raw-state equality includes all 11 tables and actual non-empty attachment_files PDF bytes and certification_attachment_files PNG bytes. The synthetic PDF is an existing attachment fixture, not a generated QA report/PDF artifact; PDF operations and markers are 0.', 'Imported historical MAX_SAFE_INTEGER demonstrates display precision only; it is outside the normal writable price cap 1e9 and does not weaken normal validation.');
  const beforeReads = counts(), beforeState = rawState(); assert.equal(Object.keys(beforeState).length, 11); assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n, 6);
  await readOnly('desktop-mobile-8-saved-fields-and-diffs', async () => {
    const trigger = await findItem(adminPage, main); await trigger.focus(); await adminPage.keyboard.press('Enter'); let d = adminPage.getByRole('dialog', { name: title, exact: true }); await d.getByText('第 5 版', { exact: true }).waitFor(); await d.getByText('合成測試價格，不代表政府支付標準', { exact: false }).waitFor();
    const stateCard = versionCard(d, 4); await stateCard.locator(':scope > summary').click(); await stateCard.getByText(users.supervisor.name, { exact: true }).waitFor(); await stateCard.evaluate(n => n.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'service-item-status-actor-desktop.png');
    const card = versionCard(d, 2); await card.locator(':scope > summary').click(); const diff = card.getByRole('region', { name: '第 2 版變更前後', exact: true }); await diff.getByText(price(12345), { exact: true }).waitFor(); await diff.getByText(price(23456), { exact: true }).waitFor(); await diff.getByText('30 分鐘', { exact: true }).waitFor(); await diff.getByText('45 分鐘', { exact: true }).waitFor(); await diff.getByText('未設起日', { exact: true }).waitFor(); await diff.getByText('未設迄日', { exact: true }).waitFor(); await card.evaluate(n => n.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'service-item-diff-desktop.png');
    await adminPage.setViewportSize({ width: 390, height: 844 }); await inspectLayout(adminPage); await diff.getByText(price(12345), { exact: true }).evaluate(n => n.scrollIntoView({ block: 'center', inline: 'nearest' })); await diff.evaluate(n => { n.scrollLeft = n.querySelector('th:nth-child(2)').offsetLeft; }); await screenshot(adminPage, 'service-item-diff-mobile-before.png'); await diff.evaluate(n => { n.scrollLeft = n.scrollWidth; }); assert.ok(await diff.evaluate(n => n.scrollLeft > 0)); await screenshot(adminPage, 'service-item-diff-mobile-after.png');
    await card.getByText('完整保存欄位', { exact: true }).click(); const snapshot = card.locator('.history-snapshot'); assert.equal(await snapshot.locator('dt').count(), 8); await snapshot.evaluate(n => n.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'service-item-snapshot-mobile.png'); assert.ok(!/billingSnapshot|INTERNAL_FILE|NEVER_RENDER|法定工時|正式給付/.test(await snapshot.textContent())); assert.equal(await d.getByRole('button', { name: /儲存|編輯|刪除|還原/ }).count(), 0); await closeHistory(adminPage, trigger); await adminPage.setViewportSize({ width: 1440, height: 1050 });
  }); mark('八保存欄位/精確12345→123.45與23456→234.56/預設分鐘/空日期/真actor；1440/390內捲及Escape焦點');
  await readOnly('28-version-pagination-previous-across-page', async () => { const trigger = await findItem(supervisor.page, pageItem); const d = await openHistory(supervisor.page, trigger, title, 28); assert.equal(await d.locator('.history-version').count(), 25); const card = versionCard(d, 4); await card.locator(':scope > summary').click(); await card.getByText('與第 3 版比較', { exact: true }).waitFor(); await card.getByText('合成第3版', { exact: true }).first().waitFor(); await card.evaluate(n => n.scrollIntoView({ block: 'start' })); await screenshot(supervisor.page, 'service-item-page-boundary.png'); await d.getByRole('button', { name: '下一頁', exact: true }).click(); await d.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(await d.locator('.history-version').count(), 3); await versionCard(d, 3).getByText('與第 2 版比較', { exact: true }).waitFor(); await screenshot(supervisor.page, 'service-item-page-two.png'); await closeHistory(supervisor.page, trigger); assert.equal((await history(pageItem, undefined, true, '&page=1&pageSize=25')).items.at(-1).comparison.previousVersion, 3); }); mark('真28版本25+3分頁；頁尾第4版仍比較第3版，第2頁第3版比較第2版');
  await readOnly('four-real-role-session-current-raw-compare', async () => {
    for (const actor of [{ client: context, auth: admin }, supervisor, finance, caregiver]) {
      assert.equal((await history(main, actor)).total, 5); const raw = await history(main, actor, false); assert.ok(raw.items.every(r => !('actor' in r) && !('comparison' in r))); assert.ok(raw.items.every(r => Number.isSafeInteger(r.snapshot.unitPriceCents)));
      const projected = await history(projection, actor); for (const row of projected.items) for (const saved of [row.snapshot, row.comparison.previousSnapshot].filter(Boolean)) { assert.ok(!('fileId' in saved)); assert.equal('billingSnapshot' in saved, [admin.user.id, finance.auth.user.id].includes(actor.auth.user.id)); }
      for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `${entity}/${foreign.id}${suffix}`, undefined, 404, actor.client, actor.auth);
    }
    for (const actor of [finance, caregiver]) await request('PATCH', `${entity}/${main.id}`, { version: main.version, note: '拒絕寫入' }, 403, actor.client, actor.auth);
    await load(finance.page, '/service-items', '服務項目'); assert.equal(await finance.page.getByRole('button', { name: '版本歷程', exact: true }).count(), 0); assert.equal(await finance.page.getByRole('button', { name: /新增服務項目|編輯|停用|啟用/ }).count(), 0); await screenshot(finance.page, 'service-item-finance-readonly.png');
    await caregiver.page.goto(`${base}/#/service-items`); await caregiver.page.waitForLoadState('networkidle'); assert.equal(await caregiver.page.getByRole('heading', { name: '服務項目', exact: true }).count(), 0); assert.equal(await caregiver.page.getByRole('link', { name: '服務項目', exact: true }).count(), 0); for (const suffix of ['?compare=wrong', '?compare=previous&compare=previous']) await request('GET', `${entity}/${main.id}/history${suffix}`, undefined, 422);
  }); mark('四真session保留原raw/compare scope：finance可讀無新UI入口、caregiver無導覽；全部snapshot公用投影/價格可讀、跨機構404與寫入403');
  await readOnly('zero-one-null-invalid-prices-and-safe-boundary', async () => {
    let trigger = await findItem(adminPage, oneCent), d = await openHistory(adminPage, trigger, title, 2), card = versionCard(d, 2), diff = card.getByRole('region', { name: '第 2 版變更前後', exact: true }); await diff.getByText(price(0), { exact: true }).waitFor(); await diff.getByText(price(1), { exact: true }).waitFor(); await screenshot(adminPage, 'service-item-zero-one-cent.png'); await closeHistory(adminPage, trigger);
    trigger = await findItem(adminPage, nullable); d = await openHistory(adminPage, trigger, title, 4); card = versionCard(d, 4); diff = card.getByRole('region', { name: '第 4 版變更前後', exact: true }); await diff.getByText('未提供', { exact: true }).waitFor(); await diff.getByText(price(0), { exact: true }).waitFor(); await screenshot(adminPage, 'service-item-null-versus-zero.png'); const v3 = versionCard(d, 3); await v3.locator(':scope > summary').click(); await v3.getByText('此版沒有業務欄位變更。', { exact: true }).waitFor(); await closeHistory(adminPage, trigger);
    trigger = await findItem(adminPage, invalid); d = await openHistory(adminPage, trigger, title, 7); for (const [version, expected] of [[6, price(Number.MAX_SAFE_INTEGER)], [5, `${Number.MAX_SAFE_INTEGER + 1}（金額無法判讀）`], [4, '[欄位格式無法判讀]（金額無法判讀）'], [3, '12345（金額無法判讀）'], [2, '1.5（金額無法判讀）'], [1, '-1（金額無法判讀）']]) { card = versionCard(d, version); await card.locator(':scope > summary').click(); await card.getByText('完整保存欄位', { exact: true }).click(); const saved = card.locator('.history-snapshot'); await saved.getByText(expected, { exact: true }).waitFor(); assert.ok(!/NEVER_RENDER_EMBEDDED_SECRET|NaN|Infinity/.test(await saved.textContent())); if ([6, 4, 3].includes(version)) { await saved.evaluate(n => n.scrollIntoView({ block: 'start' })); await screenshot(adminPage, `service-item-price-${version === 6 ? 'max-safe' : version === 4 ? 'object-invalid' : 'string-invalid'}.png`); } } await closeHistory(adminPage, trigger);
  }); mark('0/1分精確、missing/null/空與零不混同；非法字串/負/小數/unsafe不coercion、物件不洩漏、MAX_SAFE_INTEGER精確顯示');
  await readOnly('unknown-actor-empty-precise-gap', async () => {
    let trigger = await findItem(adminPage, baseline), d = await openHistory(adminPage, trigger, title, 1); await d.getByText('未記錄操作者', { exact: true }).waitFor(); await d.getByText('初始版本；沒有上一版本可比較。', { exact: true }).waitFor(); await screenshot(adminPage, 'service-item-unknown-actor.png'); await closeHistory(adminPage, trigger);
    trigger = await findItem(adminPage, empty); await trigger.click(); d = adminPage.getByRole('dialog'); await d.getByText('尚無可讀取的版本歷程。', { exact: true }).waitFor(); await screenshot(adminPage, 'service-item-empty.png'); await closeHistory(adminPage, trigger);
    trigger = await findItem(adminPage, gap); d = await openHistory(adminPage, trigger, title, 3); await d.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor(); assert.deepEqual((await history(gap)).items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null }); await screenshot(adminPage, 'service-item-gap.png'); await closeHistory(adminPage, trigger);
  }); mark('明示INSERT-only匯入未知actor／空歷程／精確缺版不跳比較，不猜操作者');
  const pattern = `**/api/${entity}/${main.id}/history*`;
  await readOnly('503-retry-and-slow-escape', async () => {
    const trigger = await findItem(adminPage, main); let attempts = 0; await adminPage.route(pattern, r => ++attempts === 1 ? r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ', message: '合成服務項目歷程暫時無法取得，請重試。' } }) }) : r.continue()); await trigger.click(); let d = adminPage.getByRole('dialog'); await d.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); await screenshot(adminPage, 'service-item-history-retry.png'); await d.getByRole('button', { name: '重新讀取', exact: true }).click(); await d.getByText('第 5 版', { exact: true }).waitFor(); assert.equal(attempts, 2); await closeHistory(adminPage, trigger); await adminPage.unroute(pattern);
    const delayed = await delayRoute(adminPage, pattern), aborted = adminPage.waitForEvent('requestfailed', { predicate: r => r.url().includes(`/${main.id}/history`), timeout: 10000 }); await trigger.click(); await delayed.arrived.promise; await screenshot(adminPage, 'service-item-history-loading.png'); await closeHistory(adminPage, trigger); delayed.release.resolve(); await delayed.handled.promise; assert.match((await aborted).failure()?.errorText || '', /abort|cancel/i); await adminPage.unroute(pattern); await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').count(), 0);
  }); mark('503重試真GET恢復；慢讀Escape中止fetch、焦點回入口，晚回應不復活');
  await readOnly('loaded-and-pending-context-identity', async () => {
    for (const pending of [false, true]) for (const mode of ['route', 'organization', 'role', 'employee', 'render']) {
      const trigger = await findItem(adminPage, main), delayed = pending ? await delayRoute(adminPage, pattern) : null; if (delayed) { await trigger.click(); await delayed.arrived.promise; } else await openHistory(adminPage, trigger, title, 5);
      if (mode === 'route') await adminPage.evaluate(() => { location.hash = '/cases'; });
      else if (mode === 'organization') await adminPage.getByLabel('目前機構', { exact: true }).evaluate((n, value) => { n.value = value; n.dispatchEvent(new Event('change', { bubbles: true })); }, otherOrg.id);
      else if (mode === 'render') await adminPage.evaluate(() => window.dispatchEvent(new Event('session-updated')));
      else await adminPage.evaluate(async ({ mode, employeeId }) => { const { getContext, setContext } = await import('/ui.js'); const ctx = structuredClone(getContext()); const org = ctx.organizations.find(item => item.id === ctx.organizationId); if (mode === 'role') org.role = 'supervisor'; else org.employeeId = employeeId; setContext(ctx, ctx.organizationId); document.body.append(document.createComment('synthetic-client-identity-fixture')); }, { mode, employeeId: employeeB.id });
      await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); if (delayed) { delayed.release.resolve(); await delayed.handled.promise; await adminPage.unroute(pattern); } await settle(adminPage); assert.equal(await adminPage.locator('.history-version').count(), 0); invalidationChecks.push({ pending, mode, removed: true, noLateRevival: true }); await adminPage.reload(); await adminPage.waitForLoadState('networkidle');
    }
  }); fixtureNotes.push('Role/employee invalidation is a client-only identity fixture plus DOM mutation, followed by a genuine server-session reload. It is not a server membership change. Four-role API authorization uses separate real sessions; scope reassignment/reference removal uses real API writes.'); mark('loaded/pending各hash/org/role/employee/render共10失效情境清空abort關閉，不復活');
  await readOnly('existing-list-search-state-pagination', async () => {
    await load(adminPage, '/service-items', '服務項目'); const search = adminPage.getByLabel('搜尋資料', { exact: true }); await search.fill('合成清單分頁'); await search.press('Enter'); await rowNamed(adminPage, 'SI-LIST-28').waitFor(); assert.equal(await adminPage.locator('tbody tr').count(), 25); await adminPage.getByRole('button', { name: '下一頁', exact: true }).click(); await rowNamed(adminPage, 'SI-LIST-01').waitFor(); assert.equal(await adminPage.locator('tbody tr').count(), 3); await screenshot(adminPage, 'service-item-list-page-two.png');
    await search.fill('不存在的合成服務項目'); await search.press('Enter'); await adminPage.getByText('沒有符合條件的資料，請調整查詢。', { exact: true }).waitFor(); await search.fill(inactiveService.code); await search.press('Enter'); await adminPage.getByLabel('狀態', { exact: true }).selectOption('inactive'); await rowNamed(adminPage, inactiveService.code).waitFor(); const trigger = rowNamed(adminPage, inactiveService.code).getByRole('button', { name: '版本歷程', exact: true }); await openHistory(adminPage, trigger, title, 2); await screenshot(adminPage, 'service-item-inactive-history.png'); await closeHistory(adminPage, trigger);
  }); mark('既有清單搜尋/狀態/28筆25+3分頁保持，no-results可恢復，停用過期項目仍能看歷程');
  await readOnly('reports-billing-masters-and-actual-blob-bytes', async () => {
    assert.deepEqual(await get('service-records', record), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll); assert.deepEqual(await get('care-plans', plan), plan); assert.deepEqual(await get('cases', careCase), careCase);
    for (const kind of ['cases', 'shifts', 'services', 'fees', 'payroll']) assert.ok(Array.isArray((await request('GET', `reports/${kind}?month=2026-10`)).rows));
    for (const name of ['shift-report', 'service-report', 'case-report']) { const report = await request('GET', `${name}/export?startDate=2026-01-01&endDate=2026-12-31`); assert.ok(Array.isArray(report.rows)); }
    for (const [kind, item, bytes] of [['case-attachments', caseAttachment, PDF_BYTES], ['certification-attachments', certAttachment, PNG_BYTES]]) { const r = await context.request.get(`${base}/api/${kind}/${item.id}/download`, { headers: { 'X-Org-Id': orgId } }); assert.equal(r.status(), 200); assert.deepEqual(await r.body(), bytes); }
  }); assert.deepEqual(counts(), beforeReads); assert.deepEqual(rawState(), beforeState); assert.equal(invalidationChecks.length, 10); assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(r => !r.expected), []); assert.ok(consoleErrors.every(s => /403|404|409|422|503/.test(s)), JSON.stringify(consoleErrors)); mark('全部唯讀區間11表含兩表真BLOB內容零寫；核閱快照/費薪/主檔保持、五舊及三新報表可讀，pageerror0');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'Synthetic memory SQLite/random localhost port/real Chromium; no actual 4310/data/original platform.', checks, screenshots, readSegments, writeSegments, invalidationChecks, fixtureNotes, pageErrors, consoleErrors, failedResponses, readonlyCounts: { before: beforeReads, after: counts() }, all11TablesUnchangedDuringReads: true, blobTablesNonempty: { attachment_files: 1, certification_attachment_files: 1 }, approvedBillingSnapshotUnchanged: true, pdfOperations: 0, pdfMarkers: 0, visualReviewPending: true }, null, 2)); console.log(`Service item history E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
} catch (error) { if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {}); await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, readSegments, writeSegments, invalidationChecks, fixtureNotes, error: error.stack, pdfOperations: 0, pdfMarkers: 0 }, null, 2)); throw error; }
finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
