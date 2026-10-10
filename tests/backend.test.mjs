import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server/index.mjs';

async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'suiyue-backend-'));const app=createApp({dbPath:path.join(dir,'test.sqlite'),port:0});const base=await app.listen();
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const admin={cookie:'',csrf:'',org:''};
 const request=async(client,method,url,data,extra={})=>{const headers={'Origin':base,...(client?.cookie?{Cookie:client.cookie}:{}),...(client?.csrf?{'X-CSRF-Token':client.csrf}:{}),...(client?.org?{'X-Org-Id':client.org}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...extra};for(const k of Object.keys(headers))if(headers[k]===null)delete headers[k];const res=await fetch(base+url,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});const raw=await res.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}return{status:res.status,value,headers:res.headers};};
 const setup=await request(null,'POST','/api/setup',{name:'測試管理員',email:'admin@example.test',password:'local-test-password-12',organizationName:'合成機構甲'});assert.equal(setup.status,201,JSON.stringify(setup.value));admin.cookie=setup.headers.get('set-cookie').split(';')[0];admin.csrf=setup.value.csrfToken;admin.org=setup.value.organizations[0].id;
 const post=async(entity,data)=>{const r=await request(admin,'POST','/api/'+entity,data);assert.equal(r.status,201,JSON.stringify(r.value));return r.value.item;};
 const employee=await post('employees',{name:'合成居服員甲',employeeNo:'E01',role:'caregiver',hourlyRateCents:24000});const otherEmployee=await post('employees',{name:'合成居服員乙',employeeNo:'E02',role:'caregiver'});
 const caseItem=await post('cases',{name:'合成個案甲',caseNo:'C01'});const otherCase=await post('cases',{name:'合成個案乙',caseNo:'C02'});
 const service=await post('service-items',{code:'TEST-01',name:'合成服務',minutes:60,unitPriceCents:10000,status:'active'});
 const plan=await post('care-plans',{caseId:caseItem.id,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',services:[{serviceItemId:service.id,quantity:30}]});
 const otherPlan=await post('care-plans',{caseId:otherCase.id,validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',services:[{serviceItemId:service.id,quantity:30}]});
 const shiftData={caseId:caseItem.id,employeeId:employee.id,carePlanId:plan.id,date:'2026-10-08',startTime:'09:00',endTime:'10:00',services:[{serviceItemId:service.id,quantity:1}]};const shift=await post('shifts',shiftData);
 return{app,base,admin,request,post,employee,otherEmployee,caseItem,otherCase,service,plan,otherPlan,shift,shiftData};
}

test('first setup, login cookie and CSRF/origin protections',async t=>{
 const f=await fixture(t);const{request,admin}=f;
 assert.match(admin.cookie,/suiyue_session=/);
 const badSetup=await request(null,'POST','/api/setup',{name:'x',email:'x@example.test',password:'another-password-12',organizationName:'x'});assert.equal(badSetup.status,409);
 assert.equal((await request(admin,'POST','/api/cases',{name:'x',caseNo:'x'},{'X-CSRF-Token':null})).status,403);
 assert.equal((await request(admin,'POST','/api/cases',{name:'x',caseNo:'x'},{Origin:'https://evil.example'})).status,403);
 assert.equal((await request(admin,'POST','/api/cases',{name:'x',caseNo:'x'},{Origin:'not-a-url'})).status,403);
 assert.equal((await request(admin,'POST','/api/cases',{name:'x',caseNo:'x'},{'X-CSRF-Token':'é'.repeat(64)})).status,403);
 assert.equal((await request(null,'POST','/api/login',{email:'admin@example.test',password:'local-test-password-12'},{Origin:null})).status,403);
 const login=await request(null,'POST','/api/login',{email:'admin@example.test',password:'local-test-password-12'});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);assert.ok(!JSON.stringify(login.value).includes('password'));
 const noAuth=await request(null,'GET','/api/cases');assert.equal(noAuth.status,401);
});

test('organization isolation for list, object, foreign keys and unauthorized header',async t=>{
 const f=await fixture(t);const{request,admin,employee,caseItem,service}=f;
 const newOrg=await request(admin,'POST','/api/organizations',{name:'合成機構乙'});assert.equal(newOrg.status,201);const orgB={...admin,org:newOrg.value.item.id};
 assert.equal((await request(orgB,'GET','/api/cases')).value.total,0);
 assert.equal((await request(orgB,'GET','/api/cases/'+caseItem.id)).status,404);
 assert.equal((await request(orgB,'POST','/api/care-plans',{caseId:caseItem.id,validFrom:'2026-01-01',validTo:'2026-12-31',services:[{serviceItemId:service.id,quantity:1}]})).status,422);
 assert.equal((await request({...admin,org:'unknown'},'GET','/api/cases')).status,403);
 const user=await request(admin,'POST','/api/users',{name:'合成督導',email:'staff@example.test',password:'strong-local-password',role:'supervisor',employeeId:employee.id});assert.equal(user.status,201);
 const login=await request(null,'POST','/api/login',{email:'staff@example.test',password:'strong-local-password'});const staff={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.value.csrfToken,org:orgB.org};
 assert.equal((await request(staff,'GET','/api/cases')).status,403);
});

test('caregiver sees only own assignments and cannot create, reassign, review or read fees',async t=>{
 const f=await fixture(t);const{request,admin,employee,otherEmployee,otherCase,otherPlan,shift,shiftData,service}=f;
 const otherShift=await f.post('shifts',{...shiftData,caseId:otherCase.id,employeeId:otherEmployee.id,carePlanId:otherPlan.id});
 const u=await request(admin,'POST','/api/users',{name:'合成居服登入',email:'carer@example.test',password:'strong-local-password',role:'caregiver',employeeId:employee.id});assert.equal(u.status,201);
 const login=await request(null,'POST','/api/login',{email:'carer@example.test',password:'strong-local-password'});const carer={cookie:login.headers.get('set-cookie').split(';')[0],csrf:login.value.csrfToken,org:admin.org};
 assert.equal(login.value.user.employeeId,employee.id);assert.equal((await request(carer,'GET','/api/shifts')).value.total,1);assert.equal((await request(carer,'GET','/api/cases')).value.total,1);
 assert.equal((await request(carer,'GET','/api/shifts/'+otherShift.id)).status,404);
 assert.equal((await request(carer,'PATCH','/api/shifts/'+shift.id,{version:shift.version,note:'tamper'})).status,403);
 assert.equal((await request(carer,'GET','/api/reports/fees')).status,403);
 const data={shiftId:shift.id,caseId:shift.caseId,employeeId:employee.id,date:shift.date,actualStart:'09:00',actualEnd:'10:00',services:[{serviceItemId:service.id,quantity:1}]};const rec=await request(carer,'POST','/api/service-records',data);assert.equal(rec.status,201);
 assert.equal((await request(carer,'PATCH','/api/service-records/'+rec.value.item.id,{version:1,employeeId:otherEmployee.id})).status,403);
 assert.equal((await request(carer,'POST','/api/service-records/'+rec.value.item.id+'/review',{version:1,decision:'approved'})).status,403);
 assert.equal((await request(carer,'POST','/api/service-records',{...data,shiftId:otherShift.id,caseId:otherCase.id,employeeId:otherEmployee.id})).status,403);
});

test('schedule conflict checks cover employee, case, approved leave, plan and chronology',async t=>{
 const f=await fixture(t);const{request,admin,shiftData,otherCase,otherEmployee,otherPlan}=f;
 const conflict=await request(admin,'POST','/api/shifts',{...shiftData,startTime:'09:30',endTime:'10:30'});assert.equal(conflict.status,409);assert.equal(conflict.value.error.code,'SHIFT_CONFLICT');
 assert.equal((await request(admin,'POST','/api/shifts',{...shiftData,caseId:otherCase.id,carePlanId:otherPlan.id})).status,409);
 assert.equal((await request(admin,'POST','/api/shifts',{...shiftData,employeeId:otherEmployee.id})).status,409);
 assert.equal((await request(admin,'POST','/api/shifts',{...shiftData,startTime:'11:00',endTime:'10:00'})).status,422);
 assert.equal((await request(admin,'POST','/api/shifts',{...shiftData,date:'2026-02-30'})).status,422);
 const leave=await request(admin,'POST','/api/leave-requests',{employeeId:shiftData.employeeId,date:shiftData.date,startTime:'12:00',endTime:'13:00',type:'事假',status:'approved'});assert.equal(leave.status,201);
 const blocked=await request(admin,'POST','/api/shifts',{...shiftData,startTime:'12:00',endTime:'13:00'});assert.equal(blocked.status,409);assert.equal(blocked.value.error.code,'LEAVE_CONFLICT');
 assert.equal((await request(admin,'POST','/api/leave-requests',{employeeId:shiftData.employeeId,date:shiftData.date,startTime:'09:30',endTime:'10:30',type:'事假',status:'approved'})).status,409);
});

test('versions, unknown fields, POST idempotency and schema enforcement',async t=>{
 const f=await fixture(t);const{request,admin,caseItem}=f;
 assert.equal((await request(admin,'PATCH','/api/cases/'+caseItem.id,{name:'new'})).status,422);
 const changed=await request(admin,'PATCH','/api/cases/'+caseItem.id,{version:1,name:'合成改名'});assert.equal(changed.status,200);assert.equal(changed.value.item.version,2);
 assert.equal((await request(admin,'PATCH','/api/cases/'+caseItem.id,{version:1,name:'stale'})).status,409);
 assert.equal((await request(admin,'PATCH','/api/cases/'+caseItem.id,{version:2,orgId:'other'})).status,422);
 const data={title:'合成公告',body:'test'};const one=await request(admin,'POST','/api/announcements',data,{'Idempotency-Key':'test-retry-1'});const two=await request(admin,'POST','/api/announcements',data,{'Idempotency-Key':'test-retry-1'});assert.equal(one.status,201);assert.equal(one.value.item.id,two.value.item.id);
 assert.equal((await request(admin,'POST','/api/announcements',{...data,title:'changed'},{'Idempotency-Key':'test-retry-1'})).status,409);
 assert.equal((await request(admin,'GET','/api/announcements')).value.total,1);
});

test('submitted records are locked, review audited, approved immutable, and shift automatically completed',async t=>{
 const f=await fixture(t);const{request,admin,shift,service}=f;const data={shiftId:shift.id,caseId:shift.caseId,employeeId:shift.employeeId,date:shift.date,actualStart:'09:00',actualEnd:'10:00',services:[{serviceItemId:service.id,quantity:2}],status:'submitted'};
 const record=await request(admin,'POST','/api/service-records',data);assert.equal(record.status,201);const recordId=record.value.item.id;
 assert.equal((await request(admin,'POST','/api/service-records',data)).status,409);
 assert.equal((await request(admin,'PATCH','/api/service-records/'+recordId,{version:1,note:'tamper'})).status,409);
 const returned=await request(admin,'POST','/api/service-records/'+recordId+'/review',{version:1,decision:'returned',reviewNote:'補充說明'});assert.equal(returned.status,200);
 const submitted=await request(admin,'PATCH','/api/service-records/'+recordId,{version:2,status:'submitted',note:'已補充'});assert.equal(submitted.status,200);
 const approved=await request(admin,'POST','/api/service-records/'+recordId+'/review',{version:3,decision:'approved',reviewNote:'已核閱'},{'Idempotency-Key':'approve-retry'});assert.equal(approved.status,200);
 const retry=await request(admin,'POST','/api/service-records/'+recordId+'/review',{version:3,decision:'approved',reviewNote:'已核閱'},{'Idempotency-Key':'approve-retry'});assert.equal(retry.status,200);assert.equal(retry.value.item.version,4);
 assert.equal((await request(admin,'PATCH','/api/service-records/'+recordId,{version:4,note:'rewrite'})).status,409);
 assert.equal((await request(admin,'GET','/api/shifts/'+shift.id)).value.item.status,'completed');
 assert.equal((await request(admin,'GET','/api/service-records?month=2026-09')).value.total,0);
 assert.equal((await request(admin,'GET','/api/service-records?month=2026-10')).value.total,1);
 const audit=await request(admin,'GET','/api/audit?pageSize=100');assert.ok(audit.value.items.some(x=>x.action==='service.review'&&x.detail.decision==='approved'));
});

test('fees and payroll use approved records, integer cents, and CSV cells prevent formula injection',async t=>{
 const f=await fixture(t);const{request,admin,shift,service,caseItem}=f;
 await request(admin,'PATCH','/api/cases/'+caseItem.id,{version:1,name:'=HYPERLINK("https://example.test")'});
 const record=await request(admin,'POST','/api/service-records',{shiftId:shift.id,caseId:shift.caseId,employeeId:shift.employeeId,date:shift.date,actualStart:'09:00',actualEnd:'10:00',services:[{serviceItemId:service.id,quantity:2}],status:'submitted'});
 assert.equal((await request(admin,'GET','/api/reports/fees?month=2026-10')).value.totals.amountCents,0);
 await request(admin,'POST','/api/service-records/'+record.value.item.id+'/review',{version:1,decision:'approved'});
 const fees=await request(admin,'GET','/api/reports/fees?month=2026-10');assert.equal(fees.value.totals.amountCents,20000);assert.match(fees.value.note,/未核定/);
 const payroll=await request(admin,'GET','/api/reports/payroll?month=2026-10');assert.equal(payroll.value.totals.amountCents,24000);assert.equal(payroll.value.totals.minutes,60);
 const csv=await request(admin,'GET','/api/reports/fees?month=2026-10&format=csv');assert.equal(csv.status,200);assert.match(csv.value,/"'=HYPERLINK/);assert.ok(!csv.value.includes(',"=HYPERLINK'));
 assert.equal((await request(admin,'GET','/api/reports/fees?month=invalid')).status,422);
});

test('demo is synthetic and idempotent, and static data files cannot be fetched',async t=>{
 const f=await fixture(t);const{request,admin}=f;
 const first=await request(admin,'POST','/api/demo/seed',{});assert.equal(first.status,200);assert.equal(first.value.seeded,true);
 const second=await request(admin,'POST','/api/demo/seed',{});assert.equal(second.value.seeded,false);
 const items=await request(admin,'GET','/api/service-items?pageSize=100');assert.ok(items.value.items.every(x=>x.code.startsWith('TEST-')));
 assert.equal((await request(null,'GET','/data/care.sqlite')).status,404);
 assert.equal((await request(null,'GET','/src/server/index.mjs')).status,404);
 const logout=await request(admin,'POST','/api/logout',{});assert.equal(logout.status,200);assert.equal((await request(admin,'GET','/api/cases')).status,401);
});


test('approval captures immutable historical prices/rates and version history stays scoped and append-only',async t=>{
 const f=await fixture(t);const{request,admin,shift,service,employee,caseItem}=f;
 const record=await request(admin,'POST','/api/service-records',{shiftId:shift.id,caseId:shift.caseId,employeeId:shift.employeeId,date:shift.date,actualStart:'09:00',actualEnd:'10:00',services:[{serviceItemId:service.id,quantity:2}],status:'submitted'});
 const approved=await request(admin,'POST','/api/service-records/'+record.value.item.id+'/review',{version:1,decision:'approved'});assert.equal(approved.status,200);assert.equal(approved.value.item.billingSnapshot.items[0].unitPriceCents,10000);
 assert.equal((await request(admin,'PATCH','/api/service-items/'+service.id,{version:1,unitPriceCents:99999})).status,200);
 assert.equal((await request(admin,'PATCH','/api/employees/'+employee.id,{version:1,hourlyRateCents:99999})).status,200);
 assert.equal((await request(admin,'GET','/api/reports/fees?month=2026-10')).value.totals.amountCents,20000);
 assert.equal((await request(admin,'GET','/api/reports/payroll?month=2026-10')).value.totals.amountCents,24000);
 const history=await request(admin,'GET','/api/service-records/'+record.value.item.id+'/history');assert.equal(history.status,200);assert.equal(history.value.total,2);assert.equal(history.value.items[0].snapshot.status,'approved');assert.equal(history.value.items[1].snapshot.status,'submitted');
 const prices=await request(admin,'GET','/api/service-items/'+service.id+'/history');assert.equal(prices.value.items[0].snapshot.unitPriceCents,99999);assert.equal(prices.value.items[1].snapshot.unitPriceCents,10000);
 assert.throws(()=>f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper',service.id),/immutable/);
 const other=await request(admin,'POST','/api/organizations',{name:'歷史隔離機構'});assert.equal((await request({...admin,org:other.value.item.id},'GET','/api/service-items/'+service.id+'/history')).status,404);
 const dash=await request(admin,'GET','/api/dashboard?date=2026-10-08');assert.equal(dash.value.todayShifts.length,1);assert.equal(dash.value.counts.activeEmployees,2);
 const users=await request(admin,'GET','/api/users?page=2&pageSize=1');assert.equal(users.value.total,1);assert.deepEqual(users.value.items,[]);
});


test('billing snapshots never escape caregiver read/write/history/dashboard or supervisor review responses',async t=>{
 const f=await fixture(t);const{request,admin,shift,employee,service}=f;
 const loginAs=async(role,email,employeeId)=>{const created=await request(admin,'POST','/api/users',{name:'合成'+role,email,password:'strong-local-password',role,...(employeeId?{employeeId}:{})});assert.equal(created.status,201);const result=await request(null,'POST','/api/login',{email,password:'strong-local-password'});return{cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.value.csrfToken,org:admin.org};};
 const carer=await loginAs('caregiver','care-billing@example.test',employee.id),supervisor=await loginAs('supervisor','sup-billing@example.test');
 const noFinancial=r=>{assert.equal(r.status,200);assert.ok(!JSON.stringify(r.value).includes('billingSnapshot'));};
 const created=await request(carer,'POST','/api/service-records',{shiftId:shift.id,caseId:shift.caseId,employeeId:shift.employeeId,date:shift.date,actualStart:'09:00',actualEnd:'10:00',services:[{serviceItemId:service.id,quantity:1}]});assert.equal(created.status,201);assert.ok(!('billingSnapshot' in created.value.item));
 const recordId=created.value.item.id;noFinancial(await request(carer,'PATCH','/api/service-records/'+recordId,{version:1,status:'submitted'}));
 noFinancial(await request(supervisor,'POST','/api/service-records/'+recordId+'/review',{version:2,decision:'approved'}));
 noFinancial(await request(carer,'GET','/api/service-records'));
 noFinancial(await request(carer,'GET','/api/service-records/'+recordId));
 noFinancial(await request(carer,'GET','/api/service-records/'+recordId+'/history'));
 noFinancial(await request(carer,'GET','/api/dashboard?date='+shift.date));
 const privileged=await request(admin,'GET','/api/service-records/'+recordId);assert.ok(privileged.value.item.billingSnapshot);
});
