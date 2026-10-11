import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';
import { customFormHistoryProjection } from '../public/data/custom-form-history.js';

const meta={id:'synthetic-template',orgId:'synthetic-org',version:2,createdAt:'2026-10-10',updatedAt:'2026-10-10'};
const field=(key,type,extra={})=>({key,label:key,type,groupId:'general',required:false,options:[],visibleIf:null,...extra});
const template={...meta,code:'SYN-FORM',name:'合成保存模板',description:'  說明\r\n末行  ',revision:1,previousTemplateId:'',groups:[{id:'general',label:'一般'}],fields:[field('enabled','boolean'),field('decimal','number'),field('details','textarea',{required:true,visibleIf:{field:'enabled',equals:true}})],status:'published',note:''};
const snapshot=Object.fromEntries(['id','orgId','version','code','name','description','revision','groups','fields'].map(key=>[key,template[key]]));
const record={...meta,id:'synthetic-record',version:1,caseId:'synthetic-case',templateId:template.id,templateVersion:2,date:'2026-10-10',answers:{enabled:true,decimal:'000.1000',details:'  保存\r\n完整末行  '},attachmentIds:['synthetic-attachment'],templateSnapshot:snapshot,status:'submitted',note:''};

test('template history describes groups, typed options and exact conditions without serializing nested raw schemas',()=>{
  const p=normalizeHistorySnapshot('form-templates',template);
  assert.deepEqual(p.groups,[{id:'general',label:'一般'}]); assert.equal(p.fields[2].condition,'enabled 等於 是'); assert.equal(p.fields[1].type,'十進位文字');
  assert.equal(p.description,template.description); assert.equal(p.fields[2].required,'提交時必填');
});
test('record history retains frozen template revision, SQL version, exact decimal and multiline answers plus attachment ids',()=>{
  const p=normalizeHistorySnapshot('form-records',record);
  assert.equal(p.templateSnapshot.metadata.find(row=>row.label==='保存模板SQL版次').value,2);
  assert.equal(p.templateSnapshot.metadata.find(row=>row.label==='保存模板修訂序號').value,1);
  assert.equal(p.answers.find(row=>row.key==='decimal').value,'000.1000');assert.equal(p.answers.find(row=>row.key==='details').value,record.answers.details);
  assert.deepEqual(p.attachmentIds,[{id:'synthetic-attachment'}]);assert.equal(p.answers[0].value,'是');
  const next={...record,answers:{...record.answers,decimal:'000.2000'}};assert.deepEqual(diffHistorySnapshots('form-records',record,next).map(row=>row.key),['answers']);
});
test('conditional fields without saved values stay absent while false remains a complete boolean answer',()=>{
  const p=customFormHistoryProjection('form-records',{...record,answers:{enabled:false,decimal:'0.10'}});
  assert.equal(p.answers.length,2); assert.equal(p.answers[0].value,'否'); assert.equal(p.answers[1].value,'0.10');
});
test('unknown nested schema, answer or attachment formats and getters never disclose raw content or execute accessors',()=>{
  let calls=0;
  for(const mutate of [value=>{value.templateSnapshot.fields[0].secret='SYNTHETIC-HIDDEN';},value=>{value.answers.secret='SYNTHETIC-HIDDEN';},value=>{Object.defineProperty(value.answers,'enabled',{enumerable:true,get(){calls++;return true;}});},value=>{Object.defineProperty(value,'orgId',{enumerable:true,get(){calls++;return meta.orgId;}});},value=>{Object.defineProperty(value.templateSnapshot.fields,'0',{enumerable:true,get(){calls++;return template.fields[0];}});}]){
    const bad=structuredClone(record); mutate(bad); const p=normalizeHistorySnapshot('form-records',bad); assert.equal(p.answers,'[欄位格式無法判讀]'); assert(!JSON.stringify(p).includes('SYNTHETIC-HIDDEN'));
  } assert.equal(calls,0);
});
test('series weekday/service and contract/task scalar history reject descriptors and unknown nested payloads without getter evaluation',()=>{
  let calls=0; const days=[];days.length=1;Object.defineProperty(days,'0',{enumerable:true,get(){calls++;return 1;}});
  const services=[{serviceItemId:'synthetic-service',quantity:1,secret:'SYNTHETIC-HIDDEN'}];
  const p=normalizeHistorySnapshot('shift-series',{weekdays:days,services}); assert.equal(p.weekdays,'[欄位格式無法判讀]'); assert.equal(p.services,'[欄位格式無法判讀]');
  const task={content:'  任務\r\n末行  '};Object.defineProperty(task,'result',{enumerable:true,get(){calls++;return 'SYNTHETIC-HIDDEN';}});
  const q=normalizeHistorySnapshot('internal-tasks',task);assert.equal(q.content,task.content);assert.equal(q.result,null);assert.equal(calls,0);
  assert(!JSON.stringify([p,q]).includes('SYNTHETIC-HIDDEN'));
});
