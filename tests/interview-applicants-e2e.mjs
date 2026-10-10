import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';

// Own a memory database, random loopback server and unique evidence directory.
// This suite never starts the default application or opens a real account database.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, 'outputs/software/interview-applicants-qa');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const installed = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
const app = createApp({ dbPath: ':memory:', port: 0 });
const entity = 'interview-applicants', password = 'synthetic-interview-browser-password';
const keys = ['name', 'phone', 'interviewDate', 'city', 'district', 'interviewContent', 'note', 'status'];
const labels = { name: '姓名', phone: '電話', interviewDate: '面試日期', city: '縣市', district: '鄉鎮區', interviewContent: '面試內容', note: '備註', status: '名單狀態' };
const checks = [], readSegments = [], payloadChecks = [], ackChecks = [], contextChecks = [], screenshots = [], consoleErrors = [], pageErrors = [], failedResponses = [], failedRequests = [], expectedFailures = [], contexts = [];
let browser, base, lastPage, stage = 'initialization';
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const same = (a, b, label) => assert.deepEqual(a, b, label);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const expectFailure = rule => { assert(!expectedFailures.some(item => item.id === rule.id)); expectedFailures.push(rule); };
const expectedHttp = (phase, url, method, status) => expectedFailures.find(rule => rule.kind === 'http' && rule.phase === phase && rule.url === url && rule.method === method && rule.status === status);
const expectedAbort = (phase, url, method, failure) => expectedFailures.find(rule => rule.kind === 'requestfailed' && rule.phase === phase && rule.url === url && rule.method === method && rule.failure === failure);
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return { schema, tables: Object.fromEntries(tables.map(name => [name, app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])) };
};
const counts = () => ({ totalChanges: app.db.prepare('SELECT total_changes() n').get().n,
  records: app.db.prepare('SELECT count(*) n FROM records').get().n,
  versions: app.db.prepare('SELECT count(*) n FROM record_versions').get().n,
  audit: app.db.prepare('SELECT count(*) n FROM audit').get().n,
  idempotency: app.db.prepare('SELECT count(*) n FROM idempotency').get().n });
