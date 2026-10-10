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

// Owned synthetic memory factory only. No default server, disk DB, environment,
// real account, Portal binding, private backup, DNS or deployment is contacted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, 'outputs/software/case-followup-worklist-qa');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const installed = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [chromium.executablePath(), ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
const app = createApp({ dbPath: ':memory:', port: 0 });
const endpoint = 'case-followup-worklist', entity = 'case-status-followups', password = 'synthetic-worklist-browser-password';
const fields = ['kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status'];
const dtoKeys = ['id', 'orgId', 'version', 'caseId', 'caseNo', 'caseName', 'fields'];
const emptyFilters = { q: '', kind: '', status: '', followUpDate: '', caseId: '' };
const names = { page: '人工追蹤查詢', search: '搜尋人工追蹤內容', detail: '人工追蹤保存內容', history: '暫停與結案追蹤版本歷程' };
const checks = [], readSegments = [], fixtureWrites = [], contextChecks = [], referenceChecks = [], outerRebuildChecks = [], projectionChecks = [], footerChecks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], failedRequests = [], expectedFailures = [], contexts = [];
let browser, base, lastPage, queryBaseline, queryCounts, stage = 'initialization';
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { sqliteInteger: item.toString() } : item);
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');
const same = (a, b, message) => assert.deepEqual(a, b, message);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return { schema, tables: Object.fromEntries(tables.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })) };
};
const counts = () => ({ totalChanges: app.db.prepare('SELECT total_changes() n').get().n, records: app.db.prepare('SELECT count(*) n FROM records').get().n, versions: app.db.prepare('SELECT count(*) n FROM record_versions').get().n, audit: app.db.prepare('SELECT count(*) n FROM audit').get().n, idempotency: app.db.prepare('SELECT count(*) n FROM idempotency').get().n });
const readOnly = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(); await action(); const after = raw(), afterCounts = counts();
  same(after, before, label + ': exact full eleven tables/six triggers/schema/BLOBs'); same(afterCounts, beforeCounts, label + ': total_changes zero');
  readSegments.push({ label, tableCount: 11, triggerCount: 6, beforeSha256: sha(before), afterSha256: sha(after), beforeCounts, afterCounts, zeroWrites: true });
};
const fixtureWrite = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(), result = await action(), after = raw(), afterCounts = counts();
  same(before.schema, after.schema, 'Fixture mutations never change schema or six triggers');
  fixtureWrites.push({ label, fixtureOnly: true, beforeSha256: sha(before), afterSha256: sha(after), beforeCounts, afterCounts, totalChangesDelta: afterCounts.totalChanges - beforeCounts.totalChanges, changedTables: Object.keys(before.tables).filter(key => sha(before.tables[key]) !== sha(after.tables[key])) });
  queryBaseline = after; queryCounts = afterCounts; return result;
};
const expectFailure = rule => { assert(!expectedFailures.some(item => item.id === rule.id)); expectedFailures.push(rule); };
const observe = page => {
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => pageErrors.push({ stage, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ stage, text: message.text(), location: message.location() }); });
  page.on('response', response => { if (response.status() < 400) return; const rule = expectedFailures.find(item => item.kind === 'http' && item.phase === stage && item.url === response.url() && item.method === response.request().method() && item.status === response.status()); failedResponses.push({ stage, url: response.url(), method: response.request().method(), status: response.status(), expectedRuleId: rule?.id || null }); });
  page.on('requestfailed', request => { const failure = request.failure()?.errorText || ''; const rule = expectedFailures.find(item => item.kind === 'requestfailed' && item.phase === stage && item.url === request.url() && item.method === request.method() && item.failure === failure); failedRequests.push({ stage, url: request.url(), method: request.method(), failure, expectedRuleId: rule?.id || null }); });
};
const rows = page => page.locator('.list-content tbody tr');
const waitList = page => page.locator('.list-content .loading').waitFor({ state: 'detached' });
const load = async page => { lastPage = page; const target = base + '/#/case-followup-worklist'; if (page.url() === target) await page.reload(); else await page.goto(target); await page.getByRole('heading', { name: names.page, level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); };
const listResponse = (page, predicate) => page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/' + endpoint && predicate(new URL(response.url())));
const search = async (page, q) => { const input = page.getByLabel(names.search, { exact: true }); await input.fill(q); const received = listResponse(page, url => (url.searchParams.get('q') || '') === q); await input.press('Enter'); const response = await received; assert.equal(response.status(), 200, await response.text()); await waitList(page); return response.json(); };
const filter = async (page, label, value, key) => { const received = listResponse(page, url => (url.searchParams.get(key) || '') === value); const control = page.getByLabel(label, { exact: true }); if (key === 'followUpDate') await control.fill(value); else await control.selectOption(value); const response = await received; assert.equal(response.status(), 200, await response.text()); await waitList(page); return response.json(); };
const findRow = async (page, q) => { const response = await search(page, q); assert.equal(response.total, 1); assert.equal(await rows(page).count(), 1); return rows(page).first(); };
const openDetails = async (page, q) => { const row = await findRow(page, q), trigger = row.getByRole('button', { name: '查看完整內容', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: names.detail, exact: true }); await dialog.waitFor(); return { dialog, trigger }; };
const openHistory = async (page, q) => { const row = await findRow(page, q), trigger = row.getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: names.history, exact: true }); await dialog.waitFor(); return { dialog, trigger }; };
const close = async (page, trigger) => { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); if (trigger) assert(await trigger.evaluate(node => node === document.activeElement), 'Escape returns focus to exact trigger'); };
const noSecrets = async locator => assert(!/HIDDEN_NESTED|HIDDEN_ARRAY|HIDDEN_UNKNOWN|UNKNOWN_KEY|METADATA_SEARCH_ONLY|BILLING_SECRET|\[object Object\]/.test(await locator.textContent()), 'Nested/unknown/metadata/JSON content stays hidden');
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No full-page horizontal overflow');
  for (const link of await page.locator('.list-content a').filter({ hasText: '前往個案維護' }).all()) assert(await link.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height); return node.matches('.btn.btn-outline') && getComputedStyle(node).whiteSpace === 'nowrap' && rects.length === 1; }), 'Every parent handoff remains a single-line canonical link, not a narrow vertical text column');
  same(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), [], 'Visible native controls labelled');
  for (const dialog of await page.getByRole('dialog').all()) assert(await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog fits viewport');
  for (const table of await page.locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => { assert(screenshots.length < 16, 'Maximum sixteen actual screenshots'); await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push({ name, sha256: sha(await readFile(path.join(output, name))), viewport: page.viewportSize(), actuallyViewed: false }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), 15000); timer.unref(); })]);
