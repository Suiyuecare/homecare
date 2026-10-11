import test from 'node:test';
import assert from 'node:assert/strict';
import { createShiftEditor } from '../public/data/shift-editor.js';
import { createLeaveEditor } from '../public/data/leave-editor.js';
import { createServiceRecordEditor, createServiceRecordReview } from '../public/data/service-record-editor.js';
import { createEndDateControl, spanRecordText, CALENDAR_SPAN_MODE } from '../public/data/shift-span-editor.js';

const people = [{ id: 'employee-a', name: '合成員工', employeeNo: 'SYN-E', status: 'active' }];
const services = [{ id: 'item-a', name: '合成服務', code: 'SYN-I', status: 'active' }];
const chosen = [{ serviceItemId: 'item-a', quantity: 2 }];
const shift = extra => ({ id: 'shift-a', orgId: 'org-a', version: 3, caseId: 'case-a', employeeId: 'employee-a', carePlanId: 'plan-a', date: '2026-10-09', startTime: '23:00', endTime: '01:00', services: chosen, status: 'scheduled', note: ' 原交班\r\n尾行\r\n ', ...extra });
const record = extra => ({ id: 'record-a', orgId: 'org-a', version: 4, shiftId: 'shift-a', caseId: 'case-a', employeeId: 'employee-a', date: '2026-10-09', actualStart: '23:10', actualEnd: '00:50', services: chosen, status: 'draft', note: ' 原觀察\r\n尾行\r\n ', reviewNote: ' 原說明 ', ...extra });
const leave = extra => ({ id: 'leave-a', orgId: 'org-a', version: 4, employeeId: 'employee-a', date: '2026-10-09', startTime: '23:00', endTime: '01:00', type: ' 機構自訂 ', reason: ' 原理由\r\n尾行\r\n ', status: 'pending', ...extra });
const shiftEditor = existing => createShiftEditor({ existing, cases: [{ id: 'case-a', name: '合成個案', status: 'active' }], employees: people, carePlans: [{ id: 'plan-a', caseId: 'case-a', status: 'active', validFrom: '2026-01-01', validTo: '2026-12-31', services: chosen }], serviceItems: services, defaultDate: '2026-10-09' });
const serviceEditor = existing => createServiceRecordEditor({ existing, shift: shift({ endDate: '2026-10-10' }), serviceItems: services });
const leaveEditor = existing => createLeaveEditor({ existing, employees: people, defaultDate: '2026-10-09' });
const next = (item, payload = {}) => ({ ...item, ...payload, version: item.version + 1 });
const error = fn => assert.throws(fn, e => !!e.fields);
const badAck = fn => assert.throws(fn, e => e.code === 'SAVE_UNCONFIRMED');

test('legacy creation truly omits new date and UI mode from all three payloads', () => {
  const a = shiftEditor().buildPayload({ employeeId: 'employee-a', services: chosen });
  const b = leaveEditor().buildPayload({ employeeId: 'employee-a', type: '人工假別' });
  const c = serviceEditor().buildPayload({ actualStart: '09:00', actualEnd: '10:00', services: chosen });
  for (const item of [a, b, c]) { assert(!Object.hasOwn(item, 'spanMode')); assert(!Object.hasOwn(item, 'endDate')); assert(!Object.hasOwn(item, 'actualEndDate')); }
  assert.equal(serviceEditor().initial.actualEndDate, '', 'planned ending date never autofills actual fact');
});

test('explicit new shifts and leave use same/next dates and never infer from clock order', () => {
  for (const create of [shiftEditor, leaveEditor]) {
    const e = create(), base = create === shiftEditor ? { employeeId: 'employee-a', services: chosen } : { employeeId: 'employee-a', type: '人工假別' };
    const same = e.buildPayload({ ...base, spanMode: CALENDAR_SPAN_MODE, endDate: '2026-10-09', startTime: '09:00', endTime: '10:00' });
    assert.equal(same.endDate, same.date);
    const overnight = e.buildPayload({ ...base, spanMode: CALENDAR_SPAN_MODE, endDate: '2026-10-10', startTime: '23:00', endTime: '01:00' });
    assert.equal(overnight.endDate, '2026-10-10'); assert(!Object.hasOwn(overnight, 'spanMode'));
    error(() => e.buildPayload({ ...base, spanMode: CALENDAR_SPAN_MODE, endDate: '2026-10-09', startTime: '23:00', endTime: '01:00' }));
  }
});

test('actual date must be manually present and may differ from planned span', () => {
  const e = serviceEditor(), base = { spanMode: CALENDAR_SPAN_MODE, actualStart: '21:00', actualEnd: '22:00', services: chosen };
  error(() => e.buildPayload(base));
  assert.equal(e.buildPayload({ ...base, actualEndDate: '2026-10-09' }).actualEndDate, '2026-10-09');
  assert.equal(e.buildPayload({ ...base, actualEndDate: '2026-10-10' }).actualEndDate, '2026-10-10');
  assert.equal(e.initial.plannedSpan, '2026-10-09 23:00 至 2026-10-10 01:00');
});

test('explicit ending date rejects null empty undefined LF invalid leap and >next', () => {
  for (const endDate of [null, '', undefined, 20261010, false, {}, [], '2026-10-10\n', '2026-02-29', '2026-10-08', '2026-10-11'])
    error(() => shiftEditor().buildPayload({ employeeId: 'employee-a', services: chosen, spanMode: CALENDAR_SPAN_MODE, endDate }));
  for (const endDate of [null, '', undefined, false]) error(() => shiftEditor(shift({ endDate })));
});

