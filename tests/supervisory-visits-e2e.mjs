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

// This factory owns all synthetic records, sessions, BLOBs and the random server.
// No disk database, default server, env file or real Portal binding is opened.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, 'outputs/software/supervisory-visits-qa');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const installed = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
const app = createApp({ dbPath: ':memory:', port: 0 });
const endpoint = 'supervisory-visits', password = 'synthetic-visits-browser-password';
const answerKeys = Array.from({ length: 10 }, (_, index) => 'q' + String(index + 1).padStart(3, '0'));
const dtoKeys = ['id', 'orgId', 'version', 'templateId', 'caseId', 'caseNo', 'caseName', 'date', 'status', 'answerContainerKind', 'hasUnknownAnswerKeys', 'answers'];
const checks = [], readSegments = [], fixtureWrites = [], contextChecks = [], projectionChecks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], failedRequests = [], expectedFailures = [], contexts = [];
let browser, base, lastPage, stage = 'initialization';
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { sqliteInteger: item.toString() } : item);
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');
const same = (left, right, label) => assert.deepEqual(left, right, label);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return { schema, tables: Object.fromEntries(tables.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })) };
};
const counts = () => ({ totalChanges: app.db.prepare('SELECT total_changes() n').get().n,
  records: app.db.prepare('SELECT count(*) n FROM records').get().n,
  versions: app.db.prepare('SELECT count(*) n FROM record_versions').get().n,
  audit: app.db.prepare('SELECT count(*) n FROM audit').get().n,
  idempotency: app.db.prepare('SELECT count(*) n FROM idempotency').get().n });
const readOnly = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(); await action();
  same(raw(), before, label + ': exact all tables and schema'); same(counts(), beforeCounts, label + ': total_changes zero');
  readSegments.push({ label, tableCount: 11, triggerCount: 6, beforeSha256: sha(before), afterSha256: sha(raw()), beforeCounts, afterCounts: counts(), zeroWrites: true });
};
const written = async (label, action) => { stage = label; const before = counts(); const result = await action(); fixtureWrites.push({ label, before, after: counts(), fixtureOnly: true }); return result; };
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
const rows = page => page.locator('.list-content tbody tr');
const waitList = page => page.locator('.list-content .loading').waitFor({ state: 'detached' });
const load = async page => {
  lastPage = page; const target = base + '/#/supervisory-visits';
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: '督導訪視查詢', exact: true, level: 1 }).waitFor(); await page.waitForLoadState('networkidle');
};
const search = async (page, q) => {
  const input = page.getByLabel('搜尋督導訪視內容', { exact: true }); await input.fill(q);
  const response = page.waitForResponse(item => { const url = new URL(item.url()); return url.pathname === '/api/' + endpoint && item.request().method() === 'GET' && (url.searchParams.get('q') || '') === q; });
  await input.press('Enter'); const result = await response; assert.equal(result.status(), 200, await result.text()); await waitList(page); return result.json();
};
const filter = async (page, name, value, key) => {
  const response = page.waitForResponse(item => { const url = new URL(item.url()); return url.pathname === '/api/' + endpoint && item.request().method() === 'GET' && (url.searchParams.get(key) || '') === value; });
  const control = page.getByLabel(name, { exact: true }); if (key === 'date') await control.fill(value); else await control.selectOption(value);
  const result = await response; assert.equal(result.status(), 200, await result.text()); await waitList(page); return result.json();
};
const findRow = async (page, q) => { await search(page, q); assert.equal(await rows(page).count(), 1); return rows(page).first(); };
const openDetails = async (page, q) => { const row = await findRow(page, q), trigger = row.getByRole('button', { name: '查看完整內容', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: '督導訪視保存內容', exact: true }); await dialog.waitFor(); return { dialog, trigger }; };
const close = async (page, trigger) => { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); if (trigger) assert(await trigger.evaluate(node => node === document.activeElement), 'Escape returns focus to trigger'); };
const noSecrets = async locator => assert(!/HIDDEN_NESTED|HIDDEN_ARRAY|HIDDEN_UNKNOWN|UNKNOWN_KEY|BILLING_SECRET|METADATA_SEARCH_ONLY/.test(await locator.textContent()), 'Nested, unknown and unrelated metadata never display');
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  same(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), [], 'Visible controls labelled');
  for (const dialog of await page.getByRole('dialog').all()) assert(await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog stays within viewport');
  for (const table of await page.locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => { assert(screenshots.length < 16); await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push({ name, sha256: sha(await readFile(path.join(output, name))), viewport: page.viewportSize(), actuallyViewed: false }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), 15000); timer.unref(); })]);
