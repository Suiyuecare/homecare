import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
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
const output = path.join(root, 'outputs/software/announcement-history-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [], screenshotGeometry = [];
const password = 'synthetic-announcement-history-password';
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
const entity = 'announcements', title = '內部公告版本歷程';
const readOnly = async (label, work) => { const before = counts(), raw = rawState(); assert.equal(Object.keys(raw).length, 11); await work(); assert.deepEqual(counts(), before, label); assert.deepEqual(rawState(), raw, label); readSegments.push({ label, all11TablesUnchanged: true, before, after: counts() }); };
const written = async (label, work) => { const before = counts(); const result = await work(); writeSegments.push({ label, before, after: counts() }); return result; };
const delayRoute = async (page, pattern) => { const arrived = deferred(), release = deferred(), handled = deferred(); await page.route(pattern, async route => { try { const response = await route.fetch(); arrived.resolve(); await release.promise; await route.fulfill({ response }); } catch (e) { if (!/closed|cancel|abort|disposed|already handled/i.test(e.message)) throw e; } finally { handled.resolve(); } }); return { arrived, release, handled }; };
const findItem = async (page, item) => {
  await load(page, '/announcements', '內部公告');
  const search=page.getByLabel('搜尋資料',{exact:true});
  await search.fill(item.title); await search.press('Enter');
  const row=rowNamed(page,item.title); await row.waitFor();
  return row.getByRole('button',{name:'版本歷程',exact:true});
};
const fill = async (page, data) => {
  const d=page.getByRole('dialog');
  for(const[key,label]of[['title','公告標題'],['body','公告內容']])if(key in data)await d.getByLabel(label,{exact:false}).fill(String(data[key]));
  for(const[key,label]of[['audience','閱讀對象'],['status','狀態']])if(key in data)await d.getByLabel(label,{exact:false}).selectOption(data[key]);
};
const discard = async page => { await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click(); const confirm=page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true}); if(await confirm.count()) await confirm.getByRole('button',{name:'放棄修改',exact:true}).click(); await page.getByRole('dialog').waitFor({state:'detached'}); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Frozen contract: docs/ANNOUNCEMENT_HISTORY_SCOPE.md.
const openCard = async (dialog, version) => { const c=versionCard(dialog,version); if(!await c.evaluate(n=>n.open))await c.locator(':scope > summary').click(); return c; };
const snapshot = async card => { const s=card.locator('.history-snapshot'); if(!await s.evaluate(n=>n.open))await card.getByText('完整保存欄位',{exact:true}).click(); return s; };
const assertNoSecrets = async locator => { assert.ok(!/NEVER_RENDER|INTERNAL_FILE_ID|billingSnapshot|deliveryReceipt|readReceipt/.test(await locator.textContent())); assert.equal(await locator.locator('script,img,iframe').count(),0); };
try {
  const initialCounts=counts();
  base=await app.listen(); browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1050}});contexts.push(context);
  const admin=await written('normal-admin-organization-setup',async()=>{const r=await context.request.post(`${base}/api/setup`,{headers:{Origin:base},data:{name:'合成公告管理員',email:'announcement-admin@example.test',password,organizationName:'合成公告甲機構'}});assert.equal(r.status(),201);return r.json();});
  const orgId=admin.organizations[0].id;
  const request=async(method,route,data,expected=200,actor={client:context,auth:admin},org=orgId,extraHeaders={})=>{const r=await actor.client.request.fetch(`${base}/api/${route}`,{method,headers:{Origin:base,'X-Org-Id':org,'X-CSRF-Token':actor.auth.csrfToken,...extraHeaders},...(data===undefined?{}:{data})});const body=await r.json();assert.equal(r.status(),expected,`${method} ${route}: ${JSON.stringify(body)}`);return body;};
  const post=async(kind,data,actor,org)=> (await request('POST',kind,data,201,actor,org)).item;
  const patch=async(kind,item,data,actor)=>(await request('PATCH',`${kind}/${item.id}`,{version:item.version,...data},200,actor)).item;
  const get=async(kind,item,actor)=>(await request('GET',`${kind}/${item.id}`,undefined,200,actor)).item;
  const history=(item,actor,compare=true,extra='')=>request('GET',`${entity}/${item.id}/history?${compare?'compare=previous':''}${extra}`,undefined,200,actor);
  const dataFor=(title,extra={})=>({title,body:'合成公告保存內容，不代表外部訊息已寄送。',audience:'all',status:'published',...extra});
  const page=await context.newPage();observe(page);
  let employeeA,employeeB,service,careCase,plan,record,approved,fees,payroll,caseAttachment,certAttachment,otherOrg,foreign,users={};
  await written('validated-role-users-billing-and-two-nonempty-attachment-fixtures',async()=>{
    employeeA=await post('employees',{name:'合成公告甲員工',employeeNo:'ANN-EMP-A',hourlyRateCents:23456});employeeB=await post('employees',{name:'合成公告乙員工',employeeNo:'ANN-EMP-B'});
    for(const role of['supervisor','finance','caregiver'])users[role]=await post('users',{name:`合成公告${role}`,email:`announcement-${role}@example.test`,password,role,...(role==='caregiver'?{employeeId:employeeA.id}:{})});
    service=await post('service-items',{code:'ANN-SERVICE',name:'合成公告核閱基準服務',minutes:60,unitPriceCents:12345});careCase=await post('cases',{name:'合成公告基準個案',caseNo:'ANN-CASE'});
    plan=await post('care-plans',{caseId:careCase.id,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',services:[{serviceItemId:service.id,quantity:10}]});
    const shift=await post('shifts',{caseId:careCase.id,employeeId:employeeA.id,carePlanId:plan.id,date:'2026-10-20',startTime:'09:00',endTime:'10:00',services:[{serviceItemId:service.id,quantity:2}]});
    record=await post('service-records',{shiftId:shift.id,caseId:careCase.id,employeeId:employeeA.id,date:shift.date,actualStart:'09:05',actualEnd:'09:50',services:[{serviceItemId:service.id,quantity:2}],status:'submitted'});
    record=(await request('POST',`service-records/${record.id}/review`,{version:record.version,decision:'approved',reviewNote:'合成公告核閱基準'})).item;approved=structuredClone(record);
    fees=await request('GET','reports/fees?month=2026-10');payroll=await request('GET','reports/payroll?month=2026-10');
    caseAttachment=await post('case-attachments/upload',{caseId:careCase.id,title:'合成公告既有個案檔案',category:'general',...filePayload(PDF_BYTES)});
    const cert=await post('employee-certifications',{employeeId:employeeA.id,name:'合成公告既有證照',issuedOn:'2026-01-01'});
    certAttachment=await post('certification-attachments/upload',{certificationId:cert.id,title:'合成公告既有證照檔案',...filePayload(PNG_BYTES,'合成.png','image/png')});
    otherOrg=await post('organizations',{name:'合成公告乙機構'});foreign=await post(entity,dataFor('ANN-FOREIGN 合成跨機構'),undefined,otherOrg.id);
  });
  const login=async role=>written(`real-${role}-session`,async()=>{const client=await browser.newContext({viewport:{width:1440,height:1050}});contexts.push(client);const r=await client.request.post(`${base}/api/login`,{headers:{Origin:base},data:{email:`announcement-${role}@example.test`,password}});assert.equal(r.status(),200);const auth=await r.json(),page=await client.newPage();observe(page);return{client,auth,page};});
  const supervisor=await login('supervisor'),finance=await login('finance'),caregiver=await login('caregiver');
  let main=await written('admin-real-UI-create-draft-v1',async()=>{await load(page,'/announcements','內部公告');await page.getByRole('button',{name:'新增公告',exact:true}).click();await fill(page,dataFor('ANN-MAIN 合成公告生命週期',{body:'合成草稿 PRIVATE_DRAFT_V1',status:'draft'}));await screenshot(page,'announcement-create-draft.png');await saveDialog(page);return(await request('GET',`${entity}?q=ANN-MAIN`)).items[0];});
  await readOnly('draft-current-invisible-to-caregiver',async()=>{for(const suffix of['','/history','/history?compare=previous','/history?compare=next'])await request('GET',`${entity}/${main.id}${suffix}`,undefined,404,caregiver);});
  const editUI=async(actor,item,values)=>{await findItem(actor.page,item);await rowNamed(actor.page,item.title).getByRole('button',{name:'編輯',exact:true}).click();await fill(actor.page,values);await saveDialog(actor.page);return get(entity,item);};
  main=await written('admin-real-UI-publish-all-v2',()=>editUI({page},main,{body:'合成公開公告 v2',status:'published'}));
  main=await written('supervisor-real-UI-body-audience-v3',()=>editUI(supervisor,main,{body:'PRIVATE_SUPERVISOR_V3 合成督導專用內容',audience:'supervisor'}));
  await readOnly('audience-change-current-not-readable',async()=>{for(const suffix of['','/history','/history?compare=previous'])await request('GET',`${entity}/${main.id}${suffix}`,undefined,404,caregiver);});
  await findItem(supervisor.page,main);await rowNamed(supervisor.page,main.title).getByRole('button',{name:'撤回草稿',exact:true}).click();
  await readOnly('cancel-withdraw-confirmation-zero-writes',async()=>{await supervisor.page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await supervisor.page.getByRole('dialog').waitFor({state:'detached'});});
  main=await written('supervisor-real-UI-withdraw-v4',async()=>{await rowNamed(supervisor.page,main.title).getByRole('button',{name:'撤回草稿',exact:true}).click();await supervisor.page.getByRole('dialog').getByRole('button',{name:'確認撤回草稿',exact:true}).click();await supervisor.page.getByRole('dialog').waitFor({state:'detached'});return get(entity,main);});
  main=await written('admin-real-UI-republish-caregiver-v5',()=>editUI({page},main,{body:'合成公開公告 v5；重新發布至本系統。',audience:'caregiver',status:'published'}));
  main=await written('supervisor-real-UI-public-body-v6',()=>editUI(supervisor,main,{body:'合成公開公告 v6\n保留段落，不代表已寄送或已讀。'}));
  assert.equal(main.version,6);
  await readOnly('exact-actor-and-authorized-visible-versions',async()=>{const h=await history(main);assert.deepEqual(h.items.map(x=>x.actor.id),[users.supervisor.id,admin.user.id,users.supervisor.id,users.supervisor.id,admin.user.id,admin.user.id]);const c=await history(main,caregiver);assert.deepEqual(c.items.map(x=>x.version),[6,5,2]);assert.equal(c.items[0].comparison.previousVersion,5);for(const x of c.items.slice(1))assert.deepEqual(x.comparison,{status:'unavailable',previousVersion:null,previousSnapshot:null});assert.ok(!JSON.stringify(c).includes('PRIVATE_'));});
  mark('真UI草稿→發布→督導改內容/對象→撤回/再發布與v6，取消零寫、精確操作者與居服可見版本[6,5,2]');
  let cas=await written('validated-separate-CAS-fixture',()=>post(entity,dataFor('ANN-CAS 合成競爭更新')));
  await findItem(page,cas);await rowNamed(page,cas.title).getByRole('button',{name:'編輯',exact:true}).click();await fill(page,{body:'合成 CAS 使用者尚未儲存內容'});
  cas=await written('real-concurrent-update-before-stale-form',()=>patch(entity,cas,{body:'合成伺服器另一人已保存'}));
  await readOnly('CAS409-and-validation-preserve-user-input',async()=>{let d=page.getByRole('dialog');await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('資料已更新，請重新讀取',{exact:true}).waitFor();assert.equal(await d.getByLabel('公告內容',{exact:false}).inputValue(),'合成 CAS 使用者尚未儲存內容');await screenshot(page,'announcement-CAS409-preserved.png');await discard(page);await findItem(page,cas);await rowNamed(page,cas.title).getByRole('button',{name:'編輯',exact:true}).click();await fill(page,{title:'',body:'合成必填失敗仍保留'});d=page.getByRole('dialog');await d.getByRole('button',{name:'儲存',exact:true}).click();assert.ok(await d.isVisible());assert.equal(await d.getByLabel('公告內容',{exact:false}).inputValue(),'合成必填失敗仍保留');await screenshot(page,'announcement-required-preserved.png');await discard(page);for(const data of[{body:''},{status:'invalid'},{audience:{}},{unknown:'NEVER_RENDER'},{body:'長'.repeat(10001)}])await request('PATCH',`${entity}/${cas.id}`,{version:cas.version,...data},422);const r=await context.request.patch(`${base}/api/${entity}/${cas.id}`,{headers:{Origin:base,'X-Org-Id':orgId},data:{version:cas.version,body:'合成無CSRF'}});assert.equal(r.status(),403);});
  const idemPayload=dataFor('ANN-IDEMPOTENT 合成同鍵重送'),idemHeaders={'Idempotency-Key':'announcement-history-v024-idempotent'};
  const idem=await written('normal-POST-idempotent-first-commit',()=>request('POST',entity,idemPayload,201,undefined,undefined,idemHeaders));
  await readOnly('POST-idempotent-replay-and-key-conflict-no-writes',async()=>{assert.deepEqual(await request('POST',entity,idemPayload,201,undefined,undefined,idemHeaders),idem);await request('POST',entity,{...idemPayload,body:'合成不同內容'},409,undefined,undefined,idemHeaders);});
  mark('原CRUD必填/非法API422、CSRF403、真CAS409保留輸入與POST同鍵重送零增版');
  await readOnly('four-real-role-UI-current-raw-compare-and-no-cross-org',async()=>{
    for(const actor of[{client:context,auth:admin,page},supervisor,finance,caregiver]){assert.equal((await get(entity,main,actor)).id,main.id);const raw=await history(main,actor,false),h=await history(main,actor);assert.deepEqual(raw.items.map(x=>x.version),h.items.map(x=>x.version));assert.ok(raw.items.every(x=>!('actor'in x)&&!('comparison'in x)));assert.equal(h.total,actor===caregiver?3:6);for(const suffix of['','/history','/history?compare=previous'])for(const item of[foreign,employeeA])await request('GET',`${entity}/${item.id}${suffix}`,undefined,404,actor);const trigger=await findItem(actor.page,main),d=await openHistory(actor.page,trigger,title,6);await d.getByText('操作者（目前名稱）',{exact:true}).first().waitFor();if(actor===caregiver){assert.equal(await d.locator('.history-version').count(),3);assert.ok(!/PRIVATE_|第 4 版|第 3 版|第 1 版/.test(await d.textContent()));await screenshot(actor.page,'announcement-caregiver-visible-history.png');}else if(actor===finance)await screenshot(actor.page,'announcement-finance-readonly-history.png');await closeHistory(actor.page,trigger);if([finance,caregiver].includes(actor)){assert.equal(await actor.page.getByRole('button',{name:/^(新增公告|編輯|撤回草稿)$/}).count(),0);await request('POST',entity,dataFor('ANN-DENIED 合成拒寫'),403,actor);await request('PATCH',`${entity}/${main.id}`,{version:main.version,body:'合成拒寫'},403,actor);}}
    for(const q of['compare=next','compare=previous&compare=previous'])await request('GET',`${entity}/${main.id}/history?${q}`,undefined,422);
  });mark('四真session現行/raw/compare與UI入口，財務/居服唯讀、跨機構和錯實體404，不以audience收窄其他角色');
  let scopeItem=await written('normal-visible-announcement-for-real-revocation',()=>post(entity,dataFor('ANN-SCOPE 合成目前撤權')));
  scopeItem=await written('real-current-draft-withdraw',()=>patch(entity,scopeItem,{status:'draft'}));
  await readOnly('current-withdraw-404-even-earlier-visible-version',async()=>{for(const suffix of['','/history','/history?compare=previous','/history?compare=next'])await request('GET',`${entity}/${scopeItem.id}${suffix}`,undefined,404,caregiver);await load(caregiver.page,'/announcements','內部公告');const q=caregiver.page.getByLabel('搜尋資料',{exact:true});await q.fill(scopeItem.title);await q.press('Enter');await caregiver.page.getByText('沒有符合條件的資料，請調整查詢。',{exact:true}).waitFor();await screenshot(caregiver.page,'announcement-caregiver-current-withdrawn.png');});
  scopeItem=await written('real-current-published-finance',()=>patch(entity,scopeItem,{status:'published',audience:'finance'}));
  await readOnly('current-other-audience-404',async()=>{for(const suffix of['','/history','/history?compare=previous'])await request('GET',`${entity}/${scopeItem.id}${suffix}`,undefined,404,caregiver);});
  scopeItem=await written('real-current-restored-all',()=>patch(entity,scopeItem,{audience:'all'}));
  await readOnly('restored-current-history-gap',async()=>{assert.deepEqual((await history(scopeItem,caregiver)).items.map(x=>x.version),[4,1]);assert.equal((await history(scopeItem,caregiver)).items[0].comparison.status,'unavailable');});
  employeeA=await written('normal-current-caregiver-employee-inactive',()=>patch('employees',employeeA,{status:'inactive'}));
  await readOnly('inactive-linked-real-caregiver-auth403',async()=>{for(const suffix of['','/history','/history?compare=previous'])await request('GET',`${entity}/${main.id}${suffix}`,undefined,403,caregiver);});
  employeeA=await written('normal-current-caregiver-employee-restored',()=>patch('employees',employeeA,{status:'active'}));
  await readOnly('active-link-restores-original-own-role-scope',async()=>{assert.equal((await history(main,caregiver)).total,3);});
  mark('真撤回/對象更換即404且不借舊版繞過，恢复後缺口不跳版；真active link停用403再恢復');
  let pageItem,literal,unknown,allLabel,baseline,gap,empty,hiddenOnly,ambiguous,typed,projection,textLabels;
  const longBody='  合成公告長文開始\n<script>window.__announcementInjected=true</script>\n<img src=x onerror="window.__announcementInjected=true">\n'+Array.from({length:8},(_,i)=>`第${i+1}段：合成機構內部服務與行政訊息；保留原始換行與完整文字。`).join('\n')+'\n合成公告長文結尾  ';
  await written('normal-API-28-versions-literal-text-unknown-audiences-and-28-list-rows',async()=>{
    pageItem=await post(entity,dataFor('ANN-HISTORY-28 合成二十八版',{body:'合成第1版'}));for(let v=2;v<=28;v++)pageItem=await patch(entity,pageItem,{body:`合成第${v}版`});
    literal=await post(entity,dataFor('ANN-LITERAL 合成文字安全',{body:'合成原始公告文字'}));literal=await patch(entity,literal,{body:longBody});
    unknown=await post(entity,dataFor('ANN-UNKNOWN 合成未知對象',{audience:'未知原文'}));for(const audience of['__proto__','constructor','toString'])unknown=await patch(entity,unknown,{audience});
    allLabel=await post(entity,dataFor('ANN-AUDIENCE 合成代碼與字面區別'));allLabel=await patch(entity,allLabel,{audience:'全體同仁'});
    for(let i=1;i<=28;i++)await post(entity,dataFor(`ANN-LIST-${String(i).padStart(2,'0')} 合成清單分頁`,{status:i===28?'draft':'published'}));
  });
  await written('explicit-INSERT-only-baseline-gap-empty-typed-projection-and-actor-ambiguity',async()=>{
    const time=now();
    const imported=(name,snapshots,current={})=>{const data=dataFor(name,current),item={...data,id:id(),orgId,version:Math.max(1,...snapshots.map(x=>x.version)),createdAt:time,updatedAt:time};app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id,orgId,entity,JSON.stringify(data),item.version,time,time);for(const entry of snapshots){const saved={...item,...entry};for(const key of entry.omit||[])delete saved[key];delete saved.omit;app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId,entity,item.id,entry.version,JSON.stringify(saved),time,'synthetic-import');}return item;};
    baseline=imported('ANN-BASELINE 合成無稽核初版',[{version:1}]);gap=imported('ANN-GAP 合成缺失前版',[{version:1},{version:3,body:'合成第3版但第2版不存在'}]);empty=imported('ANN-EMPTY 合成空歷程',[]);
    hiddenOnly=imported('ANN-HIDDEN-ONLY 合成只留隱藏歷史',[{version:1,status:'draft',body:'NEVER_RENDER_HIDDEN_DRAFT'},{version:2,status:'published',audience:'finance',body:'NEVER_RENDER_HIDDEN_FINANCE'}]);
    ambiguous=imported('ANN-AMBIGUOUS 合成歧義操作者',[{version:1},{version:2,body:'合成不同身份同版稽核'}]);
    for(const userId of[admin.user.id,users.supervisor.id])app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(),orgId,userId,'record.update',entity,ambiguous.id,JSON.stringify({version:2}),time);
    typed=imported('ANN-TYPED 合成非文字匯入',[{version:1,omit:['body','audience']},{version:2,body:null,audience:null},{version:3,body:'',audience:''},{version:4,body:0,audience:false},{version:5,body:{NEVER_RENDER:'SECRET_OBJECT'},audience:['NEVER_RENDER_ARRAY'],status:'constructor'},{version:6,body:'[欄位格式無法判讀]',audience:'__proto__',status:'published'}],{body:'[欄位格式無法判讀]',audience:'__proto__'});
    textLabels=imported('ANN-TEXT-LABELS 合成合法提示原文',[{version:1,omit:['body']},{version:2,body:'未提供'},{version:3,body:{NEVER_RENDER:'SECRET_LITERAL_COLLISION'}},{version:4,body:'非文字保存值；內容未展示。'}],{body:'非文字保存值；內容未展示。'});
    projection=imported('ANN-PROJECTION 合成未知metadata',[{version:1,fileId:'INTERNAL_FILE_ID',billingSnapshot:{secret:'NEVER_RENDER_BILLING'},deliveryReceipt:'NEVER_RENDER_DELIVERY',readReceipt:'NEVER_RENDER_READ'},{version:2,fileId:'INTERNAL_FILE_ID',billingSnapshot:{secret:'NEVER_RENDER_BILLING'},deliveryReceipt:'NEVER_RENDER_DELIVERY_UPDATED',readReceipt:'NEVER_RENDER_READ_UPDATED'}]);
  });
  fixtureNotes.push('All execution uses disposable memory SQLite/random localhost and synthetic data, not actual 4310/data/original platform. Normal announcement lifecycle, arbitrary audience strings, 28 history versions and 28 list records use validated API/UI writes.',
    'Missing/gap/empty/hidden-only/nonstring/projection and ambiguous-actor fixtures are explicitly INSERT-only memory imports. No immutable record_versions or BLOB was updated or deleted. Historical typed imports are not claims that normal API accepts nonstrings.',
    'Client user/role/employee changes test display invalidation only; not server membership revocation. Four real sessions and real current status/audience/active employee changes independently verify server authorization. Remote writes are checked on fresh requests; no real-time permission push is claimed.',
    'Existing synthetic PDF_BYTES are an attachment fixture, not a newly generated PDF. This slice creates zero PDF artifacts and calls zero operation markers.');
  const beforeReads=counts(),beforeState=rawState();assert.equal(Object.keys(beforeState).length,11);assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n,6);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM attachment_files').get().n,1);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM certification_attachment_files').get().n,1);
  await readOnly('desktop-canonical-four-fields-actor-diff-snapshot',async()=>{
    const t=await findItem(page,main);await t.focus();await page.keyboard.press('Enter');const d=page.getByRole('dialog',{name:title,exact:true});await d.getByText('第 6 版',{exact:true}).waitFor();const c=versionCard(d,6);await c.getByText(users.supervisor.name,{exact:true}).waitFor();const diff=c.getByRole('region',{name:'第 6 版變更前後',exact:true});await diff.getByText('合成公開公告 v5；重新發布至本系統。',{exact:true}).waitFor();await diff.getByText(main.body,{exact:true}).waitFor();await screenshot(page,'announcement-diff-desktop.png');const s=await snapshot(c);assert.deepEqual(await s.locator('dt').allTextContents(),['公告標題','公告內容','閱讀對象','公告狀態']);await s.getByText('居服員（caregiver）',{exact:true}).waitFor();await s.getByText('已發布至本系統（published）',{exact:true}).waitFor();await s.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(page,'announcement-snapshot-desktop.png');const withdrawn=await openCard(d,4);await withdrawn.getByText(users.supervisor.name,{exact:true}).waitFor();await withdrawn.getByRole('region',{name:'第 4 版變更前後',exact:true}).getByText('草稿（draft）',{exact:true}).waitFor();await withdrawn.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(page,'announcement-status-actor.png');await closeHistory(page,t);
  });mark('四欄共用差異與完整保存欄位、精確actor及公開範圍notice，發布不推定發送或已讀');
  await readOnly('literal-HTML-long-text-and-phone-layout',async()=>{
    const t=await findItem(page,literal);await rowNamed(page,literal.title).getByText('閱讀內容',{exact:true}).click();assert.equal(await rowNamed(page,literal.title).locator('p.pre-wrap').textContent(),longBody);assert.equal(await page.evaluate(()=>window.__announcementInjected),undefined);const d=await openHistory(page,t,title,2),c=versionCard(d,2),s=await snapshot(c);assert.equal(await s.locator('dd').nth(1).locator('span.pre-wrap').textContent(),longBody);await assertNoSecrets(d);await s.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(page,'announcement-literal-longtext-desktop.png');await page.setViewportSize({width:390,height:844});await inspectLayout(page);await s.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(page,'announcement-literal-longtext-mobile.png');const bodyText=s.locator('dd').nth(1).locator('span.pre-wrap');
    const tailGeometry=await bodyText.evaluate(async n=>{
      const dialog=n.closest('dialog'),footer=dialog.querySelector('.dialog-footer'),text=n.firstChild;
      if(!text||text.nodeType!==Node.TEXT_NODE)throw new Error('Saved body must remain a native text node');
      const start=text.textContent.indexOf('第8段：'),end=text.textContent.indexOf('合成公告長文結尾')+'合成公告長文結尾'.length;
      if(start<0||end<start)throw new Error('The exact saved tail marker is required');
      const range=document.createRange();range.setStart(text,start);range.setEnd(text,end);
      const measure=()=>{const r=range.getBoundingClientRect(),d=dialog.getBoundingClientRect(),f=footer.getBoundingClientRect();return {tail:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},visible:{top:Math.max(0,d.top)+8,bottom:Math.min(innerHeight,d.bottom,f.top)-8,left:Math.max(0,d.left),right:Math.min(innerWidth,d.right)},scrollTop:dialog.scrollTop,scrollHeight:dialog.scrollHeight,clientHeight:dialog.clientHeight};};
      const before=measure();dialog.scrollTop+=before.tail.bottom-before.visible.bottom;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {file:'announcement-literal-longtext-mobile-end.png',owner:'dialog.app-dialog',...measure()};
    });
    assert.ok(tailGeometry.tail.top>=tailGeometry.visible.top&&tailGeometry.tail.bottom<=tailGeometry.visible.bottom+1,'Eighth paragraph and exact final marker are visible above the sticky footer');
    assert.ok(tailGeometry.tail.left>=tailGeometry.visible.left&&tailGeometry.tail.right<=tailGeometry.visible.right,'Tail text remains inside the mobile dialog');
    screenshotGeometry.push(tailGeometry);await screenshot(page,'announcement-literal-longtext-mobile-end.png');await closeHistory(page,t);await page.setViewportSize({width:1440,height:1050});
    const trigger=await findItem(page,main),dialog=await openHistory(page,trigger,title,6),diff=versionCard(dialog,6).getByRole('region',{name:'第 6 版變更前後',exact:true});await page.setViewportSize({width:390,height:844});await inspectLayout(page);await diff.evaluate(n=>{n.scrollIntoView({block:'start'});n.scrollLeft=0;});await screenshot(page,'announcement-diff-mobile-before.png');await diff.evaluate(n=>{n.scrollLeft=n.scrollWidth;});await screenshot(page,'announcement-diff-mobile-after.png');await closeHistory(page,trigger);await page.setViewportSize({width:1440,height:1050});
  });mark('真保存長文/空白/換行與HTML literal不執行，1440/390完整欄位可讀、表格內捲與鍵盤焦點');
  await readOnly('own-labels-unknown-audience-and-nonstring-tag-safety',async()=>{
    let t=await findItem(page,unknown);await rowNamed(page,unknown.title).getByText('toString',{exact:true}).waitFor();let d=await openHistory(page,t,title,4);for(const[v,text]of[[4,'toString'],[3,'constructor'],[2,'__proto__'],[1,'未知原文']]){const c=await openCard(d,v);const s=await snapshot(c);await s.getByText(`保存文字：${text}`,{exact:true}).waitFor();}assert.ok(!/function Object|\[object Object\]|native code/.test(await d.textContent()));await versionCard(d,2).evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(page,'announcement-unknown-audience-prototype.png');await closeHistory(page,t);
    t=await findItem(page,allLabel);d=await openHistory(page,t,title,2);const diff=versionCard(d,2).getByRole('region',{name:'第 2 版變更前後',exact:true});await diff.getByText('全體同仁（all）',{exact:true}).waitFor();await diff.getByText('保存文字：全體同仁',{exact:true}).waitFor();await screenshot(page,'announcement-audience-code-versus-text.png');await closeHistory(page,t);
    t=await findItem(page,typed);d=await openHistory(page,t,title,6);const latest=versionCard(d,6).getByRole('region',{name:'第 6 版變更前後',exact:true});await latest.getByText('[欄位格式無法判讀]',{exact:true}).waitFor();assert.ok(await latest.locator('[data-announcement-value="unsupported"]').count()>0);await screenshot(page,'announcement-invalid-versus-literal.png');for(const v of[2,3]){const c=await openCard(d,v);await c.getByText('可展示的公告文字沒有可確認的變更。',{exact:true}).waitFor();}for(const v of[4,5]){const c=await openCard(d,v);const s=await snapshot(c);assert.equal(await s.locator('[data-announcement-value="unsupported"]').count(),2);if(v===5)await s.getByText('保存文字：constructor',{exact:true}).waitFor();}await assertNoSecrets(d);await closeHistory(page,t);
    t=await findItem(page,textLabels);d=await openHistory(page,t,title,4);for(const v of[4,2]){const c=await openCard(d,v),diff=c.getByRole('region',{name:`第 ${v} 版變更前後`,exact:true});const bodyRow=diff.getByRole('row').filter({has:page.getByText('公告內容',{exact:true})});const after=bodyRow.getByRole('cell').nth(2);await after.getByText('保存文字：',{exact:true}).waitFor();assert.equal(await after.locator('span.pre-wrap').textContent(),v===4?'非文字保存值；內容未展示。':'未提供');const before=bodyRow.getByRole('cell').nth(1);assert.equal(await before.getByText('保存文字：',{exact:true}).count(),0);if(v===4)assert.equal(await before.locator('[data-announcement-value="unsupported"]').count(),1);else await before.getByText('未提供',{exact:true}).waitFor();await c.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(page,v===4?'announcement-literal-versus-nontext-label.png':'announcement-literal-versus-missing-label.png');}await assertNoSecrets(d);await closeHistory(page,t);
  });mark('known代碼/合法字面與未知__proto__/constructor/toString可辨；missing/null/空合併，非文字tag與合法提示文字不同且不洩漏');
  await readOnly('metadata-whitelist-public-projection-and-hidden-only-history',async()=>{
    for(const actor of[{client:context,auth:admin,page},supervisor,finance,caregiver]){for(const compare of[true,false]){const h=await history(projection,actor,compare);for(const row of h.items)for(const saved of[row.snapshot,row.comparison?.previousSnapshot].filter(Boolean)){assert.ok(!('fileId'in saved));assert.equal('billingSnapshot'in saved,[admin.user.id,finance.auth.user.id].includes(actor.auth.user.id));}}const t=await findItem(actor.page,projection),d=await openHistory(actor.page,t,title,2);const s=await snapshot(versionCard(d,2));assert.deepEqual(await s.locator('dt').allTextContents(),['公告標題','公告內容','閱讀對象','公告狀態']);await assertNoSecrets(d);if(actor===finance)await screenshot(actor.page,'announcement-metadata-not-displayed.png');await closeHistory(actor.page,t);}
    for(const compare of[true,false]){assert.equal((await history(hiddenOnly,caregiver,compare)).total,0);assert.equal((await history(hiddenOnly,undefined,compare)).total,2);}const t=await findItem(caregiver.page,hiddenOnly);await t.click();const d=caregiver.page.getByRole('dialog',{name:title,exact:true});await d.getByText('尚無可讀取的版本歷程。',{exact:true}).waitFor();await assertNoSecrets(d);await screenshot(caregiver.page,'announcement-caregiver-hidden-only-empty.png');await closeHistory(caregiver.page,t);
  });mark('四欄外metadata不展示，raw/compare保持既有公共遮罩；current可讀但全部歷史隱藏時為空');
  await readOnly('28-version-pages-and-off-page-previous',async()=>{const t=await findItem(supervisor.page,pageItem),d=await openHistory(supervisor.page,t,title,28);assert.equal(await d.locator('.history-version').count(),25);const c=await openCard(d,4);await c.getByText('與第 3 版比較',{exact:true}).waitFor();await c.evaluate(n=>n.scrollIntoView({block:'start'}));await screenshot(supervisor.page,'announcement-page-boundary.png');await d.getByRole('button',{name:'下一頁',exact:true}).click();await d.getByText('第 3 版',{exact:true}).waitFor();assert.equal(await d.locator('.history-version').count(),3);await screenshot(supervisor.page,'announcement-page-two.png');await closeHistory(supervisor.page,t);for(const actor of[undefined,caregiver]){const first=await history(pageItem,actor,true,'&page=1&pageSize=25');assert.equal(first.items.at(-1).version,4);assert.equal(first.items.at(-1).comparison.previousVersion,3);assert.equal((await history(pageItem,actor,true,'&page=2&pageSize=25')).items.length,3);}});mark('正常API28版25+3，頁外精確前版仍可比較，居服範圍於分頁前完成');
  await readOnly('gap-empty-baseline-and-ambiguous-actor',async()=>{
    for(const[item,expected,file,version]of[[baseline,'未記錄操作者','announcement-baseline.png',1],[gap,'上一版本不可取得，只顯示本版保存資料。','announcement-gap.png',3],[empty,'尚無可讀取的版本歷程。','announcement-empty.png',null],[ambiguous,'未記錄操作者','announcement-ambiguous-actor.png',2]]){const t=await findItem(page,item);await t.click();const d=page.getByRole('dialog',{name:title,exact:true});await d.getByText(expected,{exact:true}).first().waitFor();if(version){const h=await history(item);assert.equal(h.items[0].version,version);if(item===ambiguous||item===baseline)assert.equal(h.items[0].actor,null);if(item===gap)assert.deepEqual(h.items[0].comparison,{status:'unavailable',previousVersion:null,previousSnapshot:null});}await screenshot(page,file);await closeHistory(page,t);}
  });mark('明示INSERT-only缺版不跳版、空歷程、未知及歧義actor，不臆測來源或操作者');
  const pattern=`**/api/${entity}/${main.id}/history*`;
  await readOnly('503-retry-and-slow-Escape-abort-focus',async()=>{const t=await findItem(page,main);let attempts=0;await page.route(pattern,r=>++attempts===1?r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC_READ',message:'合成公告歷程暫時無法取得，請重試。'}})}):r.continue());await t.click();let d=page.getByRole('dialog');await d.getByRole('button',{name:'重新讀取',exact:true}).waitFor();await screenshot(page,'announcement-history-retry.png');await d.getByRole('button',{name:'重新讀取',exact:true}).click();await d.getByText('第 6 版',{exact:true}).waitFor();assert.equal(attempts,2);await closeHistory(page,t);await page.unroute(pattern);const delayed=await delayRoute(page,pattern);await t.click();await delayed.arrived.promise;await page.getByText('正在讀取歷程…',{exact:true}).waitFor();await screenshot(page,'announcement-history-loading.png');const aborted=page.waitForEvent('requestfailed',{predicate:r=>r.url().includes(`/${main.id}/history`),timeout:10000});await closeHistory(page,t);try{assert.match((await aborted).failure()?.errorText||'',/abort|cancel/i);}finally{delayed.release.resolve();await delayed.handled.promise;}await page.unroute(pattern);await settle(page);assert.equal(await page.getByRole('dialog').count(),0);});mark('503重試真GET恢復；慢讀Escape中止、焦點返回、晚回應不復活');
  await readOnly('loaded-and-pending-full-six-context-invalidations',async()=>{for(const pending of[false,true])for(const mode of['hash','organization','user','role','employee','render']){const t=await findItem(page,main),delay=pending?await delayRoute(page,pattern):null;if(delay){await t.click();await delay.arrived.promise;}else await openHistory(page,t,title,6);if(mode==='hash')await page.evaluate(()=>{location.hash='/cases';});else if(mode==='organization')await page.getByLabel('目前機構',{exact:true}).evaluate((n,value)=>{n.value=value;n.dispatchEvent(new Event('change',{bubbles:true}));},otherOrg.id);else if(mode==='render')await page.evaluate(()=>window.dispatchEvent(new Event('session-updated')));else await page.evaluate(async({mode,employeeId,userId})=>{const{getContext,setContext}=await import('/ui.js');const ctx=structuredClone(getContext()),org=ctx.organizations.find(o=>o.id===ctx.organizationId);if(mode==='user')ctx.user.id=userId;else if(mode==='role')org.role='supervisor';else org.employeeId=employeeId;setContext(ctx,ctx.organizationId);document.body.append(document.createComment('synthetic-client-identity-fixture'));},{mode,employeeId:employeeB.id,userId:users.supervisor.id});await page.getByRole('dialog').waitFor({state:'detached'});if(delay){delay.release.resolve();await delay.handled.promise;await page.unroute(pattern);}await settle(page);assert.equal(await page.locator('.history-version').count(),0);invalidationChecks.push({pending,mode,removed:true,noLateRevival:true,clientFixture:['user','role','employee'].includes(mode)});await page.reload();await page.waitForLoadState('networkidle');}});mark('loaded/pending各user/org/role/employee/hash/render共12種清空abort關閉，clientfixture明示且不冒稱server撤權');
  await readOnly('list-search-status-pagination-no-results-and-mobile',async()=>{await load(page,'/announcements','內部公告');const q=page.getByLabel('搜尋資料',{exact:true});await q.fill('ANN-LIST-');await q.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('.list-content tbody tr').length===25);await page.getByRole('button',{name:'下一頁',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.list-content tbody tr').length===3);await screenshot(page,'announcement-list-page-two.png');await page.getByLabel('狀態',{exact:true}).selectOption('draft');await page.waitForFunction(()=>document.querySelectorAll('.list-content tbody tr').length===1);await rowNamed(page,'ANN-LIST-28').waitFor();await screenshot(page,'announcement-list-status-filter.png');await q.fill('不存在的合成公告');await q.press('Enter');await page.getByText('沒有符合條件的資料，請調整查詢。',{exact:true}).waitFor();await screenshot(page,'announcement-list-noresults.png');await q.fill('ANN-LIST-');await q.press('Enter');await rowNamed(page,'ANN-LIST-28').waitFor();await page.setViewportSize({width:390,height:844});await inspectLayout(page);await screenshot(page,'announcement-list-mobile.png');
    const listScroll=page.locator('.list-content .table-scroll');await listScroll.evaluate(n=>{n.scrollLeft=n.scrollWidth;});
    const historyTrigger=rowNamed(page,'ANN-LIST-28').getByRole('button',{name:'版本歷程',exact:true});
    const tableEnd=await historyTrigger.evaluate(n=>{const r=n.getBoundingClientRect(),s=n.closest('.table-scroll'),b=s.getBoundingClientRect();return{file:'announcement-list-mobile-table-end.png',button:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},visible:{left:Math.max(0,b.left),right:Math.min(innerWidth,b.right),top:0,bottom:innerHeight},scrollLeft:s.scrollLeft};});
    assert.ok(tableEnd.button.left>=tableEnd.visible.left&&tableEnd.button.right<=tableEnd.visible.right&&tableEnd.button.top>=0&&tableEnd.button.bottom<=tableEnd.visible.bottom,'Mobile table internal scroll exposes the actual history action');
    screenshotGeometry.push(tableEnd);await screenshot(page,'announcement-list-mobile-table-end.png');await page.setViewportSize({width:1440,height:1050});});mark('既有清單搜尋/28筆25+3/狀態/no-results及手機語義控件，未另寫controller');
  const blobDownloads=[],reportEndpoints=[];
  await readOnly('eleven-tables-billing-two-blobs-and-31-report-outlets',async()=>{
    assert.deepEqual(await get('service-records',record),approved);assert.deepEqual(await request('GET','reports/fees?month=2026-10'),fees);assert.deepEqual(await request('GET','reports/payroll?month=2026-10'),payroll);for(const[kind,item]of[['cases',careCase],['care-plans',plan],['service-items',service],['employees',employeeA],['employees',employeeB]])assert.deepEqual(await get(kind,item),item);
    for(const kind of['cases','shifts','services','fees','payroll'])for(const ext of['','.csv']){const route=`reports/${kind}${ext}?month=2026-10`,r=await context.request.get(`${base}/api/${route}`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200);if(ext)assert.ok((await r.text()).startsWith('\uFEFF'));else assert.ok(Array.isArray((await r.json()).rows));reportEndpoints.push(route);}
    for(const kind of['shift-report','service-report','case-report','employee-report','leave-report','training-report','certification-report'])for(const ext of['','/export','.csv']){const query=kind==='employee-report'?'':'?startDate=2026-01-01&endDate=2026-12-31'+(kind==='certification-report'?'&asOf=2026-10-08':'');const route=`${kind}${ext}${query}`,r=await context.request.get(`${base}/api/${route}`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200,route);if(ext==='.csv')assert.ok((await r.text()).startsWith('\uFEFF'));else assert.ok(Array.isArray((await r.json()).rows));reportEndpoints.push(route);}
    for(const[kind,item,bytes]of[['case-attachments',caseAttachment,PDF_BYTES],['certification-attachments',certAttachment,PNG_BYTES]]){const r=await context.request.get(`${base}/api/${kind}/${item.id}/download`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200);const actual=await r.body();assert.deepEqual(actual,bytes);assert.equal(digest(actual),item.sha256);blobDownloads.push({entity:kind,bytes:actual.length,sha256:digest(actual),matchesOriginal:true});}
  });assert.equal(reportEndpoints.length,31);assert.deepEqual(counts(),beforeReads);assert.deepEqual(rawState(),beforeState);assert.equal(invalidationChecks.length,12);assert.deepEqual(pageErrors,[]);assert.deepEqual(failedResponses.filter(r=>!r.expected),[]);assert.ok(consoleErrors.every(s=>/403|404|409|422|503/.test(s)),JSON.stringify(consoleErrors));const accountedChanges=writeSegments.reduce((n,s)=>n+s.after.changes-s.before.changes,0);assert.equal(counts().changes-initialCounts.changes,accountedChanges);mark('完整11表raw/count/total_changes唯讀零寫、6trigger與雙BLOB bytes/SHA、核閱費薪/主檔及31報表出口保持');
  await rm(path.join(output,'failure.png'),{force:true});
  const sourceFiles=['tests/announcement-history-e2e.mjs','src/server/history.mjs','src/server/model.mjs','public/modules/admin.js','public/modules/history.js','public/data/history-fields.js','public/ui.js','public/styles.css'];const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,digest(await readFile(path.join(root,file)))])));
  await writeFile(path.join(output,'e2e.json'),JSON.stringify({passed:true,completedAt:new Date().toISOString(),executionRoot:root,scope:'Synthetic memory SQLite/random localhost/real Chromium; no actual 4310/data/original platform.',checks,screenshots,screenshotGeometry,readSegments,writeSegments,initialCounts,finalCounts:counts(),accountedChanges,invalidationChecks,fixtureNotes,blobDownloads,reportEndpoints,pageErrors,consoleErrors,failedResponses,readonlyCounts:{before:beforeReads,after:counts()},all11TablesUnchangedDuringReads:true,blobTablesNonempty:{attachment_files:1,certification_attachment_files:1},immutableTriggers:6,approvedBillingSnapshotUnchanged:true,pdfOperations:0,pdfMarkers:0,sourceHashes,visualReviewPending:true},null,2));console.log(`Announcement history E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
}catch(error){if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:path.join(output,'failure.png'),fullPage:false}).catch(()=>{});await writeFile(path.join(output,'e2e.json'),JSON.stringify({passed:false,completedAt:new Date().toISOString(),executionRoot:root,checks,screenshots,pageErrors,consoleErrors,failedResponses,readSegments,writeSegments,invalidationChecks,fixtureNotes,error:error.stack,pdfOperations:0,pdfMarkers:0},null,2));throw error;}
finally{for(const context of contexts)await context.close();await browser?.close();await app.close();}
