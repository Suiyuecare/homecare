import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {serviceBillingMode,serviceBillingOriginEntity,guardServiceBillingAccess,serviceBillingQuery,validateServiceBillingPayload,assertServiceBillingSource,listServiceBillingSources,previewServiceBilling,preflightServiceBillingCreate,commitServiceBillingCreate,confirmServiceBillingCreateResponse,readServiceBillingOrigins,readServiceBillingOrigin} from '../src/server/service-billing.mjs';
const modelURL=existsSync(new URL('../../../../src/server/model.mjs',import.meta.url))?new URL('../../../../src/server/model.mjs',import.meta.url):new URL('../src/server/model.mjs',import.meta.url);
const{initDb,insert,replace,validate,validatePayload,audit,fail,now,billingSnapshot}=await import(modelURL);
const hooks={validate,validatePayload,insert,audit,fail};
function fixture(t){
 const db=new DatabaseSync(':memory:');initDb(db);t.after(()=>db.close());const org=randomUUID(),user=randomUUID();
 db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org,'合成來源帳單',now());db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user,'合成財務','service-billing-'+user+'@example.test','synthetic-only-not-a-login-hash',now());db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org,user,'admin',null);const ctx={orgId:org,user:{id:user},role:'admin'};
 const parent=insert(db,org,'cases',{name:'原個案',caseNo:'SB-C1',status:'active'}),employee=insert(db,org,'employees',{name:'原員工',employeeNo:'SB-E1',status:'active',hourlyRateCents:123});
 const items=[insert(db,org,'service-items',{name:'第一服務',code:'SB-S1',minutes:30,unitPriceCents:101,status:'active'}),insert(db,org,'service-items',{name:'第二服務',code:'SB-S2',minutes:30,unitPriceCents:202,status:'active'})],services=items.map((item,i)=>({serviceItemId:item.id,quantity:i+2}));
 const plan=insert(db,org,'care-plans',{caseId:parent.id,validFrom:'2026-10-01',validTo:'2026-10-31',services,status:'active'});
 const source=(date='2026-10-05',selectedServices=services)=>{const shift=insert(db,org,'shifts',{caseId:parent.id,employeeId:employee.id,carePlanId:plan.id,date,startTime:'09:00',endTime:'10:00',services:selectedServices,status:'completed',note:' 原班\r\n備註 '});const record={shiftId:shift.id,caseId:parent.id,employeeId:employee.id,date,actualStart:'09:00',actualEnd:'10:00',services:selectedServices,status:'approved',note:' 原服務\r\n備註 ',reviewNote:' 原核閱\r\n意見 '};record.billingSnapshot=billingSnapshot(db,org,record);return insert(db,org,'service-records',record);};
 const first=source(),body=()=>({caseId:parent.id,month:'2026-10',number:'SB-BILL1',sourceReference:' 共同\r\n人工依據 ',note:' 原生成\r\n備註 ',lines:[{serviceRecordId:first.id,version:first.version,label:' 人工整筆總額 ',amountCents:1,sourceReference:' 明確人工\r\n1分依據 '}]});
 const state=()=>Object.fromEntries(['records','record_versions','audit','idempotency'].map(name=>{const stmt=db.prepare('SELECT * FROM '+name+' ORDER BY rowid');stmt.setReadBigInts(true);return[name,stmt.all()];}));
 const query=()=>serviceBillingQuery(new URLSearchParams({caseId:parent.id,month:'2026-10'}),fail);
 const create=(payload=body(),custom=hooks)=>{const preview=previewServiceBilling(db,ctx,payload,hooks),request={...payload,previewHash:preview.previewHash};db.exec('BEGIN IMMEDIATE');try{const result=commitServiceBillingCreate(db,ctx,request,custom);db.exec('COMMIT');return{preview,request,result};}catch(error){db.exec('ROLLBACK');throw error;}};
 return{db,org,user,ctx,parent,employee,items,source,first,body,state,query,create};
}
const rejects=(action,code)=>assert.throws(action,error=>error.code===code);
test('ordinary selected service with two items preserves trial and manual 1-cent amount, preview zero-write and creates exactly bill+origin+versions',t=>{
 const f=fixture(t),before=f.state(),preview=previewServiceBilling(f.db,f.ctx,f.body(),hooks);assert.deepEqual(f.state(),before);assert.equal(preview.sourceCount,1);assert.equal(preview.sources[0].billingSnapshot.items.length,2);assert.equal(preview.sources[0].billingSnapshot.trial,true);assert.equal(preview.draft.summary.amountCents,1);assert.notEqual(preview.draft.summary.amountCents,preview.sources[0].billingSnapshot.items.reduce((sum,item)=>sum+item.amountCents,0));
 const {request,result}=f.create();assert.equal(result.mode,serviceBillingMode);assert.equal(result.item.version,1);assert.equal(result.origin.version,1);assert.deepEqual(result.origin.sourceSnapshots,preview.sources);assert.equal(result.item.sourceReference,f.body().sourceReference);assert.equal(result.origin.note,f.body().note);assert.deepEqual(result.item.lineItems,[{label:' 人工整筆總額 ',quantity:1,unitPriceCents:1}]);
 assert.equal(f.state().records.length,before.records.length+2);assert.equal(f.state().record_versions.length,before.record_versions.length+2);assert.equal(f.state().audit.length,before.audit.length+2);assert.equal(confirmServiceBillingCreateResponse(f.db,f.ctx,result,request,hooks),result);
 assert.equal(listServiceBillingSources(f.db,f.ctx,f.query(),hooks).total,0);assert.deepEqual(readServiceBillingOrigin(f.db,f.ctx,result.item.id,hooks),{origin:result.origin,bill:result.item});
});
test('current employee/item prices never reprice approved source; unchanged original source is checked against immutable history',t=>{
 const f=fixture(t),initial=previewServiceBilling(f.db,f.ctx,f.body(),hooks);replace(f.db,f.org,'employees',f.employee,{name:'改名員工',employeeNo:'SB-E1',status:'inactive',hourlyRateCents:999});for(const item of f.items)replace(f.db,f.org,'service-items',item,{name:'新項目名',code:item.code,minutes:30,status:'inactive',unitPriceCents:999999});const next=previewServiceBilling(f.db,f.ctx,f.body(),hooks);assert.deepEqual(next.sources,initial.sources);assert.equal(next.previewHash,initial.previewHash);assert.equal(next.sources[0].billingSnapshot.employee.hourlyRateCents,123);assert.equal(next.sources[0].billingSnapshot.items[0].unitPriceCents,101);
});
test('source remains occupied for draft, changed issued or voided bill; initial bill stays exact while current bill may differ',t=>{
 const f=fixture(t),{request,result}=f.create(),changed={caseId:f.parent.id,month:'2026-10',number:'SB-BILL1',lineItems:[{label:'人工後續變更',quantity:1,unitPriceCents:9}],sourceReference:'新依據',note:'不同備註',status:'draft'};validate(f.db,f.ctx,'billing-documents',changed,result.item);let current=replace(f.db,f.org,'billing-documents',result.item,changed);let pair=readServiceBillingOrigin(f.db,f.ctx,result.item.id,hooks);assert.equal(pair.bill.summary.amountCents,9);assert.equal(pair.origin.initialBillSnapshot.summary.amountCents,1);assert.equal(confirmServiceBillingCreateResponse(f.db,f.ctx,result,request,hooks),result);
 for(const status of ['issued','voided']){const data={...changed,status,note:status==='voided'?'本次取消':'不同備註'};validate(f.db,f.ctx,'billing-documents',data,current);current=replace(f.db,f.org,'billing-documents',current,data);const before=f.state();rejects(()=>previewServiceBilling(f.db,f.ctx,{...f.body(),number:'OTHER'},hooks),'SERVICE_ALREADY_BILLED');assert.deepEqual(f.state(),before);assert.equal(readServiceBillingOrigin(f.db,f.ctx,result.item.id,hooks).bill.status,status);}
});
test('role, revoked or replaced membership reject before malformed body and result cache',t=>{
 const f=fixture(t),before=f.state();for(const role of ['caregiver','supervisor'])rejects(()=>previewServiceBilling(f.db,{...f.ctx,role},null,hooks),'ROLE_FORBIDDEN');assert.deepEqual(f.state(),before);const{result,request}=f.create();f.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.org,f.user);const revoked=f.state();rejects(()=>preflightServiceBillingCreate(f.db,f.ctx,request,hooks),'ROLE_FORBIDDEN');rejects(()=>confirmServiceBillingCreateResponse(f.db,f.ctx,result,request,hooks),'ROLE_FORBIDDEN');assert.deepEqual(f.state(),revoked);
});
test('query modes reject duplicates, unknown keys, newline and exponent paging; no getters or sparse manual source arrays',t=>{
 const f=fixture(t);for(const suffix of ['&page=1%0A','&page=1e0','&pageSize=25%0A','&q=a&q=b','&hidden=1','&caseId=x','&month=2026-11']){if(suffix==='&month=2026-11')continue;rejects(()=>serviceBillingQuery(new URLSearchParams('caseId='+f.parent.id+'&month=2026-10'+suffix),fail),'SERVICE_BILLING_INVALID');}for(const mode of ['single','mutation'])rejects(()=>serviceBillingQuery(new URLSearchParams('page=1'),fail,mode),'SERVICE_BILLING_INVALID');
 let accessed=0;const evil={...f.body()};Object.defineProperty(evil,'lines',{enumerable:true,get(){accessed++;return[];}});rejects(()=>validateServiceBillingPayload(evil,fail),'SERVICE_BILLING_INVALID');assert.equal(accessed,0);const sparse=f.body();sparse.lines.length=2;rejects(()=>validateServiceBillingPayload(sparse,fail),'SERVICE_BILLING_INVALID');const extra=f.body();extra.lines[0].createdAt=now();rejects(()=>validateServiceBillingPayload(extra,fail),'SERVICE_BILLING_INVALID');
});
test('missing explicit money/evidence, duplicate source, wrong month/case, stale source version and caller metadata fail zero-write',t=>{
 const f=fixture(t),payloads=[{...f.body(),unknown:'x'},{...f.body(),sourceReference:' '},{...f.body(),month:'2026-11'}, {...f.body(),caseId:randomUUID()}, {...f.body(),lines:[{...f.body().lines[0],version:2}]},{...f.body(),lines:[f.body().lines[0],f.body().lines[0]]}];for(const field of ['amountCents','sourceReference']){const body=f.body();delete body.lines[0][field];payloads.push(body);}for(const amountCents of [1.1,-1,1e9+1,'1',Number.MAX_SAFE_INTEGER+1])payloads.push({...f.body(),lines:[{...f.body().lines[0],amountCents}]});for(const body of payloads){const before=f.state();assert.throws(()=>previewServiceBilling(f.db,f.ctx,body,hooks));assert.deepEqual(f.state(),before);}
});
test('transaction guard, changed preview, duplicate bill number and forced origin/audit insertion failure never partially save',t=>{
 const f=fixture(t),p=previewServiceBilling(f.db,f.ctx,f.body(),hooks),request={...f.body(),previewHash:p.previewHash},before=f.state();rejects(()=>commitServiceBillingCreate(f.db,f.ctx,request,hooks),'TRANSACTION_REQUIRED');assert.deepEqual(f.state(),before);
 f.db.exec('BEGIN IMMEDIATE');try{rejects(()=>commitServiceBillingCreate(f.db,f.ctx,{...request,lines:[{...request.lines[0],amountCents:2}]},hooks),'SERVICE_BILLING_PREVIEW_STALE');}finally{f.db.exec('ROLLBACK');}assert.deepEqual(f.state(),before);
 assert.throws(()=>f.create(f.body(),{...hooks,audit(){throw Error('forced synthetic audit failure');}}),/forced synthetic/);assert.deepEqual(f.state(),before);
 insert(f.db,f.org,'billing-documents',{caseId:f.parent.id,month:'2026-10',number:'SB-BILL1',lineItems:[{label:'既有',quantity:1,unitPriceCents:1}],sourceReference:'既有',status:'draft',note:'',summary:{amountCents:1},caseSnapshot:{id:f.parent.id,name:f.parent.name,caseNo:f.parent.caseNo}});const duplicate=f.state();rejects(()=>f.create(),'DUPLICATE_NUMBER');assert.deepEqual(f.state(),duplicate);
});
test('targeted raw corrupt source JSON, unsafe SQL version, mismatched immutable version and orphan completed shift fail closed zero-write',t=>{
 for(const corrupt of [f=>f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{',f.first.id),f=>f.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER)+1n,f.first.id),f=>f.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({...f.first,orgId:undefined,id:undefined,version:undefined,createdAt:undefined,updatedAt:undefined,note:'tampered'}),f.first.id),f=>f.db.prepare('UPDATE records SET entity=? WHERE id=?').run('synthetic-unrelated',f.first.shiftId)]){const f=fixture(t);corrupt(f);const before=f.state();assert.throws(()=>previewServiceBilling(f.db,f.ctx,f.body(),hooks));assert.deepEqual(f.state(),before);}
});
test('damaged hidden origin is never silently skipped; wrong snapshot identity and duplicate raw source occupation block creation/read/cache',t=>{
 for(const kind of ['json','unsafe','duplicate']){const f=fixture(t),{request,result}=f.create();if(kind==='json')f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{',result.origin.id);if(kind==='unsafe')f.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER)+1n,result.origin.id);if(kind==='duplicate')insert(f.db,f.org,serviceBillingOriginEntity,{billingDocumentId:result.item.id});const before=f.state();for(const call of [()=>listServiceBillingSources(f.db,f.ctx,f.query(),hooks),()=>readServiceBillingOrigin(f.db,f.ctx,result.item.id,hooks),()=>confirmServiceBillingCreateResponse(f.db,f.ctx,result,request,hooks)])rejects(call,'BROKEN_BILLING_ORIGIN');assert.deepEqual(f.state(),before);}
});
test('origin/source getters and unknown nested snapshot keys are rejected without getter access',t=>{
 const f=fixture(t),source=previewServiceBilling(f.db,f.ctx,f.body(),hooks).sources[0];let reads=0;Object.defineProperty(source.billingSnapshot.employee,'name',{enumerable:true,get(){reads++;return'leak';}});rejects(()=>assertServiceBillingSource(source,fail),'SERVICE_SOURCE_UNVERIFIABLE');assert.equal(reads,0);const source2=previewServiceBilling(f.db,f.ctx,f.body(),hooks).sources[0];source2.billingSnapshot.items[0].unknown='do not disclose';rejects(()=>assertServiceBillingSource(source2,fail),'SERVICE_SOURCE_UNVERIFIABLE');
});
test('30 sources with 2000-character individual references retain complete legal multibyte content beyond 128KiB',t=>{
 const f=fixture(t),payload=f.body();payload.lines=[f.first,...Array.from({length:29},()=>f.source())].map((record,i)=>({serviceRecordId:record.id,version:record.version,label:'人工'+i,amountCents:i,sourceReference:'核'.repeat(2000)}));assert.ok(Buffer.byteLength(JSON.stringify(payload))>128*1024);const before=f.state(),preview=previewServiceBilling(f.db,f.ctx,payload,hooks);assert.deepEqual(f.state(),before);assert.equal(preview.sources.length,30);assert.ok(preview.manualLines.every(line=>line.sourceReference===payload.lines[0].sourceReference));const{result}=f.create(payload);assert.equal(result.origin.manualLines.length,30);assert.equal(result.item.summary.amountCents,435);assert.deepEqual(result.origin.manualLines,payload.lines);
});
function largeSources(f,count,length=500){
 const items=Array.from({length:100},(_,i)=>insert(f.db,f.org,'service-items',{name:'核'.repeat(length),code:'號'.repeat(length),minutes:1,unitPriceCents:i,status:'active'})),services=items.map(item=>({serviceItemId:item.id,quantity:1}));
 return Array.from({length:count},()=>f.source('2026-10-05',services));
}
const sourceLines=records=>records.map((record,i)=>({serviceRecordId:record.id,version:record.version,label:'人工整筆'+i,amountCents:i+1,sourceReference:'本次人工核定'}));
test('complete source and origin list envelopes above 2MiB fail all; explicit smaller pages remain complete and do not write',t=>{
 const f=fixture(t),records=largeSources(f,7),before=f.state();
 rejects(()=>listServiceBillingSources(f.db,f.ctx,f.query(),hooks),'SERVICE_BILLING_TOO_LARGE');assert.deepEqual(f.state(),before);
 const page=listServiceBillingSources(f.db,f.ctx,{...f.query(),pageSize:1},hooks);assert.equal(page.total,8);assert.equal(page.items[0].billingSnapshot.items.length,100);assert.equal(page.items.length,1);
 const oversized={...f.body(),lines:sourceLines(records)};rejects(()=>previewServiceBilling(f.db,f.ctx,oversized,hooks),'SERVICE_BILLING_TOO_LARGE');assert.deepEqual(f.state(),before);
 for(const[ i,record ]of records.entries())f.create({...f.body(),number:'SB-LARGE-'+i,lines:sourceLines([record])});
 const saved=f.state();rejects(()=>readServiceBillingOrigins(f.db,f.ctx,f.query(),hooks),'SERVICE_BILLING_TOO_LARGE');assert.deepEqual(f.state(),saved);
 const originPage=readServiceBillingOrigins(f.db,f.ctx,{...f.query(),pageSize:1},hooks);assert.equal(originPage.total,7);assert.equal(originPage.items[0].origin.sourceSnapshots[0].billingSnapshot.items.length,100);
 assert.deepEqual(readServiceBillingOrigin(f.db,f.ctx,originPage.items[0].bill.id,hooks),originPage.items[0]);
});
test('new and cached complete ACK exceed 2MiB even when preview fits: new save rolls back rather than dropping duplicate snapshots',t=>{
 const f=fixture(t),records=[...largeSources(f,6),...largeSources(f,1,170)],payload={...f.body(),note:'核'.repeat(10000),sourceReference:'據'.repeat(2000),lines:sourceLines(records).map(line=>({...line,sourceReference:'核'.repeat(2000)}))},before=f.state();
 const preview=previewServiceBilling(f.db,f.ctx,payload,hooks),request={...payload,previewHash:preview.previewHash};assert.ok(Buffer.byteLength(JSON.stringify(preview))<=2*1024*1024);
 f.db.exec('BEGIN IMMEDIATE');try{
  rejects(()=>commitServiceBillingCreate(f.db,f.ctx,request,hooks),'SERVICE_BILLING_TOO_LARGE');
  const raw=f.db.prepare('SELECT * FROM records WHERE org_id=? AND entity=?').get(f.org,serviceBillingOriginEntity);assert.ok(raw);
  const origin={...JSON.parse(raw.data),id:raw.id,orgId:raw.org_id,version:raw.version,createdAt:raw.created_at,updatedAt:raw.updated_at},response={mode:serviceBillingMode,item:origin.initialBillSnapshot,origin};assert.ok(Buffer.byteLength(JSON.stringify(response))>2*1024*1024);
  rejects(()=>confirmServiceBillingCreateResponse(f.db,f.ctx,response,request,hooks),'SERVICE_BILLING_TOO_LARGE');
  rejects(()=>readServiceBillingOrigin(f.db,f.ctx,origin.billingDocumentId,hooks),'SERVICE_BILLING_TOO_LARGE');
 }finally{f.db.exec('ROLLBACK');}
 assert.deepEqual(f.state(),before);
});
