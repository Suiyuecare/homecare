import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const output = path.resolve('outputs/software/institution-holidays-qa/browser-' + Date.now());
await mkdir(output, { recursive: true });
const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
const entity = 'institution-holidays', checks = [], screenshots = [], errors = []; let stage = 'setup';
page.on('pageerror', error => errors.push({ stage, message: error.message }));
const mark = message => { checks.push(message); console.log('PASS ' + message); };
const dialog = () => page.locator('dialog[open]').last();
const settle = () => page.waitForLoadState('networkidle');
const capture = async name => { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, fullPage: true, animations: 'disabled' }); screenshots.push(file); };
const close = async () => { await page.keyboard.press('Escape'); await settle(); };
const submit = async label => { const target = dialog(), heading = await target.getAttribute('aria-labelledby'); await target.getByRole('button', { name: label, exact: true }).click(); await page.locator(`dialog[aria-labelledby="${heading}"]`).waitFor({ state: 'detached' }); await settle(); };
const counts = () => app.db.prepare('SELECT (SELECT count(*) FROM records) records,(SELECT count(*) FROM record_versions) versions,(SELECT count(*) FROM audit) audit,total_changes() changes').get();
const screen = async () => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), []);
};
const load = async () => { const target = base + '/#/institution-holidays'; if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: '機構人工假日', exact: true }).waitFor(); await settle(); assert.equal(await page.locator('.error-state').count(), 0);
  await page.getByRole('button', { name: '查詢年度', exact: true }).click(); await dialog().getByLabel('查詢年度', { exact: false }).fill('2026'); await submit('查詢清單');
};
const row = title => page.getByRole('row').filter({ hasText: title });
try {
  const password = 'synthetic-holiday-browser-password';
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成假日驗收員', email: 'holiday-browser@example.test', password, organizationName: '合成假日驗收機構甲' } }); assert.equal(setup.status(), 201);
  const session = await setup.json(), headers = { Origin: base, 'X-Org-Id': session.organizations[0].id, 'X-CSRF-Token': session.csrfToken };
  const post = async (kind, data, override = {}) => { const result = await context.request.post(base + '/api/' + kind, { headers: { ...headers, ...override }, data }); assert.equal(result.status(), 201, await result.text()); return (await result.json()).item; };
  const list = async () => { const result = await context.request.get(base + '/api/' + entity, { headers }); assert.equal(result.status(), 200, await result.text()); return (await result.json()).items; };
  const employee = await post('employees', { name: '合成假日員工', employeeNo: 'HOLIDAY-BROWSER-E01' });
  for (const role of ['supervisor', 'finance', 'caregiver']) await post('users', { name: '合成' + role, email: role + '@holidays.example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });

  stage = 'ordinary create and exact ACK'; await load(); await page.getByText('僅保存機構人工指定日期；不會自動拒絕排班、計算加給或假額，亦不推定法定假日、例休或發票規則。', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '新增指定日期', exact: true }).click();
  const mainTitle = '合成機構指定假日';
  for (const [label, value] of [['指定日期', '2026-10-10'], ['名稱', mainTitle], ['人工設定依據', '合成指定來源第一行\n完整來源末行'], ['備註', '  合成備註第一行\n完整備註末行  ']]) await dialog().getByLabel(label, { exact: false }).fill(value);
  assert.equal(await dialog().getByLabel('人工指定類型', { exact: false }).inputValue(), '');
  await dialog().getByLabel('人工指定類型', { exact: false }).selectOption('holiday'); await screen(); await capture('holiday-create-desktop');
  let injected = false;
  const badAck = async route => { if (route.request().method() !== 'POST' || injected) return route.continue(); injected = true;
    const response = await route.fetch(), result = await response.json(); result.item.note += 'SYNTHETIC-ACK-MISMATCH'; await route.fulfill({ response, json: result }); };
  await page.route('**/api/institution-holidays', badAck); await dialog().getByRole('button', { name: '儲存指定日期', exact: true }).click(); await dialog().locator('.form-summary:not([hidden])').waitFor();
  assert.equal(await dialog().getByLabel('名稱', { exact: false }).inputValue(), mainTitle); assert.equal((await list()).length, 1);
  await page.unroute('**/api/institution-holidays', badAck); const beforeRetry = counts(); await submit('儲存指定日期'); assert.equal((await list()).length, 1); assert.deepEqual(counts(), beforeRetry);
  let main = (await list())[0]; assert.equal(main.status, 'active'); assert.equal(main.note, '  合成備註第一行\n完整備註末行  ');
  mark('普通表單人工選擇類型；真commit不良ACK保留輸入，同冪等鍵重試不新增第二筆');

  stage = 'duplicate and correction'; await page.getByRole('button', { name: '新增指定日期', exact: true }).click();
  await dialog().getByLabel('指定日期', { exact: false }).fill(main.date); await dialog().getByLabel('名稱', { exact: false }).fill('合成第二個機構工作日'); await dialog().getByLabel('人工指定類型', { exact: false }).selectOption('working-day');
  const beforeDuplicate = counts(); await dialog().getByRole('button', { name: '儲存指定日期', exact: true }).click(); await dialog().locator('.form-summary:not([hidden])').waitFor(); assert.deepEqual(counts(), beforeDuplicate); assert.equal(await dialog().getByLabel('指定日期', { exact: false }).inputValue(), main.date);
  await capture('holiday-duplicate-desktop'); await dialog().getByLabel('指定日期', { exact: false }).fill('2026-10-11'); await submit('儲存指定日期'); assert.equal((await list()).length, 2);
  mark('同日有效設定拒絕且零寫入；輸入保留，可修正日期後保存');

  stage = 'deactivate and restoration conflict'; await row(main.title).getByRole('button', { name: '停用', exact: true }).click(); await dialog().getByRole('button', { name: '確認停用', exact: true }).waitFor();
  const beforeCancel = counts(); await close(); assert.deepEqual(counts(), beforeCancel); assert.equal((await list()).find(item => item.id === main.id).status, 'active');
  await row(main.title).getByRole('button', { name: '停用', exact: true }).click(); await submit('確認停用'); main = (await list()).find(item => item.id === main.id); assert.equal(main.status, 'inactive'); assert.equal(main.version, 2);
  const replacement = await post(entity, { date: main.date, title: '合成同日替代設定', kind: 'closure' }); await load();
  await row(main.title).getByRole('button', { name: '恢復使用', exact: true }).click(); const beforeRestore = counts(); await dialog().getByRole('button', { name: '確認恢復使用', exact: true }).click(); await dialog().locator('.form-summary:not([hidden])').waitFor(); assert.deepEqual(counts(), beforeRestore); await capture('holiday-restore-conflict-desktop'); await close();
  await row(replacement.title).getByRole('button', { name: '停用', exact: true }).click(); await submit('確認停用'); await row(main.title).getByRole('button', { name: '恢復使用', exact: true }).click(); await submit('確認恢復使用'); main = (await list()).find(item => item.id === main.id); assert.equal(main.status, 'active'); assert.equal(main.version, 3);
  mark('停用需明確確認、取消確認零寫；停用保留歷程，同日替代設定阻擋恢復，解除後才可恢復');

  stage = 'unchanged CRLF and no-op'; const padded = await post(entity, { date: '2026-10-12', title: '  合成原文指定日期  ', kind: 'other', sourceReference: '  原來源\r\n末行  ', note: '  原備註\r\n完整末行  ' }); await load();
  await row(padded.title.trim()).getByRole('button', { name: '編輯', exact: true }).click(); assert.equal(await dialog().getByLabel('人工設定依據', { exact: false }).inputValue(), padded.sourceReference.replace(/\r\n/g, '\n'));
  const beforeNoop = counts(); await submit('儲存指定日期'); assert.deepEqual(counts(), beforeNoop);
  await row(padded.title.trim()).getByRole('button', { name: '編輯', exact: true }).click(); await dialog().getByLabel('名稱', { exact: false }).fill('  合成只更正名稱  '); let actualPatch;
  const observePatch = request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/' + entity + '/' + padded.id)) actualPatch = request.postDataJSON(); };
  page.on('request', observePatch); await submit('儲存指定日期'); page.off('request', observePatch); assert.deepEqual(actualPatch, { title: '  合成只更正名稱  ', version: 1 });
  const savedPadded = (await list()).find(item => item.id === padded.id); assert.equal(savedPadded.note, padded.note); assert.equal(savedPadded.sourceReference, padded.sourceReference); assert.equal(savedPadded.title, '  合成只更正名稱  ');
  mark('無修改保存不PATCH；只更正名稱不提交未動長文，原CRLF與前後空白完整保留');

  stage = 'date correction and typed history'; await row(main.title).getByRole('button', { name: '編輯', exact: true }).click(); await dialog().getByLabel('指定日期', { exact: false }).fill('2026-10-13'); await dialog().getByLabel('人工指定類型', { exact: false }).selectOption('other'); await submit('儲存指定日期'); main = (await list()).find(item => item.id === main.id); assert.equal(main.version, 4);
  const beforeRead = counts(); await row(main.title).getByRole('button', { name: '查看紀錄', exact: true }).click(); await dialog().getByText(main.note, { exact: true }).waitFor(); await dialog().getByText('其他人工指定', { exact: true }).waitFor(); await screen(); await capture('holiday-details-desktop'); await close();
  await row(main.title).getByRole('button', { name: '版本歷程', exact: true }).click(); await dialog().getByText('完整保存欄位', { exact: true }).first().click(); await dialog().getByText(main.sourceReference, { exact: true }).first().waitFor();
  assert.equal(await dialog().locator('pre').count(), 0); await capture('holiday-history-desktop'); await dialog().getByText(main.note, { exact: true }).first().scrollIntoViewIfNeeded(); await capture('holiday-history-fields-desktop'); await close(); assert.deepEqual(counts(), beforeRead);
  const history = await context.request.get(base + '/api/' + entity + '/' + main.id + '/history?compare=previous', { headers }); assert.equal(history.status(), 200); assert.deepEqual((await history.json()).items.map(item => item.version), [4, 3, 2, 1]);
  mark('更正日期與類型保存新版；完整六欄詳情及四版型別化歷程唯讀零寫入');

  stage = 'strict year and search'; await post(entity, { date: '2027-01-01', title: 'SYNTHETIC-NEXT-YEAR', kind: 'holiday' }); const beforeQuery = counts();
  await page.getByRole('button', { name: '查詢年度', exact: true }).click(); await dialog().getByLabel('查詢年度', { exact: false }).fill('0000'); await dialog().getByRole('button', { name: '查詢清單', exact: true }).click(); await dialog().locator('[name="year"][aria-invalid="true"]').waitFor(); assert.deepEqual(counts(), beforeQuery);
  await dialog().getByLabel('查詢年度', { exact: false }).fill('2027'); await submit('查詢清單'); await row('SYNTHETIC-NEXT-YEAR').waitFor(); assert.equal(await row(main.title).count(), 0); assert.deepEqual(counts(), beforeQuery);
  await page.getByRole('button', { name: '查詢年度', exact: true }).click(); await dialog().getByLabel('查詢年度', { exact: false }).fill(''); await submit('查詢清單'); await row(main.title).waitFor();
  const search = page.getByRole('searchbox', { name: '搜尋指定日期', exact: true }); await search.fill('合成只更正名稱'); await search.press('Enter'); await row(savedPadded.title.trim()).waitFor(); assert.equal(await row(main.title).count(), 0); await search.fill(''); await search.press('Enter'); await row(main.title).waitFor(); assert.deepEqual(counts(), beforeQuery);
  mark('明確四位年度與全部年度／業務文字查詢；不合法年度保留輸入，所有查詢零寫');

  stage = 'mobile pixels'; await page.setViewportSize({ width: 1440, height: 1000 }); await screen(); await capture('holiday-list-desktop');
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 }); await load(); await screen(); await capture(`holiday-list-${width}`);
    await page.locator('.list-content .table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; }); await screen(); await capture(`holiday-actions-${width}`);
    await row(main.title).getByRole('button', { name: '查看紀錄', exact: true }).click(); await screen(); await capture(`holiday-details-${width}`); await close();
    await row(main.title).getByRole('button', { name: '編輯', exact: true }).click(); await screen(); await capture(`holiday-edit-${width}`); await close();
    await row(main.title).getByRole('button', { name: '版本歷程', exact: true }).click(); await dialog().getByText('完整保存欄位', { exact: true }).first().click(); await screen(); await capture(`holiday-history-${width}`);
    await dialog().getByText(main.note, { exact: true }).first().scrollIntoViewIfNeeded(); await screen(); await capture(`holiday-history-fields-${width}`); await close();
  }
  mark('375px及390px清單、詳情、編輯與型別化歷程沒有頁面溢出，輸入具可辨識標籤');

  stage = 'role and organization isolation'; const otherOrg = await post('organizations', { name: '合成假日機構乙' }); await post(entity, { date: '2026-10-14', title: 'SYNTHETIC-FOREIGN-HOLIDAY', kind: 'holiday' }, { 'X-Org-Id': otherOrg.id });
  await load(); assert.equal(await row('SYNTHETIC-FOREIGN-HOLIDAY').count(), 0);
  for (const role of ['finance', 'caregiver', 'supervisor']) {
    const other = await browser.newContext({ viewport: { width: 390, height: 844 } }), p = await other.newPage(); const login = await other.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: role + '@holidays.example.test', password } }); assert.equal(login.status(), 200);
    let calls = 0; p.on('request', request => { if (request.url().includes('/api/institution-holidays')) calls++; }); await p.goto(base + '/#/institution-holidays');
    if (role === 'supervisor') { await p.getByRole('heading', { name: '機構人工假日', exact: true }).waitFor(); await p.waitForLoadState('networkidle'); assert.equal(await p.getByRole('button', { name: '新增指定日期', exact: true }).count(), 1); assert(calls > 0); }
    else { await p.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor(); await p.waitForLoadState('networkidle'); assert.equal(calls, 0); assert.equal(await p.getByRole('button', { name: '新增指定日期', exact: true }).count(), 0); }
    await other.close();
  }
  mark('督導可維護；財務／居服員入口禁止且不發讀取請求，其他機構資料不顯示');

  stage = 'committed response after navigation'; await page.setViewportSize({ width: 1440, height: 1000 }); await load(); await row(main.title).getByRole('button', { name: '編輯', exact: true }).click(); await dialog().getByLabel('名稱', { exact: false }).fill('合成情境變動前已提交名稱');
  let committed, release; const committedPromise = new Promise(resolve => { committed = resolve; }), releasePromise = new Promise(resolve => { release = resolve; });
  const hold = async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); assert.equal(response.status(), 200); committed(); await releasePromise; await route.fulfill({ response }).catch(() => {}); };
  await page.route('**/api/institution-holidays/' + main.id, hold);
  await page.evaluate(() => { window.syntheticHolidayToastMessages = []; const observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches?.('.toast')) window.syntheticHolidayToastMessages.push(node.textContent); }); observer.observe(document.body, { childList: true, subtree: true }); window.syntheticHolidayToastObserver = observer; });
  await dialog().getByRole('button', { name: '儲存指定日期', exact: true }).click(); await committedPromise; await page.evaluate(() => { location.hash = '#/cases'; }); await page.getByRole('heading', { name: '個案', exact: true }).waitFor(); release(); await settle(); await page.unroute('**/api/institution-holidays/' + main.id, hold);
  assert.equal(await page.locator('dialog[open]').count(), 0); assert.deepEqual(await page.evaluate(() => { window.syntheticHolidayToastObserver?.disconnect(); return window.syntheticHolidayToastMessages || []; }), []);
  assert.equal((await list()).find(item => item.id === main.id).title, '合成情境變動前已提交名稱');
  mark('伺服器已commit後離開模組，晚回應不重開表單或發成功提示；已提交資料仍可重新確認');

  assert.deepEqual(errors, []); await writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', syntheticOnly: true, checks, screenshots, errors }, null, 2)); console.log('Evidence: ' + output);
} catch (error) { await capture('failure').catch(() => {}); await writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'failed', stage, error: error.message, checks, screenshots, errors }, null, 2)); throw error; }
finally { await browser.close(); await app.close(); }
