import { createHash, randomUUID } from 'node:crypto';
import { LOCAL_IMPORT_TYPES, buildLocalImportRows } from '../../public/data/local-import-core.js';
import { entities, rows, validatePayload, validate, insert, audit, fail } from './model.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
export function guardLocalImport(ctx){if(ctx?.role!=='admin')fail(403,'ROLE_FORBIDDEN','只有目前機構管理者可使用本機新增匯入。');}
function localImportPlan(db,ctx,payload,commit=false){
  guardLocalImport(ctx);
  const allowed=commit?['entity','csv','mapping','previewHash']:['entity','csv','mapping'];
  if(!plain(payload)||Object.keys(payload).length!==allowed.length||Object.keys(payload).some(key=>!allowed.includes(key))||typeof payload.entity!=='string'||!Object.hasOwn(LOCAL_IMPORT_TYPES,payload.entity)||commit&&(typeof payload.previewHash!=='string'||!/^[a-f0-9]{64}$/.test(payload.previewHash)))fail(422,'IMPORT_INVALID','匯入內容或預覽識別不完整。');
  const entity=payload.entity,spec=LOCAL_IMPORT_TYPES[entity];let parsed;
  try{parsed=buildLocalImportRows(entity,payload.csv,payload.mapping);}catch(error){if(error.status===422)fail(422,error.code,error.message,error.fields);throw error;}
  let current;try{current=rows(db,ctx.orgId,entity);}catch{fail(409,'IMPORT_SOURCE_UNVERIFIABLE','既有同類資料无法完整確認，請先核對。');}
  const known=entities[entity].fields.split(' ').concat(['id','orgId','version','createdAt','updatedAt']);
  if(current.some(item=>!plain(item)||Object.keys(item).some(key=>!known.includes(key))||item.orgId!==ctx.orgId||!Number.isSafeInteger(item.version)||item.version<1||typeof item[spec.key]!=='string'||!item[spec.key].trim()))fail(409,'IMPORT_SOURCE_UNVERIFIABLE','既有同類資料無法完整確認，請先核對。');
  const used=new Set(current.map(item=>item[spec.key])),batchKeys=new Set(),errors=[],prepared=[];
  for(const row of parsed.rows){
    try{
      const valid=validatePayload(entity,row.data),data={...entities[entity].defaults,...valid};
      for(const field of spec.required)if(typeof data[field]==='string'&&!data[field].trim())fail(422,'REQUIRED','匯入必要欄位不可只有空白。',{[field]:'必填'});
      const key=data[spec.key];if(typeof key!=='string'||key!==key.trim()||/[\r\n]/.test(key)||key.length>200)fail(422,'IMPORT_CODE_INVALID','編號須為200字內、不含首尾空白的單行原文。',{[spec.key]:'請核對唯一編號'});
      if(used.has(key)||batchKeys.has(key))fail(409,'DUPLICATE_CODE','本機或本批次已有相同精確編號。',{[spec.key]:'不覆寫既有資料'});
      batchKeys.add(key);validate(db,ctx,entity,data);prepared.push({rowNumber:row.rowNumber,data});
    }catch(error){if(!Number.isInteger(error.status))throw error;errors.push({rowNumber:row.rowNumber,code:error.code,message:error.message,fields:error.fields||{}});}
  }
  return {entity,label:spec.label,totalCount:parsed.rows.length,validCount:prepared.length,ready:errors.length===0,errors,rows:prepared,previewHash:hash({entity,csv:payload.csv,mapping:payload.mapping,current})};
}
export function previewLocalImport(db,ctx,payload){return localImportPlan(db,ctx,payload);}
/** Caller must hold the original idempotency BEGIN IMMEDIATE transaction. */
export function commitLocalImport(db,ctx,payload){
  const plan=localImportPlan(db,ctx,payload,true);
  if(!plan.ready)fail(422,'IMPORT_ROWS_INVALID','仍有資料錯誤，整批未保存。');
  if(plan.previewHash!==payload.previewHash)fail(409,'IMPORT_PREVIEW_STALE','來源、欄位對應或目前資料已變更，請重新預覽。');
  const sourceHash=createHash('sha256').update(payload.csv).digest('hex'),batchId=randomUUID(),items=[];
  for(const row of plan.rows){const item=insert(db,ctx.orgId,plan.entity,row.data);audit(db,ctx,'record.import',plan.entity,item.id,{version:1,batchId,rowNumber:row.rowNumber,sourceHash});items.push(item);}
  audit(db,ctx,'batch.import',plan.entity,null,{batchId,sourceHash,count:items.length,recordIds:items.map(item=>item.id)});
  return {batchId,entity:plan.entity,importedCount:items.length,sourceHash,items,mode:'local-new-records-only'};
}
