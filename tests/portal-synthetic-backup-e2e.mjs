import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { constants, existsSync, copyFileSync, mkdtempSync, chmodSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTAL_ORIGIN } from '../src/server/portal-handoff.mjs';
import { createSyntheticPortalWorkspace, syntheticDatabasePath, inspectSyntheticDatabase, captureSyntheticBackup,
  restoreSyntheticBackup, promoteSyntheticRestore, disposeSyntheticWorkspace } from '../src/server/synthetic-portal-backup.mjs';
import { createSyntheticPortalBackupFixture, readPortalSyntheticRawState } from './portal-synthetic-backup-fixtures.mjs';
import { createSyntheticPortalHttpsGateway, installSyntheticPortalForm } from './helpers/synthetic-portal-https.mjs';

// Single explicit synthetic attempt. Real Chromium/TLS/form/receiver/UI; only
// external Portal pages are intercepted. Keys, cookies and raw rows stay memory-only.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/portal-synthetic-backup-qa/browser');
assert(!existsSync(output), 'Never overwrite a prior native browser attempt');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert(isDeepStrictEqual(actual, expected), label);
const rawDigest = raw => sha(JSON.stringify({ typedSchema: raw.typedSchema, typedTables: raw.typedTables, userVersion: raw.userVersion, applicationId: raw.applicationId }));
const protectedTables = ['attachment_files', 'certification_attachment_files', 'demo_seeds', 'idempotency', 'memberships', 'organizations', 'record_versions', 'records', 'users'];
const protectedDigest = raw => sha(JSON.stringify(Object.fromEntries(protectedTables.map(table => [table, raw.typedTables[table]]))));
const counters = db => ({ totalChanges: db.prepare('SELECT total_changes() n').get().n,
  ...Object.fromEntries(['records', 'record_versions', 'audit', 'sessions', 'portal_identity_bindings', 'portal_handoff_nonces', 'attachment_files', 'certification_attachment_files'].map(table => [table, db.prepare(`SELECT count(*) n FROM "${table}"`).get().n])) });
