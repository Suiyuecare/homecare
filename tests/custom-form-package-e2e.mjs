import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { readCustomFormPackage } from '../public/data/custom-form-package.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), qaRoot = path.join(root, 'outputs/software/custom-form-package-qa');
await mkdir(qaRoot, { recursive: true }); const output = await mkdtemp(path.join(qaRoot, 'attempt-'));
const installed = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(value => value && existsSync(value));
const app = createApp({ dbPath: ':memory:', port: 0 }), checks = [], images = [], contexts = [], pageErrors = [], sourceFiles = [
  'public/ui.js', 'public/modules/custom-forms.js', 'public/data/custom-form-package.js', 'public/data/custom-form-engine.js', 'public/data/custom-form-editor.js', 'src/server/custom-forms.mjs', 'tests/custom-form-package-e2e.mjs'];
const hashSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const startSourceSHA256 = await hashSources(), run = new Date().toISOString().replace(/[:.]/g, '-');
let outcome = 'failed', base, browser, context, page, auth, orgId, template;
const password = 'synthetic-template-package-browser-password', body = { code: 'SYNTHETIC-PACKAGE', name: '合成七型可攜模板', description: '  合成完整說明\r\n最後說明文字  ', note: '合成備註 <img src=x onerror=alert(1)>\r\n最後備註文字', revision: 1, previousTemplateId: '', status: 'draft', groups: [{ id: 'followup', label: '合成追蹤群組' }], fields: [
  { key: 'agreed', label: '合成條件', type: 'boolean', groupId: 'followup', required: false, options: [], visibleIf: null },
  { key: 'detail', label: '合成條件長文', type: 'textarea', groupId: 'followup', required: true, options: [], visibleIf: { field: 'agreed', equals: true } },
  { key: 'reading', label: '合成數值文字', type: 'number', groupId: '', required: false, options: [], visibleIf: null },
  { key: 'day', label: '合成日期', type: 'date', groupId: '', required: false, options: [], visibleIf: null },
  { key: 'choice', label: '合成單選', type: 'select', groupId: '', required: false, options: [{ value: 'yes', label: '合成第一項' }, { value: 'no', label: '合成第二項' }], visibleIf: null },
  { key: 'actions', label: '合成多選', type: 'multiselect', groupId: '', required: false, options: [{ value: 'one', label: '合成多選甲' }], visibleIf: null },
  { key: 'short', label: '合成短文字', type: 'text', groupId: '', required: false, options: [], visibleIf: null } ] };
