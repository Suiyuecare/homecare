import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPLOYEE_RECORD_INDEX_ENTITIES, employeeRecordIndexIdentity, employeeRecordIndexQuery,
  confirmEmployeeRecordIndex } from '../public/data/employee-record-index.js';

const query = (entity = 'employee-certifications', page = 1) => ({ ...employeeRecordIndexQuery(entity, page), orgId: 'org-a', employeeId: 'e-1' });
const row = (id = 'a-1', entity = 'employee-certifications') => ({ entity, id, orgId: 'org-a', employeeId: 'e-1', version: 1, updatedAt: 'raw\r\nnot-a-date' });
const response = (items = [row()], extra = {}) => ({ items, total: items.length, page: 1, pageSize: 25,
  entity: 'employee-certifications', orgId: 'org-a', employeeId: 'e-1', ...extra });
const reject = (value, requested = query()) => assert.throws(() => confirmEmployeeRecordIndex(value, requested),
  error => error.code === 'EMPLOYEE_RECORD_INDEX_UNCONFIRMED' && error.message === '紀錄索引回應無法確認；請重新讀取。');

test('all three current personnel record kinds confirm metadata only and preserve raw timestamp text', () => {
  for (const { value } of EMPLOYEE_RECORD_INDEX_ENTITIES) {
    const saved = response([row('a-1', value)], { entity: value });
    assert.deepEqual(confirmEmployeeRecordIndex(saved, query(value)), saved);
  }
});

test('confirmed objects are fresh frozen copies; source mutation cannot replace displayed metadata', () => {
  const saved = response(), confirmed = confirmEmployeeRecordIndex(saved, query());
  assert.notStrictEqual(saved, confirmed); assert.notStrictEqual(saved.items, confirmed.items);
  assert.notStrictEqual(saved.items[0], confirmed.items[0]);
  saved.items[0].updatedAt = 'changed'; saved.items.push(row('a-2'));
  assert.equal(confirmed.items[0].updatedAt, 'raw\r\nnot-a-date'); assert.equal(confirmed.items.length, 1);
  assert.ok(Object.isFrozen(confirmed) && Object.isFrozen(confirmed.items) && Object.isFrozen(confirmed.items[0]));
});

test('null prototype and immutable data descriptors are valid JSON metadata containers', () => {
  const saved = Object.assign(Object.create(null), response([Object.freeze(Object.assign(Object.create(null), row()))]));
  assert.deepEqual(confirmEmployeeRecordIndex(Object.freeze(saved), query()).items[0], row());
});

test('full first page and exact last page counts are confirmed without dropping rows', () => {
  const items = Array.from({ length: 25 }, (_, index) => row(`a-${index.toString(16)}`));
  assert.equal(confirmEmployeeRecordIndex(response(items, { total: 26 }), query()).items.length, 25);
  assert.equal(confirmEmployeeRecordIndex(response([row('b-1')], { total: 26, page: 2 }), query('employee-certifications', 2)).items.length, 1);
  reject(response(items.slice(0, 24), { total: 26 }));
  reject(response([], { total: 26, page: 2 }), query('employee-certifications', 2));
});

test('zero records and out of range empty pages remain valid for canonical page correction', () => {
  assert.equal(confirmEmployeeRecordIndex(response([]), query()).total, 0);
  assert.equal(confirmEmployeeRecordIndex(response([], { total: 1, page: 3 }), query('employee-certifications', 3)).page, 3);
  reject(response([row()], { total: 1, page: 3 }), query('employee-certifications', 3));
});

test('request echoes and every row entity, organization and parent must match exactly', () => {
  for (const [key, value] of [['entity', 'employee-training'], ['orgId', 'org-b'], ['employeeId', 'e-2'], ['page', 2], ['pageSize', 100]])
    reject(response([row()], { [key]: value }));
  for (const [key, value] of [['entity', 'employee-training'], ['orgId', 'org-b'], ['employeeId', 'e-2']])
    reject(response([{ ...row(), [key]: value }]));
});

test('the exact envelope and row whitelist reject missing or additional business fields', () => {
  for (const key of Object.keys(response())) { const saved = response(); delete saved[key]; reject(saved); }
  for (const key of Object.keys(row())) { const item = row(); delete item[key]; reject(response([item])); }
  reject({ ...response(), audit: 'private' });
  reject(response([{ ...row(), note: 'private' }]));
  reject(response([{ ...row(), employeeName: 'private' }]));
  reject(response([{ ...row(), status: 'active' }]));
  reject(response([{ ...row(), caseId: 'ca-1' }]));
});

test('version, total and pagination numbers require safe integral values and exact fixed page size', () => {
  for (const version of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) reject(response([{ ...row(), version }]));
  for (const total of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) reject(response([row()], { total }));
  for (const page of [0, -1, 1.5, '1', Infinity]) reject(response(), { ...query(), page });
  for (const pageSize of [0, 24, 100, '25']) reject(response(), { ...query(), pageSize });
  assert.equal(confirmEmployeeRecordIndex(response([{ ...row(), version: Number.MAX_SAFE_INTEGER }]), query()).items[0].version, Number.MAX_SAFE_INTEGER);
});

