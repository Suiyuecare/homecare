import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

// Only this factory's memory database and random loopback listener are used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, 'outputs/software/case-record-index-qa/browser');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const app = createApp({ dbPath: ':memory:', port: 0 });
const password = 'synthetic-record-index-browser-password';
const kinds = ['care-plans', 'shifts', 'service-records', 'assessments'];
const historyTitles = { 'care-plans': '照顧計畫版本歷程', shifts: '班次版本歷程', 'service-records': '服務紀錄版本歷程', assessments: '評鑑填答版本歷程' };
const keys = ['entity', 'id', 'orgId', 'caseId', 'version', 'updatedAt'];
const badResponse = '紀錄索引回應無法確認；請重新讀取。';
const checks = [], readSegments = [], fixtureWrites = [], stateLedger = [], screenshots = [], contextChecks = [], referenceChecks = [], outerRebuildChecks = [], malformedChecks = [], footerChecks = [], expectedFailures = [], failedResponses = [], failedRequests = [], consoleErrors = [], pageErrors = [], requestLedger = [], contexts = [];
let browser, base, stage = 'initialization', lastPage, actors, orgId, foreignOrg, caseA, caseB, closedCase, foreignCase, main, protectedBaseline, sourceHashesBefore;
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { sqliteInteger: String(v) } : v);
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');
const same = (a, b, message) => assert.deepEqual(a, b, message);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return { schema, tables: Object.fromEntries(tables.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })) };
};
const counts = () => ({ totalChanges: app.db.prepare('SELECT total_changes() n').get().n, records: app.db.prepare('SELECT COUNT(*) n FROM records').get().n, versions: app.db.prepare('SELECT COUNT(*) n FROM record_versions').get().n, audit: app.db.prepare('SELECT COUNT(*) n FROM audit').get().n, idempotency: app.db.prepare('SELECT COUNT(*) n FROM idempotency').get().n });
const readOnly = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(), result = await action(), after = raw(), afterCounts = counts();
  same(after, before, label + ': all eleven raw tables, six triggers, schema and BLOBs'); same(afterCounts, beforeCounts, label + ': total_changes exactly zero');
  const segment = { sequence: stateLedger.length + 1, label, tableCount: 11, triggerCount: 6, beforeSha256: sha(before), afterSha256: sha(after), beforeCounts, afterCounts, zeroWrites: true };
  readSegments.push(segment); stateLedger.push({ kind: 'read', ...segment }); return result;
};
const fixtureWrite = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(), result = await action(), after = raw(), afterCounts = counts(); same(after.schema, before.schema, 'Fixture never changes schema/triggers');
  const segment = { sequence: stateLedger.length + 1, label, fixtureOnly: true, beforeSha256: sha(before), afterSha256: sha(after), beforeCounts, afterCounts, totalChangesDelta: afterCounts.totalChanges - beforeCounts.totalChanges, changedTables: Object.keys(before.tables).filter(key => sha(before.tables[key]) !== sha(after.tables[key])) };
  fixtureWrites.push(segment); stateLedger.push({ kind: 'fixture', ...segment }); return result;
};
const sourceMap = async () => {
  const files = ['BUILD_STATE.md', 'PRODUCT.md', 'README.md', 'DESIGN.md', 'UX-CONTRACT.md', 'package.json', 'premium-ui.json', '.env.portal.example', '.gitignore', 'pnpm-lock.yaml'].filter(rel => existsSync(path.join(root, rel)));
  const extensions = new Set(['.mjs', '.js', '.json', '.md', '.html', '.css', '.svg', '.png', '.yml', '.yaml']);
  const walk = async directory => { for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) { const rel = path.join(directory, entry.name); if (entry.isDirectory()) await walk(rel); else if (entry.isFile() && extensions.has(path.extname(rel))) files.push(rel); } };
  for (const directory of ['public', 'src', 'tests', 'scripts', 'docs', '.github']) if (existsSync(path.join(root, directory))) await walk(directory);
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async rel => [rel, sha(await readFile(path.join(root, rel)))])));
};
const addRule = rule => { assert(!expectedFailures.some(item => item.id === rule.id)); expectedFailures.push(rule); };
const observe = page => {
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requestLedger.push({ stage, url: request.url(), method: request.method() }); });
  page.on('pageerror', error => pageErrors.push({ stage, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ stage, text: message.text(), location: message.location() }); });
  page.on('response', response => { if (response.status() < 400) return; const rule = expectedFailures.find(rule => rule.kind === 'http' && rule.phase === stage && rule.url === response.url() && rule.method === response.request().method() && rule.status === response.status()); failedResponses.push({ stage, url: response.url(), method: response.request().method(), status: response.status(), expectedRuleId: rule?.id ?? null }); });
  page.on('requestfailed', request => { const failure = request.failure()?.errorText || ''; const rule = expectedFailures.find(rule => rule.kind === 'requestfailed' && rule.phase === stage && rule.url === request.url() && rule.method === request.method() && rule.failure === failure); failedRequests.push({ stage, url: request.url(), method: request.method(), failure, expectedRuleId: rule?.id ?? null }); });
};
const endpoint = (parent, entity, page = 1, pageSize = 25) => '/api/cases/' + parent.id + '/record-index?' + new URLSearchParams({ entity, page: String(page), pageSize: String(pageSize) });
const dialog = page => page.getByRole('dialog', { name: '保存紀錄索引', exact: true });
const indexRows = page => dialog(page).locator('tbody tr[data-record-id]');
const rowById = (page, recordId) => dialog(page).locator('tr[data-record-id="' + recordId + '"]');
const loadCase = async (page, parent = caseA) => { lastPage = page; const target = base + '/#/cases/' + parent.id; if (page.url() === target) await page.reload(); else await page.goto(target); await page.getByRole('heading', { name: parent.name, level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); };
const openIndex = async (page, parent = caseA) => { await loadCase(page, parent); const trigger = page.getByRole('button', { name: '保存紀錄索引', exact: true }); await trigger.click(); await dialog(page).waitFor(); const field = dialog(page).getByLabel(/^紀錄種類/); await field.waitFor(); assert.equal(await field.count(), 1); assert.equal(await field.getAttribute('name'), 'entity'); return trigger; };
const waitIndex = async (page, expectedTotal) => { await dialog(page).locator('.pagination').getByText(new RegExp('共 ' + expectedTotal + ' 筆')).waitFor(); assert.equal(await indexRows(page).count(), Math.min(25, expectedTotal)); };
const query = async (page, entity = 'care-plans', parent = caseA, expected) => {
  await dialog(page).getByLabel(/^紀錄種類/).selectOption(entity);
  const response = page.waitForResponse(response => response.url() === base + endpoint(parent, entity) && response.request().method() === 'GET');
  await dialog(page).getByRole('button', { name: '查詢紀錄', exact: true }).click(); const received = await response; assert.equal(received.status(), 200); const value = await received.json(); await waitIndex(page, expected ?? value.total); return value;
};
const closeDialog = async (page, modal, trigger) => {
  const element = await modal.elementHandle(); assert(element); await page.keyboard.press('Escape'); await page.waitForFunction(node => !node.isConnected, element); await element.dispose();
  if (trigger) await page.waitForFunction(node => document.activeElement === node, await trigger.elementHandle());
};
const openHistory = async (page, entity, item) => {
  const trigger = rowById(page, item.id).getByRole('button', { name: '此紀錄歷程', exact: true }); await trigger.click(); const modal = page.getByRole('dialog', { name: historyTitles[entity], exact: true }); await modal.getByText('第 ' + item.version + ' 版', { exact: true }).waitFor(); return { modal, trigger };
};
const layout = async page => {
  const result = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll('dialog[open]')].map(node => ({ width: node.clientWidth, contentWidth: node.scrollWidth })), parentLinks: [...document.querySelectorAll('a[href^="#/cases/"]')].length }));
  assert(result.documentWidth <= result.width + 1, json(result)); for (const entry of result.dialogs) assert(entry.contentWidth <= entry.width + 1, json(result)); return result;
};
const shot = async (page, name) => { await layout(page); const p = path.join(output, name); await page.screenshot({ path: p, fullPage: false }); screenshots.push({ name, path: p, sha256: sha(await readFile(p)), viewport: page.viewportSize(), actuallyViewed: false, visualReviewPending: true }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(label + ' timed out')), 15000); promise.then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); }); });
const held = async (page, url) => {
  const arrived = deferred(), released = deferred(), handled = deferred(); let used = false, finished = false;
  const handler = async route => {
    if (route.request().method() !== 'GET' || used) return route.continue(); used = true;
    try { const response = await route.fetch(); arrived.resolve({ url: route.request().url(), method: route.request().method() }); await released.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; }
    finally { handled.resolve(); }
  };
  await page.route(url, handler); return { arrived: arrived.promise, finish: async () => { if (finished) return; finished = true; released.resolve(); if (used) await bounded(handled.promise, 'held route completion'); await page.unroute(url, handler); } };
};
const abortEvent = (page, event, ruleId) => { addRule({ id: ruleId, kind: 'requestfailed', phase: stage, url: event.url, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1 }); return page.waitForEvent('requestfailed', request => request.url() === event.url && request.method() === 'GET' && request.failure()?.errorText === 'net::ERR_ABORTED'); };
const settle = async page => { await page.waitForLoadState('networkidle'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
const mutate = async (page, primitive) => page.evaluate(async ({ primitive, foreignOrg }) => {
  const ui = await import('/ui.js'), current = ui.getContext(), mounted = document.querySelector('[data-render-version]');
  if (primitive === 'hash') location.hash = '/cases';
  else if (primitive === 'render') mounted.dataset.renderVersion = 'synthetic-replaced-parent-render';
  else { if (primitive === 'user') current.user.id = 'synthetic-other-user'; if (primitive === 'org') { current.organizationId = foreignOrg; current.orgId = foreignOrg; } if (primitive === 'role') { current.role = 'finance'; current.user.role = 'finance'; } if (primitive === 'employee') current.user.employeeId = 'synthetic-other-employee'; mounted.setAttribute('data-render-version', mounted.dataset.renderVersion); }
}, { primitive, foreignOrg: foreignOrg.id });
const replaceReferences = async (page, outer = false) => page.evaluate(async outer => {
  const ui = await import('/ui.js'), old = ui.getContext(), tuple = context => JSON.stringify([context.user?.id ?? null, context.organizationId ?? context.orgId ?? null, context.role ?? null, context.user?.employeeId ?? null]); const before = tuple(old), oldUser = old.user;
  if (outer) ui.setContext({ ...old, user: { ...old.user }, organizations: old.organizations.map(org => ({ ...org })) }, old.organizationId);
  else { old.user = { ...old.user }; old.organizations = old.organizations.map(org => ({ ...org })); }
  const fresh = ui.getContext(); if (tuple(fresh) !== before || fresh.user === oldUser || (fresh === old) === outer) throw new Error('Reference fixture did not preserve primitive identity/change specified references');
  const mounted = document.querySelector('[data-render-version]'); mounted.setAttribute('data-render-version', mounted.dataset.renderVersion); return { before, after: tuple(fresh), outerChanged: fresh !== old };
}, outer);
const textGeometry = async (locator, literal) => {
  await locator.evaluate(node => { node.scrollIntoView({ block: 'end', inline: 'start' }); const region = node.closest('.table-scroll'); if (region) region.scrollLeft += node.getBoundingClientRect().left - region.getBoundingClientRect().left - 8; const dialog = node.closest('dialog'), footer = dialog.querySelector(':scope > .dialog-footer'); dialog.scrollTop += Math.max(0, node.getBoundingClientRect().bottom - footer.getBoundingClientRect().top + 20); });
  const result = await locator.evaluate((node, literal) => {
    const modal = node.closest('dialog'), footer = modal.querySelector(':scope > .dialog-footer').getBoundingClientRect(), table = node.closest('.table-scroll'), tableRect = table?.getBoundingClientRect(), walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let found;
    while (walker.nextNode()) if (walker.currentNode.textContent.includes(literal)) found = walker.currentNode; if (!found) throw new Error('Saved literal text node absent'); const start = found.textContent.lastIndexOf(literal), range = document.createRange(); range.setStart(found, start); range.setEnd(found, start + literal.length);
    return { directCloseFooter: ':scope > .dialog-footer', footerTop: footer.top, scrollX, innerWidth, tableScrollWidth: table?.scrollWidth, tableClientWidth: table?.clientWidth, literal, rects: [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => { const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, visibleAboveFooter: rect.top >= 0 && rect.bottom <= Math.min(innerHeight, footer.top) && rect.left >= Math.max(0, tableRect?.left ?? 0) && rect.right <= Math.min(innerWidth, tableRect?.right ?? innerWidth), hitTestVisible: Boolean(hit && (hit === node || node.contains(hit))) }; }) };
  }, literal);
  assert.equal(result.scrollX, 0); assert(result.rects.length); assert(result.rects.every(rect => rect.visibleAboveFooter && rect.hitTestVisible), json(result)); footerChecks.push(result); return result;
};

try {
  sourceHashesBefore = await sourceMap(); base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310'); browser = await chromium.launch({ headless: true });
  const adminClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(adminClient);
  const setup = await fixtureWrite('synthetic setup and owned session', () => adminClient.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成索引管理員', email: 'record-index-admin@example.test', password, organizationName: '合成索引甲機構' } })); assert.equal(setup.status(), 201); const auth = await setup.json(); orgId = auth.organizations[0].id;
  const admin = await adminClient.newPage(); observe(admin); actors = { admin: { client: adminClient, auth, page: admin } };
  const request = async (method, route, data, expected = 200, actor = actors.admin, selectedOrg = orgId) => { const response = await actor.client.request.fetch(base + route, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': actor.auth.csrfToken }, ...(data === undefined ? {} : { data }) }); const value = await response.json(); assert.equal(response.status(), expected, method + ' ' + route + ' ' + json(value)); return value; };
  const post = async (entity, data, selectedOrg = orgId) => (await request('POST', '/api/' + entity, data, 201, actors.admin, selectedOrg)).item;
  const patch = async (entity, item, data, actor = actors.admin) => (await request('PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data }, 200, actor)).item;
  let employee, service, approved;
  await fixtureWrite('synthetic four roles two organizations and all-status parent cases', async () => {
    employee = await post('employees', { employeeNo: 'INDEX-EMP', name: '合成索引居服員', role: 'caregiver', hourlyRateCents: 12345 });
    for (const role of ['supervisor', 'finance', 'caregiver']) { await post('users', { name: '合成索引' + role, email: 'record-index-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) }); const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(client); const login = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'record-index-' + role + '@example.test', password } }); assert.equal(login.status(), 200); const page = await client.newPage(); observe(page); actors[role] = { client, auth: await login.json(), page }; }
    foreignOrg = await post('organizations', { name: '合成索引乙機構' }); caseA = await post('cases', { caseNo: 'INDEX-SAME-A', name: '合成同名索引個案', note: '合成原個案注意事項' }); caseB = await post('cases', { caseNo: 'INDEX-SAME-B', name: caseA.name, status: 'paused' }); closedCase = await post('cases', { caseNo: 'INDEX-CLOSED', name: '合成結案索引個案', status: 'closed' }); foreignCase = await post('cases', { caseNo: 'INDEX-FOREIGN', name: caseA.name }, foreignOrg.id); service = await post('service-items', { code: 'INDEX-BA01', name: '合成索引服務', minutes: 60, unitPriceCents: 10000 });
  });
  await readOnly('G1 role-first denial and empty closed/paused parent indexes', async () => {
    for (const parent of [caseA, caseB, closedCase]) for (const entity of kinds) { const result = await request('GET', endpoint(parent, entity)); assert.equal(result.total, 0); same(result.items, []); assert.equal(result.caseId, parent.id); }
    for (const role of ['finance', 'caregiver']) for (const [method, route, data] of [['GET', endpoint(caseA, 'care-plans') + '&unknown=1'], ['POST', endpoint(caseA, 'care-plans'), { invalid: 'not parsed' }]]) await request(method, route, data, 403, actors[role]);
    for (const parentId of [foreignCase.id, employee.id, id()]) await request('GET', endpoint({ id: parentId }, 'care-plans'), undefined, 404);
  }); mark('G1 four real roles/twoorg strict authorization, exact existing case parent and all case states');

  await fixtureWrite('four actual record histories, approved billing, two nonempty attachment BLOBs', async () => {
    const plan = await post('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }], note: '合成計畫第一版' }); const updatedPlan = await patch('care-plans', plan, { note: '合成計畫督導保存第二版' }, actors.supervisor);
    const shift = await post('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-03-04', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }], note: '合成班次第一版' }); const updatedShift = await patch('shifts', shift, { note: '合成班次督導第二版' }, actors.supervisor);
    const record = await post('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }], status: 'draft', note: '合成服務第一版' }); const changedRecord = await patch('service-records', record, { note: '合成服務督導第二版', status: 'submitted' }, actors.supervisor); approved = (await request('POST', '/api/service-records/' + record.id + '/review', { version: changedRecord.version, decision: 'approved', reviewNote: '合成核閱快照保持' })).item;
    const assessment = await post('assessments', { caseId: caseB.id, templateId: 'assessment-04', date: '2026-03-04', status: 'draft', answers: { q001: '合成過去保存個案名' } }); const updatedAssessment = await patch('assessments', assessment, { caseId: caseA.id, templateId: 'assessment-03', answers: { q001: '合成目前保存名', q007: '合成督導第二版處遇' }, status: 'submitted' }, actors.supervisor);
    main = { 'care-plans': updatedPlan, shifts: (await request('GET', '/api/shifts/' + updatedShift.id)).item, 'service-records': approved, assessments: updatedAssessment };
    await request('POST', '/api/case-attachments/upload', { caseId: caseA.id, title: '合成索引BLOB甲', category: 'general', note: '合成不外洩', ...filePayload(PDF_BYTES, 'synthetic-index.pdf', 'application/pdf') }, 201);
    const certificate = await post('employee-certifications', { employeeId: employee.id, name: '合成索引證照', issuer: '合成單位', issuedOn: '2026-01-01', status: 'active' }); await request('POST', '/api/certification-attachments/upload', { certificationId: certificate.id, title: '合成索引BLOB乙', note: '合成不外洩', ...filePayload(PNG_BYTES, 'synthetic-index.png', 'image/png') }, 201);
  });
  await readOnly('G2 four exact metadata projections and original history actions', async () => {
    const trigger = await openIndex(admin); assert.equal(await indexRows(admin).count(), 0); assert.equal(requestLedger.filter(item => item.stage === stage && item.url.includes('/record-index')).length, 0, 'Opening alone does not query'); await dialog(admin).getByText('本索引只列目前同案的保存紀錄，並非完整異動時間軸。歷程可能包含過去其他目前可讀個案或模板的版本。', { exact: true }).waitFor();
    for (const entity of kinds) {
      const received = await query(admin, entity); assert.equal(received.total, 1); const item = received.items[0]; same(Object.keys(item).sort(), [...keys].sort()); assert.equal(item.entity, entity); assert.equal(item.caseId, caseA.id); assert.equal(item.id, main[entity].id); assert.equal(item.version, main[entity].version); assert(!json(received).includes('billingSnapshot')); assert(!json(received).includes('answers')); assert(!json(received).includes('note'));
      const source = await request('GET', '/api/' + entity + '/' + item.id + '/history?compare=previous'); assert.equal(source.items[0].snapshot.id, item.id); assert.equal(source.items[0].version, item.version); assert.equal(source.items[0].actor.id, entity === 'shifts' || entity === 'service-records' ? actors.admin.auth.user.id : actors.supervisor.auth.user.id);
      if (entity === 'assessments') { assert.equal(source.items[0].snapshot.templateId, 'assessment-03'); assert.equal(source.items[0].comparison.previousSnapshot.templateId, 'assessment-04'); assert.equal(source.items[0].comparison.previousSnapshot.caseId, caseB.id); }
      const opened = await openHistory(admin, entity, main[entity]); await opened.modal.getByText('操作者（目前名稱）', { exact: true }).first().waitFor(); await shot(admin, 'history-' + entity + '-desktop.png'); await closeDialog(admin, opened.modal, opened.trigger);
    }
    await closeDialog(admin, dialog(admin), trigger);
  }); mark('G2 all four actual current versions, original fresh history actors/previous snapshots and no index business leakage');

  const timeLiteral = '合成原更新時間最後一行可讀', longTime = '這不是待解析日期\n' + Array.from({ length: 45 }, (_, i) => '合成原更新時間第' + String(i + 1).padStart(3, '0') + '行').join('\n') + '\n' + timeLiteral;
  const longId = 'aaaaaaaa-'.repeat(15) + 'abcdef1234567890';
  await fixtureWrite('raw synthetic all-status index rows with SQL-authoritative metadata', () => {
    const statement = app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)');
    for (let i = 0; i < 28; i++) { const recordId = id(), t = '2025-01-' + String(i % 28 + 1).padStart(2, '0') + 'T00:00:00.000Z'; statement.run(recordId, orgId, 'care-plans', json({ caseId: caseA.id, status: ['draft', 'active', 'ended', 'unknown-saved-status', null][i % 5], note: 'INDEX-HIDDEN-BUSINESS', services: [], id: { unknownNested: 'INDEX-METADATA-SHADOW' }, orgId: foreignOrg.id, version: { hidden: 'unsafe body' }, updatedAt: 'SHADOW-TIME' }), 1, t, t); }
    statement.run(longId, orgId, 'care-plans', json({ caseId: caseA.id, status: 'ended', note: 'INDEX-HIDDEN-LONG' }), 1, '2030-01-01T00:00:00.000Z', longTime);
    statement.run(id(), orgId, 'assessments', json({ caseId: caseB.id, status: 'submitted', templateId: 'assessment-04', answers: { hidden: 'INDEX-OTHER-CASE-ANSWERS' } }), 1, now(), now());
    for (const data of [null, [], {}, { caseId: null }, { caseId: 7 }]) statement.run(id(), orgId, 'assessments', json(data), 1, now(), now());
  });
  protectedBaseline = raw(); assert(raw().tables.attachment_files.some(row => row.content?.length || row.data?.length || row.bytes?.length), 'Nonempty case BLOB fixture'); assert(raw().tables.certification_attachment_files.some(row => row.content?.length || row.data?.length || row.bytes?.length), 'Nonempty certification BLOB fixture'); assert(approved.billingSnapshot);
  const projected = (parent, entity) => app.db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id ASC').all(orgId, entity).filter(row => { const body = JSON.parse(row.data); return body && !Array.isArray(body) && Object.hasOwn(body, 'caseId') && body.caseId === parent.id; }).map(row => ({ entity, id: row.id, orgId: row.org_id, caseId: parent.id, version: row.version, updatedAt: row.updated_at }));
  await readOnly('G3 full pagination, stable SQL sort and draft withdrawal', async () => {
    const trigger = await openIndex(admin), expected = projected(caseA, 'care-plans'), first = await query(admin, 'care-plans'); assert.equal(first.total, 30); same(first.items, expected.slice(0, 25)); assert.equal(await indexRows(admin).count(), 25); await shot(admin, 'index-desktop.png');
    const next = admin.waitForResponse(response => response.url() === base + endpoint(caseA, 'care-plans', 2)); await dialog(admin).getByRole('button', { name: '下一頁', exact: true }).click(); const second = await (await next).json(); same(second.items, expected.slice(25)); await dialog(admin).getByText('第 2 / 2 頁', { exact: false }).waitFor(); assert.equal(await indexRows(admin).count(), 5); await shot(admin, 'index-page-two-desktop.png');
    await dialog(admin).getByLabel(/^紀錄種類/).selectOption('assessments'); assert.equal(await indexRows(admin).count(), 0); assert.equal(await dialog(admin).getByRole('button', { name: '此紀錄歷程', exact: true }).count(), 0); assert.equal(await dialog(admin).getByRole('button', { name: '下一頁', exact: true }).count(), 0); await query(admin, 'assessments', caseA, 1); await closeDialog(admin, dialog(admin), trigger);
  }); mark('G3 thirty all-status rows, actual 25/5 pages, SQL order and explicit draft requery');
  await readOnly('G4 same-name paused closed case and opaque body omission', async () => {
    for (const [parent, expected] of [[caseA, 1], [caseB, 1], [closedCase, 0]]) { const result = await request('GET', endpoint(parent, 'assessments')); assert.equal(result.total, expected); for (const item of result.items) assert.equal(item.caseId, parent.id); assert(!json(result).includes('INDEX-OTHER-CASE-ANSWERS')); }
    const result = await request('GET', endpoint(caseA, 'care-plans')); same(result.items, projected(caseA, 'care-plans').slice(0, 25)); for (const token of ['INDEX-HIDDEN', 'INDEX-METADATA-SHADOW', 'SHADOW-TIME', foreignOrg.id, 'snapshot', 'actor', 'status', 'answers']) assert(!json(result).includes(token), token);
    for (const parent of [caseB, closedCase]) { const trigger = await openIndex(actors.supervisor.page, parent); await query(actors.supervisor.page, 'assessments', parent, parent === caseB ? 1 : 0); await closeDialog(actors.supervisor.page, dialog(actors.supervisor.page), trigger); }
  }); mark('G4 exact current parent IDs across same names/paused/closed and non-object/typed/shadow body isolation');

  await readOnly('G5 one exact 503 and manual retry keeps selected kind', async () => {
    const trigger = await openIndex(admin), url = base + endpoint(caseA, 'assessments'); let called = 0; const handler = route => ++called === 1 ? route.fulfill({ status: 503, json: { error: { message: '合成索引首次不可用' } } }) : route.continue(); addRule({ id: 'G5-first503', kind: 'http', phase: stage, url, method: 'GET', status: 503, count: 1, maxConsoleCount: 1 }); await admin.route(url, handler);
    await dialog(admin).getByLabel(/^紀錄種類/).selectOption('assessments'); await dialog(admin).getByRole('button', { name: '查詢紀錄', exact: true }).click(); await dialog(admin).getByRole('alert').getByText('合成索引首次不可用', { exact: true }).waitFor(); assert.equal(await indexRows(admin).count(), 0); assert.equal(await dialog(admin).getByLabel(/^紀錄種類/).inputValue(), 'assessments'); await shot(admin, 'index-error-desktop.png');
    await dialog(admin).getByRole('alert').getByRole('button', { name: '重新讀取', exact: true }).click(); await waitIndex(admin, 1); assert.equal(called, 2); await admin.unroute(url, handler); await closeDialog(admin, dialog(admin), trigger);
  }); mark('G5 precise single503/no partial result, manual retry and entity retained');

  const malformedVariants = [
    ['extra-envelope', value => { value.snapshot = { private: 'not shown' }; }], ['wrong-org', value => { value.orgId = foreignOrg.id; }], ['wrong-parent', value => { value.caseId = caseB.id; }], ['wrong-entity', value => { value.entity = 'shifts'; }], ['wrong-page', value => { value.page = 2; }], ['wrong-page-size', value => { value.pageSize = 100; }], ['wrong-count', value => { value.total += 1; }], ['missing-row', value => { value.items = []; }], ['extra-row-field', value => { value.items[0].answers = { hidden: 'not shown' }; }], ['missing-row-id', value => { delete value.items[0].id; }], ['invalid-id', value => { value.items[0].id = 'NOT-A-HISTORY-ID'; }], ['unsafe-version', value => { value.items[0].version = 9007199254740992; }], ['zero-version', value => { value.items[0].version = 0; }], ['typed-time', value => { value.items[0].updatedAt = { private: 'not shown' }; }], ['wrong-row-case', value => { value.items[0].caseId = caseB.id; }], ['duplicate-id', value => { value.items.push(structuredClone(value.items[0])); value.total = 2; }],
  ];
  await readOnly('G6 sixteen untrusted 2xx envelopes are rejected and recover manually', async () => {
    const trigger = await openIndex(admin), url = base + endpoint(caseA, 'assessments');
    for (const [name, change] of malformedVariants) { const handler = async route => { const response = await route.fetch(), value = await response.json(); change(value); await route.fulfill({ status: 200, json: value }); }; await admin.route(url, handler); await dialog(admin).getByLabel(/^紀錄種類/).selectOption('assessments'); await dialog(admin).getByRole('button', { name: '查詢紀錄', exact: true }).click(); await dialog(admin).getByRole('alert').getByText(badResponse, { exact: true }).waitFor(); assert.equal(await indexRows(admin).count(), 0); assert.equal(await dialog(admin).getByRole('button', { name: '此紀錄歷程', exact: true }).count(), 0); assert(!(await dialog(admin).innerText()).includes('not shown')); malformedChecks.push({ name, rejected: true, noHistoryAction: true }); await admin.unroute(url, handler); await dialog(admin).getByRole('alert').getByRole('button', { name: '重新讀取', exact: true }).click(); await waitIndex(admin, 1); }
    await closeDialog(admin, dialog(admin), trigger);
  }); mark('G6 sixteen exact malformed metadata/envelope variants, no leaked content/action and real retry');

  let safeVersion;
  const changeVersion = async (label, version) => fixtureWrite(label, () => { const before = raw(), beforeCounts = counts(), original = before.tables.records.find(row => row.id === longId); assert(original); const changed = app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, longId); assert.equal(changed.changes, 1); const after = raw(), expected = Object.assign(Object.create(Object.getPrototypeOf(original)), original, { version: BigInt(version) }); same(after.tables.records.find(row => row.id === longId), expected); for (const name of Object.keys(before.tables)) same(after.tables[name].filter(row => name !== 'records' || row.id !== longId), before.tables[name].filter(row => name !== 'records' || row.id !== longId), 'Only synthetic version cell differs'); assert.equal(counts().totalChanges - beforeCounts.totalChanges, 1); return original.version; });
  safeVersion = await changeVersion('G7 temporarily unsafe candidate version in private memory', 9007199254740992n);
  await readOnly('G7 unsafe version fails whole index before pagination', async () => { await request('GET', endpoint(caseA, 'care-plans', 2), undefined, 409); const unaffected = await request('GET', endpoint(caseB, 'assessments')); assert.equal(unaffected.total, 1); });
  await changeVersion('G7 restore exact safe synthetic SQL version', safeVersion); same(raw(), protectedBaseline); mark('G7 unsafe SQL metadata rejects entire result and exact private fixture restore');

  const historyUrl = entity => base + '/api/' + entity + '/' + main[entity].id + '/history?page=1&pageSize=25&compare=previous';
  const prepareState = async state => {
    const trigger = await openIndex(admin); let pending, modal = dialog(admin), rowTrigger;
    if (state.includes('history')) { await query(admin, 'assessments'); rowTrigger = rowById(admin, main.assessments.id).getByRole('button', { name: '此紀錄歷程', exact: true }); if (state.startsWith('pending')) pending = await held(admin, historyUrl('assessments')); await rowTrigger.click(); modal = admin.getByRole('dialog', { name: historyTitles.assessments, exact: true }); if (pending) await bounded(pending.arrived, 'history request arrival'); else await modal.getByText('第 2 版', { exact: true }).waitFor(); }
    else { if (state.startsWith('pending')) pending = await held(admin, base + endpoint(caseA, 'care-plans')); await dialog(admin).getByRole('button', { name: '查詢紀錄', exact: true }).click(); if (pending) await bounded(pending.arrived, 'index request arrival'); else await waitIndex(admin, 30); }
    return { trigger, rowTrigger, modal, pending };
  };
  await readOnly('G8 loaded/pending index/history six primitive invalidations', async () => {
    for (const state of ['loaded-index', 'pending-index', 'loaded-history', 'pending-history']) for (const primitive of ['user', 'org', 'role', 'employee', 'hash', 'render']) {
      stage = 'G8 ' + state + ' ' + primitive;
      const prepared = await prepareState(state), original = await prepared.modal.elementHandle(); let abort;
      if (prepared.pending) abort = abortEvent(admin, await prepared.pending.arrived, 'G8-' + state + '-' + primitive);
      await mutate(admin, primitive); await admin.waitForFunction(node => !node.isConnected, original); if (prepared.pending) { await prepared.pending.finish(); await abort; } await settle(admin); assert.equal(await admin.locator('dialog[open]').count(), 0); contextChecks.push({ state, primitive, originalModalDetached: true, lateResponseDidNotRevive: true, observedAbort: Boolean(abort) });
    }
  }); mark('G8 twenty-four loaded/pending index-history primitive guards and twelve real GET aborts');
  await readOnly('G9 nested reference negatives and same-value outer rebuild invalidations', async () => {
    for (const state of ['loaded-index', 'pending-index', 'loaded-history', 'pending-history']) {
      let prepared = await prepareState(state), original = await prepared.modal.elementHandle(); const reference = await replaceReferences(admin); assert.equal(await original.evaluate(node => node.isConnected && node.open), true); if (prepared.pending) { await prepared.pending.finish(); if (state.includes('history')) await prepared.modal.getByText('第 2 版', { exact: true }).waitFor(); else await waitIndex(admin, 30); } referenceChecks.push({ state, ...reference, realContentCompleted: true }); await closeDialog(admin, prepared.modal, prepared.rowTrigger || prepared.trigger); if (state.includes('history')) await closeDialog(admin, dialog(admin), prepared.trigger);
      prepared = await prepareState(state); original = await prepared.modal.elementHandle(); let abort; if (prepared.pending) abort = abortEvent(admin, await prepared.pending.arrived, 'G9-outer-' + state); const outer = await replaceReferences(admin, true); await admin.waitForFunction(node => !node.isConnected, original); if (prepared.pending) { await prepared.pending.finish(); await abort; } await settle(admin); assert.equal(await admin.locator('dialog[open]').count(), 0); outerRebuildChecks.push({ state, ...outer, originalModalDetached: true, observedAbort: Boolean(abort) });
    }
  }); mark('G9 four nested same-primitive negatives complete real content; four outer rebuilds conservatively invalidate');
  await readOnly('G10 Escape truly aborts pending index/history and restores focus', async () => {
    for (const state of ['pending-index', 'pending-history']) { const prepared = await prepareState(state), aborted = abortEvent(admin, await prepared.pending.arrived, 'G10-' + state); await closeDialog(admin, prepared.modal, prepared.rowTrigger || prepared.trigger); await prepared.pending.finish(); await aborted; await settle(admin); if (state.includes('history')) { assert.equal(await dialog(admin).count(), 1); assert.equal(await admin.getByRole('dialog', { name: historyTitles.assessments, exact: true }).count(), 0); await closeDialog(admin, dialog(admin), prepared.trigger); } else assert.equal(await admin.locator('dialog[open]').count(), 0); }
  }); mark('G10 exact pending GET abort observed before phase advance; literal DOM removal and trigger focus');

  await readOnly('G11 desktop/mobile full metadata text and original saved-history view', async () => {
    await admin.setViewportSize({ width: 390, height: 844 }); let trigger = await openIndex(admin); await query(admin, 'care-plans'); const longRow = rowById(admin, longId); await longRow.getByText('查看識別碼', { exact: true }).click(); const savedId = longRow.locator('code'); assert.equal(await savedId.textContent(), longId); await textGeometry(savedId, 'abcdef1234567890'); const timeCell = longRow.locator('td').nth(2); assert.equal(await timeCell.textContent(), longTime); await textGeometry(timeCell, timeLiteral); await shot(admin, 'index-original-time-mobile.png'); await closeDialog(admin, dialog(admin), trigger);
    trigger = await openIndex(admin); await query(admin, 'assessments'); const opened = await openHistory(admin, 'assessments', main.assessments); await opened.modal.locator('.history-snapshot').first().locator(':scope > summary').click(); await layout(admin); await shot(admin, 'index-assessment-history-mobile.png'); await closeDialog(admin, opened.modal, opened.trigger); await closeDialog(admin, dialog(admin), trigger); await admin.setViewportSize({ width: 1440, height: 1050 });
  }); mark('G11 390px preserved long ID/raw original time, real last literal above direct footer and nested history');
  await readOnly('G12 original case summaries and legacy finance/caregiver histories stay available', async () => {
    for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) { const actor = actors[role]; await loadCase(actor.page); await actor.page.getByRole('heading', { name: '服務接力', exact: true }).waitFor(); assert.equal(await actor.page.getByRole('button', { name: '保存紀錄索引', exact: true }).count(), ['admin', 'supervisor'].includes(role) ? 1 : 0); const trigger = actor.page.getByRole('button', { name: '個案版本歷程', exact: true }); await trigger.click(); const modal = actor.page.getByRole('dialog', { name: '個案版本歷程', exact: true }); await modal.getByText('第 1 版', { exact: true }).waitFor(); await closeDialog(actor.page, modal, trigger); const original = await request('GET', '/api/cases/' + caseA.id + '/history?compare=previous', undefined, 200, actor); assert.equal(original.items[0].snapshot.id, caseA.id); }
    const assessment = await request('GET', '/api/assessments/' + main.assessments.id + '/history?compare=previous'); assert.equal(assessment.items[0].snapshot.templateId, 'assessment-03'); const saved = (await request('GET', '/api/service-records/' + approved.id)).item; same(saved, approved); same(raw(), protectedBaseline);
  }); mark('G12 original four-role case details/history, assessment template and exact approved/BLOB/schema baseline unchanged');

  same(pageErrors, []); same(failedResponses.filter(event => !event.expectedRuleId), []); same(failedRequests.filter(event => !event.expectedRuleId), []);
  for (const rule of expectedFailures) assert.equal((rule.kind === 'http' ? failedResponses : failedRequests).filter(event => event.expectedRuleId === rule.id).length, rule.count, rule.id);
  for (const error of consoleErrors) { const rule = expectedFailures.find(rule => rule.phase === error.stage && rule.url === error.location.url && (rule.kind === 'http' ? error.text.includes('503') : error.text.includes(rule.failure))); assert(rule, 'Unallocated console error ' + json(error)); rule.actualConsoleCount = (rule.actualConsoleCount || 0) + 1; assert(rule.actualConsoleCount <= rule.maxConsoleCount); }
  for (let i = 0; i < stateLedger.length; i++) { assert.equal(stateLedger[i].sequence, i + 1); if (i) { assert.equal(stateLedger[i - 1].afterSha256, stateLedger[i].beforeSha256); same(stateLedger[i - 1].afterCounts, stateLedger[i].beforeCounts); } }
  assert.equal(stateLedger.at(-1).afterSha256, sha(raw())); same(stateLedger.at(-1).afterCounts, counts());
  const sourceHashesAfter = await sourceMap(); same(sourceHashesAfter, sourceHashesBefore); assert.equal(checks.length, 12); assert.equal(readSegments.length, 12); assert.equal(fixtureWrites.length, 6); assert.equal(stateLedger.length, 18); assert.equal(contextChecks.length, 24); assert.equal(referenceChecks.length, 4); assert.equal(outerRebuildChecks.length, 4); assert.equal(malformedChecks.length, 16); assert.equal(screenshots.length, 9); assert.equal(footerChecks.length, 2); assert.equal(expectedFailures.length, 17);
  const report = { passed: true, completedAt: now(), syntheticOnly: true, database: ':memory:', randomLoopback: true, base, checks, sourceHashesBefore, sourceHashesAfter, sourceCount: Object.keys(sourceHashesBefore).length, runtimeSourceCount: Object.keys(sourceHashesBefore).filter(rel => rel.startsWith('public/') || rel.startsWith('src/')).length, readSegments, fixtureWrites, stateLedger, contextChecks, referenceChecks, outerRebuildChecks, malformedChecks, footerChecks, expectedFailures, failedResponses, failedRequests, consoleErrors, pageErrors, requestLedger, screenshots, protectedRowsAndBlobsUnchanged: true, snapshotUnchanged: true, expectedConsoleFailuresOnly: true, actuallyViewedByScript: false, visualReviewPending: true };
  const p = path.join(output, 'e2e.json'); await writeFile(p, json(report), { flag: 'wx' }); console.log('RESULT ' + p);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const report = { passed: false, completedAt: now(), stage, error: error.stack, checks, readSegments, fixtureWrites, stateLedger, contextChecks, referenceChecks, outerRebuildChecks, malformedChecks, footerChecks, screenshots, expectedFailures, failedResponses, failedRequests, consoleErrors, pageErrors, requestLedger, sourceHashesBefore, sourceHashesAfter: await sourceMap().catch(() => null), actuallyViewedByScript: false, visualReviewPending: true };
  const p = path.join(output, 'failure.json'); await writeFile(p, json(report), { flag: 'wx' }); console.log('RESULT ' + p); throw error;
} finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); await browser?.close(); await app.close(); }
