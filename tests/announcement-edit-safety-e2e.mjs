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
const output = path.join(root, 'outputs/software/announcement-edit-safety-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [], confirmationChecks = [], payloadChecks = [];
const password = 'synthetic-announcement-edit-safety-password';
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
const queryTokens = new Map();
const findItem = async (page, item) => {
  await load(page, '/announcements', '內部公告');
  const q=(queryTokens.get(item.id)||item.title).trim(), search=page.getByLabel('搜尋資料',{exact:true});
  await search.fill(q);await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/announcements'&&new URL(r.url()).searchParams.get('q')===q),search.press('Enter')]);
  await page.waitForFunction(()=>document.querySelectorAll('.list-content tbody tr').length===1);
  return page.locator('.list-content tbody tr').getByRole('button',{name:'版本歷程',exact:true});
};
const input=(dialog,name)=>dialog.locator(`[name="${name}"]`);
const intent=(dialog,name)=>input(dialog,`${name}Intent`);
const editItem=async(page,item)=>{await findItem(page,item);await page.locator('.list-content tbody tr').getByRole('button',{name:'編輯',exact:true}).click();return page.getByRole('dialog',{name:'編輯內部公告',exact:true});};
const withdrawItem=async(page,item)=>{await findItem(page,item);await page.locator('.list-content tbody tr').getByRole('button',{name:'撤回草稿',exact:true}).click();return page.getByRole('dialog',{name:'撤回公告至草稿？',exact:true});};
const noUnsafe=async dialog=>{assert.ok(!/NEVER_RENDER|unsafe_source|billingSnapshot|deliveryReceipt|readReceipt|sourceMarker/.test(await dialog.innerHTML()),'Unsafe source values/keys do not enter input, help, placeholders, attributes or hidden form markup');assert.equal(await dialog.locator('script,img,iframe').count(),0);};
const alertVisible=async d=>{await d.locator('[role="alert"]:visible').waitFor();};
const fill = async (page, data) => {
  const d=page.getByRole('dialog');
  for(const[key,label]of[['title','公告標題'],['body','公告內容']])if(key in data)await d.getByLabel(label,{exact:false}).fill(String(data[key]));
  for(const[key,label]of[['audience','閱讀對象'],['status','狀態']])if(key in data)await d.getByLabel(label,{exact:false}).selectOption(data[key]);
};
const discard = async page => { await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click(); const confirm=page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true}); if(await confirm.count()) await confirm.getByRole('button',{name:'放棄修改',exact:true}).click(); await page.getByRole('dialog').waitFor({state:'detached'}); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Frozen contract: docs/ANNOUNCEMENT_EDIT_SAFETY_SCOPE.md.
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
  const openNew=async p=>{await load(p,'/announcements','內部公告');await p.getByRole('button',{name:'新增公告',exact:true}).click();return p.getByRole('dialog',{name:'新增內部公告',exact:true});};
  const saveWithPayload=async(p,item)=>{const method=item?'PATCH':'POST',pathname=`/api/announcements${item?`/${item.id}`:''}`;const pending=p.waitForRequest(r=>new URL(r.url()).pathname===pathname&&r.method()===method);await saveDialog(p);const req=await pending,body=req.postDataJSON();payloadChecks.push({method,keys:Object.keys(body).sort(),itemId:item?.id||null});return body;};
  const businessKeys=['title','body','audience','status'];
  const projection=item=>Object.fromEntries(businessKeys.filter(k=>Object.hasOwn(item,k)).map(k=>[k,structuredClone(item[k])]));
  const assertNoSuccess=async p=>assert.equal(await p.locator('.toast').filter({hasText:/公告已儲存|公告已撤回/}).count(),0,'Unconfirmed or invalidated response never shows success');
  const resetPage=async()=>{await page.reload();await page.waitForLoadState('networkidle');};
  let main=await written('admin-real-UI-create-four-fields-defaults',async()=>{
    const d=await openNew(page);assert.equal(await input(d,'audience').inputValue(),'all');assert.equal(await input(d,'status').inputValue(),'draft');assert.equal(await d.locator('[name$="Intent"]').count(),0);
    await input(d,'title').fill('  EDIT-MAIN 合成公告　✨  ');await input(d,'body').fill('  合成第一行\n第二行：<script>不是程式</script>　\n  ');await inspectLayout(page);await screenshot(page,'announcement-editor-create-desktop.png');
    const body=await saveWithPayload(page);assert.deepEqual(Object.keys(body).sort(),businessKeys.toSorted());assert.equal(body.title,'  EDIT-MAIN 合成公告　✨  ');assert.equal(body.body,'  合成第一行\n第二行：<script>不是程式</script>　\n  ');
    const item=(await request('GET',`${entity}?q=EDIT-MAIN`)).items[0];assert.deepEqual(projection(item),body);assert.equal(item.version,1);return item;
  });
  main=await written('supervisor-real-UI-edit-and-title-revert-omits',async()=>{
    const d=await editItem(supervisor.page,main);assert.equal(await input(d,'title').inputValue(),main.title);assert.equal(await input(d,'body').inputValue(),main.body);
    await input(d,'title').fill('合成暫時變更');await input(d,'title').fill(main.title);await input(d,'body').fill('合成督導更新\n完整保存文字。');await input(d,'audience').selectOption('caregiver');await input(d,'status').selectOption('published');
    const payload=await saveWithPayload(supervisor.page,main);assert.deepEqual(payload,{body:'合成督導更新\n完整保存文字。',audience:'caregiver',status:'published',version:1});return get(entity,main);
  });
  await readOnly('no-edit-cancel-and-exact-two-actors-history',async()=>{const d=await editItem(page,main);assert.equal(await input(d,'body').inputValue(),main.body);await page.keyboard.press('Escape');await d.waitFor({state:'detached'});const h=await history(main);assert.deepEqual(h.items.map(x=>x.actor.id),[users.supervisor.id,admin.user.id]);assert.equal(h.items[0].comparison.previousVersion,1);});
  mark('真admin新增四欄/default與Unicode空白，sup編輯只送變更；改回原值省略、歷程及actor保持');

  let unknown=await written('normal-API-unknown-audience-fixture',()=>post(entity,dataFor('EDIT-UNKNOWN 合成未知對象',{audience:'__proto__'})));
  unknown=await written('unknown-audience-keep-while-editing-body',async()=>{const d=await editItem(page,unknown);assert.equal(await intent(d,'audience').inputValue(),'keep');assert.ok(await input(d,'audience').isDisabled());assert.equal(await input(d,'audience').inputValue(),'');assert.ok(!(await d.innerHTML()).includes('__proto__'));await input(d,'body').fill('合成未知對象保持、只改內文');await screenshot(page,'announcement-editor-unknown-keep.png');const payload=await saveWithPayload(page,unknown);assert.deepEqual(payload,{body:'合成未知對象保持、只改內文',version:unknown.version});const item=await get(entity,unknown);assert.equal(item.audience,'__proto__');return item;});
  unknown=await written('unknown-audience-explicit-clear',async()=>{const d=await editItem(page,unknown);await intent(d,'audience').selectOption('clear');assert.ok(await input(d,'audience').isDisabled());await screenshot(page,'announcement-editor-audience-clear.png');assert.deepEqual(await saveWithPayload(page,unknown),{audience:'',version:unknown.version});return get(entity,unknown);});
  unknown=await written('saved-empty-audience-keep-presence',async()=>{const d=await editItem(page,unknown);assert.equal(await intent(d,'audience').inputValue(),'keep');await input(d,'body').fill('合成已保存空對象仍保持');const payload=await saveWithPayload(page,unknown);assert.ok(!Object.hasOwn(payload,'audience'));const item=await get(entity,unknown);assert.ok(Object.hasOwn(item,'audience'));assert.equal(item.audience,'');return item;});
  unknown=await written('audience-explicit-replace-known',async()=>{const d=await editItem(page,unknown);await intent(d,'audience').selectOption('replace');assert.ok(await input(d,'audience').isEnabled());await input(d,'audience').selectOption('finance');assert.deepEqual(await saveWithPayload(page,unknown),{audience:'finance',version:unknown.version});return get(entity,unknown);});
  mark('合法未知與已保存空audience不預設覆蓋；保持省略、明確清空空字串與取代五既有值');

  let special=await written('normal-API-CRLF-saved-source',()=>post(entity,dataFor('EDIT-CRLF\r\n合成不可直接預填標題',{body:'EDIT-CRLF-BODY\r\nNEVER_RENDER_CRLF原文\r結尾'})));
  queryTokens.set(special.id,'EDIT-CRLF');
  special=await written('CRLF-keep-exact-and-metadata-only-payload',async()=>{const d=await editItem(page,special);for(const k of['title','body']){assert.equal(await intent(d,k).inputValue(),'keep');assert.equal(await input(d,k).inputValue(),'');assert.ok(await input(d,k).isDisabled());}await noUnsafe(d);await input(d,'audience').selectOption('admin');await screenshot(page,'announcement-editor-crlf-keep.png');assert.deepEqual(await saveWithPayload(page,special),{audience:'admin',version:special.version});const item=await get(entity,special);assert.equal(item.title,special.title);assert.equal(item.body,special.body);return item;});
  special=await written('CRLF-explicit-safe-title-and-body-replace',async()=>{const d=await editItem(page,special);await intent(d,'title').selectOption('replace');await intent(d,'body').selectOption('replace');await input(d,'title').fill('EDIT-CRLF 合成明確取代標題');await input(d,'body').fill('合成明確取代\n保留新輸入換行');const payload=await saveWithPayload(page,special);assert.deepEqual(Object.keys(payload).sort(),['body','title','version']);return get(entity,special);});
  mark('真API CR/LF原值不進控制項；保持時原樣保存，取代後只送明確新文字');

  const imported=(token,overrides={},omits=[])=>{const time=now(),data={...dataFor(token),...overrides,sourceMarker:token,billingSnapshot:{NEVER_RENDER:'unsafe_source_billing'},deliveryReceipt:'NEVER_RENDER_DELIVERY'};for(const k of omits)delete data[k];const item={...data,id:id(),orgId,version:1,createdAt:time,updatedAt:time};app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id,orgId,entity,JSON.stringify(data),1,time,time);app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId,entity,item.id,1,JSON.stringify(item),time,'synthetic-import');queryTokens.set(item.id,token);return item;};
  let typed,missing,nullAudience,invalidRequired=[];
  await written('explicit-INSERT-only-unsafe-and-presence-fixtures',async()=>{
    typed=imported('EDIT-TYPED',{title:{unsafe_source:'NEVER_RENDER_TITLE'},body:['NEVER_RENDER_BODY'],audience:{unsafe_source:'NEVER_RENDER_AUDIENCE'},status:'constructor'});
    missing=imported('EDIT-MISSING',{},['audience']);nullAudience=imported('EDIT-NULL-AUDIENCE',{audience:null});
    for(const [i,key,value,omit]of[[1,'title',null,false],[2,'body','',false],[3,'body',[],false],[4,'title',null,true],[5,'status','constructor',false]])invalidRequired.push(imported(`EDIT-REQUIRED-${i}`,{[key]:value},omit?[key]:[]));
  });
  typed=await written('unsafe-nonempty-keep-and-status-explicit-repair',async()=>{const d=await editItem(page,typed);for(const k of businessKeys){assert.equal(await intent(d,k).inputValue(),'keep');assert.ok(await input(d,k).isDisabled());assert.equal(await input(d,k).inputValue(),'');}await noUnsafe(d);await intent(d,'status').selectOption('replace');await input(d,'status').selectOption('published');await screenshot(page,'announcement-editor-unsafe-keep-desktop.png');assert.deepEqual(await saveWithPayload(page,typed),{status:'published',version:typed.version});const saved=await get(entity,typed);for(const k of['title','body','audience'])assert.deepEqual(saved[k],typed[k]);return saved;});
  for(const item of[missing,nullAudience])await written(`original-${Object.hasOwn(item,'audience')?'null':'missing'}-presence-kept`,async()=>{const d=await editItem(page,item);await input(d,'body').fill('合成只改內文以驗原存在性');const payload=await saveWithPayload(page,item);assert.ok(!Object.hasOwn(payload,'audience'));const saved=await get(entity,item);assert.equal(Object.hasOwn(saved,'audience'),Object.hasOwn(item,'audience'));if(Object.hasOwn(item,'audience'))assert.equal(saved.audience,null);});
  await readOnly('required-import-keep-still-respects-original-422',async()=>{for(const item of invalidRequired){const d=await editItem(page,item);const clientRequired=item.body==='';const pending=clientRequired?null:page.waitForResponse(r=>new URL(r.url()).pathname===`/api/announcements/${item.id}`&&r.request().method()==='PATCH');await d.getByRole('button',{name:'儲存',exact:true}).click();if(pending)assert.equal((await pending).status(),422);else{assert.equal(await input(d,'body').getAttribute('aria-invalid'),'true');await request('PATCH',`${entity}/${item.id}`,{version:item.version},422);}await alertVisible(d);await noUnsafe(d);assert.ok(await d.isVisible());if(item===invalidRequired[0])await screenshot(page,'announcement-editor-original422-keep.png');await discard(page);}});
  typed=await written('unsafe-three-fields-explicit-replace-and-clear',async()=>{const d=await editItem(page,typed);await intent(d,'title').selectOption('replace');await intent(d,'body').selectOption('replace');await intent(d,'audience').selectOption('clear');await input(d,'title').fill('EDIT-TYPED 合成修復文字');await input(d,'body').fill('合成使用者明確取代內容');const payload=await saveWithPayload(page,typed);assert.deepEqual(payload,{title:'EDIT-TYPED 合成修復文字',body:'合成使用者明確取代內容',audience:'',version:typed.version});return get(entity,typed);});
  mark('明示匯入非文字/缺失/null只顯型別並保持presence；原必要欄422不略過，使用者可明確修復');

  let retry=await written('retry-unsafe-fixture',()=>post(entity,dataFor('EDIT-RETRY',{audience:'NEVER_RENDER_UNKNOWN',body:'合成重試來源'})));
  await readOnly('required-replace-403-field422-503-preservation-and-control-lock',async()=>{
    const d=await editItem(page,retry);await intent(d,'audience').selectOption('replace');await input(d,'body').fill('合成必填與伺服器失敗保留');await d.getByRole('button',{name:'儲存',exact:true}).click();await alertVisible(d);assert.equal(await input(d,'audience').getAttribute('aria-invalid'),'true');assert.ok(await input(d,'audience').evaluate(n=>n===document.activeElement));await input(d,'audience').selectOption('caregiver');
    const pattern=`**/api/announcements/${retry.id}`;
    for(const status of[403,422,503]){await page.route(pattern,r=>r.request().method()==='PATCH'?r.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC_DENIED',message:`合成${status}失敗`,...(status===422?{fields:{body:'合成內容欄位錯誤'}}:{})}})}):r.continue());await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText(status===422?'合成內容欄位錯誤':`合成${status}失敗`,{exact:true}).waitFor();assert.equal(await input(d,'body').inputValue(),'合成必填與伺服器失敗保留');assert.equal(await intent(d,'audience').inputValue(),'replace');assert.equal(await input(d,'audience').inputValue(),'caregiver');assert.ok(await input(d,'body').isEnabled());assert.ok(await intent(d,'audience').isEnabled());if(status===422){assert.ok(await input(d,'body').evaluate(n=>n===document.activeElement));await screenshot(page,'announcement-editor-field422-focus.png');}if(status===403)await screenshot(page,'announcement-editor-403-preserved.png');await assertNoSuccess(page);await page.unroute(pattern);}
    const arrived=deferred(),release=deferred(),handled=deferred();await page.route(pattern,async r=>{if(r.request().method()!=='PATCH')return r.continue();arrived.resolve();await release.promise;await r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'合成延遲503'}})});handled.resolve();});await d.getByRole('button',{name:'儲存',exact:true}).click();await arrived.promise;assert.ok(await d.locator('input,textarea,select').evaluateAll(nodes=>nodes.every(n=>n.disabled)));await page.keyboard.press('Escape');assert.ok(await d.isVisible());await screenshot(page,'announcement-editor-busy-locked.png');release.resolve();await handled.promise;await d.getByText('合成延遲503',{exact:true}).waitFor();assert.ok(await input(d,'audience').isEnabled());await page.unroute(pattern);await screenshot(page,'announcement-editor-503-preserved.png');
  });
  retry=await written('retry-original-form-after503',async()=>{await saveWithPayload(page,retry);return get(entity,retry);});assert.equal(retry.version,2);assert.equal(retry.audience,'caregiver');
  mark('取代必填與403/欄位422/503保留輸入及intent；pending鎖控件/Escape不偽取消，失敗恢復後可重試');

  let cas=await written('CAS-fixture',()=>post(entity,dataFor('EDIT-CAS')));await editItem(page,cas);await input(page.getByRole('dialog'),'body').fill('合成使用者未儲存CAS內容');
  cas=await written('real-competing-PATCH-after-row-open',()=>patch(entity,cas,{body:'合成另一使用者已儲存'}));
  await readOnly('CAS-keeps-snapshot-no-refetch-overwrite',async()=>{const d=page.getByRole('dialog'),requests=[];const listener=r=>{if(new URL(r.url()).pathname.startsWith('/api/announcements'))requests.push({method:r.method(),path:new URL(r.url()).pathname});};page.on('request',listener);await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('資料已更新，請重新讀取',{exact:true}).waitFor();assert.equal(await input(d,'body').inputValue(),'合成使用者未儲存CAS內容');assert.equal(requests.filter(r=>r.method==='GET').length,0);await screenshot(page,'announcement-editor-CAS409.png');page.off('request',listener);await discard(page);});
  await readOnly('original-API-type-length-CSRF-rejection',async()=>{for(const data of[{title:{}},{body:[]},{audience:null},{status:'constructor'},{title:'字'.repeat(501)},{body:'文'.repeat(10001)},{audience:'x'.repeat(501)},{status:3}])await request('PATCH',`${entity}/${cas.id}`,{version:cas.version,...data},422);const r=await context.request.patch(`${base}/api/${entity}/${cas.id}`,{headers:{Origin:base,'X-Org-Id':orgId,'X-CSRF-Token':'bad'},data:{version:cas.version,body:'合成無CSRF'}});assert.equal(r.status(),403);});
  mark('真列表snapshot竞争CAS409不fresh覆蓋/自動重送；原四欄型別/長度與CSRF守門保持');
  let confirmation=await written('confirmation-response-matrix-fixture',()=>post(entity,dataFor('EDIT-CONFIRM')));
  await readOnly('fake-success-matrix-no-server-write-no-close-toast-refresh',async()=>{
    const d=await editItem(page,confirmation);await input(d,'body').fill('合成待確認四欄');const expected={...confirmation,version:confirmation.version+1,body:'合成待確認四欄'},pattern=`**/api/announcements/${confirmation.id}`;
    const mutations=[['missing-item',()=>({})],['array-item',()=>({item:[]})],['null-item',()=>({item:null})],['wrong-id',()=>({item:{...expected,id:id()}})],['empty-id',()=>({item:{...expected,id:''}})],['wrong-org',()=>({item:{...expected,orgId:otherOrg.id}})],['zero-version',()=>({item:{...expected,version:0}})],['wrong-version',()=>({item:{...expected,version:99}})],...businessKeys.map(key=>[`wrong-${key}`,()=>({item:{...expected,[key]:'合成錯誤確認值'}})]),...businessKeys.map(key=>[`missing-own-${key}`,()=>{const item={...expected};delete item[key];return{item};}])];
    let listReads=0;const listen=r=>{if(r.method()==='GET'&&new URL(r.url()).pathname==='/api/announcements')listReads++;};page.on('request',listen);
    for(const[label,make]of mutations){await page.route(pattern,r=>r.request().method()==='PATCH'?r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(make())}):r.continue());await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('儲存結果未確認；請保留輸入並重新讀取確認。',{exact:true}).waitFor();assert.equal(await input(d,'body').inputValue(),'合成待確認四欄');assert.ok(await input(d,'body').isEnabled());await assertNoSuccess(page);await page.unroute(pattern);confirmationChecks.push({operation:'edit',label,submittedToServer:false,preserved:true});}
    assert.equal(listReads,0);page.off('request',listen);await screenshot(page,'announcement-editor-wrong-success.png');await discard(page);
    const item=await get(entity,missing),f=await editItem(page,item);await input(f,'body').fill('合成missing省略確認');await page.route(`**/api/announcements/${item.id}`,r=>r.request().method()==='PATCH'?r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({item:{...item,version:item.version+1,body:'合成missing省略確認',audience:null}})}):r.continue());await f.getByRole('button',{name:'儲存',exact:true}).click();await f.getByText('儲存結果未確認；請保留輸入並重新讀取確認。',{exact:true}).waitFor();assert.equal(await intent(f,'audience').inputValue(),'keep');confirmationChecks.push({operation:'edit',label:'omitted-audience-became-own-null',submittedToServer:false,preserved:true});await page.unroute(`**/api/announcements/${item.id}`);await discard(page);
  });
  confirmation=await written('all-normal-reverted-fields-send-version-only',async()=>{const d=await editItem(page,confirmation);for(const k of['title','body']){await input(d,k).fill('合成暫改後還原');await input(d,k).fill(confirmation[k]);}await input(d,'audience').selectOption('admin');await input(d,'audience').selectOption(confirmation.audience);assert.deepEqual(await saveWithPayload(page,confirmation),{version:confirmation.version});const item=await get(entity,confirmation);assert.deepEqual(projection(item),projection(confirmation));assert.equal(item.version,confirmation.version+1);return item;});
  mark('2xx plainitem/id/org/精確version與四欄值/presence確認矩陣不接受錯誤成功；全改回僅送version沿原API升版');

  let uncertain=await written('committed-PATCH-invalid-response-fixture',()=>post(entity,dataFor('EDIT-UNCERTAIN')));
  await written('real-PATCH-commit-response-unconfirmed',async()=>{const d=await editItem(page,uncertain);await input(d,'body').fill('合成伺服器已提交但回應缺失');const pattern=`**/api/announcements/${uncertain.id}`;await page.route(pattern,async r=>{if(r.request().method()!=='PATCH')return r.continue();const response=await r.fetch();assert.equal(response.status(),200);await r.fulfill({response,body:'{}'});});await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('儲存結果未確認；請保留輸入並重新讀取確認。',{exact:true}).waitFor();assert.equal(await input(d,'body').inputValue(),'合成伺服器已提交但回應缺失');await assertNoSuccess(page);await screenshot(page,'announcement-editor-committed-unconfirmed.png');await page.unroute(pattern);uncertain=await get(entity,uncertain);assert.equal(uncertain.version,2);});
  await readOnly('uncertain-PATCH-retry-CAS-not-overwrite',async()=>{const d=page.getByRole('dialog');await d.getByRole('button',{name:'儲存',exact:true}).click();await d.getByText('資料已更新，請重新讀取',{exact:true}).waitFor();assert.equal(await input(d,'body').inputValue(),'合成伺服器已提交但回應缺失');await discard(page);});
  for(const mode of['AbortError','SyntaxError','missing-item'])await written(`real-POST-${mode}-same-key-retry`,async()=>{
    const d=await openNew(page);await input(d,'title').fill(`EDIT-POST-${mode} 合成不明回應`);await input(d,'body').fill('合成新增保持同一冪等鍵');const captures=[];const capture=r=>{if(new URL(r.url()).pathname==='/api/announcements'&&r.method()==='POST')captures.push({key:r.headers()['idempotency-key'],payload:r.postDataJSON()});};page.on('request',capture);
    if(mode==='missing-item')await page.route('**/api/announcements',async r=>{if(r.request().method()!=='POST')return r.continue();const response=await r.fetch();assert.equal(response.status(),201);await r.fulfill({response,body:'{}'});});
    else await page.evaluate(mode=>{const original=window.fetch;let once=false;window.__restoreAnnouncementFetch=()=>{window.fetch=original;};window.fetch=async function(...args){const response=await original.apply(this,args),u=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);if(u.pathname==='/api/announcements'&&args[1]?.method==='POST'&&!once){once=true;response.json=async()=>{if(mode==='AbortError')throw new DOMException('Synthetic success body interrupted','AbortError');throw new SyntaxError('Synthetic success JSON unreadable');};}return response;};},mode);
    await d.getByRole('button',{name:'儲存',exact:true}).click();await alertVisible(d);assert.equal(await input(d,'title').inputValue(),`EDIT-POST-${mode} 合成不明回應`);assert.equal(await input(d,'body').inputValue(),'合成新增保持同一冪等鍵');await assertNoSuccess(page);const saved=(await request('GET',`${entity}?q=${encodeURIComponent(`EDIT-POST-${mode}`)}`)).items;assert.equal(saved.length,1);assert.equal(saved[0].version,1);const committed=counts();if(mode==='AbortError')await screenshot(page,'announcement-editor-post-body-abort.png');
    if(mode==='missing-item')await page.unroute('**/api/announcements');else await page.evaluate(()=>window.__restoreAnnouncementFetch());await saveDialog(page);page.off('request',capture);assert.equal(captures.length,2);assert.ok(captures[0].key);assert.equal(captures[0].key,captures[1].key);assert.deepEqual(captures[0].payload,captures[1].payload);assert.deepEqual(counts(),committed);confirmationChecks.push({operation:'create',label:mode,submittedToServer:true,retrySameKey:true,retryAddedWrites:false});
  });
  mark('真已提交PATCH未確認保留並再試CAS；POST body Abort/Syntax/缺item均同鍵重試無重複record/version/audit');

  let withdrawal=await written('withdrawal-normal-fixture',()=>post(entity,dataFor('EDIT-WITHDRAW',{audience:'all'})));
  await readOnly('withdraw-cancel-keyboard-and-invalid-confirmation',async()=>{
    let d=await withdrawItem(page,withdrawal);assert.ok(await d.getByRole('button',{name:'取消',exact:true}).evaluate(n=>n===document.activeElement));await page.keyboard.press('Escape');await d.waitFor({state:'detached'});assert.ok(await page.locator('.list-content tbody tr').getByRole('button',{name:'撤回草稿',exact:true}).evaluate(n=>n===document.activeElement));
    d=await withdrawItem(page,withdrawal);const pattern=`**/api/announcements/${withdrawal.id}`;for(const[label,edit]of[['wrong-body',x=>({...x,body:'錯誤確認'})],['missing-title',x=>{delete x.title;return x;}],['wrong-id',x=>({...x,id:id()})],['wrong-version',x=>({...x,version:99})]]){await page.route(pattern,r=>r.request().method()==='PATCH'?r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({item:edit({...withdrawal,version:withdrawal.version+1,status:'draft'})})}):r.continue());await d.getByRole('button',{name:'確認撤回草稿',exact:true}).click();await d.getByText('儲存結果未確認；請保留輸入並重新讀取確認。',{exact:true}).waitFor();await assertNoSuccess(page);assert.ok(await d.getByRole('button',{name:'取消',exact:true}).isEnabled());await page.unroute(pattern);confirmationChecks.push({operation:'withdraw',label,submittedToServer:false,preserved:true});}await screenshot(page,'announcement-withdraw-unconfirmed.png');await page.keyboard.press('Escape');await d.waitFor({state:'detached'});
  });
  withdrawal=await written('supervisor-real-confirmed-withdrawal',async()=>{const d=await withdrawItem(supervisor.page,withdrawal);await screenshot(supervisor.page,'announcement-withdraw-confirm.png');const pending=supervisor.page.waitForRequest(r=>new URL(r.url()).pathname===`/api/announcements/${withdrawal.id}`&&r.method()==='PATCH');await d.getByRole('button',{name:'確認撤回草稿',exact:true}).click();await d.waitFor({state:'detached'});assert.deepEqual((await pending).postDataJSON(),{status:'draft',version:withdrawal.version});const item=await get(entity,withdrawal);assert.equal(item.status,'draft');for(const k of['title','body','audience'])assert.equal(item[k],withdrawal[k]);assert.equal((await history(item)).items[0].actor.id,users.supervisor.id);return item;});
  await readOnly('withdraw-current-role-and-previous-version-authorization',async()=>{for(const suffix of['','/history','/history?compare=previous'])await request('GET',`${entity}/${withdrawal.id}${suffix}`,undefined,404,caregiver);assert.equal((await history(withdrawal)).items[1].snapshot.status,'published');});
  let withdrawMissing=await written('withdraw-422-import-fixture',()=>imported('EDIT-WITHDRAW-MISSING',{},['title']));
  await readOnly('withdraw-required-422-preserved',async()=>{const d=await withdrawItem(page,withdrawMissing),pending=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/announcements/${withdrawMissing.id}`&&r.request().method()==='PATCH');await d.getByRole('button',{name:'確認撤回草稿',exact:true}).click();assert.equal((await pending).status(),422);await alertVisible(d);assert.ok(await d.getByRole('button',{name:'取消',exact:true}).isEnabled());await screenshot(page,'announcement-withdraw-original422.png');await page.keyboard.press('Escape');});
  mark('撤回共用guard確認可取消且有效成功只改status；錯誤確認與原422保留，精確actor/history及次次讀權保持');

  let contextItem=await written('full-context-normal-fixture',()=>post(entity,dataFor('EDIT-CONTEXT',{audience:'all'})));
  await readOnly('loaded-and-pending-edit-withdraw-six-client-contexts',async()=>{
    for(const operation of['edit','withdraw'])for(const pending of[false,true])for(const mode of['hash','organization','user','role','employee','render']){
      const d=operation==='edit'?await editItem(page,contextItem):await withdrawItem(page,contextItem);if(operation==='edit')await input(d,'body').fill(`合成${mode}${pending?'pending':'loaded'}編輯尚未儲存`);
      const pattern=`**/api/announcements/${contextItem.id}`,arrived=deferred(),release=deferred(),handled=deferred();let aborted,failedListener;console.log(`CONTEXT ${operation} ${pending?'pending':'loaded'} ${mode}`);
      if(pending){await page.route(pattern,async r=>{if(r.request().method()!=='PATCH')return r.continue();arrived.resolve();await release.promise;await r.abort('aborted').catch(()=>{});handled.resolve();});aborted=deferred();failedListener=r=>{if(new URL(r.url()).pathname===`/api/announcements/${contextItem.id}`)aborted.resolve(r);};page.on('requestfailed',failedListener);const commitButton=d.getByRole('button',{name:operation==='edit'?'儲存':'確認撤回草稿',exact:true}),commitHandle=await commitButton.elementHandle();await commitButton.click();await arrived.promise;console.log('CONTEXT request intercepted');assert.ok(await commitHandle.isDisabled());assert.equal(await commitHandle.getAttribute('aria-busy'),'true');if(operation==='withdraw')assert.ok(await d.getByRole('button',{name:'取消',exact:true}).isDisabled());else{console.log('CONTEXT before cancel click');await d.getByRole('button',{name:'取消',exact:true}).click();console.log('CONTEXT after cancel click');assert.ok(await d.isVisible());}if(operation==='edit')assert.ok(await d.locator('input,select,textarea').evaluateAll(nodes=>nodes.every(n=>n.disabled)));await page.keyboard.press('Escape');assert.ok(await d.isVisible());if(mode==='hash')await screenshot(page,`announcement-${operation}-context-pending.png`);}
      if(mode==='hash')await page.evaluate(()=>{location.hash='/cases';});else if(mode==='organization')await page.getByLabel('目前機構',{exact:true}).evaluate((n,v)=>{n.value=v;n.dispatchEvent(new Event('change',{bubbles:true}));},otherOrg.id);else if(mode==='render')await page.evaluate(()=>window.dispatchEvent(new Event('session-updated')));else await page.evaluate(async({mode,employeeId,userId})=>{const{getContext,setContext}=await import('/ui.js');const c=structuredClone(getContext()),o=c.organizations.find(x=>x.id===c.organizationId);if(mode==='user')c.user.id=userId;else if(mode==='role')o.role='supervisor';else o.employeeId=employeeId;setContext(c,c.organizationId);document.body.append(document.createComment('synthetic-client-context-fixture'));},{mode,employeeId:employeeB.id,userId:users.supervisor.id});
      await page.getByRole('dialog').waitFor({state:'detached'});if(pending){release.resolve();await handled.promise;const failed=await Promise.race([aborted.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Missing failed request after context invalidation')),10000);timer.unref();})]);assert.match(failed.failure()?.errorText||'',/abort|cancel|failed/i);page.off('requestfailed',failedListener);await page.unroute(pattern);}await page.waitForLoadState('networkidle');await settle(page);assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('[name="body"]').count(),0);await assertNoSuccess(page);invalidationChecks.push({operation,pending,mode,removed:true,noLateRevival:true,requestBlockedBeforeServer:pending,clientFixture:['user','role','employee'].includes(mode)});await resetPage();
    }
  });
  mark('edit/withdraw各loaded+pending六identity/hash/render共24失效清空abort；取消鎖定、無晚成功且clientfixture明記');
  for(const operation of['edit','withdraw'])await written(`real-${operation}-commit-then-context-invalidates-response`,async()=>{
    contextItem=await get(entity,contextItem);const d=operation==='edit'?await editItem(page,contextItem):await withdrawItem(page,contextItem);if(operation==='edit')await input(d,'body').fill('合成已提交後切換畫面');const pattern=`**/api/announcements/${contextItem.id}`,arrived=deferred(),release=deferred(),handled=deferred();
    await page.route(pattern,async r=>{if(r.request().method()!=='PATCH')return r.continue();try{const response=await r.fetch();assert.equal(response.status(),200);arrived.resolve();await release.promise;await r.fulfill({response});}catch(e){if(!/closed|cancel|abort|disposed|already handled/i.test(e.message))throw e;}finally{handled.resolve();}});
    await d.getByRole('button',{name:operation==='edit'?'儲存':'確認撤回草稿',exact:true}).click();await arrived.promise;const committed=await get(entity,contextItem);assert.equal(committed.version,contextItem.version+1);await page.evaluate(()=>{location.hash='/cases';});await page.getByRole('dialog').waitFor({state:'detached'});await page.waitForLoadState('domcontentloaded');let lateListReads=0;const capture=r=>{if(r.method()==='GET'&&new URL(r.url()).pathname==='/api/announcements')lateListReads++;};page.on('request',capture);release.resolve();await handled.promise;await settle(page);await page.unroute(pattern);await assertNoSuccess(page);assert.equal(lateListReads,0);page.off('request',capture);assert.equal(await page.getByRole('dialog').count(),0);contextItem=committed;await resetPage();
  });mark('真伺服器先提交後context失效不顯成功/不重讀舊頁；Abort不被當成資料庫回滾');

  await readOnly('dirty-confirm-Escape-focus-native-intent-keyboard',async()=>{
    await findItem(page,main);const trigger=page.locator('.list-content tbody tr').getByRole('button',{name:'編輯',exact:true});await trigger.focus();await page.keyboard.press('Enter');let d=page.getByRole('dialog');await page.keyboard.press('Escape');await d.waitFor({state:'detached'});assert.ok(await trigger.evaluate(n=>n===document.activeElement));
    await trigger.click();d=page.getByRole('dialog');await input(d,'body').fill('合成尚未儲存的dirty內容');await page.keyboard.press('Escape');let c=page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true});await c.waitFor();await screenshot(page,'announcement-editor-dirty-confirm.png');await c.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await input(d,'body').inputValue(),'合成尚未儲存的dirty內容');await discard(page);assert.ok(await trigger.evaluate(n=>n===document.activeElement));
    d=await editItem(page,retry);await input(d,'body').fill('合成dirty-confirm失效');await page.keyboard.press('Escape');c=page.getByRole('dialog',{name:'放棄未儲存的內容？',exact:true});await c.waitFor();await page.evaluate(()=>{location.hash='/cases';});await page.waitForFunction(()=>document.querySelectorAll('dialog[open]').length===0);await assertNoSuccess(page);await screenshot(page,'announcement-editor-context-cleared.png');
    d=await editItem(page,nullAudience);const choice=intent(d,'audience');assert.equal(await choice.evaluate(n=>n.tagName),'SELECT');await choice.focus();await page.keyboard.press('Tab');assert.ok(await input(d,'status').evaluate(n=>n===document.activeElement));await page.keyboard.press('Shift+Tab');assert.ok(await choice.evaluate(n=>n===document.activeElement));await choice.selectOption('replace');assert.ok(await input(d,'audience').isEnabled());await choice.selectOption('clear');assert.ok(await input(d,'audience').isDisabled());await choice.selectOption('keep');assert.ok(await input(d,'audience').isDisabled());await discard(page);
  });mark('dirty返回編輯/放棄/guard清除、Enter/Escape/Tab焦點；native意圖三態語義操作，不宣稱OS popup幾何');

  await readOnly('four-real-session-write-denial-and-history-preserved',async()=>{
    for(const actor of[{client:context,auth:admin,page},supervisor,finance,caregiver]){for(const suffix of['','/history','/history?compare=previous']){await request('GET',`${entity}/${main.id}${suffix}`,undefined,200,actor);await request('GET',`${entity}/${foreign.id}${suffix}`,undefined,404,actor);}const trigger=await findItem(actor.page,main);if([finance,caregiver].includes(actor)){assert.equal(await actor.page.getByRole('button',{name:/^(新增公告|編輯|撤回草稿)$/}).count(),0);for(const[method,path,data]of[['POST',entity,dataFor('合成拒寫')],['PATCH',`${entity}/${main.id}`,{version:main.version,body:'合成拒寫'}]])await request(method,path,data,403,actor);}const d=await openHistory(actor.page,trigger,title,main.version);await d.getByText('操作者（目前名稱）',{exact:true}).first().waitFor();await assertNoSecrets(d);if(actor===finance)await screenshot(actor.page,'announcement-editor-finance-readonly-history.png');if(actor===caregiver)await screenshot(actor.page,'announcement-editor-caregiver-readonly-history.png');await closeHistory(actor.page,trigger);}
  });mark('四真session讀取及history保持；finance/caregiver無寫入入口且server403，跨機構404');

  const longText='  合成編輯長文開始\n'+Array.from({length:24},(_,i)=>`第${i+1}段：保留使用者文字、換行與全形空白　不代表外部訊息寄送。`).join('\n')+'\n合成編輯長文結尾  ';
  let longItem=await written('normal-long-text-fixture',()=>post(entity,dataFor('EDIT-LONG 合成窄屏長文',{body:longText,audience:'NEVER_RENDER_UNKNOWN_LONG'})));
  await readOnly('desktop-390px-native-form-fulltext-and-safe-intent',async()=>{
    let d=await editItem(page,longItem);assert.equal(await input(d,'body').inputValue(),longText);await inspectLayout(page);await screenshot(page,'announcement-editor-longtext-desktop.png');await page.setViewportSize({width:390,height:844});await inspectLayout(page);await input(d,'body').scrollIntoViewIfNeeded();await screenshot(page,'announcement-editor-longtext-mobile.png');await input(d,'body').evaluate(n=>{n.scrollTop=n.scrollHeight;});assert.ok(await input(d,'body').evaluate(n=>n.scrollTop+n.clientHeight>=n.scrollHeight-1));await screenshot(page,'announcement-editor-longtext-mobile-end.png');assert.equal(await input(d,'body').inputValue(),longText);await intent(d,'audience').scrollIntoViewIfNeeded();await noUnsafe(d);await screenshot(page,'announcement-editor-keep-mobile.png');await intent(d,'audience').selectOption('replace');await input(d,'audience').selectOption('caregiver');await inspectLayout(page);await screenshot(page,'announcement-editor-replace-mobile.png');await intent(d,'audience').selectOption('clear');await screenshot(page,'announcement-editor-clear-mobile.png');await discard(page);await page.setViewportSize({width:1440,height:1050});
  });mark('1440/390語義欄位與意圖、完整長textarea原文/尾端、單欄捲動和取消零寫');

  const repaired=invalidRequired[0];await written('required-import-after422-user-explicit-repair',async()=>{const d=await editItem(page,repaired);await d.getByRole('button',{name:'儲存',exact:true}).click();await alertVisible(d);assert.ok(await input(d,'title').isDisabled());assert.ok(await intent(d,'title').isEnabled());await intent(d,'title').selectOption('replace');await input(d,'title').fill('EDIT-REQUIRED-1 合成明確修復');await saveWithPayload(page,repaired);const saved=await get(entity,repaired);assert.equal(saved.title,'EDIT-REQUIRED-1 合成明確修復');assert.equal(saved.version,2);});mark('原required422指向停用保存欄位時intent仍可操作；真取代修復後可保存且保留初版');

  fixtureNotes.push('All execution uses memory SQLite/random localhost/synthetic fixtures only; no actual 4310 database or original platform. Normal announcement and arbitrary audience strings use validated API/UI; nonstring/missing/null data are explicit INSERT-only memory imports, never updates/deletes of immutable versions.',
    'Four real login sessions test server permissions. Separate user/role/employee browser context mutations only test client display invalidation, not server membership revocation. Edit sources are list row snapshots; no fresh GET before editing or automatic CAS overwrite is claimed.',
    'Response fixtures are labelled submittedToServer or no-fetch. Real committed response uncertainty is separately tested; context abort does not roll back committed data. POST retry uses the same key and payload; ambiguous PATCH retries receive CAS409.',
    'Keyboard Enter/Escape/Tab/Shift+Tab and native selectOption states are verified. Headless native popup keyboard value selection is not verified; OS-owned popup geometry is not claimed.',
    'Existing synthetic PDF_BYTES are a BLOB fixture; zero new PDF artifacts and zero operation markers.');
  const blobDownloads=[],reportEndpoints=[];
  await readOnly('eleven-tables-billing-two-blobs-and-31-report-outlets',async()=>{
    assert.deepEqual(await get('service-records',record),approved);assert.deepEqual(await request('GET','reports/fees?month=2026-10'),fees);assert.deepEqual(await request('GET','reports/payroll?month=2026-10'),payroll);for(const[kind,item]of[['cases',careCase],['care-plans',plan],['service-items',service],['employees',employeeA],['employees',employeeB]])assert.deepEqual(await get(kind,item),item);
    for(const kind of['cases','shifts','services','fees','payroll'])for(const ext of['','.csv']){const route=`reports/${kind}${ext}?month=2026-10`,r=await context.request.get(`${base}/api/${route}`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200);if(ext)assert.ok((await r.text()).startsWith('\uFEFF'));else assert.ok(Array.isArray((await r.json()).rows));reportEndpoints.push(route);}
    for(const kind of['shift-report','service-report','case-report','employee-report','leave-report','training-report','certification-report'])for(const ext of['','/export','.csv']){const query=kind==='employee-report'?'':'?startDate=2026-01-01&endDate=2026-12-31'+(kind==='certification-report'?'&asOf=2026-10-08':'');const route=`${kind}${ext}${query}`,r=await context.request.get(`${base}/api/${route}`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200,route);if(ext==='.csv')assert.ok((await r.text()).startsWith('\uFEFF'));else assert.ok(Array.isArray((await r.json()).rows));reportEndpoints.push(route);}
    for(const[kind,item,bytes]of[['case-attachments',caseAttachment,PDF_BYTES],['certification-attachments',certAttachment,PNG_BYTES]]){const r=await context.request.get(`${base}/api/${kind}/${item.id}/download`,{headers:{'X-Org-Id':orgId}});assert.equal(r.status(),200);const actual=await r.body();assert.deepEqual(actual,bytes);assert.equal(digest(actual),item.sha256);blobDownloads.push({entity:kind,bytes:actual.length,sha256:digest(actual),matchesOriginal:true});}
  });
  assert.equal(invalidationChecks.length,24);assert.equal(reportEndpoints.length,31);assert.equal(Object.keys(rawState()).length,11);assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n,6);assert.deepEqual(pageErrors,[]);assert.deepEqual(failedResponses.filter(r=>!r.expected),[]);assert.ok(consoleErrors.every(s=>/403|404|409|422|503|ERR_FAILED|ERR_ABORTED/.test(s)),JSON.stringify(consoleErrors));const accountedChanges=writeSegments.reduce((n,s)=>n+s.after.changes-s.before.changes,0);assert.equal(counts().changes-initialCounts.changes,accountedChanges);mark('完整11表raw/count/total_changes逐段零寫；6trigger/雙BLOB bytes與SHA/核閱費薪主檔/31報表保持');
  await rm(path.join(output,'failure.png'),{force:true});
  const sourceFiles=['tests/announcement-edit-safety-e2e.mjs','src/server/history.mjs','src/server/model.mjs','public/modules/admin.js','public/modules/history.js','public/data/announcement-editor.js','public/ui.js','public/styles.css'];const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,digest(await readFile(path.join(root,file)))])));
  await writeFile(path.join(output,'e2e.json'),JSON.stringify({passed:true,completedAt:new Date().toISOString(),executionRoot:root,scope:'Synthetic memory SQLite/random localhost/real Chromium; no actual 4310/data/original platform.',checks,screenshots,readSegments,writeSegments,initialCounts,finalCounts:counts(),accountedChanges,invalidationChecks,confirmationChecks,payloadChecks,fixtureNotes,blobDownloads,reportEndpoints,pageErrors,consoleErrors,failedResponses,all11TablesUnchangedDuringReads:true,blobTablesNonempty:{attachment_files:1,certification_attachment_files:1},immutableTriggers:6,approvedBillingSnapshotUnchanged:true,pdfOperations:0,pdfMarkers:0,sourceHashes,visualReviewPending:true},null,2));console.log(`Announcement edit safety E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${readSegments.length} read segments`);
}catch(error){if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:path.join(output,'failure.png'),fullPage:false}).catch(()=>{});await writeFile(path.join(output,'e2e.json'),JSON.stringify({passed:false,completedAt:new Date().toISOString(),executionRoot:root,checks,screenshots,pageErrors,consoleErrors,failedResponses,readSegments,writeSegments,invalidationChecks,confirmationChecks,payloadChecks,fixtureNotes,error:error.stack,pdfOperations:0,pdfMarkers:0},null,2));throw error;}
finally{for(const context of contexts)await context.close();await browser?.close();await app.close();}
