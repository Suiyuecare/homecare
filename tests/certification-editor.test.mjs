import test from 'node:test';
import assert from 'node:assert/strict';
import { createCertificationEditor } from '../public/data/certification-editor.js';
const keys = ['employeeId','name','certificateNo','issuer','issuedOn','expiresOn','status','note'];
const editable = keys.filter(k => !['employeeId','status'].includes(k));
const people = [{id:'a',name:' 合成甲 ',employeeNo:'TEST-A',status:'active'},{id:'b',name:'合成乙',employeeNo:'TEST-B',status:'inactive'}];
const row = changes => ({id:'cert-a',orgId:'org-a',version:4,employeeId:'a',name:' 原證照 ',certificateNo:' 原編號 ',issuer:' 原單位 ',issuedOn:'2026-01-01',expiresOn:'2026-12-31',status:'active',note:' 原文\n第二行\n',...changes});
const edit = existing => createCertificationEditor({existing,employees:people,defaultDate:'2026-10-09'});
const next = (saved,p={}) => ({...saved,...p,version:saved.version+1});
const bad = (fn,key) => assert.throws(fn,e => !!e.fields && Object.hasOwn(e.fields,key));
const unconfirmed = fn => assert.throws(fn,e => e.code === 'SAVE_UNCONFIRMED');
function freeze(v) { if(v && typeof v==='object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

test('create exposes seven original native controls and complete eight-field active payload with explicit safe employee default',()=>{
 const e=edit(); assert.deepEqual(e.initial,{employeeId:'',name:'',certificateNo:'',issuer:'',issuedOn:'2026-10-09',expiresOn:'',note:''});
 assert.deepEqual(e.fields.map(x=>[x.name,x.type]),[['employeeId','select'],['name','text'],['certificateNo','text'],['issuer','text'],['issuedOn','date'],['expiresOn','date'],['note','textarea']]);
 bad(()=>e.buildPayload(e.initial),'employeeId');
 assert.deepEqual(e.buildPayload({employeeId:'b',name:'  合成🙂　'}),{employeeId:'b',name:'合成🙂',certificateNo:'',issuer:'',issuedOn:'2026-10-09',expiresOn:'',note:'',status:'active'});
 for(const value of ['',null,{},['a'],'missing']) assert.equal(createCertificationEditor({employees:people,defaultEmployeeId:value}).initial.employeeId,'');
 assert.equal(createCertificationEditor({employees:people,defaultEmployeeId:'b'}).initial.employeeId,'b');
 for(const value of ['',null,{},'0000-01-01','2026-02-30']) assert.equal(createCertificationEditor({defaultDate:value}).initial.issuedOn,'');
});

test('options keep inactive members but neither typed names nor mutable descriptors can inject membership',()=>{
 const employees=[...structuredClone(people),{id:'typed',name:{secret:'PRIVATE'},employeeNo:['PRIVATE']},{id:'line',name:'PRIVATE\nname',employeeNo:'PRIVATE\rno'},{id:{},name:'PRIVATE'},{id:'a',name:'duplicate'}];
 const e=createCertificationEditor({employees}); assert.deepEqual(e.fields[0].options.map(x=>x.value),['a','b','typed','line']); assert.equal(e.fields[0].options[2].label,'未提供姓名');assert.equal(e.fields[0].options[3].label,'未提供姓名');assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
 employees[0].id='injected'; e.fields[0].options.push({value:'injected',label:'x'});e.initial.employeeId='injected';
 for(const value of ['injected',{},['a'],null,'']) bad(()=>e.buildPayload({employeeId:value,name:'x'}),'employeeId');
 assert.equal(e.buildPayload({employeeId:'a',name:'x',issuedOn:'2026-10-09'}).employeeId,'a');
});

test('edit employee is permanently readonly including missing typed and inaccessible saved ownership',()=>{
 for(const employeeId of ['a','b','missing',null,[],{secret:'PRIVATE'},undefined]) {
  const original=row({employeeId});if(employeeId===undefined)delete original.employeeId;const e=edit(original);
  assert.equal(e.fields.find(f=>f.name==='employeeId').disabled,true);assert.equal(e.enabled('employeeId',{}),false);assert.equal(e.needsIntent('employeeId'),false);assert.deepEqual(e.buildPayload(e.initial),{});
  assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));bad(()=>e.buildPayload({employeeId:'different'}),'employeeId');bad(()=>e.buildPayload({employeeIdIntent:'replace'}),'employeeIdIntent');
  e.confirm(next(original),original.orgId,{});unconfirmed(()=>e.confirm(next(original,{employeeId:'b'}),original.orgId,{employeeId:'b'}));
 }
});

