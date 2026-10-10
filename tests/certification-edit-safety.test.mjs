import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert, replace } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';
import { createCertificationEditor } from '../public/data/certification-editor.js';

const ENTITY = 'employee-certifications', password = 'synthetic-certification-editor-password';
const keys = ['employeeId','name','certificateNo','issuer','issuedOn','expiresOn','status','note'];
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
  const setup = await request(null, 'POST', '/api/setup', { name: '合成證照管理者', email: 'admin@cert-editor.example.test', password, organizationName: '合成證照甲機構' }); assert.equal(setup.status, 201);
  const clientFrom = r => ({ cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.body.csrfToken, org: setup.body.organizations[0].id, user: r.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin, headers = {}) { const r = await request(caller, 'POST', '/api/' + entity, data, headers); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.item; }
  async function patch(entity, item, data, caller = admin) { const r = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { ...data, version: item.version }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.item; }
  const employee = await create('employees', { name: '合成甲員工', employeeNo: 'TEST-CERT-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成乙員工', employeeNo: 'TEST-CERT-B', hourlyRateCents: 24000 });
  const inactive = await create('employees', { name: '合成停用員工', employeeNo: 'TEST-CERT-INACTIVE', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@cert-editor.example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const service = await create('service-items', { code: 'TEST-CERT-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const careCase = await create('cases', { caseNo: 'TEST-CERT-CASE', name: '合成服務個案' }), services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shiftData = extra => ({ caseId: careCase.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-09', startTime: '09:00', endTime: '10:00', services, ...extra });
  const shift = await create('shifts', shiftData());
  const data = extra => ({ employeeId: employee.id, name: '合成證照', certificateNo: ' 原編號 ', issuer: ' 原單位 ', issuedOn: '2026-01-01', expiresOn: '2026-12-31', status: 'active', note: ' 合成備註\n', ...extra });
  const editor = existing => createCertificationEditor({ existing, employees: [employee, employeeB, inactive], defaultDate: '2026-01-01' });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  const imported = value => insert(app.db, admin.org, ENTITY, value); // INSERT-only memory imports, never normal-API claims or real data.
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const reviewed = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(reviewed.status, 200);
    return (await request(admin, 'GET', '/api/service-records/' + record.id)).body.item;
  }
  return { app, request, create, patch, admin, clients, employee, employeeB, inactive, careCase, services, service, plan, shift, shiftData, data, editor, state, imported, approve };
}

test('eight-field create name normalization selective update version-only no-op and revoke restore retain exact actors', async t => {
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({employeeId:f.employee.id,name:'  合成🙂證照　',certificateNo:' 001 ',issuer:' 原單位 ',note:' 第一行\n第二行 '});
 assert.deepEqual([...Object.keys(p)].sort(),[...keys].sort());const first=await f.create(ENTITY,p);e.confirm(first,f.admin.org,p);assert.equal(first.name,'合成🙂證照');assert.deepEqual(projection(first),p);
 const edit=f.editor(first),update=edit.buildPayload({name:'　督導證照　',note:' 督導備註\n'}),second=await f.patch(ENTITY,first,update,f.clients.supervisor);edit.confirm(second,f.admin.org,update);
 const noop=f.editor(second),third=await f.patch(ENTITY,second,noop.buildPayload(noop.initial));noop.confirm(third,f.admin.org,{});
 const revoke=f.editor(third),fourth=await f.patch(ENTITY,third,{status:'revoked'},f.clients.supervisor);revoke.confirm(fourth,f.admin.org,{status:'revoked'});
 const restored=f.editor(fourth),fifth=await f.patch(ENTITY,fourth,{status:'active'});restored.confirm(fifth,f.admin.org,{status:'active'});
 const before=f.state(),h=await f.request(f.admin,'GET',history(fifth));assert.equal(h.status,200);assert.deepEqual(h.body.items.map(x=>x.actor.id),[f.admin.user.id,f.clients.supervisor.user.id,f.admin.user.id,f.clients.supervisor.user.id,f.admin.user.id]);assert.deepEqual(projection(h.body.items.at(-1).snapshot),p);assert.deepEqual(f.state(),before);
 const audits=f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=? ORDER BY rowid').all(first.id,'record.update').map(x=>JSON.parse(x.detail));assert.deepEqual(audits.map(x=>x.fields),[['name','note'],[],['status'],['status']]);
});

test('saved CRLF and imported untrimmed name retain exact bytes until six explicit replacements and four clears',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data({name:' 合成\r\n證照 ',certificateNo:'PRIVATE\r\nno',issuer:'PRIVATE\rissuer',note:'PRIVATE\r\nnote'})),e=f.editor(first);
 for(const k of ['name','certificateNo','issuer','note']){assert.equal(e.needsIntent(k),true);assert.equal(e.initial[k],'');}assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
 const p=e.buildPayload({expiresOn:'2027-01-01'}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);for(const k of ['name','certificateNo','issuer','note'])assert.equal(second[k],first[k]);
 const captured=f.editor(second),repair=captured.buildPayload({nameIntent:'replace',name:'　新名　',certificateNoIntent:'clear',issuerIntent:'clear',noteIntent:'clear',expiresOn:''}),third=await f.patch(ENTITY,second,repair);captured.confirm(third,f.admin.org,repair);for(const k of ['certificateNo','issuer','expiresOn','note'])assert.equal(third[k],'');assert.equal(third.name,'新名');
 const imported=f.imported(f.data({name:'  合成匯入原名　'})),keep=f.editor(imported),only=keep.buildPayload({note:'只改備註'}),saved=await f.patch(ENTITY,imported,only);keep.confirm(saved,f.admin.org,only);assert.equal(saved.name,imported.name);assert.deepEqual(only,{note:'只改備註'});
 const now=f.editor(saved),normalized=now.buildPayload({name:'　合成匯入原名　'}),fixed=await f.patch(ENTITY,saved,normalized);now.confirm(fixed,f.admin.org,normalized);assert.equal(fixed.name,'合成匯入原名');
});

