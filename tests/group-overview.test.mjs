import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {GROUP_METRICS,groupOverviewQuery,guardGroupOverview,readGroupOverview,readGroupOverviewRecords,assertGroupOverview,groupOverviewCsv} from '../src/server/group-overview.mjs';
import {accountMembershipActive,commitAccountChange} from '../src/server/account-administration.mjs';
const {initDb,insert,replace,now,fail}=await import(pathToFileURL(process.cwd()+'/src/server/model.mjs'));
const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);
function fixture(t){
 const db=new DatabaseSync(':memory:');initDb(db);t.after(()=>db.close());const user=randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user,'合成群組管理員','group-'+user+'@example.test','synthetic-only-not-login',now());
 const orgs=Array.from({length:3},(_,i)=>{const id=randomUUID();db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(id,i===1?' =合成乙("名稱")':'合成機構'+i,now());db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(id,user,i<2?'admin':'supervisor',null);return id;});
 const ctx={orgId:orgs[0],role:'admin',user:{id:user}},state=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>{const st=db.prepare('SELECT * FROM '+name);st.setReadBigInts(true);return[name,st.all()];}));
 const make=(org=orgs[0],fields={})=>{const parent=insert(db,org,'cases',{name:'合成人員同名',caseNo:'C-'+randomUUID(),status:'active'}),employee=insert(db,org,'employees',{name:'合成人員同名',employeeNo:'E-'+randomUUID(),status:'active'}),shift=insert(db,org,'shifts',{caseId:parent.id,employeeId:employee.id,carePlanId:'synthetic-plan',date:'2026-10-11',startTime:'23:00',endTime:'01:00',endDate:'2026-10-12',services:[{serviceItemId:'synthetic-item',quantity:1}],status:'completed',...fields}),record=insert(db,org,'service-records',{shiftId:shift.id,caseId:parent.id,employeeId:employee.id,date:shift.date,actualStart:shift.startTime,actualEnd:shift.endTime,...(Object.hasOwn(shift,'endDate')?{actualEndDate:shift.endDate}:{}),services:[{serviceItemId:'synthetic-item',quantity:1}],status:'approved'});return {parent,employee,shift,record};};
 const a=make(),b=make(orgs[1]),query={orgIds:orgs.slice(0,2),date:'2026-10-11'},read=(q=query)=>readGroupOverview(db,ctx,q,fail),changes=()=>db.prepare('SELECT total_changes() n').get().n;
 return {db,user,orgs,ctx,state,make,a,b,query,read,changes};
}
test('two authorized organizations count records independently, preserve overnight start-day basis and read all tables zero-write',t=>{
 const f=fixture(t),before=f.state(),changes=f.changes(),out=f.read();assert.equal(out.organizations.length,2);assert.equal(out.totals.activeCases,2);assert.equal(out.totals.activeEmployees,2);assert.equal(out.totals.startsShifts,2);assert.equal(out.totals.completedStartShifts,2);assert.equal(out.totals.approvedMonthRecords,2);assert.equal(out.organizations[0].trend[6].approvedRecords,1);assert.equal(out.organizations[0].trend.length,7);assert.deepEqual(assertGroupOverview(out,fail),out);assert.equal(f.read({...f.query,date:'2026-10-12'}).totals.startsShifts,0);assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
});
test('exact canonical query refuses duplicate/unknown/suffix LF, malformed dates and noncanonical bounded pages',()=>{
 const org='synthetic-org',fp='a'.repeat(64);assert.deepEqual(groupOverviewQuery(new URLSearchParams({organizationId:org,date:'2026-10-11'}),fail),{orgIds:[org],date:'2026-10-11'});
 for(const suffix of ['', '&organizationId='+org,'&date=2026-10-11','&unknown=1']){if(suffix==='')continue;rejects(()=>groupOverviewQuery(new URLSearchParams('organizationId='+org+'&date=2026-10-11'+suffix),fail),'GROUP_QUERY_INVALID');}
 for(const day of ['0000-01-01','2026-02-30','2026-10-11\n',''])rejects(()=>groupOverviewQuery(new URLSearchParams({organizationId:org,date:day}),fail),'GROUP_QUERY_INVALID');
 for(const fingerprint of [fp+'\n',fp+'\r',fp.toUpperCase()])rejects(()=>groupOverviewQuery(new URLSearchParams({organizationId:org,date:'2026-10-11',metric:'caseTotal',fingerprint,page:'1'}),fail,true),'GROUP_QUERY_INVALID');
 for(const page of ['0','01','1e0','1.0','2001','1\n'])rejects(()=>groupOverviewQuery(new URLSearchParams({organizationId:org,date:'2026-10-11',metric:'caseTotal',fingerprint:fp,page}),fail,true),'GROUP_QUERY_INVALID');
});
test('current and every selected membership must still be admin; no partial foreign disclosure and role precedes bad query',t=>{
 const f=fixture(t),before=f.state();for(const role of ['supervisor','finance','caregiver'])rejects(()=>readGroupOverview(f.db,{...f.ctx,role},null,fail),'ROLE_FORBIDDEN');rejects(()=>f.read({orgIds:[f.orgs[0],f.orgs[2]],date:f.query.date}),'ROLE_FORBIDDEN');assert.deepEqual(f.state(),before);
 f.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.orgs[1],f.user);const revoked=f.state(),changes=f.changes();rejects(()=>f.read(),'ROLE_FORBIDDEN');assert.deepEqual(f.state(),revoked);assert.equal(f.changes(),changes);
 f.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.orgs[0],f.user);rejects(()=>f.read(null),'ROLE_FORBIDDEN');
});
test('25-row drill pages agree with exact source fingerprint and current count, preserving each saved ID/version',t=>{
 const f=fixture(t);for(let i=0;i<27;i++)insert(f.db,f.orgs[0],'cases',{name:'合成個案'+i,caseNo:'PAGE-'+i,status:'active'});const out=f.read(),org=out.organizations[0],query={orgIds:[org.id],date:out.date,metric:'activeCases',fingerprint:org.fingerprint,page:1},before=f.state(),changes=f.changes(),one=readGroupOverviewRecords(f.db,f.ctx,query,fail),two=readGroupOverviewRecords(f.db,f.ctx,{...query,page:2},fail);assert.equal(one.total,28);assert.equal(one.items.length,25);assert.equal(two.items.length,3);assert.equal(new Set([...one.items,...two.items].map(x=>x.id)).size,28);assert.ok([...one.items,...two.items].every(x=>x.orgId===org.id&&x.version===1&&x.date===''));assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
 const old=f.a.parent;replace(f.db,f.orgs[0],'cases',old,{name:'目前改名',caseNo:old.caseNo,status:'paused'});const changed=f.state();rejects(()=>readGroupOverviewRecords(f.db,f.ctx,query,fail),'GROUP_SOURCE_CHANGED');assert.deepEqual(f.state(),changed);
});
test('nonperson drill projection never discloses injected unknown name or account number even with matching immutable head',t=>{
 const f=fixture(t);f.make(f.orgs[0],{name:'不得披露的未定義文字',caseNo:'未知欄位值'});const out=f.read(),org=out.organizations[0],detail=readGroupOverviewRecords(f.db,f.ctx,{orgIds:[org.id],date:out.date,metric:'startsShifts',fingerprint:org.fingerprint,page:1},fail);assert.equal(detail.items.length,2);assert.ok(detail.items.every(x=>x.name===''&&x.number===''));assert.ok(!JSON.stringify(detail).includes('不得披露'));
});
test('cancelled shifts are excluded and submitted means current pending across all dates while approved month follows start date',t=>{
 const f=fixture(t),extra=f.make(f.orgs[0],{date:'2026-09-30',endDate:'2026-10-01',status:'cancelled'});replace(f.db,f.orgs[0],'service-records',extra.record,{shiftId:extra.shift.id,caseId:extra.parent.id,employeeId:extra.employee.id,date:extra.shift.date,actualStart:'23:00',actualEnd:'01:00',actualEndDate:'2026-10-01',services:extra.record.services,status:'submitted'});const out=f.read();assert.equal(out.totals.startsShifts,2);assert.equal(out.totals.submittedRecords,1);assert.equal(out.totals.approvedMonthRecords,2);
});
test('closed descriptor-first query/output rejects accessors, sparse/symbol arrays and inconsistent counts without invoking getters',t=>{
 const f=fixture(t),out=f.read();let calls=0;const q={orgIds:[f.orgs[0]],date:f.query.date};Object.defineProperty(q.orgIds,'0',{enumerable:true,get(){calls++;return f.orgs[0];}});rejects(()=>f.read(q),'GROUP_QUERY_INVALID');
 for(const mutate of [o=>Object.defineProperty(o.organizations[0],'counts',{enumerable:true,get(){calls++;return out.organizations[0].counts;}}),o=>Object.defineProperty(o.organizations[0].trend[0],'date',{enumerable:true,get(){calls++;return'2026-10-05';}}),o=>o.organizations[Symbol('hidden')]=1,o=>delete o.organizations[0],o=>o.totals.activeCases++,o=>o.organizations[0].fingerprint+='\n']){const bad=structuredClone(out);mutate(bad);rejects(()=>groupOverviewCsv(bad,fail),'GROUP_SOURCE_UNVERIFIABLE');}assert.equal(calls,0);
});
test('unsafe SQL versions, malformed current/head business, orphan parents and invalid explicit spans reject all organizations zero-write',t=>{
 for(const corrupt of [f=>f.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER)+1n,f.b.shift.id),f=>f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{',f.b.shift.id),f=>f.db.prepare('UPDATE records SET entity=? WHERE id=?').run('synthetic-hidden',f.b.parent.id),f=>replace(f.db,f.orgs[1],'shifts',f.b.shift,{caseId:f.b.parent.id,employeeId:f.b.employee.id,carePlanId:'synthetic-plan',date:'2026-10-11',startTime:'23:00',endTime:'01:00',endDate:'2026-10-11',services:f.b.shift.services,status:'completed'})]){const f=fixture(t);corrupt(f);const before=f.state(),changes=f.changes();rejects(()=>f.read(),'GROUP_SOURCE_UNVERIFIABLE');assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);}
});
test('saved year0000 and legacy ISO seconds/offset stay byte-exact; first supported query trend can cross into year0000',t=>{
 const f=fixture(t),before=f.state();const old=insert(f.db,f.orgs[0],'shifts',{caseId:f.a.parent.id,employeeId:f.a.employee.id,carePlanId:'synthetic-plan',date:'0000-12-31',startTime:'0000-12-31T08:10:33+08:00',endTime:'0000-12-31T09:10:54+08:00',services:f.a.shift.services,status:'scheduled'});const saved=f.state(),out=f.read({...f.query,date:'0001-01-01'});assert.equal(out.organizations[0].trend[0].date,'0000-12-26');assert.equal(out.organizations[0].trend[5].startsShifts,1);assert.equal(Object.hasOwn(old,'endDate'),false);assert.deepEqual(f.state(),saved);assert.notDeepEqual(before,saved);
});
test('CSV contains all organization summaries, all seven trends, aggregate/notice, safe formula representation and exact field count',t=>{
 const f=fixture(t),out=f.read(),copy=structuredClone(out),body=groupOverviewCsv(out,fail);assert.equal(body.charCodeAt(0),0xfeff);assert.ok(body.endsWith('\r\n'));assert.match(body,/"' =合成乙\(""名稱""\)"/);assert.equal((body.match(/^"trend"/gm)||[]).length,14);assert.equal((body.match(/^"summary"/gm)||[]).length,2);assert.ok(body.includes('"total"'));assert.ok(body.includes('"notice"'));assert.ok(body.includes(out.capturedAt));assert.deepEqual(out,copy);
 const lines=body.slice(1).split('\r\n').filter(Boolean);assert.equal(lines.length,19);for(const line of lines)assert.equal((line.match(/,(?=")/g)||[]).length,18);
});
test('the 50000 entity boundary refuses the complete output rather than silently dropping row50001',t=>{
 const f=fixture(t),wrapper={exec:sql=>f.db.exec(sql),prepare(sql){const st=f.db.prepare(sql);if(!sql.includes('ORDER BY id LIMIT 50001'))return st;return{setReadBigInts:v=>st.setReadBigInts(v),all(...args){const rows=st.all(...args);return args[1]==='cases'?Array(50001).fill(rows[0]):rows;}};}};const before=f.state(),changes=f.changes();rejects(()=>readGroupOverview(wrapper,f.ctx,f.query,fail),'GROUP_SOURCE_TOO_LARGE');assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
});
test('organization rename changes source fingerprint; old drill is refused while fresh output explicitly uses current name',t=>{
 const f=fixture(t),out=f.read(),org=out.organizations[0];f.db.prepare('UPDATE organizations SET name=? WHERE id=?').run('合成機構新名稱',org.id);const before=f.state(),changes=f.changes();rejects(()=>readGroupOverviewRecords(f.db,f.ctx,{orgIds:[org.id],date:out.date,metric:'caseTotal',fingerprint:org.fingerprint,page:1},fail),'GROUP_SOURCE_CHANGED');const fresh=f.read();assert.equal(fresh.organizations[0].name,'合成機構新名稱');assert.notEqual(fresh.organizations[0].fingerprint,org.fingerprint);assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
});
function changeSelectedAccount(f,status,version=0,orgId=f.orgs[1]) {
 const other=randomUUID();f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(other,'合成第二管理者',other+'@example.test','synthetic-only-not-login',now());f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId,other,'admin',null);
 f.db.exec('BEGIN IMMEDIATE');try{const result=commitAccountChange(f.db,{orgId,role:'admin',user:{id:other}},f.user,{version,role:'admin',employeeId:null,status,reason:'合成帳號生命週期核對'});f.db.exec('COMMIT');return {...result,stateRecordId:f.db.prepare("SELECT id FROM records WHERE org_id=? AND entity='account-lifecycle' AND json_extract(data,'$.userId')=?").get(orgId,f.user).id};}catch(e){f.db.exec('ROLLBACK');throw e;}
}
test('selected suspended admin remains a member but whole overview and stale drill are denied zero-write; explicit reactivation restores current reads',t=>{
 const f=fixture(t),out=f.read(),selected=out.organizations[1],detail={orgIds:[selected.id],date:out.date,metric:'caseTotal',fingerprint:selected.fingerprint,page:1};changeSelectedAccount(f,'suspended');
 assert.equal(accountMembershipActive(f.db,f.orgs[0],f.user),true);assert.equal(accountMembershipActive(f.db,f.orgs[1],f.user),false);assert.equal(f.db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(f.orgs[1],f.user).role,'admin');
 const before=f.state(),changes=f.changes();rejects(()=>f.read(),'ROLE_FORBIDDEN');rejects(()=>readGroupOverviewRecords(f.db,f.ctx,detail,fail),'ROLE_FORBIDDEN');assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);
 changeSelectedAccount(f,'active',2);const restored=f.state(),after=f.changes();assert.equal(f.read().totals.caseTotal,2);assert.equal(readGroupOverviewRecords(f.db,f.ctx,detail,fail).total,1);assert.deepEqual(f.state(),restored);assert.equal(f.changes(),after);
});
test('current suspended admin and selected malformed or mismatched lifecycle head fail closed without partial source or any read writes',t=>{
 const current=fixture(t);changeSelectedAccount(current,'suspended',0,current.orgs[0]);const currentBefore=current.state(),currentChanges=current.changes();rejects(()=>current.read(),'ROLE_FORBIDDEN');assert.deepEqual(current.state(),currentBefore);assert.equal(current.changes(),currentChanges);
 for(const [corrupt,code] of [
  [(f,id)=>f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{',id),'ACCOUNT_STATE_INVALID'],
  [(f,id)=>f.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER)+1n,id),'ERR_OUT_OF_RANGE'],
  [(f,id)=>f.db.prepare('UPDATE records SET data=json_set(data,\'$.reason\',?) WHERE id=?').run('合成未同步目前head',id),'ACCOUNT_STATE_INVALID'],
  [(f,id)=>f.db.prepare('UPDATE records SET data=json_set(data,\'$.status\',?) WHERE id=?').run('unknown',id),'ACCOUNT_STATE_INVALID']
 ]){const f=fixture(t),suspended=changeSelectedAccount(f,'suspended');changeSelectedAccount(f,'active',2);corrupt(f,suspended.stateRecordId);const before=f.state(),changes=f.changes();rejects(()=>f.read(),code);assert.deepEqual(f.state(),before);assert.equal(f.changes(),changes);}
});
