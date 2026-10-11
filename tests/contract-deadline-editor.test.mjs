import test from 'node:test';
import assert from 'node:assert/strict';
import { contractDeadlineFields, contractDeadlineDefaults, contractDeadlineRecordValid, contractDeadlineSnapshotValid, contractDeadlineDate, contractDeadlineWorkState,
  createContractDeadlineEditor, createContractDeadlineTransitionEditor, checkContractDeadlineRecord, contractDeadlineSnapshotRows } from '../public/data/contract-deadline-editor.js';
const snapshot = () => ({ id: 'contract-1', version: 2, caseId: 'case-1', number: 'C-01', title: '合成契約', startDate: '2026-10-01', endDate: '2026-12-31' });
const record = fields => ({ contractId: 'contract-1', contractVersion: 2, contractSnapshot: snapshot(), title: '原提醒', content: '  原文\r\n末行  ', assigneeEmployeeId: 'employee-1', dueDate: '2026-12-10', ...contractDeadlineDefaults,
  note: '  原備註\r\n結尾  ', id: 'reminder-1', orgId: 'org-1', version: 1, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...fields });
const employees = [{ value: 'employee-1', label: '合成員工 · E-01', active: true }, { value: 'employee-2', label: '合成員工二 · E-02', active: true }];
test('ordinary six controls use explicit source, manual due date and closed thirteen-field record', () => {
  const editor = createContractDeadlineEditor({ source: snapshot(), employees });
  assert.deepEqual(editor.fields.map(field => field.name), ['title', 'content', 'assigneeEmployeeId', 'dueDate', 'priority', 'note']);
  const payload = editor.buildPayload({ ...editor.initial, content: '  合成人工工作\r\n結尾  ', assigneeEmployeeId: 'employee-1', dueDate: '2026-12-10' });
  assert.equal(payload.contractId, 'contract-1'); assert.equal(payload.contractVersion, 2); assert.equal(payload.content, '  合成人工工作\r\n結尾  '); assert(!Object.hasOwn(payload, 'contractSnapshot'));
  const item = record({ title: payload.title, content: payload.content, note: '' }); assert(contractDeadlineRecordValid(item)); assert.equal(contractDeadlineFields.length, 13);
  assert.equal(checkContractDeadlineRecord({ item }, { orgId: 'org-1', payload }).id, item.id);
});
test('unchanged CRLF and spaces are omitted; changing title preserves exact source long text', () => {
  const item = record(), editor = createContractDeadlineEditor({ existing: item, employees });
  assert.equal(editor.initial.content, '  原文\n末行  '); assert.deepEqual(editor.buildPayload({ ...editor.initial }), {});
  assert.deepEqual(editor.buildPayload({ ...editor.initial, title: ' 新標題 ' }), { title: '新標題' });
  const payload = editor.buildPayload({ ...editor.initial, content: '  故意修改\n末行  ' }); assert.deepEqual(payload, { content: '  故意修改\n末行  ' });
  assert.equal(item.content, '  原文\r\n末行  ');
});
test('original and source callers cannot mutate private editor baseline', () => {
  const item = record(), editor = createContractDeadlineEditor({ existing: item, employees }); item.content = 'caller mutation'; item.contractSnapshot.number = 'caller mutation';
  assert.deepEqual(editor.buildPayload({ ...editor.initial, title: '更正標題' }), { title: '更正標題' });
  const source = snapshot(), fresh = createContractDeadlineEditor({ source, employees }); source.id = 'different'; source.version = 42;
  const payload = fresh.buildPayload({ ...fresh.initial, content: '人工工作', assigneeEmployeeId: 'employee-1', dueDate: '2026-12-01' }); assert.equal(payload.contractId, 'contract-1'); assert.equal(payload.contractVersion, 2);
});
test('inactive employee can remain but new assignment must active; closed reminders have no edit adapter', () => {
  const inactive = [{ ...employees[0], active: false }, employees[1]], editor = createContractDeadlineEditor({ existing: record(), employees: inactive });
  assert.deepEqual(editor.buildPayload(editor.initial), {}); assert.match(editor.fields.find(field => field.name === 'assigneeEmployeeId').options[0].label, /停用/);
  const create = createContractDeadlineEditor({ source: snapshot(), employees: inactive }); assert.throws(() => create.buildPayload({ ...create.initial, content: '工作', dueDate: '2026-12-01', assigneeEmployeeId: 'employee-1' }));
  assert.throws(() => createContractDeadlineEditor({ existing: record({ status: 'completed', statusDate: '2026-12-01', result: '已核對' }), employees }));
});
test('transition uses fresh dates and exact result/reason, cannot skip pending directly to completed', () => {
  assert.throws(() => createContractDeadlineTransitionEditor(record(), 'completed'));
  const progress = record({ status: 'in_progress', statusDate: '2026-12-01' }), complete = createContractDeadlineTransitionEditor(progress, 'completed');
  assert.deepEqual(complete.initial, { statusDate: '', result: '' }); assert.throws(() => complete.buildPayload({ statusDate: '2026-11-30', result: '結果' }));
  assert.throws(() => complete.buildPayload({ statusDate: '2026-12-02', result: '  ' }));
  assert.deepEqual(complete.buildPayload({ statusDate: '2026-12-02', result: '  本次人工結果\r\n結尾  ' }), { status: 'completed', statusDate: '2026-12-02', result: '  本次人工結果\r\n結尾  ' });
  const cancel = createContractDeadlineTransitionEditor(record(), 'cancelled'); assert.deepEqual(cancel.buildPayload({ statusDate: '2026-10-10', statusReason: '  本次取消\r\n依據  ' }).statusReason, '  本次取消\r\n依據  ');
});
test('explicit asOf classifies pending/progress only without changing saved record or contract date', () => {
  const item = record(), saved = structuredClone(item);
  assert.equal(contractDeadlineWorkState(item, '2026-12-09'), 'before_due'); assert.equal(contractDeadlineWorkState(item, '2026-12-10'), 'on_due'); assert.equal(contractDeadlineWorkState(item, '2026-12-11'), 'past_due');
  assert.equal(contractDeadlineWorkState(item, '2026-12-10\n'), null); assert.equal(contractDeadlineWorkState(record({ status: 'cancelled', statusDate: '2026-12-01', statusReason: '本次取消' }), '2026-12-11'), 'closed'); assert.deepEqual(item, saved);
  assert(contractDeadlineDate('2024-02-29')); for (const value of ['2026-02-29', '0000-01-01', '2026-12-10\n', '2026-1-01']) assert(!contractDeadlineDate(value));
});
test('ACK confirms every immutable field, exact source snapshot, version, identity, defaults and raw text', () => {
  const original = record(), payload = { title: '新標題' }, item = { ...original, title: payload.title, version: 2, updatedAt: '2026-10-11T00:00:00.000Z' };
  assert.equal(checkContractDeadlineRecord({ item }, { id: original.id, orgId: original.orgId, original, payload }), item);
  for (const change of [{ version: 1 }, { content: original.content.trim() }, { orgId: 'foreign' }, { createdAt: '2026-10-09T00:00:00.000Z' }, { unknown: {} }, { contractSnapshot: { ...original.contractSnapshot, endDate: '2027-01-01' } }])
    assert.throws(() => checkContractDeadlineRecord({ item: { ...item, ...change } }, { id: original.id, orgId: original.orgId, original, payload }));
  assert.throws(() => checkContractDeadlineRecord({ item, extra: true }, { orgId: 'org-1' }));
});
test('closed scalar snapshots, records, option arrays and submitted values reject accessors without invoking any', () => {
  let calls = 0; const getter = { get() { calls++; throw new Error('must not invoke'); }, enumerable: true };
  for (const key of ['id', 'version', 'endDate']) { const value = snapshot(); Object.defineProperty(value, key, getter); assert(!contractDeadlineSnapshotValid(value)); assert.equal(contractDeadlineSnapshotRows(value), null); }
  assert.equal(contractDeadlineSnapshotRows(snapshot()).length, 7);
  const item = record(); Object.defineProperty(item, 'content', getter); assert(!contractDeadlineRecordValid(item));
  const list = [...employees]; Object.defineProperty(list, '0', getter); assert.throws(() => createContractDeadlineEditor({ source: snapshot(), employees: list }));
  const editor = createContractDeadlineEditor({ existing: record(), employees }), values = { ...editor.initial }; Object.defineProperty(values, 'note', getter); assert.throws(() => editor.buildPayload(values));
  const bad = record({ contractSnapshot: { ...snapshot(), private: { secret: 'not projected' } } }); assert(!contractDeadlineRecordValid(bad)); assert.equal(calls, 0);
});
