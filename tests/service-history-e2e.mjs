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
const output = path.join(root, 'outputs/software/service-history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-service-history-password';
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
const historyTitle = '服務紀錄版本歷程';
const serviceCard = (page, name) => page.locator('.service-card').filter({ hasText: name });
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

const readSegments = [], fixtureNotes = [], invalidationChecks = [];
const recordSection = page => page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '服務紀錄', exact: true }) });
const delayRoute = async (page, pattern) => {
  const arrived = deferred(), release = deferred(), handled = deferred();
  await page.route(pattern, async route => {
    try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { handled.resolve(); }
  });
  return { arrived, release, handled };
};
try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成服務歷程管理員', email: 'service-history-admin@example.test', password, organizationName: '合成服務歷程甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const get = async (entity, item) => (await request('GET', `${entity}/${item.id}`)).item;
  const employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'VH-EA', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'VH-EB', role: 'caregiver', hourlyRateCents: 32000 });
  const users = {};
  for (const [role, name, employee] of [['supervisor', 'supervisor'], ['caregiver', 'carer-a', employeeA], ['caregiver', 'carer-b', employeeB], ['finance', 'finance']]) users[name] = await post('users', { name: `合成服務${name}`, email: `service-history-${name}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const loginAs = async name => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `service-history-${name}@example.test`, password } }); assert.equal(response.status(), 200);
    const auth = await response.json(), page = await client.newPage(); await page.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), carerA = await loginAs('carer-a'), carerB = await loginAs('carer-b'), finance = await loginAs('finance');
  const adminPage = await context.newPage(); await adminPage.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(adminPage);
  const serviceA = await post('service-items', { code: 'VH-A', name: '合成生活照顧', minutes: 30, unitPriceCents: 12000 });
  const serviceB = await post('service-items', { code: 'VH-B', name: '合成陪同外出', minutes: 30, unitPriceCents: 18000 });
  let index = 0;
  const fixture = async name => {
    const item = await post('cases', { name: `合成${name}個案`, caseNo: `VH-C${++index}`, note: '合成資料，非實際個案' });
    const plan = await post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 100 }, { serviceItemId: serviceB.id, quantity: 100 }] }); return { item, plan };
  };
  const main = await fixture('完整核閱'), gap = await fixture('原承接歷程'), pageSource = await fixture('跨頁歷程');
  const oldCase = await fixture('舊案不可讀'), newCase = await fixture('換案目前'), retainedOld = await fixture('取消班保留舊案'), retainedNew = await fixture('仍有舊案權限');
  const unknown = await fixture('未記錄主檔'), empty = await fixture('空歷程'), filtered = await fixture('匯入隔離');
  const shiftData = (source, date, extra = {}) => ({ caseId: source.item.id, carePlanId: source.plan.id, employeeId: employeeA.id, date, startTime: '09:00', endTime: '10:00', status: 'scheduled', services: [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 2 }], ...extra });
  const recordData = (shift, extra = {}) => ({ shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date, actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: serviceA.id, quantity: 3 }, { serviceItemId: serviceB.id, quantity: 1 }], status: 'draft', note: '合成初版服務觀察', ...extra });
  const mainShift = await post('shifts', shiftData(main, '2026-10-01'));
  const pageShift = await post('shifts', shiftData(pageSource, '2026-10-02'));
  const gapA = await post('shifts', shiftData(gap, '2026-10-03')), gapB = await post('shifts', shiftData(gap, '2026-10-04', { employeeId: employeeB.id }));
  let pageRecord = await post('service-records', recordData(pageShift, { note: '合成第1版觀察' }));
  for (let version = 2; version <= 28; version++) pageRecord = await patch('service-records', pageRecord, { note: `合成第${version}版觀察` });
  let gapRecord = await post('service-records', recordData(gapA, { note: '合成甲承接第1版' }));
  gapRecord = await patch('service-records', gapRecord, recordData(gapB, { note: 'HIDDEN-B-ONLY-SERVICE' }));
  const interim = await request('GET', `service-records/${gapRecord.id}/history?compare=previous`, undefined, 200, carerB.client, carerB.auth);
  assert.deepEqual(interim.items.map(row => row.version), [2]); assert.equal(interim.items[0].comparison.status, 'unavailable');
  gapRecord = await patch('service-records', gapRecord, recordData(gapA, { note: '合成甲承接第3版' }));
  let oldShift = await post('shifts', shiftData(oldCase, '2026-10-05'));
  const newShift = await post('shifts', shiftData(newCase, '2026-10-06'));
  let movedRecord = await post('service-records', recordData(oldShift, { note: 'HIDDEN-OLD-CASE-SERVICE' }));
  movedRecord = await patch('service-records', movedRecord, recordData(newShift, { note: '合成換案目前可見觀察' }));
  oldShift = await patch('shifts', oldShift, { employeeId: employeeB.id });
  let retainedShift = await post('shifts', shiftData(retainedOld, '2026-10-07'));
  const retainedNewShift = await post('shifts', shiftData(retainedNew, '2026-10-08'));
  let retainedRecord = await post('service-records', recordData(retainedShift, { note: '合成舊案仍有取消班授權' }));
  retainedRecord = await patch('service-records', retainedRecord, recordData(retainedNewShift, { note: '合成換案仍可比前版' }));
  retainedShift = await patch('shifts', retainedShift, { employeeId: employeeB.id });
  await post('shifts', shiftData(retainedOld, '2026-10-09', { status: 'cancelled' }));
  await post('shifts', shiftData(main, '2026-10-10')); // No service record: no service-history entry.
  mark('合法draft真API換另班次A→B→A，B承接時只見v2；同員工換案後原班改派、另案保留自己的取消班');

  // Normal lifecycle exclusively through the actual caregiver/supervisor/admin forms.
  await load(carerA.page, '/my-services', '我的服務'); await carerA.page.getByLabel('服務日期', { exact: true }).fill(mainShift.date);
  const ownCard = serviceCard(carerA.page, main.item.name);
  assert.equal(await ownCard.getByRole('button', { name: '服務紀錄版本歷程', exact: true }).count(), 0);
  await ownCard.getByRole('button', { name: '填寫服務紀錄', exact: true }).click(); let form = carerA.page.getByRole('dialog');
  await form.getByLabel('實際開始時間', { exact: false }).fill('09:05'); await form.getByLabel('實際結束時間', { exact: false }).fill('09:50');
  await form.getByLabel('VH-A 合成生活照顧 數量', { exact: true }).fill('3'); await form.getByLabel('VH-B 合成陪同外出 數量', { exact: true }).fill('1'); await form.getByLabel('服務紀錄與觀察', { exact: true }).fill('合成初版草稿：已完成照顧，待補交班。'); await saveDialog(carerA.page);
  let mainRecord = (await request('GET', `service-records?date=${mainShift.date}`)).items.find(item => item.shiftId === mainShift.id); assert.equal(mainRecord.version, 1);
  await ownCard.getByRole('button', { name: '繼續填寫草稿', exact: true }).click(); await carerA.page.getByRole('dialog').getByLabel('儲存方式', { exact: false }).selectOption('submitted'); await saveDialog(carerA.page);
  const loadRecords = async (page, date) => { await load(page, '/records', '服務紀錄與核閱'); await page.getByLabel('日期範圍', { exact: true }).selectOption('day'); await page.getByLabel('服務日期', { exact: true }).fill(date); await rowNamed(page, (date === mainShift.date ? main : date === pageShift.date ? pageSource : gap).item.name).waitFor(); };
  await loadRecords(supervisor.page, mainShift.date); await rowNamed(supervisor.page, main.item.name).getByRole('button', { name: '核閱', exact: true }).click(); form = supervisor.page.getByRole('dialog');
  await form.getByLabel('核閱結果', { exact: false }).selectOption('returned'); await form.getByLabel('核閱說明', { exact: true }).fill('合成督導退回：補充結束時間、數量與交班。'); await saveDialog(supervisor.page);
  await load(carerA.page, '/my-services', '我的服務'); await carerA.page.getByLabel('服務日期', { exact: true }).fill(mainShift.date); await ownCard.getByRole('button', { name: '修正退回紀錄', exact: true }).click(); form = carerA.page.getByRole('dialog');
  await form.getByLabel('實際開始時間', { exact: false }).fill('09:04'); await form.getByLabel('實際結束時間', { exact: false }).fill('09:51'); await form.locator('[name=servicesIntent]').selectOption('replace'); await form.getByLabel('VH-A 合成生活照顧 數量', { exact: true }).fill('4'); await form.getByLabel('VH-B 合成陪同外出 數量', { exact: true }).fill('2'); await form.getByLabel('服務紀錄與觀察', { exact: true }).fill('合成修正重送：實際47分鐘，生活4次及陪同2次，已交班。'); await form.getByLabel('儲存方式', { exact: false }).selectOption('submitted'); await saveDialog(carerA.page);
  await loadRecords(adminPage, mainShift.date); await rowNamed(adminPage, main.item.name).getByRole('button', { name: '核閱', exact: true }).click(); await adminPage.getByRole('dialog').getByLabel('核閱說明', { exact: true }).fill('合成管理者核閱通過，確認修正內容。'); await saveDialog(adminPage);
  mainRecord = await get('service-records', mainRecord); assert.equal(mainRecord.status, 'approved'); assert.equal(mainRecord.version, 5); assert.equal(mainRecord.billingSnapshot.serviceMinutes, 47);
  const lifecycle = await request('GET', `service-records/${mainRecord.id}/history?compare=previous`);
  assert.deepEqual(lifecycle.items.map(row => row.snapshot.status), ['approved', 'submitted', 'returned', 'submitted', 'draft']);
  assert.deepEqual(lifecycle.items.map(row => row.actor.id), [admin.user.id, users['carer-a'].id, users.supervisor.id, users['carer-a'].id, users['carer-a'].id]);
  assert.equal(lifecycle.items[0].snapshot.reviewNote, '合成管理者核閱通過，確認修正內容。'); assert.equal(lifecycle.items[2].snapshot.reviewNote, '合成督導退回：補充結束時間、數量與交班。');
  mark('真UI草稿v1→提交v2→督導退回v3→居服員修正重送v4→管理者核准v5，精確audit操作者/核閱說明/47分鐘與4+2數量');
  const approvedRecord = structuredClone(mainRecord), feeBaseline = await request('GET', 'reports/fees?month=2026-10'), payrollBaseline = await request('GET', 'reports/payroll?month=2026-10');
  await patch('service-items', serviceA, { name: '合成生活照顧目前名稱', unitPriceCents: 99000 }); await patch('employees', employeeA, { hourlyRateCents: 88000 });
  assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), feeBaseline); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payrollBaseline); assert.deepEqual(await get('service-records', mainRecord), approvedRecord);
  mark('核准後真API改服務名稱/價格與時薪，歷史billingSnapshot及費用/薪資試算維持原值');

  const otherOrg = (await request('POST', 'organizations', { name: '合成服務歷程乙機構' }, 201)).item;
  const foreignCase = (await request('POST', 'cases', { name: '合成跨機構不得揭露案', caseNo: 'VH-X' }, 201, context, admin, otherOrg.id)).item;
  const foreignRecord = insert(app.db, otherOrg.id, 'service-records', { ...recordData(mainShift), caseId: foreignCase.id, note: 'HIDDEN-FOREIGN-RECORD' });
  const unknownRecord = insert(app.db, orgId, 'service-records', { ...recordData(mainShift), caseId: unknown.item.id, shiftId: id(), employeeId: id(), services: [{ serviceItemId: id(), quantity: 7 }], actualStart: '2026-10-11T09:05:29+08:00', actualEnd: '2026-10-11T09:50:59+08:00', date: '2026-10-11', note: '合成移轉資料：主檔及操作者未保存' });
  const noJoinRecord = insert(app.db, orgId, 'service-records', { ...recordData(mainShift), shiftId: id(), date: '2026-10-12', note: '合成移轉資料：沒有目前班次，不新增shift join限制' });
  const time = now();
  const insertCurrentOnly = (data, version = 1) => { const item = { ...data, id: id(), orgId, version, createdAt: time, updatedAt: time }; app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, orgId, 'service-records', JSON.stringify(data), version, time, time); return item; };
  const emptyRecord = insertCurrentOnly({ ...recordData(mainShift), caseId: empty.item.id, shiftId: id(), date: '2026-10-13', note: '合成移轉資料：未提供歷史表' });
  const filteredRecord = insertCurrentOnly({ ...recordData(mainShift), caseId: filtered.item.id, shiftId: id(), date: '2026-10-14', note: '合成移轉資料：目前可見第三版' }, 3);
  // Grant the imported current case using a real own shift. Imported historical foreign case stays hidden.
  await post('shifts', shiftData(filtered, '2026-10-14', { status: 'cancelled' }));
  saveVersion(app.db, filteredRecord, 'baseline');
  for (const [version, caseId, note] of [[1, filtered.item.id, '合成可讀初版'], [2, foreignCase.id, 'HIDDEN-FOREIGN-CASE-V2']]) app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, 'service-records', filteredRecord.id, version, JSON.stringify({ ...filteredRecord, version, caseId, note }), time, 'baseline');
  fixtureNotes.push('All direct records/version inserts are explicit synthetic import fixtures in memory, paired coherently where history exists; no immutable version UPDATE/DELETE.', 'Foreign-case v2 in visible v1/v3 history tests isolation; missing current references and empty history cannot be produced by ordinary validated UI writes.', 'Normal draft reassignment, lifecycle, and 28 versions use genuine API/UI writes.');
  const beforeReads = counts(), beforeState = rawState(); assert.equal(Object.keys(beforeState).length, 11);
  const verifyRead = label => { assert.deepEqual(counts(), beforeReads); assert.deepEqual(rawState(), beforeState); readSegments.push({ label, all11TablesUnchanged: true, counts: counts() }); };
  const historyFor = (record, actor = { client: context, auth: admin }, compare = true) => request('GET', `service-records/${record.id}/history${compare ? '?compare=previous' : ''}`, undefined, 200, actor.client, actor.auth);

  await loadRecords(adminPage, mainShift.date); let trigger = rowNamed(adminPage, main.item.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.focus(); await adminPage.keyboard.press('Enter');
  let dialog = adminPage.getByRole('dialog', { name: historyTitle, exact: true }); await dialog.getByText('第 5 版', { exact: true }).waitFor();
  let card = versionCard(dialog, 5); await card.getByText(admin.user.name, { exact: true }).waitFor(); await card.getByRole('row').filter({ hasText: '服務紀錄狀態' }).getByText('已核閱', { exact: true }).waitFor(); await screenshot(adminPage, 'service-history-approved-desktop.png');
  card = versionCard(dialog, 4); await card.locator(':scope > summary').click(); await card.getByText('與第 3 版比較', { exact: true }).waitFor(); await card.getByRole('region', { name: '第 4 版變更前後', exact: true }).getByText('實際數量：4', { exact: true }).waitFor(); await card.getByRole('region', { name: '第 4 版變更前後', exact: true }).getByText('09:51', { exact: true }).waitFor(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await inspectLayout(adminPage); await screenshot(adminPage, 'service-history-correction-desktop.png');
  await adminPage.setViewportSize({ width: 390, height: 844 }); await inspectLayout(adminPage); await screenshot(adminPage, 'service-history-correction-mobile.png');
  const mobileDiff = card.getByRole('region', { name: '第 4 版變更前後', exact: true }); await mobileDiff.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert.ok(await mobileDiff.evaluate(node => node.scrollLeft > 0)); await screenshot(adminPage, 'service-history-correction-mobile-after.png');
  await card.getByText('完整保存欄位', { exact: true }).click(); await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'service-history-snapshot-mobile.png');
  assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|核閱|還原|刪除/ }).count(), 0); assert.ok(!/billingSnapshot|99000|88000|unitPriceCents/.test(await dialog.textContent())); await closeHistory(adminPage, trigger); await adminPage.setViewportSize({ width: 1440, height: 1050 }); 
  trigger = rowNamed(adminPage, main.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, historyTitle, 5); card = versionCard(dialog, 3); await card.locator(':scope > summary').click(); await card.getByText(users.supervisor.name, { exact: true }).waitFor(); await card.getByRole('row').filter({ hasText: '服務紀錄狀態' }).getByText('已退回', { exact: true }).waitFor(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'service-history-supervisor-return.png'); await closeHistory(adminPage, trigger); verifyRead('three-role-lifecycle-history-first-entry');
  mark('管理者服務列表鍵盤入口顯示核准與修正差異，1440/390內捲與單欄快照、Escape焦點；十欄白名單不含計價');

  await load(carerA.page, '/my-services', '我的服務'); await carerA.page.getByLabel('服務日期', { exact: true }).fill(mainShift.date); trigger = ownCard.getByRole('button', { name: '服務紀錄版本歷程', exact: true }); dialog = await openHistory(carerA.page, trigger, historyTitle, 5);
  await versionCard(dialog, 5).getByText(admin.user.name, { exact: true }).waitFor(); await screenshot(carerA.page, 'service-history-caregiver-entry.png'); await closeHistory(carerA.page, trigger);
  assert.equal(await ownCard.getByRole('button', { name: '版本歷程', exact: true }).count(), 1); await carerA.page.getByLabel('服務日期', { exact: true }).fill('2026-10-10'); assert.equal(await serviceCard(carerA.page, main.item.name).getByRole('button', { name: '服務紀錄版本歷程', exact: true }).count(), 0);
  await load(finance.page, `/cases/${main.item.id}`, main.item.name); trigger = recordSection(finance.page).getByRole('row').filter({ hasText: '合成修正重送' }).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(finance.page, trigger, historyTitle, 5); await dialog.getByText('完整保存欄位', { exact: true }).first().click(); assert.ok(!/billingSnapshot|unitPriceCents|hourlyRateCents/.test(await dialog.textContent())); await screenshot(finance.page, 'service-history-finance-case-entry.png'); await closeHistory(finance.page, trigger);
  assert.equal(await recordSection(finance.page).getByRole('button', { name: '核閱', exact: true }).count(), 0);
  await finance.page.goto(`${base}/#/records`); await finance.page.waitForLoadState('networkidle'); assert.equal(await finance.page.getByRole('button', { name: '版本歷程', exact: true }).count(), 0); verifyRead('three-ui-entries-and-finance-existing-route');
  mark('我的服務新增獨立紀錄歷程且保留班次入口，無record班不顯新入口；finance既有個案詳情可讀，未新增records管理頁');

  for (const actor of [{ client: context, auth: admin }, supervisor, carerA, finance]) {
    const result = await historyFor(mainRecord, actor); assert.equal(result.total, 5);
    const allowed = actor.auth.user.id === admin.user.id || actor.auth.user.id === finance.auth.user.id;
    assert.equal(Object.hasOwn(result.items[0].snapshot, 'billingSnapshot'), allowed);
    const shifted = await historyFor(mainRecord, actor, false); assert.ok(shifted.items.every(row => !Object.hasOwn(row, 'actor') && !Object.hasOwn(row, 'comparison')));
    for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `service-records/${foreignRecord.id}${suffix}`, undefined, 404, actor.client, actor.auth);
    for (const compare of [false, true]) { const filteredHistory = await historyFor(filteredRecord, actor, compare); assert.deepEqual(filteredHistory.items.map(row => row.version), [3, 1]); assert.ok(!JSON.stringify(filteredHistory).includes('HIDDEN-FOREIGN-CASE-V2')); if (compare) assert.deepEqual(filteredHistory.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null }); }
  }
  for (const suffix of ['?compare=wrong', '?compare=previous&compare=previous']) await request('GET', `service-records/${mainRecord.id}/history${suffix}`, undefined, 422);
  assert.equal((await historyFor(noJoinRecord, carerA)).total, 1); verifyRead('four-role-history-projection-and-foreign-scope');
  mark('四角色raw/compare授權一致；admin/finance原API計價權保留、sup/caregiver遮罩；跨機構404、非法compare422、缺目前shift不擅加join');

  for (const compare of [false, true]) {
    let result = await historyFor(gapRecord, carerA, compare); assert.deepEqual(result.items.map(row => row.version), [3, 1]); assert.ok(!JSON.stringify(result).includes('HIDDEN-B-ONLY-SERVICE')); if (compare) assert.equal(result.items[0].comparison.status, 'unavailable');
    result = await historyFor(movedRecord, carerA, compare); assert.deepEqual(result.items.map(row => row.version), [2]); assert.ok(!JSON.stringify(result).includes('HIDDEN-OLD-CASE-SERVICE'));
    result = await historyFor(retainedRecord, carerA, compare); assert.deepEqual(result.items.map(row => row.version), [2, 1]); if (compare) assert.equal(result.items[0].comparison.status, 'available');
  }
  for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `service-records/${gapRecord.id}${suffix}`, undefined, 404, carerB.client, carerB.auth);
  await request('GET', `cases/${oldCase.item.id}`, undefined, 404, carerA.client, carerA.auth);
  await load(carerA.page, '/my-services', '我的服務'); await carerA.page.getByLabel('服務日期', { exact: true }).fill(gapA.date); trigger = serviceCard(carerA.page, gap.item.name).getByRole('button', { name: '服務紀錄版本歷程', exact: true }); dialog = await openHistory(carerA.page, trigger, historyTitle, 3); await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor(); assert.equal(await dialog.getByText('第 2 版', { exact: true }).count(), 0); await carerA.page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(carerA.page); await screenshot(carerA.page, 'service-history-scope-gap-mobile.png'); await closeHistory(carerA.page, trigger); await carerA.page.setViewportSize({ width: 1440, height: 1050 }); verifyRead('true-draft-reassignment-and-current-case-authorization');
  mark('真draft A→B→A只見v3/v1且不跳版；換案失去舊案權限隱藏舊版，自己的取消班仍保留舊案前版');

  await loadRecords(adminPage, pageShift.date); trigger = rowNamed(adminPage, pageSource.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, historyTitle, 28); assert.equal(await dialog.locator('.history-version').count(), 25);
  card = versionCard(dialog, 4); await card.locator(':scope > summary').click(); await card.getByText('與第 3 版比較', { exact: true }).waitFor(); await card.getByText('合成第3版觀察', { exact: true }).waitFor(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'service-history-page-boundary.png');
  await dialog.getByRole('button', { name: '下一頁', exact: true }).click(); await dialog.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(await dialog.locator('.history-version').count(), 3); await screenshot(adminPage, 'service-history-page-two.png'); await closeHistory(adminPage, trigger);
  const pageOne = await request('GET', `service-records/${pageRecord.id}/history?compare=previous&page=1&pageSize=25`); assert.equal(pageOne.items.at(-1).comparison.previousVersion, 3); verifyRead('28-version-pagination');
  mark('28次合法draft版本以25+3分頁，第一頁v4仍比較頁外精確v3，第二頁v3比較v2');

  await load(adminPage, '/records', '服務紀錄與核閱'); await adminPage.getByLabel('日期範圍', { exact: true }).selectOption('month'); await adminPage.getByLabel('服務月份', { exact: true }).fill('2026-10');
  trigger = rowNamed(adminPage, unknown.item.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, historyTitle, 1); await dialog.getByText('未記錄操作者', { exact: true }).waitFor(); await dialog.getByText('完整保存欄位', { exact: true }).click(); await dialog.getByText('目前班次無法取得', { exact: true }).waitFor(); assert.ok(await dialog.getByText('目前名稱無法取得', { exact: true }).count() >= 2); await dialog.getByText(unknownRecord.actualStart, { exact: true }).waitFor(); await screenshot(adminPage, 'service-history-import-unknown.png'); await closeHistory(adminPage, trigger);
  trigger = rowNamed(adminPage, empty.item.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = adminPage.getByRole('dialog', { name: historyTitle, exact: true }); await dialog.getByText('尚無可讀取的版本歷程。', { exact: true }).waitFor(); await screenshot(adminPage, 'service-history-empty.png'); await closeHistory(adminPage, trigger); verifyRead('explicit-import-fallbacks');
  mark('明示memory移轉fixture：缺操作者/目前關聯不猜值、保留原ISO時間與ID，空歷程有可關閉空狀態');

  const pattern = `**/api/service-records/${mainRecord.id}/history?*`; let attempts = 0;
  await loadRecords(adminPage, mainShift.date); trigger = rowNamed(adminPage, main.item.name).getByRole('button', { name: '版本歷程', exact: true });
  await adminPage.route(pattern, route => ++attempts === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_HISTORY_FAILURE', message: '合成歷程暫時無法取得，請重新讀取。' } }) }) : route.continue());
  await trigger.click(); dialog = adminPage.getByRole('dialog'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); await screenshot(adminPage, 'service-history-retry.png'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText('第 5 版', { exact: true }).waitFor(); assert.equal(attempts, 2); await closeHistory(adminPage, trigger); await adminPage.unroute(pattern);
  const delayed = await delayRoute(adminPage, pattern);
  await trigger.click(); await delayed.arrived.promise; await adminPage.getByRole('dialog').getByText('正在讀取歷程…', { exact: true }).waitFor(); await screenshot(adminPage, 'service-history-loading.png'); const aborted = adminPage.waitForEvent('requestfailed', { predicate: req => req.url().includes(`/service-records/${mainRecord.id}/history`), timeout: 10000 }); await closeHistory(adminPage, trigger); try { assert.match((await aborted).failure()?.errorText || '', /abort|cancel/i); } finally { delayed.release.resolve(); await delayed.handled.promise; } await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').count(), 0); await adminPage.unroute(pattern); verifyRead('503-retry-and-aborted-late-read');
  mark('503後可重新讀取真API；loading時Escape取消fetch與恢復焦點，晚回應不重開歷程');

  // Context injection below is a UI-only synthetic session event, not an API authorization bypass.
  // The page is freshly reloaded after every scenario, restoring its real server session.
  for (const pending of [false, true]) for (const mode of ['route', 'organization', 'role', 'employee', 'render']) {
    await loadRecords(adminPage, mainShift.date); trigger = rowNamed(adminPage, main.item.name).getByRole('button', { name: '版本歷程', exact: true });
    const delay = pending ? await delayRoute(adminPage, pattern) : null;
    if (delay) { await trigger.click(); await delay.arrived.promise; } else await openHistory(adminPage, trigger, historyTitle, 5);
    if (mode === 'route') await adminPage.evaluate(() => { location.hash = '/cases'; });
    else if (mode === 'organization') await adminPage.getByLabel('目前機構', { exact: true }).evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, otherOrg.id);
    else if (mode === 'render') await adminPage.evaluate(() => { window.dispatchEvent(new Event('session-updated')); });
    else await adminPage.evaluate(async ({ mode, employeeId }) => { const { getContext, setContext } = await import('/ui.js'); const ctx = structuredClone(getContext()); const org = ctx.organizations.find(item => item.id === ctx.organizationId); if (mode === 'role') org.role = 'supervisor'; else org.employeeId = employeeId; setContext(ctx, ctx.organizationId); document.body.append(document.createComment('synthetic-context-invalidation')); }, { mode, employeeId: employeeB.id });
    await adminPage.getByRole('dialog').waitFor({ state: 'detached' });
    if (delay) { delay.release.resolve(); await delay.handled.promise; await adminPage.unroute(pattern); }
    await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').count(), 0); assert.equal(await adminPage.locator('.history-version').count(), 0); invalidationChecks.push({ pending, mode, removed: true });
    await adminPage.reload(); await adminPage.waitForLoadState('networkidle');
  }
  fixtureNotes.push('Role/employee invalidation uses only a synthetic client context plus DOM mutation, explicitly without changing server memberships; each scenario reloads the actual authenticated server session. Actual server roles are separately tested by four logged-in clients.');
  verifyRead('loaded-and-pending-context-render-invalidation');
  mark('已載入與慢讀兩種狀態，各驗hash/真機構切換/role/employee身份/render替换立即清空關閉，共10情境且晚回應不復活');

  assert.deepEqual(await get('service-records', mainRecord), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), feeBaseline); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payrollBaseline); verifyRead('final-financial-and-complete-database-readonly');
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /503/.test(message)), JSON.stringify(consoleErrors));
  mark('全部唯讀歷程及取消重試僅GET；完整11表/rawState/total_changes/audit/版本/冪等表不變，approved快照與fees/payroll不變且pageerror0');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium; no actual database or external platform', checks, screenshots, pageErrors, consoleErrors, failedResponses, readonlyCounts: { before: beforeReads, after: counts() }, readSegments, invalidationChecks, fixtureNotes, all11TablesUnchanged: true, billingSnapshotUnchanged: true, visualReviewPending: true }, null, 2));
  console.log(`Service history E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, fixtureNotes, error: error.stack }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
