import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

// Synthetic data, actual browser/API and a random port. Never opens the disk database.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/employee-history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-employee-history-password';
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: [403, 404, 409, 422, 503].includes(response.status()) });
  });
};
const load = async (page, route, heading) => {
  lastPage = page;
  if (page.url() === `${base}/#${route}`) await page.reload(); else await page.goto(`${base}/#${route}`);
  await page.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.error-state').count(), 0, `route ${route}`);
};
const inspectLayout = async page => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No full-page horizontal overflow');
  const unlabelled = await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name));
  assert.deepEqual(unlabelled, [], 'Visible controls have semantic labels');
  if (await page.getByRole('dialog').count()) {
    const geometry = await page.getByRole('dialog').evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, 'Dialog is inside the viewport');
    assert.ok(geometry.scroll <= geometry.client + 1, 'Only nested table regions may scroll horizontally');
    for (const region of await page.getByRole('dialog').locator('.table-scroll').all()) {
      if (!await region.isVisible()) continue;
      const data = await region.evaluate(node => ({ overflow: getComputedStyle(node).overflowX, width: node.clientWidth, scroll: node.scrollWidth }));
      assert.equal(data.overflow, 'auto');
      if (data.scroll > data.width) {
        await region.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        assert.ok(await region.evaluate(node => node.scrollLeft > 0), 'Wide comparison table scrolls within its container');
        await region.evaluate(node => { node.scrollLeft = 0; });
      }
    }
  }
};
const screenshot = async (page, name) => {
  assert.ok(await page.locator('.toast:visible').count() <= 2);
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
};
const rowNamed = (page, name) => page.getByRole('row').filter({ hasText: name });
const versionCard = (dialog, version) => dialog.locator('.history-version').filter({ has: dialog.page().getByText(`第 ${version} 版`, { exact: true }) });
const openHistory = async (page, trigger, title, version = 2) => {
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByText(`第 ${version} 版`, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|刪除|還原/ }).count(), 0, 'History is read-only');
  return dialog;
};
const closeHistory = async (page, trigger) => {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  if (trigger) assert.ok(await trigger.evaluate(node => node === document.activeElement), 'Escape restores trigger focus');
};
const saveDialog = async page => {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
};
const counts = () => ({
  changes: app.db.prepare('SELECT total_changes() AS n').get().n,
  audit: app.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,
  records: app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n,
  versions: app.db.prepare('SELECT COUNT(*) AS n FROM record_versions').get().n,
  idempotency: app.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n,
});
await mkdir(output, { recursive: true });

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const rawState = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));

