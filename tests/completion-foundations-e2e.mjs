import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(path.join(await mkdir(path.join(root, 'outputs/software/completion-foundations-qa'), { recursive: true }).then(() => path.join(root, 'outputs/software/completion-foundations-qa')), 'attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(), password = 'synthetic-completion-browser-password';
const browser = await chromium.launch({ headless: true, executablePath }), contexts = [], errors = [], checks = [], shots = [];
const mark = name => { checks.push(name); console.log('PASS ' + name); };
const raw = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])) });
let admin, page, stage = 'setup';
const request = async (client, method, endpoint, data, status = 200, extra = {}) => {
  const response = await client.context.request.fetch(base + endpoint, { method, headers: { Origin: base, 'X-Org-Id': client.org, 'X-CSRF-Token': client.auth.csrfToken, ...extra }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), status, await response.text()); return response.json();
};
const post = async (entity, data) => (await request(admin, 'POST', '/api/' + entity, data, 201)).item;
const modal = name => page.getByRole('dialog', { name, exact: true });
const load = async route => { await page.goto(base + '/#' + route); await page.waitForLoadState('networkidle'); };
const shot = async name => { await page.waitForLoadState('networkidle'); await page.locator('.toast').waitFor({ state: 'detached' }); const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); assert(size.document <= size.viewport + 1); const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); shots.push({ name, file, size }); };
const readOnly = async action => { const before = raw(); await action(); assert.deepEqual(raw(), before); };
const dynamicFieldErrors = [];
const dynamicVisibility = async (label, visible, scenario) => {
  const control = page.getByLabel(label, { exact: false });
  const actual = await control.evaluate(node => ({ visible: !node.closest('.field').hidden, disabled: node.disabled }));
  if (actual.visible !== visible || actual.disabled === visible) dynamicFieldErrors.push({ scenario, label, expectedVisible: visible, ...actual });
};
const delayedPreview = async (endpoint, submitLabel, resultHeading, action) => readOnly(async () => {
  let release;
  const handler = async route => { const response = await route.fetch(); assert.equal(response.status(), 200, await response.text()); await new Promise(resolve => { release = resolve; }); await route.fulfill({ response }); };
  await page.route(base + endpoint, handler);
  try {
    await page.getByRole('button', { name: submitLabel, exact: true }).click();
    for (let wait = 0; !release && wait < 500; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(release, 'delayed readonly response did not arrive');
    await action(); release(); await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('heading', { name: resultHeading, exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: submitLabel, exact: true }).isEnabled(), true);
  } finally { release?.(); await page.unroute(base + endpoint, handler); }
});
const change = async (item, values) => {
  const row = page.locator('tbody tr').filter({ has: page.getByText(item.email, { exact: true }) });
  await row.getByRole('button', { name: '變更授權', exact: true }).click();
  const dialog = modal(item.name + ' · 變更帳號授權'); await dialog.getByLabel('角色', { exact: false }).selectOption(values.role);
  await dialog.getByLabel('帳號狀態', { exact: false }).selectOption(values.status);
  await dialog.getByLabel('變更原因', { exact: false }).fill(values.reason);
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await modal('確認變更此帳號授權？').getByRole('button', { name: '變更並撤銷現有登入', exact: true }).click(); return dialog;
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' }); contexts.push(context);
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成完成驗收管理者', email: 'completion-admin@example.test', password, organizationName: '合成完成驗收機構' } }); assert.equal(setup.status(), 201);
  const auth = await setup.json(); admin = { context, auth, org: auth.organizations[0].id }; page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const parent = await post('cases', { caseNo: 'SYN-COMP-C', name: '合成試算個案' });
  const employee = await post('employees', { employeeNo: 'SYN-COMP-E', name: '合成服務員', hourlyRateCents: 12001 });
  const item = await post('service-items', { code: 'BA01', name: '合成測試基本身體清潔', minutes: 30, unitPriceCents: 7 });
  const services = [{ serviceItemId: item.id, quantity: 3 }];
  const plan = await post('care-plans', { caseId: parent.id, validFrom: '2026-10-01', validTo: '2026-10-31', status: 'active', services });
  const shift = await post('shifts', { caseId: parent.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-05', startTime: '09:00', endTime: '10:01', services });
  let source = await post('service-records', { shiftId: shift.id, caseId: parent.id, employeeId: employee.id, date: shift.date, actualStart: '09:00', actualEnd: '10:01', services, status: 'submitted', note: '合成試算來源' });
  source = (await request(admin, 'POST', '/api/service-records/' + source.id + '/review', { version: source.version, decision: 'approved', reviewNote: '合成核閱' })).item;
  const officialItem = await post('service-items', { code: 'BA15', name: '合成家務來源', minutes: 30, unitPriceCents: 1 });
  const officialServices = [{ serviceItemId: officialItem.id, quantity: 1 }];
  const officialPlan = await post('care-plans', { caseId: parent.id, validFrom: '2026-10-01', validTo: '2026-10-31', status: 'active', services: officialServices });
  const officialShift = await post('shifts', { caseId: parent.id, employeeId: employee.id, carePlanId: officialPlan.id, date: '2026-10-06', startTime: '09:00', endTime: '09:30', services: officialServices });
  let officialSource = await post('service-records', { shiftId: officialShift.id, caseId: parent.id, employeeId: employee.id, date: officialShift.date, actualStart: '09:00', actualEnd: '09:30', services: officialServices, status: 'submitted', note: '合成官方清冊来源' });
  officialSource = (await request(admin, 'POST', '/api/service-records/' + officialSource.id + '/review', { version: officialSource.version, decision: 'approved', reviewNote: '合成核閱' })).item;
  const twoBa01Services = [{ serviceItemId: item.id, quantity: 2 }];
  const twoBa01Plan = await post('care-plans', { caseId: parent.id, validFrom: '2026-10-01', validTo: '2026-10-31', status: 'active', services: twoBa01Services });
  const twoBa01Shift = await post('shifts', { caseId: parent.id, employeeId: employee.id, carePlanId: twoBa01Plan.id, date: '2026-10-07', startTime: '09:00', endTime: '10:00', services: twoBa01Services });
  let twoBa01Source = await post('service-records', { shiftId: twoBa01Shift.id, caseId: parent.id, employeeId: employee.id, date: twoBa01Shift.date, actualStart: '09:00', actualEnd: '10:00', services: twoBa01Services, status: 'submitted', note: '合成 BA01 早晚兩組來源；需明確特別核定' });
  twoBa01Source = (await request(admin, 'POST', '/api/service-records/' + twoBa01Source.id + '/review', { version: twoBa01Source.version, decision: 'approved', reviewNote: '合成核閱' })).item;
  const rules = [];
  for (const kind of ['pricing', 'payroll']) {
    let rule = await post('business-rules', { kind, code: 'SYN-COMP-' + kind, name: '合成核定' + kind, validFrom: '2026-10-01', validTo: '2026-10-31', sourceReference: '合成核定依據', parameters: kind === 'pricing' ? { unitPriceCents: 101, copayBasisPoints: 2000, monthlyCapCents: 250 } : { baseCents: 1001, shareBasisPoints: 5000 }, status: 'draft', note: '' });
    rule = (await request(admin, 'PATCH', '/api/business-rules/' + rule.id, { version: rule.version, status: 'approved' })).item; rules.push(rule);
  }
  const clients = {};
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const account = await post('users', { name: '合成' + role, email: `completion-${role}-member@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(ctx);
    const login = await ctx.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: account.email, password } }); assert.equal(login.status(), 200);
    clients[role] = { context: ctx, auth: await login.json(), org: admin.org, account };
  }
  stage = 'readiness'; await readOnly(async () => {
    assert.equal((await admin.context.request.get(base + '/ready')).status(), 200);
    const head = await admin.context.request.head(base + '/ready'); assert.equal(head.status(), 200); assert.equal(await head.text(), '');
  }); mark('GET/HEAD就緒探測零SQL寫入');
  stage = 'accounts'; await load('/account-administration'); await page.getByRole('heading', { name: '帳號與權限', exact: true }).waitFor();
  await readOnly(async () => { const self = page.locator('tbody tr').filter({ has: page.getByText('completion-admin@example.test', { exact: true }) }); assert.equal(await self.getByRole('button', { name: '變更授權', exact: true }).count(), 0); await shot('accounts-desktop'); });
  const target = clients.finance.account; let intercepted = false; const submissions = [];
  page.on('request', r => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/account-administration/' + target.id) submissions.push({ body: r.postDataJSON(), key: r.headers()['idempotency-key'] }); });
  const bad = async route => { if (route.request().method() !== 'PATCH' || intercepted) return route.continue(); intercepted = true; const response = await route.fetch(); assert.equal(response.status(), 200); const body = await response.json(); body.item.role = 'admin'; await route.fulfill({ response, json: body }); };
  await page.route(base + '/api/account-administration/' + target.id, bad);
  const dialog = await change(target, { role: 'supervisor', status: 'suspended', reason: '合成測試停用並撤權' });
  await dialog.getByRole('alert').first().waitFor(); assert.equal(await dialog.getByLabel('變更原因', { exact: false }).inputValue(), '合成測試停用並撤權');
  const after = raw(); await page.unroute(base + '/api/account-administration/' + target.id, bad);
  await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await modal('確認變更此帳號授權？').getByRole('button', { name: '變更並撤銷現有登入', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await page.waitForLoadState('networkidle');
  assert.deepEqual(raw(), after); assert.equal(submissions.length, 2); assert.deepEqual(submissions[0], submissions[1]);
  await request(clients.finance, 'GET', '/api/calculations/candidates', undefined, 401);
  const row = page.locator('tbody tr').filter({ has: page.getByText(target.email, { exact: true }) }); await row.getByRole('button', { name: '歷程', exact: true }).click(); await modal(target.name + ' · 帳號授權歷程').getByText('合成測試停用並撤權', { exact: true }).waitFor(); await shot('account-history'); await page.keyboard.press('Escape');
  mark('帳號錯誤回應保留輸入、相同鍵重試無重複寫入、目標現有登入已撤銷、歷程可讀');
  await page.setViewportSize({ width: 390, height: 844 }); await shot('accounts-mobile');
  stage = 'calculator'; await load('/calculations'); await page.getByLabel('已核定規則', { exact: false }).waitFor();
  await readOnly(async () => {
    await page.getByLabel('已核定規則', { exact: false }).selectOption(rules[1].id); await page.getByLabel('已核閱服務', { exact: false }).selectOption(source.id);
    await page.getByLabel('計算方式', { exact: false }).selectOption('minutes-hourly'); await page.getByLabel('進位方式', { exact: false }).selectOption('half-up');
    await page.getByRole('button', { name: '執行試算', exact: true }).click(); await page.getByRole('heading', { name: '試算結果', exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: '試算結果' }).innerText(), /10\.18/); await shot('hourly-calculation-mobile');
    await page.getByLabel('計算方式', { exact: false }).selectOption('basis-points'); assert.equal(await page.getByRole('heading', { name: '試算結果', exact: true }).count(), 0);
    await page.getByRole('button', { name: '執行試算', exact: true }).click(); await page.getByRole('heading', { name: '試算結果', exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: '試算結果' }).innerText(), /5\.01/);
  }); mark('61分鐘時薪精確算至10.18、拆帳5.01、變更輸入清除舊結果、試算零SQL寫入');
  const brokenCalc = async route => { const response = await route.fetch(); const body = await response.json(); body.amountCents++; await route.fulfill({ response, json: body }); };
  await page.route(base + '/api/calculations/preview', brokenCalc); await page.getByLabel('計算方式', { exact: false }).selectOption('flat'); await page.getByRole('button', { name: '執行試算', exact: true }).click(); await page.locator('.form-summary:not([hidden])').waitFor(); assert.equal(await page.getByRole('heading', { name: '試算結果', exact: true }).count(), 0); await page.unroute(base + '/api/calculations/preview', brokenCalc); mark('錯誤金額或hash不得呈現成功結果');
  await page.setViewportSize({ width: 1440, height: 1000 }); await shot('calculator-desktop');
  // An input change while a correct response is delayed must also discard that response.
  let releaseCalc; const delayedCalc = async route => { const response = await route.fetch(); await new Promise(resolve => { releaseCalc = resolve; }); await route.fulfill({ response }); };
  await page.route(base + '/api/calculations/preview', delayedCalc);
  await page.getByLabel('計算方式', { exact: false }).selectOption('minutes-hourly');
  await page.getByRole('button', { name: '執行試算', exact: true }).click();
  for (let wait = 0; !releaseCalc && wait < 500; wait++) await new Promise(resolve => setTimeout(resolve, 10)); assert(releaseCalc, 'preview response did not arrive');
  await page.getByLabel('進位方式', { exact: false }).selectOption('floor'); releaseCalc();
  await page.getByRole('button', { name: '執行試算', exact: true }).waitFor({ state: 'visible' }); await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('heading', { name: '試算結果', exact: true }).count(), 0); await page.unroute(base + '/api/calculations/preview', delayedCalc);
  mark('通用試算等待期間更改政策不顯示舊結果');
  await page.getByLabel('計算方式', { exact: false }).selectOption('flat');
  await delayedPreview('/api/calculations/preview', '執行試算', '試算結果', async () => {
    await page.getByLabel('計算方式', { exact: false }).selectOption('minutes-hourly');
    await dynamicVisibility('進位方式', true, 'flat→hourly during readonly submission');
  });
  await dynamicVisibility('進位方式', true, 'flat→hourly after readonly submission');
  await page.getByLabel('已核定規則', { exact: false }).selectOption(rules[0].id);
  await page.getByLabel('計算方式', { exact: false }).selectOption('quantity-rate');
  await page.getByLabel('服務項目', { exact: false }).selectOption(item.id);
  await delayedPreview('/api/calculations/preview', '執行試算', '試算結果', async () => {
    const labels = ['進位方式', '額度計算基準', '假設已使用額度', '自付比例'];
    await page.getByLabel('試算假設額度分攤', { exact: false }).check();
    for (const label of labels) await dynamicVisibility(label, true, 'allocation enabled during readonly submission');
    await page.getByLabel('試算假設額度分攤', { exact: false }).uncheck();
    for (const label of labels) await dynamicVisibility(label, false, 'allocation disabled during readonly submission');
    await page.getByLabel('試算假設額度分攤', { exact: false }).check();
    for (const label of labels) await dynamicVisibility(label, true, 'allocation re-enabled during readonly submission');
  });
  for (const label of ['進位方式', '額度計算基準', '假設已使用額度', '自付比例']) await dynamicVisibility(label, true, 'allocation after readonly submission');
  stage = 'official-catalog'; await load('/ltc-codes');
  await page.getByRole('heading', { name: 'BA／AA 清冊與試算', exact: true }).waitFor();
  await readOnly(async () => {
    const catalog = page.getByRole('table', { name: '官方 BA／AA 支付清冊' }); assert.equal(await catalog.locator('tbody tr').count(), 25);
    await catalog.locator('tbody tr').first().getByRole('button', { name: '查看條件', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: '查看官方附表四' }).waitFor(); await page.keyboard.press('Escape');
    await page.getByLabel('官方試算服務來源', { exact: false }).selectOption(officialSource.id);
    await page.getByLabel('原核閱 BA／AA 項目', { exact: false }).selectOption(officialItem.id);
    await page.getByLabel('個案居住地支付區域', { exact: false }).selectOption('ordinary');
    await page.getByLabel('支付情形', { exact: false }).selectOption('shared-family-50-percent');
    await page.getByLabel('條件支付進位方式', { exact: false }).selectOption('half-up');
    await page.getByLabel('資格與適用條件核對依據', { exact: false }).fill('合成資格核對紀錄');
    let submissions = 0; const observe = r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/ltc-codes/preview') submissions++; }; page.on('request', observe);
    await page.getByRole('button', { name: '依官方清冊試算', exact: true }).click(); await page.locator('.form-summary:not([hidden])').waitFor(); assert.equal(submissions, 0);
    await page.getByLabel('已人工核對個案、員工資格及服務適用條件', { exact: false }).check();
    await page.getByRole('button', { name: '依官方清冊試算', exact: true }).click(); await page.getByRole('heading', { name: '官方碼試算結果', exact: true }).waitFor();
    const result = page.getByRole('region', { name: '官方碼試算結果', exact: true }); assert.match(await result.innerText(), /97\.50/); assert.match(await result.innerText(), /195\.00/); page.off('request', observe);
    await shot('ltc-codes-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await result.scrollIntoViewIfNeeded(); await shot('ltc-codes-mobile');
    await page.getByLabel('個案居住地支付區域', { exact: false }).selectOption('indigenous-or-island'); assert.equal(await result.count(), 0);
    await page.getByRole('button', { name: '依官方清冊試算', exact: true }).click(); await result.waitFor(); assert.match(await result.innerText(), /117\.50/);
  }); mark('官方39碼清冊與條件可讀、BA15一般與離島50%逐分核對、未勾資格不送出、零SQL寫入');
  const brokenLtc = async route => { const response = await route.fetch(); const body = await response.json(); body.eligiblePaymentBaseCents++; await route.fulfill({ response, json: body }); };
  await page.route(base + '/api/ltc-codes/preview', brokenLtc); await page.getByLabel('個案居住地支付區域', { exact: false }).selectOption('ordinary');
  await page.getByRole('button', { name: '依官方清冊試算', exact: true }).click(); await page.locator('.form-summary:not([hidden])').waitFor();
  assert.equal(await page.getByRole('heading', { name: '官方碼試算結果', exact: true }).count(), 0); assert.equal(await page.getByLabel('資格與適用條件核對依據', { exact: false }).inputValue(), '合成資格核對紀錄'); await page.unroute(base + '/api/ltc-codes/preview', brokenLtc);
  let releaseLtc; const delayedLtc = async route => { const response = await route.fetch(); await new Promise(resolve => { releaseLtc = resolve; }); await route.fulfill({ response }); };
  await page.route(base + '/api/ltc-codes/preview', delayedLtc); await page.getByRole('button', { name: '依官方清冊試算', exact: true }).click();
  for (let wait = 0; !releaseLtc && wait < 500; wait++) await new Promise(resolve => setTimeout(resolve, 10)); assert(releaseLtc, 'official preview response did not arrive');
  await page.getByLabel('個案居住地支付區域', { exact: false }).selectOption('indigenous-or-island'); releaseLtc(); await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('heading', { name: '官方碼試算結果', exact: true }).count(), 0); await page.unroute(base + '/api/ltc-codes/preview', delayedLtc);
  mark('官方碼錯誤金額回應保留輸入，晚到舊政策回應拒顯示');
  await page.getByLabel('支付情形', { exact: false }).selectOption('standard');
  await delayedPreview('/api/ltc-codes/preview', '依官方清冊試算', '官方碼試算結果', async () => {
    await page.getByLabel('官方試算服務來源', { exact: false }).selectOption(twoBa01Source.id);
    await page.getByLabel('原核閱 BA／AA 項目', { exact: false }).selectOption(item.id);
    await page.getByLabel('支付情形', { exact: false }).selectOption('standard');
    await dynamicVisibility('BA01 早晚兩組之特別核定依據', true, 'BA15→BA01 during readonly submission');
  });
  await dynamicVisibility('BA01 早晚兩組之特別核定依據', true, 'BA15→BA01 after readonly submission');
  // Reconcile outside the pending request as well, so the original implementation
  // can expose both actual-page failures in one preserved red run.
  await page.getByLabel('個案居住地支付區域', { exact: false }).selectOption('ordinary');
  await page.getByLabel('BA01 早晚兩組之特別核定依據', { exact: false }).fill('合成早晚兩組特別核定依據');
  await delayedPreview('/api/ltc-codes/preview', '依官方清冊試算', '官方碼試算結果', async () => {
    await page.getByLabel('官方試算服務來源', { exact: false }).selectOption(officialSource.id);
    await page.getByLabel('原核閱 BA／AA 項目', { exact: false }).selectOption(officialItem.id);
    await page.getByLabel('支付情形', { exact: false }).selectOption('standard');
    await dynamicVisibility('BA01 早晚兩組之特別核定依據', false, 'BA01→BA15 during readonly submission');
  });
  await dynamicVisibility('BA01 早晚兩組之特別核定依據', false, 'BA01→BA15 after readonly submission');
  await readOnly(async () => {
    for (const kind of ['default', 'truthy-opt-in', 'mutation', 'preview']) {
      await page.evaluate(async kind => {
        const { createForm, el } = await import('/ui.js');
        let helpers;
        const form = createForm({ ...(kind === 'default' ? {} : { readOnlySubmission: kind === 'truthy-opt-in' ? 'true' : true }), lockDuringSubmit: kind === 'mutation', fields: [{ name: 'operation', label: '合成防護操作', type: 'select', options: [{ value: 'flat', label: '固定' }], required: true }, { name: 'dependent', label: '合成防護隱藏欄位', hidden: true }], initial: { operation: 'flat' }, submitLabel: '合成防護送出', previewLabel: '合成防護預覽',
          ...(kind === 'preview' ? { onPreview: async () => ({ content: el('p', {}, '合成核對內容'), canSubmit: true }) } : {}),
          onChange: (_values, current) => { helpers = current; }, onSubmit: () => new Promise(resolve => { window.__completionLockedForm.release = resolve; }) });
        window.__completionLockedForm = { form, helpers, release: null }; document.body.append(form);
      }, kind);
      // This detached fixture tests submission state, independently of the app's
      // mobile navigation hit area. Actual calculator controls are clicked above.
      if (kind === 'preview') { await page.evaluate(() => [...window.__completionLockedForm.form.querySelectorAll('button')].find(node => node.textContent === '合成防護預覽').click()); await page.waitForFunction(() => !window.__completionLockedForm.form.querySelector('button[type=submit]').disabled); }
      await page.evaluate(() => window.__completionLockedForm.form.requestSubmit());
      const guarded = await page.evaluate(() => { const { form, helpers } = window.__completionLockedForm; helpers.setHidden('dependent', false); return { busy: form.isBusy(), locked: [...form.querySelectorAll('input,select,textarea')].every(node => node.disabled), hidden: form.querySelector('[name=dependent]').closest('.field').hidden }; });
      assert.deepEqual(guarded, { busy: true, locked: ['mutation', 'preview'].includes(kind), hidden: true }, kind + ' must retain its pending hidden guard and configured control locks');
      await page.evaluate(() => window.__completionLockedForm.release()); await page.waitForFunction(() => !window.__completionLockedForm.form.isBusy());
      await page.evaluate(() => { window.__completionLockedForm.form.remove(); delete window.__completionLockedForm; });
    }
  });
  mark('readonly opt-in 必須明確為true，不放寬一般保存與先預覽表單的控制項鎖定及動態欄位保護');
  assert.deepEqual(dynamicFieldErrors, [], 'Actual readonly pages must synchronize dynamic fields during and after a pending preview');
  mark('唯讀通用試算等待期間同步時薪進位與額度欄位，舊回應不渲染，零SQL寫入');
  mark('唯讀官方碼等待期間同步 BA01 特別核定欄位，舊回應不渲染，零SQL寫入');
  await load('/account-administration');
  const restoredDialog = await change(target, { role: 'finance', status: 'active', reason: '合成測試恢復財務職務' }); await restoredDialog.waitFor({ state: 'detached' });
  const freshFinance = await clients.finance.context.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: target.email, password } }); assert.equal(freshFinance.status(), 200); clients.finance.auth = await freshFinance.json();
  stage = 'rights';
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const client = clients[role], p = await client.context.newPage(); p.on('pageerror', e => errors.push(e.message));
    await request(client, 'GET', '/api/account-administration', undefined, role === 'admin' ? 200 : 403);
    await request(client, 'GET', '/api/calculations/candidates', undefined, ['admin', 'finance'].includes(role) ? 200 : 403);
    await request(client, 'GET', '/api/ltc-codes/catalog', undefined, ['admin', 'finance'].includes(role) ? 200 : 403);
    await p.goto(base + '/#/account-administration'); await p.waitForLoadState('networkidle'); assert.equal(await p.locator('a.nav-link[data-route="/account-administration"]').count(), role === 'admin' ? 1 : 0);
    if (role !== 'admin') assert.equal(await p.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).count(), 1);
    await p.close();
  }
  const foreign = await browser.newContext(); contexts.push(foreign); const response = await foreign.request.get(base + '/api/account-administration'); assert.equal(response.status(), 401);
  mark('四角色前後端授權矩陣與匿名拒絕：財務可試算但不可管理帳號');
  assert.deepEqual(errors, []); await writeFile(path.join(output, 'RESULTS.json'), JSON.stringify({ ok: true, syntheticOnly: true, checks, screenshots: shots, errors }, null, 2));
} catch (error) { await writeFile(path.join(output, 'FAILURE.json'), JSON.stringify({ stage, message: error.message, stack: error.stack, checks, errors }, null, 2)); throw error; }
finally { await Promise.allSettled(contexts.map(context => context.close())); await browser.close(); await app.close(); }
