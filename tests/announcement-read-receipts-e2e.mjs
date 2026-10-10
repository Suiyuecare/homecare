import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { createAnnouncementReadFixture } from './announcement-read-receipts-fixtures.mjs';
import { createSyntheticWorkspace, disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';

// Explicit synthetic API actions only, factory-owned SQLite and random loopback Chromium.
// Does not inspect the default DB, old QA output, real credentials or port 4310.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.QA_OUTPUT_DIR || path.join(root, 'outputs/software/announcement-read-receipts-e2e'));
assert(!existsSync(path.join(output, 'e2e.json')), 'Preserve prior attempts before an explicitly authorized new run');
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b, label) => assert(isDeepStrictEqual(a, b), label);
const rawHash = state => sha(JSON.stringify({ typedSchema: state.typedSchema, typedTables: state.typedTables, userVersion: state.userVersion, applicationId: state.applicationId }));
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
const collectSources = async () => {
  const names = ['tests/announcement-read-receipts-e2e.mjs', 'tests/announcement-read-receipts-fixtures.mjs', 'tests/synthetic-backup-fixtures.mjs', 'docs/ANNOUNCEMENT_READ_RECEIPTS_SCOPE.md'];
  const walk = async directory => { for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else names.push(file); } };
  await walk('public'); await walk('src');
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const checks = [], screenshots = [], readSegments = [], writeSegments = [], contextChecks = [], badConfirmations = [], failedResponses = [], pageErrors = [], consoleErrors = [], contexts = [];
let fixture, workspace, browser, base, sourceHashesBefore, baseExpectedProof, lastPage, stage = 'initialization';
const baseExpectation = () => {
  const expected = fixture.baseFixture.expected;
  return { rawStateSha256: rawHash(expected.rawState), reportsSha256: sha(JSON.stringify(expected.frozenReports)), historiesSha256: sha(JSON.stringify(expected.histories)),
    csvSha256: Object.fromEntries(Object.entries(expected.csvBytes).map(([kind, bytes]) => [kind, sha(bytes)])), caseBlobSha256: sha(expected.caseBytes), certificationBlobSha256: sha(expected.certBytes) };
};
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(sha(error.message)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(sha(message.text())); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname.replace(/[a-f0-9-]{36}/g, ':id'), status: response.status() }); });
};
const readOnly = async (label, work) => {
  stage = label; const raw = fixture.rawState(), counters = fixture.counts();
  const result = await work();
  same(fixture.rawState(), raw, `${label}: all saved bytes unchanged`); same(fixture.counts(), counters, `${label}: counters unchanged`);
  readSegments.push({ label, tableCount: 11, triggerCount: 6, rawBeforeSha256: rawHash(raw), rawAfterSha256: rawHash(fixture.rawState()), unchanged: true }); return result;
};
const written = async (label, work) => { stage = label; const before = fixture.counts(); const result = await work(); writeSegments.push({ label, before, after: fixture.counts() }); return result; };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  assert.equal(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).length), 0);
  if (await page.getByRole('dialog').count()) assert(await page.getByRole('dialog').evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog remains within viewport');
  for (const region of await page.locator('.table-scroll').all()) if (await region.isVisible()) assert.equal(await region.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await layout(page); await page.screenshot({ path: path.join(output, name), fullPage: false });
  screenshots.push({ name, sha256: sha(await readFile(path.join(output, name))) });
};
const load = async page => { lastPage = page; const target = `${base}/#/announcements`; if (page.url() === target) await page.reload(); else await page.goto(target); await page.getByRole('heading', { name: '內部公告', level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); };
const findRow = async (page, item) => {
  await load(page); const input = page.getByLabel('搜尋資料', { exact: true }); const query = item.title.trim();
  await input.fill(query);
  const response = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/announcements' && url.searchParams.get('q') === query; });
  await input.press('Enter'); assert.equal((await response).status(), 200);
  await page.waitForFunction(() => document.querySelectorAll('.list-content tbody tr').length === 1);
  return page.locator('.list-content tbody tr');
};
const dialog = page => page.getByRole('dialog', { name: '閱讀公告全文', exact: true });
const roster = page => page.getByRole('dialog', { name: '公告閱讀紀錄', exact: true });
const openRead = async (page, item) => { const row = await findRow(page, item), trigger = row.getByRole('button', { name: '閱讀全文', exact: true }); await trigger.click(); await dialog(page).getByRole('heading', { name: '公告全文', exact: true }).waitFor(); return { dialog: dialog(page), trigger }; };
const close = async (page, trigger) => { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); if (trigger) assert(await trigger.evaluate(node => node === document.activeElement), 'Escape restores triggering focus'); };
const postPath = item => `/api/announcements/${item.id}/read-state`;
const matches = (request, item, method = 'GET', query) => { const url = new URL(request.url()); return request.method() === method && url.pathname === postPath(item) && (query === undefined || url.search === query); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const slowRoute = async (page, predicate) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false;
  const handler = async route => {
    if (used || !predicate(route.request())) return route.continue(); used = true;
    try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); }
    catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; }
    finally { handled.resolve(); }
  };
  await page.route('**/api/announcements/**', handler);
  let finished = false;
  return { arrived: arrived.promise, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await handled.promise; await page.unroute('**/api/announcements/**', handler); } };
};
const mutateContext = async (page, kind) => {
  await page.evaluate(async ({ kind, foreign }) => {
    const ui = await import('/ui.js'), current = ui.getContext(), container = document.querySelector('[data-render-version]');
    if (kind === 'hash') { location.hash = '/employees'; return; }
    if (kind === 'render') { container.dataset.renderVersion = crypto.randomUUID(); return; }
    if (kind === 'disconnect') { container.remove(); return; }
    const session = { ...current, user: current.user && { ...current.user }, organizations: current.organizations.map(org => ({ ...org })) };
    if (kind === 'user') session.user.id = 'synthetic-replaced-identity';
    if (kind === 'logout') session.user = null;
    if (kind === 'role') session.organizations.find(org => org.id === current.organizationId).role = 'finance';
    if (kind === 'employee') session.organizations.find(org => org.id === current.organizationId).employeeId = 'synthetic-replaced-link';
    if (kind === 'org' && !session.organizations.some(org => org.id === foreign)) session.organizations.push({ id: foreign, name: '另一合成機構', role: 'admin', employeeId: null });
    ui.setContext(session, kind === 'org' ? foreign : current.organizationId);
    if (kind === 'logout') { document.body.append(document.createComment('synthetic logout context notification')); return; }
    window.dispatchEvent(new Event('session-updated'));
  }, { kind, foreign: fixture.orgIds.foreign });
};