const readOnly = async (label, action) => {
  stage = label; const before = raw(), c = counts(); await action();
  same(raw(), before, label + ': every table/schema exact'); same(counts(), c, label + ': total_changes exact zero');
  readSegments.push({ label, tableCount: 11, triggerCount: 6, beforeSha256: sha(before), afterSha256: sha(raw()), beforeCounts: c, afterCounts: counts(), zeroWrites: true });
};
const protectedState = () => {
  const state = raw(); return { schema: state.schema,
    tables: Object.fromEntries(Object.entries(state.tables).filter(([name]) => !['records', 'record_versions', 'audit', 'idempotency'].includes(name))),
    records: state.tables.records.filter(row => row.entity !== entity),
    versions: state.tables.record_versions.filter(row => row.entity !== entity),
    audit: state.tables.audit.filter(row => row.entity !== entity),
  };
};
const observe = page => {
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => pageErrors.push({ stage, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ stage, text: message.text(), location: message.location() }); });
  page.on('response', response => {
    if (response.status() < 400) return;
    const rule = expectedHttp(stage, response.url(), response.request().method(), response.status());
    failedResponses.push({ stage, url: response.url(), method: response.request().method(), status: response.status(), expectedRuleId: rule?.id || null });
  });
  page.on('requestfailed', request => {
    const failure = request.failure()?.errorText || '', rule = expectedAbort(stage, request.url(), request.method(), failure);
    failedRequests.push({ stage, url: request.url(), method: request.method(), failure, expectedRuleId: rule?.id || null });
  });
};
const field = (dialog, name) => dialog.locator('[name="' + name + '"]');
const listRows = page => page.locator('.list-content tbody tr');
const load = async page => {
  lastPage = page; const target = base + '/#/interviews';
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: '面試者登錄', exact: true, level: 1 }).waitFor(); await page.waitForLoadState('networkidle');
};
const waitList = page => page.locator('.list-content .loading').waitFor({ state: 'detached' });
const search = async (page, q) => {
  const input = page.getByLabel('搜尋面試者', { exact: true }); await input.fill(q);
  const response = page.waitForResponse(r => { const u = new URL(r.url()); return u.pathname === '/api/' + entity && r.request().method() === 'GET' && (u.searchParams.get('q') || '') === q; });
  await input.press('Enter'); assert.equal((await response).status(), 200); await waitList(page);
};
const findRow = async (page, item) => { await search(page, item.name); const row = listRows(page).filter({ hasText: item.name }); assert.equal(await row.count(), 1); return row; };
const create = async page => { await page.getByRole('button', { name: '新增面試者', exact: true }).click(); const d = page.getByRole('dialog', { name: '新增面試者', exact: true }); await field(d, 'name').waitFor(); return d; };
const edit = async (page, item) => { const row = await findRow(page, item); await row.getByRole('button', { name: '編輯', exact: true }).click(); const d = page.getByRole('dialog', { name: '編輯面試者', exact: true }); await field(d, 'name').waitFor(); return d; };
const fill = async (d, values) => { for (const [key, value] of Object.entries(values)) { if (key === 'status' || key.endsWith('Intent')) await field(d, key).selectOption(value); else await field(d, key).fill(value); } };
const commit = async (page, d, item) => {
  const method = item ? 'PATCH' : 'POST';
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/' + entity + (item ? '/' + item.id : '') && r.request().method() === method);
  await d.getByRole('button', { name: '儲存', exact: true }).click(); const r = await response;
  assert.equal(r.status(), item ? 200 : 201, await r.text()); const payload = r.request().postDataJSON();
  payloadChecks.push({ stage, method, keys: Object.keys(payload).sort(), sha256: sha(payload) });
  await d.waitFor({ state: 'detached' }); await waitList(page); return { payload, item: (await r.json()).item };
};
const close = async (page, trigger) => {
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  if (trigger) assert(await trigger.evaluate(node => node === document.activeElement), 'Escape returns focus');
};
const discard = async page => {
  await page.keyboard.press('Escape'); const d = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true });
  await d.getByRole('button', { name: '放棄修改', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
};
const formError = d => d.locator('.form-summary[role="alert"]:visible');
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  same(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.labels?.length && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')).map(n => n.name)), [], 'Visible controls labelled');
  for (const d of await page.getByRole('dialog').all()) assert(await d.evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && n.scrollWidth <= n.clientWidth + 1; }), 'Dialog within viewport');
  for (const t of await page.locator('.table-scroll').all()) if (await t.isVisible()) assert.equal(await t.evaluate(n => getComputedStyle(n).overflowX), 'auto');
};
const shot = async (page, name) => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false });
  screenshots.push({ name, sha256: sha(await readFile(path.join(output, name))), viewport: page.viewportSize(), actuallyViewed: false });
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), 15000); timer.unref(); })]);
const held = async (page, predicate) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false;
  const handler = async route => {
    if (used || !predicate(route.request())) return route.continue(); used = true;
    try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { handled.resolve(); }
  };
  await page.route('**/api/' + entity + '**', handler);
  return { arrived: arrived.promise, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'held response'); await page.unroute('**/api/' + entity + '**', handler); } };
};
const mutateContext = async (page, kind, foreignOrg) => page.evaluate(async ({ kind, foreignOrg }) => {
  const ui = await import('/ui.js'), current = ui.getContext();
  if (kind === 'hash') { location.hash = '/employees'; return; }
  if (kind === 'render') { document.querySelector('[data-render-version]').dataset.renderVersion = crypto.randomUUID(); return; }
  const session = { ...current, user: { ...current.user }, organizations: current.organizations.map(org => ({ ...org })) };
  if (kind === 'user') session.user.id = 'synthetic-interview-replaced-user';
  if (kind === 'role') session.organizations.find(org => org.id === current.organizationId).role = 'finance';
  if (kind === 'employee') session.organizations.find(org => org.id === current.organizationId).employeeId = 'synthetic-interview-replaced-employee';
  ui.setContext(session, kind === 'org' ? foreignOrg : current.organizationId); window.dispatchEvent(new Event('session-updated'));
}, { kind, foreignOrg });