const held = async (page, pattern, predicate) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false;
  const handler = async route => {
    if (used || !predicate(route.request())) return route.continue(); used = true;
    try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { handled.resolve(); }
  };
  await page.route(pattern, handler);
  return { arrived: arrived.promise, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'held response'); await page.unroute(pattern, handler); } };
};
const mutateContext = async (page, kind, foreignOrg) => page.evaluate(async ({ kind, foreignOrg }) => {
  const ui = await import('/ui.js'), current = ui.getContext();
  if (kind === 'hash') { location.hash = '/employees'; return; }
  if (kind === 'render') { document.querySelector('[data-render-version]').dataset.renderVersion = crypto.randomUUID(); return; }
  // Isolate one primitive without replacing the context object or rebuilding the app.
  // This proves client guards; the server cookie remains a separately tested identity.
  if (kind === 'user') current.user.id = 'synthetic-visits-replaced-user';
  if (kind === 'org') { current.organizationId = foreignOrg; current.orgId = foreignOrg; }
  if (kind === 'role') { current.role = 'finance'; current.user.role = 'finance'; }
  if (kind === 'employee') current.user.employeeId = 'synthetic-visits-replaced-employee';
  const mounted = document.querySelector('[data-render-version]');
  mounted.setAttribute('data-render-version', mounted.dataset.renderVersion);
}, { kind, foreignOrg });

