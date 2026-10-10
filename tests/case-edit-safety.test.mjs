import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert, replace } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';
import { createCaseEditor } from '../public/data/case-editor.js';

const ENTITY = 'cases', password = 'synthetic-training-editor-password';
const keys = ['name','caseNo','birthDate','gender','phone','address','status','cmsLevel','welfare','supervisorId','primaryCarer','contactName','contactPhone','note'];
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
  const employee = await create('employees', { name: '合成甲員工', employeeNo: 'TEST-CERT-A', role: 'supervisor', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成乙員工', employeeNo: 'TEST-CERT-B', hourlyRateCents: 24000 });
  const inactive = await create('employees', { name: '合成停用員工', employeeNo: 'TEST-CERT-INACTIVE', role: 'supervisor', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@training-editor.example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const service = await create('service-items', { code: 'TEST-CERT-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const careCase = await create('cases', { caseNo: 'TEST-CERT-CASE', name: '合成服務個案' }), services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shiftData = extra => ({ caseId: careCase.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-09', startTime: '09:00', endTime: '10:00', services, ...extra });
  const shift = await create('shifts', shiftData());
  let nextNo=0;
  const data = extra => ({ name: ' 合成個案 ', caseNo: 'TEST-CASE-'+(++nextNo), birthDate: '2000-02-29', gender: '女性', phone: '合成電話', address: '合成地址', status: 'active', cmsLevel: 4, welfare: ' 任意原福利 ', supervisorId: employee.id, primaryCarer: '原主要照顧者', contactName: '原聯絡人', contactPhone: '原联絡電話', note: ' 原備註\n', ...extra });
  const editor = existing => createCaseEditor({ existing, employees: [employee, employeeB, inactive] });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  const imported = value => insert(app.db, admin.org, ENTITY, value); // INSERT-only memory imports, never normal-API claims or real data.
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const reviewed = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(reviewed.status, 200);
    return (await request(admin, 'GET', '/api/service-records/' + record.id)).body.item;
  }
  return { app, request, create, patch, admin, clients, employee, employeeB, inactive, careCase, services, service, plan, shift, shiftData, data, editor, state, imported, approve };
}

test('fourteen-field create selective edit no-op and three status transitions preserve exact text and audit omission',async t=>{
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({name:'　合成個案  ',caseNo:' TEST-EXACT ',supervisorId:f.employee.id,cmsLevel:8,note:' 首行\n末行 '});assert.deepEqual(Object.keys(p).sort(),[...keys].sort());
 const first=await f.create(ENTITY,p);e.confirm(first,f.admin.org,p);assert.equal(first.name,p.name);assert.equal(first.caseNo,p.caseNo);assert.equal(first.status,'active');
 const ed=f.editor(first),change=ed.buildPayload({phone:'新電話',gender:'',cmsLevel:null}),second=await f.patch(ENTITY,first,change,f.clients.supervisor);ed.confirm(second,f.admin.org,change);assert.equal(second.gender,'');assert.equal(second.cmsLevel,'');
 let current=second;for(const p of [{},{status:'paused'},{status:'closed'},{status:'active'}]){const editor=f.editor(current),next=await f.patch(ENTITY,current,p);editor.confirm(next,f.admin.org,p);current=next;}
 const before=f.state(),h=await f.request(f.admin,'GET',history(current));assert.equal(h.status,200);assert.equal(h.body.total,6);assert.equal(h.body.items.at(-2).actor.id,f.clients.supervisor.user.id);assert.deepEqual(projection(h.body.items.at(-1).snapshot),p);assert.deepEqual(f.state(),before);
 const details=f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=? ORDER BY rowid').all(first.id,'record.update').map(x=>JSON.parse(x.detail));assert.deepEqual(details.map(x=>x.fields),[['gender','phone','cmsLevel'],[],['status'],['status'],['status']]);
});

test('case names and caseNo remain untrimmed with same-organization exact uniqueness and no added normalization',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data({name:'　 ',caseNo:' A '}));assert.equal(first.name,'　 ');assert.equal(first.caseNo,' A ');
 for(const caseNo of ['A','a',' A','A '])assert.equal((await f.create(ENTITY,f.data({caseNo}))).caseNo,caseNo);
 const before=f.state(),duplicate=await f.request(f.admin,'POST','/api/cases',f.data({caseNo:first.caseNo}));assert.equal(duplicate.status,409);assert.equal(duplicate.body.error.code,'DUPLICATE_CODE');assert.deepEqual(f.state(),before);
 const org=await f.create('organizations',{name:'合成乙機構'}),other={...f.admin,org:org.id};const outside=await f.create(ENTITY,f.data({caseNo:first.caseNo,supervisorId:''}),other);assert.equal(outside.caseNo,first.caseNo);
 const e=f.editor(first),p=e.buildPayload({caseNo:' A  '}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);assert.equal(second.caseNo,' A  ');
});

