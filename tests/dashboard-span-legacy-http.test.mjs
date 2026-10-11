import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/shift-span-fixture.mjs';
import { insert } from '../src/server/model.mjs';
const route = date => '/api/dashboard?date=' + date + '&spanMode=calendar-two-day-v1';
const legacy = (f, extra = {}) => { const value = f.shiftBody({ date: '2026-10-10', startTime: '09:00', endTime: '10:00', ...extra }); delete value.endDate; return value; };
const ids = response => response.body.todayShifts.map(item => item.id).sort();
test('dashboard span mode preserves legacy exact-date lazy reads, including malformed matching times; all reads zero write', async t => {
 const f = await fixture(t), normal = await f.create('shifts', legacy(f));
 const outside = insert(f.app.db, f.admin.org, 'shifts', legacy(f, { date:null,startTime:null,endTime:['合成外期非法時段'] }));
 const matching = insert(f.app.db, f.admin.org, 'shifts', legacy(f, { startTime:null,endTime:['合成當日非法時段'] }));
 const before = f.state();
 for(const query of ['/api/dashboard?date=2026-10-10',route('2026-10-10')]){
  const result=await f.request(f.admin,'GET',query);assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(ids(result),[normal.id,matching.id].sort());assert.equal(ids(result).includes(outside.id),false);
  const preserved=result.body.todayShifts.find(item=>item.id===matching.id);assert.equal(preserved.startTime,null);assert.deepEqual(preserved.endTime,['合成當日非法時段']);
 }
 const other=await f.request(f.admin,'GET',route('2026-10-11'));assert.equal(other.status,200);assert.deepEqual(ids(other),[]);assert.deepEqual(f.state(),before);
});
test('dashboard explicit carry covers occupied next day and exact midnight does not occupy next day; legacy query stays starts only', async t => {
 const f=await fixture(t), carry=await f.create('shifts',f.shiftBody({date:'2026-10-10',endDate:'2026-10-11'}));
 const midnight=await f.create('shifts',f.shiftBody({employeeId:f.otherEmployee.id,date:'2026-10-12',endDate:'2026-10-13',startTime:'22:00',endTime:'00:00'}));
 const before=f.state(), original=await f.request(f.admin,'GET','/api/dashboard?date=2026-10-11');assert.equal(original.status,200);assert.deepEqual(ids(original),[]);
 const next=await f.request(f.admin,'GET',route('2026-10-11'));assert.equal(next.status,200);assert.deepEqual(ids(next),[carry.id]);assert.equal(next.body.spanMode,'calendar-two-day-v1');
 const start=await f.request(f.admin,'GET',route('2026-10-10'));assert.equal(start.status,200);assert.deepEqual(ids(start),[carry.id]);const midnightStart=await f.request(f.admin,'GET',route('2026-10-12'));assert.equal(midnightStart.status,200);assert.deepEqual(ids(midnightStart),[midnight.id]);const midnightNext=await f.request(f.admin,'GET',route('2026-10-13'));assert.equal(midnightNext.status,200);assert.deepEqual(ids(midnightNext),[]);assert.deepEqual(f.state(),before);
});
test('dashboard malformed explicit span returns closed 409, never 500 or partial data, with zero writes',async t=>{
 const f=await fixture(t);await f.create('shifts',f.shiftBody());insert(f.app.db,f.admin.org,'shifts',f.shiftBody({endDate:'not-a-date'}));
 const before=f.state(),result=await f.request(f.admin,'GET',route('2027-01-01'));assert.equal(result.status,409);assert.equal(result.body.error.code,'SPAN_DATA_INVALID');assert.equal(Object.hasOwn(result.body,'todayShifts'),false);assert.deepEqual(f.state(),before);
});
test('dashboard carry keeps real caregiver own employee and organization scope; foreign org is forbidden and zero writes',async t=>{
 const f=await fixture(t), own=await f.create('shifts',f.shiftBody()), other=await f.create('shifts',f.shiftBody({employeeId:f.otherEmployee.id,date:'2027-01-01',endDate:'2027-01-01',startTime:'02:00',endTime:'03:00'}));
 const organization=await f.request(f.admin,'POST','/api/organizations',{name:'合成 dashboard 外機構'});assert.equal(organization.status,201);const foreignOrg=organization.body.item.id;
 const foreign=insert(f.app.db,foreignOrg,'shifts',f.shiftBody());const before=f.state();
 const result=await f.request(f.actors.caregiver,'GET',route('2027-01-01'));assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(ids(result),[own.id]);assert.equal(ids(result).includes(other.id),false);assert.equal(ids(result).includes(foreign.id),false);
 const denied=await f.request({...f.actors.caregiver,org:foreignOrg},'GET',route('2027-01-01'));assert.equal(denied.status,403);assert.equal(Object.hasOwn(denied.body,'todayShifts'),false);assert.deepEqual(f.state(),before);
});