const readSegments = [], fixtureNotes = [], invalidationChecks = [], writeSegments = [];
const entity = 'employees', title = '員工版本歷程';
const price = cents => `新臺幣 ${BigInt(cents) / 100n}.${String(BigInt(cents) % 100n).padStart(2, '0')} 元（保存 ${cents} 分）`;
const readOnly = async (label, work) => { const before = counts(), raw = rawState(); assert.equal(Object.keys(raw).length, 11); await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); readSegments.push({ label, all11TablesUnchanged: true, before, after: counts() }); };
const written = async (label, work) => { const before = counts(); const result = await work(); writeSegments.push({ label, before, after: counts() }); return result; };
const delayRoute = async (page, pattern) => { const arrived = deferred(), release = deferred(), handled = deferred(); await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (e) { if (!/closed|cancel|abort|disposed|already handled/i.test(e.message)) throw e; } finally { handled.resolve(); } }); return { arrived, release, handled }; };
const findItem = async (page, item) => { await load(page, '/employees', '員工管理'); const search = page.getByLabel('搜尋資料', { exact: true }); await search.fill(item.employeeNo); await search.press('Enter'); await rowNamed(page, item.employeeNo).waitFor(); return rowNamed(page, item.employeeNo).getByRole('button', { name: '版本歷程', exact: true }); };
const fill = async (page, data) => { const d = page.getByRole('dialog'); for (const [key, label] of [['name','姓名'],['employeeNo','員工編號'],['role','職務'],['phone','聯絡電話'],['email','電子郵件'],['qualification','資格與證照'],['regions','服務區域'],['hourlyRate','試算時薪（新臺幣元）'],['note','備註']]) if (key in data) await d.getByLabel(label, { exact: false }).fill(String(data[key])); if (data.status) await d.getByLabel('狀態', { exact: false }).selectOption(data.status); };
const discard = async page => { await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click(); const confirm=page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true}); if(await confirm.count()) await confirm.getByRole('button',{name:'放棄修改',exact:true}).click(); await page.getByRole('dialog').waitFor({state:'detached'}); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const bootstrapBefore=counts();
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成員工管理員', email: 'employee-admin@example.test', password, organizationName: '合成員工甲機構' } }); assert.equal(setup.status(), 201);
  const admin = await setup.json(), orgId = admin.organizations[0].id;
  writeSegments.push({label:'正常API初始管理者與機構setup',before:bootstrapBefore,after:counts()});
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => { const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken }, ...(data === undefined ? {} : { data }) }); const body = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(body)}`); return body; };
  const post = async (kind, data) => (await request('POST', kind, data, 201)).item;
  const patch = async (kind, item, data) => (await request('PATCH', `${kind}/${item.id}`, { version: item.version, ...data })).item;
  const get = async (kind, item) => (await request('GET', `${kind}/${item.id}`)).item;
  const history = (item, actor = { client: context, auth: admin }, compare = true, extra = '') => request('GET', `${entity}/${item.id}/history${compare ? '?compare=previous' : '?'}${extra}`, undefined, 200, actor.client, actor.auth);
  const dataFor = (employeeNo, name, extra = {}) => ({ employeeNo, name, role:'合成照服職務', phone:'0200000000', email:'synthetic@example.test', qualification:'合成資格摘要，不代表資格核定', regions:'臺北', hourlyRateCents:12345, status:'active', note:'合成原員工備註', ...extra });
  const adminPage=await context.newPage(); observe(adminPage);
  let main=await written('管理者真UI新增v1／123.45元精確保存12345分',async()=>{await load(adminPage,'/employees','員工管理');await adminPage.getByRole('button',{name:'新增員工',exact:true}).click();await fill(adminPage,{employeeNo:'EMP-ORIGINAL',name:'合成原始員工',role:'合成照服職務',phone:'0200000000',email:'synthetic@example.test',qualification:'合成資格摘要，不代表資格核定',regions:'臺北',hourlyRate:'123.45',note:'合成原員工備註'});await saveDialog(adminPage);return(await request('GET',`${entity}?q=EMP-ORIGINAL`)).items[0];});assert.equal(main.hourlyRateCents,12345);
  const fixturesBefore=counts();
  const employeeB=await post(entity,dataFor('EMP-B','合成另一名員工'));
  const users={};for(const [role,name,employee] of [['supervisor','supervisor'],['finance','finance'],['caregiver','caregiver',main]])users[name]=await post('users',{name:`合成員工${name}`,email:`employee-${name}@example.test`,password,role,...(employee?{employeeId:employee.id}:{})});
  const login=async name=>{const client=await browser.newContext({viewport:{width:1440,height:1050}});contexts.push(client);const r=await client.request.post(`${base}/api/login`,{headers:{Origin:base},data:{email:`employee-${name}@example.test`,password}});assert.equal(r.status(),200);const auth=await r.json(),page=await client.newPage();observe(page);return{client,auth,page};};
  const supervisor=await login('supervisor'),finance=await login('finance'),caregiver=await login('caregiver');
  const service=await post('service-items',{code:'EMP-SERVICE',name:'合成快照服務',minutes:60,unitPriceCents:12345});
  const careCase=await post('cases',{name:'合成員工快照個案',caseNo:'EMP-CASE'});
  const plan=await post('care-plans',{caseId:careCase.id,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',services:[{serviceItemId:service.id,quantity:10}]});
  const shift=await post('shifts',{caseId:careCase.id,employeeId:main.id,carePlanId:plan.id,date:'2026-10-20',startTime:'09:00',endTime:'10:00',services:[{serviceItemId:service.id,quantity:2}]});
  let record=await post('service-records',{shiftId:shift.id,caseId:careCase.id,employeeId:main.id,date:shift.date,actualStart:'09:05',actualEnd:'09:50',services:[{serviceItemId:service.id,quantity:2}],status:'submitted'});
  record=(await request('POST',`service-records/${record.id}/review`,{version:record.version,decision:'approved',reviewNote:'合成員工核閱基準'})).item;
  const approvedRecord=structuredClone(record),fees=await request('GET','reports/fees?month=2026-10'),payroll=await request('GET','reports/payroll?month=2026-10');
  const caseAttachment=await post('case-attachments/upload',{caseId:careCase.id,title:'合成既有個案檔案',category:'general',...filePayload(PDF_BYTES)});
  const cert=await post('employee-certifications',{employeeId:main.id,name:'合成既有證照',issuedOn:'2026-01-01'});
  const certAttachment=await post('certification-attachments/upload',{certificationId:cert.id,title:'合成既有證照檔案',...filePayload(PNG_BYTES,'合成.png','image/png')});
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM attachment_files').get().n,1);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM certification_attachment_files').get().n,1);
  writeSegments.push({label:'正常API四角色帳號／服務個案計畫排班真核閱及双BLOBfixture',before:fixturesBefore,after:counts()});
  main=await written('督導真UI編輯v2／姓名編號職務聯絡資格區域與時薪',async()=>{await findItem(supervisor.page,main);await rowNamed(supervisor.page,main.employeeNo).getByRole('button',{name:'編輯',exact:true}).click();await fill(supervisor.page,{employeeNo:'EMP-MAIN',name:'合成員工已更新',role:'合成督導支援職務',phone:'0300000000',email:'updated@example.test',qualification:'合成更新資格摘要，不推定合格',regions:'臺北、新北',hourlyRate:'234.56',note:'合成督導更新員工備註'});await saveDialog(supervisor.page);return get(entity,main);});assert.equal(main.version,2);assert.equal(main.hourlyRateCents,23456);assert.equal((await caregiver.client.request.get(`${base}/api/session`)).status(),200);
  await findItem(adminPage,main);await rowNamed(adminPage,main.employeeNo).getByRole('button',{name:'停用',exact:true}).click();await readOnly('cancel-status-confirmation-zero-writes',async()=>{await adminPage.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await adminPage.getByRole('dialog').waitFor({state:'detached'});});
  main=await written('管理者真UI停用v3',async()=>{await findItem(adminPage,main);await rowNamed(adminPage,main.employeeNo).getByRole('button',{name:'停用',exact:true}).click();await adminPage.getByRole('dialog').getByRole('button',{name:'確認停用',exact:true}).click();await adminPage.getByRole('dialog').waitFor({state:'detached'});return get(entity,main);});assert.equal(main.status,'inactive');
  await readOnly('inactive-linked-caregiver-real-auth-403',async()=>{for(const suffix of['','/history','/history?compare=previous'])await request('GET',`${entity}/${main.id}${suffix}`,undefined,403,caregiver.client,caregiver.auth);for(const actor of[{client:context,auth:admin},supervisor,finance])assert.equal((await request('GET',`${entity}/${main.id}/history?compare=previous`,undefined,200,actor.client,actor.auth)).total,3);const trigger=await findItem(adminPage,main);const d=await openHistory(adminPage,trigger,title,3);await versionCard(d,3).getByRole('region',{name:'第 3 版變更前後',exact:true}).getByText('停用',{exact:true}).waitFor();await screenshot(adminPage,'employee-inactive-history.png');await closeHistory(adminPage,trigger);});
  main=await written('督導真UI恢復啟用v4',async()=>{await findItem(supervisor.page,main);await rowNamed(supervisor.page,main.employeeNo).getByRole('button',{name:'啟用',exact:true}).click();await supervisor.page.getByRole('dialog').getByRole('button',{name:'確認啟用',exact:true}).click();await supervisor.page.getByRole('dialog').waitFor({state:'detached'});return get(entity,main);});assert.equal(main.status,'active');assert.equal(main.version,4);
  await readOnly('restored-own-history-and-financial-snapshot',async()=>{const h=await history(main,caregiver);assert.equal(h.total,4);assert.equal(h.items.find(x=>x.version===3).snapshot.status,'inactive');assert.deepEqual(h.items.map(x=>x.actor.id),[users.supervisor.id,admin.user.id,users.supervisor.id,admin.user.id]);assert.deepEqual(await get('service-records',record),approvedRecord);assert.deepEqual(await request('GET','reports/fees?month=2026-10'),fees);assert.deepEqual(await request('GET','reports/payroll?month=2026-10'),payroll);});
  mark('管理者新增→督導編輯→真停用/恢復及精確actor；取消零寫、active link真403及恢復後可看inactive保存版，職務不改登入role');
  await findItem(adminPage,main);await rowNamed(adminPage,main.employeeNo).getByRole('button',{name:'編輯',exact:true}).click();await fill(adminPage,{hourlyRate:'345.67',note:'合成尚未儲存員工備註'});
  main=await written('真API競爭更新員工v5',()=>patch(entity,main,{note:'合成伺服器競爭員工備註'}));
  await readOnly('real-cas-retains-employee-input',async()=>{const d=adminPage.getByRole('dialog');await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('資料已更新，請重新讀取',{exact:true}).waitFor();assert.equal(await d.getByLabel('試算時薪（新臺幣元）',{exact:false}).inputValue(),'345.67');assert.equal(await d.getByLabel('備註',{exact:true}).inputValue(),'合成尚未儲存員工備註');await screenshot(adminPage,'employee-cas-preserved.png');await discard(adminPage);});
  await findItem(adminPage,main);await rowNamed(adminPage,main.employeeNo).getByRole('button',{name:'編輯',exact:true}).click();
  await readOnly('duplicate-number-and-invalid-input-no-write',async()=>{const d=adminPage.getByRole('dialog');await fill(adminPage,{employeeNo:employeeB.employeeNo,note:'合成重複編號輸入保留'});await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('同機構編號已存在',{exact:true}).waitFor();assert.equal(await d.getByLabel('員工編號',{exact:false}).inputValue(),employeeB.employeeNo);await screenshot(adminPage,'employee-duplicate-preserved.png');await discard(adminPage);for(const payload of[{hourlyRateCents:-1},{hourlyRateCents:1.1},{hourlyRateCents:'12345'},{hourlyRateCents:1e9+1},{regions:{secret:'DO_NOT_STORE'}},{regions:['臺北',3]}])await request('PATCH',`${entity}/${main.id}`,{version:main.version,...payload},422);});
  mark('真CAS409保留時薪備註、同機構員編重複保留；非法分值及regions API422無版本/audit寫入');
  const normalFixturesBefore=counts();
  let pageItem=await post(entity,dataFor('EMP-HISTORY-28','合成28版員工',{note:'合成第1版'}));for(let v=2;v<=28;v++)pageItem=await patch(entity,pageItem,{note:`合成第${v}版`});
  let oneCent=await post(entity,dataFor('EMP-CENTS','合成零一分時薪',{hourlyRateCents:0}));oneCent=await patch(entity,oneCent,{hourlyRateCents:1});
  let regionItem=await post(entity,dataFor('EMP-REGIONS','合成區域型別',{regions:'臺北'}));
  for(const regions of[['臺北'],['臺北','新北','臺北',''],['新北','臺北','臺北',''],['臺北','臺北','新北',''],[],[''],'臺北、新北',['臺北','新北']])regionItem=await patch(entity,regionItem,{regions});
  assert.equal(regionItem.version,9);const regionHistory=await history(regionItem);assert.deepEqual(regionHistory.items.find(r=>r.version===3).snapshot.regions,['臺北','新北','臺北','']);assert.deepEqual(regionHistory.items.find(r=>r.version===4).comparison.previousSnapshot.regions,['臺北','新北','臺北','']);
  let literalRegion=await post(entity,dataFor('EMP-REGION-LITERAL','合成空項與字面文字',{regions:['']}));literalRegion=await patch(entity,literalRegion,{regions:['空字串']});
  const literalSaved=await history(literalRegion);assert.deepEqual(literalSaved.items[0].snapshot.regions,['空字串']);assert.deepEqual(literalSaved.items[0].comparison.previousSnapshot.regions,['']);
  const inactiveFixture=await post(entity,dataFor('EMP-INACTIVE','合成停用篩選員工',{status:'inactive'}));
  writeSegments.push({label:'正常API28版／零一分／typedregions9版／停用員工fixtures',before:normalFixturesBefore,after:counts()});
  const importFixturesBefore=counts();
  const otherOrg=(await request('POST','organizations',{name:'合成員工乙機構'},201)).item;
  const foreign=(await request('POST',entity,dataFor('EMP-FOREIGN','合成跨機構員工'),201,context,admin,otherOrg.id)).item;
  const time=now();
  const imported=(employeeNo,name,snapshots,currentOverride={})=>{const data=dataFor(employeeNo,name,currentOverride);const item={...data,id:id(),orgId,version:Math.max(1,...snapshots.map(r=>r.version)),createdAt:time,updatedAt:time};app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id,orgId,entity,JSON.stringify(data),item.version,time,time);for(const entry of snapshots){const snapshot={...item,...entry};for(const key of entry.omit||[])delete snapshot[key];delete snapshot.omit;app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId,entity,item.id,entry.version,JSON.stringify(snapshot),time,'baseline');}return item;};
  let markerRegion=imported('EMP-REGION-MARKER','合成合法提示文字',[{version:1,regions:{credential:'NEVER_RENDER_REGION_SECRET'}}],{regions:{credential:'NEVER_RENDER_REGION_SECRET'}});markerRegion=await patch(entity,markerRegion,{regions:'[欄位格式無法判讀]'});
  const markerSaved=await history(markerRegion);assert.equal(markerSaved.items[0].snapshot.regions,'[欄位格式無法判讀]');assert.deepEqual(markerSaved.items[0].comparison.previousSnapshot.regions,{credential:'NEVER_RENDER_REGION_SECRET'});
  const baseline=imported('EMP-BASELINE','合成未知操作者',[{version:1}]);
  const gap=imported('EMP-GAP','合成精確缺前版',[{version:1},{version:3,note:'合成第3版缺第2版'}]);
  const empty=imported('EMP-EMPTY','合成空歷程',[]);
  const nullable=imported('EMP-NULL','合成缺失與零空區域',[{version:1,omit:['hourlyRateCents','regions']},{version:2,hourlyRateCents:null,regions:null},{version:3,hourlyRateCents:'',regions:''},{version:4,hourlyRateCents:0,regions:[]},{version:5,hourlyRateCents:0,regions:['']}],{hourlyRateCents:0,regions:['']});
  const invalid=imported('EMP-INVALID','合成異常保存值',[{version:1,hourlyRateCents:-1},{version:2,hourlyRateCents:1.5},{version:3,hourlyRateCents:'12345'},{version:4,hourlyRateCents:{credential:'NEVER_RENDER_SECRET'},regions:{credential:'NEVER_RENDER_SECRET'}},{version:5,hourlyRateCents:Number.MAX_SAFE_INTEGER+1,regions:['臺北',{credential:'NEVER_RENDER_SECRET'}]},{version:6,hourlyRateCents:Number.MAX_SAFE_INTEGER},{version:7,hourlyRateCents:12345}]);
  const projection=imported('EMP-PROJECT','合成公共投影員工',[{version:1,hourlyRateCents:1,status:'inactive',fileId:'INTERNAL_FILE_ID',billingSnapshot:{secret:'SYNTHETIC_BILLING_DATA'}},{version:2,hourlyRateCents:0,status:'active',fileId:'INTERNAL_FILE_ID',billingSnapshot:{secret:'SYNTHETIC_BILLING_DATA'}}],{hourlyRateCents:0});
  await post('users',{name:'合成投影居服帳號',email:'employee-projection@example.test',password,role:'caregiver',employeeId:projection.id});const projectionCaregiver=await login('projection');
  for(let i=1;i<=28;i++)await post(entity,dataFor(`EMP-LIST-${String(i).padStart(2,'0')}`,`合成員工清單分頁${String(i).padStart(2,'0')}`));
  writeSegments.push({label:'跨機構API／明示INSERT-only歷史fixture／第二caregiver正常登入／28清單資料',before:importFixturesBefore,after:counts()});
  fixtureNotes.push('Only disposable memory SQLite/random localhost port/real Chromium; no actual 4310/data/original platform, product writes or production actions.','Normal lifecycle and status changes, 28 versions, region string/array conversions, 28 list rows, approvals and both nonempty BLOB uploads use validated APIs/UI. Explicit imported baseline/gap/empty/nullable/invalid/public projection fixtures use INSERT only; no immutable version/BLOB UPDATE or DELETE.','Imported MAX_SAFE_INTEGER and invalid historical money demonstrate display behavior only; normal API retains nonnegative integer cap 1e9. Explicit employee.role changes are saved job text, not user or membership privilege changes.','The existing synthetic PDF attachment bytes are not a new QA PDF artifact. PDF operations/markers 0. Both BLOB tables contain actual synthetic bytes and are included in strict all-table comparisons.');
  const beforeReads=counts(),beforeState=rawState();assert.equal(Object.keys(beforeState).length,11);assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n,6);
  await readOnly('desktop-mobile-10-saved-fields-and-diffs',async()=>{
    const trigger=await findItem(adminPage,main);await trigger.focus();await adminPage.keyboard.press('Enter');const d=adminPage.getByRole('dialog',{name:title,exact:true});await d.getByText('第 5 版',{exact:true}).waitFor();
    const statusCard=versionCard(d,4);await statusCard.locator(':scope > summary').click();await statusCard.getByText(users.supervisor.name,{exact:true}).waitFor();await statusCard.getByRole('region',{name:'第 4 版變更前後',exact:true}).getByText('啟用',{exact:true}).waitFor();await statusCard.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(adminPage,'employee-status-actor-desktop.png');
    const card=versionCard(d,2);await card.locator(':scope > summary').click();const diff=card.getByRole('region',{name:'第 2 版變更前後',exact:true});await diff.getByText(price(12345),{exact:true}).waitFor();await diff.getByText(price(23456),{exact:true}).waitFor();await diff.getByText('合成原始員工',{exact:true}).waitFor();await diff.getByText('合成員工已更新',{exact:true}).waitFor();await card.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(adminPage,'employee-diff-desktop.png');
    await adminPage.setViewportSize({width:390,height:844});await inspectLayout(adminPage);await diff.getByText(price(12345),{exact:true}).evaluate(n=>n.scrollIntoView({block:'center',inline:'nearest'}));await diff.evaluate(n=>{n.scrollLeft=n.querySelector('th:nth-child(2)').offsetLeft;});await screenshot(adminPage,'employee-diff-mobile-before.png');await diff.evaluate(n=>{n.scrollLeft=n.scrollWidth;});await screenshot(adminPage,'employee-diff-mobile-after.png');
    await card.getByText('完整保存欄位',{exact:true}).click();const saved=card.locator('.history-snapshot');assert.deepEqual(await saved.locator('dt').allTextContents(),['姓名','員工編號','職務','聯絡電話','電子郵件','員工狀態','資格與證照','服務區域','備註','試算時薪（新臺幣元）']);await saved.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(adminPage,'employee-snapshot-mobile-top.png');await saved.getByText(price(23456),{exact:true}).evaluate(n=>n.scrollIntoView({block:'center'}));await screenshot(adminPage,'employee-snapshot-mobile-bottom.png');assert.ok(!/billingSnapshot|INTERNAL_FILE|NEVER_RENDER|登入角色/.test(await saved.textContent()));assert.equal(await d.getByRole('button',{name:/儲存|編輯|刪除|還原/}).count(),0);await closeHistory(adminPage,trigger);await adminPage.setViewportSize({width:1440,height:1050});
  });mark('十欄白名單／真actor／精確時薪差異；1440與390手機內捲、上下完整欄位及Escape焦點');
  await readOnly('28-version-pagination-precise-page-boundary',async()=>{const trigger=await findItem(supervisor.page,pageItem),d=await openHistory(supervisor.page,trigger,title,28);assert.equal(await d.locator('.history-version').count(),25);const card=versionCard(d,4);await card.locator(':scope > summary').click();await card.getByText('與第 3 版比較',{exact:true}).waitFor();await card.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(supervisor.page,'employee-page-boundary.png');await d.getByRole('button',{name:'下一頁',exact:true}).click();await d.getByText('第 3 版',{exact:true}).waitFor();assert.equal(await d.locator('.history-version').count(),3);await versionCard(d,3).getByText('與第 2 版比較',{exact:true}).waitFor();await screenshot(supervisor.page,'employee-page-two.png');await closeHistory(supervisor.page,trigger);assert.equal((await history(pageItem,undefined,true,'&page=1&pageSize=25')).items.at(-1).comparison.previousVersion,3);});mark('正常API28版25+3分頁；頁尾第4版仍取第3版，第二頁精確前版不跳版');
  await readOnly('four-role-real-sessions-current-raw-compare',async()=>{
    for(const actor of[{client:context,auth:admin},supervisor,finance,caregiver]){const current=await request('GET',`${entity}/${main.id}`,undefined,200,actor.client,actor.auth);assert.equal(current.item.hourlyRateCents,23456);assert.equal((await history(main,actor)).total,5);const raw=await history(main,actor,false);assert.ok(raw.items.every(r=>!('actor'in r)&&!('comparison'in r)));assert.ok(raw.items.every(r=>Number.isSafeInteger(r.snapshot.hourlyRateCents)));for(const suffix of['','/history','/history?compare=previous'])await request('GET',`${entity}/${foreign.id}${suffix}`,undefined,404,actor.client,actor.auth);}
    for(const suffix of['','/history','/history?compare=previous'])await request('GET',`${entity}/${employeeB.id}${suffix}`,undefined,404,caregiver.client,caregiver.auth);
    for(const actor of[{client:context,auth:admin},supervisor,finance,projectionCaregiver]){const h=await history(projection,actor);for(const row of h.items)for(const saved of[row.snapshot,row.comparison.previousSnapshot].filter(Boolean)){assert.ok(!('fileId'in saved));assert.equal('billingSnapshot'in saved,[admin.user.id,finance.auth.user.id].includes(actor.auth.user.id));}assert.equal(h.items.find(x=>x.version===1).snapshot.status,'inactive');}
    for(const actor of[finance,caregiver]){await request('PATCH',`${entity}/${main.id}`,{version:main.version,note:'合成拒絕修改'},403,actor.client,actor.auth);await request('POST',entity,dataFor('EMP-DENIED','合成拒絕新增'),403,actor.client,actor.auth);}
    await load(finance.page,'/employees','員工管理');assert.equal(await finance.page.getByRole('button',{name:'版本歷程',exact:true}).count(),0);assert.equal(await finance.page.getByRole('button',{name:/新增員工|編輯|停用|啟用/}).count(),0);await screenshot(finance.page,'employee-finance-readonly.png');await caregiver.page.goto(`${base}/#/employees`);await caregiver.page.waitForLoadState('networkidle');assert.equal(await caregiver.page.getByRole('heading',{name:'員工管理',exact:true}).count(),0);assert.equal(await caregiver.page.getByRole('link',{name:'員工管理',exact:true}).count(),0);for(const suffix of['?compare=wrong','?compare=previous&compare=previous'])await request('GET',`${entity}/${main.id}/history${suffix}`,undefined,422);
  });mark('四角色真session current/raw/compare、own/跨機構scope；財務無新UI入口、caregiver無導覽、時薪不遮罩及公用投影保持');
  await readOnly('legal-region-types-order-duplicates-empty-items',async()=>{
    const trigger=await findItem(adminPage,regionItem),d=await openHistory(adminPage,trigger,title,9);
    const openCard=async v=>{const c=versionCard(d,v);if(!await c.getAttribute('open')){if(!await c.evaluate(n=>n.open))await c.locator(':scope > summary').click();}return c;};
    let card=await openCard(9),diff=card.getByRole('region',{name:'第 9 版變更前後',exact:true});await diff.getByText('保存文字：',{exact:true}).waitFor();await diff.getByText('保存清單（2 項）',{exact:true}).waitFor();await diff.getByText('臺北、新北',{exact:true}).waitFor();assert.deepEqual(await diff.locator('li').allTextContents(),['「臺北」','「新北」']);await card.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(adminPage,'employee-regions-string-array.png');
    card=await openCard(4);diff=card.getByRole('region',{name:'第 4 版變更前後',exact:true});assert.deepEqual(await diff.locator('ol').nth(0).locator('li').allTextContents(),['「臺北」','「新北」','「臺北」','空字串']);assert.deepEqual(await diff.locator('ol').nth(1).locator('li').allTextContents(),['「新北」','「臺北」','「臺北」','空字串']);await card.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(adminPage,'employee-regions-order-duplicates.png');
    card=await openCard(7);diff=card.getByRole('region',{name:'第 7 版變更前後',exact:true});await diff.getByText('空清單（0 項）',{exact:true}).waitFor();await diff.getByText('保存清單（1 項）',{exact:true}).waitFor();await diff.getByText('空字串',{exact:true}).waitFor();await card.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(adminPage,'employee-regions-empty-list-item.png');
    card=await openCard(2);diff=card.getByRole('region',{name:'第 2 版變更前後',exact:true});await diff.getByText('保存文字：',{exact:true}).waitFor();await diff.getByText('保存清單（1 項）',{exact:true}).waitFor();assert.equal(await diff.getByText('臺北',{exact:true}).count(),1);assert.equal(await diff.getByText('「臺北」',{exact:true}).count(),1);
    await adminPage.setViewportSize({width:390,height:844});await inspectLayout(adminPage);card=versionCard(d,4);await card.getByText('完整保存欄位',{exact:true}).click();const saved=card.locator('.history-snapshot');await saved.getByText('保存清單（4 項）',{exact:true}).evaluate(n=>n.scrollIntoView({block:'center'}));await screenshot(adminPage,'employee-regions-mobile.png');await closeHistory(adminPage,trigger);await adminPage.setViewportSize({width:1440,height:1050});
    const literalTrigger=await findItem(adminPage,literalRegion),literalDialog=await openHistory(adminPage,literalTrigger,title,2),literalCard=versionCard(literalDialog,2),literalDiff=literalCard.getByRole('region',{name:'第 2 版變更前後',exact:true});assert.deepEqual(await literalDiff.locator('ol').nth(0).locator('li').allTextContents(),['空字串']);assert.deepEqual(await literalDiff.locator('ol').nth(1).locator('li').allTextContents(),['「空字串」']);await screenshot(adminPage,'employee-regions-empty-vs-literal.png');await closeHistory(adminPage,literalTrigger);
    const markerTrigger=await findItem(adminPage,markerRegion),markerDialog=await openHistory(adminPage,markerTrigger,title,2),markerCard=versionCard(markerDialog,2),markerDiff=markerCard.getByRole('region',{name:'第 2 版變更前後',exact:true});assert.equal(await markerDiff.locator('tbody tr').count(),1);const beforeCell=markerDiff.locator('tbody tr td').nth(1),afterCell=markerDiff.locator('tbody tr td').nth(2);await beforeCell.getByText('[欄位格式無法判讀]',{exact:true}).waitFor();assert.equal(await beforeCell.getByText('保存文字：',{exact:true}).count(),0);await afterCell.getByText('保存文字：',{exact:true}).waitFor();await afterCell.getByText('[欄位格式無法判讀]',{exact:true}).waitFor();assert.ok(!(await markerDialog.textContent()).includes('NEVER_RENDER_REGION_SECRET'));await screenshot(adminPage,'employee-regions-invalid-vs-literal-marker.png');await closeHistory(adminPage,markerTrigger);
  });mark('合法regions文字/清單型別、原順序/重複/空项完整區分，[]不同[空字串]、單字串不同单项陣列，空項與字面空字串文字及異常物件與合法提示文字可辨');
  await readOnly('zero-one-null-invalid-prices-and-region-values',async()=>{
    let trigger=await findItem(adminPage,oneCent),d=await openHistory(adminPage,trigger,title,2),card=versionCard(d,2),diff=card.getByRole('region',{name:'第 2 版變更前後',exact:true});await diff.getByText(price(0),{exact:true}).waitFor();await diff.getByText(price(1),{exact:true}).waitFor();await screenshot(adminPage,'employee-zero-one-cent.png');await closeHistory(adminPage,trigger);
    trigger=await findItem(adminPage,nullable);d=await openHistory(adminPage,trigger,title,5);card=versionCard(d,4);await card.locator(':scope > summary').click();diff=card.getByRole('region',{name:'第 4 版變更前後',exact:true});await diff.getByText(price(0),{exact:true}).waitFor();await diff.getByText('空清單（0 項）',{exact:true}).waitFor();assert.equal(await diff.getByText('未提供',{exact:true}).count(),2);await card.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(adminPage,'employee-null-versus-zero.png');for(const v of[2,3]){const c=versionCard(d,v);await c.locator(':scope > summary').click();await c.getByText('此版沒有業務欄位變更。',{exact:true}).waitFor();}await closeHistory(adminPage,trigger);
    trigger=await findItem(adminPage,invalid);d=await openHistory(adminPage,trigger,title,7);for(const [version,expected]of[[6,price(Number.MAX_SAFE_INTEGER)],[5,`${Number.MAX_SAFE_INTEGER+1}（金額無法判讀）`],[4,'[欄位格式無法判讀]（金額無法判讀）'],[3,'12345（金額無法判讀）'],[2,'1.5（金額無法判讀）'],[1,'-1（金額無法判讀）']]){card=versionCard(d,version);await card.locator(':scope > summary').click();await card.getByText('完整保存欄位',{exact:true}).click();const saved=card.locator('.history-snapshot');await saved.getByText(expected,{exact:true}).waitFor();if([4,5].includes(version))await saved.getByText('[欄位格式無法判讀]',{exact:true}).waitFor();assert.ok(!/NEVER_RENDER_SECRET|NaN|Infinity/.test(await saved.textContent()));if([6,4].includes(version)){await saved.getByText(expected,{exact:true}).evaluate(n=>n.scrollIntoView({block:'end'}));await screenshot(adminPage,`employee-saved-${version===6?'max-safe':'invalid'}.png`);}}await closeHistory(adminPage,trigger);
  });mark('時薪0/1分精確、missing/null/空不轉0；regions缺值/空清單不同，異常物件混合陣列整欄fallback不洩漏，MAX_SAFE精確');
  await readOnly('unknown-actor-empty-precise-gap',async()=>{
    let trigger=await findItem(adminPage,baseline),d=await openHistory(adminPage,trigger,title,1);await d.getByText('未記錄操作者',{exact:true}).waitFor();await d.getByText('初始版本；沒有上一版本可比較。',{exact:true}).waitFor();await screenshot(adminPage,'employee-unknown-actor.png');await closeHistory(adminPage,trigger);
    trigger=await findItem(adminPage,empty);await trigger.click();d=adminPage.getByRole('dialog');await d.getByText('尚無可讀取的版本歷程。',{exact:true}).waitFor();await screenshot(adminPage,'employee-empty.png');await closeHistory(adminPage,trigger);
    trigger=await findItem(adminPage,gap);d=await openHistory(adminPage,trigger,title,3);await d.getByText('上一版本不可取得，只顯示本版保存資料。',{exact:true}).waitFor();assert.deepEqual((await history(gap)).items[0].comparison,{status:'unavailable',previousVersion:null,previousSnapshot:null});await screenshot(adminPage,'employee-gap.png');await closeHistory(adminPage,trigger);
  });mark('明示INSERT-only匯入初版未知actor、空歷程、缺精確前版不跳版；無臆測身份');
  const pattern=`**/api/${entity}/${main.id}/history*`;
  await readOnly('503-retry-and-slow-escape',async()=>{
    const trigger=await findItem(adminPage,main);let attempts=0;await adminPage.route(pattern,r=>++attempts===1?r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC_READ',message:'合成员工歷程暫時無法取得，請重試。'}})}):r.continue());await trigger.click();let d=adminPage.getByRole('dialog');await d.getByRole('button',{name:'重新讀取',exact:true}).waitFor();await screenshot(adminPage,'employee-history-retry.png');await d.getByRole('button',{name:'重新讀取',exact:true}).click();await d.getByText('第 5 版',{exact:true}).waitFor();assert.equal(attempts,2);await closeHistory(adminPage,trigger);await adminPage.unroute(pattern);
    const delayed=await delayRoute(adminPage,pattern),aborted=adminPage.waitForEvent('requestfailed',{predicate:r=>r.url().includes(`/${main.id}/history`),timeout:10000});await trigger.click();await delayed.arrived.promise;await screenshot(adminPage,'employee-history-loading.png');await closeHistory(adminPage,trigger);delayed.release.resolve();await delayed.handled.promise;assert.match((await aborted).failure()?.errorText||'',/abort|cancel/i);await adminPage.unroute(pattern);await settle(adminPage);assert.equal(await adminPage.getByRole('dialog').count(),0);
  });mark('503重試真GET恢復，慢讀Escape中止fetch且焦點回入口，晚回應不復活');
  await readOnly('loaded-pending-context-identity',async()=>{
    for(const pending of[false,true])for(const mode of['route','organization','role','employee','render']){
      const trigger=await findItem(adminPage,main),delayed=pending?await delayRoute(adminPage,pattern):null;if(delayed){await trigger.click();await delayed.arrived.promise;}else await openHistory(adminPage,trigger,title,5);
      if(mode==='route')await adminPage.evaluate(()=>{location.hash='/cases';});else if(mode==='organization')await adminPage.getByLabel('目前機構',{exact:true}).evaluate((n,value)=>{n.value=value;n.dispatchEvent(new Event('change',{bubbles:true}));},otherOrg.id);else if(mode==='render')await adminPage.evaluate(()=>window.dispatchEvent(new Event('session-updated')));else await adminPage.evaluate(async({mode,employeeId})=>{const{getContext,setContext}=await import('/ui.js');const ctx=structuredClone(getContext());const org=ctx.organizations.find(item=>item.id===ctx.organizationId);if(mode==='role')org.role='supervisor';else org.employeeId=employeeId;setContext(ctx,ctx.organizationId);document.body.append(document.createComment('synthetic-client-identity-fixture'));},{mode,employeeId:employeeB.id});
      await adminPage.getByRole('dialog').waitFor({state:'detached'});if(delayed){delayed.release.resolve();await delayed.handled.promise;await adminPage.unroute(pattern);}await settle(adminPage);assert.equal(await adminPage.locator('.history-version').count(),0);invalidationChecks.push({pending,mode,removed:true,noLateRevival:true});await adminPage.reload();await adminPage.waitForLoadState('networkidle');
    }
  });fixtureNotes.push('Role/employee invalidation is a client-only identity fixture plus DOM mutation, restored through a real session reload, not a server membership change. Actual API permissions use four roles plus one second caregiver linked to explicit imported projection fixture. Real employee inactive/active API state separately verifies auth403 and restored own history.');mark('loaded/pending各hash/org/role/employee/render共10失效清空abort關閉，晚回應不復活');
  await readOnly('existing-list-search-pagination-and-form-semantics',async()=>{
    await load(adminPage,'/employees','員工管理');const search=adminPage.getByLabel('搜尋資料',{exact:true});await search.fill('合成員工清單分頁');await search.press('Enter');await rowNamed(adminPage,'EMP-LIST-28').waitFor();assert.equal(await adminPage.locator('tbody tr').count(),25);await adminPage.getByRole('button',{name:'下一頁',exact:true}).click();await rowNamed(adminPage,'EMP-LIST-01').waitFor();assert.equal(await adminPage.locator('tbody tr').count(),3);await screenshot(adminPage,'employee-list-page-two.png');await search.fill('不存在的合成员工');await search.press('Enter');await adminPage.getByText('沒有符合條件的資料，請調整查詢。',{exact:true}).waitFor();await search.fill('');await search.press('Enter');await adminPage.getByLabel('狀態',{exact:true}).selectOption('inactive');await rowNamed(adminPage,inactiveFixture.employeeNo).waitFor();assert.equal(await adminPage.locator('tbody tr').count(),1);await screenshot(adminPage,'employee-list-inactive-filter.png');await findItem(adminPage,regionItem);await rowNamed(adminPage,regionItem.employeeNo).getByRole('button',{name:'編輯',exact:true}).click();assert.equal(await adminPage.getByRole('dialog').locator('[name=regionsIntent]').inputValue(),'keep');assert.equal(await adminPage.getByRole('dialog').getByLabel('服務區域',{exact:true}).inputValue(),'');assert.ok(await adminPage.getByRole('dialog').getByLabel('服務區域',{exact:true}).isDisabled());await adminPage.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await adminPage.getByRole('dialog').waitFor({state:'detached'});assert.deepEqual((await get(entity,regionItem)).regions,['臺北','新北']);
  });mark('既有清單搜尋/28筆25+3及no-results恢復；編輯表單原清單預設保持且不合併預填，取消不改保存型別');
  const downloads=[],reportEndpoints=[];
  await readOnly('reports-billing-masters-and-nonempty-blob-bytes',async()=>{
    assert.deepEqual(await get('service-records',record),approvedRecord);assert.deepEqual(await request('GET','reports/fees?month=2026-10'),fees);assert.deepEqual(await request('GET','reports/payroll?month=2026-10'),payroll);assert.deepEqual(await get('care-plans',plan),plan);assert.deepEqual(await get('cases',careCase),careCase);assert.deepEqual(await get('service-items',service),service);
    for(const kind of['cases','shifts','services','fees','payroll'])for(const ext of['','.csv']){const route=`reports/${kind}${ext}?month=2026-10`;const r=await context.request.get(`${base}/api/${route}`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200);if(ext)assert.ok((await r.text()).startsWith('\uFEFF'));else assert.ok(Array.isArray((await r.json()).rows));reportEndpoints.push(route);}
    for(const name of['shift-report','service-report','case-report'])for(const ext of['','/export','.csv']){const route=`${name}${ext}?startDate=2026-01-01&endDate=2026-12-31`;const r=await context.request.get(`${base}/api/${route}`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200);if(ext==='.csv')assert.ok((await r.text()).startsWith('\uFEFF'));else assert.ok(Array.isArray((await r.json()).rows));reportEndpoints.push(route);}
    for(const[kind,item,bytes]of[['case-attachments',caseAttachment,PDF_BYTES],['certification-attachments',certAttachment,PNG_BYTES]]){const r=await context.request.get(`${base}/api/${kind}/${item.id}/download`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200);const actual=await r.body();assert.deepEqual(actual,bytes);assert.equal(digest(actual),item.sha256);downloads.push({entity:kind,bytes:actual.length,sha256:digest(actual),matchesOriginal:true});}
  });assert.equal(reportEndpoints.length,19);assert.deepEqual(counts(),beforeReads);assert.deepEqual(rawState(),beforeState);assert.equal(invalidationChecks.length,10);assert.deepEqual(pageErrors,[]);assert.deepEqual(failedResponses.filter(r=>!r.expected),[]);assert.ok(consoleErrors.every(s=>/403|404|409|422|503/.test(s)),JSON.stringify(consoleErrors));mark('11表含雙非空BLOB strict raw/count/total_changes零寫、下載bytes/SHA保持；核閱快照費薪與主檔不變、19報表端點相容');
  await rm(path.join(output,'failure.png'),{force:true});
  await writeFile(path.join(output,'e2e.json'),JSON.stringify({passed:true,completedAt:new Date().toISOString(),scope:'Synthetic memory SQLite/random localhost port/real Chromium; no actual 4310/data/original platform.',checks,screenshots,readSegments,writeSegments,invalidationChecks,fixtureNotes,downloads,reportEndpoints,pageErrors,consoleErrors,failedResponses,readonlyCounts:{before:beforeReads,after:counts()},all11TablesUnchangedDuringReads:true,blobTablesNonempty:{attachment_files:1,certification_attachment_files:1},approvedBillingSnapshotUnchanged:true,pdfOperations:0,pdfMarkers:0,visualReviewPending:true},null,2));console.log(`Employee history E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
}catch(error){if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:path.join(output,'failure.png'),fullPage:false}).catch(()=>{});await writeFile(path.join(output,'e2e.json'),JSON.stringify({passed:false,completedAt:new Date().toISOString(),checks,screenshots,pageErrors,consoleErrors,failedResponses,readSegments,writeSegments,invalidationChecks,fixtureNotes,error:error.stack,pdfOperations:0,pdfMarkers:0},null,2));throw error;}
finally{for(const context of contexts)await context.close();await browser?.close();await app.close();}
