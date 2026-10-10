import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseEditor, formatCaseText, formatCaseCms, formatCaseBirthDate, formatCaseStatus } from '../public/data/case-editor.js';
const keys=['name','caseNo','birthDate','gender','phone','address','status','cmsLevel','welfare','supervisorId','primaryCarer','contactName','contactPhone','note'];
const controls=keys.filter(k=>k!=='status'), optional=controls.filter(k=>!['name','caseNo'].includes(k));
const employees=[{id:'s',name:'合成督導',role:'supervisor',status:'active'},{id:'a',name:'合成管理者',role:'admin',status:'active'},{id:'i',name:'合成停用',role:'supervisor',status:'inactive'},{id:'c',name:'合成居服',role:'caregiver',status:'active'}];
const row=extra=>({id:'case-a',orgId:'org-a',version:4,name:' 原姓名 ',caseNo:' 原案號 ',birthDate:'2000-02-29',gender:'女性',phone:'合成電話',address:'合成地址',status:'active',cmsLevel:4,welfare:' 原福利 ',supervisorId:'s',primaryCarer:'原主要照顧者',contactName:'原聯絡人',contactPhone:'原聯絡電話',note:' 原備註\n',...extra});
const edit=existing=>createCaseEditor({existing,employees});
const next=(source,payload={})=>({...source,...payload,version:source.version+1});
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const bad=(fn,name)=>assert.throws(fn,e=>Object.hasOwn(e.fields||{},name));
const unconfirmed=fn=>assert.throws(fn,e=>e.code==='SAVE_UNCONFIRMED');

test('thirteen original controls create all fourteen fields with active status and exact nontrimmed text',()=>{
 const e=edit();assert.deepEqual(e.fields.map(x=>x.name),controls);assert.equal(e.initial.gender,'未指定');assert.equal(e.fields.find(x=>x.name==='gender').placeholder,'未提供');assert.equal(e.initial.cmsLevel,null);assert.equal(e.fields.find(x=>x.name==='cmsLevel').type,'number');assert.equal(e.fields.find(x=>x.name==='cmsLevel').step,1);assert.equal(e.fields.find(x=>x.name==='birthDate').type,'date');assert.equal(e.fields.find(x=>x.name==='supervisorId').placeholder,'尚未指定');
 const p=e.buildPayload({name:'　姓名  ',caseNo:' A01 ',note:' 首行\n末行 '});assert.deepEqual(Object.keys(p).sort(),[...keys].sort());assert.equal(p.name,'　姓名  ');assert.equal(p.caseNo,' A01 ');assert.equal(p.status,'active');assert.equal(p.cmsLevel,'');assert.equal(p.birthDate,'');assert.equal(p.supervisorId,'');assert.equal(p.note,' 首行\n末行 ');assert.equal(e.buildPayload({name:'x',caseNo:'x',gender:''}).gender,'');bad(()=>e.buildPayload({name:'x',caseNo:'x',status:'paused'}),'status');
});

test('unchanged and returned native values omit without trimming or overwriting fourteen-field own presence',()=>{
 const original=freeze(row()),e=edit(original);assert.deepEqual(e.buildPayload(e.initial),{});assert.deepEqual(e.buildPayload({}),{});assert.deepEqual(e.buildPayload({...e.initial,phone:'新電話'}),{phone:'新電話'});assert.deepEqual(e.buildPayload({name:original.name,caseNo:original.caseNo,cmsLevel:4}),{});e.confirm(next(original),original.orgId,{});assert.equal(e.buildPayload({name:'原姓名'}).name,'原姓名');
});

test('CMS empty saved string uses null control without equating missing null typed or numeric strings',()=>{
 const e=edit(row({cmsLevel:''}));assert.equal(e.initial.cmsLevel,null);assert.equal(e.needsIntent('cmsLevel'),false);assert.deepEqual(e.buildPayload({cmsLevel:null}),{});
 for(const n of [1,4,8]){assert.deepEqual(e.buildPayload({cmsLevel:n}),{cmsLevel:n});assert.deepEqual(edit(row({cmsLevel:n})).buildPayload({cmsLevel:null}),{cmsLevel:''});}
 for(const value of [null,'4',false,[],[4],{},0,-1,1.5,9]){const u=edit(row({cmsLevel:value}));assert(u.needsIntent('cmsLevel'));assert.equal(u.initial.cmsLevel,null);assert.deepEqual(u.buildPayload(u.initial),{});assert.deepEqual(u.buildPayload({cmsLevelIntent:'clear'}),{cmsLevel:''});}
 for(const value of ['4',false,[],[4],{},0,-1,1.5,9,NaN,Infinity])bad(()=>e.buildPayload({cmsLevel:value}),'cmsLevel');
});

