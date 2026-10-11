import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { business, replace } from '../src/server/model.mjs';
import { createHash } from 'node:crypto';

const raw=db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const state=db=>{const tables=raw(db),triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();assert.equal(Object.keys(tables).length,11);assert.equal(triggers.length,6);return{changes:db.prepare('SELECT total_changes() n').get().n,tables,triggers};};
async function fixture(t){
 const app=createApp({dbPath:':memory:',host:'127.0.0.1',port:0});t.after(()=>app.close());
 const base=await app.listen();assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'4310');
 const setup=await fetch(base+'/api/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'合成撤權窗口管理者',email:'authority-window@example.test',password:'synthetic-authority-window-password',organizationName:'合成撤權窗口機構'})});assert.equal(setup.status,201);const auth=await setup.json();const cookie=setup.headers.get('set-cookie').split(';')[0],org=auth.organizations[0].id;
 const request=async(method,route,payload,key)=>{const response=await fetch(base+route,{method,headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrfToken,'X-Org-Id':org,...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(payload)});return{status:response.status,body:await response.json()};};
 const create=async()=>{const result=await request('POST','/api/cases',{name:'合成已保存個案',caseNo:'WINDOW-C'});assert.equal(result.status,201);return result.body.item;};
 const arm=(route,method,change)=>{let saved;const listener=req=>{if(req.url===route&&req.method===method){app.server.off('request',listener);change(req);saved=state(app.db);}};app.server.on('request',listener);return()=>{assert(saved,'Authority must change in the real HTTP request/body window');assert.deepEqual(state(app.db),saved,'Denied original or cached mutation must leave all 11 tables, six triggers, and total_changes unchanged after revocation');};};
 const login=async(email)=>{const result=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email,password:'synthetic-authority-window-password'})});assert.equal(result.status,200);const current=await result.json(),actorCookie=result.headers.get('set-cookie').split(';')[0];return{auth:current,request:async(method,route,payload,key)=>{const response=await fetch(base+route,{method,headers:{Origin:base,Cookie:actorCookie,'Content-Type':'application/json','X-CSRF-Token':current.csrfToken,'X-Org-Id':org,...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(payload)});return{status:response.status,body:await response.json()};}};};
 const work=async()=>{const post=async(entity,payload)=>{const result=await request('POST','/api/'+entity,payload);assert.equal(result.status,201,JSON.stringify(result));return result.body.item;};const employee=await post('employees',{name:'合成撤權居服員',employeeNo:'WINDOW-E',role:'caregiver'}),otherEmployee=await post('employees',{name:'合成另一有效居服員',employeeNo:'WINDOW-E2',role:'caregiver'}),caseItem=await create(),service=await post('service-items',{code:'WINDOW-S',name:'合成服務',minutes:60,unitPriceCents:10000}),plan=await post('care-plans',{caseId:caseItem.id,validFrom:'2027-01-01',validTo:'2027-12-31',status:'active',services:[{serviceItemId:service.id,quantity:100}]}),shift=await post('shifts',{caseId:caseItem.id,employeeId:employee.id,carePlanId:plan.id,date:'2027-01-10',startTime:'09:00',endTime:'10:00',services:[{serviceItemId:service.id,quantity:1}]});const payload={shiftId:shift.id,caseId:caseItem.id,employeeId:employee.id,date:shift.date,actualStart:'09:00',actualEnd:'10:00',status:'submitted',services:shift.services};return{employee,otherEmployee,caseItem,service,plan,shift,payload,post};};
 return{app,org,auth,request,create,arm,base,cookie,login,work};
}
test('real HTTP role revoked while create body awaits denies old admin privileges with all-table zero-write',async t=>{
 const f=await fixture(t);const unchanged=f.arm('/api/cases','POST',()=>f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.org,f.auth.user.id));
 const result=await f.request('POST','/api/cases',{name:'合成撤權後不可新增',caseNo:'DENIED-CREATE'},'synthetic-window-create');assert.equal(result.status,403);unchanged();
});
test('real HTTP membership removed while create body awaits denies old organization context with all-table zero-write',async t=>{
 const f=await fixture(t);const unchanged=f.arm('/api/cases','POST',()=>f.app.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.org,f.auth.user.id));
 const result=await f.request('POST','/api/cases',{name:'合成退籍後不可新增',caseNo:'DENIED-MEMBERSHIP'});assert.equal(result.status,403);unchanged();
});
test('real HTTP logout while PATCH body awaits denies the pre-body session and preserves saved version and audit',async t=>{
 const f=await fixture(t),item=await f.create(),route='/api/cases/'+item.id;const unchanged=f.arm(route,'PATCH',()=>f.app.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.auth.user.id));
 const result=await f.request('PATCH',route,{version:item.version,name:'合成登出後不可改寫'});assert.equal(result.status,401);unchanged();
});
test('real HTTP role drift while PATCH body awaits cannot save using stale manager authority',async t=>{
 const f=await fixture(t),item=await f.create(),route='/api/cases/'+item.id;const unchanged=f.arm(route,'PATCH',()=>f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.org,f.auth.user.id));
 const result=await f.request('PATCH',route,{version:item.version,name:'合成降權後不可改寫'});assert.equal(result.status,403);unchanged();
});
test('real HTTP role drift before cached idempotency reply cannot expose a pre-revocation create receipt',async t=>{
 const f=await fixture(t),payload={name:'合成重送來源個案',caseNo:'WINDOW-REPLAY'},key='synthetic-window-replay';const created=await f.request('POST','/api/cases',payload,key);assert.equal(created.status,201);
 const unchanged=f.arm('/api/cases','POST',()=>f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.org,f.auth.user.id));
 const result=await f.request('POST','/api/cases',payload,key);assert.equal(result.status,403);unchanged();
});
for(const [label,route,payload]of[
 ['user provisioning','/api/users',{name:'合成不得開通帳號',email:'denied-new@example.test',password:'synthetic-authority-window-password',role:'admin'}],
 ['organization settings','/api/organizations',{name:'合成不得建立機構'}],
 ['demo seed','/api/demo/seed',{}],
])test(`real HTTP ${label} cannot retain the admin guard checked before the body await`,async t=>{
 const f=await fixture(t);const unchanged=f.arm(route,'POST',()=>f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.org,f.auth.user.id));
 const result=await f.request('POST',route,payload,'synthetic-window-'+label.replaceAll(' ','-'));assert.equal(result.status,403);unchanged();
});
test('real HTTP expired session during body read must return 401 before mutations or idempotency writes',async t=>{
 const f=await fixture(t);const unchanged=f.arm('/api/cases','POST',()=>f.app.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(f.auth.user.id));
 const result=await f.request('POST','/api/cases',{name:'合成過期後不可新增',caseNo:'DENIED-EXPIRED'});assert.equal(result.status,401);unchanged();
});
test('real HTTP changed current CSRF during body read must reject the formerly valid token',async t=>{
 const f=await fixture(t);const unchanged=f.arm('/api/cases','POST',()=>f.app.db.prepare('UPDATE sessions SET csrf=? WHERE user_id=?').run('0'.repeat(64),f.auth.user.id));
 const result=await f.request('POST','/api/cases',{name:'合成舊安全碼不可新增',caseNo:'DENIED-CSRF'});assert.equal(result.status,403);assert.equal(result.body.error.code,'CSRF_INVALID');unchanged();
});
test('real HTTP user removed during body read must reject the originally authenticated identity',async t=>{
 const f=await fixture(t);const unchanged=f.arm('/api/cases','POST',()=>{f.app.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.auth.user.id);f.app.db.prepare('DELETE FROM memberships WHERE user_id=?').run(f.auth.user.id);f.app.db.prepare('DELETE FROM users WHERE id=?').run(f.auth.user.id);});
 const result=await f.request('POST','/api/cases',{name:'合成已刪帳號不可新增',caseNo:'DENIED-USER'});assert.equal(result.status,401);unchanged();
});
test('real HTTP original organization is pinned even when another current admin membership also exists',async t=>{
 const f=await fixture(t);const foreign=await f.request('POST','/api/organizations',{name:'合成另一管理機構'});assert.equal(foreign.status,201);
 const unchanged=f.arm('/api/cases','POST',req=>{req.headers['x-org-id']=foreign.body.item.id;});
 const result=await f.request('POST','/api/cases',{name:'合成不可中途切機構',caseNo:'DENIED-ORG-SWITCH'});assert.equal(result.status,403);unchanged();
});
test('real HTTP original origin guard still applies after the body read rather than trusting a captured ctx',async t=>{
 const f=await fixture(t);const unchanged=f.arm('/api/cases','POST',req=>{req.headers.origin='https://untrusted.example.test';});
 const result=await f.request('POST','/api/cases',{name:'合成不可變更來源',caseNo:'DENIED-ORIGIN'});assert.equal(result.status,403);assert.equal(result.body.error.code,'ORIGIN_FORBIDDEN');unchanged();
});
test('real HTTP same user and CSRF in a different session cannot replace the originally captured session',async t=>{
 const f=await fixture(t),token='a'.repeat(64),tokenHash=createHash('sha256').update(token).digest('hex');
 const unchanged=f.arm('/api/cases','POST',req=>{f.app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash,f.auth.user.id,f.auth.csrfToken,Date.now()+60000);req.headers.cookie='suiyue_session='+token;});
 const result=await f.request('POST','/api/cases',{name:'合成不可替換登入',caseNo:'DENIED-SESSION-SWITCH'});assert.equal(result.status,403);unchanged();
});
test('real HTTP service review cannot approve or generate billing snapshot and complete shift after role revocation',async t=>{
 const f=await fixture(t),work=await f.work(),record=await work.post('service-records',work.payload),route='/api/service-records/'+record.id+'/review';
 const unchanged=f.arm(route,'POST',()=>f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.org,f.auth.user.id));
 const result=await f.request('POST',route,{version:record.version,decision:'approved',reviewNote:'合成撤權後不可核閱'},'synthetic-window-review');assert.equal(result.status,403);unchanged();
});
for(const change of ['inactive employee','missing employee link','changed active employee link'])test(`real HTTP caregiver ${change} during body read cannot submit using the old employee authority`,async t=>{
 const f=await fixture(t),work=await f.work(),user=await work.post('users',{name:'合成提交居服員',email:'window-caregiver@example.test',password:'synthetic-authority-window-password',role:'caregiver',employeeId:work.employee.id}),caregiver=await f.login(user.email);
 const unchanged=f.arm('/api/service-records','POST',()=>{
  if(change==='inactive employee')replace(f.app.db,f.org,'employees',work.employee,{...business(work.employee),status:'inactive'});
  else f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(change==='missing employee link'?null:work.otherEmployee.id,f.org,user.id);
 });
 const result=await caregiver.request('POST','/api/service-records',work.payload,'synthetic-window-caregiver');assert.equal(result.status,403);unchanged();
});
test('normal setup/login and stable current authority keep POST/PATCH/review and zero-write cached success behavior',async t=>{
 const f=await fixture(t),payload={name:'合成合法個案',caseNo:'ALLOWED-C'},key='synthetic-window-normal-create';const created=await f.request('POST','/api/cases',payload,key);assert.equal(created.status,201);
 const before=state(f.app.db),cached=await f.request('POST','/api/cases',payload,key);assert.equal(cached.status,201);assert.deepEqual(cached.body,created.body);assert.deepEqual(state(f.app.db),before);
 const patched=await f.request('PATCH','/api/cases/'+created.body.item.id,{version:created.body.item.version,name:'合成合法第二版'});assert.equal(patched.status,200);assert.equal(patched.body.item.version,2);
 const work=await f.work(),record=await work.post('service-records',work.payload),reviewed=await f.request('POST','/api/service-records/'+record.id+'/review',{version:record.version,decision:'approved',reviewNote:'合成合法核閱'},'synthetic-window-normal-review');assert.equal(reviewed.status,200);assert.equal(reviewed.body.item.status,'approved');assert(reviewed.body.item.billingSnapshot);assert.equal(f.app.db.prepare("SELECT COUNT(*) n FROM records WHERE entity='shifts' AND json_extract(data,'$.status')='completed'").get().n,1);
});
