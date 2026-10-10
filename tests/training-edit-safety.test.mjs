import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert, replace } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';
import { createTrainingEditor } from '../public/data/training-editor.js';

const ENTITY = 'employee-training', password = 'synthetic-training-editor-password';
const keys = ['employeeId','name','category','provider','date','trainingMinutes','status','note'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const route = item => `/api/${ENTITY}/${item.id}`;
const history = (item, compare = true) => route(item) + '/history' + (compare ? '?compare=previous' : '');
const projection = item => Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  async function request(client, method, url, data, headers = {}, raw) {
    const response = await fetch(base + url, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成證照管理者', email: 'admin@training-editor.example.test', password, organizationName: '合成證照甲機構' }); assert.equal(setup.status, 201);
  const clientFrom = r => ({ cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.body.csrfToken, org: setup.body.organizations[0].id, user: r.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin, headers = {}) { const r = await request(caller, 'POST', '/api/' + entity, data, headers); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.item; }
  async function patch(entity, item, data, caller = admin) { const r = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { ...data, version: item.version }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.item; }
  const employee = await create('employees', { name: '合成甲員工', employeeNo: 'TEST-CERT-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成乙員工', employeeNo: 'TEST-CERT-B', hourlyRateCents: 24000 });
  const inactive = await create('employees', { name: '合成停用員工', employeeNo: 'TEST-CERT-INACTIVE', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@training-editor.example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const service = await create('service-items', { code: 'TEST-CERT-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const careCase = await create('cases', { caseNo: 'TEST-CERT-CASE', name: '合成服務個案' }), services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shiftData = extra => ({ caseId: careCase.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-09', startTime: '09:00', endTime: '10:00', services, ...extra });
  const shift = await create('shifts', shiftData());
  const data = extra => ({ employeeId: employee.id, name: '合成課程', category: 'in_service', provider: ' 原單位 ', date: '2026-10-09', trainingMinutes: 61, status: 'completed', note: ' 合成備註\n', ...extra });
  const editor = existing => createTrainingEditor({ existing, employees: [employee, employeeB, inactive], defaultDate: '2026-10-09' });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  const imported = value => insert(app.db, admin.org, ENTITY, value); // INSERT-only memory imports, never normal-API claims or real data.
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const reviewed = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(reviewed.status, 200);
    return (await request(admin, 'GET', '/api/service-records/' + record.id)).body.item;
  }
  return { app, request, create, patch, admin, clients, employee, employeeB, inactive, careCase, services, service, plan, shift, shiftData, data, editor, state, imported, approve };
}

test('eight-field create normalized name selective edit no-op and cancel restore preserve actors and audit field omission',async t=>{
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({employeeId:f.employee.id,name:'　合成課程  ',provider:' 原單位 ',trainingHours:1.25,note:' 第一行\n第二行 '});assert.deepEqual(Object.keys(p).sort(),[...keys].sort());
 const first=await f.create(ENTITY,p);e.confirm(first,f.admin.org,p);assert.equal(first.name,'合成課程');assert.equal(first.trainingMinutes,75);assert.equal(first.status,'completed');
 const edit=f.editor(first),update=edit.buildPayload({category:'pre_service',trainingHours:2.5,note:'督導修改'}),second=await f.patch(ENTITY,first,update,f.clients.supervisor);edit.confirm(second,f.admin.org,update);assert.equal(second.trainingMinutes,150);
 const noop=f.editor(second),third=await f.patch(ENTITY,second,noop.buildPayload(noop.initial));noop.confirm(third,f.admin.org,{});
 const cancelled=f.editor(third),fourth=await f.patch(ENTITY,third,{status:'cancelled'},f.clients.supervisor);cancelled.confirm(fourth,f.admin.org,{status:'cancelled'});
 const restored=f.editor(fourth),fifth=await f.patch(ENTITY,fourth,{status:'completed'});restored.confirm(fifth,f.admin.org,{status:'completed'});
 const before=f.state(),h=await f.request(f.admin,'GET',history(fifth));assert.equal(h.status,200);assert.deepEqual(h.body.items.map(x=>x.actor.id),[f.admin.user.id,f.clients.supervisor.user.id,f.admin.user.id,f.clients.supervisor.user.id,f.admin.user.id]);assert.deepEqual(projection(h.body.items.at(-1).snapshot),p);assert.deepEqual(f.state(),before);
 const details=f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=? ORDER BY rowid').all(first.id,'record.update').map(x=>JSON.parse(x.detail));assert.deepEqual(details.map(x=>x.fields),[['category','trainingMinutes','note'],[],['status'],['status']]);
});

test('one seven sixty-one and upper-bound minutes keep full precision with no minute audit field when unchanged or round-back equivalent',async t=>{
 const f=await fixture(t);
 for(const minutes of [1,7,61,75,150,60000]){
  const e=f.editor(),p=e.buildPayload({employeeId:f.employee.id,name:'合成 '+minutes+' 分鐘',trainingHours:Number(String(minutes/60))}),first=await f.create(ENTITY,p);e.confirm(first,f.admin.org,p);assert.equal(first.trainingMinutes,minutes);
  const edit=f.editor(first),change=edit.buildPayload({...edit.initial,note:'只改備註'});assert.deepEqual(change,{note:'只改備註'});const second=await f.patch(ENTITY,first,change);edit.confirm(second,f.admin.org,change);assert.equal(second.trainingMinutes,minutes);
  const h=await f.request(f.admin,'GET',history(second));assert.deepEqual(h.body.items.map(x=>x.snapshot.trainingMinutes),[minutes,minutes]);
  const audit=f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=?').get(first.id,'record.update');assert.deepEqual(JSON.parse(audit.detail).fields,['note']);
 }
 const original=await f.create(ENTITY,f.data({trainingMinutes:60})),e=f.editor(original),p=e.buildPayload({trainingHours:1+1e-9});assert.deepEqual(p,{});const saved=await f.patch(ENTITY,original,p);e.confirm(saved,f.admin.org,p);assert.equal(saved.trainingMinutes,60);
 const before=f.state();for(const trainingHours of [1.001,1+1e-8,0,1000+1e-9,null,'1',[],{}])assert.throws(()=>e.buildPayload({trainingHours}),x=>!!x.fields?.trainingHours);assert.deepEqual(f.state(),before);
});

test('normal API CRLF and imported untrimmed name preserve bytes until explicit replacement or provider-note clearing',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data({name:' 合成\r\n課程 ',provider:'PRIVATE\r\n單位',note:'PRIVATE\r\n備註'})),e=f.editor(first);
 for(const key of ['name','provider','note']){assert.equal(e.needsIntent(key),true);assert.equal(e.initial[key],'');}assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
 const p=e.buildPayload({category:'other'}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);for(const key of ['name','provider','note'])assert.equal(second[key],first[key]);
 const edit=f.editor(second),change=edit.buildPayload({nameIntent:'replace',name:'　新課程　',providerIntent:'clear',noteIntent:'clear'}),third=await f.patch(ENTITY,second,change);edit.confirm(third,f.admin.org,change);assert.equal(third.name,'新課程');assert.equal(third.provider,'');assert.equal(third.note,'');
 const imported=f.imported(f.data({name:'  原匯入課程　'})),keep=f.editor(imported),only=keep.buildPayload({note:'只改備註'}),saved=await f.patch(ENTITY,imported,only);keep.confirm(saved,f.admin.org,only);assert.equal(saved.name,imported.name);
 const normalize=f.editor(saved),changed=normalize.buildPayload({name:'　原匯入課程　'}),fixed=await f.patch(ENTITY,saved,changed);normalize.confirm(fixed,f.admin.org,changed);assert.equal(fixed.name,'原匯入課程');
});

test('year0000 is kept but malformed imported required minutes category dates and statuses retain original merged422 guards',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data({date:'0000-02-29'})),e=f.editor(first);assert.equal(e.initial.date,'');assert.equal(e.needsIntent('date'),true);
 const p=e.buildPayload({note:'年零原樣保持'}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);assert.equal(second.date,'0000-02-29');
 const ed=f.editor(second),native=ed.buildPayload({dateIntent:'replace',date:'0001-01-01'}),third=await f.patch(ENTITY,second,native);ed.confirm(third,f.admin.org,native);
 const cases=[['trainingMinutes',undefined,'REQUIRED'],['trainingMinutes',null,'REQUIRED'],['trainingMinutes','','REQUIRED'],['trainingMinutes',0,'INVALID_NUMBER'],['trainingMinutes',-1,'INVALID_NUMBER'],['trainingMinutes',1.5,'INVALID_NUMBER'],['trainingMinutes',60001,'INVALID_NUMBER'],['trainingMinutes','61','INVALID_NUMBER'],['trainingMinutes',[61],'INVALID_NUMBER'],['trainingMinutes',{secret:'PRIVATE'},'INVALID_NUMBER'],['category',undefined,'REQUIRED'],['category',null,'REQUIRED'],['category','unknown','INVALID_CATEGORY'],['category','constructor','INVALID_CATEGORY'],['category',['in_service'],'INVALID_CATEGORY'],['date',undefined,'REQUIRED'],['date',null,'REQUIRED'],['date','2026-02-30','INVALID_DATE'],['date',{secret:'PRIVATE'},'INVALID_DATE'],['status','unknown','INVALID_STATUS']];
 for(const [key,value,code]of cases){const data=f.data({[key]:value});if(value===undefined)delete data[key];const item=f.imported(data),editor=f.editor(item),before=f.state(),response=await f.request(f.admin,'PATCH',route(item),{version:1,...editor.buildPayload({note:'不可繞過原規則'})});assert.equal(response.status,422,key+':'+JSON.stringify(value));assert.equal(response.body.error.code,code);assert.deepEqual(f.state(),before);
  if(key!=='status'){const control=key==='trainingMinutes'?'trainingHours':key;assert.equal(editor.needsIntent(control),true);assert.equal(editor.initial[control],control==='trainingHours'?null:'');const replacement=editor.buildPayload({[control+'Intent']:'replace',[control]:key==='trainingMinutes'?7/60:key==='category'?'other':'2026-10-09'}),fixed=await f.patch(ENTITY,item,replacement);editor.confirm(fixed,f.admin.org,replacement);}
 }
});

