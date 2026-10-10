import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrainingEditor, formatTrainingMinutes, formatTrainingCategory } from '../public/data/training-editor.js';
const keys = ['employeeId','name','category','provider','date','trainingMinutes','status','note'];
const controls = ['employeeId','name','category','provider','date','trainingHours','note'];
const editable = controls.filter(k => k !== 'employeeId');
const people = [{id:'a',name:' 合成甲 ',employeeNo:'TEST-A',status:'active'},{id:'b',name:'合成乙',employeeNo:'TEST-B',status:'inactive'}];
const row = changes => ({id:'training-a',orgId:'org-a',version:4,employeeId:'a',name:' 原課程 ',category:'in_service',provider:' 原單位 ',date:'2026-10-09',trainingMinutes:61,status:'completed',note:' 原文\n第二行\n',...changes});
const edit = existing => createTrainingEditor({existing,employees:people,defaultDate:'2026-10-09'});
const next = (saved,p={}) => ({...saved,...p,version:saved.version+1});
const bad = (fn,key) => assert.throws(fn,e => !!e.fields && Object.hasOwn(e.fields,key));
const unconfirmed = fn => assert.throws(fn,e => e.code === 'SAVE_UNCONFIRMED');
function freeze(v) { if(v && typeof v==='object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

test('create retains seven native controls complete eight-field payload selected employee only and completed status',()=>{
 const e=edit();assert.deepEqual(e.fields.map(x=>x.name),controls);assert.deepEqual(Object.keys(e.initial),controls);
 assert.equal(e.initial.employeeId,'');assert.equal(e.initial.category,'in_service');assert.equal(e.initial.date,'2026-10-09');assert.equal(e.initial.trainingHours,1);
 const hours=e.fields.find(x=>x.name==='trainingHours');assert.equal(hours.type,'number');assert.equal(hours.min,1/60);assert.equal(hours.max,1000);assert.equal(hours.step,.25);
 assert.deepEqual(e.buildPayload({employeeId:'b',name:'　合成課程  '}),{employeeId:'b',name:'合成課程',category:'in_service',provider:'',date:'2026-10-09',trainingMinutes:60,note:'',status:'completed'});
 for(const defaultEmployeeId of ['a','unknown',null,['a']])assert.equal(createTrainingEditor({employees:people,defaultEmployeeId}).initial.employeeId,defaultEmployeeId==='a'?'a':'');
 assert.equal(createTrainingEditor({defaultDate:'0000-01-01'}).initial.date,'');bad(()=>e.buildPayload({name:'課程'}),'employeeId');
 for(const k of ['status','trainingMinutes','trainingHoursIntent'])bad(()=>e.buildPayload({[k]:'x'}),k);
});

test('employee options reject coercion include inactive and privately retain immutable original or missing parent',()=>{
 const input=[...people,{id:'c',name:{secret:'PRIVATE'},employeeNo:['PRIVATE']},{id:['invalid'],name:'bad'},{id:'bad\n',name:'bad'},Object.create({id:'inherited'}),{id:'a',name:'duplicate'}];
 const e=createTrainingEditor({employees:input,defaultDate:'2026-10-09'}),opts=e.fields[0].options;assert.deepEqual(opts.map(o=>o.value),['a','b','c']);assert.equal(opts[2].label,'未提供姓名');assert.ok(!JSON.stringify(opts).includes('PRIVATE'));
 opts.push({value:'forged',label:'forged'});input.push({id:'late'});bad(()=>e.buildPayload({employeeId:'forged',name:'課程'}),'employeeId');bad(()=>e.buildPayload({employeeId:'late',name:'課程'}),'employeeId');
 for(const employeeId of ['a','unknown',null,{secret:'PRIVATE'},['a']]){const old=row({employeeId}),ed=edit(old);assert.equal(ed.fields[0].disabled,true);assert.equal(ed.needsIntent('employeeId'),false);assert.equal(ed.initial.employeeId,employeeId==='a'?'a':'');assert.deepEqual(ed.buildPayload({}),{});bad(()=>ed.buildPayload({employeeId:'b'}),'employeeId');ed.confirm(next(old),old.orgId,{});}
 const missing=row();delete missing.employeeId;const ed=edit(missing);assert.equal(ed.initial.employeeId,'');ed.confirm(next(missing),missing.orgId,{});unconfirmed(()=>ed.confirm(next(missing,{employeeId:''}),missing.orgId,{}));
});

test('all 60000 legal integer minutes survive full-precision hours round trip and untouched or equivalent-minute changes omit',t=>{
 const create=edit();let maxError=0;
 for(let minutes=1;minutes<=60000;minutes++){
  const ed=edit(row({trainingMinutes:minutes})),hours=ed.initial.trainingHours,fromNative=Number(String(hours));assert.equal(fromNative,hours);
  const raw=fromNative*60;maxError=Math.max(maxError,Math.abs(raw-Math.round(raw)));
  assert.deepEqual(ed.buildPayload({trainingHours:fromNative}),{});assert.equal(create.buildPayload({employeeId:'a',name:'合成',trainingHours:fromNative}).trainingMinutes,minutes);
 }
 assert.ok(maxError<=1e-7);t.diagnostic(`60000 values exact integer round-trip; maximum multiplication error ${maxError}`);
 for(const m of [1,7,61,75,150,60000]){const old=row({trainingMinutes:m}),e=edit(old);assert.equal(e.initial.trainingHours,m/60);e.confirm(next(old),old.orgId,e.buildPayload(e.initial));}
 assert.deepEqual(edit(row({trainingMinutes:60})).buildPayload({trainingHours:1+1e-9}),{});
 assert.deepEqual(edit(row()).buildPayload({trainingHours:1.25}),{trainingMinutes:75});
});

test('new hours retain original 1e-7 tolerance native range and integer-minute rule without string or object coercion',()=>{
 const e=edit(row());for(const [hours,minutes]of [[1/60,1],[7/60,7],[1.25,75],[2.5,150],[1000,60000],[1+1e-9,60]])assert.deepEqual(e.buildPayload({trainingHours:hours}),{trainingMinutes:minutes});
 for(const trainingHours of [null,undefined,'1','',false,true,[],[1],{},NaN,Infinity,-Infinity,0,-1,1/60-1e-9,1000+1e-9,1.001,1+1e-8])bad(()=>e.buildPayload({trainingHours}),'trainingHours');
 const hostile={valueOf(){throw Error('must not coerce');},toString(){throw Error('must not stringify');}};bad(()=>e.buildPayload({trainingHours:hostile}),'trainingHours');
});

test('six unsafe controls preserve own JSON privately with null hours baseline and only two optional clear intents',()=>{
 const original=freeze(row({name:null,category:'PRIVATE-unknown',provider:{secret:'PRIVATE'},date:'0000-02-29',trainingMinutes:'PRIVATE-61',note:['PRIVATE']})),e=edit(original);
 for(const key of editable){assert.equal(e.needsIntent(key),true);assert.equal(e.initial[key],key==='trainingHours'?null:'');assert.equal(e.initial[key+'Intent'],'keep');assert.equal(e.enabled(key,e.initial),false);assert.equal(e.fields.find(f=>f.name===key).required,false);}
 assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));assert.deepEqual(e.buildPayload(e.initial),{});e.confirm(next(original),original.orgId,{});
 assert.deepEqual(e.buildPayload({providerIntent:'clear',noteIntent:'clear'}),{provider:'',note:''});
 for(const k of ['name','category','date','trainingHours'])bad(()=>e.buildPayload({[k+'Intent']:'clear'}),k+'Intent');
 const fixed=e.buildPayload({nameIntent:'replace',name:' 課程 ',categoryIntent:'replace',category:'other',dateIntent:'replace',date:'2026-01-01',trainingHoursIntent:'replace',trainingHours:7/60});assert.deepEqual(fixed,{name:'課程',category:'other',date:'2026-01-01',trainingMinutes:7});
 const missing=row();for(const key of ['name','category','provider','date','trainingMinutes','note'])delete missing[key];const m=edit(missing);assert.deepEqual(m.buildPayload(m.initial),{});m.confirm(next(missing),missing.orgId,{});
});

