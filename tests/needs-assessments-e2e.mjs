import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

// Owned synthetic memory factory only. No default server, disk DB, environment,
// real account, Portal binding, private backup, DNS or deployment is contacted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = path.join(root, 'outputs/software/needs-assessments-qa');
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, 'browser-attempt-'));
console.log('EVIDENCE ' + output);
const { chromium } = createRequire(import.meta.url)('playwright');
const installed = await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')).catch(() => []);
const executablePath = [chromium.executablePath(), ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(os.homedir(), 'Library/Caches/ms-playwright', name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(file => file && existsSync(file));
const app = createApp({ dbPath: ':memory:', port: 0 });
const endpoint = 'needs-assessments', entity = 'assessments', password = 'synthetic-needs-browser-password';
const answerKeys = Array.from({ length: 9 }, (_, i) => 'q' + String(i + 1).padStart(3, '0'));
const templateId = 'assessment-03';
const dtoKeys = ['id','orgId','version','templateId','caseId','caseNo','caseName','date','status','answerContainerKind','hasUnknownAnswerKeys','answers'];
const emptyFilters = { q: '', status: '', date: '', caseId: '' };
const names = { page: '需求評估查詢', search: '搜尋需求評估內容', detail: '需求評估保存內容', history: '評鑑填答版本歷程' };
const checks = [], readSegments = [], fixtureWrites = [], contextChecks = [], referenceChecks = [], outerRebuildChecks = [], projectionChecks = [], malformedChecks = [], requestLedger = [], stateLedger = [], footerChecks = [], screenshots = [], pageErrors = [], consoleErrors = [], failedResponses = [], failedRequests = [], expectedFailures = [], contexts = [];
let browser, base, lastPage, queryBaseline, queryCounts, stage = 'initialization';
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { sqliteInteger: item.toString() } : item);
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');
const same = (a, b, message) => assert.deepEqual(a, b, message);
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return { schema, tables: Object.fromEntries(tables.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })) };
};
const counts = () => ({ totalChanges: app.db.prepare('SELECT total_changes() n').get().n, records: app.db.prepare('SELECT count(*) n FROM records').get().n, versions: app.db.prepare('SELECT count(*) n FROM record_versions').get().n, audit: app.db.prepare('SELECT count(*) n FROM audit').get().n, idempotency: app.db.prepare('SELECT count(*) n FROM idempotency').get().n });
const readOnly = async (label, action) => {
  stage=label; const before=raw(), beforeCounts=counts(); const result=await action(); const after=raw(), afterCounts=counts();
  same(after,before,label+': exact eleven tables/six triggers/schema/BLOB');same(afterCounts,beforeCounts,label+': total_changes exactly zero');
  const segment={sequence:stateLedger.length,label,tableCount:11,triggerCount:6,beforeSha256:sha(before),afterSha256:sha(after),beforeCounts,afterCounts,zeroWrites:true};readSegments.push(segment);stateLedger.push({kind:'read',...segment});return result;
};
const fixtureWrite=async(label,action)=>{
  stage=label;const before=raw(),beforeCounts=counts(),result=await action(),after=raw(),afterCounts=counts();same(before.schema,after.schema,'Synthetic fixture schema/six triggers unchanged');
  const segment={sequence:stateLedger.length,label,fixtureOnly:true,beforeSha256:sha(before),afterSha256:sha(after),beforeCounts,afterCounts,totalChangesDelta:afterCounts.totalChanges-beforeCounts.totalChanges,changedTables:Object.keys(before.tables).filter(key=>sha(before.tables[key])!==sha(after.tables[key]))};
  if(label.includes('membership role'))assert.equal(segment.totalChangesDelta,1,'Only one explicitly owned synthetic membership cell changes');
  if(label.includes('raw projected needs rows')){const inserted=afterCounts.records-beforeCounts.records;assert.equal(afterCounts.versions-beforeCounts.versions,inserted-1,'Only named unsafe BigInt fixture has no history row');assert.equal(segment.totalChangesDelta,inserted*2-1);same(segment.changedTables.sort(),['record_versions','records']);}
  if(label.includes('authorized synthetic supervisor')){
    assert.equal(segment.totalChangesDelta,3,'One assessment update, one version, one audit');assert.equal(afterCounts.records,beforeCounts.records);assert.equal(afterCounts.versions-beforeCounts.versions,1);assert.equal(afterCounts.audit-beforeCounts.audit,1);assert.equal(afterCounts.idempotency,beforeCounts.idempotency);
    const target=result.item;assert.equal(target.id,result.original.id,'Target bound to callback pre-request original id');assert.equal(target.orgId,result.original.orgId);same(target.answers,result.requestedAnswers,'Exact intended nine saved answers');for(const key of ['caseId','templateId','date','status'])same(target[key],result.original[key],'Fixture only changes answers '+key);
    const oldTarget=before.tables.records.find(row=>row.id===result.original.id);assert(oldTarget);same(JSON.parse(oldTarget.data),Object.fromEntries(['caseId','templateId','date','answers','status'].map(key=>[key,result.original[key]])),'Original target exact raw payload before request');
    const changed=after.tables.records.filter(row=>sha(row)!==sha(before.tables.records.find(old=>old.id===row.id)));assert.equal(changed.length,1);assert.equal(changed[0].entity,entity);assert.equal(changed[0].id,target.id);assert.equal(oldTarget.version+1n,changed[0].version);assert.equal(changed[0].version,BigInt(target.version));assert.equal(target.version,3);
    same(JSON.parse(changed[0].data),Object.fromEntries(['caseId','templateId','date','answers','status'].map(key=>[key,target[key]])),'Exact target business payload');
    same(after.tables.records.filter(row=>row.id!==target.id),before.tables.records.filter(row=>row.id!==target.id),'Every other assessment and non-assessment raw record exact');
    const additions=after.tables.record_versions.filter(row=>!before.tables.record_versions.some(old=>old.record_id===row.record_id&&old.version===row.version));assert.equal(additions.length,1);const version=additions[0];assert.equal(version.record_id,target.id);assert.equal(version.entity,entity);assert.equal(version.org_id,target.orgId);assert.equal(version.version,3n);assert.equal(version.source,'update');same(JSON.parse(version.snapshot),target,'Only target full version3 snapshot appended');
    same(after.tables.record_versions.filter(row=>row!==version),before.tables.record_versions,'Every existing version raw row unchanged');
    const auditAdds=after.tables.audit.filter(row=>!before.tables.audit.some(old=>old.id===row.id));assert.equal(auditAdds.length,1);const audit=auditAdds[0];assert.equal(audit.record_id,target.id);assert.equal(audit.entity,entity);assert.equal(audit.org_id,target.orgId);assert.equal(audit.user_id,result.actorUserId);assert.equal(audit.action,'record.update');same(JSON.parse(audit.detail),{fields:['answers'],fromStatus:target.status,toStatus:target.status,version:3});same(after.tables.audit.filter(row=>row!==audit),before.tables.audit,'Every existing audit raw row exact');
    for(const name of Object.keys(before.tables))if(!['records','record_versions','audit'].includes(name))same(after.tables[name],before.tables[name],'Every other table unchanged including BLOBs, memberships, sessions and ledger');
  }
  fixtureWrites.push(segment);stateLedger.push({kind:'fixture',...segment});queryBaseline=after;queryCounts=afterCounts;return result;
};
const expectFailure = rule => { assert(!expectedFailures.some(item => item.id === rule.id)); expectedFailures.push(rule); };
const observe = page => {
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('request', request => { if(new URL(request.url()).pathname.startsWith('/api/')) requestLedger.push({stage,url:request.url(),method:request.method()}); });
  page.on('pageerror', error => pageErrors.push({ stage, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ stage, text: message.text(), location: message.location() }); });
  page.on('response', response => { if (response.status() < 400) return; const rule = expectedFailures.find(item => item.kind === 'http' && item.phase === stage && item.url === response.url() && item.method === response.request().method() && item.status === response.status()); failedResponses.push({ stage, url: response.url(), method: response.request().method(), status: response.status(), expectedRuleId: rule?.id || null }); });
  page.on('requestfailed', request => { const failure = request.failure()?.errorText || ''; const rule = expectedFailures.find(item => item.kind === 'requestfailed' && item.phase === stage && item.url === request.url() && item.method === request.method() && item.failure === failure); failedRequests.push({ stage, url: request.url(), method: request.method(), failure, expectedRuleId: rule?.id || null }); });
};
const rows = page => page.locator('.list-content tbody tr');
const waitList = page => page.locator('.list-content .loading').waitFor({ state: 'detached' });
const load = async page => { lastPage = page; const target = base + '/#/needs-assessments'; if (page.url() === target) await page.reload(); else await page.goto(target); await page.getByRole('heading', { name: names.page, level: 1, exact: true }).waitFor(); await page.waitForLoadState('networkidle'); };
const listResponse = (page, predicate) => page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/' + endpoint && predicate(new URL(response.url())));
const search = async (page, q) => { const input = page.getByLabel(names.search, { exact: true }); await input.fill(q); const received = listResponse(page, url => (url.searchParams.get('q') || '') === q); await input.press('Enter'); const response = await received; assert.equal(response.status(), 200, await response.text()); await waitList(page); return response.json(); };
const filter = async (page, label, value, key) => { const received = listResponse(page, url => (url.searchParams.get(key) || '') === value); const control = page.getByLabel(label, { exact: true }); if (key === 'date') await control.fill(value); else await control.selectOption(value); const response = await received; assert.equal(response.status(), 200, await response.text()); await waitList(page); return response.json(); };
const findRow = async (page, q) => { const response = await search(page, q); assert.equal(response.total, 1); assert.equal(await rows(page).count(), 1); return rows(page).first(); };
const openDetails = async (page, q) => { const row = await findRow(page, q), trigger = row.getByRole('button', { name: '查看完整內容', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: names.detail, exact: true }); await dialog.waitFor(); return { dialog, trigger }; };
const openHistory = async (page, q) => { const row = await findRow(page, q), trigger = row.getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); const dialog = page.getByRole('dialog', { name: names.history, exact: true }); await dialog.waitFor(); return { dialog, trigger }; };
const close = async (page, trigger) => { const actual = page.locator('dialog').last(); assert.equal(await actual.count(),1); await page.keyboard.press('Escape'); await actual.waitFor({ state:'detached' }); if(trigger) { await page.waitForFunction(node=>node===document.activeElement,await trigger.elementHandle()); assert(await trigger.evaluate(node=>node===document.activeElement),'Actual native close removes DOM and restores exact trigger focus before next action'); } };
const noSecrets = async locator => assert(!/HIDDEN_NESTED|HIDDEN_ARRAY|HIDDEN_UNKNOWN|UNKNOWN_KEY|METADATA_SEARCH_ONLY|BILLING_SECRET|\[object Object\]/.test(await locator.textContent()), 'Nested/unknown/metadata/JSON content stays hidden');
const layout = async page => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No full-page horizontal overflow');
  same(await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name)), [], 'Visible native controls labelled');
  for (const dialog of await page.getByRole('dialog').all()) assert(await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Dialog fits viewport');
  for (const table of await page.locator('.table-scroll').all()) if (await table.isVisible()) assert.equal(await table.evaluate(node => getComputedStyle(node).overflowX), 'auto');
};
const shot = async (page, name) => { assert(screenshots.length < 16, 'Maximum sixteen actual screenshots'); await layout(page); const absolutePath=path.join(output,name);await page.screenshot({ path:absolutePath,fullPage:false });screenshots.push({name,path:absolutePath,sha256:sha(await readFile(absolutePath)),viewport:page.viewportSize(),actuallyViewed:false}); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), 15000); timer.unref(); })]);
const held = async (page, pattern, predicate) => {
  const arrived = deferred(), release = deferred(), handled = deferred(); let used = false, finished = false;
  const handler = async route => { if (used || !predicate(route.request())) return route.continue(); used = true; try { const response = await route.fetch(); arrived.resolve({ url: route.request().url(), method: route.request().method(), response }); await release.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed|already handled/i.test(error.message)) throw error; } finally { handled.resolve(); } };
  await page.route(pattern, handler);
  return { arrived: arrived.promise, async finish() { if (finished) return; finished = true; release.resolve(); if (used) await bounded(handled.promise, 'held response'); await page.unroute(pattern, handler); } };
};
const expectAbort = (page, ruleId, arrival) => { assert.equal(arrival.method, 'GET'); expectFailure({ id: ruleId, kind: 'requestfailed', phase: stage, url: arrival.url, method: 'GET', failure: 'net::ERR_ABORTED', count: 1, maxConsoleCount: 1, clientContextOrEscapeAbort: true }); return page.waitForEvent('requestfailed', request => request.url() === arrival.url && request.method() === 'GET' && request.failure()?.errorText === 'net::ERR_ABORTED'); };
const mutateContext = async (page, primitive, foreignOrg) => page.evaluate(async ({ primitive, foreignOrg }) => {
  const ui = await import('/ui.js'), current = ui.getContext();
  if (primitive === 'hash') { location.hash = '/employees'; return; }
  if (primitive === 'render') { document.querySelector('[data-render-version]').dataset.renderVersion = crypto.randomUUID(); return; }
  if (primitive === 'user') current.user.id = 'synthetic-needs-other-user';
  if (primitive === 'org') { current.organizationId = foreignOrg; current.orgId = foreignOrg; }
  if (primitive === 'role') { current.role = 'finance'; current.user.role = 'finance'; }
  if (primitive === 'employee') current.user.employeeId = 'synthetic-needs-other-employee';
  const mounted = document.querySelector('[data-render-version]'); mounted.setAttribute('data-render-version', mounted.dataset.renderVersion);
}, { primitive, foreignOrg });
const replaceNestedReferences = async page => page.evaluate(async () => { const ui = await import('/ui.js'), current = ui.getContext(); const before = JSON.stringify([current.user?.id ?? null, current.organizationId ?? current.orgId ?? null, current.role ?? null, current.user?.employeeId ?? null]); const user = current.user, orgs = current.organizations; current.user = { ...current.user }; current.organizations = current.organizations.map(item => ({ ...item })); if (user === current.user || orgs === current.organizations) throw new Error('Nested references did not change'); const after = JSON.stringify([current.user?.id ?? null, current.organizationId ?? current.orgId ?? null, current.role ?? null, current.user?.employeeId ?? null]); if (before !== after) throw new Error('Reference negative changed primitives'); const mounted = document.querySelector('[data-render-version]'); mounted.setAttribute('data-render-version', mounted.dataset.renderVersion); return { before, after, outerReferenceKept: current === ui.getContext(), userAndOrganizationReferencesChanged: true }; });
const suffixGeometry = async (locator, lastLine, literal) => {
  await locator.evaluate(node => node.scrollIntoView({ block: 'end' }));
  await locator.evaluate(node => { const dialog = node.closest('dialog'), footer = dialog.querySelector(':scope > .dialog-footer'); dialog.scrollTop += Math.max(0, node.getBoundingClientRect().bottom - footer.getBoundingClientRect().top + 20); });
  return locator.evaluate((node, { lastLine, literal }) => {
    const dialog = node.closest('dialog'), footer = dialog.querySelector(':scope > .dialog-footer').getBoundingClientRect(), area = dialog.getBoundingClientRect(); const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let textNode; while (walker.nextNode()) if (walker.currentNode.textContent.includes(literal)) textNode = walker.currentNode; if (!textNode) throw new Error('Real saved suffix text node absent');
    const measure = text => { const start = textNode.textContent.lastIndexOf(text); if (start < 0) throw new Error('Saved suffix absent'); const range = document.createRange(); range.setStart(textNode, start); range.setEnd(textNode, start + text.length); return [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => { const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, insideDialogAboveFooter: rect.top >= Math.max(0, area.top) && rect.bottom <= Math.min(innerHeight, footer.top) && rect.left >= Math.max(0, area.left) && rect.right <= Math.min(innerWidth, area.right), hitTestVisible: Boolean(hit && (hit === node || node.contains(hit))) }; }); };
    return { actualCloseFooterSelector: ':scope > .dialog-footer', footerTop: footer.top, dialogTop: area.top, scrollTop: dialog.scrollTop, clientHeight: dialog.clientHeight, scrollHeight: dialog.scrollHeight, lastLineRects: measure(lastLine), finalLiteralRects: measure(literal) };
  }, { lastLine, literal });
};