test('missing optional own keys and typed special JSON preserve exact values while malformed names remain required',async t=>{
 const f=await fixture(t),special=JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[false,0],"prototype":null}');
 for(const value of [null,false,0,['PRIVATE'],special]){const original=f.imported(f.data({provider:value,note:value})),e=f.editor(original),p=e.buildPayload({name:'改課程'}),second=await f.patch(ENTITY,original,p);e.confirm(second,f.admin.org,p);assert.deepEqual(second.provider,value);assert.deepEqual(second.note,value);assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
  const edit=f.editor(second),clear=edit.buildPayload({providerIntent:'clear',noteIntent:'clear'}),third=await f.patch(ENTITY,second,clear);edit.confirm(third,f.admin.org,clear);assert.equal(third.provider,'');assert.equal(third.note,'');}
 const data=f.data();delete data.provider;delete data.note;const original=f.imported(data),e=f.editor(original),p=e.buildPayload({name:'只改名'}),saved=await f.patch(ENTITY,original,p);e.confirm(saved,f.admin.org,p);assert.equal(Object.hasOwn(saved,'provider'),false);assert.equal(Object.hasOwn(saved,'note'),false);
 for(const name of [undefined,null,'','　',false,0,[],['not name'],special]){const value=f.data({name});if(name===undefined)delete value.name;const item=f.imported(value),editor=f.editor(item),before=f.state(),rejected=await f.request(f.admin,'PATCH',route(item),{version:1,...editor.buildPayload({note:'原必填仍驗證'})});assert.equal(rejected.status,422);assert.equal(rejected.body.error.code,'REQUIRED');assert.deepEqual(f.state(),before);}assert.equal({}.secret,undefined);
});