test('ordinary unchanged or reverted strings omit without trimming stored name while explicit new name trims only itself',()=>{
 const original=freeze(row({extra:{secret:'PRIVATE'}})),e=edit(original);assert.deepEqual(e.buildPayload(e.initial),{});
 assert.deepEqual(e.buildPayload({name:original.name,note:' 新文\n'}),{note:' 新文\n'});assert.deepEqual(e.buildPayload({name:'  新名　',certificateNo:' 新編號 ',issuer:' 新單位 '}),{name:'新名',certificateNo:' 新編號 ',issuer:' 新單位 '});
 assert.equal(e.fields.some(f=>f.name==='status'),false);assert.equal(Object.hasOwn(e.initial,'status'),false);assert.ok(!JSON.stringify(e.initial).includes('PRIVATE'));
 bad(()=>e.buildPayload({status:'revoked'}),'status');bad(()=>e.buildPayload({statusIntent:'replace'}),'statusIntent');
});

test('six unsafe fields preserve missing null and typed own JSON privately with four optional clear intents',()=>{
 const special=JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[false,0],"prototype":null}');
 for(const value of [undefined,null,false,0,['PRIVATE'],special]) {
  const original=row(Object.fromEntries(editable.map(k=>[k,value])));if(value===undefined)for(const k of editable)delete original[k];const e=edit(freeze(original));
  for(const k of editable){assert.equal(e.initial[k],'');assert.equal(e.initial[k+'Intent'],'keep');assert.equal(e.enabled(k,e.initial),false);assert.equal(e.enabled(k,{[k+'Intent']:'replace'}),true);assert.equal(e.fields.find(f=>f.name===k).required,false);}
  assert.deepEqual(e.buildPayload(e.initial),{});e.confirm(next(original),original.orgId,{});assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
  for(const k of ['certificateNo','issuer','expiresOn','note'])assert.deepEqual(e.buildPayload({[k+'Intent']:'clear',[k]:{ignored:true}}),{[k]:''});
  for(const k of ['name','issuedOn'])bad(()=>e.buildPayload({[k+'Intent']:'clear'}),k+'Intent');
 }
});

test('CRLF content and year0000 stay private until explicit native replacement while LF note remains exact',()=>{
 const original=freeze(row({name:'PRIVATE\r\nname',certificateNo:'PRIVATE\nno',issuer:'PRIVATE\rissuer',issuedOn:'0000-02-29',expiresOn:'0000-12-31',note:'PRIVATE\r\nnote'})),e=edit(original);
 assert.deepEqual(e.buildPayload(e.initial),{});e.confirm(next(original),original.orgId,{});assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
 assert.deepEqual(e.buildPayload({nameIntent:'replace',name:'  新名  ',issuedOnIntent:'replace',issuedOn:'2026-01-01',expiresOnIntent:'clear',noteIntent:'replace',note:' 原文\n\n末行\n'}),{name:'新名',issuedOn:'2026-01-01',expiresOn:'',note:' 原文\n\n末行\n'});
 for(const key of ['name','certificateNo','issuer'])for(const value of ['a\rb','a\nb',null,{}])bad(()=>e.buildPayload({[key+'Intent']:'replace',[key]:value}),key);
 for(const value of ['a\rb','a\r\nb',null,[]])bad(()=>e.buildPayload({noteIntent:'replace',note:value}),'note');
});

test('complete calendar dates reject coercion and line endings but leave cross-field range to original API',()=>{
 const e=edit(row());for(const k of ['issuedOn','expiresOn']) {
  for(const value of ['0001-01-01','2000-02-29','2024-02-29','9999-12-31'])assert.deepEqual(e.buildPayload({[k]:value}),{[k]:value});
  for(const value of ['0000-01-01','1900-02-29','2026-02-30','10000-01-01','2026-01-01\n',false,null,['2026-01-01']])bad(()=>e.buildPayload({[k]:value}),k);
 }
 bad(()=>e.buildPayload({issuedOn:''}),'issuedOn');assert.deepEqual(e.buildPayload({expiresOn:''}),{expiresOn:''});
 assert.deepEqual(e.buildPayload({issuedOn:'2027-01-01',expiresOn:'2025-01-01'}),{issuedOn:'2027-01-01',expiresOn:'2025-01-01'});
});

