import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { confirmReport } = await import('../public/modules/report-view.js');
const { certificationReportConfig: config } = await import('../public/modules/certification-report.js');
const labels = { expired: '已到期', due_soon: '即將到期', valid: '有效期內', no_expiry: '未填到期日', revoked: '已撤銷' };
const columns = [['employeeNo','員工編號'],['employee','員工（目前名稱）'],['name','證照名稱'],['certificateNo','證號'],['issuer','發證單位'],['issuedOn','核發日期'],['expiresOn','到期日期'],['statusLabel','紀錄狀態'],['expiryLabel','效期狀態'],['note','證照備註']].map(([key,label])=>({key,label}));
const filters = change => ({ startDate:'2026-10-01', endDate:'2026-10-31', q:'', employeeId:'', status:'', asOf:'2026-10-08', expiry:'', ...change });
const row = change => ({ certificationId:'cert-synthetic-1', version:1, employeeId:'employee-synthetic-1', employeeNo:'SYN-001', employee:'合成員工', name:'合成證照', certificateNo:'NO-001', issuer:'合成單位', issuedOn:'2026-10-01', expiresOn:'2026-11-08', status:'active', statusLabel:'有效紀錄', expiryState:'valid', expiryLabel:'有效期內', note:'保存備註，非資格認定。', ...change });
const report = (rows=[row()], f=filters(), change={}) => ({ title:'員工證照紀錄總表', organization:{name:'合成機構'}, filters:{...f}, selection:{employee:f.employeeId?'合成員工':'全部可讀員工',status:({active:'有效紀錄',revoked:'已撤銷'})[f.status]||'全部狀態',expiry:labels[f.expiry]||'全部效期'}, generatedAt:'2026-10-08T14:10:00.000Z', columns:columns.map(c=>({...c})), rows, totals:{count:rows.length}, total:rows.length, page:1, pageSize:25, note:'本機保存證照，效期只提醒。', ...change });
const confirm = (r,f=filters(),o) => confirmReport(config,r,f,o);
const reject = (r,f=filters(),o) => assert.throws(()=>confirm(r,f,o),/未取得與查詢條件一致的完整報表確認/);
const freeze = value => { if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value; };

test('certificate confirmation preserves fifteen saved and derived fields and ten columns without mutating frozen rows',()=>{
 assert.deepEqual(config.columns,columns);assert.equal(config.date.rowKey,'issuedOn');assert.deepEqual(config.date.displayRowKeys,['expiresOn']);assert.equal(config.caseFilter,false);
 const r=freeze(report()),before=JSON.stringify(r);assert.equal(confirm(r),r);assert.equal(Object.keys(r.rows[0]).length,15);assert.equal(JSON.stringify(r),before);
 for(const change of [{phone:'hidden'},{daysToExpiry:31},{qualification:'qualified'},{asOf:'2026-10-08'}])reject(report([row(change)]));
 for(const key of Object.keys(row())){const missing=row();delete missing[key];reject(report([missing]));}
 const r2=report();r2.columns.reverse();reject(r2);reject({...report(),columns:[]});
});

test('certificate response confirmation checks expiry -1 0 30 31 no-expiry and revoked priority against the requested asOf',()=>{
 for(const [expiresOn,state] of [['2026-10-07','expired'],['2026-10-08','due_soon'],['2026-11-07','due_soon'],['2026-11-08','valid'],['','no_expiry']]){
  const value=row({expiresOn,expiryState:state,expiryLabel:labels[state]});assert.equal(confirm(report([value])).rows[0],value);
  reject(report([row({...value,expiryState:state==='valid'?'expired':'valid',expiryLabel:state==='valid'?labels.expired:labels.valid})]));
  reject(report([row({...value,expiryLabel:'資格已核定'})]));
  const revoked=row({...value,status:'revoked',statusLabel:'已撤銷',expiryState:'revoked',expiryLabel:labels.revoked});assert.equal(confirm(report([revoked])).rows[0],revoked);
 }
 const future=row({issuedOn:'2026-10-20',expiresOn:'2026-10-25',expiryState:'due_soon',expiryLabel:labels.due_soon});assert.equal(confirm(report([future])).rows[0],future);
});

test('certificate change of asOf and expiry requires exact echoed filters selection and recomputed reminders',()=>{
 const f=filters({asOf:'2026-11-08',expiry:'due_soon'}),value=row({expiryState:'due_soon',expiryLabel:labels.due_soon});assert.equal(confirm(report([value],f),f).rows[0],value);
 reject(report([row()],f),f);reject(report([value],f),filters({asOf:'2026-11-09',expiry:'due_soon'}));
 const mismatch=report([value],f);mismatch.selection.expiry='全部效期';reject(mismatch,f);
 for(const asOf of ['',null,['2026-10-08'],20261008,'2026-02-30','2026/10/08','2026-1-08']){const bad=filters({asOf});reject(report([],bad),bad);}
 for(const expiry of ['unknown','__proto__','constructor',' expired ',[],['expired'],null]){const bad=filters({expiry});reject(report([],bad),bad);}
 for(const key of Object.keys(filters())){const missing=report();delete missing.filters[key];reject(missing);}
 reject({...report(),filters:{...filters(),caseId:''}});reject({...report(),selection:{...report().selection,asOf:'2026-10-08'}});
});

