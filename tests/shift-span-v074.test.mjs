import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftSpan, serviceSpan, leaveSpan, spansOverlap, visibleSpanSegments,
  spanWithinValidity, moveShiftSpan, recurringShiftSpan,
  referenceSnapshotKind, explicitReferenceSpan, assertCapturedServiceMinutes,
} from '../public/data/shift-span.js';
import { assertSubstitutionSnapshot } from '../public/data/shift-substitution-core.js';
import { assertAttendanceShiftSnapshot } from '../public/data/attendance-exception-core.js';

const night = () => shiftSpan({date:'2026-12-31',startTime:'23:30',endDate:'2027-01-01',endTime:'01:00'});
const snapshot = () => ({id:'synthetic-shift',orgId:'synthetic-org',version:2,employeeId:'synthetic-employee',date:'2026-12-31',startTime:'23:30',endTime:'01:00',endDate:'2027-01-01'});

test('actual service span is explicit, separate from schedule and never inferred from clock ordering', () => {
  const source={date:'2026-12-31',actualStart:'23:45',actualEnd:'01:15',actualEndDate:'2027-01-01'}, before=JSON.stringify(source), span=serviceSpan(source);
  assert.equal(span.durationMinutes,90); assert.deepEqual(span.segments.map(x=>x.minutes),[15,75]); assert.equal(JSON.stringify(source),before);
  assert.throws(()=>serviceSpan({date:source.date,actualStart:'23:45',actualEnd:'01:15'}),{code:'SPAN_TIME_RANGE'});
  for(const value of ['',null,undefined,'2027-01-02']) assert.throws(()=>serviceSpan({...source,actualEndDate:value}));
  assert.throws(()=>serviceSpan({...source,endDate:source.actualEndDate}),{code:'SPAN_SHAPE_INVALID'});
});
test('actual legacy ISO seconds and different offsets remain literal minute semantics and absence remains absence', () => {
  const source={date:'0000-02-29',actualStart:'0000-02-29T09:00:59+08:00',actualEnd:'0000-02-29T10:00:01-04:00'}, before=JSON.stringify(source), span=serviceSpan(source);
  assert.equal(span.durationMinutes,60); assert.equal(span.hasEndDate,false); assert.equal(JSON.stringify(source),before); assert.equal(Object.hasOwn(source,'actualEndDate'),false);
  assert.throws(()=>serviceSpan({...source,actualEndDate:source.date}),{code:'SPAN_TIME_INVALID'});
  assert.equal(assertCapturedServiceMinutes(60,span),60);
});
test('both-day leave/shift conflicts include prior-day night and exact endpoints remain nonconflicting', () => {
  const span=night(), nextMorning=shiftSpan({date:'2027-01-01',startTime:'00:30',endTime:'01:30'}), touching=shiftSpan({date:'2027-01-01',startTime:'01:00',endTime:'02:00'});
  const leave=leaveSpan({date:'2027-01-01',startTime:'00:00',endTime:'00:45'});
  assert.equal(spansOverlap(span,nextMorning),true); assert.equal(spansOverlap(span,leave),true); assert.equal(spansOverlap(span,touching),false);
  assert.equal(spansOverlap(leave,shiftSpan({date:'2026-12-31',startTime:'22:00',endTime:'23:00'})),false);
});
test('occupied-day calendar projection retains only requested day and does not mutate source span or source identity', () => {
  const span=night(); const day1=visibleSpanSegments(span,{startDate:'2026-12-31',endDate:'2026-12-31'}), day2=visibleSpanSegments(span,{startDate:'2027-01-01',endDate:'2027-01-01'}), both=visibleSpanSegments(span,{startDate:'2026-12-31',endDate:'2027-01-01'});
  assert.deepEqual(day1.map(x=>x.minutes),[30]); assert.deepEqual(day2.map(x=>x.minutes),[60]); assert.equal(both.length,2); assert.equal(span.segments.length,2);
  assert.ok(Object.isFrozen(day1)&&Object.isFrozen(day1[0])); assert.equal(new Set(both.map(()=> 'one-synthetic-shift-id')).size,1);
  assert.equal(visibleSpanSegments(span,{startDate:'2027-01-02',endDate:'2027-01-02'}).length,0);
  assert.throws(()=>visibleSpanSegments(span,{startDate:'2027-01-02',endDate:'2027-01-01'}));
});
test('plan/item validity covers both positive-minute days; midnight is a half-open technical boundary', () => {
  const span=night(); assert.equal(spanWithinValidity(span,{validTo:'2026-12-31'}),false); assert.equal(spanWithinValidity(span,{validFrom:'2026-12-31',validTo:'2027-01-01'}),true); assert.equal(spanWithinValidity(span,{}),true);
  const midnight=shiftSpan({date:'2026-12-31',startTime:'23:00',endDate:'2027-01-01',endTime:'00:00'}); assert.equal(spanWithinValidity(midnight,{validTo:'2026-12-31'}),true);
  for(const value of ['',null,undefined]) assert.throws(()=>spanWithinValidity(span,{validTo:value}));
});
test('only locally minted immutable span results may feed overlap/coverage, and forged accessors never run', () => {
  let invoked=0; const fake={}; Object.defineProperty(fake,'start',{get(){invoked++; return 1;}});
  assert.throws(()=>spansOverlap(fake,night()),{code:'SPAN_RESULT_INVALID'}); assert.throws(()=>spanWithinValidity(fake,{}),{code:'SPAN_RESULT_INVALID'}); assert.throws(()=>visibleSpanSegments(fake,{startDate:'2026-12-31',endDate:'2027-01-01'}),{code:'SPAN_RESULT_INVALID'}); assert.equal(invoked,0);
  assert.throws(()=>spansOverlap({...night()},night()),{code:'SPAN_RESULT_INVALID'});
  const options={}; Object.defineProperty(options,'legacyWithoutEndDate',{enumerable:true,get(){invoked++;return true;}}); assert.throws(()=>shiftSpan({date:'2026-12-31',startTime:'09:00',endTime:'10:00'},options),{code:'SPAN_OPTIONS_INVALID'}); assert.equal(invoked,0);
});
test('moving explicit two-day span moves both dates; legacy same-day presence and raw ISO are never silently converted', () => {
  const source={date:'2026-12-31',startTime:'23:30',endDate:'2027-01-01',endTime:'01:00'}, before=JSON.stringify(source), moved=moveShiftSpan(source,7);
  assert.equal(moved.date,'2027-01-07'); assert.equal(moved.endDate,'2027-01-08'); assert.equal(shiftSpan(moved).durationMinutes,90); assert.equal(JSON.stringify(source),before);
  const old=moveShiftSpan({date:'2026-12-31',startTime:'09:00',endTime:'10:00'},1); assert.equal(Object.hasOwn(old,'endDate'),false);
  assert.throws(()=>moveShiftSpan({date:'2026-12-31',startTime:'2026-12-31T09:00:59Z',endTime:'2026-12-31T10:00:01Z'},1),{code:'MOVE_CLOCK_REPLACEMENT_REQUIRED'});
  for(const offset of [0,1.5,'1',Number.MAX_SAFE_INTEGER]) assert.throws(()=>moveShiftSpan(source,offset));
});
test('recurrence endDay is distinct from period endDate, explicit same/next only, and terminal date closes safely', () => {
  const old=recurringShiftSpan('2026-12-31',{startTime:'09:00',endTime:'10:00'}); assert.equal(Object.hasOwn(old,'endDate'),false);
  const next=recurringShiftSpan('2026-12-31',{startTime:'23:30',endTime:'01:00',endDay:'next'}); assert.equal(next.endDate,'2027-01-01');
  const same=recurringShiftSpan('2026-12-31',{startTime:'09:00',endTime:'10:00',endDay:'same'}); assert.equal(same.endDate,'2026-12-31');
  for(const value of ['',null,undefined,'tomorrow']) assert.throws(()=>recurringShiftSpan('2026-12-31',{startTime:'23:30',endTime:'01:00',endDay:value}));
  assert.throws(()=>recurringShiftSpan('9999-12-31',{startTime:'23:30',endTime:'01:00',endDay:'next'}));
  assert.throws(()=>recurringShiftSpan('2026-12-31',{startTime:'09:00',endTime:'10:00',endDate:'2027-01-01'}));
});
test('old seven-key snapshot branches retain distinct original substitution and attendance policies', () => {
  const old={id:'synthetic-shift',orgId:'synthetic-org',version:2,employeeId:'synthetic-employee',date:'2026-12-31',startTime:'09:00',endTime:'10:00'}, before=JSON.stringify(old);
  assert.equal(referenceSnapshotKind(old),'legacy-seven'); assertSubstitutionSnapshot(old); assertAttendanceShiftSnapshot(old,{shiftId:old.id,shiftVersion:old.version,employeeId:old.employeeId,date:old.date},old.orgId); assert.equal(JSON.stringify(old),before);
  const differentOldPolicy={...old,endTime:'08:00'}; assert.equal(referenceSnapshotKind(differentOldPolicy),'legacy-seven'); assertAttendanceShiftSnapshot(differentOldPolicy,{shiftId:old.id,shiftVersion:old.version,employeeId:old.employeeId,date:old.date},old.orgId); assert.throws(()=>assertSubstitutionSnapshot(differentOldPolicy));
  assert.throws(()=>explicitReferenceSpan(old),{code:'SPAN_REFERENCE_LEGACY_POLICY_REQUIRED'});
});
test('new explicit reference snapshot is eight known scalars, no case PII, no unsafe SQL version or getter admission', () => {
  const source=snapshot(), before=JSON.stringify(source); assert.equal(referenceSnapshotKind(source),'explicit-eight'); assert.equal(explicitReferenceSpan(source).durationMinutes,90); assert.equal(JSON.stringify(source),before);
  for(const item of [{...source,caseId:'private-case'},{...source,version:9007199254740992},{...source,endDate:null},{...source,endDate:'2027-01-02'},{...source,date:'0000-12-31',endDate:'0001-01-01'},{...source,employeeId:'synthetic-employee\n'}]) assert.throws(()=>referenceSnapshotKind(item));
  let invoked=0; const accessor={...source}; Object.defineProperty(accessor,'endDate',{enumerable:true,get(){invoked++;return source.endDate;}}); assert.throws(()=>referenceSnapshotKind(accessor)); assert.equal(invoked,0);
});
test('captured minutes must match only actual saved span; 2879 is technical bound and not a legal/price rule', () => {
  const full=serviceSpan({date:'2026-12-31',actualStart:'00:00',actualEnd:'23:59',actualEndDate:'2027-01-01'}); assert.equal(assertCapturedServiceMinutes(2879,full),2879);
  for(const minutes of [0,2878,'2879',Number.MAX_SAFE_INTEGER]) assert.throws(()=>assertCapturedServiceMinutes(minutes,full),{code:'SPAN_CAPTURED_MINUTES_INVALID'});
  assert.throws(()=>assertCapturedServiceMinutes(2879,{...full}),{code:'SPAN_RESULT_INVALID'});
});