test('CRLF name provider note and year0000 remain exact until explicit replacement while LF note and native dates are lossless',()=>{
 const original=freeze(row({name:'PRIVATE\r\ncourse',provider:'PRIVATE\nprovider',note:'PRIVATE\r\nnote',date:'0000-02-29'})),e=edit(original);assert.deepEqual(e.buildPayload(e.initial),{});e.confirm(next(original),original.orgId,{});
 assert.deepEqual(e.buildPayload({nameIntent:'replace',name:' 新課程 ',providerIntent:'clear',noteIntent:'replace',note:' 第一行\n\n最後一行\n',dateIntent:'replace',date:'0001-01-01'}),{name:'新課程',provider:'',date:'0001-01-01',note:' 第一行\n\n最後一行\n'});
 for(const key of ['name','provider'])for(const value of ['a\rb','a\nb',null,{}])bad(()=>e.buildPayload({[key+'Intent']:'replace',[key]:value}),key);
 for(const value of ['a\rb','a\r\nb',null,[]])bad(()=>e.buildPayload({noteIntent:'replace',note:value}),'note');
 const ordinary=edit(row());for(const date of ['0001-01-01','2000-02-29','9999-12-31'])assert.deepEqual(ordinary.buildPayload({date}),{date});
 for(const date of ['0000-01-01','1900-02-29','2026-02-30','10000-01-01','2026-01-01\n','',false,null,['2026-01-01']])bad(()=>ordinary.buildPayload({date}),'date');
});