try {
  base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const adminClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(adminClient);
  const setup = await written('owned synthetic setup', () => adminClient.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成訪視管理員', email: 'visits-admin@example.test', password, organizationName: '合成訪視甲機構' } }));
  assert.equal(setup.status(), 201, await setup.text()); const adminAuth = await setup.json(), orgId = adminAuth.organizations[0].id;
  const admin = await adminClient.newPage(); observe(admin); const actors = { admin: { client: adminClient, auth: adminAuth, page: admin } };
  const request = async (method, route, data, expected = 200, actor = actors.admin, selectedOrg = orgId, headers = {}) => {
    const response = await actor.client.request.fetch(base + '/api/' + route, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': actor.auth.csrfToken, ...headers }, ...(data === undefined ? {} : { data }) });
    const result = await response.json(); assert.equal(response.status(), expected, method + ' ' + route + ' ' + JSON.stringify(result)); return result;
  };
  const post = async (entity, data, selectedOrg = orgId) => (await request('POST', entity, data, 201, actors.admin, selectedOrg)).item;
  const patch = async (entity, item, values, actor = actors.admin) => (await request('PATCH', entity + '/' + item.id, { version: item.version, ...values }, 200, actor)).item;
  let employee, foreign, sameA, sameB, closedCase, protectedCase, approved;
  await written('four role sessions and two organizations', async () => {
    employee = await post('employees', { employeeNo: 'VISIT-E01', name: '合成訪視居服', role: 'caregiver', hourlyRateCents: 12345 });
    for (const role of ['supervisor', 'finance', 'caregiver']) {
      await post('users', { name: '合成訪視' + role, email: 'visits-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
      const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(client);
      const login = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'visits-' + role + '@example.test', password } }); assert.equal(login.status(), 200);
      const page = await client.newPage(); observe(page); actors[role] = { client, auth: await login.json(), page };
    }
    foreign = await post('organizations', { name: '合成訪視乙機構' });
    sameA = await post('cases', { caseNo: 'VISIT-SAME-A', name: '合成同名個案' });
    sameB = await post('cases', { caseNo: 'VISIT-SAME-B', name: '合成同名個案' }); sameB = await patch('cases', sameB, { status: 'paused' });
    closedCase = await post('cases', { caseNo: 'VISIT-CLOSED', name: '合成結案個案' }); closedCase = await patch('cases', closedCase, { status: 'closed' });
    protectedCase = await post('cases', { caseNo: 'VISIT-SNAPSHOT', name: '合成核閱基準個案' });
  });
  await readOnly('G1 empty module and role isolation', async () => {
    await load(admin); assert.equal(await rows(admin).count(), 0); await shot(admin, 'empty-desktop.png');
    for (const role of ['finance', 'caregiver']) {
      const actor = actors[role]; await actor.page.goto(base + '/#/'); await actor.page.waitForLoadState('networkidle');
      assert.equal(await actor.page.getByRole('link', { name: '督導訪視查詢', exact: true }).count(), 0);
      for (const [method, route, data] of [['GET', endpoint + '?unknown=1'], ['GET', endpoint + '/' + sameA.id + '?unknown=1'], ['POST', endpoint, {}], ['PATCH', endpoint + '/' + sameA.id, {}]]) await request(method, route, data, 403, actor);
      await actor.page.goto(base + '/#/supervisory-visits'); await actor.page.waitForLoadState('networkidle'); assert.equal(await actor.page.getByRole('button', { name: '查看完整內容', exact: true }).count(), 0);
    }
  }); mark('G1 兩機構四角色／真empty／財務居服無導覽且解析前403');

  const longText = '合成訪視長文開頭\n' + Array.from({ length: 160 }, (_, index) => `合成完整保存第${index + 1}行：訪視內容只供人工閱讀，不計分。`).join('\n') + '\n合成手機最後一行可讀';
  let main, typed, movedTemplate, otherTemplate, foreignItem, nonAssessment, corrupts;
  await written('synthetic visit projections, existing histories, approved snapshot and two BLOB fixtures', async () => {
    const service = await post('service-items', { code: 'VISIT-SERVICE', name: '合成既有服務', minutes: 60, unitPriceCents: 12345 });
    const plan = await post('care-plans', { caseId: protectedCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
    const shift = await post('shifts', { caseId: protectedCase.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-20', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
    let record = await post('service-records', { shiftId: shift.id, caseId: protectedCase.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }], status: 'submitted' });
    record = (await request('POST', 'service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成唯讀快照基準' })).item; approved = structuredClone(record);
    await post('case-attachments/upload', { caseId: protectedCase.id, title: '合成個案非空附件', category: 'general', ...filePayload(PDF_BYTES) });
    const certificate = await post('employee-certifications', { employeeId: employee.id, name: '合成證照', issuedOn: '2026-01-01' });
    await post('certification-attachments/upload', { certificationId: certificate.id, title: '合成證照非空附件', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
    main = await post('assessments', { caseId: sameA.id, templateId: 'assessment-04', date: '2026-10-10', status: 'submitted', answers: { q001: '2026-09-01', q002: 'VISIT-MAIN 合成照服員', q003: '到宅', q004: '合成地點', q005: '面訪', q006: '合成對象', q007: longText, q008: '合成追蹤\n第二行 <script>無執行</script>', q009: '2026-09-02', q010: '2026-11-11' } });
    typed = await post('assessments', { caseId: sameB.id, templateId: 'assessment-04', date: '2026-10-11', status: 'draft', answers: { q001: '', q002: 'VISIT-TYPED 合成型別', q003: null, q004: ['HIDDEN_ARRAY'], q005: { secret: 'HIDDEN_NESTED' }, q006: 0, q007: false, q008: '合成型別追蹤', q010: '合成文字尾', UNKNOWN_KEY: 'HIDDEN_UNKNOWN' } });
    movedTemplate = await post('assessments', { caseId: closedCase.id, templateId: 'assessment-02', date: '2026-10-12', answers: { q001: '合成舊版案主', q002: '合成舊版擬定人' } });
    movedTemplate = await patch('assessments', movedTemplate, { templateId: 'assessment-04', answers: { q001: '2026-10-01', q002: 'VISIT-MOVED 合成督導', q007: '合成換模板目前內容' } }, actors.supervisor);
    otherTemplate = await post('assessments', { caseId: sameA.id, templateId: 'assessment-03', date: '2026-10-10', answers: { q001: 'NOT-A-VISIT' } }); nonAssessment = sameA;
    const foreignCase = await post('cases', { caseNo: 'FOREIGN-VISIT', name: '合成外機構個案' }, foreign.id);
    foreignItem = await post('assessments', { caseId: foreignCase.id, templateId: 'assessment-04', date: '2026-10-10', answers: { q002: '合成乙不得顯示' } }, foreign.id);
    // Deliberate imported shapes stay in this owned memory factory, before query baselines.
    const imported = (caseId, data, selectedOrg = orgId, version = 1) => { const time = now(), item = { ...data, caseId, id: id(), orgId: selectedOrg, version, createdAt: time, updatedAt: time }; app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, selectedOrg, 'assessments', JSON.stringify({ ...data, caseId }), version, time, time); app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(selectedOrg, 'assessments', item.id, version, JSON.stringify(item), time, 'baseline'); return item; };
    for (let index = 0; index < 28; index++) imported(index % 2 ? sameB.id : sameA.id, { templateId: 'assessment-04', date: index % 2 ? '2026-10-14' : '2026-10-13', status: index % 3 ? 'draft' : 'submitted', answers: { q002: 'VISIT-PAGE ' + String(index + 1).padStart(2, '0'), q007: '合成分頁內容' + index }, note: 'METADATA_SEARCH_ONLY' });
    imported(closedCase.id, { templateId: 'assessment-04', date: '0000-01-01', status: 'draft', answers: { q002: 'VISIT-YEARZERO', q003: '拼接前段ABC', q004: 'DEF拼接後段' } });
    for (const [kind, value] of [['missing', undefined], ['null', null], ['array', ['HIDDEN_ARRAY']], ['string', 'HIDDEN_NESTED'], ['number', 42], ['boolean', false]]) imported(closedCase.id, { templateId: 'assessment-04', date: '2026-10-15', status: 'draft', ...(kind === 'missing' ? {} : { answers: value }) });
    corrupts = [];
    for (const [name, changed, version] of [['date', { date: '2026-02-30' }, 1], ['status', { status: 'approved' }, 1], ['version', {}, 0]]) corrupts.push(imported(foreignCase.id, { templateId: 'assessment-04', date: '2026-10-16', status: 'draft', answers: { q002: 'CORRUPT-' + name }, ...changed }, foreign.id, version));
  });
  const allBefore = raw(), allCountsBefore = counts();

  await readOnly('G2 strict list projection and identity filters', async () => {
    const result = await request('GET', endpoint + '?pageSize=25'); same(Object.keys(result).sort(), ['items', 'total', 'page', 'pageSize', 'filters'].sort()); assert.equal(result.total, 38); assert.equal(result.items.length, 25);
    same(result.filters, { q: '', status: '', date: '', caseId: '' });
    for (const item of result.items) { same(Object.keys(item).sort(), [...dtoKeys].sort()); assert.equal(item.templateId, 'assessment-04'); assert.equal(item.orgId, orgId); same(Object.keys(item.answers).sort(), answerKeys); }
    await load(admin); assert.equal(await rows(admin).count(), 25); assert.equal(await admin.getByRole('button', { name: /新增|儲存|刪除|匯出|列印/ }).count(), 0);
    const caseSelect = admin.getByLabel('個案篩選', { exact: true }); for (const item of [sameA, sameB, closedCase]) assert.equal(await caseSelect.locator('option[value="' + item.id + '"]').count(), 1);
    assert(/暫停/.test(await caseSelect.locator('option[value="' + sameB.id + '"]').innerText())); assert(/已結案/.test(await caseSelect.locator('option[value="' + closedCase.id + '"]').innerText()));
    await shot(admin, 'list-desktop.png'); await admin.getByRole('button', { name: '下一頁', exact: true }).click(); await waitList(admin); assert.equal(await rows(admin).count(), 13);
    await filter(admin, '個案篩選', sameB.id, 'caseId'); assert.equal(await rows(admin).count(), 15); const paused = await request('GET', endpoint + '?caseId=' + sameB.id); assert(paused.items.every(item => item.caseId === sameB.id));
    await filter(admin, '個案篩選', sameA.id, 'caseId'); const active = await request('GET', endpoint + '?caseId=' + sameA.id); assert.equal(active.total, 15); assert(active.items.every(item => item.caseId === sameA.id));
    await filter(admin, '個案篩選', closedCase.id, 'caseId'); assert.equal(await rows(admin).count(), 8); await filter(admin, '個案篩選', '', 'caseId');
    await load(actors.supervisor.page); assert.equal(await rows(actors.supervisor.page).count(), 25); assert.equal((await request('GET', endpoint, undefined, 200, actors.supervisor)).total, 38);
  }); mark('G2 exact DTO／38筆25+13頁／同名ID精確、paused/closed與督導讀權');

  await readOnly('G3 answer-only search and exact filling date', async () => {
    const result = await search(admin, 'VISIT-PAGE'); assert.equal(result.total, 28); const first = await filter(admin, '填寫日期篩選', '2026-10-13', 'date'); assert.equal(first.total, 14);
    const submitted = await filter(admin, '狀態', 'submitted', 'status'); assert.equal(submitted.total, 5); await shot(admin, 'filtered-desktop.png');
    const response = admin.waitForResponse(item => new URL(item.url()).pathname === '/api/' + endpoint && !new URL(item.url()).searchParams.has('date')); await admin.getByRole('button', { name: '清除填寫日期', exact: true }).click(); await response; await waitList(admin); assert(await admin.getByLabel('填寫日期篩選', { exact: true }).evaluate(node => node === document.activeElement));
    await filter(admin, '狀態', '', 'status'); await search(admin, '');
    for (const q of ['HIDDEN_NESTED', 'HIDDEN_ARRAY', 'HIDDEN_UNKNOWN', 'UNKNOWN_KEY', 'METADATA_SEARCH_ONLY', '合成同名個案', 'VISIT-SAME-A', 'ABCDEF']) { const empty = await search(admin, q); assert.equal(empty.total, 0, 'Search must not inspect nested/unknown/metadata or join answers: ' + q); }
    await shot(admin, 'no-results-desktop.png'); const mainDate = await request('GET', endpoint + '?q=VISIT-MAIN&date=2026-10-10'); assert.equal(mainDate.total, 1); assert.equal((await request('GET', endpoint + '?q=VISIT-MAIN&date=2026-09-01')).total, 0);
    assert.equal((await request('GET', endpoint + '?q=VISIT-YEARZERO&date=0000-01-01')).total, 1); const literal = await request('GET', endpoint + '?q=' + encodeURIComponent(' VISIT-MAIN ')); assert.equal(literal.filters.q, ' VISIT-MAIN ');
    await search(admin, ''); assert.equal(new URL(admin.url()).hash, '#/supervisory-visits'); assert.equal(await admin.evaluate(() => location.search), '');
  }); mark('G3 十own string独立搜尋／不拼欄或metadata／填寫日非訪視日／交集清除');

  await readOnly('G4 fresh details and ten safe answer tags', async () => {
    const detail = (await request('GET', endpoint + '/' + typed.id)).item; same(Object.keys(detail).sort(), [...dtoKeys].sort()); same(detail.answers.q001, { kind: 'string', value: '' }); same(detail.answers.q003, { kind: 'null' }); same(detail.answers.q004, { kind: 'array' }); same(detail.answers.q005, { kind: 'object' }); same(detail.answers.q006, { kind: 'number' }); same(detail.answers.q007, { kind: 'boolean' }); same(detail.answers.q009, { kind: 'missing' }); assert.equal(detail.hasUnknownAnswerKeys, true);
    let singleGets = 0; const counter = req => { if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/' + endpoint + '/' + main.id) singleGets++; }; admin.on('request', counter);
    try { for (let turn = 0; turn < 2; turn++) { const { dialog, trigger } = await openDetails(admin, 'VISIT-MAIN'); await dialog.getByText(longText, { exact: true }).waitFor(); assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|刪除|列印/ }).count(), 0); await noSecrets(dialog); if (!turn) await shot(admin, 'detail-desktop.png'); await close(admin, trigger); } assert.equal(singleGets, 2); } finally { admin.off('request', counter); }
    const { dialog, trigger } = await openDetails(admin, 'VISIT-TYPED'); await dialog.getByText('合成型別追蹤', { exact: true }).waitFor(); await noSecrets(dialog); assert(!/false|HIDDEN_/.test(await dialog.innerText())); await shot(admin, 'typed-detail-desktop.png'); await close(admin, trigger);
    const containers = await request('GET', endpoint + '?caseId=' + closedCase.id); const shaped = containers.items.filter(item => item.date === '2026-10-15'); assert.equal(shaped.length, 6); same(shaped.map(item => item.answerContainerKind).sort(), ['array', 'boolean', 'missing', 'null', 'number', 'string']); assert(shaped.every(item => answerKeys.every(key => JSON.stringify(item.answers[key]) === '{"kind":"missing"}')));
    projectionChecks.push({ ownTwelveDTOKeys: true, ownTenAnswerTags: true, allContainerKindsProjectedSafely: true, freshSingleGetCount: singleGets, nestedAndUnknownHidden: true });
  }); mark('G4 每次fresh single／完整長文字與十型別tag／未知nested不展示');

  await readOnly('G5 canonical assessment history and filling handoff', async () => {
    const row = await findRow(admin, 'VISIT-MOVED'), trigger = row.getByRole('button', { name: '版本歷程', exact: true }); await trigger.click();
    const dialog = admin.getByRole('dialog', { name: '評鑑填答版本歷程', exact: true }); await dialog.getByText('合成訪視supervisor', { exact: true }).waitFor(); await dialog.getByText('第 1 版', { exact: true }).click(); await dialog.getByText('合成訪視管理員', { exact: true }).waitFor();
    await dialog.getByText('模板已更換；兩組填答依各自目前題項展示，不將同名題號配對比較。', { exact: true }).waitFor(); await noSecrets(dialog); await shot(admin, 'history-desktop.png'); await close(admin, trigger);
    const link = admin.getByRole('link', { name: '前往評估表單填寫', exact: true }); assert.equal(await link.getAttribute('href'), '#/assessments'); await link.click(); await admin.getByRole('heading', { name: '個案評鑑表', exact: true, level: 1 }).waitFor(); await admin.waitForLoadState('networkidle'); assert.equal(await admin.getByRole('dialog').count(), 0);
  }); mark('G5 唯一assessments history／不同模板歷史與真actor／原填寫入口零寫');

  await readOnly('G6 query guards, wrong identities and corrupt metadata', async () => {
    for (const route of [endpoint + '?page=1e2', endpoint + '?pageSize=0', endpoint + '?q=a&q=b', endpoint + '?unknown=1', endpoint + '?status=approved', endpoint + '?date=2026-02-30', endpoint + '/' + main.id + '?q=a']) await request('GET', route, undefined, 422);
    for (const item of [foreignItem, otherTemplate, nonAssessment, { id: id() }]) await request('GET', endpoint + '/' + item.id, undefined, 404);
    for (const item of corrupts) { const response = await request('GET', endpoint + '?q=' + encodeURIComponent(item.answers.q002), undefined, 409, actors.admin, foreign.id); assert.equal(response.error.code, 'VISIT_DATA_INVALID'); }
    for (const method of ['POST', 'PATCH', 'DELETE']) { await request(method, endpoint, {}, 405); await request(method, endpoint + '/' + main.id, {}, 405); }
    await request('GET', endpoint, undefined, 200, actors.admin, orgId, { 'Idempotency-Key': 'synthetic-read-no-ledger' });
  }); mark('G6 非GET405／query白名單／錯模板entity外org404／全候選corrupt409零寫');

  await readOnly('G7 malformed list responses and real retry', async () => {
    for (const variant of ['missing-key', 'duplicate-id', 'wrong-filter', 'nested-tag']) {
      await load(admin); let handled = false;
      const handler = async route => { if (handled || new URL(route.request().url()).pathname !== '/api/' + endpoint) return route.continue(); handled = true; const response = await route.fetch(), data = await response.json(); if (variant === 'missing-key') delete data.filters; if (variant === 'duplicate-id') data.items[1] = data.items[0]; if (variant === 'wrong-filter') data.filters.q = 'another query'; if (variant === 'nested-tag') data.items[0].answers.q005 = { kind: 'object', value: { secret: 'HIDDEN_NESTED' } }; await route.fulfill({ response, json: data }); };
      await admin.route('**/api/' + endpoint + '?**', handler); await load(admin); await admin.locator('.list-content .error-state').waitFor(); assert.equal(await rows(admin).count(), 0); await noSecrets(admin.locator('.list-content')); if (variant === 'nested-tag') await shot(admin, 'malformed-list-desktop.png'); await admin.unroute('**/api/' + endpoint + '?**', handler); await admin.getByRole('button', { name: '重新讀取', exact: true }).click(); await waitList(admin); assert.equal(await rows(admin).count(), 25);
    }
    await load(admin); await filter(admin, '個案篩選', sameB.id, 'caseId');
    const missingCase = async route => { const response = await route.fetch(), data = await response.json(); data.items = data.items.filter(item => item.id !== sameB.id); data.total = data.items.length; await route.fulfill({ response, json: data }); };
    await admin.route('**/api/cases?page=1&pageSize=100', missingCase);
    await admin.getByLabel('搜尋督導訪視內容', { exact: true }).fill('VISIT-TYPED'); await admin.getByLabel('搜尋督導訪視內容', { exact: true }).press('Enter');
    await admin.getByText('原選擇個案已無法確認；請重新選擇個案或明確清除條件。', { exact: true }).first().waitFor(); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), sameB.id); assert.equal(await rows(admin).count(), 0);
    await admin.unroute('**/api/cases?page=1&pageSize=100', missingCase); await admin.getByRole('button', { name: '清除個案條件', exact: true }).click(); await waitList(admin); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), ''); assert(await admin.getByLabel('個案篩選', { exact: true }).evaluate(node => node === document.activeElement));
    await load(admin); stage = 'G7 selected case404';
    expectFailure({ id: 'G7-case404', kind: 'http', phase: stage, url: base + '/api/' + endpoint + '?page=1&pageSize=25&caseId=' + sameB.id, method: 'GET', status: 404, count: 1, consoleCount: 1 });
    const rejectedCase = async route => { const url = new URL(route.request().url()); if (url.searchParams.get('caseId') !== sameB.id) return route.continue(); await route.fulfill({ status: 404, contentType: 'application/json', json: { error: { code: 'NOT_FOUND', message: '合成所選個案已不可讀', fields: { caseId: '合成所選個案已不可讀' } } } }); };
    await admin.route('**/api/' + endpoint + '?**', rejectedCase); await admin.getByLabel('個案篩選', { exact: true }).selectOption(sameB.id); await admin.getByText('合成所選個案已不可讀', { exact: true }).first().waitFor(); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), sameB.id); assert.equal(await rows(admin).count(), 0);
    await admin.unroute('**/api/' + endpoint + '?**', rejectedCase); await admin.getByRole('button', { name: '清除個案條件', exact: true }).click(); await waitList(admin); assert.equal(await rows(admin).count(), 25); assert.equal(await admin.getByLabel('個案篩選', { exact: true }).inputValue(), '');
    stage = 'G7 injected list503'; let failed = false; const badList = async route => { if (failed) return route.continue(); failed = true; await route.fulfill({ status: 503, contentType: 'application/json', json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成訪視列表暫時無法使用' } } }); };
    expectFailure({ id: 'G7-list503', kind: 'http', phase: stage, url: base + '/api/' + endpoint + '?page=1&pageSize=25', method: 'GET', status: 503, count: 1, consoleCount: 1 });
    await admin.route('**/api/' + endpoint + '?**', badList); await load(admin); await admin.getByText('合成訪視列表暫時無法使用', { exact: true }).waitFor(); await shot(admin, 'list-error-desktop.png'); await admin.unroute('**/api/' + endpoint + '?**', badList); await admin.getByRole('button', { name: '重新讀取', exact: true }).click(); await waitList(admin); assert.equal(await rows(admin).count(), 25);
  }); mark('G7 非法2xx不顯示／失效case與404保留ID必明確清除／503真重試零寫');

  await readOnly('G8 fresh single rejects malformed and no-longer-eligible identity', async () => {
    for (const variant of ['wrong-template', 'wrong-id', 'unknown-answer']) {
      await load(admin); const row = await findRow(admin, 'VISIT-MAIN'); const handler = async route => { const response = await route.fetch(), data = await response.json(); if (variant === 'wrong-template') data.item.templateId = 'assessment-03'; if (variant === 'wrong-id') data.item.id = otherTemplate.id; if (variant === 'unknown-answer') data.item.answers.UNKNOWN_KEY = { kind: 'string', value: 'HIDDEN_UNKNOWN' }; await route.fulfill({ response, json: data }); };
      await admin.route(base + '/api/' + endpoint + '/' + main.id, handler); await row.getByRole('button', { name: '查看完整內容', exact: true }).click(); const dialog = admin.getByRole('dialog', { name: '督導訪視保存內容', exact: true }); await dialog.locator('.error-state').waitFor(); assert(!await dialog.getByText(longText, { exact: true }).count()); await noSecrets(dialog); if (variant === 'wrong-template') await shot(admin, 'malformed-detail-desktop.png'); await admin.unroute(base + '/api/' + endpoint + '/' + main.id, handler); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText(longText, { exact: true }).waitFor(); await close(admin);
    }
    const realProjection = (await request('GET', endpoint + '/' + main.id)).item;
    for (const [label, rejected] of [['template', otherTemplate], ['foreign', foreignItem]]) {
      await load(admin); stage = 'G8 fresh404 ' + label; const forged = async route => { const url = new URL(route.request().url()); await route.fulfill({ status: 200, contentType: 'application/json', json: { items: [{ ...realProjection, id: rejected.id }], total: 1, page: Number(url.searchParams.get('page') || 1), pageSize: 25, filters: { q: url.searchParams.get('q') || '', status: '', date: '', caseId: '' } } }); };
      await admin.route('**/api/' + endpoint + '?**', forged); await load(admin); expectFailure({ id: 'G8-fresh404-' + label, kind: 'http', phase: stage, url: base + '/api/' + endpoint + '/' + rejected.id, method: 'GET', status: 404, count: 1, consoleCount: 1 });
      await rows(admin).first().getByRole('button', { name: '查看完整內容', exact: true }).click(); const dialog = admin.getByRole('dialog', { name: '督導訪視保存內容', exact: true }); await dialog.locator('.error-state').waitFor(); assert(!await dialog.getByText(longText, { exact: true }).count()); await close(admin); await admin.unroute('**/api/' + endpoint + '?**', forged);
    }
  }); mark('G8 fresh detail不信list／錯template與foreign真404／非法single可重讀');

  for (const state of ['loaded-list', 'pending-list', 'loaded-detail', 'pending-detail']) for (const kind of ['user', 'org', 'role', 'employee', 'hash', 'render']) {
    await readOnly('G9 ' + state + ' ' + kind, async () => {
      await load(admin); let pending, trigger;
      const originalList = await admin.locator('.list-content').elementHandle(), originalCases = await admin.getByLabel('個案篩選', { exact: true }).elementHandle();
      if (state === 'pending-list') {
        const url = base + '/api/' + endpoint + '?page=1&pageSize=25&q=VISIT-MAIN'; expectFailure({ id: state + '-' + kind, kind: 'requestfailed', phase: stage, url, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, contextAbort: true });
        pending = await held(admin, '**/api/' + endpoint + '?**', req => new URL(req.url()).searchParams.get('q') === 'VISIT-MAIN');
        await admin.getByLabel('搜尋督導訪視內容', { exact: true }).fill('VISIT-MAIN'); await admin.getByLabel('搜尋督導訪視內容', { exact: true }).press('Enter'); await bounded(pending.arrived, 'list context ' + kind);
      } else if (state === 'pending-detail') {
        const row = await findRow(admin, 'VISIT-MAIN'); trigger = row.getByRole('button', { name: '查看完整內容', exact: true }); const url = base + '/api/' + endpoint + '/' + main.id;
        expectFailure({ id: state + '-' + kind, kind: 'requestfailed', phase: stage, url, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, contextAbort: true });
        pending = await held(admin, url, req => req.method() === 'GET'); await trigger.click(); await bounded(pending.arrived, 'detail context ' + kind);
      } else if (state === 'loaded-detail') { const opened = await openDetails(admin, 'VISIT-MAIN'); await opened.dialog.getByText(longText, { exact: true }).waitFor(); }
      try {
        await mutateContext(admin, kind, foreign.id); if (pending) await pending.finish(); await admin.waitForLoadState('networkidle');
        assert.equal(await originalList.evaluate(node => node.textContent), '', 'Original mounted list cleared; a later app render cannot masquerade as this guard');
        assert(await originalCases.evaluate(node => node.disabled && [...node.options].every(option => option.value === '' && !/VISIT-|合成同名|合成結案/.test(option.textContent))), 'Original case metadata removed');
        assert.equal(await admin.getByRole('dialog').count(), 0); if (kind !== 'hash') assert.equal(await admin.locator('.list-content').innerText(), '');
        const remainingCases = admin.getByLabel('個案篩選', { exact: true });
        if (await remainingCases.count()) {
          assert(await remainingCases.isDisabled(), 'Invalidated case metadata control disabled');
          const optionText = await remainingCases.innerText(); assert(!/VISIT-SAME|VISIT-CLOSED|合成同名個案|合成結案個案/.test(optionText));
          for (const item of [sameA, sameB, closedCase]) assert.equal(await remainingCases.locator('option[value="' + item.id + '"]').count(), 0, 'Old case ID options removed');
        }
        assert.equal(await admin.locator('.toast-success').count(), 0); contextChecks.push({ state, kind, invalidated: true, lateResponseDidNotRender: true, zeroWrites: true, clientCancellationNotServerRevocation: true });
      } finally { if (pending) await pending.finish(); }
    });
  } mark('G9 四loaded/pending列表詳情×六primitive／真abort與晚回應零寫');

  await readOnly('G10 actual offline GET and escape cancellation', async () => {
    await load(admin); const row = await findRow(admin, 'VISIT-MAIN'), trigger = row.getByRole('button', { name: '查看完整內容', exact: true });
    stage = 'G10 offline single'; expectFailure({ id: 'G10-offline', kind: 'requestfailed', phase: stage, url: base + '/api/' + endpoint + '/' + main.id, method: 'GET', failure: 'net::ERR_INTERNET_DISCONNECTED', count: 1, consoleCount: 1 });
    const offline = route => route.abort('internetdisconnected'); await admin.route(base + '/api/' + endpoint + '/' + main.id, offline); await trigger.click(); let dialog = admin.getByRole('dialog', { name: '督導訪視保存內容', exact: true }); await dialog.locator('.error-state').waitFor(); await shot(admin, 'offline-detail-desktop.png'); await admin.unroute(base + '/api/' + endpoint + '/' + main.id, offline); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText(longText, { exact: true }).waitFor(); await close(admin, trigger);
    stage = 'G10 Escape pending'; expectFailure({ id: 'G10-Escape', kind: 'requestfailed', phase: stage, url: base + '/api/' + endpoint + '/' + main.id, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1 });
    const pending = await held(admin, base + '/api/' + endpoint + '/' + main.id, req => req.method() === 'GET'); await trigger.click(); await bounded(pending.arrived, 'Escape pending');
    const aborted = admin.waitForEvent('requestfailed', req => req.url() === base + '/api/' + endpoint + '/' + main.id && req.method() === 'GET' && req.failure()?.errorText === 'net::ERR_ABORTED');
    await close(admin, trigger); await pending.finish(); await aborted; assert.equal(await admin.getByRole('dialog').count(), 0);
  }); mark('G10 真offline GET重試／pending Escape abort與回焦／不復活');

  await readOnly('G11 mobile long content and canonical sibling', async () => {
    await admin.setViewportSize({ width: 390, height: 844 }); await load(admin); const table = admin.locator('.list-content .table-scroll'); assert(await table.evaluate(node => node.scrollWidth > node.clientWidth)); await table.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert(await table.evaluate(node => node.scrollLeft > 0)); await table.evaluate(node => { node.scrollLeft = 0; }); await shot(admin, 'list-mobile.png');
    const { dialog, trigger } = await openDetails(admin, 'VISIT-MAIN'); await dialog.getByText(longText, { exact: true }).waitFor(); await noSecrets(dialog); await shot(admin, 'detail-mobile.png');
    const last = dialog.getByText(longText, { exact: true }); assert.equal(await last.textContent(), longText); await last.evaluate(node => node.scrollIntoView({ block: 'end' })); assert(await dialog.evaluate(node => node.scrollTop > 0));
    assert(await last.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.bottom < innerHeight; }), 'Last full-content line remains within mobile viewport'); await shot(admin, 'detail-bottom-mobile.png'); await close(admin, trigger);
    const row = await findRow(admin, 'VISIT-MOVED'); await row.getByRole('button', { name: '版本歷程', exact: true }).click(); const history = admin.getByRole('dialog', { name: '評鑑填答版本歷程', exact: true }); await history.getByText('第 2 版', { exact: true }).waitFor(); await shot(admin, 'history-mobile.png'); await close(admin);
    await admin.setViewportSize({ width: 1440, height: 1050 }); await load(admin); await layout(admin); await admin.goto(base + '/#/assessments'); await admin.getByRole('heading', { name: '個案評鑑表', exact: true, level: 1 }).waitFor(); await admin.waitForLoadState('networkidle'); await shot(admin, 'assessments-sibling-desktop.png');
  }); mark('G11 390長文完整內捲／16圖內／1440共用assessment sibling無全頁溢出');

  stage = 'G12 final evidence'; same(raw(), allBefore, 'All query activity preserves exact eleven tables, six triggers, schema, snapshots and BLOBs'); same(counts(), allCountsBefore, 'All query activity has zero total_changes');
  same((await request('GET', 'service-records/' + approved.id)).item, approved, 'Approved price/pay snapshot remains exact');
  same(raw(), allBefore, 'Final snapshot read also preserves all raw tables'); same(counts(), allCountsBefore, 'Final snapshot read also has zero writes');
  assert.equal(pageErrors.length, 0, json(pageErrors)); assert.equal(failedResponses.filter(item => !item.expectedRuleId).length, 0, json(failedResponses)); assert.equal(failedRequests.filter(item => !item.expectedRuleId).length, 0, json(failedRequests));
  const assigned = new Set();
  for (const rule of expectedFailures) {
    const events = (rule.kind === 'http' ? failedResponses : failedRequests).filter(event => event.expectedRuleId === rule.id); assert.equal(events.length, rule.count, 'Exact controlled event count: ' + rule.id);
    const matches = consoleErrors.flatMap((event, index) => event.stage === rule.phase && event.location.url === rule.url && (rule.kind === 'http' ? event.text.startsWith('Failed to load resource: the server responded with a status of ' + rule.status + ' (') : event.text === 'Failed to load resource: ' + rule.failure) ? [index] : []);
    if (rule.consoleCount !== undefined) assert.equal(matches.length, rule.consoleCount, 'Exact console location and phase: ' + rule.id); else assert(matches.length <= rule.maxConsoleCount, 'Bounded abort console: ' + rule.id);
    for (const index of matches) { assert(!assigned.has(index)); assigned.add(index); } rule.actualFailureCount = events.length; rule.actualConsoleCount = matches.length;
  }
  assert.equal(consoleErrors.filter((_item, index) => !assigned.has(index)).length, 0, json(consoleErrors));
  mark('G12 全查詢十一表/六trigger/schema/total_changes零寫／快照BLOB保持／精確失敗事件');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), syntheticOnly: true, database: ':memory:', randomLoopback: true, checks, readSegments, fixtureWrites, contextChecks, projectionChecks, allQueryWritesZero: true, snapshotAndBlobsUnchanged: true, pageErrors, consoleErrors, failedResponses, failedRequests, expectedFailures, expectedConsoleFailuresOnly: true, screenshots, visualReviewPending: true, actuallyViewedByScript: false }, null, 2), { flag: 'wx' });
  console.log('RESULT ' + path.join(output, 'e2e.json'));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, stage, error: error.stack, checks, readSegments, fixtureWrites, contextChecks, projectionChecks, consoleErrors, pageErrors, failedResponses, failedRequests, expectedFailures, screenshots }, null, 2), { flag: 'wx' }); throw error;
} finally { for (const context of contexts) await context.close().catch(() => {}); if (browser) await browser.close(); await app.close(); }