test('API-valid year0000 stays outside native date while original invalid-date and date-range merged guards still apply',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data({issuedOn:'0000-02-29',expiresOn:'0000-12-31'})),e=f.editor(first);assert.equal(e.initial.issuedOn,'');assert.equal(e.initial.expiresOn,'');
 const p=e.buildPayload({note:'年零不轉換'}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);assert.equal(second.issuedOn,'0000-02-29');assert.equal(second.expiresOn,'0000-12-31');
 const edit=f.editor(second),dateOnly=edit.buildPayload({issuedOnIntent:'replace',issuedOn:'2026-01-01'}),before=f.state(),rejected=await f.request(f.admin,'PATCH',route(second),{version:2,...dateOnly});assert.equal(rejected.status,422);assert.equal(rejected.body.error.code,'DATE_RANGE');assert.deepEqual(f.state(),before);
 const corrected=edit.buildPayload({issuedOnIntent:'replace',issuedOn:'2026-01-01',expiresOnIntent:'clear'}),third=await f.patch(ENTITY,second,corrected);edit.confirm(third,f.admin.org,corrected);assert.equal(third.expiresOn,'');
 for(const [key,value,code] of [['issuedOn','2026-02-30','INVALID_DATE'],['expiresOn',null,'INVALID_DATE'],['expiresOn',false,'INVALID_DATE'],['expiresOn',{},'INVALID_DATE'],['expiresOn','2025-01-01','DATE_RANGE']]) {
  const item=f.imported(f.data({[key]:value})),ed=f.editor(item),b=f.state(),r=await f.request(f.admin,'PATCH',route(item),{version:1,...ed.buildPayload({note:'不能繞過'})});assert.equal(r.status,422);assert.equal(r.body.error.code,code);assert.deepEqual(f.state(),b);
  const replacement=ed.needsIntent(key)?{[key+'Intent']:'replace',[key]:'2026-10-09'}:{[key]:'2026-10-09'};const patch=ed.buildPayload(replacement),fixed=await f.patch(ENTITY,item,patch);ed.confirm(fixed,f.admin.org,patch);
 }
});

test('missing optional own keys and typed imported optional JSON are preserved while required or malformed names remain rejected',async t=>{
 const f=await fixture(t),special=JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[false,0],"prototype":null}');
 for(const value of [null,false,0,['PRIVATE'],special]) {
  const first=f.imported(f.data({certificateNo:value,issuer:value,note:value})),e=f.editor(first),p=e.buildPayload({name:'新名稱'}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);
  for(const k of ['certificateNo','issuer','note'])assert.deepEqual(second[k],value);assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));assert.equal({}.secret,undefined);
  const edit=f.editor(second),clear=edit.buildPayload({certificateNoIntent:'clear',issuerIntent:'clear',noteIntent:'clear'}),third=await f.patch(ENTITY,second,clear);edit.confirm(third,f.admin.org,clear);
 }
 const absent=f.data();for(const k of ['certificateNo','issuer','expiresOn','note'])delete absent[k];const original=f.imported(absent),e=f.editor(original),p=e.buildPayload({name:'只改名'}),saved=await f.patch(ENTITY,original,p);e.confirm(saved,f.admin.org,p);for(const k of ['certificateNo','issuer','expiresOn','note'])assert.equal(Object.hasOwn(saved,k),false);
 for(const name of [undefined,null,'','　',false,0,[],['not a name'],special]) {
  const data=f.data({name});if(name===undefined)delete data.name;const item=f.imported(data),ed=f.editor(item),before=f.state(),r=await f.request(f.admin,'PATCH',route(item),{version:1,...ed.buildPayload({note:'保留仍被原 merged 拒絕'})});assert.equal(r.status,422);assert.equal(r.body.error.code,'REQUIRED');assert.deepEqual(f.state(),before);
 }
 const badStatus=f.imported(f.data({status:'pending'})),before=f.state(),r=await f.request(f.admin,'PATCH',route(badStatus),{version:1,...f.editor(badStatus).buildPayload({note:'不改狀態'})});assert.equal(r.status,422);assert.equal(r.body.error.code,'INVALID_STATUS');assert.deepEqual(f.state(),before);
});

