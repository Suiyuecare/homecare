import test from 'node:test';
import assert from 'node:assert/strict';
import { SHIFT_SERIES_FIELDS, seriesCalendarDay, assertShiftSeriesRecord, shiftSeriesDraft, shiftSeriesPatch, confirmShiftSeriesSave, shiftSeriesRange, expectedShiftSeriesDates, confirmShiftSeriesOccurrences, confirmShiftSeriesGenerationPreview, confirmShiftSeriesGenerationSave, shiftSeriesAdjustmentDefinition, confirmShiftSeriesAdjustment } from '../public/data/shift-series-editor.js';

const series = { name: ' 合成永久週期 ', caseId: 'case-1', employeeId: 'employee-1', carePlanId: 'plan-1', startDate: '2026-10-05', endDate: '', intervalWeeks: 2, weekdays: [1, 3, 5], startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: 'service-1', quantity: 2 }], status: 'active', note: ' 原文\r\n末行 ', id: 'series-1', orgId: 'org-1', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
const range = { version: 1, fromDate: '2026-10-05', toDate: '2026-10-09' };
const data = { orgId: series.orgId, cases: [{ id: series.caseId, orgId: series.orgId, status: 'active' }], employees: [{ id: series.employeeId, orgId: series.orgId, status: 'active' }], 'care-plans': [{ id: series.carePlanId, caseId: series.caseId, orgId: series.orgId, status: 'active', services: series.services }], 'service-items': [{ id: 'service-1', orgId: series.orgId, status: 'active' }] };
const clone = value => structuredClone(value);
const values = s => ({ ...Object.fromEntries(SHIFT_SERIES_FIELDS.filter(key => key !== 'caseId').map(key => [key, s[key]])), intervalWeeks: String(s.intervalWeeks), note: s.note.replace(/\r\n/g, '\n'), replaceNote: false });
const candidate = date => ({ caseId: series.caseId, employeeId: series.employeeId, carePlanId: series.carePlanId, date, startTime: series.startTime, endTime: series.endTime, services: clone(series.services), status: 'scheduled', note: series.note });
const occurrence = (date, overrides = {}) => ({ date, shiftId: 'shift-' + date, seriesVersion: 1, seriesSnapshot: clone(series), shift: { ...candidate(date), id: 'shift-' + date, orgId: series.orgId, version: 1, createdAt: series.createdAt, updatedAt: series.updatedAt }, createdAt: series.createdAt, editable: true, lockReason: '', ...overrides });
const preview = () => ({ series: clone(series), range: clone(range), items: ['2026-10-05', '2026-10-07', '2026-10-09'].map(date => ({ date, status: 'ready', candidate: candidate(date), conflicts: [] })), total: 3, readyCount: 3, existingCount: 0, conflictCount: 0, canCommit: true });
const saved = p => ({ batchId: 'batch-1', series: clone(series), range: clone(range), items: p.items.map(item => ({ date: item.date, created: item.status === 'ready', occurrence: item.occurrence || occurrence(item.date) })), total: 3, createdCount: p.readyCount, existingCount: p.existingCount });

test('permanent calendar anchor persists across separate periods, leap days and open ends while year0000 and more than93days reject', () => {
  assert.equal(seriesCalendarDay('0000-01-01'), NaN); assert.equal(seriesCalendarDay('2026-02-30'), NaN); assert.ok(Number.isFinite(seriesCalendarDay('0001-01-01')));
  assert.deepEqual(expectedShiftSeriesDates(series, { fromDate: '2026-10-12', toDate: '2026-10-23' }), ['2026-10-19', '2026-10-21', '2026-10-23']);
  const leap = { ...series, startDate: '2028-02-28', weekdays: [2], intervalWeeks: 1, endDate: '2028-02-29' }; assert.deepEqual(expectedShiftSeriesDates(leap, { fromDate: '2028-02-28', toDate: '2028-03-10' }), ['2028-02-29']);
  assert.throws(() => shiftSeriesRange({ fromDate: '2026-01-01', toDate: '2026-04-04' }, series)); assert.deepEqual(shiftSeriesRange(range, series), range);
});

