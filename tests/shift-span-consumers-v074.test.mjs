import test from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_SPAN_MODE, shiftReferenceProjection, assertSpanData } from '../public/data/shift-span-editor.js';
import { createServiceBillingEditor, checkServiceBillingSource, checkServiceBillingCollection, checkServiceBillingPreview, checkServiceBillingSaved, checkServiceBillingOriginDetail, serviceBillingSnapshotForDisplay } from '../public/data/service-billing-editor.js';
import { createServicePayrollEditor, checkServicePayrollSource, checkServicePayrollCollection, checkServicePayrollPreview, checkServicePayrollSaved, checkServicePayrollOriginDetail } from '../public/data/service-payroll-editor.js';
import { confirmReport } from '../public/modules/report-view.js';
import { shiftSpanReportConfig, shiftCalendarReportConfig, shiftReportConfig } from '../public/modules/shift-report.js';
import { serviceSpanReportConfig } from '../public/modules/service-report.js';
import { leaveSpanReportConfig } from '../public/modules/leave-report.js';
import { calendarPeriod, spanCalendarFilters, confirmSpanCalendarReport, groupSpanCalendarRows } from '../public/data/shift-calendar.js';
import { confirmLeaveShiftConflicts } from '../public/modules/leave-shift-conflicts.js';
import { createSubstitutionEditor } from '../public/data/shift-substitution-editor.js';
import { assertSubstitutionSnapshot } from '../public/data/shift-substitution-core.js';
import { assertAttendanceShiftSnapshot } from '../public/data/attendance-exception-core.js';
import { assertShiftSeriesRecord, shiftSeriesDraft, shiftSeriesPatch, confirmShiftSeriesSave, confirmShiftSeriesGenerationPreview, confirmShiftSeriesGenerationSave, shiftSeriesAdjustmentDefinition, confirmShiftSeriesMovePreview, confirmShiftSeriesMoveSave } from '../public/data/shift-series-editor.js';
import { confirmReschedulePreview, confirmRescheduleSave } from '../public/modules/shift-series.js';
import { confirmRecurringPreview, confirmRecurringBatch } from '../public/modules/recurring-shifts.js';
const clone = structuredClone, orgId = 'org-a', caseId = 'case-a', employeeId = 'employee-a', month = '2026-10', stamp = '2026-10-01T00:00:00.000Z', spanMode = CALENDAR_SPAN_MODE;
function source(explicit = true, id = 'source-a') { return { id, orgId, version: 3, caseId, employeeId, shiftId: 'shift-a', date: '2026-10-01', actualStart: explicit ? '00:00' : '08:00', actualEnd: explicit ? '23:59' : '09:00', ...(explicit ? { actualEndDate: '2026-10-02' } : {}), billingSnapshot: { capturedAt: stamp, currency: 'TWD', trial: true, source: 'approval', serviceMinutes: explicit ? 2879 : 60, employee: { id: employeeId, name: '保存原名', employeeNo: 'SYN-E', hourlyRateCents: 20001 }, items: [{ serviceItemId: 'item-a', code: 'SYN-I', name: '保存服務', quantity: 3, unitPriceCents: 35001, amountCents: 105003 }] }, createdAt: stamp, updatedAt: stamp }; }
function financial(payroll = false, explicit = true) {
 const sources = [source(explicit)], editor = payroll ? createServicePayrollEditor({ sources, orgId, employeeId, month, spanMode }) : createServiceBillingEditor({ sources, orgId, caseId, month, spanMode });
 const payload = editor.buildPayload({ ...editor.initial, number: 'SYN-NEW', lineAmount0: '120.01', lineReference0: ' 原行\r\n ', sourceReference: ' 原依据\r\n ', note: ' 原文\r\n ' });
 const draft = { ...(payroll ? { employeeId } : { caseId }), month, number: payload.number, lineItems: payroll ? [{ label: payload.lines[0].label, kind: 'earning', amountCents: 12001 }] : [{ label: payload.lines[0].label, quantity: 1, unitPriceCents: 12001 }], sourceReference: payload.sourceReference, status: 'draft', note: payload.note, summary: payroll ? { earningCents: 12001, deductionCents: 0, netCents: 12001 } : { amountCents: 12001 }, ...(payroll ? { employeeSnapshot: { id: employeeId, name: '目前名稱', employeeNo: 'SYN-E' } } : { caseSnapshot: { id: caseId, name: '合成個案', caseNo: 'SYN-C' } }) };
 const mode = payroll ? 'manual-service-payroll-span-v1' : 'manual-service-billing-span-v1';
 const preview = { mode, draft, sources: clone(sources), manualLines: clone(payload.lines), sourceCount: 1, previewHash: 'a'.repeat(64) }, item = { ...clone(draft), id: 'financial-a', orgId, version: 1, createdAt: stamp, updatedAt: stamp };
 const origin = { id: 'origin-a', orgId, version: 1, createdAt: stamp, updatedAt: stamp, ...(payroll ? { payrollStatementId: item.id, employeeId } : { billingDocumentId: item.id, caseId }), month, number: item.number, sourceReference: payload.sourceReference, note: payload.note, sourceSnapshots: clone(sources), manualLines: clone(payload.lines), ...(payroll ? { initialStatementSnapshot: clone(item) } : { initialBillSnapshot: clone(item) }) };
 return { sources, editor, payload, preview, item, origin, saved: { mode, item: clone(item), origin: clone(origin) } };
}
for (const payroll of [false, true]) {
 const checkSource = payroll ? checkServicePayrollSource : checkServiceBillingSource, options = payroll ? { orgId, employeeId, month, spanMode } : { orgId, caseId, month, spanMode };
 test(`${payroll ? 'payroll' : 'billing'} Source13 requires fixed opt-in, exact 2879 minutes and rejects presence masquerades`, () => {
  const s = source(); assert.equal(checkSource(s, options).billingSnapshot.serviceMinutes, 2879); assert.throws(() => checkSource(s, { ...options, spanMode: undefined }));
  for (const value of [null, '', undefined, false, 20261002, '2026-10-03', '2026-10-02\n']) assert.throws(() => checkSource({ ...s, actualEndDate: value }, options));
  const wrong = clone(s); wrong.billingSnapshot.serviceMinutes--; assert.throws(() => checkSource(wrong, options));
  const legacy = source(false); legacy.billingSnapshot.serviceMinutes = 2879; assert.throws(() => checkSource(legacy, options));
 });
 test(`${payroll ? 'payroll' : 'billing'} new preview/save/origin keep trial source and manual cents separately and require exact mode`, () => {
  const f = financial(payroll), previewCheck = payroll ? checkServicePayrollPreview : checkServiceBillingPreview, saveCheck = payroll ? checkServicePayrollSaved : checkServiceBillingSaved, originCheck = payroll ? checkServicePayrollOriginDetail : checkServiceBillingOriginDetail;
  const opts = { orgId, payload: f.payload, sources: f.sources, preview: f.preview };
  assert.equal(f.editor.initial.lineAmount0, ''); assert.equal(f.payload.spanMode, spanMode); assert.equal(f.payload.lines[0].amountCents, 12001); assert.equal(f.payload.note, ' 原文\r\n ');
  previewCheck(f.preview, opts); saveCheck(f.saved, opts); const pair = { origin: f.origin, [payroll ? 'statement' : 'bill']: f.item }; originCheck(pair, { orgId, spanMode });
  assert(!Object.hasOwn(f.origin, 'spanMode')); assert(!Object.hasOwn(f.origin, 'mode')); assert.equal(f.origin.sourceSnapshots[0].billingSnapshot.items[0].amountCents, 105003);
  assert.throws(() => previewCheck({ ...f.preview, mode: payroll ? 'manual-service-payroll-v1' : 'manual-service-billing-v1' }, opts));
  assert.throws(() => saveCheck({ ...f.saved, mode: payroll ? 'manual-service-payroll-v1' : 'manual-service-billing-v1' }, opts));
  assert.throws(() => originCheck(pair, { orgId })); const lost = clone(f.saved); delete lost.origin.sourceSnapshots[0].actualEndDate; assert.throws(() => saveCheck(lost, opts));
 });
 test(`${payroll ? 'payroll' : 'billing'} mode query echo closed; old origin remains byte-exact under new read`, () => {
  const checkCollection = payroll ? checkServicePayrollCollection : checkServiceBillingCollection, filter = payroll ? { employeeId, month, q: '', spanMode } : { caseId, month, q: '', spanMode };
  const response = { query: filter, items: [source()], total: 1, page: 1, pageSize: 25 }; checkCollection(response, options);
  const wrong = clone(response); delete wrong.query.spanMode; assert.throws(() => checkCollection(wrong, options));
  const f = financial(payroll, false), bytes = JSON.stringify(f.origin), check = payroll ? checkServicePayrollOriginDetail : checkServiceBillingOriginDetail;
  check({ origin: f.origin, [payroll ? 'statement' : 'bill']: f.item }, { orgId, spanMode }); assert.equal(JSON.stringify(f.origin), bytes); assert(!Object.hasOwn(f.origin.sourceSnapshots[0], 'actualEndDate'));
 });
 test(`${payroll ? 'payroll' : 'billing'} Source13 getters and array slots rejected with zero calls`, () => {
  let called = 0; const s = source(); Object.defineProperty(s, 'actualEndDate', { enumerable: true, get() { called++; return '2026-10-02'; } }); assert.throws(() => checkSource(s, options));
  const f = financial(payroll), sources = clone(f.sources); Object.defineProperty(sources, '0', { enumerable: true, get() { called++; return f.sources[0]; } });
  assert.throws(() => (payroll ? checkServicePayrollPreview : checkServiceBillingPreview)(f.preview, { orgId, payload: f.payload, sources })); assert.equal(called, 0);
 });
}
test('snapshot minute extension only valid with a complete Source13 context', () => { const s = source(); assert.equal(serviceBillingSnapshotForDisplay(s.billingSnapshot), null); assert.equal(serviceBillingSnapshotForDisplay(s.billingSnapshot, s).serviceMinutes, 2879); });
function shiftRow(extra = {}) { return { shiftId: 'shift-a', version: 3, date: '2026-10-04', endDate: '2026-10-05', caseNo: 'SYN-C', case: '合成案', employeeNo: 'SYN-E', employee: '合成员工', startTime: '23:00', endTime: '01:00', services: 'SYN ×1', status: 'scheduled', statusLabel: '已排班', note: '原\r\n ', ...extra }; }
function report(config, rows, filters) { return { title: config.title, organization: { name: '合成機構' }, filters, selection: config === leaveSpanReportConfig ? { employee: '全部可讀員工', status: '全部狀態' } : { case: '全部可讀個案', employee: '全部可讀人員', status: '全部狀態' }, generatedAt: stamp, columns: clone(config.columns), rows, totals: { count: rows.length, ...(config === serviceSpanReportConfig ? { serviceMinutes: rows.reduce((n,r) => n+r.serviceMinutes,0) } : {}) }, total: rows.length, page: 1, pageSize: rows.length, note: '合成本機完整日期報表' }; }
test('calendar includes prior-day carry and midnight gives no empty next-day segment, unique total unchanged', () => {
 const period = calendarPeriod('week', '2026-10-05'), filters = spanCalendarFilters(period), rows = [shiftRow(), shiftRow({ shiftId: 'shift-b', date: '2026-10-05', endDate: '2026-10-06', startTime: '23:00', endTime: '00:00' })], dto = report(shiftCalendarReportConfig, rows, filters);
 confirmSpanCalendarReport(dto, period); const groups = groupSpanCalendarRows(dto, period); assert.equal(groups[0].rows.length, 2); assert.equal(groups[1].rows.length, 0); assert.match(groups[0].rows[0].displaySegment, /前日開始/); assert.equal(dto.total, 2); assert.equal(dto.rows.length, 2); assert(!Object.hasOwn(dto.rows[0], 'displaySegment'));
 const bad = clone(dto); bad.rows[0].endDate = '2026-10-04'; assert.throws(() => confirmSpanCalendarReport(bad, period));
});
test('report starts vs intersects explicit range, strict full schema, legacy ISO text remains exact', () => {
 const filters = { startDate: '2026-10-05', endDate: '2026-10-11', caseId: '', employeeId: '', status: '', spanMode, rangeMode: 'starts' };
 assert.throws(() => confirmReport(shiftSpanReportConfig, report(shiftSpanReportConfig, [shiftRow()], filters), filters, { complete: true }));
 const row = shiftRow({ date: '2026-10-05', endDate: '2026-10-05', startTime: '2026-10-05T08:00:59+08:00', endTime: '2026-10-05T09:00:01+08:00' }); const dto = report(shiftSpanReportConfig, [row], filters); confirmReport(shiftSpanReportConfig, dto, filters, { complete: true }); assert.equal(dto.rows[0].startTime, row.startTime);
 const bad = clone(dto); bad.filters.spanMode = ''; assert.throws(() => confirmReport(shiftSpanReportConfig, bad, filters, { complete: true }));
 assert.throws(() => confirmReport(shiftReportConfig, dto, filters, { complete: true }));
 let called = 0; Object.defineProperty(dto.rows, '0', { enumerable: true, get() { called++; return row; } }); assert.throws(() => confirmReport(shiftSpanReportConfig, dto, filters, { complete: true })); assert.equal(called,0);
});
test('service and leave full dates validate exact minute totals and preserve all reason text', () => {
 const filters = { startDate: '2026-10-01', endDate: '2026-10-31', caseId: '', employeeId: '', status: '', spanMode };
 const service = { recordId:'s-a',version:3,date:'2026-10-01',actualEndDate:'2026-10-02',caseNo:'',case:'合成',employeeNo:'',employee:'合成',actualStart:'00:00',actualEnd:'23:59',serviceMinutes:2879,services:'合成',status:'approved',statusLabel:'已核准',note:'原\r\n ',reviewNote:' 原核閱 ' };
 const dto = report(serviceSpanReportConfig,[service],filters); confirmReport(serviceSpanReportConfig,dto,filters,{complete:true}); const wrong=clone(dto);wrong.rows[0].serviceMinutes--;assert.throws(()=>confirmReport(serviceSpanReportConfig,wrong,filters,{complete:true}));
 const leaveFilters = {startDate:filters.startDate,endDate:filters.endDate,q:'',employeeId:'',status:'',spanMode}, leave={leaveId:'leave-a',version:2,date:'2026-10-01',endDate:'2026-10-02',employeeId,employeeNo:'',employee:'合成',startTime:'23:00',endTime:'01:00',type:'人工',reason:' 原文\r\n ',status:'pending',statusLabel:'待審核'};
 const leaveDto=report(leaveSpanReportConfig,[leave],leaveFilters);confirmReport(leaveSpanReportConfig,leaveDto,leaveFilters,{complete:true});assert.equal(leaveDto.rows[0].reason,leave.reason); const bad=clone(leaveDto);bad.filters.rangeMode='intersects';assert.throws(()=>confirmReport(leaveSpanReportConfig,bad,leaveFilters,{complete:true}));
});
test('conflict response finds real cross-date overlap and rejects adjoining boundaries, foreign identity and bad presence', () => {
 const employee={id:employeeId,name:'合成',employeeNo:null,status:'active'}, leave={id:'leave-a',version:2,employee,date:'2026-10-02',startTime:'00:00',endTime:'02:00',type:'人工',status:'pending'}, item={shiftId:'shift-a',version:3,date:'2026-10-01',endDate:'2026-10-02',startTime:'23:00',endTime:'01:00',status:'scheduled',employee:clone(employee),case:null,hasServiceRecord:false};
 const dto={leave,generatedAt:stamp,items:[item],total:1,page:1,pageSize:25,note:'合成衝突'};confirmLeaveShiftConflicts(dto,'leave-a',1);
 for(const edit of [d=>d.items[0].endTime='00:00',d=>d.items[0].employee.id='foreign',d=>d.items[0].endDate=null,d=>d.items[0].hidden=true]){const bad=clone(dto);edit(bad);assert.throws(()=>confirmLeaveShiftConflicts(bad,'leave-a',1));}
});
test('7/8 shift snapshot union preserves domain-specific legacy and complete date selectors', () => {
 const item={id:'shift-a',orgId,version:3,employeeId,date:'2026-10-01',startTime:'23:00',endTime:'01:00',endDate:'2026-10-02',status:'scheduled'};const snapshot=shiftReferenceProjection(item);assert.equal(Object.keys(snapshot).length,8);assertSubstitutionSnapshot(snapshot);assertAttendanceShiftSnapshot(snapshot, { shiftId: snapshot.id, shiftVersion: snapshot.version, employeeId: snapshot.employeeId, date: snapshot.date }, orgId);
 const e=createSubstitutionEditor({shifts:[item],orgId});assert.match(e.fields[0].options[0].label,/2026-10-02/);
 const legacy={...snapshot};delete legacy.endDate;assert.throws(()=>assertSubstitutionSnapshot(legacy));assertAttendanceShiftSnapshot(legacy, { shiftId: legacy.id, shiftVersion: legacy.version, employeeId: legacy.employeeId, date: legacy.date }, orgId);
 let called=0;const bad=clone(item);Object.defineProperty(bad,'endDate',{enumerable:true,get(){called++;return '2026-10-02';}});assert.throws(()=>shiftReferenceProjection(bad));assert.equal(called,0);
});
const series={name:'合成永久',caseId,employeeId,carePlanId:'plan-a',startDate:'2026-10-05',endDate:'',intervalWeeks:1,weekdays:[1],startTime:'23:00',endTime:'01:00',endDay:'next',services:[{serviceItemId:'item-a',quantity:1}],status:'active',note:' 原\r\n ',id:'series-a',orgId,version:2,createdAt:stamp,updatedAt:stamp};
const range={version:2,fromDate:'2026-10-05',toDate:'2026-10-05'};
function seriesFixture() { const candidate={caseId,employeeId,carePlanId:'plan-a',date:'2026-10-05',startTime:'23:00',endTime:'01:00',endDate:'2026-10-06',services:clone(series.services),status:'scheduled',note:series.note};const shift={...clone(candidate),id:'shift-a',orgId,version:1,createdAt:stamp,updatedAt:stamp},link={date:candidate.date,shiftId:shift.id,seriesVersion:2,seriesSnapshot:clone(series),shift,createdAt:stamp,editable:true,lockReason:''};return {candidate,shift,link}; }
test('series optional endDay draft/save retains absence vs explicit; generated date is not period endDate',()=>{
 assertShiftSeriesRecord(series,orgId);const data={orgId,cases:[{id:caseId,orgId,status:'active'}],employees:[{id:employeeId,orgId,status:'active'}],'care-plans':[{id:'plan-a',orgId,caseId,status:'active',services:series.services}],'service-items':[{id:'item-a',orgId,status:'active'}]},values={...series};for(const k of ['caseId','id','orgId','version','createdAt','updatedAt'])delete values[k];values.note=series.note.replace(/\r\n/g,'\n');
 const draft=shiftSeriesDraft(values,data,series);assert.deepEqual(shiftSeriesPatch(draft,series),{});confirmShiftSeriesSave({item:{...clone(series),version:3}},draft,orgId,series);assert.throws(()=>shiftSeriesDraft({...values,endDay:'legacy'},data,series));
 const {candidate,link}=seriesFixture(),preview={series:clone(series),range:clone(range),items:[{date:candidate.date,status:'ready',candidate,conflicts:[]}],total:1,readyCount:1,existingCount:0,conflictCount:0,canCommit:true};confirmShiftSeriesGenerationPreview(preview,series,range,orgId);const saved={batchId:'batch-a',series:clone(series),range:clone(range),items:[{date:candidate.date,created:true,occurrence:link}],total:1,createdCount:1,existingCount:0};confirmShiftSeriesGenerationSave(saved,preview,series,range,orgId);const bad=clone(saved);delete bad.items[0].occurrence.shift.endDate;assert.throws(()=>confirmShiftSeriesGenerationSave(bad,preview,series,range,orgId));
});
test('series reschedule preserves each original presence unless explicit same/next; ACK cannot drop or invent ending date',()=>{
 const {shift,link}=seriesFixture(),occurrences={series,range,items:[link],total:1},values={...range,items:[shift.id],action:'reschedule',startTime:'22:00',endTime:'02:00',endDay:'preserve',reason:' 原因\r\n '};delete values.version;
 const definition=shiftSeriesAdjustmentDefinition(values,occurrences,series,orgId);assert(!Object.hasOwn(definition,'endDay'));const after={...shift,startTime:'22:00',endTime:'02:00'};for(const k of ['id','orgId','version','createdAt','updatedAt'])delete after[k];const projectedDefinition={action:'reschedule',items:definition.items,reason:definition.reason,startTime:definition.startTime,endTime:definition.endTime};const preview={definition:projectedDefinition,items:[{id:shift.id,version:shift.version,status:'ready',before:clone(shift),after,conflicts:[]}],total:1,readyCount:1,conflictCount:0,canCommit:true};confirmReschedulePreview(preview,definition,orgId);
 const saved={batchId:'batch-a',action:'reschedule',reason:definition.reason,items:[{...clone(shift),...after,version:2}],total:1};confirmRescheduleSave(saved,preview,definition,orgId);const bad=clone(preview);delete bad.items[0].after.endDate;assert.throws(()=>confirmReschedulePreview(bad,definition,orgId));
 const sameDef=shiftSeriesAdjustmentDefinition({...values,endDay:'same',startTime:'09:00',endTime:'10:00'},occurrences,series,orgId);assert.equal(sameDef.endDay,'same');assert.throws(()=>shiftSeriesAdjustmentDefinition({...values,endDay:'same'},occurrences,series,orgId));
});
test('series move synchronously translates both dates and immutable original slot proof',()=>{
 const {shift}=seriesFixture(),definition={...range,action:'move',items:[{id:shift.id,version:shift.version}],reason:' 原因 ',daysOffset:1},after={...clone(shift),date:'2026-10-06',endDate:'2026-10-07'};for(const k of ['id','orgId','version','createdAt','updatedAt'])delete after[k];const preview={definition:{action:'move',items:definition.items,reason:definition.reason,daysOffset:1},items:[{id:shift.id,version:1,originalDate:'2026-10-05',status:'ready',before:shift,after,conflicts:[]}],total:1,readyCount:1,conflictCount:0,canCommit:true};confirmShiftSeriesMovePreview(preview,definition,orgId);const saved={batchId:'batch-a',action:'move',daysOffset:1,reason:definition.reason,items:[{...shift,...after,version:2}],total:1};confirmShiftSeriesMoveSave(saved,preview,definition,orgId);const bad=clone(saved);bad.items[0].endDate=bad.items[0].date;assert.throws(()=>confirmShiftSeriesMoveSave(bad,preview,definition,orgId));
});
test('finite recurrence uses endDay separately from range; preview and commit confirm every ending date',()=>{
 const {candidate,shift}=seriesFixture(),definition={caseId,employeeId,carePlanId:'plan-a',startDate:'2026-10-05',endDate:'2026-10-05',intervalWeeks:1,weekdays:[1],startTime:'23:00',endTime:'01:00',endDay:'next',services:series.services,note:series.note},preview={definition,items:[{date:candidate.date,startTime:candidate.startTime,endTime:candidate.endTime,endDate:candidate.endDate,status:'ready',conflicts:[]}],total:1,readyCount:1,conflictCount:0,canCommit:true};confirmRecurringPreview(preview,definition);const saved={batchId:'batch-a',items:[shift],total:1};confirmRecurringBatch(saved,preview,definition);const bad=clone(saved);delete bad.items[0].endDate;assert.throws(()=>confirmRecurringBatch(bad,preview,definition));
});
test('shared data guard rejects sparse/symbol/array accessors without calling them',()=>{let called=0;const list=[1];Object.defineProperty(list,'0',{enumerable:true,get(){called++;return 1;}});assert.throws(()=>assertSpanData(list));assert.throws(()=>assertSpanData(new Array(1)));const bad={a:1};bad[Symbol('unknown')]=true;assert.throws(()=>assertSpanData(bad));assert.equal(called,0);});


test('permanent generation closed candidate values do not depend on JSON top-level key insertion order',()=>{
 const {candidate}=seriesFixture(), reordered=Object.fromEntries(Object.entries(candidate).reverse()), preview={series:clone(series),range:clone(range),items:[{date:candidate.date,status:'ready',candidate:reordered,conflicts:[]}],total:1,readyCount:1,existingCount:0,conflictCount:0,canCommit:true};
 assert.equal(confirmShiftSeriesGenerationPreview(preview,series,range,orgId),preview);
 for(const mutate of[v=>delete v.endDate,v=>v.endDate='2026-10-05',v=>v.unknown='hidden',v=>v.endDate=null,v=>v.endDate=undefined]){const b=clone(preview);mutate(b.items[0].candidate);assert.throws(()=>confirmShiftSeriesGenerationPreview(b,series,range,orgId));}
});