try {
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(adminContext);
  const setup = await adminContext.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成面試管理員', email: 'interview-admin@example.test', password, organizationName: '合成面試甲機構' } });
  assert.equal(setup.status(), 201, await setup.text()); const adminAuth = await setup.json(), orgId = adminAuth.organizations[0].id;
  const admin = await adminContext.newPage(); observe(admin); const actors = { admin: { client: adminContext, auth: adminAuth, page: admin } };
  const request = async (method, route, data, expected = 200, actor = actors.admin, selectedOrg = orgId, headers = {}) => {
    const r = await actor.client.request.fetch(base + '/api/' + route, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': actor.auth.csrfToken, ...headers }, ...(data === undefined ? {} : { data }) });
    const body = await r.json(); assert.equal(r.status(), expected, method + ' ' + route + ' ' + JSON.stringify(body)); return body;
  };
  const post = async (kind, data, selectedOrg = orgId) => (await request('POST', kind, data, 201, actors.admin, selectedOrg)).item;
  const patch = async (item, data, actor = actors.admin) => (await request('PATCH', entity + '/' + item.id, { version: item.version, ...data }, 200, actor)).item;
  const get = async item => (await request('GET', entity + '/' + item.id)).item;
  const employee = await post('employees', { name: '合成既有居服員', employeeNo: 'INTERVIEW-E01', role: 'caregiver' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    await post('users', { name: '合成面試' + role, email: 'interview-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(client);
    const login = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'interview-' + role + '@example.test', password } });
    assert.equal(login.status(), 200); const page = await client.newPage(); observe(page); actors[role] = { client, page, auth: await login.json() };
  }
  const foreign = await post('organizations', { name: '合成面試乙機構' });
  const foreignItem = await post(entity, { name: '合成乙面試資料不得出現', phone: '0000000000', interviewDate: '2026-10-12', interviewContent: '合成乙隔離內容' }, foreign.id);
  // All account/auth fixture writes precede protected-state checks.
  const protectedBefore = protectedState();

  await readOnly('G1 四角色與兩機構／empty與取消', async () => {
    await load(admin); await admin.getByText('尚未建立面試者紀錄。', { exact: true }).waitFor();
    const trigger = admin.getByRole('button', { name: '新增面試者', exact: true }); const d = await create(admin);
    await fill(d, { name: '合成不保存內容' }); await discard(admin); assert(await trigger.evaluate(n => n === document.activeElement));
    for (const role of ['finance', 'caregiver']) {
      const actor = actors[role]; await actor.page.goto(base + '/#/'); await actor.page.waitForLoadState('networkidle');
      assert.equal(await actor.page.getByRole('link', { name: '面試者登錄', exact: true }).count(), 0);
      await request('GET', entity + '?unknown=1', undefined, 403, actor);
      await request('GET', entity + '/' + foreignItem.id, undefined, 403, actor);
      await request('GET', entity + '/' + foreignItem.id + '/history?compare=previous', undefined, 403, actor);
      await request('POST', entity, {}, 403, actor); await request('PATCH', entity + '/' + foreignItem.id, {}, 403, actor);
      await actor.page.goto(base + '/#/interviews'); await actor.page.waitForLoadState('networkidle');
      assert.equal(await actor.page.getByRole('button', { name: '新增面試者', exact: true }).count(), 0);
    }
    await request('GET', entity + '/' + foreignItem.id, undefined, 404);
    await shot(admin, 'empty-desktop.png');
  }); mark('G1 admin/sup能力與財務/居服403／兩org隔離／dirty取消零寫');

  stage = 'G2 真實新增八欄'; let d = await create(admin);
  const initialValues = { name: '  合成面試甲  ', phone: '  0000-123-456  ', interviewDate: '2026-10-12', city: '  合成縣市  ', district: '  合成鄉鎮  ', interviewContent: '合成面試內容第一行\n第二行：<script>無執行</script> & 保存\n尾段。', note: '合成備註\n第二行', status: 'active' };
  await fill(d, initialValues); await shot(admin, 'create-desktop.png'); let saved = (await commit(admin, d)).item;
  same(Object.fromEntries(keys.map(k => [k, saved[k]])), Object.fromEntries(keys.map(k => [k, initialValues[k].trim()])), 'Eight submitted values normalized exactly');
  await readOnly('G2 重整讀回', async () => { await load(admin); d = await edit(admin, saved); for (const k of keys) assert.equal(await field(d, k).inputValue(), saved[k]); assert(await field(d, 'status').isDisabled()); await close(admin); });
  same(protectedState(), protectedBefore, 'Create has no employee/account/existing data side effect'); mark('G2 真UI新增八欄／人工日期與換行／reload精確讀回');

  stage = 'G3 督導編輯與操作者'; const supervisor = actors.supervisor.page; await load(supervisor); d = await edit(supervisor, saved);
  await field(d, 'note').fill('合成督導只修改備註\n保留面試內容。'); const edited = await commit(supervisor, d, saved);
  same(Object.keys(edited.payload).sort(), ['note', 'version']); saved = edited.item;
  await readOnly('G3 歷程／欄位差異／實際actor', async () => {
    const row = await findRow(supervisor, saved), trigger = row.getByRole('button', { name: '版本歷程', exact: true }); await trigger.click();
    const h = supervisor.getByRole('dialog', { name: '面試者版本歷程', exact: true }); await h.getByText('合成面試supervisor', { exact: true }).waitFor();
    await h.getByText('比較僅涵蓋八個保存文字欄位；非文字值的隱藏內容不在比較範圍。', { exact: true }).waitFor();
    await h.getByText('第 1 版', { exact: true }).click();
    await h.getByText('合成面試管理員', { exact: true }).waitFor(); await h.getByText('備註', { exact: true }).first().waitFor();
    await h.getByText('合成督導只修改備註\n保留面試內容。', { exact: true }).first().waitFor();
    await shot(supervisor, 'history-desktop.png'); await close(supervisor, trigger);
  }); mark('G3 sup單欄PATCH省未改原值／八欄歷程／真admin與sup actor');

  stage = 'G4 分頁合成fixture'; for (let i = 0; i < 28; i++) await post(entity, { name: '合成分頁面試' + String(i + 1).padStart(2, '0'), phone: '0000' + i, interviewDate: i < 7 ? '2026-10-13' : '2026-10-14', interviewContent: '合成分頁內容' + i, status: i % 2 ? 'inactive' : 'active' });
  await readOnly('G4 search/day/status與25分頁', async () => {
    await load(admin); assert.equal(await listRows(admin).count(), 25); await admin.getByRole('button', { name: '下一頁', exact: true }).click(); await waitList(admin); assert.equal(await listRows(admin).count(), 4);
    await search(admin, '合成分頁面試'); assert.equal(await listRows(admin).count(), 25);
    const date = admin.getByLabel('面試日期篩選', { exact: true }); await date.fill('2026-10-13'); await date.press('Tab'); await waitList(admin); assert.equal(await listRows(admin).count(), 7);
    await admin.getByLabel('狀態', { exact: true }).selectOption('active'); await waitList(admin); assert.equal(await listRows(admin).count(), 4);
    await admin.getByRole('button', { name: '清除面試日期', exact: true }).click(); await waitList(admin); assert.equal(await date.inputValue(), ''); assert(await date.evaluate(n => n === document.activeElement)); assert.equal(await listRows(admin).count(), 14);
    await admin.getByLabel('狀態', { exact: true }).selectOption(''); await waitList(admin); await search(admin, '找不到的合成面試'); assert.equal(await listRows(admin).count(), 0); await shot(admin, 'no-results-desktop.png');
    await search(admin, saved.name); assert.equal(await listRows(admin).count(), 1); await shot(admin, 'filtered-desktop.png');
  }); mark('G4 search人工精確日與status交集／清除日期／25+4分頁／noresults零寫');

  stage = 'G5 停用與啟用確認';
  for (const next of ['inactive', 'active']) {
    const verb = next === 'inactive' ? '停用' : '啟用', row = await findRow(admin, saved); const button = row.getByRole('button', { name: verb, exact: true });
    await readOnly('G5 ' + verb + '取消確認', async () => { await button.click(); const c = admin.getByRole('dialog', { name: verb + '這筆面試紀錄', exact: true }); await c.waitFor(); await close(admin, button); });
    await button.click(); const c = admin.getByRole('dialog', { name: verb + '這筆面試紀錄', exact: true });
    const response = admin.waitForResponse(r => new URL(r.url()).pathname === '/api/' + entity + '/' + saved.id && r.request().method() === 'PATCH');
    await c.getByRole('button', { name: '確認' + verb, exact: true }).click(); const r = await response; assert.equal(r.status(), 200);
    same(Object.keys(r.request().postDataJSON()).sort(), ['status', 'version']); const nextItem = (await r.json()).item;
    for (const k of keys.filter(k => k !== 'status')) same(nextItem[k], saved[k]); assert.equal(nextItem.status, next); saved = nextItem; await c.waitFor({ state: 'detached' }); await waitList(admin);
  }
  await readOnly('G5 known status disabled', async () => { d = await edit(admin, saved); assert(await field(d, 'status').isDisabled()); await close(admin); }); mark('G5 停用/啟用必確認／取消零寫／只status與version／已知編輯status禁改');

  stage = 'G6 旧型別合成匯入';
  const rawData = { name: '合成舊型別面試', phone: '原電話\r\n不可安全預填', interviewDate: '0000-01-01', city: { hidden: 'NEVER_RENDER_INTERVIEW_CITY' }, district: 42, interviewContent: { hidden: 'NEVER_RENDER_INTERVIEW_CONTENT' }, note: null, status: 'active' };
  const typed = { ...rawData, id: id(), orgId, version: 1, createdAt: now(), updatedAt: now() };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(typed.id, orgId, entity, JSON.stringify(rawData), 1, typed.createdAt, typed.updatedAt);
  app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, typed.id, 1, JSON.stringify(typed), typed.updatedAt, 'baseline');
  await readOnly('G6 原型別不coerce／取消與history無hidden', async () => {
    await load(admin); d = await edit(admin, typed);
    for (const k of ['phone', 'interviewDate', 'city', 'district', 'interviewContent', 'note']) { assert(await field(d, k).isDisabled()); assert.equal(await field(d, k + 'Intent').inputValue(), 'keep'); }
    assert(!/NEVER_RENDER_INTERVIEW/.test(await d.innerHTML())); await shot(admin, 'raw-intent-desktop.png'); await close(admin);
    const row = await findRow(admin, typed); await row.getByRole('button', { name: '版本歷程', exact: true }).click(); const h = admin.getByRole('dialog', { name: '面試者版本歷程', exact: true }); await h.getByText('第 1 版', { exact: true }).waitFor(); assert(!/NEVER_RENDER_INTERVIEW/.test(await h.innerHTML())); await close(admin);
  });
  expectFailure({ id: 'G6-merged-422', kind: 'http', phase: 'G6 原merged守門保留輸入不清理', url: base + '/api/' + entity + '/' + typed.id, method: 'PATCH', status: 422, count: 1, consoleCount: 1 });
  await readOnly('G6 原merged守門保留輸入不清理', async () => {
    d = await edit(admin, typed); await fill(d, { noteIntent: 'clear' }); await d.getByRole('button', { name: '儲存', exact: true }).click(); await formError(d).waitFor();
    assert.equal(await field(d, 'noteIntent').inputValue(), 'clear'); for (const k of ['phone', 'interviewDate', 'city', 'district', 'interviewContent']) assert.equal(await field(d, k + 'Intent').inputValue(), 'keep'); await discard(admin);
  });
  stage = 'G6 明確repair與optional clear'; d = await edit(admin, typed);
  await fill(d, { phoneIntent: 'replace', phone: '00008888', cityIntent: 'clear', districtIntent: 'clear', interviewContentIntent: 'replace', interviewContent: '合成明確修復面試內容', noteIntent: 'clear' });
  const typedUpdate = await commit(admin, d, typed); same(Object.keys(typedUpdate.payload).sort(), ['city', 'district', 'interviewContent', 'note', 'phone', 'version']);
  for (const k of ['city', 'district', 'note']) assert.equal(typedUpdate.item[k], ''); for (const k of ['name', 'interviewDate', 'status']) same(typedUpdate.item[k], typed[k]);
  const crlf = await post(entity, { name: '合成合法CRLF面試', phone: '00009999', interviewDate: '0000-01-02', interviewContent: '合法內容甲\r\n內容乙', note: '原備註' });
  d = await edit(admin, crlf); assert.equal(await field(d, 'interviewContentIntent').inputValue(), 'keep'); assert.equal(await field(d, 'interviewDateIntent').inputValue(), 'keep');
  await field(d, 'note').fill('合成只改合法備註'); const crUpdate = await commit(admin, d, crlf); same(Object.keys(crUpdate.payload).sort(), ['note', 'version']); same(crUpdate.item.interviewContent, crlf.interviewContent); same(crUpdate.item.interviewDate, crlf.interviewDate);
  const unknownData = { name: '合成未知狀態面試', phone: '00007777', interviewDate: '2026-10-16', city: '', district: '', interviewContent: '合成保存內容', note: '', status: 'unknown-imported-status' };
  const unknown = { ...unknownData, id: id(), orgId, version: 1, createdAt: now(), updatedAt: now() };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(unknown.id, orgId, entity, JSON.stringify(unknownData), 1, unknown.createdAt, unknown.updatedAt);
  app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, unknown.id, 1, JSON.stringify(unknown), unknown.updatedAt, 'baseline');
  d = await edit(admin, unknown); assert(await field(d, 'status').isDisabled()); await fill(d, { statusIntent: 'replace', status: 'inactive' });
  const repair = await commit(admin, d, unknown); same(Object.keys(repair.payload).sort(), ['status', 'version']); assert.equal(repair.item.status, 'inactive');
  mark('G6 CRLF/year0000/JSON/null intent保持／merged422不清理／明確repair與optional清空');

  stage = 'G7 未確認2xx與同key重試'; await load(admin); if (await admin.locator('.toast').count()) await admin.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 }); d = await create(admin); const retryValues = { name: '合成未知回應面試', phone: '00001234', interviewDate: '2026-10-15', city: '合成城市', district: '合成區', interviewContent: '合成冪等內容\n原輸入保持', note: '合成備註', status: 'active' }; await fill(d, retryValues);
  const mutations = [() => null, result => ({ item: { ...result.item, id: '' } }), result => ({ item: { ...result.item, orgId: foreign.id } }), result => ({ item: { ...result.item, version: 2 } }), result => { const item = { ...result.item }; delete item.note; return { item }; }, result => ({ item: { ...result.item, interviewContent: '合成不符內容' } })];
  let ackIndex = 0, committedRaw; const requestKeys = [], requestBodies = [];
  const badAck = async route => {
    if (route.request().method() !== 'POST' || new URL(route.request().url()).pathname !== '/api/' + entity) return route.continue();
    requestKeys.push(route.request().headers()['idempotency-key']); requestBodies.push(route.request().postData());
    const r = await route.fetch(), body = await r.json(); await route.fulfill({ response: r, json: ackIndex < mutations.length ? mutations[ackIndex++](body) : body });
  };
  const beforeRetry = counts(); await admin.route('**/api/' + entity + '**', badAck);
  try {
    for (let i = 0; i < mutations.length; i++) {
      await d.getByRole('button', { name: '儲存', exact: true }).click(); await formError(d).waitFor(); assert(await d.isVisible());
      for (const k of keys) assert.equal(await field(d, k).inputValue(), retryValues[k]);
      assert.equal(await admin.locator('.toast-success').count(), 0); if (!i) committedRaw = raw(); else same(raw(), committedRaw, 'Same key retry adds no data writes');
      ackChecks.push({ branch: 'create', variant: i + 1, retainedInput: true, noFalseSuccess: true });
    }
    await shot(admin, 'unconfirmed-create-desktop.png'); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.waitFor({ state: 'detached' }); await waitList(admin);
    same(raw(), committedRaw); assert.equal(counts().records - beforeRetry.records, 1); assert.equal(counts().versions - beforeRetry.versions, 1); assert.equal(counts().audit - beforeRetry.audit, 1); assert.equal(counts().idempotency - beforeRetry.idempotency, 1);
    assert.equal(new Set(requestKeys).size, 1); assert(requestKeys[0]); assert.equal(new Set(requestBodies).size, 1);
  } finally { await admin.unroute('**/api/' + entity + '**', badAck); }
  if (await admin.locator('.toast').count()) await admin.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  d = await edit(admin, saved); await field(d, 'note').fill('合成edit換id回應不得當作成功');
  const wrongEditIdentity = async route => {
    if (route.request().method() !== 'PATCH' || new URL(route.request().url()).pathname !== '/api/' + entity + '/' + saved.id) return route.continue();
    const r = await route.fetch(), result = await r.json(); await route.fulfill({ response: r, json: { item: { ...result.item, id: foreignItem.id } } });
  };
  await admin.route('**/api/' + entity + '**', wrongEditIdentity);
  try {
    await d.getByRole('button', { name: '儲存', exact: true }).click(); await formError(d).waitFor(); assert(await d.isVisible());
    assert.equal(await field(d, 'note').inputValue(), '合成edit換id回應不得當作成功'); assert.equal(await admin.locator('.toast-success').count(), 0);
    ackChecks.push({ branch: 'edit', variant: 'wrong valid id', retainedInput: true, noFalseSuccess: true, actualServerCommitAccounted: true }); await discard(admin);
  } finally { await admin.unroute('**/api/' + entity + '**', wrongEditIdentity); }
  saved = await get(saved); assert.equal(saved.note, '合成edit換id回應不得當作成功');
  mark('G7 六create及edit錯id非法2xx保留輸入/不假成功／create同payload同key只提交一次');

  stage = 'G8 CAS與離線'; await load(admin); d = await edit(admin, saved); await field(d, 'note').fill('合成CAS本次輸入保留'); saved = await patch(saved, { note: '合成並行督導保存' }, actors.supervisor);
  expectFailure({ id: 'G8-cas-409', kind: 'http', phase: 'G8 conflict保留', url: base + '/api/' + entity + '/' + saved.id, method: 'PATCH', status: 409, count: 1, consoleCount: 1 });
  await readOnly('G8 conflict保留', async () => { await d.getByRole('button', { name: '儲存', exact: true }).click(); await formError(d).waitFor(); assert.equal(await field(d, 'note').inputValue(), '合成CAS本次輸入保留'); await discard(admin); });
  d = await edit(admin, saved); await field(d, 'note').fill('合成離線本次輸入保留'); const offline = async route => route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue(); await admin.route('**/api/' + entity + '**', offline);
  expectFailure({ id: 'G8-offline-one-patch', kind: 'requestfailed', phase: 'G8 真requestfailed與輸入保留', url: base + '/api/' + entity + '/' + saved.id, method: 'PATCH', failure: 'net::ERR_INTERNET_DISCONNECTED', count: 1, consoleCount: 1 });
  await readOnly('G8 真requestfailed與輸入保留', async () => { await d.getByRole('button', { name: '儲存', exact: true }).click(); await formError(d).waitFor(); assert.equal(await field(d, 'note').inputValue(), '合成離線本次輸入保留'); await shot(admin, 'offline-edit-desktop.png'); });
  await admin.unroute('**/api/' + entity + '**', offline); saved = (await commit(admin, d, saved)).item; mark('G8 真409/離線失敗保留輸入／失敗零寫／人工重試有效保存');

  stage = 'G9 busy與Escape'; d = await edit(admin, saved); await field(d, 'note').fill('合成busy明確保存'); const saveButton = await d.getByRole('button', { name: '儲存', exact: true }).elementHandle(), cancelButton = await d.getByRole('button', { name: '取消', exact: true }).elementHandle();
  const originalGeometry = await saveButton.boundingBox(); let busyPosts = 0; const countBusy = req => { if (req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/' + entity + '/' + saved.id) busyPosts++; }; admin.on('request', countBusy);
  const slow = await held(admin, req => req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/' + entity + '/' + saved.id);
  try {
    await saveButton.click(); await bounded(slow.arrived, 'busy server commit'); assert(await saveButton.isDisabled()); same(await saveButton.boundingBox(), originalGeometry, 'Busy original button geometry');
    await saveButton.evaluate(n => { n.click(); n.click(); }); await cancelButton.evaluate(n => n.click()); await admin.keyboard.press('Escape'); assert(await d.isVisible()); assert.equal(busyPosts, 1); await shot(admin, 'busy-desktop.png');
    await slow.finish(); await d.waitFor({ state: 'detached' }); saved = await get(saved);
  } finally { await slow.finish(); admin.off('request', countBusy); }
  mark('G9 same原生button busy防重與尺寸／cancel/Escape鎖定／真提交一次');

  const listFailures = [body => ({ ...body, items: body.items.slice(1) }), body => ({ ...body, items: body.items.map((item, i) => i === 1 ? { ...item, id: body.items[0].id } : item) }), body => ({ ...body, page: 2 })];
  expectFailure({ id: 'G10-injected-503', kind: 'http', phase: 'G10 listDTO與503手動重試', url: base + '/api/' + entity + '?page=1&pageSize=25', method: 'GET', status: 503, count: 1, consoleCount: 1 });
  await readOnly('G10 listDTO與503手動重試', async () => {
    for (let i = 0; i < listFailures.length; i++) {
      let used = false; const handler = async route => { if (used || route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/' + entity) return route.continue(); used = true; const r = await route.fetch(); await route.fulfill({ response: r, json: listFailures[i](await r.json()) }); };
      await admin.route('**/api/' + entity + '**', handler); await load(admin); await admin.locator('.list-content [role="alert"]').waitFor(); assert.equal(await listRows(admin).count(), 0); await admin.unroute('**/api/' + entity + '**', handler);
      await admin.locator('.list-content').getByRole('button', { name: '重新讀取', exact: true }).click(); await waitList(admin); assert.equal(await listRows(admin).count(), 25);
    }
    let used = false; const unavailable = async route => { if (used || route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/' + entity) return route.continue(); used = true; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成面試列表暫時無法使用' } }) }); };
    await admin.route('**/api/' + entity + '**', unavailable); await load(admin); await admin.getByText('合成面試列表暫時無法使用', { exact: true }).waitFor(); await shot(admin, 'list-error-desktop.png');
    await admin.locator('.list-content').getByRole('button', { name: '重新讀取', exact: true }).click(); await waitList(admin); await admin.unroute('**/api/' + entity + '**', unavailable);
  }); mark('G10 list精確筆數/uniqueID/page確認／503共用重試與零寫');

  for (const kind of ['user', 'org', 'role', 'employee', 'hash', 'render']) {
    await load(admin); stage = 'G11 pending list ' + kind; const pending = await held(admin, req => req.method() === 'GET' && new URL(req.url()).pathname === '/api/' + entity && new URL(req.url()).searchParams.get('q') === saved.name);
    const pendingUrl = base + '/api/' + entity + '?' + new URLSearchParams({ page: '1', pageSize: '25', q: saved.name });
    expectFailure({ id: 'G11-list-abort-' + kind, kind: 'requestfailed', phase: 'G11 list context ' + kind, url: pendingUrl, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, contextAbort: true });
    await readOnly('G11 list context ' + kind, async () => {
      const input = admin.getByLabel('搜尋面試者', { exact: true }); await input.fill(saved.name); await input.press('Enter'); await bounded(pending.arrived, 'list ' + kind);
      await mutateContext(admin, kind, foreign.id); await pending.finish(); await admin.waitForLoadState('networkidle');
      if (kind !== 'org') assert.equal(await admin.locator('.list-content').getByText(saved.name, { exact: true }).count(), 0);
      else assert(!/合成面試甲/.test(await admin.locator('.list-content').innerText()));
      assert.equal(await admin.getByRole('dialog').count(), 0); contextChecks.push({ operation: 'list', kind, lateResponseDidNotRender: true, zeroWrites: true });
    });
  }
  // Browser-local primitive context changes prove client cancellation, not server revocation.
  for (const kind of ['user', 'org', 'role', 'employee', 'hash', 'render']) {
    await load(admin); stage = 'G11 pending form ' + kind; d = await edit(admin, saved); await field(d, 'note').fill('合成context已提交 ' + kind);
    expectFailure({ id: 'G11-form-abort-' + kind, kind: 'requestfailed', phase: stage, url: base + '/api/' + entity + '/' + saved.id, method: 'PATCH', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, contextAbort: true });
    const pending = await held(admin, req => req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/' + entity + '/' + saved.id);
    try {
      await d.getByRole('button', { name: '儲存', exact: true }).click(); await bounded(pending.arrived, 'form ' + kind); await mutateContext(admin, kind, foreign.id);
      await d.waitFor({ state: 'detached' }); await pending.finish(); assert.equal(await admin.getByRole('dialog').count(), 0); assert.equal(await admin.locator('.toast-success').count(), 0);
      saved = await get(saved); assert.equal(saved.note, '合成context已提交 ' + kind); contextChecks.push({ operation: 'form', kind, lateResponseDidNotReopen: true, noFalseSuccess: true, serverCommitExplicitlyAccounted: true });
    } finally { await pending.finish(); }
  }
  mark('G11 六primitive在途列表零寫／六表單失效晚回應不復活不假成功／已提交另計');

  stage = 'G12 mobile長文'; await admin.setViewportSize({ width: 390, height: 844 }); await load(admin);
  const mobileTable = admin.locator('.list-content .table-scroll'); assert(await mobileTable.evaluate(n => n.scrollWidth > n.clientWidth));
  await mobileTable.evaluate(n => { n.scrollLeft = n.scrollWidth; }); assert(await mobileTable.evaluate(n => n.scrollLeft > 0)); await mobileTable.evaluate(n => { n.scrollLeft = 0; }); await shot(admin, 'list-mobile.png');
  d = await edit(admin, saved); const long = Array.from({ length: 140 }, (_, i) => `合成面試長文第${i + 1}行：保留換行與完整內容。`).join('\n') + '\n合成手機最後一行可讀'; assert(long.length < 10000);
  await readOnly('G12 10001字必須拒絕且不發送寫入', async () => {
    const oversized = '合'.repeat(10001); let writeRequests = 0;
    const countWrites = req => { if (['POST', 'PATCH'].includes(req.method()) && new URL(req.url()).pathname.startsWith('/api/' + entity)) writeRequests++; };
    admin.on('request', countWrites);
    try { await field(d, 'interviewContent').fill(oversized); await d.getByRole('button', { name: '儲存', exact: true }).click(); await formError(d).waitFor(); assert.equal(await field(d, 'interviewContent').inputValue(), oversized); assert.equal(writeRequests, 0); }
    finally { admin.off('request', countWrites); }
  });
  await field(d, 'interviewContent').fill(long); assert.equal(await field(d, 'interviewContent').inputValue(), long);
  const textarea = field(d, 'interviewContent'); await textarea.scrollIntoViewIfNeeded(); assert.equal(await textarea.evaluate(n => getComputedStyle(n).resize), 'none'); assert(await textarea.evaluate(n => n.scrollHeight > n.clientHeight));
  await textarea.evaluate(n => { n.scrollTop = n.scrollHeight; }); assert(await textarea.evaluate(n => n.scrollTop + n.clientHeight >= n.scrollHeight - 1)); await shot(admin, 'long-content-mobile.png');
  await d.evaluate(n => { n.scrollTop = n.scrollHeight; }); await shot(admin, 'mobile-form-bottom.png'); saved = (await commit(admin, d, saved)).item; assert.equal(saved.interviewContent, long);
  await readOnly('G12 mobile歷程與desktop sibling', async () => {
    const row = await findRow(admin, saved); await row.getByRole('button', { name: '版本歷程', exact: true }).click(); const h = admin.getByRole('dialog', { name: '面試者版本歷程', exact: true }); await h.locator('.history-version').first().waitFor(); await shot(admin, 'history-mobile.png'); await close(admin);
    await admin.setViewportSize({ width: 1440, height: 1050 }); await load(admin); await shot(admin, 'list-desktop-final.png');
    await admin.goto(base + '/#/employees'); await admin.getByRole('heading', { name: '員工管理', exact: true, level: 1 }).waitFor(); await admin.waitForLoadState('networkidle'); await shot(admin, 'employee-sibling-desktop.png');
  }); mark('G12 390px長文末段textarea內捲／保存完整／history內捲／1440 sibling無整頁溢出');

  stage = 'G13 最終零副作用'; same(protectedState(), protectedBefore, 'All employee/account/memberships/other rows and original histories preserved');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors)); assert.equal(failedResponses.filter(r => !r.expectedRuleId).length, 0, JSON.stringify(failedResponses));
  assert.equal(failedRequests.filter(r => !r.expectedRuleId).length, 0, JSON.stringify(failedRequests));
  const assignedConsole = new Set();
  for (const rule of expectedFailures) {
    const events = (rule.kind === 'http' ? failedResponses : failedRequests).filter(event => event.expectedRuleId === rule.id);
    assert.equal(events.length, rule.count, 'Exact controlled failure count: ' + rule.id);
    const matched = consoleErrors.flatMap((event, index) => event.stage === rule.phase && event.location.url === rule.url
      && (rule.kind === 'http' ? event.text.startsWith('Failed to load resource: the server responded with a status of ' + rule.status + ' (') : event.text === 'Failed to load resource: ' + rule.failure)
      ? [index] : []);
    if (rule.consoleCount !== undefined) assert.equal(matched.length, rule.consoleCount, 'Exact console source: ' + rule.id);
    else assert(matched.length <= rule.maxConsoleCount, 'Bounded context-abort console: ' + rule.id);
    for (const index of matched) { assert(!assignedConsole.has(index)); assignedConsole.add(index); }
    rule.actualFailureCount = events.length; rule.actualConsoleCount = matched.length;
  }
  const unexpectedConsole = consoleErrors.filter((_, index) => !assignedConsole.has(index));
  assert.equal(unexpectedConsole.length, 0, JSON.stringify(unexpectedConsole));
  mark('G13 原十一表/六trigger及员工帐号副作用为零／无unhandled或非受控console错误');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), syntheticOnly: true, database: ':memory:', randomLoopback: true, checks, readSegments, payloadChecks, ackChecks, contextChecks, protectedStateUnchanged: true, pageErrors, consoleErrors, failedResponses, failedRequests, expectedFailures, expectedConsoleFailuresOnly: true, screenshots, visualReviewPending: true, actuallyViewedByScript: false }, null, 2), { flag: 'wx' });
  console.log('RESULT ' + path.join(output, 'e2e.json'));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, stage, error: error.stack, checks, readSegments, payloadChecks, ackChecks, contextChecks, consoleErrors, pageErrors, failedResponses, failedRequests, expectedFailures, screenshots }, null, 2), { flag: 'wx' }); throw error;
} finally { for (const context of contexts) await context.close().catch(() => {}); if (browser) await browser.close(); await app.close(); }
