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
const output = path.join(root, 'outputs/software/leave-history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-leave-history-password';
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: (response.status() === 503 && /\/history\?/.test(response.url())) || (response.status() === 409 && /\/leave-requests\//.test(response.url())) });
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

const readSegments = [], fixtureNotes = [], invalidationChecks = [];
const entity = 'leave-requests', title = '請假版本歷程';
const delayRoute = async (page, pattern) => {
  const arrived = deferred(), release = deferred(), handled = deferred();
  await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (e) { if (!/closed|cancel|abort|disposed|already handled/i.test(e.message)) throw e; } finally { handled.resolve(); } });
  return { arrived, release, handled };
};
try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成請假管理員', email: 'leave-history-admin@example.test', password, organizationName: '合成請假甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body;
  };
  const post = async (kind, data) => (await request('POST', kind, data, 201)).item;
  const patch = async (kind, item, data) => (await request('PATCH', `${kind}/${item.id}`, { version: item.version, ...data })).item;
  const get = async (kind, item) => (await request('GET', `${kind}/${item.id}`)).item;
  let employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'LH-EA', role: 'caregiver', hourlyRateCents: 30000 });
  let employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'LH-EB', role: 'caregiver', hourlyRateCents: 32000 });
  let inactiveEmployee = await post('employees', { name: '合成停用員工', employeeNo: 'LH-INACTIVE', role: 'caregiver' });
  const users = {};
  for (const [role, name, employee] of [['supervisor', 'supervisor'], ['caregiver', 'caregiver', employeeA], ['caregiver', 'other', employeeB], ['caregiver', 'inactive', inactiveEmployee], ['finance', 'finance']]) users[name] = await post('users', { name: `合成請假${name}`, email: `leave-history-${name}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const loginAs = async name => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `leave-history-${name}@example.test`, password } }); assert.equal(response.status(), 200);
    const auth = await response.json(), page = await client.newPage(); await page.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), caregiver = await loginAs('caregiver'), other = await loginAs('other'), finance = await loginAs('finance'), inactive = await loginAs('inactive');
  const adminPage = await context.newPage(); await adminPage.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(adminPage);
  const dataFor = (reason, extra = {}) => ({ employeeId: employeeA.id, date: '2026-10-20', startTime: '13:00', endTime: '14:00', type: '合成機構自訂假', reason, status: 'pending', ...extra });
  const historyFor = (item, actor = { client: context, auth: admin }, compare = true) => request('GET', `${entity}/${item.id}/history${compare ? '?compare=previous' : ''}`, undefined, 200, actor.client, actor.auth);
  const newUi = async (page, values) => {
    await load(page, '/leave', '請假管理'); await page.getByRole('button', { name: '新增請假', exact: true }).click(); const dialog = page.getByRole('dialog');
    for (const [key, label] of [['date', '請假日期'], ['startTime', '開始時間'], ['endTime', '結束時間'], ['type', '假別'], ['reason', '請假原因']]) await dialog.getByLabel(label, { exact: false }).fill(values[key]);
    await dialog.getByLabel('員工', { exact: false }).selectOption(values.employeeId); await saveDialog(page);
    return (await request('GET', `${entity}?q=${encodeURIComponent(values.reason)}`)).items.find(item => item.reason === values.reason);
  };
  const statusUi = async (page, reason, action, confirm) => {
    await load(page, '/leave', '請假管理'); await rowNamed(page, reason).getByRole('button', { name: action, exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: confirm, exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  };
  let main = await newUi(adminPage, dataFor('合成請假原始原因')); assert.equal(main.version, 1);
  await load(supervisor.page, '/leave', '請假管理'); await rowNamed(supervisor.page, main.reason).getByRole('button', { name: '編輯', exact: true }).click(); let dialog = supervisor.page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('員工', { exact: false }).isDisabled(), false); await dialog.getByLabel('員工', { exact: false }).selectOption(employeeB.id);
  for (const [label, value] of [['請假日期', '2026-10-21'], ['開始時間', '14:15'], ['結束時間', '16:45'], ['假別', '合成家庭照顧假'], ['請假原因', '合成督導已更新完整請假原因']]) await dialog.getByLabel(label, { exact: false }).fill(value);
  await saveDialog(supervisor.page); main = await get(entity, main); assert.equal(main.version, 2); assert.equal(main.employeeId, employeeB.id);
  await load(adminPage, '/leave', '請假管理'); await rowNamed(adminPage, main.reason).getByRole('button', { name: '核准', exact: true }).click(); const cancelCounts = counts(); await adminPage.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); assert.deepEqual(counts(), cancelCounts); assert.equal((await get(entity, main)).version, 2);
  await statusUi(adminPage, main.reason, '核准', '確認核准'); main = await get(entity, main); assert.equal(main.status, 'approved'); assert.equal(main.version, 3);
  await statusUi(supervisor.page, main.reason, '取消請假', '確認取消'); main = await get(entity, main); assert.equal(main.status, 'cancelled'); assert.equal(main.version, 4);
  const mainHistory = await historyFor(main); assert.deepEqual(mainHistory.items.map(row => row.actor.id), [users.supervisor.id, admin.user.id, users.supervisor.id, admin.user.id]); assert.deepEqual(mainHistory.items.map(row => row.snapshot.status), ['cancelled', 'approved', 'pending', 'pending']); assert.equal(mainHistory.items[2].snapshot.employeeId, employeeB.id); assert.equal(mainHistory.items[3].snapshot.employeeId, employeeA.id);
  mark('真UI管理者新增v1→督導換員工/日期/時段/假別/原因v2→管理者核准v3→督導取消v4；取消確認零寫，四版actor精確');
  let rejected = await newUi(adminPage, dataFor('合成駁回流程原因', { date: '2026-10-22' })); await statusUi(supervisor.page, rejected.reason, '駁回', '確認駁回'); rejected = await get(entity, rejected); assert.equal(rejected.status, 'rejected'); assert.equal(rejected.version, 2); assert.equal((await historyFor(rejected)).items[0].actor.id, users.supervisor.id);
  await load(supervisor.page, '/leave', '請假管理'); assert.equal(await rowNamed(supervisor.page, rejected.reason).getByRole('button', { name: '編輯', exact: true }).count(), 0); assert.equal(await rowNamed(supervisor.page, main.reason).getByRole('button', { name: '核准', exact: true }).count(), 0);
  mark('另一筆真UI駁回v2及精確督導actor；已取消/已駁回仍有歷程，原pending-only編輯操作不擴張');
  // A real approved service establishes the immutable financial baseline, and a completed shift for leave conflicts.
  const service = await post('service-items', { code: 'LH-S', name: '合成費用基準服務', minutes: 30, unitPriceCents: 12000 });
  const careCase = await post('cases', { name: '合成計價基準個案', caseNo: 'LH-CASE' });
  const plan = await post('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
  const shift = await post('shifts', { caseId: careCase.id, carePlanId: plan.id, employeeId: employeeA.id, date: '2026-10-25', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  let record = await post('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: service.id, quantity: 2 }], status: 'submitted', note: '合成費用基準紀錄' });
  record = (await request('POST', `service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱確認' })).item;
  const approvedRecord = structuredClone(record), fees = await request('GET', 'reports/fees?month=2026-10'), payroll = await request('GET', 'reports/payroll?month=2026-10');
  let conflict = await newUi(adminPage, dataFor('合成已完成排班衝突', { date: shift.date, startTime: '09:30', endTime: '10:30' }));
  await rowNamed(adminPage, conflict.reason).getByRole('button', { name: '核准', exact: true }).click(); dialog = adminPage.getByRole('dialog'); const conflictCounts = counts(); await dialog.getByRole('button', { name: '確認核准', exact: true }).click(); await dialog.getByRole('alert').getByText('核准請假前須先處理重疊班次', { exact: true }).waitFor(); assert.equal(await dialog.getByRole('button', { name: '確認核准', exact: true }).isDisabled(), false); assert.deepEqual(counts(), conflictCounts); assert.deepEqual(await get(entity, conflict), conflict); await screenshot(adminPage, 'leave-conflict-preserved-desktop.png'); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  await rowNamed(adminPage, conflict.reason).getByRole('button', { name: '編輯', exact: true }).click(); dialog = adminPage.getByRole('dialog'); await dialog.getByLabel('請假原因', { exact: false }).fill('合成本機未送達原因'); conflict = await patch(entity, conflict, { reason: '合成伺服器已更新衝突原因' }); const raceCounts = counts(); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.getByRole('alert').getByText('資料已更新，請重新讀取', { exact: true }).waitFor(); assert.equal(await dialog.getByLabel('請假原因', { exact: false }).inputValue(), '合成本機未送達原因'); assert.deepEqual(counts(), raceCounts); await screenshot(adminPage, 'leave-cas-input-preserved.png'); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await adminPage.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).getByRole('button', { name: '放棄修改', exact: true }).click(); await adminPage.getByRole('dialog').waitFor({ state: 'detached' });
  mark('真已完成班次阻擋重疊核准409且保留確認/紀錄；真CAS409保留修改原因與表單，取消可放棄而不另升版');
  let reassigned = await post(entity, dataFor('合成改派A-B-A第一版'));
  reassigned = await patch(entity, reassigned, { employeeId: employeeB.id, reason: '合成改派B第二版' }); assert.deepEqual((await historyFor(reassigned, other)).items.map(row => row.version), [2]); await request('GET', `${entity}/${reassigned.id}/history?compare=previous`, undefined, 404, caregiver.client, caregiver.auth);
  reassigned = await patch(entity, reassigned, { employeeId: employeeA.id, reason: '合成改派A第三版' }); assert.deepEqual((await historyFor(reassigned, caregiver)).items.map(row => row.version), [3, 1]); assert.equal((await historyFor(reassigned, caregiver)).items[0].comparison.status, 'unavailable');
  let pageItem = await post(entity, dataFor('合成跨頁第1版')); for (let version = 2; version <= 28; version++) pageItem = await patch(entity, pageItem, { reason: `合成跨頁第${version}版` });
  const ownItem = await post(entity, dataFor('合成自己唯讀請假')); const otherItem = await post(entity, dataFor('合成他人唯讀請假', { employeeId: employeeB.id }));
  const iso = await post(entity, dataFor('合成原保存ISO時段', { date: '2026-10-26', startTime: '2026-10-26T11:05:30+08:00', endTime: '2026-10-26T12:20:40+08:00' }));
  const inactiveItem = await post(entity, dataFor('合成停用員工請假', { employeeId: inactiveEmployee.id }));
  for (const actor of [caregiver, finance]) await request('PATCH', `${entity}/${ownItem.id}`, { version: ownItem.version, reason: '拒絕寫入' }, 403, actor.client, actor.auth);
  employeeA = await patch('employees', employeeA, { name: '合成甲目前名稱', hourlyRateCents: 88000 }); employeeB = await patch('employees', employeeB, { name: '合成乙目前名稱' }); await patch('service-items', service, { unitPriceCents: 99000 }); inactiveEmployee = await patch('employees', inactiveEmployee, { status: 'inactive' });
  assert.deepEqual(await get('service-records', record), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll);
  mark('真API改派A→B→A與28版保存；財務/居服員寫入403、已核准服務計價快照與fees/payroll不受主檔改價影響');
  const otherOrg = (await request('POST', 'organizations', { name: '合成請假乙機構' }, 201)).item;
  const foreignEmployee = (await request('POST', 'employees', { name: '合成外機構員工', employeeNo: 'LH-FOREIGN', role: 'caregiver' }, 201, context, admin, otherOrg.id)).item;
  const nameless = insert(app.db, orgId, 'employees', { employeeNo: 'LH-IMPORT', role: 'caregiver', status: 'active', note: '明示合成移轉員工存在但無姓名，不更改正常驗證' });
  const time = now();
  const currentOnly = (data, version = 1) => { const item = { ...data, id: id(), orgId, version, createdAt: time, updatedAt: time }; app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, orgId, entity, JSON.stringify(data), version, time, time); return item; };
  const appendVersion = (item, version, employeeId, reason) => app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, item.id, version, JSON.stringify({ ...item, version, employeeId, reason }), time, 'baseline');
  const foreignItem = insert(app.db, otherOrg.id, entity, dataFor('合成外機構請假', { employeeId: foreignEmployee.id }));
  const polluted = currentOnly(dataFor('合成逐版父項隔離第四版'), 4); saveVersion(app.db, polluted, 'baseline'); appendVersion(polluted, 1, employeeB.id, '合成合法較早不同員工版'); appendVersion(polluted, 2, id(), 'HIDDEN-MISSING-PARENT'); appendVersion(polluted, 3, foreignEmployee.id, 'HIDDEN-FOREIGN-PARENT');
  const missingVersion = currentOnly(dataFor('合成精確缺版第三版'), 3); saveVersion(app.db, missingVersion, 'baseline'); appendVersion(missingVersion, 1, employeeA.id, '合成精確缺版第一版');
  const unknown = insert(app.db, orgId, entity, dataFor('合成移轉姓名未知', { employeeId: nameless.id }));
  const empty = currentOnly(dataFor('合成空歷程'));
  const orphan = currentOnly(dataFor('合成目前缺父項仍保留早版', { employeeId: id() }), 3); saveVersion(app.db, orphan, 'baseline'); appendVersion(orphan, 1, employeeA.id, '合成早期甲員工'); appendVersion(orphan, 2, employeeB.id, '合成早期乙員工');
  fixtureNotes.push('Only memory SQLite, synthetic employees/leave/care data, random localhost port. All real UI/API writes and expected failed writes finish before read-only baseline.', 'The nameless employee is an explicit same-organization, existing readable legacy import fixture. Normal employee validation is unchanged.', 'Missing/foreign parents, gaps, baseline actor and empty history use INSERT-only synthetic records/version fixtures; immutable record_versions are never updated or deleted. Leave may legitimately change employee; personnel immutable-parent rules are not reused.');
  const beforeReads = counts(), beforeState = rawState(); assert.equal(Object.keys(beforeState).length, 11);
  const verifyRead = label => { assert.deepEqual(counts(), beforeReads); assert.deepEqual(rawState(), beforeState); readSegments.push({ label, all11TablesUnchanged: true, counts: counts() }); };
  await load(adminPage, '/leave', '請假管理'); await inspectLayout(adminPage); await screenshot(adminPage, 'leave-list-desktop.png');
  let trigger = rowNamed(adminPage, main.reason).getByRole('button', { name: '版本歷程', exact: true }); await trigger.focus(); await adminPage.keyboard.press('Enter'); dialog = adminPage.getByRole('dialog', { name: title, exact: true }); await dialog.getByText('第 4 版', { exact: true }).waitFor(); await versionCard(dialog, 4).getByText(users.supervisor.name, { exact: true }).waitFor(); await screenshot(adminPage, 'leave-status-actor-desktop.png');
  let card = versionCard(dialog, 2); await card.locator(':scope > summary').click(); await card.getByText('與第 1 版比較', { exact: true }).waitFor(); let diff = card.getByRole('region', { name: '第 2 版變更前後', exact: true }); await diff.getByText(`目前名稱：${employeeA.name}`, { exact: true }).waitFor(); await diff.getByText(`目前名稱：${employeeB.name}`, { exact: true }).waitFor(); await diff.getByText('14:15', { exact: true }).waitFor(); await diff.getByText('合成家庭照顧假', { exact: true }).waitFor(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await inspectLayout(adminPage); await screenshot(adminPage, 'leave-diff-desktop.png');
  await adminPage.setViewportSize({ width: 390, height: 844 }); await inspectLayout(adminPage); await screenshot(adminPage, 'leave-diff-mobile-before.png'); await diff.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert.ok(await diff.evaluate(node => node.scrollLeft > 0)); await screenshot(adminPage, 'leave-diff-mobile-after.png');
  await card.getByText('完整保存欄位', { exact: true }).click(); await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'leave-snapshot-mobile.png'); assert.equal(await card.locator('.history-snapshot dt').count(), 7); assert.ok(!/billingSnapshot|請假時數|年度餘額|積分|99000|88000/.test((await dialog.locator('.history-version').allTextContents()).join(' '))); await closeHistory(adminPage, trigger); await inspectLayout(adminPage); await screenshot(adminPage, 'leave-list-mobile.png'); await adminPage.setViewportSize({ width: 1440, height: 1050 }); verifyRead('shared-seven-fields-responsive');
  mark('七欄共用唯讀歷程：真換員工diff/目前名稱/保存時段/精確actor；1440/390內捲與單欄保存、鍵盤Enter/Escape焦點');
  await load(adminPage, '/leave', '請假管理'); trigger = rowNamed(adminPage, pageItem.reason).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, title, 28); assert.equal(await dialog.locator('.history-version').count(), 25); card = versionCard(dialog, 4); await card.locator(':scope > summary').click(); await card.getByText('合成跨頁第3版', { exact: true }).waitFor(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, 'leave-page-boundary.png'); await dialog.getByRole('button', { name: '下一頁', exact: true }).click(); await dialog.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(await dialog.locator('.history-version').count(), 3); await versionCard(dialog, 3).getByText('與第 2 版比較', { exact: true }).waitFor(); await screenshot(adminPage, 'leave-page-two.png'); await closeHistory(adminPage, trigger); const firstPage = await request('GET', `${entity}/${pageItem.id}/history?compare=previous&page=1&pageSize=25`); assert.equal(firstPage.items.at(-1).comparison.previousVersion, 3); verifyRead('28-versions-pagination');
  mark('28版25+3分頁；第一頁v4比較頁外v3、第二頁v3比較v2，未將分頁邊界當缺版');
  for (const actor of [{ client: context, auth: admin }, supervisor, finance, caregiver]) {
    for (const compare of [false, true]) {
      const result = await historyFor(ownItem, actor, compare); assert.equal(result.total, 1); if (!compare) assert.ok(result.items.every(row => !Object.hasOwn(row, 'actor') && !Object.hasOwn(row, 'comparison')));
      const moved = await historyFor(reassigned, actor, compare); assert.deepEqual(moved.items.map(row => row.version), actor === caregiver ? [3, 1] : [3, 2, 1]); if (compare) assert.equal(moved.items[0].comparison.status, actor === caregiver ? 'unavailable' : 'available');
      const filtered = await historyFor(polluted, actor, compare); assert.deepEqual(filtered.items.map(row => row.version), actor === caregiver ? [4] : [4, 1]); assert.ok(!/HIDDEN-/.test(JSON.stringify(filtered))); if (compare) assert.deepEqual(filtered.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
      const gap = await historyFor(missingVersion, actor, compare); assert.deepEqual(gap.items.map(row => row.version), [3, 1]); if (compare) assert.equal(gap.items[0].comparison.status, 'unavailable');
    }
    for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `${entity}/${foreignItem.id}${suffix}`, undefined, 404, actor.client, actor.auth);
  }
  for (const suffix of ['', '/history', '/history?compare=previous']) { await request('GET', `${entity}/${otherItem.id}${suffix}`, undefined, 404, caregiver.client, caregiver.auth); await request('GET', `${entity}/${reassigned.id}${suffix}`, undefined, 404, other.client, other.auth); }
  for (const suffix of ['?compare=unknown', '?compare=previous&compare=previous']) await request('GET', `${entity}/${ownItem.id}/history${suffix}`, undefined, 422);
  for (const actor of [finance, caregiver]) { await actor.page.goto(`${base}/#/leave`); await actor.page.waitForLoadState('networkidle'); assert.equal(await actor.page.getByRole('heading', { name: '請假管理', exact: true }).count(), 0); assert.equal(await actor.page.getByRole('button', { name: '版本歷程', exact: true }).count(), 0); assert.equal(await actor.page.getByRole('link', { name: '請假與差勤', exact: true }).count(), 0); }
  verifyRead('four-real-sessions-authorization'); mark('四角色真session raw/compare：finance保留可讀API但不增導覽；caregiver僅自己目前紀錄，A→B→A只見3/1且不跳版，B現況404/跨org404');
  for (const actor of [{ client: context, auth: admin }, supervisor, finance]) {
    assert.equal((await historyFor(inactiveItem, actor)).total, 1); assert.equal((await request('GET', `${entity}/${orphan.id}`, undefined, 200, actor.client, actor.auth)).item.id, orphan.id);
    for (const compare of [false, true]) { const result = await historyFor(orphan, actor, compare); assert.deepEqual(result.items.map(row => row.version), [2, 1]); if (compare) assert.equal(result.items[0].comparison.previousVersion, 1); }
  }
  for (const suffix of ['/history', '/history?compare=previous']) await request('GET', `${entity}/${inactiveItem.id}${suffix}`, undefined, 403, inactive.client, inactive.auth);
  await load(adminPage, '/leave', '請假管理'); trigger = rowNamed(adminPage, orphan.reason).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, title, 2); assert.equal(await dialog.getByText('第 3 版', { exact: true }).count(), 0); await screenshot(adminPage, 'leave-orphan-retains-earlier.png'); await closeHistory(adminPage, trigger); verifyRead('missing-and-inactive-parent');
  mark('ALL角色逐版員工存在範圍：缺失/跨org父版隱藏；current缺父仍200並保留合法較早2/1，停用員工原管理讀權與caregiver403不變');
  trigger = rowNamed(adminPage, unknown.reason).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, title, 1); await dialog.getByText('未記錄操作者', { exact: true }).waitFor(); await dialog.getByText('完整保存欄位', { exact: true }).click(); await dialog.getByText('目前名稱無法取得', { exact: true }).waitFor(); await screenshot(adminPage, 'leave-import-unknown.png'); await closeHistory(adminPage, trigger);
  trigger = rowNamed(adminPage, empty.reason).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = adminPage.getByRole('dialog'); await dialog.getByText('尚無可讀取的版本歷程。', { exact: true }).waitFor(); await screenshot(adminPage, 'leave-empty.png'); await closeHistory(adminPage, trigger);
  trigger = rowNamed(adminPage, missingVersion.reason).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, title, 3); await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor(); await screenshot(adminPage, 'leave-missing-version.png'); await closeHistory(adminPage, trigger); verifyRead('baseline-unknown-empty-gap');
  mark('明示移轉缺姓名但員工可讀，baseline未知actor不猜；空歷程與精確缺版有明確唯讀狀態');
  trigger = rowNamed(adminPage, iso.reason).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, title, 1); await dialog.getByText('完整保存欄位', { exact: true }).click(); await dialog.getByText(iso.startTime, { exact: true }).waitFor(); await dialog.getByText(iso.endTime, { exact: true }).waitFor(); await screenshot(adminPage, 'leave-original-iso.png'); await closeHistory(adminPage, trigger); verifyRead('original-iso-preserved'); mark('同日ISO含秒與offset逐字保存，不臆測請假時數、年度餘額或正式積分');
  const pattern = `**/api/${entity}/${main.id}/history?*`; let attempts = 0;
  await adminPage.route(pattern, route => ++attempts === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ', message: '合成請假歷程暫时無法取得，請重新讀取。' } }) }) : route.continue());
  trigger = rowNamed(adminPage, main.reason).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = adminPage.getByRole('dialog'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); await screenshot(adminPage, 'leave-retry.png'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText('第 4 版', { exact: true }).waitFor(); assert.equal(attempts, 2); await closeHistory(adminPage, trigger); await adminPage.unroute(pattern);
  const delay = await delayRoute(adminPage, pattern), aborted = adminPage.waitForEvent('requestfailed', { predicate: req => req.url().includes(`/${entity}/${main.id}/history`), timeout: 10000 }); await trigger.click(); await delay.arrived.promise; await adminPage.getByRole('dialog').getByText('正在讀取歷程…', { exact: true }).waitFor(); await closeHistory(adminPage, trigger); delay.release.resolve(); await delay.handled.promise; assert.match((await aborted).failure()?.errorText || '', /abort|cancel/i); await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').count(), 0); await adminPage.unroute(pattern); verifyRead('retry-and-slow-escape');
  mark('503真API重試恢復；慢讀Escape中止fetch並回復焦點，晚回應不重新開啟');
  for (const pending of [false, true]) for (const mode of ['route', 'organization', 'role', 'employee', 'render']) {
    await load(adminPage, '/leave', '請假管理'); trigger = rowNamed(adminPage, main.reason).getByRole('button', { name: '版本歷程', exact: true }); const delayed = pending ? await delayRoute(adminPage, pattern) : null;
    if (delayed) { await trigger.click(); await delayed.arrived.promise; } else await openHistory(adminPage, trigger, title, 4);
    if (mode === 'route') await adminPage.evaluate(() => { location.hash = '/cases'; });
    else if (mode === 'organization') await adminPage.getByLabel('目前機構', { exact: true }).evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, otherOrg.id);
    else if (mode === 'render') await adminPage.evaluate(() => window.dispatchEvent(new Event('session-updated')));
    else await adminPage.evaluate(async ({ mode, employeeId }) => { const { getContext, setContext } = await import('/ui.js'); const ctx = structuredClone(getContext()); const org = ctx.organizations.find(item => item.id === ctx.organizationId); if (mode === 'role') org.role = 'supervisor'; else org.employeeId = employeeId; setContext(ctx, ctx.organizationId); document.body.append(document.createComment('synthetic-context-invalidation')); }, { mode, employeeId: employeeB.id });
    await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); if (delayed) { delayed.release.resolve(); await delayed.handled.promise; await adminPage.unroute(pattern); } await settle(adminPage); assert.equal(await adminPage.locator('.history-version').count(), 0); invalidationChecks.push({ entity, pending, mode, removed: true }); await adminPage.reload(); await adminPage.waitForLoadState('networkidle');
  }
  verifyRead('loaded-and-pending-context'); mark('已載入與慢讀各5種hash/org/role/employee/render失效立即清空關閉，10情境晚回應不復活');
  fixtureNotes.push('Role/employee invalidation is a client-only context fixture plus DOM mutation, then reloads the genuine server session. It is not a server membership change; separate real logins establish four-role API authorization.');
  await load(adminPage, '/leave', '請假管理'); const search = adminPage.getByLabel('搜尋資料', { exact: true }); await search.fill('不存在的合成搜尋字串'); await search.press('Enter'); await adminPage.getByText('沒有符合條件的資料，請調整查詢。', { exact: true }).waitFor(); await search.fill(main.reason); await search.press('Enter'); await rowNamed(adminPage, main.reason).getByRole('button', { name: '版本歷程', exact: true }).waitFor(); await adminPage.getByLabel('狀態', { exact: true }).selectOption('pending'); await adminPage.getByText('沒有符合條件的資料，請調整查詢。', { exact: true }).waitFor(); await adminPage.getByLabel('狀態', { exact: true }).selectOption('cancelled'); await rowNamed(adminPage, main.reason).getByRole('button', { name: '版本歷程', exact: true }).waitFor(); verifyRead('existing-search-status'); mark('請假列表原搜尋/狀態保持，no-results後可找回已取消紀錄並開啟歷程');
  assert.equal(invalidationChecks.length, 10); assert.deepEqual(await get('service-records', record), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll); verifyRead('final-full-database-and-financial-readonly');
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /409|503/.test(message)), JSON.stringify(consoleErrors)); mark('所有唯讀區間只GET；完整11表/raw/count/totalchanges零寫，已核准快照與fees/payroll不變，pageerror0');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium; no actual 4310/data or original platform', checks, screenshots, pageErrors, consoleErrors, failedResponses, readSegments, invalidationChecks, fixtureNotes, readonlyCounts: { before: beforeReads, after: counts() }, all11TablesUnchanged: true, billingSnapshotUnchanged: true, visualReviewPending: true }, null, 2)); console.log(`Leave history E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, fixtureNotes, error: error.stack }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
