import test from 'node:test';
import assert from 'node:assert/strict';
import { createCarePlanEditor, formatCarePlanText, formatCarePlanDate, formatCarePlanStatus, formatCarePlanServices } from '../public/data/care-plan-editor.js';
const saved=['caseId','validFrom','validTo','status','services','goals','note'];
const cases=[{id:'a',caseNo:'A',name:'合成甲',status:'active'},{id:'b',caseNo:'B',name:'合成乙',status:'active'},{id:'paused',caseNo:'P',name:'合成暫停',status:'paused'}];
const serviceItems=[{id:'s1',code:'S1',name:'合成服務1',status:'active'},{id:'s2',code:'S2',name:'合成服務2',status:'active'},{id:'old',code:'OLD',name:'合成停用',status:'inactive'},{id:'other-old',code:'OTHER',name:'未引用停用',status:'inactive'}];
const row=extra=>({id:'plan-a',orgId:'org-a',version:4,caseId:'a',validFrom:'2026-01-01',validTo:'2026-12-31',status:'active',services:[{serviceItemId:'s2',quantity:7},{serviceItemId:'s1',quantity:3}],goals:' 原目標\n',note:' 原備註\n',...extra});
const editor=(existing,extra={})=>createCarePlanEditor({existing,cases,serviceItems,defaultDate:'2026-10-09',...extra});
const next=(r,p={})=>({...r,...p,version:r.version+1});
const bad=(fn,field)=>assert.throws(fn,e=>field?Object.hasOwn(e.fields||{},field):!!e.fields);
const unconfirmed=fn=>assert.throws(fn,e=>e.code==='SAVE_UNCONFIRMED');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

test('create seven controls sends seven fields with original draft-active choices and no first-case fallback',()=>{
 const e=editor();assert.deepEqual(e.fields.map(f=>f.name),saved);assert.equal(e.initial.caseId,'');assert.equal(e.initial.validFrom,'2026-10-09');assert.equal(e.initial.validTo,'');assert.equal(e.initial.status,'draft');assert.deepEqual(e.initial.services,[]);assert.deepEqual(e.fields.find(f=>f.name==='status').options.map(o=>o.value),['draft','active']);
 const p=e.buildPayload({caseId:'a',validTo:'2026-12-31',services:[{serviceItemId:'s1',quantity:1}]});assert.deepEqual(Object.keys(p).sort(),saved.slice().sort());assert.equal(p.status,'draft');assert.equal(p.goals,'');assert.equal(p.note,'');
 assert.equal(editor(undefined,{fixedCaseId:'a'}).initial.caseId,'a');for(const fixedCaseId of ['paused','missing',null,[],{}])assert.equal(editor(undefined,{fixedCaseId}).initial.caseId,'');
 for(const status of ['ended','constructor',null])bad(()=>e.buildPayload({...p,status}),'status');for(const defaultDate of ['0000-01-01','2026-02-30',null])assert.equal(editor(undefined,{defaultDate}).initial.validFrom,'');
});

test('edit preserves all seven own fields while unchanged and returned values omit and services stay private',()=>{
 const original=freeze(row()),e=editor(original);assert(!e.fields.some(f=>f.name==='status'));assert.deepEqual(e.initial.services,[]);assert.equal(e.initial.servicesIntent,'keep');assert.equal(e.needsIntent('services'),true);assert.equal(e.enabled('services'),false);assert.deepEqual(e.buildPayload(e.initial),{});assert.deepEqual(e.buildPayload({}),{});assert.deepEqual(e.buildPayload({note:original.note}),{});assert.deepEqual(e.buildPayload({goals:'新目標'}),{goals:'新目標'});e.confirm(next(original),original.orgId,{});
 const field=e.fields.find(f=>f.name==='services');assert.equal(field.type,'services');assert.equal(field.disabled,true);assert.equal(field.preserveWhenDisabled,true);assert.equal(e.enabled('services',{servicesIntent:'replace'}),true);assert.deepEqual(e.fields.find(f=>f.name==='servicesIntent').options.map(o=>o.value),['keep','replace']);bad(()=>e.buildPayload({status:'ended'}),'status');
});

