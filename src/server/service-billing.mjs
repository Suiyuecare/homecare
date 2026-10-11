import { entitySpan } from './shift-span.mjs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const serviceBillingMode='manual-service-billing-v1';
export const serviceBillingSpanMode='manual-service-billing-span-v1';
export const serviceBillingOriginEntity='billing-service-origins';
export const SERVICE_BILLING_SOURCE_FIELDS=Object.freeze(['id','orgId','version','caseId','employeeId','shiftId','date','actualStart','actualEnd','billingSnapshot','createdAt','updatedAt']);
export const SERVICE_BILLING_ORIGIN_FIELDS=Object.freeze(['id','orgId','version','createdAt','updatedAt','billingDocumentId','caseId','month','number','sourceReference','note','sourceSnapshots','manualLines','initialBillSnapshot']);
const meta=['id','orgId','version','createdAt','updatedAt'];
const billFields=['caseId','month','number','lineItems','sourceReference','status','note','summary','caseSnapshot'];
const lineFields=['serviceRecordId','version','label','amountCents','sourceReference'];
const payloadFields=['caseId','month','number','sourceReference','note','lines'];
const own=(o,k)=>Object.getOwnPropertyDescriptor(o,k);
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&[Object.prototype,null].includes(Object.getPrototypeOf(o))&&Reflect.ownKeys(o).every(k=>typeof k==='string'&&own(o,k)?.enumerable&&Object.hasOwn(own(o,k),'value'));
const closed=(o,fields)=>plain(o)&&Object.keys(o).length===fields.length&&fields.every(k=>Object.hasOwn(o,k));
const dense=(a,min,max)=>Array.isArray(a)&&Object.getPrototypeOf(a)===Array.prototype&&a.length>=min&&a.length<=max&&Reflect.ownKeys(a).length===a.length+1&&Array.from({length:a.length},(_,i)=>String(i)).every(k=>own(a,k)?.enumerable&&Object.hasOwn(own(a,k),'value'));
const text=(v,max,required=false)=>typeof v==='string'&&v.length<=max&&(!required||!!v.trim());
const ref=v=>text(v,100,true)&&v===v.trim()&&!/[\r\n]/.test(v);
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const money=v=>integer(v,0,1000000000);
const month=v=>typeof v==='string'&&v.length===7&&/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(v);
const date=v=>typeof v==='string'&&v.length===10&&/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const iso=v=>typeof v==='string'&&v.length===24&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originId=(org,bill)=>{const h=createHash('sha256').update(JSON.stringify([serviceBillingOriginEntity,org,bill])).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
function minute(value,day){
  if(typeof value!=='string'||/[\r\n]/.test(value))return NaN;
  if(/^\d{2}:\d{2}$/.test(value)&&value.length===5){const [h,m]=value.split(':').map(Number);return h<24&&m<60?h*60+m:NaN;}
  // Preserve existing approved ISO text; never convert the stored source.
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)&&value.slice(0,10)===day&&Number.isFinite(Date.parse(value)))return minute(value.slice(11,16),day);
  return NaN;
}
const issue=(fail,code,message,fields)=>fail(409,code,message,fields);
const invalid=(fail,message,fields)=>fail(422,'SERVICE_BILLING_INVALID',message,fields);
function boundedResponse(value,fail){
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>2*1024*1024)fail(413,'SERVICE_BILLING_TOO_LARGE','完整回應超過2MiB，請縮小選取或分頁／搜尋範圍；不會省略原來源或保存結果。');
  return value;
}
function statementRows(db,sql,args=[]){const stmt=db.prepare(sql);stmt.setReadBigInts(true);return stmt.all(...args);}

/** Role check runs before body/query; a captured context does not survive revocation. */
export function guardServiceBillingAccess(db,ctx,fail){
  if(!['admin','finance'].includes(ctx?.role))fail(403,'ROLE_FORBIDDEN','僅目前機構管理者或財務可由核閱服務建立人工帳單。');
  if(!ref(ctx.orgId)||!ref(ctx.user?.id)||db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(ctx.orgId,ctx.user.id)?.role!==ctx.role)
    fail(403,'ROLE_FORBIDDEN','目前登入成員或機構授權已失效。');
}