test('normal API CRLF and year0000 preserve raw values until explicit native replacement or optional clearing',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data({name:'PRIVATE\r\n姓名',caseNo:'PRIVATE\n案號',phone:'PRIVATE\r\n電話',note:'PRIVATE\r\n備註',birthDate:'0000-02-29'})),e=f.editor(first);for(const key of ['name','caseNo','phone','note','birthDate']){assert(e.needsIntent(key));assert.equal(e.initial[key],'');}assert(!JSON.stringify(e.fields).includes('PRIVATE'));
 const p=e.buildPayload({welfare:'僅修改福利原文'}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);for(const key of ['name','caseNo','phone','note','birthDate'])assert.equal(second[key],first[key]);
 const ed=f.editor(second),fix=ed.buildPayload({nameIntent:'replace',name:' 新姓名 ',caseNoIntent:'replace',caseNo:' 新案號 ',phoneIntent:'clear',noteIntent:'clear',birthDateIntent:'replace',birthDate:'0001-01-01'}),third=await f.patch(ENTITY,second,fix);ed.confirm(third,f.admin.org,fix);assert.equal(third.name,' 新姓名 ');assert.equal(third.caseNo,' 新案號 ');assert.equal(third.phone,'');assert.equal(third.note,'');assert.equal(third.birthDate,'0001-01-01');
});

test('import-only optional JSON own presence special keys and permissive merged types stay private and uncoerced',async t=>{
 const f=await fixture(t),special=JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false],"prototype":null}');
 for(const value of [null,false,0,['PRIVATE'],special]){const first=f.imported(f.data({phone:value,address:value,welfare:value,primaryCarer:value,contactName:value,contactPhone:value,note:value,gender:value})),e=f.editor(first),p=e.buildPayload({name:'只改姓名'}),saved=await f.patch(ENTITY,first,p);e.confirm(saved,f.admin.org,p);for(const key of ['phone','address','welfare','primaryCarer','contactName','contactPhone','note','gender'])assert.deepEqual(saved[key],value);assert(!JSON.stringify(e.fields).includes('PRIVATE'));const ed=f.editor(saved),clear=ed.buildPayload({phoneIntent:'clear',noteIntent:'clear'});ed.confirm(await f.patch(ENTITY,saved,clear),f.admin.org,clear);}
 const missing=f.data();delete missing.note;delete missing.contactName;const first=f.imported(missing),e=f.editor(first),p=e.buildPayload({name:'保持缺欄'}),saved=await f.patch(ENTITY,first,p);e.confirm(saved,f.admin.org,p);assert(!Object.hasOwn(saved,'note'));assert(!Object.hasOwn(saved,'contactName'));
 for(const name of [null,'',[]]){const item=f.imported(f.data({name})),before=f.state(),r=await f.request(f.admin,'PATCH',route(item),{version:1,...f.editor(item).buildPayload({note:'原必填仍有效'})});assert.equal(r.status,422);assert.equal(r.body.error.code,'REQUIRED');assert.deepEqual(f.state(),before);}
 const typed=f.imported(f.data({name:special,caseNo:['import-only']})),ed=f.editor(typed),p2=ed.buildPayload({note:'原merged不新增文字型別規則'}),kept=await f.patch(ENTITY,typed,p2);ed.confirm(kept,f.admin.org,p2);assert.deepEqual(kept.name,special);assert.deepEqual(kept.caseNo,['import-only']);assert.equal({}.secret,undefined);
});