test('inactive employee creation remains allowed immutable employee changes always409 and missing foreign refs cannot be repaired by form',async t=>{
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({employeeId:f.inactive.id,name:'停用員工證照'}),first=await f.create(ENTITY,p);e.confirm(first,f.admin.org,p);
 const org=await f.create('organizations',{name:'合成乙機構'}),other={...f.admin,org:org.id},foreign=await f.create('employees',{name:'合成外部',employeeNo:'TEST-CERT-FOREIGN'},other);
 for(const employeeId of [f.employeeB.id,id(),foreign.id,f.careCase.id]) {const before=f.state(),r=await f.request(f.admin,'PATCH',route(first),{version:1,employeeId});assert.equal(r.status,409);assert.equal(r.body.error.code,'EMPLOYEE_IMMUTABLE');assert.deepEqual(f.state(),before);}
 for(const employeeId of [id(),foreign.id,f.careCase.id,null,undefined]) {
  const data=f.data({employeeId});if(employeeId===undefined)delete data.employeeId;const item=f.imported(data),ed=f.editor(item);assert.equal(ed.initial.employeeId,'');assert.equal(ed.needsIntent('employeeId'),false);assert.equal(ed.fields[0].disabled,true);
  assert.throws(()=>ed.buildPayload({employeeId:f.employee.id}),x=>!!x.fields?.employeeId);const before=f.state(),r=await f.request(f.admin,'PATCH',route(item),{version:1,...ed.buildPayload({note:'保持原歸屬'})});assert.equal(r.status,422);assert.equal(r.body.error.code,employeeId==null?'REQUIRED':'INVALID_REFERENCE');assert.deepEqual(f.state(),before);
  if(typeof employeeId==='string'){const replacement=await f.request(f.admin,'PATCH',route(item),{version:1,employeeId:f.employee.id});assert.equal(replacement.status,409);assert.equal(replacement.body.error.code,'EMPLOYEE_IMMUTABLE');assert.deepEqual(f.state(),before);}
 }
});

test('new payload limits normalize name before500 reject typed keys and preserve untouched oversized data under exact128KiB body guard',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data()),e=f.editor(first),before=f.state();
 for(const patch of [{name:null},{certificateNo:{}},{issuer:false},{note:[]},{name:'x'.repeat(501)},{certificateNo:'x'.repeat(501)},{issuer:'x'.repeat(501)},{note:'x'.repeat(10001)},{issuedOn:'2026-02-30'},{expiresOn:'2025-01-01'},{status:'pending'},{unknown:'x'},JSON.parse('{"__proto__":{"polluted":true}}')]){const r=await f.request(f.admin,'PATCH',route(first),{version:1,...patch});assert.equal(r.status,422);}assert.deepEqual(f.state(),before);assert.equal({}.polluted,undefined);
 const p=e.buildPayload({name:'　'+'🙂'.repeat(250)+'  ',certificateNo:'🙂'.repeat(250),issuer:'x'.repeat(500),note:'字'.repeat(10000)}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);assert.equal(second.name.length,500);
 const normalizer=await f.request(f.admin,'PATCH',route(second),{version:2,name:' '.repeat(500)+'n'+' '.repeat(500)});assert.equal(normalizer.status,200);assert.equal(normalizer.body.item.name,'n');
 const small=JSON.stringify({version:3,note:'128 KiB 原上限'}),exact=small+' '.repeat(131072-Buffer.byteLength(small)),accepted=await f.request(f.admin,'PATCH',route(second),undefined,{},exact);assert.equal(accepted.status,200);
 const committed=f.state(),large=JSON.stringify({version:4,note:'不可寫入'}),rejected=await f.request(f.admin,'PATCH',route(second),undefined,{},large+' '.repeat(131073-Buffer.byteLength(large)));assert.equal(rejected.status,413);assert.equal(rejected.body.error.code,'BODY_TOO_LARGE');assert.deepEqual(f.state(),committed);
 const huge=f.imported(f.data({name:'x'.repeat(501),certificateNo:'n'.repeat(501),issuer:'i'.repeat(501),note:'z'.repeat(150000)})),captured=f.editor(huge),patch=captured.buildPayload({expiresOn:''}),saved=await f.patch(ENTITY,huge,patch);captured.confirm(saved,f.admin.org,patch);for(const k of ['name','certificateNo','issuer','note'])assert.equal(saved[k],huge[k]);
});