test('inactive employees are permitted but immutable employee409 and original missing or foreign parent422 cannot be bypassed',async t=>{
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({employeeId:f.inactive.id,name:'停用員工訓練'}),first=await f.create(ENTITY,p);e.confirm(first,f.admin.org,p);
 const org=await f.create('organizations',{name:'合成乙機構'}),other={...f.admin,org:org.id},foreign=await f.create('employees',{name:'合成外部',employeeNo:'TEST-FOREIGN'},other);
 for(const employeeId of [f.employeeB.id,id(),foreign.id,f.careCase.id]){const before=f.state(),response=await f.request(f.admin,'PATCH',route(first),{version:1,employeeId});assert.equal(response.status,409);assert.equal(response.body.error.code,'EMPLOYEE_IMMUTABLE');assert.deepEqual(f.state(),before);}
 for(const employeeId of [id(),foreign.id,f.careCase.id,null,undefined]){const data=f.data({employeeId});if(employeeId===undefined)delete data.employeeId;const item=f.imported(data),editor=f.editor(item);assert.equal(editor.initial.employeeId,'');assert.equal(editor.needsIntent('employeeId'),false);assert.equal(editor.fields[0].disabled,true);assert.throws(()=>editor.buildPayload({employeeId:f.employee.id}),x=>!!x.fields?.employeeId);
  const before=f.state(),response=await f.request(f.admin,'PATCH',route(item),{version:1,...editor.buildPayload({note:'保持原歸屬'})});assert.equal(response.status,422);assert.equal(response.body.error.code,employeeId==null?'REQUIRED':'INVALID_REFERENCE');assert.deepEqual(f.state(),before);}
});

