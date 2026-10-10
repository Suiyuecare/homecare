import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createShiftCalendarFixture } from './shift-calendar-fixtures.mjs';

// This harness creates only its own synthetic capability, random loopback server and
// Chromium contexts. It never opens the default database or a historical QA tree.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/shift-calendar-e2e');
assert(!existsSync(path.join(output, 'e2e.json')), 'Retain previous attempts before explicitly starting a new run');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert(isDeepStrictEqual(actual, expected), label);
const compareRows = (a, b) => { for (const key of ['date', 'startTime', 'caseNo', 'employeeNo', 'shiftId']) { if (a[key] < b[key]) return -1; if (a[key] > b[key]) return 1; } return 0; };
const visibleKeys = ['date', 'caseNo', 'case', 'employeeNo', 'employee', 'startTime', 'endTime', 'services', 'statusLabel', 'version', 'note'];
const rowKeys = ['shiftId', 'version', 'date', 'caseNo', 'case', 'employeeNo', 'employee', 'startTime', 'endTime', 'services', 'status', 'statusLabel', 'note'];
const weekdays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const exportPattern = '**/api/shift-report/export?*';
const calendarPath = '/api/shift-report/export';
const unconfirmedText = '未取得完整且一致的班表，請重新讀取或調整查詢條件。';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = async (promise, label, ms = 10000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its explicit bound')), ms); })]); } finally { clearTimeout(timer); } };

// Independent UTC Date oracle uses setUTCFullYear rather than Date.UTC(year,...),
// which would reinterpret years 0000..0099. No product date helper is imported.
function oracleDate(text) {
  assert.match(text, /^\d{4}-\d{2}-\d{2}$/);
  const [year, month, day] = text.split('-').map(Number), date = new Date(0);
  date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
  assert.equal(date.toISOString().slice(0, 10), text, 'Oracle input is a real Gregorian date');
  return date;
}
function dateText(date) { const iso = date.toISOString(); return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null; }
function plusDays(date, count) { const next = new Date(date); next.setUTCDate(next.getUTCDate() + count); return next; }
function oracle(mode, anchor) {
  const selected = oracleDate(anchor); let slots, dates, previousAnchor, nextAnchor;
  if (mode === 'week') {
    const monday = plusDays(selected, -(selected.getUTCDay() + 6) % 7);
    slots = Array.from({ length: 7 }, (_, index) => dateText(plusDays(monday, index))); dates = slots.filter(Boolean);
    previousAnchor = dates[0] === '0000-01-01' ? null : dateText(plusDays(monday, -7)) || '0000-01-01';
    nextAnchor = dateText(plusDays(monday, 7));
  } else {
    assert.equal(mode, 'month'); const first = new Date(selected); first.setUTCDate(1);
    const end = new Date(first); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    const start = plusDays(first, -(first.getUTCDay() + 6) % 7);
    slots = Array.from({ length: 42 }, (_, index) => { const date = plusDays(start, index), text = dateText(date); return text && date.getUTCFullYear() === first.getUTCFullYear() && date.getUTCMonth() === first.getUTCMonth() ? text : null; });
    dates = Array.from({ length: end.getUTCDate() }, (_, index) => dateText(plusDays(first, index)));
    const previous = new Date(first); previous.setUTCMonth(previous.getUTCMonth() - 1);
    const next = new Date(first); next.setUTCMonth(next.getUTCMonth() + 1);
    previousAnchor = dateText(previous); nextAnchor = dateText(next);
  }
  return { mode, anchor, slots, dates, startDate: dates[0], endDate: dates.at(-1), previousAnchor, nextAnchor, rangeClipped: mode === 'week' && slots.some(value => value === null) };
}
const filters = (period, status = '') => ({ startDate: period.startDate, endDate: period.endDate, caseId: '', employeeId: '', status });
const query = (period, status = '') => new URLSearchParams(Object.entries(filters(period, status)).filter(([, value]) => value !== '')).toString();
const isExport = request => request.method() === 'GET' && new URL(request.url()).pathname === calendarPath;
const matchesQuery = (request, period, status = '') => isExport(request) && new URL(request.url()).search === '?' + query(period, status);
const taipeiToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());

const checks = [], screenshots = [], calendarChecks = [], contextChecks = [], serverScopeChecks = [], malformedChecks = [], readSegments = [], writeSegments = [], requestLedger = [], pageErrors = [], consoleErrors = [], expectedConsole = [], negativeResponses = [], contexts = [];
let fixture, browser, base, actors, sourceHashesBefore, stage = 'initialization', lastPage, timedOut = false;
const started = Date.now();
const watchdog = setTimeout(() => { timedOut = true; browser?.close().catch(() => {}); }, 1200000);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const collectSources = async () => {
  const names = ['tests/shift-calendar-e2e.mjs', 'tests/shift-calendar-fixtures.mjs', 'tests/announcement-read-receipts-fixtures.mjs', 'tests/synthetic-backup-fixtures.mjs', 'docs/SHIFT_CALENDAR_SCOPE.md'];
  const walk = async directory => { for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else names.push(file); } };
  await walk('public'); await walk('src');
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const readOnly = async (label, work) => { stage = label; const before = fixture.captureRead(); const result = await work(); const after = fixture.assertReadUnchanged(before, label); readSegments.push({ label, before, after, allTypedStateUnchanged: true, totalChangesDelta: 0 }); return result; };
const written = async (label, work) => { stage = label; const before = fixture.counts(); const result = await work(); const after = fixture.counts(); writeSegments.push({ label, before, after, changes: after.totalChanges - before.totalChanges }); return result; };
const observe = page => {
  page.on('pageerror', error => pageErrors.push({ messageSha256: sha(error.message) }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ messageSha256: sha(message.text()), url: message.location().url }); });
  page.on('request', request => { if (isExport(request)) requestLedger.push({ method: request.method(), path: calendarPath, query: new URL(request.url()).search, page: page.url(), headersScopePresent: Boolean(request.headers()['x-org-id']) }); });
  page.on('response', response => { if (response.status() >= 400) negativeResponses.push({ url: response.url(), status: response.status() }); });
};
function expectConsole(url, status) { expectedConsole.push({ url, status, messageSha256: sha(`Failed to load resource: the server responded with a status of ${status} (${STATUS_CODES[status]})`) }); }
const d = page => page.getByRole('dialog', { name: '週／月班表', exact: true });
const content = page => d(page).locator('.shift-calendar');
const field = (page, name) => content(page).locator('form [name="' + name + '"]');
const nav = (page, name) => content(page).locator('.actions').getByRole('button', { name, exact: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  assert.equal(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).length), 0, 'Visible fields have accessible labels');
  if (await d(page).count()) assert(await d(page).evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog remains within viewport');
  for (const region of await d(page).locator('.table-scroll').all()) if (await region.isVisible()) assert.equal(await region.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => { if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 }); await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push({ name, path: path.join(output, name), sha256: sha(await readFile(path.join(output, name))) }); };
