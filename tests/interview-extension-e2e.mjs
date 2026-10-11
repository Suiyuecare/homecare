import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { INTERVIEW_LOCAL_FIELDS, INTERVIEW_FIELD_GROUPS, INTERVIEW_EXTENSION_DEFAULTS } from '../public/data/interview-extension-editor.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const output = path.resolve('outputs/software/interview-extension-qa/browser-' + Date.now()); await mkdir(output, { recursive: true });
const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }), page = await context.newPage();
const checks = [], screenshots = [], errors = []; let stage = 'setup';
page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push({ stage, message: error.message }));
const entity = 'interview-applicants', dialog = () => page.locator('dialog[open]').last(), row = name => page.getByRole('row').filter({ hasText: name });
const settle = () => page.waitForLoadState('networkidle'), mark = message => { checks.push(message); console.log('PASS ' + message); };
const field = name => dialog().locator('[name="' + name + '"]');
const counts = () => app.db.prepare('SELECT (SELECT count(*) FROM records) records,(SELECT count(*) FROM record_versions) versions,(SELECT count(*) FROM audit) audit,(SELECT count(*) FROM idempotency) idempotency,total_changes() changes').get();
const layout = async () => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), []);
  for (const d of await page.locator('dialog[open]').all()) assert(await d.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }));
};
const shot = async name => { await layout(); const file = path.join(output, name + '.png'); await page.screenshot({ path: file, fullPage: false, animations: 'disabled' }); screenshots.push(file); };
const close = async () => { const heading = await dialog().getAttribute('aria-labelledby'); await page.keyboard.press('Escape'); const discard = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }); if (await discard.count()) await discard.getByRole('button', { name: '放棄修改', exact: true }).click(); await page.locator('dialog[aria-labelledby="' + heading + '"]').waitFor({ state: 'detached' }); await settle(); };
const submit = async (label = '儲存') => { const d = dialog(), heading = await d.getAttribute('aria-labelledby'); await d.getByRole('button', { name: label, exact: true }).click(); await page.locator('dialog[aria-labelledby="' + heading + '"]').waitFor({ state: 'detached' }); await settle(); };
const load = async () => { const target = base + '/#/interviews'; if (page.url() === target) await page.reload(); else await page.goto(target); await page.getByRole('heading', { name: '面試者登錄', exact: true, level: 1 }).waitFor(); await settle(); assert.equal(await page.locator('.error-state').count(), 0); };
const search = async name => { const input = page.getByRole('searchbox', { name: '搜尋面試者', exact: true }); await input.fill(name); await input.press('Enter'); await settle(); };
const edit = async item => { await search(item.name.trim()); await row(item.name.trim()).getByRole('button', { name: '編輯', exact: true }).click(); await field('name').waitFor(); };
const fill = async values => { for (const [key, value] of Object.entries(values)) if (['decision', 'interviewerEmployeeId', 'status'].includes(key) || key.endsWith('Intent')) await field(key).selectOption(value); else await field(key).fill(value); };
try {
  const password = 'synthetic-extended-interview-browser-password';
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成18欄驗收管理員', email: 'extension-browser@example.test', password, organizationName: '合成18欄驗收機構甲' } }); assert.equal(setup.status(), 201);
  const session = await setup.json(), headers = { Origin: base, 'X-Org-Id': session.organizations[0].id, 'X-CSRF-Token': session.csrfToken };
  const post = async (kind, data, extra = {}) => { const response = await context.request.post(base + '/api/' + kind, { headers: { ...headers, ...extra }, data }); assert.equal(response.status(), 201, await response.text()); return (await response.json()).item; };
  const get = async item => { const response = await context.request.get(base + '/api/' + entity + '/' + item.id, { headers }); assert.equal(response.status(), 200, await response.text()); return (await response.json()).item; };
  const employee = await post('employees', { name: '合成面試員工甲', employeeNo: 'EXT-BROWSER-E01' }), inactive = await post('employees', { name: '合成停用員工乙', employeeNo: 'EXT-BROWSER-E02', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) await post('users', { name: '合成18欄' + role, email: role + '@extension-browser.example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });

  stage = 'grouped create and exact ACK'; await load(); await page.getByRole('button', { name: '新增面試者', exact: true }).click();
  for (const group of INTERVIEW_FIELD_GROUPS) await dialog().getByRole('heading', { name: group.label, exact: true }).waitFor();
  assert.equal(await dialog().locator('input[name],select[name],textarea[name]').count(), 18);
  assert.equal(await field('interviewerEmployeeId').locator('option[value="' + inactive.id + '"]').count(), 0);
  const content = { name: '合成18欄面試甲', phone: '合成人工電話', city: '合成市', district: '合成區', interviewDate: '2026-10-10', interviewContent: '合成面試內容\n完整面試末行', note: '合成備註\n完整備註末行', appliedPosition: '  合成居家職務  ', education: '  合成學歷說明  ', workExperience: '  合成工作經歷\n完整經歷末行  ', availableFrom: '2026-11-01', availableHours: '  合成可配合時段\n人工時段末行  ', certificateNotes: '  合成證照說明\n不推定正式資格  ', interviewQuestions: '  合成面試提問\n完整回答末行  ', interviewerEmployeeId: employee.id, decision: 'selected', decisionReason: '  合成本次選用意向\n完整人工依據末行  ', status: 'active' };
  await fill(content); await field('decisionReason').scrollIntoViewIfNeeded(); await shot('extension-create-desktop');
  let injected = false; const badAck = async route => { if (route.request().method() !== 'POST' || injected) return route.continue(); injected = true; const response = await route.fetch(), body = await response.json(); body.item.workExperience += 'SYNTHETIC-BAD-ACK'; await route.fulfill({ response, json: body }); };
  await page.route('**/api/interview-applicants', badAck); await dialog().getByRole('button', { name: '儲存', exact: true }).click(); await dialog().locator('.form-summary:not([hidden])').waitFor(); assert.equal(await field('workExperience').inputValue(), content.workExperience);
  const committedCount = counts(); await page.unroute('**/api/interview-applicants', badAck); await submit(); assert.deepEqual(counts(), committedCount);
  let mainResponse = await context.request.get(base + '/api/' + entity, { headers }), main = (await mainResponse.json()).items.find(item => item.name === content.name); assert(main);
  for (const key of INTERVIEW_LOCAL_FIELDS) assert.equal(main[key], content[key]);
  mark('四群組18個普通欄位；新10欄精確保存，真commit不良ACK保留輸入且同冪等鍵重試零新增');

  stage = 'read full eighteen fields and typed history'; const beforeRead = counts(); await row(main.name).getByRole('button', { name: '查看紀錄', exact: true }).click();
  await dialog().locator('[data-interview-field="decisionReason"]').waitFor(); assert.equal(await dialog().locator('[data-interview-field]').count(), 18); await dialog().getByText('合成面試員工甲', { exact: false }).waitFor(); await dialog().getByText(main.workExperience, { exact: true }).waitFor(); await shot('extension-details-desktop'); await close();
  await row(main.name).getByRole('button', { name: '版本歷程', exact: true }).click(); await dialog().getByText('完整保存欄位', { exact: true }).first().click(); await dialog().getByText(main.decisionReason, { exact: true }).first().waitFor(); assert.equal(await dialog().locator('pre').count(), 0); await shot('extension-history-desktop'); await close(); assert.deepEqual(counts(), beforeRead);
  mark('詳情讀回完整18欄及可辨識面試員工；型別化人工評估歷程不展開任意JSON且零寫');

  stage = 'no-op and unchanged CRLF'; const padded = await post(entity, { name: '合成原文面試乙', phone: '合成原電話', interviewDate: '2026-10-10', interviewContent: '原8面試\r\n原內容', workExperience: '  原經歷\r\n完整末行  ', certificateNotes: '  原證照\r\n ', interviewQuestions: '  原提問\r完整末行  ', decisionReason: '  原原因\r\n ' }); await load(); await edit(padded);
  assert.equal(await field('workExperience').inputValue(), padded.workExperience.replace(/\r\n?/g, '\n')); const beforeNoop = counts(); await submit(); assert.deepEqual(counts(), beforeNoop);
  await edit(padded); await field('name').fill('合成只改姓名乙'); let submitted;
  const observe = request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/' + entity + '/' + padded.id)) submitted = request.postDataJSON(); }; page.on('request', observe); await submit(); page.off('request', observe);
  assert.deepEqual(submitted, { name: '合成只改姓名乙', version: 1 }); const paddedSaved = await get(padded); for (const key of ['interviewContent', 'workExperience', 'certificateNotes', 'interviewQuestions', 'decisionReason']) assert.equal(paddedSaved[key], padded[key]);
  mark('無改動不PATCH；只改姓名保留原8與新長文CRLF、前後空白及原判斷原因');

  stage = 'decision reason and independent status'; await edit(main); await field('decision').selectOption('not_selected'); const beforeReason = counts(); await dialog().getByRole('button', { name: '儲存', exact: true }).click(); await dialog().locator('.form-summary:not([hidden])').waitFor(); assert.deepEqual(counts(), beforeReason); assert.equal(await field('decisionReason').inputValue(), main.decisionReason);
  await shot('extension-reason-required-desktop'); await field('decisionReason').fill('  合成本次改判\n保留原原因於歷程  '); await submit(); main = await get(main); assert.equal(main.decision, 'not_selected'); assert.equal(main.status, 'active'); assert.equal(main.version, 2);
  await search(main.name); await row(main.name).getByRole('button', { name: '停用', exact: true }).click(); await submit('確認停用'); main = await get(main); assert.equal(main.status, 'inactive'); assert.equal(main.decision, 'not_selected');
  mark('改判不能沿用未改的先前原因，失敗零寫且輸入保留；明確新原因保存，名單停用獨立於人工意向');

  stage = 'inactive current interviewer remains retained'; const stopped = await context.request.patch(base + '/api/employees/' + employee.id, { headers, data: { version: employee.version, status: 'inactive' } }); assert.equal(stopped.status(), 200);
  await load(); await edit(main); assert.equal(await field('interviewerEmployeeId').inputValue(), employee.id); assert((await field('interviewerEmployeeId').locator('option:checked').textContent()).includes('停用')); await field('availableHours').fill('合成只更正可配合時段'); await submit(); main = await get(main); assert.equal(main.interviewerEmployeeId, employee.id);
  mark('原面試員工停用後維持可確認原指派；只改其他欄位不清空或代派');

  stage = 'old eight-field absence and safe editing'; const oldId = id(), time = now(), oldBusiness = { name: '合成原八欄面試丙', phone: '合成舊電話', interviewDate: '2026-10-10', city: '', district: '', interviewContent: '原八欄面試\r\n完整末行', note: '', status: 'active' };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(oldId, headers['X-Org-Id'], entity, JSON.stringify(oldBusiness), 1, time, time);
  app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(headers['X-Org-Id'], entity, oldId, 1, JSON.stringify({ ...oldBusiness, id: oldId, orgId: headers['X-Org-Id'], version: 1, createdAt: time, updatedAt: time }), time, 'synthetic-baseline');
  await load(); await edit({ ...oldBusiness, id: oldId }); assert.equal(await field('decision').inputValue(), 'pending'); await field('city').fill('合成舊紀錄更正市'); let oldSubmitted;
  const oldObserve = request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/' + entity + '/' + oldId)) oldSubmitted = request.postDataJSON(); }; page.on('request', oldObserve); await submit(); page.off('request', oldObserve); assert.deepEqual(oldSubmitted, { city: '合成舊紀錄更正市', version: 1 });
  const oldSaved = await get({ id: oldId }); for (const key of Object.keys(INTERVIEW_EXTENSION_DEFAULTS)) assert.equal(Object.hasOwn(oldSaved, key), false); assert.equal(oldSaved.interviewContent, oldBusiness.interviewContent);
  mark('原八欄匯入紀錄不回填新10欄；原內容安全保持，只改縣市逐版保存');

  stage = 'CAS conflict retains complete new input'; await edit(main); await field('workExperience').fill('  合成尚未保存經歷\n需完整保留  ');
  const concurrent = await context.request.patch(base + '/api/' + entity + '/' + main.id, { headers, data: { version: main.version, note: '合成其他操作者先保存' } }); assert.equal(concurrent.status(), 200);
  const beforeCAS = counts(); await dialog().getByRole('button', { name: '儲存', exact: true }).click(); await dialog().locator('.form-summary:not([hidden])').waitFor(); assert.deepEqual(counts(), beforeCAS); assert.equal(await field('workExperience').inputValue(), '  合成尚未保存經歷\n需完整保留  '); await shot('extension-CAS-desktop'); await close(); main = await get(main);
  mark('真實版次競爭409零寫，18欄表單保留未送出的完整經歷');

  stage = 'desktop and mobile grouped form pixels'; await load(); await search(main.name); await shot('extension-list-desktop'); await edit(main); await field('name').scrollIntoViewIfNeeded(); await shot('extension-edit-top-desktop'); await close();
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 }); await load(); await search(main.name); await shot(`extension-list-${width}`);
    await page.locator('.list-content .table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; }); await shot(`extension-actions-${width}`);
    await row(main.name).getByRole('button', { name: '查看紀錄', exact: true }).click(); await dialog().locator('[data-interview-field="name"]').waitFor(); await shot(`extension-details-${width}`); await dialog().getByText(main.decisionReason, { exact: true }).scrollIntoViewIfNeeded(); await shot(`extension-details-last-${width}`); await close();
    await edit(main); await field('name').scrollIntoViewIfNeeded(); await shot(`extension-edit-basic-${width}`); await field('workExperience').scrollIntoViewIfNeeded(); await shot(`extension-edit-experience-${width}`); await field('interviewQuestions').scrollIntoViewIfNeeded(); await shot(`extension-edit-interview-${width}`); await field('decisionReason').scrollIntoViewIfNeeded(); await shot(`extension-edit-decision-${width}`); await close();
    await row(main.name).getByRole('button', { name: '版本歷程', exact: true }).click(); await dialog().getByText('完整保存欄位', { exact: true }).first().click(); await shot(`extension-history-${width}`); await dialog().getByText(main.decisionReason, { exact: true }).first().scrollIntoViewIfNeeded(); await shot(`extension-history-last-${width}`); await close();
  }
  mark('桌面與375/390px四群組、18欄完整詳情及歷程可捲讀；標籤與保存footer可操作，無頁面橫向溢出');

  stage = 'role isolation and expired response'; const foreignOrg = await post('organizations', { name: '合成18欄機構乙' }); await post(entity, { name: 'SYNTHETIC-FOREIGN-INTERVIEW', phone: '合成外機構電話', interviewDate: '2026-10-10', interviewContent: '合成外機構面試' }, { 'X-Org-Id': foreignOrg.id });
  await load(); await search(''); assert.equal(await row('SYNTHETIC-FOREIGN-INTERVIEW').count(), 0);
  for (const role of ['finance', 'caregiver', 'supervisor']) {
    const client = await browser.newContext({ viewport: { width: 390, height: 844 } }), p = await client.newPage(); const login = await client.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: role + '@extension-browser.example.test', password } }); assert.equal(login.status(), 200); let calls = 0; p.on('request', request => { if (request.url().includes('/api/interview-applicants')) calls++; }); await p.goto(base + '/#/interviews');
    if (role === 'supervisor') { await p.getByRole('heading', { name: '面試者登錄', exact: true }).waitFor(); await p.waitForLoadState('networkidle'); assert.equal(await p.getByRole('button', { name: '新增面試者', exact: true }).count(), 1); assert(calls > 0); }
    else { await p.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor(); await p.waitForLoadState('networkidle'); assert.equal(calls, 0); }
    await client.close();
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await load(); await edit(main); await field('education').fill('合成導航前已提交學歷說明');
  let committed, release; const committedPromise = new Promise(resolve => { committed = resolve; }), releasePromise = new Promise(resolve => { release = resolve; });
  const held = async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); assert.equal(response.status(), 200); committed(); await releasePromise; await route.fulfill({ response }).catch(() => {}); };
  await page.route('**/api/interview-applicants/' + main.id, held);
  await page.evaluate(() => { window.syntheticExtensionToasts = []; const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches?.('.toast')) window.syntheticExtensionToasts.push(node.textContent); }); observer.observe(document.body, { childList: true, subtree: true }); window.syntheticExtensionObserver = observer; });
  await dialog().getByRole('button', { name: '儲存', exact: true }).click(); await committedPromise; await page.evaluate(() => { location.hash = '#/cases'; }); await page.getByRole('heading', { name: '個案', exact: true }).waitFor(); release(); await settle(); await page.unroute('**/api/interview-applicants/' + main.id, held);
  assert.equal(await page.locator('dialog[open]').count(), 0); assert.deepEqual(await page.evaluate(() => { window.syntheticExtensionObserver?.disconnect(); return window.syntheticExtensionToasts || []; }), []); assert.equal((await get(main)).education, '合成導航前已提交學歷說明');
  mark('admin/supervisor維護、finance/caregiver入口無API請求且跨機構不顯示；真commit晚回應不重開舊dialog或發成功提示');

  assert.deepEqual(errors, []); await writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', syntheticOnly: true, checks, screenshots, errors }, null, 2)); console.log('Evidence: ' + output);
} catch (error) { await shot('failure').catch(() => {}); await writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'failed', stage, error: error.message, checks, screenshots, errors }, null, 2)); throw error; }
finally { await browser.close(); await app.close(); }
