import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, insert, saveVersion } from '../src/server/model.mjs';
import { createDelayedHistoryRead } from './personnel-history-delay-route-fixture.mjs';

// Synthetic data, actual browser/API and a random port. Never opens the disk database.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/personnel-history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-personnel-history-password';
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
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

const readSegments = [], fixtureNotes = [], invalidationChecks = [];
const configs = [
  { entity: 'employee-certifications', route: '/certifications', pageTitle: '員工證照', title: '證照版本歷程', noun: '證照', statusOff: 'revoked', statusOn: 'active', offButton: '撤銷', confirmOff: '確認撤銷證照', onButton: '恢復有效', confirmOn: '確認恢復有效紀錄' },
  { entity: 'employee-training', route: '/training', pageTitle: '教育訓練', title: '訓練版本歷程', noun: '訓練', statusOff: 'cancelled', statusOn: 'completed', offButton: '取消紀錄', confirmOff: '確認取消訓練紀錄', onButton: '恢復完成', confirmOn: '確認恢復完成紀錄' },
];
const delayRoute = (page, pattern) => createDelayedHistoryRead(page, pattern, base);
try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成證訓管理員', email: 'personnel-history-admin@example.test', password, organizationName: '合成證訓甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const get = async (entity, item) => (await request('GET', `${entity}/${item.id}`)).item;
  let employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'PH-EA', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'PH-EB', role: 'caregiver', hourlyRateCents: 32000 });
  let inactiveEmployee = await post('employees', { name: '合成已停用員工', employeeNo: 'PH-INACTIVE', role: 'caregiver' });
  const users = {};
  for (const [role, name, employee] of [['supervisor', 'supervisor'], ['caregiver', 'caregiver', employeeA], ['caregiver', 'inactive', inactiveEmployee], ['finance', 'finance']]) users[name] = await post('users', { name: `合成證訓${name}`, email: `personnel-history-${name}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const loginAs = async name => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `personnel-history-${name}@example.test`, password } }); assert.equal(response.status(), 200);
    const auth = await response.json(), page = await client.newPage(); await page.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), caregiver = await loginAs('caregiver'), finance = await loginAs('finance'), inactive = await loginAs('inactive');
  const adminPage = await context.newPage(); await adminPage.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(adminPage);
  const dataFor = (config, name, extra = {}) => config.entity === 'employee-certifications'
    ? { employeeId: employeeA.id, name, certificateNo: 'PH-2026-001', issuer: '合成發證單位', issuedOn: '2026-01-01', expiresOn: '2027-01-01', status: 'active', note: '合成證照原始備註', ...extra }
    : { employeeId: employeeA.id, name, category: 'in_service', provider: '合成辦訓單位', date: '2026-02-01', trainingMinutes: 75, status: 'completed', note: '合成訓練原始備註', ...extra };
  for (const config of configs) {
    const cert = config.entity === 'employee-certifications';
    config.originalName = `合成歷程${config.noun}`; config.name = `${config.originalName}已更新`;
    await load(adminPage, config.route, config.pageTitle); await adminPage.getByRole('button', { name: `新增${config.noun}`, exact: true }).click(); let dialog = adminPage.getByRole('dialog');
    await dialog.getByLabel('員工', { exact: false }).selectOption(employeeA.id);
    await dialog.getByLabel(cert ? '證照名稱' : '課程名稱', { exact: false }).fill(config.originalName);
    if (cert) {
      await dialog.getByLabel('證照編號', { exact: true }).fill('PH-2026-001'); await dialog.getByLabel('發證單位', { exact: true }).fill('合成發證單位'); await dialog.getByLabel('發證日期', { exact: false }).fill('2026-01-01'); await dialog.getByLabel('到期日期', { exact: false }).fill('2027-01-01');
    } else {
      await dialog.getByLabel('訓練類別', { exact: false }).selectOption('in_service'); await dialog.getByLabel('辦訓單位', { exact: true }).fill('合成辦訓單位'); await dialog.getByLabel('訓練日期', { exact: false }).fill('2026-02-01'); await dialog.getByLabel('訓練時數（小時）', { exact: false }).fill('1.25');
    }
    await dialog.getByLabel('備註', { exact: true }).fill(cert ? '合成證照原始備註' : '合成訓練原始備註'); await saveDialog(adminPage);
    config.item = (await request('GET', `${config.entity}?q=${encodeURIComponent(config.originalName)}`)).items[0]; assert.equal(config.item.version, 1);
    await load(supervisor.page, config.route, config.pageTitle); await rowNamed(supervisor.page, config.originalName).getByRole('button', { name: '編輯', exact: true }).click(); dialog = supervisor.page.getByRole('dialog'); assert.ok(await dialog.getByLabel('員工', { exact: false }).isDisabled());
    await dialog.getByLabel(cert ? '證照名稱' : '課程名稱', { exact: false }).fill(config.name);
    if (cert) {
      await dialog.getByLabel('證照編號', { exact: true }).fill('PH-2026-002'); await dialog.getByLabel('發證單位', { exact: true }).fill('合成更新發證單位'); await dialog.getByLabel('發證日期', { exact: false }).fill('2026-02-02'); await dialog.getByLabel('到期日期', { exact: false }).fill('');
    } else {
      await dialog.getByLabel('訓練類別', { exact: false }).selectOption('pre_service'); await dialog.getByLabel('辦訓單位', { exact: true }).fill('合成更新辦訓單位'); await dialog.getByLabel('訓練日期', { exact: false }).fill('2026-03-03'); await dialog.getByLabel('訓練時數（小時）', { exact: false }).fill('2.5');
    }
    await dialog.getByLabel('備註', { exact: true }).fill(`合成督導更新${config.noun}備註`); await saveDialog(supervisor.page); config.item = await get(config.entity, config.item); assert.equal(config.item.version, 2);
    await load(adminPage, config.route, config.pageTitle); await rowNamed(adminPage, config.name).getByRole('button', { name: config.offButton, exact: true }).click(); await adminPage.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click(); await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); assert.equal((await get(config.entity, config.item)).version, 2);
    await rowNamed(adminPage, config.name).getByRole('button', { name: config.offButton, exact: true }).click(); await adminPage.getByRole('dialog').getByRole('button', { name: config.confirmOff, exact: true }).click(); await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); config.item = await get(config.entity, config.item); assert.equal(config.item.version, 3); assert.equal(config.item.status, config.statusOff);
    await load(supervisor.page, config.route, config.pageTitle); await rowNamed(supervisor.page, config.name).getByRole('button', { name: config.onButton, exact: true }).click(); await supervisor.page.getByRole('dialog').getByRole('button', { name: config.confirmOn, exact: true }).click(); await supervisor.page.getByRole('dialog').waitFor({ state: 'detached' }); config.item = await get(config.entity, config.item); assert.equal(config.item.version, 4); assert.equal(config.item.status, config.statusOn);
    const history = await request('GET', `${config.entity}/${config.item.id}/history?compare=previous`);
    assert.deepEqual(history.items.map(row => row.actor.id), [users.supervisor.id, admin.user.id, users.supervisor.id, admin.user.id]);
    if (cert) { assert.equal(history.items[2].snapshot.expiresOn, ''); assert.equal(history.items[3].snapshot.expiresOn, '2027-01-01'); }
    else { assert.equal(history.items[2].snapshot.trainingMinutes, 150); assert.equal(history.items[3].snapshot.trainingMinutes, 75); }
    await request('PATCH', `${config.entity}/${config.item.id}`, { version: 4, employeeId: employeeB.id }, 409);
    mark(`${config.noun}真UI管理者新增v1→督導編輯v2→管理者撤銷/取消v3→督導恢復v4，確認取消不升版、員工不可更換、四版actor精確`);
    config.pageItem = await post(config.entity, dataFor(config, `合成${config.noun}跨頁28版`, { note: '合成第1版保存備註' }));
    for (let version = 2; version <= 28; version++) config.pageItem = await patch(config.entity, config.pageItem, { note: `合成第${version}版保存備註` });
    config.otherItem = await post(config.entity, dataFor(config, `合成他人${config.noun}`, { employeeId: employeeB.id }));
    config.inactiveItem = await post(config.entity, dataFor(config, `合成停用員工${config.noun}`, { employeeId: inactiveEmployee.id }));
  }
  // A genuine approved service creates the immutable financial baseline before personnel-only reads.
  const service = await post('service-items', { code: 'PH-S', name: '合成費用基準服務', minutes: 30, unitPriceCents: 12000 });
  const careCase = await post('cases', { name: '合成計價基準個案', caseNo: 'PH-CASE' });
  const plan = await post('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
  const shift = await post('shifts', { caseId: careCase.id, carePlanId: plan.id, employeeId: employeeA.id, date: '2026-10-25', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  let record = await post('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: service.id, quantity: 2 }], status: 'submitted', note: '合成費用基準紀錄' });
  record = (await request('POST', `service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱確認' })).item;
  const approvedRecord = structuredClone(record), fees = await request('GET', 'reports/fees?month=2026-10'), payroll = await request('GET', 'reports/payroll?month=2026-10');
  employeeA = await patch('employees', employeeA, { name: '合成甲居服員目前名稱', hourlyRateCents: 88000 }); await patch('service-items', service, { unitPriceCents: 99000 }); inactiveEmployee = await patch('employees', inactiveEmployee, { status: 'inactive' });
  assert.deepEqual(await get('service-records', record), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll);
  mark('真API員工改名/停用與費率時薪更新，證訓日期及分鐘沿保存值；獨立核准服務billingSnapshot與fees/payroll保持原值');
  const otherOrg = (await request('POST', 'organizations', { name: '合成證訓乙機構' }, 201)).item;
  const foreignEmployee = (await request('POST', 'employees', { name: '合成外機構員工', employeeNo: 'PH-FOREIGN', role: 'caregiver' }, 201, context, admin, otherOrg.id)).item;
  // Explicit synthetic import: employee exists and is readable but its legacy display name is absent.
  const nameless = insert(app.db, orgId, 'employees', { employeeNo: 'PH-IMPORT', role: 'caregiver', status: 'active', note: '合成移轉缺姓名；非正常員工新增' });
  const time = now();
  const currentOnly = (config, data, version = 1) => { const item = { ...data, id: id(), orgId, version, createdAt: time, updatedAt: time }; app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, orgId, config.entity, JSON.stringify(data), version, time, time); return item; };
  const appendVersion = (config, item, version, employeeId, note) => app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, config.entity, item.id, version, JSON.stringify({ ...item, version, employeeId, note }), time, 'baseline');
  for (const config of configs) {
    config.foreignItem = insert(app.db, otherOrg.id, config.entity, dataFor(config, `合成外機構${config.noun}`, { employeeId: foreignEmployee.id }));
    config.polluted = currentOnly(config, dataFor(config, `合成${config.noun}員工污染隔離`, { note: '合成可讀第四版' }), 4); saveVersion(app.db, config.polluted, 'baseline');
    appendVersion(config, config.polluted, 1, employeeA.id, '合成可讀第一版'); appendVersion(config, config.polluted, 2, employeeB.id, 'HIDDEN-OTHER-EMPLOYEE-V2'); appendVersion(config, config.polluted, 3, foreignEmployee.id, 'HIDDEN-FOREIGN-EMPLOYEE-V3');
    config.missingVersion = currentOnly(config, dataFor(config, `合成${config.noun}精確缺版`, { note: '合成第三版' }), 3); saveVersion(app.db, config.missingVersion, 'baseline'); appendVersion(config, config.missingVersion, 1, employeeA.id, '合成第一版');
    config.unknown = insert(app.db, orgId, config.entity, dataFor(config, `合成${config.noun}未記錄姓名`, { employeeId: nameless.id, note: '明示合成移轉fixture，存在可讀員工但缺姓名和audit' }));
    config.empty = currentOnly(config, dataFor(config, `合成${config.noun}空歷程`));
    config.orphan = insert(app.db, orgId, config.entity, dataFor(config, `合成${config.noun}父員工缺失`, { employeeId: id() }));
  }
  fixtureNotes.push('Only memory SQLite. Nameless employee is an explicit import fixture with an existing readable same-organization employee record; normal employee validation is not changed.', 'History pollution, missing version, baseline actor and empty/orphan history use explicit INSERT-only import fixtures; immutable record_versions are never updated/deleted.', 'Both real UI lifecycles and both 28-version sequences use ordinary validated writes. All fixtures and expected failed writes precede the read-only baseline.');
  const beforeReads = counts(), beforeState = rawState(); assert.equal(Object.keys(beforeState).length, 11);
  const verifyRead = label => { assert.deepEqual(counts(), beforeReads); assert.deepEqual(rawState(), beforeState); readSegments.push({ label, all11TablesUnchanged: true, counts: counts() }); };
  const historyFor = (config, item, actor = { client: context, auth: admin }, compare = true) => request('GET', `${config.entity}/${item.id}/history${compare ? '?compare=previous' : ''}`, undefined, 200, actor.client, actor.auth);
  for (const config of configs) {
    const prefix = config.noun === '證照' ? 'certification' : 'training';
    await load(adminPage, config.route, config.pageTitle); let trigger = rowNamed(adminPage, config.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.focus(); await adminPage.keyboard.press('Enter');
    let dialog = adminPage.getByRole('dialog', { name: config.title, exact: true }); await dialog.getByText('第 4 版', { exact: true }).waitFor(); await versionCard(dialog, 4).getByText(users.supervisor.name, { exact: true }).waitFor();
    let card = versionCard(dialog, 2); await card.locator(':scope > summary').click(); await card.getByText('與第 1 版比較', { exact: true }).waitFor(); const diff = card.getByRole('region', { name: '第 2 版變更前後', exact: true });
    if (prefix === 'certification') { await diff.getByText('未填到期日', { exact: true }).waitFor(); await diff.getByText('PH-2026-002', { exact: true }).waitFor(); }
    else { await diff.getByText('75 分鐘', { exact: true }).waitFor(); await diff.getByText('150 分鐘', { exact: true }).waitFor(); }
    await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await inspectLayout(adminPage); await screenshot(adminPage, `${prefix}-diff-desktop.png`);
    await adminPage.setViewportSize({ width: 390, height: 844 }); await inspectLayout(adminPage); await screenshot(adminPage, `${prefix}-diff-mobile-before.png`); await diff.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert.ok(await diff.evaluate(node => node.scrollLeft > 0)); await screenshot(adminPage, `${prefix}-diff-mobile-after.png`);
    await card.getByText('完整保存欄位', { exact: true }).click(); await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' })); await card.getByText(`目前名稱：${employeeA.name}`, { exact: true }).waitFor(); await screenshot(adminPage, `${prefix}-snapshot-mobile.png`);
    assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|還原|撤銷|取消紀錄/ }).count(), 0); assert.ok(!/expiryState|daysToExpiry|statutoryCredits|billingSnapshot|99000|88000/.test(await dialog.textContent())); await closeHistory(adminPage, trigger); await adminPage.setViewportSize({ width: 1440, height: 1050 }); verifyRead(`${prefix}-shared-history-responsive`);
    mark(`${config.noun}共用唯讀八欄差異與actor可讀，1440/390前後欄內捲/單欄保存資料/目前員工名稱/Escape焦點通過`);
    await load(caregiver.page, config.route, config.pageTitle); trigger = rowNamed(caregiver.page, config.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(caregiver.page, trigger, config.title, 4); await screenshot(caregiver.page, `${prefix}-caregiver-entry.png`); await closeHistory(caregiver.page, trigger); assert.equal(await caregiver.page.getByRole('button', { name: /^新增|^編輯$|^撤銷$|^取消紀錄$|^恢復/ }).count(), 0);
    await load(adminPage, config.route, config.pageTitle); trigger = rowNamed(adminPage, config.pageItem.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, config.title, 28); assert.equal(await dialog.locator('.history-version').count(), 25); card = versionCard(dialog, 4); await card.locator(':scope > summary').click(); await card.getByText('合成第3版保存備註', { exact: true }).waitFor(); await card.evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(adminPage, `${prefix}-page-boundary.png`); await dialog.getByRole('button', { name: '下一頁', exact: true }).click(); await dialog.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(await dialog.locator('.history-version').count(), 3); await versionCard(dialog, 3).getByText('與第 2 版比較', { exact: true }).waitFor(); await closeHistory(adminPage, trigger); const first = await request('GET', `${config.entity}/${config.pageItem.id}/history?compare=previous&page=1&pageSize=25`); assert.equal(first.items.at(-1).comparison.previousVersion, 3); verifyRead(`${prefix}-caregiver-and-pagination`);
    mark(`${config.noun}居服員僅唯讀自身；28版以25+3分頁，v4跨頁精確比較v3且v3比較v2`);
    for (const actor of [{ client: context, auth: admin }, supervisor, caregiver]) {
      const result = await historyFor(config, config.item, actor); assert.equal(result.total, 4);
      const raw = await historyFor(config, config.item, actor, false); assert.ok(raw.items.every(row => !Object.hasOwn(row, 'actor') && !Object.hasOwn(row, 'comparison')));
      for (const compare of [false, true]) {
        const filtered = await historyFor(config, config.polluted, actor, compare); assert.deepEqual(filtered.items.map(row => row.version), [4, 1]); assert.ok(!/HIDDEN-|expiryState|daysToExpiry/.test(JSON.stringify(filtered))); if (compare) assert.deepEqual(filtered.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
        const missing = await historyFor(config, config.missingVersion, actor, compare); assert.deepEqual(missing.items.map(row => row.version), [3, 1]); if (compare) assert.equal(missing.items[0].comparison.status, 'unavailable');
      }
      for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `${config.entity}/${config.foreignItem.id}${suffix}`, undefined, 404, actor.client, actor.auth);
    }
    for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `${config.entity}/${config.otherItem.id}${suffix}`, undefined, 404, caregiver.client, caregiver.auth);
    for (const route of [config.entity, `${config.entity}/${config.item.id}`, `${config.entity}/${config.item.id}/history`, `${config.entity}/${config.item.id}/history?compare=previous`]) await request('GET', route, undefined, 403, finance.client, finance.auth);
    for (const suffix of ['/history', '/history?compare=previous']) await request('GET', `${config.entity}/${config.inactiveItem.id}${suffix}`, undefined, 403, inactive.client, inactive.auth);
    for (const actor of [{ client: context, auth: admin }, supervisor]) { assert.equal((await historyFor(config, config.inactiveItem, actor)).total, 1); assert.equal((await historyFor(config, config.orphan, actor)).total, 0); assert.equal((await request('GET', `${config.entity}/${config.orphan.id}`, undefined, 200, actor.client, actor.auth)).item.id, config.orphan.id); }
    for (const suffix of ['?compare=unknown', '?compare=previous&compare=previous']) await request('GET', `${config.entity}/${config.item.id}/history${suffix}`, undefined, 422);
    await finance.page.goto(`${base}/#${config.route}`); await finance.page.waitForLoadState('networkidle'); assert.equal(await finance.page.getByRole('button', { name: '版本歷程', exact: true }).count(), 0); verifyRead(`${prefix}-four-role-parent-scope`);
    mark(`${config.noun}四角色真session/API：finance403、caregiver他人及跨org404；不可變父員工污染與缺版不跳版、缺父歷程空、inactive沿既有權限`);
    await load(adminPage, config.route, config.pageTitle); trigger = rowNamed(adminPage, config.unknown.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, config.title, 1); await dialog.getByText('未記錄操作者', { exact: true }).waitFor(); await dialog.getByText('完整保存欄位', { exact: true }).click(); await dialog.getByText('目前名稱無法取得', { exact: true }).waitFor(); await screenshot(adminPage, `${prefix}-import-unknown.png`); await closeHistory(adminPage, trigger);
    trigger = rowNamed(adminPage, config.empty.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = adminPage.getByRole('dialog'); await dialog.getByText('尚無可讀取的版本歷程。', { exact: true }).waitFor(); await screenshot(adminPage, `${prefix}-empty.png`); await closeHistory(adminPage, trigger);
    trigger = rowNamed(adminPage, config.polluted.name).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(adminPage, trigger, config.title, 4); await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor(); assert.equal(await dialog.getByText('第 3 版', { exact: true }).count(), 0); await closeHistory(adminPage, trigger); verifyRead(`${prefix}-import-empty-and-hidden-gap`);
    mark(`${config.noun}合成移轉缺姓名但父員工仍存在可讀；未知actor不猜、空歷程與污染缺口有明確狀態`);
    const pattern = `**/api/${config.entity}/${config.item.id}/history?*`; let attempts = 0;
    await adminPage.route(pattern, route => ++attempts === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ', message: '合成證訓歷程暫時無法取得，請重新讀取。' } }) }) : route.continue());
    trigger = rowNamed(adminPage, config.name).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = adminPage.getByRole('dialog'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); await screenshot(adminPage, `${prefix}-retry.png`); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText('第 4 版', { exact: true }).waitFor(); assert.equal(attempts, 2); await closeHistory(adminPage, trigger); await adminPage.unroute(pattern);
    const delay = await delayRoute(adminPage, pattern);
    await trigger.click(); await delay.waitReady(); await adminPage.getByRole('dialog').getByText('正在讀取歷程…', { exact: true }).waitFor(); delay.expectCancellation(); await closeHistory(adminPage, trigger); delay.release(); await delay.waitHandled(); await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').count(), 0); await adminPage.unroute(pattern); verifyRead(`${prefix}-retry-and-cancel`);
    mark(`${config.noun}503重試成功；慢讀Escape中止fetch並回復焦點，晚回應不重開`);
    for (const pending of [false, true]) for (const mode of ['route', 'organization', 'role', 'employee', 'render']) {
      await load(adminPage, config.route, config.pageTitle); trigger = rowNamed(adminPage, config.name).getByRole('button', { name: '版本歷程', exact: true }); const delayed = pending ? await delayRoute(adminPage, pattern) : null;
      if (delayed) { await trigger.click(); await delayed.waitReady(); } else await openHistory(adminPage, trigger, config.title, 4);
      if (delayed) delayed.expectCancellation();
      if (mode === 'route') await adminPage.evaluate(() => { location.hash = '/cases'; });
      else if (mode === 'organization') await adminPage.getByLabel('目前機構', { exact: true }).evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, otherOrg.id);
      else if (mode === 'render') await adminPage.evaluate(() => window.dispatchEvent(new Event('session-updated')));
      else await adminPage.evaluate(async ({ mode, employeeId }) => { const { getContext, setContext } = await import('/ui.js'); const ctx = structuredClone(getContext()); const org = ctx.organizations.find(item => item.id === ctx.organizationId); if (mode === 'role') org.role = 'supervisor'; else org.employeeId = employeeId; setContext(ctx, ctx.organizationId); document.body.append(document.createComment('synthetic-context-invalidation')); }, { mode, employeeId: employeeB.id });
      await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); if (delayed) { delayed.release(); await delayed.waitHandled(); await adminPage.unroute(pattern); } await settle(adminPage); assert.equal(await adminPage.locator('.history-version').count(), 0); invalidationChecks.push({ entity: config.entity, pending, mode, removed: true }); await adminPage.reload(); await adminPage.waitForLoadState('networkidle');
    }
    verifyRead(`${prefix}-loaded-and-pending-context`); mark(`${config.noun}已載入與慢讀各5種hash/org/role/employee/render失效立即清空關閉，10情境無晚回應復活`);
  }
  fixtureNotes.push('Role/employee invalidation is explicitly a client-only context fixture plus DOM mutation. Every scenario reloads its genuine server session; this is not a claim that server memberships were changed. Four-role API authorization uses separate real login sessions.');
  const certHistoryNow = await request('GET', `${configs[0].entity}/${configs[0].item.id}/history?compare=previous&asOf=2030-01-01`); assert.ok(!/expiryState|daysToExpiry|"asOf"/.test(JSON.stringify(certHistoryNow))); assert.equal(certHistoryNow.items[0].snapshot.expiresOn, '');
  assert.equal(invalidationChecks.length, 20); assert.deepEqual(await get('service-records', record), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll); verifyRead('final-full-database-and-financial-readonly');
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /503/.test(message)), JSON.stringify(consoleErrors));
  mark('兩entity歷程不依asOf重算到期、不轉積分；完整11表/raw/count/totalchanges零寫，核准快照與fees/payroll不變、pageerror0');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium; no actual 4310/data or original platform', checks, screenshots, pageErrors, consoleErrors, failedResponses, readSegments, invalidationChecks, fixtureNotes, readonlyCounts: { before: beforeReads, after: counts() }, all11TablesUnchanged: true, billingSnapshotUnchanged: true, visualReviewPending: true }, null, 2));
  console.log(`Personnel history E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, fixtureNotes, error: error.stack }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