export function serviceBillingQuery(params,fail,mode='sources'){
  if(!params||typeof params.keys!=='function')invalid(fail,'查詢格式無法確認。');
  if(mode==='mutation'){if([...params.keys()].length)invalid(fail,'此操作不接受查詢欄位。');return{};}
  if(mode==='single'){for(const key of params.keys())if(key!=='spanMode'||params.getAll(key).length!==1||params.get(key)!=='calendar-two-day-v1')invalid(fail,'來源詳細只接受單一完整日期模式。');return params.has('spanMode')?{spanMode:'calendar-two-day-v1'}:{};}
  if(!['sources','origins'].includes(mode))invalid(fail,'查詢模式不合法。');
  for(const key of params.keys())if(!['caseId','month','page','pageSize','q','spanMode'].includes(key)||params.getAll(key).length!==1)invalid(fail,'查詢欄位未知或重複。',{[key]:'請使用單一合法欄位'});
  const caseId=params.get('caseId'),selectedMonth=params.get('month'),q=params.get('q')??'';
  if(!ref(caseId)||!month(selectedMonth)||!text(q,200))invalid(fail,'請指定同機構個案與有效月份。');
  if(params.has('spanMode')&&params.get('spanMode')!=='calendar-two-day-v1')invalid(fail,'完整日期模式不合法。');
  const pageValue=params.get('page')??'1',sizeValue=params.get('pageSize')??'25';
  if(!/^[1-9]\d*$/.test(pageValue)||/[\r\n]/.test(pageValue)||!integer(Number(pageValue),1)||!Number.isSafeInteger((Number(pageValue)-1)*Number(sizeValue))
    ||!/^[1-9]\d*$/.test(sizeValue)||/[\r\n]/.test(sizeValue)||!integer(Number(sizeValue),1,100))invalid(fail,'分頁須為單一正整數，pageSize最多100。');
  return{caseId,month:selectedMonth,q,page:Number(pageValue),pageSize:Number(sizeValue),...(params.has('spanMode')?{spanMode:'calendar-two-day-v1'}:{})};
}

export function validateServiceBillingPayload(payload,fail,{create=false}={}){
  const explicit=plain(payload)&&Object.hasOwn(payload,'spanMode'); if(explicit&&payload.spanMode!=='calendar-two-day-v1')invalid(fail,'完整日期模式不合法。');
  if(!closed(payload,[...payloadFields,...(create?['previewHash']:[]),...(explicit?['spanMode']:[])]))invalid(fail,'請提供完整且沒有未知欄位的人工核對內容。');
  if(!ref(payload.caseId)||!month(payload.month)||!text(payload.number,100,true)||payload.number!==payload.number.trim()||/[\r\n]/.test(payload.number)
    ||!text(payload.sourceReference,2000,true)||!text(payload.note,10000)||!dense(payload.lines,1,100))invalid(fail,'請核對個案、月份、編號、人工依據與1至100筆來源。');
  const seen=new Set();
  for(let i=0;i<payload.lines.length;i++){
    const line=payload.lines[i];
    if(!closed(line,lineFields)||!ref(line.serviceRecordId)||!integer(line.version,1)||!text(line.label,300,true)||/[\r\n]/.test(line.label)||!money(line.amountCents)||!text(line.sourceReference,2000,true)||seen.has(line.serviceRecordId))
      invalid(fail,'每筆來源須明確填寫保存版次、單行名稱、人工整數分總額及依據，來源不可重複。',{lines:`第${i+1}筆格式或依據不符`});
    seen.add(line.serviceRecordId);
  }
  if(create&&(typeof payload.previewHash!=='string'||payload.previewHash.length!==64||!/^[a-f0-9]{64}$/.test(payload.previewHash)))invalid(fail,'請先完成本次預覽。');
  return payload;
}

