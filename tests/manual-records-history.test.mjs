import test from 'node:test';
import assert from 'node:assert/strict';
import { getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

test('manual record history exposes exact human business fields with decimal text, optional unknown time and corrected date differences',()=>{
  const footprint={caseId:'synthetic-case',date:'0001-01-01',time:'',location:' 合成地點 ',contactDescription:' 原文\r\n尾端 ',relatedCaseId:'synthetic-related',source:' 人工來源 ',status:'active',note:' 保留備註 '};
  const normalized=normalizeHistorySnapshot('case-contact-footprints',footprint);assert.equal(normalized.contactDescription,footprint.contactDescription);assert.equal(normalized.time,null);assert.equal(getHistoryFields('case-contact-footprints').find(field=>field.key==='relatedCaseId').reference,'cases');
  const credit={employeeId:'synthetic-employee',date:'2026-10-10',activityName:'合成課程',provider:'合成單位',creditValue:'0.100000',creditUnit:'原文單位',sourceReference:' 依據\r\n保留 ',reference:'',note:'',status:'verified',verifiedOn:'2026-10-11',verificationBasis:'本次人工核對',voidedOn:'',voidReason:''};
  assert.equal(normalizeHistorySnapshot('employee-training-credits',credit).creditValue,'0.100000');assert.equal(getHistoryFields('employee-training-credits').length,14);
  const old={date:'2026-10-10',title:'合成人工假日',kind:'holiday',sourceReference:'原人工依據',note:' 保留\r\n備註 ',status:'active'},next={...old,date:'2026-10-11'};
  const differences=diffHistorySnapshots('institution-holidays',old,next);assert.equal(differences.length,1);assert.equal(differences[0].key,'date');assert.equal(normalizeHistorySnapshot('institution-holidays',next).note,old.note);
});
test('new scalar history never evaluates accessors or serializes unknown nested values',()=>{
  for(const entity of ['institution-holidays','case-contact-footprints','employee-training-credits']){
    let calls=0;const raw={unknown:{secret:'unrecognized'}};
    for(const field of getHistoryFields(entity))Object.defineProperty(raw,field.key,{enumerable:true,get(){calls++;throw new Error('must not read getter');}});
    const normalized=normalizeHistorySnapshot(entity,raw);assert.equal(calls,0);assert.equal(Object.keys(normalized).length,getHistoryFields(entity).length);assert.ok(!JSON.stringify(normalized).includes('unrecognized'));
    const nested=Object.fromEntries(getHistoryFields(entity).map(field=>[field.key,{secret:'do not disclose'}]));assert.ok(!JSON.stringify(normalizeHistorySnapshot(entity,nested)).includes('do not disclose'));
  }
});
