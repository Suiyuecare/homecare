import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createShiftCalendarPersonFiltersFixture } from './shift-calendar-person-filters-fixtures.mjs';

// This suite creates only its own synthetic workspace and random loopback server.
// Default databases, port 4310, historical QA trees and original credentials are unused.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/shift-calendar-filters-qa');
assert(!existsSync(path.join(output, 'e2e.json')), 'Retain previous attempts before explicitly starting a new run');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert(isDeepStrictEqual(actual, expected), label);
const emptyPerson = () => ({ caseId: '', employeeId: '' });
const visibleKeys = ['date', 'caseNo', 'case', 'employeeNo', 'employee', 'startTime', 'endTime', 'services', 'statusLabel', 'version', 'note'];
const rowKeys = ['shiftId', 'version', 'date', 'caseNo', 'case', 'employeeNo', 'employee', 'startTime', 'endTime', 'services', 'status', 'statusLabel', 'note'];
// Original columns/row keys remain the legacy oracle; UI opts in additively.
const spanVisibleKeys = visibleKeys.flatMap(key => key === 'date' ? [key, 'endDate'] : [key]);
const spanRowKeys = [...rowKeys, 'endDate'];
const fixedModes = Object.freeze({ spanMode: 'calendar-two-day-v1', rangeMode: 'intersects' });
const spanFilters = value => ({ ...value, ...fixedModes });
const primitiveFilters = value => Object.fromEntries(Object.keys(filters({ startDate: '', endDate: '' })).map(key => [key, value[key]]));
// These unchanged fixtures contain same-day rows. Clock text is read independently;
// raw ISO seconds/offsets stay intact in every original displayed value.
const segmentOracle = row => {
  assert.equal(row.endDate, row.date, 'Legacy same-day ending date is a read-only projection');
  const clock = value => { const match = /^(?:\d{4}-\d{2}-\d{2}T)?(\d{2}:\d{2})(?:$|:)/.exec(value); assert(match, 'Independent persisted clock oracle'); return match[1]; };
  return `${row.date} ${clock(row.startTime)}–${clock(row.endTime)}`;
};
const weekdays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const names = ['mode', 'anchor', 'status', 'caseId', 'employeeId'];
const loadingText = '正在讀取完整週／月班表…';
const lookupError = '未取得完整且一致的個案與人員名單，請重新讀取。';
const missingError = '原選項目前不可用，請重新選擇或明確選擇全部。';
const exportPath = '/api/shift-report/export';
const routePattern = '**/api/**';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = async (promise, label, ms = 10000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its explicit bound')), ms); })]); } finally { clearTimeout(timer); } };
const pathOf = request => new URL(request.url()).pathname;
const isExport = request => request.method() === 'GET' && pathOf(request) === exportPath;
const isLookup = request => request.method() === 'GET' && ['/api/cases', '/api/employees'].includes(pathOf(request)) && new URL(request.url()).searchParams.get('pageSize') === '100';
const relevant = request => isExport(request) || isLookup(request);
const lookupPage = request => Number(new URL(request.url()).searchParams.get('page'));
const stagePredicate = stage => stage === 'export' ? isExport : request => isLookup(request) && pathOf(request) === '/api/' + stage && lookupPage(request) === 1;

// Independent Gregorian oracle avoids Date.UTC's special interpretation of years 0..99.
function oracle(mode, anchor) {
  const [year, month, day] = anchor.split('-').map(Number), selected = new Date(0);
  selected.setUTCHours(0, 0, 0, 0); selected.setUTCFullYear(year, month - 1, day);
  assert.equal(selected.toISOString().slice(0, 10), anchor);
  const text = value => { const iso = value.toISOString(); return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null; };
  const plus = (value, n) => { const result = new Date(value); result.setUTCDate(result.getUTCDate() + n); return result; };
  let dates, previousAnchor, nextAnchor;
  if (mode === 'week') {
    const start = plus(selected, -(selected.getUTCDay() + 6) % 7);
    dates = Array.from({ length: 7 }, (_, n) => text(plus(start, n))).filter(Boolean);
    previousAnchor = dates[0] === '0000-01-01' ? null : text(plus(start, -7)) || '0000-01-01'; nextAnchor = text(plus(start, 7));
  } else {
    assert.equal(mode, 'month'); const first = new Date(selected); first.setUTCDate(1);
    const next = new Date(first); next.setUTCMonth(next.getUTCMonth() + 1); const last = plus(next, -1);
    dates = Array.from({ length: last.getUTCDate() }, (_, n) => text(plus(first, n)));
    const previous = new Date(first); previous.setUTCMonth(previous.getUTCMonth() - 1);
    previousAnchor = text(previous); nextAnchor = text(next);
  }
  return { mode, anchor, dates, startDate: dates[0], endDate: dates.at(-1), previousAnchor, nextAnchor };
}
const filters = (period, status = '', person = emptyPerson()) => ({ startDate: period.startDate, endDate: period.endDate, caseId: person.caseId, employeeId: person.employeeId, status });
const legacyQuery = (period, status = '', person = emptyPerson()) => new URLSearchParams(Object.entries(filters(period, status, person)).filter(([, value]) => value !== '')).toString();
const query = (period, status = '', person = emptyPerson()) => new URLSearchParams(Object.entries(spanFilters(filters(period, status, person))).filter(([, value]) => value !== '')).toString();
const matches = (request, period, status = '', person = emptyPerson()) => isExport(request) && new URL(request.url()).search === '?' + query(period, status, person);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());

const checks = [], screenshots = [], reportChecks = [], lookupChecks = [], malformedChecks = [], cancellationChecks = [], contextChecks = [], serverChecks = [], readSegments = [], writeSegments = [], requestLedger = [], pageErrors = [], consoleErrors = [], expectedConsole = [], negativeResponses = [], contexts = [];
let fixture, browser, base, actors, lastPage, sourcesBefore, stage = 'initialization', timedOut = false;
const started = Date.now(), watchdog = setTimeout(() => { timedOut = true; browser?.close().catch(() => {}); }, 1200000);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const collectSources = async () => {
  const files = ['tests/shift-calendar-person-filters-e2e.mjs', 'tests/shift-calendar-person-filters-fixtures.mjs', 'tests/shift-calendar-fixtures.mjs', 'tests/announcement-read-receipts-fixtures.mjs', 'tests/synthetic-backup-fixtures.mjs', 'docs/SHIFT_CALENDAR_PERSON_FILTERS_SCOPE.md'];
  const walk = async directory => { for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else files.push(file); } };
  await walk('public'); await walk('src'); return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const readOnly = async (label, work) => { stage = label; const before = fixture.captureRead(), result = await work(), after = fixture.assertReadUnchanged(before, label); readSegments.push({ label, before, after, allTypedStateUnchanged: true, totalChangesDelta: 0 }); return result; };
