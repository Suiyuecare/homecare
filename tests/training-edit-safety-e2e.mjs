import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

// Synthetic data, actual browser/API and a random port. Never opens the disk database.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/training-edit-safety-qa/new-browser-work');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [], confirmationChecks = [], payloadChecks = [];
const password = 'synthetic-training-edit-safety-password';
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: [403, 404, 409, 422, 503].includes(response.status()) });
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
const frameControl = async control => {
  await control.evaluate(n=>n.scrollIntoView({block:'center'}));
  assert.ok(await control.evaluate(n=>{const r=n.getBoundingClientRect(),f=n.closest('dialog')?.querySelector('.dialog-footer')?.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&(!f||r.bottom<=f.top+1);}), 'Evidence control is fully within viewport above fixed actions');
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

const readSegments = [], fixtureNotes = [], invalidationChecks = [], writeSegments = [];
const entity = 'employee-training', title = '訓練版本歷程';
const readOnly = async (label, work) => { const before = counts(), raw = rawState(); assert.equal(Object.keys(raw).length, 11); await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); readSegments.push({ label, all11TablesUnchanged: true, before, after: counts() }); };
const written = async (label, work) => { const before = counts(); const result = await work(); writeSegments.push({ label, before, after: counts() }); return result; };
const delayRoute = async (page, pattern) => { const arrived = deferred(), release = deferred(), handled = deferred(); await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (e) { if (!/closed|cancel|abort|disposed|already handled/i.test(e.message)) throw e; } finally { handled.resolve(); } }); return { arrived, release, handled }; };
const bounded = (promise, label, milliseconds = 15000) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); timer.unref(); })]);
const queryTokens = new Map();
const findItem = async (page, item) => {
  await load(page, '/training', '教育訓練');
  const q=queryTokens.get(item.id)||item.name, search=page.getByLabel('搜尋訓練',{exact:true});
  await search.fill(q);await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/employee-training'&&new URL(r.url()).searchParams.get('q')===q),search.press('Enter')]);
  await page.waitForFunction(()=>document.querySelectorAll('.list-content tbody tr').length===1);
  return page.locator('.list-content tbody tr').getByRole('button',{name:'版本歷程',exact:true});
};
const input=(dialog,name)=>dialog.locator(`[name="${name}"]`);
const intent=(dialog,name)=>input(dialog,`${name}Intent`);
const editItem=async(page,item)=>{await findItem(page,item);await page.locator('.list-content tbody tr').getByRole('button',{name:'編輯',exact:true}).click();return page.getByRole('dialog',{name:'編輯訓練',exact:true});};
const statusVerb=action=>action==='恢復完成'?'恢復完成紀錄':'取消訓練紀錄';
const statusItem=async(page,item,action=item.status==='cancelled'?'恢復完成':'取消紀錄')=>{await findItem(page,item);await page.locator('.list-content tbody tr').getByRole('button',{name:action,exact:true}).click();return page.getByRole('dialog',{name:statusVerb(action),exact:true});};
const noUnsafe=async dialog=>{assert.ok(!/NEVER_RENDER|unsafe_source|billingSnapshot|deliveryReceipt|readReceipt|sourceMarker/.test(await dialog.innerHTML()),'Unsafe source values/keys do not enter input, help, placeholders, attributes or hidden form markup');assert.equal(await dialog.locator('script,img,iframe').count(),0);};
const alertVisible=async d=>{await d.locator('[role="alert"]:visible').waitFor();};
const discard = async page => { await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click(); const confirm=page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true}); if(await confirm.count()) await confirm.getByRole('button',{name:'放棄修改',exact:true}).click(); await page.getByRole('dialog').waitFor({state:'detached'}); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Frozen contract: docs/TRAINING_EDIT_SAFETY_SCOPE.md.
const openCard = async (dialog, version) => { const c=versionCard(dialog,version); if(!await c.evaluate(n=>n.open))await c.locator(':scope > summary').click(); return c; };
const snapshot = async card => { const s=card.locator('.history-snapshot'); if(!await s.evaluate(n=>n.open))await card.getByText('完整保存欄位',{exact:true}).click(); return s; };
const assertNoSecrets = async locator => { assert.ok(!/NEVER_RENDER|INTERNAL_FILE_ID|billingSnapshot|deliveryReceipt|readReceipt/.test(await locator.textContent())); assert.equal(await locator.locator('script,img,iframe').count(),0); };
try {
  const initialCounts = counts();
  base = await app.listen();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const admin = await written('normal-admin-organization-setup', async () => {
    const response = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: {
      name: '合成訓練管理員', email: 'training-edit-admin@example.test', password, organizationName: '合成訓練甲機構',
    } });
    assert.equal(response.status(), 201); return response.json();
  });
  const orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, actor = { client: context, auth: admin }, org = orgId, extraHeaders = {}) => {
    const response = await actor.client.request.fetch(`${base}/api/${route}`, { method, headers: {
      Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': actor.auth.csrfToken, ...extraHeaders,
    }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body;
  };
  const post = async (kind, data, actor, org) => (await request('POST', kind, data, 201, actor, org)).item;
  const patch = async (kind, item, data, actor) => (await request('PATCH', `${kind}/${item.id}`, { version: item.version, ...data }, 200, actor)).item;
  const get = async (kind, item, actor) => (await request('GET', `${kind}/${item.id}`, undefined, 200, actor)).item;
  const history = (item, actor, compare = true) => request('GET', `${entity}/${item.id}/history${compare ? '?compare=previous' : ''}`, undefined, 200, actor);
  const businessKeys = ['employeeId', 'name', 'category', 'provider', 'date', 'trainingMinutes', 'status', 'note'];
  const controls = ['employeeId', 'name', 'category', 'provider', 'date', 'trainingHours', 'note'];
  const projection = item => Object.fromEntries(businessKeys.filter(key => Object.hasOwn(item, key)).map(key => [key, structuredClone(item[key])]));
  const page = await context.newPage(); observe(page);
  let employeeA, employeeB, inactiveEmployee, service, careCase, plan, completedShift, record, approved,
    fees, payroll, caseAttachment, certAttachment, attachmentParent, otherOrg, foreign;
  const users = {};
  const dataFor = (code, extra = {}) => ({ employeeId: employeeA.id, name: code, category: 'in_service', provider: '合成辦訓單位',
    date: '2026-06-01', trainingMinutes: 75, status: 'completed', note: '合成訓練紀錄，不認定正式積分。', ...extra });
  await written('validated-users-approved-billing-and-two-nonempty-blobs', async () => {
    employeeA = await post('employees', { name: '合成訓練甲員工', employeeNo: 'TSE-EMP-A', hourlyRateCents: 23456 });
    employeeB = await post('employees', { name: '合成訓練乙員工', employeeNo: 'TSE-EMP-B' });
    inactiveEmployee = await post('employees', { name: '合成停用員工', employeeNo: 'TSE-INACTIVE', status: 'inactive' });
    for (const role of ['supervisor', 'finance', 'caregiver']) users[role] = await post('users', { name: `合成訓練${role}`,
      email: `training-edit-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    service = await post('service-items', { code: 'TSE-BILLING', name: '合成既有服務項目', minutes: 60, unitPriceCents: 12345, status: 'active' });
    careCase = await post('cases', { name: '合成費薪基準個案', caseNo: 'TSE-CASE' });
    plan = await post('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
    completedShift = await post('shifts', { caseId: careCase.id, employeeId: employeeA.id, carePlanId: plan.id, date: '2026-10-20',
      startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 2 }] });
    record = await post('service-records', { shiftId: completedShift.id, caseId: careCase.id, employeeId: employeeA.id, date: completedShift.date,
      actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: service.id, quantity: 2 }], status: 'submitted' });
    record = (await request('POST', `service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱基準' })).item;
    approved = structuredClone(record); completedShift = await get('shifts', completedShift);
    fees = await request('GET', 'reports/fees?month=2026-10'); payroll = await request('GET', 'reports/payroll?month=2026-10');
    caseAttachment = await post('case-attachments/upload', { caseId: careCase.id, title: '合成既有個案檔案', category: 'general', ...filePayload(PDF_BYTES) });
    attachmentParent = await post('employee-certifications', { employeeId: employeeA.id, name: '合成既有證照', issuedOn: '2026-01-01' });
    certAttachment = await post('certification-attachments/upload', { certificationId: attachmentParent.id, title: '合成既有證照檔案', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
    otherOrg = await post('organizations', { name: '合成訓練乙機構' });
    const foreignEmployee = await post('employees', { name: '合成外機構員工', employeeNo: 'TSE-FOREIGN-E' }, undefined, otherOrg.id);
    foreign = await post(entity, dataFor('TSE-FOREIGN', { employeeId: foreignEmployee.id }), undefined, otherOrg.id);
  });
  const login = async role => written(`real-${role}-session`, async () => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `training-edit-${role}@example.test`, password } });
    assert.equal(response.status(), 200); const auth = await response.json(), actorPage = await client.newPage(); observe(actorPage);
    return { client, auth, page: actorPage };
  });
  const supervisor = await login('supervisor'), finance = await login('finance'), caregiver = await login('caregiver');
  const openNew = async p => { await load(p, '/training', '教育訓練'); await p.getByRole('button', { name: '新增訓練', exact: true }).click(); return p.getByRole('dialog', { name: '新增訓練', exact: true }); };
  const saveWithPayload = async (p, item) => {
    const method = item ? 'PATCH' : 'POST', pathname = `/api/${entity}${item ? `/${item.id}` : ''}`;
    const pending = p.waitForRequest(r => new URL(r.url()).pathname === pathname && r.method() === method);
    await saveDialog(p); const body = (await pending).postDataJSON();
    assert.equal(Object.hasOwn(body, 'trainingHours'), false); assert.ok(!Object.keys(body).some(key => key.endsWith('Intent')));
    if (item) assert.equal(Object.hasOwn(body, 'employeeId'), false);
    payloadChecks.push({ method, keys: Object.keys(body).sort(), itemId: item?.id || null }); return body;
  };
  const assertNoSuccess = async p => assert.equal(await p.locator('.toast').filter({ hasText: /訓練紀錄已儲存|已取消訓練紀錄|已恢復完成紀錄/ }).count(), 0);
  const resetPage = async () => { await page.reload(); await page.waitForLoadState('networkidle'); };
  const imported = (code, overrides = {}, omit = []) => {
    const data = dataFor(code, { sourceMarker: code, ...overrides }); for (const key of omit) delete data[key];
    const time = now(), item = { ...data, id: id(), orgId, version: 1, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, orgId, entity, JSON.stringify(data), 1, time, time);
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, item.id, 1, JSON.stringify(item), time, 'baseline');
    queryTokens.set(item.id, code); return item;
  };
  const membershipBefore = app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all();

  let main = await written('admin-real-UI-eight-fields-name-normalization', async () => {
    const d = await openNew(page);
    assert.equal(await input(d, 'employeeId').inputValue(), ''); assert.equal(await input(d, 'status').count(), 0);
    assert.equal(await d.locator('[name$="Intent"]').count(), 0);
    for (const key of ['name', 'provider', 'note']) assert.equal(await input(d, key).inputValue(), '');
    assert.equal(await input(d, 'category').inputValue(), 'in_service'); assert.equal(await input(d, 'trainingHours').inputValue(), '1');
    assert.equal(await input(d, 'date').inputValue(), await page.evaluate(async () => { const { today } = await import('/ui.js'); return today(); }));
    assert.equal(await input(d, 'trainingHours').getAttribute('type'), 'number');
    assert.equal(await input(d, 'trainingHours').getAttribute('step'), '0.25');
    assert.equal(Number(await input(d, 'trainingHours').getAttribute('min')), 1 / 60);
    assert.equal(await input(d, 'trainingHours').getAttribute('max'), '1000');
    await input(d, 'employeeId').selectOption(employeeA.id); await input(d, 'name').fill('  TSE-MAIN 合成訓練　');
    await input(d, 'provider').fill('  合成辦訓單位　'); await input(d, 'date').fill('2026-06-01');
    await input(d, 'trainingHours').fill('1.25'); await input(d, 'note').fill(' 合成第一行\n第二行 <script>文字</script>　\n ');
    await inspectLayout(page); await screenshot(page, 'training-editor-create-desktop.png');
    const body = await saveWithPayload(page); assert.deepEqual(Object.keys(body).sort(), businessKeys.toSorted());
    assert.equal(body.status, 'completed'); assert.equal(body.name, 'TSE-MAIN 合成訓練'); assert.equal(body.provider, '  合成辦訓單位　'); assert.equal(body.trainingMinutes, 75);
    const item = (await request('GET', `${entity}?q=TSE-MAIN`)).items[0]; queryTokens.set(item.id, 'TSE-MAIN'); assert.deepEqual(projection(item), body); return item;
  });
  main = await written('supervisor-real-UI-six-fields-and-revert', async () => {
    const d = await editItem(supervisor.page, main); assert.ok(await input(d, 'employeeId').isDisabled()); assert.equal(await intent(d, 'employeeId').count(), 0);
    assert.equal(await input(d, 'status').count(), 0); assert.equal(await input(d, 'trainingHours').inputValue(), '1.25');
    await input(d, 'name').fill('  TSE-MAIN 督導更正　'); await input(d, 'category').selectOption('pre_service');
    await input(d, 'provider').fill('暫時更正'); await input(d, 'provider').fill(main.provider);
    await input(d, 'date').fill('2026-06-02'); await input(d, 'trainingHours').fill('2.5'); await input(d, 'note').fill('督導備註\n完整 LF');
    assert.deepEqual(await saveWithPayload(supervisor.page, main), { name: 'TSE-MAIN 督導更正', category: 'pre_service', date: '2026-06-02', trainingMinutes: 150, note: '督導備註\n完整 LF', version: 1 });
    return get(entity, main);
  });
  await readOnly('normal-prefill-fixed-parent-cancel-exact-actors', async () => {
    const d = await editItem(page, main); for (const key of controls) assert.equal(await input(d, key).inputValue(), key === 'trainingHours' ? String(main.trainingMinutes / 60) : main[key]);
    await discard(page); const result = await history(main); assert.deepEqual(result.items.map(row => row.actor.id), [users.supervisor.id, admin.user.id]);
    assert.deepEqual(app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(), membershipBefore);
  });
  main = await written('unchanged-version-only-PATCH', async () => { await editItem(page, main); assert.deepEqual(await saveWithPayload(page, main), { version: 2 }); return get(entity, main); });
  mark('真管理者八欄新增與督導六欄修改；新name trim、LF、未改或改回省略、員工固定及精確actor');

  const minuteItems = [];
  for (const minutes of [1, 7, 61, 75, 150, 60000]) await written(`normal-${minutes}-minute-roundtrip`, async () => {
    let item = await post(entity, dataFor(`TSE-MINUTE-${String(minutes).padStart(5, '0')}`, { trainingMinutes: minutes }));
    const d = await editItem(page, item); const control = input(d, 'trainingHours');
    assert.equal(await control.inputValue(), String(minutes / 60)); assert.ok(await control.isEnabled()); assert.equal(await intent(d, 'trainingHours').count(), 0);
    await control.fill('2'); await control.fill(String(minutes / 60));
    if ([1, 61, 60000].includes(minutes)) await screenshot(page, `training-editor-${minutes}-minutes-precision.png`);
    assert.deepEqual(await saveWithPayload(page, item), { version: 1 }); item = await get(entity, item); assert.equal(item.trainingMinutes, minutes); minuteItems.push(item);
  });
  let tolerance = await written('normal-explicit-minute-conversions-and-original-tolerance', async () => {
    let item = await post(entity, dataFor('TSE-TOLERANCE', { trainingMinutes: 2 }));
    for (const [hours, minutes] of [[1 / 60, 1], [7 / 60, 7], [61 / 60, 61], [(75 + 5e-8) / 60, 75], [2.5, 150]]) {
      const d = await editItem(page, item); await input(d, 'trainingHours').fill(String(hours));
      assert.deepEqual(await saveWithPayload(page, item), { trainingMinutes: minutes, version: item.version });
      item = await get(entity, item); assert.equal(item.trainingMinutes, minutes);
    }
    const d = await editItem(page, item); await input(d, 'trainingHours').fill(String((150 + 5e-8) / 60));
    assert.deepEqual(await saveWithPayload(page, item), { version: item.version }); return get(entity, item);
  });
  mark('1/7/61/75/150/60000整數分鐘完整預填及改回省略；明確時數換算與原1e-7容差，不新增15分鐘倍數規則');

  let special = await written('normal-API-CRLF-year0000-and-seven-minutes', () => post(entity, dataFor('TSE-SPECIAL\r\n訓練', {
    provider: '合成辦訓\r\n單位', date: '0000-02-29', trainingMinutes: 7, note: '合成備註\r\n完整',
  }))); queryTokens.set(special.id, 'TSE-SPECIAL');
  special = await written('whole-CRLF-year0000-keep-no-coercion', async () => {
    const d = await editItem(page, special);
    for (const key of ['name', 'provider', 'date', 'note']) { assert.equal(await input(d, key).inputValue(), ''); assert.ok(await input(d, key).isDisabled()); assert.equal(await intent(d, key).inputValue(), 'keep'); }
    assert.equal(await input(d, 'trainingHours').inputValue(), String(7 / 60)); await noUnsafe(d);
    assert.ok(!(await d.innerHTML()).includes('合成辦訓')); await screenshot(page, 'training-editor-crlf-year0000-keep.png');
    assert.deepEqual(await saveWithPayload(page, special), { version: 1 }); const saved = await get(entity, special); assert.deepEqual(projection(saved), projection(special)); return saved;
  });
  special = await written('explicit-CRLF-replace-optional-clear-native-date', async () => {
    const d = await editItem(page, special);
    for (const [key, value] of [['name', '  TSE-SPECIAL-REPAIRED　'], ['date', '2026-03-01']]) { await intent(d, key).selectOption('replace'); await input(d, key).fill(value); }
    for (const key of ['provider', 'note']) await intent(d, key).selectOption('clear');
    await screenshot(page, 'training-editor-explicit-replace-clear.png');
    assert.deepEqual(await saveWithPayload(page, special), { name: 'TSE-SPECIAL-REPAIRED', provider: '', date: '2026-03-01', note: '', version: special.version }); return get(entity, special);
  });
  let spaced = await written('import-old-name-spacing-and-compatible-overlong', async () => imported('TSE-SPACED', { name: '  TSE-SPACED 原名稱　', provider: '辦'.repeat(501) }));
  spaced = await written('old-name-overlong-unmodified-not-trimmed', async () => {
    const d = await editItem(page, spaced); assert.equal(await input(d, 'name').inputValue(), spaced.name); assert.equal(await input(d, 'provider').inputValue(), spaced.provider);
    await input(d, 'note').fill('合成僅改備註'); assert.deepEqual(await saveWithPayload(page, spaced), { note: '合成僅改備註', version: 1 });
    const saved = await get(entity, spaced); assert.equal(saved.name, spaced.name); assert.equal(saved.provider, spaced.provider); return saved;
  });
  let typed, missingNote, nullNote, missingProvider, missingParent, badDate, badName, inactiveTraining;
  const requiredRepairs = [];
  await written('explicit-INSERT-only-unsafe-missing-imports', async () => {
    typed = imported('TSE-TYPED', { provider: { unsafe_source: 'NEVER_RENDER_PROVIDER' }, note: ['NEVER_RENDER_NOTE'] });
    missingNote = imported('TSE-ABSENT-NOTE', {}, ['note']); nullNote = imported('TSE-NULL-NOTE', { note: null });
    missingProvider = imported('TSE-ABSENT-PROVIDER', {}, ['provider']); missingParent = imported('TSE-ORPHAN', { employeeId: id() });
    badDate = imported('TSE-INVALID-DATE', { date: { unsafe_source: 'NEVER_RENDER_DATE' } });
    badName = imported('TSE-INVALID-NAME', { name: { unsafe_source: 'NEVER_RENDER_NAME' } });
    requiredRepairs.push({ item: badDate, control: 'date', value: '2026-01-01' }, { item: badName, control: 'name', value: 'TSE-INVALID-NAME-REPAIRED' });
    for (const [token, category] of [['PROTO', '__proto__'], ['CONSTRUCTOR', 'constructor'], ['OBJECT', { unsafe_source: 'NEVER_RENDER_CATEGORY' }]]) {
      requiredRepairs.push({ item: imported(`TSE-CATEGORY-${token}`, { category }), control: 'category', value: 'other' });
    }
    for (const [token, trainingMinutes] of [['NULL', null], ['TEXT', '61'], ['ZERO', 0], ['ARRAY', ['NEVER_RENDER_MINUTES']]]) {
      requiredRepairs.push({ item: imported(`TSE-MINUTES-${token}`, { trainingMinutes }), control: 'trainingHours', value: '1.25' });
    }
    requiredRepairs.push({ item: imported('TSE-MINUTES-ABSENT', {}, ['trainingMinutes']), control: 'trainingHours', value: '1.25' });
  });
  typed = await written('optional-typed-retained-with-other-edit', async () => {
    const d = await editItem(page, typed); await noUnsafe(d);
    for (const key of ['provider', 'note']) { assert.equal(await input(d, key).inputValue(), ''); assert.ok(await input(d, key).isDisabled()); }
    await input(d, 'category').selectOption('other'); await screenshot(page, 'training-editor-typed-keep.png');
    assert.deepEqual(await saveWithPayload(page, typed), { category: 'other', version: 1 }); const saved = await get(entity, typed);
    assert.deepEqual(saved.provider, typed.provider); assert.deepEqual(saved.note, typed.note); return saved;
  });
  for (const item of [missingNote, nullNote, missingProvider]) await written(`own-presence-retained-${queryTokens.get(item.id)}`, async () => {
    const d = await editItem(page, item); await input(d, 'date').fill('2026-07-01');
    assert.deepEqual(await saveWithPayload(page, item), { date: '2026-07-01', version: 1 }); const saved = await get(entity, item);
    for (const key of ['note', 'provider']) { assert.equal(Object.hasOwn(saved, key), Object.hasOwn(item, key)); if (Object.hasOwn(item, key)) assert.deepEqual(saved[key], item[key]); }
  });
  await readOnly('missing-parent-required-merged422-and-safe-list-projections', async () => {
    for (const { item, control } of [{ item: missingParent, control: 'employeeId' }, ...requiredRepairs]) {
      await findItem(page, item); const row = page.locator('.list-content tbody tr');
      if (control === 'trainingHours') assert.equal(await row.getByRole('cell').nth(5).textContent(), '—', 'Invalid minutes never coerced to a valid duration');
      if (control === 'category') assert.equal(await row.getByRole('cell').nth(2).textContent(), typeof item.category === 'string' ? item.category : '未提供');
      if (item.category === '__proto__') await screenshot(page, 'training-editor-unknown-category-literal-list.png');
      await row.getByRole('button', { name: '編輯', exact: true }).click(); const d = page.getByRole('dialog', { name: '編輯訓練', exact: true });
      assert.equal(await input(d, control).inputValue(), ''); assert.ok(await input(d, control).isDisabled()); await noUnsafe(d);
      if (control === 'employeeId') { assert.equal(await intent(d, control).count(), 0); await d.getByText('所屬員工無法在目前可讀選項中表示；保留原歸屬且不可在此更換。', { exact: true }).waitFor(); }
      else assert.equal(await intent(d, control).inputValue(), 'keep');
      const response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/${entity}/${item.id}` && r.request().method() === 'PATCH');
      await d.getByRole('button', { name: '儲存', exact: true }).click(); assert.equal((await response).status(), 422); await alertVisible(d);
      if (control !== 'employeeId') assert.ok(await intent(d, control).isEnabled());
      if ([missingParent, badDate, badName].some(row => row.id === item.id) || item.category === '__proto__' || item.trainingMinutes === null)
        await screenshot(page, `training-editor-${queryTokens.get(item.id).toLowerCase()}-original422.png`);
      if (control === 'trainingHours') assert.equal(await input(d, control).getAttribute('aria-invalid'), 'true', 'Original trainingMinutes error is aliased to hours');
      await discard(page);
    }
  });
  inactiveTraining = await written('inactive-readable-employee-create-selected-filter', async () => {
    await load(page, '/training', '教育訓練'); await page.getByLabel('員工篩選', { exact: true }).selectOption(inactiveEmployee.id); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '新增訓練', exact: true }).click(); const d = page.getByRole('dialog', { name: '新增訓練', exact: true });
    assert.equal(await input(d, 'employeeId').inputValue(), inactiveEmployee.id); await input(d, 'name').fill('TSE-INACTIVE-TRAINING'); await input(d, 'date').fill('2026-01-01');
    await screenshot(page, 'training-editor-inactive-parent-create.png'); const body = await saveWithPayload(page); assert.equal(body.employeeId, inactiveEmployee.id);
    assert.equal(body.trainingMinutes, 60); return (await request('GET', `${entity}?q=TSE-INACTIVE-TRAINING`)).items[0];
  });
  await readOnly('employee-immutable-API-and-disabled-native-control', async () => {
    await request('PATCH', `${entity}/${main.id}`, { version: main.version, employeeId: employeeB.id }, 409);
    const d = await editItem(page, main); assert.ok(await input(d, 'employeeId').isDisabled()); assert.equal(await intent(d, 'employeeId').count(), 0); await discard(page);
  });
  mark('合法CRLF/0000保全；optional異型/own-presence不猜值，unknown分類與非法分鐘原422可見、固定缺父不fallback，停用員工可明確新增');

  let race = await written('normal-CAS-fixture', () => post(entity, dataFor('TSE-CAS')));
  const stale = await editItem(page, race); await input(stale, 'note').fill('合成使用者未保存備註');
  race = await written('real-supervisor-competitor', () => patch(entity, race, { note: '合成競爭保存' }, supervisor));
  await readOnly('CAS-and-required-length-minutes-CSRF', async () => {
    await stale.getByRole('button', { name: '儲存', exact: true }).click(); await stale.getByText('資料已更新，請重新讀取', { exact: true }).waitFor();
    assert.equal(await input(stale, 'note').inputValue(), '合成使用者未保存備註'); await screenshot(page, 'training-editor-CAS409.png'); await discard(page);
    const d = await editItem(page, race);
    for (const [key, value] of [['name', '　 '], ['name', '字'.repeat(501)], ['provider', '字'.repeat(501)], ['note', '字'.repeat(10001)],
      ['trainingHours', ''], ['trainingHours', '0'], ['trainingHours', '1000.1'], ['trainingHours', '1.001'], ['trainingHours', String((75 + 2e-7) / 60)]]) {
      await input(d, key).fill(value); await d.getByRole('button', { name: '儲存', exact: true }).click(); await alertVisible(d);
      assert.equal(await input(d, key).inputValue(), value); if (key === 'trainingHours') assert.equal(await input(d, key).getAttribute('aria-invalid'), 'true');
      if (value === '1.001') await screenshot(page, 'training-editor-fractional-minute-rejected.png');
      await input(d, key).fill(key === 'trainingHours' ? String(race.trainingMinutes / 60) : race[key]);
    }
    await discard(page); await request('PATCH', `${entity}/${race.id}`, { version: race.version, note: 'CSRF rejected' }, 403, undefined, orgId, { 'X-CSRF-Token': 'synthetic-invalid' });
  });
  mark('真CAS/CSRF、名稱必填與新送長度、空白/0/超界/非整數分鐘拒絕，錯誤保留輸入且零寫');

  let retry = await written('retry-normal-API-CRLF-fixture', () => post(entity, dataFor('TSE-RETRY', { provider: '合成單位\r\n保持', note: '合成原CRLF\r\n保持' })));
  await readOnly('403-minute-field422-503-lock-restore-and-exact-input', async () => {
    const d = await editItem(page, retry); await intent(d, 'note').selectOption('replace'); await input(d, 'note').fill('合成明確新備註\nLF保持'); await input(d, 'trainingHours').fill('2.5');
    const pattern = `**/api/${entity}/${retry.id}`;
    for (const status of [403, 422, 503]) {
      await page.route(pattern, r => r.request().method() === 'PATCH' ? r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: {
        message: `合成${status}失敗`, ...(status === 422 ? { fields: { trainingMinutes: '合成分鐘欄位錯誤' } } : {}),
      } }) }) : r.continue());
      await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.getByText(status === 422 ? '合成分鐘欄位錯誤' : `合成${status}失敗`, { exact: true }).waitFor();
      assert.equal(await input(d, 'note').inputValue(), '合成明確新備註\nLF保持'); assert.equal(await input(d, 'trainingHours').inputValue(), '2.5');
      if (status === 422) { assert.ok(await input(d, 'trainingHours').evaluate(n => n === document.activeElement)); await screenshot(page, 'training-editor-minute422-focus.png'); }
      await page.unroute(pattern);
    }
    const arrived = deferred(), release = deferred(), handled = deferred();
    await page.route(pattern, async r => { if (r.request().method() !== 'PATCH') return r.continue(); arrived.resolve(); await release.promise;
      await r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成延遲503' } }) }); handled.resolve(); });
    const submit = await d.getByRole('button', { name: '儲存', exact: true }).elementHandle(); await submit.click(); await bounded(arrived.promise, 'busy PATCH arrival');
    assert.ok(await submit.isDisabled()); assert.ok(await d.locator('input,textarea,select').evaluateAll(nodes => nodes.every(n => n.disabled)));
    await d.getByRole('button', { name: '取消', exact: true }).click(); await page.keyboard.press('Escape'); assert.ok(await d.isVisible()); await screenshot(page, 'training-editor-busy-locked.png');
    release.resolve(); await bounded(handled.promise, 'busy response'); await d.getByText('合成延遲503', { exact: true }).waitFor();
    assert.ok(await input(d, 'note').isEnabled()); assert.ok(await input(d, 'trainingHours').isEnabled()); assert.ok(await input(d, 'provider').isDisabled());
    assert.equal(await intent(d, 'note').inputValue(), 'replace'); assert.equal(await intent(d, 'provider').inputValue(), 'keep');
    await screenshot(page, 'training-editor-503-preserved.png'); await page.unroute(pattern);
  });
  retry = await written('successful-retry-after-failure-original-intents', async () => {
    assert.deepEqual(await saveWithPayload(page, retry), { note: '合成明確新備註\nLF保持', trainingMinutes: 150, version: 1 }); return get(entity, retry);
  });
  mark('403/分鐘alias422/503保存intent與LF；pending鎖定、取消/Escape inert，失敗還原disabled與焦點後真重試');

  const confirmation = await written('eight-field-response-matrix-fixture', () => post(entity, dataFor('TSE-CONFIRM')));
  await readOnly('fake2xx-eight-field-values-presence-and-identity', async () => {
    const d = await editItem(page, confirmation); await input(d, 'note').fill('合成八欄待確認');
    const expected = { ...confirmation, version: 2, note: '合成八欄待確認' }, pattern = `**/api/${entity}/${confirmation.id}`;
    const mutations = [
      ['missing-item', () => ({})], ['array-item', () => ({ item: [] })], ['null-item', () => ({ item: null })],
      ['wrong-id', () => ({ item: { ...expected, id: id() } })], ['empty-id', () => ({ item: { ...expected, id: '' } })],
      ['wrong-org', () => ({ item: { ...expected, orgId: otherOrg.id } })], ['zero-version', () => ({ item: { ...expected, version: 0 } })],
      ['wrong-version', () => ({ item: { ...expected, version: 99 } })],
      ...businessKeys.map(key => [`wrong-${key}`, () => ({ item: { ...expected, [key]: '合成錯誤確認值' } })]),
      ...businessKeys.map(key => [`missing-own-${key}`, () => { const item = { ...expected }; delete item[key]; return { item }; }]),
    ];
    let listReads = 0; const listener = r => { if (r.method() === 'GET' && new URL(r.url()).pathname === `/api/${entity}`) listReads++; }; page.on('request', listener);
    for (const [label, make] of mutations) {
      await page.route(pattern, r => r.request().method() === 'PATCH' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(make()) }) : r.continue());
      await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.getByText('儲存結果未確認；請保留輸入並重新讀取確認。', { exact: true }).waitFor();
      assert.equal(await input(d, 'note').inputValue(), '合成八欄待確認'); await assertNoSuccess(page); await page.unroute(pattern);
      confirmationChecks.push({ operation: 'edit', label, submittedToServer: false, preserved: true });
    }
    assert.equal(listReads, 0); page.off('request', listener); await screenshot(page, 'training-editor-wrong-success.png'); await discard(page);
    const item = await get(entity, missingNote), f = await editItem(page, item), route = `**/api/${entity}/${item.id}`;
    await input(f, 'date').fill('2026-08-01');
    await page.route(route, r => r.request().method() === 'PATCH' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: { ...item, version: item.version + 1, date: '2026-08-01', note: null } }) }) : r.continue());
    await f.getByRole('button', { name: '儲存', exact: true }).click(); await f.getByText('儲存結果未確認；請保留輸入並重新讀取確認。', { exact: true }).waitFor();
    assert.equal(await intent(f, 'note').inputValue(), 'keep'); confirmationChecks.push({ operation: 'edit', label: 'omitted-note-became-own-null', submittedToServer: false, preserved: true });
    await page.unroute(route); await discard(page);
  });
  mark('不實2xx八欄精確值/own-presence/id/org/version全拒，保留表單且不success或refresh');

  let uncertain=await written('committed-PATCH-unknown-response-fixture',()=>post(entity,dataFor('TSE-UNCERTAIN')));
  await written('real-PATCH-commits-before-missing-response',async()=>{const d=await editItem(page,uncertain);await input(d,'note').fill('合成真已提交但回應缺失');const p=`**/api/${entity}/${uncertain.id}`;await page.route(p,async r=>{if(r.request().method()!=='PATCH')return r.continue();const response=await r.fetch();assert.equal(response.status(),200);await r.fulfill({response,body:'{}'});});await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('儲存結果未確認；請保留輸入並重新讀取確認。',{exact:true}).waitFor();assert.equal(await input(d,'note').inputValue(),'合成真已提交但回應缺失');await assertNoSuccess(page);await screenshot(page,'training-editor-committed-unconfirmed.png');await page.unroute(p);uncertain=await get(entity,uncertain);assert.equal(uncertain.version,2);});
  await readOnly('ambiguous-PATCH-retry-remains-CAS409',async()=>{const d=page.getByRole('dialog');await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('資料已更新，請重新讀取',{exact:true}).waitFor();assert.equal(await input(d,'note').inputValue(),'合成真已提交但回應缺失');await discard(page);});
  for(const mode of['AbortError','SyntaxError','missing-item'])await written(`real-POST-${mode}-same-key-retry`,async()=>{const d=await openNew(page),code=`TSE-POST-${mode}`;await input(d,'employeeId').selectOption(employeeA.id);await input(d,'date').fill('2026-01-12');await input(d,'name').fill(code);await input(d,'note').fill('合成同鍵保留\n第二行');const captures=[],capture=r=>{if(new URL(r.url()).pathname===`/api/${entity}`&&r.method()==='POST')captures.push({key:r.headers()['idempotency-key'],payload:r.postDataJSON()});};page.on('request',capture);
    if(mode==='missing-item')await page.route(`**/api/${entity}`,async r=>{if(r.request().method()!=='POST')return r.continue();const response=await r.fetch();assert.equal(response.status(),201);await r.fulfill({response,body:'{}'});});
    else await page.evaluate(mode=>{const original=window.fetch;let once=false;window.__restoreTrainingFetch=()=>{window.fetch=original;};window.fetch=async function(...args){const response=await original.apply(this,args),u=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);if(u.pathname==='/api/employee-training'&&args[1]?.method==='POST'&&!once){once=true;response.json=async()=>{if(mode==='AbortError')throw new DOMException('Synthetic success body interrupted','AbortError');throw new SyntaxError('Synthetic success JSON unreadable');};}return response;};},mode);
    await d.getByRole('button',{name:'儲存',exact:true}).click();await alertVisible(d);assert.equal(await input(d,'name').inputValue(),code);assert.equal(await input(d,'note').inputValue(),'合成同鍵保留\n第二行');await assertNoSuccess(page);const saved=(await request('GET',`${entity}?q=${code}`)).items;assert.equal(saved.length,1);assert.equal(saved[0].version,1);assert.equal(saved[0].status,'completed');const committed=counts();if(mode==='AbortError')await screenshot(page,'training-editor-post-body-abort.png');if(mode==='missing-item')await page.unroute(`**/api/${entity}`);else await page.evaluate(()=>window.__restoreTrainingFetch());await saveDialog(page);page.off('request',capture);assert.equal(captures.length,2);assert.ok(captures[0].key);assert.equal(captures[0].key,captures[1].key);assert.deepEqual(captures[0].payload,captures[1].payload);assert.deepEqual(counts(),committed);confirmationChecks.push({operation:'create',label:mode,submittedToServer:true,retrySameKey:true,retryAddedWrites:false});});mark('真已提交未知PATCH後CAS；POST本文Abort/Syntax/缺item三種同key重試零重複，abort不等於rollback');

  let statusRecord=await written('status-only-normal-fixture',()=>post(entity,dataFor('TSE-STATUS')));
  await readOnly('status-focus-and-all-eight-fields-confirmed',async()=>{let d=await statusItem(page,statusRecord);assert.ok(await d.getByRole('button',{name:'取消',exact:true}).evaluate(n=>n===document.activeElement));await page.keyboard.press('Escape');await d.waitFor({state:'detached'});assert.ok(await page.locator('.list-content tbody tr').getByRole('button',{name:'取消紀錄',exact:true}).evaluate(n=>n===document.activeElement));d=await statusItem(page,statusRecord);const p=`**/api/${entity}/${statusRecord.id}`;for(const key of businessKeys){const expected={...statusRecord,status:'cancelled',version:2,[key]:key==='status'?'completed':'合成漂移确认值'};await page.route(p,r=>r.request().method()==='PATCH'?r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({item:expected})}):r.continue());await d.getByRole('button',{name:'確認取消訓練紀錄',exact:true}).click();await d.getByText('儲存結果未確認；請保留輸入並重新讀取確認。',{exact:true}).waitFor();await assertNoSuccess(page);await page.unroute(p);confirmationChecks.push({operation:'status',label:`wrong-${key}`,submittedToServer:false,preserved:true});}await screenshot(page,'training-status-unconfirmed.png');await page.keyboard.press('Escape');const unsafe=await statusItem(page,badName);await noUnsafe(unsafe);await unsafe.getByText(/這筆訓練紀錄/).waitFor();await screenshot(page,'training-status-safe-typed-name.png');await page.keyboard.press('Escape');});
  for(const[actor,action,expected]of[[supervisor,'取消紀錄','cancelled'],[{client:context,auth:admin,page},'恢復完成','completed']])statusRecord=await written(`real-${expected}-status-only-with-actor`,async()=>{const d=await statusItem(actor.page,statusRecord,action),pending=actor.page.waitForRequest(r=>new URL(r.url()).pathname===`/api/${entity}/${statusRecord.id}`&&r.method()==='PATCH');await screenshot(actor.page,`training-status-${expected}-confirm.png`);await d.getByRole('button',{name:`確認${statusVerb(action)}`,exact:true}).click();await d.waitFor({state:'detached'});assert.deepEqual((await pending).postDataJSON(),{status:expected,version:statusRecord.version});const item=await get(entity,statusRecord);for(const k of businessKeys.filter(k=>k!=='status'))assert.deepEqual(item[k],statusRecord[k]);assert.equal(item.status,expected);assert.equal((await history(item)).items[0].actor.id,actor.auth.user.id);return item;});
  mark('取消與恢復真status-only及actor；八欄確認拒絕漂移、異型名稱不洩漏，不認定正式積分');
  let contextItem=await written('full-context-fixture',()=>post(entity,dataFor('TSE-CONTEXT')));
  await readOnly('edit-status-loaded-pending-six-context-matrix',async()=>{for(const operation of['edit','status'])for(const pending of[false,true])for(const mode of['hash','organization','user','role','employee','render']){
    console.log(`CONTEXT ${operation} ${pending?'pending':'loaded'} ${mode}`);const d=operation==='edit'?await editItem(page,contextItem):await statusItem(page,contextItem);if(operation==='edit')await input(d,'note').fill(`合成${mode}${pending?'pending':'loaded'}未保存`);const p=`**/api/${entity}/${contextItem.id}`,arrived=deferred(),release=deferred(),handled=deferred();let aborted,listener;
    if(pending){await page.route(p,async r=>{if(r.request().method()!=='PATCH')return r.continue();arrived.resolve();await release.promise;await r.abort('aborted').catch(()=>{});handled.resolve();});aborted=deferred();listener=r=>{if(new URL(r.url()).pathname===`/api/${entity}/${contextItem.id}`)aborted.resolve(r);};page.on('requestfailed',listener);const commit=await d.getByRole('button',{name:operation==='edit'?'儲存':'確認取消訓練紀錄',exact:true}).elementHandle();await commit.click();await bounded(arrived.promise,'context arrival');assert.ok(await commit.isDisabled());assert.equal(await commit.getAttribute('aria-busy'),'true');if(operation==='status')assert.ok(await d.getByRole('button',{name:'取消',exact:true}).isDisabled());else{assert.ok(await d.locator('input,select,textarea').evaluateAll(ns=>ns.every(n=>n.disabled)));await d.getByRole('button',{name:'取消',exact:true}).click();assert.ok(await d.isVisible());}await page.keyboard.press('Escape');assert.ok(await d.isVisible());if(mode==='hash')await screenshot(page,`training-${operation}-context-pending.png`);}
    if(mode==='hash')await page.evaluate(()=>{location.hash='/cases';});else if(mode==='organization')await page.evaluate(orgId=>{const s=document.querySelector('select#organization');s.value=orgId;s.dispatchEvent(new Event('change',{bubbles:true}));},otherOrg.id);else if(mode==='render')await page.evaluate(()=>window.dispatchEvent(new Event('session-updated')));else await page.evaluate(async({mode,employeeId,userId})=>{const{getContext,setContext}=await import('/ui.js');const c=structuredClone(getContext()),o=c.organizations.find(x=>x.id===c.organizationId);if(mode==='user')c.user.id=userId;else if(mode==='role')o.role='supervisor';else o.employeeId=employeeId;setContext(c,c.organizationId);document.body.append(document.createComment('synthetic-client-context-fixture'));},{mode,employeeId:employeeB.id,userId:users.supervisor.id});
    await page.getByRole('dialog').waitFor({state:'detached'});if(pending){release.resolve();await bounded(handled.promise,'context abort handler');const failed=await bounded(aborted.promise,'context requestfailed');assert.match(failed.failure()?.errorText||'',/abort|cancel|failed/i);page.off('requestfailed',listener);await page.unroute(p);}await page.waitForLoadState('networkidle');await settle(page);assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('[name="note"]').count(),0);await assertNoSuccess(page);invalidationChecks.push({operation,pending,mode,removed:true,noLateRevival:true,requestBlockedBeforeServer:pending,clientFixture:['user','role','employee'].includes(mode)});await resetPage();
  }});mark('edit/status loaded與pending各六種context共24失效，abort/清空且無晚成功或復活');
  for(const operation of['edit','status'])await written(`real-${operation}-commit-before-context-loss`,async()=>{contextItem=await get(entity,contextItem);const d=operation==='edit'?await editItem(page,contextItem):await statusItem(page,contextItem);if(operation==='edit')await input(d,'note').fill('合成伺服器已提交再切換');const p=`**/api/${entity}/${contextItem.id}`,arrived=deferred(),release=deferred(),handled=deferred();await page.route(p,async r=>{if(r.request().method()!=='PATCH')return r.continue();try{const response=await r.fetch();assert.equal(response.status(),200);arrived.resolve();await release.promise;await r.fulfill({response});}catch(e){if(!/closed|cancel|abort|disposed|already handled/i.test(e.message))throw e;}finally{handled.resolve();}});await d.getByRole('button',{name:operation==='edit'?'儲存':'確認取消訓練紀錄',exact:true}).click();await bounded(arrived.promise,'committed response arrival');const committed=await get(entity,contextItem);assert.equal(committed.version,contextItem.version+1);await page.evaluate(()=>{location.hash='/cases';});await page.getByRole('dialog').waitFor({state:'detached'});let lateListReads=0;const listener=r=>{if(r.method()==='GET'&&new URL(r.url()).pathname===`/api/${entity}`)lateListReads++;};page.on('request',listener);release.resolve();await bounded(handled.promise,'committed late response');await settle(page);await page.unroute(p);await assertNoSuccess(page);assert.equal(lateListReads,0);page.off('request',listener);contextItem=committed;await resetPage();});mark('兩個真server先提交晚回應：路由失效後不顯成功、不refresh舊頁；資料確已提交不假稱回滾');

  await readOnly('dirty-Escape-focus-native-intent-and-context',async()=>{await findItem(page,main);const trigger=page.locator('.list-content tbody tr').getByRole('button',{name:'編輯',exact:true});await trigger.focus();await page.keyboard.press('Enter');let d=page.getByRole('dialog');await page.keyboard.press('Escape');await d.waitFor({state:'detached'});assert.ok(await trigger.evaluate(n=>n===document.activeElement));await trigger.click();d=page.getByRole('dialog');await input(d,'note').fill('合成dirty尚未保存');await page.keyboard.press('Escape');const c=page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true});await c.waitFor();await screenshot(page,'training-editor-dirty-confirm.png');await c.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await input(d,'note').inputValue(),'合成dirty尚未保存');await discard(page);assert.ok(await trigger.evaluate(n=>n===document.activeElement));d=await editItem(page,main);await input(d,'note').fill('合成dirty失效');await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true}).waitFor();await page.evaluate(()=>{location.hash='/cases';});await page.waitForFunction(()=>document.querySelectorAll('dialog[open]').length===0);await assertNoSuccess(page);await screenshot(page,'training-editor-context-cleared.png');d=await editItem(page,await get(entity,nullNote));const choice=intent(d,'note');assert.equal(await choice.evaluate(n=>n.tagName),'SELECT');await choice.focus();await page.keyboard.press('Shift+Tab');assert.ok(await input(d,'trainingHours').evaluate(n=>n===document.activeElement));await page.keyboard.press('Tab');assert.ok(await choice.evaluate(n=>n===document.activeElement));await choice.selectOption('replace');assert.ok(await input(d,'note').isEnabled());await choice.selectOption('clear');assert.ok(await input(d,'note').isDisabled());await choice.selectOption('keep');assert.ok(await input(d,'note').isDisabled());await discard(page);});mark('dirty返回/放棄及context清除雙dialog；Enter/Escape/Tab焦點與native select三態，不宣稱OS popup鍵盤選值');

  // Required invalid imports are repaired through explicit normal writes before positive report checks.
  for (const { item, control, value } of requiredRepairs) await written(`explicit-import-repair-${queryTokens.get(item.id)}-before-reports`, async () => {
    const d = await editItem(page, item); await intent(d, control).selectOption('replace');
    if (control === 'category') await input(d, control).selectOption(value); else await input(d, control).fill(value);
    const key = control === 'trainingHours' ? 'trainingMinutes' : control, saved = control === 'trainingHours' ? 75 : value;
    assert.deepEqual(await saveWithPayload(page, item), { [key]: saved, version: 1 });
  });
  typed = await written('optional-typed-explicit-replace-and-clear', async () => {
    const d = await editItem(page, typed); await intent(d, 'provider').selectOption('replace'); await input(d, 'provider').fill(' 合成新辦訓單位　');
    await intent(d, 'note').selectOption('clear'); assert.deepEqual(await saveWithPayload(page, typed), { provider: ' 合成新辦訓單位　', note: '', version: typed.version }); return get(entity, typed);
  });
  const otherEmployeeTraining = await written('normal-other-readable-employee-training', () => post(entity, dataFor('TSE-EMP-B-TRAINING', { employeeId: employeeB.id })));
  const gapTraining = await written('explicit-INSERT-only-immutable-parent-gap-history', async () => {
    const data = dataFor('TSE-PARENT-GAP'), time = now(), recordId = id(), current = { ...data, id: recordId, orgId, version: 3, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, orgId, entity, JSON.stringify(data), 3, time, time);
    for (const version of [1, 2, 3]) {
      const saved = { ...current, version, ...(version === 2 ? { employeeId: employeeB.id, note: 'NEVER_RENDER_OTHER_PARENT_VERSION' } : {}) };
      app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, recordId, version, JSON.stringify(saved), time, 'baseline');
    }
    return current;
  });
  await readOnly('four-real-sessions-parent-scope-and-forbidden-writes', async () => {
    for (const actor of [{ client: context, auth: admin }, supervisor]) {
      assert.equal((await get(entity, main, actor)).id, main.id); assert.ok((await history(main, actor)).items.length >= 3);
      assert.equal((await get(entity, inactiveTraining, actor)).id, inactiveTraining.id);
      for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', `${entity}/${foreign.id}${suffix}`, undefined, 404, actor);
    }
    for (const suffix of ['', '/history', '/history?compare=previous']) {
      await request('GET', `${entity}/${main.id}${suffix}`, undefined, 403, finance);
      await request('GET', `${entity}/${otherEmployeeTraining.id}${suffix}`, undefined, 404, caregiver);
      await request('GET', `${entity}/${foreign.id}${suffix}`, undefined, 404, caregiver);
    }
    assert.equal((await get(entity, main, caregiver)).id, main.id); assert.ok((await history(main, caregiver)).items.length >= 3);
    for (const actor of [finance, caregiver]) {
      await request('POST', entity, dataFor('TSE-FORBIDDEN'), 403, actor);
      await request('PATCH', `${entity}/${main.id}`, { version: main.version, note: 'denied' }, 403, actor);
      await request('PATCH', `${entity}/${main.id}`, { version: main.version, status: 'cancelled' }, 403, actor);
    }
    for (const suffix of ['', '/export', '.csv']) {
      const url = `${base}/api/training-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`;
      for (const actor of [finance, caregiver]) {
        const response = await actor.client.request.get(url, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), actor === finance ? 403 : 200);
        if (actor === caregiver && suffix !== '.csv') assert.ok((await response.json()).rows.every(row => row.employeeId === employeeA.id));
      }
    }
    await finance.page.goto(`${base}/#/training`); await finance.page.waitForLoadState('networkidle');
    assert.equal(await finance.page.getByRole('heading', { name: '教育訓練', exact: true }).count(), 0);
    assert.equal(await finance.page.getByRole('link', { name: '訓練紀錄', exact: true }).count(), 0);
    assert.equal(await finance.page.getByRole('button', { name: /新增訓練|編輯|取消紀錄|恢復完成/ }).count(), 0);
    await screenshot(finance.page, 'training-editor-finance-no-entry.png');
    await load(caregiver.page, '/training', '教育訓練'); assert.equal(await caregiver.page.getByRole('button', { name: /新增訓練|編輯|取消紀錄|恢復完成/ }).count(), 0);
    assert.equal(await caregiver.page.getByRole('link', { name: '報表中心', exact: true }).count(), 0);
    await screenshot(caregiver.page, 'training-editor-caregiver-read-only.png');
    assert.deepEqual((await history(missingParent)).items, []); assert.equal((await get(entity, missingParent)).employeeId, missingParent.employeeId);
    for (const actor of [{ client: context, auth: admin }, supervisor, caregiver]) for (const compare of [false, true]) {
      const h = await history(gapTraining, actor, compare); assert.deepEqual(h.items.map(row => row.version), [3, 1]);
      assert.ok(!JSON.stringify(h).includes('NEVER_RENDER_OTHER_PARENT_VERSION'));
      if (compare) assert.deepEqual(h.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
    }
    const trigger = await findItem(page, gapTraining), dialog = await openHistory(page, trigger, title, 3);
    await assertNoSecrets(dialog); await screenshot(page, 'training-editor-parent-gap-history.png'); await closeHistory(page, trigger);
  });
  mark('四真session與固定父項逐版範圍：caregiver本人唯讀，finance及非writer拒絕；原缺父空歷程與精確缺版不跳');

  employeeA = await written('real-linked-employee-deactivation', () => patch('employees', employeeA, { status: 'inactive' }));
  await readOnly('active-caregiver-link-real-server403-not-client-fixture', async () => {
    await request('GET', entity, undefined, 403, caregiver); await request('GET', `${entity}/${main.id}/history?compare=previous`, undefined, 403, caregiver);
    assert.equal((await get(entity, main, supervisor)).id, main.id); assert.equal((await get(entity, main)).id, main.id);
  });
  employeeA = await written('real-linked-employee-restoration-with-current-name', () => patch('employees', employeeA, { status: 'active', name: '合成訓練甲員工目前名稱' }));
  await readOnly('restoration-not-rollback-and-history-current-name-original-minutes', async () => {
    assert.equal((await get(entity, main, caregiver)).id, main.id); assert.equal(employeeA.version, 3);
    const trigger = await findItem(page, main), dialog = await openHistory(page, trigger, title, main.version), card = await openCard(dialog, main.version);
    await snapshot(card); await card.getByText('目前名稱：' + employeeA.name, { exact: true }).waitFor();
    await card.getByText('150 分鐘', { exact: true }).waitFor(); await screenshot(page, 'training-editor-history-current-name-minutes.png'); await closeHistory(page, trigger);
    assert.deepEqual(await get('service-records', record), approved);
  });
  mark('真停用已連結員工使caregiver403，恢復是新版本；歷程目前名稱及原150分鐘不改核閱費薪快照');

  const pages = [];
  await written('normal-API-list28-history28-and-category-status-fixtures', async () => {
    for (let i = 1; i <= 28; i++) pages.push(await post(entity, dataFor(`TSE-PAGE-${String(i).padStart(2, '0')}`, {
      category: i % 3 === 0 ? 'other' : i % 3 === 1 ? 'pre_service' : 'in_service', status: i % 2 ? 'completed' : 'cancelled', note: `合成分頁第${i}筆`,
    })));
    for (let version = 2; version <= 28; version++) pages[0] = await patch(entity, pages[0], { note: `合成版本第${version}筆` });
  });
  await readOnly('existing-history-pagination-category-status-and-training-report', async () => {
    const trigger = await findItem(page, pages[0]), dialog = await openHistory(page, trigger, title, 28);
    assert.equal(await dialog.locator('.history-version').count(), 25); const boundary = await openCard(dialog, 4);
    await boundary.getByText('與第 3 版比較', { exact: true }).waitFor(); await boundary.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await screenshot(page, 'training-editor-history-page-boundary.png'); await dialog.getByRole('button', { name: '下一頁', exact: true }).click();
    await dialog.getByText('第 3 版', { exact: true }).waitFor(); assert.equal(await dialog.locator('.history-version').count(), 3); await closeHistory(page, trigger);
    await load(page, '/training', '教育訓練'); const search = page.getByLabel('搜尋訓練', { exact: true });
    await search.fill('TSE-PAGE-'); await search.press('Enter'); await page.waitForFunction(() => document.querySelectorAll('.list-content tbody tr').length === 25);
    await screenshot(page, 'training-editor-list-page-one.png'); await page.getByRole('button', { name: '下一頁', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.list-content tbody tr').length === 3); await screenshot(page, 'training-editor-list-page-two.png');
    await search.fill('不存在的合成訓練'); await search.press('Enter'); await page.getByText('沒有符合條件的紀錄，請調整篩選。', { exact: true }).waitFor();
    await search.fill('TSE-PAGE-'); await search.press('Enter'); await page.waitForLoadState('networkidle');
    for (const category of ['pre_service', 'in_service', 'other']) {
      const expected = pages.filter(row => row.category === category), response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/${entity}` && new URL(r.url()).searchParams.get('category') === category);
      await page.getByLabel('訓練類別篩選', { exact: true }).selectOption(category); const body = await (await response).json(); assert.equal(body.total, expected.length);
      await page.waitForFunction(count => document.querySelectorAll('.list-content tbody tr').length === count, expected.length);
    }
    const filterResponse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/${entity}` && new URL(r.url()).searchParams.get('category') === 'other' && new URL(r.url()).searchParams.get('status') === 'cancelled');
    await page.getByLabel('紀錄狀態', { exact: true }).selectOption('cancelled');
    assert.equal((await (await filterResponse).json()).total, pages.filter(row => row.category === 'other' && row.status === 'cancelled').length);
    await page.waitForLoadState('networkidle'); await screenshot(page, 'training-editor-category-status-AND-filter.png');
    const report = await request('GET', 'training-report/export?startDate=2026-01-01&endDate=2026-12-31');
    assert.deepEqual(Object.keys(report.totals), ['count']); assert.equal(report.total, report.rows.length);
    for (const item of [main, tolerance, statusRecord, ...minuteItems]) {
      const row = report.rows.find(row => row.trainingId === item.id); assert.ok(row);
      for (const key of ['name', 'provider', 'category', 'date', 'trainingMinutes', 'status', 'note']) assert.deepEqual(row[key], item[key]); assert.equal(row.version, item.version);
    }
    const certificateBefore = await get('employee-certifications', attachmentParent);
    await load(page, '/certifications', '員工證照'); await page.getByLabel('搜尋證照', { exact: true }).fill('合成既有證照'); await page.getByLabel('搜尋證照', { exact: true }).press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.list-content tbody tr').length === 1);
    await page.locator('.list-content tbody tr').getByRole('button', { name: '編輯', exact: true }).click();
    const certificateDialog = page.getByRole('dialog', { name: '編輯證照', exact: true }); assert.ok(await input(certificateDialog, 'employeeId').isDisabled());
    await discard(page); assert.deepEqual(await get('employee-certifications', attachmentParent), certificateBefore);
    await load(page, '/training', '教育訓練'); assert.equal(await page.getByRole('button', { name: '附件', exact: true }).count(), 0);
  });
  mark('原28版頁外前版、列表25+3及搜尋/分類/狀態AND保持；訓練報表原分鐘與latest版次、countonly及證照sibling保持');

  const longText = '  合成訓練備註長文開始\n' + Array.from({ length: 24 }, (_, index) => `第${index + 1}段：完整保存訓練備註、換行與全形空白　分鐘不等同法定積分或正式資格。`).join('\n') + '\n合成訓練備註長文結尾　';
  const longItem = await written('normal-API-long-note-year0000-one-minute-mobile-fixture', () => post(entity, dataFor('TSE-LONG', { note: longText, date: '0000-02-29', trainingMinutes: 1 })));
  await readOnly('desktop-mobile-fixed-parent-year0000-full-precision-and-true-note-end', async () => {
    const d = await editItem(page, longItem); assert.equal(await input(d, 'note').inputValue(), longText);
    assert.ok(await input(d, 'employeeId').isDisabled()); assert.ok(await input(d, 'date').isDisabled());
    assert.equal(await input(d, 'trainingHours').inputValue(), String(1 / 60));
    await inspectLayout(page); await frameControl(input(d, 'note')); await screenshot(page, 'training-editor-long-note-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 }); await input(d, 'employeeId').evaluate(n => n.scrollIntoView({ block: 'start' }));
    await inspectLayout(page); await screenshot(page, 'training-editor-mobile-top.png');
    await intent(d, 'date').evaluate(n => n.scrollIntoView({ block: 'center' })); await screenshot(page, 'training-editor-mobile-year0000-keep.png');
    await intent(d, 'date').selectOption('replace'); await input(d, 'date').fill('2026-01-01'); await screenshot(page, 'training-editor-mobile-date-replace.png');
    await frameControl(input(d, 'trainingHours')); await screenshot(page, 'training-editor-mobile-one-minute.png');
    await frameControl(input(d, 'note')); await screenshot(page, 'training-editor-long-note-mobile.png');
    await input(d, 'note').evaluate(n => { n.scrollTop = n.scrollHeight; });
    assert.ok(await input(d, 'note').evaluate(n => n.scrollTop + n.clientHeight >= n.scrollHeight - 1));
    assert.equal(await input(d, 'note').inputValue(), longText); await screenshot(page, 'training-editor-long-note-mobile-end.png');
    await inspectLayout(page); await discard(page); await page.setViewportSize({ width: 1440, height: 1050 });
    const f = await editItem(page, await get(entity, nullNote)); await page.setViewportSize({ width: 390, height: 844 });
    await intent(f, 'note').selectOption('replace'); await input(f, 'note').fill('合成明確新備註\n第二行'); await frameControl(input(f, 'note'));
    await screenshot(page, 'training-editor-mobile-note-replace.png'); await intent(f, 'note').selectOption('clear'); assert.ok(await input(f, 'note').isDisabled());
    await intent(f, 'note').evaluate(n => n.scrollIntoView({ block: 'center' })); await screenshot(page, 'training-editor-mobile-note-clear.png');
    await discard(page); await page.setViewportSize({ width: 1440, height: 1050 });
  });
  mark('1440/390七原生控件、固定員工、0000保持/明確日期及1分鐘完整時數；24段長文真正末段、clear可讀且整頁不溢出');

  fixtureNotes.push(
    'Only synthetic memory SQLite/random localhost/real Chromium. No actual 4310/data/original platform. Normal API legally saves interior CRLF, year0000 and integer 1/7/61 minutes. Nonstring/missing/null/unknown category/invalid minute/bad-reference/overlong/old-space values are explicit INSERT-only memory imports with matching immutable versions. Invalid required imports are repaired through separately accounted normal UI writes before positive reports. No UPDATE/DELETE immutable versions or BLOBs.',
    'Four real sessions verify server authorization. Finance training/list/history/report reads and all writes are forbidden. Caregiver reads only own training while employee link is active and has no report navigation. Real employee deactivation/restoration are writes and new versions, not rollback. Other user/role/employee invalidation scenarios mutate only synthetic client context, not server membership.',
    'Seven controls and eight private saved fields. Edit employeeId is immutable and never submitted; missing reference cannot be repaired here. New name uses backend trim, unchanged name is omitted. Optional absence/null/typed values remain private and are not guessed into empty strings. Only provider/note offer clear.',
    'trainingHours remains native number/min1/60/max1000/step0.25. Canonical noValidate does not enforce 15-minute multiples. Numeric prefill uses the full saved integer divided by60. Changed hours use the original Number(hours)*60/Math.round and <=1e-7 tolerance. Saved 1/7/61/75/150/60000-minute integers survive unchanged/reverted edits; private invalid minutes require keep/replace, never null-to-zero coercion. Minutes are not statutory training credits.',
    'Editor starts from list-row snapshot, not a fresh detail GET. Fake2xx matrix responses never fetch server. Actual committed unknown PATCH responses leave retry subject to CAS409. POST body AbortError/SyntaxError/missing-item scenarios really commit and retry the same idempotency key. Two separately accounted status/edit late responses prove abort is not rollback.',
    'Imported parent-gap history deliberately includes a version with another employee. All roles filter it from raw/compare and do not skip to an older visible version. This is an INSERT-only migration fixture, not a legal employee reassignment. Normal API reassignment remains EMPLOYEE_IMMUTABLE409.',
    'Enter/Escape/Tab/Shift+Tab and native selectOption semantics are checked. Headless native popup keyboard value selection not verified; OS-owned popup geometry not claimed. Screenshot visual review is agent review, not human UAT.',
    'No new PDF artifact or marker. Existing synthetic PDF_BYTES/PNG_BYTES create two nonempty BLOB fixtures only; training has no attachment panel. All eleven raw tables including BLOBs are compared separately from intentional writes. Current and exact-version downloads verify bytes and SHA256.'
  );
  const blobDownloads = [], reportEndpoints = [];
  await readOnly('eleven-tables-billing-two-blobs-and-31-report-outlets', async () => {
    assert.deepEqual(await get('service-records', record), approved);
    assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll);
    for (const [kind, item] of [['cases', careCase], ['care-plans', plan], ['service-items', service], ['employees', employeeA], ['employees', employeeB], ['employees', inactiveEmployee]]) assert.deepEqual(await get(kind, item), item);
    assert.deepEqual(app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(), membershipBefore);
    for (const kind of ['cases', 'shifts', 'services', 'fees', 'payroll']) for (const extension of ['', '.csv']) {
      const route = `reports/${kind}${extension}?month=2026-10`, response = await context.request.get(`${base}/api/${route}`, { headers: { 'X-Org-Id': orgId } });
      assert.equal(response.status(), 200); if (extension) assert.ok((await response.text()).startsWith('\uFEFF')); else assert.ok(Array.isArray((await response.json()).rows)); reportEndpoints.push(route);
    }
    for (const kind of ['shift-report', 'service-report', 'case-report', 'employee-report', 'leave-report', 'training-report', 'certification-report']) for (const extension of ['', '/export', '.csv']) {
      const query = kind === 'employee-report' ? '' : '?startDate=2026-01-01&endDate=2026-12-31' + (kind === 'certification-report' ? '&asOf=2026-10-09' : '');
      const route = `${kind}${extension}${query}`, response = await context.request.get(`${base}/api/${route}`, { headers: { 'X-Org-Id': orgId } });
      assert.equal(response.status(), 200, route); if (extension === '.csv') assert.ok((await response.text()).startsWith('\uFEFF')); else assert.ok(Array.isArray((await response.json()).rows)); reportEndpoints.push(route);
    }
    for (const [kind, item, bytes] of [['case-attachments', caseAttachment, PDF_BYTES], ['certification-attachments', certAttachment, PNG_BYTES]]) for (const exact of [false, true]) {
      const response = await context.request.get(`${base}/api/${kind}/${item.id}/download${exact ? '?recordVersion=' + item.version : ''}`, { headers: { 'X-Org-Id': orgId } });
      assert.equal(response.status(), 200); const actual = await response.body(); assert.deepEqual(actual, bytes); assert.equal(digest(actual), item.sha256);
      blobDownloads.push({ entity: kind, recordVersion: exact ? item.version : null, bytes: actual.length, sha256: digest(actual), matchesOriginal: true });
    }
  });
  assert.equal(invalidationChecks.length, 24); assert.equal(reportEndpoints.length, 31); assert.equal(Object.keys(rawState()).length, 11);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n, 6);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(response => !response.expected), []);
  assert.ok(consoleErrors.every(message => /403|404|409|422|503|ERR_FAILED|ERR_ABORTED/.test(message)), JSON.stringify(consoleErrors));
  const accountedChanges = writeSegments.reduce((sum, segment) => sum + segment.after.changes - segment.before.changes, 0);
  assert.equal(counts().changes - initialCounts.changes, accountedChanges);
  mark('完整11表raw/count/total_changes唯讀零寫；全部必要寫入對帳、6triggers/雙BLOB精確版/核閱費薪/31報表保持');
  await rm(path.join(output, 'failure.png'), { force: true });
  const sourceFiles = ['tests/training-edit-safety-e2e.mjs', 'src/server/history.mjs', 'src/server/model.mjs', 'src/server/personnel.mjs',
    'public/modules/personnel.js', 'public/data/training-editor.js', 'public/ui.js', 'public/styles.css'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(path.join(root, file)))])));
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version,
    scope: 'Synthetic memory SQLite/random localhost/real Chromium; no actual4310/data/original platform.', checks, screenshots, readSegments, writeSegments,
    initialCounts, finalCounts: counts(), accountedChanges, invalidationChecks, confirmationChecks, payloadChecks, fixtureNotes, blobDownloads, reportEndpoints,
    pageErrors, consoleErrors, failedResponses, all11TablesUnchangedDuringReads: true, blobTablesNonempty: { attachment_files: 1, certification_attachment_files: 1 },
    immutableTriggers: 6, approvedBillingSnapshotUnchanged: true, pdfOperations: 0, pdfMarkers: 0, sourceHashes, visualReviewPending: true }, null, 2));
  console.log(`Training edit safety E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version,
    checks, screenshots, pageErrors, consoleErrors, failedResponses, readSegments, writeSegments, invalidationChecks, confirmationChecks, payloadChecks, fixtureNotes,
    error: error.stack, pdfOperations: 0, pdfMarkers: 0 }, null, 2)); throw error;
} finally {
  for (const context of contexts) await context.close(); await browser?.close(); await app.close();
}
