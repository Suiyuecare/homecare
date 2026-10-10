import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';

// Real browser + API + memory database. No production port, disk database or original-platform data.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/personnel-qa');
const asOf = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const plusDays = count => new Date(Date.parse(`${asOf}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  chromium.executablePath(),
  ...installed.filter(x => /^chromium-/.test(x)).sort().reverse().map(x => path.join(cache, x, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [];
const contexts = [];
let browser, page, base, expectedConflict = false, expectedDateRange = false;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = current => {
  current.on('pageerror', error => pageErrors.push(error.message));
  current.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  current.on('response', response => {
    if (response.status() >= 400) failedResponses.push({
      path: new URL(response.url()).pathname, status: response.status(),
      expected: (expectedConflict && response.status() === 409 && /\/api\/employee-certifications\//.test(response.url()))
        || (expectedDateRange && response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/employee-certifications' && response.status() === 422),
    });
  });
};
const load = async (current, route, heading) => {
  await current.goto(`${base}/#${route}`);
  await current.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor();
  await current.waitForLoadState('networkidle');
  assert.equal(await current.locator('.error-state').count(), 0, `route error: ${route}`);
};
const inspectLayout = async current => {
  assert.ok(await current.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Document must not overflow viewport');
  const unlabelled = await current.locator('input,select,textarea').evaluateAll(nodes => nodes
    .filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby'))
    .map(node => ({ tag: node.tagName, name: node.name })));
  assert.deepEqual(unlabelled, [], 'Visible controls need semantic labels');
};
const screenshot = async (current, filename) => { assert.ok(await current.locator('.toast:visible').count() <= 2, 'At most two visible toasts'); if (await current.locator('.toast').count()) await current.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 }); await current.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename); };
const rowNamed = (current, name) => current.getByRole('row').filter({ hasText: name });
const revealHistorySnapshots = async dialog => {
  await dialog.locator('.history-version').first().waitFor();
  for (const version of await dialog.locator('.history-version').all()) {
    if (await version.getAttribute('open') === null) await version.locator('summary').first().click();
    const snapshot = version.locator('.history-snapshot');
    if (await snapshot.getAttribute('open') === null) await snapshot.getByText('完整保存欄位', { exact: true }).click();
  }
};
const saveDialog = async current => {
  const dialog = current.getByRole('dialog');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
};
const discardDialog = async current => {
  await current.keyboard.press('Escape');
  const confirm = current.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true });
  await confirm.getByRole('button', { name: '放棄修改', exact: true }).click();
  await current.getByRole('dialog').waitFor({ state: 'detached' });
};
await mkdir(output, { recursive: true });