test('new UTF16 limits use normalized name while unchanged compatible oversize strings omit and categories remain closed',()=>{
 const e=edit(row());for(const [key,size]of [['name',500],['provider',500],['note',10000]]){const boundary='🙂'.repeat(size/2),value=key==='name'?'  '+boundary+'　':boundary;assert.deepEqual(e.buildPayload({[key]:value}),{[key]:boundary});bad(()=>e.buildPayload({[key]:boundary+'x'}),key);assert.deepEqual(edit(row({[key]:boundary+'x'})).buildPayload({}),{});}
 for(const name of ['',' 　',false,[]])bad(()=>e.buildPayload({name}),'name');
 for(const category of ['pre_service','other'])assert.deepEqual(e.buildPayload({category}),{category});for(const category of ['','constructor','__proto__','unknown',null,['other']])bad(()=>e.buildPayload({category}),'category');
});

test('list projections render only valid saved integer minutes and own category codes without prototype lookup or coercion',()=>{
 for(const [n,text]of [[1,'1 分鐘'],[7,'7 分鐘'],[60,'1 小時'],[61,'1 小時 1 分鐘'],[75,'1 小時 15 分鐘'],[60000,'1000 小時']])assert.equal(formatTrainingMinutes(n),text);
 for(const value of [undefined,null,'61',false,true,[],[61],{},0,-1,1.5,60001,NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.equal(formatTrainingMinutes(value),'—');
 for(const [code,label]of [['pre_service','職前訓練'],['in_service','在職訓練'],['other','其他訓練'],['constructor','constructor'],['__proto__','__proto__'],['unknown','unknown'],['','']])assert.equal(formatTrainingCategory(code),label);
 const hostile={toString(){throw Error('must not coerce');}};for(const value of [undefined,null,false,1,[],['other'],hostile])assert.equal(formatTrainingCategory(value),'未提供');for(const value of [undefined,null,false,[],['other'],hostile])assert.equal(formatTrainingMinutes(value),'—');
});

test('unknown keys forged intents and mutated field options cannot alter private baseline or allowed categories',()=>{
 const e=edit(row({provider:null,trainingMinutes:null}));for(const key of ['id','orgId','version','status','trainingMinutes','asOf','constructor','nameIntent'])bad(()=>e.buildPayload({[key]:'x'}),key);
 bad(()=>e.buildPayload(JSON.parse('{"__proto__":{"polluted":true}}')),'__proto__');for(const intent of ['delete',null,false,{}])bad(()=>e.buildPayload({trainingHoursIntent:intent}),'trainingHoursIntent');
 e.initial.trainingHoursIntent='replace';e.initial.trainingHours=999;e.fields.find(f=>f.name==='category').options.push({value:'forged',label:'x'});e.fields.find(f=>f.name==='trainingHoursIntent').options.push({value:'clear',label:'x'});assert.deepEqual(e.buildPayload({}),{});bad(()=>e.buildPayload({category:'forged'}),'category');assert.equal(e.enabled('unknown'),false);assert.equal({}.polluted,undefined);
 for(const value of [null,[],false,'x'])bad(()=>e.buildPayload(value),'employeeId');
});

test('private JSON own presence and identity survive later caller mutations and reject non-JSON without source serialization',()=>{
 const original=row({provider:JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false]}'),note:null}),captured=structuredClone(original),e=edit(original);
 original.provider.constructor[0]=9;original.id='other';original.orgId='other';original.version=99;e.initial.name='mutated';e.confirm(next(captured),captured.orgId,{});unconfirmed(()=>e.confirm(next(original),captured.orgId,{}));assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));assert.equal({}.secret,undefined);
 for(const note of [undefined,NaN,Infinity,()=>{}])bad(()=>edit(row({note})),'employeeId');const cycle={};cycle.self=cycle;bad(()=>edit(row({note:cycle})),'employeeId');
});

