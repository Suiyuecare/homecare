import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { installReportPrintCapture, renderCapturedReportPdf } from './helpers/report-print.mjs';

// All fixtures and mutations below use only this process's memory SQLite and random port.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/case-report-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [], readSegments = [], intentionalMutations = [], downloads = [];
const password = 'synthetic-case-report-password';
let browser, base, lastPage, readBaseline, stateBaseline;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: response.status() === 503 }); });
  page.on('download', download => downloads.push(download.suggestedFilename()));
};
const counts = () => Object.fromEntries([
  ['changes', 'SELECT total_changes() AS n'], ['audit', 'SELECT COUNT(*) AS n FROM audit'],
  ['records', 'SELECT COUNT(*) AS n FROM records'], ['versions', 'SELECT COUNT(*) AS n FROM record_versions'],
  ['idempotency', 'SELECT COUNT(*) AS n FROM idempotency'],
].map(([key, sql]) => [key, app.db.prepare(sql).get().n]));
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const startReads = () => { readBaseline = counts(); stateBaseline = rawState(); };
const verifyReads = label => { assert.deepEqual(counts(), readBaseline); assert.deepEqual(rawState(), stateBaseline); readSegments.push({ label, before: readBaseline, after: counts(), allStateUnchanged: true }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const fail503 = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_RETRY', message: '合成報表暫時無法取得，請重試。' } }) });
const listPattern = '**/api/case-report?*', fullPattern = '**/api/case-report/export?*', csvPattern = '**/api/case-report.csv?*';
const region = page => page.getByRole('region', { name: '個案總表查詢', exact: true });
const resultRegion = page => page.getByRole('region', { name: '個案總表查詢結果', exact: true });
const previewTitle = '個案總表列印預覽';
const printCount = page => page.evaluate(() => window.__printCalls.length);
const closeDialog = async (page, trigger) => { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); if (trigger) assert.ok(await trigger.evaluate(node => node === document.activeElement)); };
const queryReport = async (page, expected) => {
  await region(page).getByRole('button', { name: '查詢個案', exact: true }).click();
  await resultRegion(page).getByText(`符合條件共 ${expected} 個案；本頁 ${Math.min(expected, 25)} 筆。`, { exact: true }).waitFor();
};
const setAllRange = async page => {
  await region(page).getByLabel('建立日期起', { exact: true }).fill('2026-09-30');
  await region(page).getByLabel('建立日期迄', { exact: true }).fill('2026-11-08');
};
const loadReport = async page => {
  lastPage = page;
  if (page.url() === `${base}/#/reports`) await page.reload(); else await page.goto(`${base}/#/reports`);
  await page.getByRole('heading', { name: '報表中心', exact: true, level: 1 }).waitFor();
  await page.getByLabel('報表類型', { exact: true }).selectOption('cases');
  await resultRegion(page).waitFor(); await page.waitForLoadState('networkidle');
};
const inspectLayout = async page => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page horizontal overflow');
  assert.deepEqual(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), []);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    const box = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, window: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
    assert.ok(box.left >= 0 && box.right <= box.window && box.scroll <= box.client + 1, 'Dialog fits viewport, table owns scroll');
  }
  for (const table of await page.locator('.case-report-table:visible').all()) {
    assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
    assert.ok(await table.evaluate(node => [...node.querySelectorAll('tbody td:first-child')].every(cell => { const range = document.createRange(); range.selectNodeContents(cell); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size <= 1 && cell.scrollWidth <= cell.clientWidth + 1; })), 'Complete Taipei creation date stays on one readable line inside its cell');
    if (await table.evaluate(node => node.scrollWidth > node.clientWidth)) { await table.evaluate(node => { node.scrollLeft = node.scrollWidth; }); assert.ok(await table.evaluate(node => node.scrollLeft > 0)); await table.evaluate(node => { node.scrollLeft = 0; }); }
  }
};
const shot = async (page, name) => {
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
};
const openPreview = async page => { const trigger = region(page).getByRole('button', { name: '列印預覽', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.getByRole('region', { name: '完整個案總表', exact: true }).waitFor(); return { dialog, trigger }; };
const delayRoute = async (page, pattern) => {
  const arrived = deferred(), release = deferred(), handled = deferred();
  await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } });
  return { arrived, release, handled };
};
await mkdir(output, { recursive: true });

