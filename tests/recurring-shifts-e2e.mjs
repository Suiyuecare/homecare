import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/index.mjs';

// Synthetic fixtures and memory SQLite only. No disk database or fixed application port.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/recurring-shifts-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], contexts = [], previewEvidence = [], batchEvidence = [];
let base, browser, lastPage;
const password = 'synthetic-recurring-password';
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: /\/api\/recurring-shifts\/(preview|commit)$/.test(new URL(response.url()).pathname) && [409, 422, 503].includes(response.status()) }); });
};
const counts = () => Object.fromEntries([
  ['changes', 'SELECT total_changes() AS n'], ['records', 'SELECT COUNT(*) AS n FROM records'],
  ['versions', 'SELECT COUNT(*) AS n FROM record_versions'], ['audit', 'SELECT COUNT(*) AS n FROM audit'],
  ['idempotency', 'SELECT COUNT(*) AS n FROM idempotency'],
].map(([name, sql]) => [name, app.db.prepare(sql).get().n]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const dialogOf = page => page.getByRole('dialog', { name: '週期排班', exact: true });
const previewOf = page => dialogOf(page).getByRole('region', { name: '排班預覽', exact: true });
const previewButton = page => dialogOf(page).getByRole('button', { name: /^預覽排班/ });
const commitButton = page => dialogOf(page).getByRole('button', { name: /^建立全部班次/ });
const labels = { carePlanId: '個案與照顧計畫', employeeId: '服務人員', startDate: '開始日期', endDate: '結束日期', intervalWeeks: '每隔幾週', startTime: '開始時間', endTime: '結束時間', note: '交班備註' };
const weekdayLabels = ['', '週一', '週二', '週三', '週四', '週五', '週六', '週日'];
async function setField(page, name, value) {
  const field = dialogOf(page).getByLabel(labels[name], { exact: false });
  if (await field.evaluate(node => node.tagName) === 'SELECT') await field.selectOption(String(value)); else await field.fill(String(value));
}
async function setWeekdays(page, weekdays) {
  for (let weekday = 1; weekday <= 7; weekday++) await dialogOf(page).getByRole('checkbox', { name: weekdayLabels[weekday], exact: true }).setChecked(weekdays.includes(weekday));
}
async function inspectLayout(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No full page overflow');
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), [], 'Visible controls have labels');
  if (await dialogOf(page).count()) {
    const geometry = await dialogOf(page).evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: innerWidth, client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport);
    assert.ok(geometry.scroll <= geometry.client + 1, 'Dialog has no horizontal overflow');
  }
}
async function screenshot(page, file) {
  assert.ok(await page.locator('.toast:visible').count() <= 2);
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await page.screenshot({ path: path.join(output, file), fullPage: false }); screenshots.push(file);
}
async function load(page, route = '/shifts', heading = '班表') {
  lastPage = page;
  if (page.url() === `${base}/#${route}`) await page.reload(); else await page.goto(`${base}/#${route}`);
  await page.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.error-state').count(), 0);
}
async function closeDirty(page) {
  await page.keyboard.press('Escape');
  const dirty = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true });
  await dirty.getByRole('button', { name: '放棄修改', exact: true }).click();
  await dialogOf(page).waitFor({ state: 'detached' });
}
const previewPattern = '**/api/recurring-shifts/preview', commitPattern = '**/api/recurring-shifts/commit';
await mkdir(output, { recursive: true });