/** Approved snapshots are checked, never repaired or repriced. */
export function assertServiceBillingSource(source,fail){
  const explicit=plain(source)&&Object.hasOwn(source,'actualEndDate');
  if(!closed(source,[...SERVICE_BILLING_SOURCE_FIELDS,...(explicit?['actualEndDate']:[])])||!ref(source.id)||!ref(source.orgId)||!integer(source.version,1)||!ref(source.caseId)||!ref(source.employeeId)||!ref(source.shiftId)||!date(source.date)
    ||!iso(source.createdAt)||!iso(source.updatedAt)||source.updatedAt<source.createdAt)issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','來源保存身份或版次無法完整確認。');
  const b=source.billingSnapshot,start=minute(source.actualStart,source.date),end=minute(source.actualEnd,source.date);
  let duration=end-start; if(explicit) { try { duration=entitySpan('service-records',source,fail).durationMinutes; } catch { issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','明確結束日原核閱來源無法確認。'); } }
  if(!closed(b,['capturedAt','currency','trial','source','serviceMinutes','employee','items'])||!iso(b.capturedAt)||b.currency!=='TWD'||b.trial!==true||b.source!=='approval'
    ||!integer(b.serviceMinutes,1,explicit?2879:1440)||(!explicit&&(!Number.isFinite(start)||!Number.isFinite(end)||end<=start))||b.serviceMinutes!==duration
    ||!closed(b.employee,['id','name','employeeNo','hourlyRateCents'])||b.employee.id!==source.employeeId||!text(b.employee.name,500)||!text(b.employee.employeeNo,500)||!money(b.employee.hourlyRateCents)||!dense(b.items,1,100))
    issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','原核閱試算與時間／人員保存快照無法確認。');
  const ids=new Set();
  for(const item of b.items){
    if(!closed(item,['serviceItemId','code','name','quantity','unitPriceCents','amountCents'])||!ref(item.serviceItemId)||ids.has(item.serviceItemId)||!text(item.code,500)||!text(item.name,500)||!integer(item.quantity,1,10000)||!money(item.unitPriceCents)
      ||!integer(item.amountCents)||BigInt(item.quantity)*BigInt(item.unitPriceCents)!==BigInt(item.amountCents))issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','原試算服務項目或精確金額無法確認。');
    ids.add(item.serviceItemId);
  }
  return source;
}

function rawRecord(db,org,entity,id,fail,code='SERVICE_SOURCE_UNVERIFIABLE'){
  const rows=statementRows(db,'SELECT * FROM records WHERE org_id=? AND entity=? AND id=?',[org,entity,id]);
  if(!rows.length)return null;const row=rows[0];
  if(rows.length!==1||typeof row.version!=='bigint'||row.version<1n||row.version>BigInt(Number.MAX_SAFE_INTEGER)||!iso(row.created_at)||!iso(row.updated_at)||row.updated_at<row.created_at)issue(fail,code,'保存資料的SQL身份或版次無法確認。');
  let data;try{data=JSON.parse(row.data);}catch{issue(fail,code,'保存資料無法確認。');}
  if(!plain(data)||meta.some(k=>Object.hasOwn(data,k)))issue(fail,code,'保存資料的業務／SQL身份混合或無法確認。');
  const record={...data,id:row.id,orgId:row.org_id,version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
  const versions=statementRows(db,'SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?',[org,entity,id,record.version]);
  if(versions.length!==1||versions[0].version!==row.version)issue(fail,code,'原不可改寫保存版本缺失或無法確認。');
  let snapshot;try{snapshot=JSON.parse(versions[0].snapshot);}catch{issue(fail,code,'原不可改寫版本無法確認。');}
  if(!isDeepStrictEqual(record,snapshot))issue(fail,code,'目前保存內容與原不可改寫版本不一致。');
  return record;
}
function readSource(db,ctx,id,fail){
  const record=rawRecord(db,ctx.orgId,'service-records',id,fail);if(!record)fail(404,'NOT_FOUND','找不到可核對的服務來源。');
  const required=['shiftId','caseId','employeeId','date','actualStart','actualEnd','services','status','billingSnapshot',...meta];
  const allowed=[...required,'note','reviewNote','actualEndDate'];
  if(!plain(record)||required.some(k=>!Object.hasOwn(record,k))||Object.keys(record).some(k=>!allowed.includes(k))||record.status!=='approved'||!dense(record.services,1,100)
    ||['note','reviewNote'].some(k=>Object.hasOwn(record,k)&&!text(record[k],10000)))issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','來源必須是完整已核閱服務紀錄。');
  const source=Object.fromEntries([...SERVICE_BILLING_SOURCE_FIELDS,...(Object.hasOwn(record,'actualEndDate')?['actualEndDate']:[])].map(k=>[k,record[k]]));assertServiceBillingSource(source,fail);
  if(record.services.length!==source.billingSnapshot.items.length||record.services.some((s,i)=>!closed(s,['serviceItemId','quantity'])||s.serviceItemId!==source.billingSnapshot.items[i].serviceItemId||s.quantity!==source.billingSnapshot.items[i].quantity))issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','原服務數量與核閱快照不一致。');
  const employee=rawRecord(db,ctx.orgId,'employees',source.employeeId,fail),shift=rawRecord(db,ctx.orgId,'shifts',source.shiftId,fail);
  if(!employee||!shift||shift.caseId!==source.caseId||shift.employeeId!==source.employeeId||shift.date!==source.date||shift.status!=='completed')issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','來源同機構員工或原完成班次無法確認。');
  return source;
}
function currentCase(db,ctx,id,fail){const item=rawRecord(db,ctx.orgId,'cases',id,fail);if(!item)fail(404,'NOT_FOUND','找不到可使用的個案。');if(!text(item.name,500)||!text(item.caseNo,500))issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','個案保存身份無法確認。');return{id:item.id,name:item.name,caseNo:item.caseNo};}
function assertBill(bill,ctx,fail){
  if(!closed(bill,[...billFields,...meta])||bill.orgId!==ctx.orgId||!ref(bill.id)||!integer(bill.version,1)||!iso(bill.createdAt)||!iso(bill.updatedAt)||bill.updatedAt<bill.createdAt||!ref(bill.caseId)||!month(bill.month)||!text(bill.number,100,true)||!text(bill.sourceReference,2000)||!text(bill.note,10000)||!['draft','issued','voided'].includes(bill.status)||!dense(bill.lineItems,1,100)||!closed(bill.summary,['amountCents'])||!integer(bill.summary.amountCents)
    ||!closed(bill.caseSnapshot,['id','name','caseNo'])||bill.caseSnapshot.id!==bill.caseId||!text(bill.caseSnapshot.name,500)||!text(bill.caseSnapshot.caseNo,500))issue(fail,'BROKEN_BILLING_ORIGIN','帳單保存結果無法完整確認。');
  let total=0n;for(const line of bill.lineItems){if(!closed(line,['label','quantity','unitPriceCents'])||!text(line.label,300,true)||/[\r\n]/.test(line.label)||!integer(line.quantity,1,10000)||!money(line.unitPriceCents))issue(fail,'BROKEN_BILLING_ORIGIN','帳單明細格式無法確認。');total+=BigInt(line.quantity)*BigInt(line.unitPriceCents);}
  if(total>BigInt(Number.MAX_SAFE_INTEGER)||total!==BigInt(bill.summary.amountCents))issue(fail,'BROKEN_BILLING_ORIGIN','帳單明細金額無法精確核對。');return bill;
}
function assertOrigin(origin,ctx,fail){
  if(!closed(origin,SERVICE_BILLING_ORIGIN_FIELDS)||origin.orgId!==ctx.orgId||origin.version!==1||origin.id!==originId(ctx.orgId,origin.billingDocumentId)||!iso(origin.createdAt)||!iso(origin.updatedAt)||origin.createdAt!==origin.updatedAt
    ||!ref(origin.billingDocumentId)||!ref(origin.caseId)||!month(origin.month)||!text(origin.number,100,true)||!text(origin.sourceReference,2000,true)||!text(origin.note,10000)||!dense(origin.sourceSnapshots,1,100)||!dense(origin.manualLines,1,100))issue(fail,'BROKEN_BILLING_ORIGIN','保存的生成來源追溯無法確認。');
  validateServiceBillingPayload({caseId:origin.caseId,month:origin.month,number:origin.number,sourceReference:origin.sourceReference,note:origin.note,lines:origin.manualLines,...(origin.sourceSnapshots.some(source=>Object.hasOwn(source,'actualEndDate'))?{spanMode:'calendar-two-day-v1'}:{})},(...args)=>issue(fail,'BROKEN_BILLING_ORIGIN','保存的人工來源映射無法確認。'));
  if(origin.sourceSnapshots.length!==origin.manualLines.length)issue(fail,'BROKEN_BILLING_ORIGIN','保存來源及人工明細筆數不一致。');
  origin.sourceSnapshots.forEach((source,i)=>{assertServiceBillingSource(source,(...args)=>issue(fail,'BROKEN_BILLING_ORIGIN','保存原核閱來源無法確認。'));const line=origin.manualLines[i];if(source.orgId!==ctx.orgId||source.caseId!==origin.caseId||source.date.slice(0,7)!==origin.month||line.serviceRecordId!==source.id||line.version!==source.version)issue(fail,'BROKEN_BILLING_ORIGIN','保存來源身份或原版次錯置。');});
  const initial=assertBill(origin.initialBillSnapshot,ctx,fail);
  if(initial.id!==origin.billingDocumentId||initial.version!==1||initial.status!=='draft'||initial.caseId!==origin.caseId||initial.month!==origin.month||initial.number!==origin.number||initial.sourceReference!==origin.sourceReference||initial.note!==origin.note
    ||!isDeepStrictEqual(initial.lineItems,origin.manualLines.map(line=>({label:line.label,quantity:1,unitPriceCents:line.amountCents}))))issue(fail,'BROKEN_BILLING_ORIGIN','生成帳單初版與人工来源映射不一致。');
  return origin;
}
function origins(db,ctx,fail,{verifySources=true}={}){
  const raw=statementRows(db,'SELECT id FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id',[ctx.orgId,serviceBillingOriginEntity]);
  const result=[],bills=new Set(),used=new Set();
  for(const row of raw){const origin=rawRecord(db,ctx.orgId,serviceBillingOriginEntity,row.id,fail,'BROKEN_BILLING_ORIGIN');if(!origin)issue(fail,'BROKEN_BILLING_ORIGIN','來源追溯筆數無法核對。');assertOrigin(origin,ctx,fail);
    if(bills.has(origin.billingDocumentId))issue(fail,'BROKEN_BILLING_ORIGIN','來源追溯帳單重複。');bills.add(origin.billingDocumentId);
    const bill=rawRecord(db,ctx.orgId,'billing-documents',origin.billingDocumentId,fail,'BROKEN_BILLING_ORIGIN');if(!bill)issue(fail,'BROKEN_BILLING_ORIGIN','來源帳單缺失。');assertBill(bill,ctx,fail);currentCase(db,ctx,origin.caseId,fail);
    if(bill.caseId!==origin.caseId||bill.month!==origin.month||bill.number!==origin.number)issue(fail,'BROKEN_BILLING_ORIGIN','目前帳單與固定生成來源身份不一致。');
    for(const source of origin.sourceSnapshots){if(used.has(source.id))issue(fail,'BROKEN_BILLING_ORIGIN','來源服務已被重複占用。');used.add(source.id);if(verifySources&&!isDeepStrictEqual(readSource(db,ctx,source.id,fail),source))issue(fail,'BROKEN_BILLING_ORIGIN','來源服務與當時不可改寫版次不一致。');}
    result.push({origin,bill});
  }
  return{items:result,used};
}
const paginate=(items,query)=>({query:{caseId:query.caseId,month:query.month,q:query.q,...(query.spanMode?{spanMode:query.spanMode}:{})},items:items.slice((query.page-1)*query.pageSize,query.page*query.pageSize),total:items.length,page:query.page,pageSize:query.pageSize});

export function listServiceBillingSources(db,ctx,query,hooks){
  const{fail}=hooks;guardServiceBillingAccess(db,ctx,fail);currentCase(db,ctx,query.caseId,fail);const saved=origins(db,ctx,fail),raw=statementRows(db,'SELECT id,data FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id',[ctx.orgId,'service-records']),items=[];
  for(const row of raw){let data;try{data=JSON.parse(row.data);}catch{issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','服務來源資料無法完整確認。');}
    if(!plain(data))issue(fail,'SERVICE_SOURCE_UNVERIFIABLE','服務來源資料無法完整確認。');
    if(data.caseId!==query.caseId||typeof data.date!=='string'||data.date.slice(0,7)!==query.month||data.status!=='approved'||saved.used.has(row.id))continue;
    const source=readSource(db,ctx,row.id,fail);if(Object.hasOwn(source,'actualEndDate')&&!query.spanMode)issue(fail,'SPAN_VIEW_REQUIRED','此來源含明確結束日，請使用完整日期模式。');if(!query.q||[source.date,...source.billingSnapshot.items.flatMap(item=>[item.code,item.name])].some(value=>value.includes(query.q)))items.push(source);
  }
  return boundedResponse(paginate(items,query),fail);
}
function plan(db,ctx,payload,hooks,{create=false,allowOccupied=false}={}){
  const{fail}=hooks;guardServiceBillingAccess(db,ctx,fail);validateServiceBillingPayload(payload,fail,{create});const caseSnapshot=currentCase(db,ctx,payload.caseId,fail),saved=origins(db,ctx,fail),sources=[];let total=0n;
  for(const line of payload.lines){const source=readSource(db,ctx,line.serviceRecordId,fail);if(Object.hasOwn(source,'actualEndDate')&&!payload.spanMode)issue(fail,'SPAN_VIEW_REQUIRED','請以完整日期模式核對明確結束日来源。');if(source.caseId!==payload.caseId||source.date.slice(0,7)!==payload.month)invalid(fail,'所有來源須為指定同個案及同月份。');if(source.version!==line.version)issue(fail,'VERSION_CONFLICT','服務來源保存版次已變更，請重新核對。');if(!allowOccupied&&saved.used.has(source.id))issue(fail,'SERVICE_ALREADY_BILLED','服務來源已生成帳單，包含草稿及作廢紀錄，不可再次使用。');sources.push(source);total+=BigInt(line.amountCents);}
  if(total>BigInt(Number.MAX_SAFE_INTEGER))invalid(fail,'人工金額合計超出安全整數分。');
  const draft={caseId:payload.caseId,month:payload.month,number:payload.number,lineItems:payload.lines.map(line=>({label:line.label,quantity:1,unitPriceCents:line.amountCents})),sourceReference:payload.sourceReference,status:'draft',note:payload.note,summary:{amountCents:Number(total)},caseSnapshot};
  const preview={mode:payload.spanMode?serviceBillingSpanMode:serviceBillingMode,draft,sources,manualLines:structuredClone(payload.lines),sourceCount:sources.length};
  return boundedResponse({...preview,previewHash:hash(preview)},fail);
}
export function previewServiceBilling(db,ctx,payload,hooks){return plan(db,ctx,payload,hooks);}
/** Call before cached idempotency lookup; occupied sources are checked against a confirmed cached origin or at commit. */
export function preflightServiceBillingCreate(db,ctx,payload,hooks){const result=plan(db,ctx,payload,hooks,{create:true,allowOccupied:true});if(result.previewHash!==payload.previewHash)issue(hooks.fail,'SERVICE_BILLING_PREVIEW_STALE','輸入、來源或個案保存身份已變更，請重新預覽。');return result;}
/** The caller owns mandatory-idempotency BEGIN IMMEDIATE. All callbacks are synchronous existing model primitives. */
export function commitServiceBillingCreate(db,ctx,payload,hooks){
  const{fail,validatePayload,validate,insert,audit}=hooks;guardServiceBillingAccess(db,ctx,fail);
  if(!db.isTransaction)issue(fail,'TRANSACTION_REQUIRED','帳單與來源必須在同一交易保存。');
  if([validatePayload,validate,insert,audit].some(value=>typeof value!=='function'))issue(fail,'CALLBACK_REQUIRED','保存、驗證與稽核接口不完整。');
  const preview=plan(db,ctx,payload,hooks,{create:true});if(preview.previewHash!==payload.previewHash)issue(fail,'SERVICE_BILLING_PREVIEW_STALE','來源或輸入已變更，請重新預覽。');
  const data=Object.fromEntries(['caseId','month','number','lineItems','sourceReference','status','note'].map(k=>[k,structuredClone(preview.draft[k])]));
  // Existing payload validation still checks its field contract. This dedicated
  // creation flow keeps the explicitly entered documentary source text, rather
  // than copying the generic normalizer's trim into an immutable origin.
  validatePayload('billing-documents',data);
  validate(db,ctx,'billing-documents',data);
  if(!isDeepStrictEqual(data,preview.draft))issue(fail,'BILLING_GENERATION_MISMATCH','既有帳單保存接口改寫了本次人工核對內容。');
  const item=insert(db,ctx.orgId,'billing-documents',data);assertBill(item,ctx,fail);
  const body={billingDocumentId:item.id,caseId:item.caseId,month:item.month,number:item.number,sourceReference:payload.sourceReference,note:payload.note,sourceSnapshots:preview.sources,manualLines:preview.manualLines,initialBillSnapshot:item};
  // A deterministic internal id and PK plus the encompassing transaction protect occupancy without a new table.
  const key=originId(ctx.orgId,item.id),time=item.updatedAt;db.prepare('INSERT INTO records(id,org_id,entity,data,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(key,ctx.orgId,serviceBillingOriginEntity,JSON.stringify(body),1,time,time);
  const origin={...body,id:key,orgId:ctx.orgId,version:1,createdAt:time,updatedAt:time};assertOrigin(origin,ctx,fail);
  db.prepare('INSERT INTO record_versions(org_id,entity,record_id,version,snapshot,created_at,source) VALUES(?,?,?,?,?,?,?)').run(ctx.orgId,serviceBillingOriginEntity,key,1,JSON.stringify(origin),time,'create');
  audit(db,ctx,'record.create','billing-documents',item.id,{status:'draft',version:1,originId:key});
  audit(db,ctx,'service-billing.create',serviceBillingOriginEntity,key,{billingDocumentId:item.id,sourceRecordIds:preview.sources.map(source=>source.id),amountCents:item.summary.amountCents,version:1});
  return boundedResponse({mode:payload.spanMode?serviceBillingSpanMode:serviceBillingMode,item,origin},fail);
}
export function confirmServiceBillingCreateResponse(db,ctx,response,payload,hooks){
  const{fail}=hooks;guardServiceBillingAccess(db,ctx,fail);if(!closed(response,['mode','item','origin'])||response.mode!==(payload.spanMode?serviceBillingSpanMode:serviceBillingMode))issue(fail,'SERVICE_BILLING_ACK_INVALID','保存回應無法完整確認。');
  assertOrigin(response.origin,ctx,fail);assertBill(response.item,ctx,fail);
  const pair=origins(db,ctx,fail).items.find(row=>row.origin.id===response.origin.id);
  if(!pair||!isDeepStrictEqual(pair.origin,response.origin)||!isDeepStrictEqual(response.item,response.origin.initialBillSnapshot)||response.origin.caseId!==payload.caseId||response.origin.month!==payload.month||response.origin.number!==payload.number||response.origin.sourceReference!==payload.sourceReference||response.origin.note!==payload.note||!isDeepStrictEqual(response.origin.manualLines,payload.lines))issue(fail,'SERVICE_BILLING_ACK_INVALID','原生成結果、固定來源或本次輸入不一致。');
  return boundedResponse(response,fail);
}
export function readServiceBillingOrigins(db,ctx,query,hooks){const{fail}=hooks;guardServiceBillingAccess(db,ctx,fail);currentCase(db,ctx,query.caseId,fail);const items=origins(db,ctx,fail).items.filter(({origin})=>origin.caseId===query.caseId&&origin.month===query.month&&(!query.q||[origin.number,origin.sourceReference,origin.note,...origin.manualLines.map(line=>line.sourceReference)].some(value=>value.includes(query.q))));if(!query.spanMode&&items.some(row=>row.origin.sourceSnapshots.some(source=>Object.hasOwn(source,'actualEndDate'))))issue(fail,'SPAN_VIEW_REQUIRED','來源含明確結束日期，請以完整日期模式核對。');return boundedResponse(paginate(items,query),fail);}
export function readServiceBillingOrigin(db,ctx,billId,hooks,query={}){const{fail}=hooks;guardServiceBillingAccess(db,ctx,fail);if(!ref(billId))invalid(fail,'帳單識別格式不符。');const item=origins(db,ctx,fail).items.find(row=>row.origin.billingDocumentId===billId);if(!item)fail(404,'NOT_FOUND','找不到本機構可讀的生成來源。');if(!query.spanMode&&item.origin.sourceSnapshots.some(source=>Object.hasOwn(source,'actualEndDate')))issue(fail,'SPAN_VIEW_REQUIRED','此固定來源含明確結束日期，請使用完整日期模式。');return boundedResponse(item,fail);}
