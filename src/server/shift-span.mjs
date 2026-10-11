import { isDeepStrictEqual } from 'node:util';
import {
  shiftSpan, serviceSpan, spansOverlap, spanWithinValidity,
  referenceSnapshotKind, explicitReferenceSpan, assertCapturedServiceMinutes,
} from '../../public/data/shift-span.js';

export const SPAN_END_FIELDS = Object.freeze({ shifts: 'endDate', 'leave-requests': 'endDate', 'service-records': 'actualEndDate' });
export class SpanHttpError extends Error {
  constructor(status, code, message, fields) { super(message); this.status=status; this.code=code; if(fields)this.fields=fields; }
}
export function spanFail(status, code, message, fields) { throw new SpanHttpError(status,code,message,fields); }
const plain = value => !!value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key=>typeof key==='string' && Object.getOwnPropertyDescriptor(value,key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const identity = value => typeof value==='string' && value.length>0 && value.length<=500 && value===value.trim() && !/[\0\r\n]/.test(value);
const stamp = value => typeof value==='string' && value.length>0 && value.length<=100;
const failClosed = (fail,code='SPAN_DATA_INVALID') => fail(409,code,'有無法確認的完整日期時段／保存版次或歷程，未修改資料。');

export const hasExplicitSpan = (entity,data) => !!SPAN_END_FIELDS[entity] && Object.hasOwn(data,SPAN_END_FIELDS[entity]);
/** Exact subset projection, not a replacement for the caller's full DTO guard. */
export function spanProjection(entity,data,fail=spanFail) {
  if(!SPAN_END_FIELDS[entity])fail(422,'SPAN_ENTITY_INVALID','不支援的日期時段資料類型。');
  if(!plain(data))fail(422,'SPAN_SHAPE_INVALID','日期時段資料須為無accessor的plain object。');
  const fields=entity==='service-records'?['date','actualStart','actualEnd']:['date','startTime','endTime'];
  if(fields.some(key=>!Object.hasOwn(data,key)))fail(422,'SPAN_SHAPE_INVALID','開始日及完整起訖時間不可省略。');
  return Object.fromEntries([...fields,...(hasExplicitSpan(entity,data)?[SPAN_END_FIELDS[entity]]:[])].map(key=>[key,data[key]]));
}
export function entitySpan(entity,data,fail=spanFail) {
  const projection=spanProjection(entity,data,fail);
  try{return entity==='service-records'?serviceSpan(projection):shiftSpan(projection);}catch(error){
    if(!hasExplicitSpan(entity,data))fail(422,'TIME_RANGE','結束時間必須晚於開始時間，且須為同日有效時間');
    fail(422,error.code||'TIME_RANGE',error.message,{[SPAN_END_FIELDS[entity]]:'請核對明確同日或翌日結束日與完整HH:mm'});
  }
}
/** Reject explicit null/type before legacy model scalar coercion. */
export function assertSpanPayload(entity,payload,fail=spanFail) {
  const field=SPAN_END_FIELDS[entity]; if(!field)return payload;
  if(!plain(payload))fail(422,'SPAN_SHAPE_INVALID','只接受無accessor的plain object。');
  if(Object.hasOwn(payload,field) && (typeof payload[field]!=='string' || payload[field].length!==10 || /[\r\n]/.test(payload[field])))fail(422,'INVALID_DATE','明確結束日期不可為空值或非字串',{[field]:'請填完整有效日期'});
  return payload;
}
export function spanIntervalsOverlap(leftEntity,left,rightEntity,right,fail=spanFail) { return spansOverlap(entitySpan(leftEntity,left,fail),entitySpan(rightEntity,right,fail)); }
/** Original optional validity empty/null semantics are selected without rewrite. */
export function coversOriginalDateBounds(span,validFrom,validTo,fail=spanFail) {
  try{return spanWithinValidity(span,{...(validFrom?{validFrom}:{}),...(validTo?{validTo}:{})});}catch{failClosed(fail);}
}
export function assertSpanPlanCoverage(entity,data,plan,fail=spanFail) {
  const span=entitySpan(entity,data,fail);
  if(!plain(plan)||!coversOriginalDateBounds(span,plan.validFrom,plan.validTo,fail))fail(422,'INVALID_PLAN','照顧計畫须涵蓋完整服務佔用日。');
  return span;
}
export function assertSpanServiceValidity(entity,data,item,fail=spanFail) {
  const span=entitySpan(entity,data,fail);
  if(!plain(item)||!coversOriginalDateBounds(span,item.validFrom,item.validTo,fail))fail(422,'INACTIVE_SERVICE','服務項目未涵蓋完整服務佔用日。');
  return span;
}
export function spanFieldsChanged(entity,before,after) {
  const fields=entity==='service-records'?['date','actualStart','actualEnd','actualEndDate']:['date','startTime','endTime','endDate'];
  if(!plain(before)||!plain(after))return true;
  return fields.some(key=>Object.hasOwn(before,key)!==Object.hasOwn(after,key)||!isDeepStrictEqual(before[key],after[key]));
}
/** Seven fields unchanged; new eighth only comes from a fully saved explicit shift. */
export function shiftReferenceSnapshot(shift,fail=spanFail) {
  const span=entitySpan('shifts',shift,fail), fields=['id','orgId','version','employeeId','date','startTime','endTime',...(span.hasEndDate?['endDate']:[])];
  const snapshot=Object.fromEntries(fields.map(key=>[key,shift[key]]));
  try{referenceSnapshotKind(snapshot);}catch{fail(409,'SPAN_REFERENCE_INVALID','保存班次識別或明確span無法確認。');}
  return snapshot;
}
/** Preserve each existing domain's complete legacy-seven validator. */
export function validateSpanReference(snapshot,legacyValidator,fail=spanFail) {
  let kind; try{kind=referenceSnapshotKind(snapshot);}catch{fail(422,'SPAN_REFERENCE_INVALID','只接受已知七欄／八欄保存參照。');}
  if(kind==='legacy-seven'){
    if(typeof legacyValidator!=='function')fail(500,'SPAN_LEGACY_VALIDATOR_REQUIRED','歷史七欄須保留原domain驗證。');
    return legacyValidator(snapshot);
  }
  explicitReferenceSpan(snapshot); return snapshot;
}
export function capturedEntityMinutes(entity,data,fail=spanFail) { return entitySpan(entity,data,fail).durationMinutes; }
export function assertEntityCapturedMinutes(entity,data,minutes,fail=spanFail) {
  try{return assertCapturedServiceMinutes(minutes,entitySpan(entity,data,fail));}catch(error){fail(409,error.code||'SPAN_CAPTURED_MINUTES_INVALID','當時保存技術分鐘與完整服務時段不符。');}
}

/** Read-only closed dependency/head guard; trusted caller supplies entity schema.
 * No repair, DB writes, temporary status changes, role expansion or private DB.
 */
export function readSpanDependencyRows(db,orgId,entity,{fields,required=[],statuses,assertExtra=()=>{},fail=spanFail}={}) {
  if(!identity(orgId)||!Array.isArray(fields)||fields.some(key=>typeof key!=='string'))failClosed(fail);
  const statement=db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id'); statement.setReadBigInts(true);
  const raw=statement.all(orgId,entity);
  return raw.map(row=>{
    if(row.org_id!==orgId||row.entity!==entity||!identity(row.id)||typeof row.version!=='bigint'||row.version<1n||row.version>BigInt(Number.MAX_SAFE_INTEGER)||!stamp(row.created_at)||!stamp(row.updated_at)||typeof row.data!=='string')failClosed(fail);
    let data;try{data=JSON.parse(row.data);}catch{failClosed(fail);}
    if(!plain(data)||Reflect.ownKeys(data).some(key=>!fields.includes(key))||required.some(key=>!Object.hasOwn(data,key))||statuses&&!statuses.includes(data.status))failClosed(fail);
    const item={...data,id:row.id,orgId,version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
    const headStmt=db.prepare('SELECT version,snapshot,created_at,source FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?'); headStmt.setReadBigInts(true); const head=headStmt.get(orgId,entity,row.id,row.version);
    let snapshot;try{snapshot=JSON.parse(head?.snapshot);}catch{failClosed(fail);}
    if(!head||head.version!==row.version||!stamp(head.source)||head.created_at!==item.updatedAt||!plain(snapshot)||!isDeepStrictEqual(snapshot,item))failClosed(fail);
    try{if(SPAN_END_FIELDS[entity])entitySpan(entity,item,fail);assertExtra(item);}catch{failClosed(fail);}
    return item;
  });
}