const written = async (label, work) => { stage = label; const before = fixture.counts(), result = await work(), after = fixture.counts(); writeSegments.push({ label, before, after, changes: after.totalChanges - before.totalChanges }); return result; };
function observe(page) {
  page.on('pageerror', error => pageErrors.push({ messageSha256: sha(error.message) }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ messageSha256: sha(message.text()), url: message.location().url }); });
  page.on('request', request => { if (relevant(request)) requestLedger.push({ path: pathOf(request), query: new URL(request.url()).search, orgHeaderPresent: Boolean(request.headers()['x-org-id']), page: page.url() }); });
  page.on('response', response => { if (response.status() >= 400) negativeResponses.push({ url: response.url(), status: response.status() }); });
}
const expectConsole = (url, status) => expectedConsole.push({ url, status, messageSha256: sha(`Failed to load resource: the server responded with a status of ${status} (${STATUS_CODES[status]})`) });
const dialog = page => page.getByRole('dialog', { name: '週／月班表', exact: true });
const content = page => dialog(page).locator('.shift-calendar');
const field = (page, name) => content(page).locator(`form [name="${name}"]`);
const nav = (page, name) => content(page).locator('.actions').getByRole('button', { name, exact: true });
const queryButton = page => content(page).getByRole('button', { name: '查詢班表', exact: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const noResult = async page => assert.equal(await content(page).locator('.shift-calendar-index,.shift-calendar-agenda').count(), 0, 'No old, partial or false-empty confirmed result remains');
async function layout(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Document has no horizontal overflow');
  assert.equal(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).length), 0, 'Visible controls have labels');
  for (const surface of await page.locator('dialog[open]').all()) assert(await surface.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog stays inside viewport');
  for (const region of await page.locator('.table-scroll').all()) if (await region.isVisible()) assert.equal(await region.evaluate(node => getComputedStyle(node).overflowX), 'auto');
}
const shot = async (page, name) => { await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push({ name, path: path.join(output, name), sha256: sha(await readFile(path.join(output, name))) }); };
async function load(page, role = 'admin') {
  lastPage = page; const own = role.startsWith('caregiver'), target = `${base}/#${own ? '/my-services' : '/shifts'}`;
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { level: 1, name: own ? '我的服務' : '班表', exact: true }).waitFor();
  await page.getByRole('button', { name: '週／月班表', exact: true }).waitFor();
  await page.locator(`main section[aria-label="${own ? '我的服務' : '班表'}結果"][aria-busy="false"]`).waitFor();
}
async function open(page, role = 'admin') {
  await load(page, role); const trigger = page.getByRole('button', { name: '週／月班表', exact: true }), before = requestLedger.length;
  const response = page.waitForResponse(value => isExport(value.request())); response.catch(() => {}); await trigger.click(); const reply = await response;
  assert.equal(reply.status(), 200); await content(page).locator('.shift-calendar-agenda').waitFor();
  same(await content(page).locator('form [name]').evaluateAll(nodes => nodes.map(node => node.name)), names.slice(0, 3), 'Default is still exactly three fields');
  const segment = requestLedger.slice(before); assert.equal(segment.length, 1); assert.equal(segment[0].path, exportPath, 'Default open performs only one export and no extra lookup');
  return { trigger, result: await reply.json() };
}
async function close(page, trigger, method = 'escape') {
  if (method === 'button') await dialog(page).locator(':scope > .dialog-footer').getByRole('button', { name: '關閉', exact: true }).click(); else await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' }); if (trigger && await trigger.count() && await trigger.evaluate(node => node.isConnected)) assert(await trigger.evaluate(node => document.activeElement === node), 'Close restores triggering focus');
}
async function enable(page, expectedStatus = 200) {
  const response = page.waitForResponse(value => isExport(value.request())); response.catch(() => {});
  await content(page).getByRole('button', { name: '啟用個案／人員篩選', exact: true }).click(); const reply = await response; assert.equal(reply.status(), expectedStatus);
  await content(page).locator(expectedStatus === 200 ? '.shift-calendar-agenda' : '.error-state').waitFor();
  same(await content(page).locator('form [name]').evaluateAll(nodes => nodes.map(node => node.name)), names, 'Explicit opt-in shows all five canonical fields');
  assert.equal(await content(page).getByRole('button', { name: '啟用個案／人員篩選', exact: true }).count(), 0);
  return await reply.json();
}
async function draft(page, period, status = '', person) {
  await field(page, 'mode').selectOption(period.mode); await field(page, 'anchor').fill(period.anchor); await field(page, 'status').selectOption(status);
  if (person) { await field(page, 'caseId').selectOption(person.caseId); if (await field(page, 'employeeId').isEnabled()) await field(page, 'employeeId').selectOption(person.employeeId); else assert.equal(await field(page, 'employeeId').inputValue(), person.employeeId); }
}
async function submit(page, period, status = '', person = emptyPerson(), expectedStatus = 200) {
  await draft(page, period, status, person); const response = page.waitForResponse(value => matches(value.request(), period, status, person)); response.catch(() => {});
  await queryButton(page).click(); const reply = await response; assert.equal(reply.status(), expectedStatus);
  await content(page).locator(expectedStatus === 200 ? '.shift-calendar-agenda' : '.error-state').waitFor(); return await reply.json();
}
const readFullLookup = async (entity, role = 'admin') => {
  const rows = []; let total;
  for (let page = 1; page <= 100; page++) { const response = await fixture.request(fixture.clients[role], 'GET', `/api/${entity}?page=${page}&pageSize=100`); assert.equal(response.status, 200); assert.equal(response.body.page, page); assert.equal(response.body.pageSize, 100); total ??= response.body.total; assert.equal(response.body.total, total); rows.push(...response.body.items); if (rows.length === total) return rows; }
  throw new Error('Independent fixture lookup exceeds its known bound');
};
const expectedOption = (row, entity) => {
  const number = typeof row[entity === 'cases' ? 'caseNo' : 'employeeNo'] === 'string' ? row[entity === 'cases' ? 'caseNo' : 'employeeNo'] : '';
  const name = typeof row.name === 'string' ? row.name : '', status = typeof row.status === 'string' ? row.status : '';
  const states = entity === 'cases' ? { active: '服務中', paused: '暫停', closed: '已結案' } : { active: '在職', inactive: '停用' };
  return { value: row.id, text: `${number || '未填編號'} · ${name || (entity === 'cases' ? '未取得個案名稱' : '未取得服務人員名稱')}（${states[status] || '狀態未確認'}） · ${row.id}` };
};
async function assertOptions(page, role = 'admin') {
  for (const [entity, key, all] of [['cases', 'caseId', '全部可讀個案'], ['employees', 'employeeId', '全部可讀人員']]) {
    const rows = await readFullLookup(entity, role), options = await field(page, key).locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent })));
    same(options, [{ value: '', text: all }, ...rows.map(row => expectedOption(row, entity))], 'Native options equal every currently readable persisted ID, including inactive and literal missing names');
    lookupChecks.push({ entity, role, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / 100)), exactOptionsSha256: sha(JSON.stringify(options)), currentOwnOrg: true });
  }
  assert.equal(await content(page).locator('script,img').count(), 0, 'Literal option/body text never creates markup');
}
async function assertSequence(before, role = 'admin', expectedExport = true) {
  const cases = await readFullLookup('cases', role), employees = await readFullLookup('employees', role);
  const expected = [['cases', cases], ['employees', employees]].flatMap(([entity, rows]) => Array.from({ length: Math.max(1, Math.ceil(rows.length / 100)) }, (_, index) => ({ path: '/api/' + entity, query: `?page=${index + 1}&pageSize=100` })));
  const segment = requestLedger.slice(before).map(({ path, query }) => ({ path, query }));
  assert.equal(segment.length, expected.length + Number(expectedExport)); same(segment.slice(0, expected.length), expected, 'Fresh complete cases then employees precede each export');
  if (expectedExport) assert.equal(segment.at(-1).path, exportPath);
}
async function assertFull(page, period, status = '', person = emptyPerson(), role = 'admin', returned) {
  const real = await fixture.request(fixture.clients[role], 'GET', exportPath + '?' + query(period, status, person)); assert.equal(real.status, 200); const result = real.body;
  same(primitiveFilters(result.filters), filters(period, status, person), 'All five original primitive filters remain exact'); same(result.filters, spanFilters(filters(period, status, person)), 'Only the two fixed explicit modes are added');
  const legacy = await fixture.request(fixture.clients[role], 'GET', exportPath + '?' + legacyQuery(period, status, person)); assert.equal(legacy.status, 200);
  same(legacy.body.filters, filters(period, status, person)); same(legacy.body.columns.map(column => column.key), visibleKeys); for (const row of legacy.body.rows) same(Object.keys(row).sort(), [...rowKeys].sort());
  same(result.rows.map(({ endDate, ...row }) => row), legacy.body.rows, 'All original raw projection values still equal the untouched legacy API'); assert.equal(Object.keys(result).length, 12); assert.equal(result.rows.length, result.total); assert.equal(result.page, 1); assert.equal(result.pageSize, result.total); assert.equal(result.totals.count, result.total);
  same(result.columns.map(column => column.key), spanVisibleKeys); for (const row of result.rows) same(Object.keys(row).sort(), [...spanRowKeys].sort());
  same(result.rows.map(row => row.shiftId).sort(), fixture.expectedShiftIds(filters(period, status, person), role).sort(), 'Independent saved shiftId→caseId/employeeId oracle proves real HTTP ID filtering');
  if (returned) same(returned.rows, result.rows, 'Loaded response is complete and matches fresh HTTP');
  const actual = await content(page).locator('.shift-calendar-agenda').evaluate(node => [...node.querySelectorAll(':scope > section[data-date]')].map(section => ({ date: section.dataset.date,
    rows: [...section.querySelectorAll('tbody tr')].map(row => ({ id: row.dataset.shiftId, values: [...row.children].map(td => td.textContent), wraps: [...row.querySelectorAll('span.pre-wrap')].map(span => getComputedStyle(span).whiteSpace) })),
    headers: [...section.querySelectorAll('thead th')].map(th => ({ text: th.textContent, scope: th.scope })), empty: section.querySelector('p')?.textContent || null })));
  same(actual.map(day => day.date), period.dates); const ids = [];
  for (const day of actual) { const rows = result.rows.filter(row => row.date === day.date); same(day.rows.map(row => row.id), rows.map(row => row.shiftId)); if (rows.length) {
      same(day.headers, [{ text: '本日顯示區段', scope: 'col' }, ...result.columns.map(column => ({ text: column.label, scope: 'col' }))]);
      for (let i = 0; i < rows.length; i++) { same(day.rows[i].values.filter((_, index) => index !== 0 && index !== 2), visibleKeys.map(key => String(rows[i][key])), 'All eleven original literal values are retained'); same(day.rows[i].values, [segmentOracle(rows[i]), ...spanVisibleKeys.map(key => String(rows[i][key]))]); assert(day.rows[i].wraps.every(value => value === 'pre-wrap')); }
    } else assert.equal(day.empty, '此日沒有班次。'); ids.push(...day.rows.map(row => row.id)); }
  same(ids, result.rows.map(row => row.shiftId)); assert.equal(new Set(ids).size, result.total);
  if (await field(page, 'caseId').count()) {
    assert.equal(await field(page, 'caseId').inputValue(), person.caseId); assert.equal(await field(page, 'employeeId').inputValue(), person.employeeId);
    for (const [label, value] of [['個案', result.selection.case], ['服務人員', result.selection.employee]]) assert.equal(await content(page).locator('.detail-grid > div').filter({ has: page.locator('dt', { hasText: new RegExp('^' + label + '$') }) }).locator('dd').textContent(), value);
  }
  reportChecks.push({ role, filters: result.filters, rows: result.total, rowSha256: sha(JSON.stringify(result.rows)), independentIdOracle: true, completeRowsExactlyOnce: true, originalVisibleColumns: 11, visibleColumns: 13, reportColumns: 12 }); return result;
}
async function slowRoute(page, predicate) {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false, request;
  const handler = async route => { if (used || !predicate(route.request())) return route.continue(); used = true; request = route.request(); try { const response = await route.fetch({ timeout: 10000 }); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } };
  await page.route(routePattern, handler); return { arrived: arrived.promise, get request() { return request; }, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'Late intercepted response release'); await page.unroute(routePattern, handler); } };
}
async function mutateContext(page, kind) {
  return page.evaluate(async ({ kind, foreign }) => {
    const ui = await import('/ui.js'), context = ui.getContext(), source = document.querySelector('[data-render-version]');
    const dialog = [...document.querySelectorAll('dialog[open]')].find(node => document.getElementById(node.getAttribute('aria-labelledby'))?.textContent === '週／月班表');
    if (!dialog?.open || !source?.isConnected) throw new Error('Synthetic invalidation requires connected owned source and dialog');
    const values = c => [c.user?.id ?? null, c.organizationId ?? null, c.role ?? null, c.user?.employeeId ?? null];
    const before = values(context), hash = location.hash, stamp = source.dataset.renderVersion;
    const wake = () => { const comment = document.createComment('synthetic-calendar-person-observer-wakeup'); document.body.append(comment); comment.remove(); };
    wake(); await new Promise(resolve => requestAnimationFrame(resolve));
    const wakeupControlPassed = dialog.open && dialog.isConnected && ui.getContext() === context && JSON.stringify(values(context)) === JSON.stringify(before) && location.hash === hash && source.dataset.renderVersion === stamp && source.isConnected;
    if (!wakeupControlPassed) throw new Error('Wakeup alone must preserve the unchanged context');
    if (kind === 'user') context.user.id = 'synthetic-replaced-user';
    else if (kind === 'logout') context.user = null;
    else if (kind === 'org') { context.organizationId = foreign; context.orgId = foreign; }
    else if (kind === 'role') context.role = 'finance';
    else if (kind === 'employee') context.user.employeeId = 'synthetic-replaced-employee';
    else if (kind === 'context-ref') ui.setContext({ ...context, user: { ...context.user }, organizations: context.organizations.map(org => ({ ...org })) }, context.organizationId);
    else if (kind === 'hash') location.hash = '/employees';
    else if (kind === 'render') source.dataset.renderVersion = crypto.randomUUID();
    else if (kind === 'disconnect') source.remove(); else throw new Error('Unknown context fixture');
    const afterContext = ui.getContext(), after = values(afterContext), keys = ['userId', 'organizationId', 'role', 'employeeId'];
    const changedIdentityFields = keys.filter((key, index) => before[index] !== after[index]), refStayedSame = afterContext === context;
    const changedDimensions = [!refStayedSame && 'reference', changedIdentityFields.length > 0 && 'identity', location.hash !== hash && 'hash', source.dataset.renderVersion !== stamp && 'stamp', !source.isConnected && 'connected'].filter(Boolean);
    wake(); return { wakeupControlPassed, refStayedSame, changedIdentityFields, changedDimensions, sessionUpdatedDispatched: false, observerWakeupOnly: true };
  }, { kind, foreign: fixture.orgIds.foreign });
}

