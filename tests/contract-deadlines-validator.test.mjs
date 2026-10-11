import test from 'node:test';
import assert from 'node:assert/strict';
import { contractDeadlineDefaults } from '../public/data/contract-deadline-editor.js';
import { contractDeadlineEntities, guardContractDeadlineAccess, normalizeContractDeadlinePayload, assertContractDeadlinePayload, validateContractDeadline,
  contractDeadlineVisible, contractDeadlineHistoryVisible, contractDeadlineQuery, assertContractDeadlineQueryTarget, filterContractDeadlines } from '../src/server/contract-deadlines.mjs';
const entity = 'contract-deadline-reminders', ctx = { role: 'admin', orgId: 'org-1', user: { id: 'user-1' } };
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
function fixture() {
  const parent = { id: 'contract-1', orgId: 'org-1', version: 2, caseId: 'case-1', number: 'C01', title: '來源契約', startDate: '2026-10-01', endDate: '2026-12-31', status: 'active' };
  const employee = { id: 'employee-1', orgId: 'org-1', status: 'active' }, list = [];
  const get = (_db, org, name, id) => org !== 'org-1' ? null : name === 'case-contracts' && parent.id === id ? parent : name === 'employees' && employee.id === id ? employee : null;
  const visible = (_db, context, _entity, value) => value.orgId === context.orgId && ['active', 'terminated', 'expired'].includes(value.status) && value.caseId === 'case-1';
  const rows = () => list;
  const db = { prepare: () => ({ setReadBigInts() {}, get: () => ({ n: BigInt(list.length) }) }) };
  const draft = fields => ({ contractId: parent.id, contractVersion: parent.version, title: '人工提醒', content: '  人工工作\r\n尾行  ', assigneeEmployeeId: employee.id, dueDate: '2026-12-10', ...contractDeadlineDefaults, ...fields });
  const validate = (data, old) => validateContractDeadline(db, ctx, entity, data, old, fail, rows, get, visible);
  const save = fields => { const data = draft(fields); validate(data); const item = { ...data, id: 'reminder-' + list.length, orgId: ctx.orgId, version: 1, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }; list.push(item); return item; };
  return { parent, employee, list, get, visible, rows, draft, validate, save };
}
test('entity hook advertises thirteen closed fields, derived source and only manager roles', () => {
  assert.equal(contractDeadlineEntities[entity].fields.split(' ').length, 13);
  for (const role of ['finance', 'caregiver']) assert.throws(() => guardContractDeadlineAccess(entity, { ...ctx, role }, true, fail), error => error.status === 403);
  guardContractDeadlineAccess(entity, { ...ctx, role: 'supervisor' }, false, fail);
  const raw = { title: ' 標題 ', content: '  工作\r\n結尾  ', note: '  備註  ' }, normalized = normalizeContractDeadlinePayload(entity, raw); assert.equal(normalized.title, '標題'); assert.equal(normalized.content, raw.content); assert.equal(normalized.note, raw.note);
  assert.throws(() => assertContractDeadlinePayload(entity, { contractSnapshot: {} }, fail), error => error.status === 422);
  assert.throws(() => assertContractDeadlinePayload(entity, {}, fail), error => error.status === 422);
  for (const value of ['2', 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => assertContractDeadlinePayload(entity, { contractVersion: value }, fail));
});
test('new reminder captures exact active source version, source conflict and open duplicate fail closed', () => {
  const f = fixture(), item = f.save(); assert.equal(item.contractSnapshot.version, 2); assert.equal(item.contractSnapshot.endDate, f.parent.endDate);
  assert.throws(() => f.validate(f.draft()), error => error.code === 'OPEN_REMINDER_EXISTS');
  assert.throws(() => f.validate(f.draft({ contractVersion: 1 })), error => error.code === 'SOURCE_VERSION_CONFLICT');
  f.parent.status = 'terminated'; assert.throws(() => f.validate(f.draft()), error => error.code === 'SOURCE_NOT_ACTIVE');
  assert(contractDeadlineVisible(null, ctx, entity, item, f.get, f.visible)); f.parent.version = 3; assert(contractDeadlineVisible(null, ctx, entity, item, f.get, f.visible));
  const data = { ...item }; delete data.id; delete data.orgId; delete data.version; delete data.createdAt; delete data.updatedAt;
  data.title = '終止後仍人工處理'; f.validate(data, item); assert.equal(data.contractSnapshot.version, 2);
});
test('transition hooks require current result/date; lifecycle freezes source and terminal content', () => {
  const f = fixture(), item = f.save(), business = Object.fromEntries(contractDeadlineEntities[entity].fields.split(' ').map(key => [key, item[key]]));
  assert.throws(() => assertContractDeadlinePayload(entity, { status: 'completed', statusDate: '2026-12-01' }, fail, true));
  assert.throws(() => f.validate({ ...business, status: 'completed', statusDate: '2026-12-01', result: '本次結果' }, item), error => error.status === 409);
  const progressData = { ...business, status: 'in_progress', statusDate: '2026-12-01' }; f.validate(progressData, item);
  const progress = { ...item, ...progressData, version: 2 }, finished = { ...progressData, status: 'completed', statusDate: '2026-12-02', result: '  本次結果\r\n依據  ' }; f.validate(finished, progress);
  assert.throws(() => f.validate({ ...finished, title: '違規改內容' }, progress), error => error.code === 'REMINDER_LOCKED');
  const complete = { ...progress, ...finished, version: 3 }; assert.throws(() => f.validate({ ...finished, note: 'edit' }, complete), error => error.status === 409);
  assert.throws(() => f.validate({ ...progressData, contractSnapshot: { ...item.contractSnapshot, number: 'other' } }, item), error => error.code === 'REMINDER_SOURCE_LOCKED');
});
test('same-org parent/employee, closed snapshots and source integrity gate current/history and writes', () => {
  const f = fixture(), item = f.save();
  assert(contractDeadlineVisible(null, ctx, entity, item, f.get, f.visible)); assert(contractDeadlineHistoryVisible(null, ctx, entity, item, item, f.get, f.visible));
  assert(!contractDeadlineVisible(null, { ...ctx, role: 'finance' }, entity, item, f.get, f.visible));
  for (const snapshot of [{ ...item.contractSnapshot, unknown: { private: true } }, { ...item.contractSnapshot, caseId: 'foreign' }]) assert(!contractDeadlineVisible(null, ctx, entity, { ...item, contractSnapshot: snapshot }, f.get, f.visible));
  f.employee.orgId = 'foreign'; assert(!contractDeadlineVisible(null, ctx, entity, item, f.get, f.visible)); f.employee.orgId = ctx.orgId;
  f.parent.caseId = 'foreign'; assert(!contractDeadlineVisible(null, ctx, entity, item, f.get, f.visible));
  assert.throws(() => f.validate({ ...f.draft(), contractSnapshot: item.contractSnapshot }, item), error => error.status === 404);
});
test('asOf is explicit, filters bounded and duplicate/unknown/CRLF/foreign query targets rejected', () => {
  const f = fixture();
  for (const raw of ['', 'asOf=2026-12-10%0A', 'asOf=2026-12-10&page=1%0A', 'asOf=2026-12-10&pageSize=101', 'asOf=2026-12-10&asOf=2026-12-11', 'asOf=2026-12-10&unknown=x', 'asOf=2026-12-10&dueFrom=2026-01-01', 'asOf=2026-12-10&dueFrom=2026-01-01&dueTo=2027-01-02', 'asOf=2026-12-10&workState=legal_expired'])
    assert.throws(() => contractDeadlineQuery(entity, new URLSearchParams(raw), fail), error => error.status === 422, raw);
  assert.throws(() => contractDeadlineQuery(entity, new URLSearchParams('asOf=2026-12-10'), fail, 'single'));
  const query = contractDeadlineQuery(entity, new URLSearchParams('asOf=2026-12-10&workState=on_due&dueFrom=2026-12-01&dueTo=2026-12-31'), fail); assert.equal(query.pageSize, 25);
  assert.deepEqual(contractDeadlineQuery(entity, new URLSearchParams('compare=previous'), fail, 'history'), { page: 1, pageSize: 25, q: '', compare: 'previous' });
  assert.throws(() => assertContractDeadlineQueryTarget(null, ctx, entity, { contractId: 'foreign' }, fail, f.get, f.visible), error => error.status === 404);
});
test('worklist searches business text, sorts manual due dates and never searches org or employee identifiers', () => {
  const f = fixture(), item = f.save(), second = { ...item, id: 'reminder-2', dueDate: '2026-12-09', status: 'in_progress', statusDate: '2026-12-01' }, query = { asOf: '2026-12-10', q: '' };
  const saved = structuredClone([item, second]); assert.deepEqual(filterContractDeadlines(entity, [item, second], query).map(row => row.id), [second.id, item.id]);
  assert.equal(filterContractDeadlines(entity, [item, second], { ...query, workState: 'past_due' })[0].id, second.id);
  assert.equal(filterContractDeadlines(entity, [item], { ...query, q: 'C01' }).length, 1); assert.equal(filterContractDeadlines(entity, [item], { ...query, q: item.orgId }).length, 0);
  assert.deepEqual([item, second], saved); const malformed = { ...item, unknown: {} }; f.list.push(malformed); assert.throws(() => f.validate(f.draft()), error => error.code === 'REMINDER_DATA_INVALID');
});