const mark = text => { checks.push(text); console.log('PASS ' + text); };
const dialog = name => page.getByRole('dialog', { name, exact: true });
const control = (d, name) => d.locator('[name="' + name + '"]');
const sourceRow = () => page.locator('tbody tr').filter({ hasText: template.code });
const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, records: app.db.prepare('SELECT * FROM records ORDER BY id').all(), versions: app.db.prepare('SELECT * FROM record_versions ORDER BY record_id,version').all(), audit: app.db.prepare('SELECT * FROM audit ORDER BY id').all() });
const headers = session => ({ Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': session.csrfToken });
const request = async (method, route, data, expected = 200, client = context, session = auth) => { const response = await client.request.fetch(base + '/api/' + route, { method, headers: headers(session), ...(data !== undefined ? { data } : {}) }); assert.equal(response.status(), expected, await response.text()); return response.json(); };
const create = async (entity, data) => (await request('POST', entity, data, 201)).item;
const load = async () => { await page.goto(base + '/#/custom-forms'); await page.reload(); await page.getByRole('heading', { name: '自訂表單', level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); await sourceRow().waitFor(); await sourceRow().locator('td').nth(3).filter({ hasText: String(template.version) }).waitFor(); };
const cancel = async d => { await d.getByRole('button', { name: '取消', exact: true }).click(); const dirty = dialog('放棄未儲存的內容？'); if (await dirty.isVisible()) await dirty.getByRole('button', { name: '放棄修改', exact: true }).click(); await d.waitFor({ state: 'detached' }); };
async function layout() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page itself does not overflow');
  const missing = await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.labels?.length && !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')).map(n => n.name)); assert.deepEqual(missing, []);
  for (const d of await page.getByRole('dialog').all()) if (await d.isVisible()) { const bounds = await d.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth })); assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1); assert.ok(bounds.scroll <= bounds.client + 1, 'Table scroll stays in table owner'); }
}
const shot = async name => { await layout(); await page.screenshot({ path: path.join(output, name), fullPage: false }); images.push(name); };
const importFile = async (buffer, name = '合成模板.json', mimeType = 'application/json') => {
  await page.getByRole('button', { name: '匯入模板套件', exact: true }).click(); const d = dialog('選擇模板套件'); await control(d, 'file').setInputFiles({ name, mimeType, buffer }); await d.getByRole('button', { name: '核對模板套件', exact: true }).click(); return d;
};
const prepareDraft = async (buffer, code, name = '合成可攜新草稿') => { await importFile(buffer); const d = dialog('匯入為新模板草稿'); await control(d, 'code').waitFor(); await control(d, 'code').fill(code); await control(d, 'name').fill(name); await control(d, 'reviewed').check(); return d; };
try {
  base = await app.listen(); assert.notEqual(new URL(base).port, '4310'); browser = await chromium.launch({ headless: true, executablePath });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context);
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成模板套件管理員', email: 'package-browser@example.test', password, organizationName: '合成可攜模板機構' } }); assert.equal(setup.status(), 201); auth = await setup.json(); orgId = auth.organizations[0].id;
  template = await create('form-templates', body); const employee = await create('employees', { name: '合成套件居服員', employeeNo: 'SYN-PACK-E' });
  for (const role of ['supervisor', 'finance', 'caregiver']) await create('users', { name: '合成套件' + role, email: role + '-package-browser@example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
  page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); await load();
  const beforeExport = state(), trigger = sourceRow().getByRole('button', { name: '下載模板套件', exact: true });
  await trigger.click(); let d = dialog('核對模板套件下載'); await control(d, 'reviewed').waitFor(); await d.getByText('最後備註文字', { exact: false }).waitFor(); assert.equal(await d.locator('img').count(), 0); assert.equal(await d.locator('table tbody tr').count(), 8);
  let downloads = 0; page.on('download', () => downloads++); await shot('export-preview-1440.png'); await d.getByRole('button', { name: '下載模板套件', exact: true }).click(); await d.getByText('請先核對模板文字，再明確勾選下載確認。', { exact: true }).waitFor(); assert.equal(downloads, 0); assert.deepEqual(state(), beforeExport);
  mark('Full seven-type/group/condition/free-text privacy preview is literal and read-only; unchecked acknowledgement cannot download');
  await control(d, 'reviewed').check(); const downloaded = page.waitForEvent('download'); await d.getByRole('button', { name: '下載模板套件', exact: true }).click(); const download = await downloaded; await d.waitFor({ state: 'detached' });
  const buffer = await readFile(await download.path()), packageValue = await readCustomFormPackage(buffer); assert.deepEqual(packageValue.definition.fields, body.fields); assert.equal(packageValue.definition.note, body.note);
  assert.equal(download.suggestedFilename(), '歲悅-SYNTHETIC-PACKAGE-模板.json'); assert.equal(downloads, 1); assert.deepEqual(state(), beforeExport); assert.ok(!buffer.includes(Buffer.from(template.id))); assert.ok(!buffer.includes(Buffer.from(orgId)));
  mark('Actual JSON download verifies canonical SHA and exact CRLF/options; source SQL and metadata/answers/IDs unchanged');
  d = await prepareDraft(buffer, 'SYN-IMPORTED'); await shot('import-preview-1440.png'); await d.getByRole('button', { name: '建立新模板草稿', exact: true }).click(); await d.waitFor({ state: 'detached' }); await page.waitForLoadState('networkidle');
  const imported = (await request('GET', 'form-templates?q=SYN-IMPORTED')).items[0]; assert.equal(imported.status, 'draft'); assert.equal(imported.revision, 1); assert.equal(imported.previousTemplateId, ''); assert.notEqual(imported.id, template.id); assert.deepEqual(imported.fields, template.fields); assert.equal(imported.note, template.note); assert.deepEqual((await request('GET', 'form-templates/' + template.id)).item, template);
  mark('Ordinary native file/manual new-code/new-name/ack creates independent revision-one draft; no publishing or source overwrite');
  for (const invalid of [{ buffer: Buffer.from(JSON.stringify(packageValue).replace('"version":1', '"version":2,"version":1')), message: '模板 JSON 含重複欄位，尚未匯入。' },
    { buffer: Buffer.from(JSON.stringify(packageValue).replace('合成七型可攜模板', '篡改文字')), message: '模板檔案的內容與完整性碼不符；請重新取得完整檔案。' },
    { buffer: Buffer.from([0xff]), message: '模板檔案不是完整的 UTF-8 文字，尚未匯入。' }]) {
    const before = state(); d = await importFile(invalid.buffer); await d.getByText(invalid.message, { exact: true }).waitFor(); assert.equal(await control(d, 'file').evaluate(node => node.files.length), 1); assert.deepEqual(state(), before); await cancel(d);
  }
  mark('Duplicate keys, checksum corruption and malformed UTF8 show actionable errors, keep file and perform zero writes');
  for (const invalid of [{ buffer, name: 'wrong.csv', mimeType: 'text/csv', message: '請選擇 JSON 模板套件。' }, { buffer: Buffer.alloc(4 * 1024 * 1024 + 1), name: 'large.json', mimeType: 'application/json', message: '檔案超過 4 MiB，請重新選檔。' }]) { const before = state(); d = await importFile(invalid.buffer, invalid.name, invalid.mimeType); await d.getByText(invalid.message, { exact: true }).waitFor(); assert.deepEqual(state(), before); await cancel(d); }
  mark('Shared file owner rejects wrong extension/MIME and oversize before parse, without relaxing attachment/CSV defaults');
  d = await prepareDraft(buffer, template.code); const beforeIdentity = state(); await d.getByRole('button', { name: '建立新模板草稿', exact: true }).click(); await d.getByText(/請明確填寫不同於來源的新模板代碼/).waitFor(); assert.deepEqual(state(), beforeIdentity); await control(d, 'code').fill(imported.code); await d.getByRole('button', { name: '建立新模板草稿', exact: true }).click(); await d.getByText(/改用尚未建立的新模板代碼/).waitFor(); assert.equal(await control(d, 'name').inputValue(), '合成可攜新草稿'); assert.deepEqual(state(), beforeIdentity); await cancel(d);
  mark('Original code is rejected locally; occupied new code returns real server conflict and keeps inputs, no overwrite');
  let corrupted = false; const keys = []; const endpoint = '**/api/form-templates';
  await page.route(endpoint, async route => { if (route.request().method() !== 'POST') return route.continue(); keys.push(route.request().headers()['idempotency-key']); const response = await route.fetch(); const json = await response.json(); if (!corrupted) { corrupted = true; delete json.item.note; await route.fulfill({ response, json }); } else await route.fulfill({ response }); });
  d = await prepareDraft(buffer, 'SYN-ACK-RETRY'); await d.getByRole('button', { name: '建立新模板草稿', exact: true }).click(); await d.getByText(/無法確認儲存結果或模板內容/).waitFor(); const afterCommit = state(); assert.equal(await control(d, 'code').inputValue(), 'SYN-ACK-RETRY'); await shot('uncertain-ack-1440.png');
  await d.getByRole('button', { name: '建立新模板草稿', exact: true }).click(); await d.waitFor({ state: 'detached' }); await page.waitForLoadState('networkidle'); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.ok(keys[0]); assert.deepEqual(state(), afterCommit); assert.equal((await request('GET', 'form-templates?q=SYN-ACK-RETRY')).total, 1); await page.unroute(endpoint);
  mark('A real committed but malformed ACK preserves form; same payload reuses idempotency key and exact retry creates no duplicate');
  await sourceRow().getByRole('button', { name: '下載模板套件', exact: true }).click(); d = dialog('核對模板套件下載'); await control(d, 'reviewed').check(); template = (await request('PATCH', 'form-templates/' + template.id, { version: template.version, note: '合成更新後備註' })).item; const beforeConflict = state();
  await d.getByRole('button', { name: '下載模板套件', exact: true }).click(); await d.getByText('內容已更新，請重新讀取後操作。', { exact: true }).waitFor(); assert.equal(downloads, 1); assert.deepEqual(state(), beforeConflict); await cancel(d); await load();
  mark('Export performs a second fresh permission/version read; changed source cannot download old definition');
  for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await load(); await sourceRow().getByRole('button', { name: '下載模板套件', exact: true }).click(); d = dialog('核對模板套件下載'); await control(d, 'reviewed').waitFor(); await shot('export-confirm-' + width + '.png'); await d.getByText('合成更新後備註', { exact: false }).scrollIntoViewIfNeeded(); await shot('export-footer-' + width + '.png'); await cancel(d); d = await prepareDraft(buffer, 'SYN-PHONE-' + width); await control(d, 'code').scrollIntoViewIfNeeded(); await shot('import-controls-' + width + '.png'); await cancel(d); }
  mark('1440/390 layouts use labeled native controls, complete scrolling definitions and shared footer; no page/dialog overflow');
  await page.setViewportSize({ width: 1440, height: 1000 }); await load();
  for (const kind of ['hash', 'organization', 'role', 'employee', 'user', 'outer', 'render']) {
    await sourceRow().getByRole('button', { name: '下載模板套件', exact: true }).click(); d = dialog('核對模板套件下載'); await control(d, 'reviewed').waitFor(); const before = state();
    await page.evaluate(async kind => { const ui = await import('/ui.js'), ctx = ui.getContext(); if (kind === 'hash') location.hash = '#/dashboard'; else if (kind === 'render') document.querySelector('[data-render-version^="forms:"]').setAttribute('data-render-version', 'invalid'); else if (kind === 'outer') { ui.setContext(ctx, ctx.organizationId); window.dispatchEvent(new Event('session-updated')); } else { if (kind === 'organization') ctx.organizationId = 'synthetic-foreign'; if (kind === 'role') ctx.role = 'finance'; if (kind === 'employee') ctx.user.employeeId = 'synthetic-changed'; if (kind === 'user') ctx.user.id = 'synthetic-changed'; window.dispatchEvent(new Event('session-updated')); } }, kind);
    await d.waitFor({ state: 'detached' }); assert.deepEqual(state(), before); assert.equal(downloads, 1); await load();
  }
  mark('Loaded package privacy preview clears on route/org/role/employee/user/outer-context/render invalidation; no stale download');
  const routeName = '**/api/form-templates/' + template.id; let release, entered, finished, handlerError;
  const reached = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; }), handled = new Promise(resolve => { finished = resolve; });
  await page.route(routeName, async route => { try { const response = await route.fetch(); entered(); await waiting; await route.fulfill({ response }); } catch (error) { handlerError = error; } finally { finished(); } });
  await sourceRow().getByRole('button', { name: '下載模板套件', exact: true }).click(); await reached;
  const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/form-templates/' + template.id && request.method() === 'GET' && request.failure()?.errorText === 'net::ERR_ABORTED');
  await page.evaluate(() => { location.hash = '#/dashboard'; }); await aborted; release(); await handled;
  if (handlerError) assert.match(handlerError.message, /already handled|cancel|abort|disposed/i, 'Held transfer may only fail after the actual observed client abort');
  await page.unroute(routeName); await page.waitForLoadState('networkidle'); assert.equal(await dialog('核對模板套件下載').count(), 0); assert.equal(downloads, 1); await load();
  mark('Pending fresh source read is aborted on route change; late transfer cannot open a package preview');
  let lateFilePosts = 0; const countLateFilePosts = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/form-templates') lateFilePosts++; }; page.on('request', countLateFilePosts);
  await page.evaluate(() => { const original = File.prototype.arrayBuffer; window.__packageFileStarted = false; window.__packageFileFinished = false;
    window.__packageRestoreFileRead = () => { File.prototype.arrayBuffer = original; };
    File.prototype.arrayBuffer = function () { window.__packageFileStarted = true; const file = this; return new Promise(resolve => { window.__packageReleaseFileRead = async () => { resolve(await original.call(file)); window.__packageFileFinished = true; }; }); }; });
  await page.getByRole('button', { name: '匯入模板套件', exact: true }).click(); d = dialog('選擇模板套件'); await control(d, 'file').setInputFiles({ name: 'held.json', mimeType: 'application/json', buffer });
  const beforeLateFile = state(); await d.getByRole('button', { name: '核對模板套件', exact: true }).click(); await page.waitForFunction(() => window.__packageFileStarted === true);
  await page.evaluate(() => { location.hash = '#/'; }); await d.waitFor({ state: 'detached' }); await page.evaluate(async () => { window.__packageRestoreFileRead(); await window.__packageReleaseFileRead(); }); await page.waitForFunction(() => window.__packageFileFinished === true); await page.waitForLoadState('networkidle');
  assert.equal(await dialog('匯入為新模板草稿').count(), 0); assert.equal(lateFilePosts, 0); assert.deepEqual(state(), beforeLateFile); page.off('request', countLateFilePosts); await load();
  mark('Pending local file read is discarded after route invalidation; late UTF8/hash work cannot open draft or send POST');
  const supervisor = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Taipei' }); contexts.push(supervisor); const supLogin = await supervisor.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: 'supervisor-package-browser@example.test', password } }); assert.equal(supLogin.status(), 200); const supAuth = await supLogin.json(), supPage = await supervisor.newPage(); await supPage.goto(base + '/#/custom-forms'); await supPage.waitForLoadState('networkidle'); assert.equal(await supPage.getByRole('button', { name: '匯入模板套件', exact: true }).count(), 1);
  await supPage.locator('tbody tr').filter({ hasText: template.code }).getByRole('button', { name: '下載模板套件', exact: true }).click(); const supDialog = supPage.getByRole('dialog', { name: '核對模板套件下載', exact: true }); await supDialog.locator('[name="reviewed"]').check();
  app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance', orgId, supAuth.user.id); const beforeRevocation = state(); let revokedDownloads = 0; supPage.on('download', () => revokedDownloads++); await supDialog.getByRole('button', { name: '下載模板套件', exact: true }).click(); await supDialog.locator('.form-summary:not([hidden])').waitFor(); assert.equal(revokedDownloads, 0); assert.deepEqual(state(), beforeRevocation);
  mark('Supervisor real session can open package flow; fresh server role revocation blocks download, no email or role widening');
  for (const role of ['finance', 'caregiver']) { const denied = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(denied); const login = await denied.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: role + '-package-browser@example.test', password } }); assert.equal(login.status(), 200); const actor = await login.json(), deniedPage = await denied.newPage(); await deniedPage.goto(base + '/#/custom-forms'); await deniedPage.waitForLoadState('networkidle'); assert.equal(await deniedPage.getByRole('button', { name: '匯入模板套件', exact: true }).count(), 0); await request('GET', 'form-templates/' + template.id, undefined, 403, denied, actor); await request('POST', 'form-templates', body, 403, denied, actor); }
  mark('Finance/caregiver lack package controls and existing backend templates read/write returns actual 403');
  await load(); await page.getByLabel('表單工作清單', { exact: true }).selectOption('form-records'); assert.equal(await page.getByRole('button', { name: '匯入模板套件', exact: true }).isVisible(), false);
  mark('Template import controls disappear in case-answer mode; no package export of filled forms');
  assert.deepEqual(pageErrors, []); outcome = 'passed';
} catch (error) { console.error(error.stack); process.exitCode = 1; if (page) { console.error('SYNTHETIC_HEADING_DIAGNOSTIC', await page.locator('h1').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, html: node.outerHTML, visible: !!node.getClientRects().length, inert: !!node.closest('[inert]') }))).catch(() => [])); await page.screenshot({ path: path.join(output, 'failure-' + run + '.png'), fullPage: false }).catch(() => {}); } }
finally {
  const sourceSHA256 = await hashSources(), sourceUnchanged = JSON.stringify(sourceSHA256) === JSON.stringify(startSourceSHA256); if (!sourceUnchanged) { outcome = 'failed-source-drift'; process.exitCode = 1; }
  const artifactSHA256 = {}; for (const entry of await readdir(output, { withFileTypes: true })) if (entry.isFile()) artifactSHA256[entry.name] = createHash('sha256').update(await readFile(path.join(output, entry.name))).digest('hex');
  await writeFile(path.join(output, 'browser-' + run + '.json'), JSON.stringify({ outcome, run, dbPath: ':memory:', randomLoopback: base, syntheticOnly: true, formalTemplatesComplete: false, checks, images, pageErrors, startSourceSHA256, sourceSHA256, sourceUnchanged, artifactSHA256, scope: 'portable typed definitions only; formal templates, PII policy and real production UAT remain pending' }, null, 2));
  console.log('RECEIPT ' + output); await Promise.all(contexts.map(c => c.close().catch(() => {}))); await browser?.close(); await app.close();
}
