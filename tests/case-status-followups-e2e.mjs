import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';

// This suite owns a fresh memory database. Never boot the application's default disk database.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, 'outputs/software/case-status-followups-qa');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const installed = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(file => file && existsSync(file));
const app = createApp({ dbPath: ':memory:', port: 0 });
const entity = 'case-status-followups', password = 'synthetic-followup-browser-password';
const businessKeys = ['caseId', 'kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status'];
const checks = [], readSegments = [], screenshots = [], confirmations = [], contextChecks = [], payloadChecks = [], pageErrors = [], consoleErrors = [], consoleEvents = [], failedResponses = [], contexts = [];
let controlledContext404Window = null;
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
let browser, base, lastPage, stage = 'initialization';
const same = (a, b, label) => assert.deepEqual(a, b, label);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const counts = () => ({
  totalChanges: app.db.prepare('SELECT total_changes() n').get().n,
  records: app.db.prepare('SELECT count(*) n FROM records').get().n,
  versions: app.db.prepare('SELECT count(*) n FROM record_versions').get().n,
  audit: app.db.prepare('SELECT count(*) n FROM audit').get().n,
  idempotency: app.db.prepare('SELECT count(*) n FROM idempotency').get().n,
});
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(tables.length, 11, 'Fixed original eleven-table synthetic schema');
  return { schema, tables: Object.fromEntries(tables.map(name => [name, app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])) };
};
const readOnly = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts();
  await action();
  same(raw(), before, label + ': all eleven tables and schema exact');
  same(counts(), beforeCounts, label + ': total_changes and ledger counts exact');
  readSegments.push({ label, tableCount: 11, schemaSha256: sha(before.schema), beforeSha256: sha(before), afterSha256: sha(raw()), beforeCounts, afterCounts: counts(), unchanged: true });
};
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const location = message.location();
    consoleErrors.push(message.text());
    consoleEvents.push({ text: message.text(), location: { url: location.url, lineNumber: location.lineNumber, columnNumber: location.columnNumber }, phase: stage,
      ...(controlledContext404Window?.page === page && controlledContext404Window.phase === stage
        && location.url === controlledContext404Window.url && /status of 404/.test(message.text())
        ? { controlledContextMarker: controlledContext404Window.marker } : {}),
    });
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    const scopedContextFailure = response.status() === 404 && response.request().method() === 'GET'
      && controlledContext404Window?.page === page && controlledContext404Window.phase === stage
      && response.url() === controlledContext404Window.url && response.request().headers()['x-org-id'] === controlledContext404Window.orgId;
    failedResponses.push({ path: pathname.replace(/[a-f0-9-]{36}/g, ':id'), status: response.status(),
      expected: scopedContextFailure || response.url().includes('/api/' + entity) && [403, 404, 409, 422, 503].includes(response.status()),
      ...(scopedContextFailure ? { controlledContextFailure: 'G11 org switch: exact own case URL with foreign organization header',
        controlledContextMarker: controlledContext404Window.marker, phase: stage, url: response.url(), organizationHeader: response.request().headers()['x-org-id'] } : {}),
    });
  });
};
const panel = page => page.getByRole('region', { name: '暫停與結案追蹤', exact: true });
const card = (page, item) => panel(page).locator('[data-followup-id="' + item.id + '"]');
const field = (dialog, key) => dialog.locator('[name="' + key + '"]');
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  const unlabelled = await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name));
  same(unlabelled, [], 'Every visible control has a semantic label');
  const dialogs = await page.getByRole('dialog').all();
  for (const dialog of dialogs) {
    assert(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog stays inside viewport');
    for (const region of await dialog.locator('.table-scroll').all()) if (await region.isVisible()) assert.equal(await region.evaluate(node => getComputedStyle(node).overflowX), 'auto');
  }
};
const shot = async (page, name) => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false });
  screenshots.push({ name, sha256: sha(await readFile(path.join(output, name))), viewport: page.viewportSize(), actuallyViewed: false });
};
const close = async (page, trigger) => {
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  if (trigger) assert(await trigger.evaluate(node => node === document.activeElement), 'Escape restores trigger focus');
};
const discard = async page => {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).getByRole('button', { name: '放棄修改', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
};
const fill = async (dialog, values) => {
  for (const [key, value] of Object.entries(values)) {
    if (['kind', 'status'].includes(key)) await field(dialog, key).selectOption(value);
    else await field(dialog, key).fill(value);
  }
};
const load = async (page, item) => {
  lastPage = page; const target = base + '/#/cases/' + item.id;
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: item.name, level: 1, exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
};
const search = async (page, q) => { const input = panel(page).getByLabel('追蹤紀錄搜尋', { exact: true }); await input.fill(q); await input.press('Enter'); };
const openCreate = async page => {
  await panel(page).getByRole('button', { name: '新增追蹤紀錄', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增追蹤紀錄', exact: true });
  await field(dialog, 'reason').waitFor(); return dialog;
};
const edit = async (page, item) => {
  await search(page, item.reason.slice(0, 200)); await card(page, item).waitFor();
  await card(page, item).getByRole('button', { name: '編輯', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '編輯追蹤紀錄', exact: true });
  await field(dialog, 'reason').waitFor(); return dialog;
};
const commit = async (page, dialog, method = 'POST', item) => {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/' + entity + (item ? '/' + item.id : '') && response.request().method() === method);
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  const received = await response;
  assert.equal(received.status(), method === 'POST' ? 201 : 200, await received.text());
  const payload = received.request().postDataJSON(); payloadChecks.push({ method, keys: Object.keys(payload).sort(), payloadSha256: sha(payload) });
  await dialog.waitFor({ state: 'detached' }); return { payload, item: (await received.json()).item };
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), 15000); timer.unref(); })]);
const held = async (page, pattern, predicate) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false;
  const handler = async route => {
    if (used || !predicate(route.request())) return route.continue(); used = true;
    try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { handled.resolve(); }
  };
  await page.route(pattern, handler); let done = false;
  return { arrived: arrived.promise, async finish() { if (done) return; done = true; release.resolve(); if (used) await bounded(handled.promise, 'held response'); await page.unroute(pattern, handler); } };
};
const mutateContext = async (page, kind, foreignOrg) => page.evaluate(async ({ kind, foreignOrg }) => {
  const ui = await import('/ui.js'), context = ui.getContext();
  if (kind === 'hash') { location.hash = '/employees'; return; }
  if (kind === 'render') { document.querySelector('[data-render-version]').dataset.renderVersion = crypto.randomUUID(); return; }
  const session = { ...context, user: { ...context.user }, organizations: context.organizations.map(org => ({ ...org })) };
  if (kind === 'user') session.user.id = 'synthetic-replaced-user';
  if (kind === 'role') session.organizations.find(org => org.id === context.organizationId).role = 'finance';
  if (kind === 'employee') session.organizations.find(org => org.id === context.organizationId).employeeId = 'synthetic-replaced-employee';
  if (kind === 'org' && !session.organizations.some(org => org.id === foreignOrg)) session.organizations.push({ id: foreignOrg, name: '合成切換機構', role: 'admin', employeeId: null });
  ui.setContext(session, kind === 'org' ? foreignOrg : context.organizationId); window.dispatchEvent(new Event('session-updated'));
}, { kind, foreignOrg });