test('new string limits use normalized name and UTF16 units while unchanged compatible oversize values omit',()=>{
 const e=edit(row());for(const [k,size] of [['name',500],['certificateNo',500],['issuer',500],['note',10000]]) {
  const boundary='🙂'.repeat(size/2),value=k==='name'?'  '+boundary+'　':boundary;assert.deepEqual(e.buildPayload({[k]:value}),{[k]:boundary});bad(()=>e.buildPayload({[k]:boundary+'x'}),k);
  const imported=edit(row({[k]:boundary+'x'}));assert.deepEqual(imported.buildPayload(imported.initial),{});
 }
 for(const name of ['',' 　',false,[]])bad(()=>e.buildPayload({name}),'name');
});

test('unknown own keys and forged intents reject without leaking or changing private JSON and option policy',()=>{
 const e=edit(row({note:null}));for(const key of ['id','orgId','version','status','expiryState','daysToExpiry','asOf','constructor','nameIntent'])bad(()=>e.buildPayload({[key]:'x'}),key);
 bad(()=>e.buildPayload(JSON.parse('{"__proto__":{"polluted":true}}')),'__proto__');for(const value of ['delete',null,false,{}])bad(()=>e.buildPayload({noteIntent:value}),'noteIntent');
 e.initial.noteIntent='delete';e.fields.find(f=>f.name==='noteIntent').options.push({value:'delete',label:'x'});assert.deepEqual(e.buildPayload({}),{});assert.equal(e.enabled('unknown'),false);assert.equal({}.polluted,undefined);
 for(const value of [null,[],false,'x'])bad(()=>e.buildPayload(value),'employeeId');
});

test('captured own JSON identity survives caller mutation and rejects non-JSON source without serializing special keys',()=>{
 const special=JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false]}'),original=row({note:special}),copy=structuredClone(original),e=edit(original);
 original.note.constructor[0]=9;original.id='other';original.orgId='other';original.version=99;e.initial.name='mutated';e.confirm(next(copy),copy.orgId,{});assert.deepEqual(e.buildPayload({}),{});unconfirmed(()=>e.confirm(next(original),copy.orgId,{}));assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));assert.equal({}.secret,undefined);
 for(const note of [undefined,NaN,Infinity,()=>{}])bad(()=>edit(row({note})),'employeeId');const cycle={};cycle.self=cycle;bad(()=>edit(row({note:cycle})),'employeeId');
});

test('create success requires plain item own identity exact version1 and all eight saved fields not derived display fields',()=>{
 const e=edit(),p=e.buildPayload({employeeId:'a',name:' 新證照 '}),good={...p,id:'new',orgId:'org-a',version:1,expiryState:'valid',daysToExpiry:99,asOf:'2026-10-09'};assert.equal(e.confirm(good,good.orgId,p),good);
 for(const badItem of [null,[],{},Object.create(good),{...good,id:''},{...good,orgId:'other'},{...good,version:'1'},{...good,version:2}])unconfirmed(()=>e.confirm(badItem,good.orgId,p));
 for(const k of ['id','orgId','version',...keys]){const v={...good};delete v[k];unconfirmed(()=>e.confirm(v,good.orgId,p));}
 for(const k of keys)unconfirmed(()=>e.confirm({...good,[k]:{changed:true}},good.orgId,p));unconfirmed(()=>e.confirm(good,'',p));unconfirmed(()=>e.confirm(good,good.orgId,{name:'x'}));
});

test('status-only confirmation preserves all seven untouched values missing own keys and private exact next version',()=>{
 const original=row({certificateNo:null,note:['原文']}),e=edit(original),p={status:'revoked'},good=next(original,p);e.confirm(good,original.orgId,p);e.confirm(good,original.orgId,{...p,version:4});
 for(const k of keys)unconfirmed(()=>e.confirm({...good,[k]:{changed:true}},original.orgId,p));for(const change of [{id:'other'},{orgId:'other'},{version:4},{version:6},{version:'5'},{name:'原證照'},{certificateNo:''}])unconfirmed(()=>e.confirm({...good,...change},original.orgId,p));
 const missing=row();delete missing.expiresOn;const absent=edit(missing);absent.confirm(next(missing),missing.orgId,{});unconfirmed(()=>absent.confirm(next(missing,{expiresOn:''}),missing.orgId,{}));
 unconfirmed(()=>e.confirm(good,original.orgId,{...p,version:3}));for(const version of [0,-1,1.5,'4',Number.MAX_SAFE_INTEGER]){const r=row({version});unconfirmed(()=>edit(r).confirm({...r,version:5},r.orgId,{}));}
});