test('payload guards normalize name before limits and preserve omitted oversized imports under exact128KiB request limit',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data()),e=f.editor(first),before=f.state();
 for(const patch of [{name:null},{provider:{}},{note:[]},{name:'x'.repeat(501)},{provider:'x'.repeat(501)},{note:'x'.repeat(10001)},{trainingMinutes:null},{trainingMinutes:'61'},{trainingMinutes:60001},{date:'2026-02-30'},{category:'unknown'},{status:'active'},{trainingHours:1},{unknown:'x'},JSON.parse('{"__proto__":{"polluted":true}}')])assert.equal((await f.request(f.admin,'PATCH',route(first),{version:1,...patch})).status,422);
 assert.deepEqual(f.state(),before);assert.equal({}.polluted,undefined);
 const p=e.buildPayload({name:'　'+'🙂'.repeat(250)+'  ',provider:'🙂'.repeat(250),note:'字'.repeat(10000)}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);assert.equal(second.name.length,500);
 const normalized=await f.request(f.admin,'PATCH',route(second),{version:2,name:' '.repeat(500)+'n'+' '.repeat(500)});assert.equal(normalized.status,200);assert.equal(normalized.body.item.name,'n');
 const small=JSON.stringify({version:3,note:'128 KiB 原上限'}),exact=small+' '.repeat(131072-Buffer.byteLength(small));assert.equal((await f.request(f.admin,'PATCH',route(second),undefined,{},exact)).status,200);
 const committed=f.state(),large=JSON.stringify({version:4,note:'不可寫入'}),rejected=await f.request(f.admin,'PATCH',route(second),undefined,{},large+' '.repeat(131073-Buffer.byteLength(large)));assert.equal(rejected.status,413);assert.equal(rejected.body.error.code,'BODY_TOO_LARGE');assert.deepEqual(f.state(),committed);
 const huge=f.imported(f.data({name:'x'.repeat(501),provider:'n'.repeat(501),note:'z'.repeat(150000)})),editor=f.editor(huge),patch=editor.buildPayload({category:'other'}),saved=await f.patch(ENTITY,huge,patch);editor.confirm(saved,f.admin.org,patch);for(const key of ['name','provider','note'])assert.equal(saved[key],huge[key]);
});

