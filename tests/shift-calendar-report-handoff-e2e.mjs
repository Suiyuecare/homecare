import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { createShiftCalendarPersonFiltersFixture } from './shift-calendar-person-filters-fixtures.mjs';
import { installReportPrintCapture } from './helpers/report-print.mjs';

// One explicitly started run, an owned synthetic workspace, and a random
// loopback port. No root/default database or sealed earlier QA tree is touched.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/shift-calendar-report-handoff-qa');
assert(!existsSync(path.join(output, 'e2e.json')), 'Preserve a prior attempt before explicitly starting another run');
const exportPath = '/api/shift-report/export', csvPath = '/api/shift-report.csv';
const previewTitle = '班表明細列印預覽', entryName = '完整報表／下載';
const routePattern = '**/api/shift-report**';
const columns = ['date', 'caseNo', 'case', 'employeeNo', 'employee', 'startTime', 'endTime', 'services', 'statusLabel', 'version', 'note'];
const spanColumns = columns.flatMap(key => key === 'date' ? [key, 'endDate'] : [key]);
const fixedModes = Object.freeze({ spanMode: 'calendar-two-day-v1', rangeMode: 'intersects' });
const spanFilters = value => ({ ...value, ...fixedModes });
const primitiveFilters = value => Object.fromEntries(['startDate', 'endDate', 'caseId', 'employeeId', 'status'].map(key => [key, value[key]]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, message) => assert(isDeepStrictEqual(actual, expected), message);
const pathname = request => new URL(request.url()).pathname;
const exported = request => request.method() === 'GET' && pathname(request) === exportPath;
const csvRequest = request => request.method() === 'GET' && pathname(request) === csvPath;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function bounded(promise, label, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its explicit bound')), ms); })]); }
  finally { clearTimeout(timer); }
}
const filters = (startDate, endDate, person = {}, status = '') => ({ startDate, endDate, caseId: person.caseId || '', employeeId: person.employeeId || '', status });
const legacyQuery = value => new URLSearchParams(Object.entries(value).filter(([, text]) => text !== '')).toString();
const query = value => new URLSearchParams(Object.entries(spanFilters(value)).filter(([, text]) => text !== '')).toString();
const matches = (request, value, target = exportPath) => request.method() === 'GET' && pathname(request) === target && new URL(request.url()).search === '?' + query(value);
const calendar = page => page.getByRole('dialog', { name: '週／月班表', exact: true });
const content = page => calendar(page).locator('.shift-calendar');
const field = (page, name) => content(page).locator(`form [name="${name}"]`);
const entry = page => content(page).getByRole('button', { name: entryName, exact: true });
const preview = page => page.getByRole('dialog', { name: previewTitle, exact: true });
const printable = page => preview(page).locator('.shift-report-print');
const printButton = page => preview(page).getByRole('button', { name: '列印／另存 PDF', exact: true });
const csvButton = page => printable(page).getByRole('button', { name: '下載 CSV', exact: true });
const retry = page => preview(page).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const checks = [], screenshots = [], reports = [], cancellations = [], contextsProof = [], malformed = [], reads = [], writes = [], ledger = [], downloads = [], pageErrors = [], consoleErrors = [], expectedConsole = [], negativeResponses = [], contexts = [];
let fixture, browser, actors, base, sourcesBefore, lastPage, stage = 'initialization', timedOut = false;
const started = Date.now(), watchdog = setTimeout(() => { timedOut = true; browser?.close().catch(() => {}); }, 900000);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const readOnly = async (label, work) => { stage = label; const before = fixture.captureRead(), result = await work(), after = fixture.assertReadUnchanged(before, label); reads.push({ label, before, after, allTypedStateUnchanged: true, totalChangesDelta: 0 }); return result; };
const written = async (label, work) => { stage = label; const before = fixture.counts(), result = await work(), after = fixture.counts(); writes.push({ label, before, after, changes: after.totalChanges - before.totalChanges }); return result; };
async function sourceMap() {
  const files = ['tests/shift-calendar-report-handoff-e2e.mjs', 'tests/shift-calendar-person-filters-fixtures.mjs', 'tests/shift-calendar-fixtures.mjs', 'tests/announcement-read-receipts-fixtures.mjs', 'tests/synthetic-backup-fixtures.mjs', 'tests/helpers/report-print.mjs', 'docs/SHIFT_CALENDAR_REPORT_HANDOFF_SCOPE.md'];
  const walk = async directory => { for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) await walk(file); else files.push(file); } };
  await walk('public'); await walk('src');
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
}
function observe(page, role) {
  page.on('pageerror', error => pageErrors.push({ role, messageSha256: sha(error.message) }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ role, url: message.location().url, messageSha256: sha(message.text()) }); });
  page.on('request', request => { if (exported(request) || csvRequest(request)) ledger.push({ role, path: pathname(request), query: new URL(request.url()).search, orgHeaderPresent: Boolean(request.headers()['x-org-id']) }); });
  page.on('download', download => downloads.push({ role, suggestedFilename: download.suggestedFilename() }));
  page.on('response', response => { if (response.status() >= 400) negativeResponses.push({ role, url: response.url(), status: response.status() }); });
}
const expectConsole = (url, status) => expectedConsole.push({ url, status, messageSha256: sha(`Failed to load resource: the server responded with a status of ${status} (${STATUS_CODES[status]})`) });
async function layout(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Document does not overflow horizontally');
  assert.equal(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).length), 0, 'Every visible field has a label');
  for (const surface of await page.locator('dialog[open]').all()) assert(await surface.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Nested dialogs fit the viewport');
  for (const table of await page.locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto', 'A wide table owns horizontal scrolling');
}
async function shot(page, name) { await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push({ name, sha256: sha(await readFile(path.join(output, name))) }); }
async function openCalendar(page, role = 'admin') {
  lastPage = page; const own = role.startsWith('caregiver'), target = `${base}/#${own ? '/my-services' : '/shifts'}`;
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { level: 1, name: own ? '我的服務' : '班表', exact: true }).waitFor();
  await page.locator(`main section[aria-label="${own ? '我的服務' : '班表'}結果"][aria-busy="false"]`).waitFor();
  const trigger = page.getByRole('button', { name: '週／月班表', exact: true }); await trigger.click();
  await content(page).locator('.shift-calendar-agenda').waitFor(); return trigger;
}
async function enable(page) { await content(page).getByRole('button', { name: '啟用個案／人員篩選', exact: true }).click(); await content(page).locator('form [name="caseId"]').waitFor(); await content(page).locator('.shift-calendar-agenda').waitFor(); }
async function submit(page, value, { mode = 'week', anchor = value.startDate, status = 200 } = {}) {
  await field(page, 'mode').selectOption(mode); await field(page, 'anchor').fill(anchor); await field(page, 'status').selectOption(value.status);
  if (await field(page, 'caseId').count()) {
    await field(page, 'caseId').selectOption(value.caseId);
    if (await field(page, 'employeeId').isEnabled()) await field(page, 'employeeId').selectOption(value.employeeId);
    else assert.equal(await field(page, 'employeeId').inputValue(), value.employeeId);
  }
  const response = page.waitForResponse(valueResponse => matches(valueResponse.request(), value)); response.catch(() => {});
  await content(page).getByRole('button', { name: '查詢班表', exact: true }).click(); const reply = await response; assert.equal(reply.status(), status);
  await content(page).locator(status === 200 ? '.shift-calendar-agenda' : '.error-state').waitFor(); return reply.json();
}
async function closePreview(page, trigger = entry(page), method = 'escape') {
  if (method === 'button') await preview(page).locator(':scope > .dialog-footer').getByRole('button', { name: '關閉', exact: true }).click(); else await page.keyboard.press('Escape');
  await preview(page).waitFor({ state: 'detached' });
  if (await trigger.count() && await trigger.evaluate(node => node.isConnected)) assert(await trigger.evaluate(node => node === document.activeElement), 'Inner close restores the actual calendar action focus');
  assert(await calendar(page).isVisible(), 'Closing the report preserves the outer calendar');
}
async function openPreview(page, value, { keyboard = false, ready = true } = {}) {
  const before = ledger.length, trigger = entry(page), response = page.waitForResponse(reply => matches(reply.request(), value)); response.catch(() => {});
  if (keyboard) { await trigger.focus(); await trigger.press('Enter'); } else await trigger.click();
  const reply = await response;
  if (ready) { assert.equal(reply.status(), 200); await printable(page).waitFor(); }
  const relevant = ledger.slice(before); same(relevant.map(item => item.path), [exportPath], 'Handoff performs one fresh complete GET and no .csv');
  return { trigger, reply, body: await reply.json() };
}
async function assertReport(page, value, role = 'admin', returned) {
  const real = await fixture.request(fixture.clients[role], 'GET', exportPath + '?' + query(value)); assert.equal(real.status, 200);
  const result = real.body; same(primitiveFilters(result.filters), value, 'Five primitive filters remain exact'); same(result.filters, spanFilters(value), 'Only the two fixed explicit modes are added');
  const legacy = await fixture.request(fixture.clients[role], 'GET', exportPath + '?' + legacyQuery(value)); assert.equal(legacy.status, 200); same(legacy.body.filters, value); same(legacy.body.columns.map(column => column.key), columns);
  same(result.rows.map(({ endDate, ...row }) => row), legacy.body.rows, 'All original projection values and ordering still equal the untouched legacy API');
  same(result.rows.map(row => row.shiftId).sort(), fixture.expectedShiftIds(value, role), 'Independent persisted shiftId→caseId/employeeId oracle proves the server scope');
  if (returned) same(returned.rows, result.rows, 'Handoff rows equal fresh server rows');
  assert.equal(result.rows.length, result.total); assert.equal(result.pageSize, result.total);
  same(result.columns.map(column => column.key), spanColumns);
  const visible = await printable(page).locator('tbody tr').evaluateAll(nodes => nodes.map(node => [...node.children].map(cell => cell.textContent)));
  same(visible.map(cells => cells.filter((_, index) => index !== 1)), result.rows.map(row => columns.map(key => key === 'date' ? row.date.replaceAll('-', '/') : row[key] === '' ? '—' : String(row[key]))), 'All eleven shared report columns preserve exact values and complete ordered rows');
  same(visible, result.rows.map(row => spanColumns.map(key => ['date', 'endDate'].includes(key) ? row[key].replaceAll('-', '/') : row[key] === '' ? '—' : String(row[key]))), 'The additive ending date is also displayed exactly');
  same(await printable(page).locator('thead th').evaluateAll(nodes => nodes.map(node => ({ label: node.textContent, scope: node.scope }))), result.columns.map(column => ({ label: column.label, scope: 'col' })));
  for (const [label, text] of [['機構', result.organization.name], ['個案', result.selection.case], ['服務人員', result.selection.employee], ['班次狀態', result.selection.status]]) {
    assert.equal(await printable(page).locator('.detail-grid > div').filter({ has: page.locator('dt', { hasText: new RegExp('^' + label + '$') }) }).locator('dd').textContent(), text);
  }
  assert.equal(await printable(page).locator('script,img').count(), 0, 'Literal names and notes never become markup');
  assert(await printButton(page).isEnabled()); assert(await csvButton(page).isEnabled());
  reports.push({ role, filters: value, count: result.total, rowSha256: sha(JSON.stringify(result.rows)), independentSavedIdOracle: true, originalVisibleColumns: 11, visibleColumns: 12 }); return result;
}
async function slow(page, predicate) {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false, request;
  const handler = async route => {
    if (used || !predicate(route.request())) return route.continue(); used = true; request = route.request();
    try { const response = await route.fetch({ timeout: 15000 }); arrived.resolve(); await release.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { handled.resolve(); }
  };
  await page.route(routePattern, handler);
  return { arrived: arrived.promise, get request() { return request; }, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'Release held response'); await page.unroute(routePattern, handler); } };
}
const failurePromise = (page, held) => { const result = page.waitForEvent('requestfailed', { predicate: request => request === held.request, timeout: 10000 }); result.catch(() => {}); return result; };
async function assertAborted(failed) { const request = await failed; assert(/abort|cancel|failed/i.test(request.failure()?.errorText || ''), 'Product cancellation causes a real browser request failure before releasing the held response'); }
async function mutateContext(page, kind) {
  return page.evaluate(async ({ kind, foreign }) => {
    const ui = await import('/ui.js'), context = ui.getContext(), source = document.querySelector('[data-render-version]');
    const inner = [...document.querySelectorAll('dialog[open]')].find(node => document.getElementById(node.getAttribute('aria-labelledby'))?.textContent === '班表明細列印預覽');
    if (!inner || !source) throw new Error('Context test requires owned connected source and inner preview');
    const values = value => [value.user?.id ?? null, value.organizationId ?? null, value.role ?? null, value.user?.employeeId ?? null];
    const before = values(context), hash = location.hash, stamp = source.dataset.renderVersion;
    const wake = () => { const node = document.createComment('synthetic-handoff-observer-wakeup'); document.body.append(node); node.remove(); };
    wake(); await new Promise(resolve => requestAnimationFrame(resolve));
    const wakeupControlPassed = inner.open && inner.isConnected && ui.getContext() === context && JSON.stringify(values(context)) === JSON.stringify(before) && location.hash === hash && source.dataset.renderVersion === stamp && source.isConnected;
    if (!wakeupControlPassed) throw new Error('Wakeup without identity change must preserve the preview');
    if (kind === 'user') context.user.id = 'synthetic-new-user'; else if (kind === 'logout') context.user = null;
    else if (kind === 'org') { context.organizationId = foreign; context.orgId = foreign; } else if (kind === 'role') context.role = 'finance';
    else if (kind === 'employee') context.user.employeeId = 'synthetic-new-employee';
    else if (kind === 'context-ref') ui.setContext({ ...context, user: { ...context.user }, organizations: context.organizations.map(org => ({ ...org })) }, context.organizationId);
    else if (kind === 'hash') location.hash = '/employees'; else if (kind === 'render') source.dataset.renderVersion = crypto.randomUUID();
    else if (kind === 'disconnect') source.remove(); else throw new Error('Unknown context mutation');
    const afterContext = ui.getContext(), after = values(afterContext), keys = ['userId', 'organizationId', 'role', 'employeeId'];
    const changedIdentityFields = keys.filter((key, index) => before[index] !== after[index]);
    const changedDimensions = [afterContext !== context && 'reference', changedIdentityFields.length > 0 && 'identity', location.hash !== hash && 'hash', source.dataset.renderVersion !== stamp && 'stamp', !source.isConnected && 'connected'].filter(Boolean);
    wake(); return { wakeupControlPassed, refStayedSame: afterContext === context, changedIdentityFields, changedDimensions, clientFixtureOnly: true, noSessionEvent: true };
  }, { kind, foreign: fixture.orgIds.foreign });
}