const load = async (page, role = 'admin') => {
  lastPage = page; const route = role === 'caregiver' || role === 'caregiver2' ? '/my-services' : '/shifts';
  const target = `${base}/#${route}`; if (page.url() === target) await page.reload(); else await page.goto(target); await page.getByRole('heading', { level: 1, name: route === '/shifts' ? '班表' : '我的服務', exact: true }).waitFor();
  await page.getByRole('button', { name: '週／月班表', exact: true }).waitFor();
};
const open = async (page, role = 'admin') => { await load(page, role); const trigger = page.getByRole('button', { name: '週／月班表', exact: true }); const response = page.waitForResponse(value => isExport(value.request())); response.catch(() => {}); await trigger.click(); const reply = await response; assert.equal(reply.status(), 200); await content(page).locator('.shift-calendar-agenda').waitFor(); return { trigger, result: await reply.json() }; };
const close = async (page, trigger, method = 'escape') => { if (method === 'button') await d(page).locator('.dialog-footer').getByRole('button', { name: '關閉', exact: true }).click(); else await page.keyboard.press('Escape'); await d(page).waitFor({ state: 'detached' }); if (trigger && await trigger.count() && await trigger.evaluate(node => node.isConnected)) assert(await trigger.evaluate(node => document.activeElement === node), 'Close restores triggering focus'); };
const setDraft = async (page, mode, anchor, status = '') => { await field(page, 'mode').selectOption(mode); await field(page, 'anchor').fill(anchor); await field(page, 'status').selectOption(status); };
const submit = async (page, mode, anchor, status = '', expectedStatus = 200) => {
  await setDraft(page, mode, anchor, status); const period = oracle(mode, anchor);
  const response = page.waitForResponse(value => matchesQuery(value.request(), period, status));
  await content(page).getByRole('button', { name: '查詢班表', exact: true }).click();
  const reply = await response; assert.equal(reply.status(), expectedStatus); await content(page).waitFor();
  if (expectedStatus === 200) await content(page).locator('.shift-calendar-agenda').waitFor(); else await content(page).locator('.error-state').waitFor();
  return { period, result: await reply.json(), status };
};
async function assertFull(page, period, status = '', role = 'admin', returned) {
  const real = await fixture.request(fixture.clients[role], 'GET', calendarPath + '?' + query(period, status));
  assert.equal(real.status, 200); const result = real.body;
  assert.equal(Object.keys(result).length, 12); same(result.filters, filters(period, status), 'Exactly the full interval and fixed empty IDs are requested');
  assert.equal(result.rows.length, result.total); assert.equal(result.page, 1); assert.equal(result.pageSize, result.total); assert.equal(result.totals.count, result.total);
  same(result.columns.map(column => column.key), visibleKeys, 'Eleven original visible columns');
  for (const row of result.rows) same(Object.keys(row).sort(), [...rowKeys].sort(), 'Thirteen persisted projection keys');
  if (returned) same(returned.rows, result.rows, 'Browser loaded the complete real server response');
  const actual = await content(page).locator('.shift-calendar-agenda').evaluate(node => [...node.querySelectorAll(':scope > section[data-date]')].map(section => ({
    date: section.dataset.date, heading: section.querySelector('h3').textContent, tabIndex: section.querySelector('h3').tabIndex,
    empty: section.querySelector('p')?.textContent || null,
    headers: [...section.querySelectorAll('thead th')].map(th => ({ text: th.textContent, scope: th.scope })),
    rows: [...section.querySelectorAll('tbody tr')].map(row => ({ id: row.dataset.shiftId, values: [...row.children].map(td => td.textContent), preWrap: [...row.querySelectorAll('span.pre-wrap')].map(span => getComputedStyle(span).whiteSpace) })),
  })));
  same(actual.map(day => day.date), period.dates, 'Every available day appears exactly once, including empty days');
  const allIds = [];
  for (const day of actual) {
    const rows = result.rows.filter(row => row.date === day.date), weekDay = weekdays[(oracleDate(day.date).getUTCDay() + 6) % 7];
    assert.equal(day.heading, `${day.date}（${weekDay}）・共 ${rows.length} 班次`); assert.equal(day.tabIndex, -1);
    same(day.rows.map(row => row.id), rows.map(row => row.shiftId), 'Daily row ID/order equals the complete API');
    if (!rows.length) assert.equal(day.empty, '此日沒有班次。');
    else {
      same(day.headers, result.columns.map(column => ({ text: column.label, scope: 'col' })), 'Semantic table headers retain the report labels');
      for (let i = 0; i < rows.length; i++) { same(day.rows[i].values, visibleKeys.map(key => String(rows[i][key])), 'All eleven raw displayed values remain exact literal strings'); assert(day.rows[i].preWrap.every(value => value === 'pre-wrap')); }
    }
    allIds.push(...day.rows.map(row => row.id));
  }
  same(allIds, result.rows.map(row => row.shiftId), 'One complete agenda contains every raw row exactly once'); assert.equal(new Set(allIds).size, result.total);
  const index = await content(page).locator('.shift-calendar-index table').evaluate(table => ({ headers: [...table.querySelectorAll('thead th')].map(th => ({ text: th.textContent, scope: th.scope })), rows: table.tBodies[0].rows.length, slots: [...table.tBodies[0].querySelectorAll('td')].map(td => td.querySelector('button')?.querySelector('span')?.textContent || null), invalidButtons: [...table.querySelectorAll('.shift-calendar-unavailable button')].length }));
  same(index.headers, weekdays.map(text => ({ text, scope: 'col' }))); assert.equal(index.rows, period.mode === 'week' ? 1 : 6); same(index.slots, period.slots); assert.equal(index.invalidButtons, 0);
  assert.equal(await nav(page, '上一期').isDisabled(), period.previousAnchor === null); assert.equal(await nav(page, '下一期').isDisabled(), period.nextAnchor === null);
  assert.equal(await content(page).locator('script,img').count(), 0, 'HTML-looking saved text is never executed or inserted as markup');
  calendarChecks.push({ mode: period.mode, anchor: period.anchor, status, role, startDate: period.startDate, endDate: period.endDate, slots: period.slots.length, availableDates: period.dates.length, rows: result.total, rawRowsSha256: sha(JSON.stringify(result.rows)), realFreshGet: true, agendaExactlyOnce: true, visibleColumns: 11, rowKeys: 13 });
  return result;
}
const slowRoute = async (page, predicate = isExport) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false;
  const handler = async route => { if (used || !predicate(route.request())) return route.continue(); used = true; try { const response = await route.fetch({ timeout: 10000 }); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } };
  await page.route(exportPattern, handler);
  return { arrived: arrived.promise, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'Late route release'); await page.unroute(exportPattern, handler); } };
};
const mutateContext = async (page, kind) => page.evaluate(async ({ kind, foreign }) => {
  const ui = await import('/ui.js'), current = ui.getContext(), source = document.querySelector('[data-render-version]');
  const dialog = [...document.querySelectorAll('dialog[open]')].find(node => document.getElementById(node.getAttribute('aria-labelledby'))?.textContent === '週／月班表');
  if (!dialog?.open || !source?.isConnected) throw new Error('Synthetic context mutation requires its open calendar and connected source');
  const keys = ['userId', 'organizationId', 'role', 'employeeId'];
  const identity = context => JSON.parse(JSON.stringify([context.user?.id, context.organizationId, context.role, context.user?.employeeId]));
  const beforeValues = identity(current), beforeHash = location.hash, beforeStamp = source.dataset.renderVersion, beforeConnected = source.isConnected;
  const wakeObserver = () => { const marker = document.createComment('synthetic-calendar-context-observer-wakeup'); document.body.append(marker); marker.remove(); };
  wakeObserver(); await new Promise(resolve => requestAnimationFrame(resolve));
  const controlContext = ui.getContext(), controlValues = identity(controlContext);
  const wakeupControlPassed = dialog.isConnected && dialog.open && controlContext === current
    && JSON.stringify(controlValues) === JSON.stringify(beforeValues) && location.hash === beforeHash
    && source.dataset.renderVersion === beforeStamp && source.isConnected === beforeConnected;
  if (!wakeupControlPassed) throw new Error('Observer wakeup alone must preserve the open calendar and original context');
  if (kind === 'user') current.user.id = 'synthetic-calendar-replaced-user';
  else if (kind === 'logout') current.user = null;
  else if (kind === 'org') { current.organizationId = foreign; current.orgId = foreign; }
  else if (kind === 'role') current.role = 'finance';
  else if (kind === 'employee') current.user.employeeId = 'synthetic-calendar-replaced-employee';
  else if (kind === 'context-ref') {
    const session = { ...current, user: current.user && { ...current.user }, organizations: current.organizations.map(org => ({ ...org })) };
    ui.setContext(session, current.organizationId);
  } else if (kind === 'hash') location.hash = '/employees';
  else if (kind === 'render') source.dataset.renderVersion = crypto.randomUUID();
  else if (kind === 'disconnect') source.remove();
  else throw new Error('Unknown synthetic context mutation');
  const afterContext = ui.getContext(), afterValues = identity(afterContext);
  const changedIdentityFields = keys.filter((key, index) => beforeValues[index] !== afterValues[index]);
  const refStayedSame = afterContext === current, sameIdentity = changedIdentityFields.length === 0;
  const hashStayedSame = location.hash === beforeHash, stampStayedSame = source.dataset.renderVersion === beforeStamp, connectedStayedSame = source.isConnected === beforeConnected;
  const changedDimensions = [!refStayedSame && 'reference', !sameIdentity && 'identity', !hashStayedSame && 'hash', !stampStayedSame && 'stamp', !connectedStayedSame && 'connected'].filter(Boolean);
  const expectedField = { user: 'userId', logout: 'userId', org: 'organizationId', role: 'role', employee: 'employeeId' }[kind];
  const hashStampAndConnectedPreserved = hashStayedSame && stampStayedSame && connectedStayedSame;
  const proof = {
    wakeupControlPassed, refStayedSame, changedIdentityFields, changedDimensions,
    identityChangedOnly: Boolean(expectedField) && refStayedSame && changedIdentityFields.length === 1 && changedIdentityFields[0] === expectedField && hashStampAndConnectedPreserved,
    referenceChangedWithSameIdentity: kind === 'context-ref' && !refStayedSame && sameIdentity && hashStampAndConnectedPreserved,
    hashStampAndConnectedPreserved,
    beforeIdentity: Object.fromEntries(keys.map((key, index) => [key, beforeValues[index]])),
    afterIdentity: Object.fromEntries(keys.map((key, index) => [key, afterValues[index]])),
    observerWakeupOnly: true, sessionUpdatedDispatched: false,
  };
  wakeObserver(); return proof;
}, { kind, foreign: fixture.orgIds.foreign });