test('POST same-key replay CAS CSRF and origin failures leave captured input and all eleven tables unchanged',async t=>{
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({employeeId:f.employee.id,name:'合成一次'}),headers={'Idempotency-Key':'synthetic-training-editor-once'},first=await f.request(f.admin,'POST','/api/'+ENTITY,p,headers);assert.equal(first.status,201);e.confirm(first.body.item,f.admin.org,p);
 const committed=f.state(),replay=await f.request(f.admin,'POST','/api/'+ENTITY,p,headers);assert.deepEqual(replay.body,first.body);assert.deepEqual(f.state(),committed);const duplicate=await f.request(f.admin,'POST','/api/'+ENTITY,{...p,name:'另一次'},headers);assert.equal(duplicate.status,409);assert.equal(duplicate.body.error.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(f.state(),committed);
 const old=first.body.item,edit=f.editor(old),pending=edit.buildPayload({note:'尚未送達'}),fresh=await f.patch(ENTITY,old,{note:'督導先存'},f.clients.supervisor),before=f.state(),stale=await f.request(f.admin,'PATCH',route(old),{version:1,...pending});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'VERSION_CONFLICT');
 for(const token of ['','invalid'])assert.equal((await f.request(f.admin,'PATCH',route(fresh),{version:2,note:'禁止'},{'X-CSRF-Token':token})).status,403);assert.equal((await f.request(f.admin,'PATCH',route(fresh),{version:2,note:'禁止'},{Origin:'https://untrusted.example.test'})).status,403);assert.deepEqual(pending,{note:'尚未送達'});assert.throws(()=>edit.confirm(fresh,f.admin.org,pending),/未確認/);assert.deepEqual(f.state(),before);
});

test('four roles organization isolation active caregiver link and exact immutable-parent history gaps remain unchanged',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data()),otherRecord=await f.create(ENTITY,f.data({employeeId:f.employeeB.id})),org=await f.create('organizations',{name:'合成別機構'}),other={...f.admin,org:org.id},foreignEmployee=await f.create('employees',{name:'合成外機構',employeeNo:'TEST-OUT'},other),foreign=await f.create(ENTITY,f.data({employeeId:foreignEmployee.id}),other);
 let before=f.state();for(const client of [f.clients.finance,f.clients.caregiver])for(const patch of [{note:'禁止'},{status:'cancelled'}])assert.equal((await f.request(client,'PATCH',route(first),{version:1,...patch})).status,403);
 for(const client of [f.clients.finance,f.clients.caregiver])assert.equal((await f.request(client,'POST','/api/'+ENTITY,f.data())).status,403);
 for(const client of [f.admin,f.clients.supervisor,f.clients.caregiver])for(const url of [route(first),history(first),history(first,false),'/api/training-report?startDate=2026-01-01&endDate=2026-12-31'])assert.equal((await f.request(client,'GET',url)).status,200);
 for(const url of ['/api/'+ENTITY,route(first),history(first),history(first,false),'/api/training-report?startDate=2026-01-01&endDate=2026-12-31'])assert.equal((await f.request(f.clients.finance,'GET',url)).status,403);
 for(const url of [route(otherRecord),history(otherRecord)])assert.equal((await f.request(f.clients.caregiver,'GET',url)).status,404);
 for(const [client,item]of [[other,first],[f.admin,foreign]])for(const url of [route(item),history(item)])assert.equal((await f.request(client,'GET',url)).status,404);assert.equal((await f.request(other,'PATCH',route(first),{version:1,note:'禁止'})).status,404);assert.equal((await f.request(null,'GET',route(first))).status,401);assert.deepEqual(f.state(),before);
 const imported=f.imported(f.data()),moved=replace(f.app.db,f.admin.org,ENTITY,imported,f.data({employeeId:f.employeeB.id})),back=replace(f.app.db,f.admin.org,ENTITY,moved,f.data());before=f.state();
 for(const client of [f.admin,f.clients.supervisor,f.clients.caregiver]){const h=await f.request(client,'GET',history(back));assert.deepEqual(h.body.items.map(x=>x.version),[3,1]);assert.equal(h.body.items[0].comparison.status,'unavailable');assert.equal(h.body.items[0].comparison.previousSnapshot,null);assert.equal(h.body.items[0].actor,null);}assert.deepEqual(f.state(),before);
 const sessions=f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(),memberships=f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(),inactive=await f.patch('employees',f.employee,{status:'inactive'});before=f.state();for(const url of [route(first),history(first),'/api/'+ENTITY]){const r=await f.request(f.clients.caregiver,'GET',url);assert.equal(r.status,403);assert.equal(r.body.error.code,'EMPLOYEE_LINK_REQUIRED');}assert.equal((await f.request(f.admin,'GET',route(first))).status,200);assert.deepEqual(f.state(),before);
 await f.patch('employees',inactive,{status:'active'});before=f.state();assert.equal((await f.request(f.clients.caregiver,'GET',route(first))).status,200);assert.deepEqual(f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(),sessions);assert.deepEqual(f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(),memberships);assert.deepEqual(f.state(),before);
});

