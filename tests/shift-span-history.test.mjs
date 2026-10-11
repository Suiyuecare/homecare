import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/shift-span-fixture.mjs';
import { id } from '../src/server/model.mjs';
import { referenceSnapshotKind } from '../public/data/shift-span.js';
const changes=f=>f.app.db.prepare('SELECT total_changes() n').get().n;
const state=f=>({rows:f.state(),changes:changes(f)});
const append=(f,entity,item,version,snapshot,source='span-update')=>f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org,entity,item.id,version,snapshot,item.updatedAt,source);

test('explicit span history keeps source scalars, exact comparisons, actors, raw old ISO and original role projections without writes',async t=>{
  const f=await fixture(t),rawStart='2026-12-29T08:00:59+08:00',rawEnd='2026-12-29T09:00:37+08:00';
  const old=await f.create('shifts',f.shiftBody({date:'2026-12-29',startTime:rawStart,endTime:rawEnd,endDate:undefined}));
  const updated=await f.request(f.admin,'PATCH','/api/shifts/'+old.id,{version:old.version,note:' 合成原文\r\n尾端 '});assert.equal(updated.status,200);
  const night=await f.create('shifts',f.shiftBody()),saved=await f.request(f.admin,'PATCH','/api/shifts/'+night.id,{version:night.version,note:'合成新跨日第二版'});assert.equal(saved.status,200);
  const before=state(f);
  const history=await f.request(f.admin,'GET','/api/shifts/'+night.id+'/history?compare=previous');assert.equal(history.status,200,JSON.stringify(history.body));
  assert.deepEqual(history.body.items.map(v=>v.source),['span-update','span-create']);assert.equal(history.body.items[0].comparison.previousSnapshot.endDate,night.endDate);assert.equal(history.body.items[0].actor.id,history.body.items[1].actor.id);
  const legacy=await f.request(f.admin,'GET','/api/shifts/'+old.id+'/history?compare=previous');assert.equal(legacy.status,200);assert.equal(legacy.body.items[1].snapshot.startTime,rawStart);assert.equal(legacy.body.items[1].snapshot.endTime,rawEnd);assert.ok(legacy.body.items.every(v=>!Object.hasOwn(v.snapshot,'endDate')));
  const own=await f.request(f.actors.caregiver,'GET','/api/shifts/'+night.id+'/history?compare=previous');assert.equal(own.status,200);assert.equal(own.body.items.length,2);assert.deepEqual(state(f),before);
});

for(const [label,version,snapshot] of [['malformed JSON',2n,'{broken'],['null snapshot',2n,'null'],['unsafe SQL version',9007199254740993n,'{}'],['mismatched saved identity',2n,JSON.stringify({id:'wrong'})]])test('explicit span '+label+' rejects whole history with zero writes',async t=>{
  const f=await fixture(t),item=await f.create('shifts',f.shiftBody());append(f,'shifts',item,version,snapshot);const before=state(f),r=await f.request(f.admin,'GET','/api/shifts/'+item.id+'/history?compare=previous');assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.error.code,'SPAN_HISTORY_INVALID');assert.deepEqual(state(f),before);
});

test('ever-explicit marker cannot fall back to legacy when current loses endDate and earlier malformed history is present',async t=>{
  const f=await fixture(t),item=await f.create('shifts',f.shiftBody()),data=f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id);const changed=JSON.parse(data.data);delete changed.endDate;
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(changed),item.id);append(f,'shifts',item,2n,'null');const before=state(f),r=await f.request(f.admin,'GET','/api/shifts/'+item.id+'/history');assert.equal(r.status,409);assert.deepEqual(state(f),before);
});

test('ordinary legacy current SQL id remains readable at exact 500 characters after span activation; Source7/Source12 limits unchanged',async t=>{
  const f=await fixture(t),longId='a'.repeat(500),original=await f.create('shifts',f.shiftBody({date:'2026-12-28',startTime:'08:00',endTime:'09:00',endDate:undefined}));
  const row=f.app.db.prepare('SELECT * FROM records WHERE id=?').get(original.id),snapshot={...original,id:longId};f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(longId,row.org_id,row.entity,row.data,row.version,row.created_at,row.updated_at);f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(row.org_id,row.entity,longId,row.version,JSON.stringify(snapshot),row.updated_at,'create');
  let r=await f.request(f.admin,'GET','/api/shifts/'+longId);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.item.id,longId);
  await f.create('shifts',f.shiftBody());const before=state(f);r=await f.request(f.admin,'GET','/api/shifts/'+longId);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.item.id,longId);r=await f.request(f.admin,'GET','/api/shifts/'+longId+'/history');assert.equal(r.status,200);assert.equal(r.body.items[0].snapshot.id,longId);assert.deepEqual(state(f),before);
  assert.throws(()=>referenceSnapshotKind({id:longId,orgId:f.admin.org,version:1,employeeId:f.employee.id,date:original.date,startTime:'08:00',endTime:'09:00'}));
});