test('all services JSON representations preserve exact private values and own absence without leaking nested content',()=>{
 const special=JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false]}');
 for(const services of [null,'PRIVATE',false,0,[],special,[null],[{serviceItemId:['PRIVATE'],quantity:1}],[{serviceItemId:'missing',quantity:1}],[{serviceItemId:'s1',quantity:2,extra:special}],[{serviceItemId:'s1',quantity:2},{serviceItemId:'s1',quantity:3}]]){
  const original=row({services}),e=editor(original);assert.deepEqual(e.initial.services,[]);assert.equal(e.initial.servicesIntent,'keep');assert(!JSON.stringify(e.fields).includes('PRIVATE'));assert(!JSON.stringify(e.initial).includes('PRIVATE'));assert.deepEqual(e.buildPayload(e.initial),{});e.confirm(next(original),original.orgId,{});
 }
 const original=row();delete original.services;const e=editor(original);assert.deepEqual(e.buildPayload({}),{});e.confirm(next(original),original.orgId,{});unconfirmed(()=>e.confirm(next(original,{services:[]}),original.orgId,{}));assert.equal({}.secret,undefined);
});

test('service replacement is whole canonical array with exact-order equality and no merge or quantity coercion',()=>{
 const original=row(),e=editor(original);assert.deepEqual(e.buildPayload({servicesIntent:'replace',services:structuredClone(original.services)}),{});
 const reversed=original.services.toReversed();assert.deepEqual(e.buildPayload({servicesIntent:'replace',services:reversed}),{services:reversed});const replacement=[{serviceItemId:'s1',quantity:10000}];assert.deepEqual(e.buildPayload({servicesIntent:'replace',services:replacement}),{services:replacement});
 for(const services of [[],null,{},[{serviceItemId:'s1',quantity:0}],[{serviceItemId:'s1',quantity:-1}],[{serviceItemId:'s1',quantity:1.5}],[{serviceItemId:'s1',quantity:'2'}],[{serviceItemId:'s1',quantity:10001}],[{serviceItemId:'s1',quantity:NaN}],[{serviceItemId:'s1',quantity:1,extra:true}],[{serviceItemId:'s1',quantity:1},{serviceItemId:'s1',quantity:2}],[{serviceItemId:'missing',quantity:1}],[{serviceItemId:['s1'],quantity:1}]])bad(()=>e.buildPayload({servicesIntent:'replace',services}),'services');bad(()=>e.buildPayload({servicesIntent:'clear'}),'servicesIntent');
});

test('service option membership allows active plus own-string current readable refs but never mutates private membership',()=>{
 const original=row({services:[{serviceItemId:'old',quantity:2}]}),e=editor(original),options=e.fields.find(f=>f.name==='services').options;assert.deepEqual(options.map(o=>o.value),['s1','s2','old']);assert.deepEqual(e.buildPayload({servicesIntent:'replace',services:[{serviceItemId:'old',quantity:1}]}),{services:[{serviceItemId:'old',quantity:1}]});options.push({value:'forged',label:'x'});bad(()=>e.buildPayload({servicesIntent:'replace',services:[{serviceItemId:'forged',quantity:1}]}),'services');
 const inherited=Object.create({serviceItemId:'old'});inherited.quantity=1;assert.throws(()=>editor(row({services:[inherited]})));
 const safe=editor(row({services:[{serviceItemId:{secret:'PRIVATE'},quantity:1}]}),{serviceItems:[...serviceItems,{id:['PRIVATE'],status:'active',name:'x'}, {id:'safe',status:'active',code:{secret:'PRIVATE'},name:['PRIVATE']}]});assert(!JSON.stringify(safe.fields).includes('PRIVATE'));assert(!safe.fields.find(f=>f.name==='services').options.some(o=>o.value==='old'));
 const many=Array.from({length:101},(_,i)=>({id:'s'+i,code:'S'+i,name:'合成'+i,status:'active'}));const m=editor(undefined,{serviceItems:many}),p={caseId:'a',validTo:'2026-12-31',services:many.slice(0,100).map(s=>({serviceItemId:s.id,quantity:1}))};assert.equal(m.buildPayload(p).services.length,100);bad(()=>m.buildPayload({...p,services:many.map(s=>({serviceItemId:s.id,quantity:1}))}),'services');
});