test('POST same-key replay CAS conflicts CSRF and origin failures preserve eight-field inputs and exact ledger',async t=>{
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({employeeId:f.employee.id,name:'合成一次'}),headers={'Idempotency-Key':'synthetic-cert-editor-once'},first=await f.request(f.admin,'POST','/api/'+ENTITY,p,headers);assert.equal(first.status,201);e.confirm(first.body.item,f.admin.org,p);
 const committed=f.state(),replay=await f.request(f.admin,'POST','/api/'+ENTITY,p,headers);assert.deepEqual(replay.body,first.body);assert.deepEqual(f.state(),committed);const duplicate=await f.request(f.admin,'POST','/api/'+ENTITY,{...p,name:'另一次'},headers);assert.equal(duplicate.status,409);assert.equal(duplicate.body.error.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(f.state(),committed);
 const old=first.body.item,edit=f.editor(old),pending=edit.buildPayload({note:'尚未送達'}),fresh=await f.patch(ENTITY,old,{note:'督導先存'},f.clients.supervisor),before=f.state(),stale=await f.request(f.admin,'PATCH',route(old),{version:1,...pending});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'VERSION_CONFLICT');
 for(const token of ['','invalid'])assert.equal((await f.request(f.admin,'PATCH',route(fresh),{version:2,note:'禁止'},{'X-CSRF-Token':token})).status,403);assert.equal((await f.request(f.admin,'PATCH',route(fresh),{version:2,note:'禁止'},{Origin:'https://untrusted.example.test'})).status,403);assert.deepEqual(pending,{note:'尚未送達'});assert.throws(()=>edit.confirm(fresh,f.admin.org,pending),/未確認/);assert.deepEqual(f.state(),before);
});

test('four roles org isolation active caregiver link and immutable history parent gap stay unchanged',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data()),otherRecord=await f.create(ENTITY,f.data({employeeId:f.employeeB.id})),org=await f.create('organizations',{name:'合成別機構'}),other={...f.admin,org:org.id},foreignEmployee=await f.create('employees',{name:'合成外機構',employeeNo:'TEST-OUT'},other),foreign=await f.create(ENTITY,f.data({employeeId:foreignEmployee.id}),other);
 let before=f.state();for(const client of [f.clients.finance,f.clients.caregiver])for(const patch of [{note:'禁止'},{status:'revoked'}])assert.equal((await f.request(client,'PATCH',route(first),{version:1,...patch})).status,403);
 for(const client of [f.clients.finance,f.clients.caregiver])assert.equal((await f.request(client,'POST','/api/'+ENTITY,f.data())).status,403);
 for(const client of [f.admin,f.clients.supervisor,f.clients.caregiver])for(const url of [route(first),history(first),history(first,false)])assert.equal((await f.request(client,'GET',url)).status,200);
 for(const url of ['/api/'+ENTITY,route(first),history(first),history(first,false),'/api/certification-report?startDate=2026-01-01&endDate=2026-12-31&asOf=2026-10-09'])assert.equal((await f.request(f.clients.finance,'GET',url)).status,403);
 for(const url of [route(otherRecord),history(otherRecord)])assert.equal((await f.request(f.clients.caregiver,'GET',url)).status,404);
 for(const [client,item] of [[other,first],[f.admin,foreign]])for(const url of [route(item),history(item)])assert.equal((await f.request(client,'GET',url)).status,404);assert.equal((await f.request(other,'PATCH',route(first),{version:1,note:'禁止'})).status,404);assert.equal((await f.request(null,'GET',route(first))).status,401);assert.deepEqual(f.state(),before);
 // Imported legacy parent changes are not supported API mutations; filter exact visible versions without bridging the gap.
 const imported=f.imported(f.data()),moved=replace(f.app.db,f.admin.org,ENTITY,imported,f.data({employeeId:f.employeeB.id})),back=replace(f.app.db,f.admin.org,ENTITY,moved,f.data());before=f.state();
 for(const client of [f.admin,f.clients.supervisor,f.clients.caregiver]){const h=await f.request(client,'GET',history(back));assert.deepEqual(h.body.items.map(x=>x.version),[3,1]);assert.equal(h.body.items[0].comparison.status,'unavailable');assert.equal(h.body.items[0].comparison.previousSnapshot,null);assert.equal(h.body.items[0].actor,null);}assert.deepEqual(f.state(),before);
 const sessions=f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(),memberships=f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(),inactive=await f.patch('employees',f.employee,{status:'inactive'});before=f.state();for(const url of [route(first),history(first),'/api/'+ENTITY]){const r=await f.request(f.clients.caregiver,'GET',url);assert.equal(r.status,403);assert.equal(r.body.error.code,'EMPLOYEE_LINK_REQUIRED');}assert.equal((await f.request(f.admin,'GET',route(first))).status,200);assert.deepEqual(f.state(),before);
 await f.patch('employees',inactive,{status:'active'});before=f.state();assert.equal((await f.request(f.clients.caregiver,'GET',route(first))).status,200);assert.deepEqual(f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(),sessions);assert.deepEqual(f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(),memberships);assert.deepEqual(f.state(),before);
});