test('draft preserves unmodified padded name/CRLF/max-length text, sends no untouched edits and requires explicit replacement for native LF normalization', () => {
  const long = { ...series, note: ' ' + '字'.repeat(9994) + '\r\n尾 ' }; assert.equal(long.note.length, 9999);
  const original = values(long), draft = shiftSeriesDraft(original, data, long); assert.equal(draft.name, long.name); assert.equal(draft.note, long.note); assert.deepEqual(shiftSeriesPatch(draft, long), {});
  const replaced = shiftSeriesDraft({ ...original, replaceNote: true }, data, long); assert.deepEqual(shiftSeriesPatch(replaced, long), { note: original.note });
  assert.equal(shiftSeriesDraft({ ...original, note: ' 明確修改\n保留邊界 ' }, data, long).note, ' 明確修改\n保留邊界 ');
  assert.throws(() => shiftSeriesDraft({ ...original, startDate: '2026-10-06' }, data, long)); assert.throws(() => shiftSeriesDraft({ ...original, services: [{ serviceItemId: 'service-1', quantity: 2, hidden: true }] }, data, long));
});

test('series record/save ACKs require complete identity, scope, exact payload/CAS/createdAt and closed nested services', () => {
  const draft = Object.fromEntries(SHIFT_SERIES_FIELDS.map(key => [key, series[key]])), changed = { ...series, version: 2, updatedAt: '2026-10-02T00:00:00.000Z' };
  assert.deepEqual(confirmShiftSeriesSave({ item: changed }, draft, series.orgId, series), changed);
  for (const alter of [item => { item.id = ' '; }, item => { item.orgId = 'other'; }, item => { item.version = 3; }, item => { item.createdAt = 'changed'; }, item => { delete item.note; }, item => { item.services[0].quantity = 3; }, item => { item.services[0].hidden = true; }, item => { item.unconfirmed = true; }]) { const response = clone(changed); alter(response); assert.throws(() => confirmShiftSeriesSave({ item: response }, draft, series.orgId, series)); }
  assert.throws(() => assertShiftSeriesRecord({ ...series, weekdays: [1, 1] }, series.orgId)); assert.throws(() => confirmShiftSeriesSave({ item: changed, hidden: true }, draft, series.orgId, series));
});

test('generation preview confirms exact complete expected calendar, every field/count/status and refuses missing dates, fake readiness or hidden projections', () => {
  const p = preview(); assert.equal(confirmShiftSeriesGenerationPreview(p, series, range, series.orgId), p);
  const missing = preview(); missing.items.pop(); missing.total--; missing.readyCount--; assert.throws(() => confirmShiftSeriesGenerationPreview(missing, series, range, series.orgId));
  for (const alter of [p => { p.items[0].candidate.note = p.items[0].candidate.note.trim(); }, p => { p.items[0].candidate.employeeId = 'other'; }, p => { p.items[0].candidate.services[0].extra = true; }, p => { p.items[0].date = '2026-10-06'; }, p => { p.canCommit = false; }, p => { p.range.version = 2; }, p => { p.hidden = true; }]) { const changed = preview(); alter(changed); assert.throws(() => confirmShiftSeriesGenerationPreview(changed, series, range, series.orgId)); }
  const empty = { ...p, items: [], total: 0, readyCount: 0, canCommit: false }; assert.throws(() => confirmShiftSeriesGenerationPreview(empty, series, range, series.orgId));
});