await mkdir(output, { recursive: true });
try {
  sourceHashesBefore = await collectSources(); workspace = createSyntheticWorkspace(); fixture = await createAnnouncementReadFixture({ workspace }); base = fixture.base;
  baseExpectedProof = baseExpectation();
  assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  assert.equal(fixture.counts().tableCount, 11); assert.equal(fixture.counts().triggerCount, 6);
  for (const table of ['attachment_files', 'certification_attachment_files']) assert(fixture.rawState().typedTables[table].rows.flat().some(value => value[0] === 'blob' && value[1].length > 0), 'Both original BLOB families are nonempty');
  const actors = {};
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context);
    const cookie = fixture.clients[role].cookie, equal = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, equal), value: cookie.slice(equal + 1), url: base }]);
    const page = await context.newPage(); observe(page); actors[role] = { page, context };
  }
  const admin = actors.admin.page, finance = actors.finance.page, caregiver = actors.caregiver.page;
  let all = fixture.announcements.all;
  await readOnly('G1 四角色僅明確開啟，GET不自動記錄閱讀', async () => {
    for (const role of Object.keys(actors)) {
      const { dialog: d, trigger } = await openRead(actors[role].page, all);
      await d.getByText(`尚未記錄您對第 ${all.version} 版公告的閱讀。`, { exact: true }).waitFor();
      assert(await d.getByRole('button', { name: '我已閱讀本版公告', exact: true }).isEnabled());
      if (['finance', 'caregiver'].includes(role)) assert.equal(await actors[role].page.getByRole('button', { name: '閱讀紀錄', exact: true }).count(), 0);
      await layout(actors[role].page); if (role === 'finance') await shot(finance, 'unread-desktop.png'); await close(actors[role].page, trigger);
      if (['finance', 'caregiver'].includes(role)) {
        const response = await actors[role].context.request.get(`${base}/api/announcements/${all.id}/read-receipts`, { headers: { 'X-Org-Id': fixture.orgIds.own } }); assert.equal(response.status(), 403);
      }
    }
    assert.equal((await fixture.request(fixture.clients.admin, 'GET', postPath(fixture.announcements.foreign))).status, 404);
    assert.equal((await fixture.request(fixture.clients.caregiver, 'GET', postPath(fixture.announcements.finance))).status, 404);
  }); mark('G1 四角色入口／本人未讀／GET零寫／非管理角色無名冊');

  const opened = await openRead(caregiver, all), commit = opened.dialog.locator('.dialog-footer button').filter({ hasText: /^我已閱讀本版公告$/ });
  assert.equal(await commit.count(), 1, 'Exactly one canonical acknowledgement button is targeted');
  const beforeRead = fixture.rawState(), beforeCounts = fixture.counts(); let posts = 0;
  const onPost = request => { if (matches(request, all, 'POST')) posts++; }; caregiver.on('request', onPost);
  const slow = await slowRoute(caregiver, request => matches(request, all, 'POST'));
  try {
    await written('G2 本人明確按鍵建立回執', async () => {
      const size = await commit.boundingBox(); await commit.click(); await slow.arrived;
      assert(await commit.isDisabled()); assert(await opened.dialog.getByRole('button', { name: '關閉', exact: true }).isDisabled());
      same(await commit.boundingBox(), size, 'Busy button keeps original geometry');
      await commit.evaluate(node => { node.click(); node.click(); }); await caregiver.keyboard.press('Escape'); assert(await opened.dialog.isVisible()); assert.equal(posts, 1);
      await shot(caregiver, 'acknowledgement-pending.png'); await slow.finish();
      await opened.dialog.getByText(`您已記錄閱讀第 ${all.version} 版公告：`, { exact: false }).waitFor(); assert(await commit.isDisabled());
    });
  } finally { await slow.finish(); caregiver.off('request', onPost); }
  const afterRead = fixture.rawState();
  for (const table of Object.keys(beforeRead.typedTables).filter(table => !['records', 'record_versions', 'audit', 'idempotency'].includes(table))) same(afterRead.typedTables[table], beforeRead.typedTables[table], `Read receipt does not touch ${table}`);
  same(afterRead.schema, beforeRead.schema, 'Original eleven tables and six triggers preserved');
  for (const table of ['records', 'record_versions']) same(afterRead.tables[table].filter(row => row.entity !== 'announcement-reads'), beforeRead.tables[table].filter(row => row.entity !== 'announcement-reads'), 'Acknowledgement never changes existing records, version history or approved price snapshots');
  assert.equal(fixture.counts().totalChanges - beforeCounts.totalChanges, 4, 'Locator/version/audit/idem exactly four committed writes');
  await close(caregiver); mark('G2 明確提交／pending防重／Escape鎖定／原歷程價格附件保持');

  await readOnly('G3 重新開啟保留本版已讀', async () => { const { dialog: d } = await openRead(caregiver, all); await d.getByText(`您已記錄閱讀第 ${all.version} 版公告：`, { exact: false }).waitFor(); assert(await d.getByRole('button', { name: '我已閱讀本版公告', exact: true }).isDisabled()); await close(caregiver); });
  all = await written('G3 合成正常no-op公告新版本', () => fixture.patch('announcements', all, { body: all.body }));
  await readOnly('G3 新版不繼承已讀', async () => { const { dialog: d } = await openRead(caregiver, all); await d.getByText(`尚未記錄您對第 ${all.version} 版公告的閱讀。`, { exact: true }).waitFor(); await close(caregiver); }); mark('G3 持久回執／no-op新版本未讀');

  await openRead(finance, all); const requestKeys = [], payloadHashes = []; let badIndex = 0;
  const mutations = [() => null, () => [], result => ({ ...result, extra: true }), result => ({ receipt: { ...result.receipt, role: 'admin' } }), result => ({ receipt: { ...result.receipt, announcementVersion: 1 } }), result => ({ receipt: { ...result.receipt, userId: 'synthetic-spoof' } }), result => ({ receipt: { ...result.receipt, id: result.receipt.id.slice(0, 32) } }), result => ({ receipt: { ...result.receipt, readAt: result.receipt.readAt.replace('.000Z', 'Z') + 'invalid' } })];
  const badHandler = async route => {
    if (!matches(route.request(), all, 'POST')) return route.continue();
    requestKeys.push(route.request().headers()['idempotency-key']); payloadHashes.push(sha(route.request().postData()));
    const response = await route.fetch(), result = await response.json();
    const replacement = badIndex < mutations.length ? mutations[badIndex++](result) : result;
    await route.fulfill({ response, json: replacement });
  };
  await finance.route('**/api/announcements/**', badHandler);
  const badBefore = fixture.counts(); let committedRaw;
  try {
    for (let i = 0; i < mutations.length; i++) {
      await written(`G4 未確認2xx ${i + 1} 明確重試`, async () => {
        if (!i) await dialog(finance).getByRole('button', { name: '我已閱讀本版公告', exact: true }).click(); else await dialog(finance).getByRole('button', { name: '重試記錄本版閱讀', exact: true }).click();
        await dialog(finance).locator('.form-summary[role="alert"]:visible').waitFor();
        assert.equal(await dialog(finance).getByText(`您已記錄閱讀第 ${all.version} 版公告：`, { exact: false }).count(), 0);
        await dialog(finance).getByRole('heading', { name: '公告全文', exact: true }).waitFor();
      });
      if (!i) committedRaw = fixture.rawState(); else same(fixture.rawState(), committedRaw, 'Same-key bad-body retries add no saved rows');
      badConfirmations.push({ index: i + 1, inlineUnconfirmed: true, noFalseRead: true });
    }
    await shot(finance, 'unconfirmed-result-error.png');
    await readOnly('G4 同key有效重試確認既存不可變回執', async () => { await dialog(finance).getByRole('button', { name: '重試記錄本版閱讀', exact: true }).click(); await dialog(finance).getByText(`您已記錄閱讀第 ${all.version} 版公告：`, { exact: false }).waitFor(); });
    assert.equal(fixture.counts().totalChanges - badBefore.totalChanges, 4); assert.equal(new Set(requestKeys).size, 1); assert(requestKeys[0]); assert.equal(new Set(payloadHashes).size, 1);
  } finally { await finance.unroute('**/api/announcements/**', badHandler); }
  await close(finance); mark('G4 八種非法2xx不假已讀／原payload與key手動重試／成功只寫一次');

  await written('G5 合成27位正常讀者與明確回執', () => fixture.addReaders(27, { announcement: all }));
  await readOnly('G5 管理者督導bounded名冊／精確保存版次', async () => {
    for (const role of ['admin', 'supervisor']) {
      const page = actors[role].page, row = await findRow(page, all); await row.getByRole('button', { name: '閱讀紀錄', exact: true }).click();
      await roster(page).getByRole('heading', { name: `第 ${all.version} 版閱讀紀錄：共 28 筆`, exact: true }).waitFor();
      assert.equal(await roster(page).locator('tbody tr').count(), 25); await roster(page).getByRole('button', { name: '下一頁', exact: true }).click();
      await roster(page).getByText('共 28 筆 · 第 2 / 2 頁', { exact: true }).waitFor(); assert.equal(await roster(page).locator('tbody tr').count(), 3);
      if (role === 'admin') {
        await shot(page, 'saved-reader-roster.png');
        await roster(page).getByText('查詢精確保存版次', { exact: true }).click(); await roster(page).getByLabel('精確保存公告版次', { exact: false }).fill('1');
        await roster(page).getByRole('button', { name: '查詢版次', exact: true }).click();
        await roster(page).getByRole('heading', { name: '第 1 版閱讀紀錄：共 1 筆', exact: true }).waitFor(); assert.equal(await roster(page).locator('tbody tr').count(), 1);
        await roster(page).getByRole('button', { name: '查詢目前版', exact: true }).click(); await roster(page).getByRole('heading', { name: `第 ${all.version} 版閱讀紀錄：共 28 筆`, exact: true }).waitFor();
      }
      await close(page);
    }
  }); mark('G5 25筆分頁／admin與sup保存姓名角色／精確版查詢及回目前版');

  const typed = await written('G6 另帳完整head typed合成匯入', () => fixture.importAnnouncement({ title: '合成不可顯示正文公告', body: { nested: 'NEVER_RENDER_RECEIPT_PAYLOAD' }, audience: 'all', status: 'published' }));
  await readOnly('G6 draft／typed不能確認／empty名冊', async () => {
    for (const item of [typed, fixture.announcements.draft]) { const { dialog: d } = await openRead(admin, item); assert(await d.getByRole('button', { name: '我已閱讀本版公告', exact: true }).isDisabled()); assert(!/NEVER_RENDER_RECEIPT_PAYLOAD/.test(await d.innerHTML())); if (item === typed) await d.getByText('保存類型：物件', { exact: true }).waitFor(); await close(admin); }
    const row = await findRow(admin, fixture.announcements.draft); await row.getByRole('button', { name: '閱讀紀錄', exact: true }).click();
    await roster(admin).getByText('本版尚無已保存的閱讀紀錄。', { exact: true }).waitFor(); await shot(admin, 'empty-draft-roster.png'); await close(admin);
  }); mark('G6 typed安全tag／草稿不能ack／真實空名冊');

  const row7 = await findRow(admin, all); let readAttempts = 0;
  const unavailable = async route => { if (!matches(route.request(), all)) return route.continue(); if (!readAttempts++) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成服務暫時無法使用' } }) }); return route.continue(); };
  await admin.route('**/api/announcements/**', unavailable);
  await readOnly('G7 freshGET503／inline重試', async () => {
    await row7.getByRole('button', { name: '閱讀全文', exact: true }).click(); await dialog(admin).getByText('合成服務暫時無法使用', { exact: true }).waitFor();
    assert(await dialog(admin).getByRole('button', { name: '我已閱讀本版公告', exact: true }).isDisabled()); await dialog(admin).getByRole('button', { name: '重新讀取', exact: true }).click();
    await dialog(admin).getByRole('heading', { name: '公告全文', exact: true }).waitFor(); await close(admin);
  }); await admin.unroute('**/api/announcements/**', unavailable);
  await readOnly('G7 精確版名冊503保留查詢版次與頁', async () => {
    const row = await findRow(admin, all); await row.getByRole('button', { name: '閱讀紀錄', exact: true }).click();
    await roster(admin).getByRole('heading', { name: `第 ${all.version} 版閱讀紀錄：共 28 筆`, exact: true }).waitFor();
    await roster(admin).getByText('查詢精確保存版次', { exact: true }).click(); await roster(admin).getByLabel('精確保存公告版次', { exact: false }).fill('1');
    await roster(admin).getByRole('button', { name: '查詢版次', exact: true }).click(); await roster(admin).getByRole('heading', { name: '第 1 版閱讀紀錄：共 1 筆', exact: true }).waitFor();
    let attempts = 0; const queryEcho = [];
    const failRoster = async route => {
      const url = new URL(route.request().url()); if (url.pathname !== `/api/announcements/${all.id}/read-receipts`) return route.continue();
      queryEcho.push({ version: url.searchParams.get('version'), page: url.searchParams.get('page') });
      if (!attempts++) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成名冊暫時無法使用' } }) }); return route.continue();
    };
    await admin.route('**/api/announcements/**', failRoster);
    try {
      await roster(admin).getByRole('button', { name: '重新讀取閱讀紀錄', exact: true }).click(); await roster(admin).getByText('合成名冊暫時無法使用', { exact: true }).waitFor();
      await roster(admin).getByRole('button', { name: '重新讀取', exact: true }).click(); await roster(admin).getByRole('heading', { name: '第 1 版閱讀紀錄：共 1 筆', exact: true }).waitFor();
      same(queryEcho, [{ version: '1', page: '1' }, { version: '1', page: '1' }], 'Roster retry preserves exact selected version and page');
    } finally { await admin.unroute('**/api/announcements/**', failRoster); }
    await close(admin);
  });
  const post503Item = await written('G7 正常建立503操作公告', () => fixture.create('announcements', { title: '合成503手動重試公告', body: '合成原文：未確認保存結果時仍可閱讀全文。', audience: 'all', status: 'published' }));
  await openRead(admin, post503Item); let post503Attempts = 0; const post503Keys = [];
  const failPost = async route => {
    if (!matches(route.request(), post503Item, 'POST')) return route.continue(); post503Keys.push(route.request().headers()['idempotency-key']);
    if (!post503Attempts++) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '尚未取得儲存結果；請重試記錄本版閱讀。' } }) }); return route.continue();
  };
  await admin.route('**/api/announcements/**', failPost);
  try {
    await readOnly('G7 POST503沒有自行queue或自動提交', async () => {
      await dialog(admin).getByRole('button', { name: '我已閱讀本版公告', exact: true }).click(); await dialog(admin).locator('.form-summary[role="alert"]:visible').waitFor();
      await dialog(admin).getByText(post503Item.body, { exact: true }).waitFor(); assert.equal(post503Attempts, 1);
    });
    await written('G7 原key人工重試正常保存', async () => { await dialog(admin).getByRole('button', { name: '重試記錄本版閱讀', exact: true }).click(); await dialog(admin).getByText(`您已記錄閱讀第 ${post503Item.version} 版公告：`, { exact: false }).waitFor(); });
    assert.equal(new Set(post503Keys).size, 1); assert(post503Keys[0]);
  } finally { await admin.unroute('**/api/announcements/**', failPost); }
  await close(admin); mark('G7 GET／名冊／POST503可恢復／精確版查詢與samekey保留');

  await openRead(admin, all); const loadedVersion = all.version;
  all = await written('G8 合成並行公告新版本', () => fixture.patch('announcements', all, { body: all.body }));
  await readOnly('G8 CAS拒絕舊版／明確重讀新版不自動ack', async () => {
    await dialog(admin).getByRole('button', { name: '我已閱讀本版公告', exact: true }).click(); await dialog(admin).locator('.form-summary[role="alert"]:visible').waitFor();
    assert(await dialog(admin).getByRole('button', { name: '我已閱讀本版公告', exact: true }).isDisabled()); assert.equal(await dialog(admin).getByRole('button', { name: '重試記錄本版閱讀', exact: true }).count(), 0);
    await dialog(admin).locator('.form-summary').getByRole('button', { name: '重新讀取公告', exact: true }).click(); await dialog(admin).getByText(`尚未記錄您對第 ${all.version} 版公告的閱讀。`, { exact: true }).waitFor(); assert.notEqual(all.version, loadedVersion); await close(admin);
  }); mark('G8 VERSION_CONFLICT不重送新版／explicit reload恢復新版未讀');

  const kinds = ['user', 'logout', 'org', 'role', 'employee', 'hash', 'render', 'disconnect', 'same'];
  await readOnly('G9 loaded完整context及same-identity失效', async () => {
    for (const kind of kinds) { await openRead(admin, all); await mutateContext(admin, kind); await dialog(admin).waitFor({ state: 'detached' }); await settle(admin); assert.equal(await admin.getByRole('dialog').count(), 0); contextChecks.push({ kind, phase: 'loaded', cleared: true }); }
  }); mark('G9 九種loaded context失效不保留全文／同身份新context亦關閉');

  await readOnly('G10 pendingGET真實abort及晚回應抑制', async () => {
    for (const kind of kinds) {
      const row = await findRow(admin, all), pending = await slowRoute(admin, request => matches(request, all, 'GET', ''));
      try {
        await row.getByRole('button', { name: '閱讀全文', exact: true }).click(); await pending.arrived;
        if (kind === 'same') await shot(admin, 'fresh-read-loading.png');
        const abort = admin.waitForEvent('requestfailed', { predicate: request => matches(request, all, 'GET', ''), timeout: 10000 });
        await mutateContext(admin, kind); const failed = await abort; assert.match(failed.failure().errorText, /ABORTED|FAILED|cancel/i);
        await dialog(admin).waitFor({ state: 'detached' }); await pending.finish(); await settle(admin); assert.equal(await dialog(admin).count(), 0);
        contextChecks.push({ kind, phase: 'pending-read', realRequestFailed: true, noLateRevival: true });
      } finally { await pending.finish(); }
    }
  }); mark('G10 九種pendingGET真requestfailed／釋放晚response不復活');

  const postItem = await written('G11 正常建立context測試公告', () => fixture.create('announcements', { title: '合成待提交切換機構公告', body: '合成正文，提交中切換只取消畫面，不宣稱交易回滾。', audience: 'all', status: 'published' }));
  await openRead(admin, postItem); const pendingPost = await slowRoute(admin, request => matches(request, postItem, 'POST'));
  try {
    await written('G11 pendingPOSTcontext失效，合法server保存另帳', async () => {
      await dialog(admin).getByRole('button', { name: '我已閱讀本版公告', exact: true }).click(); await pendingPost.arrived;
      const abort = admin.waitForEvent('requestfailed', { predicate: request => matches(request, postItem, 'POST'), timeout: 10000 });
      await mutateContext(admin, 'org'); assert.match((await abort).failure().errorText, /ABORTED|FAILED|cancel/i); await pendingPost.finish(); await settle(admin); assert.equal(await dialog(admin).count(), 0);
      assert.equal(await admin.getByText(`已保存第 ${postItem.version} 版公告的閱讀紀錄`, { exact: true }).count(), 0); contextChecks.push({ kind: 'org', phase: 'pending-post', realRequestFailed: true, noLateSuccess: true });
    });
  } finally { await pendingPost.finish(); }
  await readOnly('G11 名冊pending page/version context亦abort', async () => {
    const row = await findRow(admin, all); await row.getByRole('button', { name: '閱讀紀錄', exact: true }).click(); await roster(admin).getByText('本版尚無已保存的閱讀紀錄。', { exact: true }).waitFor();
    await roster(admin).getByText('查詢精確保存版次', { exact: true }).click(); await roster(admin).getByLabel('精確保存公告版次', { exact: false }).fill('2');
    const wanted = `/api/announcements/${all.id}/read-receipts`, pending = await slowRoute(admin, request => new URL(request.url()).pathname === wanted && new URL(request.url()).searchParams.get('version') === '2');
    try {
      await roster(admin).getByRole('button', { name: '查詢版次', exact: true }).click(); await pending.arrived;
      const abort = admin.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === wanted && new URL(request.url()).searchParams.get('version') === '2', timeout: 10000 });
      await mutateContext(admin, 'same'); assert.match((await abort).failure().errorText, /ABORTED|FAILED|cancel/i); await pending.finish(); await settle(admin); assert.equal(await roster(admin).count(), 0); contextChecks.push({ kind: 'same', phase: 'pending-roster-version', realRequestFailed: true });
    } finally { await pending.finish(); }
  }); mark('G11 POST與精確版名冊真abort／晚成功不跨機構顯示');

  const long = await written('G12 正常literalHTML／長CJK公告', () => fixture.create('announcements', { title: '合成手機長正文公告', body: '  <img src=x onerror=NEVER_EXECUTE_READ>\n' + '合成照顧交接內容，請逐段閱讀。\n'.repeat(250) + '合成最後一段 END_READ\u0000原文末尾  ', audience: 'all', status: 'published' }));
  await caregiver.setViewportSize({ width: 390, height: 844 });
  await readOnly('G12 390全文／literalHTML／reduced-motion／keyboard焦點', async () => {
    const { dialog: d, trigger } = await openRead(caregiver, long); assert.equal(await d.locator('img,script,iframe').count(), 0);
    const text = await d.textContent(); assert(text.includes(long.body)); assert(text.includes('END_READ'));
    assert(await d.getByRole('button', { name: '關閉', exact: true }).evaluate(node => node === document.activeElement));
    await caregiver.keyboard.press('Tab'); assert(await d.evaluate(node => node.contains(document.activeElement)));
    await d.getByRole('button', { name: '我已閱讀本版公告', exact: true }).scrollIntoViewIfNeeded(); assert(await d.getByRole('button', { name: '我已閱讀本版公告', exact: true }).isVisible());
    await shot(caregiver, 'mobile-long-literal-announcement.png'); await close(caregiver, trigger);
  }); mark('G12 390px長原文／literalHTML安全／按鈕可達與keyboard焦點');

  await readOnly('G13 shared sibling歷程與原公告edit入口', async () => {
    const row = await findRow(admin, all); await row.getByRole('button', { name: '版本歷程', exact: true }).click();
    const history = admin.getByRole('dialog', { name: '內部公告版本歷程', exact: true }); await history.locator('.history-version').first().waitFor(); assert.equal(await history.getByRole('button', { name: '我已閱讀本版公告', exact: true }).count(), 0);
    await shot(admin, 'sibling-announcement-history.png'); await close(admin);
    await row.getByRole('button', { name: '編輯', exact: true }).click(); await admin.getByRole('dialog', { name: '編輯內部公告', exact: true }).getByLabel('公告標題', { exact: false }).waitFor(); await close(admin);
  }); mark('G13 shared read-only歷程與原安全編輯保持');

  same(await collectSources(), sourceHashesBefore, 'All consumed source bytes remain fixed during this run'); assert.equal(pageErrors.length, 0, 'No browser runtime errors');
  same(baseExpectation(), baseExpectedProof, 'The composed v0.39 expected raw state/reports/history/CSV/BLOB objects remain unchanged');
  assert(failedResponses.every(response => [403, 404, 409, 422, 503].includes(response.status)), 'Only deliberately exercised failure statuses appear');
  const e2e = { passed: true, checks, screenshots, sourceHashesBefore, sourceHashesAfter: await collectSources(), readSegments, writeSegments,
    contextChecks, badConfirmations, failedResponses, pageErrors, consoleErrors, fixtureLedger: fixture.ledger, baseExpectedProof,
    noDefaultDatabase: true, randomLoopbackPort: true, noPDFOrPrint: true, noExternalActions: true, tables: 11, immutableTriggers: 6 };
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify(e2e, null, 2));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, stage, errorName: error.name, messageSha256: sha(error.message), checks, screenshots, readSegments, writeSegments, contextChecks, badConfirmations, pageErrors, consoleErrors }, null, 2));
  throw new Error(`Synthetic announcement-read browser validation failed at ${stage}; details are redacted.`, { cause: undefined });
} finally {
  for (const context of contexts) await context.close(); await browser?.close(); await fixture?.close(); if (workspace) disposeSyntheticWorkspace(workspace);
}
