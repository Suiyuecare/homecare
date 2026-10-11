import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { entitySpan } from './shift-span.mjs';
import { accountMembershipActive } from './account-administration.mjs';

export const GROUP_OVERVIEW_MODE = 'authorized-organization-start-date-counts-v1';
export const GROUP_OVERVIEW_NOTICE = '各機構目前保存紀錄的筆數；依開始日歸屬，跨機構同一人會各計一次，不代表去重人數、收入、工時或正式申報。';
export const GROUP_METRICS = Object.freeze(['caseTotal','activeCases','employeeTotal','activeEmployees','startsShifts','completedStartShifts','submittedRecords','approvedMonthRecords']);
const entities = ['cases','employees','shifts','service-records'];
const meta = ['id','orgId','version','createdAt','updatedAt'];
const statuses = { cases:['active','paused','closed'], employees:['active','inactive'], shifts:['scheduled','completed','cancelled'], 'service-records':['draft','submitted','approved','returned'] };
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.trim() && !/[\0\r\n]/.test(value);
const savedDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const date = value => savedDate(value) && !value.startsWith('0000');
const stamp = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = value => typeof value === 'string' && value.length <= 500 && !!value.trim();
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key=>typeof key==='string' && Object.getOwnPropertyDescriptor(value,key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const closed = (value,keys) => plain(value) && Reflect.ownKeys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const dense = (value,max,min=0) => Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype && value.length>=min && value.length<=max && Reflect.ownKeys(value).length===value.length+1 && Array.from({length:value.length},(_,i)=>Object.getOwnPropertyDescriptor(value,String(i))).every(descriptor=>descriptor?.enumerable && Object.hasOwn(descriptor,'value'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprintValid = value => typeof value==='string' && value.length===64 && /^[a-f0-9]{64}$/.test(value);
const broken = fail => fail(409,'GROUP_SOURCE_UNVERIFIABLE','選取機構的完整目前紀錄或保存歷程無法確認，未略過或修改資料。');
const invalid = fail => fail(422,'GROUP_QUERY_INVALID','請明確選取授權機構、有效基準日及單一查詢條件。');
const cap = (value,fail) => { if(Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8')>2*1024*1024)fail(413,'GROUP_OUTPUT_TOO_LARGE','完整營運概覽超過2MiB，請縮小機構選取後重查；不會截斷資料。');return value; };

export function guardGroupOverview(db,ctx,orgIds,fail) {
  const activeAdmin = orgId => db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(orgId,ctx.user.id)?.role==='admin' && accountMembershipActive(db,orgId,ctx.user.id);
  if(ctx?.role!=='admin'||!ref(ctx.orgId)||!ref(ctx.user?.id)||!activeAdmin(ctx.orgId))fail(403,'ROLE_FORBIDDEN','僅目前機構有效管理者可查詢自己已獲管理者授權的機構。');
  if(orgIds){if(!dense(orgIds,10,1)||orgIds.some(id=>!ref(id)))invalid(fail);for(const orgId of orgIds)if(!activeAdmin(orgId))fail(403,'ROLE_FORBIDDEN','有選取機構的管理者授權已失效，請重新選取；不會返回部分機構資料。');}
}
export function groupOverviewQuery(params,fail,detail=false) {
  const allowed = detail?['organizationId','date','metric','fingerprint','page']:['organizationId','date'];
  for(const key of params.keys())if(!allowed.includes(key)||(key!=='organizationId'&&params.getAll(key).length!==1))invalid(fail);
  const orgIds=params.getAll('organizationId'),asOf=params.get('date');
  if(!orgIds.length||orgIds.length>(detail?1:10)||orgIds.some(id=>!ref(id))||new Set(orgIds).size!==orgIds.length||!date(asOf))invalid(fail);
  if(!detail)return {orgIds,date:asOf};
  const metric=params.get('metric'),fingerprint=params.get('fingerprint'),literal=params.get('page')||'1',page=Number(literal);
  if(!GROUP_METRICS.includes(metric)||!fingerprintValid(fingerprint)||!(/^[1-9]\d*$/).test(literal)||!Number.isSafeInteger(page)||page>2000||String(page)!==literal)invalid(fail);
  return {orgIds,date:asOf,metric,fingerprint,page};
}
function readSources(db,orgId,fail) {
  const source={};
  for(const entity of entities) {
    const query=db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY id LIMIT 50001');query.setReadBigInts(true);const rows=query.all(orgId,entity);
    if(rows.length>50000)fail(413,'GROUP_SOURCE_TOO_LARGE','選取機構的完整實體超過50000筆，概覽不會略過後續紀錄。');
    source[entity]=rows.map(row=>{
      if(row.org_id!==orgId||row.entity!==entity||!ref(row.id)||typeof row.version!=='bigint'||row.version<1n||row.version>BigInt(Number.MAX_SAFE_INTEGER)||!stamp(row.created_at)||!stamp(row.updated_at)||row.updated_at<row.created_at)broken(fail);
      let business;try{business=JSON.parse(row.data);}catch{broken(fail);}
      if(!plain(business)||meta.some(key=>Object.hasOwn(business,key))||!statuses[entity].includes(business.status))broken(fail);
      const item={...business,id:row.id,orgId,version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
      const head=db.prepare('SELECT version,snapshot,created_at FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?');head.setReadBigInts(true);const versions=head.all(orgId,entity,item.id,row.version);let snapshot;
      try{snapshot=JSON.parse(versions[0]?.snapshot);}catch{broken(fail);}
      if(versions.length!==1||versions[0].version!==row.version||versions[0].created_at!==item.updatedAt||!isDeepStrictEqual(snapshot,item))broken(fail);
      if(['cases','employees'].includes(entity)){if(!text(item.name)||!text(item[entity==='cases'?'caseNo':'employeeNo']))broken(fail);}
      else{if(!savedDate(item.date)||!ref(item.caseId)||!ref(item.employeeId)||entity==='service-records'&&!ref(item.shiftId))broken(fail);const end=entity==='shifts'?'endDate':'actualEndDate';if(Object.hasOwn(item,end)&&!savedDate(item[end]))broken(fail);try{entitySpan(entity,item);}catch{broken(fail);}}
      return item;
    });
  }
  const cases=new Map(source.cases.map(item=>[item.id,item])),employees=new Map(source.employees.map(item=>[item.id,item])),shifts=new Map(source.shifts.map(item=>[item.id,item]));
  for(const item of source.shifts)if(!cases.has(item.caseId)||!employees.has(item.employeeId))broken(fail);
  for(const item of source['service-records']){const parent=shifts.get(item.shiftId);if(!cases.has(item.caseId)||!employees.has(item.employeeId)||!parent||parent.caseId!==item.caseId||parent.employeeId!==item.employeeId||parent.date!==item.date)broken(fail);}
  return source;
}
function selected(source,metric,asOf) {
  if(metric==='caseTotal')return source.cases;
  if(metric==='activeCases')return source.cases.filter(item=>item.status==='active');
  if(metric==='employeeTotal')return source.employees;
  if(metric==='activeEmployees')return source.employees.filter(item=>item.status==='active');
  if(metric==='startsShifts')return source.shifts.filter(item=>item.date===asOf&&item.status!=='cancelled');
  if(metric==='completedStartShifts')return source.shifts.filter(item=>item.date===asOf&&item.status==='completed');
  if(metric==='submittedRecords')return source['service-records'].filter(item=>item.status==='submitted');
  return source['service-records'].filter(item=>item.date.startsWith(asOf.slice(0,7))&&item.status==='approved');
}
const days = asOf => Array.from({length:7},(_,index)=>new Date(Date.parse(asOf+'T00:00:00Z')-(6-index)*86400000).toISOString().slice(0,10));
function readOrganization(db,ctx,orgId,asOf,fail) {
  const org=db.prepare('SELECT id,name FROM organizations WHERE id=?').get(orgId);if(!org||org.id!==orgId||!text(org.name))broken(fail);
  const source=readSources(db,orgId,fail),fingerprint=digest({organization:org,source}),counts=Object.fromEntries(GROUP_METRICS.map(metric=>[metric,selected(source,metric,asOf).length]));
  const trend=days(asOf).map(day=>({date:day,startsShifts:selected(source,'startsShifts',day).length,completedStartShifts:selected(source,'completedStartShifts',day).length,approvedRecords:source['service-records'].filter(item=>item.date===day&&item.status==='approved').length}));
  return {source,item:{id:org.id,name:org.name,counts,trend,fingerprint}};
}
function readSnapshot(db,fn) {
  db.exec('SAVEPOINT group_overview_read');
  try{const result=fn();db.exec('RELEASE group_overview_read');return result;}
  catch(error){db.exec('ROLLBACK TO group_overview_read');db.exec('RELEASE group_overview_read');throw error;}
}
export function readGroupOverview(db,ctx,query,fail) {
  guardGroupOverview(db,ctx,null,fail);
  if(!closed(query,['orgIds','date'])||!dense(query.orgIds,10,1)||query.orgIds.some(id=>!ref(id))||!date(query.date))invalid(fail);
  const normalized=groupOverviewQuery(new URLSearchParams([...query.orgIds.map(id=>['organizationId',id]),['date',query.date]]),fail);
  return readSnapshot(db,()=>{
    guardGroupOverview(db,ctx,normalized.orgIds,fail);
    const organizations=normalized.orgIds.map(id=>readOrganization(db,ctx,id,query.date,fail).item),totals=Object.fromEntries(GROUP_METRICS.map(metric=>[metric,organizations.reduce((sum,item)=>sum+item.counts[metric],0)]));
    return cap({mode:GROUP_OVERVIEW_MODE,date:query.date,organizations,totals,notice:GROUP_OVERVIEW_NOTICE,capturedAt:new Date().toISOString()},fail);
  });
}
export function readGroupOverviewRecords(db,ctx,query,fail) {
  guardGroupOverview(db,ctx,null,fail);
  if(!closed(query,['orgIds','date','metric','fingerprint','page'])||!dense(query.orgIds,1,1)||query.orgIds.some(id=>!ref(id))||!date(query.date)||!GROUP_METRICS.includes(query.metric)||typeof query.fingerprint!=='string'||typeof query.page!=='number')invalid(fail);
  const normalized=groupOverviewQuery(new URLSearchParams([...query.orgIds.map(id=>['organizationId',id]),['date',query.date],['metric',query.metric],['fingerprint',query.fingerprint],['page',String(query.page)]]),fail,true);
  return readSnapshot(db,()=>{
    guardGroupOverview(db,ctx,normalized.orgIds,fail);const {source,item}=readOrganization(db,ctx,normalized.orgIds[0],normalized.date,fail);
    if(item.fingerprint!==normalized.fingerprint)fail(409,'GROUP_SOURCE_CHANGED','機構來源已變更，請重新取得概覽後再查明細。');
    const person=['caseTotal','activeCases','employeeTotal','activeEmployees'].includes(normalized.metric),employee=['employeeTotal','activeEmployees'].includes(normalized.metric),rows=selected(source,normalized.metric,normalized.date),items=rows.slice((normalized.page-1)*25,normalized.page*25).map(record=>({id:record.id,orgId:record.orgId,version:record.version,name:person?record.name:'',number:person?record[employee?'employeeNo':'caseNo']:'',date:record.date||'',status:record.status}));
    return cap({mode:GROUP_OVERVIEW_MODE,date:normalized.date,organization:{id:item.id,name:item.name},metric:normalized.metric,fingerprint:item.fingerprint,page:normalized.page,pageSize:25,total:rows.length,items},fail);
  });
}
export function assertGroupOverview(output,fail) {
  if(!closed(output,['mode','date','organizations','totals','notice','capturedAt'])||output.mode!==GROUP_OVERVIEW_MODE||output.notice!==GROUP_OVERVIEW_NOTICE||!date(output.date)||!stamp(output.capturedAt)||!dense(output.organizations,10,1)||!closed(output.totals,GROUP_METRICS))broken(fail);
  const count=(n,max=50000)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
  for(const item of output.organizations){
    if(!closed(item,['id','name','counts','trend','fingerprint'])||!ref(item.id)||!text(item.name)||!closed(item.counts,GROUP_METRICS)||!GROUP_METRICS.every(key=>count(item.counts[key]))||!fingerprintValid(item.fingerprint)||!dense(item.trend,7,7))broken(fail);
    if(item.counts.activeCases>item.counts.caseTotal||item.counts.activeEmployees>item.counts.employeeTotal||item.counts.completedStartShifts>item.counts.startsShifts)broken(fail);
    const expected=days(output.date);
    for(const [i,point] of item.trend.entries())if(!closed(point,['date','startsShifts','completedStartShifts','approvedRecords'])||point.date!==expected[i]||!count(point.startsShifts)||!count(point.completedStartShifts)||point.completedStartShifts>point.startsShifts||!count(point.approvedRecords))broken(fail);
    const tail=item.trend[6];if(tail.startsShifts!==item.counts.startsShifts||tail.completedStartShifts!==item.counts.completedStartShifts)broken(fail);
  }
  if(new Set(output.organizations.map(item=>item.id)).size!==output.organizations.length||!GROUP_METRICS.every(key=>count(output.totals[key],500000)&&output.totals[key]===output.organizations.reduce((sum,item)=>sum+item.counts[key],0)))broken(fail);
  return output;
}
export function groupOverviewCsv(output,fail) {
  assertGroupOverview(output,fail);
  const cell=value=>{let literal=String(value);if(/^[\s\u0000-\u001f]*[=+\-@]/.test(literal)||/^[\t\r\n]/.test(literal))literal="'"+literal;return '"'+literal.replaceAll('"','""')+'"';};
  const columns=['列種類','目前機構識別','目前機構名稱或說明','基準日','個案紀錄筆數','使用中個案紀錄','員工紀錄筆數','使用中員工紀錄','當日開始非取消班次','其中已完成班次','目前待核閱紀錄','基準月已核閱紀錄','完整來源fingerprint','趨勢開始日','趨勢非取消班次','趨勢已完成班次','趨勢已核閱紀錄','統計模式','取得時間'];
  const suffix=[output.mode,output.capturedAt],rows=[['notice','',output.notice,output.date,...Array(13).fill(''),...suffix],['total','','選取機構紀錄合計',output.date,...GROUP_METRICS.map(key=>output.totals[key]),...Array(5).fill(''),...suffix]];
  for(const item of output.organizations){rows.push(['summary',item.id,item.name,output.date,...GROUP_METRICS.map(key=>item.counts[key]),item.fingerprint,...Array(4).fill(''),...suffix]);for(const point of item.trend)rows.push(['trend',item.id,item.name,output.date,...Array(8).fill(''),item.fingerprint,point.date,point.startsShifts,point.completedStartShifts,point.approvedRecords,...suffix]);}
  return cap('\uFEFF'+[columns,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n',fail);
}