test('CMS API endpoints and original merged coercion are preserved without allowing new coercion through the editor',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data());let current=first;
 for(const cmsLevel of [1,8,'']){const e=f.editor(current),p=e.buildPayload({cmsLevel:cmsLevel===''?null:cmsLevel});current=await f.patch(ENTITY,current,p);e.confirm(current,f.admin.org,p);assert.equal(current.cmsLevel,cmsLevel);}
 let before=f.state();for(const cmsLevel of ['4',false,[],[4],{},0,-1,9,1.5]){assert.throws(()=>f.editor(current).buildPayload({cmsLevel}),x=>!!x.fields?.cmsLevel);if(cmsLevel!==null)assert.equal((await f.request(f.admin,'PATCH',route(current),{version:current.version,cmsLevel})).status,422);}assert.deepEqual(f.state(),before);
 for(const cmsLevel of ['4',[4],{}]){const item=f.imported(f.data({cmsLevel})),e=f.editor(item),p=e.buildPayload({note:'僅保存其他欄'}),saved=await f.patch(ENTITY,item,p);e.confirm(saved,f.admin.org,p);assert.deepEqual(saved.cmsLevel,cmsLevel);}
 for(const cmsLevel of [null,0,-1,9]){const item=f.imported(f.data({cmsLevel})),e=f.editor(item);before=f.state();const r=await f.request(f.admin,'PATCH',route(item),{version:1,...e.buildPayload({note:'保留不跳過merged'})});assert.equal(r.status,422);assert.equal(r.body.error.code,'INVALID_NUMBER');assert.deepEqual(f.state(),before);const p=e.buildPayload({cmsLevelIntent:'clear'}),saved=await f.patch(ENTITY,item,p);e.confirm(saved,f.admin.org,p);assert.equal(saved.cmsLevel,'');}
});

test('birth date malformed imports keep original merged validation while falsy imports and optional missing values are not rewritten',async t=>{
 const f=await fixture(t);for(const birthDate of ['2026-02-30','0001-02-29',['2000-02-29'],{secret:'PRIVATE'}]){const item=f.imported(f.data({birthDate})),e=f.editor(item),before=f.state(),r=await f.request(f.admin,'PATCH',route(item),{version:1,...e.buildPayload({note:'不繞過生日格式'})});assert.equal(r.status,422);assert.equal(r.body.error.code,'INVALID_DATE');assert.deepEqual(f.state(),before);const p=e.buildPayload({birthDateIntent:'clear'});e.confirm(await f.patch(ENTITY,item,p),f.admin.org,p);}
 for(const birthDate of [null,false,0]){const item=f.imported(f.data({birthDate})),e=f.editor(item),p=e.buildPayload({note:'保持原falsy'}),saved=await f.patch(ENTITY,item,p);e.confirm(saved,f.admin.org,p);assert.equal(saved.birthDate,birthDate);}
 const item=await f.create(ENTITY,f.data({birthDate:'9999-12-31'})),before=f.state();for(const birthDate of [null,false,0,[],{},'2026-02-30','10000-01-01'])assert.equal((await f.request(f.admin,'PATCH',route(item),{version:1,birthDate})).status,422);assert.deepEqual(f.state(),before);
});

test('supervisor same-org reference permits inactive and other-job employees while UI options remain narrower and missing-parent422 is not bypassed',async t=>{
 const f=await fixture(t);for(const supervisorId of [f.inactive.id,f.employeeB.id]){const item=await f.create(ENTITY,f.data({supervisorId})),e=f.editor(item);assert.equal(e.initial.supervisorId,supervisorId);const p=e.buildPayload({note:'保持已指派者'});e.confirm(await f.patch(ENTITY,item,p),f.admin.org,p);}assert(!f.editor().fields.find(x=>x.name==='supervisorId').options.some(x=>x.value===f.inactive.id));
 const org=await f.create('organizations',{name:'外部機構'}),other={...f.admin,org:org.id},foreign=await f.create('employees',{name:'外部員工',employeeNo:'OUT'},other);
 for(const supervisorId of [id(),foreign.id,f.careCase.id]){const item=f.imported(f.data({supervisorId})),e=f.editor(item);assert(e.needsIntent('supervisorId'));const before=f.state(),r=await f.request(f.admin,'PATCH',route(item),{version:1,...e.buildPayload({note:'保持不可讀父項'})});assert.equal(r.status,422);assert.equal(r.body.error.code,'INVALID_REFERENCE');assert.deepEqual(f.state(),before);const p=e.buildPayload({supervisorIdIntent:'clear'});e.confirm(await f.patch(ENTITY,item,p),f.admin.org,p);}
});