try {
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(adminContext);
  const setup = await adminContext.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成追蹤管理員', email: 'followup-admin@example.test', password, organizationName: '合成追蹤甲機構' } });
  assert.equal(setup.status(), 201, await setup.text());
  const adminAuth = await setup.json(), orgId = adminAuth.organizations[0].id;
  const adminPage = await adminContext.newPage(); observe(adminPage);
  const actors = { admin: { client: adminContext, auth: adminAuth, page: adminPage } };
  const request = async (method, route, data, expected = 200, actor = actors.admin, selectedOrg = orgId, headers = {}) => {
    const response = await actor.client.request.fetch(base + '/api/' + route, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': actor.auth.csrfToken, ...headers }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, method + ' ' + route + ': ' + JSON.stringify(body)); return body;
  };
  const post = async (kind, data, selectedOrg = orgId) => (await request('POST', kind, data, 201, actors.admin, selectedOrg)).item;
  const patch = async (kind, item, data, actor = actors.admin) => (await request('PATCH', kind + '/' + item.id, { version: item.version, ...data }, 200, actor)).item;
  const get = async (kind, item, actor = actors.admin) => (await request('GET', kind + '/' + item.id, undefined, 200, actor)).item;
  const employee = await post('employees', { name: '合成追蹤居服員', employeeNo: 'FOLLOW-E01', role: 'caregiver', hourlyRateCents: 23456 });
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    await post('users', { name: '合成追蹤' + role, email: 'followup-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(client);
    const response = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'followup-' + role + '@example.test', password } }); assert.equal(response.status(), 200);
    const page = await client.newPage(); observe(page); actors[role] = { client, auth: await response.json(), page };
  }
  const caseA = await post('cases', { name: '合成追蹤個案甲', caseNo: 'FOLLOW-C01', primaryCarer: '合成原照顧者', contactName: '合成原聯絡人', status: 'active' });
  const caseB = await post('cases', { name: '合成追蹤個案乙', caseNo: 'FOLLOW-C02', status: 'closed' });
  const otherOrg = await post('organizations', { name: '合成追蹤乙機構' });
  const foreignCase = await post('cases', { name: '合成追蹤外機構個案', caseNo: 'FOLLOW-FOREIGN' }, otherOrg.id);
  const service = await post('service-items', { code: 'FOLLOW-TEST', name: '合成核閱服務', minutes: 60, unitPriceCents: 12345 });
  const plan = await post('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 8 }] });
  const shift = await post('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 2 }] });
  let record = await post('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:55', services: [{ serviceItemId: service.id, quantity: 2 }], status: 'submitted' });
  record = (await request('POST', 'service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成核閱快照基準' })).item;
  const parentIds = [caseA.id, caseB.id, foreignCase.id, employee.id, service.id, plan.id, shift.id, record.id];
  const parentState = () => ({ records: app.db.prepare('SELECT * FROM records ORDER BY rowid').all().filter(row => parentIds.includes(row.id)), versions: app.db.prepare('SELECT * FROM record_versions ORDER BY rowid').all().filter(row => parentIds.includes(row.record_id)) });
  const protectedBefore = parentState();
  assert(record.billingSnapshot, 'Approved service includes saved price/payroll snapshot');
  const foreign = await post(entity, { caseId: foreignCase.id, kind: 'closure', startDate: '2026-10-01', reason: '合成外機構不可見原因' }, otherOrg.id);
  const other = await post(entity, { caseId: caseB.id, kind: 'pause', startDate: '2026-10-01', reason: '合成乙案專屬追蹤' });
  const page = adminPage, supervisor = actors.supervisor.page;
  await load(page, caseA);
  await panel(page).getByText('共 0 筆', { exact: false }).waitFor();
  await readOnly('G1 empty and pristine Escape', async () => {
    const trigger = panel(page).getByRole('button', { name: '新增追蹤紀錄', exact: true });
    await openCreate(page); await close(page, trigger); await panel(page).scrollIntoViewIfNeeded(); await shot(page, 'empty-panel-desktop.png');
  });
  stage = 'G1 real nine-field create';
  let d = await openCreate(page);
  assert.equal(await field(d, 'caseId').count(), 0, 'Current case cannot be selected or moved');
  assert.equal(await d.locator('input,select,textarea').count(), 8);
  await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.locator('[aria-invalid="true"]').first().waitFor();
  const values = { kind: 'pause', startDate: '2026-10-01', endDate: '2026-10-31', reason: '  合成核心追蹤原因  ', followUpDate: '2026-11-02', outcome: '  合成人工追蹤結果  ', note: '  合成第一版備註  ', status: 'pending' };
  await fill(d, values); await shot(page, 'create-nine-fields-desktop.png');
  const created = await commit(page, d); let main = created.item;
  same(created.payload, { caseId: caseA.id, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])) });
  same(Object.keys(created.payload).sort(), businessKeys.slice().sort()); assert.equal(main.version, 1);
  same(parentState(), protectedBefore, 'Creating manual followup preserves all parent/shift/snapshot rows and histories');
  mark('G1 空清單／未改Escape焦點／必填阻擋／admin真UI九欄trim保存且不改個案班次快照');

  stage = 'G2 supervisor edit and exact history';
  await load(supervisor, caseA); d = await edit(supervisor, main);
  await fill(d, { kind: 'closure', status: 'completed', outcome: '合成第二版結果', note: '合成第二版備註' });
  const edited = await commit(supervisor, d, 'PATCH', main);
  same(edited.payload, { version: main.version, kind: 'closure', status: 'completed', outcome: '合成第二版結果', note: '合成第二版備註' });
  main = edited.item; assert.equal(main.version, 2);
  await readOnly('G2 exact saved previous history actor and mobile scroll', async () => {
    const history = await request('GET', entity + '/' + main.id + '/history?compare=previous');
    assert.equal(history.total, 2); same(history.items.map(item => item.actor.id), [actors.supervisor.auth.user.id, adminAuth.user.id]);
    same(history.items[0].snapshot, main); same(history.items[0].comparison.previousSnapshot, created.item);
    const trigger = card(supervisor, main).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click();
    d = supervisor.getByRole('dialog', { name: '暫停與結案追蹤版本歷程', exact: true }); await d.getByText('第 2 版', { exact: true }).waitFor();
    assert.equal(await d.getByRole('button', { name: /儲存|編輯|刪除|還原/ }).count(), 0);
    const version = d.locator('.history-version').filter({ has: supervisor.getByText('第 2 版', { exact: true }) });
    const differences = version.getByRole('region', { name: '變更前後', exact: true });
    await differences.getByText('合成第二版結果', { exact: true }).waitFor(); await version.getByText('合成追蹤supervisor', { exact: true }).waitFor();
    await shot(supervisor, 'history-differences-desktop.png');
    await supervisor.setViewportSize({ width: 390, height: 844 });
    const region = differences.locator('.table-scroll'); await region.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    assert(await region.evaluate(node => node.scrollLeft > 0), '390px previous comparison scrolls internally');
    await shot(supervisor, 'history-differences-mobile.png'); await close(supervisor, trigger);
    await supervisor.setViewportSize({ width: 1440, height: 1050 });
  });
  same(parentState(), protectedBefore); mark('G2 督導只送四項變更與version／精確前版actor／唯讀桌機手機歷程與內捲');

  stage = 'G3 actual CAS conflict';
  await load(page, caseA); d = await edit(page, main); await field(d, 'note').fill('合成本機未保存備註');
  main = await patch(entity, main, { note: '合成另一位督導已保存備註' }, actors.supervisor);
  await readOnly('G3 real CAS409 and dirty preservation', async () => {
    const response = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/' + entity + '/' + main.id);
    await d.getByRole('button', { name: '儲存', exact: true }).click(); assert.equal((await response).status(), 409);
    await d.getByRole('alert').filter({ visible: true }).waitFor(); assert.equal(await field(d, 'note').inputValue(), '合成本機未保存備註');
    await page.keyboard.press('Escape'); const guard = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true });
    await guard.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await field(d, 'note').inputValue(), '合成本機未保存備註');
    await shot(page, 'real-conflict-retained-desktop.png'); await discard(page);
  });
  await load(page, caseA); d = await edit(page, main); await field(d, 'outcome').fill('合成離線未保存結果');
  await readOnly('G3 offline abort and manual retry error', async () => {
    const pattern = '**/api/' + entity + '/' + main.id;
    const abort = async route => route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue();
    await page.route(pattern, abort); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.locator('[role="alert"]:visible').waitFor();
    assert.equal(await field(d, 'outcome').inputValue(), '合成離線未保存結果'); await page.unroute(pattern, abort);
    const fail = async route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { error: { message: '合成離線重試仍不可用' } } }) : route.continue();
    await page.route(pattern, fail); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.getByText('合成離線重試仍不可用', { exact: true }).waitFor();
    assert.equal(await field(d, 'outcome').inputValue(), '合成離線未保存結果'); await page.unroute(pattern, fail); await discard(page);
  });
  mark('G3 真409零覆寫／dirty取消保留／離線中斷與503重試保留輸入');

  stage = 'G4 real busy submit';
  await load(page, caseA); d = await openCreate(page); await fill(d, { kind: 'pause', startDate: '2026-10-02', reason: '合成忙碌提交追蹤' });
  const holdBusy = await held(page, '**/api/' + entity, req => req.method() === 'POST'); let posts = 0;
  const countPost = req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/' + entity) posts++; }; page.on('request', countPost);
  let busyItem;
  try {
    const save = await d.getByRole('button', { name: '儲存', exact: true }).elementHandle(), geometry = await save.boundingBox();
    const cancel = await d.getByRole('button', { name: '取消', exact: true }).elementHandle();
    await save.click(); await bounded(holdBusy.arrived, 'busy server committed');
    assert(await save.isDisabled()); assert.equal(await save.getAttribute('aria-busy'), 'true');
    assert(await d.locator('input,select,textarea').evaluateAll(nodes => nodes.every(node => node.disabled)));
    same(await save.boundingBox(), geometry, 'Busy actions do not move');
    await cancel.click(); assert(await d.isVisible(), 'Pending cancel remains inert');
    await save.evaluate(node => { node.click(); node.click(); }); await page.keyboard.press('Escape'); assert(await d.isVisible()); assert.equal(posts, 1);
    await shot(page, 'busy-single-submit-desktop.png'); await holdBusy.finish(); await d.waitFor({ state: 'detached' });
    busyItem = (await request('GET', entity + '?caseId=' + caseA.id + '&q=' + encodeURIComponent('合成忙碌提交追蹤'))).items[0]; assert(busyItem);
  } finally { await holdBusy.finish(); page.off('request', countPost); }
  mark('G4 真已提交延遲回應／八欄鎖定且取消無作用／Escape防重／按鍵幾何不變／單次新增');

  stage = 'G4 explicit cancellation and restoration';
  await search(page, busyItem.reason); await card(page, busyItem).waitFor();
  await readOnly('G4 confirmation cancel is zero write and restores focus', async () => {
    const trigger = card(page, busyItem).getByRole('button', { name: '取消追蹤', exact: true }); await trigger.click();
    d = page.getByRole('dialog', { name: '取消這筆追蹤？', exact: true });
    assert(await d.getByRole('button', { name: '取消', exact: true }).evaluate(node => node === document.activeElement));
    await close(page, trigger);
  });
  for (const [label, title, confirm, status] of [
    ['取消追蹤', '取消這筆追蹤？', '確認取消追蹤', 'cancelled'],
    ['恢復追蹤', '恢復這筆追蹤？', '確認恢復追蹤', 'pending'],
  ]) {
    await card(page, busyItem).getByRole('button', { name: label, exact: true }).click();
    d = page.getByRole('dialog', { name: title, exact: true });
    const received = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/' + entity + '/' + busyItem.id);
    await d.getByRole('button', { name: confirm, exact: true }).click(); const response = await received; assert.equal(response.status(), 200); await d.waitFor({ state: 'detached' });
    same(response.request().postDataJSON(), { version: busyItem.version, status }); const saved = (await response.json()).item;
    for (const key of businessKeys.filter(key => key !== 'status')) same(saved[key], busyItem[key], 'Confirmation only changes manual followup status');
    busyItem = saved;
    if (status === 'cancelled') await readOnly('G4 cancelled editor cannot silently reopen', async () => {
      const editor = await edit(page, busyItem); assert(await field(editor, 'status').isDisabled());
      assert.equal(await field(editor, 'status').inputValue(), 'cancelled'); await close(page);
    });
  }
  assert.equal(busyItem.version, 3); same(parentState(), protectedBefore);
  mark('G4b 取消與恢復各自明確確認／取消確認零寫與焦點／status加version及其餘八欄原樣');

  stage = 'G5 synthetic 29 records';
  for (let i = 1; i <= 27; i++) await post(entity, { caseId: caseA.id, kind: i % 2 ? 'closure' : 'pause', startDate: '2026-10-01', reason: '合成批次追蹤' + String(i).padStart(2, '0'), status: i === 27 ? 'cancelled' : 'pending' });
  const all = (await request('GET', entity + '?caseId=' + caseA.id + '&pageSize=100')).items; assert.equal(all.length, 29);
  await readOnly('G5 server pagination filters clear empty and URL privacy', async () => {
    await load(page, caseA); await panel(page).getByText('共 29 筆 · 第 1 / 2 頁', { exact: true }).waitFor();
    assert.equal(await panel(page).locator('[data-followup-id]').count(), 25); await panel(page).getByRole('button', { name: '下一頁', exact: true }).click();
    await panel(page).getByText('共 29 筆 · 第 2 / 2 頁', { exact: true }).waitFor(); assert.equal(await panel(page).locator('[data-followup-id]').count(), 4);
    for (const kind of ['pause', 'closure']) {
      await panel(page).getByLabel('追蹤類型篩選', { exact: true }).selectOption(kind);
      await panel(page).getByText('共 ' + all.filter(item => item.kind === kind).length + ' 筆', { exact: false }).waitFor();
      assert.equal(await panel(page).locator('[data-followup-id]').count(), all.filter(item => item.kind === kind).length);
    }
    await panel(page).getByLabel('追蹤類型篩選', { exact: true }).selectOption('');
    for (const status of ['pending', 'completed', 'cancelled']) {
      const matching = all.filter(item => item.status === status).length;
      await panel(page).getByLabel('追蹤狀態篩選', { exact: true }).selectOption(status);
      await panel(page).getByText('共 ' + matching + ' 筆', { exact: false }).waitFor();
      assert.equal(await panel(page).locator('[data-followup-id]').count(), Math.min(25, matching));
    }
    await panel(page).getByLabel('追蹤狀態篩選', { exact: true }).selectOption('');
    await search(page, '合成不存在追蹤'); await panel(page).getByText('共 0 筆', { exact: false }).waitFor();
    assert(!page.url().includes(encodeURIComponent('合成不存在追蹤')));
    assert(await page.evaluate(() => Object.values(localStorage).every(value => !value.includes('合成不存在追蹤'))));
    await panel(page).getByRole('button', { name: '清除追蹤紀錄搜尋', exact: true }).click(); await panel(page).getByText('共 29 筆', { exact: false }).waitFor();
    await panel(page).scrollIntoViewIfNeeded(); await shot(page, 'paginated-panel-desktop.png');
  }); mark('G5 29筆25+4伺服器分頁／兩類型與三狀態／搜尋清除空結果不寫URLstorage');

  await readOnly('G6 four roles and current-case/org authorization', async () => {
    for (const role of ['admin', 'supervisor', 'caregiver', 'finance']) {
      const actor = actors[role]; await load(actor.page, caseA); await search(actor.page, main.reason); await card(actor.page, main).waitFor();
      await layout(actor.page);
      assert.equal(await panel(actor.page).getByRole('button', { name: '新增追蹤紀錄', exact: true }).count(), ['admin', 'supervisor'].includes(role) ? 1 : 0);
      assert.equal(await card(actor.page, main).getByRole('button', { name: '編輯', exact: true }).count(), ['admin', 'supervisor'].includes(role) ? 1 : 0);
      const trigger = card(actor.page, main).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click();
      await actor.page.getByRole('dialog').getByText('第 3 版', { exact: true }).waitFor(); await close(actor.page, trigger);
      await request('GET', entity + '/' + foreign.id, undefined, 404, actor);
      await request('GET', entity + '/' + foreign.id + '/history?compare=previous', undefined, 404, actor);
      if (['caregiver', 'finance'].includes(role)) {
        await request('POST', entity, { caseId: caseA.id, kind: 'pause', startDate: '2026-10-01', reason: '合成禁止寫入' }, 403, actor);
        await request('PATCH', entity + '/' + main.id, { version: main.version, note: '合成禁止覆寫' }, 403, actor);
      }
    }
    assert.equal((await request('GET', entity + '?caseId=' + caseB.id, undefined, 200, actors.caregiver)).total, 0);
    await request('GET', entity + '/' + other.id + '/history?compare=previous', undefined, 404, actors.caregiver);
    await load(page, caseB); await card(page, other).waitFor();
    assert.equal(await card(page, main).count(), 0); assert.equal(await panel(page).locator('[data-followup-id]').count(), 1);
  }); mark('G6 四真登入角色／財務居服只讀及伺服器403／居服他案與全角色跨機構404');

  await readOnly('G7 list and history failures retry independently', async () => {
    const listPattern = '**/api/' + entity + '?*'; let attempts = 0;
    const failList = async route => {
      if (new URL(route.request().url()).searchParams.get('caseId') !== caseA.id) return route.continue();
      if (++attempts === 1) return route.fulfill({ status: 503, json: { error: { message: '合成追蹤清單首次不可用' } } }); return route.continue();
    };
    await page.route(listPattern, failList); await load(page, caseA);
    await panel(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor();
    await page.getByText('合成原照顧者', { exact: true }).waitFor(); await page.getByRole('heading', { name: '生效中的照顧計畫', exact: true }).waitFor();
    await panel(page).scrollIntoViewIfNeeded(); await shot(page, 'list-error-island-desktop.png');
    await panel(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await panel(page).getByText('共 29 筆', { exact: false }).waitFor();
    assert.equal(attempts, 2); await page.unroute(listPattern, failList);
    for (const corruptBody of [
      body => ({ ...body, items: body.items.slice(1) }),
      body => ({ ...body, items: body.items.map((item, i) => i === 1 ? body.items[0] : item) }),
      body => ({ ...body, items: body.items.map((item, i) => i ? item : { ...item, caseId: caseB.id, reason: 'SYNTHETIC_DTO_NEVER_RENDER' }) }),
      body => ({ ...body, items: body.items.map((item, i) => i ? item : { ...item, orgId: otherOrg.id, reason: 'SYNTHETIC_DTO_NEVER_RENDER' }) }),
    ]) {
      const malformed = async route => {
        const response = await route.fetch(), body = await response.json(); await route.fulfill({ response, json: corruptBody(body) });
      };
      await page.route(listPattern, malformed); await panel(page).getByRole('button', { name: '重新讀取追蹤紀錄', exact: true }).click();
      await panel(page).getByText('追蹤紀錄回應無法確認，請重新讀取。', { exact: true }).waitFor();
      assert.equal(await panel(page).locator('[data-followup-id]').count(), 0); assert(!/SYNTHETIC_DTO_NEVER_RENDER/.test(await panel(page).innerHTML()));
      await page.getByText('合成原照顧者', { exact: true }).waitFor(); await page.unroute(listPattern, malformed);
      await panel(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await panel(page).getByText('共 29 筆', { exact: false }).waitFor();
    }
    await search(page, main.reason); await card(page, main).waitFor();
    const historyPattern = '**/api/' + entity + '/' + main.id + '/history?*'; let historyAttempts = 0;
    const failHistory = async route => ++historyAttempts === 1 ? route.fulfill({ status: 503, json: { error: { message: '合成追蹤歷程首次不可用' } } }) : route.continue();
    await page.route(historyPattern, failHistory); const trigger = card(page, main).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click();
    d = page.getByRole('dialog'); await d.getByRole('button', { name: '重新讀取', exact: true }).click(); await d.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(historyAttempts, 2);
    await close(page, trigger); await page.unroute(historyPattern, failHistory);
    const late = await held(page, historyPattern, req => req.method() === 'GET');
    try { await trigger.click(); await bounded(late.arrived, 'history arrived'); await close(page, trigger); await late.finish(); await settle(page); assert.equal(await page.getByRole('dialog').count(), 0); }
    finally { await late.finish(); }
  }); mark('G7 清單503不阻断親案計畫／歷程503重試／關閉延遲歷程不復活且零寫');

  await readOnly('G8 stale searches and different case route do not overwrite', async () => {
    await load(page, caseA); const pattern = '**/api/' + entity + '?*';
    let late = await held(page, pattern, req => new URL(req.url()).searchParams.get('q') === '合成批次追蹤01');
    try {
      await search(page, '合成批次追蹤01'); await bounded(late.arrived, 'first search held');
      await search(page, main.reason); await card(page, main).waitFor(); await late.finish(); await settle(page);
      assert.equal(await panel(page).locator('[data-followup-id]').count(), 1); await card(page, main).waitFor();
    } finally { await late.finish(); }
    late = await held(page, pattern, req => new URL(req.url()).searchParams.get('caseId') === caseA.id);
    try {
      await panel(page).getByRole('button', { name: '重新讀取追蹤紀錄', exact: true }).click(); await bounded(late.arrived, 'old case read held');
      await page.evaluate(caseId => { location.hash = '/cases/' + caseId; }, caseB.id);
      await page.getByRole('heading', { name: caseB.name, level: 1, exact: true }).waitFor(); await card(page, other).waitFor();
      await late.finish(); await settle(page); assert.equal(await card(page, main).count(), 0); assert.equal(await panel(page).locator('[data-followup-id]').count(), 1);
    } finally { await late.finish(); }
  }); mark('G8 真API晚搜尋只留最新條件／切換個案舊回應不串案／所有表零寫');

  stage = 'G9 real commit with malformed acknowledgement and idempotent retry';
  await load(page, caseA); d = await openCreate(page);
  const retryValues = { kind: 'closure', startDate: '2026-10-03', reason: '合成未知回應同鍵追蹤', endDate: '', followUpDate: '', outcome: '', note: '合成未知回應保留', status: 'pending' };
  await fill(d, retryValues); const keys = [], payloads = [];
  const variants = [
    ['empty-envelope', () => ({})], ['null', () => null], ['array', () => []],
    ['empty-id', body => ({ item: { ...body.item, id: '' } })], ['wrong-org', body => ({ item: { ...body.item, orgId: otherOrg.id } })],
    ['wrong-version', body => ({ item: { ...body.item, version: 2 } })],
    ...businessKeys.map(key => ['wrong-' + key, body => ({ item: { ...body.item, [key]: key === 'caseId' ? caseB.id : 'synthetic-drift' } })]),
    ['missing-note', body => { const item = { ...body.item }; delete item.note; return { item }; }],
  ];
  let variantIndex = 0, committedRaw, committedCounts;
  const corrupt = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']); payloads.push(sha(route.request().postData()));
    const response = await route.fetch(); assert.equal(response.status(), 201); const body = await response.json();
    const replacement = variantIndex < variants.length ? variants[variantIndex++][1](body) : body;
    await route.fulfill({ response, body: JSON.stringify(replacement) });
  };
  await page.route('**/api/' + entity, corrupt);
  try {
    for (const [label] of variants) {
      await d.getByRole('button', { name: '儲存', exact: true }).click();
      await d.getByText('儲存結果未確認；請保留輸入並重新讀取確認。', { exact: true }).waitFor();
      assert.equal(await field(d, 'reason').inputValue(), retryValues.reason); assert.equal(await field(d, 'note').inputValue(), retryValues.note);
      assert.equal(await page.locator('.toast.toast-success').count(), 0); assert(await d.isVisible());
      if (!committedRaw) { committedRaw = raw(); committedCounts = counts(); }
      else { same(raw(), committedRaw, 'Same-key malformed acknowledgement retry no additional write'); same(counts(), committedCounts); }
      confirmations.push({ label, realServerCommit: true, inputPreserved: true, falseSuccess: false });
    }
    await shot(page, 'unknown-acknowledgement-retained-desktop.png');
    await readOnly('G9 final identical-key valid acknowledgement confirms existing create', async () => {
      await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.waitFor({ state: 'detached' });
    });
    assert.equal(new Set(keys).size, 1); assert(keys[0]); assert.equal(new Set(payloads).size, 1);
    assert.equal((await request('GET', entity + '?caseId=' + caseA.id + '&q=' + encodeURIComponent(retryValues.reason))).total, 1);
  } finally { await page.unroute('**/api/' + entity, corrupt); }
  mark('G9 十六種未知2xx確認拒絕／真POST同payload同key重試只寫一次／有效回應才關窗');

  stage = 'G10 preserved non-roundtrip legal note and explicit clear';
  const originalNote = '合成CR\r\n換行保存備註';
  let legal = await post(entity, { caseId: caseA.id, kind: 'pause', startDate: '0000-02-29', reason: '合成原值無損追蹤', note: originalNote });
  await load(page, caseA); d = await edit(page, legal);
  assert.equal(await field(d, 'noteIntent').inputValue(), 'keep'); assert(await field(d, 'note').isDisabled());
  assert.equal(await field(d, 'startDateIntent').inputValue(), 'keep'); assert(await field(d, 'startDate').isDisabled());
  await field(d, 'outcome').fill('合成只改結果');
  let changed = await commit(page, d, 'PATCH', legal); same(changed.payload, { version: legal.version, outcome: '合成只改結果' });
  legal = changed.item; assert.equal(legal.note, originalNote); assert.equal(legal.startDate, '0000-02-29');
  d = await edit(page, legal); await field(d, 'noteIntent').selectOption('clear');
  changed = await commit(page, d, 'PATCH', legal); same(changed.payload, { version: legal.version, note: '' }); legal = changed.item; assert.equal(legal.note, '');
  const time = now(), typedData = { caseId: caseA.id, kind: 'pause', startDate: '2026-10-01', endDate: '', reason: '合成匯入typed追蹤', followUpDate: '', outcome: '', note: { private: 'NEVER_RENDER_FOLLOWUP_OBJECT' }, status: 'pending' };
  const typed = { ...typedData, id: id(), orgId, version: 1, createdAt: time, updatedAt: time };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(typed.id, orgId, entity, JSON.stringify(typedData), 1, time, time);
  app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, typed.id, 1, JSON.stringify(typed), time, 'baseline');
  await load(page, caseA);
  await readOnly('G10 imported typed note hidden and merged-validation error retains intent', async () => {
    d = await edit(page, typed); assert.equal(await field(d, 'noteIntent').inputValue(), 'keep');
    assert(!/NEVER_RENDER_FOLLOWUP_OBJECT/.test(await d.innerHTML())); assert(await field(d, 'note').isDisabled());
    await field(d, 'outcome').fill('合成merged-validation未保存结果'); await d.getByRole('button', { name: '儲存', exact: true }).click();
    await d.locator('[role="alert"]:visible').waitFor(); assert.equal(await field(d, 'noteIntent').inputValue(), 'keep');
    assert.equal(await field(d, 'outcome').inputValue(), '合成merged-validation未保存结果'); await discard(page);
  });
  mark('G10 正常API CRLF及0000日期不改原值／只送結果／明確清空／typed內容隱藏並保留錯誤意圖');

  stage = 'G11 context transition with actual late committed responses';
  for (const kind of ['user', 'org', 'role', 'employee', 'hash', 'render']) {
    stage = 'G11 context transition: ' + kind;
    await load(page, caseA); d = await openCreate(page); await fill(d, { kind: 'pause', startDate: '2026-10-04', reason: '合成晚回應切換-' + kind });
    const late = await held(page, '**/api/' + entity, req => req.method() === 'POST');
    let controlledResponse, controlledConsole, consoleAttribution;
    try {
      await d.getByRole('button', { name: '儲存', exact: true }).click(); await bounded(late.arrived, 'context actual commit ' + kind);
      if (kind === 'org') {
        const url = base + '/api/cases/' + caseA.id;
        controlledContext404Window = { page, url, orgId: otherOrg.id, phase: stage, marker: 'G11-exact-foreign-org-case-read' };
        controlledResponse = page.waitForResponse(response => response.url() === url && response.request().method() === 'GET'
          && response.request().headers()['x-org-id'] === otherOrg.id && response.status() === 404, { timeout: 10000 });
        controlledConsole = page.waitForEvent('console', { predicate: message => message.type() === 'error'
          && message.location().url === url && /status of 404/.test(message.text()), timeout: 10000 });
        // Keep original observer events even if another assertion fails before these barriers.
        controlledResponse.catch(() => {}); controlledConsole.catch(() => {});
      }
      await mutateContext(page, kind, otherOrg.id); await d.waitFor({ state: 'detached' }); await late.finish(); await settle(page);
      if (kind === 'org') {
        const response = await controlledResponse, message = await controlledConsole;
        assert.equal(response.url(), base + '/api/cases/' + caseA.id); assert.equal(response.request().headers()['x-org-id'], otherOrg.id);
        assert.equal(message.location().url, response.url()); assert.equal(stage, 'G11 context transition: org');
        consoleAttribution = { marker: controlledContext404Window.marker, phase: stage, responseUrl: response.url(), organizationHeader: otherOrg.id, consoleLocationUrl: message.location().url };
        controlledContext404Window = null;
      }
      assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await page.locator('.toast.toast-success').count(), 0);
      assert.equal((await request('GET', entity + '?caseId=' + caseA.id + '&q=' + encodeURIComponent('合成晚回應切換-' + kind))).total, 1);
      contextChecks.push({ kind, actualServerCommitted: true, oldDialogDetached: true, lateFalseSuccess: false, ...(consoleAttribution ? { consoleAttribution } : {}) });
    } finally { if (kind === 'org') controlledContext404Window = null; await late.finish(); }
  }
  mark('G11 user/org/role/employee/hash/render六情境取消舊表單／晚真提交不假成功或復活');

  stage = 'G12 long mobile form and sibling history';
  const longReason = '合成長原因文字，保留人工說明且不推定結案；'.repeat(220);
  const long = await post(entity, { caseId: caseA.id, kind: 'closure', startDate: '2026-10-05', reason: longReason, note: '合成手機長備註\n'.repeat(80), outcome: '合成追蹤結果', status: 'pending' });
  await load(page, caseA);
  await readOnly('G12 narrow viewport long reason and shared sibling visuals', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await search(page, '合成長原因文字'); await card(page, long).waitFor();
    await card(page, long).evaluate(node => node.scrollIntoView({ block: 'start' })); await shot(page, 'long-reason-panel-mobile.png');
    d = await edit(page, long); assert.equal(await field(d, 'reason').inputValue(), longReason);
    await field(d, 'reason').evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert(await field(d, 'reason').evaluate(node => node.scrollTop > 0), 'Long mobile reason scrolls inside textarea');
    await field(d, 'reason').scrollIntoViewIfNeeded(); await shot(page, 'long-reason-editor-mobile.png');
    assert(await d.evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto'), 'Mobile dialog has internal vertical scrolling');
    await d.evaluate(node => { node.scrollTop = node.scrollHeight; });
    assert(await d.locator('.dialog-footer').evaluate(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'Mobile actions stay inside viewport');
    await shot(page, 'editor-actions-mobile.png'); await close(page);
    await page.setViewportSize({ width: 1440, height: 1050 }); await search(page, main.reason); await card(page, main).waitFor();
    let trigger = card(page, main).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); await page.getByRole('dialog').getByText('第 3 版', { exact: true }).waitFor();
    await shot(page, 'final-followup-history-desktop.png'); await close(page, trigger);
    trigger = page.getByRole('button', { name: '個案版本歷程', exact: true });
    if (!await trigger.count()) trigger = page.getByRole('button', { name: '版本歷程', exact: true }).first();
    await trigger.click(); await page.getByRole('dialog').getByText('第 1 版', { exact: true }).waitFor(); await shot(page, 'sibling-case-history-desktop.png'); await close(page, trigger);
    same(parentState(), protectedBefore);
  });
  mark('G12 390px長原因textarea與dialog內捲／1440既有個案歷程sibling／親案班次核閱快照始終不變');

  same(parentState(), protectedBefore, 'All original parent rows and histories exact at completion');
  same(pageErrors, [], 'No browser unhandled exceptions');
  same(failedResponses.filter(row => !row.expected), [], 'Only explicitly induced API failure statuses');
  const context404Responses = failedResponses.filter(response => response.controlledContextFailure);
  assert.equal(context404Responses.length, 1, 'Exactly the controlled G11 foreign-org case GET fails404');
  const context404ConsoleEvents = consoleEvents.filter(event => /status of 404/.test(event.text));
  assert.equal(context404ConsoleEvents.length, 1, 'Exactly one console404 has the controlled case resource location');
  const context404Response = context404Responses[0], context404ConsoleEvent = context404ConsoleEvents[0];
  assert.equal(context404Response.url, base + '/api/cases/' + caseA.id); assert.equal(context404Response.organizationHeader, otherOrg.id);
  assert.equal(context404Response.phase, 'G11 context transition: org');
  assert.equal(context404ConsoleEvent.location.url, context404Response.url); assert.equal(context404ConsoleEvent.phase, context404Response.phase);
  assert.equal(context404ConsoleEvent.controlledContextMarker, 'G11-exact-foreign-org-case-read');
  assert.equal(context404ConsoleEvent.controlledContextMarker, context404Response.controlledContextMarker);
  assert(consoleEvents.every(event => /409|503|422|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(event.text)
    || event === context404ConsoleEvent), JSON.stringify(consoleEvents));
  assert(readSegments.every(segment => segment.unchanged && segment.beforeCounts.totalChanges === segment.afterCounts.totalChanges));
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / eleven original tables / random loopback port / synthetic four roles and two organizations / actual Chromium', checks, readSegments, payloadChecks, confirmations, contextChecks, parentRowsAndHistoryUnchanged: true, snapshotUnchanged: true, pageErrors, consoleErrors, consoleEvents, expectedConsoleFailuresOnly: true, failedResponses, screenshots, visualReviewPending: true }, null, 2), { flag: 'wx' });
  console.log('Case status followups E2E passed: ' + checks.length + ' gates / ' + screenshots.length + ' screenshots');
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), stage, checks, readSegments, screenshots, pageErrors, consoleErrors, consoleEvents, failedResponses, error: error.stack }, null, 2), { flag: 'wx' });
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser?.close(); await app.close();
}
