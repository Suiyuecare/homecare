import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftBatchFormDefinition, confirmShiftBatchChoices, confirmShiftBatchPreview, confirmShiftBatchCommit } from '../public/modules/shift-batches.js';

const orgId = 'synthetic-batch-org';
const shift = overrides => ({ id: 'synthetic-shift-a', orgId, version: 1, caseId: 'synthetic-case', employeeId: 'synthetic-old-employee', carePlanId: 'synthetic-plan', date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: 'synthetic-service', quantity: 1 }], status: 'scheduled', note: ' 原交班\r\n末行 ', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', ...overrides });
const business = item => Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'orgId', 'version', 'createdAt', 'updatedAt'].includes(key)));
const values = overrides => ({ selectionDate: '2026-10-10', selectionSearch: '', selectionState: '已讀取', action: 'reassign', employeeId: 'synthetic-new-employee', items: ['synthetic-shift-a'], reason: ' 本次人工原因\n保留空白 ', ...overrides });
function preview(action = 'reassign', before = shift()) {
  const definition = shiftBatchFormDefinition(values({ action }), [before], orgId), after = { ...business(before), ...(action === 'reassign' ? { employeeId: definition.employeeId } : { status: 'cancelled' }) };
  return { definition, items: [{ id: before.id, version: before.version, status: 'ready', before, after, conflicts: [] }], total: 1, readyCount: 1, conflictCount: 0, canCommit: true };
}
const result = prepared => ({ batchId: 'synthetic-batch', action: prepared.definition.action, reason: prepared.definition.reason, total: 1, items: [{ ...prepared.items[0].before, ...prepared.items[0].after, version: 2, updatedAt: '2026-10-10T00:01:00Z' }] });

test('explicit batch selections freeze id/version and retain reason and original saved text without exposing JSON controls', () => {
  const candidates = [shift()], definition = shiftBatchFormDefinition(values(), candidates, orgId);
  assert.deepEqual(definition.items, [{ id: candidates[0].id, version: 1 }]); assert.equal(definition.reason, values().reason);
  const canceled = shiftBatchFormDefinition(values({ action: 'cancel' }), candidates, orgId); assert.ok(!Object.hasOwn(canceled, 'employeeId'));
  assert.equal(candidates[0].note, ' 原交班\r\n末行 ');
  for (const patch of [{ items: [] }, { items: Array(51).fill(candidates[0].id) }, { items: [candidates[0].id, candidates[0].id] }, { items: ['stale-selection'] }, { reason: ' ' }, { reason: '字'.repeat(2001) }, { action: 'delete' }, { employeeId: ' padded' }, { unknown: 'hidden' }]) assert.throws(() => shiftBatchFormDefinition(values(patch), candidates, orgId));
});

test('choice list confirmation refuses truncation, duplicate/foreign/wrong-date rows and partial scheduled projections', () => {
  const response = { items: [shift()], total: 1, page: 1, pageSize: 100 }; assert.equal(confirmShiftBatchChoices(response, orgId, '2026-10-10').length, 1);
  for (const patch of [{ total: 101 }, { total: 2 }, { pageSize: 25 }, { items: [{ ...shift(), orgId: 'foreign' }] }, { items: [{ ...shift(), date: '2026-10-11' }] }, { items: [{ ...shift(), status: 'completed' }] }, { total: 2, items: [shift(), shift()] }]) assert.throws(() => confirmShiftBatchChoices({ ...response, ...patch }, orgId, '2026-10-10'));
});

test('preview confirms full exact preserved projections and rejects misleading ready counts or hidden nested fields', () => {
  for (const action of ['reassign', 'cancel']) {
    const prepared = preview(action); assert.equal(confirmShiftBatchPreview(prepared, prepared.definition, orgId), prepared);
    for (const patch of [{ canCommit: false }, { readyCount: 0 }, { conflictCount: 1 }, { definition: { ...prepared.definition, reason: 'another' } }, { hidden: {} }]) assert.throws(() => confirmShiftBatchPreview({ ...prepared, ...patch }, prepared.definition, orgId));
    for (const patch of [{ version: 2 }, { id: 'other' }, { before: { ...shift(), orgId: 'foreign' } }, { after: { ...prepared.items[0].after, note: 'normalized' } }, { after: { ...prepared.items[0].after, services: [{ serviceItemId: 'synthetic-service', quantity: 2 }] } }, { after: { ...prepared.items[0].after, hidden: [] } }, { status: 'ready', conflicts: [{ code: 'failure', message: 'message' }] }]) assert.throws(() => confirmShiftBatchPreview({ ...prepared, items: [{ ...prepared.items[0], ...patch }] }, prepared.definition, orgId));
  }
});

test('conflict previews need no private record projection and cannot become a commit acknowledgement', () => {
  const prepared = preview(), blocked = { ...prepared, readyCount: 0, conflictCount: 1, canCommit: false, items: [{ id: prepared.items[0].id, version: 1, status: 'conflict', conflicts: [{ code: 'NOT_FOUND', message: '班次不可用' }] }] };
  assert.equal(confirmShiftBatchPreview(blocked, blocked.definition, orgId), blocked);
  assert.throws(() => confirmShiftBatchCommit(result(prepared), blocked, blocked.definition, orgId));
  for (const conflict of [{ code: 'NOT_FOUND', message: 'message', fields: { hidden: {} } }, { code: '', message: 'message' }, { code: 'NOT_FOUND', message: '', secret: true }]) assert.throws(() => confirmShiftBatchPreview({ ...blocked, items: [{ ...blocked.items[0], conflicts: [conflict] }] }, blocked.definition, orgId));
});

test('atomic commit ACK validates exact next version, action, reason, scope, every business field and original creation time', () => {
  for (const action of ['reassign', 'cancel']) {
    const prepared = preview(action), saved = result(prepared); assert.equal(confirmShiftBatchCommit(saved, prepared, prepared.definition, orgId), saved);
    for (const patch of [{ batchId: ' ' }, { action: 'other' }, { reason: 'different' }, { total: 2 }, { items: [] }, { hidden: true }]) assert.throws(() => confirmShiftBatchCommit({ ...saved, ...patch }, prepared, prepared.definition, orgId));
    for (const patch of [{ id: 'other' }, { orgId: 'foreign' }, { version: 1 }, { note: 'lost-original' }, { date: '2026-10-11' }, { caseId: 'different-case' }, { createdAt: 'changed' }, { services: [{ serviceItemId: 'synthetic-service', quantity: 2 }] }]) assert.throws(() => confirmShiftBatchCommit({ ...saved, items: [{ ...saved.items[0], ...patch }] }, prepared, prepared.definition, orgId));
  }
});

test('omitted notes remain omitted and maximum-length notes with CRLF survive preview and saved response intact', () => {
  for (const original of [shift({ note: '字'.repeat(9996) + '\r\n末行' }), (() => { const missing = shift(); delete missing.note; return missing; })()]) {
    const prepared = preview('cancel', original), saved = result(prepared); assert.equal(confirmShiftBatchCommit(saved, prepared, prepared.definition, orgId), saved);
    const tampered = structuredClone(saved); if (Object.hasOwn(original, 'note')) delete tampered.items[0].note; else tampered.items[0].note = '';
    assert.throws(() => confirmShiftBatchCommit(tampered, prepared, prepared.definition, orgId));
  }
});
