import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { insert } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

// Private author draft: copy to tests only after root review. One explicit run;
// synthetic memory SQLite, a random 127.0.0.1 port and real Chromium only.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/month-filter-safety-qa/new-browser-work');
assert(!existsSync(path.join(output, 'e2e.json')), 'Retain the prior actual attempt before authorizing a new run');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const collectSources = async () => {
  const names = [];
  const walk = async dir => { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (/\.(?:mjs|js|json|md|html|css|svg)$/.test(file)) names.push(file); } };
  for (const dir of ['public', 'src', 'tests', 'scripts', 'docs']) await walk(dir);
  for (const file of ['BUILD_STATE.md', 'PRODUCT.md', 'README.md', 'DESIGN.md', 'UX-CONTRACT.md', 'package.json', 'premium-ui.json']) if (existsSync(path.join(root, file))) names.push(file);
  return Object.fromEntries(await Promise.all([...new Set(names)].sort().map(async file => [file, digest(await readFile(path.join(root, file)))])));
};
await mkdir(output, { recursive: true });
const sourceHashesBefore = await collectSources();
assert.deepEqual(await collectSources(), sourceHashesBefore, 'Capture every current source byte unchanged before browser setup');
const app = createApp({ dbPath: ':memory:', host: '127.0.0.1', port: 0 });
const password = 'synthetic-month-filter-safety-password';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const month = today.slice(0, 7), year = Number(month.slice(0, 4)), monthNumber = Number(month.slice(5, 7));
const otherMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 7);
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], contexts = [];
const readSegments = [], writeSegments = [], apiChecks = [], uiQueries = [], importedFixtures = [], blobDownloads = [];
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const counts = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, ...Object.fromEntries(['audit', 'records', 'record_versions', 'idempotency'].map(table => [table === 'record_versions' ? 'versions' : table, app.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n])) });
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const triggerState = () => app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
const readOnly = async (label, work) => { const before = counts(), raw = rawState(), triggers = triggerState(); assert.equal(Object.keys(raw).length, 11); assert.equal(triggers.length, 6); const result = await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); assert.deepEqual(triggerState(), triggers, label); readSegments.push({ label, all11TablesUnchanged: true, all6TriggersUnchanged: true, before, after: counts(), rawBeforeSha256: digest(JSON.stringify(raw)), rawAfterSha256: digest(JSON.stringify(rawState())) }); return result; };
const written = async (label, work) => { const before = counts(); const result = await work(); writeSegments.push({ label, phase: 'pre-read-fixture-or-login-only', before, after: counts() }); return result; };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: response.status() === 503 }); });
};
const headings = { shifts: '班表', 'service-records': '服務紀錄與核閱', own: '我的服務' };
const resultSection = (page, kind) => page.locator(`section[aria-label="${headings[kind]}結果"]`);
const search = (page, kind) => page.getByLabel(`${headings[kind]}搜尋`, { exact: true });
const load = async (page, route, title) => { lastPage = page; if (page.url() === `${base}/#${route}`) await page.reload(); else await page.goto(`${base}/#${route}`); await page.getByRole('heading', { name: title, level: 1, exact: true }).waitFor(); };
const inspectLayout = async page => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow');
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.labels?.length && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')).map(n => n.name)), []);
  for (const region of await page.locator('.table-scroll').all()) if (await region.isVisible()) assert.equal(await region.evaluate(n => getComputedStyle(n).overflowX), 'auto');
};
const screenshot = async (page, name) => { await inspectLayout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name); };
const matchQuery = (response, entity, expected) => { const url = new URL(response.url()); return response.request().method() === 'GET' && url.pathname === `/api/${entity}` && Object.entries(expected).every(([key, value]) => (url.searchParams.get(key) || '') === String(value)); };
const listQuery = (extra = {}) => ({ month, page: 1, pageSize: 25, q: '', status: '', ...extra });
const renderedList = async (page, kind, expected, action, total, expectedIds) => {
  const entity = kind === 'own' ? 'shifts' : kind;
  const waiting = page.waitForResponse(response => matchQuery(response, entity, expected));
  await action(); const response = await waiting; assert.equal(response.status(), 200, 'Real monthly UI list must return 200');
  const body = await response.json(); assert.equal(body.total, total); assert.equal(body.page, Number(expected.page)); assert.equal(body.pageSize, Number(expected.pageSize));
  if (expectedIds) assert.deepEqual(body.items.map(item => item.id).sort(), [...expectedIds].sort());
  for (const item of body.items) assert.equal(item.orgId, orgId, 'UI response remains in the current organization');
  await page.waitForFunction(label => document.querySelector(`section[aria-label="${label}"]`)?.getAttribute('aria-busy') === 'false', `${headings[kind]}結果`);
  assert.equal(await resultSection(page, kind).locator('.error-state').count(), 0);
  assert.equal(await resultSection(page, kind).locator(kind === 'own' ? '.service-card' : 'tbody tr').count(), body.items.length);
  const pages = Math.max(1, Math.ceil(total / 25)), text = total ? `共 ${total} 筆 · 第 ${Math.min(Number(expected.page), pages)} / ${pages} 頁` : '共 0 筆';
  await page.getByRole('navigation', { name: '資料分頁', exact: true }).getByText(text, { exact: true }).waitFor();
  uiQueries.push({ role: await page.locator('.role-tag').textContent(), kind, filters: expected, total, page: body.page, pageSize: body.pageSize, itemIds: body.items.map(item => item.id), status: response.status() }); return body;
};
const enterSearch = async (page, kind, value) => { await search(page, kind).fill(value); await search(page, kind).press('Enter'); };
const changeMonth = async (page, value) => { const control = page.getByLabel('服務月份', { exact: true }); await control.fill(value); await control.press('Tab'); };
let orgId;