try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true }); contexts.push(context);
  const stubPrint = installReportPrintCapture;
  await stubPrint(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成個案報表管理員', email: 'case-report-admin@example.test', password, organizationName: '合成個案報表甲機構' } });
  assert.equal(setup.status(), 201); const admin = await setup.json(), orgId = admin.organizations[0].id;
  const fetchApi = (method, route, data, client = context, auth = admin, org = orgId) => client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) });
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => { const response = await fetchApi(method, route, data, client, auth, org); const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body; };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const employeeA = await post('employees', { name: '合成甲居服員', employeeNo: 'CR-EA', role: 'caregiver', hourlyRateCents: 30000 });
  const employeeB = await post('employees', { name: '合成乙居服員', employeeNo: 'CR-EB', role: 'caregiver', hourlyRateCents: 32000 });
  for (const [role, employee] of [['supervisor'], ['finance'], ['caregiver', employeeA]]) await post('users', { name: `合成報表${role}`, email: `case-report-${role}@example.test`, password, role, ...(employee ? { employeeId: employee.id } : {}) });
  const loginAs = async role => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true }); contexts.push(client); await stubPrint(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `case-report-${role}@example.test`, password } }); assert.equal(response.status(), 200);
    const auth = await response.json(), page = await client.newPage(); await page.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), finance = await loginAs('finance'), caregiver = await loginAs('caregiver');
  const page = await context.newPage(); await page.clock.setFixedTime(new Date('2026-10-08T02:00:00Z')); observe(page); lastPage = page;

  const supervisorA = await post('employees', { name: '合成甲督導', employeeNo: 'CR-SA', role: 'supervisor' });
  let supervisorB = await post('employees', { name: '合成停用主責人', employeeNo: 'CR-SB', role: 'supervisor' });
  const unusedEmployee = await post('employees', { name: '合成未指派主管', employeeNo: 'CR-SX', role: 'supervisor' });
  const loadWork = async (p, route, title) => { lastPage = p; if (p.url() === `${base}/#${route}`) await p.reload(); else await p.goto(`${base}/#${route}`); await p.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor(); await p.waitForLoadState('networkidle'); };
  const saveForm = async p => { const d = p.getByRole('dialog'); await d.getByRole('button', { name: '儲存', exact: true }).click(); await d.waitFor({ state: 'detached' }); };
  // First case follows actual UI create/edit/status actions and records real version/audit writes.
  await loadWork(page, '/cases', '個案'); await page.getByRole('button', { name: '新增個案', exact: true }).click();
  let form = page.getByRole('dialog'); await form.getByLabel(/^姓名/).fill('合成介面個案'); await form.getByLabel('案號', { exact: false }).fill('CR-001');
  await form.getByLabel('主責督導', { exact: true }).selectOption(supervisorA.id); await form.getByLabel('CMS 等級', { exact: true }).fill('4'); await form.getByLabel('照顧注意事項', { exact: true }).fill('CASE-001 合成介面建立'); await saveForm(page);
  const cases = [(await request('GET', 'cases?q=CR-001')).items[0]]; assert.equal(cases[0].version, 1);
  await page.getByRole('row').filter({ hasText: 'CR-001' }).getByRole('button', { name: '編輯', exact: true }).click(); form = page.getByRole('dialog');
  await form.getByLabel(/^姓名/).fill('合成介面更新個案'); await form.getByLabel('照顧注意事項', { exact: true }).fill('CASE-001 合成介面更新，建立日不代表收案日。'); await saveForm(page);
  await page.getByRole('row').filter({ hasText: 'CR-001' }).getByRole('link', { name: '查看個案', exact: true }).click();
  for (const [label, confirm, status] of [['暫停','確認暫停','paused'],['恢復服務','確認服務中','active'],['結案','確認結案','closed']]) {
    await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: confirm, exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); await page.waitForLoadState('networkidle');
    cases[0] = (await request('GET', `cases/${cases[0].id}`)).item; assert.equal(cases[0].status, status);
  }
  assert.equal(cases[0].version, 5); const history = await request('GET', `cases/${cases[0].id}/history?compare=previous`); assert.deepEqual(history.items.map(row => row.snapshot.status), ['closed','active','paused','active','active']);
  assert.ok(history.items.every(row => row.actor?.name === '合成個案報表管理員'));
  mark('真UI建立v1、編輯v2、暫停v3、恢復v4、結案v5；history與實際管理員audit一致，建立日期語意不變');

  // Explicit memory-only historical timestamp fixtures create BOTH records and immutable version snapshots.
  // No UPDATE/DELETE of record_versions and no real database or external patient information is used.
  const fixtureTimestampCase = (data, createdAt, updatedAt = createdAt, org = orgId) => {
    const item = { ...data, id: randomUUID(), orgId: org, version: 1, createdAt, updatedAt };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, org, 'cases', JSON.stringify(data), 1, createdAt, updatedAt);
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(org, 'cases', item.id, 1, JSON.stringify(item), createdAt, 'synthetic-timestamp-fixture'); return item;
  };
  const dates = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 8, 30+i)).toISOString().slice(0,10)).filter(date => date !== '2026-10-08');
  for (let i = 1; i < 40; i++) {
    const date = dates[i-1]; let createdAt = `${date}T04:00:00.000Z`;
    if (date === '2026-09-30') createdAt = '2026-09-30T15:59:59.999Z';
    if (date === '2026-10-01') createdAt = '2026-09-30T16:00:00.000Z';
    if (date === '2026-11-01') createdAt = '2026-10-31T16:00:00.000Z';
    if (date === '2026-10-05') createdAt = '2026-10-05T00:00:00+08:00';
    const marker = `CASE-${String(i+1).padStart(3,'0')}`;
    cases.push(fixtureTimestampCase({ name: `合成個案${String(i+1).padStart(2,'0')}`, caseNo: `CR-${String(i+1).padStart(3,'0')}`, gender: i%2 ? '女性':'男性', status:'active',
      supervisorId: i === 39 ? randomUUID() : i%4===0 ? supervisorA.id : i%4===1 ? supervisorB.id : i%4===2 ? employeeA.id : '',
      cmsLevel: i === 30 ? '待核對原保存文字' : i === 6 ? null : i === 33 ? 0 : i%5===0 ? '' : 4, welfare: '合成福利身分，待業務核對',
      birthDate:'1950-01-01',phone:'0000000000',address:'合成地址不應輸出',contactName:'合成隱藏聯絡人',contactPhone:'0000000000',primaryCarer:'合成隱藏照顧者',
      note: i===1 ? `=SUM(1,2)\n${marker} 合成"引號",逗號` : `${marker} 合成個案照顧提醒：維持既有作息，聯絡窗口與服務安排需依目前紀錄確認。`
    }, createdAt));
  }
  const service = await post('service-items', { code:'CR-S',name:'合成報表唯讀照顧',minutes:30,unitPriceCents:12345 });
  const shifts=[];
  for(let i=1;i<=28;i++) {
    const plan=await post('care-plans',{caseId:cases[i].id,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',services:[{serviceItemId:service.id,quantity:100}]});
    shifts.push(await post('shifts',{caseId:cases[i].id,carePlanId:plan.id,employeeId:employeeA.id,date:`2026-01-${String(i).padStart(2,'0')}`,startTime:'09:00',endTime:'10:00',services:[{serviceItemId:service.id,quantity:1}]}));
  }
  let billRecord=await post('service-records',{shiftId:shifts[0].id,caseId:cases[1].id,employeeId:employeeA.id,date:shifts[0].date,actualStart:'09:05',actualEnd:'09:50',services:[{serviceItemId:service.id,quantity:2}],status:'submitted',note:'合成既有核閱快照，報表不得改動'});
  billRecord=(await request('POST',`service-records/${billRecord.id}/review`,{version:billRecord.version,decision:'approved',reviewNote:'合成已確認'})).item;
  shifts[0]=(await request('GET',`shifts/${shifts[0].id}`)).item; assert.equal(shifts[0].status,'completed');
  shifts[1]=await patch('shifts',shifts[1],{status:'cancelled'});
  for(let i=1;i<40;i++) if(i%3) cases[i]=await patch('cases',cases[i],{status:i%3===1?'paused':'closed'});
  supervisorB=await patch('employees',supervisorB,{status:'inactive',role:'administration'});
  const orgB=(await request('POST','organizations',{name:'合成個案報表乙機構'},201)).item;
  const foreignCase=(await request('POST','cases',{name:'合成跨機構個案',caseNo:'CR-X'},201,context,admin,orgB.id)).item;
  const foreignEmployee=(await request('POST','employees',{name:'合成跨機構主責人',employeeNo:'CR-X',role:'supervisor'},201,context,admin,orgB.id)).item;
  const oldFee=await request('GET','reports/fees?month=2026-01'),oldPayroll=await request('GET','reports/payroll?month=2026-01');
  const masterState=app.db.prepare("SELECT * FROM records WHERE entity NOT IN ('cases','shifts') ORDER BY id").all();
  const allQuery='startDate=2026-09-30&endDate=2026-11-08', full=()=>request('GET',`case-report/export?${allQuery}`);
  const expectedFor=filters=>cases.filter(item=>(!filters.status||item.status===filters.status)&&(!filters.caseId||item.id===filters.caseId)&&(!filters.supervisorId||item.supervisorId===filters.supervisorId)).length;
  for(const item of cases.slice(1)){const saved=app.db.prepare('SELECT snapshot,created_at FROM record_versions WHERE record_id=? AND version=1').get(item.id);assert.equal(JSON.parse(saved.snapshot).createdAt,item.createdAt);assert.equal(saved.created_at,item.createdAt);}
  startReads(); const initialCounts=counts();
  const completeInitial=await full(); assert.equal(completeInitial.total,40);
  for(const [stamp,date] of [['2026-09-30T15:59:59.999Z','2026-09-30'],['2026-09-30T16:00:00.000Z','2026-10-01'],['2026-10-31T16:00:00.000Z','2026-11-01'],['2026-10-05T00:00:00+08:00','2026-10-05']]) {
    const row=completeInitial.rows.find(row=>row.createdAt===stamp); assert.equal(row.createdDate,date);
    const single=await request('GET',`case-report/export?startDate=${date}&endDate=${date}&caseId=${row.caseId}`); assert.equal(single.total,1); assert.equal(single.rows[0].createdAt,stamp);
  }
  assert.equal(completeInitial.rows.find(row=>row.caseId===cases[30].id).cmsLevel,'待核對原保存文字');
  assert.equal(completeInitial.rows.find(row=>row.caseId===cases[6].id).cmsLevel,''); assert.equal(completeInitial.rows.find(row=>row.caseId===cases[33].id).cmsLevel,'0');
  assert.equal(completeInitial.rows.find(row=>row.caseId===cases[3].id).supervisor,'尚未指定'); assert.equal(completeInitial.rows.find(row=>row.caseId===cases[39].id).supervisor,'主責督導名稱未取得');
  verifyReads('timestamp-boundaries-and-projection'); mark('合成timestamp同時保存在records及版本；臺北16:00Z跨日/月底、合法offset、CMS文字/空/0與未指定/缺名皆正確，純讀零寫入');

  let dialog,trigger;
  await loadReport(page); await resultRegion(page).getByText('符合條件共 31 個案；本頁 25 筆。',{exact:true}).waitFor();
  await setAllRange(page); assert.ok(await region(page).getByRole('button',{name:'下載 CSV',exact:true}).isDisabled()); assert.ok(await region(page).getByRole('button',{name:'列印預覽',exact:true}).isDisabled());
  await queryReport(page,40); assert.equal(await resultRegion(page).locator('tbody tr').count(),25);
  await region(page).getByRole('button',{name:'下一頁',exact:true}).click(); await resultRegion(page).getByText('符合條件共 40 個案；本頁 15 筆。',{exact:true}).waitFor();
  const first=await request('GET',`case-report?${allQuery}&page=1&pageSize=25`),second=await request('GET',`case-report?${allQuery}&page=2&pageSize=25`),complete=await full();assert.deepEqual([...first.rows,...second.rows],complete.rows);
  await shot(page,'report-page-two-desktop.png');mark('跨月40個案與25+15分頁聯集等於全數JSON；總數不誤用當頁，改日期條件立即禁輸出');
  await region(page).getByLabel('主責督導',{exact:true}).selectOption(supervisorB.id); await queryReport(page,expectedFor({supervisorId:supervisorB.id}));
  assert.equal(await region(page).getByLabel('主責督導',{exact:true}).locator(`option[value="${unusedEmployee.id}"]`).count(),0);
  await region(page).getByLabel('個案',{exact:true}).selectOption(cases[0].id); await queryReport(page,0); await shot(page,'report-empty-combination.png'); assert.ok(await region(page).getByRole('button',{name:'下載 CSV',exact:true}).isDisabled());
  await region(page).getByLabel('主責督導',{exact:true}).selectOption(supervisorA.id); await queryReport(page,1);
  await region(page).getByLabel('個案',{exact:true}).selectOption('');await region(page).getByLabel('主責督導',{exact:true}).selectOption('');
  for(const status of ['active','paused','closed']){await region(page).getByLabel('個案狀態',{exact:true}).selectOption(status);await queryReport(page,expectedFor({status}));}
  await region(page).getByRole('button',{name:'清除條件',exact:true}).click();await resultRegion(page).getByText('符合條件共 31 個案；本頁 25 筆。',{exact:true}).waitFor();
  assert.equal(await region(page).getByLabel('建立日期起',{exact:true}).inputValue(),'2026-10-01');assert.equal(await region(page).getByLabel('建立日期迄',{exact:true}).inputValue(),'2026-10-31');for(const label of ['個案','主責督導','個案狀態'])assert.equal(await region(page).getByLabel(label,{exact:true}).inputValue(),'');
  mark('三種狀態與個案/督導交集真查詢；已指派停用且職務改字主管仍可選，未指派員工不列；空結果禁輸出/清除回本月');
  await region(page).getByLabel('建立日期迄', { exact: true }).fill('2026-09-30'); await region(page).getByRole('button', { name: '查詢個案', exact: true }).click(); assert.equal(await region(page).getByLabel('建立日期迄', { exact: true }).getAttribute('aria-invalid'), 'true'); assert.ok(await region(page).getByLabel('建立日期迄', { exact: true }).evaluate(node => node === document.activeElement));
  await shot(page, 'report-date-validation.png'); await setAllRange(page); await queryReport(page, 40); await inspectLayout(page); await shot(page, 'report-filters-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await shot(page, 'report-filters-mobile.png');
  await resultRegion(page).locator('.table-scroll').evaluate(node => { node.scrollIntoView({ block: 'start' }); node.scrollLeft = node.scrollWidth; }); await shot(page, 'report-table-mobile-after.png'); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('日期倒置保留輸入且語意錯誤/焦點正確；1440/390所有控制有label、整頁不溢出且寬表自身捲動');

  const csvResponse = await fetchApi('GET', `case-report.csv?${allQuery}`); assert.equal(csvResponse.status(), 200); const expectedCsv = await csvResponse.body();
  assert.match(csvResponse.headers()['content-type'], /^text\/csv/); assert.match(csvResponse.headers()['content-disposition'], /case-report\.csv/); assert.equal(csvResponse.headers()['x-content-type-options'], 'nosniff'); assert.match(csvResponse.headers()['cache-control'], /no-store/);
  assert.deepEqual([...expectedCsv.subarray(0, 3)], [239, 187, 191]); assert.ok(expectedCsv.toString().includes('\r\n')); assert.ok(expectedCsv.toString().includes("'=SUM(1,2)")); assert.ok(expectedCsv.toString().includes('""引號""'));
  const downloadPromise = page.waitForEvent('download'); await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); const download = await downloadPromise; const csvFile = path.join(output, 'synthetic-case-report.csv'); await download.saveAs(csvFile); assert.deepEqual(await readFile(csvFile), expectedCsv);
  mark('真瀏覽器CSV下載逐位元等於fresh API全40筆，BOM/CRLF/中文/引號/換行與公式防護、下載headers正確');

  ({ dialog, trigger } = await openPreview(page)); assert.equal(await dialog.locator('tbody tr').count(), 40); await dialog.getByText('符合條件共 40 個案；以下為完整資料。', { exact: true }).waitFor(); await inspectLayout(page); await shot(page, 'report-preview-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await inspectLayout(page); await shot(page, 'report-preview-mobile.png'); await dialog.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; node.scrollIntoView({ block: 'start' }); }); await shot(page, 'report-preview-mobile-after.png'); await page.setViewportSize({ width: 1440, height: 1050 }); await closeDialog(page, trigger);
  await trigger.focus(); await trigger.press('Enter'); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.locator('tbody tr').first().waitFor(); await closeDialog(page, trigger);
  verifyReads('filters/pagination/CSV/previews/keyboard'); mark('完整預覽顯示40筆/機構/條件/產生時間；1440/390內部捲動與鍵盤Enter/Escape焦點，所有讀取零DB寫入');


  const suppressNativePrint = async (targetPage = page) => {
    const count = await printCount(targetPage); await targetPage.evaluate(() => window.dispatchEvent(new Event('beforeprint'))); await targetPage.emulateMedia({ media: 'print' });
    assert.ok(await targetPage.evaluate(() => document.body.classList.contains('print-suppressed')));
    assert.deepEqual(await targetPage.evaluate(() => [...document.body.children].filter(node => getComputedStyle(node).display !== 'none').map(node => node.tagName)), [], 'Invalid or unready native print hides every body child, including background app');
    assert.equal(await printCount(targetPage), count); await targetPage.evaluate(() => window.dispatchEvent(new Event('afterprint'))); assert.equal(await targetPage.evaluate(() => document.body.classList.contains('print-suppressed')), false); await targetPage.emulateMedia({ media: null });
  };
  ({dialog,trigger}=await openPreview(page));
  for(const status of ['paused','active','closed']) {
    verifyReads(`before-intentional-${status}`);const before=counts();cases[12]=await patch('cases',cases[12],{status,name:'合成最新版本個案',welfare:'合成最新福利保存文字',note:`CASE-013 合成預覽後${status}最新保存備註：完整文字不得截斷。`});intentionalMutations.push({caseId:cases[12].id,status,version:cases[12].version,before,after:counts()});startReads();
    await suppressNativePrint();assert.equal(await page.getByRole('dialog').count(),1);await dialog.getByText('請使用「列印／另存 PDF」按鈕重新讀取資料後列印。',{exact:true}).waitFor();
    const prints=await printCount(page);await dialog.getByRole('button',{name:'列印／另存 PDF',exact:true}).click();await page.waitForFunction(n=>window.__printCalls.length===n,prints+1);
    const row=dialog.getByRole('row').filter({hasText:'CASE-013'});assert.equal(await row.getByRole('cell').nth(9).textContent(),String(cases[12].version));await row.getByText({paused:'暫停',active:'服務中',closed:'結案'}[status],{exact:true}).waitFor();assert.ok((await page.evaluate(()=>window.__printCalls.at(-1).text)).includes(cases[12].note));verifyReads(`fresh-print-${status}`);
  }
  await dialog.getByRole('row').filter({hasText:'CASE-013'}).evaluate(node=>node.scrollIntoView({block:'center'}));await dialog.locator('.table-scroll').evaluate(node=>node.scrollLeft=node.scrollWidth);await shot(page,'report-print-fresh-case.png');await closeDialog(page,trigger);await queryReport(page,40);
  mark('預覽後真PATCH暫停/恢復/結案連續升版，原生CtrlP禁印舊快取，每次畫面列印fresh後才print；最新名字/福利/狀態/版次/完整備註一致');
  let tries = 0; await page.route(listPattern, route => ++tries === 1 ? fail503(route) : route.continue());
  await region(page).getByRole('button', { name: '查詢個案', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.ok(await region(page).getByRole('button', { name: '列印預覽', exact: true }).isDisabled()); await shot(page, 'report-list-retry.png'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await resultRegion(page).waitFor(); assert.equal(tries, 2); await page.unroute(listPattern);
  tries = 0; await page.route(csvPattern, route => ++tries === 1 ? fail503(route) : route.continue()); const downloadsBeforeRetry = downloads.length;
  await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(downloads.length, downloadsBeforeRetry); await shot(page, 'report-csv-retry.png'); const retryDownload = page.waitForEvent('download'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await retryDownload; assert.equal(tries, 2); await page.unroute(csvPattern);
  await page.route(csvPattern, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>synthetic wrong type</html>' })); const beforeWrongType = downloads.length; await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(downloads.length, beforeWrongType); await page.unroute(csvPattern); await queryReport(page, 40);
  await page.route(csvPattern, route => route.fulfill({ status: 200, contentType: 'text/csv', body: '' })); const beforeEmptyBody = downloads.length;
  await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByText('報表回應為空，請重試。', { exact: true }).waitFor(); assert.equal(downloads.length, beforeEmptyBody); await page.unroute(csvPattern); await queryReport(page, 40);
  await page.route(csvPattern, fail503);
  await page.evaluate(() => {
    const original = window.fetch; window.__originalReportFetch = original; let interrupted = false;
    window.fetch = async (...args) => { const response = await original(...args); if (!interrupted && String(args[0]).includes('/api/case-report.csv?')) { interrupted = true; Object.defineProperty(response, 'json', { value: async () => { throw new DOMException('Synthetic response body interrupted', 'AbortError'); } }); } return response; };
  });
  const beforeBodyAbort = downloads.length; await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await region(page).getByText('報表下載逾時，請重試。', { exact: true }).waitFor(); assert.equal(downloads.length, beforeBodyAbort);
  await page.evaluate(() => { window.fetch = window.__originalReportFetch; delete window.__originalReportFetch; }); await page.unroute(csvPattern); await queryReport(page, 40);
  mark('查詢/CSV503可重試真API；錯誤MIME、空body與錯誤回應body AbortError均不下載，逾時提示且保留條件');

  ({ dialog, trigger } = await openPreview(page)); tries = 0; const printsBeforeRetry = await printCount(page); await page.route(fullPattern, route => ++tries === 1 ? fail503(route) : route.continue());
  await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await dialog.getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.equal(await printCount(page), printsBeforeRetry); await shot(page, 'report-print-retry.png'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.locator('tbody tr').first().waitFor(); assert.equal(await printCount(page), printsBeforeRetry); await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await page.waitForFunction(n => window.__printCalls.length === n, printsBeforeRetry + 1); assert.equal(tries, 3); await page.unroute(fullPattern); await closeDialog(page, trigger);
  ({ dialog, trigger } = await openPreview(page)); const empty = await full(); empty.rows = []; empty.total = 0; empty.totals.count = 0; empty.pageSize = 0; await page.route(fullPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(empty) })); const printBeforeEmpty = await printCount(page); await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await dialog.getByText('目前已無符合條件的個案，請重新查詢。', { exact: true }).waitFor(); assert.equal(await printCount(page), printBeforeEmpty); await closeDialog(page, trigger); await page.unroute(fullPattern);
  const malformed = await full(); malformed.rows[0].createdDate = '2026-10-15'; const beforeMalformed = await printCount(page);
  await page.route(fullPattern, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(malformed) })); await region(page).getByRole('button', { name: '列印預覽', exact: true }).click(); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.getByRole('alert').waitFor(); assert.ok(await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).isDisabled()); assert.equal(await dialog.locator('tbody tr').count(), 0); assert.equal(await printCount(page), beforeMalformed); await closeDialog(page); await page.unroute(fullPattern);
  mark('列印fresh GET503不印舊快取；重讀只恢復預覽、再按列印再fresh；空結果與建立日期不符的DTO皆不列印');

  for (const action of ['preview', 'print']) {
    if (action === 'print') ({ dialog, trigger } = await openPreview(page)); else trigger = region(page).getByRole('button', { name: '列印預覽', exact: true });
    const delayed = await delayRoute(page, fullPattern), before = await printCount(page);
    if (action === 'preview') await trigger.click(); else await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click();
    await delayed.arrived.promise; await closeDialog(page, trigger); delayed.release.resolve(); await delayed.handled.promise; await settle(page); assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await printCount(page), before); await page.unroute(fullPattern);
  }
  const delayedList = await delayRoute(page, listPattern); await region(page).getByRole('button', { name: '查詢個案', exact: true }).click(); await delayedList.arrived.promise; await region(page).getByLabel('個案狀態', { exact: true }).selectOption('closed'); await page.unroute(listPattern); await queryReport(page, expectedFor({status:'closed'})); delayedList.release.resolve(); await delayedList.handled.promise; await settle(page); assert.equal(await resultRegion(page).locator('tbody tr').count(), expectedFor({status:'closed'})); await region(page).getByLabel('個案狀態', { exact: true }).selectOption(''); await queryReport(page, 40);
  mark('慢預覽/慢列印Escape取消且焦點回復、晚回應不復活/不印；舊查詢晚回應不覆蓋新status結果');

  for (const mode of ['cancel', 'type', 'route', 'organization']) {
    await loadReport(page); await setAllRange(page); await queryReport(page, 40); const delayed = await delayRoute(page, csvPattern), before = downloads.length;
    await region(page).getByRole('button', { name: '下載 CSV', exact: true }).click(); await delayed.arrived.promise;
    if (mode === 'cancel') await region(page).getByRole('button', { name: '取消下載', exact: true }).click();
    if (mode === 'type') await page.getByLabel('報表類型', { exact: true }).selectOption('services');
    if (mode === 'route') await page.evaluate(() => { location.hash = '/cases'; });
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).selectOption(orgB.id);
    delayed.release.resolve(); await delayed.handled.promise; await settle(page); assert.equal(downloads.length, before); await page.unroute(csvPattern);
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).selectOption(orgId);
  }
  mark('CSV慢回應於取消/切報表類型/換route/換機構後均不下載，沒有跨條件或跨scope晚輸出');

  for (const mode of ['type', 'route', 'organization']) {
    await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page)); const delayed = await delayRoute(page, fullPattern), before = await printCount(page);
    await dialog.getByRole('button', { name: '列印／另存 PDF', exact: true }).click(); await delayed.arrived.promise;
    if (mode === 'type') await page.getByLabel('報表類型', { exact: true }).evaluate(node => { node.value = 'services'; node.dispatchEvent(new Event('change', { bubbles: true })); });
    if (mode === 'route') await page.evaluate(() => { location.hash = '/cases'; });
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, orgB.id);
    delayed.release.resolve(); await delayed.handled.promise; await settle(page); assert.equal(await printCount(page), before); await dialog.waitFor({ state: 'detached' }); await page.unroute(fullPattern);
    if (mode === 'organization') await page.getByLabel('目前機構', { exact: true }).selectOption(orgId);
  }
  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page));
  await page.evaluate(() => { location.hash = '/cases'; }); await dialog.waitFor({ state: 'detached' });
  mark('列印重讀期間切報表類型/route/機構不晚印且自動關閉；已載入預覽route失效亦立即撤除，不能留下舊內容供CtrlP');

  // Chromium print-media checks exercise the native event guard without generating another PDF.

  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page));
  await region(page).getByLabel('建立日期迄', { exact: true }).evaluate(node => { node.value = '2026-11-07'; }); await suppressNativePrint(); await dialog.waitFor({ state: 'detached' });
  await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page)); await closeDialog(page, trigger);
  const pendingPrint = await delayRoute(page, fullPattern); await region(page).getByRole('button', { name: '列印預覽', exact: true }).click(); await pendingPrint.arrived.promise; await suppressNativePrint();
  pendingPrint.release.resolve(); await pendingPrint.handled.promise; await page.unroute(fullPattern); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.locator('tbody tr').first().waitFor(); await closeDialog(page);
  await page.route(fullPattern, fail503); await region(page).getByRole('button', { name: '列印預覽', exact: true }).click(); dialog = page.getByRole('dialog', { name: previewTitle, exact: true }); await dialog.getByRole('alert').waitFor(); await suppressNativePrint(); await page.unroute(fullPattern);
  await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.locator('tbody tr').first().waitFor(); await closeDialog(page);
  mark('原生beforeprint檢查：靜默改filter撤除舊dialog且print media全背景隱藏；載入/錯誤同樣禁印，afterprint清抑制並可重查/重試');

  await page.goto(`${base}/#/reports`); tries = 0; await page.route('**/api/employees?page=*&pageSize=100', route => ++tries === 1 ? fail503(route) : route.continue()); await page.getByLabel('報表類型', { exact: true }).selectOption('cases'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor(); assert.ok(await region(page).getByRole('button', { name: '查詢個案', exact: true }).isDisabled()); await shot(page, 'report-lookup-retry.png'); await region(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await resultRegion(page).waitFor(); assert.equal(tries, 2); await page.unroute('**/api/employees?page=*&pageSize=100');

  for(const actor of [supervisor,finance]){await loadReport(actor.page);await setAllRange(actor.page);await queryReport(actor.page,40);}
  const rowKeys=['caseId','version','createdDate','caseNo','name','gender','cmsLevel','welfare','status','statusLabel','supervisorNo','supervisor','createdAt','updatedAt','note'].sort();
  for(const actor of [{client:context,auth:admin},supervisor,finance,caregiver]) {
    for(const suffix of ['', '/export','.csv']) {
      const response=await fetchApi('GET',`case-report${suffix}?${allQuery}`,undefined,actor.client,actor.auth);assert.equal(response.status(),200);
      if(suffix!=='.csv'){const body=await response.json();assert.equal(body.total,actor===caregiver?28:40);for(const row of body.rows)assert.deepEqual(Object.keys(row).sort(),rowKeys);}
      for(const [key,id] of [['caseId',foreignCase.id],['supervisorId',foreignEmployee.id],['supervisorId',unusedEmployee.id]]) assert.equal((await fetchApi('GET',`case-report${suffix}?${allQuery}&${key}=${id}`,undefined,actor.client,actor.auth)).status(),404);
    }
  }
  for(const suffix of ['', '/export','.csv'])assert.equal((await fetchApi('GET',`case-report${suffix}?${allQuery}&supervisorId=${supervisorA.id}`,undefined,caregiver.client,caregiver.auth)).status(),404);
  const own=await request('GET',`case-report/export?${allQuery}`,undefined,200,caregiver.client,caregiver.auth);assert.equal(own.total,28);
  assert.ok(own.rows.some(row=>row.caseId===cases[1].id));assert.ok(own.rows.some(row=>row.caseId===cases[2].id));
  const hiddenSupervisor=own.rows.find(row=>row.caseId===cases[1].id);assert.equal(hiddenSupervisor.supervisor,'主責督導名稱未取得');assert.equal(hiddenSupervisor.supervisorNo,'');assert.ok(!JSON.stringify(own).includes(supervisorB.id));
  const ownAssigned=await request('GET',`case-report/export?${allQuery}&supervisorId=${employeeA.id}`,undefined,200,caregiver.client,caregiver.auth);assert.equal(ownAssigned.total,7);
  await caregiver.page.goto(`${base}/#/reports`);await caregiver.page.waitForLoadState('networkidle');assert.equal(await caregiver.page.getByLabel('報表類型',{exact:true}).count(),0);assert.equal(await caregiver.page.getByRole('link',{name:'報表中心',exact:true}).count(),0);
  verifyReads('retry-cancel-beforeprint-role-scope');
  mark('管理/督導/財務40案、居服員依現存含完成/取消舊班28案；督導名稱不擴employee scope，未指派/跨機構/不可讀filters404，無報表導覽');
  // Current authorization refresh: one normal reassignment removes that case immediately, without a historical grant.
  const reassignedIndex=2;verifyReads('before-intentional-reassignment');const beforeReassignment=counts();shifts[reassignedIndex]=await patch('shifts',shifts[reassignedIndex],{employeeId:employeeB.id});intentionalMutations.push({shiftId:shifts[reassignedIndex].id,action:'reassign-for-authorization',before:beforeReassignment,after:counts()});startReads();
  const reduced=await request('GET',`case-report/export?${allQuery}`,undefined,200,caregiver.client,caregiver.auth);assert.equal(reduced.total,27);assert.ok(!reduced.rows.some(row=>row.caseId===cases[3].id));
  for(const suffix of ['', '/export','.csv'])assert.equal((await fetchApi('GET',`case-report${suffix}?${allQuery}&caseId=${cases[3].id}`,undefined,caregiver.client,caregiver.auth)).status(),404);
  const emptyApi=await request('GET','case-report/export?startDate=2026-12-01&endDate=2026-12-02');assert.deepEqual(emptyApi.rows,[]);assert.equal(emptyApi.pageSize,0);verifyReads('fresh-current-case-authorization');mark('正常改派班次後居服員case範圍立即28→27，三端舊casefilter404；沒有沿用先前查詢權限');

  await loadReport(supervisor.page);await setAllRange(supervisor.page);await queryReport(supervisor.page,40);const permissionPreview=await openPreview(supervisor.page);
  verifyReads('before-memory-permission-fixture');const savedMembership=app.db.prepare('SELECT * FROM memberships WHERE org_id=? AND user_id=?').get(orgId,supervisor.auth.user.id);const beforeRevoke=counts();
  app.db.prepare("UPDATE memberships SET role='caregiver',employee_id=NULL WHERE org_id=? AND user_id=?").run(orgId,supervisor.auth.user.id);
  intentionalMutations.push({action:'memory-only-revoke-supervisor-permission-fixture',before:beforeRevoke,after:counts()});startReads();
  await suppressNativePrint(supervisor.page);assert.equal(await supervisor.page.getByRole('dialog').count(),1);const deniedPrintCount=await printCount(supervisor.page);
  await permissionPreview.dialog.getByRole('button',{name:'列印／另存 PDF',exact:true}).click();await permissionPreview.dialog.getByRole('alert').waitFor();assert.equal(await printCount(supervisor.page),deniedPrintCount);assert.equal(await permissionPreview.dialog.locator('tbody tr').count(),0);
  for(const response of failedResponses)if(response.path==='/api/case-report/export'&&response.status===403)response.expected=true;
  verifyReads('native-cached-permission-revoked-and-fresh-denied');await closeDialog(supervisor.page,permissionPreview.trigger);
  const beforeRestore=counts();app.db.prepare('UPDATE memberships SET role=?,employee_id=? WHERE org_id=? AND user_id=?').run(savedMembership.role,savedMembership.employee_id,orgId,supervisor.auth.user.id);
  intentionalMutations.push({action:'restore-memory-permission-fixture',before:beforeRestore,after:counts()});startReads();assert.deepEqual(app.db.prepare('SELECT * FROM memberships WHERE org_id=? AND user_id=?').get(orgId,supervisor.auth.user.id),savedMembership);
  mark('已載入預覽後memory權限撤銷：原生CtrlP抑制舊內容，畫面fresh403亦不印；測試membership原樣恢復且兩次fixture寫入獨立列帳');

  // One QA-only PDF from the latest complete preview, with the native print function still intercepted.
  await loadReport(page); await setAllRange(page); await queryReport(page, 40); ({ dialog, trigger } = await openPreview(page)); await dialog.getByText(cases[12].note, { exact: true }).waitFor();
  const expectedPdf = await full(); await writeFile(path.join(output, 'pdf-expected.json'), JSON.stringify(expectedPdf, null, 2));
  const marker = process.env.HOME_CARE_QA_PDF_MARKER;
  if (marker && !process.env.PDF_OPERATION_ALREADY_MARKED) {
    const markerResult = spawnSync(process.execPath, [marker, '--operation-kind', 'create', '--expected-output-count', '1', '--output-format', 'pdf'], { encoding: 'utf8' }); assert.equal(markerResult.status, 0, markerResult.stderr);
    await writeFile(path.join(output, 'pdf-operation.json'), JSON.stringify({ operation: 'create', expectedOutputCount: 1, outputFormat: 'pdf', marker, completedAt: new Date().toISOString(), exitStatus: markerResult.status, stdout: markerResult.stdout, stderr: markerResult.stderr }, null, 2)); console.log(markerResult.stdout.trim());
  }
  const pdfPath = path.join(output, 'synthetic-case-report.pdf'); const provenance = await renderCapturedReportPdf({ browser, page, path: pdfPath }); await writeFile(path.join(output, 'pdf-provenance.json'), JSON.stringify(provenance, null, 2));
  const py = process.env.HOME_CARE_QA_PYTHON || 'python3';
  const audit = spawnSync(py, ['-c', `import json, pathlib, re, sys, logging, unicodedata, pdfplumber
logging.getLogger('pdfminer').setLevel(logging.ERROR)
p=pathlib.Path(sys.argv[1]); expected=json.loads((p/'pdf-expected.json').read_text()); findings=[]
with pdfplumber.open(p/'synthetic-case-report.pdf') as pdf:
 texts=[unicodedata.normalize('NFKC',page.extract_text(use_text_flow=True) or '') for page in pdf.pages]
 assert len(texts)>1, 'Expected multi-page QA PDF'
 combined='\\n\\n'.join(texts); compact=re.sub(r'\\s+','',combined)
 for row in expected['rows']:
  for key in ['note','updatedAt','cmsLevel','createdDate']:
   if row[key]: assert re.sub(r'\\s+','',unicodedata.normalize('NFKC',row[key].replace('-','/') if key=='createdDate' else row[key])) in compact, ('Missing full saved value',row['caseId'],key)
 for index in range(1,41):
  marker=f'CASE-{index:03d}'; assert compact.count(marker)==1, (marker,compact.count(marker))
 assert '符合條件共40個案' in compact, 'Missing whole-result count'
 for i,page in enumerate(pdf.pages):
  text=re.sub(r'\\s+','',texts[i]); assert text and len(text)>80, ('Blank page',i+1)
  assert page.width>page.height and abs(page.width-841.89)<3 and abs(page.height-595.28)<3, ('Not landscape A4',i,page.width,page.height)
  for header in ['系統建立日期','案號','CMS等級','督導編號','個案備註']: assert header in text, ('Missing repeated table header',i+1,header)
  for forbidden in ['報表中心','列印／另存PDF','查詢個案','清除條件','測試工作空間']: assert forbidden not in text, ('Background UI',i+1,forbidden)
  assert '\\ufffd' not in text and '\\u25a1' not in text, ('Missing glyph',i+1)
  chars=page.chars
  assert all(c['x0']>=20 and c['x1']<=page.width-20 and c['top']>=15 and c['bottom']<=page.height-15 for c in chars), ('Text outside safe printable bounds',i+1)
  findings.append({'page':i+1,'width':page.width,'height':page.height,'characters':len(chars),'rowMarkers':re.findall(r'CASE-\\d{3}',text),'headersRepeated':True,'boundsSafe':True})
 (p/'pdf-text.txt').write_text(combined)
 (p/'pdf-review.json').write_text(json.dumps({'passed':True,'pages':findings,'all40RowMarkersExactlyOnce':True,'latestVersionIncluded':'CASE-013合成預覽後closed最新保存備註' in compact,'noBackgroundUI':True,'visualReviewRequired':True},ensure_ascii=False,indent=2))
 print(json.dumps({'pageCount':len(texts),'rowCount':40}))`, output], { encoding: 'utf8' }); assert.equal(audit.status, 0, audit.stderr); console.log(audit.stdout.trim());
  const poppler = process.env.HOME_CARE_QA_PDFTOPPM || 'pdftoppm';
  for (const name of await readdir(output)) if (/^pdf-(?:page|initial)-\d+\.png$/.test(name)) await rm(path.join(output, name));
  const render = spawnSync(poppler, ['-r', '110', '-png', pdfPath, path.join(output, 'pdf-page')], { encoding: 'utf8' }); assert.equal(render.status, 0, render.stderr);
  await closeDialog(page, trigger); verifyReads('PDF-generation-and-full-text-validation'); assert.deepEqual(app.db.prepare("SELECT * FROM records WHERE entity NOT IN ('cases','shifts') ORDER BY id").all(), masterState); assert.deepEqual((await request('GET', `service-records/${billRecord.id}`)).item, billRecord); assert.deepEqual(await request('GET','reports/fees?month=2026-01'),oldFee); assert.deepEqual(await request('GET','reports/payroll?month=2026-01'),oldPayroll);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.ok(consoleErrors.every(message => /503|403/.test(message)), JSON.stringify(consoleErrors));
  mark('單一合成多頁PDF文字驗40筆各一次、每頁表頭、A4橫向安全邊界、無背景UI/空白頁；所有讀取完整DB與billing不變，僅明確3次個案修改、1次改派及2次memory權限fixture寫入');
  await rm(path.join(output, 'failure.png'), { force: true }); await rm(path.join(output, 'pdf-diagnostic-text.txt'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic data / real Chromium / authorized fresh print DOM capture / JS-disabled QA PDF snapshot', checks, screenshots, pdf: 'synthetic-case-report.pdf', pdfPages: (await readdir(output)).filter(name => /^pdf-page-\d+\.png$/.test(name)), pageErrors, consoleErrors, failedResponses, downloads, initialCounts, finalCounts: counts(), readSegments, intentionalMutations, mastersAndOriginalBillingSnapshotUnchanged: true, visualReviewPending: true }, null, 2));
  console.log(`Case report E2E passed: ${checks.length} checks, ${screenshots.length} screenshots`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, screenshots, pageErrors, consoleErrors, failedResponses, intentionalMutations, error: error.stack }, null, 2)); throw error;
} finally { for (const context of contexts) await context.close(); await browser?.close(); await app.close(); }
