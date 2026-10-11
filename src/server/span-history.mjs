import { isDeepStrictEqual } from 'node:util';
import { SPAN_END_FIELDS, entitySpan, assertEntityCapturedMinutes } from './shift-span.mjs';
import { entities, validatePayload, business } from './model.mjs';

const plain = value => !!value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key=>typeof key==='string' && Object.getOwnPropertyDescriptor(value,key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const identity = value => typeof value==='string' && value.length>0 && value.length<=500 && value===value.trim() && !/[\0\r\n]/.test(value);
const scalar = value => typeof value==='string' && value.length>0 && value.length<=100 && !/[\0\r\n]/.test(value);
const meta = ['id','orgId','version','createdAt','updatedAt'];
const closed = (value,keys) => plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text = value => typeof value==='string'&&value.length<=500;
function assertTrial(record,bad) {
  const snapshot=record.billingSnapshot,employee=snapshot?.employee;
  if(record.status!=='approved'||!closed(snapshot,['capturedAt','currency','trial','source','serviceMinutes','employee','items'])
    ||!scalar(snapshot.capturedAt)||!Number.isFinite(Date.parse(snapshot.capturedAt))||snapshot.currency!=='TWD'||snapshot.trial!==true||snapshot.source!=='approval'
    ||!closed(employee,['id','name','employeeNo','hourlyRateCents'])||!identity(employee.id)||employee.id!==record.employeeId||!text(employee.name)||!text(employee.employeeNo)
    ||!Number.isSafeInteger(employee.hourlyRateCents)||employee.hourlyRateCents<0||employee.hourlyRateCents>1e9
    ||!Array.isArray(record.services)||!Array.isArray(snapshot.items)||!snapshot.items.length||snapshot.items.length>100||snapshot.items.length!==record.services.length)bad();
  assertEntityCapturedMinutes('service-records',record,snapshot.serviceMinutes,()=>bad());
  snapshot.items.forEach((item,index)=>{const service=record.services[index];
    if(!closed(item,['serviceItemId','code','name','quantity','unitPriceCents','amountCents'])||!identity(item.serviceItemId)||item.serviceItemId!==service?.serviceItemId
      ||!text(item.code)||!text(item.name)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>10000||item.quantity!==service.quantity
      ||!Number.isSafeInteger(item.unitPriceCents)||item.unitPriceCents<0||item.unitPriceCents>1e9||!Number.isSafeInteger(item.amountCents)||item.amountCents!==item.unitPriceCents*item.quantity)bad();
  });
}

/** Independent immutable marker survives missing current fields and bad JSON.
 * Activation is scoped to the existing three span entities in this organization.
 * Legacy-only organizations keep the original history branch byte semantics.
 */
export function isStrictSpanHistory(db,orgId,entity) {
  if(!SPAN_END_FIELDS[entity])return false;
  for(const type of Object.keys(SPAN_END_FIELDS)) {
    const field=SPAN_END_FIELDS[type];
    for(const row of db.prepare('SELECT data FROM records WHERE org_id=? AND entity=?').all(orgId,type)) {
      try { const value=JSON.parse(row.data); if(plain(value)&&Object.hasOwn(value,field))return true; } catch {}
    }
    for(const row of db.prepare('SELECT snapshot,source FROM record_versions WHERE org_id=? AND entity=?').all(orgId,type)) {
      if(['span-create','span-update'].includes(row.source))return true;
      try { const value=JSON.parse(row.snapshot); if(plain(value)&&Object.hasOwn(value,field))return true; } catch {}
    }
  }
  return false;
}

/** Validate every saved version before the existing per-version authorization.
 * A corrupted row rejects the complete history; no skip, repair or live lookup.
 * Source remains a bounded scalar; old literal labels are never rewritten.
 */
export function readClosedSpanHistory(rows,entity,current,fail) {
  const bad=()=>fail(409,'SPAN_HISTORY_INVALID','完整日期時段歷程的保存身份、版次或內容無法確認，未略過或修改資料。');
  const spec=entities[entity],keys=[...spec.fields.split(' '),...meta,...(entity==='service-records'?['billingSnapshot']:[])];
  let head;
  const result=rows.map(row=>{
    if(typeof row.version!=='bigint'||row.version<1n||row.version>BigInt(Number.MAX_SAFE_INTEGER)||row.version>BigInt(current.version)||!scalar(row.createdAt)||!scalar(row.source))bad();
    let snapshot; try{snapshot=JSON.parse(row.snapshot);}catch{bad();}
    const version=Number(row.version);
    if(!plain(snapshot)||Reflect.ownKeys(snapshot).some(key=>!keys.includes(key))||meta.some(key=>!Object.hasOwn(snapshot,key))
      ||!identity(snapshot.id)||!identity(snapshot.orgId)||snapshot.id!==current.id||snapshot.orgId!==current.orgId||snapshot.version!==version
      ||snapshot.createdAt!==current.createdAt||snapshot.updatedAt!==row.createdAt||!scalar(snapshot.createdAt)||!scalar(snapshot.updatedAt)
      ||!spec.statuses.includes(snapshot.status)||spec.required.some(key=>!Object.hasOwn(snapshot,key)))bad();
    try {
      const data=business(snapshot); delete data.billingSnapshot;
      validatePayload(entity,data);
      entitySpan(entity,snapshot,fail);
      for(const key of ['employeeId',...(entity==='leave-requests'?[]:['caseId']),...(entity==='service-records'?['shiftId']:[])])if(!identity(snapshot[key]))bad();
      if(entity!=='leave-requests') {
        if(!Array.isArray(snapshot.services)||!snapshot.services.length||snapshot.services.length>100)bad();
        const seen=new Set();for(const service of snapshot.services) {
          if(!closed(service,['serviceItemId','quantity'])||!identity(service.serviceItemId)||!Number.isSafeInteger(service.quantity)||service.quantity<1||service.quantity>10000||seen.has(service.serviceItemId))bad();
          seen.add(service.serviceItemId);
        }
      }
      if(entity==='service-records'&&Object.hasOwn(snapshot,'actualEndDate')&&snapshot.status==='approved'&&!Object.hasOwn(snapshot,'billingSnapshot'))bad();
      if(entity==='service-records'&&Object.hasOwn(snapshot,'billingSnapshot'))assertTrial(snapshot,bad);
    } catch { bad(); }
    if(version===current.version)head=snapshot;
    return {...row,version,snapshot};
  });
  if(!head||!isDeepStrictEqual(head,current))bad();
  return result;
}