test('mixed ready/existing generation confirms frozen source snapshot, one new version and preserves cancelled date without duplication', () => {
  const p = preview(), old = occurrence('2026-10-05'); old.shift.status = 'cancelled'; old.shift.version = 2; old.editable = false; old.lockReason = '班次已取消'; p.items[0] = { date: old.date, status: 'existing', occurrence: old, conflicts: [] }; p.readyCount = 2; p.existingCount = 1;
  assert.equal(confirmShiftSeriesGenerationPreview(p, series, range, series.orgId), p); const ack = saved(p); assert.equal(confirmShiftSeriesGenerationSave(ack, p, series, range, series.orgId), ack);
  for (const alter of [ack => { ack.createdCount++; }, ack => { ack.items[1].occurrence.shift.version = 2; }, ack => { ack.items[1].occurrence.seriesSnapshot.note = 'changed'; }, ack => { ack.items[1].occurrence.shift.note = 'changed'; }, ack => { ack.items[0].created = true; }, ack => { ack.items[2].occurrence.shiftId = ack.items[1].occurrence.shiftId; }, ack => { ack.items[1].occurrence.hidden = true; }]) { const changed = clone(ack); alter(changed); assert.throws(() => confirmShiftSeriesGenerationSave(changed, p, series, range, series.orgId)); }
});

test('occurrence projection is closed and typed, reads current time/employee while requiring immutable parent/date and lock-state consistency', () => {
  const link = occurrence('2026-10-05'); link.shift.employeeId = 'employee-2'; link.shift.startTime = '11:00'; link.shift.endTime = '12:00'; link.shift.version = 2;
  const result = { series: clone(series), range: clone(range), items: [link], total: 1 }; assert.equal(confirmShiftSeriesOccurrences(result, series, range, series.orgId), result);
  for (const alter of [r => { r.items[0].shift.caseId = 'another'; }, r => { r.items[0].shift.date = '2026-10-06'; }, r => { r.items[0].shift.createdAt = 123; }, r => { r.items[0].seriesSnapshot.weekdays = [1, 1]; }, r => { r.items[0].editable = false; }, r => { r.items.push(clone(r.items[0])); r.total++; }, r => { r.items[0].shift.services[0].hidden = 1; }]) { const changed = clone(result); alter(changed); assert.throws(() => confirmShiftSeriesOccurrences(changed, series, range, series.orgId)); }
});

test('ordinary group definition requires exact explicit whole selection, derives frozen versions, omits disabled staff/time fields and preserves fresh reason', () => {
  const links = [occurrence('2026-10-05'), occurrence('2026-10-07')], source = { series, range, items: links, total: 2 }, form = { ...range, items: links.map(link => link.shiftId), action: 'cancel', employeeId: 'hidden-old-selection', startTime: '09:00', endTime: '10:00', reason: ' 原因\n邊界 ' }; delete form.version;
  const definition = shiftSeriesAdjustmentDefinition(form, source, series, series.orgId); assert.deepEqual(definition, { ...range, action: 'cancel', items: links.map(link => ({ id: link.shiftId, version: 1 })), reason: form.reason });
  assert.throws(() => shiftSeriesAdjustmentDefinition({ ...form, items: [links[0].shiftId] }, source, series, series.orgId)); assert.throws(() => shiftSeriesAdjustmentDefinition({ ...form, items: [links[0].shiftId, links[0].shiftId] }, source, series, series.orgId)); assert.throws(() => shiftSeriesAdjustmentDefinition({ ...form, reason: ' ' }, source, series, series.orgId)); assert.throws(() => shiftSeriesAdjustmentDefinition({ ...form, hidden: true }, source, series, series.orgId));
  const reschedule = shiftSeriesAdjustmentDefinition({ ...form, action: 'reschedule', startTime: '11:00', endTime: '12:00' }, source, series, series.orgId); assert.equal(reschedule.startTime, '11:00'); assert.ok(!Object.hasOwn(reschedule, 'employeeId')); assert.throws(() => shiftSeriesAdjustmentDefinition({ ...form, action: 'reschedule', startTime: '23:00', endTime: '02:00' }, source, series, series.orgId));
});