test('UTF16 limits exact128KiB body guard and omitted oversized imports preserve bytes without truncation',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data()),e=f.editor(first),before=f.state();for(const patch of [{name:null},{phone:{}},{note:[]},{name:'x'.repeat(501)},{caseNo:'x'.repeat(501)},{phone:'x'.repeat(501)},{note:'x'.repeat(10001)},{unknown:'x'},JSON.parse('{"__proto__":{"polluted":true}}')])assert.equal((await f.request(f.admin,'PATCH',route(first),{version:1,...patch})).status,422);assert.deepEqual(f.state(),before);
 const p=e.buildPayload({name:'🙂'.repeat(250),caseNo:' '.repeat(500),phone:'🙂'.repeat(250),note:'字'.repeat(10000)}),second=await f.patch(ENTITY,first,p);e.confirm(second,f.admin.org,p);assert.equal(second.name.length,500);assert.equal(second.caseNo.length,500);
 const small=JSON.stringify({version:2,note:'128 KiB 原上限'}),exact=small+' '.repeat(131072-Buffer.byteLength(small));assert.equal((await f.request(f.admin,'PATCH',route(second),undefined,{},exact)).status,200);const committed=f.state(),large=JSON.stringify({version:3,note:'不可送達'});assert.equal((await f.request(f.admin,'PATCH',route(second),undefined,{},large+' '.repeat(131073-Buffer.byteLength(large)))).status,413);assert.deepEqual(f.state(),committed);
 const huge=f.imported(f.data({name:'n'.repeat(501),phone:'p'.repeat(501),note:'z'.repeat(150000)})),ed=f.editor(huge),change=ed.buildPayload({welfare:'只改福利原文'}),saved=await f.patch(ENTITY,huge,change);ed.confirm(saved,f.admin.org,change);for(const key of ['name','phone','note'])assert.equal(saved[key],huge[key]);
});

test('POST same-key replay CAS CSRF origin and unknown acknowledgement failures preserve source and committed state',async t=>{
 const f=await fixture(t),e=f.editor(),p=e.buildPayload({name:'合成一次',caseNo:'IDEM-ONCE'}),headers={'Idempotency-Key':'synthetic-case-editor-once'},first=await f.request(f.admin,'POST','/api/cases',p,headers);assert.equal(first.status,201);e.confirm(first.body.item,f.admin.org,p);const committed=f.state(),replay=await f.request(f.admin,'POST','/api/cases',p,headers);assert.deepEqual(replay.body,first.body);assert.deepEqual(f.state(),committed);assert.equal((await f.request(f.admin,'POST','/api/cases',{...p,name:'不同'},headers)).status,409);assert.deepEqual(f.state(),committed);
 const old=first.body.item,ed=f.editor(old),pending=ed.buildPayload({note:'我的修改'}),fresh=await f.patch(ENTITY,old,{note:'督導已存'},f.clients.supervisor),before=f.state();assert.equal((await f.request(f.admin,'PATCH',route(old),{version:1,...pending})).status,409);
 for(const token of ['','invalid'])assert.equal((await f.request(f.admin,'PATCH',route(fresh),{version:2,note:'禁止'},{'X-CSRF-Token':token})).status,403);assert.equal((await f.request(f.admin,'PATCH',route(fresh),{version:2,note:'禁止'},{Origin:'https://untrusted.example.test'})).status,403);assert.deepEqual(pending,{note:'我的修改'});assert.deepEqual(f.state(),before);
 const editor=f.editor(fresh),change=editor.buildPayload({note:'實際已提交'}),saved=await f.patch(ENTITY,fresh,change),after=f.state();for(const key of keys){const reply={...saved};delete reply[key];assert.throws(()=>editor.confirm(reply,f.admin.org,change),/未確認/);}for(const reply of [null,[],{},Object.create(saved),{...saved,id:'other'},{...saved,orgId:'other'},{...saved,version:'3'},{...saved,cmsLevel:'4'}])assert.throws(()=>editor.confirm(reply,f.admin.org,change),/未確認/);editor.confirm(saved,f.admin.org,change);assert.deepEqual((await f.request(f.admin,'GET',route(saved))).body.item,saved);assert.deepEqual(f.state(),after);
});