const held = async (page, pattern, predicate) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false;
  const handler = async route => { if (used || !predicate(route.request())) return route.continue(); used = true; try { const response = await route.fetch(); arrived.resolve({ url: route.request().url(), method: route.request().method(), response }); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } };
  await page.route(pattern, handler);
  return { arrived: arrived.promise, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'held response'); await page.unroute(pattern, handler); } };
};
const expectAbort = (page, ruleId, arrival) => { assert.equal(arrival.method, 'GET'); expectFailure({ id: ruleId, kind: 'requestfailed', phase: stage, url: arrival.url, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, clientContextOrEscapeAbort: true }); return page.waitForEvent('requestfailed', request => request.url() === arrival.url && request.method() === 'GET' && request.failure()?.errorText === 'net::ERR_ABORTED'); };
const mutateContext = async (page, primitive, foreignOrg) => page.evaluate(async ({ primitive, foreignOrg }) => {
  const ui = await import('/ui.js'), current = ui.getContext();
  if (primitive === 'hash') { location.hash = '/employees'; return; }
  if (primitive === 'render') { document.querySelector('[data-render-version]').dataset.renderVersion = crypto.randomUUID(); return; }
  if (primitive === 'user') current.user.id = 'synthetic-worklist-other-user';
  if (primitive === 'org') { current.organizationId = foreignOrg; current.orgId = foreignOrg; }
  if (primitive === 'role') { current.role = 'finance'; current.user.role = 'finance'; }
  if (primitive === 'employee') current.user.employeeId = 'synthetic-worklist-other-employee';
  const mounted = document.querySelector('[data-render-version]'); mounted.setAttribute('data-render-version', mounted.dataset.renderVersion);
}, { primitive, foreignOrg });
const replaceNestedReferences = async page => page.evaluate(async () => { const ui = await import('/ui.js'), current = ui.getContext(); const before = JSON.stringify([current.user?.id ?? null, current.organizationId ?? current.orgId ?? null, current.role ?? null, current.user?.employeeId ?? null]); const user = current.user, orgs = current.organizations; current.user = { ...current.user }; current.organizations = current.organizations.map(item => ({ ...item })); if (user === current.user || orgs === current.organizations) throw new Error('Nested references did not change'); const after = JSON.stringify([current.user?.id ?? null, current.organizationId ?? current.orgId ?? null, current.role ?? null, current.user?.employeeId ?? null]); if (before !== after) throw new Error('Reference negative changed primitives'); const mounted = document.querySelector('[data-render-version]'); mounted.setAttribute('data-render-version', mounted.dataset.renderVersion); return { before, after, outerReferenceKept: current === ui.getContext(), userAndOrganizationReferencesChanged: true }; });
const suffixGeometry = async (locator, lastLine, literal) => {
  await locator.evaluate(node => node.scrollIntoView({ block: 'end' }));
  await locator.evaluate(node => { const dialog = node.closest('dialog'), footer = dialog.querySelector('.dialog-footer'); dialog.scrollTop += Math.max(0, node.getBoundingClientRect().bottom - footer.getBoundingClientRect().top + 20); });
  return locator.evaluate((node, { lastLine, literal }) => {
    const dialog = node.closest('dialog'), footer = dialog.querySelector('.dialog-footer').getBoundingClientRect(), area = dialog.getBoundingClientRect(); const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let textNode; while (walker.nextNode()) if (walker.currentNode.textContent.includes(literal)) textNode = walker.currentNode; if (!textNode) throw new Error('Real saved suffix text node absent');
    const measure = text => { const start = textNode.textContent.lastIndexOf(text); if (start < 0) throw new Error('Saved suffix absent'); const range = document.createRange(); range.setStart(textNode, start); range.setEnd(textNode, start + text.length); return [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => { const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, insideDialogAboveFooter: rect.top >= Math.max(0, area.top) && rect.bottom <= Math.min(innerHeight, footer.top) && rect.left >= Math.max(0, area.left) && rect.right <= Math.min(innerWidth, area.right), hitTestVisible: Boolean(hit && (hit === node || node.contains(hit))) }; }); };
    return { footerTop: footer.top, dialogTop: area.top, scrollTop: dialog.scrollTop, clientHeight: dialog.clientHeight, scrollHeight: dialog.scrollHeight, lastLineRects: measure(lastLine), finalLiteralRects: measure(literal) };
  }, { lastLine, literal });
};

