import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftSeriesMoveOffset, shiftSeriesMovedDate, shiftSeriesAdjustmentDefinition, confirmShiftSeriesOccurrences, confirmShiftSeriesMovePreview, confirmShiftSeriesMoveSave } from '../public/data/shift-series-editor.js';

const clone = value => JSON.parse(JSON.stringify(value)), orgId = 'org-move', stamp = '2026-10-01T00:00:00.000Z';
const series = { name: '合成整組移日', caseId: 'case-move', employeeId: 'employee-move', carePlanId: 'plan-move', startDate: '2026-10-05', endDate: '', intervalWeeks: 1, weekdays: [1, 2, 3], startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: 'service-move', quantity: 2 }], status: 'active', note: ' 原服務\r\n末行 ', id: 'series-move', orgId, version: 1, createdAt: stamp, updatedAt: stamp };
const range = { version: 1, fromDate: '2026-10-05', toDate: '2026-10-07' };
const shift = (date, index) => ({ caseId: series.caseId, employeeId: series.employeeId, carePlanId: series.carePlanId, date, startTime: '09:00', endTime: '10:00', services: clone(series.services), status: 'scheduled', note: series.note, id: 'shift-' + index, orgId, version: 1, createdAt: stamp, updatedAt: stamp });
const occurrences = () => ({ series: clone(series), range: clone(range), items: [5, 6, 7].map((day, index) => ({ date: '2026-10-0' + day, shiftId: 'shift-' + index, seriesVersion: 1, seriesSnapshot: clone(series), shift: shift('2026-10-0' + day, index), createdAt: stamp, editable: true, lockReason: '' })), total: 3 });
const values = () => ({ fromDate: range.fromDate, toDate: range.toDate, action: 'move', items: ['shift-0', 'shift-1', 'shift-2'], daysOffset: '+1', employeeId: 'disabled-value', startTime: '01:00', endTime: '02:00', reason: ' 移日原因\n末行 ' });
const definition = () => shiftSeriesAdjustmentDefinition(values(), occurrences(), series, orgId);
const preview = () => { const d = definition(); return { definition: { action: 'move', items: d.items, reason: d.reason, daysOffset: 1 }, items: occurrences().items.map(item => { const before = item.shift, after = Object.fromEntries(Object.entries(before).filter(([key]) => !['id', 'orgId', 'version', 'createdAt', 'updatedAt'].includes(key))); after.date = shiftSeriesMovedDate(before.date, 1); return { id: before.id, version: 1, originalDate: item.date, status: 'ready', before, after, conflicts: [] }; }), total: 3, readyCount: 3, conflictCount: 0, canCommit: true }; };
const saved = p => ({ batchId: 'batch-move', action: 'move', daysOffset: 1, reason: p.definition.reason, items: p.items.map(item => ({ ...item.after, id: item.id, orgId, version: 2, createdAt: item.before.createdAt, updatedAt: '2026-10-02T00:00:00.000Z' })), total: 3 });