test('group envelope discloses only exact series/range and locked excluded projections without duplicate or selected hidden exclusions', () => {
  const link = occurrence('2026-10-07'); link.editable = false; link.lockReason = '已有服務紀錄'; const definition = { ...range, action: 'cancel', items: [{ id: 'shift-2026-10-05', version: 1 }], reason: 'fresh' }, result = { series: clone(series), range: clone(range), excluded: [link], preview: {} };
  assert.equal(confirmShiftSeriesAdjustment(result, definition, series, series.orgId), result);
  for (const alter of [r => { r.excluded[0].editable = true; r.excluded[0].lockReason = ''; }, r => { r.excluded.push(clone(r.excluded[0])); }, r => { r.range.version = 2; }, r => { r.excluded[0].seriesSnapshot.orgId = 'other'; }, r => { r.hidden = true; }]) { const changed = clone(result); alter(changed); assert.throws(() => confirmShiftSeriesAdjustment(changed, definition, series, series.orgId)); }
});

test('every ACK/preview/occurrence envelope rejects accessors without executing them, including nested and non-enumerable data', () => {
  let reads = 0; const getter = (object, key) => Object.defineProperty(object, key, { enumerable: true, get() { reads++; return 'synthetic-getter'; } });
  const draft = Object.fromEntries(SHIFT_SERIES_FIELDS.map(key => [key, series[key]]));
  const checks = [
    () => confirmShiftSeriesSave(getter({}, 'item'), draft, series.orgId),
    () => confirmShiftSeriesSave({ item: getter(clone(series), 'note') }, draft, series.orgId),
    () => confirmShiftSeriesGenerationPreview(getter(preview(), 'items'), series, range, series.orgId),
    () => { const p = preview(); getter(p.items[0].candidate.services[0], 'quantity'); return confirmShiftSeriesGenerationPreview(p, series, range, series.orgId); },
    () => { const r = { series: clone(series), range: clone(range), items: [occurrence('2026-10-05')], total: 1 }; getter(r.items[0].shift, 'createdAt'); return confirmShiftSeriesOccurrences(r, series, range, series.orgId); },
    () => { const ack = saved(preview()); getter(ack.items[0].occurrence.seriesSnapshot, 'weekdays'); return confirmShiftSeriesGenerationSave(ack, preview(), series, range, series.orgId); },
    () => confirmShiftSeriesAdjustment(getter({}, 'excluded'), { ...range, items: [] }, series, series.orgId),
    () => shiftSeriesDraft(getter(values(series), 'note'), data, series),
  ];
  for (const check of checks) assert.throws(check); assert.equal(reads, 0);
  for (const key of ['createdAt', 'updatedAt']) { const item = clone(series); delete item[key]; assert.throws(() => assertShiftSeriesRecord(item, series.orgId)); }
  for (const decorate of [item => Object.defineProperty(item, 'hidden', { value: true }), item => { item[Symbol('hidden')] = true; }, item => { item.weekdays.hidden = true; }, item => { delete item.weekdays[1]; }, item => { item.services[0] = Object.create({ quantity: 2 }); }]) { const item = clone(series); decorate(item); assert.throws(() => assertShiftSeriesRecord(item, series.orgId)); }
  assert.equal(assertShiftSeriesRecord(Object.assign(Object.create(null), series), series.orgId).id, series.id);
});

test('typed times, interval select and occurrence times reject CR/LF rather than silently coercing them', () => {
  for (const suffix of ['\n', '\r\n']) {
    assert.throws(() => assertShiftSeriesRecord({ ...series, startTime: '09:00' + suffix }, series.orgId));
    assert.throws(() => shiftSeriesDraft({ ...values(series), intervalWeeks: '2' + suffix }, data, series));
    const r = { series: clone(series), range: clone(range), items: [occurrence('2026-10-05')], total: 1 }; r.items[0].shift.endTime += suffix;
    assert.throws(() => confirmShiftSeriesOccurrences(r, series, range, series.orgId));
    const valid = { series: clone(series), range: clone(range), items: [occurrence('2026-10-05')], total: 1 };
    assert.throws(() => shiftSeriesAdjustmentDefinition({ fromDate: range.fromDate, toDate: range.toDate, items: ['shift-2026-10-05'], action: 'reschedule', startTime: '11:00' + suffix, endTime: '12:00', reason: 'fresh' }, valid, series, series.orgId));
  }
});
