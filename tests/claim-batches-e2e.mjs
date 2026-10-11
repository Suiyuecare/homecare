import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const output = path.resolve('outputs/software/claim-batches-qa/browser-' + Date.now());
await mkdir(output, { recursive: true });
const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }), page = await context.newPage();
const checks = [], screenshots = [], errors = []; let stage = 'setup';
page.on('pageerror', error => errors.push({ stage, message: error.message }));
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const dialog = () => page.locator('dialog[open]').last();
const settle = async () => page.waitForLoadState('networkidle');
const capture = async name => { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
const close = async () => { await page.keyboard.press('Escape'); await settle(); };
const submit = async name => {
  const target = dialog(), label = await target.getAttribute('aria-labelledby'); await target.getByRole('button', { name, exact: true }).click();
  await page.locator(`dialog[aria-labelledby="${label}"]`).waitFor({ state: 'detached' }); await settle();
};
const counts = () => app.db.prepare('SELECT (SELECT count(*) FROM records) records,(SELECT count(*) FROM record_versions) versions,(SELECT count(*) FROM audit) audit,total_changes() changes').get();
const screen = async () => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), []);
};
try {
  const password = 'synthetic-claims-password';
  const setup = await context.request.post(base + '/api/setup', { headers: { Origin: base }, data: { name: '合成核銷驗收員', organizationName: '合成核銷機構', email: 'claims-admin@example.test', password } }); assert.equal(setup.status(), 201);
  const session = await setup.json(), orgId = session.organizations[0].id, headers = { Origin: base, 'X-Org-Id': orgId, 'X-CSRF-Token': session.csrfToken };
  const post = async (entity, data) => { const result = await context.request.post(base + '/api/' + entity, { headers, data }); assert.equal(result.status(), 201, await result.text()); return (await result.json()).item; };
  const list = async () => { const result = await context.request.get(base + '/api/claim-batches', { headers }); assert.equal(result.status(), 200); return (await result.json()).items; };
  const employee = await post('employees', { name: '合成核銷員工', employeeNo: 'CLAIM-E' });
  const c = await post('cases', { name: '合成帳单個案', caseNo: 'CLAIM-C' });
  const bills = [];
  for (const [number, amount] of [['SYN-CLAIM-B1', 12001], ['SYN-CLAIM-B2', 10001], ['SYN-CLAIM-B3', 1]]) {
    let item = await post('billing-documents', { caseId: c.id, month: '2026-10', number, lineItems: [{ label: '合成核對服務', quantity: 1, unitPriceCents: amount }] });
    const issued = await context.request.patch(base + '/api/billing-documents/' + item.id, { headers, data: { version: item.version, status: 'issued', sourceReference: '合成人工計價依據' } }); assert.equal(issued.status(), 200); item = (await issued.json()).item; bills.push(item);
  }
  for (const role of ['finance', 'supervisor', 'caregiver']) await post('users', { name: '合成' + role, email: role + '@claims.example.test', password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
  await page.goto(base + '/#/claim-batches'); await page.getByRole('heading', { name: '離線核銷與人工對帳', exact: true }).waitFor(); await settle(); await screen();
  const startDraft = async (number, selected) => {
    await page.getByRole('button', { name: '新增離線批次', exact: true }).click(); await dialog().getByLabel('來源帳單月份', { exact: false }).fill('2026-10'); await submit('查看可選帳單');
    await dialog().getByLabel('批次編號', { exact: false }).fill(number);
    for (const item of selected) await dialog().locator(`input[type="checkbox"][data-choice-value="${item.id}"]`).check();
    await dialog().getByLabel('批次人工依據', { exact: false }).fill('合成本機核銷批次依據');
  };
  stage = 'draft and exact ACK'; await startDraft('SYN-CLAIM-1', bills.slice(0, 2));
  await capture('draft-form-desktop');
  let injected = false;
  const badAck = async route => {
    if (route.request().method() !== 'POST' || injected) return route.continue(); injected = true;
    const response = await route.fetch(), result = await response.json(); result.item.summary.amountCents++;
    await route.fulfill({ response, json: result });
  };
  await page.route('**/api/claim-batches', badAck); await dialog().getByRole('button', { name: '儲存批次草稿', exact: true }).click(); await dialog().locator('.form-summary:not([hidden])').waitFor();
  assert.equal(await dialog().getByLabel('批次編號', { exact: false }).inputValue(), 'SYN-CLAIM-1'); assert.equal((await list()).length, 1);
  await page.unroute('**/api/claim-batches', badAck); await submit('儲存批次草稿'); assert.equal((await list()).length, 1);
  let batch = (await list())[0]; assert.equal(batch.summary.amountCents, 22002); assert.equal(batch.summary.unansweredAmountCents, 22002); assert.equal(batch.sourceSnapshots.length, 2);
  mark('普通勾選表單保存兩張帳單精確快照；非法提交ACK保留輸入，冪等重試不重複');
  stage = 'verify';
  await page.getByRole('button', { name: '批次詳情', exact: true }).click(); await dialog().getByRole('button', { name: '核對並鎖定', exact: true }).click();
  await dialog().getByRole('button', { name: '核對來源與鎖定', exact: true }).click(); await dialog().getByRole('button', { name: '確認核對鎖定', exact: true }).click();
  await page.getByRole('dialog', { name: '核對並鎖定離線批次', exact: true }).waitFor({ state: 'detached' }); await settle();
  batch = (await list())[0]; assert.equal(batch.status, 'verified'); assert.equal(batch.version, 2); await dialog().getByRole('button', { name: '下載本機 CSV', exact: true }).waitFor();
  await capture('verified-details-desktop'); mark('逐筆來源重新驗證、明確核對鎖定；保存版次與本機未申報標示');
  const beforeExport = counts(); const downloadEvent = page.waitForEvent('download'); await dialog().getByRole('button', { name: '下載本機 CSV', exact: true }).click(); const download = await downloadEvent;
  const csv = await readFile(await download.path(), 'utf8'); assert(csv.includes('local-homecare-claim-v1') && csv.includes('非FA') && bills.slice(0, 2).every(item => csv.includes(item.id)));
  assert.deepEqual(counts(), beforeExport); mark('共用CSV下載含格式警示、原帳單識別及精確分值，匯出零寫入');
  const frozen = structuredClone(batch.sourceSnapshots);
  const reply = async (bill, status, amount, reason) => {
    const row = dialog().getByRole('row').filter({ hasText: bill.number }); await row.getByRole('button', { name: '記錄人工回應', exact: true }).click();
    await dialog().getByLabel('收到回應的共同依據', { exact: false }).fill('合成已收回應文字依據');
    await dialog().getByLabel('本筆人工外部回應編號或依據', { exact: false }).fill('合成回應\n' + bill.number);
    await dialog().getByLabel('人工記錄回應結果', { exact: false }).selectOption(status); await dialog().getByLabel('回應接受金額（元）', { exact: false }).fill(amount);
    await dialog().getByLabel('退件原因或回應說明', { exact: false }).fill(reason); await submit('儲存人工回應');
  };
  stage = 'partial replies'; await reply(bills[0], 'accepted', '120.01', '合成接受說明'); batch = (await list())[0]; assert.equal(batch.status, 'reconciling'); assert.equal(batch.summary.acceptedAmountCents, 12001); assert.equal(batch.summary.unansweredAmountCents, 10001);
  const beforeIncomplete = counts(); const incomplete = await context.request.patch(base + '/api/claim-batches/' + batch.id, { headers, data: { version: batch.version, status: 'closed' } }); assert.equal(incomplete.status(), 409); assert.deepEqual(counts(), beforeIncomplete);
  mark('人工接受精確金額與未回應額分開；回應不完整時伺服器拒絕完成且零寫入');
  stage = 'rejection and closure'; await reply(bills[1], 'rejected', '0.00', '合成退件原因第一行\n合成退件原因末行'); batch = (await list())[0]; assert.equal(batch.summary.rejectedAmountCents, 10001); assert.equal(batch.responses.find(item => item.billingDocumentId === bills[1].id).amountCents, 0); assert.deepEqual(batch.sourceSnapshots, frozen);
  await dialog().getByRole('button', { name: '完成人工對帳', exact: true }).click(); await dialog().getByRole('button', { name: '確認人工對帳完成', exact: true }).click(); await settle();
  await dialog().getByText('人工對帳完成', { exact: true }).waitFor(); batch = (await list())[0]; assert.equal(batch.status, 'closed'); assert.equal(batch.version, 5); assert.deepEqual(batch.sourceSnapshots, frozen); assert.equal(await dialog().getByRole('button', { name: '記錄人工回應', exact: true }).count(), 0);
  await capture('closed-details-desktop'); mark('退件原來源額與接受金額分清；全筆有確定結果後鎖定人工對帳並保留快照');
  stage = 'history'; await close(); const beforeHistory = counts(); await page.getByRole('button', { name: '版本歷程', exact: true }).click();
  await dialog().getByText('完整保存欄位', { exact: true }).first().click(); await dialog().getByText('核對來源快照', { exact: true }).first().waitFor(); await dialog().getByText('保存對帳合計', { exact: true }).first().waitFor();
  assert(!(await dialog().innerText()).includes('[object Object]')); await capture('history-desktop'); await close(); assert.deepEqual(counts(), beforeHistory); mark('五版歷程保留核對來源、逐分合計與多行回應，唯讀零寫入');
  stage = 'cancellation and retry'; await startDraft('SYN-CLAIM-2', [bills[2]]); await submit('儲存批次草稿');
  const cancelRow = page.getByRole('row').filter({ hasText: 'SYN-CLAIM-2' }); await cancelRow.getByRole('button', { name: '批次詳情', exact: true }).click();
  await dialog().getByRole('button', { name: '取消批次', exact: true }).click(); await dialog().getByLabel('本次取消原因', { exact: false }).fill('合成更正後重新建立');
  await dialog().getByRole('button', { name: '核對並取消', exact: true }).click(); await dialog().getByRole('button', { name: '確認取消批次', exact: true }).click();
  await page.getByRole('dialog', { name: '取消離線批次', exact: true }).waitFor({ state: 'detached' }); await settle(); await dialog().getByText('已取消', { exact: true }).waitFor(); await close();
  await startDraft('SYN-CLAIM-3', [bills[2]]); await submit('儲存批次草稿'); const all = await list(); assert.equal(all.find(item => item.number === 'SYN-CLAIM-2').status, 'cancelled'); assert.equal(all.find(item => item.number === 'SYN-CLAIM-3').billingDocumentIds[0], bills[2].id);
  mark('取消必填本次原因且不可恢復；取消後以新批次重建同來源，不改舊歷程');
  stage = 'mobile'; await page.setViewportSize({ width: 390, height: 844 }); await screen(); await capture('list-mobile');
  await page.getByRole('row').filter({ hasText: 'SYN-CLAIM-1' }).getByRole('button', { name: '批次詳情', exact: true }).click(); await screen(); await capture('closed-details-mobile'); await close();
  await page.getByRole('row').filter({ hasText: 'SYN-CLAIM-1' }).getByRole('button', { name: '版本歷程', exact: true }).click(); await dialog().getByText('完整保存欄位', { exact: true }).first().click(); await screen(); await capture('history-mobile'); await close(); mark('390px清單、鎖定詳情與型別化歷程無頁面溢出、輸入具標籤');
  stage = 'roles';
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const other = await browser.newContext({ viewport: { width: 390, height: 844 } }), p = await other.newPage();
    const login = await other.request.post(base + '/api/login', { headers: { Origin: base }, data: { email: role + '@claims.example.test', password } }); assert.equal(login.status(), 200);
    let calls = 0; p.on('request', request => { if (role !== 'finance' && request.url().includes('/api/claim-batches')) calls++; });
    await p.goto(base + '/#/claim-batches'); await p.getByRole('heading', { name: role === 'finance' ? '離線核銷與人工對帳' : '您沒有這項操作權限', exact: true }).waitFor(); await p.waitForLoadState('networkidle'); assert.equal(calls, 0); await other.close();
  }
  mark('管理者財務可操作，督導居服員無入口且零批次讀取'); assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'passed', syntheticOnly: true, checks, screenshots, errors }, null, 2)); console.log('Evidence: ' + output);
} catch (error) {
  await capture('failure').catch(() => {}); await writeFile(path.join(output, 'verification.json'), JSON.stringify({ status: 'failed', stage, error: error.message, checks, screenshots, errors }, null, 2)); throw error;
} finally { await browser.close(); await app.close(); }