await mkdir(output, { recursive: true });
try {
  sourceHashesBefore = await collectSources(); fixture = await createShiftCalendarFixture(); base = fixture.base;
  assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310'); assert.equal(fixture.counts().tableCount, 11); assert.equal(fixture.counts().triggerCount, 6);
  const raw = fixture.rawState();
  for (const table of ['attachment_files', 'certification_attachment_files']) assert(raw.typedTables[table].rows.flat().some(value => value[0] === 'blob' && value[1].length > 0), 'Both original BLOB families are nonempty');
  assert(raw.tables.record_versions.some(row => row.entity === 'service-records' && JSON.parse(row.snapshot).billingSnapshot));
  assert(raw.tables.record_versions.some(row => row.entity === 'announcement-reads' && row.version === 1));
  const baselinePreserved = { blobFamilies: 2, billingSnapshotPresent: true, immutableReceiptPresent: true, schemaTables: 11, immutableTriggers: 6, initialTypedStateSha256: fixture.captureRead().digest };
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright'), installed = await readdir(cache).catch(() => []);
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); actors = {};
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver', 'caregiver2']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context);
    context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(30000);
    const cookie = fixture.clients[role].cookie, equal = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, equal), value: cookie.slice(equal + 1), url: base }]);
    const page = await context.newPage(); observe(page); actors[role] = { page, context };
  }
  const admin = actors.admin.page, supervisor = actors.supervisor.page, caregiver = actors.caregiver.page;
  const week = oracle('week', fixture.dataset.weekAnchor), month = oracle('month', fixture.dataset.monthAnchor);

  await readOnly('G1 兩頁三角色入口／default臺北週／finance無新入口', async () => {
    for (const role of ['admin', 'supervisor', 'caregiver']) {
      const beforeToday = taipeiToday(), page = actors[role].page, opened = await open(page, role), afterToday = taipeiToday();
      assert.equal(await field(page, 'mode').inputValue(), 'week');
      const anchor = await field(page, 'anchor').inputValue(); assert([beforeToday, afterToday].includes(anchor)); assert.equal(await field(page, 'anchor').getAttribute('type'), 'text');
      assert.equal(await field(page, 'status').inputValue(), ''); await assertFull(page, oracle('week', anchor), '', role, opened.result);
      if (role === 'supervisor') await shot(page, 'supervisor-default-week.png'); await close(page, opened.trigger);
    }
    const finance = actors.finance.page; await finance.goto(`${base}/#/`); await finance.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await finance.getByRole('button', { name: '週／月班表', exact: true }).count(), 0);
    await finance.evaluate(async () => { const module = await import('/modules/shift-calendar.js'); await module.openShiftCalendar(); }); assert.equal(await d(finance).count(), 0);
  }); mark('G1 兩頁入口／三允許角色／財務無入口／臺北今天週與原生欄位');

  await readOnly('G2 完整週126以上與原字串十一欄', async () => { await open(admin); const loaded = await submit(admin, 'week', week.anchor); const result = await assertFull(admin, week, '', 'admin', loaded.result); assert(result.total > 100 && result.total > 25); assert(!result.rows.some(row => row.shiftId === fixture.dataset.foreignShift.id)); assert(result.rows.some(row => row.startTime.endsWith('+14:00'))); assert(result.rows.some(row => row.startTime.endsWith('Z'))); assert(result.rows.some(row => row.startTime === '08:15')); await shot(admin, 'desktop-complete-week.png'); }); mark('G2 真完整>100／不拼分頁／原時間HTML備註字串／外機構不洩漏');

  await readOnly('G3 完整月42格／index同DOM跳日／keyboard焦點', async () => {
    await setDraft(admin, 'month', month.anchor); assert.equal(await field(admin, 'anchor').inputValue(), month.anchor);
    const loaded = await submit(admin, 'month', month.anchor), result = await assertFull(admin, month, '', 'admin', loaded.result); assert(result.total > 100);
    const requestsBefore = requestLedger.length, hashBefore = new URL(admin.url()).hash;
    const targetDate = '2026-10-05', count = result.rows.filter(row => row.date === targetDate).length;
    const indexButton = content(admin).getByRole('button', { name: `查看 ${targetDate} 週一，共 ${count} 班次`, exact: true }); await indexButton.focus(); await admin.keyboard.press('Enter');
    const heading = content(admin).locator(`.shift-calendar-agenda section[data-date="${targetDate}"] h3`); assert(await heading.evaluate(node => document.activeElement === node)); assert.equal(requestLedger.length, requestsBefore); assert.equal(new URL(admin.url()).hash, hashBefore);
    await field(admin, 'mode').focus(); await admin.keyboard.press('Tab'); assert(await field(admin, 'anchor').evaluate(node => node === document.activeElement));
    for (const name of ['mode', 'anchor', 'status']) {
      const control = field(admin, name), id = await control.getAttribute('id');
      await content(admin).locator(`label[for="${id}"]`).click();
      assert(await control.evaluate(node => document.activeElement === node), 'Clicking the actual label focuses its native field');
    }
    assert.equal(await field(admin, 'mode').evaluate(node => node.tagName), 'SELECT');
    assert.equal(await field(admin, 'status').evaluate(node => node.tagName), 'SELECT');
    // Literal private probes retained trusted key events but no native SELECT
    // input/change in this headless environment. They are a recorded limitation,
    // not a passed keyboard selection or native popup geometry assertion.
    assert.equal(await field(admin, 'mode').inputValue(), 'month');
    assert.equal(await field(admin, 'status').inputValue(), '');
    await field(admin, 'anchor').focus();
    await admin.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await admin.keyboard.type(month.anchor);
    assert.equal(await field(admin, 'anchor').inputValue(), month.anchor, 'Real keyboard date input preserves the exact typed anchor');
    await content(admin).getByText('條件已變更，請查詢班表。', { exact: true }).waitFor();
    assert.equal(requestLedger.length, requestsBefore, 'Actual keyboard date input remains draft until explicit query');
    const refreshed = admin.waitForResponse(value => matchesQuery(value.request(), month));
    const queryButton = content(admin).getByRole('button', { name: '查詢班表', exact: true });
    await queryButton.focus(); assert(await queryButton.evaluate(node => node === document.activeElement));
    await admin.keyboard.press('Enter'); const refreshedReply = await refreshed;
    assert.equal(refreshedReply.status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor();
    await assertFull(admin, month, '', 'admin', await refreshedReply.json());
    await shot(admin, 'desktop-complete-month.png');
  }); mark('G3 月42格全agenda／同DOM索引／label焦點／真日期鍵盤與Enter和Tab');

  await readOnly('G4 previous／next月初週初／today保留mode與status', async () => {
    let response = admin.waitForResponse(value => matchesQuery(value.request(), oracle('month', '2026-09-01'))); await nav(admin, '上一期').click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); assert.equal(await field(admin, 'anchor').inputValue(), '2026-09-01'); await assertFull(admin, oracle('month', '2026-09-01'));
    response = admin.waitForResponse(value => matchesQuery(value.request(), oracle('month', '2026-10-01'))); await nav(admin, '下一期').click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, oracle('month', '2026-10-01'));
    await submit(admin, 'week', week.anchor); response = admin.waitForResponse(value => matchesQuery(value.request(), oracle('week', '2026-09-28'))); await nav(admin, '上一期').click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); assert.equal(await field(admin, 'anchor').inputValue(), '2026-09-28');
    response = admin.waitForResponse(value => matchesQuery(value.request(), oracle('week', '2026-10-05'))); await nav(admin, '下一期').click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, oracle('week', '2026-10-05'));
    await setDraft(admin, 'month', month.anchor, 'cancelled'); const today = taipeiToday(), todayPeriod = oracle('month', today); response = admin.waitForResponse(value => matchesQuery(value.request(), todayPeriod, 'cancelled')); await nav(admin, '今天').click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, todayPeriod, 'cancelled');
  }); mark('G4 翻週月／週初月初／Today沿draft mode與status');

  await readOnly('G5 0000／0099／400年閏日／9999邊界', async () => {
    for (const [mode, anchor] of [['week', '0000-01-01'], ['month', '0000-01-01'], ['month', '0000-02-29'], ['week', '0099-12-31'], ['month', '1900-02-28'], ['month', '2000-02-29'], ['month', '2100-02-28'], ['week', '9999-12-31'], ['month', '9999-12-31']]) {
      const loaded = await submit(admin, mode, anchor); await assertFull(admin, loaded.period, '', 'admin', loaded.result);
      if (loaded.period.rangeClipped) await content(admin).getByText('本週跨越支援日期邊界；不可用日期留空，只查詢 0000 至 9999 年內的日期。', { exact: true }).waitFor();
      if (anchor === '0000-01-01' && mode === 'week') await shot(admin, 'year-zero-clipped-week.png');
      if (mode === 'month' && anchor === '9999-12-31') await shot(admin, 'year-9999-final-month.png');
    }
  }); mark('G5 獨立UTC完整四位日期oracle／0000與0099／閏年／9999／null slots');

  await readOnly('G6 draft立即清空／錯欄aria與focus／today空mode fallback', async () => {
    await submit(admin, 'week', week.anchor); const before = requestLedger.length; await field(admin, 'anchor').fill('0099-02-29');
    await content(admin).getByText('條件已變更，請查詢班表。', { exact: true }).waitFor(); assert.equal(await content(admin).locator('.shift-calendar-agenda,.shift-calendar-index').count(), 0); for (const name of ['上一期', '下一期', '重新讀取']) assert(await nav(admin, name).isDisabled()); assert.equal(requestLedger.length, before);
    await content(admin).getByRole('button', { name: '查詢班表', exact: true }).click(); await content(admin).locator('.form-summary[role="alert"]:visible').waitFor(); const anchor = field(admin, 'anchor'); assert.equal(await anchor.getAttribute('aria-invalid'), 'true'); assert(await anchor.evaluate(node => document.activeElement === node)); assert.equal(await anchor.inputValue(), '0099-02-29'); assert.equal(requestLedger.length, before);
    await setDraft(admin, '', week.anchor, 'scheduled'); await content(admin).getByRole('button', { name: '查詢班表', exact: true }).click(); await content(admin).locator('.form-summary[role="alert"]:visible').waitFor(); assert.equal(await field(admin, 'mode').getAttribute('aria-invalid'), 'true'); assert.equal(requestLedger.length, before);
    const today = taipeiToday(), response = admin.waitForResponse(value => matchesQuery(value.request(), oracle('week', today), 'scheduled')); await nav(admin, '今天').click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, oracle('week', today), 'scheduled');
  }); mark('G6 不自動查／draft撤銷／無效日期模式ariafocus／Today合法fallback');

  await readOnly('G7 真空期完整零筆而非錯誤假空', async () => { const loaded = await submit(admin, 'week', fixture.dataset.emptyAnchor); const result = await assertFull(admin, loaded.period, '', 'admin', loaded.result); assert.equal(result.total, 0); assert.equal(await content(admin).locator('.error-state').count(), 0); assert.equal(await content(admin).getByText('此日沒有班次。', { exact: true }).count(), 7); await shot(admin, 'confirmed-empty-week.png'); }); mark('G7 真GET空期／七日零筆／完整條件保留');

  await readOnly('G8 合成503保留draft與fresh retry', async () => {
    let used = false; const handler = async route => { if (!used && matchesQuery(route.request(), week, 'completed')) { used = true; expectConsole(route.request().url(), 503); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成班表暫時無法使用' } }) }); } return route.continue(); };
    await admin.route(exportPattern, handler);
    try { await submit(admin, 'week', week.anchor, 'completed', 503); await content(admin).getByText('合成班表暫時無法使用', { exact: true }).waitFor(); assert.equal(await content(admin).locator('.shift-calendar-agenda').count(), 0); assert.equal(await field(admin, 'anchor').inputValue(), week.anchor); assert.equal(await field(admin, 'status').inputValue(), 'completed'); await shot(admin, 'unavailable-kept-filters.png'); const response = admin.waitForResponse(value => matchesQuery(value.request(), week, 'completed')); await content(admin).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true }).click(); assert.equal((await response).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, week, 'completed'); }
    finally { await admin.unroute(exportPattern, handler); }
  }); mark('G8 503錯誤不假空／三欄保留／手動fresh GET成功');

  await readOnly('G9 十種malformed2xx全部拒絕且手動fresh讀取', async () => {
    const mutations = [
      ['unknown-envelope-key', result => ({ ...result, extra: true })],
      ['missing-row-key', result => { delete result.rows[0].note; return result; }],
      ['partial-page', result => ({ ...result, rows: result.rows.slice(0, 25), pageSize: 25 })],
      ['duplicate-id', result => { result.rows[1].shiftId = result.rows[0].shiftId; return result; }],
      ['unsorted', result => ({ ...result, rows: result.rows.toReversed() })],
      ['wrong-range-date', result => { result.rows[0].date = '2026-10-12'; return result; }],
      ['unsafe-version', result => { result.rows[0].version = Number.MAX_SAFE_INTEGER + 1; return result; }],
      ['wrong-filter-echo', result => { result.filters.status = 'completed'; return result; }],
      ['1001-rows', result => { result.rows = Array.from({ length: 1001 }, () => ({ ...result.rows[0], shiftId: randomUUID() })).sort(compareRows); result.total = result.pageSize = result.totals.count = 1001; return result; }],
      ['over-2MiB', result => { result.rows[0].note = '界'.repeat(700000); return result; }],
    ];
    for (const [label, change] of mutations) {
      let used = false; const handler = async route => { if (used || !matchesQuery(route.request(), week)) return route.continue(); used = true; const response = await route.fetch({ timeout: 10000 }), body = change(await response.json()); malformedChecks.push({ label, mock2xx: true, bodySha256: sha(JSON.stringify(body)), bytes: Buffer.byteLength(JSON.stringify(body)) }); return route.fulfill({ response, json: body }); };
      await admin.route(exportPattern, handler);
      try {
        await setDraft(admin, 'week', week.anchor); const response = admin.waitForResponse(value => matchesQuery(value.request(), week)); await content(admin).getByRole('button', { name: '查詢班表', exact: true }).click(); assert.equal((await response).status(), 200);
        await content(admin).getByText(unconfirmedText, { exact: true }).waitFor(); assert.equal(await content(admin).locator('.shift-calendar-agenda,.shift-calendar-index').count(), 0); assert.equal(await field(admin, 'anchor').inputValue(), week.anchor);
        if (label === 'over-2MiB') await shot(admin, 'malformed-response-no-agenda.png');
        const retry = admin.waitForResponse(value => matchesQuery(value.request(), week)); await content(admin).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true }).click(); assert.equal((await retry).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, week);
      } finally { await admin.unroute(exportPattern, handler); }
    }
  }); mark('G9 非法2xx／分頁重複排序版次echo／1001與2MiB不假空');

  await readOnly('G10 共用15秒timeout真Abort／保留條件／fresh retry', async () => {
    await setDraft(admin, 'week', week.anchor, 'scheduled'); const slow = await slowRoute(admin, request => matchesQuery(request, week, 'scheduled'));
    const failed = admin.waitForEvent('requestfailed', { predicate: request => matchesQuery(request, week, 'scheduled'), timeout: 30000 });
    try { await content(admin).getByRole('button', { name: '查詢班表', exact: true }).click(); await bounded(slow.arrived, 'Timeout fixture arrival'); await d(admin).getByText('正在讀取完整週／月班表…', { exact: true }).waitFor(); const request = await failed; assert(/abort|cancel|failed/i.test(request.failure()?.errorText || '')); await content(admin).getByText('連線逾時，請保留輸入內容並重試。', { exact: true }).waitFor({ timeout: 30000 }); assert.equal(await content(admin).locator('.shift-calendar-agenda').count(), 0); assert.equal(await field(admin, 'status').inputValue(), 'scheduled'); await slow.finish(); const retry = admin.waitForResponse(value => matchesQuery(value.request(), week, 'scheduled')); await content(admin).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true }).click(); assert.equal((await retry).status(), 200); await content(admin).locator('.shift-calendar-agenda').waitFor(); await assertFull(admin, week, 'scheduled'); }
    finally { await slow.finish(); }
  }); mark('G10 真共用timeout先Abort再釋放／同條件retry／沒有假成功');

  await readOnly('G11 pendingClose與Escape真取消／serialbusy／晚回應不復活', async () => {
    for (const method of ['escape', 'button']) {
      await submit(admin, 'week', week.anchor); const slow = await slowRoute(admin), before = requestLedger.length;
      try {
        await nav(admin, '重新讀取').evaluate(node => { node.click(); node.click(); node.click(); }); await bounded(slow.arrived, 'Pending arrival'); await d(admin).getByText('正在讀取完整週／月班表…', { exact: true }).waitFor(); assert.equal(await d(admin).locator('form').count(), 0); assert.equal(requestLedger.length - before, 1, 'Busy shared reload rejects repeated requests'); assert(await d(admin).locator('.dialog-footer').getByRole('button', { name: '關閉', exact: true }).isEnabled()); if (method === 'escape') await shot(admin, 'pending-owned-cancellation.png');
        // Observe only after setup/arrival/screenshot, immediately before cancellation.
        const failed = admin.waitForEvent('requestfailed', { predicate: isExport, timeout: 10000 }); await close(admin, undefined, method); const request = await failed; assert(/abort|cancel|failed/i.test(request.failure()?.errorText || '')); await slow.finish(); await settle(admin); assert.equal(await d(admin).count(), 0);
      } finally { await slow.finish(); }
      await open(admin);
    }
  }); mark('G11 pending只Close/Escape／表單移除／busy零額外query／late不復活');

  await readOnly('G12 loaded與pending完整context撤銷', async () => {
    for (const state of ['loaded', 'pending']) for (const kind of ['user', 'logout', 'org', 'role', 'employee', 'hash', 'render', 'disconnect', 'context-ref']) {
      await open(admin); let slow;
      try {
        if (state === 'pending') { slow = await slowRoute(admin); await nav(admin, '重新讀取').click(); await bounded(slow.arrived, 'Context pending arrival'); await d(admin).getByText('正在讀取完整週／月班表…', { exact: true }).waitFor(); }
        const failed = state === 'pending' ? admin.waitForEvent('requestfailed', { predicate: isExport, timeout: 10000 }) : undefined;
        const requestsBefore = requestLedger.length, mutationProof = await mutateContext(admin, kind);
        assert(mutationProof.wakeupControlPassed, 'An unchanged context survives the exact same observer wakeup');
        assert.equal(requestLedger.length, requestsBefore, 'Context-only mutation issues no extra calendar GET');
        if (['user', 'logout', 'org', 'role', 'employee'].includes(kind)) {
          assert(mutationProof.refStayedSame && mutationProof.identityChangedOnly && mutationProof.hashStampAndConnectedPreserved, 'One original primitive identity field changes while reference hash stamp and connection stay fixed');
          same(mutationProof.changedDimensions, ['identity'], 'Primitive identity and canonical-reference guards are isolated');
        } else if (kind === 'context-ref') {
          assert(mutationProof.referenceChangedWithSameIdentity && mutationProof.hashStampAndConnectedPreserved, 'Only the canonical reference changes while the exact four identity values stay fixed');
          same(mutationProof.changedDimensions, ['reference'], 'Reference invalidation is isolated from primitive identity');
        } else {
          assert(mutationProof.refStayedSame); same(mutationProof.changedIdentityFields, [], 'Hash stamp and connection fixtures leave all four identity fields intact');
          same(mutationProof.changedDimensions, [kind === 'render' ? 'stamp' : kind === 'disconnect' ? 'connected' : 'hash'], 'Only the requested DOM or hash dimension changes');
        }
        await d(admin).waitFor({ state: 'detached' }); if (failed) { const request = await failed; assert(/abort|cancel|failed/i.test(request.failure()?.errorText || '')); }
        if (slow) await slow.finish(); await settle(admin); assert.equal(await d(admin).count(), 0); assert.equal(await admin.locator('.shift-calendar').count(), 0);
        contextChecks.push({ state, kind, ...mutationProof, clientFixtureOnly: true, closedAndCleared: true, actualAbortBeforeRelease: state === 'pending', noLateResurrection: true });
      } finally { if (slow) await slow.finish(); }
    }
  }); mark('G12 九種loaded＋pending identity/reference/hash/stamp/DOM撤銷');

  await written('G13 合成正常API改派', async () => {
    const moved = await fixture.patch('shifts', fixture.dataset.mutableShift, { employeeId: fixture.dataset.employees.other.id }, fixture.clients.supervisor); assert.equal(moved.version, fixture.dataset.mutableShift.version + 1);
  });
  await readOnly('G13 真server改派後fresh本人排除／新本人版本', async () => {
    for (const role of ['caregiver', 'caregiver2', 'supervisor']) {
      const page = actors[role].page; await open(page, role); const loaded = await submit(page, 'month', month.anchor), result = await assertFull(page, month, '', role, loaded.result), moved = result.rows.find(row => row.shiftId === fixture.dataset.mutableShift.id);
      if (role === 'caregiver') assert.equal(moved, undefined); else { assert(moved); assert.equal(moved.version, fixture.dataset.mutableShift.version + 1); assert.equal(moved.employeeNo, fixture.dataset.employees.other.employeeNo); }
      if (role === 'caregiver') await shot(page, 'caregiver-complete-own-month.png'); await close(page); serverScopeChecks.push({ role, actualFreshServerGet: true, reassignedFormerOwnerExcluded: role === 'caregiver', newSavedVersion: role !== 'caregiver' });
    }
  }); mark('G13 真API正常改派／fresh本人scope／新版本原員編');

  await written('G14 合成inactive與membership撤權', async () => { await fixture.patch('employees', fixture.dataset.employees.own, { status: 'inactive' }); fixture.recordOwnedMutation('browser-calendar-explicit-owned-supervisor-membership-removal', () => fixture.app.db.prepare('DELETE FROM memberships WHERE user_id=? AND org_id=?').run(fixture.clients.supervisor.user.id, fixture.orgIds.own)); });
  await readOnly('G14 server撤權拒絕與零寫獨立於clientfixtures', async () => {
    const inactive = await fixture.request(fixture.clients.caregiver, 'GET', calendarPath + '?' + query(week)); assert.equal(inactive.status, 403); assert.equal(inactive.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
    const revoked = await fixture.request(fixture.clients.supervisor, 'GET', calendarPath + '?' + query(week)); assert.equal(revoked.status, 403); assert.equal(revoked.body.error.code, 'ORG_FORBIDDEN');
    const finance = await fixture.request(fixture.clients.finance, 'GET', calendarPath + '?' + query(week)); assert.equal(finance.status, 200);
    serverScopeChecks.push({ inactive: { status: inactive.status, code: inactive.body.error.code }, revokedMembership: { status: revoked.status, code: revoked.body.error.code }, financeExistingApiStatus: finance.status, directOwnedHttpProof: true, notClientSimulation: true });
  }); mark('G14 真inactive與membership403／GET零寫／財務舊API保持');

  await written('G15 合成1001與UTF8超限完整INSERT-only資料', async () => { fixture.importShifts(Array.from({ length: 1001 }, (_, index) => fixture.dataset.shiftData({ date: '2027-04-15', note: 'CAL-BROWSER-LIMIT-' + index })), { label: 'browser-calendar-1001-complete-owned-rows' }); fixture.importShifts([fixture.dataset.shiftData({ date: '2027-05-15', note: '界'.repeat(700000) })], { label: 'browser-calendar-over-2MiB-complete-owned-row' }); });
  await readOnly('G15 真server完整上限413／不顯示部分或空／調整query恢复', async () => {
    await open(admin);
    for (const anchor of ['2027-04-15', '2027-05-15']) {
      const period = oracle('week', anchor), url = base + calendarPath + '?' + query(period); expectConsole(url, 413); const loaded = await submit(admin, 'week', anchor, '', 413); assert.equal(loaded.result.error.code, 'REPORT_TOO_LARGE'); assert.equal(await content(admin).locator('.shift-calendar-agenda,.shift-calendar-index').count(), 0); assert.equal(await field(admin, 'anchor').inputValue(), anchor);
      if (anchor === '2027-04-15') await shot(admin, 'real-server-413-kept-filters.png');
      // Same-condition fresh retry remains a real rejection, rather than a fake empty.
      expectConsole(url, 413); const retry = admin.waitForResponse(value => matchesQuery(value.request(), period)); await content(admin).locator('.error-state').getByRole('button', { name: '重新讀取', exact: true }).click(); assert.equal((await retry).status(), 413); await content(admin).locator('.error-state').waitFor(); assert.equal(await content(admin).locator('.shift-calendar-agenda').count(), 0);
    }
    const restored = await submit(admin, 'month', month.anchor); await assertFull(admin, month, '', 'admin', restored.result);
  }); mark('G15 真1001／2MiB413／保留條件fresh拒絕／合法重查恢復');

  await readOnly('G16 1440與390同完整agenda／長literalprewrap／footer焦點', async () => {
    await admin.setViewportSize({ width: 390, height: 844 }); await layout(admin); assert(await content(admin).locator('.shift-calendar-index').isHidden()); await assertFull(admin, month);
    const note = content(admin).locator('.shift-calendar-daily-table tbody tr').filter({ hasText: 'CAL-001' }).locator('td').last(); assert((await note.textContent()).includes('<script>literal & 完整中文🙂</script>')); assert((await note.textContent()).endsWith('合成很長交班原文 ')); await note.scrollIntoViewIfNeeded();
    const region = content(admin).locator('.shift-calendar-daily-table').first(); assert.equal(await region.evaluate(node => getComputedStyle(node).overflowX), 'auto'); assert(await region.evaluate(node => node.scrollWidth >= node.clientWidth)); await shot(admin, 'mobile-complete-literal-agenda.png');
    await field(admin, 'anchor').focus(); await field(admin, 'anchor').scrollIntoViewIfNeeded(); assert(await field(admin, 'anchor').evaluate(node => { const r = node.getBoundingClientRect(), footer = node.closest('dialog').querySelector(':scope > .dialog-footer').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && (r.bottom <= footer.top || footer.bottom <= r.top); }), 'Footer does not cover focused field'); await shot(admin, 'mobile-keyboard-form-focus.png');
    await admin.setViewportSize({ width: 1440, height: 1050 }); assert(await content(admin).locator('.shift-calendar-index').isVisible()); await layout(admin); await close(admin);
  }); mark('G16 390單一完整agenda／無文件overflow／自身table捲動／literal尾文與焦點');

  stage = 'final proof'; assert(!timedOut && Date.now() - started <= 1200000, 'Overall browser run stays within its explicit 1200-second bound'); assert.equal(pageErrors.length, 0);
  for (const actual of consoleErrors) assert(expectedConsole.some(expected => expected.url === actual.url && expected.messageSha256 === actual.messageSha256), 'Only exact expected 503/413 URL and resource-message hashes are accepted');
  for (const actual of negativeResponses) assert(expectedConsole.some(expected => expected.url === actual.url && expected.status === actual.status), 'No unregistered browser HTTP failure is suppressed');
  assert.equal(consoleErrors.length, expectedConsole.length, 'Each expected resource error is observed exactly once');
  const sourceHashesAfter = await collectSources(); same(sourceHashesAfter, sourceHashesBefore, 'Controlled runtime, fixture, helper and scope source bytes remain exact');
  assert.equal(fixture.counts().tableCount, 11); assert.equal(fixture.counts().triggerCount, 6); assert.equal(fixture.counts().totalChanges, fixture.ledger.reduce((sum, entry) => sum + entry.changes, 0), 'All setup, logins and explicit synthetic writes have a separate exact ledger');
  const finalRaw = fixture.rawState(); for (const table of ['attachment_files', 'certification_attachment_files']) same(finalRaw.typedTables[table], raw.typedTables[table], 'Both BLOB families preserve every saved byte');
  for (const entity of ['service-records', 'announcement-reads']) same(finalRaw.tables.record_versions.filter(row => row.entity === entity), raw.tables.record_versions.filter(row => row.entity === entity), 'Approved snapshots and immutable read receipts remain exact');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, version: '0.41', scope: 'synthetic full week/month read-only calendar', checks, screenshots, calendarChecks, contextChecks, serverScopeChecks, malformedChecks, readSegments, writeSegments,
    setupLedger: fixture.ledger, counts: fixture.counts(), baselinePreserved, pageErrors, consoleErrors, expectedConsole, negativeResponses, requestLedger, sourceHashesBefore, sourceHashesAfter,
    totalElapsedMs: Date.now() - started, limits: { actionTimeoutMs: 10000, navigationTimeoutMs: 30000, overallTimeoutMs: 1200000, nativeOSSelectionManualUatVerified: false },
    verificationScope: { browser: true, nativeSelectKeyboardValueVerified: false, nativePopupGeometryVerified: false, nativeSelectKeyboardLimitation: 'Two separate literal probes in this headless Chromium retained trusted focused key events without SELECT input/change; no claim about other operating systems or manual UAT.', randomOwnedLocalhost: true, controlledSourceLedger: true, realFullExports: true, malformed2xxAreExplicitMocks: true, serverRevocationIsSeparateHttpProof: true, allReadSegmentsZeroWrites: true, pendingControlsRemoved: true, pendingPeriodChangeNotClaimed: true, noOriginalCredentialsOrData: true, ci: false, userAcceptance: false, deployment: false, originalSystemEquivalence: false } }, null, 2) + '\n');
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, version: '0.41', stage, error: { name: error.name, messageSha256: sha(String(error.message)), stackSha256: sha(String(error.stack)) }, checks, screenshots, calendarChecks, contextChecks, serverScopeChecks, malformedChecks, readSegments, writeSegments, pageErrors, consoleErrors, expectedConsole, negativeResponses, requestLedger, sourceHashesBefore, totalElapsedMs: Date.now() - started, noAutomaticRetry: true }, null, 2) + '\n');
  throw error;
} finally {
  clearTimeout(watchdog); for (const context of contexts) await context.close().catch(() => {}); await browser?.close().catch(() => {}); await fixture?.close();
}