test('certificate dates are strict and inclusive with empty expiry kept separate from invalid imported types',()=>{
 for(const issuedOn of ['2026-10-01','2026-10-31']){const value=row({issuedOn});assert.equal(confirm(report([value])).rows[0],value);}
 for(const issuedOn of ['2026-09-30','2026-11-01','2026-10-32','2026-1-01','',null,20261001])reject(report([row({issuedOn})]));
 for(const expiresOn of ['2026-09-30','2026-02-30','2026/11/08',null,undefined,false,[],{},20261108])reject(report([row({expiresOn})]));
 reject(report([row({status:'revoked',statusLabel:'已撤銷',expiryState:'revoked',expiryLabel:labels.revoked,expiresOn:'2026-09-30'})]));
 const f=filters({startDate:'0000-01-01',endDate:'0000-01-01',asOf:'0000-01-01'}),value=row({issuedOn:'0000-01-01',expiresOn:'',expiryState:'no_expiry',expiryLabel:labels.no_expiry});assert.equal(confirm(report([value],f),f).rows[0],value);
});

test('certificate employee status and literal search match only whitelisted saved text and not derived or hidden fields',()=>{
 for(const q of ['syn-001','合成員工','合成證照','no-001','合成單位','備註','有效紀錄']){const f=filters({q});assert.equal(confirm(report([row()],f),f).total,1);}
 for(const q of ['有效期內','2026-10-01','2026-11-08','cert-synthetic-1','employee-synthetic-1','qualification',' 合成證照 ','合成證照合成單位','名稱未取得']){const f=filters({q});reject(report([row()],f),f);}
 const f=filters({employeeId:'different'});reject(report([row()],f),f);
 const s=filters({status:'revoked'});reject(report([row()],s),s);
 for(const status of ['draft','constructor','__proto__',''])reject(report([row({status})]));
 reject(report([row({statusLabel:'核准'})]));
 const raw=row({name:'= 合成「證照」\n <script>',certificateNo:' +NO, "quoted" ',employee:'',employeeNo:''});const r=freeze(report([raw]));assert.equal(confirm(r).rows[0].certificateNo,raw.certificateNo);
});

test('certificate confirmation rejects nonstring coercion unsafe versions duplicate identity and count-only pollution',()=>{
 for(const key of ['name','certificateNo','issuer','employeeNo','employee','employeeId','note','expiryState','expiryLabel'])for(const value of [null,{},[],7,false])reject(report([row({[key]:value})]));
 for(const version of [0,-1,'1',1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,null])reject(report([row({version})]));
 assert.equal(confirm(report([row({version:Number.MAX_SAFE_INTEGER})])).rows[0].version,Number.MAX_SAFE_INTEGER);
 reject(report([row(),row()]));for(const totals of [{count:'1'},{count:0},{count:1,qualified:1},{count:1,expired:0}])reject({...report(),totals});
 for(const certificationId of ['',null,1])reject(report([row({certificationId})]));
});

test('certificate page and complete confirmation rejects truncation wrong page and extra rows',()=>{
 const rows=Array.from({length:28},(_,i)=>row({certificationId:`CERT-${i+1}`}));
 const first=report(rows.slice(0,25),filters(),{total:28,totals:{count:28}}),last=report(rows.slice(25),filters(),{page:2,total:28,totals:{count:28}}),full=report(rows,filters(),{pageSize:28});
 assert.equal(confirm(first),first);assert.equal(confirm(last,filters(),{page:2}),last);assert.equal(confirm(full,filters(),{complete:true}),full);
 reject(first,filters(),{complete:true});reject({...full,rows:rows.slice(0,27)},filters(),{complete:true});reject({...full,pageSize:25},filters(),{complete:true});reject({...last,page:1},filters(),{page:2});
});

test('certificate metadata and empty complete responses retain exact date and expiry selection without inferring qualifications',()=>{
 for(const change of [{title:'正式資格總表'},{organization:{name:''}},{generatedAt:'invalid'},{generatedAt:'2026-10-08'},{note:''},{selection:{}},{rows:null}])reject({...report(),...change});
 for(const value of [undefined,null,{},[]])reject(value);
 const f=filters({expiry:'expired'}),empty=freeze(report([],f));assert.equal(confirm(empty,f),empty);const full=freeze({...empty,pageSize:0});assert.equal(confirm(full,f,{complete:true}),full);
});
