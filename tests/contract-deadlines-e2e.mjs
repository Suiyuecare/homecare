import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const formal = new URL('../src/server/index.mjs', import.meta.url), serverUrl = existsSync(formal) ? formal : new URL('../../../../src/server/index.mjs', import.meta.url);
const { createApp } = await import(serverUrl);
const root = path.resolve(path.dirname(fileURLToPath(serverUrl)), '../..'), { chromium } = createRequire(import.meta.url)('playwright');
const entity = 'contract-deadline-reminders', password = 'synthetic-deadline-browser-password';
const qa = path.join(root, 'outputs/software/contract-deadlines-qa'); await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-')); console.log('EVIDENCE ' + output);
const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
const checks = [], screenshots = [], pageErrors = [], mutations = [], nativeDialogs = [], contexts = [];
let browser, stage = 'setup', admin, employee, parentCase, parents, current, page;
const sha = data => createHash('sha256').update(data).digest('hex');
const mark = name => { checks.push(name); console.log('PASS ' + name); };
const raw = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => { const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [row.name, statement.all()]; })) });
const route = item => '/api/' + entity + (item ? '/' + item.id : '');
const request = async (method, url, data, status = 200, client = admin) => { const result = await client.context.request.fetch(base + url, { method, headers: { Origin: base, 'X-CSRF-Token': client.auth.csrfToken, 'X-Org-Id': client.org }, ...(data === undefined ? {} : { data }) }); assert.equal(result.status(), status, await result.text()); return result.json(); };
const post = async (name, fields, client = admin) => (await request('POST', '/api/' + name, fields, 201, client)).item;
const patch = async (name, item, fields, client = admin) => (await request('PATCH', '/api/' + name + '/' + item.id, { version: item.version, ...fields }, 200, client)).item;
const readOnly = async action => { const before = raw(); const result = await action(); assert.deepEqual(raw(), before, 'read action changes no table or total_changes'); return result; };
const observe = tab => { tab.setDefaultTimeout(15000); tab.on('pageerror', error => pageErrors.push({ stage, message: error.message })); tab.on('dialog', async dialog => { nativeDialogs.push({ stage, type: dialog.type() }); await dialog.dismiss(); }); tab.on('request', req => { if (['POST', 'PATCH', 'DELETE'].includes(req.method()) && new URL(req.url()).pathname === route()) mutations.push({ stage, method: req.method(), data: req.postDataJSON(), key: req.headers()['idempotency-key'] }); }); };
const modal = (name, tab = page) => tab.getByRole('dialog', { name, exact: true });
const editModal = () => modal('編輯契約期限提醒');
const createModal = () => modal('新增契約期限提醒');
const detailsModal = () => modal('契約期限提醒完整紀錄');
const row = item => page.locator('tbody tr').filter({ has: page.getByText(item.title, { exact: true }) });
const close = async dialog => { const handle = await dialog.elementHandle(); await page.keyboard.press('Escape'); const discard = modal('放棄未儲存的內容？'); if (await discard.isVisible()) await discard.getByRole('button', { name: '放棄修改', exact: true }).click(); await page.waitForFunction(element => !element.isConnected, handle); await handle.dispose(); };
const settle = async () => page.waitForLoadState('networkidle');
const load = async (item, tab = page) => {
  const target = base + '/#/contract-deadlines'; if (tab.url() === target) await tab.reload(); else await tab.goto(target);
  await tab.getByRole('heading', { name: '契約期限提醒', level: 1, exact: true }).waitFor(); await tab.waitForLoadState('networkidle');
  if (item) { await tab.getByRole('searchbox', { name: '搜尋契約提醒', exact: true }).fill(item.title); await tab.getByRole('searchbox', { name: '搜尋契約提醒', exact: true }).press('Enter'); await tab.locator('tbody tr').filter({ has: tab.getByText(item.title, { exact: true }) }).waitFor(); await tab.waitForLoadState('networkidle'); }
};
const openDetails = async item => { await load(item); await row(item).getByRole('button', { name: '查看紀錄', exact: true }).click(); await detailsModal().getByText('保存版次', { exact: true }).waitFor(); await settle(); };
const create = async (parent, title) => {
  await page.getByRole('button', { name: '新增期限提醒', exact: true }).click(); const chooser = modal('選擇人工提醒來源契約');
  await chooser.getByLabel('目前已記錄生效契約', { exact: false }).selectOption(parent.id); await chooser.getByRole('button', { name: '核對此契約', exact: true }).click();
  await createModal().getByLabel('提醒標題', { exact: false }).fill(title); await createModal().getByLabel('人工工作內容', { exact: false }).fill('  人工提醒原文\n末行  ');
  await createModal().getByLabel('受指派員工', { exact: false }).selectOption(employee.id); await createModal().getByLabel('人工應完成日期', { exact: false }).fill('2026-12-10');
  await createModal().getByLabel('備註', { exact: false }).fill('  人工備註\n尾行  ');
};
const finishForm = async (name, date, detail) => {
  const form = modal(name); await form.getByLabel('本次人工處理日期', { exact: false }).fill(date);
  if (detail) await form.getByLabel(name === '取消人工提醒' ? '本次取消原因' : '本次完成結果', { exact: false }).fill(detail);
  await form.getByRole('button', { name: '核對並保存本次處理', exact: true }).click(); const confirmation = modal('確認' + name + '？');
  await confirmation.getByRole('button', { name: '確認' + name, exact: true }).click(); await form.waitFor({ state: 'detached' }); await detailsModal().getByText('保存版次', { exact: true }).waitFor(); await settle();
};
const shot = async name => {
  await settle(); const geometry = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll('dialog[open]')].map(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth })) }));
  assert(geometry.documentWidth <= geometry.width + 1); for (const dialog of geometry.dialogs) assert(dialog.scrollWidth <= dialog.width + 1);
  const target = path.join(output, name); await page.screenshot({ path: target, fullPage: false }); screenshots.push({ name, path: target, sha256: sha(await readFile(target)), viewport: page.viewportSize(), geometry, actuallyViewed: false });
};
try {
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context);
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成期限瀏覽管理員', email: 'deadline-browser-admin@example.test', password, organizationName: '合成期限瀏覽機構' } }); assert.equal(setup.status(), 201);
  const auth = await setup.json(); admin = { context, auth, org: auth.organizations[0].id }; page = await context.newPage(); observe(page);
  parentCase = await post('cases', { caseNo: 'DEADLINE-BROWSER-C', name: '合成期限瀏覽個案' }); employee = await post('employees', { employeeNo: 'DEADLINE-BROWSER-E', name: '合成期限瀏覽員工' });
  parents = [];
  for (let i = 0; i < 4; i++) { let parent = await post('case-contracts', { caseId: parentCase.id, number: 'DEADLINE-BROWSER-' + i, title: '合成期限來源' + i, startDate: '2026-10-01', endDate: '2026-12-31' }); parent = await patch('case-contracts', parent, { status: 'active', signedDate: '2026-09-20', statusDate: '2026-09-21', documentReference: '合成文件', sourceReference: '人工核對來源' }); parents.push(parent); }
  stage = 'G1 actual commit with malformed ACK and exact POST idem retry'; await load(); await create(parents[0], '合成期限瀏覽提醒'); let intercepted = false, saved;
  const handler = async routeHandle => { if (routeHandle.request().method() !== 'POST' || intercepted) return routeHandle.continue(); intercepted = true; const response = await routeHandle.fetch(); assert.equal(response.status(), 201); const body = await response.json(); saved = structuredClone(body.item); body.item.contractSnapshot.version += 1; await routeHandle.fulfill({ response, json: body }); };
  await page.route(base + route(), handler); await createModal().getByRole('button', { name: '儲存人工提醒', exact: true }).click(); await createModal().getByRole('alert').waitFor();
  assert.equal(await createModal().getByLabel('提醒標題', { exact: false }).inputValue(), '合成期限瀏覽提醒'); assert.equal(saved.version, 1);
  await page.unroute(base + route(), handler); await createModal().getByRole('button', { name: '儲存人工提醒', exact: true }).click(); await createModal().waitFor({ state: 'detached' }); await settle();
  assert.equal(mutations.filter(entry => entry.stage === stage).length, 2); assert.equal(mutations.at(-1).key, mutations.at(-2).key); assert.equal(app.db.prepare('SELECT COUNT(*) n FROM records WHERE entity=?').get(entity).n, 1); current = saved;
  assert.equal((await request('GET', '/api/case-contracts/' + parents[0].id)).item.version, parents[0].version); mark(stage);

  stage = 'G2 unchanged CRLF omitted and only edited title saved';
  // Raw synthetic legacy-style newline fixture, new record remains closed and source valid.
  let stored = app.db.prepare('SELECT data FROM records WHERE id=?').get(current.id).data, content = JSON.parse(stored); content.content = '  人工提醒原文\r\n末行  '; content.note = '  人工備註\r\n尾行  '; app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(content), current.id);
  current = (await request('GET', route(current))).item; await load(current); await row(current).getByRole('button', { name: '編輯提醒', exact: true }).click(); await editModal().getByLabel('提醒標題', { exact: false }).waitFor();
  await readOnly(async () => { await editModal().getByRole('button', { name: '儲存人工提醒', exact: true }).click(); await editModal().waitFor({ state: 'detached' }); await settle(); });
  await row(current).getByRole('button', { name: '編輯提醒', exact: true }).click(); await editModal().getByLabel('提醒標題', { exact: false }).fill('合成期限更正提醒'); await editModal().getByRole('button', { name: '儲存人工提醒', exact: true }).click(); await editModal().waitFor({ state: 'detached' }); await settle();
  current = (await request('GET', route(current))).item; assert.equal(current.content, content.content); assert.equal(current.note, content.note); assert.equal(current.title, '合成期限更正提醒'); mark(stage);

  stage = 'G3 explicit asOf and manual deadline classification query never writes'; await load(current);
  await readOnly(async () => { await page.getByRole('button', { name: '設定比對日期／期限', exact: true }).click(); const filter = modal('明確指定期限工作清單');
    await filter.getByLabel('明確比對日期', { exact: false }).fill('2026-12-10'); await filter.getByLabel('人工期限分類', { exact: false }).selectOption('on_due'); await filter.getByLabel('人工應完成起日', { exact: false }).fill('2026-12-01'); await filter.getByLabel('人工應完成迄日', { exact: false }).fill('2026-12-31');
    await filter.getByRole('button', { name: '套用唯讀查詢', exact: true }).click(); await filter.waitFor({ state: 'detached' }); await row(current).waitFor(); await settle(); assert.match(await page.textContent('main'), /明確比對日期：2026-12-10/); assert.equal(await row(current).count(), 1); await shot('worklist-explicit-date-desktop.png');
    await page.getByRole('button', { name: '清除期間與分類', exact: true }).click(); await settle(); }); mark(stage);

  stage = 'G4 actual CAS409 preserves user input and current source'; await load(current); await row(current).getByRole('button', { name: '編輯提醒', exact: true }).click(); await editModal().getByLabel('提醒標題', { exact: false }).fill('本次輸入不能丟失');
  current = await patch(entity, current, { note: '合成其他管理員保存' }); const beforeCAS = raw(); await editModal().getByRole('button', { name: '儲存人工提醒', exact: true }).click(); await editModal().getByRole('alert').waitFor();
  assert.equal(await editModal().getByLabel('提醒標題', { exact: false }).inputValue(), '本次輸入不能丟失'); assert.deepEqual(raw(), beforeCAS); await shot('cas-preserved-input-desktop.png'); await close(editModal()); mark(stage);

  stage = 'G5 manual begin/complete current result and typed history'; await openDetails(current); await detailsModal().getByRole('button', { name: '開始處理', exact: true }).click(); await finishForm('開始人工處理', '2026-12-01');
  await detailsModal().getByRole('button', { name: '完成提醒', exact: true }).click(); await finishForm('人工完成提醒', '2026-12-02', '  本次人工核對完成\n來源保留  '); assert.match(await detailsModal().textContent(), /已人工完成/); await shot('completed-detail-desktop.png'); await close(detailsModal());
  current = (await request('GET', route(current))).item; assert.equal(current.status, 'completed');
  await load(current); await readOnly(async () => { await row(current).getByRole('button', { name: '版本歷程', exact: true }).click(); const history = page.locator('dialog[open]').last(); await history.getByText('完整保存欄位', { exact: true }).first().click(); await history.getByText('提醒標題', { exact: true }).first().waitFor(); assert.match(await history.textContent(), /建立時契約|建立時來源|來源契約/); assert(!(await history.textContent()).includes('[object Object]')); await shot('typed-history-desktop.png'); await close(history); }); mark(stage);

  stage = 'G6 terminal source retains frozen reminder manual cancellation and new record'; let terminal = await post(entity, { contractId: parents[1].id, contractVersion: parents[1].version, title: '合成來源到期提醒', content: '合成人工工作', assigneeEmployeeId: employee.id, dueDate: '2026-12-10' });
  const snapshot = structuredClone(terminal.contractSnapshot); parents[1] = await patch('case-contracts', parents[1], { status: 'expired', statusDate: '2027-01-01', statusReason: '合成人工處理來源到期' });
  await openDetails(terminal); assert.match(await detailsModal().textContent(), /來源目前狀態：已人工處理到期/); await detailsModal().getByRole('button', { name: '取消提醒', exact: true }).click(); await finishForm('取消人工提醒', '2027-01-02', '  本次人工取消原因\n來源已另核對  '); await close(detailsModal());
  terminal = (await request('GET', route(terminal))).item; assert.deepEqual(terminal.contractSnapshot, snapshot); assert.equal(terminal.status, 'cancelled');
  const replacement = await post(entity, { contractId: parents[0].id, contractVersion: parents[0].version, title: '合成完成後新提醒', content: '合成後續工作', assigneeEmployeeId: employee.id, dueDate: '2026-12-20' }); assert.notEqual(replacement.id, current.id); mark(stage);

  stage = 'G7 desktop375390 ordinary forms/details footer and local table overflow';
  for (const width of [1440, 375, 390]) { await page.setViewportSize({ width, height: width > 1000 ? 1000 : 900 }); await load(replacement); await shot('worklist-' + width + '.png');
    await row(replacement).getByRole('button', { name: '編輯提醒', exact: true }).click(); await editModal().getByLabel('提醒標題', { exact: false }).waitFor(); await shot('form-' + width + '.png');
    await editModal().getByRole('button', { name: '儲存人工提醒', exact: true }).scrollIntoViewIfNeeded(); assert(await editModal().getByRole('button', { name: '儲存人工提醒', exact: true }).isVisible()); await shot('form-footer-' + width + '.png'); await close(editModal());
    await openDetails(replacement); await shot('details-' + width + '.png'); await detailsModal().getByRole('button', { name: '關閉', exact: true }).scrollIntoViewIfNeeded(); assert(await detailsModal().getByRole('button', { name: '關閉', exact: true }).isVisible()); await shot('details-footer-' + width + '.png'); await close(detailsModal()); }
  mark(stage);

  stage = 'G8 two restricted roles no nav or direct access, stale committed response discarded';
  for (const role of ['finance', 'caregiver']) { const email = 'deadline-browser-' + role + '@example.test'; await post('users', { email, password, name: '合成期限' + role, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) }); const context = await browser.newContext(); contexts.push(context); const login = await context.request.post(base + '/api/login', { headers: { Origin: base }, data: { email, password } }); assert.equal(login.status(), 200); const auth = await login.json(), tab = await context.newPage(); observe(tab); await tab.goto(base + '/#/'); await tab.waitForLoadState('networkidle'); assert.equal(await tab.locator('[data-route="/contract-deadlines"]').count(), 0); await readOnly(async () => request('GET', route(replacement), undefined, 403, { context, auth, org: admin.org })); }
  await page.setViewportSize({ width: 1440, height: 1000 }); await load(); await create(parents[2], '合成晚回應已提交提醒'); let release, arrive; const arrived = new Promise(resolve => { arrive = resolve; }), released = new Promise(resolve => { release = resolve; });
  const late = async routeHandle => { if (routeHandle.request().method() !== 'POST') return routeHandle.continue(); const response = await routeHandle.fetch(); assert.equal(response.status(), 201); arrive(await response.json()); await released; try { await routeHandle.fulfill({ response }); } catch {} };
  await page.route(base + route(), late); await createModal().getByRole('button', { name: '儲存人工提醒', exact: true }).click(); const committed = await arrived;
  await page.goto(base + '/#/'); await page.getByRole('heading', { name: '今日服務工作台', exact: true }).waitFor(); release(); await page.unroute(base + route(), late); await settle();
  assert.equal(await page.locator('dialog[open]').count(), 0); assert(!(await page.textContent('main')).includes('合成晚回應已提交提醒')); assert.equal((await request('GET', route(committed.item))).item.version, 1); mark(stage);
  assert.equal(nativeDialogs.length, 0); assert.equal(pageErrors.length, 0);
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ passed: true, scope: 'synthetic-local-contract-deadline-reminder-workflow', base, checks, screenshots, mutations, nativeDialogs, pageErrors, note: 'Screenshots require actual view_image review; no production or legal deadline claim.' }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await writeFile(path.join(output, 'failure-dom.html'), await page.content()).catch(() => {});
    await writeFile(path.join(output, 'failure-visible-text.txt'), await page.locator('body').innerText()).catch(() => {});
    await page.screenshot({ path: path.join(output, 'failure-screen.png'), fullPage: false }).catch(() => {});
  }
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ passed: false, stage, error: error.stack, checks, screenshots, mutations, nativeDialogs, pageErrors }, null, 2)); throw error;
}
finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); await browser?.close(); app.close(); }