test('unknown replies after actual commit cannot confirm missing typed or coerced eight-field values and do not roll back',async t=>{
 const f=await fixture(t),data=f.data({provider:{secret:'PRIVATE'},note:null}),first=f.imported(data),e=f.editor(first),p=e.buildPayload({name:'新名稱'}),saved=await f.patch(ENTITY,first,p),before=f.state();
 for(const reply of [null,[],{},Object.create(saved),{...saved,id:'other'},{...saved,orgId:'other'},{...saved,version:1},{...saved,version:'2'},{...saved,provider:'[object Object]'},{...saved,note:''},{...saved,trainingMinutes:'61'}])assert.throws(()=>e.confirm(reply,f.admin.org,p),/未確認/);
 for(const key of keys){const reply={...saved};delete reply[key];assert.throws(()=>e.confirm(reply,f.admin.org,p),/未確認/);}e.confirm(saved,f.admin.org,p);assert.deepEqual(e.buildPayload({name:'新名稱'}),p);
 assert.deepEqual(projection((await f.request(f.admin,'GET',route(saved))).body.item),projection(saved));assert.deepEqual(f.state(),before);
});

test('28 versions paginate25plus3 while exact previous minutes status actor and current employee name remain read-only',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data());let current=first;
 for(let version=2;version<=28;version++){const editor=f.editor(current),p=editor.buildPayload({trainingHours:version/60,note:'合成版本 '+version});current=await f.patch(ENTITY,current,p,version%2?f.admin:f.clients.supervisor);editor.confirm(current,f.admin.org,p);}
 await f.patch('employees',f.employee,{name:'合成目前姓名'});const before=f.state();
 const page1=await f.request(f.admin,'GET',history(current)+'&page=1&pageSize=25'),page2=await f.request(f.admin,'GET',history(current)+'&page=2&pageSize=25');assert.equal(page1.body.total,28);assert.equal(page1.body.items.length,25);assert.equal(page2.body.items.length,3);assert.deepEqual([...page1.body.items,...page2.body.items].map(x=>x.version),Array.from({length:28},(_,i)=>28-i));
 const boundary=page1.body.items.at(-1);assert.equal(boundary.version,4);assert.equal(boundary.comparison.previousVersion,3);assert.equal(boundary.comparison.previousSnapshot.trainingMinutes,3);assert.equal(boundary.snapshot.trainingMinutes,4);assert.equal(boundary.actor.id,f.clients.supervisor.user.id);
 assert.equal(page2.body.items.at(-1).comparison.status,'initial');const report=await f.request(f.admin,'GET','/api/training-report?startDate=2026-01-01&endDate=2026-12-31');assert.equal(report.status,200);assert.equal(report.body.rows[0].employee,'合成目前姓名');assert.equal(report.body.rows[0].trainingMinutes,28);assert.deepEqual(f.state(),before);
});

