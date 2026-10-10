import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, insert, saveVersion } from '../src/server/model.mjs';

// Synthetic data, actual browser/API and a random port. Never opens the disk database.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/shift-history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-shift-history-password';
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: response.status() === 503 && /\/history\?/.test(response.url()) });
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
const historyTitle = '班次版本歷程';
const serviceCard = (page, name) => page.locator('.service-card').filter({ hasText: name });
const rawState = () => ({
  records: app.db.prepare('SELECT * FROM records ORDER BY id').all(),
  versions: app.db.prepare('SELECT * FROM record_versions ORDER BY record_id,version').all(),
});

try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成班次歷程管理員', email: 'shift-history-admin@example.test', password, organizationName: '合成班次歷程甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const result = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(result)}`); return result;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const get = async (entity, item) => (await request('GET', `${entity}/${item.id}`)).item;
  const employeeA = await post('employees', { name: '合成原承接居服員', employeeNo: 'SH-EA', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成代班居服員', employeeNo: 'SH-EB', role: 'caregiver', hourlyRateCents: 32000 });
  const users = {};
  for (const [role, name, employee] of [['supervisor', 'supervisor'], ['caregiver', 'carer-a', employeeA], ['caregiver', 'carer-b', employeeB], ['finance', 'finance']]) users[name] = await post('users', { name: `合成班次${name}`, email: `shift-history-${name}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const loginAs = async name => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `shift-history-${name}@example.test`, password } });
    assert.equal(response.status(), 200); const auth = await response.json(), page = await client.newPage(); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), carerA = await loginAs('carer-a'), carerB = await loginAs('carer-b'), finance = await loginAs('finance');
  const adminPage = await context.newPage(); observe(adminPage); const page = supervisor.page;
  const serviceA = await post('service-items', { code: 'SH-A', name: '合成生活服務', minutes: 30, unitPriceCents: 10000 });
  const serviceB = await post('service-items', { code: 'SH-B', name: '合成外出服務', minutes: 30, unitPriceCents: 15000 });
  let index = 0;
  const fixture = async name => {
    const item = await post('cases', { name: `合成${name}個案`, caseNo: `SH-C${++index}`, note: '合成個案注意事項' });
    const plan = await post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 20 }, { serviceItemId: serviceB.id, quantity: 20 }] });
    return { item, plan };
  };
  const main = await fixture('改派前後'), cancelled = await fixture('取消歷程'), completed = await fixture('核閱完成'), pagination = await fixture('跨頁歷程');
  const oldCase = await fixture('舊案不得揭露'), newCase = await fixture('換案目前'), retainedOld = await fixture('舊案仍授權'), retainedNew = await fixture('保留舊案新案');
  const unknown = await fixture('名稱不可取得'), empty = await fixture('空歷程'), filtered = await fixture('其他機構歷史');
  const shiftData = (source, date, more = {}) => ({ caseId: source.item.id, carePlanId: source.plan.id, employeeId: employeeA.id, date, startTime: '09:00', endTime: '10:00', status: 'scheduled', services: [{ serviceItemId: serviceA.id, quantity: 1 }], note: '合成初版交班', ...more });
  let mainShift = await post('shifts', shiftData(main, '2026-10-05'));
  let cancelledShift = await post('shifts', shiftData(cancelled, '2026-10-07'));
  let completedShift = await post('shifts', shiftData(completed, '2026-10-09'));
  let pageShift = await post('shifts', shiftData(pagination, '2026-10-20', { note: '合成分頁第1版' }));
  for (let version = 2; version <= 28; version++) pageShift = await patch('shifts', pageShift, { note: `合成分頁第${version}版` });
  let movedCaseShift = await post('shifts', shiftData(oldCase, '2026-10-12', { note: 'HIDDEN-OLD-CASE-SNAPSHOT' }));
  movedCaseShift = await patch('shifts', movedCaseShift, { caseId: newCase.item.id, carePlanId: newCase.plan.id, note: '合成目前可見換案備註' });
  let retainedCaseShift = await post('shifts', shiftData(retainedOld, '2026-10-13', { note: '合成仍授權舊案保存值' }));
  retainedCaseShift = await patch('shifts', retainedCaseShift, { caseId: retainedNew.item.id, carePlanId: retainedNew.plan.id, note: '合成新案保存值' });
  await post('shifts', shiftData(retainedOld, '2026-10-14', { status: 'cancelled', note: '合成取消班仍保留既有個案授權' }));
  const otherOrg = (await request('POST', 'organizations', { name: '合成班次歷程乙機構' }, 201)).item;
  const foreignCase = (await request('POST', 'cases', { name: '合成跨機構不可見個案', caseNo: 'SH-FOREIGN' }, 201, context, admin, otherOrg.id)).item;
  const foreignEmployee = (await request('POST', 'employees', { name: '合成跨機構員工', employeeNo: 'SH-FOREIGN', role: 'caregiver' }, 201, context, admin, otherOrg.id)).item;
  const foreignService = (await request('POST', 'service-items', { code: 'SH-FOREIGN', name: '合成跨機構服務', minutes: 30, unitPriceCents: 100 }, 201, context, admin, otherOrg.id)).item;
  const foreignPlan = (await request('POST', 'care-plans', { caseId: foreignCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: foreignService.id, quantity: 1 }] }, 201, context, admin, otherOrg.id)).item;
  const foreignShift = (await request('POST', 'shifts', { caseId: foreignCase.id, carePlanId: foreignPlan.id, employeeId: foreignEmployee.id, date: '2026-10-05', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: foreignService.id, quantity: 1 }] }, 201, context, admin, otherOrg.id)).item;

  // Only import-style fixtures use direct memory inserts; no immutable versions are changed or deleted.
  const unknownShift = insert(app.db, orgId, 'shifts', shiftData(unknown, '2026-10-21', { employeeId: id(), carePlanId: id(), services: [{ serviceItemId: id(), quantity: 7 }], note: '合成舊資料未留目前主檔與操作者' }));
  const time = now(), emptyShift = { ...shiftData(empty, '2026-10-22'), id: id(), orgId, version: 1, createdAt: time, updatedAt: time };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(emptyShift.id, orgId, 'shifts', JSON.stringify(shiftData(empty, '2026-10-22')), 1, time, time);
  const filteredShift = { ...shiftData(filtered, '2026-10-23'), id: id(), orgId, version: 2, createdAt: time, updatedAt: time };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(filteredShift.id, orgId, 'shifts', JSON.stringify(shiftData(filtered, '2026-10-23')), 2, time, time);
  saveVersion(app.db, filteredShift, 'baseline');
  app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, 'shifts', filteredShift.id, 1, JSON.stringify({ ...filteredShift, version: 1, caseId: foreignCase.id, note: 'HIDDEN-FOREIGN-CASE-SNAPSHOT' }), time, 'baseline');

  // Supervisor's real edit UI creates a meaningful before/after version.
  await load(page, '/shifts', '班表'); await page.getByLabel('服務月份', { exact: true }).fill('2026-10');
  await rowNamed(page, main.item.name).getByRole('button', { name: '調整／代班', exact: true }).click(); let dialog = page.getByRole('dialog');
  await dialog.getByLabel('服務人員', { exact: false }).selectOption(employeeB.id); await dialog.getByLabel('服務日期', { exact: false }).fill('2026-10-06');
  await dialog.getByLabel('開始時間', { exact: false }).fill('10:30'); await dialog.getByLabel('結束時間', { exact: false }).fill('11:30');
  await dialog.locator('select[name="servicesIntent"]').selectOption('replace');
  await dialog.getByLabel('SH-A 合成生活服務 數量', { exact: true }).fill('3'); await dialog.getByLabel('SH-B 合成外出服務 數量', { exact: true }).fill('2');
  await dialog.getByLabel('交班備註', { exact: true }).fill('合成督導改派並補服務'); await saveDialog(page);
  mainShift = await get('shifts', mainShift); assert.equal(mainShift.version, 2); assert.equal(mainShift.employeeId, employeeB.id); assert.equal(mainShift.date, '2026-10-06'); assert.equal(mainShift.services.length, 2);
  const bHistory = await request('GET', `shifts/${mainShift.id}/history?compare=previous`, undefined, 200, carerB.client, carerB.auth); assert.deepEqual(bHistory.items.map(item => item.version), [2]); assert.equal(bHistory.items[0].comparison.status, 'unavailable');
  mainShift = await patch('shifts', mainShift, { employeeId: employeeA.id, note: '合成管理員改派回原承接者' }); assert.equal(mainShift.version, 3);
  mark('督導真UI改派A→B並改日期/時段/兩項服務數量，API改回A保存v3；B承接期間只能讀自己的v2');

  await rowNamed(page, cancelled.item.name).getByRole('button', { name: '取消班次', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '確認取消班次', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  cancelledShift = await get('shifts', cancelledShift); assert.equal(cancelledShift.status, 'cancelled'); assert.equal(cancelledShift.version, 2);
  const serviceRecord = await post('service-records', { shiftId: completedShift.id, caseId: completedShift.caseId, employeeId: completedShift.employeeId, date: completedShift.date, actualStart: '09:02', actualEnd: '10:03', services: completedShift.services, status: 'submitted', note: '合成真實核閱服務紀錄' });
  await load(page, '/records', '服務紀錄與核閱'); await rowNamed(page, completed.item.name).getByRole('button', { name: '核閱', exact: true }).click();
  await page.getByRole('dialog').getByLabel('核閱說明', { exact: true }).fill('合成督導確認完成'); await saveDialog(page);
  completedShift = await get('shifts', completedShift); const approvedRecord = await get('service-records', serviceRecord); assert.equal(completedShift.version, 2); assert.equal(completedShift.status, 'completed'); assert.equal(approvedRecord.status, 'approved'); assert.ok(approvedRecord.billingSnapshot);
  const beforeRejected = counts(); await request('PATCH', `shifts/${completedShift.id}`, { version: 2, employeeId: employeeB.id }, 409); assert.deepEqual(counts(), beforeRejected);
  mark('真UI取消班次留v2；真UI核閱使班次自動完成，核閱價格快照已保存，已有服務紀錄仍禁止改派');

  // Every subsequent action is read-only, including rejected lookups, retries and stale responses.
  const beforeReads = counts(), beforeState = rawState();
  const historyFor = (item, actor = { client: context, auth: admin }, compare = true) => request('GET', `shifts/${item.id}/history${compare ? '?compare=previous' : ''}`, undefined, 200, actor.client, actor.auth);
  let result = await historyFor(mainShift); assert.deepEqual(result.items.map(item => item.version), [3, 2, 1]); assert.deepEqual(result.items[1].actor, { id: users.supervisor.id, name: users.supervisor.name }); assert.equal(result.items[0].actor.id, admin.user.id); assert.equal(result.items[0].comparison.previousVersion, 2);
  result = await historyFor(completedShift); assert.deepEqual(result.items[0].actor, { id: users.supervisor.id, name: users.supervisor.name }); assert.equal(result.items[0].snapshot.status, 'completed'); assert.equal(result.items[0].comparison.previousSnapshot.status, 'scheduled');
  const completeAudit = app.db.prepare("SELECT * FROM audit WHERE action='shift.complete' AND record_id=?").get(completedShift.id); assert.equal(completeAudit.user_id, users.supervisor.id); assert.equal(JSON.parse(completeAudit.detail).version, 2);
  mark('精確版本actor可識別管理員/督導；shift.complete歷程使用實際核閱者，完成前後狀態正確');

  await load(adminPage, '/shifts', '班表'); await adminPage.getByLabel('服務月份', { exact: true }).fill('2026-10');
  let trigger = rowNamed(adminPage, main.item.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.focus(); await trigger.press('Enter');
  dialog = adminPage.getByRole('dialog', { name: historyTitle, exact: true }); await dialog.getByText('第 3 版', { exact: true }).waitFor(); let card = versionCard(dialog, 2); await card.locator(':scope > summary').click();
  const employeeRow = card.getByRole('row').filter({ hasText: '服務人員' }); await employeeRow.getByText(`目前名稱：${employeeA.name}`, { exact: true }).waitFor(); await employeeRow.getByText(`目前名稱：${employeeB.name}`, { exact: true }).waitFor();
  const serviceRow = card.getByRole('row').filter({ hasText: '服務項目與排班數量' }); await serviceRow.getByText('排班數量：3', { exact: true }).waitFor(); await serviceRow.getByText('排班數量：2', { exact: true }).waitFor();
  await card.getByRole('row').filter({ hasText: '服務日期' }).getByText('2026/10/06', { exact: true }).waitFor(); await card.getByRole('row').filter({ hasText: '開始時間' }).getByText('10:30', { exact: true }).waitFor();
  await card.getByText('完整保存欄位', { exact: true }).click(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await inspectLayout(adminPage); await screenshot(adminPage, 'shift-reassignment-history-desktop.png');
  await adminPage.setViewportSize({ width: 390, height: 844 }); await inspectLayout(adminPage); await card.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; }); await screenshot(adminPage, 'shift-reassignment-history-mobile-after.png');
  await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'shift-snapshot-mobile.png'); assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|還原|發送/ }).count(), 0);
  await closeHistory(adminPage, trigger); await adminPage.setViewportSize({ width: 1440, height: 1050 });
  mark('管理者班表鍵盤入口顯示真改派/日期時間/服務排班數量前後值；1440/390內部捲動、完整快照及Escape焦點通過');

  await load(carerA.page, '/my-services', '我的服務'); await carerA.page.getByLabel('服務日期', { exact: true }).fill(mainShift.date); trigger = serviceCard(carerA.page, main.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(carerA.page, trigger, historyTitle, 3);
  card = versionCard(dialog, 3); await card.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor(); assert.equal(await dialog.getByText('第 2 版', { exact: true }).count(), 0); await dialog.getByText('第 1 版', { exact: true }).waitFor();
  assert.ok(!(await dialog.textContent()).includes(employeeB.name)); await carerA.page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(carerA.page); await screenshot(carerA.page, 'shift-caregiver-gap-mobile.png'); await closeHistory(carerA.page, trigger); await carerA.page.setViewportSize({ width: 1440, height: 1050 });
  for (const compare of [false, true]) { result = await historyFor(mainShift, carerA, compare); assert.deepEqual(result.items.map(item => item.version), [3, 1]); assert.ok(!JSON.stringify(result).includes(employeeB.id)); if (compare) assert.deepEqual(result.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null }); }
  for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `shifts/${mainShift.id}${suffix}`, undefined, 404, carerB.client, carerB.auth);
  mark('我的服務A→B→A僅見v3/v1，不以v1充當前版；raw/compare不洩漏B，改派出去的B目前detail/history皆404');

  for (const compare of [false, true]) {
    result = await historyFor(movedCaseShift, carerA, compare); assert.deepEqual(result.items.map(item => item.version), [2]); assert.ok(!JSON.stringify(result).includes('HIDDEN-OLD-CASE-SNAPSHOT')); assert.ok(!JSON.stringify(result).includes(oldCase.item.id));
    result = await historyFor(retainedCaseShift, carerA, compare); assert.deepEqual(result.items.map(item => item.version), [2, 1]); if (compare) assert.equal(result.items[0].comparison.status, 'available');
  }
  await request('GET', `cases/${oldCase.item.id}`, undefined, 404, carerA.client, carerA.auth);
  await carerA.page.getByLabel('服務日期', { exact: true }).fill(movedCaseShift.date); trigger = serviceCard(carerA.page, newCase.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(carerA.page, trigger, historyTitle, 2); await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor(); assert.ok(!(await dialog.textContent()).includes(oldCase.item.name)); await screenshot(carerA.page, 'shift-case-scope-gap.png'); await closeHistory(carerA.page, trigger);
  for (const actor of [{ client: context, auth: admin }, supervisor, carerA, finance]) for (const compare of [false, true]) { result = await historyFor(filteredShift, actor, compare); assert.deepEqual(result.items.map(item => item.version), [2]); assert.ok(!JSON.stringify(result).includes('HIDDEN-FOREIGN-CASE-SNAPSHOT')); }
  mark('同員工換案隱藏目前未授權舊案；另有取消班仍授權舊案則可比較；所有角色raw/compare均排除跨機構歷史case');

  for (const [item, source, state] of [[cancelledShift, cancelled, '已取消'], [completedShift, completed, '已完成']]) {
    trigger = rowNamed(adminPage, source.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, historyTitle, 2); card = versionCard(dialog, 2);
    await card.getByRole('row').filter({ hasText: '班次狀態' }).getByText(state, { exact: true }).waitFor(); await card.getByText(users.supervisor.name, { exact: true }).waitFor(); await screenshot(adminPage, item.id === cancelledShift.id ? 'shift-cancelled-history.png' : 'shift-completed-reviewer-history.png'); await closeHistory(adminPage, trigger);
  }
  mark('已取消與已核閱完成班次仍有唯讀入口，狀態差異與實際督導操作者可讀');

  trigger = rowNamed(adminPage, pagination.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, historyTitle, 28); assert.equal(await dialog.locator('.history-version').count(), 25);
  card = versionCard(dialog, 4); await card.locator(':scope > summary').click(); await card.getByText('與第 3 版比較', { exact: true }).waitFor(); await card.getByText('合成分頁第3版', { exact: true }).waitFor(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'shift-history-page-boundary.png');
  await dialog.getByRole('button', { name: '下一頁', exact: true }).click(); await dialog.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(await dialog.locator('.history-version').count(), 3); await versionCard(dialog, 3).getByText('與第 2 版比較', { exact: true }).waitFor(); await screenshot(adminPage, 'shift-history-page-two.png'); await closeHistory(adminPage, trigger);
  result = await request('GET', `shifts/${pageShift.id}/history?compare=previous&page=1&pageSize=25`); assert.equal(result.items.at(-1).version, 4); assert.equal(result.items.at(-1).comparison.previousVersion, 3);
  mark('28版以25+3分頁；第一頁最後v4仍精確比較頁外v3，第二頁v3比較v2，沒有跳版');

  trigger = rowNamed(adminPage, unknown.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, historyTitle, 1); await dialog.getByText('未記錄操作者', { exact: true }).waitFor(); await dialog.getByText('完整保存欄位', { exact: true }).click(); assert.ok(await dialog.getByText('目前名稱無法取得', { exact: true }).count() >= 2); await screenshot(adminPage, 'shift-history-unknown-reference.png'); await closeHistory(adminPage, trigger);
  trigger = rowNamed(adminPage, empty.item.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = adminPage.getByRole('dialog', { name: historyTitle, exact: true }); await dialog.getByText('尚無可讀取的版本歷程。', { exact: true }).waitFor(); await screenshot(adminPage, 'shift-history-empty.png'); await closeHistory(adminPage, trigger);
  mark('合法匯入fixture缺目前主檔不猜姓名，缺audit不猜操作者；空歷程顯示明確空狀態且可關閉');

  const pattern = `**/api/shifts/${mainShift.id}/history?*`; let attempts = 0;
  await adminPage.route(pattern, route => { attempts++; if (attempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_READ_FAILURE', message: '合成班次歷程讀取失敗，請重試' } }) }); return route.continue(); });
  trigger = rowNamed(adminPage, main.item.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = adminPage.getByRole('dialog'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); await screenshot(adminPage, 'shift-history-read-retry.png'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(attempts, 2); await closeHistory(adminPage, trigger); await adminPage.unroute(pattern);
  const arrived = deferred(), release = deferred(), handled = deferred();
  await adminPage.route(pattern, async route => { try { const real = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response: real }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { handled.resolve(); } });
  const aborted = adminPage.waitForEvent('requestfailed', { predicate: req => req.url().includes(`/shifts/${mainShift.id}/history`), timeout: 10000 });
  await trigger.click(); await arrived.promise; await adminPage.getByRole('dialog').getByText('正在讀取歷程…', { exact: true }).waitFor(); await closeHistory(adminPage, trigger); release.resolve(); await handled.promise; assert.match((await aborted).failure()?.errorText || '', /abort|cancel/i); await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').count(), 0); await adminPage.unroute(pattern);
  mark('歷程503可重試取得真API；慢讀取Escape會取消請求且焦點回復，晚回應不復活dialog');

  for (const mode of ['organization', 'route']) {
    await load(adminPage, '/shifts', '班表'); trigger = rowNamed(adminPage, main.item.name).getByRole('button', { name: '版本歷程', exact: true });
    const arrived = deferred(), release = deferred(), handled = deferred();
    await adminPage.route(pattern, async route => { try { const real = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response: real }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { handled.resolve(); } });
    await trigger.click(); await arrived.promise;
    if (mode === 'organization') await adminPage.getByLabel('目前機構', { exact: true }).evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, otherOrg.id);
    else await adminPage.evaluate(() => { location.hash = '/cases'; });
    await adminPage.waitForFunction(mode => mode === 'organization' ? document.querySelector('#organization')?.selectedOptions[0]?.textContent.includes('乙機構') : location.hash === '#/cases', mode);
    release.resolve(); await handled.promise; await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').locator('.history-version').count(), 0); await closeHistory(adminPage); await adminPage.unroute(pattern);
    if (mode === 'organization') await adminPage.getByLabel('目前機構', { exact: true }).selectOption(orgId);
  }
  mark('真機構context切換與hash換頁後，晚到的歷程不顯示舊個案版本或跨scope資料');

  for (const actor of [{ client: context, auth: admin }, supervisor, carerA, finance]) for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `shifts/${foreignShift.id}${suffix}`, undefined, 404, actor.client, actor.auth);
  for (const suffix of ['?compare=unknown', '?compare=previous&compare=previous']) await request('GET', `shifts/${mainShift.id}/history${suffix}`, undefined, 422);
  result = await historyFor(mainShift, finance); assert.equal(result.total, 3); await finance.page.goto(`${base}/#/shifts`); await finance.page.waitForLoadState('networkidle'); assert.equal(await finance.page.getByRole('button', { name: '版本歷程', exact: true }).count(), 0);
  assert.deepEqual(await get('service-records', serviceRecord), approvedRecord); assert.deepEqual(rawState(), beforeState); assert.deepEqual(counts(), beforeReads); assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /503/.test(message)), JSON.stringify(consoleErrors));
  mark('四角色跨機構detail/raw/compare404、非法compare422；finance既有API可讀但不新增排班頁；所有讀取零DB寫入且完整主檔/版本/billing快照不變');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium', checks, screenshots, pageErrors, consoleErrors, failedResponses, readonlyCounts: { before: beforeReads, after: counts() }, allRecordsAndVersionsUnchanged: true, billingSnapshotUnchanged: true }, null, 2));
  console.log(`Shift history E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, error: error.stack }, null, 2)); throw error;
} finally {
  for (const context of contexts) await context.close(); await browser?.close(); await app.close();
}