test('all thirteen unsafe controls remain private and eleven optional controls clear only by explicit intent',()=>{
 const original=row(Object.fromEntries(controls.map(k=>[k,{secret:'DO-NOT-SERIALIZE'}]))),e=edit(original);for(const key of controls){assert(e.needsIntent(key));assert.equal(e.enabled(key),false);assert.equal(e.initial[key],key==='cmsLevel'?null:'');}assert(!JSON.stringify(e.initial).includes('DO-NOT'));assert(!JSON.stringify(e.fields).includes('DO-NOT'));assert.deepEqual(e.buildPayload(e.initial),{});e.confirm(next(original),original.orgId,{});
 for(const key of optional)assert.deepEqual(e.buildPayload({[key+'Intent']:'clear'}),{[key]:''});for(const key of ['name','caseNo'])bad(()=>e.buildPayload({[key+'Intent']:'clear'}),key+'Intent');
 const missing=row();for(const key of controls)delete missing[key];const m=edit(missing);assert.deepEqual(m.buildPayload(m.initial),{});m.confirm(next(missing),missing.orgId,{});
});

test('CRLF values and year0000 stay private while native calendar and LF notes preserve exact text',()=>{
 const e=edit(row({name:'PRIVATE\r\nname',caseNo:'PRIVATE\nnumber',note:'PRIVATE\r\nnote',birthDate:'0000-02-29'}));assert.deepEqual(e.buildPayload(e.initial),{});for(const key of ['name','caseNo','note','birthDate'])assert(e.needsIntent(key));
 assert.deepEqual(e.buildPayload({nameIntent:'replace',name:' 新姓名 ',caseNoIntent:'replace',caseNo:' 新編號 ',noteIntent:'replace',note:'\n第一行\n末行\n',birthDateIntent:'replace',birthDate:'0001-01-01'}),{name:' 新姓名 ',caseNo:' 新編號 ',birthDate:'0001-01-01',note:'\n第一行\n末行\n'});
 const ordinary=edit(row());for(const birthDate of ['','0001-01-01','2400-02-29','9999-12-31'])assert.deepEqual(ordinary.buildPayload({birthDate}),{birthDate});
 for(const birthDate of ['0000-02-29','1900-02-29','2026-02-30','10000-01-01','2000-02-29\n',null,false,['2000-02-29']])bad(()=>ordinary.buildPayload({birthDate}),'birthDate');
 for(const key of controls.filter(k=>!['cmsLevel','birthDate','supervisorId','gender','note'].includes(k)))bad(()=>ordinary.buildPayload({[key]:'a\nb'}),key);bad(()=>ordinary.buildPayload({note:'a\rb'}),'note');
});

test('supervisor UI membership is active admin-supervisor plus current readable value with private safe labels and no escalation',()=>{
 assert.deepEqual(edit().fields.find(x=>x.name==='supervisorId').options.map(x=>x.value),['s','a']);
 for(const id of ['i','c']){const e=edit(row({supervisorId:id}));assert.equal(e.initial.supervisorId,id);assert(e.fields.find(x=>x.name==='supervisorId').options.some(x=>x.value===id));assert.deepEqual(e.buildPayload({}),{});}
 const missing=edit(row({supervisorId:'missing'}));assert(missing.needsIntent('supervisorId'));assert.deepEqual(missing.buildPayload({}),{});assert.deepEqual(missing.buildPayload({supervisorIdIntent:'replace',supervisorId:'s'}),{supervisorId:'s'});bad(()=>missing.buildPayload({supervisorIdIntent:'replace',supervisorId:'i'}),'supervisorId');
 const safe=createCaseEditor({employees:[...employees,{id:'typed',name:{secret:'PRIVATE'},role:'admin',status:'active'},{id:['bad'],name:'bad',role:'admin',status:'active'}]});assert.equal(safe.fields.find(x=>x.name==='supervisorId').options.at(-1).label,'未提供姓名');assert(!JSON.stringify(safe.fields).includes('PRIVATE'));safe.fields.find(x=>x.name==='supervisorId').options.push({value:'forged',label:'x'});bad(()=>safe.buildPayload({name:'x',caseNo:'x',supervisorId:'forged'}),'supervisorId');
});

test('unknown saved gender uses safe own labels without imposing new API classification or mutable option membership',()=>{
 for(const [gender,label]of [['female','女性'],['male','男性'],['other','其他'],['constructor','constructor'],['__proto__','__proto__'],['任意原字串','任意原字串']]){const e=edit(row({gender}));assert.equal(e.initial.gender,gender);assert.equal(e.fields.find(x=>x.name==='gender').options.at(-1).label,label);assert.deepEqual(e.buildPayload({gender}),{});assert.deepEqual(e.buildPayload({gender:'其他'}),{gender:'其他'});}
 const e=edit();e.fields.find(x=>x.name==='gender').options.push({value:'forged',label:'x'});bad(()=>e.buildPayload({name:'x',caseNo:'x',gender:'forged'}),'gender');assert.deepEqual(edit(row()).buildPayload({welfare:' constructor／任意福利原文 '}),{welfare:' constructor／任意福利原文 '});
});

