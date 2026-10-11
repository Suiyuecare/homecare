import { entitySpan, hasExplicitSpan, assertEntityCapturedMinutes } from './shift-span.mjs';
import { fail,scopedRows,rows,get,timeMinute } from './model.mjs';
import { serializeEmployeeRegions } from '../../public/data/employee-regions.js';
export function report(db,ctx,kind,month,{spanMode}={}){
 if(spanMode!==undefined&&(spanMode!=='calendar-two-day-v1'||kind==='cases'))fail(422,'INVALID_QUERY','此試算不支援完整日期模式');
 if(!['cases','shifts','services','fees','payroll'].includes(kind))fail(404,'REPORT_NOT_FOUND','尚未支援此報表');
 if(['fees','payroll'].includes(kind)&&!['admin','finance'].includes(ctx.role))fail(403,'ROLE_FORBIDDEN','費用與薪資報表僅管理者或財務可讀取');
 if(month&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail(422,'INVALID_MONTH','month須為YYYY-MM');
 const inMonth=x=>!month||(typeof x.date==='string'&&x.date.startsWith(month));
 const name=(e,v)=>get(db,ctx.orgId,e,v)?.name||'未找到';
 let columns=[],data=[],title='',totals={};
 const c=(key,label)=>({key,label});
 const spanRows=(entity)=>{const matching=scopedRows(db,ctx,entity).filter(inMonth);if(!spanMode&&matching.some(item=>hasExplicitSpan(entity,item)))fail(409,'SPAN_VIEW_REQUIRED','此報表包含明確結束日期；請使用完整日期模式核對，不會省略服務。');return matching;};
 if(kind==='cases'){
  title='個案總表';columns=[c('caseNo','案號'),c('name','姓名'),c('status','狀態'),c('supervisor','主責督導')];data=scopedRows(db,ctx,'cases').map(x=>({caseNo:x.caseNo,name:x.name,status:x.status,supervisor:x.supervisorId?name('employees',x.supervisorId):''}));
 }else if(kind==='shifts'){
  title='班表';columns=[c('date','日期'),c('case','個案'),c('employee','員工'),c('startTime','開始'),c('endTime','結束'),c('status','狀態')];if(spanMode)columns.splice(1,0,c('endDate','結束日期'));data=spanRows('shifts').map(x=>({date:x.date,...(spanMode?{endDate:Object.hasOwn(x,'endDate')?x.endDate:x.date}:{}),case:name('cases',x.caseId),employee:name('employees',x.employeeId),startTime:x.startTime,endTime:x.endTime,status:x.status}));
 }else if(kind==='services'){
  title='服務紀錄總表';columns=[c('date','日期'),c('case','個案'),c('employee','員工'),c('actualStart','實際開始'),c('actualEnd','實際結束'),c('status','狀態')];if(spanMode)columns.splice(1,0,c('actualEndDate','實際結束日期'));data=spanRows('service-records').map(x=>({date:x.date,...(spanMode?{actualEndDate:Object.hasOwn(x,'actualEndDate')?x.actualEndDate:x.date}:{}),case:name('cases',x.caseId),employee:name('employees',x.employeeId),actualStart:x.actualStart,actualEnd:x.actualEnd,status:x.status}));
 }else{
  const records=rows(db,ctx.orgId,'service-records').filter(x=>x.status==='approved'&&inMonth(x));if(!spanMode&&records.some(item=>hasExplicitSpan('service-records',item)))fail(409,'SPAN_VIEW_REQUIRED','試算含明確結束日來源；請以完整日期模式核對。');for(const record of records)if(hasExplicitSpan('service-records',record))assertEntityCapturedMinutes('service-records',record,record.billingSnapshot?.serviceMinutes,fail);if(records.some(r=>!r.billingSnapshot))fail(409,'BILLING_SNAPSHOT_REQUIRED','舊核閱紀錄缺少計價快照，需確認歷史費率後另行建立，不以現價重算');
  if(kind==='fees'){
   title='費用試算（未核定規則）';columns=[c('date','日期'),c('case','個案'),c('serviceCode','測試服務代碼'),c('service','服務項目'),c('quantity','數量'),c('unitPriceCents','單價（分）'),c('amountCents','試算金額（分）')];
   if(spanMode)columns.splice(1,0,c('actualEndDate','來源實際結束日期'));
   data=records.flatMap(r=>r.billingSnapshot.items.map(s=>({date:r.date,...(spanMode?{actualEndDate:Object.hasOwn(r,'actualEndDate')?r.actualEndDate:r.date}:{}),case:name('cases',r.caseId),serviceCode:s.code,service:s.name,quantity:s.quantity,unitPriceCents:s.unitPriceCents,amountCents:s.amountCents})));
   totals={amountCents:data.reduce((n,r)=>n+r.amountCents,0)};
  }else{
   title='薪資試算（未核定規則）';columns=[c('employeeNo','員工編號'),c('employee','員工'),c('minutes','核閱服務分鐘'),c('hourlyRateCents','時薪（分）'),c('amountCents','試算金額（分）')];const grouped=new Map();
   for(const r of records){const emp=r.billingSnapshot.employee;const key=r.employeeId+':'+emp.hourlyRateCents;const item=grouped.get(key)||{employeeNo:emp.employeeNo,employee:emp.name,minutes:0,hourlyRateCents:emp.hourlyRateCents,amountCents:0};item.minutes+=r.billingSnapshot.serviceMinutes;grouped.set(key,item);}
   data=[...grouped.values()].map(x=>({...x,amountCents:Math.round(x.minutes*x.hourlyRateCents/60)}));totals={amountCents:data.reduce((n,r)=>n+r.amountCents,0),minutes:data.reduce((n,r)=>n+r.minutes,0)};
  }
 }
 return{title,columns,rows:data,...(spanMode?{spanMode}:{}),totals:{count:data.length,...totals},note:['fees','payroll'].includes(kind)?'試算、未核定規則。僅計入已核閱服務，以核閱時保存的價格及時薪快照計算；未處理補助、自付額、加班、稅費或正式薪資/核銷規則，不可作正式申報。示範資料與價格均為合成測試值。':'本機測試報表；未連接政府申報系統。'};
}
export function csvCell(value){let s=value===null||value===undefined?'':String(value);if(/^[\s\u0000-\u001f]*[=+\-@]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function toCsv(r){return '\uFEFF'+[r.columns.map(x=>csvCell(x.label)).join(','),...r.rows.map(row=>r.columns.map(x=>csvCell(x.type==='employee-regions'?serializeEmployeeRegions(row[x.key]):row[x.key])).join(',')),csvCell(r.note)].join('\r\n')+'\r\n';}
