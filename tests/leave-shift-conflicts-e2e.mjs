import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, insert } from '../src/server/model.mjs';

// All fixtures and normal writes are in a disposable memory database, never 4310/data.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/leave-shift-conflicts-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), ...installed.filter(n => /^chromium-/.test(n)).sort().reverse().map(n => path.join(cache, n, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], readSegments = [], writeSegments = [], invalidationChecks = [], fixtureNotes = [], contexts = [];
const password = 'synthetic-leave-conflicts-password';
const title = '請假衝突班次', entity = 'leave-requests';
let browser, base, lastPage;
const mark = text => { checks.push(text); console.log(`PASS ${text}`); };
const observe = page => { page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); }); page.on('response', r => { if (r.status() >= 400) failedResponses.push({ path: new URL(r.url()).pathname, status: r.status(), expected: [403, 404, 409, 422, 503].includes(r.status()) }); }); };
const counts = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n, audit: app.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, records: app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, versions: app.db.prepare('SELECT COUNT(*) AS n FROM record_versions').get().n, idempotency: app.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n });
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const readOnly = async (label, work) => { const before = counts(), raw = rawState(); assert.equal(Object.keys(raw).length, 11); await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); readSegments.push({ label, tableCount: 11, all11TablesUnchanged: true, before, after: counts() }); };
const write = async (label, work) => { const before = counts(); const result = await work(); writeSegments.push({ label, before, after: counts(), intentional: true }); return result; };
const load = async (page, route = '/leave', heading = '請假管理') => { lastPage = page; if (page.url() === `${base}/#${route}`) await page.reload(); else await page.goto(`${base}/#${route}`); await page.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); assert.equal(await page.locator('.error-state').count(), 0); };
const rowNamed = (page, name) => page.getByRole('row').filter({ hasText: name });
const triggerFor = (page, item) => rowNamed(page, item.reason).getByRole('button', { name: '檢視衝突班次', exact: true });
const inspectLayout = async page => { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page horizontal overflow'); assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.labels?.length && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')).map(n => n.name)), []); if (await page.getByRole('dialog').count()) assert.ok(await page.getByRole('dialog').evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && n.scrollWidth <= n.clientWidth + 1; }), 'Dialog fits; inner region owns any scrolling'); };
const shot = async (page, name) => {
  await page.waitForFunction(() => !document.querySelector('.toast'));
  const d = page.getByRole('dialog');
  if (['conflicts-locked-mobile.png', 'conflicts-page-two.png', 'conflicts-fresh-shift.png', 'conflicts-fresh-service-lock.png'].includes(name)) {
    const note = d.locator('.service-card').last().locator('p.notice');
    if (name.includes('locked') || name.includes('service-lock')) await note.getByText('已有服務紀錄，不能改派、改時段或取消此班次。', { exact: false }).waitFor();
    await note.evaluate(n => n.scrollIntoView({ block: 'center' }));
  }
  if (name === 'conflicts-missing-case.png') await d.getByText('目前個案資料無法取得，請核對資料', { exact: true }).evaluate(n => n.scrollIntoView({ block: 'center' }));
  if (name === 'conflicts-empty-mobile.png') await d.locator('.empty-state').evaluate(n => n.scrollIntoView({ block: 'center' }));
  await inspectLayout(page); await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
};
const settle = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delayRoute = async (page, pattern) => { const arrived = deferred(), release = deferred(), handled = deferred(); await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (e) { if (!/closed|cancel|abort|disposed|already handled/i.test(e.message)) throw e; } finally { handled.resolve(); } }); return { arrived, release, handled }; };
const waitContent = async page => { const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.getByRole('button', { name: '重新檢查', exact: true }).waitFor(); return dialog; };
const open = async (page, item) => { await triggerFor(page, item).click(); return waitContent(page); };
const close = async (page, trigger) => { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); if (trigger) assert.ok(await trigger.evaluate(n => n === document.activeElement), 'Escape returns to trigger'); };
const refresh = async (page, item) => { const response = page.waitForResponse(r => r.url().includes(`/${item.id}/shift-conflicts`) && r.request().method() === 'GET'); await page.getByRole('dialog').getByRole('button', { name: '重新檢查', exact: true }).click(); await response; return waitContent(page); };
await mkdir(output, { recursive: true });
try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成衝突管理員', email: 'conflicts-admin@example.test', password, organizationName: '合成衝突甲機構' } }); assert.equal(setup.status(), 201);
  const admin = await setup.json(), orgId = admin.organizations[0].id;
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => { const r = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) }); const body = await r.json(); assert.equal(r.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body; };
  const post = async (kind, data) => (await request('POST', kind, data, 201)).item;
  const patch = async (kind, item, data) => (await request('PATCH', `${kind}/${item.id}`, { version: item.version, ...data })).item;
  const get = async (kind, item) => (await request('GET', `${kind}/${item.id}`)).item;
  const query = (item, suffix = '', actor = { client: context, auth: admin }, expected = 200) => request('GET', `${entity}/${item.id}/shift-conflicts${suffix}`, undefined, expected, actor.client, actor.auth);
  const employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'LC-A', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'LC-B', role: 'caregiver', hourlyRateCents: 32000 });
  let inactiveEmployee = await post('employees', { name: '合成停用員工', employeeNo: 'LC-I', role: 'caregiver' });
  for (const [role, name, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['caregiver', 'caregiver', employeeA]]) await post('users', { name: `合成衝突${name}`, email: `conflicts-${name}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const login = async name => { const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client); const r = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `conflicts-${name}@example.test`, password } }); assert.equal(r.status(), 200); const auth = await r.json(), page = await client.newPage(); observe(page); return { client, auth, page }; };
  const supervisor = await login('supervisor'), finance = await login('finance'), caregiver = await login('caregiver');
  const adminPage = await context.newPage(); observe(adminPage);
  const careCase = await post('cases', { name: '合成衝突甲個案', caseNo: 'LC-C1', phone: 'DO_NOT_PROJECT_PHONE', address: 'DO_NOT_PROJECT_ADDRESS', note: 'DO_NOT_PROJECT_CASE_NOTE' });
  const caseB = await post('cases', { name: '合成衝突乙個案', caseNo: 'LC-C2' });
  const service = await post('service-items', { code: 'LC-S', name: '合成照顧', minutes: 15, unitPriceCents: 50000 });
  const services = [{ serviceItemId: service.id, quantity: 1 }];
  const plan = await post('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', services, status: 'active' });
  const planB = await post('care-plans', { caseId: caseB.id, validFrom: '2026-01-01', validTo: '2026-12-31', services, status: 'active' });
  const shiftData = (date, startTime, endTime, extra = {}) => ({ caseId: careCase.id, employeeId: employeeA.id, carePlanId: plan.id, date, startTime, endTime, services, status: 'scheduled', note: 'DO_NOT_PROJECT_SHIFT_NOTE', ...extra });
  const leaveData = (reason, extra = {}) => ({ employeeId: employeeA.id, date: '2026-10-20', startTime: '09:00', endTime: '15:00', type: '合成機構自訂假', reason, status: 'pending', ...extra });
  const newUi = async (page, data) => { await load(page); await page.getByRole('button', { name: '新增請假', exact: true }).click(); const d = page.getByRole('dialog'); for (const [key, label] of [['date', '請假日期'], ['startTime', '開始時間'], ['endTime', '結束時間'], ['type', '假別'], ['reason', '請假原因']]) await d.getByLabel(label, { exact: false }).fill(data[key]); await d.getByLabel('員工', { exact: false }).selectOption(data.employeeId); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.waitFor({ state: 'detached' }); return (await request('GET', `${entity}?q=${encodeURIComponent(data.reason)}`)).items.find(r => r.reason === data.reason); };
  let main = await write('真管理者UI建立待審核請假', () => newUi(adminPage, leaveData('合成28以外主驗收')));
  const normal = [], recordItems = [];
  for (let i = 0; i < 5; i++) normal.push(await post('shifts', shiftData('2026-10-20', `${String(9 + i).padStart(2, '0')}:00`, `${String(10 + i).padStart(2, '0')}:00`)));
  for (const [i, desired] of [[1, 'draft'], [2, 'submitted'], [3, 'returned'], [4, 'approved']]) { let r = await post('service-records', { shiftId: normal[i].id, caseId: careCase.id, employeeId: employeeA.id, date: normal[i].date, actualStart: normal[i].startTime, actualEnd: normal[i].endTime, services, status: desired === 'draft' ? 'draft' : 'submitted', note: 'DO_NOT_PROJECT_RECORD_NOTE' }); if (['returned', 'approved'].includes(desired)) r = (await request('POST', `service-records/${r.id}/review`, { version: r.version, decision: desired, reviewNote: 'DO_NOT_PROJECT_REVIEW_NOTE' })).item; recordItems.push(r); }
  const approvedRecord = recordItems.find(r => r.status === 'approved');
  const fees = await request('GET', 'reports/fees?month=2026-10'), payroll = await request('GET', 'reports/payroll?month=2026-10');
  const cancelled = await post('shifts', shiftData('2026-10-20', '14:00', '15:00')); await patch('shifts', cancelled, { status: 'cancelled' });
  await post('shifts', shiftData('2026-10-20', '08:00', '09:00')); await post('shifts', shiftData('2026-10-20', '15:00', '16:00'));
  await post('shifts', shiftData('2026-10-21', '09:00', '10:00'));
  await post('shifts', shiftData('2026-10-20', '09:00', '10:00', { employeeId: employeeB.id, caseId: caseB.id, carePlanId: planB.id }));
  const pageItem = await post(entity, leaveData('合成28個相接班次', { date: '2026-10-22', startTime: '08:00', endTime: '15:00' }));
  const minutes = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const pageShifts = []; for (let i = 0; i < 28; i++) pageShifts.push(await post('shifts', shiftData(pageItem.date, minutes(480 + i * 15), minutes(495 + i * 15))));
  let freshLeave = await post(entity, leaveData('合成最新請假資料', { date: '2026-10-23', startTime: '10:00', endTime: '11:00' }));
  let raceLeave = await post(entity, leaveData('合成核准競爭', { date: '2026-10-24', startTime: '10:00', endTime: '11:00' }));
  const emptyLeave = await post(entity, leaveData('合成無衝突', { date: '2026-10-25' }));
  const states = []; for (const status of ['approved', 'rejected', 'cancelled']) states.push(await post(entity, leaveData(`合成${status}可唯讀`, { date: '2026-10-26', status })));
  const isoLeave = await post(entity, leaveData('合成ISO原保存時段', { date: '2026-10-28', startTime: '2026-10-28T09:30:51+08:00', endTime: '2026-10-28T10:15:20+08:00' }));
  await post('shifts', shiftData(isoLeave.date, '09:30', '10:15'));
  const inactiveLeave = await post(entity, leaveData('合成停用員工查詢', { date: '2026-10-29', employeeId: inactiveEmployee.id })); inactiveEmployee = await patch('employees', inactiveEmployee, { status: 'inactive' });
  const otherOrg = (await request('POST', 'organizations', { name: '合成衝突乙機構' }, 201)).item;
  const foreignEmployee = (await request('POST', 'employees', { name: '合成跨機構員工', employeeNo: 'LC-FOREIGN', role: 'caregiver' }, 201, context, admin, otherOrg.id)).item;
  const foreignLeave = insert(app.db, otherOrg.id, entity, leaveData('合成不可讀跨機構請假', { employeeId: foreignEmployee.id }));
  const orphan = insert(app.db, orgId, entity, leaveData('合成缺失父員工', { employeeId: id() }));
  const foreignParent = insert(app.db, orgId, entity, leaveData('合成跨機構父員工', { employeeId: foreignEmployee.id }));
  const wrongParent = insert(app.db, orgId, entity, leaveData('合成錯實體父員工', { employeeId: careCase.id }));
  const unknownCaseLeave = await post(entity, leaveData('合成缺個案仍列阻擋', { date: '2026-10-27', startTime: '09:00', endTime: '12:00' }));
  const hiddenCaseId = id(); insert(app.db, orgId, 'shifts', shiftData(unknownCaseLeave.date, '09:00', '10:00', { caseId: hiddenCaseId, carePlanId: id() }));
  const nameless = insert(app.db, orgId, 'employees', { employeeNo: 'LC-IMPORT', role: 'caregiver', status: 'active', note: 'Explicit nameless imported fixture' });
  const unknownNameLeave = insert(app.db, orgId, entity, leaveData('合成未知員工名稱', { employeeId: nameless.id, date: '2026-10-30' }));
  fixtureNotes.push('Memory SQLite only, random localhost port; no actual 4310/data, original platform or production records. No PDF generated and no PDF operation marker invoked.', 'The 28 pagination shifts are created through normal APIs as adjacent 15-minute slots, not overlapping import fixtures.', 'Only missing/cross-organization/wrong-entity employee, missing case/plan, and existing-but-nameless employee fixtures use INSERT-only memory imports. Immutable versions/BLOBs are never updated/deleted.', 'Each read segment compares complete raw rows in all 11 tables, counts and total_changes. Deliberate setup, race, reassignment, cancellation and new-service writes are separate from read-only segments.');
  const setupCounts = counts(); assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 6);
  await readOnly('predicate-dto-locks', async () => {
    const result = await query(main); assert.equal(result.total, 5); assert.deepEqual(result.items.map(r => r.shiftId), normal.map(r => r.id)); assert.deepEqual(result.items.map(r => r.hasServiceRecord), [false, true, true, true, true]); assert.equal(result.items.at(-1).status, 'completed');
    assert.deepEqual(Object.keys(result).sort(), ['leave', 'generatedAt', 'items', 'total', 'page', 'pageSize', 'note'].sort());
    assert.deepEqual(Object.keys(result.leave).sort(), ['id', 'version', 'employee', 'date', 'startTime', 'endTime', 'type', 'status'].sort());
    for (const item of result.items) assert.deepEqual(Object.keys(item).sort(), ['shiftId', 'version', 'date', 'startTime', 'endTime', 'status', 'employee', 'case', 'hasServiceRecord'].sort());
    assert.ok(!/DO_NOT_PROJECT|billingSnapshot|unitPriceCents|hourlyRateCents|recordId|canApprove|overlapMinutes/.test(JSON.stringify(result)));
    assert.equal((await query(isoLeave)).items.length, 1); assert.equal((await query(isoLeave)).leave.startTime, isoLeave.startTime);
    await load(adminPage); const d = await open(adminPage, main); assert.equal(await d.getByRole('button', { name: /核准|改派|取消班次|儲存/ }).count(), 0); await shot(adminPage, 'conflicts-desktop.png'); await adminPage.setViewportSize({ width: 390, height: 844 }); await shot(adminPage, 'conflicts-mobile.png'); await d.locator('.service-card').last().evaluate(n => n.scrollIntoView({ block: 'start' })); await shot(adminPage, 'conflicts-locked-mobile.png'); await close(adminPage, triggerFor(adminPage, main)); await adminPage.setViewportSize({ width: 1440, height: 1050 });
  }); mark('精確同日半開判斷／取消排除／completed保留；四種服務狀態鎖定、最小DTO與1440/390唯讀畫面');
  await readOnly('normal-28-pagination', async () => {
    await load(supervisor.page); let d = await open(supervisor.page, pageItem); assert.equal(await d.locator('.service-card').count(), 25); await shot(supervisor.page, 'conflicts-page-one.png'); await d.getByRole('button', { name: '下一頁', exact: true }).click(); d = await waitContent(supervisor.page); await d.getByText(pageShifts.at(-1).id, { exact: true }).waitFor(); assert.equal(await d.locator('.service-card').count(), 3); await shot(supervisor.page, 'conflicts-page-two.png'); await close(supervisor.page, triggerFor(supervisor.page, pageItem));
    const a = await query(pageItem, '?page=1&pageSize=25'), b = await query(pageItem, '?page=2&pageSize=25'), c = await query(pageItem, '?page=3&pageSize=25'); assert.deepEqual([...a.items, ...b.items].map(r => r.shiftId), pageShifts.map(r => r.id)); assert.equal(c.total, 28); assert.deepEqual(c.items, []);
  }); mark('正常API28個相接班次25+3分頁，完整總數、排序、頁外空與督導真UI');
  await load(adminPage); // The list deliberately holds the old leave row.
  freshLeave = await write('督導真UI修改請假員工及日期時段', async () => { await load(supervisor.page); await rowNamed(supervisor.page, freshLeave.reason).getByRole('button', { name: '編輯', exact: true }).click(); const d = supervisor.page.getByRole('dialog'); await d.getByLabel('員工', { exact: false }).selectOption(employeeB.id); await d.getByLabel('請假日期', { exact: false }).fill('2026-10-31'); await d.getByLabel('開始時間', { exact: false }).fill('11:00'); await d.getByLabel('結束時間', { exact: false }).fill('12:00'); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.waitFor({ state: 'detached' }); return get(entity, freshLeave); });
  await readOnly('stale-list-fresh-parent', async () => { const d = await open(adminPage, freshLeave); await d.getByText(employeeB.name, { exact: false }).first().waitFor(); assert.equal((await query(freshLeave)).leave.version, 2); assert.ok((await d.textContent()).includes('11:00')); await shot(adminPage, 'conflicts-fresh-parent.png'); await close(adminPage); });
  let freshShift = await write('新增與最新請假重疊的班次', () => post('shifts', shiftData(freshLeave.date, '11:00', '12:00', { employeeId: employeeB.id, caseId: caseB.id, carePlanId: planB.id })));
  await readOnly('fresh-shift-added', async () => { await load(adminPage); await open(adminPage, freshLeave); assert.equal((await query(freshLeave)).total, 1); await shot(adminPage, 'conflicts-fresh-shift.png'); });
  await write('新增草稿服務紀錄後班次鎖定', () => post('service-records', { shiftId: freshShift.id, caseId: caseB.id, employeeId: employeeB.id, date: freshShift.date, actualStart: '11:05', actualEnd: '11:50', services, status: 'draft' }));
  await readOnly('refresh-new-service-lock', async () => { await refresh(adminPage, freshLeave); assert.equal((await query(freshLeave)).items[0].hasServiceRecord, true); await shot(adminPage, 'conflicts-fresh-service-lock.png'); await close(adminPage); }); mark('舊清單開啟仍讀最新請假version/員工/時段；新增班次與草稿紀錄後重新檢查立即反映');
  await readOnly('initial-no-conflict', async () => { await load(adminPage); const d = await open(adminPage, raceLeave); await d.getByText('目前沒有重疊班次；核准時仍會重新檢查。', { exact: true }).waitFor(); await shot(adminPage, 'conflicts-empty-desktop.png'); await close(adminPage); });
  let raceShift = await write('讀取無衝突後競爭新增班次', () => post('shifts', shiftData(raceLeave.date, '10:00', '11:00')));
  await readOnly('approval-race-original-guard', async () => { await rowNamed(adminPage, raceLeave.reason).getByRole('button', { name: '核准', exact: true }).click(); const d = adminPage.getByRole('dialog'); await d.getByRole('button', { name: '確認核准', exact: true }).click(); await d.getByText('核准請假前須先處理重疊班次', { exact: true }).waitFor(); await shot(adminPage, 'conflicts-approval-race.png'); assert.deepEqual(await get(entity, raceLeave), raceLeave); await d.getByRole('button', { name: '取消', exact: true }).click(); await d.waitFor({ state: 'detached' }); await open(adminPage, raceLeave); });
  raceShift = await write('競爭班次正常改派其他員工', () => patch('shifts', raceShift, { employeeId: employeeB.id }));
  await readOnly('refresh-reassignment', async () => { const d = await refresh(adminPage, raceLeave); await d.getByText('目前沒有重疊班次；核准時仍會重新檢查。', { exact: true }).waitFor(); });
  raceShift = await write('班次正常改派回原員工', () => patch('shifts', raceShift, { employeeId: employeeA.id }));
  await readOnly('refresh-returned-assignment', async () => { await refresh(adminPage, raceLeave); assert.equal((await query(raceLeave)).total, 1); });
  raceShift = await write('正常取消無服務紀錄班次', () => patch('shifts', raceShift, { status: 'cancelled' }));
  await readOnly('refresh-cancelled-shift', async () => { const d = await refresh(adminPage, raceLeave); await d.getByText('目前沒有重疊班次；核准時仍會重新檢查。', { exact: true }).waitFor(); await close(adminPage); }); mark('真無衝突→新增race→原核准409零寫；班次改派／改回／取消後fresh刷新正確');
  const finalWriteCounts = counts(), finalWriteState = rawState();
  await readOnly('four-real-sessions-and-parent-scope', async () => {
    for (const actor of [supervisor, { client: context, auth: admin }]) assert.equal((await query(main, '', actor)).total, 5);
    for (const actor of [finance, caregiver]) { await query(main, '?unknown=1&page=bad', actor, 403); await query({ id: id() }, '', actor, 403); await actor.page.goto(`${base}/#/leave`); await actor.page.waitForLoadState('networkidle'); assert.equal(await actor.page.getByRole('heading', { name: '請假管理', exact: true }).count(), 0); assert.equal(await actor.page.getByRole('button', { name: '檢視衝突班次', exact: true }).count(), 0); await request('GET', `${entity}/${main.id}`, undefined, 200, actor.client, actor.auth); }
    for (const item of [foreignLeave, orphan, foreignParent, wrongParent, { id: id() }]) await query(item, '', undefined, 404);
    assert.equal((await query(inactiveLeave)).leave.employee.status, 'inactive');
    for (const suffix of ['?page=0', '?pageSize=101', '?page=1&page=2', '?employeeId=x']) await query(main, suffix, undefined, 422);
    const anonymous = await browser.newContext(); contexts.push(anonymous); assert.equal((await anonymous.request.get(`${base}/api/${entity}/${main.id}/shift-conflicts`)).status(), 401);
  }); mark('四角色真session：新端點finance/caregiver早403、舊leave讀權保持；跨機構／缺父404、停用父項保留與query拒絕');
  await readOnly('null-case-unknown-name-all-leave-statuses', async () => {
    const unknown = await query(unknownCaseLeave); assert.equal(unknown.total, 1); assert.equal(unknown.items[0].case, null); assert.ok(!JSON.stringify(unknown).includes(hiddenCaseId));
    await load(adminPage); let d = await open(adminPage, unknownCaseLeave); await d.getByText('目前個案資料無法取得，請核對資料', { exact: false }).waitFor(); await shot(adminPage, 'conflicts-missing-case.png'); await close(adminPage);
    d = await open(adminPage, unknownNameLeave); await shot(adminPage, 'conflicts-unknown-employee.png'); assert.equal((await query(unknownNameLeave)).leave.employee.name, null); await close(adminPage);
    for (const item of states) { d = await open(adminPage, item); assert.equal((await query(item)).leave.status, item.status); assert.equal(await d.getByRole('button', { name: /核准|改派|取消班次|儲存/ }).count(), 0); if (item.status === 'approved') await shot(adminPage, 'conflicts-nonpending.png'); await close(adminPage); }
  }); mark('缺個案仍列阻擋且不透露ID；未知姓名不猜，全部請假狀態僅查保存時段');
  const pattern = `**/api/${entity}/${main.id}/shift-conflicts*`;
  await readOnly('503-and-invalid-dto-recovery', async () => {
    await load(adminPage); let attempts = 0;
    await adminPage.route(pattern, route => ++attempts === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ', message: '合成衝突查詢暫時無法取得，請重試。' } }) }) : route.continue());
    await triggerFor(adminPage, main).click(); let d = adminPage.getByRole('dialog', { name: title, exact: true }); await d.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); await shot(adminPage, 'conflicts-read-error.png'); await d.getByRole('button', { name: '重新讀取', exact: true }).click(); await waitContent(adminPage); assert.equal(attempts, 2); await close(adminPage, triggerFor(adminPage, main)); await adminPage.unroute(pattern);
    const real = await query(main);
    for (const [label, body] of [['missing-envelope', {}], ['wrong-leave-id', { ...real, leave: { ...real.leave, id: id() } }], ['invalid-pagination', { ...real, total: -1 }]]) {
      let once = true; await adminPage.route(pattern, route => { if (once) { once = false; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }); } return route.continue(); });
      await triggerFor(adminPage, main).click(); d = adminPage.getByRole('dialog'); await d.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(await d.getByText('目前沒有重疊班次；核准時仍會重新檢查。', { exact: true }).count(), 0); if (label === 'missing-envelope') await shot(adminPage, 'conflicts-invalid-response.png'); await d.getByRole('button', { name: '重新讀取', exact: true }).click(); await waitContent(adminPage); await close(adminPage); await adminPage.unroute(pattern);
    }
  }); mark('503與200缺envelope／錯id／非法分頁皆不能冒充零衝突，重試真GET恢復');
  await readOnly('escape-cancel-late-result', async () => {
    await load(adminPage); const trigger = triggerFor(adminPage, main); await trigger.focus(); const delayed = await delayRoute(adminPage, pattern);
    await adminPage.keyboard.press('Enter'); await delayed.arrived.promise; await shot(adminPage, 'conflicts-loading.png'); const aborted = adminPage.waitForEvent('requestfailed', { predicate: req => req.url().includes(`/${main.id}/shift-conflicts`), timeout: 10000 }); await close(adminPage, trigger); delayed.release.resolve(); await delayed.handled.promise; assert.match((await aborted).failure()?.errorText || '', /abort|cancel/i); await adminPage.unroute(pattern); await open(adminPage, emptyLeave); await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').locator('.service-card').count(), 0); await close(adminPage);
  }); mark('鍵盤Enter開啟、慢讀Escape取消fetch並回焦點；晚回應不復活也不串到另一請假');
  await readOnly('loaded-pending-complete-identity', async () => {
    for (const pending of [false, true]) for (const mode of ['route', 'organization', 'role', 'employee', 'render']) {
      await load(adminPage); const delayed = pending ? await delayRoute(adminPage, pattern) : null;
      if (delayed) { await triggerFor(adminPage, main).click(); await delayed.arrived.promise; } else await open(adminPage, main);
      if (mode === 'route') await adminPage.evaluate(() => { location.hash = '/cases'; });
      else if (mode === 'organization') await adminPage.getByLabel('目前機構', { exact: true }).evaluate((n, value) => { n.value = value; n.dispatchEvent(new Event('change', { bubbles: true })); }, otherOrg.id);
      else if (mode === 'render') await adminPage.evaluate(() => window.dispatchEvent(new Event('session-updated')));
      else await adminPage.evaluate(async ({ mode, employeeId }) => { const { getContext, setContext } = await import('/ui.js'); const ctx = structuredClone(getContext()); const org = ctx.organizations.find(item => item.id === ctx.organizationId); if (mode === 'role') org.role = 'supervisor'; else org.employeeId = employeeId; setContext(ctx, ctx.organizationId); document.body.append(document.createComment('synthetic-client-identity-fixture')); }, { mode, employeeId: employeeB.id });
      await adminPage.getByRole('dialog').waitFor({ state: 'detached' }); if (delayed) { delayed.release.resolve(); await delayed.handled.promise; await adminPage.unroute(pattern); } await settle(adminPage); assert.equal(await adminPage.getByRole('dialog').count(), 0); invalidationChecks.push({ pending, mode, cleared: true, noLateRevival: true }); await adminPage.reload(); await adminPage.waitForLoadState('networkidle');
    }
  }); fixtureNotes.push('Role/employee invalidation is an explicitly client-only context fixture plus DOM mutation, restored by reloading the real server session; this is not evidence of server membership revocation. Four-role API authorization uses separate real login sessions.'); mark('loaded/pending × hash/org/role/employee/render 共10情境清空關閉，晚回應不復活');
  await readOnly('navigation-and-mobile-empty-iso', async () => {
    await load(adminPage); const d = await open(adminPage, main); const link = d.getByRole('link', { name: '前往排班管理', exact: true }); assert.equal(await link.count(), 1); assert.equal(await link.getAttribute('href'), '#/shifts'); await link.click(); await adminPage.getByRole('heading', { name: '班表', exact: true }).waitFor(); assert.equal(await adminPage.getByRole('dialog').count(), 0); assert.equal(new URL(adminPage.url()).hash, '#/shifts');
    await load(adminPage); await adminPage.setViewportSize({ width: 390, height: 844 }); await open(adminPage, emptyLeave); await shot(adminPage, 'conflicts-empty-mobile.png'); await close(adminPage, triggerFor(adminPage, emptyLeave)); await open(adminPage, isoLeave); await adminPage.getByRole('dialog').getByText(isoLeave.startTime, { exact: false }).waitFor(); await shot(adminPage, 'conflicts-iso-mobile.png'); await close(adminPage); await adminPage.setViewportSize({ width: 1440, height: 1050 });
  }); mark('單一排班導引只到#/shifts、清除modal；390空狀態與原保存ISO可讀且無整頁溢出');
  assert.deepEqual(counts(), finalWriteCounts); assert.deepEqual(rawState(), finalWriteState);
  await readOnly('final-financial-and-masters-preserved', async () => { assert.deepEqual(await get('service-records', approvedRecord), approvedRecord); assert.deepEqual(await request('GET', 'reports/fees?month=2026-10'), fees); assert.deepEqual(await request('GET', 'reports/payroll?month=2026-10'), payroll); assert.deepEqual(await get('cases', careCase), careCase); assert.deepEqual(await get('care-plans', plan), plan); assert.deepEqual(await get('service-items', service), service); });
  assert.equal(invalidationChecks.length, 10); assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(r => !r.expected), []); assert.ok(consoleErrors.every(s => /403|404|409|422|503/.test(s)), JSON.stringify(consoleErrors));
  mark('每段11表raw/count/total_changes零寫，所有預期競爭寫入另列；核准snapshot/fees/payroll及主檔保持，pageerror0');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'Memory SQLite, synthetic fixtures, random localhost port, actual Chromium. No actual 4310/data or original platform.', checks, screenshots, pageErrors, consoleErrors, failedResponses, readSegments, writeSegments, invalidationChecks, fixtureNotes, setupCounts, finalReadCounts: { before: finalWriteCounts, after: counts() }, all11TablesUnchangedDuringReads: true, billingSnapshotUnchanged: true, pdfOperations: 0, pdfMarkers: 0, visualReviewPending: true }, null, 2));
  console.log(`Leave shift conflicts E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, readSegments, writeSegments, invalidationChecks, fixtureNotes, error: error.stack, pdfOperations: 0, pdfMarkers: 0 }, null, 2)); throw error;
} finally { for (const c of contexts) await c.close(); await browser?.close(); await app.close(); }