test('new UTF16 limits are untrimmed while unchanged overlong compatible text remains omitted',()=>{
 const e=edit(row());for(const key of controls.filter(k=>!['cmsLevel','birthDate','supervisorId','gender'].includes(k))){const limit=key==='note'?10000:500,value='🙂'.repeat(limit/2);assert.deepEqual(e.buildPayload({[key]:value}),{[key]:value});bad(()=>e.buildPayload({[key]:value+' '}),key);assert.deepEqual(edit(row({[key]:value+' '})).buildPayload({}),{});}
 for(const key of ['name','caseNo']){assert.deepEqual(e.buildPayload({[key]:'　 '}),{[key]:'　 '});bad(()=>e.buildPayload({[key]:''}),key);}
});

test('unknown keys and private original JSON/identity cannot be changed through descriptors or later caller mutations',()=>{
 const original=row({note:JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false]}'),phone:null}),captured=structuredClone(original),e=edit(original);original.note.constructor[0]=9;original.id='other';original.orgId='other';original.version=99;e.initial.name='changed';e.initial.noteIntent='replace';e.confirm(next(captured),captured.orgId,{});assert.deepEqual(e.buildPayload({}),{});assert.equal({}.secret,undefined);
 for(const key of ['id','version','status','cms','nameIntent','constructor'])bad(()=>e.buildPayload({[key]:'x'}),key);bad(()=>e.buildPayload(JSON.parse('{"__proto__":{}}')),'__proto__');for(const intent of ['delete',null,{}])bad(()=>e.buildPayload({noteIntent:intent}),'noteIntent');
 for(const value of [undefined,NaN,Infinity,()=>{}])bad(()=>edit(row({note:value})),'name');const cycle={};cycle.self=cycle;bad(()=>edit(row({note:cycle})),'name');
});

test('case-only text date CMS status projections never coerce malformed data or invoke prototype labels',()=>{
 const hostile={toString(){throw Error('must not coerce');}};for(const v of [null,false,1,[],['PRIVATE'],hostile]){assert.equal(formatCaseText(v),'未取得');assert.equal(formatCaseStatus(v),'狀態未取得');assert.equal(formatCaseBirthDate(v),'日期未取得');}
 assert.equal(formatCaseText('PRIVATE\n原文字'),'PRIVATE\n原文字');assert.equal(formatCaseText(''),'未提供');for(const value of ['constructor','__proto__','unknown'])assert.equal(formatCaseStatus(value),value);assert.equal(formatCaseStatus('closed'),'結案');assert.equal(formatCaseBirthDate('0000-02-29'),'0000/02/29');assert.equal(formatCaseBirthDate('1900-02-29'),'日期未取得');assert.equal(formatCaseCms(8),'8');for(const value of [null,'4',false,[4],{},0,9,1.5])assert.equal(formatCaseCms(value),'未取得');assert.equal(formatCaseCms(''),'未提供');
});

test('create acknowledgement needs all fourteen own fields plus exact plain identity and version1',()=>{
 const e=edit(),p=e.buildPayload({name:' x ',caseNo:' c '}),good={...p,id:'new',orgId:'org-a',version:1};e.confirm(good,'org-a',p);
 for(const key of ['id','orgId','version',...keys]){const copy={...good};delete copy[key];unconfirmed(()=>e.confirm(copy,'org-a',p));}
 for(const key of keys)unconfirmed(()=>e.confirm({...good,[key]:{changed:true}},'org-a',p));for(const change of [{id:''},{orgId:'other'},{version:'1'},{version:2},{name:'x'}])unconfirmed(()=>e.confirm({...good,...change},'org-a',p));for(const value of [null,[],{},Object.create(good)])unconfirmed(()=>e.confirm(value,'org-a',p));
});

test('status-only no-op acknowledgements protect own absence and JSON types as well as captured next version',()=>{
 const original=row({note:null,phone:['private']}),e=edit(original),p={status:'paused'},good=next(original,p);e.confirm(good,'org-a',p);e.confirm(good,'org-a',{...p,version:4});for(const key of keys)unconfirmed(()=>e.confirm({...good,[key]:{changed:true}},'org-a',p));
 for(const change of [{id:'other'},{orgId:'other'},{version:4},{version:6},{version:'5'},{note:''},{cmsLevel:'4'}])unconfirmed(()=>e.confirm({...good,...change},'org-a',p));const absent=row();delete absent.phone;const a=edit(absent);a.confirm(next(absent),'org-a',{});unconfirmed(()=>a.confirm(next(absent,{phone:null}),'org-a',{}));for(const version of [0,1.5,'4',Number.MAX_SAFE_INTEGER])unconfirmed(()=>edit(row({version})).confirm({...good,version:5},'org-a',p));
});
