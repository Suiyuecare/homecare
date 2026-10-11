import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const FINANCIAL_OUTPUT_NOTE='本機保存人工紀錄；不代表正式憑證、申報或付款。';
export const financialOutputKinds=Object.freeze({billing:Object.freeze({entity:'billing-documents',title:'人工帳單保存明細'}),payroll:Object.freeze({entity:'payroll-statements',title:'人工薪資結算保存明細'})});
const meta=['id','orgId','version','createdAt','updatedAt'];
const billingFields=['caseId','month','number','lineItems','sourceReference','status','note','summary','caseSnapshot'];
const payrollFields=['employeeId','month','number','lineItems','sourceReference','status','note','summary','employeeSnapshot'];
const own=(value,key)=>Object.getOwnPropertyDescriptor(value,key);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&own(value,key)?.enumerable&&Object.hasOwn(own(value,key),'value'));
const closed=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const dense=(value,min,max)=>Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype&&value.length>=min&&value.length<=max&&Reflect.ownKeys(value).length===value.length+1&&Array.from({length:value.length},(_,i)=>String(i)).every(key=>own(value,key)?.enumerable&&Object.hasOwn(own(value,key),'value'));
const text=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||!!value.trim());
const ref=value=>text(value,500,true)&&value===value.trim()&&!/[\r\n]/.test(value);
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const month=value=>typeof value==='string'&&value.length===7&&/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const iso=value=>typeof value==='string'&&value.length===24&&/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const broken=(fail,message)=>fail(409,'FINANCIAL_OUTPUT_UNVERIFIABLE',message);
const invalid=(fail,message)=>fail(422,'INVALID_FINANCIAL_OUTPUT_QUERY',message);
function cap(value,fail,csv=false){const bytes=Buffer.byteLength(csv?value:JSON.stringify(value),'utf8');if(bytes>2*1024*1024)fail(413,'FINANCIAL_OUTPUT_TOO_LARGE',csv?'完整CSV超過2MiB，請使用保存明細列印；不會省略欄位。':'完整保存明細超過2MiB，無法安全輸出；不會省略內容。');return value;}
const kindProfile=(kind,fail)=>{if(typeof kind!=='string'||!Object.hasOwn(financialOutputKinds,kind))fail(404,'NOT_FOUND','找不到可用的保存財務輸出。');return financialOutputKinds[kind];};

