import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as spanFixture } from './helpers/shift-span-fixture.mjs';
import { insert } from '../src/server/model.mjs';
const legacy = f => { const data=f.shiftBody({date:'2026-10-10',startTime:'09:00',endTime:'10:00'});delete data.endDate;return data; };
const patch=(f,item)=>f.request(f.admin,'PATCH','/api/shifts/'+item.id,{version:item.version,note:'合成只更新正常班次'});
test('pure legacy shift PATCH skips malformed out-of-date dependencies exactly as original same-date lazy guard',async t=>{
 const f=await spanFixture(t),data=legacy(f),item=await f.create('shifts',data);
 const outside=insert(f.app.db,f.admin.org,'shifts',{...data,date:null,startTime:null,endTime:['合成非法原文'],note:'合成外期匯入'});
 const leave=insert(f.app.db,f.admin.org,'leave-requests',{employeeId:f.employee.id,date:'2026-10-11',startTime:'invalid',endTime:'10:00',type:'合成假別',reason:'合成外期請假',status:'approved'});
 const rows=()=>f.app.db.prepare('SELECT * FROM records WHERE id IN (?,?) ORDER BY id').all(outside.id,leave.id),before=rows();
 const result=await patch(f,item);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.item.version,2);assert.equal(Object.hasOwn(result.body.item,'endDate'),false);assert.deepEqual(rows(),before);
});
test('pure legacy relevant same-date malformed dependency still refuses PATCH with original TIME_RANGE and zero writes',async t=>{
 for(const entity of ['shifts','leave-requests']){
  const f=await spanFixture(t),data=legacy(f),item=await f.create('shifts',data);
  insert(f.app.db,f.admin.org,entity,entity==='shifts'?{...data,startTime:'invalid',note:'合成同日非法班'}:{employeeId:f.employee.id,date:data.date,startTime:'invalid',endTime:'10:00',type:'合成假別',status:'approved'});
  const before=f.state(),result=await patch(f,item);assert.equal(result.status,422);assert.equal(result.body.error.code,'TIME_RANGE');assert.deepEqual(f.state(),before);
 }
});
test('ever explicit organization keeps full strict dependency guard for out-of-date malformed legacy; no lazy downgrade',async t=>{
 const f=await spanFixture(t),data=legacy(f),item=await f.create('shifts',data);await f.create('shifts',f.shiftBody());
 insert(f.app.db,f.admin.org,'shifts',{...data,date:null,startTime:null,endTime:['合成非法原文']});
 const before=f.state(),result=await patch(f,item);assert.equal(result.status,409);assert.equal(result.body.error.code,'SPAN_DATA_INVALID');assert.deepEqual(f.state(),before);
});
