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
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

// Own synthetic memory DB and random loopback server; never opens the default DB.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, 'outputs/software/contact-edit-safety-qa');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const installed = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [chromium.executablePath(), ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const entity = 'case-contacts', password = 'synthetic-contact-edit-browser-password';
const businessKeys = ['caseId', 'name', 'category', 'relationship', 'phone', 'alternatePhone', 'email', 'organization', 'status', 'note'];
const controlKeys = ['name', 'category', 'relationship', 'phone', 'alternatePhone', 'email', 'organization', 'note'];
const checks = [], readSegments = [], writeSegments = [], fixtureWrites = [], contextChecks = [], payloadChecks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], failedRequests = [], expectedFailures = [], contexts = [];
let base, browser, lastPage, stage = 'initialization';
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { sqliteInteger: item.toString() } : item);
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');
const same = (a, b, label) => assert.deepEqual(a, b, label);
const ownProjection = item => Object.fromEntries(businessKeys.map(key => [key, { present: Object.hasOwn(item, key), ...(Object.hasOwn(item, key) ? { value: item[key] } : {}) }]));
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return { schema, tables: Object.fromEntries(tables.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })) };
};
const counts = () => ({ totalChanges: app.db.prepare('SELECT total_changes() n').get().n, records: app.db.prepare('SELECT count(*) n FROM records').get().n, versions: app.db.prepare('SELECT count(*) n FROM record_versions').get().n, audit: app.db.prepare('SELECT count(*) n FROM audit').get().n, idempotency: app.db.prepare('SELECT count(*) n FROM idempotency').get().n });
const readOnly = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(); const result = await action();
  same(raw(), before, label + ': exact eleven tables and six triggers/schema'); same(counts(), beforeCounts, label + ': total_changes zero');
  readSegments.push({ label, tableCount: 11, triggerCount: 6, beforeSha256: sha(before), afterSha256: sha(raw()), beforeCounts, afterCounts: counts(), zeroWrites: true }); return result;
};
const fixtureWrite = async (label, action) => { stage = label; const before = counts(), result = await action(); fixtureWrites.push({ label, before, after: counts(), fixtureOnly: true }); return result; };
const actualWrite = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(); const result = await action(), after = raw(), afterCounts = counts();
  same(after.schema, before.schema);
  const oldRecords = new Map(before.tables.records.map(row => [row.id, row]));
  const changed = after.tables.records.filter(row => !oldRecords.has(row.id) || json(oldRecords.get(row.id)) !== json(row));
  assert.equal(changed.length, 1, label + ': exactly one target contact write');
  assert(result && typeof result.id === 'string'); assert.equal(changed[0].id, result.id, 'Changed raw row is exactly the acknowledged/contact-verified target');
  assert(changed.every(row => row.entity === entity), 'Only target contacts may change');
  const ids = new Set(changed.map(row => row.id));
  same(after.tables.records.filter(row => !ids.has(row.id)), before.tables.records.filter(row => !ids.has(row.id)), 'All other records exactly preserved');
  assert.equal(after.tables.records.length, before.tables.records.length + changed.filter(row => !oldRecords.has(row.id)).length, 'No record deletion');
  for (const table of Object.keys(before.tables).filter(name => !['records', 'record_versions', 'audit', 'idempotency'].includes(name))) same(after.tables[table], before.tables[table], table + ': unchanged including BLOBs/auth');
  for (const table of ['record_versions', 'audit', 'idempotency']) {
    same(after.tables[table].slice(0, before.tables[table].length), before.tables[table], table + ': original rows append-only');
    const appended = after.tables[table].slice(before.tables[table].length);
    if (table !== 'idempotency') assert(appended.every(row => row.entity === entity && ids.has(row.record_id)), table + ': target contact rows only');
    else assert(appended.every(row => row.route === 'POST /api/case-contacts'), 'Only contact creation ledger may append');
  }
  const creates = changed.filter(row => !oldRecords.has(row.id)).length, versionDelta = afterCounts.versions - beforeCounts.versions;
  assert.equal(afterCounts.records - beforeCounts.records, creates); assert.equal(afterCounts.audit - beforeCounts.audit, versionDelta);
  assert.equal(afterCounts.idempotency - beforeCounts.idempotency, creates, 'Each new UI contact has one ledger, PATCH has none');
  for (const row of changed) assert.equal(Number(row.version), oldRecords.has(row.id) ? Number(oldRecords.get(row.id).version) + 1 : 1, 'Each action changes each contact exactly once');
  assert.equal(versionDelta, changed.length);
  assert.equal(afterCounts.totalChanges - beforeCounts.totalChanges, versionDelta * 3 + creates, 'Exact record + version + audit + POST ledger write accounting');
  writeSegments.push({ label, targetContactIds: [...ids], beforeSha256: sha(before), afterSha256: sha(after), beforeCounts, afterCounts, exactUnrelatedRowsPreserved: true }); return result;
};
const expectFailure = rule => { assert(!expectedFailures.some(item => item.id === rule.id)); expectedFailures.push(rule); };
const observe = page => {
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => pageErrors.push({ stage, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ stage, text: message.text(), location: message.location() }); });
  page.on('response', response => {
    if (response.status() < 400) return;
    const rule = expectedFailures.find(item => item.kind === 'http' && item.phase === stage && item.url === response.url() && item.method === response.request().method() && item.status === response.status());
    failedResponses.push({ stage, url: response.url(), method: response.request().method(), status: response.status(), expectedRuleId: rule?.id || null });
  });
  page.on('requestfailed', request => {
    const failure = request.failure()?.errorText || '';
    const rule = expectedFailures.find(item => item.kind === 'requestfailed' && item.phase === stage && item.url === request.url() && item.method === request.method() && item.failure === failure);
    failedRequests.push({ stage, url: request.url(), method: request.method(), failure, expectedRuleId: rule?.id || null });
  });
};
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const panel = page => page.getByRole('region', { name: '多組聯絡人', exact: true });
const cards = page => panel(page).locator('.contact-card');
const card = (page, item) => panel(page).locator('[data-contact-id="' + item.id + '"]');
const input = (dialog, name) => dialog.locator('[name="' + name + '"]');
const load = async (page, caseItem) => {
  lastPage = page; const target = base + '/#/cases/' + caseItem.id;
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: caseItem.name, exact: true, level: 1 }).waitFor(); await page.waitForLoadState('networkidle'); await panel(page).waitFor();
};
const search = async (page, q) => {
  const field = panel(page).getByLabel('聯絡人搜尋', { exact: true }); await field.fill(q);
  const pending = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/' + entity && (url.searchParams.get('q') || '') === q; });
  await field.press('Enter'); const response = await pending; assert.equal(response.status(), 200, await response.text()); await panel(page).locator('.loading').waitFor({ state: 'detached' }); return response.json();
};
const edit = async (page, item, query = item.name) => { await search(page, query); await card(page, item).getByRole('button', { name: '編輯', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '編輯聯絡人', exact: true }); await input(dialog, 'name').waitFor(); return dialog; };
const create = async page => { await panel(page).getByRole('button', { name: '新增聯絡人', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '新增聯絡人', exact: true }); await input(dialog, 'name').waitFor(); return dialog; };
const fill = async (dialog, values) => { for (const [name, value] of Object.entries(values)) if (name === 'category' || name.endsWith('Intent') || name === 'statusRepair') await input(dialog, name).selectOption(value); else await input(dialog, name).fill(value); };
const commit = async (page, dialog, existing) => {
  const method = existing ? 'PATCH' : 'POST', url = base + '/api/' + entity + (existing ? '/' + existing.id : '');
  const pending = page.waitForResponse(response => response.url() === url && response.request().method() === method);
  await dialog.getByRole('button', { name: '儲存', exact: true }).click(); const response = await pending;
  assert.equal(response.status(), existing ? 200 : 201, await response.text());
  const payload = response.request().postDataJSON(); payloadChecks.push({ stage, method, keys: Object.keys(payload).sort(), payloadSha256: sha(payload), idempotencyKey: response.request().headers()['idempotency-key'] || null });
  await dialog.waitFor({ state: 'detached' }); return { item: (await response.json()).item, payload };
};
const abandon = async page => { await page.keyboard.press('Escape'); const dirty = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }); if (await dirty.count()) await dirty.getByRole('button', { name: '放棄修改', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); };
const noSuccess = async page => assert.equal(await page.locator('.toast').filter({ hasText: /聯絡人已新增|聯絡人資料已更新|聯絡人已停用|聯絡人已恢復使用/ }).count(), 0);
const clearToasts = async page => { for (const toast of await page.locator('.toast').all()) if (await toast.isVisible()) await toast.waitFor({ state: 'detached' }); };
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No full-page horizontal overflow');
  same(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), [], 'Visible controls labelled');
  for (const dialog of await page.getByRole('dialog').all()) assert(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog within viewport');
  for (const table of await page.locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => { assert(screenshots.length < 16); await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push({ name, sha256: sha(await readFile(path.join(output, name))), viewport: page.viewportSize(), actuallyViewed: false }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), 15000); timer.unref(); })]);