test('case selection preserves current paused readable case but missing typed references have keep-replace without clear',()=>{
 const e=editor(row({caseId:'paused'}));assert.equal(e.initial.caseId,'paused');assert.deepEqual(e.fields.find(f=>f.name==='caseId').options.map(o=>o.value),['a','b','paused']);assert.deepEqual(e.buildPayload({caseId:'b'}),{caseId:'b'});
 for(const caseId of [null,{},['PRIVATE'],'missing']){const x=editor(row({caseId}));assert(x.needsIntent('caseId'));assert.equal(x.initial.caseId,'');assert.deepEqual(x.buildPayload({}),{});assert.deepEqual(x.buildPayload({caseIdIntent:'replace',caseId:'a'}),{caseId:'a'});bad(()=>x.buildPayload({caseIdIntent:'clear'}),'caseIdIntent');}
 const x=editor(row(),{cases:[...cases,{id:'safe',status:'active',caseNo:{secret:'PRIVATE'},name:['PRIVATE']}]});assert(!JSON.stringify(x.fields).includes('PRIVATE'));x.fields.find(f=>f.name==='caseId').options.push({value:'forged',label:'x'});bad(()=>x.buildPayload({caseId:'forged'}),'caseId');
});

test('native date safety keeps year0000 and invalid original dates private without losing valid LF goals or note',()=>{
 const original=row({validFrom:'0000-02-29',validTo:'9999-12-31',goals:' 原\r\n目標',note:'PRIVATE\r備註'}),e=editor(original);for(const k of ['validFrom','goals','note']){assert(e.needsIntent(k));assert.equal(e.initial[k],'');}assert.deepEqual(e.buildPayload({}),{});assert.deepEqual(e.buildPayload({validFromIntent:'replace',validFrom:'0001-01-01',goalsIntent:'replace',goals:' 首行\n尾行 ',noteIntent:'clear'}),{validFrom:'0001-01-01',goals:' 首行\n尾行 ',note:''});
 for(const k of ['validFrom','validTo'])for(const v of [null,[],{},'2026-02-30','0000-01-01','10000-01-01','2026-01-01\n',''])bad(()=>editor(row()).buildPayload({[k]:v}),k);for(const k of ['goals','note'])bad(()=>editor(row()).buildPayload({[k]:'a\rb'}),k);
 for(const k of ['validFrom','validTo']){const x=editor(row({[k]:null}));assert.deepEqual(x.buildPayload({}),{});bad(()=>x.buildPayload({[k+'Intent']:'clear'}),k+'Intent');}
});

test('optional missing and typed JSON clear explicitly while normal text may be emptied and untrimmed',()=>{
 for(const k of ['goals','note'])for(const v of [null,false,0,[],{secret:'PRIVATE'}]){const original=row({[k]:v}),e=editor(original);assert(e.needsIntent(k));assert.equal(e.enabled(k),false);assert.deepEqual(e.buildPayload({}),{});assert.deepEqual(e.buildPayload({[k+'Intent']:'clear'}),{[k]:''});assert.deepEqual(e.buildPayload({[k+'Intent']:'replace',[k]:'  \n保留空白\n  '}),{[k]:'  \n保留空白\n  '});}
 const original=row();delete original.note;const e=editor(original);e.confirm(next(original),original.orgId,{});unconfirmed(()=>e.confirm(next(original,{note:null}),original.orgId,{}));assert.deepEqual(editor(row()).buildPayload({goals:'',note:''}),{goals:'',note:''});
});

test('new UTF16 length limits apply without truncating unchanged overlong private or compatible original text',()=>{
 for(const k of ['goals','note']){const e=editor(row()),v='🙂'.repeat(5000);assert.deepEqual(e.buildPayload({[k]:v}),{[k]:v});bad(()=>e.buildPayload({[k]:v+' '}),k);const huge=row({[k]:v+' '}),x=editor(huge);assert.deepEqual(x.buildPayload({}),{});x.confirm(next(huge),huge.orgId,{});}
});

test('captured JSON and identity are immutable to caller edits and prototype keys cannot alter object prototypes',()=>{
 const original=row({goals:JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false]}')}),captured=structuredClone(original),e=editor(original);original.id='changed';original.version=99;original.goals.constructor[0]=9;e.initial.caseId='b';e.initial.servicesIntent='replace';e.initial.services.push({serviceItemId:'forged',quantity:1});original.services[0].quantity=99;e.confirm(next(captured),captured.orgId,{});assert.deepEqual(e.buildPayload({}),{});assert.equal({}.secret,undefined);
 for(const k of ['id','orgId','version','status','unknown','constructor'])bad(()=>e.buildPayload({[k]:'x'}),k);bad(()=>e.buildPayload(JSON.parse('{"__proto__":{}}')),'__proto__');for(const value of [undefined,NaN,Infinity,()=>{}])assert.throws(()=>editor(row({goals:value})));const cycle={};cycle.self=cycle;assert.throws(()=>editor(row({note:cycle})));
});