try {
  const initialCounts = counts(); base = await app.listen(); assert(new URL(base).hostname === '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const setupClient = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(setupClient);
  const setup = await written('normal-admin-organization-setup', async () => { const response = await setupClient.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成月份管理員', email: 'month-admin@example.test', password, organizationName: '合成月份甲機構' } }); assert.equal(response.status(), 201); return response.json(); });
  orgId = setup.organizations[0].id;
  const setupActor = { client: setupClient, auth: setup }, users = { admin: { email: setup.user.email } };
  const request = async (method, route, data, expected = 200, actor = setupActor, org = orgId) => {
    const response = await actor.client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': actor.auth.csrfToken }, ...(data === undefined ? {} : { data }) });
    const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`);
    apiChecks.push({ role: actor.auth.user.role, method, route, requestedOrganization: org, status: response.status(), code: body.error?.code || null }); return body;
  };
  const post = async (kind, data, org) => (await request('POST', kind, data, 201, setupActor, org)).item;
  let employeeA, employeeB, caseA, caseB, service, planA, planB, otherOrg, foreignShift, foreignRecord, approved, caseAttachment, certAttachment;
  const ownShifts = [], otherShifts = [], ownRecords = [], otherRecords = [];
  const services = () => [{ serviceItemId: service.id, quantity: 1 }];
  const shiftData = (i, isOwn, selectedMonth = month) => ({ caseId: isOwn ? caseA.id : caseB.id, employeeId: isOwn ? employeeA.id : employeeB.id, carePlanId: isOwn ? planA.id : planB.id, date: `${selectedMonth}-${String(i === 26 && isOwn ? 1 : isOwn ? i + 1 : i).padStart(2, '0')}`, startTime: i === 26 && isOwn ? '11:00' : '09:00', endTime: i === 26 && isOwn ? '12:00' : '10:00', services: services(), note: `${isOwn ? 'MF-OWN' : 'MF-OTHER'}-${String(i).padStart(2, '0')} 合成月份交班` });
  const recordData = (shift, token, status = 'draft') => ({ shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date, actualStart: shift.startTime === '11:00' ? '11:05' : '09:05', actualEnd: shift.startTime === '11:00' ? '11:45' : '09:45', services: services(), status, note: `${token} 合成月份服務紀錄`, reviewNote: '' });
  await written('normal-valid-four-role-fixtures-29-current-and-one-other-month-approved-snapshot-and-two-BLOBs', async () => {
    employeeA = await post('employees', { name: '合成月份本人', employeeNo: 'MF-A', role: 'caregiver', hourlyRateCents: 21000 }); employeeB = await post('employees', { name: '合成月份他人', employeeNo: 'MF-B', role: 'caregiver' });
    for (const [role, employee] of [['supervisor'], ['finance'], ['caregiver', employeeA]]) users[role] = await post('users', { name: '合成月份' + role, email: `month-${role}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    caseA = await post('cases', { name: '合成月份本人個案', caseNo: 'MF-CA', address: '合成測試路一號' }); caseB = await post('cases', { name: '合成月份他人個案', caseNo: 'MF-CB' });
    service = await post('service-items', { code: 'MF-S', name: '合成月份服務', minutes: 60, unitPriceCents: 12345 });
    const plan = caseId => ({ caseId, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, status: 'active', services: services() });
    planA = await post('care-plans', plan(caseA.id)); planB = await post('care-plans', plan(caseB.id));
    for (let i = 0; i < 27; i++) { const shift = await post('shifts', shiftData(i, true)); ownShifts.push(shift); let record = await post('service-records', recordData(shift, `MF-OWN-${String(i).padStart(2, '0')}`, i === 26 ? 'submitted' : 'draft')); if (i === 26) { record = (await request('POST', `service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱快照基準' })).item; ownShifts[i] = (await request('GET', `shifts/${shift.id}`)).item; approved = structuredClone(record); } ownRecords.push(record); }
    for (const i of [27, 28]) { const shift = await post('shifts', shiftData(i, false)); otherShifts.push(shift); otherRecords.push(await post('service-records', recordData(shift, `MF-OTHER-${i}`, i === 28 ? 'submitted' : 'draft'))); }
    const nextShift = await post('shifts', shiftData(0, true, otherMonth)); ownShifts.push(nextShift); ownRecords.push(await post('service-records', recordData(nextShift, 'MF-OWN-OTHER-MONTH')));
    caseAttachment = await post('case-attachments/upload', { caseId: caseA.id, title: '合成月份只讀附件', category: 'other', ...filePayload(PDF_BYTES, '合成月份.pdf', 'application/pdf') });
    const cert = await post('employee-certifications', { employeeId: employeeA.id, name: '合成月份證照', issuedOn: `${year}-01-01` });
    certAttachment = await post('certification-attachments/upload', { certificationId: cert.id, title: '合成月份證照附件', ...filePayload(PNG_BYTES, '合成月份.png', 'image/png') });
    otherOrg = await post('organizations', { name: '合成月份乙機構' });
    const foreignCase = await post('cases', { name: '合成外機構個案', caseNo: 'MF-FOREIGN' }, otherOrg.id), foreignEmployee = await post('employees', { name: '合成外機構員工', employeeNo: 'MF-FOREIGN' }, otherOrg.id), foreignService = await post('service-items', { code: 'MF-FOREIGN', name: '合成外機構服務', minutes: 60, unitPriceCents: 0 }, otherOrg.id);
    const foreignPlan = await post('care-plans', { caseId: foreignCase.id, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, status: 'active', services: [{ serviceItemId: foreignService.id, quantity: 1 }] }, otherOrg.id);
    foreignShift = await post('shifts', { caseId: foreignCase.id, employeeId: foreignEmployee.id, carePlanId: foreignPlan.id, date: `${month}-01`, startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: foreignService.id, quantity: 1 }], note: 'MF-FOREIGN' }, otherOrg.id);
    foreignRecord = await post('service-records', { shiftId: foreignShift.id, caseId: foreignCase.id, employeeId: foreignEmployee.id, date: foreignShift.date, actualStart: '09:05', actualEnd: '09:45', services: foreignShift.services, status: 'draft', note: 'MF-FOREIGN' }, otherOrg.id);
  });
  await written('INSERT-only-eight-unsafe-date-types-and-matching-immutable-snapshots', async () => {
    for (const [label, date] of [['object', { source: `${month}-01`, marker: 'MF-BAD-object' }], ['array', [`${month}-01`]], ['number', Number(month.replace('-', ''))], ['boolean-true', true], ['null', null], ['missing', undefined], ['empty', ''], ['boolean-false', false]]) {
      const data = { ...shiftData(0, true), status: 'cancelled', note: 'MF-BAD-' + label, ...(date === undefined ? {} : { date }), ...(['object', 'array'].includes(label) ? { validFrom: `${month}-01` } : {}) }; if (date === undefined) delete data.date;
      const shift = insert(app.db, orgId, 'shifts', data), recordPayload = { ...recordData(shift, 'MF-BAD-' + label), ...(['object', 'array'].includes(label) ? { validFrom: `${month}-01` } : {}) }; if (date === undefined) delete recordPayload.date;
      const record = insert(app.db, orgId, 'service-records', recordPayload);
      for (const [entity, item] of [['shifts', shift], ['service-records', record]]) { const saved = app.db.prepare('SELECT snapshot FROM record_versions WHERE record_id=? AND version=1').get(item.id); assert.deepEqual(JSON.parse(saved.snapshot), item); importedFixtures.push({ entity, label, id: item.id, ownDate: Object.hasOwn(item, 'date'), date: item.date, validFrom: item.validFrom, matchingVersion: 1, insertOnly: true }); }
    }
  });
  const actors = {};
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(client);
    const auth = await written('normal-real-' + role + '-login-before-read-phase', async () => { const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: users[role].email, password } }); assert.equal(response.status(), 200); return response.json(); });
    const page = await client.newPage(); observe(page); actors[role] = { client, auth, page };
  }
  const rawReadBaseline = rawState(), readPhaseCounts = counts(), triggersBefore = triggerState(), versionsBefore = rawReadBaseline.record_versions;
  const currentOwnShifts = ownShifts.slice(0, 27), currentOwnRecords = ownRecords.slice(0, 27), currentShifts = [...currentOwnShifts, ...otherShifts], currentRecords = [...currentOwnRecords, ...otherRecords];
  const ids = rows => rows.map(item => item.id).sort();
  const checkApiList = async (entity, actor, filters, expectedRows) => { const body = await request('GET', `${entity}?${new URLSearchParams(filters)}`, undefined, 200, actor); assert.equal(body.total, expectedRows.length); assert.deepEqual(ids(body.items), ids(expectedRows)); return body; };
  await readOnly('four-real-roles-month-filter-before-pagination-preserves-unsafe-saved-values', async () => {
    for (const [role, actor] of Object.entries(actors)) for (const entity of ['shifts', 'service-records']) {
      const expected = entity === 'shifts' ? role === 'caregiver' ? currentOwnShifts : currentShifts : role === 'caregiver' ? currentOwnRecords : currentRecords;
      await checkApiList(entity, actor, { month, pageSize: '100' }, expected);
      const first = await request('GET', `${entity}?month=${month}&page=1&pageSize=25`, undefined, 200, actor), second = await request('GET', `${entity}?month=${month}&page=2&pageSize=25`, undefined, 200, actor);
      assert.equal(first.total, expected.length); assert.equal(second.total, expected.length); assert.equal(first.items.length, 25); assert.equal(second.items.length, expected.length - 25); assert.deepEqual(ids([...first.items, ...second.items]), ids(expected));
      await checkApiList(entity, actor, { month, q: 'MF-BAD', pageSize: '100' }, []);
      await checkApiList(entity, actor, { month: otherMonth, pageSize: '100' }, [entity === 'shifts' ? ownShifts.at(-1) : ownRecords.at(-1)]);
    }
    for (const fixture of importedFixtures) { const current = (await request('GET', `${fixture.entity}/${fixture.id}`, undefined, 200, actors.admin)).item; assert.equal(Object.hasOwn(current, 'date'), fixture.ownDate); assert.deepEqual(current.date, fixture.date); const history = await request('GET', `${fixture.entity}/${fixture.id}/history`, undefined, 200, actors.admin); assert.equal(history.items.length, 1); assert.equal(Object.hasOwn(history.items[0].snapshot, 'date'), fixture.ownDate); assert.deepEqual(history.items[0].snapshot.date, fixture.date); }
  }); mark('四真角色月份200、異型不轉字串／不fallback，篩選先於25筆分頁，原date與版本保持');

  const page = actors.admin.page;
  await readOnly('admin-shifts-default-month-q-status-page-route-memory-and-explicit-read-retry', async () => {
    await renderedList(page, 'shifts', listQuery(), () => load(page, '/shifts', '班表'), 29); await screenshot(page, 'month-shifts-desktop.png');
    await renderedList(page, 'shifts', listQuery({ q: 'MF-OWN' }), () => enterSearch(page, 'shifts', 'MF-OWN'), 27);
    await renderedList(page, 'shifts', listQuery({ q: 'MF-OWN', status: 'scheduled' }), () => page.getByLabel('狀態', { exact: true }).selectOption('scheduled'), 26);
    const filtered = listQuery({ q: 'MF-OWN', status: 'scheduled', page: 2 });
    const beforeRetry = await renderedList(page, 'shifts', filtered, () => page.getByRole('button', { name: '下一頁', exact: true }).click(), 26);
    await load(page, '/help', '使用說明');
    let oneExplicitFailure = false;
    const pattern = '**/api/shifts?*';
    await page.route(pattern, route => { const requestUrl = new URL(route.request().url()); const exact = Object.entries(filtered).every(([key, value]) => (requestUrl.searchParams.get(key) || '') === String(value)); if (exact && !oneExplicitFailure) { oneExplicitFailure = true; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ_ONLY', message: '合成一次讀取失敗，保留查詢條件' } }) }); } return route.continue(); });
    await load(page, '/shifts', '班表'); await resultSection(page, 'shifts').getByText('合成一次讀取失敗，保留查詢條件', { exact: true }).waitFor(); assert(oneExplicitFailure);
    assert.equal(await search(page, 'shifts').inputValue(), 'MF-OWN'); assert.equal(await page.getByLabel('狀態', { exact: true }).inputValue(), 'scheduled'); assert.equal(await page.getByLabel('服務月份', { exact: true }).inputValue(), month);
    const afterRetry = await renderedList(page, 'shifts', filtered, () => resultSection(page, 'shifts').getByRole('button', { name: '重新讀取', exact: true }).click(), 26); assert.deepEqual(ids(afterRetry.items), ids(beforeRetry.items)); await page.unroute(pattern); await screenshot(page, 'month-shifts-filtered-page-two-retry.png');
    await renderedList(page, 'shifts', listQuery(), () => page.reload(), 29); assert.equal(await search(page, 'shifts').inputValue(), '', 'Full browser reload intentionally resets the existing in-memory filters');
    await renderedList(page, 'shifts', listQuery({ month: otherMonth }), () => changeMonth(page, otherMonth), 1, [ownShifts.at(-1).id]); await screenshot(page, 'month-shifts-other-month.png');
    await renderedList(page, 'shifts', listQuery(), () => changeMonth(page, month), 29);
  }); mark('班表本月200及切月、q／狀態／頁次、route記憶與503明確重新讀取保持；full reload沿原重置');

  await readOnly('admin-records-default-month-enrichment-search-status-page-and-route-memory', async () => {
    await renderedList(page, 'service-records', listQuery(), () => load(page, '/records', '服務紀錄與核閱'), 29); await screenshot(page, 'month-records-desktop.png');
    await renderedList(page, 'service-records', listQuery({ q: 'MF-OWN' }), () => enterSearch(page, 'service-records', 'MF-OWN'), 27);
    await renderedList(page, 'service-records', listQuery({ q: 'MF-OWN', status: 'draft' }), () => page.getByLabel('狀態', { exact: true }).selectOption('draft'), 26);
    const query = listQuery({ q: 'MF-OWN', status: 'draft', page: 2 }), second = await renderedList(page, 'service-records', query, () => page.getByRole('button', { name: '下一頁', exact: true }).click(), 26);
    await load(page, '/help', '使用說明'); const reopened = await renderedList(page, 'service-records', query, () => load(page, '/records', '服務紀錄與核閱'), 26); assert.deepEqual(ids(reopened.items), ids(second.items)); await screenshot(page, 'month-records-filtered-page-two.png');
    await renderedList(page, 'service-records', listQuery({ q: 'MF-OWN', status: 'draft' }), () => page.getByRole('button', { name: '上一頁', exact: true }).click(), 26);
    await renderedList(page, 'service-records', listQuery({ status: 'draft' }), () => enterSearch(page, 'service-records', ''), 27);
    await renderedList(page, 'service-records', listQuery(), () => page.getByLabel('狀態', { exact: true }).selectOption(''), 29);
  }); mark('管理服務紀錄月清單200、q／狀態／25筆分頁與route重讀保持，未自動清理原資料');

  await readOnly('supervisor-canonical-month-shifts-records-and-unchanged-navigation', async () => {
    const p = actors.supervisor.page;
    await renderedList(p, 'shifts', listQuery(), () => load(p, '/shifts', '班表'), 29);
    assert.equal(await p.getByRole('button', { name: '新增排班', exact: true }).count(), 1);
    await renderedList(p, 'service-records', listQuery(), () => load(p, '/records', '服務紀錄與核閱'), 29);
    assert.equal(await p.getByRole('link', { name: '服務核閱', exact: true }).count(), 1); await screenshot(p, 'month-supervisor-records.png');
  }); mark('督導兩原月份頁正常200且原導覽／管理入口保持，沒有新寫入');

  await readOnly('finance-readonly-api-and-four-role-cross-organization-own-employee-guards', async () => {
    const finance = actors.finance; await load(finance.page, '/cases', '個案'); await finance.page.waitForLoadState('networkidle');
    for (const name of ['排班調度', '服務核閱', '我的服務']) assert.equal(await finance.page.getByRole('link', { name, exact: true }).count(), 0);
    await request('POST', 'shifts', shiftData(0, true), 403, finance);
    await request('PATCH', `service-records/${ownRecords[0].id}`, { version: ownRecords[0].version, note: '合成禁止財務改寫' }, 403, finance);
    await request('POST', 'shifts', shiftData(0, true), 403, actors.caregiver);
    for (const actor of Object.values(actors)) for (const [entity, item] of [['shifts', foreignShift], ['service-records', foreignRecord]]) { await request('GET', `${entity}/${item.id}`, undefined, 404, actor); const monthItems = await request('GET', `${entity}?month=${month}&q=MF-FOREIGN&pageSize=100`, undefined, 200, actor); assert.equal(monthItems.total, 0); assert.deepEqual(monthItems.items, []); }
    for (const actor of [actors.supervisor, finance, actors.caregiver]) await request('GET', `shifts?month=${month}`, undefined, 403, actor, otherOrg.id);
    for (const entity of ['shifts', 'service-records']) await checkApiList(entity, actors.caregiver, { month, employeeId: employeeB.id, pageSize: '100' }, []);
    await screenshot(finance.page, 'month-finance-existing-navigation.png');
  }); mark('財務月API唯讀與原無新導覽、四角色current-org foreign404／非member403、居服employee query不擴權');

  const ownPage = actors.caregiver.page;
  await readOnly('caregiver-month-my-services-and-month-matched-record-enrichment-own-only', async () => {
    await load(ownPage, '/my-services', '我的服務'); await ownPage.waitForLoadState('networkidle'); assert.equal(await ownPage.getByLabel('日期範圍', { exact: true }).inputValue(), 'day');
    await renderedList(ownPage, 'own', listQuery({ employeeId: employeeA.id }), () => ownPage.getByLabel('日期範圍', { exact: true }).selectOption('month'), 27);
    assert.equal(await ownPage.getByRole('link', { name: '服務核閱', exact: true }).count(), 0); assert.equal(await ownPage.getByRole('link', { name: '排班調度', exact: true }).count(), 0);
    assert(!(await resultSection(ownPage, 'own').textContent()).includes('合成月份他人個案')); assert(!(await resultSection(ownPage, 'own').textContent()).includes('合成外機構'));
    const second = await renderedList(ownPage, 'own', listQuery({ employeeId: employeeA.id, page: 2 }), () => ownPage.getByRole('button', { name: '下一頁', exact: true }).click(), 27); assert(second.items.every(item => item.employeeId === employeeA.id)); await screenshot(ownPage, 'month-caregiver-own-page-two.png');
    await renderedList(ownPage, 'own', listQuery({ employeeId: employeeA.id, month: otherMonth }), () => changeMonth(ownPage, otherMonth), 1, [ownShifts.at(-1).id]);
    await renderedList(ownPage, 'own', listQuery({ employeeId: employeeA.id }), () => changeMonth(ownPage, month), 27);
    const ownRecordResult = await checkApiList('service-records', actors.caregiver, { month, pageSize: '100' }, currentOwnRecords); assert(ownRecordResult.items.every(item => item.employeeId === employeeA.id)); assert(!Object.hasOwn(ownRecordResult.items.find(item => item.id === approved.id), 'billingSnapshot'));
  }); mark('居服本人整月班次／my-services及recordsForShifts200、他人與跨機構不漏、核閱快照原遮罩保持');

  await readOnly('390px-canonical-month-controls-focus-inner-table-scroll-and-own-cards', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await renderedList(page, 'shifts', listQuery(), () => load(page, '/shifts', '班表'), 29);
    const monthControl = page.getByLabel('服務月份', { exact: true }); await monthControl.focus(); assert(await monthControl.evaluate(node => node === document.activeElement)); await monthControl.evaluate(node => node.scrollIntoView({ block: 'center' })); await screenshot(page, 'month-mobile-shifts-filter-focus.png');
    await renderedList(page, 'service-records', listQuery(), () => load(page, '/records', '服務紀錄與核閱'), 29);
    const region = resultSection(page, 'service-records').locator('.table-scroll'); await region.focus(); assert(await region.evaluate(node => node === document.activeElement)); await region.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert(await region.evaluate(node => node.scrollLeft > 0)); await region.evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(page, 'month-mobile-records-inner-scroll.png');
    await ownPage.setViewportSize({ width: 390, height: 844 }); const ownSearch = search(ownPage, 'own'); await ownSearch.focus(); assert(await ownSearch.evaluate(node => node === document.activeElement)); await ownSearch.evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(ownPage, 'month-mobile-caregiver-own-cards.png');
    await page.setViewportSize({ width: 1440, height: 1050 }); await ownPage.setViewportSize({ width: 1440, height: 1050 });
  }); mark('390px月份查詢control與卡片無頁面overflow、真focus及服務表格自身橫捲；原生popup不宣稱');

  await readOnly('final-all-eleven-raw-tables-six-triggers-billing-version-history-and-two-nonempty-BLOBs', async () => {
    assert.deepEqual(rawState(), rawReadBaseline); assert.deepEqual(rawState().record_versions, versionsBefore); assert.deepEqual(triggerState(), triggersBefore); assert.deepEqual(counts(), readPhaseCounts);
    assert.deepEqual((await request('GET', `service-records/${approved.id}`, undefined, 200, actors.admin)).item, approved);
    assert.deepEqual((await request('GET', `service-records/${approved.id}`, undefined, 200, actors.finance)).item.billingSnapshot, approved.billingSnapshot);
    const masked = (await request('GET', `service-records/${approved.id}`, undefined, 200, actors.supervisor)).item; assert(!Object.hasOwn(masked, 'billingSnapshot'));
    for (const [entity, item, bytes] of [['case-attachments', caseAttachment, PDF_BYTES], ['certification-attachments', certAttachment, PNG_BYTES]]) for (const exact of [false, true]) { const response = await actors.admin.client.request.get(`${base}/api/${entity}/${item.id}/download${exact ? '?recordVersion=' + item.version : ''}`, { headers: { 'X-Org-Id': orgId } }); assert.equal(response.status(), 200); const actual = await response.body(); assert.deepEqual(actual, bytes); assert.equal(digest(actual), item.sha256); blobDownloads.push({ entity, recordVersion: exact ? item.version : null, bytes: actual.length, sha256: digest(actual), matchesOriginal: true }); }
    assert(rawReadBaseline.attachment_files.length > 0 && rawReadBaseline.certification_attachment_files.length > 0);
  });
  const accountedChanges = writeSegments.reduce((total, segment) => total + segment.after.changes - segment.before.changes, 0);
  assert.equal(counts().changes - initialCounts.changes, accountedChanges); assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(response => !response.expected), []); assert.equal(failedResponses.filter(response => response.status === 503).length, 1); assert(consoleErrors.every(message => /503|ERR_ABORTED|ERR_FAILED/.test(message)), JSON.stringify(consoleErrors));
  assert.equal(readSegments.length, 8); assert.equal(screenshots.length, 11); assert.equal(importedFixtures.length, 16); assert.equal(blobDownloads.length, 4);
  const sourceHashesAfter = await collectSources(); assert.deepEqual(sourceHashesAfter, sourceHashesBefore);
  mark('八段十一表零寫、六trigger／所有版本／原billingSnapshot與四BLOB下載保持，前置寫精確對帳');
  const fixtureNotes = [
    'Synthetic memory SQLite, random 127.0.0.1 port and real Chromium only; never actual4310/original platform/real people or deployment. Every setup, normal validated API creation, approval, INSERT-only import and four role login occurs before the read-only phase.',
    '29 normal current-month shifts and service records: 27 own employee including one legitimately approved record and completed shift, plus two other employee rows. One further own shift and record belongs to the following month. 27 own rows use dates01..26 and a second nonoverlapping day01 slot, so all calendar months support the fixture.',
    'Eight date shapes per shifts and service-records are explicit INSERT-only synthetic imports with matching append-only snapshots. Object and array dates include a validFrom in the current month to prove a truthy nonstring date does not fall back. Null/missing/empty/false have no validFrom, so they do not match the month. These imports do not establish normal API acceptance or automatic data repair.',
    'Canonical shared filters are kept on route return and the single intercepted503 explicit reread; a full browser reload intentionally clears the existing in-memory list state and resets month/q/status/page. Search Enter uses the original trim behavior. The503 is an explicit UI-only fixture and does not establish a server failure.',
    'Finance retains its original readable monthly list APIs and absent shift/record/my-services navigation. Caregiver uses the existing day default then explicitly switches my-services to month; own service-record APIs and recordsForShifts enrichment remain scoped. No new page, edit control or permission is added.',
    'The generic monthly guard excludes truthy nonstring selected values without String coercion, valid-date validation or fallback repair. Existing reports.mjs, date validation, billing/payroll/qualification and imports are outside this browser change. Strict reporting rejection of malformed dates is not presented as repaired.',
    'All11 raw tables, six trigger definitions, record_versions, approved billingSnapshot and both nonempty BLOB tables remain identical across every read segment and the complete read phase. Necessary fixture/login changes are separately accounted. No immutable/BLOB UPDATE or DELETE is issued.',
    'Native DOM controls, actual focus, ordinary filters, horizontal table scrolling and viewport overflow are verified. OS-owned popup geometry/native keyboard selection, human UAT, formal claims/payments/messages/integrations and production deployment are unverified. Every new screenshot requires a separate individual visual review; raw execution visualReviewPending remains true.'
  ];
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, scope: 'Synthetic memory SQLite/random localhost/real Chromium only; no actual4310/data/original platform.', checks, screenshots, month, otherMonth, readSegments, writeSegments, initialCounts, readPhaseCounts, finalCounts: counts(), accountedChanges, apiChecks, uiQueries, importedFixtures, fixtureNotes, blobDownloads, pageErrors, consoleErrors, failedResponses, all11TablesUnchangedDuringReads: true, entireReadPhaseRawTablesUnchanged: true, rawReadPhaseBeforeSha256: digest(JSON.stringify(rawReadBaseline)), rawReadPhaseAfterSha256: digest(JSON.stringify(rawState())), immutableTriggers: 6, allRecordVersionsUnchanged: true, approvedBillingSnapshotUnchanged: true, blobTablesNonempty: { attachment_files: rawReadBaseline.attachment_files.length, certification_attachment_files: rawReadBaseline.certification_attachment_files.length }, pdfOperations: 0, pdfMarkers: 0, sourceCount: Object.keys(sourceHashesBefore).length, sourceHashesBefore, sourceHashesAfter, visualReviewPending: true }, null, 2));
  console.log(`Month filter safety E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const sourceHashesAfter = await collectSources().catch(() => null);
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, checks, screenshots, month, otherMonth, pageErrors, consoleErrors, failedResponses, readSegments, writeSegments, apiChecks, uiQueries, importedFixtures, sourceCount: Object.keys(sourceHashesBefore).length, sourceHashesBefore, sourceHashesAfter, error: error.stack, pdfOperations: 0, pdfMarkers: 0 }, null, 2));
  throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
