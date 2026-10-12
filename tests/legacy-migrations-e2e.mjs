import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticLegacyMigrationFixture } from './helpers/legacy-migration-fixture.mjs';
import { previewLegacyOperationalImport, commitLegacyOperationalImport, legacyOperationalId } from '../src/server/legacy-operational-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), qaRoot = path.join(root, 'outputs/software/legacy-migrations-qa');
await mkdir(qaRoot, { recursive: true }); const output = await mkdtemp(path.join(qaRoot, 'attempt-')); console.log('EVIDENCE ' + output);
const boundFiles = ['public/app.js', 'public/ui.js', 'public/styles.css', 'public/modules/legacy-migrations.js', 'public/data/legacy-migrations.js',
  'src/server/index.mjs', 'src/server/legacy-operational-import.mjs', 'src/server/legacy-operational-import-format.mjs', 'src/server/legacy-migration-archive.mjs',
  'tests/helpers/legacy-migration-fixture.mjs', 'tests/legacy-migrations-e2e.mjs'];
const sources = async () => Object.fromEntries(await Promise.all(boundFiles.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const sourceBefore = await sources(), { chromium } = createRequire(import.meta.url)('playwright');
const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(), password = 'synthetic-legacy-ui-password';
assert.notEqual(new URL(base).port, '4310');
const browser = await chromium.launch({ headless: true, executablePath }), contexts = [], checks = [], images = [], pageErrors = [], requestLog = [];
let page, context, auth, orgId, fixture, outcome = 'failed', stage = 'setup', mode = 'normal', hold, tailProof;
const mark = name => { checks.push(name); console.log('PASS ' + name); };
const raw = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])) });
const request = async (client, method, endpoint, data, expected = 200, session = auth, extra = {}) => {
  const response = await client.request.fetch(base + endpoint, { method, headers: { Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': session?.csrfToken || '', ...extra }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), expected, await response.text()); return response.json();
};
const modal = name => page.getByRole('dialog', { name, exact: true });
const close = async dialog => { const handle = await dialog.elementHandle(); await dialog.getByRole('button', { name: '關閉', exact: true }).click(); await page.waitForFunction(node => !node.isConnected, handle); await handle.dispose(); };
const visit = async () => { await page.goto(base + '/#/legacy-migrations'); await page.reload(); await page.getByRole('heading', { name: '移轉紀錄', level: 1, exact: true }).waitFor(); await page.getByRole('button', { name: '查看批次', exact: true }).waitFor(); };
const openBatch = async () => { await page.getByRole('button', { name: '查看批次', exact: true }).click(); const dialog = modal('移轉批次資料'); await dialog.getByRole('button', { name: '查看原欄位', exact: true }).first().waitFor(); return dialog; };
const openRecord = async (rowIndex = 0) => { const parent = await openBatch(); await parent.getByRole('button', { name: '查看原欄位', exact: true }).nth(rowIndex).click(); const dialog = modal('完整移轉來源欄位'); await dialog.getByRole('heading', { name: '完整來源原欄位', exact: true }).waitFor(); return { parent, dialog }; };
const tableRows = dialog => dialog.getByRole('region', { name: '本批移轉紀錄，每頁最多 25 筆，可左右捲動', exact: true }).locator('tbody tr');
const readOnly = async work => { const before = raw(); await work(); assert.deepEqual(raw(), before); };
async function shot(name) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
    dialogs: [...document.querySelectorAll('dialog[open]')].map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, client: node.clientWidth })) }));
  assert(geometry.document <= geometry.viewport + 1); for (const dialog of geometry.dialogs) { assert(dialog.left >= -1 && dialog.right <= geometry.viewport + 1); assert(dialog.scroll <= dialog.client + 1); }
  await page.screenshot({ path: path.join(output, name + '.png') }); images.push({ name: name + '.png', geometry });
}
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function holdNext(kind) { const value = { kind, used: false, entered: defer(), release: defer(), handled: defer() }; hold = value; return value; }
async function release(value) { value.release.resolve(); await value.handled.promise; hold = null; }
async function changed(kind) {
  await page.evaluate(async kind => { const ui = await import('/ui.js'), context = ui.getContext();
    if (kind === 'hash') location.hash = '#/help';
    else if (kind === 'render') document.querySelector('[data-render-version^="legacy-migrations:"]').dataset.renderVersion = 'invalidated';
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
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成移轉管理者', email: 'synthetic-legacy-admin@example.test', password, organizationName: '合成移轉驗收機構' } }); assert.equal(setup.status(), 201);
  auth = await setup.json(); orgId = auth.organizations[0].id;
  const ctx = { orgId, user: auth.user, role: 'admin', employeeId: null }; fixture = createSyntheticLegacyMigrationFixture(app.db, ctx, { count: 27 });
  const longSource = '合成完整來源長文字\r\n'.repeat(1500) + '<img src=x onerror="window.__legacyExecuted=1">\u0000合成完整尾端';
  fixture.payload.records[1].data.note = '合成來源備註\r\n最後備註原文'; fixture.payload.records[1].columns[0].raw = longSource;
  const preview = previewLegacyOperationalImport(app.db, ctx, fixture.payload, fixture.capability); const committed = commitLegacyOperationalImport(app.db, ctx, fixture.payload, fixture.capability, preview.previewHash);
  const target = legacyOperationalId(orgId, fixture.payload.provider, fixture.payload.tenant, 'cases', fixture.payload.records[1].sourceId);
  const employeeId = legacyOperationalId(orgId, fixture.payload.provider, fixture.payload.tenant, 'employees', fixture.payload.records[0].sourceId);
  const current = (await request(context, 'GET', '/api/cases/' + target)).item;
  await request(context, 'PATCH', '/api/cases/' + target, { version: current.version, note: '合成目前主檔新備註' });
  const clients = {};
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const user = (await request(context, 'POST', '/api/users', { name: '合成移轉' + role, email: `synthetic-legacy-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId } : {}) }, 201)).item;
    const owned = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(owned);
    const login = await owned.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: user.email, password } }); assert.equal(login.status(), 200); clients[role] = { context: owned, auth: await login.json() };
  }
  const foreignOrgId = randomUUID(); app.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(foreignOrgId, '合成外部機構', new Date().toISOString());
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/legacy-migrations')) requestLog.push({ method: request.method(), path: new URL(request.url()).pathname, query: new URL(request.url()).search }); });
  await page.route('**/api/legacy-migrations**', async route => {
    const endpoint = new URL(route.request().url()).pathname, activeHold = hold && !hold.used && (hold.kind === 'list' ? endpoint === '/api/legacy-migrations' : endpoint.startsWith('/api/legacy-migrations/records/')) ? hold : null;
    if (activeHold) activeHold.used = true;
    try {
      const response = await route.fetch(mode === 'deny-org' && endpoint.includes('/records/') ? { headers: { ...route.request().headers(), 'x-org-id': foreignOrgId } } : {});
      if (activeHold) { activeHold.entered.resolve(); await activeHold.release.promise; await route.fulfill({ response }); }
      else if (mode === 'error' && endpoint.includes('/records/')) await route.fulfill({ status: 503, json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成來源暫時無法讀取，請重試。' } } });
      else if (mode === 'nested' && endpoint.includes('/records/')) { const value = await response.json(); value.item.columns[0].raw = { private: 'SYNTHETIC-UNCONFIRMED', formula: '<script>window.__legacyExecuted=1</script>' }; await route.fulfill({ response, json: value }); }
      else if (mode === 'empty' && endpoint === '/api/legacy-migrations') await route.fulfill({ response, json: { orgId, items: [], total: 0, page: 1, pageSize: 25, sourceSystemComplete: false } });
      else await route.fulfill({ response });
    } catch (error) { if (!activeHold || !/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { if (activeHold) activeHold.handled.resolve(); }
  });
  stage = 'paging'; await visit();
  await readOnly(async () => {
    assert((await page.title()).includes('移轉紀錄')); assert.equal(await page.locator('.nav-link[data-route="/legacy-migrations"]').count(), 1); await shot('list-1440');
    const parent = await openBatch(); assert.equal(await tableRows(parent).count(), 25); await shot('batch-1440');
    await parent.getByRole('button', { name: '下一頁', exact: true }).click(); await page.waitForFunction(() => document.querySelector('dialog[open] .pagination')?.textContent.includes('第 2 / 2 頁'));
    assert.equal(await tableRows(parent).count(), 2); await parent.getByRole('button', { name: '上一頁', exact: true }).click(); await parent.getByText('共 27 筆 · 第 1 / 2 頁', { exact: true }).waitFor(); await close(parent);
  }); mark('G1 real admin route/navigation and server25 paging keep SQL unchanged');
  stage = 'literal-derived'; await readOnly(async () => {
    const { parent, dialog } = await openRecord(); await dialog.getByText('此編號由移轉時產生', { exact: true }).waitFor();
    const rawValue = await dialog.getByRole('region', { name: '完整來源原欄位，可左右捲動', exact: true }).locator('tbody tr').first().locator('td').nth(2).textContent(); assert.equal(rawValue, fixture.payload.records[0].columns[0].raw);
    assert.equal(await dialog.locator('a,img,script').count(), 0); assert.equal(await dialog.getByText('空白文字', { exact: true }).count() >= 1, true); await shot('derived-record-1440');
    await close(dialog); await close(parent);
  }); mark('G2 duplicate labels/full CRLF-loneCR-NUL raw/formula/cached types remain literal; derived employee number is explicit');
  stage = 'snapshot-comparison'; await readOnly(async () => {
    const { parent, dialog } = await openRecord(1); await dialog.getByText('合成目前主檔新備註', { exact: true }).waitFor(); await dialog.getByText('不同', { exact: true }).waitFor();
    const saved = await dialog.getByRole('region', { name: '完整來源原欄位，可左右捲動', exact: true }).locator('tbody tr').first().locator('td').nth(2).textContent(); assert.equal(saved, longSource);
    assert.equal(await dialog.locator('a,img,script').count(), 0); assert.equal(await page.evaluate(() => window.__legacyExecuted || 0), 0); await shot('record-comparison-1440'); await close(dialog); await close(parent);
  }); mark('G3 actual newer target version differs from original snapshot; no original platform synchronization or formula execution');
  stage = 'mobile'; await page.setViewportSize({ width: 390, height: 844 }); await visit(); await readOnly(async () => {
    await shot('list-390'); const parent = await openBatch(); await shot('batch-390'); await parent.getByRole('button', { name: '查看原欄位', exact: true }).nth(1).click(); const dialog = modal('完整移轉來源欄位'); await dialog.getByRole('heading', { name: '完整來源原欄位', exact: true }).waitFor(); await shot('record-390');
    const text = dialog.getByRole('region', { name: '完整來源原欄位，可左右捲動', exact: true }).locator('tbody tr').first().locator('td').nth(2).locator('span');
    const complete = await text.textContent(); assert.equal(complete, longSource);
    const visible = await text.evaluate(async node => {
      const range = document.createRange(), leaf = node.firstChild; range.setStart(leaf, leaf.textContent.length - '合成完整尾端'.length); range.setEnd(leaf, leaf.textContent.length);
      const dialog = node.closest('dialog'), footer = dialog.querySelector(':scope > .dialog-footer'), scroll = node.closest('.table-scroll');
      let bounds = range.getBoundingClientRect(); dialog.scrollTop += bounds.bottom - footer.getBoundingClientRect().top + 24;
      bounds = range.getBoundingClientRect(); let box = scroll.getBoundingClientRect(); scroll.scrollLeft += Math.max(0, bounds.right - box.right + 12);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      bounds = range.getBoundingClientRect(); box = dialog.getBoundingClientRect(); const clip = scroll.getBoundingClientRect(), bottom = footer.getBoundingClientRect().top;
      const glyphBoxes = [...range.getClientRects()].filter(box => box.width > 0 && box.height > 0);
      const hits = glyphBoxes.map(box => { const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2); return hit === node || node.contains(hit); });
      return { tail: leaf.textContent.slice(-'合成完整尾端'.length), top: bounds.top, bottom: bounds.bottom, visibleTop: Math.max(box.top, 0), visibleBottom: Math.min(bottom, innerHeight),
        left: bounds.left, right: bounds.right, clipLeft: Math.max(clip.left, box.left, 0), clipRight: Math.min(clip.right, box.right, innerWidth), glyphBoxCount: glyphBoxes.length,
        hit: hits.length > 0 && hits.every(Boolean), nativeDialogScrollTop: dialog.scrollTop };
    });
    tailProof = visible;
    assert.equal(visible.tail, '合成完整尾端'); assert(visible.top >= visible.visibleTop && visible.bottom <= visible.visibleBottom); assert(visible.left >= visible.clipLeft && visible.right <= visible.clipRight);
    assert.equal(visible.hit, true); assert(visible.nativeDialogScrollTop > 0); await shot('record-tail-footer-390');
    const closeButton = dialog.getByRole('button', { name: '關閉', exact: true }); assert(await closeButton.evaluate(node => { const r = node.getBoundingClientRect(); return r.height >= 44 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node; }));
    await close(dialog); await close(parent);
  }); mark('G4 390 layout owns table horizontal scroll; exact long-text tail and native44px close footer remain readable');
  await page.setViewportSize({ width: 1440, height: 1000 });
  stage = 'empty'; mode = 'empty'; await page.reload(); await page.getByText('尚無移轉批次；請由管理者依核定移轉流程建立。', { exact: true }).waitFor(); await shot('empty-1440'); mode = 'normal'; await visit(); mark('G5 empty state is explicit and does not claim a completed source inventory');
  stage = 'fail-closed'; await readOnly(async () => {
    const parent = await openBatch(); mode = 'nested'; await parent.getByRole('button', { name: '查看原欄位', exact: true }).first().click(); let dialog = modal('完整移轉來源欄位');
    await dialog.getByText('移轉紀錄回應無法確認；請重新讀取。', { exact: true }).waitFor(); assert.equal(await dialog.getByText('SYNTHETIC-UNCONFIRMED', { exact: false }).count(), 0); assert.equal(await dialog.locator('img,script,a').count(), 0); await shot('invalid-response-1440');
    mode = 'error'; await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText('合成來源暫時無法讀取，請重試。', { exact: true }).waitFor(); await shot('error-retry-1440');
    mode = 'normal'; const count = requestLog.length; await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByRole('heading', { name: '完整來源原欄位', exact: true }).waitFor(); assert.equal(requestLog.length, count + 1); await close(dialog); await close(parent);
  }); mark('G6 malformed nested2xx and real503-like network error clear details; explicit retry performs exactly one fresh GET');
  stage = 'permission-retraction'; await visit(); await readOnly(async () => {
    const parent = await openBatch(); mode = 'deny-org'; await parent.getByRole('button', { name: '查看原欄位', exact: true }).first().click();
    await page.getByText('目前無權查看移轉紀錄，請重新登入或聯絡機構管理者。', { exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(await page.locator('#main-content').getByText('合成員工1', { exact: true }).count(), 0); await shot('permission-1440'); mode = 'normal';
  }); mark('G7 actual foreign-org403 retracts all previously loaded source dialogs/list contents');
  stage = 'loaded-context'; for (const kind of ['hash', 'organization', 'role', 'employee', 'user', 'outer', 'render']) {
    await visit(); await readOnly(async () => { await openRecord(); await changed(kind); await page.waitForFunction(() => !document.querySelector('dialog[open]')); });
  } mark('G8 all seven loaded authorization/route/render contexts revoke original and nested views');
  stage = 'same-primitives'; await visit(); await readOnly(async () => { const { parent, dialog } = await openRecord(); await page.evaluate(async () => { const ui = await import('/ui.js'), context = ui.getContext(); context.user = { ...context.user }; });
    assert(await dialog.isVisible()); await close(dialog); await close(parent); }); mark('G9 nested user object replacement with identical primitives preserves valid reading');
  stage = 'pending-context'; for (const kind of ['hash', 'organization', 'role', 'employee', 'user', 'outer', 'render']) {
    await visit(); await readOnly(async () => { const parent = await openBatch(), pending = holdNext('record');
      const failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.includes('/legacy-migrations/records/') && request.failure()?.errorText === 'net::ERR_ABORTED');
      await parent.getByRole('button', { name: '查看原欄位', exact: true }).first().click(); await pending.entered.promise; await changed(kind); await failed; await release(pending);
      await page.waitForFunction(() => !document.querySelector('dialog[open]')); assert.equal(await page.locator('dialog').getByText('合成員工1', { exact: true }).count(), 0);
    });
  } mark('G10 all seven pending contexts abort actual requests; released old responses cannot resurrect private text');
  stage = 'escape-focus'; await visit(); await readOnly(async () => { const parent = await openBatch(), trigger = parent.getByRole('button', { name: '查看原欄位', exact: true }).first(), pending = holdNext('record');
    const failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.includes('/legacy-migrations/records/') && request.failure()?.errorText === 'net::ERR_ABORTED');
    await trigger.focus(); await page.keyboard.press('Enter'); await pending.entered.promise; await shot('loading-1440'); await page.keyboard.press('Escape'); await failed; await release(pending);
    await modal('完整移轉來源欄位').waitFor({ state: 'detached' }); assert.equal(await trigger.evaluate(node => node === document.activeElement), true); await close(parent);
  }); mark('G11 real Enter/Escape cancels pending request and restores source-row keyboard focus');
  stage = 'stale-list'; await visit(); await readOnly(async () => { const pending = holdNext('list'), failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/legacy-migrations' && request.failure()?.errorText === 'net::ERR_ABORTED');
    await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await pending.entered.promise; await page.getByRole('button', { name: '重新讀取', exact: true }).click(); await failed;
    await page.getByRole('button', { name: '查看批次', exact: true }).waitFor(); await release(pending); assert.equal(await page.getByRole('button', { name: '查看批次', exact: true }).count(), 1);
  }); mark('G12 superseded list reads abort and cannot overwrite newer accepted page');
  stage = 'role-server-gates'; const recordId = (await request(context, 'GET', `/api/legacy-migrations/batches/${committed.batchId}?page=1&pageSize=25`)).records[0].id;
  for (const [role, client] of Object.entries(clients)) {
    const before = raw(); for (const endpoint of ['/api/legacy-migrations?page=1&pageSize=25', '/api/legacy-migrations/batches/' + committed.batchId, '/api/legacy-migrations/records/' + recordId]) await request(client.context, 'GET', endpoint, undefined, 403, client.auth);
    const otherPage = await client.context.newPage(); await otherPage.goto(base + '/#/legacy-migrations'); await otherPage.getByText('目前角色無法使用此頁面，請聯絡機構管理者。', { exact: true }).waitFor();
    assert.equal(await otherPage.locator('.nav-link[data-route="/legacy-migrations"]').count(), 0); assert.equal(await otherPage.getByRole('button', { name: '查看原欄位', exact: true }).count(), 0); assert.deepEqual(raw(), before);
  } mark('G13 supervisor/finance/caregiver actual server403 and direct-route/nav gating preserve all SQL');
  stage = 'anonymous-and-method'; const anonymous = await browser.newContext(); contexts.push(anonymous); await readOnly(async () => {
    await request(anonymous, 'GET', '/api/legacy-migrations', undefined, 401, null); await request(context, 'POST', '/api/legacy-migrations', { inputPath: '/synthetic/not-an-import-path' }, 405);
    await request(context, 'GET', '/api/legacy-migrations?page=1&page=2', undefined, 422);
  }); mark('G14 unauthenticated/duplicate query and arbitrary-pathPOST are denied; HTTP remains read-only');
  assert(requestLog.every(request => request.method === 'GET')); assert(requestLog.filter(request => request.path.includes('/batches/')).every(request => request.query === '?page=1&pageSize=25' || request.query === '?page=2&pageSize=25'));
  assert.deepEqual(pageErrors, []); const sourceAfter = await sources(); assert.deepEqual(sourceAfter, sourceBefore); outcome = 'passed';
  await writeFile(path.join(output, 'browser.json'), JSON.stringify({ format: 'suiyue-legacy-migrations-browser-v1', status: outcome, syntheticOnly: true, stage, checks, images, pageErrors,
    fixtureImportedCount: committed.importedCount, sourceSystemComplete: false, tailProof, requestLog, sourceBefore, sourceAfter, realDataAccessed: false, actual4310Accessed: false, formalDeployment: false }, null, 2));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ status: 'failed', syntheticOnly: true, stage, checks, images, pageErrors, tailProof, error: error.stack, sourceBefore, sourceAfter: await sources() }, null, 2));
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error;
} finally {
  hold?.release.resolve(); for (const owned of contexts) await owned.close().catch(() => {}); await browser.close(); await app.close(); fixture?.cleanup();
}
assert.equal(outcome, 'passed'); console.log('PASS ' + checks.length + ' legacy migration browser gates; ' + images.length + ' synthetic screenshots');