test('existing explicit record never drops date when changing only long text or status', () => {
  const rows = [shift({ endDate: '2026-10-10' }), leave({ endDate: '2026-10-10' }), record({ actualEndDate: '2026-10-10' })];
  for (let i = 0; i < rows.length; i++) {
    const e = [shiftEditor, leaveEditor, serviceEditor][i](rows[i]);
    assert.deepEqual(e.buildPayload(e.initial), {});
    const field = i === 1 ? 'reason' : 'note';
    const payload = e.buildPayload({ [field + 'Intent']: 'replace', [field]: ' 新人工內容\n尾行\n ' });
    assert.deepEqual(payload, { [field]: ' 新人工內容\n尾行\n ' });
    assert(!JSON.stringify(payload).includes('EndDate'));
    e.confirm(next(rows[i], payload), 'org-a', payload);
    error(() => e.buildPayload({ spanMode: 'legacy' }));
  }
});

test('legacy ISO seconds offsets and CRLF stay byte exact until complete intentional replacement', () => {
  const old = shift({ startTime: '2026-10-09T09:00:59+08:00', endTime: '2026-10-09T10:00:03+08:00' });
  const e = shiftEditor(old); assert.deepEqual(e.buildPayload(e.initial), {}); e.confirm(next(old), 'org-a', {});
  error(() => e.buildPayload({ spanMode: CALENDAR_SPAN_MODE, endDate: '2026-10-10' }));
  const payload = e.buildPayload({ spanMode: CALENDAR_SPAN_MODE, endDate: '2026-10-10', startTimeIntent: 'replace', startTime: '23:00', endTimeIntent: 'replace', endTime: '01:00' });
  assert.deepEqual(payload, { startTime: '23:00', endTime: '01:00', endDate: '2026-10-10' });
  assert.equal(old.note, ' 原交班\r\n尾行\r\n ');
});

test('save ACK confirms ending-date own presence and exact content for create/edit/review', () => {
  const old = record({ actualEndDate: '2026-10-10', status: 'submitted' });
  const review = createServiceRecordReview({ existing: old }), payload = review.buildPayload({ decision: 'approved', reviewNote: ' 人工核閱 ' });
  const ack = next(old, { status: 'approved', reviewNote: payload.reviewNote }); review.confirm(ack, 'org-a', payload);
  const missing = { ...ack }; delete missing.actualEndDate; badAck(() => review.confirm(missing, 'org-a', payload));
  badAck(() => review.confirm({ ...ack, actualEndDate: '2026-10-09' }, 'org-a', payload));
  for (const create of [shiftEditor, leaveEditor]) {
    const original = create === shiftEditor ? shift({ endDate: '2026-10-10' }) : leave({ endDate: '2026-10-10' });
    const e = create(original); badAck(() => e.confirm({ ...next(original), endDate: null }, 'org-a', {}));
    const omitted = next(original); delete omitted.endDate; badAck(() => e.confirm(omitted, 'org-a', {}));
    e.confirm(next(original), 'org-a', {});
  }
});

test('new date getters in original form values or ACK are rejected without execution', () => {
  let calls = 0;
  const getter = (object, key) => Object.defineProperty(object, key, { enumerable: true, get() { calls++; return '2026-10-10'; } });
  error(() => shiftEditor(getter(shift(), 'endDate')));
  const e = shiftEditor(); error(() => e.buildPayload(getter({ employeeId: 'employee-a', services: chosen, spanMode: CALENDAR_SPAN_MODE }, 'endDate')));
  const item = shift({ endDate: '2026-10-10' }), saved = shiftEditor(item);
  badAck(() => saved.confirm(getter(next(item), 'endDate'), 'org-a', {}));
  const r = record({ actualEndDate: '2026-10-10' }), reviewer = createServiceRecordReview({ existing: r });
  badAck(() => reviewer.confirm(getter(next(r, { status: 'approved', reviewNote: '' }), 'actualEndDate'), 'org-a', { decision: 'approved', reviewNote: '' }));
  assert.equal(calls, 0);
});

test('original year0000 literal ISO is never rewritten by legacy note edit', () => {
  const old = shift({ date: '0000-02-29', startTime: '0000-02-29T09:00:59+08:00', endTime: '0000-02-29T10:00:03+08:00' });
  const e = shiftEditor(old), p = e.buildPayload({ noteIntent: 'replace', note: '只改交班' });
  assert.deepEqual(p, { note: '只改交班' }); e.confirm(next(old, p), 'org-a', p);
  assert(!Object.hasOwn(p, 'endDate'));
});

test('complete display shows saved ending date without backfilling legacy or invoking getters', () => {
  assert.equal(spanRecordText(shift({ endDate: '2026-10-10' })), '2026-10-09 23:00 至 2026-10-10 01:00');
  assert.equal(spanRecordText(shift({ startTime: '09:00', endTime: '10:00' })), '2026-10-09 09:00 至 10:00（舊同日格式）');
  let calls = 0; const malicious = shift(); Object.defineProperty(malicious, 'endDate', { enumerable: true, get() { calls++; return '2026-10-10'; } });
  assert.equal(spanRecordText(malicious), '完整日期時段未取得'); assert.equal(calls, 0);
});

test('explicit disabled mode cannot be broadened by caller mutation of returned initial/options', () => {
  const e = createEndDateControl({ existing: shift({ endDate: '2026-10-10' }) });
  e.initial.spanMode = 'legacy'; e.fields[0].options.push({ value: 'other', label: 'inject' });
  assert.equal(e.mode({}), CALENDAR_SPAN_MODE); error(() => e.mode({ spanMode: 'legacy' })); error(() => e.mode({ spanMode: 'other' }));
});