test('create confirmation requires plain own identity version1 and every exact saved field with no hours alias',()=>{
 const e=edit(),p=e.buildPayload({employeeId:'a',name:' 新課程 ',trainingHours:7/60}),good={...p,id:'new',orgId:'org-a',version:1};assert.equal(e.confirm(good,good.orgId,p),good);
 for(const badItem of [null,[],{},Object.create(good),{...good,id:''},{...good,orgId:'other'},{...good,version:'1'},{...good,version:2}])unconfirmed(()=>e.confirm(badItem,good.orgId,p));
 for(const key of ['id','orgId','version',...keys]){const v={...good};delete v[key];unconfirmed(()=>e.confirm(v,good.orgId,p));}
 for(const key of keys)unconfirmed(()=>e.confirm({...good,[key]:{changed:true}},good.orgId,p));unconfirmed(()=>e.confirm(good,good.orgId,{...p,trainingHours:7/60}));unconfirmed(()=>e.confirm(good,'',p));
});

test('status-only and metadata-only acknowledgements preserve all eight saved fields including missing versus null and exact next version',()=>{
 const original=row({provider:null,note:['原文']}),e=edit(original),p={status:'cancelled'},good=next(original,p);e.confirm(good,original.orgId,p);e.confirm(good,original.orgId,{...p,version:4});
 for(const key of keys)unconfirmed(()=>e.confirm({...good,[key]:{changed:true}},original.orgId,p));for(const change of [{id:'other'},{orgId:'other'},{version:4},{version:6},{version:'5'},{name:'原課程'},{provider:''},{trainingMinutes:'61'}])unconfirmed(()=>e.confirm({...good,...change},original.orgId,p));
 const missing=row();delete missing.provider;const absent=edit(missing);absent.confirm(next(missing),missing.orgId,{});unconfirmed(()=>absent.confirm(next(missing,{provider:''}),missing.orgId,{}));
 unconfirmed(()=>e.confirm(good,original.orgId,{...p,version:3}));unconfirmed(()=>e.confirm(good,original.orgId,{...p,employeeId:'a'}));for(const version of [0,-1,1.5,'4',Number.MAX_SAFE_INTEGER]){const r=row({version});unconfirmed(()=>edit(r).confirm({...r,version:5},r.orgId,{}));}
});