await mkdir(output, { recursive: true });
try {
  sourcesBefore = await collectSources(); fixture = await createShiftCalendarPersonFiltersFixture(); base = fixture.base;
  assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310'); assert.equal(fixture.counts().tableCount, 11); assert.equal(fixture.counts().triggerCount, 6);
  const rawBefore = fixture.rawState();
  for (const table of ['attachment_files', 'certification_attachment_files']) assert(rawBefore.typedTables[table].rows.flat().some(value => value[0] === 'blob' && value[1].length), 'Both original BLOB families are nonempty');
  assert(rawBefore.tables.record_versions.some(row => row.entity === 'service-records' && JSON.parse(row.snapshot).billingSnapshot));
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright'), installed = await readdir(cache).catch(() => []);
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); actors = {};
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver', 'caregiver2']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context); context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(30000);
    const cookie = fixture.clients[role].cookie, equal = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, equal), value: cookie.slice(equal + 1), url: base }]);
    const page = await context.newPage(); observe(page); actors[role] = { page, context };
  }
  const admin = actors.admin.page, caregiver = actors.caregiver.page, pd = fixture.personDataset;
  const week = oracle('week', fixture.dataset.weekAnchor), month = oracle('month', fixture.dataset.monthAnchor);
  const A = { caseId: pd.caseA.id, employeeId: pd.employeeA.id }, B = { caseId: pd.caseB.id, employeeId: pd.employeeB.id };

  await readOnly('G1 unchanged default and role entrances', async () => {
    for (const role of ['admin', 'supervisor', 'caregiver']) { const page = actors[role].page, opened = await open(page, role); assert.equal(await field(page, 'caseId').count(), 0); assert.equal(await field(page, 'employeeId').count(), 0); await close(page, opened.trigger); }
    const finance = actors.finance.page; await finance.goto(base + '/#/'); await finance.getByRole('heading', { level: 1 }).waitFor(); assert.equal(await finance.getByRole('button', { name: '週／月班表', exact: true }).count(), 0);
    await finance.evaluate(async () => { await (await import('/modules/shift-calendar.js')).openShiftCalendar(); }); assert.equal(await dialog(finance).count(), 0);
  }); mark('G1 原三欄單export／三允許角色／財務無新入口');

  await readOnly('G2 full multi-page native options', async () => {
    await open(admin); const before = requestLedger.length; await enable(admin); await assertSequence(before); await assertOptions(admin);
    assert((await readFullLookup('cases')).length > 101); assert((await readFullLookup('employees')).length > 101);
    assert.equal(pd.caseA.name, pd.caseB.name); assert.equal(pd.employeeA.name, pd.employeeB.name); assert.notEqual(pd.caseA.id, pd.caseB.id); assert.notEqual(pd.employeeA.id, pd.employeeB.id);
    assert((await field(admin, 'caseId').locator(`option[value="${pd.caseA.id}"]`).textContent()).includes('已結案')); assert((await field(admin, 'employeeId').locator(`option[value="${pd.employeeA.id}"]`).textContent()).includes('停用'));
    await shot(admin, 'desktop-five-fields-complete-options.png');
  }); mark('G2 101以上跨頁完整有權名單／停用結案／同名ID可辨／缺名稱literal');

  await readOnly('G3 single dual and status filters', async () => {
    for (const [person, status] of [[{ caseId: A.caseId, employeeId: '' }, ''], [{ caseId: B.caseId, employeeId: '' }, ''], [{ caseId: '', employeeId: A.employeeId }, ''], [{ caseId: '', employeeId: B.employeeId }, ''], [A, 'cancelled'], [B, 'cancelled'], [{ caseId: A.caseId, employeeId: pd.typedEmployee.id }, '']]) {
      const before = requestLedger.length, result = await submit(admin, week, status, person); await assertSequence(before); await assertFull(admin, week, status, person, 'admin', result);
      if (person.caseId === A.caseId && person.employeeId === pd.typedEmployee.id) { assert.equal(result.total, 0); await shot(admin, 'desktop-confirmed-empty-id-intersection.png'); }
    }
    await submit(admin, week, 'cancelled', A); await shot(admin, 'desktop-same-name-specific-ids.png');
  }); mark('G3 單雙ID及status AND／獨立保存ID oracle／同名不推測／合法空結果');

  await readOnly('G4 memory draft retracts and native labels', async () => {
    const before = requestLedger.length; await field(admin, 'caseId').selectOption(B.caseId); await content(admin).getByText('條件已變更，請查詢班表。', { exact: true }).waitFor(); await noResult(admin);
    for (const name of ['上一期', '下一期', '重新讀取']) assert(await nav(admin, name).isDisabled()); assert.equal(requestLedger.length, before);
    await field(admin, 'employeeId').selectOption(B.employeeId); await noResult(admin); assert.equal(requestLedger.length, before); assert(await nav(admin, '重新讀取').isDisabled());
    for (const name of ['caseId', 'employeeId']) { const control = field(admin, name); assert.equal(await control.evaluate(node => node.tagName), 'SELECT'); const id = await control.getAttribute('id'); await content(admin).locator(`label[for="${id}"]`).click(); assert(await control.evaluate(node => node === document.activeElement)); }
    await field(admin, 'status').focus(); await admin.keyboard.press('Tab'); assert(await field(admin, 'caseId').evaluate(node => node === document.activeElement));
    await submit(admin, week, 'cancelled', B); await assertFull(admin, week, 'cancelled', B);
  }); mark('G4 草稿立即撤舊結果與導航／未submit零GET／native label與Tab');

  await readOnly('G5 every navigation refreshes options and exact IDs', async () => {
    await submit(admin, month, 'cancelled', A);
    for (const [name, period] of [['上一期', oracle('month', '2026-09-01')], ['下一期', oracle('month', '2026-10-01')], ['今天', oracle('month', today())]]) {
      const before = requestLedger.length, response = admin.waitForResponse(value => matches(value.request(), period, 'cancelled', A)); await nav(admin, name).click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertSequence(before); await assertFull(admin, period, 'cancelled', A);
    }
    const before = requestLedger.length, period = oracle('month', await field(admin, 'anchor').inputValue()), response = admin.waitForResponse(value => matches(value.request(), period, 'cancelled', A)); await nav(admin, '重新讀取').click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertSequence(before); await assertFull(admin, period, 'cancelled', A);
  }); mark('G5 翻期／今天／重讀每次完整fresh名單且精確ID不丟失');

  await readOnly('G6 caregiver fixed own ID and supervisor options', async () => {
    for (const role of ['caregiver', 'supervisor']) { const page = actors[role].page; await open(page, role); const before = requestLedger.length, result = await enable(page); await assertSequence(before, role); await assertOptions(page, role);
      const person = { caseId: '', employeeId: role === 'caregiver' ? fixture.dataset.employees.own.id : '' };
      assert.equal(await field(page, 'employeeId').isDisabled(), role === 'caregiver'); assert.equal(await field(page, 'employeeId').inputValue(), person.employeeId);
      const period = oracle('week', await field(page, 'anchor').inputValue()); await assertFull(page, period, '', person, role, result);
      if (role === 'caregiver') { assert.equal(await field(page, 'employeeId').locator('option').count(), 2); assert(await field(page, 'caseId').locator(`option[value="${pd.outsidePeriodCaregiverShift.caseId}"]`).count()); await shot(page, 'caregiver-fixed-own-readable-history-options.png'); }
      await close(page);
    }
  }); mark('G6 居服員固定disabled本人ID／歷史關聯個案／督導同org名單');

  await readOnly('G7 malformed lookup response never exports and fresh retry', async () => {
    await submit(admin, week, 'cancelled', A);
    const firstCaseId = (await readFullLookup('cases'))[0].id;
    const mutations = [
      ['null', 'cases', 1, () => null], ['array', 'cases', 1, () => []], ['extra-envelope', 'cases', 1, body => ({ ...body, extra: true })],
      ['wrong-page', 'cases', 1, body => ({ ...body, page: 2 })], ['wrong-pageSize', 'cases', 1, body => ({ ...body, pageSize: 25 })], ['numeric-total', 'cases', 1, body => ({ ...body, total: String(body.total) })],
      ['empty-partial', 'cases', 1, body => ({ ...body, items: [] })], ['wrong-org', 'employees', 1, body => { body.items[0].orgId = fixture.orgIds.foreign; return body; }],
      ['wrong-version', 'employees', 1, body => { body.items[0].version = 0; return body; }], ['duplicate-ID', 'cases', 2, body => { body.items[0].id = firstCaseId; return body; }],
      ['changed-total', 'cases', 2, body => ({ ...body, total: body.total + 1 })], ['over-10000', 'cases', 1, body => ({ ...body, total: 10001 })],
      ['over-projected-2MiB', 'employees', 1, body => { body.items[0].name = '界'.repeat(700000); return body; }],
    ];
    for (const [label, entity, number, change] of mutations) {
      stage = 'G7 ' + label; let used = false;
      const handler = async route => { if (used || !isLookup(route.request()) || pathOf(route.request()) !== '/api/' + entity || lookupPage(route.request()) !== number) return route.continue(); used = true; const response = await route.fetch({ timeout: 10000 }), body = change(await response.json()); malformedChecks.push({ family: 'lookup', label, mocked2xx: true, bodySha256: sha(JSON.stringify(body)) }); await route.fulfill({ response, json: body }); };
      await admin.route(routePattern, handler);
      try { const before = requestLedger.length; await nav(admin, '重新讀取').click(); await content(admin).getByText(lookupError, { exact: true }).waitFor(); assert(used); await noResult(admin); assert.equal(requestLedger.slice(before).filter(item => item.path === exportPath).length, 0);
        for (const [name, value] of [['caseId', A.caseId], ['employeeId', A.employeeId]]) { assert.equal(await field(admin, name).inputValue(), value); assert(await field(admin, name).isDisabled()); assert.equal(await field(admin, name).locator('option:checked').textContent(), '原選項目前不可用'); }
        if (label === 'wrong-org') await shot(admin, 'lookup-failure-kept-exact-disabled-ids.png');
        const retryBefore = requestLedger.length, reply = admin.waitForResponse(value => matches(value.request(), week, 'cancelled', A)); await content(admin).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true }).click(); assert.equal((await reply).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertSequence(retryBefore); await assertFull(admin, week, 'cancelled', A);
      } finally { await admin.unroute(routePattern, handler); }
    }
  }); mark('G7 13非法lookup 2xx／跨頁重複與改total／投影上限／零export／精確IDretry');

  await readOnly('G8 lookup HTTP failure preserves disabled IDs', async () => {
    let used = false, mockedUrl; const handler = async route => { if (used || !stagePredicate('employees')(route.request())) return route.continue(); used = true; mockedUrl = route.request().url(); expectConsole(mockedUrl, 503); await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成名單暫時無法讀取，請重新讀取。' } }) }); };
    await admin.route(routePattern, handler);
    try { const before = requestLedger.length; await nav(admin, '重新讀取').click(); await content(admin).getByText('合成名單暫時無法讀取，請重新讀取。', { exact: true }).waitFor(); assert(used); await noResult(admin); assert.equal(requestLedger.slice(before).filter(item => item.path === exportPath).length, 0); assert.equal(await field(admin, 'employeeId').inputValue(), A.employeeId); assert(await field(admin, 'employeeId').isDisabled());
      const response = admin.waitForResponse(value => matches(value.request(), week, 'cancelled', A)); await queryButton(admin).click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, week, 'cancelled', A);
    } finally { await admin.unroute(routePattern, handler); }
  }); mark('G8 第二名單503／不認部分cases為完整／disabled值仍保存／submit恢复');

  await readOnly('G9 wrong report selection or ID cannot confirm', async () => {
    for (const [label, change] of [['wrong-case-name', body => { body.selection.case = '偽造同名回顯'; return body; }], ['wrong-person-name', body => { body.selection.employee = pd.employeeB.name + ' changed'; return body; }], ['wrong-ID-echo', body => { body.filters.caseId = B.caseId; return body; }], ['truncated-rows', body => { body.rows.pop(); return body; }]]) {
      let used = false; const handler = async route => { if (used || !matches(route.request(), week, 'cancelled', A)) return route.continue(); used = true; const response = await route.fetch({ timeout: 10000 }), body = change(await response.json()); malformedChecks.push({ family: 'report', label, mocked2xx: true, bodySha256: sha(JSON.stringify(body)) }); await route.fulfill({ response, json: body }); };
      await admin.route(routePattern, handler);
      try { await nav(admin, '重新讀取').click(); await content(admin).locator('.error-state').waitFor(); assert(used); await noResult(admin); assert.equal(await field(admin, 'caseId').inputValue(), A.caseId); assert.equal(await field(admin, 'employeeId').inputValue(), A.employeeId); assert(await field(admin, 'caseId').isEnabled()); if (label === 'wrong-case-name') await shot(admin, 'report-unconfirmed-kept-usable-filters.png');
        const response = admin.waitForResponse(value => matches(value.request(), week, 'cancelled', A)); await content(admin).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true }).click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, week, 'cancelled', A);
      } finally { await admin.unroute(routePattern, handler); }
    }
  }); mark('G9 fresh主檔selectionName與精確filter echo／不完整rows未確認／可重讀');

  await readOnly('G10 unavailable selected ID is retained and explicitly corrected', async () => {
    const actual = await readFullLookup('cases'), remaining = actual.filter(row => row.id !== A.caseId);
    const handler = async route => { if (!isLookup(route.request()) || pathOf(route.request()) !== '/api/cases') return route.continue(); const page = lookupPage(route.request()); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: remaining.slice((page - 1) * 100, page * 100), total: remaining.length, page, pageSize: 100 }) }); };
    await admin.route(routePattern, handler);
    try { const before = requestLedger.length; await nav(admin, '重新讀取').click(); await content(admin).locator('.error-state').waitFor(); await noResult(admin); assert.equal(requestLedger.slice(before).filter(item => item.path === exportPath).length, 0); assert.equal(await field(admin, 'caseId').inputValue(), A.caseId); assert(await field(admin, 'caseId').isEnabled()); assert.equal(await field(admin, 'caseId').locator('option:checked').textContent(), '原選項目前不可用');
      const control = field(admin, 'caseId'), described = (await control.getAttribute('aria-describedby')).split(' '); assert(await content(admin).locator('#' + described.at(-1)).isVisible()); assert.equal(await content(admin).locator('#' + described.at(-1)).textContent(), missingError);
      const beforeSubmit = requestLedger.length; await queryButton(admin).click(); assert.equal(await control.getAttribute('aria-invalid'), 'true'); assert(await control.evaluate(node => document.activeElement === node)); assert.equal(await content(admin).locator('#' + described[0]).textContent(), missingError); assert.equal(requestLedger.length, beforeSubmit); await shot(admin, 'unavailable-id-canonical-field-error.png');
      await control.selectOption(''); const person = { caseId: '', employeeId: A.employeeId }, response = admin.waitForResponse(value => matches(value.request(), week, 'cancelled', person)); await queryButton(admin).click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, week, 'cancelled', person);
    } finally { await admin.unroute(routePattern, handler); }
    // Removing a route does not refresh the currently confirmed native options.
    const restoredPerson = { caseId: '', employeeId: A.employeeId }, restoredBefore = requestLedger.length;
    const restoredResponse = admin.waitForResponse(value => matches(value.request(), week, 'cancelled', restoredPerson));
    await nav(admin, '重新讀取').click(); assert.equal((await restoredResponse).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor();
    await assertSequence(restoredBefore); await assertOptions(admin); assert.equal(await field(admin, 'caseId').locator(`option[value="${A.caseId}"]`).count(), 1);
    await submit(admin, week, 'cancelled', A);
  }); mark('G10 missingID保留不可用option／立即help＋alert／canonical field error與focus／明確全部');

  await written('G11 explicitly owned complete 1001 report fixtures', async () => {
    fixture.importShifts(Array.from({ length: 1001 }, (_, index) => fixture.dataset.shiftData({ caseId: index < 999 ? A.caseId : B.caseId, employeeId: index < 999 ? A.employeeId : B.employeeId, date: '2027-04-15', status: 'cancelled', note: 'CAL-FILTER-LIMIT-' + index })), { label: 'person-filter-browser-1001-complete-INSERT-only-fixtures' });
  });
  await readOnly('G11 real 413 retains opt-in usable filters and narrows', async () => {
    await close(admin); await open(admin); const period = oracle('month', '2027-04-15'); await draft(admin, period);
    let url = base + exportPath + '?' + query(period); expectConsole(url, 413); let response = admin.waitForResponse(value => matches(value.request(), period)); await queryButton(admin).click(); assert.equal((await response).status(), 413); await content(admin).locator('.error-state').waitFor(); await noResult(admin); assert.equal(await field(admin, 'caseId').count(), 0);
    expectConsole(url, 413); const before = requestLedger.length; await enable(admin, 413); await assertSequence(before); await noResult(admin); assert(await field(admin, 'caseId').isEnabled()); assert(await field(admin, 'employeeId').isEnabled()); await shot(admin, 'real-413-five-fields-can-narrow.png');
    const result = await submit(admin, period, 'cancelled', B); assert.equal(result.total, 2); await assertFull(admin, period, 'cancelled', B);
    await submit(admin, week, 'cancelled', A);
  }); mark('G11 真1001 HTTP413／原三欄亦可啟用／保留五欄縮到完整兩筆');

  await readOnly('G12 both lookup phases and export true cancellation', async () => {
    for (const pendingStage of ['cases', 'employees', 'export']) for (const method of ['escape', 'button']) {
      await close(admin); const opened = await open(admin); await enable(admin); const slow = await slowRoute(admin, stagePredicate(pendingStage)), before = requestLedger.length;
      try { await nav(admin, '重新讀取').evaluate(node => { node.click(); node.click(); node.click(); }); await bounded(slow.arrived, 'Cancellation arrival'); await dialog(admin).getByText(loadingText, { exact: true }).waitFor(); assert.equal(await dialog(admin).locator('form').count(), 0); assert(await dialog(admin).locator(':scope > .dialog-footer').getByRole('button', { name: '關閉', exact: true }).isEnabled());
        const segment = requestLedger.slice(before), counts = { cases: 1, employees: 3, export: 5 }; assert.equal(segment.length, counts[pendingStage], 'Serial owner starts no duplicate reload or subsequent stage while current request is held'); if (pendingStage === 'employees' && method === 'escape') await shot(admin, 'pending-owner-cancel-options-loading.png');
        const failed = admin.waitForEvent('requestfailed', { predicate: request => request === slow.request, timeout: 10000 }); failed.catch(() => {}); await close(admin, opened.trigger, method); const request = await failed; assert(/abort|cancel|failed/i.test(request.failure()?.errorText || '')); await slow.finish(); await settle(admin); assert.equal(await dialog(admin).count(), 0);
        cancellationChecks.push({ pendingStage, method, realRequestFailedBeforeRelease: true, noLateResurrection: true, noInjectedAbort: true, serialRequests: segment.length });
      } finally { await slow.finish(); }
      await open(admin); await enable(admin);
    }
  }); mark('G12 cases／employees／export各Close和Escape真Abort／busy序列／晚回應不復活');

  await readOnly('G13 loaded and pending context dimensions fail closed', async () => {
    const kinds = ['user', 'logout', 'org', 'role', 'employee', 'hash', 'render', 'disconnect', 'context-ref'];
    for (const pendingStage of ['loaded', 'cases', 'employees', 'export']) for (const kind of pendingStage === 'employees' ? ['role', 'render', 'context-ref'] : kinds) {
      await close(admin); await open(admin); await enable(admin); let slow;
      try { if (pendingStage !== 'loaded') { slow = await slowRoute(admin, stagePredicate(pendingStage)); await nav(admin, '重新讀取').click(); await bounded(slow.arrived, 'Context arrival'); await dialog(admin).getByText(loadingText, { exact: true }).waitFor(); }
        const failed = slow ? admin.waitForEvent('requestfailed', { predicate: request => request === slow.request, timeout: 10000 }) : null; failed?.catch(() => {});
        const proof = await mutateContext(admin, kind); assert(proof.wakeupControlPassed);
        if (['user', 'logout', 'org', 'role', 'employee'].includes(kind)) { assert(proof.refStayedSame); same(proof.changedDimensions, ['identity']); same(proof.changedIdentityFields, [{ user: 'userId', logout: 'userId', org: 'organizationId', role: 'role', employee: 'employeeId' }[kind]]); }
        else if (kind === 'context-ref') { assert(!proof.refStayedSame); same(proof.changedDimensions, ['reference']); same(proof.changedIdentityFields, []); }
        else { assert(proof.refStayedSame); same(proof.changedIdentityFields, []); same(proof.changedDimensions, [kind === 'render' ? 'stamp' : kind === 'disconnect' ? 'connected' : 'hash']); }
        await dialog(admin).waitFor({ state: 'detached' }); if (failed) { const request = await failed; assert(/abort|cancel|failed/i.test(request.failure()?.errorText || '')); } if (slow) await slow.finish(); await settle(admin); assert.equal(await admin.locator('.shift-calendar').count(), 0);
        contextChecks.push({ pendingStage, kind, ...proof, actualAbortBeforeRelease: Boolean(slow), noLateResurrection: true, clientFixtureOnly: true });
      } finally { if (slow) await slow.finish(); }
      await open(admin); await enable(admin);
    }
  }); mark('G13 loaded與兩lookup/export的primitive/reference/hash/render/DOM失效／零晚復活');

  await readOnly('G14 mobile native five fields and sidebar sibling', async () => {
    const result = await submit(admin, week, '', emptyPerson()); assert(result.total > 100); await admin.setViewportSize({ width: 390, height: 844 }); await layout(admin); assert(await content(admin).locator('.shift-calendar-index').isHidden()); await assertFull(admin, week);
    await field(admin, 'caseId').scrollIntoViewIfNeeded(); await field(admin, 'caseId').focus(); assert(await field(admin, 'caseId').evaluate(node => { const r = node.getBoundingClientRect(), footer = node.closest('dialog').querySelector(':scope > .dialog-footer').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && (r.bottom <= footer.top || footer.bottom <= r.top); })); await shot(admin, 'mobile-five-fields-focused-long-options.png');
    const note = content(admin).locator('.shift-calendar-daily-table tbody tr').filter({ hasText: 'CAL-001' }).locator('td').last(); await note.scrollIntoViewIfNeeded(); assert((await note.textContent()).includes('<script>literal & 完整中文🙂</script>')); const region = content(admin).locator('.shift-calendar-daily-table').first(); await region.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert(await region.evaluate(node => node.scrollLeft > 0)); await shot(admin, 'mobile-complete-agenda-own-horizontal-scroll.png');
    await close(admin); const menu = admin.getByRole('button', { name: '選單', exact: true }); await menu.click();
    const navigationDrawer = admin.locator('dialog.navigation-drawer');
    await navigationDrawer.waitFor({ state: 'visible', timeout: 10000 });
    await navigationDrawer.locator('#sidebar').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await menu.getAttribute('aria-expanded'), 'true'); assert(await admin.locator('#sidebar').isVisible()); await shot(admin, 'mobile-sidebar-after-calendar-close.png');
    await admin.locator('#sidebar').getByRole('link', { name: '機構公告', exact: true }).click();
    await navigationDrawer.waitFor({ state: 'detached', timeout: 10000 });
    await admin.getByRole('heading', { name: '內部公告', level: 1, exact: true }).waitFor(); assert.equal(await menu.getAttribute('aria-expanded'), 'false'); assert(await admin.locator('#sidebar').isHidden());
    const row = admin.getByRole('row').filter({ hasText: fixture.announcements.all.title }), read = row.getByRole('button', { name: '閱讀全文', exact: true }); await read.click();
    const sibling = admin.getByRole('dialog', { name: '閱讀公告全文', exact: true }); await sibling.getByRole('button', { name: '我已閱讀本版公告', exact: true }).waitFor(); await layout(admin); await shot(admin, 'mobile-existing-announcement-read-sibling.png');
    await admin.keyboard.press('Escape'); await sibling.waitFor({ state: 'detached' }); assert(await read.evaluate(node => node === document.activeElement));
    await admin.setViewportSize({ width: 1440, height: 1050 }); await open(admin); await enable(admin);
  }); mark('G14 390五欄焦點／長原文全列／表內橫捲／sidebar回復／既有公告唯讀sibling');

  await written('G15 normal API reassigns a synthetic caregiver-only case', async () => {
    const moved = await fixture.patch('shifts', pd.mutableCaregiverShift, { employeeId: fixture.dataset.employees.other.id }, fixture.clients.supervisor); assert.equal(moved.version, pd.mutableCaregiverShift.version + 1);
  });
  await readOnly('G15 real server reassignment changes currently readable case options', async () => {
    for (const role of ['caregiver', 'caregiver2', 'supervisor']) { const page = actors[role].page; await open(page, role); const body = await enable(page), period = oracle('week', await field(page, 'anchor').inputValue()), person = { caseId: '', employeeId: role.startsWith('caregiver') ? fixture.dataset.employees[role === 'caregiver' ? 'own' : 'other'].id : '' }; await assertOptions(page, role); await assertFull(page, period, '', person, role, body);
      const visible = await field(page, 'caseId').locator(`option[value="${pd.mutableCaregiverShift.caseId}"]`).count(); assert.equal(visible, role === 'caregiver' ? 0 : 1); await close(page); serverChecks.push({ role, actualFreshGet: true, reassignedCaseExcludedFromFormerOwner: role === 'caregiver', notClientSimulation: true });
    }
    const foreign = await fixture.request(fixture.clients.caregiver, 'GET', exportPath + '?' + query(week, '', { caseId: fixture.dataset.cases.foreign.id, employeeId: fixture.dataset.employees.own.id })); assert.equal(foreign.status, 404);
    const noAuth = await fetch(base + '/api/cases?page=1&pageSize=100', { headers: { 'X-Org-Id': fixture.orgIds.own } }); assert.equal(noAuth.status, 401);
    const orgDenied = await fixture.request(fixture.clients.supervisor, 'GET', '/api/employees?page=1&pageSize=100', undefined, { 'X-Org-Id': fixture.orgIds.foreign }); assert.equal(orgDenied.status, 403);
    serverChecks.push({ noAuth: 401, foreignId: 404, foreignOrganization: 403, directOwnedHttp: true });
  }); mark('G15 真正常API改派／完整本人名單scope／新本人可讀／401與跨機構拒絕');

  stage = 'final proof'; assert(!timedOut && Date.now() - started <= 1200000); assert.equal(pageErrors.length, 0, 'No product or harness page errors are discarded');
  for (const actual of consoleErrors) assert(expectedConsole.some(expected => expected.url === actual.url && expected.messageSha256 === actual.messageSha256), 'Only exact registered resource errors are accepted');
  for (const actual of negativeResponses) assert(expectedConsole.some(expected => expected.url === actual.url && expected.status === actual.status), 'No unregistered browser failure is suppressed');
  assert.equal(consoleErrors.length, expectedConsole.length);
  const sourcesAfter = await collectSources(); same(sourcesAfter, sourcesBefore, 'Controlled sources remain byte exact throughout execution'); assert.equal(fixture.counts().tableCount, 11); assert.equal(fixture.counts().triggerCount, 6);
  assert.equal(fixture.counts().totalChanges, fixture.ledger.reduce((sum, entry) => sum + entry.changes, 0), 'All setup, imports, login and normal API writes are independently accounted');
  const rawAfter = fixture.rawState(); for (const table of ['attachment_files', 'certification_attachment_files']) same(rawAfter.typedTables[table], rawBefore.typedTables[table], 'All BLOB bytes remain exact');
  for (const entity of ['service-records', 'announcement-reads']) same(rawAfter.tables.record_versions.filter(row => row.entity === entity), rawBefore.tables.record_versions.filter(row => row.entity === entity), 'Approved pricing snapshots and immutable receipts remain exact');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, version: '0.42', checks, screenshots, reportChecks, lookupChecks, malformedChecks, cancellationChecks, contextChecks, serverChecks, readSegments, writeSegments, setupLedger: fixture.ledger, counts: fixture.counts(), requestLedger, pageErrors, consoleErrors, expectedConsole, negativeResponses, sourcesBefore, sourcesAfter, totalElapsedMs: Date.now() - started,
    limits: { actionTimeoutMs: 10000, navigationTimeoutMs: 30000, overallTimeoutMs: 1200000 }, verificationScope: { syntheticRandomLoopbackOnly: true, originalDataOrCredentials: false, allReadSegmentsZeroWrites: true, independentSavedIdOracle: true, noInjectedRouteAbort: true, noAutomaticRetry: true, nativeSelectKeyboardValueVerified: false, nativePopupGeometryVerified: false, fullWcag: false, manualUat: false, ci: false, deployment: false, originalSystemEquivalence: false, pdfGenerated: false } }, null, 2) + '\n');
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, version: '0.42', stage, error: { name: error.name, messageSha256: sha(String(error.message)), stackSha256: sha(String(error.stack)) }, checks, screenshots, reportChecks, lookupChecks, malformedChecks, cancellationChecks, contextChecks, serverChecks, readSegments, writeSegments, requestLedger, pageErrors, consoleErrors, expectedConsole, negativeResponses, sourcesBefore, totalElapsedMs: Date.now() - started, noAutomaticRetry: true }, null, 2) + '\n');
  throw error;
} finally { clearTimeout(watchdog); for (const context of contexts) await context.close().catch(() => {}); await browser?.close().catch(() => {}); await fixture?.close(); }
