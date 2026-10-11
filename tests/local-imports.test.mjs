import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { confirmLocalImportPreview,confirmLocalImportCommit } from '../public/modules/local-imports.js';

async function fixture(t){
 const app=createApp({dbPath:':memory:',port:0}),base=await app.listen();assert.notEqual(new URL(base).port,'4310');t.after(()=>app.close());
 const setup=await fetch(base+'/api/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'合成匯入管理員',organizationName:'合成匯入機構',email:'imports@example.test',password:'synthetic-local-import-password'})});assert.equal(setup.status,201);const auth=await setup.json(),orgId=auth.organizations[0].id;
 const headers={Origin:base,'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-Org-Id':orgId,'X-CSRF-Token':auth.csrfToken};
 const request=async(method,route,data,status=200,extra={})=>{const response=await fetch(base+'/api/'+route,{method,headers:{...headers,...extra},...(data!==undefined?{body:typeof data==='string'?data:JSON.stringify(data)}:{})});assert.equal(response.status,status,await response.clone().text());return response.json();};
 const state=()=>Object.fromEntries(['records','record_versions','audit','idempotency'].map(table=>[table,app.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 const changes=()=>app.db.prepare('SELECT total_changes() n').get().n;
 const input={entity:'cases',csv:'姓名,案號,備註\r\n合成甲,0001," 首行\r\n逗號,引號""保留""尾端 "\r\n合成乙,0002,',mapping:{姓名:'name',案號:'caseNo',備註:'note'}};
 return{app,base,auth,orgId,headers,request,state,changes,input};
}
test('HTTP preview is zero-write; atomic new import preserves original CSV text and ids, exact history/audit and replay once',async t=>{
 const f=await fixture(t),before=f.state(),changes=f.changes();const preview=await f.request('POST','local-imports/preview',f.input);confirmLocalImportPreview(preview,f.input);assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
 const key=randomUUID(),body={...f.input,previewHash:preview.previewHash},ack=await f.request('POST','local-imports/commit',body,201,{'Idempotency-Key':key});
 const sourceHash=createHash('sha256').update(f.input.csv).digest('hex');confirmLocalImportCommit(ack,preview,f.orgId,sourceHash);assert.equal(ack.items[0].caseNo,'0001');assert.equal(ack.items[0].note,' 首行\r\n逗號,引號"保留"尾端 ');assert.equal(ack.items[1].note,'');
 const after=f.state(),written=f.changes();assert.equal(after.records.length-before.records.length,2);assert.equal(after.record_versions.length-before.record_versions.length,2);assert.equal(after.audit.length-before.audit.length,3);assert.equal(after.idempotency.length-before.idempotency.length,1);
 assert.deepEqual(await f.request('POST','local-imports/commit',body,201,{'Idempotency-Key':key}),ack);assert.deepEqual(f.state(),after);assert.equal(f.changes(),written);
 for(const item of ack.items){const history=await f.request('GET','cases/'+item.id+'/history?compare=previous');assert.equal(history.total,1);assert.deepEqual(history.items[0].snapshot,item);assert.equal(history.items[0].actor.id,f.auth.user.id);}
 await f.request('POST','local-imports/commit',{...body,csv:body.csv+'\n'},409,{'Idempotency-Key':key});assert.deepEqual(f.state(),after);
});
test('HTTP duplicate, invalid rows, missing mapping and metadata injection reject whole batch without partial writes',async t=>{
 const f=await fixture(t),before=f.state(),changes=f.changes(),duplicate={...f.input,csv:'姓名,案號,備註\n合成甲,DUP,\n合成乙,DUP,'};const preview=await f.request('POST','local-imports/preview',duplicate);assert.equal(preview.ready,false);assert.equal(preview.errors[0].code,'DUPLICATE_CODE');confirmLocalImportPreview(preview,duplicate);
 await f.request('POST','local-imports/commit',{...duplicate,previewHash:preview.previewHash},422,{'Idempotency-Key':randomUUID()});
 for(const input of [{...f.input,mapping:{姓名:'name',案號:'id',備註:'note'}},{...f.input,mapping:{姓名:'name',案號:'caseNo',備註:'name'}},{...f.input,mapping:{姓名:'name'}},{...f.input,entity:'users'},{...f.input,csv:'name,name\na,b'},{...f.input,unknown:1}])await f.request('POST','local-imports/preview',input,422);
 await f.request('POST','local-imports/commit',{...f.input,previewHash:'a'.repeat(64)},422);
 assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
});
test('HTTP stale preview, exact same-org duplicate and cross-org isolation remain explicit and atomic',async t=>{
 const f=await fixture(t),preview=await f.request('POST','local-imports/preview',f.input);await f.request('POST','cases',{name:'合成後來新增',caseNo:'SYN-LATER'},201);let before=f.state(),changes=f.changes();
 await f.request('POST','local-imports/commit',{...f.input,previewHash:preview.previewHash},409,{'Idempotency-Key':randomUUID()});assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
 const secondOrg=(await f.request('POST','organizations',{name:'合成第二機構'},201)).item.id;await f.request('POST','cases',{name:'合成外機構重號',caseNo:'0001'},201,{'X-Org-Id':secondOrg});const fresh=await f.request('POST','local-imports/preview',f.input);assert.equal(fresh.ready,true);
 await f.request('POST','cases',{name:'合成本機重號',caseNo:'0001'},201);before=f.state();changes=f.changes();const invalid=await f.request('POST','local-imports/preview',f.input);assert.equal(invalid.ready,false);assert.equal(invalid.errors[0].code,'DUPLICATE_CODE');await f.request('POST','local-imports/commit',{...f.input,previewHash:fresh.previewHash},422,{'Idempotency-Key':randomUUID()});assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
});
test('HTTP admin guard precedes bad JSON/query; employee import does not create account or privilege',async t=>{
 const f=await fixture(t);for(const role of ['supervisor','caregiver','finance']){
  const employee=(await f.request('POST','employees',{name:'合成'+role,employeeNo:'ROLE-'+role},201)).item;await f.request('POST','users',{name:'合成'+role,email:role+'-import@example.test',password:'synthetic-import-role-password',role,...(role==='caregiver'?{employeeId:employee.id}:{})},201);
  const login=await fetch(f.base+'/api/login',{method:'POST',headers:{Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({email:role+'-import@example.test',password:'synthetic-import-role-password'})});assert.equal(login.status,200);const session=await login.json(),extra={Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrfToken},before=f.state(),changes=f.changes();
  await f.request('POST','local-imports/preview?invalid=1','{bad',403,extra);await f.request('POST','local-imports/commit','{bad',403,extra);assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
 }
 const input={entity:'employees',csv:'name,employeeNo,role\n合成新員工,0005,人工職務說明',mapping:{name:'name',employeeNo:'employeeNo',role:'role'}},before=f.app.db.prepare('SELECT * FROM users ORDER BY id').all(),members=f.app.db.prepare('SELECT * FROM memberships ORDER BY user_id').all(),preview=await f.request('POST','local-imports/preview',input),ack=await f.request('POST','local-imports/commit',{...input,previewHash:preview.previewHash},201,{'Idempotency-Key':randomUUID()});confirmLocalImportPreview(preview,input);confirmLocalImportCommit(ack,preview,f.orgId,createHash('sha256').update(input.csv).digest('hex'));assert.deepEqual(f.app.db.prepare('SELECT * FROM users ORDER BY id').all(),before);assert.deepEqual(f.app.db.prepare('SELECT * FROM memberships ORDER BY user_id').all(),members);assert.equal(ack.items[0].hourlyRateCents,0);
});
test('HTTP exact integer service price, large legal Unicode CSV and oversize body never truncate',async t=>{
 const f=await fixture(t),input={entity:'service-items',csv:'code,name,minutes,price\nSYN-X,合成試算服務,60,10001',mapping:{code:'code',name:'name',minutes:'minutes',price:'unitPriceCents'}},preview=await f.request('POST','local-imports/preview',input),ack=await f.request('POST','local-imports/commit',{...input,previewHash:preview.previewHash},201,{'Idempotency-Key':randomUUID()});assert.equal(ack.items[0].unitPriceCents,10001);confirmLocalImportPreview(preview,input);confirmLocalImportCommit(ack,preview,f.orgId,createHash('sha256').update(input.csv).digest('hex'));
 const long='合'.repeat(9000),large={entity:'cases',csv:'name,caseNo,note\n'+Array.from({length:20},(_,i)=>'合成'+i+',L'+i+','+long).join('\n'),mapping:{name:'name',caseNo:'caseNo',note:'note'}};assert.ok(Buffer.byteLength(JSON.stringify(large))>131072);const largePreview=await f.request('POST','local-imports/preview',large),saved=await f.request('POST','local-imports/commit',{...large,previewHash:largePreview.previewHash},201,{'Idempotency-Key':randomUUID()});assert.equal(saved.items.length,20);assert.ok(saved.items.every(item=>item.note===long));const before=f.state();await f.request('POST','local-imports/preview',{...large,csv:'x'.repeat(4*1024*1024)},413);assert.deepEqual(f.state(),before);
});
test('HTTP mid-batch SQL failure rolls persistent records/history/audit/idempotency back completely',async t=>{
 const f=await fixture(t),preview=await f.request('POST','local-imports/preview',f.input);f.app.db.exec("CREATE TEMP TRIGGER import_test_failure BEFORE INSERT ON records WHEN NEW.entity='cases' AND json_extract(NEW.data,'$.caseNo')='0002' BEGIN SELECT RAISE(ABORT,'synthetic import rejection'); END");const before=f.state();await f.request('POST','local-imports/commit',{...f.input,previewHash:preview.previewHash},500,{'Idempotency-Key':randomUUID()});assert.deepEqual(f.state(),before);f.app.db.exec('DROP TRIGGER import_test_failure');
});
test('import preview/commit ACK refuses unknown, changed, sparse, nested or accessor values without executing getters',()=>{
 const input={entity:'cases',csv:'name,caseNo\n合成甲,0001',mapping:{name:'name',caseNo:'caseNo'}},preview={entity:'cases',label:'個案',totalCount:1,validCount:1,ready:true,errors:[],rows:[{rowNumber:2,data:{status:'active',name:'合成甲',caseNo:'0001'}}],previewHash:'a'.repeat(64)};
 confirmLocalImportPreview(preview,input);for(const patch of [{entity:'employees'},{rows:[{...preview.rows[0],data:{...preview.rows[0].data,caseNo:'1'}}]},{rows:new Array(1)},{ready:false},{unknown:'secret'}])assert.throws(()=>confirmLocalImportPreview({...preview,...patch},input));let calls=0;const row={data:preview.rows[0].data};Object.defineProperty(row,'rowNumber',{enumerable:true,get(){calls++;return 2;}});assert.throws(()=>confirmLocalImportPreview({...preview,rows:[row]},input));assert.equal(calls,0);
 const ack={batchId:'synthetic-batch',entity:'cases',importedCount:1,sourceHash:'b'.repeat(64),items:[{...preview.rows[0].data,id:'abc',orgId:'org',version:1,createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z'}],mode:'local-new-records-only'};confirmLocalImportCommit(ack,preview,'org',ack.sourceHash);for(const extra of [{orgId:'outside'},{caseNo:'1'},{version:2},{createdAt:'2026-02-30T00:00:00.000Z'},{updatedAt:'2026-10-10\n'},{id:'abc\n'},{unknown:{secret:'not allowed'}}])assert.throws(()=>confirmLocalImportCommit({...ack,items:[{...ack.items[0],...extra}]},preview,'org',ack.sourceHash));
});