test('leave conflict same-start explicit rows sort by complete absolute end then id, with legacy same-day order preserved',async t=>{
  const f=await fixture(t),short=await f.create('shifts',f.shiftBody({date:'2026-12-27',startTime:'23:00',endTime:'23:30',endDate:'2026-12-27'}));
  const long={...short,id:id(),version:1,endTime:'00:30',endDate:'2026-12-28'},data={...long};for(const key of ['id','orgId','version','createdAt','updatedAt'])delete data[key];f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(long.id,f.admin.org,'shifts',JSON.stringify(data),1,long.createdAt,long.updatedAt);f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org,'shifts',long.id,1,JSON.stringify(long),long.updatedAt,'span-create');
  const leave=await f.create('leave-requests',{employeeId:f.employee.id,date:short.date,endDate:'2026-12-28',startTime:'22:00',endTime:'01:00',type:'合成待審假',status:'pending'}),before=state(f),r=await f.request(f.admin,'GET','/api/leave-requests/'+leave.id+'/shift-conflicts');assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.items.map(v=>v.shiftId),[short.id,long.id]);assert.deepEqual(state(f),before);
});

test('closed saved span history rejects unknown nested service fields even when current SQL/head exactly agree',async t=>{
  const f=await fixture(t),item=await f.create('shifts',f.shiftBody()),corrupt={...item,version:2,services:[{...item.services[0],unknown:'must not be shown'}]},data={...corrupt};for(const key of ['id','orgId','version','createdAt','updatedAt'])delete data[key];
  f.app.db.prepare('UPDATE records SET data=?,version=2 WHERE id=?').run(JSON.stringify(data),item.id);append(f,'shifts',item,2n,JSON.stringify(corrupt));const before=state(f),r=await f.request(f.admin,'GET','/api/shifts/'+item.id+'/history');assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.error.code,'SPAN_HISTORY_INVALID');assert.deepEqual(state(f),before);
});

test('approved span history reads full saved financial head before role projection, closes snapshot header and never discloses captured money to caregiver',async t=>{
  const f=await fixture(t),shift=await f.create('shifts',f.shiftBody()),submitted=await f.create('service-records',{shiftId:shift.id,caseId:shift.caseId,employeeId:shift.employeeId,date:shift.date,actualStart:'23:30',actualEnd:'01:00',actualEndDate:'2027-01-01',services:f.services,status:'submitted'},f.actors.caregiver),approved=await f.request(f.admin,'POST','/api/service-records/'+submitted.id+'/review',{version:submitted.version,decision:'approved',reviewNote:'人工核閱'},id());assert.equal(approved.status,200);
  const before=state(f);for(const role of ['admin','finance','caregiver','supervisor']){const r=await f.request(f.actors[role],'GET','/api/service-records/'+submitted.id+'/history?compare=previous');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(Object.hasOwn(r.body.items[0].snapshot,'billingSnapshot'),['admin','finance'].includes(role));}assert.deepEqual(state(f),before);
  const corrupt={...approved.body.item,version:3,billingSnapshot:{...approved.body.item.billingSnapshot,unknown:'forbidden'}},data={...corrupt};for(const key of ['id','orgId','version','createdAt','updatedAt'])delete data[key];f.app.db.prepare('UPDATE records SET data=?,version=3 WHERE id=?').run(JSON.stringify(data),submitted.id);append(f,'service-records',approved.body.item,3n,JSON.stringify(corrupt));const badBefore=state(f),r=await f.request(f.admin,'GET','/api/service-records/'+submitted.id+'/history');assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.error.code,'SPAN_HISTORY_INVALID');assert.deepEqual(state(f),badBefore);
});

for(const explicit of [false,true])test('approved '+(explicit?'explicit':'legacy')+' history missing captured snapshot follows its original branch without writes',async t=>{
  const f=await fixture(t),shift=await f.create('shifts',f.shiftBody({date:'2026-12-30',startTime:'08:00',endTime:'09:00',...(explicit?{endDate:'2026-12-30'}:{endDate:undefined})}));
  const submitted=await f.create('service-records',{shiftId:shift.id,caseId:shift.caseId,employeeId:shift.employeeId,date:shift.date,actualStart:'08:00',actualEnd:'09:00',...(explicit?{actualEndDate:shift.date}:{}),services:f.services,status:'submitted'},f.actors.caregiver);
  const approved=await f.request(f.admin,'POST','/api/service-records/'+submitted.id+'/review',{version:submitted.version,decision:'approved',reviewNote:'合成核閱'},id());assert.equal(approved.status,200);
  const corrupt={...approved.body.item,version:3};delete corrupt.billingSnapshot;const data={...corrupt};for(const key of ['id','orgId','version','createdAt','updatedAt'])delete data[key];
  f.app.db.prepare('UPDATE records SET data=?,version=3 WHERE id=?').run(JSON.stringify(data),submitted.id);append(f,'service-records',approved.body.item,3n,JSON.stringify(corrupt),explicit?'span-update':'update');
  const before=state(f),result=await f.request(f.admin,'GET','/api/service-records/'+submitted.id+'/history');assert.equal(result.status,explicit?409:200,JSON.stringify(result.body));if(explicit)assert.equal(result.body.error.code,'SPAN_HISTORY_INVALID');assert.deepEqual(state(f),before);
});
