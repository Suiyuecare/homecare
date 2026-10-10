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
const output = path.join(root, 'outputs/software/contacts-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-contacts-password';
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: [409, 503].includes(response.status()) && /\/api\/case-contacts/.test(response.url()) });
  });
};
const load = async (page, route, heading) => {
  lastPage = page;
  const target = `${base}/#${route}`;
  if (page.url() === target) await page.reload(); else await page.goto(target);
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
const section = page => page.getByRole('region', { name: '多組聯絡人', exact: true });
const contactCard = (page, name) => section(page).locator('.contact-card').filter({ hasText: name });
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

const fillContact = async (page, values) => {
  const dialog = page.getByRole('dialog');
  const labels = { name: '聯絡人姓名', category: '聯絡人分類', relationship: '關係', phone: '主要電話', alternatePhone: '其他電話', email: '電子信箱', organization: '所屬單位', note: '備註' };
  for (const [key, value] of Object.entries(values)) {
    const field = dialog.getByLabel(labels[key], { exact: false });
    if (key === 'category') await field.selectOption(value); else await field.fill(value);
  }
};
const search = async (page, query) => {
  const field = section(page).getByLabel('聯絡人搜尋', { exact: true });
  await field.fill(query); await field.press('Enter');
};
const abandon = async page => {
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true });
  await dialog.getByRole('button', { name: '放棄修改', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

try {
  base = await app.listen();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成聯絡管理員', email: 'contacts-admin@example.test', password, organizationName: '合成聯絡測試機構' } });
  assert.equal(setup.status(), 201, await setup.text());
  const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, selectedOrg = orgId) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const value = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(value)}`); return value;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const employee = await post('employees', { name: '合成聯絡居服員', employeeNo: 'CONTACT-E01', role: 'caregiver' });
  const actors = {};
  for (const role of ['supervisor', 'caregiver', 'finance']) actors[role] = await post('users', { name: `合成聯絡${role}`, email: `contacts-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
  const loginAs = async role => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `contacts-${role}@example.test`, password } });
    assert.equal(response.status(), 200, await response.text());
    const auth = await response.json(), page = await client.newPage(); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), caregiver = await loginAs('caregiver'), finance = await loginAs('finance');
  const page = supervisor.page;
  const caseA = await post('cases', { name: '合成聯絡個案甲', caseNo: 'CONTACT-C01', primaryCarer: '合成原主要照顧者', contactName: '合成原聯絡人', contactPhone: '合成原電話' });
  const caseB = await post('cases', { name: '合成聯絡個案乙', caseNo: 'CONTACT-C02', status: 'paused' });
  const caseHistory = await post('cases', { name: '合成歷史範圍個案', caseNo: 'CONTACT-C03' });
  const oldCase = (await request('GET', `cases/${caseA.id}`)).item;
  const oldCaseHistory = await request('GET', `cases/${caseA.id}/history?compare=previous`);
  const service = await post('service-items', { code: 'CONTACT-TEST', name: '合成聯絡驗證服務', minutes: 60, unitPriceCents: 10000 });
  for (const [item, startTime, endTime] of [[caseA, '09:00', '10:00'], [caseHistory, '11:00', '12:00']]) {
    const plan = await post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 2 }] });
    await post('shifts', { caseId: item.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime, endTime, services: [{ serviceItemId: service.id, quantity: 1 }] });
  }
  const otherContact = await post('case-contacts', { caseId: caseB.id, name: '合成乙案專屬聯絡人', phone: 'HIDDEN-CONTACT-PHONE' });
  const otherOrg = (await request('POST', 'organizations', { name: '合成另一聯絡機構' }, 201)).item;
  const foreignCase = (await request('POST', 'cases', { name: '合成跨機構個案', caseNo: 'CONTACT-FOREIGN' }, 201, context, admin, otherOrg.id)).item;
  const foreignContact = (await request('POST', 'case-contacts', { caseId: foreignCase.id, name: '合成跨機構聯絡人' }, 201, context, admin, otherOrg.id)).item;
  // Corrupt legacy history fixture: v1 belonged to another case. Only current-case snapshots may leave the API.
  const historyId = id(), time = now();
  const historyData = { caseId: caseHistory.id, name: '合成歷史範圍聯絡人', category: 'other', status: 'active', phone: '合成可見歷史電話' };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(historyId, orgId, 'case-contacts', JSON.stringify(historyData), 2, time, time);
  initDb(app.db);
  app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, 'case-contacts', historyId, 1, JSON.stringify({ ...historyData, id: historyId, orgId, caseId: caseB.id, name: 'HIDDEN-HISTORY-CONTACT', version: 1, createdAt: time, updatedAt: time }), time, 'baseline');

  const creationKeys = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/case-contacts') creationKeys.push(req.headers()['idempotency-key']); });
  await load(page, `/cases/${caseA.id}`, caseA.name);
  await section(page).getByText('共 0 筆', { exact: false }).waitFor();
  assert.equal(await section(page).locator('.contact-card').count(), 0, 'Legacy fields do not auto-create contact records');
  let trigger = section(page).getByRole('button', { name: '新增聯絡人', exact: true });
  await trigger.click(); await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.ok(await trigger.evaluate(node => node === document.activeElement));
  await trigger.press('Enter');
  let dialog = page.getByRole('dialog', { name: '新增聯絡人', exact: true });
  assert.equal(await dialog.locator('[name="caseId"]').count(), 0, 'Current case is fixed');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.locator('[aria-invalid="true"]').first().waitFor();
  await fillContact(page, { name: '  合成核心聯絡人  ', category: 'primary_caregiver', relationship: '  合成家屬  ', phone: '+886 合成電話 分機 123', alternatePhone: '合成其他電話', email: 'invalid-email', organization: '合成服務窗口', note: '合成備註第一版；長備註會換行且不影響手機欄位。' });
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.getByLabel('電子信箱', { exact: true }).locator('xpath=..').locator('[aria-invalid="true"]').waitFor();
  assert.equal(await dialog.getByLabel('聯絡人姓名', { exact: false }).inputValue(), '  合成核心聯絡人  ');
  await fillContact(page, { email: 'synthetic.long.contact.name.for.mobile.readability@example.test' });
  await inspectLayout(page); await screenshot(page, 'contact-create-desktop.png');
  await saveDialog(page);
  let core = (await request('GET', `case-contacts?caseId=${caseA.id}`)).items[0];
  assert.equal(core.name, '合成核心聯絡人'); assert.equal(core.relationship, '合成家屬'); assert.equal(core.version, 1);
  await contactCard(page, core.name).waitFor();
  await trigger.click(); await fillContact(page, { name: '合成第二聯絡人', category: 'primary_caregiver' }); await saveDialog(page);
  const second = (await request('GET', `case-contacts?caseId=${caseA.id}&q=${encodeURIComponent('合成第二聯絡人')}`)).items[0];
  assert.equal(second.category, 'primary_caregiver', 'Same category permits multiple contacts');
  assert.equal(second.phone || '', '', 'No contact method is mandatory');
  assert.equal(creationKeys.length, 2); assert.ok(creationKeys.every(Boolean)); assert.notEqual(creationKeys[0], creationKeys[1]);
  mark('督導真 UI 新增兩筆同分類聯絡人；必填/信箱錯誤保留輸入、trim、電話文字、每份表單獨立冪等鍵');

  await contactCard(page, core.name).getByRole('button', { name: '編輯', exact: true }).click();
  await fillContact(page, { phone: '合成電話第二版', note: '合成備註第二版，適用桌機與手機驗證。' }); await saveDialog(page);
  core = (await request('GET', `case-contacts/${core.id}`)).item;
  assert.equal(core.version, 2); assert.equal(core.phone, '合成電話第二版');
  assert.deepEqual((await request('GET', `case-contacts/${second.id}`)).item, second, 'Editing one contact cannot change another');
  let beforeCancel = counts();
  trigger = contactCard(page, core.name).getByRole('button', { name: '停用', exact: true });
  await trigger.click(); dialog = page.getByRole('dialog', { name: '停用聯絡人？', exact: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(counts(), beforeCancel); assert.ok(await trigger.evaluate(node => node === document.activeElement));
  await trigger.click(); await page.getByRole('dialog').getByRole('button', { name: '確認停用', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  await contactCard(page, core.name).getByRole('button', { name: '恢復使用', exact: true }).waitFor();
  core = (await request('GET', `case-contacts/${core.id}`)).item; assert.equal(core.status, 'inactive'); assert.equal(core.version, 3);
  await contactCard(page, core.name).getByRole('button', { name: '恢復使用', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認恢復使用', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  core = (await request('GET', `case-contacts/${core.id}`)).item; assert.equal(core.status, 'active'); assert.equal(core.version, 4);
  mark('單筆編輯不碰其他聯絡人；停用/恢復均確認並保存版本，取消零寫入與焦點回復');

  await contactCard(page, core.name).getByRole('button', { name: '編輯', exact: true }).click();
  await fillContact(page, { phone: '合成本機尚未儲存電話', note: '合成本機未儲存備註，衝突時必須保留。' });
  core = await patch('case-contacts', core, { phone: '合成另一位管理員已保存電話' });
  const beforeConflict = counts();
  const conflict = page.waitForResponse(response => response.url().includes(`/api/case-contacts/${core.id}`) && response.request().method() === 'PATCH');
  dialog = page.getByRole('dialog', { name: '編輯聯絡人', exact: true });
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  assert.equal((await conflict).status(), 409); await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByLabel('主要電話', { exact: true }).inputValue(), '合成本機尚未儲存電話');
  assert.equal(await dialog.getByLabel('備註', { exact: true }).inputValue(), '合成本機未儲存備註，衝突時必須保留。');
  assert.deepEqual(counts(), beforeConflict); assert.equal((await request('GET', `case-contacts/${core.id}`)).item.phone, '合成另一位管理員已保存電話');
  await screenshot(page, 'contact-real-conflict-desktop.png');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await dialog.getByLabel('主要電話', { exact: true }).inputValue(), '合成本機尚未儲存電話');
  await abandon(page);
  await section(page).getByRole('button', { name: '重新讀取聯絡人', exact: true }).click();
  await contactCard(page, core.name).getByText('合成另一位管理員已保存電話', { exact: true }).waitFor();
  await contactCard(page, core.name).getByRole('button', { name: '編輯', exact: true }).click();
  assert.equal(await page.getByRole('dialog').getByLabel('主要電話', { exact: true }).inputValue(), '合成另一位管理員已保存電話');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  mark('真實另一 client 修改造成409；表單電話/備註完整保留，取消放棄仍保留、不覆寫伺服器新值');

  // 28 contacts exercise server-side filtering and pagination rather than client-only slicing.
  for (let i = 1; i <= 26; i++) await post('case-contacts', { caseId: caseA.id, name: `合成批次聯絡人${String(i).padStart(2, '0')}`, category: i % 2 ? 'case_manager' : 'other', status: i === 26 ? 'inactive' : 'active', phone: `合成批次電話${i}` });
  await load(page, `/cases/${caseA.id}`, caseA.name);
  await section(page).getByText('共 28 筆', { exact: false }).waitFor(); assert.equal(await section(page).locator('.contact-card').count(), 25);
  await section(page).getByRole('button', { name: '下一頁', exact: true }).click();
  await section(page).getByText('第 2 / 2 頁', { exact: false }).waitFor(); assert.equal(await section(page).locator('.contact-card').count(), 3);
  await section(page).getByRole('button', { name: '上一頁', exact: true }).click(); await section(page).getByText('第 1 / 2 頁', { exact: false }).waitFor();
  const categoryResponse = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/case-contacts' && url.searchParams.get('category') === 'case_manager'; });
  await section(page).getByLabel('聯絡人分類篩選', { exact: true }).selectOption('case_manager'); await categoryResponse;
  await section(page).getByText('共 13 筆', { exact: false }).waitFor(); assert.equal(await section(page).locator('.contact-card').count(), 13);
  await section(page).getByLabel('聯絡人分類篩選', { exact: true }).selectOption(''); await section(page).getByText('共 28 筆', { exact: false }).waitFor();
  await section(page).getByLabel('聯絡人狀態篩選', { exact: true }).selectOption('inactive');
  await section(page).getByText('共 1 筆', { exact: false }).waitFor(); await contactCard(page, '合成批次聯絡人26').waitFor();
  await section(page).getByLabel('聯絡人狀態篩選', { exact: true }).selectOption('');
  await search(page, '查無此合成聯絡人'); await section(page).getByText('共 0 筆', { exact: false }).waitFor(); assert.equal(await section(page).locator('.contact-card').count(), 0);
  await section(page).getByRole('button', { name: '清除聯絡人搜尋', exact: true }).click(); await section(page).getByText('共 28 筆', { exact: false }).waitFor();
  await search(page, core.name); await contactCard(page, core.name).waitFor(); await section(page).getByText('共 1 筆', { exact: false }).waitFor();
  assert.ok(!page.url().includes(encodeURIComponent(core.name)) && !page.url().includes(core.name));
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(core.name));
  await section(page).scrollIntoViewIfNeeded(); await inspectLayout(page); await screenshot(page, 'contact-card-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await contactCard(page, core.name).scrollIntoViewIfNeeded();
  await inspectLayout(page); await screenshot(page, 'contact-card-mobile.png');
  await contactCard(page, core.name).getByRole('button', { name: '編輯', exact: true }).click(); await inspectLayout(page); await screenshot(page, 'contact-edit-mobile.png');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  mark('28筆25+3伺服器分頁；分類13筆/停用1筆/搜尋/清除/無結果正確，搜尋不入URL或localStorage，1440/390卡片表單可讀');

  const beforeReads = counts();
  let history = await request('GET', `case-contacts/${core.id}/history?compare=previous`);
  assert.equal(history.total, 5); assert.deepEqual(history.items[0].actor, { id: admin.user.id, name: admin.user.name });
  assert.deepEqual(history.items.find(item => item.version === 2).actor, { id: actors.supervisor.id, name: actors.supervisor.name });
  assert.equal(history.items.find(item => item.version === 3).snapshot.status, 'inactive');
  assert.equal(history.items.find(item => item.version === 4).snapshot.status, 'active');
  trigger = contactCard(page, core.name).getByRole('button', { name: '版本歷程', exact: true });
  dialog = await openHistory(page, trigger, '聯絡人版本歷程', 5);
  let card = versionCard(dialog, 5);
  await card.getByRole('row').filter({ hasText: '主要電話' }).getByText('合成電話第二版', { exact: true }).waitFor();
  await card.getByRole('row').filter({ hasText: '主要電話' }).getByText('合成另一位管理員已保存電話', { exact: true }).waitFor();
  await card.getByText('操作者（目前名稱）', { exact: true }).waitFor(); await card.getByText(admin.user.name, { exact: true }).waitFor();
  await inspectLayout(page); await screenshot(page, 'contact-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page);
  await card.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; }); await screenshot(page, 'contact-history-mobile-after.png');
  await card.getByText('完整保存欄位', { exact: true }).click(); await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await screenshot(page, 'contact-history-snapshot-mobile.png');
  await closeHistory(page, trigger); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('聯絡人5版歷程含實際admin/supervisor、電話前後值、停用/恢復，桌機與手機快照/橫捲及Escape焦點正確');

  // Hold actual server responses to prove stale list results cannot overwrite later searches or cases.
  const listPattern = '**/api/case-contacts?*';
  const slowArrived = deferred(), releaseSlow = deferred(), slowHandled = deferred();
  await page.route(listPattern, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') !== '合成批次聯絡人01') return route.continue();
    try { const response = await route.fetch(); slowArrived.resolve(); await releaseSlow.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; }
    finally { slowHandled.resolve(); }
  });
  await search(page, '合成批次聯絡人01'); await slowArrived.promise;
  await search(page, '合成第二聯絡人'); await contactCard(page, '合成第二聯絡人').waitFor();
  releaseSlow.resolve(); await slowHandled.promise; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await contactCard(page, '合成批次聯絡人01').count(), 0); assert.equal(await section(page).locator('.contact-card').count(), 1);
  await page.unroute(listPattern);
  await section(page).getByRole('button', { name: '清除聯絡人搜尋', exact: true }).click(); await section(page).getByText('共 28 筆', { exact: false }).waitFor();
  const caseArrived = deferred(), releaseCase = deferred(), caseHandled = deferred();
  await page.route(listPattern, async route => {
    if (new URL(route.request().url()).searchParams.get('caseId') !== caseA.id) return route.continue();
    try { const response = await route.fetch(); caseArrived.resolve(); await releaseCase.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; }
    finally { caseHandled.resolve(); }
  });
  await page.reload(); await page.getByRole('heading', { name: caseA.name, exact: true }).waitFor(); await caseArrived.promise;
  await section(page).getByRole('status').waitFor();
  await page.evaluate(caseId => { location.hash = `/cases/${caseId}`; }, caseB.id);
  await page.getByRole('heading', { name: caseB.name, exact: true }).waitFor(); await contactCard(page, otherContact.name).waitFor();
  releaseCase.resolve(); await caseHandled.promise; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await contactCard(page, core.name).count(), 0); assert.equal(await section(page).locator('.contact-card').count(), 1);
  await page.unroute(listPattern);
  mark('延遲真API回應：快速搜尋只顯示最新條件，切換個案後舊聯絡清單不串入新案');

  let listAttempts = 0;
  await page.route(listPattern, async route => {
    if (new URL(route.request().url()).searchParams.get('caseId') !== caseA.id) return route.continue();
    listAttempts++;
    if (listAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_LIST_FAILURE', message: '合成聯絡人首次讀取失敗，請重新讀取' } }) });
    return route.continue();
  });
  await page.goto(`${base}/#/cases/${caseA.id}`); await page.getByRole('heading', { name: caseA.name, exact: true }).waitFor();
  await section(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor();
  await page.getByRole('heading', { name: '生效中的照顧計畫', exact: true }).waitFor();
  await page.getByText('合成原主要照顧者', { exact: true }).waitFor();
  await section(page).scrollIntoViewIfNeeded(); await screenshot(page, 'contact-list-retry-error.png');
  await section(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await section(page).getByText('共 28 筆', { exact: false }).waitFor();
  assert.equal(listAttempts, 2); await page.unroute(listPattern);
  mark('聯絡清單首次503不阻斷個案基本資料/計畫，重試真API可恢复28筆');

  await search(page, core.name); await contactCard(page, core.name).waitFor();
  const historyPattern = `**/api/case-contacts/${core.id}/history?*`;
  let historyAttempts = 0;
  await page.route(historyPattern, async route => {
    historyAttempts++;
    if (historyAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_HISTORY_FAILURE', message: '合成歷程讀取失敗' } }) });
    return route.continue();
  });
  trigger = contactCard(page, core.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click();
  dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click();
  await dialog.getByText('第 5 版', { exact: true }).waitFor(); assert.equal(historyAttempts, 2); await closeHistory(page, trigger); await page.unroute(historyPattern);
  const historyArrived = deferred(), releaseHistory = deferred(), historyHandled = deferred();
  const aborted = page.waitForEvent('requestfailed', { predicate: req => req.url().includes(`/case-contacts/${core.id}/history`), timeout: 10000 });
  await page.route(historyPattern, async route => {
    try { const response = await route.fetch(); historyArrived.resolve(); await releaseHistory.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; }
    finally { historyHandled.resolve(); }
  });
  await trigger.click(); await historyArrived.promise; await page.getByRole('dialog').getByText('正在讀取歷程…', { exact: true }).waitFor();
  await closeHistory(page, trigger); releaseHistory.resolve(); await historyHandled.promise;
  assert.match((await aborted).failure()?.errorText || '', /abort|cancel/i);
  assert.equal(await page.getByRole('dialog').count(), 0); await page.unroute(historyPattern);
  mark('歷程503後可重試；關閉載入中的歷程取消請求，延遲回應不復活且焦點返回');

  for (const actor of [{ client: context, auth: admin }, caregiver, finance]) {
    history = await request('GET', `case-contacts/${historyId}/history?compare=previous`, undefined, 200, actor.client, actor.auth);
    assert.equal(history.total, 1); assert.equal(history.items[0].version, 2); assert.equal(history.items[0].actor, null);
    assert.deepEqual(history.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
    assert.ok(!JSON.stringify(history).includes('HIDDEN-HISTORY-CONTACT')); assert.ok(!JSON.stringify(history).includes(caseB.id));
  }
  await load(caregiver.page, `/cases/${caseHistory.id}`, caseHistory.name);
  trigger = contactCard(caregiver.page, historyData.name).getByRole('button', { name: '版本歷程', exact: true });
  dialog = await openHistory(caregiver.page, trigger, '聯絡人版本歷程', 2);
  await dialog.getByText('未記錄操作者', { exact: true }).waitFor(); await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor();
  await screenshot(caregiver.page, 'contact-history-scope-gap.png'); await closeHistory(caregiver.page, trigger);
  mark('所有角色歷程均排除其他個案舊快照；精確前版缺口不可比較且baseline不猜操作者');

  const ownList = await request('GET', `case-contacts?caseId=${caseA.id}&pageSize=100`, undefined, 200, caregiver.client, caregiver.auth);
  assert.equal(ownList.total, 28); assert.ok(ownList.items.some(item => item.status === 'inactive'));
  assert.equal((await request('GET', `case-contacts?caseId=${caseB.id}&pageSize=100`, undefined, 200, caregiver.client, caregiver.auth)).total, 0);
  for (const suffix of ['', '/history?compare=previous']) {
    await request('GET', `case-contacts/${otherContact.id}${suffix}`, undefined, 404, caregiver.client, caregiver.auth);
    await request('GET', `case-contacts/${foreignContact.id}${suffix}`, undefined, 404, caregiver.client, caregiver.auth);
  }
  for (const actor of [caregiver, finance]) {
    await request('POST', 'case-contacts', { caseId: caseA.id, name: '不可建立' }, 403, actor.client, actor.auth);
    await request('PATCH', `case-contacts/${core.id}`, { version: core.version, phone: '不可覆寫' }, 403, actor.client, actor.auth);
    await load(actor.page, `/cases/${caseA.id}`, caseA.name);
    await section(actor.page).getByText('共 28 筆', { exact: false }).waitFor();
    assert.equal(await section(actor.page).getByRole('button', { name: /新增聯絡人|編輯|停用|恢復使用/ }).count(), 0);
    await search(actor.page, core.name); await contactCard(actor.page, core.name).waitFor();
    trigger = contactCard(actor.page, core.name).getByRole('button', { name: '版本歷程', exact: true });
    await openHistory(actor.page, trigger, '聯絡人版本歷程', 5); await closeHistory(actor.page, trigger);
  }
  await section(caregiver.page).getByRole('button', { name: '清除聯絡人搜尋', exact: true }).click();
  await section(caregiver.page).getByLabel('聯絡人狀態篩選', { exact: true }).selectOption('inactive');
  await contactCard(caregiver.page, '合成批次聯絡人26').waitFor(); await caregiver.page.setViewportSize({ width: 390, height: 844 });
  await contactCard(caregiver.page, '合成批次聯絡人26').scrollIntoViewIfNeeded(); await inspectLayout(caregiver.page); await screenshot(caregiver.page, 'caregiver-inactive-contact-mobile.png');
  mark('居服員本案含停用/歷程與財務沿個案唯讀；他案/跨機構無資料，新增修改403且無寫入按鈕');

  assert.deepEqual((await request('GET', `cases/${caseA.id}`)).item, oldCase);
  assert.deepEqual(await request('GET', `cases/${caseA.id}/history?compare=previous`), oldCaseHistory);
  assert.deepEqual(counts(), beforeReads, 'Read/search/filter/history/retry/cancel and forbidden writes leave the database unchanged');
  mark('舊個案 primaryCarer/contactName/contactPhone、完整item/version/history均不變；唯讀階段total_changes/audit/records/versions不變');
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(response => !response.expected), []);
  assert.equal(failedResponses.filter(response => response.status === 409).length, 1); assert.equal(failedResponses.filter(response => response.status === 503).length, 2);
  assert.ok(consoleErrors.every(message => /409|503/.test(message)), JSON.stringify(consoleErrors));
  mark('無pageerror；只含一筆真409及兩筆刻意503，沒有其他瀏覽器失敗');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium', checks, pageErrors, consoleErrors, failedResponses, readonlyCounts: { before: beforeReads, after: counts() }, legacyCaseUnchanged: true, screenshots }, null, 2));
  console.log(`Contacts E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, pageErrors, consoleErrors, failedResponses, screenshots, error: error.stack }, null, 2));
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser?.close(); await app.close();
}
