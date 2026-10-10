import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticWorkspace, syntheticDatabasePath, inspectSyntheticDatabase, captureSyntheticBackup,
  restoreSyntheticBackup, promoteSyntheticRestore, disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';
import { createSyntheticBackupFixture, readSyntheticRawState, syntheticClient } from './synthetic-backup-fixtures.mjs';

// The unmounted v0.39 tools consume only a factory-owned synthetic workspace.
// Actual restored Chromium UI, port 0, four roles, eleven tables/six triggers.
// Existing UI/backend/old tests remain unchanged. No new PDF/print operations.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.QA_OUTPUT_DIR || path.join(root, 'outputs/software/synthetic-backup-restore-e2e'));
assert(!existsSync(path.join(output, 'e2e.json')), 'Preserve the prior attempt before any explicit new run');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert(isDeepStrictEqual(actual, expected), label);
const rawSha = state => sha(JSON.stringify({ schema: state.schema, typedTables: state.typedTables, userVersion: state.userVersion, applicationId: state.applicationId }));
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const collectSources = async () => {
  const names = ['tests/synthetic-backup-e2e.mjs', 'tests/synthetic-backup-fixtures.mjs', 'tests/attachment-fixtures.mjs'];
  const walk = async dir => { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else names.push(file); } };
  for (const dir of ['public', 'src']) await walk(dir);
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const counters = db => ({ totalChanges: db.prepare('SELECT total_changes() AS n').get().n,
  ...Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency', 'sessions', 'attachment_files', 'certification_attachment_files'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n])) });
const independentRead = dbPath => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    return readSyntheticRawState(db);
  } finally { db.close(); }
};
const checks = [], screenshots = [], readSegments = [], writeSegments = [], apiChecks = [], csvChecks = [], blobDownloads = [], contexts = [], pageErrors = [], consoleErrors = [], failedResponses = [], uiQueries = [];
let workspace, fixture, restoredApp, browser, base, lastPage, sourceHashesBefore, readBaseline, readCounts, safeStage = 'initialization';
const actors = {};
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const safeRoute = route => route.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, ':id');
const readOnly = async (label, work) => {
  safeStage = label;
  const before = counters(restoredApp.db), raw = readSyntheticRawState(restoredApp.db);
  const value = await work();
  same(counters(restoredApp.db), before, label + ': row-change counters unchanged');
  same(readSyntheticRawState(restoredApp.db), raw, label + ': all saved columns/schema/BLOBs unchanged');
  same(raw, readBaseline, label + ': entire restored read phase unchanged');
  readSegments.push({ label, before, after: counters(restoredApp.db), rawBeforeSha256: rawSha(raw), rawAfterSha256: rawSha(readSyntheticRawState(restoredApp.db)), tableCount: 11, triggerCount: 6, unchanged: true });
  return value;
};
const apiResponse = async (actor, route, { method = 'GET', data, orgId = fixture.orgId, status = 200 } = {}) => {
  const response = await actor.context.request.fetch(`${base}/api/${route}`, { method,
    headers: { Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': actor.auth.csrfToken }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), status, `${actor.role}: ${method} ${safeRoute(route)} status`);
  apiChecks.push({ role: actor.role, method, route: safeRoute(route), status: response.status(), requestedOrg: orgId === fixture.orgId ? 'primary' : 'foreign' });
  return response;
};
const apiJson = async (actor, route, options = {}) => (await apiResponse(actor, route, options)).json();
const observe = page => {
  page.on('pageerror', error => pageErrors.push({ messageSha256: sha(error.message) }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ messageSha256: sha(message.text()) }); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ route: safeRoute(new URL(response.url()).pathname), status: response.status() }); });
};
const body = page => page.locator('.report-body');
const selection = page => page.getByLabel('報表類型', { exact: true });
const monthControl = page => page.getByLabel('報表月份', { exact: true });
const csvButton = page => page.getByRole('button', { name: '下載 CSV', exact: true }).first();
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  assert.equal(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).length), 0, 'Visible controls have semantic labels');
  for (const table of await page.locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
  if (await page.getByRole('dialog').count()) assert(await page.getByRole('dialog').evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog stays inside viewport');
};
const shot = async (page, name) => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await layout(page); const target = path.join(output, name); await page.screenshot({ path: target, fullPage: false });
  screenshots.push({ name, sha256: sha(await readFile(target)), actualVisualReviewPending: true });
};
const loadReports = async page => {
  lastPage = page; await page.goto(`${base}/#/reports`);
  await page.getByRole('heading', { name: '報表中心', exact: true, level: 1 }).waitFor();
  await selection(page).waitFor(); await page.waitForLoadState('networkidle');
};
const reportMatches = (response, kind, month) => { const url = new URL(response.url()); return response.request().method() === 'GET' && url.pathname === `/api/reports/${kind}` && url.searchParams.get('month') === month; };
const display = async (page, kind) => {
  const waiting = page.waitForResponse(response => reportMatches(response, kind, fixture.month));
  if (await selection(page).inputValue() !== kind) await selection(page).selectOption(kind); else await page.getByRole('button', { name: '重新查詢', exact: true }).click();
  const response = await waiting; assert.equal(response.status(), 200);
  const result = await response.json(); same(result, fixture.expected.frozenReports[kind], 'Confirmed restored report equals saved source report');
  await body(page).getByRole('heading', { name: result.title, exact: true, level: 2 }).waitFor();
  await body(page).getByText(`${fixture.month} · ${result.rows.length} 筆`, { exact: true }).waitFor();
  assert.equal(await monthControl(page).inputValue(), fixture.month);
  assert.equal(await body(page).locator('.error-state').count(), 0); assert(await csvButton(page).isEnabled());
  assert.equal(await body(page).locator('table').first().locator('tbody tr').count(), result.rows.length);
  await body(page).getByText('試算，未核定規則', { exact: true }).waitFor();
  await page.getByText('費用與薪資僅供試算', { exact: true }).waitFor();
  const money = cents => { const digits = String(cents).padStart(3, '0'); return '$' + digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + digits.slice(-2); };
  const keys = result.columns.map(column => column.key), table = body(page).locator('table').first();
  for (const [index, row] of result.rows.entries()) for (const key of keys.filter(value => /cents$/i.test(value))) assert.equal(await table.locator('tbody tr').nth(index).locator('td').nth(keys.indexOf(key)).textContent(), money(row[key]));
  const totalsKeys = Object.keys(result.totals); assert.equal(await body(page).locator('table').last().locator('tbody tr').first().locator('td').nth(totalsKeys.indexOf('amountCents')).textContent(), money(result.totals.amountCents));
  uiQueries.push({ kind, month: fixture.month, status: 200, rowCount: result.rows.length, totals: result.totals, sourceReportSha256: sha(JSON.stringify(fixture.expected.frozenReports[kind])), renderedSavedCentsExactly: true });
  return result;
};
const closeBrowser = async () => { for (const context of contexts) await context.close(); contexts.length = 0; await browser?.close(); browser = null; };

