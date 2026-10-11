import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/index.mjs';

// This executable accepts no disk database and never uses a fixed application port.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/v066-shift-batches-qa/browser-' + Date.now());
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], contexts = [], submissions = [];
let base, browser, lastPage, stage = 'setup';
const password = 'synthetic-batch-browser-password';
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const counts = () => Object.fromEntries([
  ['changes', 'SELECT total_changes() n'], ['records', 'SELECT COUNT(*) n FROM records'],
  ['versions', 'SELECT COUNT(*) n FROM record_versions'], ['audit', 'SELECT COUNT(*) n FROM audit'],
  ['idempotency', 'SELECT COUNT(*) n FROM idempotency']].map(([name, sql]) => [name, app.db.prepare(sql).get().n]));
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: /\/api\/shift-batches\/commit$/.test(new URL(response.url()).pathname) && [409, 503].includes(response.status()) }); });
};
const dialogOf = page => page.getByRole('dialog', { name: '批次改派與取消班次', exact: true });
const previewButton = page => dialogOf(page).getByRole('button', { name: /^預覽整批調整/ });
const commitButton = page => dialogOf(page).getByRole('button', { name: /^確認套用整批調整/ });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screen(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow');
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), [], 'Visible fields have labels');
  if (await dialogOf(page).count()) {
    const geometry = await dialogOf(page).evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: innerWidth, client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport); assert.ok(geometry.scroll <= geometry.client + 1, 'No dialog overflow');
  }
}
async function capture(page, name) { await screen(page); const file = name + '.png'; await page.screenshot({ path: path.join(output, file), fullPage: false }); screenshots.push(file); }
async function load(page, route = '/shifts', heading = '班表') {
  lastPage = page; if (page.url() === `${base}/#${route}`) await page.reload(); else await page.goto(`${base}/#${route}`);
  await page.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); assert.equal(await page.locator('.error-state').count(), 0);
}
async function closeDirty(page) { await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).getByRole('button', { name: '放棄修改', exact: true }).click(); await dialogOf(page).waitFor({ state: 'detached' }); }
const previewPattern = '**/api/shift-batches/preview', commitPattern = '**/api/shift-batches/commit';
await mkdir(output, { recursive: true });
try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成批次驗收管理員', email: 'batch-browser-admin@example.test', password, organizationName: '合成批次驗收機構' } }); assert.equal(setup.status(), 201);
  const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, moreHeaders = {}) => {
    const response = await client.request.fetch(base + '/api/' + route, { method, headers: { Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': auth.csrfToken, ...moreHeaders }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, method + ' ' + route + ': ' + JSON.stringify(body)); return body;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const get = async (entity, id) => (await request('GET', entity + '/' + id)).item;
  const source = await post('employees', { name: '合成原居服員', employeeNo: 'BATCH-SOURCE' }), target = await post('employees', { name: '合成改派居服員', employeeNo: 'BATCH-TARGET' });
  const service = await post('service-items', { code: 'BATCH-SERVICE', name: '合成照顧服務', minutes: 60, unitPriceCents: 12345 }), services = [{ serviceItemId: service.id, quantity: 2 }];
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
  const nextDate = offset => { const parsed = new Date(today + 'T00:00:00Z'); parsed.setUTCDate(parsed.getUTCDate() + offset); return parsed.toISOString().slice(0, 10); };
  let fixtureIndex = 0;
  const fixture = async (label, offset) => {
    const key = ++fixtureIndex, item = await post('cases', { name: '合成批次' + label + '個案', caseNo: 'BATCH-C' + key });
    const plan = await post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services });
    const shifts = [];
    for (let index = 0; index < 2; index++) shifts.push(await post('shifts', { caseId: item.id, carePlanId: plan.id, employeeId: source.id, date: nextDate(offset), startTime: index ? '10:00' : '09:00', endTime: index ? '11:00' : '10:00', services, note: ' ' + label + '原交班\r\n末行 ' }));
    return { item, plan, shifts, date: nextDate(offset) };
  };
  const main = await fixture('主流程', 0), recovery = await fixture('重送', 1), blocked = await fixture('服務鎖定', 2), race = await fixture('版本競態', 3), mobile = await fixture('手機', 4);
  for (const role of ['supervisor', 'finance', 'caregiver']) await post('users', { name: '合成批次' + role, email: 'batch-browser-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: source.id } : {}) });
  await post('service-records', { shiftId: blocked.shifts[1].id, caseId: blocked.item.id, employeeId: source.id, date: blocked.date, actualStart: '10:00', actualEnd: '11:00', services, status: 'draft' });
  const untouched = app.db.prepare("SELECT * FROM records WHERE entity!='shifts' ORDER BY rowid").all();
  const page = await context.newPage(); observe(page); lastPage = page;
  const open = async (f, action = 'reassign', currentPage = page) => {
    await load(currentPage); const trigger = currentPage.getByRole('button', { name: '批次改派／取消', exact: true }); await trigger.click();
    const dialog = dialogOf(currentPage); await dialog.waitFor();
    await dialog.getByLabel('選取清單日期', { exact: false }).fill(f.date);
    await currentPage.waitForFunction(() => document.querySelector('dialog[open] [name="selectionState"]')?.value.startsWith('已讀取 2 筆'));
    assert.equal(await dialog.getByRole('checkbox').count(), 2);
    for (const checkbox of await dialog.getByRole('checkbox').all()) await checkbox.check();
    await dialog.getByLabel('本次操作', { exact: false }).selectOption(action);
    if (action === 'reassign') await dialog.getByLabel('改派服務人員', { exact: false }).selectOption(target.id);
    await dialog.getByLabel('本次批次操作原因', { exact: false }).fill(' 合成本次批次原因\n保留原文 ');
    return { trigger, definition: { action, items: f.shifts.map(item => ({ id: item.id, version: item.version })), ...(action === 'reassign' ? { employeeId: target.id } : {}), reason: ' 合成本次批次原因\n保留原文 ' } };
  };
  const preview = async (currentPage = page) => {
    const received = currentPage.waitForResponse(response => response.url().endsWith('/api/shift-batches/preview'));
    await previewButton(currentPage).click(); const response = await received; assert.equal(response.status(), 200); const body = await response.json();
    await dialogOf(currentPage).getByRole('heading', { name: '整批調整預覽', exact: true }).waitFor(); return body;
  };
  const commit = async (currentPage = page) => {
    const received = currentPage.waitForResponse(response => response.url().endsWith('/api/shift-batches/commit'));
    await commitButton(currentPage).click(); const response = await received; assert.equal(response.status(), 200); const body = await response.json();
    await dialogOf(currentPage).waitFor({ state: 'detached' }); await currentPage.waitForLoadState('networkidle'); submissions.push(body); return body;
  };

  stage = 'desktop reassignment'; let opened = await open(main), before = counts();
  assert.equal(await commitButton(page).isEnabled(), false); await capture(page, 'desktop-form'); let prepared = await preview();
  assert.equal(prepared.canCommit, true); assert.equal(prepared.readyCount, 2); assert.deepEqual(counts(), before); await capture(page, 'desktop-reassignment-preview');
  mark('桌面明確勾選2筆目前版次；有標籤、預覽之前不可提交，預覽零寫入');
  let saved = await commit(); assert.equal(saved.total, 2);
  for (let index = 0; index < 2; index++) {
    const current = await get('shifts', main.shifts[index].id); assert.equal(current.employeeId, target.id); assert.equal(current.version, 2);
    for (const key of ['caseId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note', 'createdAt']) assert.deepEqual(current[key], main.shifts[index][key], key);
    const history = await request('GET', 'shifts/' + current.id + '/history?compare=previous'); assert.equal(history.items[0].actor.id, admin.user.id); assert.equal(history.items[0].comparison.previousSnapshot.employeeId, source.id);
  }
  mark('真UI整批改派2筆，CAS各增1且保存實際actor與歷程；原交班CRLF及全部非操作欄位保留');

  stage = 'desktop cancellation'; main.shifts = saved.items; opened = await open(main, 'cancel'); before = counts();
  assert.equal(await dialogOf(page).getByLabel('改派服務人員', { exact: false }).isDisabled(), true); prepared = await preview(); assert.equal(prepared.canCommit, true); assert.deepEqual(counts(), before);
  await capture(page, 'desktop-cancel-preview'); saved = await commit(); assert.ok(saved.items.every(item => item.status === 'cancelled' && item.employeeId === target.id && item.version === 3));
  assert.ok(saved.items.every((item, index) => item.note === main.shifts[index].note)); mark('取消整批2筆保留人員及交班內容；取消不提交隱藏改派值、不建立服務紀錄');

  stage = 'blocked selection'; await open(blocked, 'cancel'); before = counts(); prepared = await preview();
  assert.equal(prepared.canCommit, false); assert.equal(prepared.readyCount, 1); assert.equal(prepared.items.find(item => item.id === blocked.shifts[1].id).conflicts[0].code, 'SHIFT_HAS_RECORD');
  assert.equal(await commitButton(page).isEnabled(), false); await dialogOf(page).getByText('班次已有服務紀錄，不能批次改派或取消', { exact: true }).waitFor(); await capture(page, 'desktop-record-conflict'); assert.deepEqual(counts(), before); await closeDirty(page);
  mark('草稿服務紀錄也鎖定班次；一筆有衝突整批不可提交，零寫入');

  stage = 'transport recovery'; opened = await open(recovery); prepared = await preview(); before = counts(); const retryKeys = []; let unavailable = false;
  await page.route(commitPattern, async route => { retryKeys.push(route.request().headers()['idempotency-key']); if (!unavailable) { unavailable = true; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成暫時失敗，請保留輸入重試' } }) }); } await route.continue(); });
  const priorCancelToasts = await page.locator('.toast-success').filter({ hasText: '已取消 2 筆班次。' }).count();
  await commitButton(page).click(); await dialogOf(page).locator('.form-summary:not([hidden])').waitFor();
  assert.equal(await dialogOf(page).getByLabel('本次批次操作原因', { exact: false }).inputValue(), opened.definition.reason); assert.equal(await dialogOf(page).getByRole('checkbox', { checked: true }).count(), 2); assert.deepEqual(counts(), before); await capture(page, 'desktop-retry-preserves-draft');
  saved = await commit(); assert.equal(retryKeys.length, 2); assert.ok(retryKeys[0]); assert.equal(retryKeys[0], retryKeys[1]); await page.unroute(commitPattern);
  mark('503失敗保留選取與原因且零寫入；原payload重試使用同一冪等key成功');

  stage = 'malformed ACK recovery'; recovery.shifts = saved.items; opened = await open(recovery, 'cancel'); prepared = await preview(); before = counts(); const ackKeys = []; let malformed = false;
  await page.route(commitPattern, async route => { ackKeys.push(route.request().headers()['idempotency-key']); const actual = await route.fetch(); if (!malformed) { malformed = true; const body = await actual.json(); body.items[1].note = '合成錯誤ACK'; return route.fulfill({ response: actual, json: body }); } await route.fulfill({ response: actual }); });
  await commitButton(page).click(); await dialogOf(page).locator('.form-summary:not([hidden])').waitFor();
  assert.equal(await dialogOf(page).getByLabel('本次批次操作原因', { exact: false }).inputValue(), opened.definition.reason);
  const once = counts(); assert.equal(once.versions, before.versions + 2); assert.equal(once.audit, before.audit + 2); assert.equal(once.idempotency, before.idempotency + 1); assert.ok(await page.locator('.toast-success').filter({ hasText: '已取消 2 筆班次。' }).count() <= priorCancelToasts);
  saved = await commit(); assert.equal(ackKeys[0], ackKeys[1]); assert.deepEqual(counts(), once); assert.equal(saved.items[1].note, recovery.shifts[1].note); await page.unroute(commitPattern);
  mark('已寫入但ACK非操作欄位錯誤時保留表單、不宣告成功；同key重試驗證快照，沒有重複版本');

  stage = 'commit version race'; await open(race, 'cancel'); prepared = await preview();
  await request('PATCH', 'shifts/' + race.shifts[1].id, { version: race.shifts[1].version, note: '合成預覽後修改' }); before = counts();
  const conflict = page.waitForResponse(response => response.url().endsWith('/api/shift-batches/commit')); await commitButton(page).click(); assert.equal((await conflict).status(), 409);
  await dialogOf(page).getByText('班次版次已更新，請重新讀取', { exact: true }).waitFor(); assert.equal(await commitButton(page).isEnabled(), false); assert.deepEqual(counts(), before); assert.equal(await dialogOf(page).getByRole('checkbox', { checked: true }).count(), 2); await closeDirty(page);
  mark('預覽後版次變動時409整批零寫入，保留選取與衝突內容，必須重讀再預覽');

  stage = 'dirty escape'; opened = await open(mobile); before = counts(); await page.keyboard.press('Escape');
  const dirty = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }); await dirty.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await dialogOf(page).getByRole('checkbox', { checked: true }).count(), 2); await closeDirty(page); assert.deepEqual(counts(), before); assert.ok(await opened.trigger.evaluate(node => node === document.activeElement));
  mark('Escape先詢問放棄，取消保留選取；確認放棄零寫入並回復入口焦點');

  stage = 'route context'; await open(mobile); before = counts(); const arrived = deferred(), release = deferred(), handled = deferred();
  await page.route(previewPattern, async route => { try { const actual = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response: actual }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { handled.resolve(); } });
  await previewButton(page).click(); await arrived.promise; await page.evaluate(() => { location.hash = '/cases'; }); await page.getByRole('heading', { name: '個案', level: 1, exact: true }).waitFor();
  release.resolve(); await handled.promise; await settle(page); assert.equal(await dialogOf(page).count(), 0); assert.equal(await page.getByRole('heading', { name: '整批調整預覽', exact: true }).count(), 0); assert.deepEqual(counts(), before); await page.unroute(previewPattern);
  mark('切換路由使慢預覽context失效；晚回應不復活表單、不提交且零寫入');

  stage = 'mobile'; await page.setViewportSize({ width: 390, height: 844 }); await open(mobile); await capture(page, 'mobile-form'); before = counts(); prepared = await preview(); assert.equal(prepared.canCommit, true); await capture(page, 'mobile-preview'); assert.deepEqual(counts(), before); await closeDirty(page);
  mark('390px手機原生選取與預覽無全頁／dialog橫向溢出、欄位有標籤，表格在自身範圍捲動');

  stage = 'roles';
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const client = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(client);
    const login = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'batch-browser-' + role + '@example.test', password } }); assert.equal(login.status(), 200); const auth = await login.json(), actorPage = await client.newPage(); observe(actorPage);
    if (role === 'supervisor') { await open(mobile, 'cancel', actorPage); before = counts(); await preview(actorPage); assert.deepEqual(counts(), before); saved = await commit(actorPage); const history = await request('GET', 'shifts/' + saved.items[0].id + '/history?compare=previous'); assert.equal(history.items[0].actor.id, auth.user.id); }
    else { before = counts(); for (const operation of ['preview', 'commit']) await request('POST', 'shift-batches/' + operation, [], 403, client, auth, { 'Idempotency-Key': 'synthetic-denied-' + role + operation }); await actorPage.goto(base + '/#/shifts'); await actorPage.waitForLoadState('networkidle'); assert.equal(await actorPage.getByRole('button', { name: '批次改派／取消', exact: true }).count(), 0); assert.deepEqual(counts(), before); }
  }
  mark('督導真手機UI可批次保存並記錄實際actor；居服員／財務無入口且兩API先403、零寫入');
  assert.deepEqual(app.db.prepare("SELECT * FROM records WHERE entity!='shifts' ORDER BY rowid").all(), untouched);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /409|503/.test(message)), JSON.stringify(consoleErrors));
  mark('未操作主檔原資料保持，0 pageerror，瀏覽器僅有預期503及409');
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'synthetic only / memory SQLite / random loopback / real Chromium', checks, screenshots, pageErrors, consoleErrors, failedResponses, submissions, finalCounts: counts() }, null, 2));
  console.log(`Shift batch E2E passed: ${checks.length} checks, ${screenshots.length} screenshots\nEvidence: ${output}`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), stage, checks, screenshots, pageErrors, consoleErrors, failedResponses, error: error.stack }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