test('ordinary signed integer input stays exact; decimal/exponent/zero/leading-zero/CRLF and unsafe bounds reject', () => {
  for (const value of [1, -1, '+1', '-2', '3652058']) assert.equal(shiftSeriesMoveOffset(value), Number(value));
  for (const value of [0, -0, '0', '-0', '+0', '01', '-01', '1.0', '1e2', ' 1', '1 ', '1\n', '1\r', 1.5, NaN, Infinity, null, {}, Number.MAX_SAFE_INTEGER, '3652059']) assert.throws(() => shiftSeriesMoveOffset(value));
});
test('calendar translation preserves leap day and closed year bounds without native date coercion', () => {
  assert.equal(shiftSeriesMovedDate('2024-02-28', 1), '2024-02-29'); assert.equal(shiftSeriesMovedDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftSeriesMovedDate('0001-01-01', 3652058), '9999-12-31');
  for (const pair of [['0001-01-01', -1], ['9999-12-31', 1], ['0000-12-31', 1], ['2026-02-30', 1], ['2026-10-05\n', 1]]) assert.throws(() => shiftSeriesMovedDate(...pair));
});
test('move definition selects all exact current versions and sends no disabled employee/time fields', () => {
  const d = definition(); assert.equal(d.daysOffset, 1); assert.equal(d.reason, values().reason); assert.deepEqual(Object.keys(d), ['version', 'fromDate', 'toDate', 'action', 'items', 'reason', 'daysOffset']);
  assert.throws(() => shiftSeriesAdjustmentDefinition({ ...values(), items: ['shift-0'] }, occurrences(), series, orgId));
  assert.throws(() => shiftSeriesAdjustmentDefinition({ ...values(), skipConflict: true }, occurrences(), series, orgId));
});
test('original eight-field occurrence cannot claim moved date; server-only matching movedDate extension allows fresh trace', () => {
  const data = occurrences(); data.items[0].shift.date = '2026-10-06'; data.items[0].shift.version = 2;
  assert.throws(() => confirmShiftSeriesOccurrences(data, series, range, orgId));
  data.items[0].movedDate = '2026-10-06'; assert.equal(confirmShiftSeriesOccurrences(data, series, range, orgId), data);
  for (const mutate of [x => { x.items[0].movedDate = '2026-10-07'; }, x => { x.items[0].shift.date = '0000-01-01'; }, x => { x.items[1].movedDate = x.items[1].date; }, x => { x.items[0].shift.caseId = 'foreign-case'; }]) { const bad = clone(data); mutate(bad); assert.throws(() => confirmShiftSeriesOccurrences(bad, series, range, orgId)); }
});
test('legacy ISO occurrence values remain literal and do not get cropped into native clocks', () => {
  const data = occurrences(); data.items[0].shift.startTime = '2026-10-05T09:00:33+08:00'; data.items[0].shift.endTime = '2026-10-05T10:00:59+08:00';
  const text = JSON.stringify(data); confirmShiftSeriesOccurrences(data, series, range, orgId); assert.equal(JSON.stringify(data), text);
  data.items[0].shift.startTime = '2026-10-06T09:00:33+08:00'; assert.throws(() => confirmShiftSeriesOccurrences(data, series, range, orgId));
});
test('move preview confirms exact raw business preservation, origin range, order, readiness and complete target dates', () => {
  const p = preview(), text = JSON.stringify(p); confirmShiftSeriesMovePreview(p, definition(), orgId); assert.equal(JSON.stringify(p), text);
  for (const mutate of [x => { x.definition.daysOffset = 2; }, x => { x.items[0].after.note = x.items[0].after.note.trim(); }, x => { x.items[0].after.employeeId = 'other'; }, x => { x.items[0].after.date = '2026-10-07'; }, x => { x.items[0].originalDate = '2026-10-01'; }, x => { x.items[0].after.services[0].quantity = 1; }, x => { x.items.reverse(); }, x => { x.readyCount = 2; }, x => { x.canCommit = false; }, x => { x.items[0].hidden = true; }, x => { x.hidden = true; }]) { const bad = clone(p); mutate(bad); assert.throws(() => confirmShiftSeriesMovePreview(bad, definition(), orgId)); }
});
test('conflict preview cannot save; closed reason/code fields permit correction without a fake ready row', () => {
  const p = preview(); p.items[0] = { id: p.items[0].id, version: 1, originalDate: p.items[0].originalDate, status: 'conflict', conflicts: [{ code: 'MOVE_CLOCK_REPLACEMENT_REQUIRED', message: '先明確取代原 ISO 時段' }] }; p.readyCount = 2; p.conflictCount = 1; p.canCommit = false;
  confirmShiftSeriesMovePreview(p, definition(), orgId); assert.throws(() => confirmShiftSeriesMoveSave(saved(preview()), p, definition(), orgId));
});
test('save ACK requires same ids, exact next versions, raw note/services and confirmed new dates', () => {
  const p = preview(), result = saved(p); confirmShiftSeriesMoveSave(result, p, definition(), orgId);
  for (const mutate of [x => { x.items[0].date = '2026-10-05'; }, x => { x.items[0].version = 3; }, x => { x.items[0].note = 'normalized'; }, x => { x.items[0].orgId = 'foreign'; }, x => { x.items[0].createdAt = x.items[0].updatedAt; }, x => { x.daysOffset = 2; }, x => { x.reason = x.reason.trim(); }, x => { x.items.push(clone(x.items[0])); }, x => { x.extra = true; }]) { const bad = clone(result); mutate(bad); assert.throws(() => confirmShiftSeriesMoveSave(bad, p, definition(), orgId)); }
});
test('descriptor guard rejects getters/symbols/sparse arrays without evaluating unknown data', () => {
  let calls = 0; const bad = preview(); Object.defineProperty(bad.items[0].after, 'note', { enumerable: true, get() { calls++; return 'trap'; } });
  assert.throws(() => confirmShiftSeriesMovePreview(bad, definition(), orgId)); assert.equal(calls, 0);
  const hidden = saved(preview()); hidden.items[0][Symbol('trap')] = 1; assert.throws(() => confirmShiftSeriesMoveSave(hidden, preview(), definition(), orgId));
  const sparse = values(); sparse.items = new Array(3); assert.throws(() => shiftSeriesAdjustmentDefinition(sparse, occurrences(), series, orgId));
});
