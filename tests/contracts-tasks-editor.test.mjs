import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContractsTasksRecord, createContractsTasksEditor, createContractsTasksTransitionEditor, contractExpiryForDisplay } from '../public/data/contracts-tasks-editor.js';
import { contractsTasksEntities, validateContractsTasks, contractsTasksVisible, contractsTasksHistoryVisible, guardContractsTasksAccess,
  assertContractsTasksTransitionPayload, contractsTasksQuery, contractExpiry } from '../src/server/contracts-tasks.mjs';

const contractEntity = 'case-contracts', taskEntity = 'internal-tasks', meta = { id: 'synthetic-contract', orgId: 'synthetic-org', version: 1, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' };
const contract = overrides => ({ ...contractsTasksEntities[contractEntity].defaults, caseId: 'synthetic-case', number: 'CONTRACT-01', title: '合成契約', startDate: '2026-10-01', endDate: '2026-12-31', ...meta, ...overrides });
const task = overrides => ({ ...contractsTasksEntities[taskEntity].defaults, title: '合成內部待辦', content: '  合成內容\r\n末行  ', assigneeEmployeeId: 'synthetic-employee', dueDate: '2026-10-20', ...meta, id: 'synthetic-task', ...overrides });
const manager = { role: 'admin', orgId: meta.orgId, user: { id: 'synthetic-user' } };
const business = item => Object.fromEntries(Object.entries(item).filter(([key]) => !['id', 'orgId', 'version', 'createdAt', 'updatedAt'].includes(key)));
const fail = (status, code, message, fields) => { const error = new Error(message); Object.assign(error, { status, code, fields }); throw error; };
const parents = new Map([['cases/synthetic-case', { id: 'synthetic-case', orgId: meta.orgId }], ['employees/synthetic-employee', { id: 'synthetic-employee', orgId: meta.orgId, status: 'active' }], ['employees/synthetic-second', { id: 'synthetic-second', orgId: meta.orgId, status: 'active' }]]);
const get = (_db, org, kind, id) => { const item = parents.get(`${kind}/${id}`); return item?.orgId === org ? item : null; };
const validate = (entity, item, original) => validateContractsTasks(null, manager, entity, business(item), original, fail, () => true, () => [], get);

test('contract and task DTO checks reject unknown nested fields and accessors without execution', () => {
  for (const [entity, source] of [[contractEntity, contract()], [taskEntity, task()]]) {
    assert.equal(checkContractsTasksRecord({ item: source }, { entity, orgId: meta.orgId }), source);
    assert.throws(() => checkContractsTasksRecord({ item: { ...source, privateImport: { secret: 'SYNTHETIC' } } }, { entity, orgId: meta.orgId }));
    let calls = 0; const poison = { ...source }; Object.defineProperty(poison, 'title', { enumerable: true, get() { calls++; return 'bad'; } });
    assert.throws(() => checkContractsTasksRecord({ item: poison }, { entity, orgId: meta.orgId })); assert.equal(calls, 0);
    const envelope = {}; Object.defineProperty(envelope, 'item', { enumerable: true, get() { calls++; return source; } });
    assert.throws(() => checkContractsTasksRecord(envelope, { entity, orgId: meta.orgId })); assert.equal(calls, 0);
  }
});
test('draft editor omits unchanged CRLF and padded text, preserves unrelated fields and deliberately changed text exactly', () => {
  const existing = contract({ sourceReference: '  文件\r\n核對  ', note: '  備註\r\n末行  ' }), editor = createContractsTasksEditor({ entity: contractEntity, existing });
  const values = { ...editor.initial, sourceReference: '  文件\n核對  ', note: '  備註\n末行  ' };
  assert.deepEqual(editor.buildPayload(values), {});
  assert.deepEqual(editor.buildPayload({ ...values, title: '  改標題  ' }), { title: '改標題' });
  assert.deepEqual(editor.buildPayload({ ...values, note: '  明確新內容\n末行  ' }), { note: '  明確新內容\n末行  ' });
  assert.deepEqual(editor.buildPayload({ ...values, sourceReference: '' }), { sourceReference: '' });
});
test('ordinary new contract and task editors validate references and periods without raw JSON', () => {
  const first = createContractsTasksEditor({ entity: contractEntity, references: [{ value: 'synthetic-case', label: '合成個案' }] });
  const values = { ...first.initial, caseId: 'synthetic-case', number: 'C-01', title: '合成契約', startDate: '2026-10-01', endDate: '2026-12-31' };
  assert.equal(first.buildPayload(values).caseId, 'synthetic-case');
  assert.throws(() => first.buildPayload({ ...values, caseId: 'foreign' })); assert.throws(() => first.buildPayload({ ...values, endDate: '2026-09-30' }));
  const second = createContractsTasksEditor({ entity: taskEntity, references: [{ value: 'synthetic-employee', label: '合成員工' }] });
  assert.equal(second.buildPayload({ ...second.initial, title: '合成待辦', content: '合成描述', assigneeEmployeeId: 'synthetic-employee', dueDate: '2026-10-10' }).priority, 'normal');
});
test('malicious reference option array slots and saved records execute no getters', () => {
  let calls = 0; const references = []; Object.defineProperty(references, '0', { enumerable: true, get() { calls++; return { value: 'x', label: 'x' }; } });
  assert.throws(() => createContractsTasksEditor({ entity: contractEntity, references })); assert.equal(calls, 0);
  const existing = contract(); Object.defineProperty(existing, 'orgId', { enumerable: true, get() { calls++; return meta.orgId; } });
  assert.throws(() => createContractsTasksEditor({ entity: contractEntity, existing })); assert.equal(calls, 0);
});
test('renewal creates fixed parent and case binding without allowing overlapping period or old record editing', () => {
  const renewal = contract({ status: 'active', signedDate: '2026-09-20', statusDate: '2026-09-21', documentReference: '合成文件', sourceReference: '合成核對' });
  const editor = createContractsTasksEditor({ entity: contractEntity, renewal });
  const values = { ...editor.initial, number: 'RENEWAL-01', title: '合成續約', startDate: '2027-01-01', endDate: '2027-12-31' };
  assert.deepEqual(Object.fromEntries(Object.entries(editor.buildPayload(values)).filter(([key]) => ['caseId', 'renewedFromId'].includes(key))), { caseId: renewal.caseId, renewedFromId: renewal.id });
  assert.throws(() => editor.buildPayload({ ...values, startDate: '2026-12-31' })); assert.throws(() => createContractsTasksEditor({ entity: contractEntity, existing: renewal }));
});
test('transition editor requires fresh result/reason, exact dates and keeps untouched source CRLF', () => {
  const original = contract({ sourceReference: '  核對\r\n依據  ', documentReference: '合成文件', signedDate: '2026-09-20' });
  const editor = createContractsTasksTransitionEditor(contractEntity, original, 'active');
  assert.deepEqual(editor.buildPayload({ ...editor.initial, statusDate: '2026-09-21', sourceReference: '  核對\n依據  ' }), {
    status: 'active', statusDate: '2026-09-21', signedDate: '2026-09-20', documentReference: '合成文件', sourceReference: '  核對\r\n依據  '
  });
  const inProgress = task({ status: 'in_progress', statusDate: '2026-10-10' }), finish = createContractsTasksTransitionEditor(taskEntity, inProgress, 'completed');
  assert.throws(() => finish.buildPayload({ statusDate: '2026-10-11', result: ' ' }));
  assert.deepEqual(finish.buildPayload({ statusDate: '2026-10-11', result: '  合成完成\n說明  ' }), { status: 'completed', statusDate: '2026-10-11', result: '  合成完成\n說明  ' });
  assert.throws(() => finish.buildPayload({ statusDate: '2026-10-09', result: '合成結果' }));
});
test('ACK checks exact version identity and every business field; success status alone cannot close form', () => {
  const original = contract(), payload = { title: '合成新標題' }, item = { ...original, title: payload.title, version: 2 };
  assert.equal(checkContractsTasksRecord({ item }, { entity: contractEntity, orgId: meta.orgId, original, payload }), item);
  for (const changed of [{ version: 1 }, { orgId: 'foreign' }, { id: 'other' }, { note: 'silently changed' }, { startDate: '2026-10-02' }]) {
    assert.throws(() => checkContractsTasksRecord({ item: { ...item, ...changed } }, { entity: contractEntity, orgId: meta.orgId, original, payload }));
  }
});
test('explicit expiry compares inclusive saved dates but never changes current manual status', () => {
  const item = contract({ status: 'active' }), before = structuredClone(item);
  for (const [date, result] of [['2026-09-30', 'not_started'], ['2026-10-01', 'within_term'], ['2026-12-31', 'within_term'], ['2027-01-01', 'past_end']]) {
    assert.equal(contractExpiry(item, date), result); assert.equal(contractExpiryForDisplay(item, date), result);
  }
  assert.equal(contractExpiry(item, '2026-10-01\n'), null); assert.equal(contractExpiry(contract(), '2026-10-01'), 'not_active'); assert.deepEqual(item, before);
});
test('server closed current/history hide unknown keys, missing or foreign parents, cycles and non-own tasks', () => {
  const item = contract(), work = task(); assert.ok(contractsTasksVisible(null, manager, contractEntity, item, get));
  assert.equal(contractsTasksVisible(null, manager, contractEntity, { ...item, extra: [] }, get), false);
  assert.equal(contractsTasksVisible(null, manager, contractEntity, { ...item, caseId: 'foreign' }, get), false);
  assert.equal(contractsTasksVisible(null, manager, contractEntity, { ...item, renewedFromId: item.id }, get), false);
  assert.equal(contractsTasksHistoryVisible(null, manager, contractEntity, { ...item, number: 'bad' }, item, get), false);
  const own = { ...manager, role: 'caregiver', employeeId: work.assigneeEmployeeId };
  assert.ok(contractsTasksVisible(null, own, taskEntity, work, get)); assert.equal(contractsTasksVisible(null, { ...own, employeeId: 'synthetic-second' }, taskEntity, work, get), false);
  assert.equal(contractsTasksHistoryVisible(null, own, taskEntity, { ...work, assigneeEmployeeId: 'synthetic-second' }, work, get), false);
});
test('server contract and task validation enforces initial/terminal states and manager-only writes', () => {
  assert.doesNotThrow(() => validate(contractEntity, contract())); assert.doesNotThrow(() => validate(taskEntity, task()));
  const active = contract({ status: 'active', signedDate: '2026-09-20', statusDate: '2026-09-21', documentReference: '合成文件', sourceReference: '合成依據' });
  assert.doesNotThrow(() => validate(contractEntity, active, contract()));
  assert.throws(() => validate(contractEntity, { ...active, note: 'cannot edit' }, active), { status: 409 });
  assert.throws(() => validate(contractEntity, { ...active, status: 'expired', statusDate: '2026-12-31', statusReason: '合成到期' }, active), { status: 422 });
  const done = task({ status: 'completed', statusDate: '2026-10-11', result: '合成完成' });
  assert.throws(() => validate(taskEntity, done, task()), { status: 409 });
  assert.throws(() => validate(taskEntity, { ...done, note: 'edit' }, done), { status: 409 });
  for (const role of ['finance', 'caregiver']) assert.throws(() => guardContractsTasksAccess(taskEntity, { ...manager, role }, false, fail), { status: 403 });
});
test('server transition hook prevents omitted or reused reason and result with no inferred operation date', () => {
  assert.throws(() => assertContractsTasksTransitionPayload(contractEntity, { status: 'terminated', statusDate: '2026-10-10' }, fail), { status: 422 });
  assert.throws(() => assertContractsTasksTransitionPayload(taskEntity, { status: 'completed', result: '合成完成' }, fail), { status: 422 });
  assert.doesNotThrow(() => assertContractsTasksTransitionPayload(taskEntity, { status: 'completed', statusDate: '2026-10-10', result: '合成完成' }, fail));
});
test('malformed parent JSON and corrupt existing contract rows fail closed without skipping renewal or number reservation', () => {
  const brokenGet = () => { throw new SyntaxError('SYNTHETIC invalid JSON'); };
  assert.throws(() => validateContractsTasks(null, manager, contractEntity, business(contract()), undefined, fail, () => true, () => [], brokenGet), { status: 422 });
  assert.throws(() => validateContractsTasks(null, manager, contractEntity, business(contract()), undefined, fail, () => true, () => { throw new SyntaxError('SYNTHETIC invalid JSON'); }, get), { status: 409 });
  assert.throws(() => validateContractsTasks(null, manager, contractEntity, business(contract()), undefined, fail, () => true, () => [{ ...contract(), unknown: {} }], get), { status: 409 });
});
test('strict explicit date query rejects missing pairs, backwards/oversized dates, LF paging, unknown and duplicate fields', () => {
  for (const query of ['page=1%0A', 'pageSize=25%0A', 'asOf=2026-10-10%0A', 'expiry=past_end', 'expiryFrom=2026-10-10', 'expiryFrom=2026-10-11&expiryTo=2026-10-10',
    'expiryFrom=2026-01-01&expiryTo=2027-01-02', 'q=x&q=y', 'secret=x', 'status=active&status=active']) assert.throws(() => contractsTasksQuery(contractEntity, new URLSearchParams(query), fail), { status: 422 });
  assert.equal(contractsTasksQuery(contractEntity, new URLSearchParams('asOf=2026-10-10&expiry=past_end&expiryFrom=2026-01-01&expiryTo=2027-01-01'), fail).expiryTo, '2027-01-01');
  assert.throws(() => contractsTasksQuery(taskEntity, new URLSearchParams('dueFrom=2026-10-10'), fail), { status: 422 });
  assert.throws(() => contractsTasksQuery(contractEntity, new URLSearchParams('q=x'), fail, 'single'), { status: 422 });
});