test('31 report outlets two nonempty versioned BLOBs six immutable triggers and eleven-table reads preserve approved fee-pay snapshots',async t=>{
 const f=await fixture(t),billing=await f.approve(),training=await f.create(ENTITY,f.data()),cert=await f.create('employee-certifications',{employeeId:f.employee.id,name:'合成證照父項',issuedOn:'2026-01-01',expiresOn:'',status:'active'}),a=await f.create('case-attachments/upload',{caseId:f.careCase.id,title:'合成PDF',...filePayload(PDF_BYTES)}),b=await f.create('certification-attachments/upload',{certificationId:cert.id,title:'合成PNG',...filePayload(PNG_BYTES,'合成.png','image/png')});
 const e=f.editor(training),p=e.buildPayload({note:'僅改訓練備註'}),current=await f.patch(ENTITY,training,p);e.confirm(current,f.admin.org,p);
 const urls=['cases','shifts','services','fees','payroll'].flatMap(kind=>[`/api/reports/${kind}?month=2026-10`,`/api/reports/${kind}.csv?month=2026-10`]);for(const kind of ['shift','service','case','leave','training','certification'])for(const suffix of ['','/export','.csv'])urls.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind==='certification'?'&asOf=2026-10-09':''}`);for(const suffix of ['','/export','.csv'])urls.push('/api/employee-report'+suffix);assert.equal(urls.length,31);
 const triggers=f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),before=f.state();assert.equal(triggers.length,6);assert.equal(Object.keys(before.tables).length,11);
 const reports=async()=>{const result={};for(const url of urls){const r=await f.request(f.admin,'GET',url);assert.equal(r.status,200,url);result[url]=typeof r.body==='string'?r.body:Object.fromEntries(Object.entries(r.body).filter(([k])=>k!=='generatedAt'));}return result;};const first=await reports();
 for(const [url,bytes]of [[`/api/case-attachments/${a.id}/download`,PDF_BYTES],[`/api/certification-attachments/${b.id}/download`,PNG_BYTES]])for(const suffix of ['','?recordVersion=1']){const r=await f.request(f.admin,'GET',url+suffix);assert.equal(r.status,200);assert.deepEqual(r.bytes,bytes);assert.equal(sha(r.bytes),sha(bytes));}
 for(const client of [f.admin,f.clients.supervisor,f.clients.caregiver])for(const url of [route(current),history(current),history(current,false),`/api/certification-attachments/${b.id}`,`/api/certification-attachments/${b.id}/history?compare=previous`])assert.equal((await f.request(client,'GET',url)).status,200);
 for(const url of [route(current),history(current),`/api/certification-attachments/${b.id}`,`/api/certification-attachments/${b.id}/download`,`/api/certification-attachments/${b.id}/history?compare=previous`])assert.equal((await f.request(f.clients.finance,'GET',url)).status,403);
 assert.deepEqual(await reports(),first);assert.deepEqual((await f.request(f.admin,'GET','/api/service-records/'+billing.id)).body.item,billing);for(const client of [f.clients.supervisor,f.clients.caregiver])assert.equal(Object.hasOwn((await f.request(client,'GET','/api/service-records/'+billing.id)).body.item,'billingSnapshot'),false);
 assert.equal(first['/api/reports/fees?month=2026-10'].totals.amountCents,37035);assert.equal(first['/api/reports/payroll?month=2026-10'].totals.amountCents,18800);assert.deepEqual(f.state(),before);assert.deepEqual(f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),triggers);
 for(const table of ['record_versions','attachment_files','certification_attachment_files']){assert.throws(()=>f.app.db.exec('DELETE FROM '+table),/immutable/);assert.throws(()=>f.app.db.exec('UPDATE '+table+' SET '+(table==='record_versions'?'version=version':'id=id')),/immutable/);}assert.deepEqual(f.state(),before);
});
