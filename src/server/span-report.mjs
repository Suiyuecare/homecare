import { entities, scopedRows, fail } from './model.mjs';
import { entitySpan, hasExplicitSpan, readSpanDependencyRows } from './shift-span.mjs';
import { calendarDay } from '../../public/data/shift-span.js';
export const SPAN_REPORT_MODE='calendar-two-day-v1';
/** Scope remains the existing server role owner. Explicit mode also proves every current/head before projection. */
export function spanReportRows(db,ctx,entity,filters,{range=false}={}) {
  const scoped=scopedRows(db,ctx,entity);
  const items=filters.spanMode ? readSpanDependencyRows(db,ctx.orgId,entity,{fields:[...entities[entity].fields.split(' '),...(entity==='service-records'?['billingSnapshot']:[])],required:entities[entity].required,statuses:entities[entity].statuses,fail}).filter(item=>scoped.some(visible=>visible.id===item.id)) : scoped;
  const min=calendarDay(filters.startDate)*1440,max=(calendarDay(filters.endDate)+1)*1440;
  const matches=items.filter(item=>(!filters.caseId||item.caseId===filters.caseId)&&(!filters.employeeId||item.employeeId===filters.employeeId)&&(!filters.status||item.status===filters.status)).filter(item=>{
    if(filters.spanMode&&range&&filters.rangeMode==='intersects'){const s=entitySpan(entity,item,fail);return s.start<max&&s.end>min;}
    return item.date>=filters.startDate&&item.date<=filters.endDate;
  });
  if(!filters.spanMode && matches.some(item=>hasExplicitSpan(entity,item)))fail(409,'SPAN_VIEW_REQUIRED','符合條件的紀錄含明確結束日期，請使用完整日期報表；未省略或裁切。');
  return matches;
}
export function spanReportColumns(columns,key,label,filters){if(!filters.spanMode)return columns;const value=[...columns];const index=value.findIndex(c=>c.key==='date');value.splice(index+1,0,Object.freeze({key,label}));return value;}
