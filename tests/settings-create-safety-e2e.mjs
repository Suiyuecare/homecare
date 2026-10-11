import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server/index.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url))), qa = path.join(root, 'outputs/software/settings-create-safety-qa');
await mkdir(qa, { recursive: true }); const output = await mkdtemp(path.join(qa, 'attempt-')); console.log('EVIDENCE ' + output);
const files = ['src/server/index.mjs', 'src/server/model.mjs', 'src/server/account-administration.mjs', 'src/server/portal-handoff.mjs', 'src/server/demo.mjs', 'public/modules/admin.js', 'public/data/settings-create-core.js', 'public/ui.js', 'public/app.js', 'public/styles.css', 'tests/settings-create-safety-e2e.mjs'];
const hashSources = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]))), beforeHashes = await hashSources();
const cached = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), ...cached.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(value => value && existsSync(value));
const app = createApp({ dbPath: ':memory:', port: 0 }), checks = [], images = [], errors = [], trace = [], contexts = [], actors = {}, password = 'synthetic-settings-browser-only';
let browser, page, base, admin, employee, stage = 'setup', outcome = 'failed', expectedBeforeUnload = false;
const raw = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])) });
const request = async (method, endpoint, payload, expected = 200, client = admin, key = randomUUID()) => {
  const response = await client.context.request.fetch(base + endpoint, { method, headers: { Origin: base, 'X-Org-Id': client.org, 'X-CSRF-Token': client.auth.csrfToken, 'Idempotency-Key': key }, ...(payload === undefined ? {} : { data: payload }) }); assert.equal(response.status(), expected, await response.text()); return response.json();
};
const modal = title => page.getByRole('dialog', { name: title, exact: true });
const mark = async value => { assert.equal(await page.evaluate(() => window.__settingsUnloadCount?.()), 0, 'No stale unload owner after completed action'); checks.push(value); console.log('PASS ' + value); };
const observe = tab => { tab.setDefaultTimeout(15000); tab.on('pageerror', error => errors.push({ stage, message: error.message })); tab.on('dialog', async dialog => { if (!(expectedBeforeUnload && dialog.type() === 'beforeunload')) errors.push({ stage, nativeDialog: dialog.type() }); await dialog.dismiss(); }); tab.on('request', req => { if (req.method() === 'POST' && ['/api/users', '/api/organizations', '/api/demo/seed'].some(endpoint => req.url().endsWith(endpoint))) trace.push({ stage, url: req.url(), method: req.method(), key: req.headers()['idempotency-key'], body: req.postData() }); }); };
async function load(tab = page) { const target = base + '/#/settings'; if (tab.url() === target) await tab.reload(); else await tab.goto(target); await tab.getByRole('heading', { name: '機構與帳號設定', exact: true, level: 1 }).waitFor(); await tab.getByRole('button', { name: '新增帳號', exact: true }).waitFor(); await tab.waitForLoadState('networkidle'); }
async function shot(name, tab = page) {
  assert(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow');
  assert.deepEqual(await tab.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), []);
  for (const dialog of await tab.locator('dialog[open]').all()) { const geometry = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth })); assert(geometry.left >= -1 && geometry.right <= geometry.width + 1 && geometry.scroll <= geometry.client + 1); }
  for (const control of await tab.locator('dialog[open] input,dialog[open] select,dialog[open] button').all()) assert(await control.evaluate(node => node.getBoundingClientRect().height >= 44));
  await tab.screenshot({ path: path.join(output, name), fullPage: false }); images.push(name);
}
async function fillUser(email, name = '合成瀏覽器帳號') {
  await page.getByRole('button', { name: '新增帳號', exact: true }).click(); const dialog = modal('新增系統帳號');
  await dialog.getByLabel('使用者姓名').fill(name); await dialog.getByLabel('登入電子郵件').fill(email); await dialog.getByLabel('初始密碼').fill(password); await dialog.getByLabel('存取角色').selectOption('caregiver'); await dialog.getByLabel('連結員工').selectOption(employee.id); return dialog;
}
try {
  base = await app.listen(); assert.notEqual(new URL(base).port, '4310'); browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context);
  await context.addInitScript(() => {
    const handlers = new Set(), add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, handler, options) => { if (type === 'beforeunload') handlers.add(handler); return add(type, handler, options); };
    window.removeEventListener = (type, handler, options) => { if (type === 'beforeunload') handlers.delete(handler); return remove(type, handler, options); };
    window.__settingsUnloadCount = () => handlers.size;
  });
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成設定驗收管理者', email: 'settings-browser-admin@example.invalid', password, organizationName: '合成設定驗收機構' } }); assert.equal(setup.status(), 201); const auth = await setup.json(); admin = actors.admin = { context, auth, org: auth.organizations[0].id };
  employee = (await request('POST', '/api/employees', { name: '合成設定測試員工', employeeNo: 'SYN-SET-UI-EMP' }, 201)).item;
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const email = 'settings-browser-' + (role === 'admin' ? 'manager' : role) + '@example.invalid', user = (await request('POST', '/api/users', { name: '合成設定' + role, email, password, role, employeeId: role === 'caregiver' ? employee.id : null }, 201)).item;
    const other = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei' }); contexts.push(other); const login = await other.request.post(base + '/api/login', { headers: { Origin: base }, data: { email, password } }); assert.equal(login.status(), 200); actors[role === 'admin' ? 'manager' : role] = { user, context: other, auth: await login.json(), org: admin.org };
  }
  page = await context.newPage(); observe(page); await load(); await shot('settings-1440.png');
  stage = 'G0 valid dirty form still blocks native reload; explicit discard cleans unload owner before navigation';
  let dirtyDialog = await fillUser('settings-ui-unsubmitted@example.invalid'); assert.equal(await page.evaluate(() => window.__settingsUnloadCount()), 1);
  expectedBeforeUnload = true; const native = page.waitForEvent('dialog', { predicate: dialog => dialog.type() === 'beforeunload' }); const dirtyReload = page.reload({ timeout: 1200 }).catch(error => error); const nativeDialog = await native; assert.equal(nativeDialog.type(), 'beforeunload'); const blocked = await dirtyReload; assert(blocked instanceof Error); expectedBeforeUnload = false;
  assert.equal(await dirtyDialog.getByLabel('初始密碼').inputValue(), password); assert.equal(await page.evaluate(() => window.__settingsUnloadCount()), 1);
  await dirtyDialog.getByRole('button', { name: '取消', exact: true }).click(); let discardDialog = modal('放棄未儲存的內容？'); await discardDialog.getByRole('button', { name: '放棄修改', exact: true }).click(); await discardDialog.waitFor({ state: 'detached' }); await dirtyDialog.waitFor({ state: 'detached' }); await mark(stage); await load();
  stage = 'G1 wrong-org and malformed successful user receipt preserve input; same-key retry creates exactly one account';
  const initialRefresh = await page.locator('#main-content > div').getAttribute('data-settings-refresh');
  let count = 0; const keys = []; let savedSnapshot;
  const wrong = async route => {
    const response = await route.fetch(); keys.push(route.request().headers()['idempotency-key']);
    if (count++ === 0) { const value = await response.json(); value.item.orgId = randomUUID(); savedSnapshot = raw(); return route.fulfill({ response, json: value }); }
    if (count === 2) return route.fulfill({ status: 201, contentType: 'application/json', body: '{' });
    await route.fulfill({ response });
  };
  await page.route('**/api/users', wrong); let dialog = await fillUser('settings-ui-retry@example.invalid'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('.form-summary').waitFor({ state: 'visible' });
  assert.equal(await dialog.getByLabel('登入電子郵件').inputValue(), 'settings-ui-retry@example.invalid'); assert.equal(await dialog.getByLabel('初始密碼').inputValue(), password); assert.equal(await page.getByText('系統帳號已新增', { exact: true }).count(), 0); await shot('user-wrong-ack-1440.png');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('.form-summary').waitFor({ state: 'visible' }); assert((await dialog.locator('.form-summary').textContent()).includes('無法讀取')); assert.deepEqual(raw(), savedSnapshot);
  await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await page.unroute('**/api/users', wrong); await page.getByText('settings-ui-retry@example.invalid', { exact: true }).waitFor(); assert.deepEqual(raw(), savedSnapshot); assert.equal(keys.length, 3); assert(keys.every(key => key === keys[0] && key)); await page.waitForFunction(prior => document.querySelector('#main-content > div')?.getAttribute('data-settings-refresh') !== prior && document.activeElement?.textContent === '新增帳號', initialRefresh, { timeout: 1500 }); assert.equal(await page.getByRole('button', { name: '新增帳號', exact: true }).evaluate(node => node === document.activeElement), true); await mark(stage);
  stage = 'G2 changing failed form input rotates action key; unknown uncommitted receipt cannot show success';
  let unknown = true; const rotateKeys = [];
  const unconfirmed = async route => { rotateKeys.push(route.request().headers()['idempotency-key']); if (unknown) { unknown = false; return route.fulfill({ status: 201, json: {} }); } await route.continue(); };
  await page.route('**/api/users', unconfirmed); dialog = await fillUser('settings-ui-rotate-before@example.invalid', '合成旋轉前'); const rotateStart = raw(); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('.form-summary').waitFor({ state: 'visible' }); assert.deepEqual(raw(), rotateStart);
  await dialog.getByLabel('使用者姓名').fill('合成旋轉後'); await dialog.getByLabel('登入電子郵件').fill('settings-ui-rotate-after@example.invalid'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await page.unroute('**/api/users', unconfirmed); assert.equal(rotateKeys.length, 2); assert.notEqual(rotateKeys[0], rotateKeys[1]); assert.equal(app.db.prepare('SELECT count(*) n FROM users WHERE email=?').get('settings-ui-rotate-before@example.invalid').n, 0); await mark(stage);
  stage = 'G3 organization wrong actor receipt retains name/key; exact retry refreshes confirmed membership without switching current org';
  let orgWrong = true; const orgKeys = []; let orgSnapshot;
  const wrongOrganization = async route => { const response = await route.fetch(); orgKeys.push(route.request().headers()['idempotency-key']); if (orgWrong) { orgWrong = false; const data = await response.json(); data.item.createdBy = randomUUID(); orgSnapshot = raw(); return route.fulfill({ response, json: data }); } await route.fulfill({ response }); };
  await page.route('**/api/organizations', wrongOrganization); await page.getByRole('button', { name: '新增機構', exact: true }).click(); dialog = modal('新增機構'); await dialog.getByLabel('機構名稱').fill('合成設定新機構'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('.form-summary').waitFor({ state: 'visible' }); assert.equal(await dialog.getByLabel('機構名稱').inputValue(), '合成設定新機構'); await shot('organization-wrong-ack-1440.png');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await page.unroute('**/api/organizations', wrongOrganization); await page.locator('#organization option').filter({ hasText: '合成設定新機構' }).waitFor({ state: 'attached' }); assert.equal(await page.locator('#organization').inputValue(), admin.org); assert.deepEqual(raw(), orgSnapshot); assert.equal(orgKeys[0], orgKeys[1]); await mark(stage);
  stage = 'G3b unconfirmed or late session refresh cannot replace actor/org/context after a proven organization creation';
  const unknownSession = async route => { await route.fulfill({ status: 200, json: {} }); };
  await page.route('**/api/session', unknownSession); await page.getByRole('button', { name: '新增機構', exact: true }).click(); dialog = modal('新增機構'); await dialog.getByLabel('機構名稱').fill('合成選單待確認機構'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await page.getByText('機構已保存，但機構選單尚未確認；請重新整理登入資料後核對。', { exact: true }).waitFor();
  assert.equal(await page.locator('#organization').inputValue(), admin.org); assert.equal(await page.locator('#organization option').filter({ hasText: '合成選單待確認機構' }).count(), 0); assert.equal(app.db.prepare('SELECT count(*) n FROM organizations WHERE name=?').get('合成選單待確認機構').n, 1); await shot('organization-session-unconfirmed-1440.png'); await page.unroute('**/api/session', unknownSession); await load();
  let sessionEntered, sessionRelease; const sessionReady = new Promise(resolve => sessionEntered = resolve), sessionGate = new Promise(resolve => sessionRelease = resolve); let sessionSnapshot;
  const lateSession = async route => { const response = await route.fetch(); sessionSnapshot = raw(); sessionEntered(); await sessionGate; await route.fulfill({ response }).catch(() => {}); };
  await page.route('**/api/session', lateSession); await page.getByRole('button', { name: '新增機構', exact: true }).click(); dialog = modal('新增機構'); await dialog.getByLabel('機構名稱').fill('合成晚選單機構'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await sessionReady; await page.evaluate(() => location.hash = '/help'); await page.getByRole('heading', { name: '使用說明', exact: true }).waitFor(); sessionRelease(); await page.waitForLoadState('networkidle'); await page.unroute('**/api/session', lateSession);
  assert.equal(await page.locator('#organization').inputValue(), admin.org); assert.equal(await page.locator('#organization option').filter({ hasText: '合成晚選單機構' }).count(), 0); assert.deepEqual(raw(), sessionSnapshot); await load(); await mark(stage);
  stage = 'G4 mobile demo scoped receipt retry is idempotent and common dialog focus/touch/viewport are preserved';
  await page.setViewportSize({ width: 390, height: 844 }); await load(); await shot('settings-390.png');
  const initialSeedRefresh = await page.locator('#main-content > div').getAttribute('data-settings-refresh');
  let demoWrong = true, seedSnapshot; const demoKeys = [];
  const wrongDemo = async route => { const response = await route.fetch(); demoKeys.push(route.request().headers()['idempotency-key']); if (demoWrong) { demoWrong = false; const data = await response.json(); data.orgId = randomUUID(); seedSnapshot = raw(); return route.fulfill({ response, json: data }); } await route.fulfill({ response }); };
  await page.route('**/api/demo/seed', wrongDemo); await page.getByRole('button', { name: '建立合成示範資料', exact: true }).click(); dialog = modal('將示範資料加入目前機構'); await dialog.getByRole('button', { name: '確認加入示範資料', exact: true }).click(); await dialog.locator('.form-summary').waitFor({ state: 'visible' }); await shot('demo-wrong-ack-390.png');
  await dialog.getByRole('button', { name: '確認加入示範資料', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await page.unroute('**/api/demo/seed', wrongDemo); await page.waitForLoadState('networkidle'); assert.deepEqual(raw(), seedSnapshot); assert.equal(demoKeys[0], demoKeys[1]); await page.waitForFunction(prior => document.querySelector('#main-content > div')?.getAttribute('data-settings-refresh') !== prior && document.activeElement?.textContent === '建立合成示範資料', initialSeedRefresh, { timeout: 1500 }); assert.equal(await page.getByRole('button', { name: '建立合成示範資料', exact: true }).evaluate(node => node === document.activeElement), true);
  dialog = await fillUser('settings-ui-mobile@example.invalid', '合成手機帳號'); await shot('user-create-390.png'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await page.getByText('settings-ui-mobile@example.invalid', { exact: true }).waitFor(); await mark(stage);
  stage = 'G5 route change and organization switch invalidate pending dialog and suppress late successful receipt without reversing committed writes';
  const delay = async (next, email) => {
    let entered, release; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve); let committed;
    const held = async route => { const response = await route.fetch(); committed = raw(); entered(); await gate; await route.fulfill({ response }).catch(() => {}); };
    await page.route('**/api/users', held); const form = await fillUser(email, '合成晚回應帳號'); await form.getByRole('button', { name: '儲存', exact: true }).click(); await ready; const successBefore = await page.getByText('系統帳號已新增', { exact: true }).count(); await next(); await form.waitFor({ state: 'detached' }); release(); await page.unroute('**/api/users', held); await page.waitForLoadState('networkidle'); assert.deepEqual(raw(), committed); assert.equal(await page.getByText('系統帳號已新增', { exact: true }).count() <= successBefore, true);
  };
  await delay(() => page.evaluate(() => location.hash = '/help'), 'settings-ui-late-route@example.invalid'); await load();
  const otherOrg = app.db.prepare('SELECT id FROM organizations WHERE name=?').get('合成設定新機構').id;
  await delay(() => page.locator('#organization').selectOption(otherOrg), 'settings-ui-late-org@example.invalid'); assert.equal(await page.locator('#organization').inputValue(), otherOrg); await page.locator('#organization').selectOption(admin.org); await page.getByRole('button', { name: '新增帳號', exact: true }).waitFor(); await mark(stage);
  stage = 'G6 four-role UI/API denials and real external lifecycle revocation cannot create or claim late settings success';
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const client = actors[role], tab = await client.context.newPage(); observe(tab); await tab.goto(base + '/#/settings'); await tab.waitForLoadState('networkidle'); assert.equal(await tab.getByRole('button', { name: '新增帳號', exact: true }).count(), 0); assert((await tab.locator('body').innerText()).includes('權限')); await shot(role + '-settings-denied-1440.png', tab);
    for (const endpoint of ['/api/users', '/api/organizations', '/api/demo/seed']) { const start = raw(); await request('POST', endpoint, {}, 403, client); assert.deepEqual(raw(), start); } await tab.close();
  }
  await load(); let entered, release; const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const revoked = async route => { entered(); await gate; await route.continue().catch(() => {}); };
  await page.route('**/api/users', revoked); dialog = await fillUser('settings-ui-revoked@example.invalid'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await ready;
  await request('PATCH', '/api/account-administration/' + admin.auth.user.id, { version: 0, role: 'admin', employeeId: null, status: 'suspended', reason: '合成瀏覽器送出期間由另一管理者停用' }, 200, actors.manager); const revokedStart = raw(); release(); await dialog.locator('.form-summary').waitFor({ state: 'visible' }); assert((await dialog.locator('.form-summary').innerText()).includes('請先登入')); await page.unroute('**/api/users', revoked); assert.deepEqual(raw(), revokedStart); assert.equal(await dialog.getByLabel('初始密碼').inputValue(), password); assert.equal(await page.getByText('系統帳號已新增', { exact: true }).count(), 0); await shot('revoked-dialog-1440.png');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); const discard = modal('放棄未儲存的內容？'); await discard.getByRole('button', { name: '放棄修改', exact: true }).click(); await discard.waitFor({ state: 'detached' }); await dialog.waitFor({ state: 'detached' });
  await page.reload(); await page.getByRole('heading', { name: '登入機構工作空間', exact: true }).waitFor(); assert.deepEqual(raw(), revokedStart); await shot('revoked-login-1440.png'); await mark(stage);
  assert.equal(errors.length, 0, JSON.stringify(errors)); outcome = 'passed';
} catch (error) { errors.push({ stage, message: error.message, stack: error.stack }); console.error(error); if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText()).catch(() => {}); } process.exitCode = 1; }
finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ outcome, stage, checks, screenshots: images, errors, trace: trace.map(({ stage, url, method }) => ({ stage, url, method })), sourceHashesBefore: beforeHashes, sourceHashesAfter: await hashSources(), syntheticOnly: true, productionValidated: false }, null, 2));
  for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); await app.close(); console.log('RESULT ' + outcome + ' ' + checks.length + ' gates');
}