test('four-role case scope includes cancelled/completed caregiver shifts and current paused-closed cases without supervisor ACL',async t=>{
 const f=await fixture(t),item=f.careCase,unassigned=await f.create(ENTITY,f.data()),org=await f.create('organizations',{name:'別機構'}),other={...f.admin,org:org.id},foreign=await f.create(ENTITY,f.data({supervisorId:''}),other);
 let before=f.state();for(const client of [f.clients.finance,f.clients.caregiver]){assert.equal((await f.request(client,'POST','/api/cases',f.data())).status,403);for(const patch of [{note:'拒絕'},{status:'closed'}])assert.equal((await f.request(client,'PATCH',route(item),{version:1,...patch})).status,403);}for(const client of Object.values(f.clients))for(const url of [route(item),history(item),history(item,false)])assert.equal((await f.request(client,'GET',url)).status,200);
 assert.equal((await f.request(f.clients.caregiver,'GET',route(unassigned))).status,404);for(const [client,row]of [[other,item],[f.admin,foreign]])for(const url of [route(row),history(row)])assert.equal((await f.request(client,'GET',url)).status,404);assert.equal((await f.request(null,'GET',route(item))).status,401);assert.deepEqual(f.state(),before);
 let current=item,shift=f.shift;for(const [status,shiftStatus]of [['paused','cancelled'],['closed','completed']]){if(current.status!=='active')current=await f.patch(ENTITY,current,{status:'active'});if(shiftStatus==='completed'){shift=await f.patch('shifts',shift,{status:'scheduled'});await f.approve();}else shift=await f.patch('shifts',shift,{status:shiftStatus});current=await f.patch(ENTITY,current,{status});before=f.state();for(const url of [route(current),history(current)])assert.equal((await f.request(f.clients.caregiver,'GET',url)).status,200);const r=await f.request(f.admin,'POST','/api/shifts',f.shiftData({date:'2026-10-10'}));assert.equal(r.status,422);assert.equal(r.body.error.code,'INACTIVE_ASSIGNMENT');assert.deepEqual(f.state(),before);}
 current=await f.patch(ENTITY,current,{status:'active'});assert.equal((await f.request(f.admin,'POST','/api/shifts',f.shiftData({date:'2026-10-10'}))).status,201);
});

test('28 exact versions paginate25plus3 and case history keeps all versions under current scope rather than current supervisor assignment',async t=>{
 const f=await fixture(t),first=await f.create(ENTITY,f.data());let current=first;for(let v=2;v<=28;v++){const e=f.editor(current),p=e.buildPayload({note:'合成版本 '+v,cmsLevel:(v%8)+1,supervisorId:v%2?f.employee.id:''});current=await f.patch(ENTITY,current,p,v%2?f.admin:f.clients.supervisor);e.confirm(current,f.admin.org,p);}await f.patch('employees',f.employee,{name:'合成目前督導'});
 const before=f.state(),a=await f.request(f.admin,'GET',history(current)+'&page=1&pageSize=25'),b=await f.request(f.admin,'GET',history(current)+'&page=2&pageSize=25');assert.equal(a.body.total,28);assert.equal(a.body.items.length,25);assert.equal(b.body.items.length,3);assert.deepEqual([...a.body.items,...b.body.items].map(x=>x.version),Array.from({length:28},(_,i)=>28-i));const boundary=a.body.items.at(-1);assert.equal(boundary.version,4);assert.equal(boundary.comparison.previousVersion,3);assert.equal(boundary.comparison.previousSnapshot.note,'合成版本 3');assert.equal(boundary.actor.id,f.clients.supervisor.user.id);assert.equal(b.body.items.at(-1).comparison.status,'initial');assert.deepEqual(f.state(),before);
 const raw=f.imported(f.data()),moved=replace(f.app.db,f.admin.org,ENTITY,raw,{...projection(raw),supervisorId:f.employeeB.id}),back=replace(f.app.db,f.admin.org,ENTITY,moved,{...projection(raw),supervisorId:f.employee.id});const h=await f.request(f.admin,'GET',history(back));assert.deepEqual(h.body.items.map(x=>x.version),[3,2,1]);assert.equal(h.body.items[0].comparison.status,'available');assert.equal(h.body.items[0].actor,null);
});

