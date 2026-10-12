import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticLegacyHistoryFixture } from './helpers/legacy-history-fixture.mjs';
import { captureLegacyArchive } from '../src/server/legacy-migration-archive.mjs';
import { createVerifiedLegacyHistorySource, legacyHistorySourceHash, previewLegacyHistoryImport, commitLegacyHistoryImport } from '../src/server/legacy-history-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root, 'outputs/software/legacy-history-qa', 'attempt-' + randomUUID());
await mkdir(output, { recursive: true, mode: 0o700 }); console.log('EVIDENCE ' + output);
const boundFiles = ['public/app.js', 'public/ui.js', 'public/styles.css', 'public/modules/legacy-history.js', 'public/data/legacy-history.js', 'public/data/legacy-migrations.js',
  'src/server/index.mjs', 'src/server/legacy-history-import.mjs', 'src/server/legacy-history-format.mjs', 'src/server/legacy-migration-archive.mjs',
  'src/server/legacy-migration-archive-metadata.mjs', 'src/server/legacy-operational-import.mjs', 'src/server/legacy-operational-import-format.mjs',
  'tests/helpers/legacy-history-fixture.mjs', 'tests/legacy-history-e2e.mjs'];
const sources = async () => Object.fromEntries(await Promise.all(boundFiles.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const sourceBefore = await sources(), { chromium } = createRequire(import.meta.url)('playwright');
const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(), password = 'synthetic-history-browser-password-only';
assert.notEqual(new URL(base).port, '4310'); assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, executablePath }), contexts = [], fixtures = [], checks = [], images = [], pageErrors = [], requestLog = [];
let page, context, auth, orgId, mainFixture, committed, outcome = 'failed', stage = 'setup', mode = 'normal', hold, tailProof;
const flags = { sourceSystemComplete: false, operationalConversionCompleted: false, approvalCompleted: false, payrollApproved: false };
const mark = name => { checks.push(name); console.log('PASS ' + name); };
const raw = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])) });
const readOnly = async work => { const before = raw(); await work(); assert.deepEqual(raw(), before); };
const request = async (client, method, endpoint, data, expected = 200, session = auth, extra = {}) => {
  const response = await client.request.fetch(base + endpoint, { method, headers: { Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': session?.csrfToken || '', ...extra }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), expected, `${method} ${new URL(base + endpoint).pathname}: unexpected status`); return response.json();
};
const modal = name => page.getByRole('dialog', { name, exact: true });
const close = async dialog => { const handle = await dialog.elementHandle(); await dialog.getByRole('button', { name: '關閉', exact: true }).click(); await page.waitForFunction(node => !node.isConnected, handle); await handle.dispose(); };
const refresh = () => page.locator('.toolbar').getByRole('button', { name: '重新讀取', exact: true });
const visit = async () => { await page.goto(base + '/#/legacy-history'); await page.reload(); await page.getByRole('heading', { name: '歷史原始紀錄', level: 1, exact: true }).waitFor(); await page.getByRole('button', { name: '查看批次', exact: true }).first().waitFor(); };
const openBatch = async () => { await page.locator('table tbody tr').filter({ hasText: '27 列' }).getByRole('button', { name: '查看批次', exact: true }).click(); const dialog = modal('歷史原始批次'); await dialog.getByRole('button', { name: '查看原文', exact: true }).first().waitFor(); return dialog; };
const openRow = async (index = 0) => { const parent = await openBatch(); await parent.getByRole('button', { name: '查看原文', exact: true }).nth(index).click(); const dialog = modal('完整歷史原欄位'); await dialog.getByRole('heading', { name: '完整來源原欄位', exact: true }).waitFor(); return { parent, dialog }; };
const batchRows = dialog => dialog.getByRole('region', { name: '本批歷史原始列，每頁最多 25 列，可左右捲動', exact: true }).locator('tbody tr');
const columnRows = dialog => dialog.getByRole('region', { name: '完整歷史原欄位，可左右捲動', exact: true }).locator('tbody tr');
async function shot(name) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
    dialogs: [...document.querySelectorAll('dialog[open]')].map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, client: node.clientWidth })) }));
  assert(geometry.document <= geometry.viewport + 1); for (const dialog of geometry.dialogs) { assert(dialog.left >= -1 && dialog.right <= geometry.viewport + 1); assert(dialog.scroll <= dialog.client + 1); }
  const file = name + '.png'; await page.screenshot({ path: path.join(output, file) }); images.push({ name: file, geometry, sha256: createHash('sha256').update(await readFile(path.join(output, file))).digest('hex') });
}
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Synthetic held request did not reach its expected state in 10 seconds')), 10000); timer.unref(); })]);
function holdNext(kind) { const value = { kind, used: false, entered: defer(), release: defer(), handled: defer() }; hold = value; return value; }
async function release(value) { value.release.resolve(); await bounded(value.handled.promise); hold = null; }
async function changed(kind) {
  await page.evaluate(async kind => { const ui = await import('/ui.js'), context = ui.getContext();
    if (kind === 'hash') location.hash = '#/help';
    else if (kind === 'render') document.querySelector('[data-render-version^="legacy-history:"]').dataset.renderVersion = 'invalidated';
    else {
      if (kind === 'organization') { context.organizationId = '99999999-9999-4999-8999-999999999999'; context.orgId = context.organizationId; }
      if (kind === 'role') context.role = 'finance';
      if (kind === 'employee') context.user.employeeId = '88888888-8888-4888-8888-888888888888';
      if (kind === 'user') context.user.id = '77777777-7777-4777-8777-777777777777';
      if (kind === 'outer') ui.setContext(context, context.organizationId);
      window.dispatchEvent(new Event('session-updated'));
    }
  }, kind);
}
try {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context);
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成歷史管理者', email: 'synthetic-history-admin@example.test', password, organizationName: '合成歷史驗收機構' } }); assert.equal(setup.status(), 201);
  auth = await setup.json(); orgId = auth.organizations[0].id; const ctx = { orgId, user: auth.user, role: 'admin', employeeId: null };
  const employee = (await request(context, 'POST', '/api/employees', { name: '合成已核對員工', employeeNo: 'SYN-HIST-EMP', role: 'caregiver', status: 'active' }, 201)).item;
  const person = (await request(context, 'POST', '/api/cases', { name: '合成已核對個案', caseNo: 'SYN-HIST-CASE', status: 'closed', supervisorId: employee.id }, 201)).item;
  for (let count = 1; count <= 25; count++) { const fixture = createSyntheticLegacyHistoryFixture(app.db, ctx, { count, commit: true }); fixtures.push(fixture); }
  mainFixture = createSyntheticLegacyHistoryFixture(app.db, ctx, { count: 27, columnCount: 8, caseId: person.id, employeeId: employee.id }); fixtures.push(mainFixture);
  const longSource = '合成完整歷史長文字\r\n'.repeat(1500) + '<img src=x onerror="window.__historyExecuted=1">\u0000合成完整尾端';
  mainFixture.payload.records[1].columns[0].raw = longSource;
  mainFixture.payload.records[2].columns = Array.from({ length: 500 }, (_, index) => ({ columnIndex: index + 1, label: index < 2 ? '重複欄名' : '合成欄位-' + (index + 1), raw: index === 499 ? '合成第500欄原文' : index, formula: null, cached: null }));
  // A new owned synthetic original is captured before verification. The existing sealed archive is never edited.
  const original = Buffer.from(JSON.stringify({ rows: mainFixture.payload.records })); writeFileSync(path.join(mainFixture.incomingPath, 'synthetic.json'), original, { mode: 0o600 });
  const capture = captureLegacyArchive({ inputPath: mainFixture.incomingPath, outputParent: path.dirname(mainFixture.archivePath), scope: {
    format: 'suiyue-legacy-export-scope-v1', provider: 'synthetic', tenant: 'synthetic-tenant', exportedAt: '2020-01-02T03:04:05.000Z',
    datasets: [{ id: 'synthetic-history', sourceFiles: ['synthetic.json'], sourceRowCount: 27, reportedCoverage: 'partial', range: { kind: 'unknown' } }],
    missingDatasets: ['synthetic-attachments'], unresolved: ['synthetic-no-business-conversion'],
  } });
  const capability = createVerifiedLegacyHistorySource({ archivePath: path.join(path.dirname(mainFixture.archivePath), capture.archiveId), expectedManifestSha256: capture.manifestSha256 });
  mainFixture.payload.archiveManifestSha256 = capture.manifestSha256; mainFixture.payload.sourceFiles = [{ fileId: 'file-00000001', sha256: createHash('sha256').update(original).digest('hex') }]; original.fill(0);
  mainFixture.payload.sourceHash = legacyHistorySourceHash({ provider: mainFixture.payload.provider, tenant: mainFixture.payload.tenant,
    sourceFiles: mainFixture.payload.sourceFiles, records: mainFixture.payload.records });
  const preview = previewLegacyHistoryImport(app.db, ctx, mainFixture.payload, capability);
  committed = commitLegacyHistoryImport(app.db, ctx, mainFixture.payload, capability, preview.previewHash);
  const clients = {};
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const user = (await request(context, 'POST', '/api/users', { name: '合成歷史' + role, email: `synthetic-history-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) }, 201)).item;
    const owned = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(owned);
    const login = await owned.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: user.email, password } }); assert.equal(login.status(), 200); clients[role] = { context: owned, auth: await login.json() };
  }
  await request(context, 'PATCH', '/api/cases/' + person.id, { version: person.version, name: '合成目前新姓名' });
  const foreignOrgId = randomUUID(); app.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(foreignOrgId, '合成外部機構', new Date().toISOString());
  page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000); page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/legacy-history')) requestLog.push({ method: request.method(), path: url.pathname, query: url.search }); });
  await page.route('**/api/legacy-history**', async route => {
    const endpoint = new URL(route.request().url()).pathname, activeHold = hold && !hold.used && (hold.kind === 'list' ? endpoint === '/api/legacy-history' : endpoint.startsWith('/api/legacy-history/rows/')) ? hold : null;
    if (activeHold) activeHold.used = true;
    try {
      const response = await route.fetch(mode === 'deny-org' && endpoint.includes('/rows/') ? { headers: { ...route.request().headers(), 'x-org-id': foreignOrgId } } : {});
      if (activeHold) { activeHold.entered.resolve(); await activeHold.release.promise; await route.fulfill({ response }); }
      else if (mode === 'error' && endpoint.includes('/rows/')) await route.fulfill({ status: 503, json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成歷史暫時無法讀取，請重試。' } } });
      else if (mode === 'nested' && endpoint.includes('/rows/')) { const value = await response.json(); value.item.columns[0].raw = { private: 'SYNTHETIC-UNCONFIRMED' }; await route.fulfill({ response, json: value }); }
      else if (mode === 'empty' && endpoint === '/api/legacy-history') await route.fulfill({ response, json: { orgId, items: [], total: 0, page: 1, pageSize: 25, ...flags } });
      else if (mode === 'wrong-months' && endpoint === '/api/legacy-history') { const value = await response.json(); value.items[0].reportingPeriods = ['2020-02', '2020-01']; await route.fulfill({ response, json: value }); }
      else await route.fulfill({ response });
    } catch (error) { if (!activeHold || !/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { if (activeHold) activeHold.handled.resolve(); }
  });
  stage = 'paging'; await visit(); await readOnly(async () => {
    assert((await page.title()).includes('歷史原始紀錄')); assert.equal(await page.locator('.nav-link[data-route="/legacy-history"]').count(), 1);
    assert.equal(await page.locator('#main-content table tbody tr').count(), 25); await page.locator('#main-content .list-footer').getByRole('button', { name: '下一頁', exact: true }).click(); await page.getByText('共 26 筆 · 第 2 / 2 頁', { exact: true }).waitFor();
    assert.equal(await page.locator('#main-content table tbody tr').count(), 1); await page.locator('#main-content .list-footer').getByRole('button', { name: '上一頁', exact: true }).click(); await page.getByText('共 26 筆 · 第 1 / 2 頁', { exact: true }).waitFor(); await shot('list-1440');
    const parent = await openBatch(); assert.equal(await batchRows(parent).count(), 25); await parent.getByText('2020-01、2020-02', { exact: true }).waitFor(); await shot('batch-1440');
    await parent.getByRole('button', { name: '下一頁', exact: true }).click(); await parent.getByText('共 27 筆 · 第 2 / 2 頁', { exact: true }).waitFor(); assert.equal(await batchRows(parent).count(), 2);
    await parent.getByRole('button', { name: '上一頁', exact: true }).click(); await parent.getByText('共 27 筆 · 第 1 / 2 頁', { exact: true }).waitFor(); await close(parent);
  }); mark('G1 real admin route and both server25 page levels show original months and preserve all SQL');
  stage = 'literal-native'; await readOnly(async () => {
    const { parent, dialog } = await openRow(); await dialog.getByText('來源未提供原始識別碼', { exact: true }).waitFor();
    assert.equal(await columnRows(dialog).first().locator('td').nth(2).textContent(), mainFixture.payload.records[0].columns[0].raw);
    assert.equal(await columnRows(dialog).first().locator('td').nth(3).textContent(), mainFixture.payload.records[0].columns[0].formula);
    assert.equal(await dialog.locator('a,img,script').count(), 0); assert(await dialog.getByText('空白文字', { exact: true }).count() > 0);
    assert(await dialog.getByText('空值（null）', { exact: true }).count() > 0); assert(await dialog.getByText('false（布林值）', { exact: true }).count() > 0);
    await shot('literal-native-null-1440'); await close(dialog); await close(parent);
  }); mark('G2 complete raw types/NUL/CRLF/formula are text and absent native ID is never fabricated');
  stage = 'complete-columns-and-reference'; await readOnly(async () => {
    const { parent, dialog } = await openRow(2); assert.equal(await columnRows(dialog).count(), 500); await dialog.getByText('合成第500欄原文', { exact: true }).waitFor();
    await dialog.getByText('合成目前新姓名', { exact: true }).waitFor(); assert(await dialog.getByText('SYN-HIST-CASE · 目前主檔第 2 版', { exact: true }).count() === 1);
    assert.equal(await page.evaluate(() => window.__historyExecuted || 0), 0); await shot('complete-500-columns-1440'); await close(dialog); await close(parent);
  }); mark('G3 all500 columns remain readable; fresh limited case/employee references reflect current legitimate head');
  stage = 'mobile'; await page.setViewportSize({ width: 390, height: 844 }); await visit(); await readOnly(async () => {
    await shot('list-390'); const parent = await openBatch(); await shot('batch-390'); await parent.getByRole('button', { name: '查看原文', exact: true }).nth(1).click(); const dialog = modal('完整歷史原欄位'); await dialog.getByRole('heading', { name: '完整來源原欄位', exact: true }).waitFor(); await shot('raw-long-390');
    const text = columnRows(dialog).first().locator('td').nth(2).locator('span'); assert.equal(await text.textContent(), longSource);
    const visible = await text.evaluate(async node => {
      const range = document.createRange(), leaf = node.firstChild; range.setStart(leaf, leaf.textContent.length - '合成完整尾端'.length); range.setEnd(leaf, leaf.textContent.length);
      const dialog = node.closest('dialog'), footer = dialog.querySelector(':scope > .dialog-footer'), scroll = node.closest('.table-scroll');
      let bounds = range.getBoundingClientRect(); dialog.scrollTop += bounds.bottom - footer.getBoundingClientRect().top + 24;
      bounds = range.getBoundingClientRect(); let box = scroll.getBoundingClientRect(); scroll.scrollLeft += Math.max(0, bounds.right - box.right + 12);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); bounds = range.getBoundingClientRect(); box = dialog.getBoundingClientRect(); const clip = scroll.getBoundingClientRect(), bottom = footer.getBoundingClientRect().top;
      const glyphBoxes = [...range.getClientRects()].filter(box => box.width > 0 && box.height > 0), hits = glyphBoxes.map(box => { const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2); return hit === node || node.contains(hit); });
      return { tail: leaf.textContent.slice(-'合成完整尾端'.length), top: bounds.top, bottom: bounds.bottom, visibleTop: Math.max(box.top, 0), visibleBottom: Math.min(bottom, innerHeight),
        left: bounds.left, right: bounds.right, clipLeft: Math.max(clip.left, box.left, 0), clipRight: Math.min(clip.right, box.right, innerWidth), glyphBoxCount: glyphBoxes.length, hit: hits.length > 0 && hits.every(Boolean), nativeDialogScrollTop: dialog.scrollTop };
    });
    tailProof = visible; assert.equal(visible.tail, '合成完整尾端'); assert(visible.top >= visible.visibleTop && visible.bottom <= visible.visibleBottom); assert(visible.left >= visible.clipLeft && visible.right <= visible.clipRight); assert(visible.hit); assert(visible.nativeDialogScrollTop > 0);
    const closeButton = dialog.getByRole('button', { name: '關閉', exact: true }); assert(await closeButton.evaluate(node => { const r = node.getBoundingClientRect(); return r.height >= 44 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node; }));
    await shot('raw-tail-footer-390'); await close(dialog); await close(parent);
  }); mark('G4 390px table scroll, exact long-text glyph tail and44px native footer are operable without HTML execution');
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'empty'; mode = 'empty'; await page.reload(); await page.getByText('尚無已封存的歷史原始批次；請由管理者依受控封存流程建立。', { exact: true }).waitFor(); await shot('empty-1440'); mode = 'normal'; await visit(); mark('G5 empty state never claims original system completion or business conversion');
  stage = 'malformed-and-retry'; await readOnly(async () => {
    const parent = await openBatch(); mode = 'nested'; await parent.getByRole('button', { name: '查看原文', exact: true }).first().click(); const dialog = modal('完整歷史原欄位');
    await dialog.getByText('歷史原始紀錄回應無法確認；請重新讀取。', { exact: true }).waitFor(); assert.equal(await dialog.getByText('SYNTHETIC-UNCONFIRMED', { exact: false }).count(), 0); assert.equal(await dialog.locator('a,img,script').count(), 0); await shot('invalid-response-1440');
    mode = 'error'; await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText('合成歷史暫時無法讀取，請重試。', { exact: true }).waitFor(); await shot('error-retry-1440');
    mode = 'normal'; const count = requestLog.length; await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByRole('heading', { name: '完整來源原欄位', exact: true }).waitFor(); assert.equal(requestLog.length, count + 1); await close(dialog); await close(parent);
  }); mark('G6 malformed nested2xx and503 clear detail; one explicit retry causes one fresh GET');
  stage = 'fresh-permission'; await visit(); await readOnly(async () => {
    const parent = await openBatch(); mode = 'deny-org'; await parent.getByRole('button', { name: '查看原文', exact: true }).first().click();
    await page.getByText('目前無權查看歷史原始紀錄，請重新登入或聯絡機構管理者。', { exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('dialog[open]')); assert.equal(await page.locator('#main-content').getByText('合成目前新姓名', { exact: true }).count(), 0); await shot('permission-1440'); mode = 'normal';
  }); mark('G7 actual fresh foreign-org403 retracts source list and all owned nested dialogs');
  stage = 'loaded-context'; for (const kind of ['hash', 'organization', 'role', 'employee', 'user', 'outer', 'render']) { await visit(); await readOnly(async () => { await openRow(); await changed(kind); await page.waitForFunction(() => !document.querySelector('dialog[open]')); }); }
  mark('G8 all seven loaded identity/route/render owners revoke historical text');
  stage = 'same-primitives'; await visit(); await readOnly(async () => { const { parent, dialog } = await openRow(); await page.evaluate(async () => { const ui = await import('/ui.js'), context = ui.getContext(); context.user = { ...context.user }; }); assert(await dialog.isVisible()); await close(dialog); await close(parent); });
  mark('G9 nested identity object replacement with the same primitives keeps valid reading');
  stage = 'pending-context'; for (const kind of ['hash', 'organization', 'role', 'employee', 'user', 'outer', 'render']) {
    await visit(); await readOnly(async () => { const parent = await openBatch(), pending = holdNext('row'); const failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.includes('/legacy-history/rows/') && request.failure()?.errorText === 'net::ERR_ABORTED'); failed.catch(() => {});
      await parent.getByRole('button', { name: '查看原文', exact: true }).first().click(); await bounded(pending.entered.promise); await changed(kind); await failed; await release(pending); await page.waitForFunction(() => !document.querySelector('dialog[open]')); assert.equal(await page.locator('dialog').getByText('合成目前新姓名', { exact: true }).count(), 0);
    });
  } mark('G10 all seven pending owners abort real requests and late responses cannot restore historical text');
  stage = 'keyboard-busy'; await visit(); await readOnly(async () => {
    const parent = await openBatch(), trigger = parent.getByRole('button', { name: '查看原文', exact: true }).first(), triggerHandle = await trigger.elementHandle(), pending = holdNext('row'); const failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.includes('/legacy-history/rows/') && request.failure()?.errorText === 'net::ERR_ABORTED'); failed.catch(() => {});
    try {
      // Busy CSS changes the accessible name; keep the actual original node instead of re-resolving another row.
      await triggerHandle.focus(); await page.keyboard.press('Enter'); await bounded(pending.entered.promise); assert.equal(await triggerHandle.getAttribute('aria-busy'), 'true'); assert.equal(await triggerHandle.getAttribute('aria-disabled'), 'true'); const count = requestLog.length; await triggerHandle.evaluate(node => node.click()); assert.equal(requestLog.length, count);
      await shot('loading-busy-1440'); await page.keyboard.press('Escape'); await failed; await release(pending); await modal('完整歷史原欄位').waitFor({ state: 'detached' }); assert.equal(await triggerHandle.evaluate(node => node === document.activeElement), true); await close(parent);
    } finally { await triggerHandle.dispose(); }
  }); mark('G11 canonical Enter/Escape and focusable busy guard prevent duplicate reads and restore row focus');
  stage = 'stale-list'; await visit(); await readOnly(async () => { const pending = holdNext('list'), failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/legacy-history' && request.failure()?.errorText === 'net::ERR_ABORTED'); failed.catch(() => {});
    await refresh().click(); await bounded(pending.entered.promise); await refresh().click(); await failed; await page.getByRole('button', { name: '查看批次', exact: true }).first().waitFor(); await release(pending); assert.equal(await page.locator('#main-content table tbody tr').count(), 25);
  }); mark('G12 superseded list reads abort and cannot replace the newer confirmed page');
  stage = 'role-gates'; const rowId = (await request(context, 'GET', `/api/legacy-history/batches/${committed.batchId}?page=1&pageSize=25`)).records[0].id;
  for (const client of Object.values(clients)) { const before = raw(); for (const endpoint of ['/api/legacy-history?page=1&pageSize=25', '/api/legacy-history/batches/' + committed.batchId, '/api/legacy-history/rows/' + rowId]) await request(client.context, 'GET', endpoint, undefined, 403, client.auth);
    const otherPage = await client.context.newPage(); await otherPage.goto(base + '/#/legacy-history'); await otherPage.getByText('目前角色無法使用此頁面，請聯絡機構管理者。', { exact: true }).waitFor(); assert.equal(await otherPage.locator('.nav-link[data-route="/legacy-history"]').count(), 0); assert.equal(await otherPage.getByRole('button', { name: '查看原文', exact: true }).count(), 0); assert.deepEqual(raw(), before);
  } mark('G13 all three nonadmin roles are denied by real server and admin-only direct-route/navigation gates');
  stage = 'anonymous-and-closed-http'; const anonymous = await browser.newContext(); contexts.push(anonymous); await readOnly(async () => { await request(anonymous, 'GET', '/api/legacy-history', undefined, 401, null); await request(context, 'POST', '/api/legacy-history', { inputPath: '/synthetic/not-an-import-path' }, 405); await request(context, 'GET', '/api/legacy-history?page=1&page=2', undefined, 422); await request(context, 'GET', '/api/legacy-history/source.json', undefined, 404); });
  mark('G14 anonymous/duplicate-query/arbitrary-pathPOST/unknownpath are rejected without SQL writes');
  stage = 'closed-months'; mode = 'wrong-months'; await page.reload(); await page.getByText('歷史原始紀錄回應無法確認；請重新讀取。', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '查看批次', exact: true }).count(), 0); await shot('invalid-months-1440'); mode = 'normal'; await visit();
  mark('G15 unsorted or unconfirmed source-month metadata never renders a misleading batch');
  assert(requestLog.every(request => request.method === 'GET')); assert.deepEqual(pageErrors, []); const sourceAfter = await sources(); assert.deepEqual(sourceAfter, sourceBefore); outcome = 'passed';
  await writeFile(path.join(output, 'browser.json'), JSON.stringify({ format: 'suiyue-legacy-history-browser-v1', status: outcome, syntheticOnly: true, stage, checks, images, pageErrors,
    fixtureHistoricalRows: 27, fixtureBatchCount: 26, ...flags, tailProof, requestLog, sourceBefore, sourceAfter, realDataAccessed: false, actual4310Accessed: false, formalDeployment: false }, null, 2), { mode: 0o600 });
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ status: 'failed', syntheticOnly: true, stage, checks, images, pageErrors, tailProof, error: error.stack, sourceBefore, sourceAfter: await sources() }, null, 2), { mode: 0o600 });
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error;
} finally {
  hold?.release.resolve(); for (const owned of contexts) await owned.close().catch(() => {}); await browser.close(); await app.close(); for (const fixture of fixtures) fixture.cleanup();
}
assert.equal(outcome, 'passed'); console.log('PASS ' + checks.length + ' legacy history browser gates; ' + images.length + ' synthetic screenshots');