test('create acknowledgement requires exact seven own fields plain identity and version one',()=>{
 const e=editor(),p=e.buildPayload({caseId:'a',validTo:'2026-12-31',services:[{serviceItemId:'s1',quantity:1}]}),good={...p,id:'new',orgId:'org-a',version:1};e.confirm(good,'org-a',p);
 for(const k of ['id','orgId','version',...saved]){const copy={...good};delete copy[k];unconfirmed(()=>e.confirm(copy,'org-a',p));}for(const k of saved)unconfirmed(()=>e.confirm({...good,[k]:{wrong:true}},'org-a',p));for(const v of [null,[],{},Object.create(good),{...good,id:''},{...good,orgId:'other'},{...good,version:2},{...good,version:'1'}])unconfirmed(()=>e.confirm(v,'org-a',p));
});

test('edit status-only confirmations preserve order extra JSON absence and captured next version exactly',()=>{
 const original=row({goals:null,services:[{serviceItemId:'s1',quantity:2,extra:{keep:true}},{serviceItemId:'s1',quantity:3}]}),e=editor(original),p={status:'ended'},good=next(original,p);e.confirm(good,'org-a',p);e.confirm(good,'org-a',{...p,version:4});for(const k of saved){const missing={...good};delete missing[k];unconfirmed(()=>e.confirm(missing,'org-a',p));unconfirmed(()=>e.confirm({...good,[k]:{wrong:true}},'org-a',p));}
 unconfirmed(()=>e.confirm({...good,services:original.services.toReversed()},'org-a',p));for(const change of [{id:'other'},{orgId:'other'},{version:4},{version:6},{version:'5'},{goals:''}])unconfirmed(()=>e.confirm({...good,...change},'org-a',p));for(const version of [0,1.5,'4',Number.MAX_SAFE_INTEGER])unconfirmed(()=>editor(row({version})).confirm(good,'org-a',p));
 const missing=row();delete missing.note;editor(missing).confirm(next(missing),missing.orgId,{});unconfirmed(()=>editor(missing).confirm(next(missing,{note:''}),missing.orgId,{}));
});


test('sparse or property-bearing arrays cannot hide JSON loss in either saved values or explicit service replacement',()=>{
 const sparse=Array(1),sparseExtra=Array(1);sparseExtra.extra='PRIVATE';const extra=[{serviceItemId:'s1',quantity:1}];extra.extra='PRIVATE';const noncanonical=[];noncanonical['01']={serviceItemId:'s1',quantity:1};
 for(const value of [sparse,sparseExtra,extra,noncanonical]){assert.throws(()=>editor(row({services:value})));bad(()=>editor(row()).buildPayload({servicesIntent:'replace',services:value}),'services');}
 const inherited=Object.create({quantity:1});inherited.serviceItemId='s1';bad(()=>editor(row()).buildPayload({servicesIntent:'replace',services:[inherited]}),'services');
});

test('plan-only safe projections retain valid text dates and known statuses without coercing malformed lookup data',()=>{
 const hostile={toString(){throw Error('must not coerce');}};for(const value of [null,false,1,[],['PRIVATE'],hostile]){assert.equal(formatCarePlanText(value),'未取得');assert.equal(formatCarePlanDate(value),'日期未取得');assert.equal(formatCarePlanStatus(value),'狀態未取得');}
 for(const value of ['constructor','__proto__','unknown'])assert.equal(formatCarePlanStatus(value),'狀態未取得');assert.equal(formatCarePlanStatus('active'),'生效中');assert.equal(formatCarePlanStatus(''),'未提供');assert.equal(formatCarePlanText('原文\n末行'),'原文\n末行');assert.equal(formatCarePlanDate('0000-02-29'),'0000/02/29');assert.equal(formatCarePlanDate('1900-02-29'),'日期未取得');
 const map=new Map([['good',{code:'S',name:'目前名稱'}],['typed',{code:hostile,name:['PRIVATE']}]]);assert.equal(formatCarePlanServices([{serviceItemId:'good',quantity:7}],map),'S 目前名稱 × 7');assert.equal(formatCarePlanServices([null],map),'服務明細未取得');assert.equal(formatCarePlanServices({secret:'PRIVATE'},map),'服務明細未取得');assert.equal(formatCarePlanServices([],map),'尚未設定');for(const quantity of ['7',null,0,10001,hostile])assert.equal(formatCarePlanServices([{serviceItemId:'typed',quantity}],map),'服務項目名稱未取得 × 數量未取得');
});