await mkdir(output, { recursive: true });
try {
  sourceHashesBefore = await collectSources();
  safeStage = 'G1 owned source fixture and committed WAL snapshot';
  workspace = createSyntheticWorkspace();
  fixture = await createSyntheticBackupFixture({ workspace });
  const sourceBefore = fixture.readRawState(), sourceCounts = counters(fixture.app.db);
  same(sourceBefore, fixture.expected.rawState, 'Source fixture matches independent expected saved rows');
  const sourceInspection = inspectSyntheticDatabase(workspace, 'source');
  assert.equal(sourceInspection.tableCount, 11); assert.equal(sourceInspection.triggerCount, 6);
  const ref = captureSyntheticBackup(workspace);
  const restored = restoreSyntheticBackup(workspace, ref, 'live');
  assert.equal(restored.status, 'restored'); assert.equal(restored.target, 'live');
  const livePath = syntheticDatabasePath(workspace, 'live');
  const preStartup = independentRead(livePath);
  same(preStartup, sourceBefore, 'Fresh restore contains every persisted source value, including committed WAL sentinel');
  assert.equal(preStartup.tables.records.find(row => row.id === fixture.items.case.id).version, 3);
  same(fixture.readRawState(), sourceBefore, 'Capture and restore leave source saved rows unchanged');
  same(counters(fixture.app.db), sourceCounts, 'Capture and restore cause no source writes');
  mark('G1 合成live WAL提交完整capture/restore，十一表/六trigger/所有保存欄與BLOB精確相同');

  safeStage = 'G2 restored startup sessions and fresh role logins';
  restoredApp = createApp({ dbPath: livePath, host: '127.0.0.1', port: 0 });
  assert.equal(counters(restoredApp.db).totalChanges, 0, 'Restored initDb writes zero baseline/version rows');
  same(readSyntheticRawState(restoredApp.db), preStartup, 'Restored constructor preserves sessions/schema/rows before any login');
  base = await restoredApp.listen(); assert(new URL(base).port !== '4310');
  const anonymous = syntheticClient(base, 'restored-anonymous');
  const missing = await anonymous.json('GET', 'cases', undefined, { orgId: fixture.orgId, status: 401 }); assert.equal(missing.error.code, 'AUTH_REQUIRED');
  const retained = syntheticClient(base, 'restored-retained-source-session', { cookie: fixture.sourceCookies.admin, auth: fixture.actors.admin.auth });
  const retainedSession = await retained.json('GET', 'session', undefined, { orgId: fixture.orgId });
  assert.equal(retainedSession.user.id, fixture.users.admin.id);
  await retained.json('GET', 'cases', undefined, { orgId: fixture.orgId });
  const expired = syntheticClient(base, 'restored-known-expired-session', { cookie: fixture.secrets.expiredCookie });
  const expiredResult = await expired.json('GET', 'cases', undefined, { orgId: fixture.orgId, status: 401 }); assert.equal(expiredResult.error.code, 'AUTH_REQUIRED');
  const expiredSession = await expired.json('GET', 'session', undefined, { orgId: fixture.orgId }); assert.equal(expiredSession.user, null);
  same(readSyntheticRawState(restoredApp.db), preStartup, 'Anonymous, valid and expired session GETs preserve every saved row');
  assert.equal(counters(restoredApp.db).totalChanges, 0);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei' }); contexts.push(context);
    const before = counters(restoredApp.db);
    const response = await context.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: fixture.users[role].email, password: fixture.secrets.password } });
    assert.equal(response.status(), 200, 'Fresh normal restored login succeeds');
    const auth = await response.json(); assert.equal(auth.organizations.find(org => org.id === fixture.orgId).role, role);
    const after = counters(restoredApp.db); assert.equal(after.totalChanges - before.totalChanges, role === 'admin' ? 2 : 1, 'Only expired-session cleanup and normal session insert are counted');
    const page = await context.newPage(); observe(page); actors[role] = { context, auth, page, role };
    writeSegments.push({ label: 'normal-restored-login-' + role, before, after, changes: after.totalChanges - before.totalChanges });
  }
  assert.equal(counters(restoredApp.db).sessions, 8);
  assert.equal(counters(restoredApp.db).totalChanges, 5);
  readBaseline = readSyntheticRawState(restoredApp.db); readCounts = counters(restoredApp.db);
  mark('G2 還原啟動零寫、原有效session保持/過期與未登入401；四次正常登入另列五筆changes');

  await readOnly('G3 restored four-role two-organization self scope', async () => {
    for (const role of ['admin', 'finance']) for (const kind of ['fees', 'payroll']) same(await apiJson(actors[role], `reports/${kind}?month=${fixture.month}`), fixture.expected.frozenReports[kind], 'Restored authorized financial report equals source snapshot');
    for (const role of ['supervisor', 'caregiver']) for (const kind of ['fees', 'payroll']) for (const suffix of ['', '.csv']) {
      const denied = await apiJson(actors[role], `reports/${kind}${suffix}?month=${fixture.month}`, { status: 403 }); assert.equal(denied.error.code, 'ROLE_FORBIDDEN');
    }
    for (const role of ['supervisor', 'finance', 'caregiver']) { const denied = await apiJson(actors[role], 'cases', { orgId: fixture.foreignOrgId, status: 403 }); assert.equal(denied.error.code, 'ORG_FORBIDDEN'); }
    const foreignCases = await apiJson(actors.admin, 'cases', { orgId: fixture.foreignOrgId });
    assert.equal(foreignCases.items.length, 1); assert.equal(foreignCases.items[0].id, fixture.items.foreignCase.id);
    for (const [entity, expectedId] of [['cases', fixture.items.case.id], ['employees', fixture.items.employee.id], ['shifts', fixture.items.ownShift.id], ['service-records', fixture.items.ownRecord.id]]) {
      const result = await apiJson(actors.caregiver, entity); assert.equal(result.total, 1); assert.equal(result.items[0].id, expectedId);
    }
    const year = Number(fixture.month.slice(0, 4)), monthNumber = Number(fixture.month.slice(5, 7));
    const endDate = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    const ownReport = await apiJson(actors.caregiver, `service-report/export?startDate=${fixture.month}-01&endDate=${endDate}`);
    assert.equal(ownReport.rows.length, 1); assert.equal(ownReport.rows[0].recordId, fixture.items.ownRecord.id);
    for (const id of [fixture.items.otherCase.id, fixture.items.foreignCase.id]) for (const suffix of ['', '/history?compare=previous']) await apiJson(actors.caregiver, `cases/${id}${suffix}`, { status: 404 });
    for (const role of ['supervisor', 'caregiver']) assert(!Object.hasOwn((await apiJson(actors[role], `service-records/${fixture.items.ownRecord.id}`)).item, 'billingSnapshot'), 'Nonfinancial DTO omits pricing snapshot');
    const financeCert = await apiJson(actors.finance, `certification-attachments/${fixture.items.certAttachment.id}`, { status: 403 }); assert.equal(financeCert.error.code, 'ROLE_FORBIDDEN');
    same((await apiJson(actors.admin, `service-records/${fixture.items.ownRecord.id}`)).item, fixture.items.ownRecord, 'Approved saved service snapshot remains exact after restore');
  });
  mark('G3 四角色/雙機構/居服員本人報表與歷程邊界保持，授權讀取十一表零寫');

  await readOnly('G4 restored desktop financial UI and fresh raw CSV', async () => {
    for (const role of ['admin', 'finance']) {
      const page = actors[role].page; await loadReports(page);
      for (const kind of ['fees', 'payroll']) await display(page, kind);
    }
    const page = actors.admin.page; await display(page, 'fees'); await shot(page, 'restored-fees-desktop.png');
    await display(page, 'payroll'); await shot(page, 'restored-payroll-desktop.png');
    for (const kind of ['fees', 'payroll']) {
      await display(page, kind);
      const expected = await apiResponse(actors.admin, `reports/${kind}.csv?month=${fixture.month}`);
      const endpointBytes = await expected.body(); assert(endpointBytes.equals(fixture.expected.csvBytes[kind]), 'Fresh restored raw CSV equals pre-backup source CSV');
      const responseWaiting = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === `/api/reports/${kind}.csv` && url.searchParams.get('month') === fixture.month; });
      const downloadWaiting = page.waitForEvent('download'); await csvButton(page).click();
      const response = await responseWaiting; assert.equal(response.status(), 200);
      const download = await downloadWaiting, stream = await download.createReadStream(), chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); assert.equal(await download.failure(), null); assert(bytes.equals(endpointBytes), 'Browser download equals independently fresh restored endpoint bytes');
      assert.equal(download.suggestedFilename(), `歲悅-${kind}-${fixture.month}.csv`);
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf'); assert(bytes.toString('utf8').includes('\r\n'));
      for (const row of fixture.expected.frozenReports[kind].rows) assert(bytes.toString('utf8').includes('"' + row.amountCents + '"'), 'CSV retains saved raw integer cents');
      csvChecks.push({ kind, month: fixture.month, status: 200, bytes: bytes.length, sha256: sha(bytes), sourceSha256: sha(fixture.expected.csvBytes[kind]), sourceAndRestoredAndBrowserExact: true, rawCents: true, screenSnapshotIdentityClaimed: false });
    }
  });
  mark('G4 桌機恢復兩種試算畫面與兩次真CSV下載，保存分與fresh來源byte一致');

  await readOnly('G5 restored version histories and four exact BLOB downloads', async () => {
    const entries = [['cases', fixture.items.case], ['service-records', fixture.items.ownRecord], ['employee-certifications', fixture.items.certification], ['case-attachments', fixture.items.caseAttachment], ['certification-attachments', fixture.items.certAttachment]];
    for (const [entity, item] of entries) {
      const result = await apiJson(actors.admin, `${entity}/${item.id}/history?compare=previous`);
      same(result, fixture.expected.histories[entity], 'Restored complete saved history and exact prior version equal source');
      assert.equal(result.items[0].version, item.version); assert.equal(result.items[0].comparison.previousVersion, item.version - 1);
      if (entity === 'cases' || entity === 'service-records') assert.equal(result.items[0].actor.id, fixture.users.admin.id);
      for (const role of ['supervisor', 'caregiver']) {
        const scoped = await apiJson(actors[role], `${entity}/${item.id}/history?compare=previous`);
        assert.equal(scoped.items[0].version, item.version);
        if (entity === 'service-records') for (const version of scoped.items) assert(!Object.hasOwn(version.snapshot, 'billingSnapshot'), 'Nonfinancial histories do not expose pricing snapshots');
      }
    }
    for (const [entity, item, expected] of [['case-attachments', fixture.items.caseAttachment, fixture.expected.caseBytes], ['certification-attachments', fixture.items.certAttachment, fixture.expected.certBytes]]) for (const version of [null, 1]) {
      const response = await apiResponse(actors.admin, `${entity}/${item.id}/download${version === null ? '' : '?recordVersion=' + version}`);
      const bytes = await response.body(); assert(bytes.equals(expected), 'Restored BLOB bytes equal independent synthetic source bytes'); assert.equal(sha(bytes), item.sha256);
      assert.equal(response.headers()['cache-control'], 'no-store'); assert.equal(response.headers()['x-content-type-options'], 'nosniff');
      assert.equal(Number(response.headers()['content-length']), bytes.length); assert(response.headers()['content-disposition'].startsWith('attachment;'));
      blobDownloads.push({ entity, version: version === null ? item.version : version, status: 200, bytes: bytes.length, sha256: sha(bytes), independentBytesExact: true });
    }
    const page = actors.admin.page; lastPage = page; await page.goto(`${base}/#/cases/${fixture.items.case.id}`);
    await page.getByRole('heading', { name: fixture.items.case.name, exact: true, level: 1 }).waitFor();
    const trigger = page.getByRole('button', { name: '個案版本歷程', exact: true }); await trigger.click();
    const dialog = page.getByRole('dialog', { name: '個案版本歷程', exact: true }); await dialog.getByText('第 3 版', { exact: true }).waitFor();
    const card = dialog.locator('.history-version').filter({ has: page.getByText('第 3 版', { exact: true }) });
    await card.getByRole('row').filter({ hasText: '備註' }).getByText(fixture.items.case.note, { exact: true }).waitFor();
    await card.getByText(fixture.users.admin.name, { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|刪除|還原/ }).count(), 0);
    await shot(page, 'restored-case-history-desktop.png'); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert(await trigger.evaluate(node => node === document.activeElement), 'History close returns actual focus to its trigger');
  });
  mark('G5 保存歷程/精確前版/操作者與四次非空BLOB下載保持，歷程唯讀與焦點可用');

  await readOnly('G6 restored 390px financial report own horizontal scroll', async () => {
    const page = actors.finance.page; lastPage = page; await page.setViewportSize({ width: 390, height: 844 }); await loadReports(page); await display(page, 'fees');
    await monthControl(page).focus(); assert(await monthControl(page).evaluate(node => node === document.activeElement));
    const table = body(page).locator('.table-scroll').first(); assert(await table.evaluate(node => node.scrollWidth > node.clientWidth), 'Wide report owns its horizontal scroll');
    await table.evaluate(node => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = node.scrollWidth; }); assert(await table.evaluate(node => node.scrollLeft > 0));
    await body(page).locator('table').last().scrollIntoViewIfNeeded(); await shot(page, 'restored-fees-mobile.png');
    await table.evaluate(node => { node.scrollLeft = 0; }); assert.equal(await table.evaluate(node => node.scrollLeft), 0);
    same(readSyntheticRawState(restoredApp.db), readBaseline, 'Complete operational browser phase preserves every post-login saved row');
    same(counters(restoredApp.db), readCounts, 'No business/version/session writes during the full restored browser read phase');
  });
  mark('G6 390px既有控制項/試算說明/表內橫捲可用，頁面無溢出且完整讀取期零寫');

  safeStage = 'G7 closed controlled rollback and promotion';
  const liveBefore = counters(restoredApp.db);
  const changed = await apiJson(actors.admin, `cases/${fixture.items.case.id}`, { method: 'PATCH', data: { version: fixture.items.case.version, note: '合成039 scratch generation B；仅供controlled rollback' } });
  assert.equal(changed.item.version, 4); const liveAfter = counters(restoredApp.db);
  assert(liveAfter.totalChanges > liveBefore.totalChanges, 'Normal controlled generation B change is separately accounted');
  writeSegments.push({ label: 'normal-controlled-live-generation-B-case-PATCH', before: liveBefore, after: liveAfter, changes: liveAfter.totalChanges - liveBefore.totalChanges });
  const generationB = readSyntheticRawState(restoredApp.db);
  await closeBrowser(); await restoredApp.close(); restoredApp = null;
  for (const suffix of ['-wal', '-shm', '-journal']) assert(!existsSync(livePath + suffix), 'All controlled live handles close before promotion');
  const generationBFileSha = sha(await readFile(livePath));
  const staged = restoreSyntheticBackup(workspace, ref, 'staged'); assert.equal(staged.status, 'restored'); assert.equal(staged.target, 'staged');
  const rollback = promoteSyntheticRestore(workspace, { forceRollback: true });
  assert.equal(rollback.status, 'rolled_back'); assert.equal(rollback.previous, null); assert(rollback.staged);
  assert.equal(sha(await readFile(livePath)), generationBFileSha, 'Forced rollback restores exact closed generation B main bytes');
  assert.equal(rollback.live.fingerprint, rollback.before.fingerprint); assert.equal(rollback.live.mainFileSha256, generationBFileSha);
  const success = promoteSyntheticRestore(workspace, { forceRollback: false });
  assert.equal(success.status, 'promoted'); assert.equal(success.staged, null);
  assert.equal(success.previous.mainFileSha256, generationBFileSha); assert.equal(sha(await readFile(syntheticDatabasePath(workspace, 'previous'))), generationBFileSha);
  const promotedA = independentRead(livePath); same(promotedA, sourceBefore, 'Successful promotion installs exact saved snapshot A columns/schema/BLOB/session values');
  same(fixture.readRawState(), sourceBefore, 'Closed rollback/promotion leave the live source fixture unchanged'); same(counters(fixture.app.db), sourceCounts, 'Whole backup/browser/rehearsal workflow writes no additional source rows');
  assert.equal(writeSegments.reduce((total, item) => total + item.changes, 0), liveAfter.totalChanges, 'All restored login and generation B changes reconcile exactly');
  assert.equal(checks.length, 6); assert.equal(screenshots.length, 4); assert.equal(readSegments.length, 4); assert.equal(csvChecks.length, 2); assert.equal(blobDownloads.length, 4);
  assert.equal(pageErrors.length, 0); assert.equal(consoleErrors.length, 0); assert.equal(failedResponses.length, 0);
  const sourceHashesAfter = await collectSources(); same(sourceHashesAfter, sourceHashesBefore, 'All consumed source files remain byte-identical during the explicit run');
  mark('G7 關閉handle後forced rollback精確恢復B，再promotion安裝A並保留B；來源與全部寫入對帳保持');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base,
    actual4310Touched: false, checks, screenshots, readSegments, writeSegments, sourceWriteLedger: fixture.writeLedger,
    sourceAccountedChanges: fixture.writeLedger.reduce((total, item) => total + item.changes, 0), restoredAccountedChanges: writeSegments.reduce((total, item) => total + item.changes, 0),
    apiChecks, uiQueries, csvChecks, blobDownloads, fourRoles: 4, organizations: 2, tables: 11, immutableTriggers: 6,
    sourceInspection, restoredInspection: restored, startupChanges: 0, retainedValidSession: true, expiredAndAnonymousStatus: 401, rawSessionsEqualBeforeLogin: true, restoredLoginChanges: 5,
    sourceRawBeforeSha256: rawSha(sourceBefore), sourceRawAfterSha256: rawSha(fixture.readRawState()), restoredReadBaselineSha256: rawSha(readBaseline), restoredReadBaselineCounters: readCounts,
    walProof: { checkpoint: fixture.walProof.checkpoint, mainHashAtCheckpoint: fixture.walProof.mainHashAtCheckpoint, mainHashAfterWalWrite: fixture.walProof.mainHashAfterWalWrite, walBytes: fixture.walProof.walBytes, beforeVersion: 2, afterVersion: 3 },
    controlledPromotion: { rolledBackStatus: rollback.status, promotedStatus: success.status, generationBClosedMainSha256: generationBFileSha, generationBRawSha256: rawSha(generationB), previousMainSha256: success.previous.mainFileSha256, promotedRawSha256: rawSha(promotedA), sourceUnchanged: true },
    sourceHashesBefore, sourceHashesAfter, consumedSourceCount: Object.keys(sourceHashesBefore).length, pageErrors, consoleErrors, failedResponses,
    pdfOperations: 0, printOperations: 0, visualReviewPending: true, limitations: ['Synthetic plaintext owned rehearsal only; no authenticity/encryption/RPO-RTO/formal migration/production/UAT claim.', 'Raw source credentials, passwords/hashes, session cookies/CSRF, business records and BLOB bytes are excluded from JSON and console.', 'Fresh raw CSV is verified independently; formatted screen text does not establish CSV identity.', 'No existing default database, actual 4310, original platform credentials, real personal data, external action or new UI is used.'] }, null, 2));
  console.log(`Synthetic backup E2E passed: ${checks.length} gates, ${screenshots.length} PNG, ${readSegments.length} read-only segments`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const errorSha256 = sha(error.stack || error.message || String(error));
  const locations = (error.stack || '').split('\n').filter(line => /^\s*at /.test(line) && /\.m?js:\d+/.test(line)).map(line => line.trim());
  const sourceHashesAfter = await collectSources().catch(() => null);
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version, localhostBase: base, actual4310Touched: false,
    checks, screenshots, readSegments, writeSegments, apiChecks, uiQueries, csvChecks, blobDownloads, sourceHashesBefore, sourceHashesAfter,
    failure: { stage: safeStage, code: error.code || 'E2E_FAILURE', name: error.name, errorSha256, locations }, pageErrors, consoleErrors, failedResponses, pdfOperations: 0, printOperations: 0, visualReviewPending: true }, null, 2));
  throw new Error(`Synthetic backup E2E failed during ${safeStage}; ${checks.length} complete gates; original error SHA ${errorSha256}`);
} finally {
  await closeBrowser(); await restoredApp?.close(); await fixture?.close(); if (workspace) disposeSyntheticWorkspace(workspace);
}