// Same explicit-base source allowlist as the accepted private evidence helper.
// Only .env.portal.example is synthetic source; no actual env or data is read.
const collectSources=async(baseDirectory)=>{
  assert.equal(path.resolve(baseDirectory),root,'Source collector must receive this exact owned source copy explicitly');
  const files=['BUILD_STATE.md','PRODUCT.md','README.md','DESIGN.md','UX-CONTRACT.md','package.json','premium-ui.json','.env.portal.example','.gitignore'];
  const suffixes=new Set(['.mjs','.js','.json','.md','.html','.css','.svg','.png']);
  const walk=async dir=>{for(const e of await readdir(path.join(baseDirectory,dir),{withFileTypes:true})){const n=path.join(dir,e.name);if(e.isDirectory())await walk(n);else if(e.isFile()&&suffixes.has(path.extname(e.name)))files.push(n);}};
  for(const dir of ['public','src','tests','scripts','docs'])await walk(dir);
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async n=>[n,sha(await readFile(path.join(baseDirectory,n)))])));
};
let sourceHashesBefore;

try {
  sourceHashesBefore=await collectSources(root);
  base=await app.listen();assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'4310');
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const adminClient=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'Asia/Taipei',reducedMotion:'reduce'});contexts.push(adminClient);
  const setup=await fixtureWrite('owned synthetic setup/session',()=>adminClient.request.post(base+'/api/setup',{headers:{Origin:base},data:{name:'合成需求評估管理員',email:'needs-admin@example.test',password,organizationName:'合成需求評估甲機構'}}));
  assert.equal(setup.status(),201,await setup.text());const adminAuth=await setup.json(),orgId=adminAuth.organizations[0].id;
  const admin=await adminClient.newPage();observe(admin);const actors={admin:{client:adminClient,auth:adminAuth,page:admin}};
  const request=async(method,route,data,expected=200,actor=actors.admin,selectedOrg=orgId,headers={})=>{
    const response=await actor.client.request.fetch(base+'/api/'+route,{method,headers:{Origin:base,'X-Org-Id':selectedOrg,'X-CSRF-Token':actor.auth.csrfToken,...headers},...(data===undefined?{}:{data})});
    const value=await response.json();assert.equal(response.status(),expected,method+' '+route+' '+json(value));return value;
  };
  const post=async(kind,data,selectedOrg=orgId)=>(await request('POST',kind,data,201,actors.admin,selectedOrg)).item;
  const patch=async(item,data,actor=actors.admin)=>(await request('PATCH',entity+'/'+item.id,{version:item.version,...data},200,actor)).item;
  let employee,foreign,caseA,caseB,closedCase,foreignCase,approved;
  await fixtureWrite('four roles/three owned logins and two orgs',async()=>{
    employee=await post('employees',{employeeNo:'NEEDS-E01',name:'合成需求評估居服',role:'caregiver',hourlyRateCents:12345});
    for(const role of ['supervisor','finance','caregiver']){
      await post('users',{name:'合成需求評估'+role,email:'needs-'+role+'@example.test',password,role,...(role==='caregiver'?{employeeId:employee.id}:{})});
      const client=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'Asia/Taipei',reducedMotion:'reduce'});contexts.push(client);
      const login=await client.request.post(base+'/api/login',{headers:{Origin:base},data:{email:'needs-'+role+'@example.test',password}});assert.equal(login.status(),200);
      const page=await client.newPage();observe(page);actors[role]={client,auth:await login.json(),page};
    }
    foreign=await post('organizations',{name:'合成需求評估乙機構'});
    caseA=await post('cases',{caseNo:'NEEDS-SAME-A',name:'合成同名目前個案'});caseB=await post('cases',{caseNo:'NEEDS-SAME-B',name:'合成同名目前個案'});
    caseB=(await request('PATCH','cases/'+caseB.id,{version:caseB.version,status:'paused'})).item;
    closedCase=await post('cases',{caseNo:'NEEDS-CLOSED',name:'合成已結案目前個案'});closedCase=(await request('PATCH','cases/'+closedCase.id,{version:closedCase.version,status:'closed'})).item;
    foreignCase=await post('cases',{caseNo:'NEEDS-FOREIGN',name:'合成乙機構不得顯示'},foreign.id);
  });
  await readOnly('G1 empty module and denied roles before parsing',async()=>{
    await load(admin);assert.equal(await rows(admin).count(),0);await shot(admin,'empty-desktop.png');
    for(const role of ['finance','caregiver']){
      const actor=actors[role];await actor.page.goto(base+'/#/');await actor.page.waitForLoadState('networkidle');assert.equal(await actor.page.getByRole('link',{name:names.page,exact:true}).count(),0);
      for(const [method,route,data] of [['GET',endpoint+'?unknown=1'],['GET',endpoint+'/invalid?unknown=1'],['POST',endpoint,{unknown:'not-read'}],['PATCH',endpoint+'/invalid',{}],['DELETE',endpoint+'/invalid',undefined]])await request(method,route,data,403,actor);
      await actor.page.goto(base+'/#/needs-assessments');await actor.page.waitForLoadState('networkidle');assert.equal(await actor.page.getByRole('button',{name:'查看完整內容',exact:true}).count(),0);
    }
  });
  await fixtureWrite('synthetic unknown membership role',()=>app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('synthetic_unknown',orgId,actors.supervisor.auth.user.id));
  await readOnly('G1 unknown membership preparse denial',async()=>{await request('GET',endpoint+'?unknown=1',undefined,403,actors.supervisor);await request('POST',endpoint+'/invalid',{},403,actors.supervisor);});
  await fixtureWrite('restore synthetic membership role',()=>app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('supervisor',orgId,actors.supervisor.auth.user.id));
  mark('G1 synthetic memory/randomloopback／twoorg fourroles／empty／finance-caregiver-unknown preparse403');

  const lastTreatment='合成完整處遇第160行：只供人工閱讀。',treatmentLiteral='合成手機處遇最後一行完整可讀';
  const lastNote='合成完整備註第160行：保留原文。',noteLiteral='合成手機需求備註最後一行完整可讀';
  const longTreatment='NEEDS-MAIN 合成完整處遇開頭\n'+Array.from({length:160},(_,i)=>'合成完整處遇第'+(i+1)+'行：只供人工閱讀。').join('\n')+'\n'+treatmentLiteral;
  const longNote='合成完整備註開頭\n'+Array.from({length:160},(_,i)=>'合成完整備註第'+(i+1)+'行：保留原文。').join('\n')+'\n'+noteLiteral;
  let main,typed,emptyText,moved,otherTemplate,foreignItem,previousMain;const pageItems=[],containers=[],corrupts=[];
  const imported=(caseId,data,selectedOrg=orgId,options={})=>{
    const time=now(),item={...data,caseId,id:options.id??id(),orgId:selectedOrg,version:options.version??1,createdAt:time,updatedAt:time};
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id,selectedOrg,options.entity||entity,JSON.stringify({...data,caseId}),item.version,time,time);
    if(options.history!==false)app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(selectedOrg,options.entity||entity,item.id,item.version,JSON.stringify(item,(_k,v)=>typeof v==='bigint'?v.toString():v),time,'baseline');return item;
  };
  await fixtureWrite('synthetic snapshot/two nonempty BLOBs and saved assessment history',async()=>{
    const service=await post('service-items',{code:'NEEDS-SERVICE',name:'合成既有服務',minutes:60,unitPriceCents:12345});
    const plan=await post('care-plans',{caseId:caseA.id,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',services:[{serviceItemId:service.id,quantity:10}]});
    const shift=await post('shifts',{caseId:caseA.id,employeeId:employee.id,carePlanId:plan.id,date:'2026-10-20',startTime:'09:00',endTime:'10:00',services:[{serviceItemId:service.id,quantity:1}]});
    let record=await post('service-records',{shiftId:shift.id,caseId:caseA.id,employeeId:employee.id,date:shift.date,actualStart:'09:00',actualEnd:'10:00',services:[{serviceItemId:service.id,quantity:1}],status:'submitted'});
    record=(await request('POST','service-records/'+record.id+'/review',{version:record.version,decision:'approved',reviewNote:'合成唯讀快照基準'})).item;approved=structuredClone(record);
    await post('case-attachments/upload',{caseId:caseA.id,title:'合成非空個案附件',category:'general',...filePayload(PDF_BYTES)});
    const certificate=await post('employee-certifications',{employeeId:employee.id,name:'合成證照',issuedOn:'2026-01-01'});
    await post('certification-attachments/upload',{certificationId:certificate.id,title:'合成非空證照附件',...filePayload(PNG_BYTES,'合成.png','image/png')});
    main=await post(entity,{caseId:caseA.id,templateId,date:'2026-10-10',status:'submitted',answers:{q001:'合成保存案主姓名',q002:'NEEDS-MAIN 合成保存照服員',q003:'不相容訪視日期 2026-02-30',q004:longTreatment,q005:longNote,q006:'合成保存督導文字',q007:'合成保存主管文字',q008:'0000-00-99 保存審閱日期',q009:'民國一一五年 保存填表日期'}});
    main=await patch(main,{answers:{...main.answers,q006:'合成前版督導保存文字'}});
    moved=await post(entity,{caseId:closedCase.id,templateId:'assessment-02',date:'2026-10-12',status:'draft',answers:{q001:'合成舊模板案主',q002:'合成舊模板擬定人'}});
    moved=await patch(moved,{caseId:caseB.id,templateId,answers:{q001:'合成跨案新模板案主',q002:'NEEDS-MOVED 合成跨案目前照服員',q004:'合成跨案目前處遇'}},actors.supervisor);
    otherTemplate=await post(entity,{caseId:caseA.id,templateId:'assessment-04',date:'2026-10-10',answers:{q002:'NOT-A-NEEDS'}});
    foreignItem=await post(entity,{caseId:foreignCase.id,templateId,date:'2026-10-10',answers:{q002:'NEEDS-FOREIGN 不顯示'}},foreign.id);
  });
  await fixtureWrite('raw projected needs rows only',async()=>{
    typed=imported(caseB.id,{templateId,date:'2026-10-11',status:'draft',answers:{q001:null,q002:'NEEDS-TYPED 合成型別定位',q003:'不解析原文日期',q004:'合成CR\rLF\n完整處遇',q006:['HIDDEN_ARRAY'],q007:{secret:'HIDDEN_NESTED'},q008:0,q009:false,UNKNOWN_KEY:'HIDDEN_UNKNOWN'},metadata:'METADATA_SEARCH_ONLY'});
    emptyText=imported(closedCase.id,{templateId,date:'0000-01-01',status:'draft',answers:{q001:'',q002:'NEEDS-EMPTY 合成空文字',q003:'',q004:'合成空文字定位',q005:''}});
    for(const answers of [null,['HIDDEN_ARRAY'],'HIDDEN_CONTAINER'])containers.push(imported(closedCase.id,{templateId,date:'2026-10-13',status:'draft',answers,metadata:'METADATA_SEARCH_ONLY'}));
    for(let i=0;i<28;i++)pageItems.push(imported(i%2?caseB.id:caseA.id,{templateId,date:i%2?'2026-10-11':'2026-10-10',status:i%3?'draft':'submitted',answers:{q001:'合成保存頁面案主',q002:'NEEDS-PAGE '+String(i+1).padStart(2,'0'),q003:'2026-01-01',q004:i%3?'合成結果ABC':'合成結果',q005:'DEF合成備註',q006:'NEEDS RAW SPACE 尾文',q008:'2026-01-02',q009:'2026-01-03',UNKNOWN_KEY:'HIDDEN_UNKNOWN'},metadata:'METADATA_SEARCH_ONLY'}));
    imported(id(),{templateId,date:'2026-10-10',status:'draft',answers:{q002:'NEEDS-ORPHAN'}});
    imported(foreignCase.id,{templateId,date:'2026-10-10',status:'draft',answers:{q002:'NEEDS-CROSS-PARENT'}});
    imported(caseA.id,{templateId:'assessment-04',date:'bad',status:'bad',answers:{q002:'NEEDS-OTHER-TEMPLATE'}});
    imported(caseA.id,{templateId,date:'2026-10-10',status:'draft',answers:{q002:'NEEDS-NONENTITY'}},orgId,{entity:'announcements'});
    for(const [label,values,options] of [['empty-id',{}, {id:''}],['zero-version',{}, {version:0}],['unsafe-version',{}, {version:9007199254740993n,history:false}],['date',{date:'2026-02-30'},{}],['status',{status:'saved_future'},{}]]){
      const item=imported(foreignCase.id,{templateId,date:'2026-10-10',status:'draft',...values,answers:{q002:'NEEDS-CORRUPT-'+label}},foreign.id,options);corrupts.push(item);
    }
  });
  const protectedBefore=raw();assert(approved.billingSnapshot);for(const name of ['attachment_files','certification_attachment_files'])assert(protectedBefore.tables[name].some(row=>Object.values(row).some(value=>value instanceof Uint8Array&&value.length>0)),'Owned '+name+' has a real nonempty BLOB');
  const protectedRaw=value=>({schema:value.schema,tables:Object.fromEntries(Object.entries(value.tables).map(([key,values])=>[key,['records','record_versions','audit'].includes(key)?values.filter(row=>row.entity!==entity):values]))});
  const assertProtected=()=>same(protectedRaw(raw()),protectedRaw(protectedBefore),'Non-assessment raw rows, BLOBs, snapshot and all schema unchanged');
  await readOnly('G2 exact twelve keys/nine tags,35 rows and true25 paging',async()=>{
    const result=await request('GET',endpoint+'?pageSize=25');same(Object.keys(result).sort(),['items','total','page','pageSize','filters'].sort());same(result.filters,emptyFilters);assert.equal(result.total,35);assert.equal(result.items.length,25);
    const parents=new Map([caseA,caseB,closedCase].map(x=>[x.id,x]));
    for(const row of result.items){same(Object.keys(row).sort(),dtoKeys.slice().sort());same(Object.keys(row.answers).sort(),answerKeys.slice().sort());assert.equal(row.templateId,templateId);assert.equal(row.orgId,orgId);assert(Number.isSafeInteger(row.version)&&row.version>0);assert(parents.has(row.caseId));assert.equal(row.caseName,parents.get(row.caseId).name);assert.equal(row.caseNo,parents.get(row.caseId).caseNo);}
    await load(admin);assert.equal(await rows(admin).count(),25);assert.equal(await admin.getByRole('button',{name:/新增|儲存|刪除|匯出|列印/}).count(),0);
    const cases=admin.getByLabel('個案篩選',{exact:true});for(const c of [caseA,caseB,closedCase])assert.equal(await cases.locator('option[value="'+c.id+'"]').count(),1);
    assert(/暫停/.test(await cases.locator('option[value="'+caseB.id+'"]').innerText()));assert(/已結案/.test(await cases.locator('option[value="'+closedCase.id+'"]').innerText()));await shot(admin,'list-desktop.png');
    const next=listResponse(admin,u=>u.searchParams.get('page')==='2');await admin.getByRole('button',{name:'下一頁',exact:true}).click();await next;await waitList(admin);assert.equal(await rows(admin).count(),10);
    for(const [c,total] of [[caseA,15],[caseB,16],[closedCase,4]]){const value=await filter(admin,'個案篩選',c.id,'caseId');assert.equal(value.total,total);assert(value.items.every(x=>x.caseId===c.id));}
    await load(actors.supervisor.page);assert.equal((await request('GET',endpoint,undefined,200,actors.supervisor)).total,35);
  });mark('G2 DTO12/tags9／35 real25+10／current names separate／same-name ID plus paused-closed');
  await readOnly('G3 four literal filters,28 unique pages and raw spaces search',async()=>{
    await load(admin);let result=await search(admin,'NEEDS-PAGE');assert.equal(result.total,28);const first=result.items.map(x=>x.id);
    const next=listResponse(admin,u=>u.searchParams.get('page')==='2'&&u.searchParams.get('q')==='NEEDS-PAGE');await admin.getByRole('button',{name:'下一頁',exact:true}).click();result=await(await next).json();await waitList(admin);assert.equal(await rows(admin).count(),3);same([...first,...result.items.map(x=>x.id)].sort(),pageItems.map(x=>x.id).sort());
    result=await filter(admin,'狀態','submitted','status');assert.equal(result.total,10);
    result=await filter(admin,'紀錄填寫日期篩選','2026-10-10','date');assert.equal(result.total,5);
    result=await filter(admin,'個案篩選',caseA.id,'caseId');assert.equal(result.total,5);same(result.filters,{q:'NEEDS-PAGE',status:'submitted',date:'2026-10-10',caseId:caseA.id});await shot(admin,'filtered-desktop.png');
    const dateCleared=listResponse(admin,u=>!u.searchParams.has('date'));await admin.getByRole('button',{name:'清除紀錄填寫日期',exact:true}).click();await dateCleared;await waitList(admin);assert(await admin.getByLabel('紀錄填寫日期篩選',{exact:true}).evaluate(n=>n===document.activeElement));
    const caseCleared=listResponse(admin,u=>!u.searchParams.has('caseId'));await admin.getByRole('button',{name:'清除個案條件',exact:true}).click();await caseCleared;await waitList(admin);await filter(admin,'狀態','','status');
    for(const q of ['HIDDEN_NESTED','HIDDEN_ARRAY','HIDDEN_UNKNOWN','HIDDEN_CONTAINER','UNKNOWN_KEY','METADATA_SEARCH_ONLY','合成同名目前個案','NEEDS-SAME-A','ABCDEF','NEEDS-ORPHAN','NEEDS-CROSS-PARENT','NEEDS-NONENTITY','NEEDS-OTHER-TEMPLATE'])assert.equal((await search(admin,q)).total,0,q+' not searchable metadata/nested/joined/other entity/template');await shot(admin,'no-results-desktop.png');
    result=await search(admin,' RAW SPACE ');same(result.filters,{...emptyFilters,q:' RAW SPACE '});assert.equal(result.total,28,'Actual native input/request preserves spaces');assert.equal(await admin.getByLabel(names.search,{exact:true}).inputValue(),' RAW SPACE ');
    assert.equal((await search(admin,' needs-page ')).total,0,'Leading/trailing query spaces are not trimmed');assert.equal((await search(admin,'needs-page')).total,28);
    assert.equal((await request('GET',endpoint+'?q=NEEDS-MAIN&date=2026-10-10')).total,1);await request('GET',endpoint+'?q=NEEDS-MAIN&date=2026-02-30',undefined,422);
    assert.equal((await request('GET',endpoint+'?q=NEEDS-PAGE&date=2026-01-01')).total,0,'Metadata date differs from q003 visit date');
    await search(admin,'NEEDS-MAIN');assert.equal(new URL(admin.url()).search,'');assert(!await admin.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('NEEDS-MAIN')));
  });mark('G3 28 real25+3 unique IDs／exactcase-date-status/q echo／rawspaces no trim／nine separate own strings only');
  await readOnly('G4 raw nine own questions and nonobject containers',async()=>{
    const value=(await request('GET',endpoint+'/'+typed.id)).item;assert.equal(value.answerContainerKind,'object');assert(value.hasUnknownAnswerKeys);
    for(const [key,expected] of Object.entries({q001:{kind:'null'},q002:{kind:'string',value:typed.answers.q002},q003:{kind:'string',value:typed.answers.q003},q004:{kind:'string',value:typed.answers.q004},q005:{kind:'missing'},q006:{kind:'array'},q007:{kind:'object'},q008:{kind:'number'},q009:{kind:'boolean'}}))same(value.answers[key],expected);
    const empty=(await request('GET',endpoint+'/'+emptyText.id)).item;same(empty.answers.q001,{kind:'string',value:''});same(empty.answers.q003,{kind:'string',value:''});assert.equal(empty.date,'0000-01-01');
    for(const item of containers){const result=(await request('GET',endpoint+'/'+item.id)).item;assert(!result.hasUnknownAnswerKeys);for(const key of answerKeys)same(result.answers[key],{kind:'missing'});}
    let opened=await openDetails(admin,'NEEDS-TYPED');await opened.dialog.getByText('NEEDS-TYPED 合成型別定位',{exact:true}).waitFor();await noSecrets(opened.dialog);assert.equal(await opened.dialog.getByRole('button',{name:/新增|儲存|編輯|刪除|匯出|列印/}).count(),0);await shot(admin,'typed-detail-desktop.png');await close(admin,opened.trigger);
    const saved=(await request('GET',endpoint+'/'+main.id)).item;for(const key of answerKeys)same(saved.answers[key],{kind:'string',value:main.answers[key]});assert.equal(saved.caseName,caseA.name);assert.notEqual(saved.caseName,saved.answers.q001.value);
    opened=await openDetails(admin,'NEEDS-MAIN');await opened.dialog.getByText(longTreatment,{exact:true}).waitFor();await opened.dialog.getByText(caseA.name,{exact:true}).waitFor();await opened.dialog.getByText(main.answers.q001,{exact:true}).waitFor();
    for(const key of ['q003','q008','q009']){const text=opened.dialog.getByText(main.answers[key],{exact:true});await text.waitFor();assert(await text.evaluate(n=>!n.closest('time')),'Saved answer date is literal text, no date parsing');}
    await noSecrets(opened.dialog);await close(admin,opened.trigger);projectionChecks.push({ownQuestionCount:9,rawCrLfExactApi:true,emptyStringsPreserved:true,nontextKindsHaveNoValue:true,threeAnswerDatesLiteral:true,currentVsSavedNameSeparate:true});
  });mark('G4 nine raw tags/ownpresence／CR-LF-empty/type containers／three answer dates literal／saved-current names separate');
  let capturedRow,capturedVersion;
  await readOnly('G5 capture list before separately accounted supervisor fixture change',async()=>{await load(admin);capturedRow=await findRow(admin,'NEEDS-MAIN');capturedVersion=(await request('GET',endpoint+'?q=NEEDS-MAIN')).items[0].version;assert.equal(capturedVersion,2);previousMain=structuredClone(main);});
  await fixtureWrite('authorized synthetic supervisor answers change after captured list',async()=>{const original=structuredClone(main),requestedAnswers={...main.answers,q006:'合成 fresh 目前督導保存文字'};main=await patch(main,{answers:requestedAnswers},actors.supervisor);assert.equal(main.version,3);return {item:main,original,requestedAnswers,actorUserId:actors.supervisor.auth.user.id};});assertProtected();
  await readOnly('G5 each open uses fresh single and exact identity',async()=>{
    let gets=0;const count=req=>{if(req.method()==='GET'&&req.url()===base+'/api/'+endpoint+'/'+main.id)gets++;};admin.on('request',count);
    try{const trigger=capturedRow.getByRole('button',{name:'查看完整內容',exact:true});await trigger.click();const dialog=admin.getByRole('dialog',{name:names.detail,exact:true});await dialog.getByText(main.answers.q006,{exact:true}).waitFor();await dialog.getByText(longTreatment,{exact:true}).waitFor();await dialog.getByText(longNote,{exact:true}).waitFor();await shot(admin,'detail-desktop.png');await close(admin,trigger);
      const opened=await openDetails(admin,'NEEDS-MAIN');await opened.dialog.getByText(main.answers.q006,{exact:true}).waitFor();await close(admin,opened.trigger);assert.equal(gets,2);
    }finally{admin.off('request',count);}projectionChecks.push({capturedVersion,freshVersion:main.version,actualSingleGets:gets});
  });mark('G5 real version2 list→fixtureversion3／two opens two fresh GETs／full nine answers current');
  await readOnly('G6 original assessment history actual actors and legal cross-template/case',async()=>{
    const result=await request('GET',entity+'/'+main.id+'/history?compare=previous');assert.equal(result.total,3);same(result.items.map(x=>x.actor.id),[actors.supervisor.auth.user.id,adminAuth.user.id,adminAuth.user.id]);same(result.items[0].snapshot,main);same(result.items[0].comparison.previousSnapshot,previousMain);
    for(const key of answerKeys)same(result.items[0].comparison.previousSnapshot.answers[key],previousMain.answers[key]);
    let opened=await openHistory(admin,'NEEDS-MAIN');await opened.dialog.getByText('合成需求評估supervisor',{exact:true}).waitFor();await opened.dialog.getByText('第 2 版',{exact:true}).click();await opened.dialog.getByText('合成需求評估管理員',{exact:true}).first().waitFor();await opened.dialog.getByText('合成前版督導保存文字',{exact:true}).first().waitFor();await shot(admin,'history-desktop.png');await close(admin,opened.trigger);
    const cross=await request('GET',entity+'/'+moved.id+'/history?compare=previous');assert.equal(cross.total,2);assert.equal(cross.items[0].actor.id,actors.supervisor.auth.user.id);assert.equal(cross.items[0].snapshot.caseId,caseB.id);assert.equal(cross.items[0].comparison.previousSnapshot.caseId,closedCase.id);assert.equal(cross.items[0].comparison.previousSnapshot.templateId,'assessment-02');
    opened=await openHistory(admin,'NEEDS-MOVED');await opened.dialog.getByText('模板已更換；兩組填答依各自目前題項展示，不將同名題號配對比較。',{exact:true}).waitFor();await opened.dialog.getByText('合成舊模板案主',{exact:true}).first().waitFor();await close(admin,opened.trigger);
    const templatesResponse=await adminClient.request.get(base+'/data/assessment-templates.json');assert.equal(templatesResponse.status(),200);const templates=await templatesResponse.json();assert.equal(templates.length,16);for(const route of [entity+'?caseId='+caseA.id,entity+'/'+main.id,entity+'/'+main.id+'/history?compare=previous'])await request('GET',route,undefined,200,actors.finance);
    const link=admin.getByRole('link',{name:'前往評估表單填寫',exact:true});assert.equal(await link.getAttribute('href'),'#/assessments');await link.click();await admin.getByRole('heading',{name:'個案評鑑表',level:1,exact:true}).waitFor();await admin.waitForLoadState('networkidle');assert.equal(await admin.locator('dialog').count(),0);await shot(admin,'assessments-sibling-desktop.png');
  });mark('G6 original exact previous/actor history／cross-template-crosscase authorised old版／16templates-finance/filling unchanged');
  await readOnly('G7 closed query and source identities safe metadata before pagination',async()=>{
    for(const route of [endpoint+'?page=1e2',endpoint+'?pageSize=0',endpoint+'?page=',endpoint+'?pageSize=101',endpoint+'?q=a&q=b',endpoint+'?unknown=1',endpoint+'?status=approved',endpoint+'?date=2026-02-30',endpoint+'?caseId='+encodeURIComponent('  '),endpoint+'/'+main.id+'?q=a'])await request('GET',route,undefined,422);
    for(const item of [foreignItem,otherTemplate,caseA,{id:id()}])await request('GET',endpoint+'/'+item.id,undefined,404);await request('GET',endpoint+'?caseId='+foreignCase.id,undefined,404);
    for(const item of corrupts){const value=await request('GET',endpoint+'?q='+encodeURIComponent(item.answers.q002),undefined,409,actors.admin,foreign.id);assert.equal(value.error.code,'NEEDS_ASSESSMENT_DATA_INVALID');}
    for(const method of ['POST','PATCH','DELETE']){await request(method,endpoint,{},405);await request(method,endpoint+'/'+main.id,{},405);}await request('GET',endpoint,undefined,200,actors.admin,orgId,{'Idempotency-Key':'synthetic-read-never-writes-ledger'});
  });mark('G7 exactquery422／wrong entity-template-org-parent404／filtered candidate metadata409 prepage／GET-only405 readzero');
  await readOnly('G8 untrusted list envelope/tags/echo and missing selected case',async()=>{
    for(const variant of ['missing-filters','short-page','duplicate-id','wrong-echo','wrong-org','wrong-parent','unsafe-version','wrong-template','invalid-date','invalid-status','extra-question','nested-tag']){
      await load(admin);let used=false;const handler=async route=>{if(used)return route.continue();used=true;const response=await route.fetch(),data=await response.json();
        if(variant==='missing-filters')delete data.filters;if(variant==='short-page')data.items.pop();if(variant==='duplicate-id')data.items[1]=structuredClone(data.items[0]);if(variant==='wrong-echo')data.filters.q='wrong-q';if(variant==='wrong-org')data.items[0].orgId=foreign.id;if(variant==='wrong-parent')data.items[0].caseId=foreignCase.id;
        if(variant==='unsafe-version')data.items[0].version=0;if(variant==='wrong-template')data.items[0].templateId='assessment-04';if(variant==='invalid-date')data.items[0].date='2026-02-30';if(variant==='invalid-status')data.items[0].status='future';if(variant==='extra-question')data.items[0].answers.UNKNOWN_KEY={kind:'string',value:'HIDDEN_UNKNOWN'};if(variant==='nested-tag')data.items[0].answers.q007={kind:'object',value:{secret:'HIDDEN_NESTED'}};
        await route.fulfill({response,json:data});};
      await admin.route('**/api/'+endpoint+'?**',handler);await load(admin);await admin.locator('.list-content .error-state').waitFor();assert.equal(await rows(admin).count(),0);await noSecrets(admin.locator('.list-content'));if(variant==='nested-tag')await shot(admin,'malformed-list-desktop.png');await admin.unroute('**/api/'+endpoint+'?**',handler);await admin.getByRole('button',{name:'重新讀取',exact:true}).click();await waitList(admin);assert.equal(await rows(admin).count(),25);malformedChecks.push({target:'list',variant,rejectedNoRows:true,manualFreshRetry:true});
    }
    await load(admin);await filter(admin,'個案篩選',caseB.id,'caseId');const lookup=base+'/api/cases?page=1&pageSize=100';
    const missing=async route=>{const response=await route.fetch(),data=await response.json();data.items=data.items.filter(x=>x.id!==caseB.id);data.total=data.items.length;await route.fulfill({response,json:data});};
    await admin.route(lookup,missing);const input=admin.getByLabel(names.search,{exact:true});await input.fill('NEEDS-TYPED');await input.press('Enter');await admin.getByText('原選擇個案已無法確認；請重新選擇個案或明確清除條件。',{exact:true}).first().waitFor();assert.equal(await admin.getByLabel('個案篩選',{exact:true}).inputValue(),caseB.id);assert.equal(await rows(admin).count(),0);await admin.unroute(lookup,missing);
    await admin.getByRole('button',{name:'清除個案條件',exact:true}).click();await waitList(admin);assert.equal(await admin.getByLabel('個案篩選',{exact:true}).inputValue(),'');assert(await admin.getByLabel('個案篩選',{exact:true}).evaluate(n=>n===document.activeElement));
    await load(admin);stage='G8 exact selected case404';let rejected=false;const unavailable=async route=>{if(rejected||new URL(route.request().url()).searchParams.get('caseId')!==caseB.id)return route.continue();rejected=true;expectFailure({id:'G8-case404',kind:'http',phase:stage,url:route.request().url(),method:'GET',status:404,count:1,consoleCount:1});await route.fulfill({status:404,contentType:'application/json',json:{error:{code:'NOT_FOUND',message:'合成所選需求個案已不可讀',fields:{caseId:'合成所選需求個案已不可讀'}}}});};
    await admin.route('**/api/'+endpoint+'?**',unavailable);await admin.getByLabel('個案篩選',{exact:true}).selectOption(caseB.id);await admin.getByText('合成所選需求個案已不可讀',{exact:true}).first().waitFor();assert.equal(await admin.getByLabel('個案篩選',{exact:true}).inputValue(),caseB.id);assert.equal(await rows(admin).count(),0);await admin.unroute('**/api/'+endpoint+'?**',unavailable);await admin.getByRole('button',{name:'清除個案條件',exact:true}).click();await waitList(admin);assert.equal(await rows(admin).count(),25);
    stage='G8 exact503 then manual retry';let failed=false;const bad=async route=>{if(failed)return route.continue();failed=true;expectFailure({id:'G8-only503',kind:'http',phase:stage,url:route.request().url(),method:'GET',status:503,count:1,consoleCount:1});await route.fulfill({status:503,contentType:'application/json',json:{error:{code:'SYNTHETIC_UNAVAILABLE',message:'合成需求列表暫時無法使用'}}});};
    await admin.route('**/api/'+endpoint+'?**',bad);await load(admin);await admin.getByText('合成需求列表暫時無法使用',{exact:true}).waitFor();assert.equal(await rows(admin).count(),0);await shot(admin,'list-error-desktop.png');await admin.unroute('**/api/'+endpoint+'?**',bad);await admin.getByRole('button',{name:'重新讀取',exact:true}).click();await waitList(admin);assert.equal(await rows(admin).count(),25);
  });mark('G8 twelve malformed2xx no rows／missing/unreadable selected ID retained until clear／oneexact503 manualretry');
  await readOnly('G9 fresh single untrusted response and exact foreign/template404',async()=>{
    for(const variant of ['wrong-id','wrong-org','zero-version','wrong-template','extra-key','typed-value']){
      await load(admin);const row=await findRow(admin,'NEEDS-MAIN'),trigger=row.getByRole('button',{name:'查看完整內容',exact:true}),url=base+'/api/'+endpoint+'/'+main.id;
      const handler=async route=>{const response=await route.fetch(),data=await response.json();if(variant==='wrong-id')data.item.id=otherTemplate.id;if(variant==='wrong-org')data.item.orgId=foreign.id;if(variant==='zero-version')data.item.version=0;if(variant==='wrong-template')data.item.templateId='assessment-04';if(variant==='extra-key')data.item.UNTRUSTED='HIDDEN_UNKNOWN';if(variant==='typed-value')data.item.answers.q005={kind:'number',value:123};await route.fulfill({response,json:data});};
      await admin.route(url,handler);await trigger.click();const dialog=admin.getByRole('dialog',{name:names.detail,exact:true});await dialog.locator('.error-state').waitFor();assert.equal(await dialog.getByText(longTreatment,{exact:true}).count(),0);await noSecrets(dialog);if(variant==='wrong-template')await shot(admin,'malformed-detail-desktop.png');await admin.unroute(url,handler);await dialog.getByRole('button',{name:'重新讀取',exact:true}).click();await dialog.getByText(longTreatment,{exact:true}).waitFor();await close(admin,trigger);malformedChecks.push({target:'single',variant,rejectedNoData:true,manualFreshRetry:true});
    }
    const real=(await request('GET',endpoint+'/'+main.id)).item;
    for(const [label,rejected] of [['template',otherTemplate],['foreign',foreignItem]]){
      await load(admin);stage='G9 fresh real404 '+label;const forged=async route=>{const u=new URL(route.request().url());await route.fulfill({status:200,contentType:'application/json',json:{items:[{...real,id:rejected.id}],total:1,page:Number(u.searchParams.get('page')||1),pageSize:Number(u.searchParams.get('pageSize')||25),filters:{q:u.searchParams.get('q')||'',status:u.searchParams.get('status')||'',date:u.searchParams.get('date')||'',caseId:u.searchParams.get('caseId')||''}}});};
      await admin.route('**/api/'+endpoint+'?**',forged);await load(admin);const trigger=rows(admin).first().getByRole('button',{name:'查看完整內容',exact:true});expectFailure({id:'G9-fresh404-'+label,kind:'http',phase:stage,url:base+'/api/'+endpoint+'/'+rejected.id,method:'GET',status:404,count:1,consoleCount:1});await trigger.click();const dialog=admin.getByRole('dialog',{name:names.detail,exact:true});await dialog.locator('.error-state').waitFor();assert.equal(await dialog.getByText(longTreatment,{exact:true}).count(),0);await close(admin,trigger);await admin.unroute('**/api/'+endpoint+'?**',forged);
    }
  });mark('G9 six single malformed2xx refused／list cannot grantfreshdetail／wrongtemplate-foreign real404');
  const historyUrl = base + '/api/' + entity + '/' + main.id + '/history?page=1&pageSize=25&compare=previous';
  const prepareContext = async state => {
    await load(admin); const originalList = await admin.locator('.list-content').elementHandle(), originalCases = await admin.getByLabel('個案篩選', { exact: true }).elementHandle(); let pending, arrival, dialog, trigger;
    if (state === 'pending-list') {
      pending = await held(admin, '**/api/' + endpoint + '?**', req => req.method() === 'GET' && new URL(req.url()).searchParams.get('q') === 'NEEDS-MAIN');
      const input = admin.getByLabel(names.search, { exact: true }); await input.fill('NEEDS-MAIN'); await input.press('Enter'); arrival = await bounded(pending.arrived, state + ' arrived');
      const parsed = new URL(arrival.url); assert.equal(parsed.pathname, '/api/' + endpoint); assert.equal(parsed.searchParams.get('q'), 'NEEDS-MAIN');
    } else if (state.endsWith('detail')) {
      const row = await findRow(admin, 'NEEDS-MAIN'); trigger = row.getByRole('button', { name: '查看完整內容', exact: true });
      if (state === 'pending-detail') pending = await held(admin, base + '/api/' + endpoint + '/' + main.id, req => req.method() === 'GET');
      await trigger.click(); dialog = admin.getByRole('dialog', { name: names.detail, exact: true });
      if (pending) arrival = await bounded(pending.arrived, state + ' arrived'); else await dialog.getByText(longTreatment, { exact: true }).waitFor();
    } else if (state.endsWith('history')) {
      const row = await findRow(admin, 'NEEDS-MAIN'); trigger = row.getByRole('button', { name: '版本歷程', exact: true });
      if (state === 'pending-history') pending = await held(admin, historyUrl, req => req.method() === 'GET');
      await trigger.click(); dialog = admin.getByRole('dialog', { name: names.history, exact: true });
      if (pending) arrival = await bounded(pending.arrived, state + ' arrived'); else await dialog.getByText('合成需求評估supervisor', { exact: true }).waitFor();
    }
    if (arrival) assert.equal(arrival.response.status(), 200, 'Held context fixture is a real successful server GET before client abort');
    const originalDialogBody=dialog?await dialog.locator('.dialog-body').elementHandle():null;return {originalList,originalCases,originalDialogBody,pending,arrival,dialog,trigger};
  };
  const invalidationAssertions = async prepared => {
    await admin.waitForFunction(node => node.textContent === '', prepared.originalList); assert.equal(await prepared.originalList.evaluate(node => node.textContent), '', 'Original list DOM cleared, not replaced as a false guard');
    assert(await prepared.originalCases.evaluate(node => node.disabled && [...node.options].every(option => option.value === '' && !/NEEDS-SAME|NEEDS-CLOSED|合成同名需求評估|合成已結案/.test(option.textContent))), 'Original case metadata/IDs removed');
    for (const item of [caseA, caseB, closedCase]) assert.equal(await prepared.originalCases.evaluate((node, value) => [...node.options].filter(option => option.value === value).length, item.id), 0);
    if(prepared.originalDialogBody){await admin.waitForFunction(node=>node.textContent==='',prepared.originalDialogBody);assert.equal(await prepared.originalDialogBody.evaluate(node=>node.textContent),'');}if(prepared.dialog)await admin.locator('dialog').last().waitFor({state:'detached'}); assert.equal(await admin.getByRole('dialog').count(), 0); assert.equal(await admin.locator('.toast-success').count(), 0);
  };
  const states = ['loaded-list', 'pending-list', 'loaded-detail', 'pending-detail', 'loaded-history', 'pending-history'];
  for (const state of states) for (const primitive of ['user', 'org', 'role', 'employee', 'hash', 'render']) await readOnly('G10 ' + state + ' primitive ' + primitive, async () => {
    const prepared = await prepareContext(state); let aborted;
    try {
      if (prepared.pending) aborted = expectAbort(admin, 'primitive-' + state + '-' + primitive, prepared.arrival);
      await mutateContext(admin, primitive, foreign.id); await invalidationAssertions(prepared);
      if (prepared.pending) { await prepared.pending.finish(); await aborted; }
      await admin.waitForLoadState('networkidle'); assert.equal(await admin.getByRole('dialog').count(), 0); assert.equal(await prepared.originalList.evaluate(node => node.textContent), '');
      contextChecks.push({ state, primitive, originalListCleared: true, originalCaseMetadataCleared: true, dialogGone: true, actualRequestAbort: Boolean(prepared.pending), lateResponseDidNotRevive: true, zeroWrites: true, clientPrimitiveGuardNotServerPermissionRevocation: true });
    } finally { if (prepared.pending) await prepared.pending.finish(); }
  }); mark('G10 six loaded/pending list-detail-history states×six primitives／36 original-DOM guards／18 exact observed GET aborts');
  for (const state of states) await readOnly('G11 nested reference negative ' + state, async () => {
    const prepared = await prepareContext(state), reference = await replaceNestedReferences(admin); assert(reference.outerReferenceKept && reference.userAndOrganizationReferencesChanged); same(reference.before, reference.after);
    if (prepared.pending) await prepared.pending.finish(); await admin.waitForLoadState('networkidle');
    assert(await prepared.originalList.evaluate(node => node.isConnected && node.textContent.length > 0), 'Same primitive nested reference change keeps original loaded list');
    assert(await prepared.originalCases.evaluate(node => !node.disabled && [...node.options].some(option => /NEEDS-SAME-A/.test(option.textContent))), 'Same-value nested reference keeps confirmed case options');
    if (prepared.dialog) { assert(await prepared.dialog.isVisible()); if (state.endsWith('detail')) await prepared.dialog.getByText(longTreatment, { exact: true }).waitFor(); else await prepared.dialog.getByText('合成需求評估supervisor', { exact: true }).waitFor(); await close(admin, prepared.trigger); }
    referenceChecks.push({ state, primitivesExact: true, outerContextKept: true, nestedUserAndOrganizationReferencesChanged: true, listAndMetadataRetained: true, pendingResultAcceptedWithoutAbort: Boolean(prepared.pending), zeroWrites: true });
  });
  for (const state of states) await readOnly('G11 conservative outer context rebuild ' + state, async () => {
    const prepared = await prepareContext(state); let aborted;
    try {
      if (prepared.pending) aborted = expectAbort(admin, 'outer-' + state, prepared.arrival);
      const rebuilt = await admin.evaluate(async () => { const ui = await import('/ui.js'), current = ui.getContext(); const tuple = c => JSON.stringify([c.user?.id ?? null, c.organizationId ?? c.orgId ?? null, c.role ?? null, c.user?.employeeId ?? null]); const before = tuple(current); ui.setContext({ ...current, user: { ...current.user }, organizations: current.organizations.map(item => ({ ...item })) }, current.organizationId); const changed = current !== ui.getContext(), after = tuple(ui.getContext()); const mounted = document.querySelector('[data-render-version]'); mounted.setAttribute('data-render-version', mounted.dataset.renderVersion); return { changed, before, after }; });
      assert(rebuilt.changed); same(rebuilt.before, rebuilt.after, 'Outer context positive changes reference, not identity primitives'); await invalidationAssertions(prepared);
      if (prepared.pending) { await prepared.pending.finish(); await aborted; } await admin.waitForLoadState('networkidle'); assert.equal(await admin.getByRole('dialog').count(), 0);
      outerRebuildChecks.push({ state, identityPrimitivesUnchanged: true, outerContextActuallyChanged: true, originalListAndCaseMetadataCleared: true, dialogGone: true, actualRequestAbort: Boolean(prepared.pending), lateResponseDidNotRevive: true, zeroWrites: true });
    } finally { if (prepared.pending) await prepared.pending.finish(); }
  }); mark('G11 six nested same-value reference negatives retained／six same-primitive outer rebuilds invalidate／three exact GET aborts');
  await readOnly('G12 pending detail/history Escape truly aborts and restores focus before next stage', async () => {
    for (const kind of ['detail', 'history']) {
      stage = 'G12 pending Escape ' + kind; const prepared = await prepareContext('pending-' + kind), aborted = expectAbort(admin, 'Escape-' + kind, prepared.arrival);
      await close(admin, prepared.trigger); await prepared.pending.finish(); await aborted; await admin.waitForLoadState('networkidle'); assert.equal(await admin.getByRole('dialog').count(), 0); assert(await prepared.trigger.evaluate(node => node === document.activeElement));
    }
  }); mark('G12 pending detail/history Escape close→release→observed requestfailed／focus restored／no late revival');
  await readOnly('G13 actual mobile raw answer tail/footer/table/history',async()=>{
    await admin.setViewportSize({width:390,height:844});await load(admin);const table=admin.locator('.list-content .table-scroll');assert(await table.evaluate(n=>n.scrollWidth>n.clientWidth));await table.evaluate(n=>{n.scrollLeft=n.scrollWidth;});assert(await table.evaluate(n=>n.scrollLeft>0));await table.evaluate(n=>{n.scrollLeft=0;});await shot(admin,'list-mobile.png');
    const opened=await openDetails(admin,'NEEDS-MAIN');await opened.dialog.getByText(longTreatment,{exact:true}).waitFor();await opened.dialog.getByText(longNote,{exact:true}).waitFor();await noSecrets(opened.dialog);await shot(admin,'detail-mobile.png');
    for(const [kind,value,lastLine,literal,filename] of [['treatment',longTreatment,lastTreatment,treatmentLiteral,'treatment-suffix-mobile.png'],['note',longNote,lastNote,noteLiteral,'note-suffix-mobile.png']]){
      const text=opened.dialog.getByText(value,{exact:true});assert.equal(await text.textContent(),value);const geometry=await suffixGeometry(text,lastLine,literal);assert(geometry.lastLineRects.length&&geometry.finalLiteralRects.length);assert([...geometry.lastLineRects,...geometry.finalLiteralRects].every(r=>r.insideDialogAboveFooter&&r.hitTestVisible),'Every real '+kind+' tail Range remains inside dialog and above direct close footer');footerChecks.push({kind,fullSavedTextExact:true,...geometry});await shot(admin,filename);
    }
    await close(admin,opened.trigger);const history=await openHistory(admin,'NEEDS-MAIN');await history.dialog.getByText('合成需求評估supervisor',{exact:true}).waitFor();await shot(admin,'history-mobile.png');await close(admin,history.trigger);await admin.setViewportSize({width:1440,height:1050});
  });mark('G13 390 native controls/tableinnerpan／two real raw160th line-literal Ranges/hittest/directclosefooter／mobilehistory');
  await readOnly('G14 exact source/database/snapshot/BLOB and precise error accounting',async()=>{
    same(raw(),queryBaseline,'No unaccounted database mutation after last named synthetic fixture');same(counts(),queryCounts);assertProtected();same((await request('GET','service-records/'+approved.id)).item,approved);
    const afterSources=await collectSources(root);same(afterSources,sourceHashesBefore,'All consumed full source bytes unchanged including85 runtime/newtest/helper/scope');
    assert.equal(pageErrors.length,0,json(pageErrors));assert.equal(failedResponses.filter(x=>!x.expectedRuleId).length,0,json(failedResponses));assert.equal(failedRequests.filter(x=>!x.expectedRuleId).length,0,json(failedRequests));
    const assigned=new Set();for(const rule of expectedFailures){const events=(rule.kind==='http'?failedResponses:failedRequests).filter(x=>x.expectedRuleId===rule.id);assert.equal(events.length,rule.count,'Exact phase/fullURL/method/status or code '+rule.id);
      const matches=consoleErrors.flatMap((e,i)=>e.stage===rule.phase&&e.location.url===rule.url&&(rule.kind==='http'?e.text.startsWith('Failed to load resource: the server responded with a status of '+rule.status+' ('):e.text==='Failed to load resource: '+rule.failure)?[i]:[]);
      if(rule.consoleCount!==undefined)assert.equal(matches.length,rule.consoleCount);else assert(matches.length<=rule.maxConsoleCount);for(const i of matches){assert(!assigned.has(i));assigned.add(i);}rule.actualFailureCount=events.length;rule.actualConsoleCount=matches.length;
    }assert.equal(assigned.size,consoleErrors.length,json(consoleErrors.filter((_e,i)=>!assigned.has(i))));
    assert.equal(contextChecks.length,36);assert.equal(referenceChecks.length,6);assert.equal(outerRebuildChecks.length,6);assert.equal(malformedChecks.length,18);assert.equal(footerChecks.length,2);assert.equal(screenshots.length,16);assert.equal(checks.length,13);
    for(let i=1;i<stateLedger.length;i++){same(stateLedger[i].beforeCounts,stateLedger[i-1].afterCounts,'Continuous read/fixture counts');assert.equal(stateLedger[i].beforeSha256,stateLedger[i-1].afterSha256,'Continuous all11table/schema/raw state');}
  });mark('G14 all11tables6triggers fullraw/schema/changes readzero／fixture ledger continuous／snapshot-BLOB-source unchanged／only exact expectederrors');
  const sourceHashesAfter=await collectSources(root);same(sourceHashesAfter,sourceHashesBefore);same(stateLedger.at(-1).afterCounts,counts());assert.equal(stateLedger.at(-1).afterSha256,sha(raw()));
  await writeFile(path.join(output,'e2e.json'),JSON.stringify({passed:true,completedAt:now(),syntheticOnly:true,database:':memory:',randomLoopback:true,checks,readSegments,fixtureWrites,stateLedger,requestLedger,contextChecks,referenceChecks,outerRebuildChecks,projectionChecks,malformedChecks,footerChecks,originalProtectedRowsAndBlobsUnchanged:true,snapshotUnchanged:true,pageErrors,consoleErrors,failedResponses,failedRequests,expectedFailures,expectedConsoleFailuresOnly:true,sourceHashesBefore,sourceHashesAfter,runtimeSourceCount:Object.keys(sourceHashesBefore).filter(n=>n.startsWith('public/')||n.startsWith('src/')).length,sourceCount:Object.keys(sourceHashesBefore).length,screenshots,visualReviewPending:true,actuallyViewedByScript:false},null,2)+'\n',{flag:'wx'});console.log('RESULT '+path.join(output,'e2e.json'));
}catch(error){
  await writeFile(path.join(output,'failure.json'),JSON.stringify({passed:false,stage,error:error.stack,checks,readSegments,fixtureWrites,stateLedger,requestLedger,contextChecks,referenceChecks,outerRebuildChecks,projectionChecks,malformedChecks,footerChecks,screenshots,pageErrors,consoleErrors,failedResponses,failedRequests,expectedFailures,sourceHashesBefore},null,2)+'\n',{flag:'wx'});
  if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:path.join(output,'failure.png'),fullPage:false}).catch(()=>{});console.error('FAILURE '+path.join(output,'failure.json'));throw error;
}finally{for(const context of contexts)await context.close().catch(()=>{});if(browser)await browser.close();await app.close();}