try {
  base = await app.listen();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  contexts.push(context);
  page = await context.newPage(); observe(page);
  const setupResponse = await context.request.post(`${base}/api/setup`, {
    headers: { Origin: base }, data: { name: '合成證訓管理者', email: 'personnel-admin@example.test', password: 'synthetic-personnel-password', organizationName: '合成證訓測試機構' },
  });
  assert.equal(setupResponse.status(), 201, await setupResponse.text());
  const session = await setupResponse.json();
  const orgId = session.organizations[0].id;
  const headersFor = auth => ({ Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': auth.csrfToken });
  const headers = headersFor(session);
  const request = async (method, url, data, expected = 200, client = context, auth = session) => {
    const response = await client.request.fetch(`${base}/api/${url}`, { method, headers: headersFor(auth), ...(data === undefined ? {} : { data }) });
    const value = await response.json();
    assert.equal(response.status(), expected, `${method} ${url}: ${JSON.stringify(value)}`);
    return value;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const list = async (entity, query = '') => request('GET', `${entity}${query ? `?${query}` : ''}`);
  const employee = await post('employees', { name: '合成證訓員工甲', employeeNo: 'PERSONNEL-01', role: 'caregiver' });
  const other = await post('employees', { name: '合成證訓員工乙', employeeNo: 'PERSONNEL-02', role: 'caregiver' });
  for (const [role, email, employeeId] of [
    ['caregiver', 'personnel-carer@example.test', employee.id],
    ['supervisor', 'personnel-supervisor@example.test', ''],
    ['finance', 'personnel-finance@example.test', ''],
  ]) await post('users', { name: `合成證訓${role}`, email, password: 'synthetic-personnel-password', role, employeeId });

  const certificateData = { employeeId: employee.id, name: '合成日期邊界', certificateNo: '', issuer: '合成發證單位', issuedOn: plusDays(-365), expiresOn: plusDays(45), status: 'active', note: '合成資料' };
  const boundaries = [
    ['昨日', -1, 'active', 'expired', -1], ['今日', 0, 'active', 'due_soon', 0],
    ['第30天', 30, 'active', 'due_soon', 30], ['第31天', 31, 'active', 'valid', 31],
    ['未填到期日', null, 'active', 'no_expiry', null], ['撤銷', -5, 'revoked', 'revoked', -5],
  ];
  const boundaryIds = new Map();
  for (const [label, offset, status] of boundaries) {
    const item = await post('employee-certifications', { ...certificateData, name: `合成邊界-${label}`, expiresOn: offset === null ? '' : plusDays(offset), status });
    boundaryIds.set(label, item.id);
  }
  const boundaryList = await list('employee-certifications', `asOf=${asOf}&q=${encodeURIComponent('合成邊界-')}&pageSize=100`);
  assert.equal(boundaryList.total, boundaries.length);
  for (const [label, , , expiryState, days] of boundaries) {
    const item = boundaryList.items.find(record => record.id === boundaryIds.get(label));
    assert.equal(item.expiryState, expiryState, label);
    assert.equal(item.asOf, asOf, label);
    if (expiryState !== 'revoked') assert.equal(item.daysToExpiry, days, label);
  }
  for (const state of ['expired', 'due_soon', 'valid', 'no_expiry', 'revoked']) {
    const filtered = await list('employee-certifications', `asOf=${asOf}&expiry=${state}&pageSize=100`);
    assert.ok(filtered.items.length > 0, `expiry ${state}`);
    assert.ok(filtered.items.every(item => item.expiryState === state));
  }
  await request('GET', 'employee-certifications?asOf=2026-02-30', undefined, 422);
  await request('POST', 'employee-certifications', { ...certificateData, issuedOn: asOf, expiresOn: plusDays(-1) }, 422);
  mark('證照 API 日期邊界：昨日、今日、30/31天、未填到期日、撤銷；非法日期拒絕');

  await load(page, '/certifications', '員工證照');
  const createCertificate = page.getByRole('button', { name: '新增證照', exact: true });
  await createCertificate.click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.ok(await createCertificate.evaluate(node => node === document.activeElement));
  await createCertificate.press('Enter');
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.locator('[aria-invalid="true"]').first().waitFor();
  assert.equal((await list('employee-certifications')).total, boundaries.length);
  await dialog.getByLabel('員工', { exact: false }).first().selectOption(employee.id);
  await dialog.getByLabel('證照名稱', { exact: false }).fill('合成核心證照');
  await dialog.getByLabel('證照編號', { exact: false }).fill('SYNTHETIC-CERT-V1');
  await dialog.getByLabel('發證單位', { exact: false }).fill('合成發證單位甲');
  await dialog.getByLabel('發證日期', { exact: false }).fill(asOf);
  await dialog.getByLabel('到期日期', { exact: false }).fill(plusDays(-1));
  // The frozen edit contract delegates date ordering to the unchanged API.
  expectedDateRange = true;
  const dateRangeResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/employee-certifications' && response.status() === 422);
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  const dateRangeResponse = await dateRangeResponsePromise;
  assert.equal((await dateRangeResponse.json()).error?.code, 'DATE_RANGE');
  await dialog.locator('[aria-invalid="true"]').last().waitFor();
  expectedDateRange = false;
  assert.equal(await dialog.getByLabel('證照名稱', { exact: false }).inputValue(), '合成核心證照');
  assert.equal((await list('employee-certifications')).total, boundaries.length);
  await dialog.getByLabel('到期日期', { exact: false }).fill(plusDays(45));
  await inspectLayout(page);
  await saveDialog(page);
  let certificate = (await list('employee-certifications', `q=${encodeURIComponent('合成核心證照')}`)).items[0];
  assert.equal(certificate.version, 1); assert.equal(certificate.certificateNo, 'SYNTHETIC-CERT-V1');
  mark('證照完整新增；空白及倒置日期留在表單；鍵盤開啟、Escape及焦點回復');

  await rowNamed(page, '合成核心證照').getByRole('button', { name: '編輯', exact: true }).click();
  dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('員工', { exact: false }).first().isDisabled(), true);
  await dialog.getByLabel('證照編號', { exact: false }).fill('SYNTHETIC-CERT-V2');
  await dialog.getByLabel('發證單位', { exact: false }).fill('合成發證單位乙');
  await saveDialog(page);
  certificate = (await request('GET', `employee-certifications/${certificate.id}`)).item;
  assert.equal(certificate.version, 2); assert.equal(certificate.employeeId, employee.id);
  const certHistory = await request('GET', `employee-certifications/${certificate.id}/history`);
  assert.ok(certHistory.items.some(item => item.version === 1 && item.snapshot.certificateNo === 'SYNTHETIC-CERT-V1'));
  assert.ok(certHistory.items.some(item => item.version === 2 && item.snapshot.certificateNo === 'SYNTHETIC-CERT-V2'));
  assert.ok(certHistory.items.every(item => !('expiryState' in item.snapshot)));
  await rowNamed(page, '合成核心證照').getByRole('button', { name: '版本歷程', exact: true }).click();
  dialog = page.getByRole('dialog');
  await revealHistorySnapshots(dialog);
  await dialog.locator('.history-snapshot').getByText('SYNTHETIC-CERT-V1', { exact: true }).waitFor();
  await dialog.locator('.history-snapshot').getByText('SYNTHETIC-CERT-V2', { exact: true }).waitFor();
  await dialog.getByText('初始版本；沒有上一版本可比較。', { exact: true }).waitFor();
  await screenshot(page, 'certification-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.locator('.table-scroll').first().evaluate(node => { node.scrollLeft = node.scrollWidth; });
  assert.ok(await dialog.getByText(asOf.replaceAll('-', '/'), { exact: true }).first().evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) * 1.5), 'Mobile history date remains on one readable line');
  await inspectLayout(page);
  await screenshot(page, 'certification-history-mobile.png');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await rowNamed(page, '合成核心證照').getByRole('button', { name: '版本歷程', exact: true }).evaluate(node => node === document.activeElement));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await request('PATCH', `employee-certifications/${certificate.id}`, { version: certificate.version, employeeId: other.id }, 409);
  mark('證照修改、員工不可改派、版本快照及歷程畫面保留原值');

  await rowNamed(page, '合成核心證照').getByRole('button', { name: '編輯', exact: true }).click();
  dialog = page.getByRole('dialog');
  await request('PATCH', `employee-certifications/${certificate.id}`, { version: certificate.version, note: '合成另一工作階段更新' });
  await dialog.getByLabel('備註', { exact: false }).fill('合成尚未儲存的內容');
  expectedConflict = true;
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.getByText(/資料已更新/).waitFor();
  expectedConflict = false;
  assert.equal(await dialog.getByLabel('備註', { exact: false }).inputValue(), '合成尚未儲存的內容');
  assert.equal(await dialog.getByLabel('證照編號', { exact: false }).inputValue(), 'SYNTHETIC-CERT-V2');
  await screenshot(page, 'certification-conflict-desktop.png');
  await discardDialog(page);
  mark('真實並行 PATCH 造成409，表單保留所有未儲存輸入');

  await load(page, '/training', '教育訓練');
  await page.getByRole('button', { name: '新增訓練', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('員工', { exact: false }).first().selectOption(employee.id);
  await dialog.getByLabel('課程名稱', { exact: false }).fill('合成核心訓練');
  await dialog.getByLabel('訓練類別', { exact: false }).selectOption('in_service');
  await dialog.getByLabel('辦訓單位', { exact: false }).fill('合成辦訓單位');
  await dialog.getByLabel('訓練日期', { exact: false }).fill(asOf);
  const hours = dialog.getByLabel('訓練時數（小時）', { exact: false });
  assert.equal(await hours.getAttribute('step'), '0.25');
  await hours.fill('1.001');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.locator('[aria-invalid="true"]').waitFor();
  assert.equal(await hours.inputValue(), '1.001');
  assert.equal((await list('employee-training')).total, 0);
  await hours.fill('1.25');
  await inspectLayout(page);
  await saveDialog(page);
  let training = (await list('employee-training', `q=${encodeURIComponent('合成核心訓練')}`)).items[0];
  assert.equal(training.trainingMinutes, 75); assert.equal(training.status, 'completed');
  await rowNamed(page, '合成核心訓練').getByRole('button', { name: '編輯', exact: true }).click();
  dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('員工', { exact: false }).first().isDisabled(), true);
  assert.equal(await dialog.getByLabel('訓練時數（小時）', { exact: false }).inputValue(), '1.25');
  await dialog.getByLabel('訓練時數（小時）', { exact: false }).fill('2.5');
  await dialog.getByLabel('訓練類別', { exact: false }).selectOption('pre_service');
  await saveDialog(page);
  training = (await request('GET', `employee-training/${training.id}`)).item;
  assert.equal(training.trainingMinutes, 150); assert.equal(training.category, 'pre_service');
  const trainingHistory = await request('GET', `employee-training/${training.id}/history`);
  assert.ok(trainingHistory.items.some(item => item.version === 1 && item.snapshot.trainingMinutes === 75));
  assert.ok(trainingHistory.items.some(item => item.version === 2 && item.snapshot.trainingMinutes === 150));
  await rowNamed(page, '合成核心訓練').getByRole('button', { name: '版本歷程', exact: true }).click();
  dialog = page.getByRole('dialog');
  await revealHistorySnapshots(dialog);
  await dialog.locator('.history-snapshot').getByText('75 分鐘', { exact: true }).waitFor();
  await dialog.locator('.history-snapshot').getByText('150 分鐘', { exact: true }).waitFor();
  await dialog.getByText('初始版本；沒有上一版本可比較。', { exact: true }).waitFor();
  await screenshot(page, 'training-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.locator('.table-scroll').first().evaluate(node => { node.scrollLeft = node.scrollWidth; });
  assert.ok(await dialog.getByText(asOf.replaceAll('-', '/'), { exact: true }).first().evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) * 1.5), 'Mobile history date remains on one readable line');
  await inspectLayout(page);
  await screenshot(page, 'training-history-mobile.png');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await rowNamed(page, '合成核心訓練').getByRole('button', { name: '版本歷程', exact: true }).evaluate(node => node === document.activeElement));
  await page.setViewportSize({ width: 1440, height: 1050 });
  mark('兩類版本歷程在1440/390px展開可讀；Escape關閉與焦點回復');
  await request('PATCH', `employee-training/${training.id}`, { version: training.version, employeeId: other.id }, 409);
  await request('POST', 'employee-training', { employeeId: employee.id, name: '合成無效分鐘', category: 'other', provider: '', date: asOf, trainingMinutes: 0, status: 'completed' }, 422);
  mark('訓練新增編輯：1.25小時→75分鐘、2.5小時→150分鐘，歷程保留且不可改派員工');

  const otherCertificate = await post('employee-certifications', { ...certificateData, employeeId: other.id, name: '合成他人限定證照' });
  const otherTraining = await post('employee-training', { employeeId: other.id, name: '合成他人限定訓練', category: 'other', provider: '', date: asOf, trainingMinutes: 60, status: 'completed' });
  const loginAs = async (email, width = 1440) => {
    const client = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email, password: 'synthetic-personnel-password' } });
    assert.equal(response.status(), 200, await response.text());
    const auth = await response.json(); const current = await client.newPage(); observe(current);
    return { client, auth, current };
  };
  const carer = await loginAs('personnel-carer@example.test', 390);
  for (const [route, heading, entity, foreignId] of [
    ['/certifications', '員工證照', 'employee-certifications', otherCertificate.id],
    ['/training', '教育訓練', 'employee-training', otherTraining.id],
  ]) {
    await load(carer.current, route, heading); await inspectLayout(carer.current);
    assert.equal(await carer.current.getByRole('button', { name: /^新增|^編輯$|^撤銷$|^取消紀錄$/ }).count(), 0);
    assert.equal(await carer.current.getByText(/合成他人限定/).count(), 0);
    const own = await request('GET', entity, undefined, 200, carer.client, carer.auth);
    assert.ok(own.items.length > 0 && own.items.every(item => item.employeeId === employee.id));
    await request('GET', `${entity}/${foreignId}`, undefined, 404, carer.client, carer.auth);
    await request('GET', `${entity}/${foreignId}/history`, undefined, 404, carer.client, carer.auth);
    await request('POST', entity, entity === 'employee-certifications' ? certificateData : { employeeId: employee.id, name: '合成拒絕訓練', category: 'other', date: asOf, trainingMinutes: 60 }, 403, carer.client, carer.auth);
    await screenshot(carer.current, `${route.slice(1)}-caregiver-mobile.png`);
  }
  mark('390px 居服員只看自己的證照訓練；無修改入口，跨人員及寫入API拒絕');

  const finance = await loginAs('personnel-finance@example.test');
  for (const [route, entity] of [['/certifications', 'employee-certifications'], ['/training', 'employee-training']]) {
    await finance.current.goto(`${base}/#${route}`);
    await finance.current.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor();
    await request('GET', entity, undefined, 403, finance.client, finance.auth);
  }
  mark('財務角色頁面與兩個證訓API均拒絕');

  const supervisor = await loginAs('personnel-supervisor@example.test');
  await load(supervisor.current, '/certifications', '員工證照');
  assert.equal(await supervisor.current.getByRole('button', { name: '新增證照', exact: true }).count(), 1);
  const supervisorCert = (await request('POST', 'employee-certifications', { ...certificateData, name: '合成督導新增證照' }, 201, supervisor.client, supervisor.auth)).item;
  await request('PATCH', `employee-certifications/${supervisorCert.id}`, { version: 1, note: '合成督導修改' }, 200, supervisor.client, supervisor.auth);
  await load(supervisor.current, '/training', '教育訓練');
  assert.equal(await supervisor.current.getByRole('button', { name: '新增訓練', exact: true }).count(), 1);
  mark('督導可進入兩頁並新增修改證照；管理角色入口正常');

  await load(page, '/certifications', '員工證照');
  await rowNamed(page, '合成核心證照').getByRole('button', { name: '撤銷', exact: true }).click();
  await page.getByRole('dialog', { name: '撤銷證照', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await request('GET', `employee-certifications/${certificate.id}`)).item.status, 'active');
  await rowNamed(page, '合成核心證照').getByRole('button', { name: '撤銷', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認撤銷證照', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal((await request('GET', `employee-certifications/${certificate.id}`)).item.expiryState, 'revoked');
  await rowNamed(page, '合成核心證照').getByRole('button', { name: '恢復有效', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認恢復有效紀錄', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await load(page, '/training', '教育訓練');
  await rowNamed(page, '合成核心訓練').getByRole('button', { name: '取消紀錄', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認取消訓練紀錄', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal((await request('GET', `employee-training/${training.id}`)).item.status, 'cancelled');
  await rowNamed(page, '合成核心訓練').getByRole('button', { name: '恢復完成', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認恢復完成紀錄', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const restoredHistory = await request('GET', `employee-training/${training.id}/history`);
  assert.ok(restoredHistory.items.some(item => item.snapshot.status === 'cancelled'));
  assert.equal((await request('GET', `employee-training/${training.id}`)).item.status, 'completed');
  mark('撤銷與取消先確認，可取消操作及恢復，原資料與狀態歷程保留');

  await load(page, '/certifications', '員工證照');
  await page.getByLabel('員工篩選', { exact: true }).selectOption(other.id);
  await rowNamed(page, '合成他人限定證照').waitFor();
  assert.equal(await rowNamed(page, '合成核心證照').count(), 0);
  await page.getByLabel('員工篩選', { exact: true }).selectOption('');
  await page.getByLabel('效期狀態', { exact: true }).selectOption('due_soon');
  await rowNamed(page, '合成邊界-今日').waitFor();
  await rowNamed(page, '合成邊界-第30天').waitFor();
  assert.equal(await rowNamed(page, '合成邊界-第31天').count(), 0);
  await page.getByLabel('效期基準日', { exact: true }).fill('');
  await page.getByText('請選擇有效的效期基準日。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('效期基準日', { exact: true }).getAttribute('aria-invalid'), 'true');
  assert.equal(await page.getByLabel('效期狀態', { exact: true }).inputValue(), 'due_soon');
  assert.equal(await page.locator('tbody tr').count(), 0);
  mark('效期基準日清空時提示並標aria-invalid，原效期篩選保留');
  await page.getByLabel('效期基準日', { exact: true }).fill(plusDays(31));
  await page.getByLabel('效期狀態', { exact: true }).selectOption('due_soon');
  await rowNamed(page, '合成邊界-第31天').waitFor();
  assert.equal(await rowNamed(page, '合成邊界-今日').count(), 0);
  await page.getByLabel('效期基準日', { exact: true }).fill(asOf);
  await page.getByLabel('效期狀態', { exact: true }).selectOption('');
  for (let index = 1; index <= 26; index++) await post('employee-certifications', { ...certificateData, employeeId: other.id, name: `合成分頁證照-${String(index).padStart(2, '0')}` });
  const certSearch = page.getByRole('searchbox', { name: '搜尋證照', exact: true });
  await certSearch.fill('合成分頁證照-'); await certSearch.press('Enter');
  await page.getByText('共 26 筆 · 第 1 / 2 頁', { exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 25);
  await page.getByRole('button', { name: '下一頁', exact: true }).click();
  await page.getByText('共 26 筆 · 第 2 / 2 頁', { exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 1);
  await certSearch.fill('合成絕無資料關鍵字'); await certSearch.press('Enter');
  await page.getByText(/沒有符合條件|找不到符合條件/).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 0);
  assert.ok(!new URL(page.url()).hash.includes('合成'));
  await page.getByRole('button', { name: '清除搜尋證照', exact: true }).click();
  await load(page, '/training', '教育訓練');
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/employee-training' && new URL(response.url()).searchParams.get('category') === 'pre_service' && response.status() === 200),
    page.getByLabel('訓練類別篩選', { exact: true }).selectOption('pre_service'),
  ]);
  await rowNamed(page, '合成核心訓練').waitFor();
  assert.equal(await rowNamed(page, '合成他人限定訓練').count(), 0);
  await page.getByLabel('訓練類別篩選', { exact: true }).selectOption('');
  await page.getByLabel('員工篩選', { exact: true }).selectOption(other.id);
  await rowNamed(page, '合成他人限定訓練').waitFor();
  assert.equal(await rowNamed(page, '合成核心訓練').count(), 0);
  await page.getByLabel('員工篩選', { exact: true }).selectOption('');
  mark('員工、效期及基準日、類別真API篩選；空基準日留篩選並提示；26筆分頁/清除');

  for (const [route, heading] of [['/certifications', '員工證照'], ['/training', '教育訓練']]) {
    await page.setViewportSize({ width: 1440, height: 1050 }); await load(page, route, heading);
    if (route === '/certifications') { await page.getByLabel('員工篩選', { exact: true }).selectOption(employee.id); await rowNamed(page, '合成核心證照').waitFor(); }
    await inspectLayout(page);
    await screenshot(page, `${route.slice(1)}-desktop.png`);
    await page.setViewportSize({ width: 390, height: 844 }); await load(page, route, heading); await inspectLayout(page);
    await screenshot(page, `${route.slice(1)}-mobile.png`);
  }
  mark('1440/390px 管理頁與歷程畫面：標籤、文件寬度與表格捲動');
  mark('連續操作最多兩則通知；畫面證據於通知消失後擷取');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedResponses.filter(response => !response.expected), []);
  const dateRangeFailures = failedResponses.filter(response => response.status === 422);
  assert.deepEqual(dateRangeFailures, [{ path: '/api/employee-certifications', status: 422, expected: true }]);
  const dateRangeConsole = consoleErrors.filter(message => message.includes('the server responded with a status of 422'));
  assert.equal(dateRangeConsole.length, 1, 'Only the verified DATE_RANGE response may explain one 422 console message');
  const unexpectedConsole = consoleErrors.filter(message => !message.includes('the server responded with a status of 409') && !dateRangeConsole.includes(message));
  assert.deepEqual(unexpectedConsole, []);
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, date: new Date().toISOString(), scope: '合成資料、記憶體SQLite、隨機埠；未使用4310或data目錄', asOf, checks, pageErrors, consoleErrors: unexpectedConsole, expectedFailures: failedResponses.filter(response => response.expected), screenshots }, null, 2));
  console.log(`PERSONNEL_E2E_PASS ${checks.length} checks`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, date: new Date().toISOString(), asOf, checks, error: error.message, pageErrors, consoleErrors, failedResponses }, null, 2));
  throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  await app.close();
}