/** Must precede method/query and output generation, including fresh native print. */
export function guardFinancialOutputAccess(db,ctx,fail){
 if(!['admin','finance'].includes(ctx?.role))fail(403,'ROLE_FORBIDDEN','僅目前機構管理者或財務可輸出保存帳單及人工薪資明細。');
 if(!ref(ctx.orgId)||!ref(ctx.user?.id)||db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(ctx.orgId,ctx.user.id)?.role!==ctx.role)fail(403,'ROLE_FORBIDDEN','目前機構成員授權已失效。');
}
export function financialOutputQuery(params,fail){
 if(!params||typeof params.keys!=='function')invalid(fail,'輸出查詢格式無法確認。');
 for(const key of params.keys())if(key!=='version'||params.getAll(key).length!==1)invalid(fail,'輸出只接受單一保存版次。');
 const literal=params.get('version');if(typeof literal!=='string'||!literal.length||/[\r\n]/.test(literal)||!/^[1-9]\d*$/.test(literal)||!integer(Number(literal),1)||String(Number(literal))!==literal)invalid(fail,'請提供canonical安全正整數保存版次。');return{version:Number(literal)};
}
/** Closed current records retain documentary text; totals are validated, never repaired. */
export function assertFinancialOutputRecord(kind,record,expected,fail){
 kindProfile(kind,fail);const fields=kind==='billing'?billingFields:payrollFields;
 if(!closed(record,[...fields,...meta])||!ref(record.id)||!ref(record.orgId)||!integer(record.version,1)||!iso(record.createdAt)||!iso(record.updatedAt)||record.updatedAt<record.createdAt||!month(record.month)||!text(record.number,100,true)||!text(record.note,10000)||!dense(record.lineItems,1,100))broken(fail,'保存明細身份、版次或完整欄位無法確認。');
 if(expected&&(!plain(expected)||expected.orgId!==record.orgId||expected.id!==record.id||expected.version!==record.version))broken(fail,'保存明細與已核對機構、識別或版次不一致。');
 if(kind==='billing'){
  if(!ref(record.caseId)||record.caseId.length>100||/[\r\n]/.test(record.number)||!text(record.sourceReference,2000)||!['draft','issued','voided'].includes(record.status)||!closed(record.caseSnapshot,['id','name','caseNo'])||record.caseSnapshot.id!==record.caseId||!text(record.caseSnapshot.name,500)||!text(record.caseSnapshot.caseNo,500)||!closed(record.summary,['amountCents'])||!integer(record.summary.amountCents))broken(fail,'帳單保存快照、狀態或總額無法確認。');
  let total=0n;for(const line of record.lineItems){if(!closed(line,['label','quantity','unitPriceCents'])||!text(line.label,300,true)||/[\r\n]/.test(line.label)||!integer(line.quantity,1,10000)||!integer(line.unitPriceCents,0,1000000000))broken(fail,'帳單明細格式無法確認。');total+=BigInt(line.quantity)*BigInt(line.unitPriceCents);}
  if(total>BigInt(Number.MAX_SAFE_INTEGER)||total!==BigInt(record.summary.amountCents))broken(fail,'帳單明細與保存總額不一致，輸出不會重新計價或修補。');
 }else{
  if(!ref(record.employeeId)||!text(record.sourceReference,500)||!['draft','reviewed','closed','voided'].includes(record.status)||!closed(record.employeeSnapshot,['id','name','employeeNo'])||record.employeeSnapshot.id!==record.employeeId||!text(record.employeeSnapshot.name,500)||!text(record.employeeSnapshot.employeeNo,500)||!closed(record.summary,['earningCents','deductionCents','netCents'])||Object.values(record.summary).some(value=>!integer(value)))broken(fail,'薪資保存快照、狀態或合計無法確認。');
  let earning=0n,deduction=0n;for(const line of record.lineItems){if(!closed(line,['label','kind','amountCents'])||!text(line.label,100,true)||!['earning','deduction'].includes(line.kind)||!integer(line.amountCents,0,1000000000))broken(fail,'薪資明細格式無法確認。');if(line.kind==='earning')earning+=BigInt(line.amountCents);else deduction+=BigInt(line.amountCents);}
  if(earning>BigInt(Number.MAX_SAFE_INTEGER)||deduction>earning||earning!==BigInt(record.summary.earningCents)||deduction!==BigInt(record.summary.deductionCents)||earning-deduction!==BigInt(record.summary.netCents))broken(fail,'薪資明細與保存合計不一致，輸出不會重算或修補。');
 }
 return record;
}
export function assertFinancialOutput(output,expected,fail){
 if(!closed(output,['kind','title','organization','record','note']))broken(fail,'保存明細輸出回應不完整。');const profile=kindProfile(output.kind,fail);
 if(output.title!==profile.title||output.note!==FINANCIAL_OUTPUT_NOTE||!closed(output.organization,['id','name'])||!ref(output.organization.id)||!text(output.organization.name,500,true))broken(fail,'保存明細輸出說明或目前機構無法確認。');
 if(expected&&(!plain(expected)||expected.kind!==output.kind||expected.orgId!==output.organization.id))broken(fail,'保存明細輸出與已核對操作不一致。');
 assertFinancialOutputRecord(output.kind,output.record,expected?{orgId:expected.orgId,id:expected.id,version:expected.version}:null,fail);if(output.organization.id!==output.record.orgId)broken(fail,'輸出機構及保存機構不一致。');return cap(output,fail);
}
function rows(db,sql,args){const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...args);}
function exactSqlRef(bytes,expected,fail){let literal;try{if(!(bytes instanceof Uint8Array))throw new TypeError('SQL ref bytes missing');literal=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{broken(fail,'保存SQL識別的完整UTF8位元組無法確認。');}if(literal!==expected)broken(fail,'保存SQL完整識別與本次綁定不一致。');return literal;}
function head(db,org,entity,id,fail){
 const found=rows(db,'SELECT *, CAST(id AS BLOB) AS exact_id_bytes FROM records WHERE org_id=? AND entity=? AND id=?',[org,entity,id]);if(!found.length)return null;const row=found[0];if(found.length!==1||row.org_id!==org||row.entity!==entity||typeof row.version!=='bigint'||row.version<1n||row.version>BigInt(Number.MAX_SAFE_INTEGER)||!iso(row.created_at)||!iso(row.updated_at)||row.updated_at<row.created_at)broken(fail,'保存SQL身份或安全版次無法確認。');const exactId=exactSqlRef(row.exact_id_bytes,id,fail);
 let data;try{data=JSON.parse(row.data);}catch{broken(fail,'保存JSON無法確認。');}if(!plain(data)||meta.some(key=>Object.hasOwn(data,key)))broken(fail,'保存業務欄位與SQL身份無法確認。');const record={...data,id:exactId,orgId:row.org_id,version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
 const versions=rows(db,'SELECT *, CAST(record_id AS BLOB) AS exact_id_bytes FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?',[org,entity,id,record.version]);if(versions.length!==1||versions[0].version!==row.version||!iso(versions[0].created_at)||versions[0].created_at!==record.updatedAt)broken(fail,'目前不可改寫保存版本缺失或無法確認。');exactSqlRef(versions[0].exact_id_bytes,id,fail);let snapshot;try{snapshot=JSON.parse(versions[0].snapshot);}catch{broken(fail,'不可改寫保存版本無法確認。');}if(!isDeepStrictEqual(snapshot,record))broken(fail,'目前保存內容與不可改寫版本不一致。');return record;
}
/** No pricing, snapshots, receipts or payroll trial engine is queried. */
export function readFinancialOutput(db,ctx,kind,id,query,hooks){
 const {fail,get,billingDocumentVisible,payrollStatementVisible}=hooks;guardFinancialOutputAccess(db,ctx,fail);const profile=kindProfile(kind,fail);if(!ref(id)||!closed(query,['version'])||!integer(query.version,1))invalid(fail,'輸出識別或保存版次不合法。');
 const record=head(db,ctx.orgId,profile.entity,id,fail);if(!record)fail(404,'NOT_FOUND','找不到本機構可讀的保存單據。');if(record.version!==query.version)fail(409,'VERSION_CONFLICT','保存單據版次已變更，請重新讀取並核對後輸出。');assertFinancialOutputRecord(kind,record,{orgId:ctx.orgId,id,version:query.version},fail);
 const parentEntity=kind==='billing'?'cases':'employees',parentId=kind==='billing'?record.caseId:record.employeeId,parent=head(db,ctx.orgId,parentEntity,parentId,fail);if(!parent)fail(404,'NOT_FOUND','找不到目前可讀的同機構父個案或員工。');
 const visible=kind==='billing'?billingDocumentVisible:payrollStatementVisible;if(typeof get!=='function'||typeof visible!=='function')broken(fail,'保存單據原權限接口不完整。');if(!visible(db,ctx,profile.entity,record,get))fail(404,'NOT_FOUND','找不到目前可讀的保存單據。');
 const organization=db.prepare('SELECT id,name FROM organizations WHERE id=?').get(ctx.orgId);if(!organization||organization.id!==ctx.orgId||!text(organization.name,500,true))broken(fail,'目前授權機構名稱無法確認。');return assertFinancialOutput({kind,title:profile.title,organization:{id:organization.id,name:organization.name},record,note:FINANCIAL_OUTPUT_NOTE},{kind,orgId:ctx.orgId,id,version:query.version},fail);
}
/** CSV representation escapes formulas; saved and printable JSON remains exact. */
export function financialOutputCsvCell(value){
 if(typeof value!=='string')throw new TypeError('CSV requires an already typed string.');let literal=value;if(/^[\s\u0000-\u001f]*[=+\-@]/.test(literal)||/^[\t\r\n]/.test(literal))literal="'"+literal;return'"'+literal.replaceAll('"','""')+'"';
}
export function financialOutputCsv(output,fail){
 assertFinancialOutput(output,null,fail);const record=output.record,columns=output.kind==='billing'?['保存識別','機構識別','保存版次','狀態','月份','編號','個案識別','建立時案號','建立時個案姓名','明細序號','人工明細名稱','保存數量','保存單價（分）','文件保存總額（分）','人工依據','備註','建立時間','保存時間']:['保存識別','機構識別','保存版次','狀態','月份','編號','員工識別','建立時員編','建立時員工姓名','明細序號','人工明細名稱','加項／減項','保存明細金額（分）','保存加項合計（分）','保存減項合計（分）','保存淨額（分）','人工依據','備註','建立時間','保存時間'];
 const prefix=[record.id,record.orgId,String(record.version),record.status,record.month,record.number],data=record.lineItems.map((line,i)=>output.kind==='billing'?[...prefix,record.caseId,record.caseSnapshot.caseNo,record.caseSnapshot.name,String(i+1),line.label,String(line.quantity),String(line.unitPriceCents),String(record.summary.amountCents),record.sourceReference,record.note,record.createdAt,record.updatedAt]:[...prefix,record.employeeId,record.employeeSnapshot.employeeNo,record.employeeSnapshot.name,String(i+1),line.label,line.kind,String(line.amountCents),String(record.summary.earningCents),String(record.summary.deductionCents),String(record.summary.netCents),record.sourceReference,record.note,record.createdAt,record.updatedAt]);
 const body=cap('\uFEFF'+[columns,...data].map(row=>row.map(financialOutputCsvCell).join(',')).join('\r\n')+'\r\n',fail,true),digest=createHash('sha256').update(record.id).digest('hex').slice(0,20),filename='financial-'+output.kind+'-'+digest+'-v'+record.version+'.csv';return{body,filename,contentType:'text/csv; charset=utf-8',contentDisposition:'attachment; filename="'+filename+'"'};
}