test('history compatible lowercase hex and hyphen IDs have no guessed UUID shape or length bound', () => {
  const id = 'a'.repeat(2048) + '-b';
  assert.equal(confirmEmployeeRecordIndex(response([row(id)]), query()).items[0].id, id);
  assert.equal(confirmEmployeeRecordIndex(response([row('-')]), query()).items[0].id, '-');
  for (const id of ['', ' A1', 'a1 ', 'A1', 'zz', 'a/1', null, 1]) reject(response([row(id)]));
  for (const employeeId of ['', 'E-1', 'e/1', ' e-1']) reject(response(), { ...query(), employeeId });
});

test('duplicate IDs cannot hide a missing record in a confirmed page', () => {
  reject(response([row(), row()], { total: 2 }));
});

test('raw updatedAt may be empty, multiline or invalid time but never coerces a typed value', () => {
  for (const updatedAt of ['', '0000-00-00', ' 原文\r\n末句\n', '<img src=x onerror=alert(1)>'])
    assert.equal(confirmEmployeeRecordIndex(response([{ ...row(), updatedAt }]), query()).items[0].updatedAt, updatedAt);
  for (const updatedAt of [null, undefined, 0, false, [], {}, new Date()]) reject(response([{ ...row(), updatedAt }]));
});

test('unreturned creation order is not inferred from updatedAt or record ID', () => {
  const items = [{ ...row('f-2'), updatedAt: '1' }, { ...row('a-1'), updatedAt: '9999' }];
  assert.deepEqual(confirmEmployeeRecordIndex(response(items), query()).items, items);
});

test('envelope, row, requested and array accessors are rejected without invoking them', () => {
  let calls = 0;
  const getter = () => { calls++; return 'hidden'; };
  const saved = response(); Object.defineProperty(saved, 'total', { enumerable: true, get: getter }); reject(saved);
  const item = row(); Object.defineProperty(item, 'updatedAt', { enumerable: true, get: getter }); reject(response([item]));
  const requested = query(); Object.defineProperty(requested, 'orgId', { enumerable: true, get: getter }); reject(response(), requested);
  const items = [row()]; Object.defineProperty(items, '0', { enumerable: true, get: getter }); reject(response(items));
  assert.equal(calls, 0);
});

test('hidden or symbol fields cannot pass the closed metadata projection', () => {
  const hidden = response(); Object.defineProperty(hidden, 'secret', { value: 'private' }); reject(hidden);
  const symbol = row(); symbol[Symbol('private')] = 'secret'; reject(response([symbol]));
  const nonenum = row(); Object.defineProperty(nonenum, 'updatedAt', { enumerable: false }); reject(response([nonenum]));
});

test('sparse, decorated, subclass and cyclic containers are never accepted as wire metadata', () => {
  reject(response(new Array(1), { total: 1 }));
  const items = [row()]; items.note = 'private'; reject(response(items));
  class Rows extends Array {} reject(response(new Rows(row())));
  class Record {} reject(response([Object.assign(new Record(), row())]));
  const cycle = response(); cycle.items[0].updatedAt = cycle; reject(cycle);
  reject(response([{ ...row(), updatedAt: 1n }]));
});

test('requested scope is itself exact and cannot gain business or unsafe identity fields', () => {
  reject(response(), { ...query(), status: 'active' });
  reject(response(), { ...query(), orgId: '   ' });
  reject(response(), { ...query(), entity: 'cases' });
  const requested = query(); delete requested.employeeId; reject(response(), requested);
});

test('query builder accepts exactly the three personnel kinds and positive safe page while always fixing 25', () => {
  for (const { value } of EMPLOYEE_RECORD_INDEX_ENTITIES) assert.deepEqual(employeeRecordIndexQuery(value, 2), { entity: value, page: 2, pageSize: 25 });
  for (const entity of ['', 'cases', ' employee-certifications', null, {}]) assert.throws(() => employeeRecordIndexQuery(entity));
  for (const page of [0, -1, 1.1, '2', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => employeeRecordIndexQuery('employee-certifications', page));
});

test('primitive context identity survives nested reference replacement and distinguishes each authorization value', () => {
  const context = { user: { id: 'user:a', employeeId: 'employee:a' }, organizationId: 'org:a', role: 'supervisor' };
  const identity = employeeRecordIndexIdentity(context);
  assert.equal(employeeRecordIndexIdentity({ ...context, user: { ...context.user }, organizations: [] }), identity);
  for (const changed of [
    { ...context, user: { ...context.user, id: 'user:b' } },
    { ...context, user: { ...context.user, employeeId: 'employee:b' } },
    { ...context, organizationId: 'org:b' }, { ...context, role: 'admin' },
  ]) assert.notEqual(employeeRecordIndexIdentity(changed), identity);
  assert.equal(employeeRecordIndexIdentity({}), '[null,null,null,null]');
  assert.notEqual(employeeRecordIndexIdentity({ user: { id: '' } }), employeeRecordIndexIdentity({}));
});


test('more than 25 rows or an uncounted array property cannot be presented as a full page', () => {
  const rows = Array.from({ length: 26 }, (_, index) => row(`a-${index.toString(16)}`));
  reject(response(rows));
  const decorated = [row()]; Object.defineProperty(decorated, Symbol('hidden'), { value: 'private' });
  reject(response(decorated));
});


test('inherited identities cannot stand in for owned employee metadata', () => {
  const item = Object.assign(Object.create({ employeeId: 'e-1' }), row());
  delete item.employeeId; reject(response([item]));
  const requested = Object.assign(Object.create({ employeeId: 'e-1' }), query());
  delete requested.employeeId; reject(response(), requested);
});