test('unknown 2xx after real save cannot confirm changed absent typed fields and never claims rollback',async t=>{
 const f=await fixture(t),data=f.data({certificateNo:{secret:'PRIVATE'},note:null});delete data.issuer;const first=f.imported(data),e=f.editor(first),p=e.buildPayload({name:'新名稱'}),saved=await f.patch(ENTITY,first,p),before=f.state();
 for(const reply of [null,[],{},Object.create(saved),{...saved,id:'other'},{...saved,orgId:'other'},{...saved,version:1},{...saved,version:'2'},{...saved,issuer:''},{...saved,certificateNo:'[object Object]'},{...saved,note:''}])assert.throws(()=>e.confirm(reply,f.admin.org,p),/未確認/);
 for(const key of keys.filter(k=>k!=='issuer')){const reply={...saved};delete reply[key];assert.throws(()=>e.confirm(reply,f.admin.org,p),/未確認/);}e.confirm(saved,f.admin.org,p);assert.deepEqual(e.buildPayload({name:'新名稱'}),p);
 assert.deepEqual(projection((await f.request(f.admin,'GET',route(saved))).body.item),projection(saved));assert.deepEqual(f.state(),before);
});

test('expiry remains derived at read time with revoked precedence empty date and inclusive30day boundary no saved metadata',async t=>{
 const f=await fixture(t),fixtures=[['2026-10-08','active','expired',-1],['2026-10-09','active','due_soon',0],['2026-11-08','active','due_soon',30],['2026-11-09','active','valid',31],['','active','no_expiry',null],['2026-10-08','revoked','revoked',-1]];
 const records=[];for(const [expiresOn,status,state,days]of fixtures)records.push({item:await f.create(ENTITY,f.data({expiresOn,status})),state,days});const before=f.state();
 for(const {item,state,days}of records){const response=await f.request(f.admin,'GET',route(item)+'?asOf=2026-10-09');assert.equal(response.status,200);assert.equal(response.body.item.expiryState,state);assert.equal(response.body.item.daysToExpiry,days);assert.equal(response.body.item.asOf,'2026-10-09');
  const h=await f.request(f.admin,'GET',history(item));for(const k of ['expiryState','daysToExpiry','asOf']){assert.equal(Object.hasOwn(item,k),false);assert.equal(Object.hasOwn(h.body.items[0].snapshot,k),false);}
  const editor=f.editor(item);assert.deepEqual(editor.buildPayload(editor.initial),{});
 }assert.deepEqual(f.state(),before);
});

test('31 report outlets two exact versioned BLOBs six immutable triggers and eleven-table readonly ledger preserve approved snapshots',async t=>{
 const f=await fixture(t),billing=await f.approve(),cert=await f.create(ENTITY,f.data()),a=await f.create('case-attachments/upload',{caseId:f.careCase.id,title:'合成PDF',...filePayload(PDF_BYTES)}),b=await f.create('certification-attachments/upload',{certificationId:cert.id,title:'合成PNG',...filePayload(PNG_BYTES,'合成.png','image/png')});
 const e=f.editor(cert),p=e.buildPayload({note:'僅改證照備註'}),current=await f.patch(ENTITY,cert,p);e.confirm(current,f.admin.org,p);
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
