import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, initDb } from '../src/server/model.mjs';

// Synthetic data, actual browser/API and a random port. Never opens the disk database.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-history-password';
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
  await page.goto(`${base}/#${route}`);
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
  await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
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
});
await mkdir(output, { recursive: true });

try {
  base = await app.listen();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const adminPage = await context.newPage(); observe(adminPage);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成歷程管理員', email: 'history-admin@example.test', password, organizationName: '合成歷程驗證機構' } });
  assert.equal(setup.status(), 201, await setup.text());
  const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const result = await response.json();
    assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(result)}`);
    return result;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const employee = await post('employees', { name: '合成歷程居服員', employeeNo: 'HISTORY-E01', role: 'caregiver' });
  const actors = {};
  for (const role of ['supervisor', 'caregiver', 'finance']) actors[role] = await post('users', { name: `合成歷程${role}`, email: `history-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
  const loginAs = async role => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `history-${role}@example.test`, password } });
    assert.equal(response.status(), 200, await response.text());
    const auth = await response.json(), page = await client.newPage(); observe(page);
    return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), caregiver = await loginAs('caregiver'), finance = await loginAs('finance');
  const serviceA = await post('service-items', { code: 'TEST-H-A', name: '合成生活協助', minutes: 30, unitPriceCents: 10000 });
  const serviceB = await post('service-items', { code: 'TEST-H-B', name: '合成陪同外出', minutes: 30, unitPriceCents: 12000 });
  const caseA = await post('cases', { name: '合成核心個案', caseNo: 'HISTORY-C01', phone: '合成電話第一版', contactName: '合成聯絡人第一版', contactPhone: '合成聯絡電話', note: '合成照顧注意事項' });
  const caseB = await post('cases', { name: '合成其他個案', caseNo: 'HISTORY-C02', note: 'HIDDEN-SYNTHETIC-CASE' });
  const planData = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 2 }], goals: '合成目標第一版' });
  const plan = await post('care-plans', planData(caseA.id));
  const hiddenOldPlan = await post('care-plans', { ...planData(caseB.id), goals: 'HIDDEN-SYNTHETIC-PLAN' });
  const visiblePlan = await patch('care-plans', hiddenOldPlan, { caseId: caseA.id, goals: '合成可見計畫第二版' });
  await post('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: visiblePlan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: serviceA.id, quantity: 1 }] });
  let paginationCase = await post('cases', { name: '合成分頁個案', caseNo: 'HISTORY-PAGE', note: '合成分頁第1版' });
  for (let version = 2; version <= 28; version++) paginationCase = await patch('cases', paginationCase, { note: `合成分頁第${version}版` });
  const baselineId = id(), time = now();
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(baselineId, orgId, 'cases', JSON.stringify({ name: '合成基準個案', caseNo: 'HISTORY-BASELINE', status: 'active', note: '合成舊資料基準' }), 4, time, time);
  initDb(app.db);

  // Real UI edits establish v2 values, with the supervisor's actual authenticated identity.
  const page = supervisor.page;
  await load(page, '/cases', '個案');
  await rowNamed(page, caseA.name).getByRole('button', { name: '編輯', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('聯絡電話', { exact: true }).fill('合成電話第二版');
  await dialog.getByLabel('聯絡人姓名', { exact: true }).fill('合成聯絡人第二版');
  await saveDialog(page);
  const updatedCase = (await request('GET', `cases/${caseA.id}`)).item;
  assert.equal(updatedCase.version, 2); assert.equal(updatedCase.phone, '合成電話第二版'); assert.equal(updatedCase.contactName, '合成聯絡人第二版');
  await load(page, '/plans', '照顧計畫');
  await rowNamed(page, '合成目標第一版').getByRole('button', { name: '編輯', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('照顧目標', { exact: true }).fill('合成目標第二版');
  await dialog.locator('select[name="servicesIntent"]').selectOption('replace');
  await dialog.getByLabel('TEST-H-B 合成陪同外出 數量', { exact: true }).fill(String(plan.services.find(service => service.serviceItemId === serviceB.id).quantity));
  await dialog.getByLabel('TEST-H-A 合成生活協助 數量', { exact: true }).fill('3');
  await saveDialog(page);
  const updatedPlan = (await request('GET', `care-plans/${plan.id}`)).item;
  assert.equal(updatedPlan.version, 2); assert.equal(updatedPlan.goals, '合成目標第二版');
  assert.equal(updatedPlan.services.find(service => service.serviceItemId === serviceA.id).quantity, 3);
  mark('真實督導透過 UI 修改個案電話/聯絡人與計畫目標/服務數量，API 保存第二版');

  // All following operations are reads. Even the retry and abort must not write to SQLite.
  const beforeReads = counts();
  for (const [entity, item] of [['cases', caseA], ['care-plans', plan]]) {
    const history = await request('GET', `${entity}/${item.id}/history?compare=previous`);
    assert.equal(history.total, 2);
    assert.deepEqual(history.items[0].actor, { id: actors.supervisor.id, name: actors.supervisor.name });
    assert.deepEqual(history.items[1].actor, { id: admin.user.id, name: admin.user.name });
    assert.equal(history.items[0].comparison.previousVersion, 1);
    assert.deepEqual(history.items[0].comparison.previousSnapshot, history.items[1].snapshot);
    assert.deepEqual(history.items[1].comparison, { status: 'initial', previousVersion: null, previousSnapshot: null });
  }
  mark('API 使用真實 admin/supervisor 操作者，精確前版快照及 initial 語意正確');

  await load(page, '/cases', '個案');
  let trigger = rowNamed(page, caseA.name).getByRole('button', { name: '版本歷程', exact: true });
  dialog = await openHistory(page, trigger, '個案版本歷程');
  let card = versionCard(dialog, 2);
  await card.getByRole('row').filter({ hasText: '聯絡電話' }).getByText('合成電話第一版', { exact: true }).waitFor();
  await card.getByRole('row').filter({ hasText: '聯絡電話' }).getByText('合成電話第二版', { exact: true }).waitFor();
  await card.getByRole('row').filter({ hasText: '聯絡人姓名' }).getByText('合成聯絡人第一版', { exact: true }).waitFor();
  await card.getByText('操作者（目前名稱）', { exact: true }).waitFor();
  await card.getByText(actors.supervisor.name, { exact: true }).waitFor();
  await card.getByText('完整保存欄位', { exact: true }).click();
  await inspectLayout(page); await screenshot(page, 'case-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await inspectLayout(page); await screenshot(page, 'case-history-mobile.png');
  await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await screenshot(page, 'case-snapshot-mobile.png');
  await closeHistory(page, trigger); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('個案列表歷程顯示 v2 聯絡欄位前後值、操作者、完整快照；桌機/手機及 Escape 焦點通過');

  await load(page, '/plans', '照顧計畫');
  trigger = rowNamed(page, '合成目標第二版').getByRole('button', { name: '版本歷程', exact: true });
  dialog = await openHistory(page, trigger, '照顧計畫版本歷程');
  card = versionCard(dialog, 2);
  await card.getByRole('row').filter({ hasText: '照顧目標' }).getByText('合成目標第一版', { exact: true }).waitFor();
  await card.getByRole('row').filter({ hasText: '照顧目標' }).getByText('合成目標第二版', { exact: true }).waitFor();
  const servicesRow = card.getByRole('row').filter({ hasText: '服務項目與計畫數量' });
  await servicesRow.getByText('計畫數量：1', { exact: true }).waitFor(); await servicesRow.getByText('計畫數量：3', { exact: true }).waitFor();
  await inspectLayout(page); await screenshot(page, 'plan-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await inspectLayout(page); await screenshot(page, 'plan-history-mobile.png');
  await card.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; });
  await screenshot(page, 'plan-history-mobile-after.png');
  await card.getByText('完整保存欄位', { exact: true }).click();
  await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await screenshot(page, 'plan-snapshot-mobile.png');
  await closeHistory(page, trigger); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('計畫列表歷程顯示目標與服務數量 1→3，手機比較表內捲動且完整快照單欄');

  await load(page, `/cases/${caseA.id}`, caseA.name);
  trigger = page.getByRole('button', { name: '個案版本歷程', exact: true });
  await openHistory(page, trigger, '個案版本歷程'); await closeHistory(page, trigger);
  trigger = rowNamed(page, '合成目標第二版').getByRole('button', { name: '計畫版本歷程', exact: true });
  await openHistory(page, trigger, '照顧計畫版本歷程'); await closeHistory(page, trigger);
  mark('個案詳細頁的個案與生效計畫兩個歷程入口均可讀且保留焦點');

  await load(page, '/cases', '個案');
  trigger = rowNamed(page, paginationCase.name).getByRole('button', { name: '版本歷程', exact: true });
  dialog = await openHistory(page, trigger, '個案版本歷程', 28);
  assert.equal(await dialog.locator('.history-version').count(), 25);
  card = versionCard(dialog, 4); await card.locator(':scope > summary').click();
  await card.getByText('與第 3 版比較', { exact: true }).waitFor();
  await card.getByText('合成分頁第3版', { exact: true }).waitFor();
  await card.getByRole('row').filter({ hasText: '照顧注意事項' }).getByText('合成分頁第4版', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('第 3 版', { exact: true }).count(), 0, 'Previous snapshot is available even when its card is on another page');
  await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await screenshot(page, 'history-page-boundary.png');
  await dialog.getByRole('button', { name: '下一頁', exact: true }).click();
  await dialog.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(await dialog.locator('.history-version').count(), 3);
  card = versionCard(dialog, 1); await card.locator(':scope > summary').click();
  await card.getByText('初始版本；沒有上一版本可比較。', { exact: true }).waitFor();
  await screenshot(page, 'history-page-two.png');
  await dialog.getByRole('button', { name: '上一頁', exact: true }).click(); await dialog.getByText('第 28 版', { exact: true }).waitFor();
  await closeHistory(page, trigger);
  mark('28 版分為 25+3 筆，第一頁第 4 版可比較第二頁第 3 版，前後翻頁及初始版正確');

  trigger = rowNamed(page, '合成基準個案').getByRole('button', { name: '版本歷程', exact: true });
  dialog = await openHistory(page, trigger, '個案版本歷程', 4);
  await dialog.getByText('未記錄操作者', { exact: true }).waitFor();
  await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor();
  const baseline = (await request('GET', `cases/${baselineId}/history?compare=previous`)).items[0];
  assert.equal(baseline.source, 'baseline'); assert.equal(baseline.actor, null);
  assert.deepEqual(baseline.comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
  await screenshot(page, 'history-baseline-unknown.png'); await closeHistory(page, trigger);
  mark('既有基準資料不虛構操作者，缺少精確上一版明示無法比較');

  const historyPattern = `**/api/cases/${caseA.id}/history?*`;
  let attempts = 0;
  await page.route(historyPattern, async route => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_READ_FAILURE', message: '合成單次讀取失敗，請重新讀取' } }) });
    await route.continue();
  });
  trigger = rowNamed(page, caseA.name).getByRole('button', { name: '版本歷程', exact: true });
  await trigger.click(); dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor();
  await screenshot(page, 'history-retry-error.png');
  await dialog.getByRole('button', { name: '重新讀取', exact: true }).click();
  await dialog.getByText('第 2 版', { exact: true }).waitFor(); assert.equal(attempts, 2);
  await closeHistory(page, trigger); await page.unroute(historyPattern);
  mark('單次歷程讀取失敗顯示可重試狀態，重試向真實 API 取得原始版本');

  let release, arrived, finished;
  const hold = new Promise(resolve => { release = resolve; });
  const fetched = new Promise(resolve => { arrived = resolve; });
  const handled = new Promise(resolve => { finished = resolve; });
  const abortedRequest = page.waitForEvent('requestfailed', { predicate: req => req.url().includes(`/api/cases/${caseA.id}/history`), timeout: 10000 });
  await page.route(historyPattern, async route => {
    try { const response = await route.fetch(); arrived(); await hold; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; }
    finally { finished(); }
  });
  await trigger.click(); await fetched;
  await page.getByRole('dialog').getByText('正在讀取歷程…', { exact: true }).waitFor();
  await closeHistory(page, trigger); release(); await handled;
  const cancelledRequest = await abortedRequest;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('dialog').count(), 0, 'Late response never resurrects closed dialog');
  assert.match(cancelledRequest.failure()?.errorText || '', /abort|cancel/i, 'Closing cancels in-flight browser request');
  await page.unroute(historyPattern);
  mark('關閉進行中的歷程會取消請求，延遲真實 API 回應不會重開彈窗');

  const carerHistory = await request('GET', `care-plans/${visiblePlan.id}/history?compare=previous`, undefined, 200, caregiver.client, caregiver.auth);
  assert.equal(carerHistory.total, 1); assert.equal(carerHistory.items[0].version, 2);
  assert.deepEqual(carerHistory.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
  assert.ok(!JSON.stringify(carerHistory).includes(caseB.id)); assert.ok(!JSON.stringify(carerHistory).includes('HIDDEN-SYNTHETIC'));
  await request('GET', `cases/${caseB.id}/history?compare=previous`, undefined, 404, caregiver.client, caregiver.auth);
  await request('PATCH', `cases/${caseA.id}`, { version: 2, phone: '不可保存' }, 403, caregiver.client, caregiver.auth);
  await load(caregiver.page, `/cases/${caseA.id}`, caseA.name);
  trigger = caregiver.page.getByRole('button', { name: '個案版本歷程', exact: true });
  await openHistory(caregiver.page, trigger, '個案版本歷程'); await closeHistory(caregiver.page, trigger);
  trigger = rowNamed(caregiver.page, '合成可見計畫第二版').getByRole('button', { name: '計畫版本歷程', exact: true });
  dialog = await openHistory(caregiver.page, trigger, '照顧計畫版本歷程');
  await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('第 1 版', { exact: true }).count(), 0);
  assert.ok(!(await dialog.innerText()).includes('HIDDEN-SYNTHETIC'));
  await dialog.getByText('完整保存欄位', { exact: true }).click();
  await caregiver.page.setViewportSize({ width: 390, height: 844 });
  await inspectLayout(caregiver.page); await screenshot(caregiver.page, 'caregiver-visible-history-mobile.png');
  await closeHistory(caregiver.page, trigger);
  assert.equal(await caregiver.page.getByRole('button', { name: '編輯個案', exact: true }).count(), 0);
  mark('居服員僅讀相關個案及計畫，隱藏前版不洩漏、不跨版本缺口比較且無修改權');

  await load(finance.page, `/cases/${caseA.id}`, caseA.name);
  trigger = finance.page.getByRole('button', { name: '個案版本歷程', exact: true });
  await openHistory(finance.page, trigger, '個案版本歷程'); await closeHistory(finance.page, trigger);
  trigger = rowNamed(finance.page, '合成目標第二版').getByRole('button', { name: '計畫版本歷程', exact: true });
  await openHistory(finance.page, trigger, '照顧計畫版本歷程'); await closeHistory(finance.page, trigger);
  assert.equal(await finance.page.locator('.nav-link[href="#/plans"]').count(), 0);
  await finance.page.goto(`${base}/#/plans`);
  await finance.page.getByText('您沒有這項操作權限', { exact: true }).waitFor();
  await request('PATCH', `cases/${caseA.id}`, { version: 2, note: '不可保存' }, 403, finance.client, finance.auth);
  mark('財務保有個案詳細與計畫歷程讀取權，但未取得計畫管理頁或修改權');

  assert.deepEqual(counts(), beforeReads, 'History read/retry/pagination/abort and denied writes produce no database writes or audit events');
  mark('歷程讀取、翻頁、重試、關閉與拒權後 SQLite total_changes、audit、records、versions 全數不變');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedResponses.filter(item => !item.expected), []);
  assert.equal(failedResponses.length, 1, 'Only intentional 503 is a failed browser response');
  assert.ok(consoleErrors.every(message => /503/.test(message)), JSON.stringify(consoleErrors));
  mark('所有畫面無 pageerror；僅一筆刻意注入的 503，無其他瀏覽器/API 失敗');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium', checks, pageErrors, consoleErrors, failedResponses, readonlyCounts: { before: beforeReads, after: counts() }, screenshots }, null, 2));
  console.log(`History E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, pageErrors, consoleErrors, failedResponses, screenshots, error: error.stack }, null, 2));
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser?.close(); await app.close();
}