await mkdir(output, { recursive: true });
try {
  sourcesBefore = await sourceMap(); fixture = await createShiftCalendarPersonFiltersFixture(); base = fixture.base;
  assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  const rawBefore = fixture.rawState(), pd = fixture.personDataset;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright'), installed = await readdir(cache).catch(() => []);
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); actors = {};
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce', acceptDownloads: true }); contexts.push(context);
    context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000); await installReportPrintCapture(context);
    const cookie = fixture.clients[role].cookie, equal = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, equal), value: cookie.slice(equal + 1), url: base }]);
    const page = await context.newPage(); observe(page, role); actors[role] = { page, context };
  }
  const admin = actors.admin.page, A = { caseId: pd.caseA.id, employeeId: pd.employeeA.id }, B = { caseId: pd.caseB.id, employeeId: pd.employeeB.id };
  const week = filters('2026-10-05', '2026-10-11'), month = filters('2026-10-01', '2026-10-31');
  const specific = filters(week.startDate, week.endDate, A, 'cancelled');

  await readOnly('G1 default three-field handoff and existing roles', async () => {
    for (const role of ['admin', 'supervisor', 'caregiver']) {
      const page = actors[role].page, trigger = await openCalendar(page, role), value = week;
      same(await content(page).locator('form [name]').evaluateAll(nodes => nodes.map(node => node.name)), ['mode', 'anchor', 'status']);
      await submit(page, value); const opened = await openPreview(page, value); await assertReport(page, value, role, opened.body);
      assert.equal(await preview(page).locator('input,select').count(), 0, 'Handoff cannot widen the captured primitive filters');
      assert.equal(new URL(page.url()).hash, role === 'caregiver' ? '#/my-services' : '#/shifts');
      await closePreview(page, opened.trigger); await page.keyboard.press('Escape'); await calendar(page).waitFor({ state: 'detached' }); assert(await trigger.evaluate(node => node === document.activeElement));
    }
    const finance = actors.finance.page; await finance.goto(base + '/#/'); await finance.getByRole('heading', { level: 1 }).waitFor(); assert.equal(await finance.getByRole('button', { name: '週／月班表', exact: true }).count(), 0); assert.equal(await finance.getByRole('button', { name: entryName, exact: true }).count(), 0);
    const existingFinanceReport = await fixture.request(fixture.clients.finance, 'GET', exportPath + '?' + query(week)); assert.equal(existingFinanceReport.status, 200, 'Existing finance report API access is preserved; the calendar handoff UI remains unavailable');
  }); mark('G1 原三欄 admin/supervisor/caregiver 完整報表本人 scope；finance 無日曆入口並保留既有 API');

  await readOnly('G2 opt-in exact IDs and memory-only handoff', async () => {
    await openCalendar(admin); await enable(admin);
    assert.equal(pd.caseA.name, pd.caseB.name); assert.equal(pd.employeeA.name, pd.employeeB.name);
    for (const person of [A, B, { caseId: A.caseId, employeeId: B.employeeId }]) {
      const value = filters(week.startDate, week.endDate, person, 'cancelled'); await submit(admin, value); const opened = await openPreview(admin, value); await assertReport(admin, value, 'admin', opened.body);
      const browserState = await admin.evaluate(() => ({ href: location.href, storage: [...Object.entries(localStorage), ...Object.entries(sessionStorage)] }));
      assert(!JSON.stringify(browserState).includes(person.caseId)); assert(!JSON.stringify(browserState).includes(person.employeeId));
      await closePreview(admin, opened.trigger); assert.equal(await field(admin, 'caseId').inputValue(), person.caseId); assert.equal(await field(admin, 'employeeId').inputValue(), person.employeeId);
    }
    const own = actors.caregiver.page; await openCalendar(own, 'caregiver'); await enable(own); const value = { ...week, employeeId: fixture.dataset.employees.own.id }; await submit(own, value); await openPreview(own, value); await assertReport(own, value, 'caregiver'); assert(await field(own, 'employeeId').isDisabled()); await closePreview(own); await own.keyboard.press('Escape');
    await submit(admin, specific); await shot(admin, 'desktop-confirmed-five-filter-handoff.png');
  }); mark('G2 同名不同 ID／交集與本人固定 ID／無 route 或 storage 傳遞／關閉保留條件');

  await readOnly('G3 week month and full Gregorian boundaries retain strings', async () => {
    for (const [mode, anchor, value] of [['week', '2026-10-08', week], ['month', '2026-10-08', month], ['week', '0000-01-01', filters('0000-01-01', '0000-01-02')], ['month', '0000-02-29', filters('0000-02-01', '0000-02-29')], ['week', '9999-12-31', filters('9999-12-27', '9999-12-31')]]) {
      await submit(admin, value, { mode, anchor }); const opened = await openPreview(admin, value); await assertReport(admin, value, 'admin', opened.body);
      assert.equal(await printable(admin).locator('.detail-grid > div').filter({ has: admin.locator('dt', { hasText: /^日期範圍$/ }) }).locator('dd').textContent(), value.startDate.replaceAll('-', '/') + ' 至 ' + value.endDate.replaceAll('-', '/'));
      await closePreview(admin, opened.trigger);
    }
    await submit(admin, specific); 
  }); mark('G3 週/月導出日期與 0000/閏日/9999 邊界原字串完整銜接');

  await readOnly('G4 draft empty and calendar error retract output entry', async () => {
    const before = ledger.length; await field(admin, 'caseId').selectOption(B.caseId); assert.equal(await entry(admin).count(), 0); assert.equal(ledger.length, before);
    await submit(admin, filters('2027-03-15', '2027-03-21'), { anchor: '2027-03-18' }); assert.equal(await entry(admin).count(), 0);
    await submit(admin, specific); let used = false;
    const handler = async route => { if (used || !exported(route.request())) return route.continue(); used = true; expectConsole(route.request().url(), 503); await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成班表暫時無法讀取。' } }) }); };
    await admin.route(routePattern, handler);
    try { await content(admin).locator('.actions').getByRole('button', { name: '重新讀取', exact: true }).click(); await content(admin).locator('.error-state').waitFor(); assert.equal(await entry(admin).count(), 0); await content(admin).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true }).click(); await entry(admin).waitFor(); }
    finally { await admin.unroute(routePattern, handler); }
  }); mark('G4 草稿零 GET 並撤入口／empty/error 不輸出／重新確認才恢复');

  let renamedCase, renamedEmployee;
  await written('G5 normal API same-ID renames after calendar confirmation', async () => { renamedCase = await fixture.patch('cases', pd.caseA, { name: '合成 fresh 同 ID 個案🙂' }); renamedEmployee = await fixture.patch('employees', pd.employeeA, { name: '合成 fresh 同 ID 人員🙂' }); });
  await readOnly('G5 preview names are current and allow same-ID rename', async () => { const opened = await openPreview(admin, specific); const result = await assertReport(admin, specific, 'admin', opened.body); assert.equal(result.selection.case, renamedCase.name); assert.equal(result.selection.employee, renamedEmployee.name); await shot(admin, 'desktop-fresh-same-id-renamed-preview.png'); await closePreview(admin); await submit(admin, month, { mode: 'month', anchor: '2026-10-08' }); await openPreview(admin, month); });
  let freshShift;
  await written('G5 normal API version change after report preview', async () => { freshShift = await fixture.patch('shifts', fixture.dataset.mutableShift, { note: 'CAL-MUTABLE fresh-print v2 中文原文🙂' }, fixture.clients.supervisor); assert.equal(freshShift.version, fixture.dataset.mutableShift.version + 1); });
  await readOnly('G5 program print always re-reads current versions', async () => { const before = await admin.evaluate(() => window.__printCalls.length), response = admin.waitForResponse(reply => matches(reply.request(), month)); await printButton(admin).click(); assert.equal((await response).status(), 200); await admin.waitForFunction(count => window.__printCalls.length === count + 1, before); const capture = await admin.evaluate(() => window.__printCalls.at(-1)); assert(capture.text.includes(freshShift.note)); await assertReport(admin, month); await shot(admin, 'desktop-fresh-version-authorized-print.png'); await closePreview(admin); await submit(admin, specific); }); mark('G5 真 API 更名与版次更新；預覽與授權列印各 fresh GET');

  await readOnly('G6 malformed full responses cannot enable output and retry is fresh', async () => {
    const changes = [['extra-envelope', body => ({ ...body, extra: true })], ['filter-ID-mismatch', body => ({ ...body, filters: { ...body.filters, caseId: B.caseId } })], ['partial-rows', body => ({ ...body, rows: [] })], ['duplicate-row', body => { body.rows.push({ ...body.rows[0] }); body.total++; body.pageSize++; body.totals.count++; return body; }], ['invalid-version', body => { body.rows[0].version = 0; return body; }], ['projection-over-2MiB', body => { body.rows[0].note = '界'.repeat(700000); return body; }]];
    for (const [label, change] of changes) {
      let used = false; const handler = async route => { if (used || !matches(route.request(), specific)) return route.continue(); used = true; const response = await route.fetch({ timeout: 15000 }), body = change(await response.json()); malformed.push({ label, mocked2xx: true, bodySha256: sha(JSON.stringify(body)) }); await route.fulfill({ response, json: body }); };
      await admin.route(routePattern, handler);
      try { await openPreview(admin, specific, { ready: false }); await retry(admin).waitFor(); assert(used); assert(await printButton(admin).isDisabled()); assert.equal(await printable(admin).count(), 0); const count = downloads.length; await retry(admin).click(); await printable(admin).waitFor(); await assertReport(admin, specific); assert.equal(downloads.length, count); if (label === 'filter-ID-mismatch') await shot(admin, 'preview-invalid-response-fresh-retry.png'); await closePreview(admin); }
      finally { await admin.unroute(routePattern, handler); }
    }
  }); mark('G6 非法 envelope/filter/rows/version/2 MiB 回應不列印不下載；retry fresh');

  await readOnly('G7 preview HTTP failure and fresh empty revoke print', async () => {
    for (const type of ['503', 'empty']) {
      let used = false; const handler = async route => { if (used || !matches(route.request(), specific)) return route.continue(); used = true;
        if (type === '503') { expectConsole(route.request().url(), 503); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成完整報表暫時無法讀取。' } }) }); }
        const response = await route.fetch({ timeout: 15000 }), body = await response.json(); body.rows = []; body.total = 0; body.pageSize = 0; body.totals.count = 0; await route.fulfill({ response, json: body });
      };
      await admin.route(routePattern, handler);
      try { await openPreview(admin, specific, { ready: false }); await retry(admin).waitFor(); assert(await printButton(admin).isDisabled()); assert.equal(await printable(admin).count(), 0); assert.equal(await preview(admin).getByRole('button', { name: '下載 CSV', exact: true }).count(), 0); await retry(admin).click(); await printable(admin).waitFor(); await assertReport(admin, specific); await closePreview(admin); }
      finally { await admin.unroute(routePattern, handler); }
    }
  }); mark('G7 503 與 fresh empty 拒絕成功預覽／禁列印及 CSV／條件原樣 retry');

  await readOnly('G8 CSV independently fresh JSON then exact CSV bytes', async () => {
    await openPreview(admin, specific); const expected = await fixture.request(fixture.clients.admin, 'GET', csvPath + '?' + query(specific)); assert.equal(expected.status, 200);
    const before = ledger.length, downloaded = admin.waitForEvent('download'); await csvButton(admin).click(); const download = await downloaded;
    const file = path.join(output, 'synthetic-confirmed-calendar.csv'); await download.saveAs(file); same(await readFile(file), expected.bytes);
    same(ledger.slice(before).map(item => ({ path: item.path, query: item.query })), [{ path: exportPath, query: '?' + query(specific) }, { path: csvPath, query: '?' + query(specific) }]);
    assert.match(expected.headers.get('content-type'), /^text\/csv/); assert.match(expected.headers.get('cache-control'), /no-store/); same([...expected.bytes.subarray(0, 3)], [239, 187, 191]); assert(expected.bytes.toString('utf8').includes(renamedCase.name));
    await closePreview(admin);
  }); mark('G8 CSV fresh JSON 確認後第二 GET；真下載逐 byte 一致/BOM/現名/原五條件');

  await readOnly('G9 CSV cancel and duplicate defense at both stages', async () => {
    for (const phase of ['export', 'csv']) {
      await openPreview(admin, specific); const csv = await csvButton(admin).elementHandle(); assert(csv, 'Capture the confirmed CSV control before its busy pseudo-content changes the accessible name');
      const held = await slow(admin, phase === 'export' ? exported : csvRequest), before = ledger.length, count = downloads.length;
      try { await csv.evaluate(node => { node.click(); node.click(); node.click(); }); await bounded(held.arrived, 'CSV cancellation arrival'); assert(await csv.evaluate(node => node.isConnected), 'The held CSV request keeps the captured report control connected'); assert(await csv.isDisabled()); assert.equal(await csv.getAttribute('aria-busy'), 'true'); const cancel = printable(admin).getByRole('button', { name: '取消下載', exact: true }); assert(await cancel.isVisible()); assert.equal(ledger.length - before, phase === 'export' ? 1 : 2); const failed = failurePromise(admin, held); await cancel.click(); await assertAborted(failed); await held.finish(); await settle(admin); assert.equal(downloads.length, count); assert(await csv.isEnabled()); assert.equal(await csv.getAttribute('aria-busy'), null); assert(await csvButton(admin).isEnabled()); await assertReport(admin, specific); cancellations.push({ phase, action: 'cancel CSV', actualBrowserAbortBeforeRelease: true, noInjectedAbort: true, noDuplicate: true, noLateFile: true }); }
      finally { await held.finish(); }
      await closePreview(admin);
    }
  }); mark('G9 CSV preflight/transfer 真 Abort；重複 click 一次 transfer／可取消無晚檔');

  await readOnly('G10 CSV errors stay inline and retry re-confirms current data', async () => {
    await openPreview(admin, specific);
    for (const type of ['503', 'mime', 'empty']) {
      let used = false; const handler = async route => { if (used || !csvRequest(route.request())) return route.continue(); used = true;
        if (type === '503') { expectConsole(route.request().url(), 503); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成下載暫時無法讀取。' } }) }); }
        return route.fulfill({ status: 200, contentType: type === 'mime' ? 'text/html' : 'text/csv', body: type === 'mime' ? '<html>synthetic wrong MIME</html>' : '' });
      };
      await admin.route(routePattern, handler);
      try { const count = downloads.length; await csvButton(admin).click(); await retry(admin).waitFor(); assert.equal(downloads.length, count); assert(await printButton(admin).isEnabled()); if (type === '503') await shot(admin, 'preview-inline-csv-error-retry.png'); const before = ledger.length, downloaded = admin.waitForEvent('download'); await retry(admin).click(); await downloaded; same(ledger.slice(before).map(item => item.path), [exportPath, csvPath]); }
      finally { await admin.unroute(routePattern, handler); }
    }
    await closePreview(admin);
  }); mark('G10 CSV 503/錯 MIME/空 body 無檔；inline retry 每次重讀 JSON+CSV');

  await readOnly('G11 print reload cancels old transfer and protects replacement body', async () => {
    await openPreview(admin, specific); const held = await slow(admin, csvRequest), count = downloads.length;
    try { await csvButton(admin).click(); await bounded(held.arrived, 'Print competition CSV arrival'); const failed = failurePromise(admin, held), printsBefore = await admin.evaluate(() => window.__printCalls.length); await printButton(admin).click(); await assertAborted(failed); await admin.waitForFunction(value => window.__printCalls.length === value + 1, printsBefore); await held.finish(); await settle(admin); assert.equal(downloads.length, count); await assertReport(admin, specific); assert.equal(await printable(admin).locator('.error-state').count(), 0); cancellations.push({ phase: 'csv', action: 'print reload', actualBrowserAbortBeforeRelease: true, replacementBodyProtected: true, noLateFile: true }); }
    finally { await held.finish(); }
    await closePreview(admin);
  }); mark('G11 列印起始中止 CSV transfer；fresh print／舊 body 不回寫與不晚下載');

  await readOnly('G12 close Escape and context invalidation cancel loaded/pending preview', async () => {
    for (const phase of ['preview-export', 'csv']) for (const method of ['escape', 'button']) {
      const count = downloads.length; let held;
      if (phase === 'preview-export') { held = await slow(admin, exported); await entry(admin).click(); await bounded(held.arrived, 'Pending preview arrival'); }
      else { await openPreview(admin, specific); held = await slow(admin, csvRequest); await csvButton(admin).click(); await bounded(held.arrived, 'Pending CSV arrival'); }
      try { const failed = failurePromise(admin, held); await closePreview(admin, entry(admin), method); await assertAborted(failed); await held.finish(); await settle(admin); assert.equal(downloads.length, count); assert.equal(await preview(admin).count(), 0); cancellations.push({ phase, action: method, actualBrowserAbortBeforeRelease: true, noLateFileOrResurrection: true, noInjectedAbort: true }); }
      finally { await held.finish(); }
    }
    for (const phase of ['loaded', 'preview-export', 'csv']) for (const kind of ['user', 'logout', 'org', 'role', 'employee', 'context-ref', 'hash', 'render', 'disconnect']) {
      await openCalendar(admin); await enable(admin); await submit(admin, specific); let held;
      if (phase === 'preview-export') { held = await slow(admin, exported); await entry(admin).click(); await bounded(held.arrived, 'Context preview arrival'); }
      else { await openPreview(admin, specific); if (phase === 'csv') { held = await slow(admin, csvRequest); await csvButton(admin).click(); await bounded(held.arrived, 'Context CSV arrival'); } }
      const count = downloads.length;
      try { const failed = held ? failurePromise(admin, held) : null, proof = await mutateContext(admin, kind); assert(proof.wakeupControlPassed);
        if (['user', 'logout', 'org', 'role', 'employee'].includes(kind)) { assert(proof.refStayedSame); same(proof.changedDimensions, ['identity']); same(proof.changedIdentityFields, [{ user: 'userId', logout: 'userId', org: 'organizationId', role: 'role', employee: 'employeeId' }[kind]]); }
        else if (kind === 'context-ref') { assert(!proof.refStayedSame); same(proof.changedDimensions, ['reference']); same(proof.changedIdentityFields, []); }
        else { assert(proof.refStayedSame); same(proof.changedDimensions, [kind === 'render' ? 'stamp' : kind === 'disconnect' ? 'connected' : 'hash']); same(proof.changedIdentityFields, []); }
        await preview(admin).waitFor({ state: 'detached' }); await calendar(admin).waitFor({ state: 'detached' }); if (failed) await assertAborted(failed); if (held) await held.finish(); await settle(admin); assert.equal(downloads.length, count); assert.equal(await printable(admin).count(), 0); contextsProof.push({ phase, kind, ...proof, actualAbortBeforeRelease: Boolean(held), noLateOutput: true });
      } finally { if (held) await held.finish(); }
    }
    await openCalendar(admin); await enable(admin); await submit(admin, specific);
  }); mark('G12 Close/Escape 真取消；loaded/pending preview/CSV 全 primitive/reference/hash/render/DOM 失效');

  await readOnly('G13 nested keyboard mobile layout and native print suppression', async () => {
    await submit(admin, week); const opened = await openPreview(admin, week, { keyboard: true }); await assertReport(admin, week);
    await admin.evaluate(() => window.dispatchEvent(new Event('beforeprint'))); assert(await admin.evaluate(() => document.body.classList.contains('print-suppressed')), 'Unrequested native print suppresses the document'); await admin.evaluate(() => window.dispatchEvent(new Event('afterprint'))); assert(!await admin.evaluate(() => document.body.classList.contains('print-suppressed')));
    await shot(admin, 'nested-report-desktop-complete-table.png'); await admin.setViewportSize({ width: 390, height: 844 }); await shot(admin, 'nested-report-mobile-complete-table.png');
    const wide = printable(admin).locator('.table-scroll'); await wide.evaluate(node => { node.scrollLeft = node.scrollWidth; node.scrollIntoView({ block: 'start' }); }); assert(await wide.evaluate(node => node.scrollLeft > 0)); await shot(admin, 'nested-report-mobile-own-horizontal-scroll.png');
    await csvButton(admin).focus(); await admin.keyboard.press('Tab'); assert(await admin.evaluate(() => document.activeElement?.closest('dialog')?.classList.contains('app-dialog-printable')), 'Keyboard focus stays inside the topmost modal');
    await closePreview(admin, opened.trigger); assert.equal(await field(admin, 'anchor').inputValue(), week.startDate); await shot(admin, 'mobile-calendar-return-focus-kept-filters.png'); await admin.setViewportSize({ width: 1440, height: 1050 });
  }); mark('G13 nested Enter/Escape/focus；390px 全列自行橫捲／native print guard');

  await written('G14 explicit complete 1001 INSERT-only limit fixture after confirmation', async () => { fixture.importShifts(Array.from({ length: 1001 }, (_, index) => fixture.dataset.shiftData({ date: '2026-10-08', status: 'cancelled', note: 'HANDOFF-LIMIT-' + index })), { label: 'handoff-browser-1001-complete-INSERT-only-fixtures' }); });
  await readOnly('G14 real server 413 disables print and permits narrowing after close', async () => {
    expectConsole(base + exportPath + '?' + query(week), 413); const opened = await openPreview(admin, week, { ready: false }); assert.equal(opened.reply.status(), 413); await retry(admin).waitFor(); assert(await printButton(admin).isDisabled()); assert.equal(await printable(admin).count(), 0); await shot(admin, 'real-server-413-handoff-no-output.png'); await closePreview(admin); await submit(admin, filters(week.startDate, week.endDate, B, 'cancelled')); const narrowed = filters(week.startDate, week.endDate, B, 'cancelled'); await openPreview(admin, narrowed); await assertReport(admin, narrowed); await closePreview(admin);
  }); mark('G14 確認後真 1001 HTTP 413 無列印/CSV；關閉後保留五欄可縮到完整結果');

  stage = 'final proof'; assert(!timedOut && Date.now() - started <= 900000); assert.equal(pageErrors.length, 0, 'No page error is discarded');
  for (const item of consoleErrors) assert(expectedConsole.some(expected => item.url === expected.url && item.messageSha256 === expected.messageSha256), 'Only exactly registered resource failures are accepted');
  for (const item of negativeResponses) assert(expectedConsole.some(expected => item.url === expected.url && item.status === expected.status), 'No unregistered browser HTTP failure is suppressed');
  assert.equal(consoleErrors.length, expectedConsole.length); const sourcesAfter = await sourceMap(); same(sourcesAfter, sourcesBefore, 'Sources remain byte exact throughout the run');
  assert.equal(fixture.counts().tableCount, 11); assert.equal(fixture.counts().triggerCount, 6); assert.equal(fixture.counts().totalChanges, fixture.ledger.reduce((sum, item) => sum + item.changes, 0), 'All setup/login/import/normal API changes are separately accounted');
  const rawAfter = fixture.rawState(); for (const table of ['attachment_files', 'certification_attachment_files']) same(rawAfter.typedTables[table], rawBefore.typedTables[table], 'All attachment BLOB bytes remain exact');
  for (const entity of ['service-records', 'announcement-reads']) same(rawAfter.tables.record_versions.filter(row => row.entity === entity), rawBefore.tables.record_versions.filter(row => row.entity === entity), 'Approved billing snapshots and immutable read receipts remain exact');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, version: '0.43', checks, screenshots, reports, cancellations, contextsProof, malformed, reads, writes, requestLedger: ledger, downloads, setupLedger: fixture.ledger, counts: fixture.counts(), pageErrors, consoleErrors, expectedConsole, negativeResponses, sourcesBefore, sourcesAfter, totalElapsedMs: Date.now() - started, limits: { actionTimeoutMs: 10000, navigationTimeoutMs: 15000, interceptedApiTimeoutMs: 15000, overallTimeoutMs: 900000 }, verificationScope: { syntheticRandomLoopbackOnly: true, allReadSegmentsZeroWrites: true, independentSavedIdOracle: true, noInjectedRouteAbort: true, noAutomaticRetry: true, nativePrintAuthorizationCaptured: true, nativePopupGeometryVerified: false, atomicCsvSnapshotClaimed: false, pdfGenerated: false, physicalPrinting: false, fullWcag: false, manualUat: false, ci: false, deployment: false, originalDataOrCredentials: false, originalSystemEquivalence: false } }, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, version: '0.43', stage, error: { name: error.name, messageSha256: sha(String(error.message)), stackSha256: sha(String(error.stack)) }, checks, screenshots, reports, cancellations, contextsProof, malformed, reads, writes, requestLedger: ledger, downloads, pageErrors, consoleErrors, expectedConsole, negativeResponses, sourcesBefore, totalElapsedMs: Date.now() - started, noAutomaticRetry: true }, null, 2) + '\n', { flag: 'wx' });
  throw error;
} finally { clearTimeout(watchdog); for (const context of contexts) await context.close().catch(() => {}); await browser?.close().catch(() => {}); await fixture?.close(); }
