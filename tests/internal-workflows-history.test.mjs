import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHistorySnapshot,diffHistorySnapshots} from '../public/data/history-fields.js';
const savedTime='2026-10-10T00:00:00.000Z';
test('new workflow history uses only closed seven-scalar source snapshots; malformed/extra keys/getters never expose hidden content',()=>{
 let calls=0;
 const shift={id:'shift',orgId:'org',version:2,employeeId:'employee',date:'2026-10-10',startTime:'09:00',endTime:'10:00'};
 const contract={id:'contract',version:2,caseId:'case',number:'0009',title:'人工來源標題',startDate:'2026-01-01',endDate:'2026-12-31'};
 const cases=[['shift-substitution-requests','shiftSnapshot',shift],['contract-deadline-reminders','contractSnapshot',contract]];
 for(const [entity,key,snapshot] of cases){
  const normal=normalizeHistorySnapshot(entity,{[key]:snapshot});assert.equal(normal[key].length,7);assert.ok(normal[key].every(row=>typeof row.value==='string'));
  const extra=normalizeHistorySnapshot(entity,{[key]:{...snapshot,secret:{private:'forbidden'}}});assert.equal(extra[key],'[欄位格式無法判讀]');assert.ok(!JSON.stringify(extra).includes('forbidden'));
  const nested={...snapshot};Object.defineProperty(nested,'id',{enumerable:true,get(){calls++;return 'secret';}});
  assert.equal(normalizeHistorySnapshot(entity,{[key]:nested})[key],'[欄位格式無法判讀]');
  const root={};Object.defineProperty(root,key,{enumerable:true,get(){calls++;return snapshot;}});normalizeHistorySnapshot(entity,root);
 }
 assert.equal(calls,0);
});
test('notification typed history preserves full publication CRLF while own projection has no management note or other recipients; private getters never execute',()=>{
 const publisher={userId:'manager',userName:'保存管理員',role:'admin'},one={userId:'finance',userName:'保存財務',role:'finance'},other={userId:'caregiver',userName:'保存居服員',role:'caregiver'};
 const item={title:' 保留標題 ',body:' 原文\r\n結尾 ',recipientUserIds:['finance','caregiver'],status:'published',note:' 私人管理備註 ',cancellationReason:'',publication:{publicationVersion:2,title:' 保留標題 ',body:' 原文\r\n結尾 ',recipientSnapshots:[one,other],publisher,publishedAt:savedTime},id:'notice',orgId:'org',version:2,createdAt:savedTime,updatedAt:savedTime};
 const manager=normalizeHistorySnapshot('internal-notifications',item);assert.equal(manager.publication.find(row=>row.label==='發布全文原文').value,item.body);assert.equal(manager.recipientUserIds.length,2);
 const own={title:item.title,body:item.body,status:item.status,cancellationReason:'',publicationVersion:2,publishedAt:savedTime,publisher,recipientSnapshot:one,id:item.id,orgId:item.orgId,version:2,createdAt:savedTime,updatedAt:savedTime};
 const publicValue=normalizeHistorySnapshot('internal-notifications',own);assert.equal(publicValue.body,item.body);assert.equal(publicValue.note,null);assert.deepEqual(publicValue.recipientUserIds,[]);assert.deepEqual(publicValue.publication,[]);assert.ok(!JSON.stringify(publicValue).includes('caregiver'));assert.ok(!JSON.stringify(publicValue).includes('私人管理備註'));
 let calls=0;const bad={...item.publication};Object.defineProperty(bad,'recipientSnapshots',{enumerable:true,get(){calls++;return [other];}});normalizeHistorySnapshot('internal-notifications',{...item,publication:bad});const root={...item};Object.defineProperty(root,'publication',{enumerable:true,get(){calls++;return item.publication;}});normalizeHistorySnapshot('internal-notifications',root);assert.equal(calls,0);
 assert.deepEqual(diffHistorySnapshots('internal-notifications',own,{...own,status:'cancelled',cancellationReason:' 本次\r\n原因 '}).map(row=>row.key),['status','cancellationReason']);
});