test('status actions do not cascade relations billing snapshots BLOBs or reports and all reads preserve eleven tables and six triggers',async t=>{
 const f=await fixture(t),billing=await f.approve(),contact=await f.create('case-contacts',{caseId:f.careCase.id,name:'合成聯絡人',relationship:'合成關係'}),cert=await f.create('employee-certifications',{employeeId:f.employee.id,name:'合成證照',issuedOn:'2026-01-01',expiresOn:'',status:'active'}),a=await f.create('case-attachments/upload',{caseId:f.careCase.id,title:'合成PDF',...filePayload(PDF_BYTES)}),b=await f.create('certification-attachments/upload',{certificationId:cert.id,title:'合成PNG',...filePayload(PNG_BYTES,'合成.png','image/png')});
 const related=()=>f.app.db.prepare("SELECT * FROM records WHERE entity!='cases' ORDER BY rowid").all(),relatedBefore=related();let current=f.careCase;for(const status of ['paused','closed','active']){const e=f.editor(current),p={status};current=await f.patch(ENTITY,current,p);e.confirm(current,f.admin.org,p);assert.deepEqual(related(),relatedBefore);}assert.equal(contact.caseId,current.id);
 const urls=['cases','shifts','services','fees','payroll'].flatMap(kind=>[`/api/reports/${kind}?month=2026-10`,`/api/reports/${kind}.csv?month=2026-10`]);for(const kind of ['shift','service','case','leave','training','certification'])for(const suffix of ['','/export','.csv'])urls.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind==='certification'?'&asOf=2026-10-09':''}`);for(const suffix of ['','/export','.csv'])urls.push('/api/employee-report'+suffix);assert.equal(urls.length,31);
 const triggers=f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),before=f.state();assert.equal(triggers.length,6);assert.equal(Object.keys(before.tables).length,11);const reports=async()=>{const result={};for(const url of urls){const r=await f.request(f.admin,'GET',url);assert.equal(r.status,200,url);result[url]=typeof r.body==='string'?r.body:Object.fromEntries(Object.entries(r.body).filter(([k])=>k!=='generatedAt'));}return result;};const first=await reports();
 for(const [url,bytes]of [[`/api/case-attachments/${a.id}/download`,PDF_BYTES],[`/api/certification-attachments/${b.id}/download`,PNG_BYTES]])for(const suffix of ['','?recordVersion=1']){const r=await f.request(f.admin,'GET',url+suffix);assert.equal(r.status,200);assert.deepEqual(r.bytes,bytes);assert.equal(sha(r.bytes),sha(bytes));}
 for(const client of Object.values(f.clients))for(const url of [route(current),history(current),history(current,false)])assert.equal((await f.request(client,'GET',url)).status,200);assert.deepEqual(await reports(),first);assert.deepEqual((await f.request(f.admin,'GET','/api/service-records/'+billing.id)).body.item,billing);for(const client of [f.clients.supervisor,f.clients.caregiver])assert(!Object.hasOwn((await f.request(client,'GET','/api/service-records/'+billing.id)).body.item,'billingSnapshot'));
 assert.equal(first['/api/reports/fees?month=2026-10'].totals.amountCents,37035);assert.equal(first['/api/reports/payroll?month=2026-10'].totals.amountCents,18800);assert.deepEqual(f.state(),before);assert.deepEqual(f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),triggers);for(const table of ['record_versions','attachment_files','certification_attachment_files']){assert.throws(()=>f.app.db.exec('DELETE FROM '+table),/immutable/);assert.throws(()=>f.app.db.exec('UPDATE '+table+' SET '+(table==='record_versions'?'version=version':'id=id')),/immutable/);}assert.deepEqual(f.state(),before);
});