const independentRead = file => {
  // Readonly SQLite may create WAL sidecars. Observe a closed exclusive copy,
  // never the original slot; original closed-generation guards stay strict.
  const suffixes = ['-wal', '-shm', '-journal'];
  for (const suffix of suffixes) assert(!existsSync(file + suffix), 'Independent oracle requires a closed original with no sidecars');
  const before = lstatSync(file); assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  const originalSha256 = sha(readFileSync(file));
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'suiyue-portal-browser-oracle-'));
  let db;
  try {
    chmodSync(scratch, 0o700);
    const copy = path.join(scratch, 'oracle.sqlite'); copyFileSync(file, copy, constants.COPYFILE_EXCL); chmodSync(copy, 0o600);
    db = new DatabaseSync(copy, { readOnly: true });
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    return readPortalSyntheticRawState(db);
  } finally {
    try { db?.close(); } finally { rmSync(scratch, { recursive: true }); }
    const after = lstatSync(file);
    assert(after.isFile() && after.nlink === 1 && after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mode === before.mode);
    assert.equal(sha(readFileSync(file)), originalSha256, 'Independent copied oracle preserves original main bytes');
    for (const suffix of suffixes) assert(!existsSync(file + suffix), 'Independent copied oracle leaves every original sidecar absent');
  }
};
function fixedSourceRead() {
  assert.equal(arguments.length, 0, 'Source oracle only accepts the factory-owned fixed source slot');
  const file = syntheticDatabasePath(workspace, 'source'), suffixes = ['-wal', '-shm', '-journal'];
  const present = pathname => { try { return lstatSync(pathname); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const before = lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid());
  const owned = stat => assert(stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === before.uid && stat.gid === before.gid, 'Source observer permits only owned regular single-link files');
  const sameLease = (actual, expected) => assert(actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid && actual.gid === expected.gid && actual.mode === expected.mode, 'Source observer preserves every existing file lease');
  const originalSha256 = sha(readFileSync(file));
  const sidecarsBefore = Object.fromEntries(suffixes.map(suffix => [suffix, present(file + suffix)]));
  for (const stat of Object.values(sidecarsBefore)) if (stat) owned(stat);
  let db, raw, changesBefore, changesAfter, sidecarsAfter;
  try {
    // Capture may leave source WAL/SHM. Read committed WAL consistently instead
    // of copying only main bytes; this policy never applies to closed candidates.
    db = new DatabaseSync(file, { readOnly: true });
    changesBefore = db.prepare('SELECT total_changes() n').get().n; assert.equal(changesBefore, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    raw = readPortalSyntheticRawState(db); changesAfter = db.prepare('SELECT total_changes() n').get().n; assert.equal(changesAfter, 0);
  } finally {
    try { db?.close(); } finally {
      const after = lstatSync(file); owned(after); sameLease(after, before); assert.equal(after.size, before.size);
      assert.equal(sha(readFileSync(file)), originalSha256, 'Fixed source readonly observer preserves original main bytes');
      sidecarsAfter = Object.fromEntries(suffixes.map(suffix => [suffix, present(file + suffix)]));
      for (const suffix of suffixes) {
        if (sidecarsAfter[suffix]) owned(sidecarsAfter[suffix]);
        if (sidecarsBefore[suffix]) { owned(sidecarsAfter[suffix]); sameLease(sidecarsAfter[suffix], sidecarsBefore[suffix]); }
      }
      // No source checkpoint, chmod or sidecar removal; SHM lock bytes may vary.
    }
  }
  sourceOracleReads.push({ slot: 'source', tables: 13, immutableTriggers: 6, totalChangesBefore: changesBefore, totalChangesAfter: changesAfter, mainFileSha256Before: originalSha256, mainFileSha256After: sha(readFileSync(file)), mainFileLeaseUnchanged: true,
    existingSidecars: suffixes.filter(suffix => sidecarsBefore[suffix]), newOwnedSidecars: suffixes.filter(suffix => !sidecarsBefore[suffix] && sidecarsAfter[suffix]), existingSidecarLeasesUnchanged: true, rawSha256: rawDigest(raw) });
  return raw;
}
const collectSources = async () => {
  const names = ['tests/portal-synthetic-backup-e2e.mjs', 'tests/portal-synthetic-backup-fixtures.mjs', 'tests/synthetic-backup-fixtures.mjs', 'tests/attachment-fixtures.mjs', 'tests/helpers/synthetic-portal-https.mjs', 'docs/PORTAL_SYNTHETIC_BACKUP_RESTORE_SCOPE.md'];
  const walk = async dir => { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else names.push(file); } };
  for (const dir of ['public', 'src']) await walk(dir);
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const checks = [], screenshots = [], readSegments = [], sourceOracleReads = [], writeSegments = [], apiChecks = [], csvChecks = [], blobDownloads = [], pageErrors = [], consoleErrors = [], deniedChecks = [];
let workspace, fixture, sourceApp, liveApp, gateway, browser, context, page, form, sourceHashesBefore, baseline, sourceBaseline, sourceCounts, originalCookie, originalExpiresAt, stage = 'initialization', generation = 'source-A';
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const routeLabel = route => route.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, ':id');
const written = async (label, app, work) => {
  stage = label; const before = counters(app.db), result = await work(), after = counters(app.db);
  assert(after.totalChanges > before.totalChanges, 'Explicit write segment accounts actual logical changes');
  writeSegments.push({ label, generation, connection: app === sourceApp ? 'source-https' : 'restored-live', before, after, changes: after.totalChanges - before.totalChanges }); return result;
};
const readonly = async (label, app, work) => {
  stage = label; const before = counters(app.db), raw = readPortalSyntheticRawState(app.db), result = await work();
  same(counters(app.db), before, label + ': zero logical writes'); same(readPortalSyntheticRawState(app.db), raw, label + ': all thirteen tables/schema/storage classes unchanged');
  if (baseline && app === liveApp) same(raw, baseline, label + ': complete restored read phase unchanged');
  readSegments.push({ label, connection: app === sourceApp ? 'source-https' : 'restored-live', before, after: counters(app.db), tables: 13, immutableTriggers: 6, rawBeforeSha256: rawDigest(raw), rawAfterSha256: rawDigest(readPortalSyntheticRawState(app.db)), unchanged: true }); return result;
};
const api = async (route, { method = 'GET', data, status = 200, orgId = fixture.orgId, origin = gateway.origin, auth = null, headers = {} } = {}) => {
  const response = await context.request.fetch(gateway.origin + '/api/' + route, { method, maxRedirects: 0,
    headers: { Origin: origin, 'X-Org-Id': orgId, ...(auth ? { 'X-CSRF-Token': auth.csrfToken } : {}), ...headers }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), status, 'Real restored receiver keeps expected status: ' + routeLabel(route));
  apiChecks.push({ method, route: routeLabel(route), status, org: orgId === fixture.orgId ? 'primary' : 'foreign' }); return response;
};
const json = async (route, options) => (await api(route, options)).json();
const sessionExpiry = (db, cookie) => { const token = cookie.value; return db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(sha(token))?.expires_at; };
const workspaceVisible = async () => {
  await page.getByRole('heading', { name: '今日服務工作台', level: 1, exact: true }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert(!/[?&](payload|signature|token)=/.test(page.url()));
};
const layout = async () => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No global horizontal overflow');
  assert.equal(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).length), 0);
};
const shot = async name => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached' });
  await layout(); const file = path.join(output, name); await page.screenshot({ path: file, fullPage: false });
  screenshots.push({ name, sha256: sha(await readFile(file)), actualVisualReviewPending: true });
};
const reportSelect = () => page.getByLabel('報表類型', { exact: true });
const reportMonth = () => page.getByLabel('報表月份', { exact: true });
const reportBody = () => page.locator('.report-body');
const displayReport = async kind => {
  const waiting = page.waitForResponse(response => { const url = new URL(response.url()); return response.request().method() === 'GET' && url.pathname === '/api/reports/' + kind && url.searchParams.get('month') === fixture.month; });
  if (await reportSelect().inputValue() !== kind) await reportSelect().selectOption(kind); else await page.getByRole('button', { name: '重新查詢', exact: true }).click();
  const response = await waiting; assert.equal(response.status(), 200); const result = await response.json(); same(result, fixture.expected.frozenReports[kind], 'Saved source price snapshot equals restored actual report');
  await reportBody().getByRole('heading', { name: result.title, level: 2, exact: true }).waitFor();
  await reportBody().getByText(`${fixture.month} · ${result.rows.length} 筆`, { exact: true }).waitFor();
  await reportBody().getByText('試算，未核定規則', { exact: true }).waitFor(); assert.equal(await reportMonth().inputValue(), fixture.month);
  const money = cents => { const digits = String(cents).padStart(3, '0'); return '$' + digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + digits.slice(-2); };
  const table = reportBody().locator('table').first(), keys = result.columns.map(column => column.key);
  assert.equal(await table.locator('tbody tr').count(), result.rows.length);
  for (const [index, row] of result.rows.entries()) for (const key of keys.filter(value => /cents$/i.test(value))) assert.equal(await table.locator('tbody tr').nth(index).locator('td').nth(keys.indexOf(key)).textContent(), money(row[key]));
};
const noSidecars = slot => { const file = syntheticDatabasePath(workspace, slot); for (const suffix of ['-wal', '-shm', '-journal']) assert(!existsSync(file + suffix), 'All scratch handles close before capture/promotion'); };