try {
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const adminClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(adminClient);
  const setup = await fixtureWrite('owned synthetic setup and session', () => adminClient.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成人工追蹤管理員', email: 'worklist-admin@example.test', password, organizationName: '合成人工追蹤甲機構' } }));
  assert.equal(setup.status(), 201, await setup.text()); const adminAuth = await setup.json(), orgId = adminAuth.organizations[0].id;
  const admin = await adminClient.newPage(); observe(admin); const actors = { admin: { client: adminClient, auth: adminAuth, page: admin } };
  const request = async (method, route, data, expected = 200, actor = actors.admin, selectedOrg = orgId, extraHeaders = {}) => {
    const response = await actor.client.request.fetch(base + '/api/' + route, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': actor.auth.csrfToken, ...extraHeaders }, ...(data === undefined ? {} : { data }) });
    const result = await response.json(); assert.equal(response.status(), expected, method + ' ' + route + ' ' + JSON.stringify(result)); return result;
  };
  const post = async (kind, data, selectedOrg = orgId) => (await request('POST', kind, data, 201, actors.admin, selectedOrg)).item;
  const patch = async (kind, item, values, actor = actors.admin) => (await request('PATCH', kind + '/' + item.id, { version: item.version, ...values }, 200, actor)).item;
  let employee, foreign, caseA, caseB, closedCase, foreignCase, approved;
  await fixtureWrite('four roles, three independent login sessions and two orgs/cases', async () => {
    employee = await post('employees', { employeeNo: 'WORK-E01', name: '合成人工追蹤居服', role: 'caregiver', hourlyRateCents: 12345 });
    for (const role of ['supervisor', 'finance', 'caregiver']) {
      await post('users', { name: '合成人工追蹤' + role, email: 'worklist-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
      const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(client);
      const response = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'worklist-' + role + '@example.test', password } }); assert.equal(response.status(), 200);
      const page = await client.newPage(); observe(page); actors[role] = { client, auth: await response.json(), page };
    }
    foreign = await post('organizations', { name: '合成人工追蹤乙機構' });
    caseA = await post('cases', { caseNo: 'WORK-SAME-A', name: '合成同名人工追蹤個案' });
    caseB = await post('cases', { caseNo: 'WORK-SAME-B', name: '合成同名人工追蹤個案' }); caseB = await patch('cases', caseB, { status: 'paused' });
    closedCase = await post('cases', { caseNo: 'WORK-CLOSED', name: '合成已結案人工追蹤個案' }); closedCase = await patch('cases', closedCase, { status: 'closed' });
    foreignCase = await post('cases', { caseNo: 'WORK-FOREIGN', name: '合成乙機構不得顯示個案' }, foreign.id);
  });
  await readOnly('G1 empty new module and finance/caregiver pre-parse role guards', async () => {
    await load(admin); assert.equal(await rows(admin).count(), 0); await shot(admin, 'empty-desktop.png');
    for (const role of ['finance', 'caregiver']) {
      const actor = actors[role]; await actor.page.goto(base + '/#/'); await actor.page.waitForLoadState('networkidle'); assert.equal(await actor.page.getByRole('link', { name: names.page, exact: true }).count(), 0);
      for (const [method, route, data] of [['GET', endpoint + '?unknown=1'], ['GET', endpoint + '/' + caseA.id + '?unknown=1'], ['POST', endpoint, {}], ['PATCH', endpoint + '/' + caseA.id, {}], ['DELETE', endpoint + '/' + caseA.id, undefined]]) await request(method, route, data, 403, actor);
      await actor.page.goto(base + '/#/case-followup-worklist'); await actor.page.waitForLoadState('networkidle'); assert.equal(await actor.page.getByRole('button', { name: '查看完整內容', exact: true }).count(), 0);
    }
  });
  await fixtureWrite('owned unsupported membership role negative setup', async () => { const result = app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('synthetic_future_role', orgId, actors.supervisor.auth.user.id); assert.equal(result.changes, 1); });
  await readOnly('G1 unknown role is denied before method and query parsing', async () => { for (const [method, route, data] of [['GET', endpoint + '?unknown=1'], ['GET', endpoint + '/invalid?unknown=1'], ['POST', endpoint, {}]]) await request(method, route, data, 403, actors.supervisor); });
  await fixtureWrite('restore owned supervisor membership before query baseline', async () => { const result = app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('supervisor', orgId, actors.supervisor.auth.user.id); assert.equal(result.changes, 1); });
  mark('G1 owned memory/randomloopback／twoorg fourroles／empty／new-role and finance/caregiver pre-parse403');

  const lastReason = '合成完整原因第160行：只供人工閱讀，不推算期限。', reasonLiteral = '合成手機原因最後一行完整可讀';
  const lastNote = '合成完整備註第160行：只保存人工追蹤紀錄。', noteLiteral = '合成手機備註最後一行完整可讀';
  const longReason = 'WORK-MAIN 合成長原因開頭\n' + Array.from({ length: 160 }, (_, i) => '合成完整原因第' + (i + 1) + '行：只供人工閱讀，不推算期限。').join('\n') + '\n' + reasonLiteral;
  const longNote = '合成長備註開頭\n' + Array.from({ length: 160 }, (_, i) => '合成完整備註第' + (i + 1) + '行：只保存人工追蹤紀錄。').join('\n') + '\n' + noteLiteral;
  assert(longReason.length < 10000 && longNote.length < 10000);
  let main, typed, unknown, blank, foreignItem, previousMain, corrupts;
  const pageItems = [];
  const imported = (caseId, values, selectedOrg = orgId, options = {}) => {
    const time = now(), item = { ...values, caseId, id: options.id ?? id(), orgId: selectedOrg, version: options.version ?? 1, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, selectedOrg, options.entity || entity, JSON.stringify({ ...values, caseId }), item.version, time, time);
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(selectedOrg, options.entity || entity, item.id, item.version, JSON.stringify(item), time, 'baseline'); return item;
  };
  await fixtureWrite('synthetic followups, raw tags/pages and exact approved snapshot/nonempty BLOBs', async () => {
    const service = await post('service-items', { code: 'WORK-SERVICE', name: '合成既有服務', minutes: 60, unitPriceCents: 12345 });
    const plan = await post('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
    const shift = await post('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-20', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
    let record = await post('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }], status: 'submitted' });
    record = (await request('POST', 'service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成查詢快照基準' })).item; approved = structuredClone(record);
    await post('case-attachments/upload', { caseId: caseA.id, title: '合成非空個案附件', category: 'general', ...filePayload(PDF_BYTES) });
    const certificate = await post('employee-certifications', { employeeId: employee.id, name: '合成證照', issuedOn: '2026-01-01' });
    await post('certification-attachments/upload', { certificationId: certificate.id, title: '合成非空證照附件', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
    main = await post(entity, { caseId: caseA.id, kind: 'pause', startDate: '2026-10-01', endDate: '2026-10-31', reason: longReason, followUpDate: '2026-11-02', outcome: '合成初版結果', note: longNote, status: 'pending' });
    main = await patch(entity, main, { outcome: '合成前版結果' });
    typed = imported(caseB.id, { kind: { hidden: 'HIDDEN_NESTED' }, startDate: null, endDate: ['HIDDEN_ARRAY'], reason: 0, outcome: 'WORK-TYPED 合成型別定位', note: '', status: false, UNKNOWN_KEY: 'HIDDEN_UNKNOWN', metadata: 'METADATA_SEARCH_ONLY' });
    unknown = imported(closedCase.id, { kind: '合成未知人工類型', startDate: '0000-01-01', endDate: '2026-02-30', reason: 'WORK-UNKNOWN\r\n合成原樣原因', followUpDate: '2026-11-03', outcome: '合成未知狀態結果', note: '合成 CR\rLF\n備註', status: '合成未知人工狀態', UNKNOWN_KEY: 'HIDDEN_UNKNOWN' });
    blank = imported(closedCase.id, { kind: 'closure', startDate: '', endDate: '', reason: 'WORK-BLANK 合成空文字', followUpDate: '', outcome: null, note: { hidden: 'HIDDEN_NESTED' }, status: 'cancelled' });
    for (let i = 0; i < 28; i++) pageItems.push(imported(i % 2 ? caseB.id : caseA.id, { kind: i % 2 ? 'closure' : 'pause', startDate: '2026-10-01', endDate: '', reason: 'WORK-PAGE ' + String(i + 1).padStart(2, '0'), followUpDate: i % 2 ? '2026-11-04' : '2026-11-03', outcome: i % 3 ? '合成結果ABC' : '合成結果', note: 'DEF合成備註', status: ['pending', 'completed', 'cancelled'][i % 3], UNKNOWN_KEY: 'HIDDEN_UNKNOWN', metadata: 'METADATA_SEARCH_ONLY' }));
    imported(id(), { kind: 'pause', reason: 'WORK-ORPHAN 不可顯示' }); imported(foreignCase.id, { kind: 'pause', reason: 'WORK-CROSS-PARENT 不可顯示' });
    foreignItem = await post(entity, { caseId: foreignCase.id, kind: 'closure', startDate: '2026-10-01', reason: 'WORK-FOREIGN 不可顯示' }, foreign.id);
    imported(caseA.id, { reason: 'WORK-NONENTITY 不可顯示' }, orgId, { entity: 'announcements' });
    corrupts = [['empty-id', { id: '' }], ['zero-version', { version: 0 }], ['unsafe-version', { version: 9007199254740993n }]].map(([label, options]) => {
      const value = { kind: 'pause', reason: 'WORK-CORRUPT-' + label, startDate: '2026-10-01', status: 'pending' };
      if (typeof options.version === 'bigint') { const time = now(), recordId = id(); app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, foreign.id, entity, JSON.stringify({ ...value, caseId: foreignCase.id }), options.version, time, time); return { id: recordId, reason: value.reason }; }
      return imported(foreignCase.id, value, foreign.id, options);
    });
  });
  const protectedBefore = raw();
  const protectedRaw = value => ({ schema: value.schema, tables: Object.fromEntries(Object.entries(value.tables).map(([key, rows]) => [key, key === 'records' ? rows.filter(row => row.entity !== entity) : key === 'record_versions' ? rows.filter(row => row.entity !== entity) : key === 'audit' ? rows.filter(row => row.entity !== entity) : rows])) });
  const assertProtected = () => same(protectedRaw(raw()), protectedRaw(protectedBefore), 'All original unrelated rows/schema/nonempty BLOBs/approved pricing snapshot preserved');
  await readOnly('G2 exact seven DTO keys/eight tags and 32 rows/25+7 same-name case IDs', async () => {
    const result = await request('GET', endpoint + '?pageSize=25'); same(Object.keys(result).sort(), ['items', 'total', 'page', 'pageSize', 'filters'].sort()); same(result.filters, emptyFilters); assert.equal(result.total, 32); assert.equal(result.items.length, 25);
    const parents = new Map([caseA, caseB, closedCase].map(item => [item.id, item]));
    for (const row of result.items) { same(Object.keys(row).sort(), [...dtoKeys].sort()); same(Object.keys(row.fields).sort(), [...fields].sort()); assert.equal(row.orgId, orgId); assert(Number.isSafeInteger(row.version) && row.version > 0); assert(parents.has(row.caseId)); assert.equal(row.caseNo, parents.get(row.caseId).caseNo); assert.equal(row.caseName, parents.get(row.caseId).name); }
    await load(admin); assert.equal(await rows(admin).count(), 25); assert.equal(await admin.getByRole('button', { name: /新增|儲存|刪除|匯出|列印/ }).count(), 0);
    const cases = admin.getByLabel('個案篩選', { exact: true }); for (const item of [caseA, caseB, closedCase]) assert.equal(await cases.locator('option[value="' + item.id + '"]').count(), 1);
    assert(/暫停/.test(await cases.locator('option[value="' + caseB.id + '"]').innerText())); assert(/已結案/.test(await cases.locator('option[value="' + closedCase.id + '"]').innerText()));
    await shot(admin, 'list-desktop.png'); const next = listResponse(admin, url => url.searchParams.get('page') === '2'); await admin.getByRole('button', { name: '下一頁', exact: true }).click(); await next; await waitList(admin); assert.equal(await rows(admin).count(), 7);
    for (const [caseItem, expected] of [[caseA, 15], [caseB, 15], [closedCase, 2]]) { const filtered = await filter(admin, '個案篩選', caseItem.id, 'caseId'); assert.equal(filtered.total, expected); assert(filtered.items.every(item => item.caseId === caseItem.id)); }
    await filter(admin, '個案篩選', '', 'caseId'); await load(actors.supervisor.page); assert.equal((await request('GET', endpoint, undefined, 200, actors.supervisor)).total, 32);
  }); mark('G2 exact DTO7/tags8／32 real25+7 pages／same-name ID／paused and closed parent visibility');
  await readOnly('G3 real28-item pagination, five filters and explicit clears', async () => {
    await load(admin); let result = await search(admin, 'WORK-PAGE'); assert.equal(result.total, 28); assert.equal(result.items.length, 25); const firstIds = result.items.map(item => item.id);
    const next = listResponse(admin, url => url.searchParams.get('page') === '2' && url.searchParams.get('q') === 'WORK-PAGE'); await admin.getByRole('button', { name: '下一頁', exact: true }).click(); result = await (await next).json(); await waitList(admin); assert.equal(result.items.length, 3); assert.equal(await rows(admin).count(), 3); same([...firstIds, ...result.items.map(item => item.id)].sort(), pageItems.map(item => item.id).sort());
    result = await filter(admin, '追蹤類型篩選', 'pause', 'kind'); assert.equal(result.total, 14); same(result.filters, { ...emptyFilters, q: 'WORK-PAGE', kind: 'pause' });
    result = await filter(admin, '狀態', 'pending', 'status'); assert.equal(result.total, 5);
    result = await filter(admin, '人工追蹤日期篩選', '2026-11-03', 'followUpDate'); assert.equal(result.total, 5);
    result = await filter(admin, '個案篩選', caseA.id, 'caseId'); assert.equal(result.total, 5); same(result.filters, { q: 'WORK-PAGE', kind: 'pause', status: 'pending', followUpDate: '2026-11-03', caseId: caseA.id }); await shot(admin, 'filtered-desktop.png');
    const clearedDate = listResponse(admin, url => !url.searchParams.has('followUpDate')); await admin.getByRole('button', { name: '清除追蹤日期', exact: true }).click(); await clearedDate; await waitList(admin); assert(await admin.getByLabel('人工追蹤日期篩選', { exact: true }).evaluate(node => node === document.activeElement));
    const clearedCase = listResponse(admin, url => !url.searchParams.has('caseId')); await admin.getByRole('button', { name: '清除個案條件', exact: true }).click(); await clearedCase; await waitList(admin); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), '');
    await filter(admin, '追蹤類型篩選', '', 'kind'); await filter(admin, '狀態', '', 'status'); await search(admin, '');
    for (const q of ['HIDDEN_NESTED', 'HIDDEN_ARRAY', 'HIDDEN_UNKNOWN', 'UNKNOWN_KEY', 'METADATA_SEARCH_ONLY', '合成同名人工追蹤個案', 'WORK-SAME-A', 'ABCDEF', 'WORK-ORPHAN', 'WORK-CROSS-PARENT', 'WORK-NONENTITY']) assert.equal((await search(admin, q)).total, 0, 'Only three separate own-string business fields are searched: ' + q);
    await shot(admin, 'no-results-desktop.png');
    const lower = await search(admin, 'work-page'); assert.equal(lower.total, 28); const spaces = await request('GET', endpoint + '?q=' + encodeURIComponent(' WORK-PAGE ')); assert.equal(spaces.filters.q, ' WORK-PAGE '); assert.equal(spaces.total, 0, 'Leading/trailing q spaces are not silently trimmed');
    assert.equal((await request('GET', endpoint + '?q=WORK-MAIN&followUpDate=2026-11-02')).total, 1); assert.equal((await request('GET', endpoint + '?q=WORK-MAIN&followUpDate=2026-10-01')).total, 0);
    await search(admin, 'WORK-MAIN'); assert.equal(new URL(admin.url()).hash, '#/case-followup-worklist'); assert.equal(new URL(admin.url()).search, ''); assert(!await admin.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('WORK-MAIN')));
  }); mark('G3 exact five-filter intersections/reset／28 real25+3 unique IDs／q only own reason/outcome/note and not joined/metadata');
  await readOnly('G4 full saved tags, unknown text and raw CR/LF projection', async () => {
    const projection = (await request('GET', endpoint + '/' + typed.id)).item; same(Object.keys(projection).sort(), [...dtoKeys].sort()); same(projection.fields.kind, { kind: 'object' }); same(projection.fields.startDate, { kind: 'null' }); same(projection.fields.endDate, { kind: 'array' }); same(projection.fields.reason, { kind: 'number' }); same(projection.fields.followUpDate, { kind: 'missing' }); same(projection.fields.note, { kind: 'string', value: '' }); same(projection.fields.status, { kind: 'boolean' });
    let opened = await openDetails(admin, 'WORK-TYPED'); await opened.dialog.getByText('WORK-TYPED 合成型別定位', { exact: true }).waitFor(); await noSecrets(opened.dialog); assert.equal(await opened.dialog.getByRole('button', { name: /儲存|編輯|刪除|列印/ }).count(), 0); await shot(admin, 'typed-detail-desktop.png'); await close(admin, opened.trigger);
    const savedUnknown = (await request('GET', endpoint + '/' + unknown.id)).item; same(savedUnknown.fields.reason, { kind: 'string', value: unknown.reason }); same(savedUnknown.fields.note, { kind: 'string', value: unknown.note }); same(savedUnknown.fields.endDate, { kind: 'string', value: '2026-02-30' });
    opened = await openDetails(admin, 'WORK-UNKNOWN'); await opened.dialog.getByText('保存文字：合成未知人工類型', { exact: true }).waitFor(); await opened.dialog.getByText('保存文字：合成未知人工狀態', { exact: true }).waitFor(); await noSecrets(opened.dialog); await close(admin, opened.trigger);
    projectionChecks.push({ exactRowKeys: 7, exactFieldTags: 8, everyNonStringKindProjectedWithoutValue: true, rawCrLfPreservedByApi: true, unknownKindAndStatusDisplayedAsSavedText: true });
  }); mark('G4 all eight tag kinds／raw empty/missing/null/JSON/CRLF／unknown saved kind-status text without guessed actions');
  let capturedRow, capturedVersion;
  await readOnly('G5 capture original list row before isolated authorized fixture update', async () => { await load(admin); capturedRow = await findRow(admin, 'WORK-MAIN'); const original = (await request('GET', endpoint + '?q=WORK-MAIN')).items[0]; capturedVersion = original.version; assert.equal(capturedVersion, 2); previousMain = structuredClone(main); });
  await fixtureWrite('authorized supervisor synthetic update after list capture, before fresh read', async () => { main = await patch(entity, main, { outcome: '合成 fresh 目前結果' }, actors.supervisor); assert.equal(main.version, capturedVersion + 1); }); assertProtected();
  await readOnly('G5 captured row opens newer fresh single every time', async () => {
    let singleGets = 0; const counter = req => { if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/' + endpoint + '/' + main.id) singleGets++; }; admin.on('request', counter);
    try {
      const trigger = capturedRow.getByRole('button', { name: '查看完整內容', exact: true }); await trigger.click(); let dialog = admin.getByRole('dialog', { name: names.detail, exact: true }); await dialog.getByText('合成 fresh 目前結果', { exact: true }).waitFor(); await dialog.getByText(longReason, { exact: true }).waitFor(); await dialog.getByText(longNote, { exact: true }).waitFor(); assert.equal((await request('GET', endpoint + '/' + main.id)).item.version, 3); await noSecrets(dialog); await shot(admin, 'detail-desktop.png'); await close(admin, trigger);
      const second = await openDetails(admin, 'WORK-MAIN'); await second.dialog.getByText('合成 fresh 目前結果', { exact: true }).waitFor(); await close(admin, second.trigger); assert.equal(singleGets, 2);
    } finally { admin.off('request', counter); }
    projectionChecks.push({ capturedVersion, freshVersion: main.version, acceptedExactIdOrgCaseNewerVersion: true, actualSingleGetCount: singleGets });
  }); mark('G5 actual version2-list→authorized fixture version3／fresh single identity and full reason-note／two opens two GETs');
  await readOnly('G6 original nine-field history actors/previous and captured parent handoff', async () => {
    const history = await request('GET', entity + '/' + main.id + '/history?compare=previous'); assert.equal(history.total, 3); same(history.items.map(entry => entry.actor.id), [actors.supervisor.auth.user.id, adminAuth.user.id, adminAuth.user.id]); same(history.items[0].snapshot, main); same(history.items[0].comparison.previousSnapshot, previousMain);
    for (const key of ['caseId', ...fields]) same(history.items[0].comparison.previousSnapshot[key], previousMain[key]);
    const opened = await openHistory(admin, 'WORK-MAIN'); await opened.dialog.getByText('合成人工追蹤supervisor', { exact: true }).waitFor(); await opened.dialog.getByText('第 2 版', { exact: true }).click(); await opened.dialog.getByText('合成人工追蹤管理員', { exact: true }).first().waitFor(); await opened.dialog.getByText('合成前版結果', { exact: true }).first().waitFor(); await shot(admin, 'history-desktop.png'); await close(admin, opened.trigger);
    let row = await findRow(admin, 'WORK-MAIN'); const link = row.getByRole('link', { name: '前往個案維護', exact: true }); assert.equal(await link.getAttribute('href'), '#/cases/' + encodeURIComponent(caseA.id));
    const detail = await openDetails(admin, 'WORK-MAIN'); await detail.dialog.getByText('合成 fresh 目前結果', { exact: true }).waitFor(); assert.equal(await detail.dialog.getByRole('link', { name: '前往個案維護', exact: true }).getAttribute('href'), '#/cases/' + encodeURIComponent(caseA.id)); await close(admin, detail.trigger);
    row = await findRow(admin, 'WORK-MAIN'); await row.getByRole('link', { name: '前往個案維護', exact: true }).click(); await admin.getByRole('heading', { name: caseA.name, level: 1, exact: true }).waitFor(); await admin.waitForLoadState('networkidle'); assert.equal(new URL(admin.url()).hash, '#/cases/' + encodeURIComponent(caseA.id)); assert.equal(await admin.getByRole('dialog').count(), 0);
    const originalPanel = admin.getByRole('region', { name: '暫停與結案追蹤', exact: true }); await originalPanel.getByLabel('追蹤紀錄搜尋', { exact: true }).fill('WORK-MAIN'); await originalPanel.getByLabel('追蹤紀錄搜尋', { exact: true }).press('Enter'); await originalPanel.locator('[data-followup-id="' + main.id + '"]').waitFor(); assert.equal(await originalPanel.getByRole('button', { name: '新增追蹤紀錄', exact: true }).count(), 1); await shot(admin, 'parent-sibling-desktop.png');
    for (const role of ['finance', 'caregiver']) {
      const actor = actors[role]; assert((await request('GET', entity + '?caseId=' + caseA.id, undefined, 200, actor)).items.some(item => item.id === main.id)); await request('GET', entity + '/' + main.id, undefined, 200, actor); await request('GET', entity + '/' + main.id + '/history?compare=previous', undefined, 200, actor);
      await request('POST', entity, { caseId: caseA.id, kind: 'pause', startDate: '2026-10-01', reason: '合成禁止新增' }, 403, actor); await request('PATCH', entity + '/' + main.id, { version: main.version, note: '合成禁止覆寫' }, 403, actor);
      await request('GET', endpoint, undefined, 403, actor); await request('GET', endpoint + '/' + main.id, undefined, 403, actor);
    }
  }); mark('G6 original followup9-field precise history/actual actors／captured ID parent link／four-role generic remains unchanged');
  await readOnly('G7 closed queries, wrong entity/org, safe integer guard and GET-only', async () => {
    for (const route of [endpoint + '?page=1e2', endpoint + '?pageSize=0', endpoint + '?q=a&q=b', endpoint + '?unknown=1', endpoint + '?kind=unknown', endpoint + '?status=approved', endpoint + '?followUpDate=2026-02-30', endpoint + '?caseId=' + encodeURIComponent('  '), endpoint + '/' + main.id + '?q=a']) await request('GET', route, undefined, 422);
    for (const item of [foreignItem, caseA, { id: id() }]) await request('GET', endpoint + '/' + item.id, undefined, 404);
    await request('GET', endpoint + '?caseId=' + foreignCase.id, undefined, 404);
    for (const item of corrupts) { const result = await request('GET', endpoint + '?q=' + encodeURIComponent(item.reason), undefined, 409, actors.admin, foreign.id); assert.equal(result.error.code, 'FOLLOWUP_DATA_INVALID'); }
    for (const method of ['POST', 'PATCH', 'DELETE']) { await request(method, endpoint, {}, 405); await request(method, endpoint + '/' + main.id, {}, 405); }
    await request('GET', endpoint, undefined, 200, actors.admin, orgId, { 'Idempotency-Key': 'synthetic-get-must-not-create-ledger' });
  }); mark('G7 closed duplicate/unknown/date/page queries／GET-only405／foreign/entity404／unsafe id-version409 zero writes');
  await readOnly('G8 malformed list DTO fails closed, missing selected case and503 retry', async () => {
    for (const variant of ['missing-filters', 'short-page', 'duplicate-id', 'wrong-echo', 'wrong-org', 'wrong-case', 'unsafe-version', 'extra-field', 'nested-tag']) {
      await load(admin); let used = false; const handler = async route => {
        if (used) return route.continue(); used = true; const response = await route.fetch(), data = await response.json();
        if (variant === 'missing-filters') delete data.filters;
        if (variant === 'short-page') data.items.pop();
        if (variant === 'duplicate-id') data.items[1] = structuredClone(data.items[0]);
        if (variant === 'wrong-echo') data.filters.q = 'wrong-echo-query';
        if (variant === 'wrong-org') data.items[0].orgId = foreign.id;
        if (variant === 'wrong-case') data.items[0].caseId = foreignCase.id;
        if (variant === 'unsafe-version') data.items[0].version = 0;
        if (variant === 'extra-field') data.items[0].fields.UNKNOWN_KEY = { kind: 'string', value: 'HIDDEN_UNKNOWN' };
        if (variant === 'nested-tag') data.items[0].fields.note = { kind: 'object', value: { secret: 'HIDDEN_NESTED' } };
        await route.fulfill({ response, json: data });
      };
      await admin.route('**/api/' + endpoint + '?**', handler); await load(admin); await admin.locator('.list-content .error-state').waitFor(); assert.equal(await rows(admin).count(), 0); await noSecrets(admin.locator('.list-content')); if (variant === 'nested-tag') await shot(admin, 'malformed-list-desktop.png'); await admin.unroute('**/api/' + endpoint + '?**', handler); await admin.getByRole('button', { name: '重新讀取', exact: true }).click(); await waitList(admin); assert.equal(await rows(admin).count(), 25);
    }
    await load(admin); await filter(admin, '個案篩選', caseB.id, 'caseId');
    const missingCase = async route => { const response = await route.fetch(), data = await response.json(); data.items = data.items.filter(item => item.id !== caseB.id); data.total = data.items.length; await route.fulfill({ response, json: data }); };
    await admin.route('**/api/cases?page=1&pageSize=100', missingCase); const input = admin.getByLabel(names.search, { exact: true }); await input.fill('WORK-TYPED'); await input.press('Enter');
    await admin.getByText('原選擇個案已無法確認；請重新選擇個案或明確清除條件。', { exact: true }).first().waitFor(); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), caseB.id); assert.equal(await rows(admin).count(), 0);
    await admin.unroute('**/api/cases?page=1&pageSize=100', missingCase); await admin.getByRole('button', { name: '清除個案條件', exact: true }).click(); await waitList(admin); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), '');
    await load(admin); stage = 'G8 exact selected case404'; let selectedRejected = false;
    const rejectedCase = async route => { if (selectedRejected || new URL(route.request().url()).searchParams.get('caseId') !== caseB.id) return route.continue(); selectedRejected = true; expectFailure({ id: 'G8-case404', kind: 'http', phase: stage, url: route.request().url(), method: 'GET', status: 404, count: 1, consoleCount: 1 }); await route.fulfill({ status: 404, contentType: 'application/json', json: { error: { code: 'NOT_FOUND', message: '合成所選人工追蹤個案已不可讀', fields: { caseId: '合成所選人工追蹤個案已不可讀' } } } }); };
    await admin.route('**/api/' + endpoint + '?**', rejectedCase); await admin.getByLabel('個案篩選', { exact: true }).selectOption(caseB.id); await admin.getByText('合成所選人工追蹤個案已不可讀', { exact: true }).first().waitFor(); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), caseB.id); assert.equal(await rows(admin).count(), 0); await admin.unroute('**/api/' + endpoint + '?**', rejectedCase); await admin.getByRole('button', { name: '清除個案條件', exact: true }).click(); await waitList(admin); assert.equal(await rows(admin).count(), 25);
    stage = 'G8 exact list503'; let failed = false; const badList = async route => { if (failed) return route.continue(); failed = true; expectFailure({ id: 'G8-list503', kind: 'http', phase: stage, url: route.request().url(), method: 'GET', status: 503, count: 1, consoleCount: 1 }); await route.fulfill({ status: 503, contentType: 'application/json', json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成人工追蹤列表暫時無法使用' } } }); };
    await admin.route('**/api/' + endpoint + '?**', badList); await load(admin); await admin.getByText('合成人工追蹤列表暫時無法使用', { exact: true }).waitFor(); await shot(admin, 'list-error-desktop.png'); await admin.unroute('**/api/' + endpoint + '?**', badList); await admin.getByRole('button', { name: '重新讀取', exact: true }).click(); await waitList(admin); assert.equal(await rows(admin).count(), 25);
  }); mark('G8 exact list-envelope/row/tag/echo rejection／case condition never silently broadened／503 actual manual retry');
  await readOnly('G9 malformed fresh single, forged list cannot override real404 and offline recovery', async () => {
    for (const variant of ['missing-item', 'wrong-id', 'wrong-org', 'wrong-case', 'zero-version', 'extra-tag', 'nested-tag']) {
      await load(admin); const row = await findRow(admin, 'WORK-MAIN'); const handler = async route => { const response = await route.fetch(), data = await response.json();
        if (variant === 'missing-item') delete data.item; if (variant === 'wrong-id') data.item.id = unknown.id; if (variant === 'wrong-org') data.item.orgId = foreign.id; if (variant === 'wrong-case') data.item.caseId = caseB.id; if (variant === 'zero-version') data.item.version = 0; if (variant === 'extra-tag') data.item.fields.UNKNOWN_KEY = { kind: 'string', value: 'HIDDEN_UNKNOWN' }; if (variant === 'nested-tag') data.item.fields.note = { kind: 'object', value: { secret: 'HIDDEN_NESTED' } }; await route.fulfill({ response, json: data }); };
      await admin.route(base + '/api/' + endpoint + '/' + main.id, handler); const trigger = row.getByRole('button', { name: '查看完整內容', exact: true }); await trigger.click(); const dialog = admin.getByRole('dialog', { name: names.detail, exact: true }); await dialog.locator('.error-state').waitFor(); assert.equal(await dialog.getByText(longReason, { exact: true }).count(), 0); await noSecrets(dialog); if (variant === 'nested-tag') await shot(admin, 'malformed-detail-desktop.png'); await admin.unroute(base + '/api/' + endpoint + '/' + main.id, handler); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText(longReason, { exact: true }).waitFor(); await close(admin, trigger);
    }
    const real = (await request('GET', endpoint + '/' + main.id)).item;
    for (const [label, rejected] of [['foreign', foreignItem], ['nonentity', caseA]]) {
      stage = 'G9 real fresh404 ' + label;
      const forged = async route => { const url = new URL(route.request().url()), data = structuredClone(real); data.id = rejected.id; await route.fulfill({ status: 200, contentType: 'application/json', json: { items: [data], total: 1, page: Number(url.searchParams.get('page') || 1), pageSize: 25, filters: { ...emptyFilters, q: url.searchParams.get('q') || '' } } }); };
      await admin.route('**/api/' + endpoint + '?**', forged); await load(admin); expectFailure({ id: 'G9-real404-' + label, kind: 'http', phase: stage, url: base + '/api/' + endpoint + '/' + rejected.id, method: 'GET', status: 404, count: 1, consoleCount: 1 }); const trigger = rows(admin).first().getByRole('button', { name: '查看完整內容', exact: true }); await trigger.click(); const dialog = admin.getByRole('dialog', { name: names.detail, exact: true }); await dialog.locator('.error-state').waitFor(); assert.equal(await dialog.getByText(longReason, { exact: true }).count(), 0); await close(admin, trigger); await admin.unroute('**/api/' + endpoint + '?**', forged);
    }
    await load(admin); const row = await findRow(admin, 'WORK-MAIN'), trigger = row.getByRole('button', { name: '查看完整內容', exact: true }), url = base + '/api/' + endpoint + '/' + main.id;
    stage = 'G9 exact offline detail'; expectFailure({ id: 'G9-offline', kind: 'requestfailed', phase: stage, url, method: 'GET', failure: 'net::ERR_INTERNET_DISCONNECTED', count: 1, consoleCount: 1 }); const offline = route => route.abort('internetdisconnected'); await admin.route(url, offline); await trigger.click(); const dialog = admin.getByRole('dialog', { name: names.detail, exact: true }); await dialog.locator('.error-state').waitFor(); await admin.unroute(url, offline); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText(longReason, { exact: true }).waitFor(); await close(admin, trigger);
  }); mark('G9 fresh DTO rejects finite malformed identities/tags／forged-list foreign/entity real404／true offline GET retry');
  const historyUrl = base + '/api/' + entity + '/' + main.id + '/history?page=1&pageSize=25&compare=previous';
  const prepareContext = async state => {
    await load(admin); const originalList = await admin.locator('.list-content').elementHandle(), originalCases = await admin.getByLabel('個案篩選', { exact: true }).elementHandle(); let pending, arrival, dialog, trigger;
    if (state === 'pending-list') {
      pending = await held(admin, '**/api/' + endpoint + '?**', req => req.method() === 'GET' && new URL(req.url()).searchParams.get('q') === 'WORK-MAIN');
      const input = admin.getByLabel(names.search, { exact: true }); await input.fill('WORK-MAIN'); await input.press('Enter'); arrival = await bounded(pending.arrived, state + ' arrived');
      const parsed = new URL(arrival.url); assert.equal(parsed.pathname, '/api/' + endpoint); assert.equal(parsed.searchParams.get('q'), 'WORK-MAIN');
    } else if (state.endsWith('detail')) {
      const row = await findRow(admin, 'WORK-MAIN'); trigger = row.getByRole('button', { name: '查看完整內容', exact: true });
      if (state === 'pending-detail') pending = await held(admin, base + '/api/' + endpoint + '/' + main.id, req => req.method() === 'GET');
      await trigger.click(); dialog = admin.getByRole('dialog', { name: names.detail, exact: true });
      if (pending) arrival = await bounded(pending.arrived, state + ' arrived'); else await dialog.getByText(longReason, { exact: true }).waitFor();
    } else if (state.endsWith('history')) {
      const row = await findRow(admin, 'WORK-MAIN'); trigger = row.getByRole('button', { name: '版本歷程', exact: true });
      if (state === 'pending-history') pending = await held(admin, historyUrl, req => req.method() === 'GET');
      await trigger.click(); dialog = admin.getByRole('dialog', { name: names.history, exact: true });
      if (pending) arrival = await bounded(pending.arrived, state + ' arrived'); else await dialog.getByText('合成人工追蹤supervisor', { exact: true }).waitFor();
    }
    if (arrival) assert.equal(arrival.response.status(), 200, 'Held context fixture is a real successful server GET before client abort');
    return { originalList, originalCases, pending, arrival, dialog, trigger };
  };
  const invalidationAssertions = async prepared => {
    await admin.waitForFunction(node => node.textContent === '', prepared.originalList); assert.equal(await prepared.originalList.evaluate(node => node.textContent), '', 'Original list DOM cleared, not replaced as a false guard');
    assert(await prepared.originalCases.evaluate(node => node.disabled && [...node.options].every(option => option.value === '' && !/WORK-SAME|WORK-CLOSED|合成同名人工追蹤|合成已結案/.test(option.textContent))), 'Original case metadata/IDs removed');
    for (const item of [caseA, caseB, closedCase]) assert.equal(await prepared.originalCases.evaluate((node, value) => [...node.options].filter(option => option.value === value).length, item.id), 0);
    if (prepared.dialog) await prepared.dialog.waitFor({ state: 'detached' }); assert.equal(await admin.getByRole('dialog').count(), 0); assert.equal(await admin.locator('.toast-success').count(), 0);
  };
  const states = ['loaded-list', 'pending-list', 'loaded-detail', 'pending-detail', 'loaded-history', 'pending-history'];
  for (const state of states) for (const primitive of ['user', 'org', 'role', 'employee', 'hash', 'render']) await readOnly('G10 ' + state + ' primitive ' + primitive, async () => {
    const prepared = await prepareContext(state); let aborted;
    try {
      if (prepared.pending) aborted = expectAbort(admin, 'primitive-' + state + '-' + primitive, prepared.arrival);
      await mutateContext(admin, primitive, foreign.id); await invalidationAssertions(prepared);
      if (prepared.pending) { await prepared.pending.finish(); await aborted; }
      await admin.waitForLoadState('networkidle'); assert.equal(await admin.getByRole('dialog').count(), 0); assert.equal(await prepared.originalList.evaluate(node => node.textContent), '');
      contextChecks.push({ state, primitive, originalListCleared: true, originalCaseMetadataCleared: true, dialogGone: true, actualRequestAbort: Boolean(prepared.pending), lateResponseDidNotRevive: true, zeroWrites: true, clientPrimitiveGuardNotServerPermissionRevocation: true });
    } finally { if (prepared.pending) await prepared.pending.finish(); }
  }); mark('G10 six loaded/pending list-detail-history states×six primitives／36 original-DOM guards／18 exact observed GET aborts');
  for (const state of states) await readOnly('G11 nested reference negative ' + state, async () => {
    const prepared = await prepareContext(state), reference = await replaceNestedReferences(admin); assert(reference.outerReferenceKept && reference.userAndOrganizationReferencesChanged); same(reference.before, reference.after);
    if (prepared.pending) await prepared.pending.finish(); await admin.waitForLoadState('networkidle');
    assert(await prepared.originalList.evaluate(node => node.isConnected && node.textContent.length > 0), 'Same primitive nested reference change keeps original loaded list');
    assert(await prepared.originalCases.evaluate(node => !node.disabled && [...node.options].some(option => /WORK-SAME-A/.test(option.textContent))), 'Same-value nested reference keeps confirmed case options');
    if (prepared.dialog) { assert(await prepared.dialog.isVisible()); if (state.endsWith('detail')) await prepared.dialog.getByText(longReason, { exact: true }).waitFor(); else await prepared.dialog.getByText('合成人工追蹤supervisor', { exact: true }).waitFor(); await close(admin, prepared.trigger); }
    referenceChecks.push({ state, primitivesExact: true, outerContextKept: true, nestedUserAndOrganizationReferencesChanged: true, listAndMetadataRetained: true, pendingResultAcceptedWithoutAbort: Boolean(prepared.pending), zeroWrites: true });
  });
  for (const state of states) await readOnly('G11 conservative outer context rebuild ' + state, async () => {
    const prepared = await prepareContext(state); let aborted;
    try {
      if (prepared.pending) aborted = expectAbort(admin, 'outer-' + state, prepared.arrival);
      const rebuilt = await admin.evaluate(async () => { const ui = await import('/ui.js'), current = ui.getContext(); const tuple = c => JSON.stringify([c.user?.id ?? null, c.organizationId ?? c.orgId ?? null, c.role ?? null, c.user?.employeeId ?? null]); const before = tuple(current); ui.setContext({ ...current, user: { ...current.user }, organizations: current.organizations.map(item => ({ ...item })) }, current.organizationId); const changed = current !== ui.getContext(), after = tuple(ui.getContext()); const mounted = document.querySelector('[data-render-version]'); mounted.setAttribute('data-render-version', mounted.dataset.renderVersion); return { changed, before, after }; });
      assert(rebuilt.changed); same(rebuilt.before, rebuilt.after, 'Outer context positive changes reference, not identity primitives'); await invalidationAssertions(prepared);
      if (prepared.pending) { await prepared.pending.finish(); await aborted; } await admin.waitForLoadState('networkidle'); assert.equal(await admin.getByRole('dialog').count(), 0);
      outerRebuildChecks.push({ state, identityPrimitivesUnchanged: true, outerContextActuallyChanged: true, originalListAndCaseMetadataCleared: true, dialogGone: true, actualRequestAbort: Boolean(prepared.pending), lateResponseDidNotRevive: true, zeroWrites: true });
    } finally { if (prepared.pending) await prepared.pending.finish(); }
  }); mark('G11 six nested same-value reference negatives retained／six same-primitive outer rebuilds invalidate／three exact GET aborts');
  await readOnly('G12 pending detail/history Escape truly aborts and restores focus before next stage', async () => {
    for (const kind of ['detail', 'history']) {
      stage = 'G12 pending Escape ' + kind; const prepared = await prepareContext('pending-' + kind), aborted = expectAbort(admin, 'Escape-' + kind, prepared.arrival);
      await close(admin, prepared.trigger); await prepared.pending.finish(); await aborted; await admin.waitForLoadState('networkidle'); assert.equal(await admin.getByRole('dialog').count(), 0); assert(await prepared.trigger.evaluate(node => node === document.activeElement));
    }
  }); mark('G12 pending detail/history Escape close→release→observed requestfailed／focus restored／no late revival');
  await readOnly('G13 390px true saved reason/note suffix ranges and history/sibling visuals', async () => {
    await admin.setViewportSize({ width: 390, height: 844 }); await load(admin); const table = admin.locator('.list-content .table-scroll'); assert(await table.evaluate(node => node.scrollWidth > node.clientWidth)); await table.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert(await table.evaluate(node => node.scrollLeft > 0)); await table.evaluate(node => { node.scrollLeft = 0; }); await shot(admin, 'list-mobile.png');
    const opened = await openDetails(admin, 'WORK-MAIN'); await opened.dialog.getByText(longReason, { exact: true }).waitFor(); await opened.dialog.getByText(longNote, { exact: true }).waitFor(); await noSecrets(opened.dialog);
    for (const [kind, value, lastLine, literal, filename] of [['reason', longReason, lastReason, reasonLiteral, 'reason-suffix-mobile.png'], ['note', longNote, lastNote, noteLiteral, 'note-suffix-mobile.png']]) {
      const saved = opened.dialog.getByText(value, { exact: true }); assert.equal(await saved.textContent(), value); const geometry = await suffixGeometry(saved, lastLine, literal); assert(geometry.lastLineRects.length && geometry.finalLiteralRects.length); assert([...geometry.lastLineRects, ...geometry.finalLiteralRects].every(rect => rect.insideDialogAboveFooter && rect.hitTestVisible), 'Every real ' + kind + ' final-line/literal Range clears footer and is hit-test visible'); footerChecks.push({ kind, savedValueExact: true, ...geometry }); await shot(admin, filename);
    }
    await close(admin, opened.trigger); const history = await openHistory(admin, 'WORK-MAIN'); await history.dialog.getByText('合成人工追蹤supervisor', { exact: true }).waitFor(); await shot(admin, 'history-mobile.png'); await close(admin, history.trigger);
    await admin.setViewportSize({ width: 1440, height: 1050 }); await load(admin); await layout(admin); await admin.goto(base + '/#/interviews'); await admin.getByRole('heading', { name: '面試者登錄', level: 1, exact: true }).waitFor(); await admin.waitForLoadState('networkidle'); await shot(admin, 'interviews-sibling-desktop.png');
  }); mark('G13 390px native filters/table internal scroll／real reason and note final Range+hit-test above footer／history and1440 sibling');
  await readOnly('G14 final exact full database, snapshot/BLOB and observer evidence', async () => {
    same(raw(), queryBaseline, 'All query activity preserves all raw tables from last explicitly accounted synthetic fixture mutation'); same(counts(), queryCounts, 'All query activity total_changes exactly zero'); same((await request('GET', 'service-records/' + approved.id)).item, approved); assertProtected();
    assert.equal(pageErrors.length, 0, json(pageErrors)); assert.equal(failedResponses.filter(item => !item.expectedRuleId).length, 0, json(failedResponses)); assert.equal(failedRequests.filter(item => !item.expectedRuleId).length, 0, json(failedRequests));
    const assigned = new Set();
    for (const rule of expectedFailures) {
      const events = (rule.kind === 'http' ? failedResponses : failedRequests).filter(event => event.expectedRuleId === rule.id); assert.equal(events.length, rule.count, 'Exact phase/URL/method/status or code count: ' + rule.id);
      const matches = consoleErrors.flatMap((event, index) => event.stage === rule.phase && event.location.url === rule.url && (rule.kind === 'http' ? event.text.startsWith('Failed to load resource: the server responded with a status of ' + rule.status + ' (') : event.text === 'Failed to load resource: ' + rule.failure) ? [index] : []);
      if (rule.consoleCount !== undefined) assert.equal(matches.length, rule.consoleCount, 'Exact console URL/stage ' + rule.id); else assert(matches.length <= rule.maxConsoleCount, 'Bounded actual cancellation console ' + rule.id);
      for (const index of matches) { assert(!assigned.has(index), 'Console cannot be allocated twice'); assigned.add(index); } rule.actualFailureCount = events.length; rule.actualConsoleCount = matches.length;
    }
    assert.equal(consoleErrors.filter((_event, index) => !assigned.has(index)).length, 0, json(consoleErrors)); assert.equal(contextChecks.length, 36); assert.equal(referenceChecks.length, 6); assert.equal(outerRebuildChecks.length, 6); assert.equal(footerChecks.length, 2); assert.equal(screenshots.length, 16); assert.equal(checks.length, 13);
  }); mark('G14 all11tables/sixtriggers/schema/total_changes read-zero／snapshot/BLOB preserved／exact associated failures only');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), syntheticOnly: true, database: ':memory:', randomLoopback: true, checks, readSegments, fixtureWrites, contextChecks, referenceChecks, outerRebuildChecks, projectionChecks, footerChecks, allQueryWritesZero: true, originalProtectedRowsAndBlobsUnchanged: true, snapshotUnchanged: true, pageErrors, consoleErrors, failedResponses, failedRequests, expectedFailures, expectedConsoleFailuresOnly: true, screenshots, visualReviewPending: true, actuallyViewedByScript: false }, null, 2) + '\n', { flag: 'wx' });
  console.log('RESULT ' + path.join(output, 'e2e.json'));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, stage, error: error.stack, checks, readSegments, fixtureWrites, contextChecks, referenceChecks, outerRebuildChecks, projectionChecks, footerChecks, consoleErrors, pageErrors, failedResponses, failedRequests, expectedFailures, screenshots }, null, 2) + '\n', { flag: 'wx' }); console.error('FAILURE ' + path.join(output, 'failure.json')); throw error;
} finally { for (const context of contexts) await context.close().catch(() => {}); if (browser) await browser.close(); await app.close(); }