try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成週期管理員', email: 'recurring-admin@example.test', password, organizationName: '合成週期排班甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, organizationId = orgId, moreHeaders = {}) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': organizationId, 'X-CSRF-Token': auth.csrfToken, ...moreHeaders }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const rows = async (entity, query = '') => (await request('GET', `${entity}?pageSize=100${query ? `&${query}` : ''}`)).items;
  const serviceA = await post('service-items', { code: 'REC-A', name: '合成週期照顧', minutes: 60, unitPriceCents: 10000 });
  const serviceB = await post('service-items', { code: 'REC-B', name: '合成週期陪伴', minutes: 30, unitPriceCents: 5000 });
  let fixtureIndex = 0;
  const fixture = async name => {
    const key = ++fixtureIndex, item = await post('cases', { name: `合成${name}個案`, caseNo: `REC-C${key}` });
    const employee = await post('employees', { name: `合成${name}員工`, employeeNo: `REC-E${key}`, role: 'caregiver' });
    const plan = await post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 30 }, { serviceItemId: serviceB.id, quantity: 30 }], goals: '合成週期驗收目標' });
    return { item, employee, plan };
  };
  const main = await fixture('隔週跨月'), conflict = await fixture('既有衝突'), race = await fixture('競態重疊'), inactive = await fixture('計畫失效'), recovery = await fixture('重送恢復');
  const alternateEmployee = await post('employees', { name: '合成替代員工', employeeNo: 'REC-ALT', role: 'caregiver' });
  const alternatePlan = await post('care-plans', { caseId: main.item.id, validFrom: '2026-02-01', validTo: '2027-12-31', status: 'active', services: [{ serviceItemId: serviceB.id, quantity: 20 }] });
  const oldMasters = await Promise.all(['cases', 'employees', 'care-plans', 'service-items'].map(async entity => [entity, await rows(entity)]));
  const oldMasterVersions = oldMasters.flatMap(([, items]) => items.map(item => ({ id: item.id, versions: app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(item.id) })));
  const actors = {};
  for (const role of ['supervisor', 'caregiver', 'finance']) actors[role] = await post('users', { name: `合成週期${role}`, email: `recurring-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: main.employee.id } : {}) });
  const loginAs = async role => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `recurring-${role}@example.test`, password } });
    assert.equal(response.status(), 200); const auth = await response.json(), page = await client.newPage(); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), caregiver = await loginAs('caregiver'), finance = await loginAs('finance');
  const otherOrg = (await request('POST', 'organizations', { name: '合成週期排班乙機構' }, 201)).item;
  const page = await context.newPage(); observe(page);
  const definitions = (source, overrides = {}) => ({ caseId: source.item.id, carePlanId: source.plan.id, employeeId: source.employee.id, startDate: '2026-10-28', endDate: '2026-11-27', intervalWeeks: 2, weekdays: [1, 3, 5], startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: serviceA.id, quantity: 2 }], note: '合成週期交班備註', ...overrides });
  const serviceQuantity = (target, service = serviceA) => dialogOf(target).getByLabel(`${service.code} ${service.name} 數量`, { exact: true });
  async function open(source, overrides = {}, target = page) {
    await load(target); const trigger = target.getByRole('button', { name: '週期排班', exact: true }); await trigger.click();
    const definition = definitions(source, overrides);
    for (const name of Object.keys(labels)) await setField(target, name, definition[name]);
    await setWeekdays(target, definition.weekdays); await serviceQuantity(target).fill(String(definition.services[0].quantity));
    return { trigger, definition };
  }
  async function preview(target = page) {
    const before = counts(), waiting = target.waitForResponse(response => response.url().endsWith('/api/recurring-shifts/preview'));
    await previewButton(target).click(); const response = await waiting; assert.equal(response.status(), 200); const body = await response.json();
    await previewOf(target).waitFor(); await previewButton(target).waitFor({ state: 'visible' });
    assert.deepEqual(counts(), before, 'Preview writes absolutely nothing, including total_changes and idempotency');
    assert.equal(await previewOf(target).locator('.recurring-date-card').count(), body.total);
    assert.equal(await commitButton(target).isEnabled(), body.canCommit);
    previewEvidence.push({ dates: body.items.map(item => item.date), total: body.total, readyCount: body.readyCount, conflictCount: body.conflictCount, counts: before }); return body;
  }
  async function assertBatch(body, definition, actorId, expectedDates) {
    assert.equal(typeof body.batchId, 'string'); assert.ok(body.batchId); assert.equal(body.total, expectedDates.length); assert.equal(body.items.length, expectedDates.length);
    assert.deepEqual(body.items.map(item => item.date).sort(), expectedDates); assert.equal(new Set(body.items.map(item => item.id)).size, expectedDates.length);
    for (const item of body.items) {
      assert.equal(item.version, 1); assert.equal(item.status, 'scheduled');
      for (const name of ['caseId', 'employeeId', 'carePlanId', 'startTime', 'endTime', 'services', 'note']) assert.deepEqual(item[name], definition[name]);
      const versions = app.db.prepare('SELECT * FROM record_versions WHERE record_id=?').all(item.id); assert.equal(versions.length, 1); assert.equal(versions[0].version, 1);
      const audits = app.db.prepare("SELECT * FROM audit WHERE entity='shifts' AND record_id=?").all(item.id); assert.equal(audits.length, 1); assert.equal(audits[0].user_id, actorId); assert.equal(audits[0].action, 'record.create');
      const detail = JSON.parse(audits[0].detail); assert.equal(detail.version, 1); assert.equal(detail.operation, 'recurring-shifts'); assert.equal(detail.batchId, body.batchId);
    }
    batchEvidence.push({ batchId: body.batchId, total: body.total, dates: expectedDates, actorId, versionsAndAuditVerified: true });
  }
  async function commit(definition, expectedDates, target = page, actorId = admin.user.id) {
    const waiting = target.waitForResponse(response => response.url().endsWith('/api/recurring-shifts/commit'));
    await commitButton(target).click(); const response = await waiting; assert.equal(response.status(), 201); const body = await response.json();
    await dialogOf(target).waitFor({ state: 'detached' }); await assertBatch(body, definition, actorId, expectedDates); return body;
  }
  const commitRequests = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/recurring-shifts/commit') commitRequests.push({ key: req.headers()['idempotency-key'], body: req.postDataJSON() }); });

  await load(page); let trigger = page.getByRole('button', { name: '週期排班', exact: true }); let before = counts(); await trigger.press('Enter');
  assert.equal(await commitButton(page).isEnabled(), false); await page.keyboard.press('Escape'); await dialogOf(page).waitFor({ state: 'detached' }); assert.ok(await trigger.evaluate(node => node === document.activeElement)); assert.deepEqual(counts(), before);
  let opened = await open(main); await setWeekdays(page, []); await previewButton(page).click();
  await dialogOf(page).locator('[aria-invalid="true"]').first().waitFor(); assert.equal(await commitButton(page).isEnabled(), false); assert.deepEqual(counts(), before);
  const monday = dialogOf(page).getByRole('checkbox', { name: '週一', exact: true }); await monday.focus(); await monday.press('Space'); assert.equal(await monday.isChecked(), true);
  await setWeekdays(page, [1, 3, 5]); await serviceQuantity(page).fill('1.5'); await previewButton(page).click(); assert.equal(await dialogOf(page).locator('.services-picker').getAttribute('aria-invalid'), 'true'); assert.deepEqual(counts(), before);
  await serviceQuantity(page).fill('2'); await inspectLayout(page); mark('鍵盤開啟/週一Space選取、空星期與小數數量拒絕、初始不可提交、未改取消與焦點回復均零寫入');

  const expectedDates = ['2026-10-28', '2026-10-30', '2026-11-09', '2026-11-11', '2026-11-13', '2026-11-23', '2026-11-25', '2026-11-27'];
  let result = await preview(); assert.deepEqual(result.items.map(item => item.date), expectedDates); assert.deepEqual(result.definition.weekdays, [1, 3, 5]); assert.equal(result.readyCount, 8); assert.equal(result.conflictCount, 0);
  await previewOf(page).scrollIntoViewIfNeeded(); await screenshot(page, 'recurring-preview-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await previewOf(page).locator('.recurring-date-card').first().scrollIntoViewIfNeeded(); await screenshot(page, 'recurring-preview-mobile.png'); await dialogOf(page).getByLabel('開始日期', { exact: false }).scrollIntoViewIfNeeded(); await screenshot(page, 'recurring-form-mobile.png'); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('週一起算隔週跨月精確8日，預覽records/versions/audit/idempotency/total_changes全零；1440/390日期卡片與原生欄位可讀');

  const mutations = [
    ['employeeId', alternateEmployee.id, main.employee.id], ['startDate', '2026-10-29', '2026-10-28'], ['endDate', '2026-11-26', '2026-11-27'],
    ['intervalWeeks', 3, 2], ['startTime', '09:15', '09:00'], ['endTime', '10:15', '10:00'], ['note', '合成更改備註', opened.definition.note],
  ];
  for (const [name, changed, original] of mutations) { await setField(page, name, changed); assert.equal(await commitButton(page).isEnabled(), false, name); await setField(page, name, original); await preview(); }
  await setWeekdays(page, [1, 3]); assert.equal(await commitButton(page).isEnabled(), false); await setWeekdays(page, [1, 3, 5]); await preview();
  await serviceQuantity(page).fill('3'); assert.equal(await commitButton(page).isEnabled(), false); await serviceQuantity(page).fill('2'); await preview();
  await setField(page, 'carePlanId', alternatePlan.id); assert.equal(await commitButton(page).isEnabled(), false); assert.equal(await serviceQuantity(page, serviceB).inputValue(), ''); assert.equal(await serviceQuantity(page).count(), 0);
  await setField(page, 'carePlanId', main.plan.id); await serviceQuantity(page).fill('2'); await preview();
  assert.ok(!page.url().includes(encodeURIComponent(opened.definition.note))); assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(opened.definition.note));
  mark('計畫/員工/起訖日期/間隔/星期/起訖時間/數量/備註修改即失效；換計畫清空服務，不能提交舊預覽，輸入不進URL或storage');
  const mainBatch = await commit(opened.definition, expectedDates); assert.equal((await rows('shifts', `caseId=${main.item.id}`)).length, 8);
  await page.getByLabel('服務月份', { exact: true }).fill('2026-11'); await page.waitForLoadState('networkidle'); await inspectLayout(page); await screenshot(page, 'recurring-created-list-desktop.png');
  mark('真UI建立8班，各班日期/關聯/數量完全一致；version1/history1/實際actor與同batchId audit逐筆核對');

  await post('leave-requests', { employeeId: conflict.employee.id, date: '2026-12-02', startTime: '09:00', endTime: '10:00', type: 'personal', status: 'approved', reason: '合成預覽請假衝突' });
  opened = await open(conflict, { startDate: '2026-11-30', endDate: '2026-12-04', intervalWeeks: 1 }); result = await preview();
  assert.equal(result.total, 3); assert.equal(result.conflictCount, 1); assert.equal(result.readyCount, 2); assert.equal(result.items.find(item => item.date === '2026-12-02').conflicts[0].code, 'LEAVE_CONFLICT');
  await previewOf(page).scrollIntoViewIfNeeded(); await screenshot(page, 'recurring-preview-conflict-desktop.png'); assert.equal(await commitButton(page).isEnabled(), false); before = counts(); await closeDirty(page); assert.deepEqual(counts(), before);
  mark('跨月每週3日有一日核准請假，顯示2可建立/1衝突且禁止部分提交；放棄預覽零寫入');

  opened = await open(race, { startDate: '2026-12-07', endDate: '2026-12-11', intervalWeeks: 1 }); await preview();
  await post('shifts', { caseId: race.item.id, carePlanId: race.plan.id, employeeId: race.employee.id, date: '2026-12-09', startTime: '09:00', endTime: '10:00', services: opened.definition.services }); before = counts();
  let waiting = page.waitForResponse(response => response.url().endsWith('/api/recurring-shifts/commit')); await commitButton(page).click(); let response = await waiting; assert.equal(response.status(), 409); let body = await response.json(); assert.equal(body.error.code, 'BATCH_CONFLICT'); assert.equal(body.error.details.preview.conflictCount, 1);
  await dialogOf(page).getByRole('alert').first().waitFor(); assert.equal(await commitButton(page).isEnabled(), false); assert.equal(await dialogOf(page).getByLabel('交班備註', { exact: true }).inputValue(), opened.definition.note); assert.deepEqual(counts(), before);
  await previewOf(page).getByText('有衝突', { exact: true }).waitFor(); await previewOf(page).scrollIntoViewIfNeeded(); await screenshot(page, 'recurring-race-conflict-desktop.png'); await closeDirty(page);
  mark('預覽後另一API真插入重疊，commit409回新版衝突預覽並保留輸入/撤銷提交資格；全批零部分寫入');

  opened = await open(inactive, { startDate: '2026-12-14', endDate: '2026-12-18', intervalWeeks: 1 }); await preview(); inactive.plan = await patch('care-plans', inactive.plan, { status: 'ended' }); before = counts();
  waiting = page.waitForResponse(response => response.url().endsWith('/api/recurring-shifts/commit')); await commitButton(page).click(); response = await waiting; assert.equal(response.status(), 409); body = await response.json(); assert.equal(body.error.details.preview.conflictCount, 3);
  await dialogOf(page).getByRole('alert').first().waitFor(); assert.deepEqual(counts(), before); assert.equal((await rows('shifts', `caseId=${inactive.item.id}`)).length, 0); assert.equal(await commitButton(page).isEnabled(), false); await screenshot(page, 'recurring-inactive-plan-error.png'); await closeDirty(page);
  mark('尚無班次的計畫在預覽後真PATCH ended；提交重验3日全衝突且不新增班次/歷程/audit/key');

  opened = await open(recovery, { startDate: '2026-12-21', endDate: '2026-12-25', intervalWeeks: 1 }); await preview(); before = counts();
  await page.route(commitPattern, route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_FIELD_ERROR', message: '合成欄位驗證', fields: { note: '合成備註欄位需確認' } } }) }));
  await commitButton(page).click(); await dialogOf(page).getByText('合成備註欄位需確認', { exact: true }).waitFor();
  const noteInput = dialogOf(page).getByLabel('交班備註', { exact: true });
  assert.equal(await noteInput.isEnabled(), true); assert.equal(await noteInput.inputValue(), opened.definition.note); assert.ok(await noteInput.evaluate(node => node === document.activeElement));
  assert.equal(await noteInput.getAttribute('aria-invalid'), 'true'); assert.equal(await previewButton(page).isEnabled(), true); assert.equal(await commitButton(page).isEnabled(), true); assert.deepEqual(counts(), before);
  await screenshot(page, 'recurring-field-error-focus.png'); await page.unroute(commitPattern); await closeDirty(page);
  mark('commit422欄位錯誤先恢復控制項，再聚焦備註並標示ARIA；原輸入與預覽保留、零寫入');

  // Server has committed before failures are injected, so a retry must reuse the original successful result.
  for (const [mode, startDate, endDate, dates] of [
    ['503', '2027-01-04', '2027-01-08', ['2027-01-04', '2027-01-06', '2027-01-08']],
    ['abort', '2027-01-11', '2027-01-15', ['2027-01-11', '2027-01-13', '2027-01-15']],
    ['empty', '2027-01-18', '2027-01-22', ['2027-01-18', '2027-01-20', '2027-01-22']],
  ]) {
    opened = await open(recovery, { startDate, endDate, intervalWeeks: 1, note: `合成成功回應${mode}保留` }); await preview(); const keyStart = commitRequests.length;
    const committedSignal = deferred(), releaseCommit = deferred();
    if (mode === '503') {
      let attempts = 0; await page.route(commitPattern, async route => { attempts++; if (attempts > 1) return route.continue(); const real = await route.fetch(); assert.equal(real.status(), 201); committedSignal.resolve(); await releaseCommit.promise; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_RESPONSE_LOST', message: '合成已提交回應中斷，請重試' } }) }); });
    } else {
      await page.evaluate(mode => { const original = window.fetch; window.__recurringBodyFault = null; window.fetch = async function(input, options) { const response = await original.call(this, input, options); const url = new URL(typeof input === 'string' ? input : input.url, location.href); if (url.pathname === '/api/recurring-shifts/commit' && options?.method === 'POST' && response.status === 201) { window.fetch = original; window.__recurringBodyFault = { mode, status: 201 }; if (mode === 'empty') return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } }); Object.defineProperty(response, 'json', { value: async () => { throw new DOMException('Synthetic successful batch body aborted', 'AbortError'); } }); } return response; }; }, mode);
    }
    const clickingCommit = commitButton(page).click({ noWaitAfter: true });
    if (mode === '503') {
      await committedSignal.promise;
      assert.equal(await commitButton(page).isEnabled(), false); assert.equal(await previewButton(page).isEnabled(), false);
      assert.equal(await dialogOf(page).getByLabel('交班備註', { exact: true }).isEnabled(), false);
      await page.keyboard.press('Escape'); assert.equal(await dialogOf(page).count(), 1); assert.equal(await page.getByRole('dialog').count(), 1);
      await dialogOf(page).getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await dialogOf(page).count(), 1);
      await screenshot(page, 'recurring-commit-busy-locked.png'); releaseCommit.resolve();
    }
    await clickingCommit;
    await dialogOf(page).getByRole('alert').first().waitFor();
    assert.equal(await dialogOf(page).getByLabel('交班備註', { exact: true }).inputValue(), opened.definition.note); assert.equal(await serviceQuantity(page).inputValue(), '2'); assert.equal(await commitButton(page).isEnabled(), true);
    if (mode !== '503') assert.deepEqual(await page.evaluate(() => window.__recurringBodyFault), { mode, status: 201 });
    const committedCounts = counts(); const committedRows = await rows('shifts', `caseId=${recovery.item.id}`); assert.equal(committedRows.filter(item => dates.includes(item.date)).length, 3);
    await screenshot(page, `recurring-success-${mode}-retained.png`); await commit(opened.definition, dates); assert.deepEqual(counts(), committedCounts);
    const attempts = commitRequests.slice(keyStart); assert.equal(attempts.length, 2); assert.ok(attempts[0].key); assert.equal(attempts[0].key, attempts[1].key); assert.deepEqual(attempts[0].body, attempts[1].body);
    if (mode === '503') await page.unroute(commitPattern);
  }
  mark('commit忙碌鎖欄位且Escape/取消不關閉；3批真201後503/JSON AbortError/空body均保留預覽，同key同body重試無重複寫入');

  opened = await open(recovery, { startDate: '2027-02-01', endDate: '2027-02-05', intervalWeeks: 1 }); before = counts();
  let previewAttempts = 0; await page.route(previewPattern, route => { previewAttempts++; if (previewAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_PREVIEW_FAILURE', message: '合成預覽讀取失敗，請重試' } }) }); return route.continue(); });
  await previewButton(page).click(); await dialogOf(page).getByRole('alert').first().waitFor(); assert.equal(await commitButton(page).isEnabled(), false); assert.equal(await dialogOf(page).getByLabel('開始日期', { exact: false }).inputValue(), '2027-02-01'); await screenshot(page, 'recurring-preview-retry-error.png'); await preview(); assert.equal(previewAttempts, 2); assert.deepEqual(counts(), before); await page.unroute(previewPattern);
  mark('預覽503保留所有输入且不可提交；同預覽按鈕重試成功，全流程零寫入');

  const arrived = deferred(), release = deferred(), handled = deferred();
  await page.route(previewPattern, async route => { const data = route.request().postDataJSON(); if (data.note !== '合成慢預覽' || data.endDate !== '2027-02-05') return route.continue(); try { const real = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response: real }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { handled.resolve(); } });
  await setField(page, 'note', '合成慢預覽'); await previewButton(page).click(); await arrived.promise; await setField(page, 'endDate', '2027-02-03'); await preview(); release.resolve(); await handled.promise; await settle(page); assert.equal(await previewOf(page).locator('.recurring-date-card').count(), 2); assert.equal(await dialogOf(page).getByLabel('結束日期', { exact: false }).inputValue(), '2027-02-03'); await page.unroute(previewPattern); assert.deepEqual(counts(), before); await closeDirty(page);
  mark('慢預覽途中修改欄位中止舊請求；新2日結果不被晚到3日覆蓋，沒有寫入');

  opened = await open(recovery, { startDate: '2027-02-08', endDate: '2027-02-12', intervalWeeks: 1 }); before = counts();
  const cancelArrived = deferred(), releaseCancel = deferred(), cancelHandled = deferred();
  await page.route(previewPattern, async route => { try { const real = await route.fetch(); cancelArrived.resolve(); await releaseCancel.promise; await route.fulfill({ response: real }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { cancelHandled.resolve(); } });
  await previewButton(page).click(); await cancelArrived.promise; await page.keyboard.press('Escape'); let dirty = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }); await dirty.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await dialogOf(page).getByLabel('開始日期', { exact: false }).inputValue(), '2027-02-08'); await closeDirty(page); assert.ok(await opened.trigger.evaluate(node => node === document.activeElement)); releaseCancel.resolve(); await cancelHandled.promise; await settle(page); assert.equal(await dialogOf(page).count(), 0); assert.deepEqual(counts(), before); await page.unroute(previewPattern);
  mark('慢預覽可Escape取消，取消放棄保留輸入、確認放棄回復焦點；晚回應不復活dialog且零寫入');

  opened = await open(recovery, { startDate: '2027-02-15', endDate: '2027-02-19', intervalWeeks: 1 }); before = counts();
  const orgArrived = deferred(), releaseOrg = deferred(), orgHandled = deferred();
  await page.route(previewPattern, async route => { try { const real = await route.fetch(); orgArrived.resolve(); await releaseOrg.promise; await route.fulfill({ response: real }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { orgHandled.resolve(); } });
  await previewButton(page).click(); await orgArrived.promise;
  // Programmatically dispatch the real organisation control, representing an external context change while the modal is open.
  await page.getByLabel('目前機構', { exact: true }).evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, otherOrg.id);
  await page.waitForFunction(organizationId => document.querySelector('#organization')?.value === organizationId, otherOrg.id);
  releaseOrg.resolve(); await orgHandled.promise; await settle(page); assert.deepEqual(counts(), before);
  if (await dialogOf(page).count()) { assert.equal(await commitButton(page).isEnabled(), false); await closeDirty(page); }
  assert.equal(await page.locator('.recurring-date-card').count(), 0); assert.equal(await page.locator('.toast-success').count(), 0); await page.unroute(previewPattern);
  await page.getByLabel('目前機構', { exact: true }).selectOption(orgId); await page.getByRole('button', { name: '週期排班', exact: true }).waitFor();
  opened = await open(recovery, { startDate: '2027-03-08', endDate: '2027-03-12', intervalWeeks: 1 });
  const routeArrived = deferred(), releaseRoute = deferred(), routeHandled = deferred();
  await page.route(previewPattern, async route => { try { const real = await route.fetch(); routeArrived.resolve(); await releaseRoute.promise; await route.fulfill({ response: real }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { routeHandled.resolve(); } });
  await previewButton(page).click(); await routeArrived.promise; await page.evaluate(() => { location.hash = '/cases'; }); await page.getByRole('heading', { name: '個案', level: 1, exact: true }).waitFor();
  releaseRoute.resolve(); await routeHandled.promise; await settle(page); assert.deepEqual(counts(), before);
  if (await dialogOf(page).count()) { assert.equal(await commitButton(page).isEnabled(), false); await closeDirty(page); }
  assert.equal(await page.locator('.recurring-date-card').count(), 0); await page.unroute(previewPattern);
  mark('真機構control切換及hash換頁後，慢預覽不能跨context顯示或提交/成功toast；資料零變動');

  opened = await open(recovery, { startDate: '2027-02-22', endDate: '2027-02-26', intervalWeeks: 1 }, supervisor.page); result = await preview(supervisor.page); await commit(opened.definition, result.items.map(item => item.date), supervisor.page, actors.supervisor.id);
  const unauthorizedDefinition = definitions(main, { startDate: '2027-03-01', endDate: '2027-03-05', intervalWeeks: 1 }); before = counts();
  for (const actor of [caregiver, finance]) {
    for (const operation of ['preview', 'commit']) await request('POST', `recurring-shifts/${operation}`, unauthorizedDefinition, 403, actor.client, actor.auth, orgId, { 'Idempotency-Key': `synthetic-denied-${operation}` });
    await actor.page.goto(`${base}/#/shifts`); await actor.page.waitForLoadState('networkidle'); assert.equal(await actor.page.getByRole('button', { name: '週期排班', exact: true }).count(), 0);
  }
  assert.deepEqual(counts(), before); mark('admin與supervisor真UI可提交並保存實際actor；caregiver/finance兩API403且無維護入口，拒絕零寫入');

  for (const [entity, saved] of oldMasters) {
    const current = await rows(entity);
    assert.deepEqual(current.filter(item => item.id !== inactive.plan.id), saved.filter(item => item.id !== inactive.plan.id));
  }
  for (const saved of oldMasterVersions.filter(item => item.id !== inactive.plan.id)) assert.deepEqual(app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(saved.id), saved.versions);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /409|422|503/.test(message)), JSON.stringify(consoleErrors));
  assert.equal(failedResponses.filter(item => item.status === 409).length, 2); assert.equal(failedResponses.filter(item => item.status === 503).length, 2); assert.equal(failedResponses.filter(item => item.status === 422).length, 1);
  mark('除明確競態fixture之計畫停用外，原個案/員工/計畫/服務主檔與完整版本歷程不變；0pageerror，僅預期409/422/503');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium', checks, screenshots, pageErrors, consoleErrors, failedResponses, previewEvidence, batchEvidence, finalCounts: counts(), mainBatchId: mainBatch.batchId }, null, 2));
  console.log(`Recurring shifts E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, previewEvidence, batchEvidence, error: error.stack }, null, 2)); throw error;
} finally {
  for (const context of contexts) await context.close(); await browser?.close(); await app.close();
}