await mkdir(path.dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
try {
  sourceHashesBefore = await collectSources(); workspace = createSyntheticPortalWorkspace();
  fixture = await createSyntheticPortalBackupFixture({ workspace });
  const initialRaw = readPortalSyntheticRawState(fixture.app.db);
  const expiredHash = sha(fixture.secrets.expiredCookie.split('=')[1]);
  const expiredRow = initialRaw.tables.sessions.find(row => row.token_hash === expiredHash);
  const expiredNonce = initialRaw.tables.portal_handoff_nonces.find(row => row.jti === fixture.secrets.expiredNonceJti);
  assert(expiredRow && expiredRow.expires_at < Date.now() && expiredNonce && expiredNonce.expires_at < Date.now());
  await fixture.closeSource(); noSidecars('source');
  gateway = await createSyntheticPortalHttpsGateway(); sourceApp = fixture.createAppForSlot('source', { publicOrigin: gateway.origin });
  assert.equal(counters(sourceApp.db).totalChanges, 0); same(readPortalSyntheticRawState(sourceApp.db), initialRaw, 'Writable source HTTPS startup causes zero logical changes');
  gateway.setBackend(await sourceApp.listen());
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', ignoreHTTPSErrors: true });
  form = await installSyntheticPortalForm(context, { destinationOrigin: gateway.origin, mintHandoff: () => fixture.mintHandoff('admin') });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => pageErrors.push({ messageSha256: sha(error.message) }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ messageSha256: sha(message.text()) }); });
  await written('normal-source-native-HTTPS-Portal-form-handoff-and-expiry-cleanup', sourceApp, async () => {
    const response = await form.submit(page); const attributes = (await response.allHeaders())['set-cookie'];
    assert(attributes.includes('Secure') && attributes.includes('HttpOnly') && attributes.includes('SameSite=Lax') && attributes.includes('Max-Age=28800'));
    await workspaceVisible();
  });
  const snapshotEnvelope = form.envelope;
  originalCookie = (await context.cookies(gateway.origin)).find(cookie => cookie.name === 'suiyue_session');
  assert(originalCookie?.secure && originalCookie.httpOnly && originalCookie.sameSite === 'Lax');
  originalExpiresAt = sessionExpiry(sourceApp.db, originalCookie); assert(originalExpiresAt > Date.now());
  await written('synthetic-INSERT-only-known-expired-snapshot-session-and-nonce', sourceApp, async () => {
    assert.equal(sourceApp.db.prepare('SELECT count(*) n FROM sessions WHERE token_hash=?').get(expiredRow.token_hash).n, 0);
    assert.equal(sourceApp.db.prepare('SELECT count(*) n FROM portal_handoff_nonces WHERE jti=?').get(expiredNonce.jti).n, 0);
    sourceApp.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(expiredRow.token_hash, expiredRow.user_id, expiredRow.csrf, expiredRow.expires_at);
    sourceApp.db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run(expiredNonce.jti, expiredNonce.issuer, expiredNonce.user_id, expiredNonce.org_id, expiredNonce.consumed_at, expiredNonce.expires_at);
  });
  await readonly('source original HTTPS session reload', sourceApp, async () => { await page.reload(); await workspaceVisible(); assert.equal(sessionExpiry(sourceApp.db, originalCookie), originalExpiresAt); await shot('source-portal-desktop.png'); });
  assert.equal(form.visits.length, 1); same(gateway.handoffRequests, [{ host: new URL(gateway.origin).host, origin: PORTAL_ORIGIN, encrypted: true }], 'Browser actual Host/Origin reach receiver unchanged');
  sourceBaseline = readPortalSyntheticRawState(sourceApp.db); sourceCounts = counters(sourceApp.db);
  const sourceProtected = protectedDigest(sourceBaseline);
  assert.equal(sourceCounts.totalChanges, writeSegments.filter(row => row.connection === 'source-https').reduce((sum, row) => sum + row.changes, 0));
  await sourceApp.close(); sourceApp = null; noSidecars('source');
  stage = 'closed source capture and exclusive Portal restore';
  const sourceInspection = inspectSyntheticDatabase(workspace, 'source'); assert.equal(sourceInspection.tableCount, 13); assert.equal(sourceInspection.triggerCount, 6); assert.equal(sourceInspection.format, 'suiyue-synthetic-portal-sqlite-inspection-v1');
  const backupRef = captureSyntheticBackup(workspace), restoredInspection = restoreSyntheticBackup(workspace, backupRef, 'live');
  assert.equal(restoredInspection.status, 'restored'); same(independentRead(syntheticDatabasePath(workspace, 'live')), sourceBaseline, 'Closed restore preserves full independent typed thirteen-table oracle');
  same(fixedSourceRead(), sourceBaseline, 'Capture/restore do not mutate source rows including committed WAL');
  mark('G1 真HTTPS Portal表單cookie與固定Host/Origin；閉合source後capture/restore精確保存十三表、schema、版本、nonce、binding及BLOB');

  generation = 'restored-B'; liveApp = fixture.createAppForSlot('live', { publicOrigin: gateway.origin });
  assert.equal(counters(liveApp.db).totalChanges, 0); same(readPortalSyntheticRawState(liveApp.db), sourceBaseline, 'Writable restored startup has zero logical writes');
  gateway.setBackend(await liveApp.listen()); baseline = sourceBaseline;
  await readonly('restored same native cookie and absolute session expiry', liveApp, async () => {
    await page.reload(); await workspaceVisible(); const auth = await json('session');
    assert.equal(auth.user.id, fixture.identities.admin.userId); assert.equal(auth.user.email, fixture.identities.admin.email); assert.equal(auth.user.role, 'admin');
    assert.equal(auth.authMode, 'portal'); assert.equal(sessionExpiry(liveApp.db, originalCookie), originalExpiresAt);
    const retainedCookie = (await context.cookies(gateway.origin)).find(cookie => cookie.name === 'suiyue_session');
    assert.equal(retainedCookie.value, originalCookie.value); assert.equal(retainedCookie.expires, originalCookie.expires);
    assert.equal(form.visits.length, 1); assert.equal(gateway.handoffRequests.length, 1); await shot('restored-portal-desktop.png');
  });
  mark('G2 還原Portal啟動零邏輯寫；同一原Secure cookie重新整理可讀且absolute expires_at/瀏覽器期限不續期，無第二次密碼');

  await readonly('restored reports UI saved prices and real browser CSV', liveApp, async () => {
    await page.goto(gateway.origin + '/#/reports'); await page.getByRole('heading', { name: '報表中心', level: 1, exact: true }).waitFor(); await reportSelect().waitFor();
    for (const kind of ['fees', 'payroll']) {
      await displayReport(kind); await shot(`restored-${kind}-desktop.png`);
      const response = await api(`reports/${kind}.csv?month=${fixture.month}`), bytes = await response.body(); assert(bytes.equals(fixture.expected.csvBytes[kind]));
      const downloadWaiting = page.waitForEvent('download'); await page.getByRole('button', { name: '下載 CSV', exact: true }).first().click();
      const download = await downloadWaiting, stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
      const downloaded = Buffer.concat(chunks); assert.equal(await download.failure(), null); assert(downloaded.equals(bytes));
      assert.equal(download.suggestedFilename(), `歲悅-${kind}-${fixture.month}.csv`);
      csvChecks.push({ kind, bytes: bytes.length, sha256: sha(bytes), sourceSha256: sha(fixture.expected.csvBytes[kind]), browserExact: true, savedIntegerCents: true });
    }
    same((await json('service-records/' + fixture.items.ownRecord.id)).item, fixture.items.ownRecord, 'Approved price snapshot remains saved despite current price edits');
  });
  mark('G3 原兩種費用薪資試算畫面與真CSV下載保存價格/分；不是正式支付或薪資核定');

  await readonly('restored histories and four nonempty BLOB downloads', liveApp, async () => {
    for (const [entity, item] of [['cases', fixture.items.case], ['service-records', fixture.items.ownRecord], ['employee-certifications', fixture.items.certification], ['case-attachments', fixture.items.caseAttachment], ['certification-attachments', fixture.items.certAttachment]]) {
      const result = await json(`${entity}/${item.id}/history?compare=previous`); same(result, fixture.expected.histories[entity], 'Full saved history equals pre-snapshot normal API history');
      assert.equal(result.items[0].version, item.version); assert.equal(result.items[0].comparison.previousVersion, item.version - 1);
    }
    for (const [entity, item, expected] of [['case-attachments', fixture.items.caseAttachment, fixture.expected.caseBytes], ['certification-attachments', fixture.items.certAttachment, fixture.expected.certBytes]]) for (const version of [null, 1]) {
      const response = await api(`${entity}/${item.id}/download${version === null ? '' : '?recordVersion=' + version}`), bytes = await response.body(); assert(bytes.length > 0 && bytes.equals(expected));
      blobDownloads.push({ entity, version: version || 'current', bytes: bytes.length, sha256: sha(bytes), sourceSha256: sha(expected), exact: true });
    }
    await page.goto(gateway.origin + '/#/cases/' + fixture.items.case.id); await page.getByRole('heading', { name: fixture.items.case.name, level: 1, exact: true }).waitFor();
    const opener = page.getByRole('button', { name: '個案版本歷程', exact: true }); await opener.click();
    const dialog = page.getByRole('dialog', { name: '個案版本歷程', exact: true }); await dialog.waitFor(); await dialog.getByText('第 3 版', { exact: true }).waitFor();
    const card = dialog.locator('.history-version').filter({ has: page.getByText('第 3 版', { exact: true }) });
    await card.getByRole('row').filter({ hasText: '備註' }).getByText(fixture.items.case.note, { exact: true }).waitFor();
    await card.getByText(fixture.users.admin.name, { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|刪除|還原/ }).count(), 0); await shot('restored-history-desktop.png');
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); assert(await opener.evaluate(node => node === document.activeElement));
  });
  mark('G4 原版本與前版比較、歷程對話框/Escape回焦點及四次BLOB下載精確保持');

  await readonly('restored 390px shared layout and report horizontal scroll', liveApp, async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(gateway.origin + '/#/'); await workspaceVisible(); await shot('restored-portal-mobile.png');
    const menu = page.getByRole('button', { name: '選單', exact: true }); await menu.click(); await page.getByRole('dialog', { name: '功能選單', exact: true }).waitFor(); await shot('restored-menu-mobile.png');
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); assert(await menu.evaluate(node => node === document.activeElement));
    await page.goto(gateway.origin + '/#/reports'); await reportSelect().waitFor(); await displayReport('fees'); await reportMonth().focus(); assert(await reportMonth().evaluate(node => node === document.activeElement));
    const scroll = reportBody().locator('.table-scroll').first(); assert(await scroll.evaluate(node => node.scrollWidth > node.clientWidth));
    await scroll.evaluate(node => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = node.scrollWidth; }); assert(await scroll.evaluate(node => node.scrollLeft > 0)); await shot('restored-fees-mobile.png');
    await scroll.evaluate(node => { node.scrollLeft = 0; }); await layout();
  });
  mark('G5 390px共同外框/選單/焦點/表格自身橫捲正常；全讀期十三表及trigger原樣零寫');

  await readonly('snapshot replay inactive expired and unchanged receiver guards', liveApp, async () => {
    const request = async (envelope, expected, code, headers = {}) => {
      const response = await context.request.post(gateway.origin + '/api/auth/handoff', { maxRedirects: 0, headers: { Origin: PORTAL_ORIGIN, ...headers }, form: envelope });
      assert.equal(response.status(), expected); assert.equal((await response.json()).error.code, code); deniedChecks.push({ kind: code, status: expected, unchanged: true });
    };
    await request(snapshotEnvelope, 409, 'HANDOFF_REPLAYED'); await request(fixture.snapshotReplayEnvelope, 409, 'HANDOFF_REPLAYED');
    await request(fixture.mintHandoff('inactive'), 403, 'PORTAL_IDENTITY_DENIED');
    await request(fixture.mintHandoff('admin'), 403, 'HANDOFF_ORIGIN_FORBIDDEN', { Origin: gateway.origin });
    await request(fixture.mintHandoff('admin'), 403, 'HOST_FORBIDDEN', { Host: 'unapproved.example.test' });
    const invalid = fixture.mintHandoff('admin'); await request({ payload: invalid.payload, signature: 'A'.repeat(43) }, 401, 'HANDOFF_INVALID');
    for (const [kind, cookie] of [['expired-session', fixture.secrets.expiredCookie], ['inactive-binding-session', fixture.secrets.inactiveCookie]]) {
      const response = await context.request.get(gateway.origin + '/api/dashboard', { headers: { Cookie: cookie, 'X-Org-Id': fixture.orgId } }); assert.equal(response.status(), 401);
      const current = await context.request.get(gateway.origin + '/api/session', { headers: { Cookie: cookie } }); assert.equal((await current.json()).user, null); deniedChecks.push({ kind, status: 401, unchanged: true });
    }
    assert.equal(sessionExpiry(liveApp.db, originalCookie), originalExpiresAt);
  });
  mark('G6 snapshot已消費nonce重放、inactive binding、expired session、Origin/Host/簽章仍拒絕且零寫');

  baseline = null; let postSnapshotEnvelope;
  await written('normal-post-snapshot-native-handoff-and-expiry-cleanup', liveApp, async () => { await form.submit(page); postSnapshotEnvelope = form.envelope; await workspaceVisible(); });
  const postSnapshotClaims = JSON.parse(Buffer.from(postSnapshotEnvelope.payload, 'base64url').toString('utf8'));
  assert(liveApp.db.prepare('SELECT 1 FROM portal_handoff_nonces WHERE jti=?').get(postSnapshotClaims.jti));
  await written('synthetic-explicit-post-snapshot-binding-revocation', liveApp, async () => {
    assert.equal(liveApp.db.prepare('UPDATE portal_identity_bindings SET active=0 WHERE user_id=? AND active=1').run(fixture.identities.admin.userId).changes, 1);
  });
  const revoked = await json('session'); assert.equal(revoked.user, null); await api('dashboard', { status: 401 });
  const generationB = readPortalSyntheticRawState(liveApp.db); assert.equal(protectedDigest(generationB), sourceProtected);
  assert.notEqual(rawDigest(generationB), rawDigest(sourceBaseline));
  const finalLiveChanges = counters(liveApp.db).totalChanges;
  assert.equal(finalLiveChanges, writeSegments.filter(row => row.connection === 'restored-live').reduce((sum, row) => sum + row.changes, 0));
  await liveApp.close(); liveApp = null; noSidecars('live');
  const livePath = syntheticDatabasePath(workspace, 'live'), generationBFileSha256 = sha(await readFile(livePath));
  restoreSyntheticBackup(workspace, backupRef, 'staged'); noSidecars('staged');
  const rollback = promoteSyntheticRestore(workspace, { forceRollback: true }); assert.equal(rollback.status, 'rolled_back'); assert.equal(sha(await readFile(livePath)), generationBFileSha256); same(independentRead(livePath), generationB, 'Forced rollback restores exact closed B saved state');
  const promoted = promoteSyntheticRestore(workspace, { forceRollback: false }); assert.equal(promoted.status, 'promoted'); assert.equal(promoted.previous.mainFileSha256, generationBFileSha256);
  same(independentRead(syntheticDatabasePath(workspace, 'previous')), generationB, 'Previous slot retains exact post-snapshot revoked B');
  same(independentRead(livePath), sourceBaseline, 'Promotion installs exact snapshot A, not later nonce/revocation state');
  mark('G7 snapshot後真handoff/cleanup/撤權另記帳；撤權即拒session，closed forcedrollback精確回B，promotion回A並保留B');

  generation = 'promoted-A'; liveApp = fixture.createAppForSlot('live', { publicOrigin: gateway.origin }); assert.equal(counters(liveApp.db).totalChanges, 0); same(readPortalSyntheticRawState(liveApp.db), sourceBaseline, 'Promoted snapshot startup writes zero rows');
  gateway.setBackend(await liveApp.listen()); await context.addCookies([originalCookie]); baseline = sourceBaseline;
  await readonly('promoted snapshot session and post-snapshot state boundary', liveApp, async () => {
    assert.equal(liveApp.db.prepare('SELECT active FROM portal_identity_bindings WHERE user_id=?').get(fixture.identities.admin.userId).active, 1);
    assert.equal(liveApp.db.prepare('SELECT count(*) n FROM portal_handoff_nonces WHERE jti=?').get(postSnapshotClaims.jti).n, 0);
    await page.setViewportSize({ width: 1440, height: 1050 }); await page.goto(gateway.origin + '/#/'); await workspaceVisible(); await page.reload(); await workspaceVisible();
    assert.equal((await json('session')).user.id, fixture.identities.admin.userId); assert.equal(sessionExpiry(liveApp.db, originalCookie), originalExpiresAt); await shot('promoted-portal-desktop.png');
  });
  baseline = null;
  await written('normal-reconsumption-of-post-snapshot-handoff-after-restore', liveApp, async () => {
    assert(postSnapshotClaims.exp > Math.floor(Date.now() / 1000), 'The original post-snapshot synthetic envelope is still within receiver lifetime');
    const response = await context.request.post(gateway.origin + '/api/auth/handoff', { maxRedirects: 0, headers: { Origin: PORTAL_ORIGIN }, form: postSnapshotEnvelope }); assert.equal(response.status(), 303);
    assert(liveApp.db.prepare('SELECT 1 FROM portal_handoff_nonces WHERE jti=?').get(postSnapshotClaims.jti));
    const newCookie = (await context.cookies(gateway.origin)).find(cookie => cookie.name === 'suiyue_session'); const nextExpiry = sessionExpiry(liveApp.db, newCookie);
    assert(nextExpiry > originalExpiresAt); assert(Math.abs(nextExpiry - Date.now() - 8 * 3600000) < 5000);
  });
  assert.equal(protectedDigest(readPortalSyntheticRawState(liveApp.db)), sourceProtected);
  assert.equal(counters(liveApp.db).totalChanges, writeSegments.filter(row => row.generation === 'promoted-A').reduce((sum, row) => sum + row.changes, 0));
  same(fixedSourceRead(), sourceBaseline, 'Source including committed WAL remains exact throughout all browser and promotion phases');
  assert.equal(sourceOracleReads.length, 2);
  assert.equal(checks.length, 7); assert.equal(screenshots.length, 9); assert.equal(csvChecks.length, 2); assert.equal(blobDownloads.length, 4);
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(gateway.errors, []);
  const sourceHashesAfter = await collectSources(); same(sourceHashesAfter, sourceHashesBefore, 'Every consumed runtime/public/test byte remains exact during this attempt');
  mark('G8 promotion恢復原cookie與absolute期限；快照後撤權/nonce消費實際不保留，重用該仍有效聲明可新起八小時，正式reconciliation/keyrotation待核定');
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version,
    checks, screenshots, readSegments, sourceOracleReads, writeSegments, legacyNormalApiSeedWriteLedger: fixture.legacyWriteLedger, legacyNormalApiSeedChanges: fixture.legacyWriteLedger.reduce((sum, row) => sum + row.changes, 0), sourceFixtureWriteLedger: fixture.writeLedger, sourceFixtureChanges: fixture.writeLedger.reduce((sum, row) => sum + row.changes, 0),
    sourceHttpsChanges: sourceCounts.totalChanges, restoredGenerationBChanges: finalLiveChanges, promotedGenerationAChanges: counters(liveApp.db).totalChanges,
    apiChecks, csvChecks, blobDownloads, deniedChecks, tables: 13, immutableTriggers: 6, sourceInspection, restoredInspection,
    startupChanges: 0, sourceHttpsStartupChanges: 0, promotedStartupChanges: 0, writableConnectionButZeroStartupLogicalWrites: true,
    tlsGatewayReal: true, originalHostAndOriginPreserved: true, secureHttpOnlyLaxCookieVerified: true, cookieMaxAge: 28800, originalAbsoluteExpiresAt: originalExpiresAt, retainedCookieExpiryNotRenewed: true,
    portalVisits: form.visits.length, nativeSuccessfulFormPosts: 2, snapshotNonceReplayRejected: true, expiredSnapshotSessionRejected: true, inactiveSnapshotBindingRejected: true,
    postSnapshotRevocationNotRetained: true, postSnapshotNonceConsumptionNotRetained: true, postSnapshotEnvelopeActuallyReusable: true, newHandoffStartsNewEightHours: true,
    sourceRawSha256: rawDigest(sourceBaseline), protectedBusinessRawSha256: sourceProtected,
    controlledPromotion: { forcedRollback: rollback.status, success: promoted.status, generationBFileSha256, generationBRawSha256: rawDigest(generationB), installedSnapshotRawSha256: rawDigest(sourceBaseline), previousExact: true },
    sourceHashesBefore, sourceHashesAfter, consumedSourceCount: Object.keys(sourceHashesBefore).length, pageErrors, consoleErrors, gatewayErrors: gateway.errors,
    actual4310Touched: false, originalPlatformTouched: false, realAccountUsed: false, realPortalOrGoogleLoginPerformed: false, externalPagesIntercepted: true, syntheticOnly: true,
    pdfOperations: 0, printOperations: 0, automaticRetryPerformed: false, visualReviewPending: true, productionVerified: false,
    limitations: ['Snapshot restore returns binding/session/nonce state to snapshot time; later revocation or nonce consumption requires separately approved reconciliation.', 'Same memory signing key is used; key rotation alone does not revoke existing database sessions, and no formal rotation policy is implemented.', 'Only count/digest/expiry evidence is emitted; raw identities, binding, nonce, cookies, keys and stored table values are excluded.', 'No official restore, migration, encryption, retention, RPO/RTO, performance, native popup geometry, human UAT or deployment claim.'] }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Synthetic Portal backup browser passed: ${checks.length} gates, ${screenshots.length} PNG`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  const errorSha256 = sha(error.stack || error.message || String(error));
  const locations = (error.stack || '').split('\n').filter(line => /^\s*at /.test(line) && /\.m?js:\d+/.test(line)).map(line => line.trim());
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), executionRoot: root, nodeVersion: process.version,
    checks, screenshots, readSegments, sourceOracleReads, writeSegments, apiChecks, csvChecks, blobDownloads, deniedChecks, sourceHashesBefore, sourceHashesAfter: await collectSources().catch(() => null),
    failure: { stage, code: error.code || 'E2E_FAILURE', name: error.name, errorSha256, locations }, pageErrors, consoleErrors, gatewayErrors: gateway?.errors || [],
    syntheticOnly: true, actual4310Touched: false, automaticRetryPerformed: false, visualReviewPending: true }, null, 2) + '\n', { flag: 'wx' });
  throw new Error(`Synthetic Portal backup browser failed during ${stage}; ${checks.length} gates complete; private error SHA ${errorSha256}`);
} finally {
  await context?.close(); await browser?.close(); await gateway?.close(); await sourceApp?.close(); await liveApp?.close(); await fixture?.close(); if (workspace) disposeSyntheticWorkspace(workspace);
}
