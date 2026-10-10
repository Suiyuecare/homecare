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
const qa = path.join(root, 'outputs/software/interview-record-details-qa/browser');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const app = createApp({ dbPath: ':memory:', port: 0 });
const password = 'synthetic-interview-details-browser-password';
const entity = 'interview-applicants';
const fieldKeys = ['name', 'phone', 'interviewDate', 'city', 'district', 'interviewContent', 'note', 'status'];
const badResponse = '面試紀錄回應無法確認；請重新讀取。';
const checks = [], readSegments = [], fixtureWrites = [], stateLedger = [], screenshots = [], contextChecks = [], referenceChecks = [], outerRebuildChecks = [], malformedChecks = [], footerChecks = [], firstLiteralChecks = [], expectedFailures = [], failedResponses = [], failedRequests = [], consoleErrors = [], pageErrors = [], requestLedger = [], contexts = [];
let browser, base, stage = 'initialization', lastPage, actors, orgId, foreignOrg, employeeA, caseA, main, inactive, foreignItem, legacy, approved, protectedBaseline, sourceHashesBefore, staleList;

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
const endpoint = item => '/api/interview-applicants/' + item.id;
const dialog = page => page.getByRole('dialog', { name: '面試者保存紀錄', exact: true });
const content = page => dialog(page).getByRole('region', { name: '面試者完整保存內容', exact: true });
const field = (page, key) => content(page).locator('[data-interview-field="' + key + '"] dd');
const row = (page, item) => page.locator('tbody tr').filter({ has: page.getByText(item.phone, { exact: true }) });
const load = async (page, item = main) => {
  lastPage = page; const target = base + '/#/interviews'; if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: '面試者登錄', level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle');
  const statuses = page.getByLabel('狀態', { exact: true }); if (await statuses.inputValue() !== '') { await statuses.selectOption(''); await page.waitForLoadState('networkidle'); }
  assert.equal(await statuses.inputValue(), ''); const search = page.getByLabel('搜尋面試者', { exact: true }); await search.fill(item.phone);
  const received = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/interview-applicants' && url.searchParams.get('q') === item.phone && response.request().method() === 'GET'; });
  await search.press('Enter'); const response = await received; assert.equal(response.status(), 200); staleList = await response.json(); await row(page, item).waitFor(); assert.equal(await row(page, item).count(), 1); await page.waitForLoadState('networkidle');
};
const waitContent = async page => { await content(page).waitFor(); assert.equal(await content(page).locator('[data-interview-field]').count(), 8); };
const open = async (page, item = main, { reload = true, keyboard = false } = {}) => {
  if (reload) await load(page, item); const trigger = row(page, item).getByRole('button', { name: '查看紀錄', exact: true }); assert.equal(await trigger.count(), 1);
  const received = page.waitForResponse(response => response.url() === base + endpoint(item) && response.request().method() === 'GET'); if (keyboard) { await trigger.focus(); await trigger.press('Enter'); } else await trigger.click();
  const response = await received; assert.equal(response.status(), 200); const value = await response.json(); await waitContent(page); return { trigger, value };
};
const closeDialog = async (page, modal, trigger) => {
  const element = await modal.elementHandle(); assert(element); await page.keyboard.press('Escape'); await page.waitForFunction(node => !node.isConnected, element); await element.dispose();
  if (trigger) { const handle = await trigger.elementHandle(); assert(handle); await page.waitForFunction(node => document.activeElement === node, handle); await handle.dispose(); }
};
const assertFields = async (page, item) => {
  same(await content(page).locator('[data-interview-field]').evaluateAll(nodes => nodes.map(node => node.dataset.interviewField)), fieldKeys);
  for (const key of fieldKeys) { const value = item[key], missing = !Object.hasOwn(item, key), expectedKind = missing ? 'missing' : value === null ? 'null' : typeof value === 'string' ? value === '' ? 'empty' : 'text' : 'non-text';
    const expected = missing ? '未保存' : value === null ? '未提供（null）' : typeof value === 'string' ? value === '' ? '空白' : key === 'status' ? ['active', 'inactive'].includes(value) ? (value === 'active' ? '啟用' : '停用') + '（保存碼：' + value + '）' : '未辨識狀態（保存原文）：' + value : value : '非文字值（' + (Array.isArray(value) ? 'array' : typeof value) + '）';
    assert.equal(await field(page, key).textContent(), expected, key + ' exact saved text/type'); assert.equal(await field(page, key).locator('..').getAttribute('data-saved-kind'), expectedKind);
  }
  const metadata = content(page).getByLabel('保存紀錄資訊'); for (const [label, key] of [['版次', 'version'], ['保存更新文字', 'updatedAt'], ['保存建立文字', 'createdAt'], ['識別碼', 'id']]) assert.equal(await metadata.locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd').textContent(), String(item[key]));
  assert.equal(await content(page).locator('script,img,iframe,button,a').count(), 0, 'Saved HTML is literal, never controls'); assert.equal(await page.evaluate(() => window.__syntheticInterviewExecuted), undefined);
};
const layout = async page => {
  const result = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll('dialog[open]')].map(node => ({ width: node.clientWidth, contentWidth: node.scrollWidth })), parentLinks: [...document.querySelectorAll('a[href^="#/cases/"]')].length }));
  assert(result.documentWidth <= result.width + 1, json(result)); for (const entry of result.dialogs) assert(entry.contentWidth <= entry.width + 1, json(result)); return result;
};
const shot = async (page, name) => { await settle(page); await layout(page); const p = path.join(output, name); await page.screenshot({ path: p, fullPage: false }); screenshots.push({ name, path: p, sha256: sha(await readFile(p)), viewport: page.viewportSize(), actuallyViewed: false, visualReviewPending: true }); };
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
  if (primitive === 'hash') location.hash = '/help';
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
const textGeometry = async (locator, literal, edge = 'end') => {
  await locator.evaluate((node, edge) => { node.scrollIntoView({ block: edge, inline: 'start' }); const region = node.closest('.table-scroll'); if (region) region.scrollLeft += node.getBoundingClientRect().left - region.getBoundingClientRect().left - 8; const dialog = node.closest('dialog'), footer = dialog.querySelector(':scope > .dialog-footer'); if (edge === 'start') dialog.scrollTop += node.getBoundingClientRect().top - dialog.getBoundingClientRect().top - 24; else dialog.scrollTop += Math.max(0, node.getBoundingClientRect().bottom - footer.getBoundingClientRect().top + 20); }, edge);
  const result = await locator.evaluate((node, literal) => {
    const modal = node.closest('dialog'), footer = modal.querySelector(':scope > .dialog-footer').getBoundingClientRect(), table = node.closest('.table-scroll'), tableRect = table?.getBoundingClientRect(), walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let found;
    while (walker.nextNode()) if (walker.currentNode.textContent.includes(literal)) found = walker.currentNode; if (!found) throw new Error('Saved literal text node absent'); const start = found.textContent.lastIndexOf(literal), range = document.createRange(); range.setStart(found, start); range.setEnd(found, start + literal.length);
    return { directCloseFooter: ':scope > .dialog-footer', footerTop: footer.top, scrollX, innerWidth, tableScrollWidth: table?.scrollWidth, tableClientWidth: table?.clientWidth, literal, rects: [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => { const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, visibleAboveFooter: rect.top >= 0 && rect.bottom <= Math.min(innerHeight, footer.top) && rect.left >= Math.max(0, tableRect?.left ?? 0) && rect.right <= Math.min(innerWidth, tableRect?.right ?? innerWidth), hitTestVisible: Boolean(hit && (hit === node || node.contains(hit))) }; }) };
  }, literal);
  assert.equal(result.scrollX, 0); assert(result.rects.length); assert(result.rects.every(rect => rect.visibleAboveFooter && rect.hitTestVisible), json(result)); (edge === 'start' ? firstLiteralChecks : footerChecks).push(result); return result;
};