const held = async (page, pattern, predicate) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false;
  const handler = async route => { if (used || !predicate(route.request())) return route.continue(); used = true; try { const response = await route.fetch(); arrived.resolve({ url: route.request().url(), response }); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } };
  await page.route(pattern, handler);
  return { arrived: arrived.promise, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'held response'); await page.unroute(pattern, handler); } };
};
const mutateContext = (page, kind, foreignOrg) => page.evaluate(async ({ kind, foreignOrg }) => {
  const ui = await import('/ui.js'), context = ui.getContext();
  if (kind === 'hash') { location.hash = '/employees'; return; }
  const parent = document.querySelector('[data-render-version]');
  if (kind === 'render') { parent.dataset.renderVersion = crypto.randomUUID(); return; }
  if (kind === 'user') context.user.id = 'synthetic-contact-replaced-user';
  if (kind === 'org') { context.organizationId = foreignOrg; context.orgId = foreignOrg; }
  if (kind === 'role') { context.role = 'finance'; context.user.role = 'finance'; }
  if (kind === 'employee') context.user.employeeId = 'synthetic-contact-replaced-employee';
  parent.setAttribute('data-render-version', parent.dataset.renderVersion);
}, { kind, foreignOrg });

// Gates are authored below. All mutable fixtures are explicitly separated from reads.
try {
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const adminClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(adminClient);
  const setup = await fixtureWrite('owned setup/session', () => adminClient.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成聯絡安全管理員', email: 'contact-edit-admin@example.test', password, organizationName: '合成聯絡安全甲機構' } }));
  assert.equal(setup.status(), 201); const adminAuth = await setup.json(), orgId = adminAuth.organizations[0].id;
  const admin = await adminClient.newPage(); observe(admin); const actors = { admin: { client: adminClient, auth: adminAuth, page: admin } };
  const request = async (method, route, data, expected = 200, actor = actors.admin, selectedOrg = orgId, headers = {}) => {
    const response = await actor.client.request.fetch(base + '/api/' + route, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': actor.auth.csrfToken, ...headers }, ...(data === undefined ? {} : { data }) });
    const result = await response.json(); assert.equal(response.status(), expected, method + ' ' + route + ' ' + json(result)); return result;
  };
  const post = async (kind, data, selectedOrg = orgId, headers = {}) => (await request('POST', kind, data, 201, actors.admin, selectedOrg, headers)).item;
  const get = async item => (await request('GET', entity + '/' + item.id)).item;
  const patch = async (item, values) => (await request('PATCH', entity + '/' + item.id, { version: item.version, ...values })).item;
  let caseA, caseB, closedCase, foreignCase, foreignContact, foreign, employee, approved;
  const imported = (name, overrides = {}, omit = []) => {
    const data = { caseId: caseA.id, name, category: 'general', relationship: '合成原關係', phone: '合成原電話', alternatePhone: '', email: '', organization: '', status: 'active', note: '合成原備註', opaque: { sentinel: 'HIDDEN_OPAQUE', array: [1, null, false] }, ...overrides };
    for (const key of omit) delete data[key]; const time = now(), item = { ...data, id: id(), orgId, version: 1, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, orgId, entity, JSON.stringify(data), 1, time, time);
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, item.id, 1, JSON.stringify(item), time, 'baseline'); return item;
  };
  await fixtureWrite('four roles/two orgs/parents/approved snapshot/BLOBs', async () => {
    employee = await post('employees', { employeeNo: 'CTE-E01', name: '合成聯絡居服', role: 'caregiver', hourlyRateCents: 12345 });
    for (const role of ['supervisor', 'finance', 'caregiver']) {
      await post('users', { name: '合成聯絡' + role, email: 'contact-edit-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
      const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(client);
      const response = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'contact-edit-' + role + '@example.test', password } }); assert.equal(response.status(), 200);
      const page = await client.newPage(); observe(page); actors[role] = { client, auth: await response.json(), page };
    }
    caseA = await post('cases', { caseNo: 'CTE-A', name: '合成同名聯絡個案', contactName: '合成原個案聯絡人', contactPhone: '合成原個案電話', primaryCarer: '合成原主要照顧者' });
    caseB = await post('cases', { caseNo: 'CTE-B', name: '合成同名聯絡個案', status: 'paused' });
    closedCase = await post('cases', { caseNo: 'CTE-CLOSED', name: '合成已結案聯絡個案', status: 'closed' });
    foreign = await post('organizations', { name: '合成聯絡安全乙機構' });
    foreignCase = await post('cases', { caseNo: 'CTE-FOREIGN', name: 'HIDDEN_FOREIGN_CASE' }, foreign.id);
    foreignContact = await post(entity, { caseId: foreignCase.id, name: 'HIDDEN_FOREIGN_CONTACT', phone: 'HIDDEN_FOREIGN_PHONE' }, foreign.id);
    const service = await post('service-items', { code: 'CTE-SERVICE', name: '合成既有服務', minutes: 60, unitPriceCents: 12345 });
    const plan = await post('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
    const shift = await post('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-20', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
    let record = await post('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }], status: 'submitted' });
    approved = (await request('POST', 'service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成聯絡安全快照基準' })).item;
    await post('case-attachments/upload', { caseId: caseA.id, title: '合成個案PDF', category: 'general', ...filePayload(PDF_BYTES) });
    const certificate = await post('employee-certifications', { employeeId: employee.id, name: '合成證照', issuedOn: '2026-01-01' });
    await post('certification-attachments/upload', { certificationId: certificate.id, title: '合成證照PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  });
  const protectedRows = raw();
  const assertProtected = () => {
    const current = raw(); same(current.schema, protectedRows.schema);
    for (const table of Object.keys(current.tables)) {
      const filter = rows => table === 'records' || table === 'record_versions' || table === 'audit' ? rows.filter(row => row.entity !== entity) : table === 'idempotency' ? rows.filter(row => row.route !== 'POST /api/case-contacts') : rows;
      same(filter(current.tables[table]), filter(protectedRows.tables[table]), 'Protected original rows ' + table);
    }
  };
  await readOnly('G1 empty parent panel and immutable legacy fields', async () => {
    await load(admin, caseA); assert.equal(await cards(admin).count(), 0); await panel(admin).scrollIntoViewIfNeeded(); await shot(admin, 'empty-desktop.png');
    const trigger = panel(admin).getByRole('button', { name: '新增聯絡人', exact: true }); await trigger.click(); await admin.keyboard.press('Escape'); await admin.getByRole('dialog').waitFor({ state: 'detached' }); assert(await trigger.evaluate(node => node === document.activeElement));
  }); mark('G1 owned memory/random port／4roles 2org／empty／parent legacy and protected snapshot baseline');

  let core;
  await actualWrite('G2 admin true create ten fields', async () => {
    const dialog = await create(admin); assert.equal(await input(dialog, 'caseId').count(), 0); assert.equal(await input(dialog, 'statusRepair').count(), 0);
    await fill(dialog, { name: '  CTE-MAIN 合成核心聯絡人　', category: 'primary_caregiver', relationship: '  合成家屬 ', phone: '+886 合成電話 分機123', alternatePhone: '合成其他電話', email: 'contact@example.test', organization: '合成服務窗口', note: '合成第一版備註\n第二行' });
    await shot(admin, 'create-desktop.png'); const saved = await commit(admin, dialog); core = saved.item;
    assert.equal(core.version, 1); assert.equal(core.caseId, caseA.id); assert.equal(core.name, 'CTE-MAIN 合成核心聯絡人'); assert.equal(core.relationship, '合成家屬');
    same(ownProjection(core), ownProjection({ ...saved.payload, name: core.name, relationship: core.relationship })); same(Object.keys(saved.payload).sort(), [...businessKeys].sort()); assert(saved.payload.status === 'active');
    return core;
  });
  for (const parent of [caseB, closedCase]) await actualWrite('G2 maintain ' + parent.status + ' parent', async () => {
    await load(admin, parent); const dialog = await create(admin); await fill(dialog, { name: 'CTE-' + parent.status + ' 合成聯絡人' }); const saved = await commit(admin, dialog); assert.equal(saved.item.caseId, parent.id); return saved.item;
  });
  assertProtected(); mark('G2 true UI ten-field create/trim/phone text／paused closed parents／no parent/account effects');

  await actualWrite('G3 supervisor one-field PATCH', async () => {
    const supervisor = actors.supervisor.page; await load(supervisor, caseA); const before = await get(core), dialog = await edit(supervisor, core);
    for (const key of controlKeys) assert.equal(await input(dialog, key).inputValue(), before[key]);
    assert.equal(await input(dialog, 'statusRepair').count(), 0); assert.equal(await input(dialog, 'status').count(), 0);
    await fill(dialog, { phone: '  合成督導第二版電話　' }); await shot(supervisor, 'edit-one-field-desktop.png');
    const saved = await commit(supervisor, dialog, core); same(saved.payload, { phone: '合成督導第二版電話', version: core.version }); core = saved.item;
    for (const key of businessKeys.filter(key => key !== 'phone')) same({ present: Object.hasOwn(core, key), value: core[key] }, { present: Object.hasOwn(before, key), value: before[key] });
    return core;
  });
  await readOnly('G3 no-op edit sends no PATCH', async () => {
    const page = actors.supervisor.page, dialog = await edit(page, core); let calls = 0; const counter = req => { if (req.method() === 'PATCH' && req.url() === base + '/api/' + entity + '/' + core.id) calls++; }; page.on('request', counter);
    try { await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); assert.equal(calls, 0); } finally { page.off('request', counter); }
  }); assertProtected(); mark('G3 exact changed-field PATCH／all other own-values preserved／known status independent／no-op zero writes');

  let missing, cr, unsafe;
  await fixtureWrite('G4 explicit synthetic imported JSON/missing/CR fixtures', async () => {
    missing = imported('CTE-MISSING', { note: '合成缺失欄備註' }, ['relationship', 'phone', 'alternatePhone', 'email', 'organization']);
    cr = imported(' CTE-CR 原空白姓名 ', { phone: '合成保存\r\n電話', note: '合成原CR\r備註' });
    unsafe = imported('CTE-UNSAFE', { category: 'HIDDEN_CATEGORY', relationship: 0, phone: { secret: 'HIDDEN_NESTED' }, alternatePhone: ['HIDDEN_ARRAY'], email: null, organization: false, status: 'HIDDEN_STATUS', note: '合成原CR\r備註' });
  });
  await actualWrite('G4 missing own-presence preserved', async () => {
    await load(admin, caseA); const original = await get(missing), dialog = await edit(admin, missing);
    for (const key of ['relationship', 'phone', 'alternatePhone', 'email', 'organization']) { assert.equal(await input(dialog, key + 'Intent').inputValue(), 'keep'); assert(await input(dialog, key).isDisabled()); }
    await fill(dialog, { note: '合成只改備註、未保存欄保持缺失' }); const saved = await commit(admin, dialog, missing); same(saved.payload, { note: '合成只改備註、未保存欄保持缺失', version: missing.version }); missing = saved.item;
    for (const key of ['relationship', 'phone', 'alternatePhone', 'email', 'organization']) assert.equal(Object.hasOwn(missing, key), Object.hasOwn(original, key)); same(missing.opaque, original.opaque);
    return missing;
  });
  await actualWrite('G4 CR and old whitespace retained when omitted', async () => {
    const original = await get(cr), dialog = await edit(admin, cr, 'CTE-CR'); assert.equal(await input(dialog, 'phoneIntent').inputValue(), 'keep'); assert.equal(await input(dialog, 'noteIntent').inputValue(), 'keep');
    await fill(dialog, { relationship: '合成本次新關係' }); const saved = await commit(admin, dialog, cr); same(saved.payload, { relationship: '合成本次新關係', version: cr.version }); cr = saved.item;
    for (const key of businessKeys.filter(key => key !== 'relationship')) same({ present: Object.hasOwn(cr, key), value: cr[key] }, { present: Object.hasOwn(original, key), value: original[key] }); same(cr.opaque, original.opaque);
    return cr;
  });
  await readOnly('G4 keep does not bypass merged422', async () => {
    await clearToasts(admin); const dialog = await edit(admin, unsafe); assert.equal(await input(dialog, 'statusRepair').inputValue(), 'keep'); assert.equal(await card(admin, unsafe).getByRole('button', { name: /停用|恢復使用/ }).count(), 0);
    for (const key of controlKeys.filter(key => key !== 'name')) { assert.equal(await input(dialog, key + 'Intent').inputValue(), 'keep'); assert(await input(dialog, key).isDisabled()); }
    assert(!/HIDDEN_|\[object Object\]/.test(await dialog.innerText())); await shot(admin, 'unsafe-intents-desktop.png');
    await fill(dialog, { noteIntent: 'replace', note: '合成僅取代備註仍應422' });
    expectFailure({ id: 'G4-merged422', kind: 'http', phase: stage, url: base + '/api/' + entity + '/' + unsafe.id, method: 'PATCH', status: 422, count: 1, consoleCount: 1 });
    const response = admin.waitForResponse(r => r.url() === base + '/api/' + entity + '/' + unsafe.id && r.request().method() === 'PATCH'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); assert.equal((await response).status(), 422);
    await dialog.locator('.form-summary:visible').waitFor(); assert.equal(await input(dialog, 'note').inputValue(), '合成僅取代備註仍應422'); await noSuccess(admin); await abandon(admin);
  });
  await actualWrite('G4 explicit raw repair including unknown status', async () => {
    const original = await get(unsafe), dialog = await edit(admin, unsafe);
    await fill(dialog, { categoryIntent: 'replace', category: 'other', relationshipIntent: 'clear', phoneIntent: 'replace', phone: '合成修復電話', alternatePhoneIntent: 'clear', emailIntent: 'clear', organizationIntent: 'clear', noteIntent: 'replace', note: '合成已明確修復', statusRepair: 'active' });
    const saved = await commit(admin, dialog, unsafe); same(Object.keys(saved.payload).sort(), ['category', 'relationship', 'phone', 'alternatePhone', 'email', 'organization', 'note', 'status', 'version'].sort()); unsafe = saved.item; assert.equal(unsafe.status, 'active'); assert.equal(unsafe.relationship, ''); same(unsafe.opaque, original.opaque);
    return unsafe;
  }); assertProtected(); mark('G4 missing/null/JSON/number/boolean/CR/raw enum keep markers／merged422／explicit repair only');

  await readOnly('G5 actual invalid form boundaries retain input without sending', async () => {
    await load(admin, caseA); await clearToasts(admin); let dialog = await create(admin), sends = 0; const counter = req => { if (['POST', 'PATCH'].includes(req.method()) && new URL(req.url()).pathname.startsWith('/api/' + entity)) sends++; }; admin.on('request', counter);
    try {
      await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('[aria-invalid=true]').first().waitFor(); assert.equal(sends, 0);
      await fill(dialog, { name: 'CTE-INVALID', email: 'invalid-email' }); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('[name=email][aria-invalid=true]').waitFor(); assert.equal(await input(dialog, 'name').inputValue(), 'CTE-INVALID'); assert.equal(sends, 0);
      await fill(dialog, { email: '', note: 'N'.repeat(10001) }); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('.form-summary:visible').waitFor(); assert.equal(await input(dialog, 'note').inputValue(), 'N'.repeat(10001)); assert.equal(sends, 0); await noSuccess(admin); await abandon(admin);
    } finally { admin.off('request', counter); }
  });
  await actualWrite('G5 valid 10000 note persisted', async () => { const dialog = await create(admin); await fill(dialog, { name: 'CTE-LIMIT', note: 'N'.repeat(10000) }); const saved = await commit(admin, dialog); assert.equal(saved.item.note.length, 10000); return saved.item; });
  mark('G5 real required/email/10001 boundary retains input and zero sends／10000 valid true save');

  const transition = async (page, item, value) => {
    await search(page, item.name); const inactive = value === 'inactive';
    await card(page, item).getByRole('button', { name: inactive ? '停用' : '恢復使用', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: inactive ? '停用聯絡人？' : '恢復使用聯絡人？', exact: true });
    const pending = page.waitForResponse(r => r.url() === base + '/api/' + entity + '/' + item.id && r.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: inactive ? '確認停用' : '確認恢復使用', exact: true }).click(); const response = await pending;
    assert.equal(response.status(), 200, await response.text()); same(response.request().postDataJSON(), { status: value, version: item.version }); await dialog.waitFor({ state: 'detached' }); return (await response.json()).item;
  };
  await readOnly('G6 status cancel restores focus and does not write', async () => {
    await load(admin, caseA); await search(admin, core.name); const trigger = card(admin, core).getByRole('button', { name: '停用', exact: true });
    await trigger.click(); const dialog = admin.getByRole('dialog', { name: '停用聯絡人？', exact: true }); await shot(admin, 'status-confirm-desktop.png');
    await admin.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); assert(await trigger.evaluate(node => node === document.activeElement));
  });
  for (const status of ['inactive', 'active']) await actualWrite('G6 true independent ' + status, async () => {
    const before = await get(core); core = await transition(admin, core, status); for (const key of businessKeys.filter(key => key !== 'status')) same({ present: Object.hasOwn(core, key), value: core[key] }, { present: Object.hasOwn(before, key), value: before[key] });
    return core;
  }); assertProtected(); mark('G6 independent exact status/version confirmation／cancel zero writes／stop-reopen preserves other fields');

  await load(admin, caseA); await clearToasts(admin);
  for (const variant of ['create-missing-id', 'create-empty-id', 'create-nonstring-id', 'edit-wrong-id', 'edit-wrong-org', 'edit-wrong-version', 'edit-missing-phone']) await readOnly('G7 unconfirmed ' + variant, async () => {
    const creating = variant.startsWith('create'), dialog = creating ? await create(admin) : await edit(admin, core);
    await fill(dialog, creating ? { name: 'CTE-UNCONFIRMED-' + variant, note: '合成未知回應保留輸入' } : { note: '合成未知回應保留輸入' });
    const pattern = base + '/api/' + entity + (creating ? '' : '/' + core.id);
    const handler = async route => {
      if (route.request().method() !== (creating ? 'POST' : 'PATCH')) return route.continue();
      const body = route.request().postDataJSON(), item = creating ? { ...body, id: id(), orgId, version: 1 } : { ...await get(core), ...body, version: core.version + 1 };
      if (variant === 'create-missing-id') delete item.id; if (variant === 'create-empty-id') item.id = ''; if (variant === 'create-nonstring-id') item.id = 42;
      if (variant === 'edit-wrong-id') item.id = id(); if (variant === 'edit-wrong-org') item.orgId = foreign.id; if (variant === 'edit-wrong-version') item.version = core.version;
      if (variant === 'edit-missing-phone') delete item.phone;
      await route.fulfill({ status: creating ? 201 : 200, contentType: 'application/json', body: JSON.stringify({ item }) });
    };
    await admin.route(pattern, handler);
    try {
      await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.getByText('儲存結果未確認；請保留輸入並重新讀取確認。', { exact: true }).waitFor();
      assert.equal(await input(dialog, 'note').inputValue(), '合成未知回應保留輸入'); await noSuccess(admin); if (variant === 'edit-wrong-id') await shot(admin, 'unconfirmed-ack-desktop.png'); await abandon(admin);
    } finally { await admin.unroute(pattern, handler); }
  });
  await readOnly('G7 unconfirmed independent status ack', async () => {
    await search(admin, core.name); await card(admin, core).getByRole('button', { name: '停用', exact: true }).click(); const dialog = admin.getByRole('dialog', { name: '停用聯絡人？', exact: true });
    const pattern = base + '/api/' + entity + '/' + core.id;
    const handler = async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: { ...core, id: id(), status: 'inactive', version: core.version + 1 } }) });
    await admin.route(pattern, handler); try { await dialog.getByRole('button', { name: '確認停用', exact: true }).click(); await dialog.getByText('儲存結果未確認；請保留輸入並重新讀取確認。', { exact: true }).waitFor(); await noSuccess(admin); await admin.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); } finally { await admin.unroute(pattern, handler); }
  }); mark('G7 finite malformed create/edit/status ACKs reject／input retained／no false success／no fixture writes');

  await load(actors.supervisor.page, caseA); let conflictDialog = await edit(actors.supervisor.page, core); const staleVersion = core.version;
  await fill(conflictDialog, { phone: '合成本次未保存電話' });
  core = await actualWrite('G8 real competing admin save', () => patch(core, { phone: '合成另一位管理員已保存電話' }));
  await readOnly('G8 true CAS409 preserves stale input', async () => {
    const page = actors.supervisor.page; await clearToasts(page); expectFailure({ id: 'G8-CAS409', kind: 'http', phase: stage, url: base + '/api/' + entity + '/' + core.id, method: 'PATCH', status: 409, count: 1, consoleCount: 1 });
    const pending = page.waitForResponse(r => r.url() === base + '/api/' + entity + '/' + core.id && r.request().method() === 'PATCH'); await conflictDialog.getByRole('button', { name: '儲存', exact: true }).click(); const response = await pending;
    assert.equal(response.status(), 409); same(response.request().postDataJSON(), { phone: '合成本次未保存電話', version: staleVersion });
    await conflictDialog.locator('.form-summary:visible').waitFor(); assert.equal(await input(conflictDialog, 'phone').inputValue(), '合成本次未保存電話'); await noSuccess(page); await shot(page, 'conflict-desktop.png'); await abandon(page);
  });
  core = await actualWrite('G8 reread then explicit fresh save', async () => { const page = actors.supervisor.page; await load(page, caseA); const dialog = await edit(page, core); assert.equal(await input(dialog, 'phone').inputValue(), core.phone); await fill(dialog, { phone: '合成本次重新確認電話' }); return (await commit(page, dialog, core)).item; });
  let offlineDialog;
  await readOnly('G8 real offline PATCH before server', async () => {
    await load(admin, caseA); await clearToasts(admin); offlineDialog = await edit(admin, core); await fill(offlineDialog, { note: '合成離線後重試備註' });
    const pattern = base + '/api/' + entity + '/' + core.id, handler = route => route.request().method() === 'PATCH' ? route.abort('internetdisconnected') : route.continue();
    expectFailure({ id: 'G8-offline', kind: 'requestfailed', phase: stage, url: pattern, method: 'PATCH', failure: 'net::ERR_INTERNET_DISCONNECTED', count: 1, consoleCount: 1 });
    await admin.route(pattern, handler); const failed = admin.waitForEvent('requestfailed', req => req.url() === pattern && req.method() === 'PATCH' && req.failure()?.errorText === 'net::ERR_INTERNET_DISCONNECTED');
    await offlineDialog.getByRole('button', { name: '儲存', exact: true }).click(); await failed; await offlineDialog.locator('.form-summary:visible').waitFor(); assert.equal(await input(offlineDialog, 'note').inputValue(), '合成離線後重試備註'); await noSuccess(admin); await admin.unroute(pattern, handler);
  });
  core = await actualWrite('G8 same input online recovery saves once', async () => (await commit(admin, offlineDialog, core)).item);
  assertProtected(); mark('G8 real competing CAS409／offline pre-server zero writes／reread and explicit retry save once');

  const creationKeys = []; let idemDialog, committed;
  const creationCounter = req => { if (req.url() === base + '/api/' + entity && req.method() === 'POST') creationKeys.push({ key: req.headers()['idempotency-key'], payload: req.postDataJSON() }); };
  admin.on('request', creationCounter);
  await actualWrite('G9 commit then unknown create acknowledgement', async () => {
    await load(admin, caseA); await clearToasts(admin); idemDialog = await create(admin); await fill(idemDialog, { name: 'CTE-IDEMPOTENT', note: '合成已提交回應未確認' });
    const pattern = base + '/api/' + entity, handler = async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(), value = await response.json(); assert.equal(response.status(), 201); committed = structuredClone(value.item); delete value.item.id; await route.fulfill({ response, body: JSON.stringify(value) }); };
    await admin.route(pattern, handler); try { await idemDialog.getByRole('button', { name: '儲存', exact: true }).click(); await idemDialog.getByText('儲存結果未確認；請保留輸入並重新讀取確認。', { exact: true }).waitFor(); await noSuccess(admin); assert.equal(await input(idemDialog, 'name').inputValue(), 'CTE-IDEMPOTENT'); assert.equal((await get(committed)).version, 1); } finally { await admin.unroute(pattern, handler); } return committed;
  });
  await readOnly('G9 same canonical payload/key server replay creates nothing', async () => { const saved = await commit(admin, idemDialog); assert.equal(saved.item.id, committed.id); assert.equal(saved.item.version, 1); same(creationKeys[0], creationKeys[1]); assert(creationKeys[0].key); });
  let changedDialog, firstChanged;
  await actualWrite('G9 second uncertain form committed first payload', async () => {
    await clearToasts(admin); changedDialog = await create(admin); await fill(changedDialog, { name: 'CTE-PAYLOAD-CHANGE', phone: '合成改前電話' });
    const pattern = base + '/api/' + entity, handler = async route => { if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(), value = await response.json(); firstChanged = structuredClone(value.item); delete value.item.id; await route.fulfill({ response, body: JSON.stringify(value) }); };
    await admin.route(pattern, handler); try { await changedDialog.getByRole('button', { name: '儲存', exact: true }).click(); await changedDialog.getByText('儲存結果未確認；請保留輸入並重新讀取確認。', { exact: true }).waitFor(); } finally { await admin.unroute(pattern, handler); } return firstChanged;
  });
  await actualWrite('G9 different canonical payload uses a new key', async () => {
    await fill(changedDialog, { phone: '合成改後電話' }); const saved = await commit(admin, changedDialog); assert.notEqual(saved.item.id, firstChanged.id); assert.notEqual(creationKeys[2].key, creationKeys[3].key); assert.equal((await get(firstChanged)).phone, '合成改前電話'); return saved.item;
  }); admin.off('request', creationCounter); assertProtected(); mark('G9 true committed uncertain POST／same payload-key replay zero writes／changed payload new key explicit second record');

  const pageItems = [];
  await fixtureWrite('G10 explicit synthetic pagination contacts', async () => { for (let index = 1; index <= 28; index++) pageItems.push(imported('CTE-PAGE-' + String(index).padStart(2, '0'), { category: index % 2 ? 'case_manager' : 'other', status: index === 28 ? 'inactive' : 'active', phone: '合成分頁電話' + index })); });
  await readOnly('G10 filters paging clear search only in memory', async () => {
    await load(admin, caseA); const first = await search(admin, 'CTE-PAGE-'); assert.equal(first.total, 28); assert.equal(await cards(admin).count(), 25);
    const firstIds = await cards(admin).evaluateAll(nodes => nodes.map(node => node.dataset.contactId));
    const next = admin.waitForResponse(r => { const url = new URL(r.url()); return url.pathname === '/api/' + entity && url.searchParams.get('page') === '2'; }); await panel(admin).getByRole('button', { name: '下一頁', exact: true }).click(); assert.equal((await next).status(), 200); await panel(admin).locator('.loading').waitFor({ state: 'detached' }); assert.equal(await cards(admin).count(), 3);
    const lastIds = await cards(admin).evaluateAll(nodes => nodes.map(node => node.dataset.contactId)); same([...firstIds, ...lastIds].sort(), pageItems.map(item => item.id).sort());
    const filter = async (name, value, key) => { const pending = admin.waitForResponse(r => { const url = new URL(r.url()); return url.pathname === '/api/' + entity && (url.searchParams.get(key) || '') === value && url.searchParams.get('page') === '1'; }); await panel(admin).getByLabel(name, { exact: true }).selectOption(value); const response = await pending; assert.equal(response.status(), 200); await panel(admin).locator('.loading').waitFor({ state: 'detached' }); return response.json(); };
    assert.equal((await filter('聯絡人分類篩選', 'case_manager', 'category')).total, 14); await filter('聯絡人分類篩選', '', 'category'); assert.equal((await filter('聯絡人狀態篩選', 'inactive', 'status')).total, 1); assert.equal(await cards(admin).count(), 1); await filter('聯絡人狀態篩選', '', 'status');
    assert.equal((await search(admin, 'CTE-NO-SUCH-CONTACT')).total, 0); assert.equal(await cards(admin).count(), 0);
    await panel(admin).getByRole('button', { name: '清除聯絡人搜尋', exact: true }).click(); await panel(admin).locator('.loading').waitFor({ state: 'detached' }); assert((await request('GET', entity + '?caseId=' + caseA.id)).total > 28);
    assert(!admin.url().includes('CTE-PAGE')); assert(!await admin.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes('CTE-PAGE')));
    await search(admin, core.name); await panel(admin).scrollIntoViewIfNeeded(); await shot(admin, 'contact-card-desktop.png');
  }); mark('G10 28 contacts 25+3 pages／category status search clear／sensitive q not URL or storage');

  for (const variant of ['missing-envelope-total', 'short-page', 'duplicate-id', 'foreign-org', 'wrong-case', 'zero-version']) await readOnly('G11 malformed list ' + variant, async () => {
    const pattern = '**/api/' + entity + '?*';
    const handler = async route => {
      const url = new URL(route.request().url()); if (route.request().method() !== 'GET' || url.searchParams.get('caseId') !== caseA.id) return route.continue();
      const response = await route.fetch(), value = await response.json(); assert.equal(response.status(), 200);
      if (variant === 'missing-envelope-total') delete value.total;
      if (variant === 'short-page') value.items.pop();
      if (variant === 'duplicate-id') value.items[1] = { ...value.items[0] };
      if (variant === 'foreign-org') value.items[0].orgId = foreign.id;
      if (variant === 'wrong-case') value.items[0].caseId = caseB.id;
      if (variant === 'zero-version') value.items[0].version = 0;
      await route.fulfill({ response, body: JSON.stringify(value) });
    };
    await admin.route(pattern, handler); try {
      await load(admin, caseA); await panel(admin).locator('.error-state').waitFor(); assert.equal(await cards(admin).count(), 0);
      await admin.getByRole('region', { name: '個案附件', exact: true }).waitFor(); await admin.getByRole('region', { name: '暫停與結案追蹤', exact: true }).waitFor();
      if (variant === 'duplicate-id') { await panel(admin).scrollIntoViewIfNeeded(); await shot(admin, 'malformed-list-desktop.png'); }
    } finally { await admin.unroute(pattern, handler); }
    await panel(admin).getByRole('button', { name: '重新讀取', exact: true }).click(); await panel(admin).locator('.loading').waitFor({ state: 'detached' }); assert.equal(await cards(admin).count(), 25);
  });
  await readOnly('G11 exact injected503 manual retry siblings stay readable', async () => {
    const pattern = '**/api/' + entity + '?*'; let used = false;
    const handler = async route => {
      const url = new URL(route.request().url()); if (used || route.request().method() !== 'GET' || url.searchParams.get('caseId') !== caseA.id) return route.continue(); used = true;
      assert.equal(url.pathname, '/api/' + entity); assert.equal(url.searchParams.get('page'), '1');
      expectFailure({ id: 'G11-list503', kind: 'http', phase: stage, url: route.request().url(), method: 'GET', status: 503, count: 1, consoleCount: 1 });
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_503', message: '合成聯絡列表暫時無法使用' } }) });
    };
    await admin.route(pattern, handler); try { await load(admin, caseA); await panel(admin).locator('.error-state').waitFor(); await panel(admin).scrollIntoViewIfNeeded(); await shot(admin, 'list-error-desktop.png'); await admin.getByRole('region', { name: '個案附件', exact: true }).waitFor(); await panel(admin).getByRole('button', { name: '重新讀取', exact: true }).click(); await panel(admin).locator('.loading').waitFor({ state: 'detached' }); assert.equal(await cards(admin).count(), 25); } finally { await admin.unroute(pattern, handler); }
  });
  await readOnly('G11 finance caregiver read and server write guards', async () => {
    const otherContact = (await request('GET', entity + '?caseId=' + caseB.id)).items[0];
    assert.equal((await request('GET', entity + '?caseId=' + foreignCase.id, undefined, 200, actors.admin, foreign.id)).total, 1);
    for (const role of ['finance', 'caregiver']) {
      const actor = actors[role]; await load(actor.page, caseA); await search(actor.page, core.name); assert.equal(await card(actor.page, core).count(), 1);
      assert.equal(await panel(actor.page).getByRole('button', { name: /新增聯絡人|編輯|停用|恢復使用/ }).count(), 0);
      await request('POST', entity, { caseId: caseA.id, name: '不可新增' }, 403, actor); await request('PATCH', entity + '/' + core.id, { version: core.version, note: '不可寫入' }, 403, actor);
      await request('GET', entity + '/' + core.id, undefined, 200, actor); await request('GET', entity + '/' + core.id + '/history?compare=previous', undefined, 200, actor);
      await request('GET', 'cases/' + foreignCase.id, undefined, 404, actor);
      for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', entity + '/' + foreignContact.id + suffix, undefined, 404, actor);
      if (role === 'caregiver') {
        assert.equal((await request('GET', entity + '?caseId=' + caseB.id, undefined, 200, actor)).total, 0);
        for (const suffix of ['', '/history', '/history?compare=previous']) await request('GET', entity + '/' + otherContact.id + suffix, undefined, 404, actor);
      } else assert((await request('GET', entity + '?caseId=' + caseB.id, undefined, 200, actor)).total > 0);
    }
  }); mark('G11 exact list DTO rejects malformed／503 retry independent／finance caregiver read-only and server scope guards');

  for (const state of ['loaded-list', 'pending-list', 'loaded-editor', 'pending-editor']) for (const kind of ['user', 'org', 'role', 'employee', 'hash', 'render']) {
    const label = 'G12 ' + state + ' ' + kind;
    const action = async () => {
      await load(admin, caseA); core = await get(core); await search(admin, core.name); const oldPanel = await panel(admin).elementHandle(); assert(oldPanel);
      let pending, failed, dialog;
      if (state === 'loaded-editor' || state === 'pending-editor') { dialog = await edit(admin, core); await fill(dialog, { note: '合成 context ' + state + ' ' + kind }); }
      if (state === 'pending-list') {
        pending = await held(admin, '**/api/' + entity + '?*', req => req.method() === 'GET' && new URL(req.url()).searchParams.get('q') === core.name);
        await panel(admin).getByLabel('聯絡人搜尋', { exact: true }).press('Enter'); const arrival = await bounded(pending.arrived, label + ' arrived');
        const parsed = new URL(arrival.url); assert.equal(parsed.pathname, '/api/' + entity); assert.equal(parsed.searchParams.get('caseId'), caseA.id); assert.equal(parsed.searchParams.get('q'), core.name);
        expectFailure({ id: state + '-' + kind, kind: 'requestfailed', phase: stage, url: arrival.url, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, clientContextAbort: true });
        failed = admin.waitForEvent('requestfailed', req => req.url() === arrival.url && req.method() === 'GET' && req.failure()?.errorText === 'net::ERR_ABORTED');
      }
      if (state === 'pending-editor') {
        const url = base + '/api/' + entity + '/' + core.id;
        pending = await held(admin, url, req => req.method() === 'PATCH'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); const arrival = await bounded(pending.arrived, label + ' already committed');
        assert.equal(arrival.response.status(), 200); assert.equal((await get(core)).version, core.version + 1, 'Authorized server commit is explicitly accounted before client invalidation');
        expectFailure({ id: state + '-' + kind, kind: 'requestfailed', phase: stage, url, method: 'PATCH', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, clientContextAbort: true, authorizedServerCommitBeforeAbort: true });
        failed = admin.waitForEvent('requestfailed', req => req.url() === url && req.method() === 'PATCH' && req.failure()?.errorText === 'net::ERR_ABORTED');
      }
      await mutateContext(admin, kind, foreign.id); await admin.waitForFunction(node => node.textContent === '', oldPanel);
      assert.equal(await oldPanel.evaluate(node => node.textContent), '', 'Original captured panel cleared; no rebuild is used to simulate revocation');
      if (dialog) await dialog.waitFor({ state: 'detached' });
      if (pending) { await pending.finish(); await failed; }
      assert.equal(await admin.getByRole('dialog').count(), 0); await noSuccess(admin); contextChecks.push({ state, primitive: kind, originalPanelCleared: true, dialogGone: true, actualAbort: Boolean(pending), authorizedServerCommit: state === 'pending-editor' });
      if (state === 'pending-editor') core = await get(core);
      return core;
    };
    if (state === 'pending-editor') await actualWrite(label, action); else await readOnly(label, action);
  }
  assertProtected(); mark('G12 24 isolated loaded/pending contexts／original DOM cleared／true exact aborts／committed PATCH not claimed rolled back');

  await load(admin, caseA); core = await get(core); await search(admin, core.name);
  await readOnly('G13 dirty cancel preserves editing and discard writes nothing', async () => {
    const dialog = await edit(admin, core), trigger = card(admin, core).getByRole('button', { name: '編輯', exact: true }); await fill(dialog, { note: '合成未保存 dirty 備註' });
    await admin.keyboard.press('Escape'); const dirty = admin.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }); await dirty.getByRole('button', { name: '取消', exact: true }).click(); await dirty.waitFor({ state: 'detached' }); assert.equal(await input(dialog, 'note').inputValue(), '合成未保存 dirty 備註');
    await abandon(admin); assert(await trigger.evaluate(node => node === document.activeElement));
  });
  core = await actualWrite('G13 busy cancel and Escape cannot dismiss committed operation', async () => {
    const dialog = await edit(admin, core); await fill(dialog, { note: '合成 busy 真保存備註' });
    const saveHandle = await dialog.getByRole('button', { name: '儲存', exact: true }).elementHandle(), cancelHandle = await dialog.getByRole('button', { name: '取消', exact: true }).elementHandle();
    const pending = await held(admin, base + '/api/' + entity + '/' + core.id, req => req.method() === 'PATCH');
    await saveHandle.click(); await bounded(pending.arrived, 'G13 busy committed arrival'); assert(await saveHandle.isDisabled()); assert.equal(await saveHandle.getAttribute('aria-busy'), 'true');
    const rect = await cancelHandle.boundingBox(); assert(rect); await admin.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2); assert(await dialog.isVisible()); assert.equal(await admin.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).count(), 0);
    await admin.keyboard.press('Escape'); assert(await dialog.isVisible()); await pending.finish(); await dialog.waitFor({ state: 'detached' }); return get(core);
  });
  await readOnly('G13 original history exact actor previous and pending Escape', async () => {
    const history = await request('GET', entity + '/' + core.id + '/history?page=1&pageSize=100&compare=previous');
    assert.equal(history.items[0].version, core.version); same(history.items[0].actor, { id: adminAuth.user.id, name: adminAuth.user.name });
    const supervisorEntry = history.items.find(item => item.version === 2); same(supervisorEntry.actor, { id: actors.supervisor.auth.user.id, name: actors.supervisor.auth.user.name }); assert.equal(supervisorEntry.comparison.previousVersion, 1); assert.equal(supervisorEntry.snapshot.phone, '合成督導第二版電話');
    await search(admin, core.name); const trigger = card(admin, core).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); let dialog = admin.getByRole('dialog', { name: '聯絡人版本歷程', exact: true }); await dialog.getByText('第 ' + core.version + ' 版', { exact: true }).waitFor();
    await dialog.getByText(adminAuth.user.name, { exact: true }).first().waitFor(); await shot(admin, 'history-desktop.png'); await admin.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); assert(await trigger.evaluate(node => node === document.activeElement));
    const pattern = base + '/api/' + entity + '/' + core.id + '/history?*', pending = await held(admin, pattern, req => req.method() === 'GET'); await trigger.click(); dialog = admin.getByRole('dialog', { name: '聯絡人版本歷程', exact: true }); await dialog.waitFor();
    const arrival = await bounded(pending.arrived, 'G13 pending history arrived'); assert.equal(arrival.url, base + '/api/' + entity + '/' + core.id + '/history?page=1&pageSize=25&compare=previous');
    expectFailure({ id: 'G13-history-Escape', kind: 'requestfailed', phase: stage, url: arrival.url, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1 });
    const failed = admin.waitForEvent('requestfailed', req => req.url() === arrival.url && req.method() === 'GET' && req.failure()?.errorText === 'net::ERR_ABORTED'); await admin.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); await pending.finish(); await failed;
    assert.equal(await admin.getByRole('dialog').count(), 0); assert(await trigger.evaluate(node => node === document.activeElement));
  }); mark('G13 canonical dirty/busy/cancel/Escape/focus／native same handles／original actual history actors/exact previous／observed Escape abort');

  const lastLine = '合成完整保存第160行：聯絡備註只供人工閱讀。', finalLiteral = '合成手機備註最後一行完整可讀';
  const longNote = '合成聯絡多行備註開頭\n' + Array.from({ length: 160 }, (_, index) => `合成完整保存第${index + 1}行：聯絡備註只供人工閱讀。`).join('\n') + '\n' + finalLiteral;
  core = await actualWrite('G14 true long-note saved before mobile inspection', async () => { await load(admin, caseA); const dialog = await edit(admin, core); await fill(dialog, { note: longNote }); const saved = await commit(admin, dialog, core); same(saved.payload, { note: longNote, version: core.version }); assert.equal(saved.item.note, longNote); return saved.item; });
  const footerChecks = [];
  await readOnly('G14 mobile suffix clears real footer and desktop sibling', async () => {
    await admin.setViewportSize({ width: 390, height: 844 }); await load(admin, caseA); await search(admin, core.name); await card(admin, core).scrollIntoViewIfNeeded(); await shot(admin, 'contact-card-mobile.png');
    let dialog = await edit(admin, core); const note = input(dialog, 'note'); assert.equal(await note.inputValue(), longNote);
    await note.evaluate(node => { node.focus(); node.setSelectionRange(node.value.length, node.value.length); node.scrollTop = node.scrollHeight; });
    await dialog.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const textareaGeometry = await note.evaluate(node => { const rect = node.getBoundingClientRect(), footer = node.closest('dialog').querySelector('.dialog-footer').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, footerTop: footer.top, scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, valueSuffix: node.value.slice(-40) }; });
    assert(textareaGeometry.top >= 0 && textareaGeometry.bottom <= textareaGeometry.footerTop); assert(textareaGeometry.scrollTop + textareaGeometry.clientHeight >= textareaGeometry.scrollHeight - 1); assert(textareaGeometry.valueSuffix.endsWith(finalLiteral));
    footerChecks.push({ kind: 'native-textarea', ...textareaGeometry, note: 'Native value is not inferred from a DOM Range; actual screenshot must be viewed separately.' }); await shot(admin, 'edit-note-bottom-mobile.png');
    await admin.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    const trigger = card(admin, core).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = admin.getByRole('dialog', { name: '聯絡人版本歷程', exact: true }); await dialog.getByText('第 ' + core.version + ' 版', { exact: true }).waitFor();
    const version = dialog.locator('.history-version').filter({ has: admin.getByText('第 ' + core.version + ' 版', { exact: true }) }), saved = version.locator('.history-snapshot'); await saved.getByText('完整保存欄位', { exact: true }).click();
    const savedNote = saved.getByText(longNote, { exact: true }); await savedNote.waitFor(); assert.equal(await savedNote.textContent(), longNote); await savedNote.evaluate(node => node.scrollIntoView({ block: 'end' }));
    await savedNote.evaluate(node => { const dialog = node.closest('dialog'), footer = dialog.querySelector('.dialog-footer'); dialog.scrollTop += Math.max(0, node.getBoundingClientRect().bottom - footer.getBoundingClientRect().top + 20); });
    const ranges = await savedNote.evaluate((node, { lastLine, finalLiteral }) => {
      const dialog = node.closest('dialog'), footer = dialog.querySelector('.dialog-footer').getBoundingClientRect(), area = dialog.getBoundingClientRect();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let textNode; while (walker.nextNode()) if (walker.currentNode.textContent.includes(finalLiteral)) textNode = walker.currentNode;
      if (!textNode) throw new Error('Saved suffix text node absent');
      const check = text => { const start = textNode.textContent.lastIndexOf(text); if (start < 0) throw new Error('Saved suffix absent'); const range = document.createRange(); range.setStart(textNode, start); range.setEnd(textNode, start + text.length); return [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => { const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, insideDialogAboveFooter: rect.top >= Math.max(0, area.top) && rect.bottom <= Math.min(innerHeight, footer.top) && rect.left >= Math.max(0, area.left) && rect.right <= Math.min(innerWidth, area.right), hitTestVisible: Boolean(hit && (hit === node || node.contains(hit))) }; }); };
      return { footerTop: footer.top, dialogTop: area.top, scrollTop: dialog.scrollTop, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight, lastLineRects: check(lastLine), finalLiteralRects: check(finalLiteral) };
    }, { lastLine, finalLiteral });
    assert(ranges.lastLineRects.length && ranges.finalLiteralRects.length); assert([...ranges.lastLineRects, ...ranges.finalLiteralRects].every(rect => rect.insideDialogAboveFooter && rect.hitTestVisible), 'Every wrapped final-line/literal Range clears sticky footer and is hit-test visible');
    footerChecks.push({ kind: 'saved-history-text-ranges', ...ranges }); await shot(admin, 'history-note-suffix-mobile.png');
    await admin.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); assert(await trigger.evaluate(node => node === document.activeElement));
    await actors.caregiver.page.setViewportSize({ width: 390, height: 844 }); await load(actors.caregiver.page, caseA); await search(actors.caregiver.page, core.name); await card(actors.caregiver.page, core).scrollIntoViewIfNeeded(); assert.equal(await panel(actors.caregiver.page).getByRole('button', { name: /新增聯絡人|編輯|停用|恢復使用/ }).count(), 0); await shot(actors.caregiver.page, 'caregiver-read-only-mobile.png');
    await admin.setViewportSize({ width: 1440, height: 1050 }); await load(admin, caseA); await admin.evaluate(() => scrollTo(0, 0)); await admin.getByText('合成原個案聯絡人', { exact: true }).waitFor(); await shot(admin, 'case-parent-sibling-desktop.png');
  }); assertProtected(); mark('G14 390 native textarea tail／actual saved note Range and hit-test above footer／read-only mobile／1440 sibling');

  stage = 'final exact observer accounting'; assert.equal(checks.length, 14); assert.equal(contextChecks.length, 24); assert.equal(screenshots.length, 16);
  assert.equal(pageErrors.length, 0, json(pageErrors)); assert.equal(failedResponses.filter(item => !item.expectedRuleId).length, 0, json(failedResponses)); assert.equal(failedRequests.filter(item => !item.expectedRuleId).length, 0, json(failedRequests));
  const assigned = new Set();
  for (const rule of expectedFailures) {
    const events = (rule.kind === 'http' ? failedResponses : failedRequests).filter(event => event.expectedRuleId === rule.id); assert.equal(events.length, rule.count, 'Exact controlled event count: ' + rule.id);
    const matches = consoleErrors.flatMap((event, index) => event.stage === rule.phase && event.location.url === rule.url && (rule.kind === 'http' ? event.text.startsWith('Failed to load resource: the server responded with a status of ' + rule.status + ' (') : event.text === 'Failed to load resource: ' + rule.failure) ? [index] : []);
    if (rule.consoleCount !== undefined) assert.equal(matches.length, rule.consoleCount, 'Exact associated console count: ' + rule.id); else assert(matches.length <= rule.maxConsoleCount, 'Bounded associated context/Escape abort console count');
    for (const index of matches) { assert(!assigned.has(index), 'Each console failure allocated once'); assigned.add(index); }
    rule.actualFailureCount = events.length; rule.actualConsoleCount = matches.length;
  }
  assert.equal(assigned.size, consoleErrors.length, json(consoleErrors.filter((_event, index) => !assigned.has(index))));
  await readOnly('final snapshot read is exact zero writes', async () => { same((await request('GET', 'service-records/' + approved.id)).item, approved); assertProtected(); });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: now(), syntheticOnly: true, database: ':memory:', randomLoopback: true, checks, readSegments, writeSegments, fixtureWrites, contextChecks, payloadChecks, footerChecks, originalProtectedRowsAndBlobsUnchanged: true, snapshotUnchanged: true, pageErrors, consoleErrors, failedResponses, failedRequests, expectedFailures, expectedConsoleFailuresOnly: true, screenshots, visualReviewPending: true, actuallyViewedByScript: false }, null, 2) + '\n', { flag: 'wx' });
  console.log('RESULT ' + path.join(output, 'e2e.json'));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ stage, error: error.stack, checks, readSegments, writeSegments, fixtureWrites, contextChecks, screenshots, pageErrors, consoleErrors, failedResponses, failedRequests, expectedFailures }, null, 2) + '\n', { flag: 'wx' });
  if (lastPage) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  console.error('FAILURE ' + path.join(output, 'failure.json')); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