try {
  sourceHashesBefore = await sourceMap(); base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310'); browser = await chromium.launch({ headless: true });
  const adminClient = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(adminClient);
  const setup = await fixtureWrite('synthetic setup and owned session', () => adminClient.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成面試詳情管理員', email: 'interview-details-admin@example.test', password, organizationName: '合成面試詳情甲機構' } })); assert.equal(setup.status(), 201); const auth = await setup.json(); orgId = auth.organizations[0].id;
  const admin = await adminClient.newPage(); observe(admin); actors = { admin: { client: adminClient, auth, page: admin } };
  const request = async (method, route, data, expected = 200, actor = actors.admin, selectedOrg = orgId) => { const response = await actor.client.request.fetch(base + route, { method, headers: { Origin: base, 'X-Org-Id': selectedOrg, 'X-CSRF-Token': actor.auth.csrfToken }, ...(data === undefined ? {} : { data }) }); const value = await response.json(); assert.equal(response.status(), expected, method + ' ' + route + ' ' + json(value)); return value; };
  const post = async (name, data, selectedOrg = orgId) => (await request('POST', '/api/' + name, data, 201, actors.admin, selectedOrg)).item;
  const patch = async (name, item, data, actor = actors.admin) => (await request('PATCH', '/api/' + name + '/' + item.id, { version: item.version, ...data }, 200, actor)).item;
  const versionedPatch = async (name, item, data, actor) => {
    const before = raw(), beforeCounts = counts(), result = await patch(name, item, data, actor), after = raw();
    assert.equal(result.id, item.id); assert.equal(result.version, item.version + 1); assert.equal(counts().totalChanges - beforeCounts.totalChanges, 3);
    assert.equal(counts().records, beforeCounts.records); assert.equal(counts().versions, beforeCounts.versions + 1); assert.equal(counts().audit, beforeCounts.audit + 1); assert.equal(counts().idempotency, beforeCounts.idempotency);
    for (const table of Object.keys(before.tables)) {
      if (table === 'records') same(after.tables[table].filter(value => value.id !== item.id), before.tables[table].filter(value => value.id !== item.id), 'Fixture PATCH preserves every other record');
      else if (['record_versions', 'audit'].includes(table)) same(after.tables[table].slice(0, before.tables[table].length), before.tables[table], 'Fixture PATCH preserves original history/audit');
      else same(after.tables[table], before.tables[table], 'Fixture PATCH preserves all unrelated tables/BLOBs');
    }
    const stored = after.tables.records.find(value => value.id === item.id), saved = after.tables.record_versions.at(-1), audit = after.tables.audit.at(-1);
    same({ ...JSON.parse(stored.data), id: stored.id, orgId: stored.org_id, version: Number(stored.version), createdAt: stored.created_at, updatedAt: stored.updated_at }, result); assert.equal(stored.created_at, before.tables.records.find(value => value.id === item.id).created_at);
    assert.equal(saved.org_id, orgId); assert.equal(saved.entity, name); assert.equal(saved.record_id, item.id); assert.equal(saved.version, BigInt(result.version)); same(JSON.parse(saved.snapshot), result);
    assert.equal(audit.org_id, orgId); assert.equal(audit.entity, name); assert.equal(audit.record_id, item.id); assert.equal(audit.user_id, actor.auth.user.id); assert.equal(audit.action, 'record.update'); same(after.schema, before.schema); return result;
  };
  let service;
  const contentFirst = '合成面試全文第一句可讀', contentLast = '合成面試全文最後一句可讀', noteFirst = '合成備註全文第一句可讀', noteLast = '合成備註全文最後一句可讀';
  const longContent = contentFirst + '\r\n' + Array.from({ length: 80 }, (_, i) => '合成面試保存第' + String(i + 1).padStart(3, '0') + '行，維持全文。').join('\r\n') + '\r\n<script>window.__syntheticInterviewExecuted=true</script><img src=x onerror="window.__syntheticInterviewExecuted=true">\r\n' + contentLast;
  const longNote = noteFirst + '\n' + Array.from({ length: 60 }, (_, i) => '合成備註保存第' + String(i + 1).padStart(3, '0') + '行。').join('\n') + '\n<button>不產生按鈕</button> & <b>原文</b>\n' + noteLast;
  await fixtureWrite('synthetic four roles two organizations and same-name inactive interview records', async () => {
    employeeA = await post('employees', { employeeNo: 'INTERVIEW-DETAILS-EMP', name: '合成詳情居服員', role: 'caregiver', hourlyRateCents: 10000 });
    for (const role of ['supervisor', 'finance', 'caregiver']) { await post('users', { name: '合成面試詳情' + role, email: 'interview-details-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) }); const client = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(client); const login = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'interview-details-' + role + '@example.test', password } }); assert.equal(login.status(), 200); const page = await client.newPage(); observe(page); actors[role] = { client, auth: await login.json(), page }; }
    foreignOrg = await post('organizations', { name: '合成面試詳情乙機構' });
    main = await post(entity, { name: '合成同名面試者', phone: '0000-DETAILS-A', interviewDate: '2026-10-10', city: '合成縣市', district: '合成鄉鎮區', interviewContent: longContent, note: longNote, status: 'active' });
    inactive = await post(entity, { name: main.name, phone: '0000-DETAILS-B', interviewDate: '2026-10-11', city: '', district: '', interviewContent: '合成停用保存全文，與同名A不同。', note: '', status: 'inactive' });
    foreignItem = await post(entity, { name: main.name, phone: '0000-DETAILS-FOREIGN', interviewDate: '2026-10-11', interviewContent: 'FOREIGN_INTERVIEW_NEVER_SHOWN' }, foreignOrg.id);
    caseA = await post('cases', { caseNo: 'INTERVIEW-DETAILS-CASE', name: '合成保護個案' }); service = await post('service-items', { code: 'INTERVIEW-DETAILS-BA01', name: '合成保護服務', minutes: 60, unitPriceCents: 10000 });
  });
  await fixtureWrite('protected approved billing/two nonempty BLOBs and legacy raw interview fixtures', async () => {
    const certificate = await post('employee-certifications', { employeeId: employeeA.id, name: '合成保護證照', certificateNo: 'SYNTHETIC-DETAILS-CERT', issuer: '合成單位', issuedOn: '2026-01-01' });
    const plan = await post('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
    const shift = await post('shifts', { caseId: caseA.id, employeeId: employeeA.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
    const record = await post('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:00', actualEnd: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }], status: 'draft' }); const submitted = await patch('service-records', record, { status: 'submitted' }, actors.supervisor); approved = (await request('POST', '/api/service-records/' + record.id + '/review', { version: submitted.version, decision: 'approved', reviewNote: '合成核閱快照保持' })).item;
    await request('POST', '/api/case-attachments/upload', { caseId: caseA.id, title: '合成詳情BLOB甲', category: 'general', note: '合成保護', ...filePayload(PDF_BYTES, 'synthetic-interview-details.pdf', 'application/pdf') }, 201);
    await request('POST', '/api/certification-attachments/upload', { certificationId: certificate.id, title: '合成詳情BLOB乙', note: '合成保護', ...filePayload(PNG_BYTES, 'synthetic-interview-details.png', 'image/png') }, 201);
    const rawItem = data => { const itemId = id(), createdAt = '保存建立\r\n不是日期', updatedAt = '保存更新\n原文字'; app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(itemId, orgId, entity, json(data), 1, createdAt, updatedAt); return { ...data, id: itemId, orgId, version: 1, createdAt, updatedAt }; };
    legacy = [
      rawItem({ phone: '0000-DETAILS-TYPED-A', name: null, interviewDate: '0000-01-01', city: { nested: 'HIDDEN_INTERVIEW_OBJECT' }, district: ['HIDDEN_INTERVIEW_ARRAY'], interviewContent: 47, note: false, status: null, unknownSaved: { name: 'HIDDEN_UNKNOWN_INTERVIEW_KEY' } }),
      rawItem({ name: '', phone: '0000-DETAILS-TYPED-B', interviewDate: '', city: '', district: null, status: 'legacy-unrecognized-status\r\n原狀態尾句' }),
      rawItem({ phone: '0000-DETAILS-TYPED-C', interviewDate: '不是日期 <script>literal</script>\r\n原日期尾句', city: '  原縣市\r\n原第二行  ', district: 23, interviewContent: ['HIDDEN_INTERVIEW_CONTENT'], note: { secret: 'HIDDEN_INTERVIEW_NOTE' }, status: 'active' }),
    ];
  });
  assert(raw().tables.attachment_files.some(value => value.content?.length || value.data?.length || value.bytes?.length)); assert(raw().tables.certification_attachment_files.some(value => value.content?.length || value.data?.length || value.bytes?.length)); assert(approved.billingSnapshot); protectedBaseline = raw();
  await readOnly('G1 role-first same-org and nonexistent authorization', async () => {
    for (const role of ['finance', 'caregiver']) { await request('GET', endpoint(main), undefined, 403, actors[role]); await request('GET', endpoint(foreignItem), undefined, 403, actors[role]); const page = actors[role].page; lastPage = page; await page.goto(base + '/#/'); await page.getByRole('heading', { name: '今日服務工作台', level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); assert.equal(await page.locator('[data-route="/interviews"]').count(), 0); assert.equal(await page.getByRole('button', { name: '查看紀錄', exact: true }).count(), 0); const before = requestLedger.length; await page.evaluate(async id => { const { openInterviewRecordDetails } = await import('/modules/interview-record-details.js'); await openInterviewRecordDetails({ id }); }, main.id); assert.equal(requestLedger.length, before, 'Unauthorized preopen emits no API request'); assert.equal(await page.locator('dialog[open]').count(), 0); }
    await load(admin); const beforePreflight = requestLedger.length; await admin.evaluate(async id => { const { openInterviewRecordDetails } = await import('/modules/interview-record-details.js'); await openInterviewRecordDetails({ id: 'NOT-A-ROUTE-ID' }); await openInterviewRecordDetails({ id, isCurrent: () => false }); }, main.id); assert.equal(requestLedger.length, beforePreflight, 'Invalid ID/caller preopen emits no API request'); assert.equal(await admin.locator('dialog[open]').count(), 0);
    for (const actor of [actors.admin, actors.supervisor]) { same((await request('GET', endpoint(main), undefined, 200, actor)).item, main); same((await request('GET', endpoint(inactive), undefined, 200, actor)).item, inactive); await request('GET', endpoint(foreignItem), undefined, 404, actor); await request('GET', endpoint({ id: id() }), undefined, 404, actor); }
  }); mark('G1 four actual roles/two organizations: role-first403, scoped404 and inactive read');

  let staleTrigger;
  await readOnly('G2 eight full fields and literal HTML keyboard open', async () => {
    const opened = await open(admin, main, { keyboard: true }); await assertFields(admin, opened.value.item); assert.equal(opened.value.item.version, 1); assert.equal(requestLedger.filter(value => value.stage === stage && value.url === base + endpoint(main)).length, 1); await shot(admin, 'full-record-desktop.png'); await closeDialog(admin, dialog(admin), opened.trigger);
    const sameName = await open(actors.supervisor.page, inactive); await assertFields(actors.supervisor.page, sameName.value.item); assert.equal(sameName.value.item.id, inactive.id); assert.equal(sameName.value.item.name, main.name); assert.equal(sameName.value.item.status, 'inactive'); await shot(actors.supervisor.page, 'inactive-same-name-desktop.png'); await closeDialog(actors.supervisor.page, dialog(actors.supervisor.page), sameName.trigger);
    await load(admin, main); assert.equal(staleList.items.find(value => value.id === main.id).version, 1); staleTrigger = row(admin, main).getByRole('button', { name: '查看紀錄', exact: true });
  }); mark('G2 all eight exact saved fields, CR/LF/HTML literal, keyboard and same-name inactive ID');
  main = await fixtureWrite('authorized synthetic supervisor updates sole main record after captured v1 list', () => versionedPatch(entity, main, { interviewContent: longContent.replace(contentFirst, '督導第二版：' + contentFirst), note: longNote.replace(noteFirst, '督導第二版：' + noteFirst) }, actors.supervisor)); protectedBaseline = raw();
  await readOnly('G3 single fresh GET supersedes stale row version', async () => {
    const received = admin.waitForResponse(response => response.url() === base + endpoint(main) && response.request().method() === 'GET'); await staleTrigger.click(); const value = await (await received).json(); await waitContent(admin); assert.equal(value.item.version, 2); await assertFields(admin, main); assert.equal(requestLedger.filter(value => value.stage === stage && value.url === base + endpoint(main)).length, 1); await shot(admin, 'fresh-version-desktop.png'); await closeDialog(admin, dialog(admin), staleTrigger);
    const history = await request('GET', endpoint(main) + '/history?compare=previous'); assert.equal(history.items[0].actor.id, actors.supervisor.auth.user.id); assert.equal(history.items[0].version, 2); assert.equal(history.items[0].comparison.previousSnapshot.version, 1);
  }); mark('G3 stale v1 list opens fresh v2 metadata/content with exact supervisor history');

  await readOnly('G4 missing/empty/null/typed own-presence and nested content hidden', async () => {
    for (const item of legacy) { const opened = await open(admin, item); await assertFields(admin, opened.value.item); for (const token of ['HIDDEN_INTERVIEW_OBJECT', 'HIDDEN_INTERVIEW_ARRAY', 'HIDDEN_UNKNOWN_INTERVIEW_KEY', 'HIDDEN_INTERVIEW_CONTENT', 'HIDDEN_INTERVIEW_NOTE']) assert(!(await dialog(admin).textContent()).includes(token)); if (item === legacy[0]) await shot(admin, 'typed-missing-desktop.png'); await closeDialog(admin, dialog(admin), opened.trigger); }
  }); mark('G4 all eight own-presence types displayed as exact markers; nested/unknown data hidden');
  await readOnly('G5 unknown status and invalid/year0000 date/time text never parsed', async () => {
    for (const item of [legacy[0], legacy[1], legacy[2]]) { const opened = await open(actors.supervisor.page, item); await assertFields(actors.supervisor.page, item); assert.equal(await field(actors.supervisor.page, 'interviewDate').textContent(), item.interviewDate || '空白'); if (item === legacy[1]) await shot(actors.supervisor.page, 'unknown-status-desktop.png'); await closeDialog(actors.supervisor.page, dialog(actors.supervisor.page), opened.trigger); }
  }); mark('G5 literal unknown status, year0000/legacy date, whitespace and unparsed metadata');

  await readOnly('G6 one exact503 no automatic retry; manual fresh GET recovery', async () => {
    await load(admin); const trigger = row(admin, main).getByRole('button', { name: '查看紀錄', exact: true }), url = base + endpoint(main); let called = 0;
    const handler = route => ++called === 1 ? route.fulfill({ status: 503, json: { error: { message: '合成面試紀錄首次不可用' } } }) : route.continue(); addRule({ id: 'G6-first503', kind: 'http', phase: stage, url, method: 'GET', status: 503, count: 1, maxConsoleCount: 1 }); await admin.route(url, handler); await trigger.click(); await dialog(admin).getByRole('alert').getByText('合成面試紀錄首次不可用', { exact: true }).waitFor(); assert.equal(await dialog(admin).locator('[data-interview-field]').count(), 0); await settle(admin); assert.equal(called, 1); await shot(admin, 'error-retry-desktop.png'); await dialog(admin).getByRole('alert').getByRole('button', { name: '重新讀取', exact: true }).click(); await waitContent(admin); assert.equal(called, 2); await assertFields(admin, main); await admin.unroute(url, handler); await closeDialog(admin, dialog(admin), trigger);
  }); mark('G6 exact503 error without fields/no automatic retry, one manual fresh GET');

  const malformedVariants = [
    ['extra-envelope', value => { value.privateSnapshot = { text: 'HIDDEN_MALFORMED' }; }], ['missing-item', value => { delete value.item; }], ['null-item', value => { value.item = null; }], ['array-item', value => { value.item = [value.item]; }],
    ['wrong-valid-id', value => { value.item.id = inactive.id; }], ['invalid-id', value => { value.item.id = 'NOT-A-ROUTE-ID'; }], ['missing-id', value => { delete value.item.id; }], ['wrong-org', value => { value.item.orgId = foreignOrg.id; }], ['missing-org', value => { delete value.item.orgId; }],
    ['missing-version', value => { delete value.item.version; }], ['zero-version', value => { value.item.version = 0; }], ['unsafe-version', value => { value.item.version = 9007199254740992; }], ['missing-created', value => { delete value.item.createdAt; }], ['typed-created', value => { value.item.createdAt = { secret: 'HIDDEN_MALFORMED' }; }], ['missing-updated', value => { delete value.item.updatedAt; }], ['typed-updated', value => { value.item.updatedAt = ['HIDDEN_MALFORMED']; }],
  ];
  await readOnly('G7 sixteen untrusted2xx envelopes/identity/metadata rejected with manual real retry', async () => {
    for (const [name, change] of malformedVariants) { await load(admin); const trigger = row(admin, main).getByRole('button', { name: '查看紀錄', exact: true }), url = base + endpoint(main); let called = 0; const handler = async route => { called++; const response = await route.fetch(), value = await response.json(); change(value); await route.fulfill({ status: 200, json: value }); }; await admin.route(url, handler); await trigger.click(); await dialog(admin).getByRole('alert').getByText(badResponse, { exact: true }).waitFor(); assert.equal(await dialog(admin).locator('[data-interview-field]').count(), 0); assert.equal(await dialog(admin).locator('.detail-grid').count(), 0); assert(!(await dialog(admin).textContent()).includes('HIDDEN_MALFORMED')); await settle(admin); assert.equal(called, 1); if (name === 'wrong-org') await shot(admin, 'malformed-response-desktop.png'); await admin.unroute(url, handler); const start = requestLedger.filter(value => value.url === url && value.stage === stage).length; await dialog(admin).getByRole('alert').getByRole('button', { name: '重新讀取', exact: true }).click(); await waitContent(admin); await assertFields(admin, main); assert.equal(requestLedger.filter(value => value.url === url && value.stage === stage).length - start, 1); malformedChecks.push({ name, rejected: true, noFields: true, manualSingleFreshRetry: true }); await closeDialog(admin, dialog(admin), trigger); }
  }); mark('G7 sixteen untrusted2xx closed/identity/metadata rejects, no disclosure and exact manual retry');

  const prepareState = async state => {
    await load(admin); const trigger = row(admin, main).getByRole('button', { name: '查看紀錄', exact: true }); let pending;
    if (state === 'pending') pending = await held(admin, base + endpoint(main)); await trigger.click(); const modal = dialog(admin); await modal.waitFor(); if (pending) await bounded(pending.arrived, 'single detail request arrival'); else { await waitContent(admin); await assertFields(admin, main); } return { trigger, modal, pending };
  };
  await readOnly('G8 loaded/pending six primitive invalidations and genuine request abort', async () => {
    for (const state of ['loaded', 'pending']) for (const primitive of ['user', 'org', 'role', 'employee', 'hash', 'render']) { stage = 'G8 ' + state + ' ' + primitive; const prepared = await prepareState(state), original = await prepared.modal.elementHandle(); let abort; if (prepared.pending) abort = abortEvent(admin, await prepared.pending.arrived, 'G8-' + state + '-' + primitive); await mutate(admin, primitive); await admin.waitForFunction(node => !node.isConnected, original); if (prepared.pending) { await prepared.pending.finish(); await abort; } await settle(admin); assert.equal(await admin.locator('dialog[open]').count(), 0); assert.equal(await admin.locator('[data-interview-field]').count(), 0); contextChecks.push({ state, primitive, originalModalDetached: true, lateResponseDidNotRevive: true, observedAbort: Boolean(abort) }); await original.dispose(); }
  }); mark('G8 twelve loaded/pending primitive guards remove full saved DOM; six exact real GET aborts');
  await readOnly('G9 nested same-value references retain real content; outer rebuild invalidates', async () => {
    for (const state of ['loaded', 'pending']) { let prepared = await prepareState(state), original = await prepared.modal.elementHandle(); const reference = await replaceReferences(admin); assert.equal(await original.evaluate(node => node.isConnected && node.open), true); if (prepared.pending) await prepared.pending.finish(); await waitContent(admin); await assertFields(admin, main); referenceChecks.push({ state, ...reference, realContentCompleted: true }); await closeDialog(admin, prepared.modal, prepared.trigger); await original.dispose();
      stage = 'G9 outer ' + state; prepared = await prepareState(state); original = await prepared.modal.elementHandle(); let abort; if (prepared.pending) abort = abortEvent(admin, await prepared.pending.arrived, 'G9-outer-' + state); const outer = await replaceReferences(admin, true); await admin.waitForFunction(node => !node.isConnected, original); if (prepared.pending) { await prepared.pending.finish(); await abort; } await settle(admin); assert.equal(await admin.locator('dialog[open]').count(), 0); assert.equal(await admin.locator('[data-interview-field]').count(), 0); outerRebuildChecks.push({ state, ...outer, originalModalDetached: true, observedAbort: Boolean(abort) }); await original.dispose(); }
  }); mark('G9 two nested reference negatives complete true fields and two outer context rebuild withdrawals');
  await readOnly('G10 pending Escape abort and native Enter/close focus', async () => {
    const prepared = await prepareState('pending'), aborted = abortEvent(admin, await prepared.pending.arrived, 'G10-pending-Escape'); await closeDialog(admin, prepared.modal, prepared.trigger); await prepared.pending.finish(); await aborted; await settle(admin); assert.equal(await admin.locator('dialog[open]').count(), 0); assert.equal(await admin.locator('[data-interview-field]').count(), 0);
    const opened = await open(admin, main, { keyboard: true }); await assertFields(admin, main); await closeDialog(admin, dialog(admin), opened.trigger); assert.equal(await opened.trigger.evaluate(node => node === document.activeElement), true);
  }); mark('G10 observed Escape abort before phase advance, literal detach and native Enter/focus restoration');

  await readOnly('G11 390px saved long content and note first/last literal above direct footer', async () => {
    await admin.setViewportSize({ width: 390, height: 844 }); const opened = await open(admin); await assertFields(admin, main); await shot(admin, 'full-record-mobile.png');
    for (const [key, first, last, image] of [['interviewContent', contentFirst, contentLast, 'content-end-mobile.png'], ['note', noteFirst, noteLast, 'note-end-mobile.png']]) { const saved = field(admin, key); assert((await saved.textContent()).includes(first)); assert((await saved.textContent()).includes(last)); await textGeometry(saved, first, 'start'); await textGeometry(saved, last); await shot(admin, image); }
    await closeDialog(admin, dialog(admin), opened.trigger); await admin.setViewportSize({ width: 1440, height: 1000 });
  }); mark('G11 390px exact long CR/LF/HTML literal, two complete tails Range/hit-test above true close footer');
  await readOnly('G12 original interviews filters/edit/history and protected baseline', async () => {
    await load(admin); const target = row(admin, main), editTrigger = target.getByRole('button', { name: '編輯', exact: true }); await editTrigger.click(); const editModal = admin.getByRole('dialog', { name: '編輯面試者', exact: true }); await editModal.getByLabel(/^姓名/).waitFor(); await closeDialog(admin, editModal, editTrigger);
    const historyTrigger = row(admin, main).getByRole('button', { name: '版本歷程', exact: true }); await historyTrigger.click(); const historyModal = admin.getByRole('dialog', { name: '面試者版本歷程', exact: true }); await historyModal.getByText('第 2 版', { exact: true }).waitFor(); await historyModal.getByText(actors.supervisor.auth.user.name, { exact: true }).first().waitFor(); await closeDialog(admin, historyModal, historyTrigger);
    const date = admin.getByLabel('面試日期篩選', { exact: true }); await date.fill(main.interviewDate); await row(admin, main).waitFor(); await admin.waitForLoadState('networkidle'); assert.equal(await row(admin, main).count(), 1); await admin.getByRole('button', { name: '清除面試日期', exact: true }).click(); await admin.waitForLoadState('networkidle'); assert.equal(await date.inputValue(), '');
    await load(actors.supervisor.page, inactive); assert.equal(await row(actors.supervisor.page, inactive).getByRole('button', { name: '啟用', exact: true }).count(), 1); const saved = (await request('GET', '/api/service-records/' + approved.id)).item; same(saved, approved); same(raw(), protectedBaseline);
  }); mark('G12 original interview search/date/editor/history actor/enable controls; all BLOBs/billing/raw unchanged');

  same(pageErrors, []); same(failedResponses.filter(value => !value.expectedRuleId), []); same(failedRequests.filter(value => !value.expectedRuleId), []);
  for (const rule of expectedFailures) assert.equal((rule.kind === 'http' ? failedResponses : failedRequests).filter(value => value.expectedRuleId === rule.id).length, rule.count, rule.id);
  for (const error of consoleErrors) { const rule = expectedFailures.find(value => value.phase === error.stage && value.url === error.location.url && (value.kind === 'http' ? error.text.includes('503') : error.text.includes(value.failure))); assert(rule, 'Unallocated console error ' + json(error)); rule.actualConsoleCount = (rule.actualConsoleCount || 0) + 1; assert(rule.actualConsoleCount <= rule.maxConsoleCount); }
  for (let i = 0; i < stateLedger.length; i++) { assert.equal(stateLedger[i].sequence, i + 1); if (i) { assert.equal(stateLedger[i - 1].afterSha256, stateLedger[i].beforeSha256); same(stateLedger[i - 1].afterCounts, stateLedger[i].beforeCounts); } }
  assert.equal(stateLedger.at(-1).afterSha256, sha(raw())); same(stateLedger.at(-1).afterCounts, counts());
  const sourceHashesAfter = await sourceMap(); same(sourceHashesAfter, sourceHashesBefore); assert.equal(checks.length, 12); assert.equal(readSegments.length, 12); assert.equal(fixtureWrites.length, 4); assert.equal(stateLedger.length, 16); assert.equal(contextChecks.length, 12); assert.equal(referenceChecks.length, 2); assert.equal(outerRebuildChecks.length, 2); assert.equal(malformedChecks.length, 16); assert.equal(footerChecks.length, 2); assert.equal(firstLiteralChecks.length, 2); assert.equal(screenshots.length, 10); assert.equal(expectedFailures.length, 9);
  const report = { passed: true, completedAt: now(), syntheticOnly: true, database: ':memory:', randomLoopback: true, base, checks, sourceHashesBefore, sourceHashesAfter, sourceCount: Object.keys(sourceHashesBefore).length, runtimeSourceCount: Object.keys(sourceHashesBefore).filter(rel => rel.startsWith('public/') || rel.startsWith('src/')).length, readSegments, fixtureWrites, stateLedger, contextChecks, referenceChecks, outerRebuildChecks, malformedChecks, footerChecks, firstLiteralChecks, expectedFailures, failedResponses, failedRequests, consoleErrors, pageErrors, requestLedger, screenshots, protectedRowsAndBlobsUnchanged: true, snapshotUnchanged: true, expectedConsoleFailuresOnly: true, actuallyViewedByScript: false, visualReviewPending: true };
  const p = path.join(output, 'e2e.json'); await writeFile(p, json(report), { flag: 'wx' }); console.log('RESULT ' + p);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const report = { passed: false, completedAt: now(), stage, error: error.stack, checks, readSegments, fixtureWrites, stateLedger, contextChecks, referenceChecks, outerRebuildChecks, malformedChecks, footerChecks, firstLiteralChecks, screenshots, expectedFailures, failedResponses, failedRequests, consoleErrors, pageErrors, requestLedger, sourceHashesBefore, sourceHashesAfter: await sourceMap().catch(() => null), actuallyViewedByScript: false, visualReviewPending: true };
  const p = path.join(output, 'failure.json'); await writeFile(p, json(report), { flag: 'wx' }); console.log('RESULT ' + p); throw error;
} finally { await Promise.all(contexts.map(value => value.close().catch(() => {}))); await browser?.close(); await app.close(); }
