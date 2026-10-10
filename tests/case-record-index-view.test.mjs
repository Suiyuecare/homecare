import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_RECORD_INDEX_ENTITIES, caseRecordIndexIdentity, caseRecordIndexQuery,
  confirmCaseRecordIndex } from '../public/data/case-record-index.js';

const query = (entity = 'care-plans', page = 1) => ({ ...caseRecordIndexQuery(entity, page), orgId: 'org-a', caseId: 'ca-1' });
const row = (id = 'a-1', entity = 'care-plans') => ({ entity, id, orgId: 'org-a', caseId: 'ca-1', version: 1, updatedAt: 'raw\r\nnot-a-date' });
const response = (items = [row()], extra = {}) => ({ items, total: items.length, page: 1, pageSize: 25,
  entity: 'care-plans', orgId: 'org-a', caseId: 'ca-1', ...extra });
const reject = (value, requested = query()) => assert.throws(() => confirmCaseRecordIndex(value, requested),
  error => error.code === 'CASE_RECORD_INDEX_UNCONFIRMED' && error.message === '紀錄索引回應無法確認；請重新讀取。');

test('all four current record kinds confirm metadata only and preserve raw timestamp text', () => {
  for (const { value } of CASE_RECORD_INDEX_ENTITIES) {
    const saved = response([row('a-1', value)], { entity: value });
    assert.deepEqual(confirmCaseRecordIndex(saved, query(value)), saved);
  }
});

test('confirmed objects are fresh frozen copies; source mutation cannot replace displayed metadata', () => {
  const saved = response(), confirmed = confirmCaseRecordIndex(saved, query());
  assert.notStrictEqual(saved, confirmed); assert.notStrictEqual(saved.items, confirmed.items);
  assert.notStrictEqual(saved.items[0], confirmed.items[0]);
  saved.items[0].updatedAt = 'changed'; saved.items.push(row('a-2'));
  assert.equal(confirmed.items[0].updatedAt, 'raw\r\nnot-a-date'); assert.equal(confirmed.items.length, 1);
  assert.ok(Object.isFrozen(confirmed) && Object.isFrozen(confirmed.items) && Object.isFrozen(confirmed.items[0]));
});

test('null prototype and immutable data descriptors are valid JSON metadata containers', () => {
  const saved = Object.assign(Object.create(null), response([Object.freeze(Object.assign(Object.create(null), row()))]));
  assert.deepEqual(confirmCaseRecordIndex(Object.freeze(saved), query()).items[0], row());
});

test('full first page and exact last page counts are confirmed without dropping rows', () => {
  const items = Array.from({ length: 25 }, (_, index) => row(`a-${index.toString(16)}`));
  assert.equal(confirmCaseRecordIndex(response(items, { total: 26 }), query()).items.length, 25);
  assert.equal(confirmCaseRecordIndex(response([row('b-1')], { total: 26, page: 2 }), query('care-plans', 2)).items.length, 1);
  reject(response(items.slice(0, 24), { total: 26 }));
  reject(response([], { total: 26, page: 2 }), query('care-plans', 2));
});

test('zero records and out of range empty pages remain valid for canonical page correction', () => {
  assert.equal(confirmCaseRecordIndex(response([]), query()).total, 0);
  assert.equal(confirmCaseRecordIndex(response([], { total: 1, page: 3 }), query('care-plans', 3)).page, 3);
  reject(response([row()], { total: 1, page: 3 }), query('care-plans', 3));
});

test('request echoes and every row entity, organization and parent must match exactly', () => {
  for (const [key, value] of [['entity', 'shifts'], ['orgId', 'org-b'], ['caseId', 'ca-2'], ['page', 2], ['pageSize', 100]])
    reject(response([row()], { [key]: value }));
  for (const [key, value] of [['entity', 'shifts'], ['orgId', 'org-b'], ['caseId', 'ca-2']])
    reject(response([{ ...row(), [key]: value }]));
});

test('the exact envelope and row whitelist reject missing or additional business fields', () => {
  for (const key of Object.keys(response())) { const saved = response(); delete saved[key]; reject(saved); }
  for (const key of Object.keys(row())) { const item = row(); delete item[key]; reject(response([item])); }
  reject({ ...response(), audit: 'private' });
  reject(response([{ ...row(), note: 'private' }]));
  reject(response([{ ...row(), answers: { hidden: 'private' } }]));
});

test('version, total and pagination numbers require safe integral values and exact fixed page size', () => {
  for (const version of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) reject(response([{ ...row(), version }]));
  for (const total of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) reject(response([row()], { total }));
  for (const page of [0, -1, 1.5, '1', Infinity]) reject(response(), { ...query(), page });
  for (const pageSize of [0, 24, 100, '25']) reject(response(), { ...query(), pageSize });
  assert.equal(confirmCaseRecordIndex(response([{ ...row(), version: Number.MAX_SAFE_INTEGER }]), query()).items[0].version, Number.MAX_SAFE_INTEGER);
});

test('history compatible lowercase hex and hyphen IDs have no guessed UUID shape or length bound', () => {
  const id = 'a'.repeat(2048) + '-b';
  assert.equal(confirmCaseRecordIndex(response([row(id)]), query()).items[0].id, id);
  assert.equal(confirmCaseRecordIndex(response([row('-')]), query()).items[0].id, '-');
  for (const id of ['', ' A1', 'a1 ', 'A1', 'zz', 'a/1', null, 1]) reject(response([row(id)]));
  for (const caseId of ['', 'CA-1', 'ca/1', ' ca-1']) reject(response(), { ...query(), caseId });
});

test('duplicate IDs cannot hide a missing record in a confirmed page', () => {
  reject(response([row(), row()], { total: 2 }));
});

test('raw updatedAt may be empty, multiline or invalid time but never coerces a typed value', () => {
  for (const updatedAt of ['', '0000-00-00', ' 原文\r\n末句\n', '<img src=x onerror=alert(1)>'])
    assert.equal(confirmCaseRecordIndex(response([{ ...row(), updatedAt }]), query()).items[0].updatedAt, updatedAt);
  for (const updatedAt of [null, undefined, 0, false, [], {}, new Date()]) reject(response([{ ...row(), updatedAt }]));
});

test('unreturned creation order is not inferred from updatedAt or record ID', () => {
  const items = [{ ...row('f-2'), updatedAt: '1' }, { ...row('a-1'), updatedAt: '9999' }];
  assert.deepEqual(confirmCaseRecordIndex(response(items), query()).items, items);
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
  const requested = query(); delete requested.caseId; reject(response(), requested);
});

test('query builder accepts exactly the four kinds and positive safe page while always fixing 25', () => {
  for (const { value } of CASE_RECORD_INDEX_ENTITIES) assert.deepEqual(caseRecordIndexQuery(value, 2), { entity: value, page: 2, pageSize: 25 });
  for (const entity of ['', 'cases', ' care-plans', null, {}]) assert.throws(() => caseRecordIndexQuery(entity));
  for (const page of [0, -1, 1.1, '2', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => caseRecordIndexQuery('care-plans', page));
});

test('primitive context identity survives nested reference replacement and distinguishes each authorization value', () => {
  const context = { user: { id: 'user:a', employeeId: 'employee:a' }, organizationId: 'org:a', role: 'supervisor' };
  const identity = caseRecordIndexIdentity(context);
  assert.equal(caseRecordIndexIdentity({ ...context, user: { ...context.user }, organizations: [] }), identity);
  for (const changed of [
    { ...context, user: { ...context.user, id: 'user:b' } },
    { ...context, user: { ...context.user, employeeId: 'employee:b' } },
    { ...context, organizationId: 'org:b' }, { ...context, role: 'admin' },
  ]) assert.notEqual(caseRecordIndexIdentity(changed), identity);
  assert.equal(caseRecordIndexIdentity({}), '[null,null,null,null]');
  assert.notEqual(caseRecordIndexIdentity({ user: { id: '' } }), caseRecordIndexIdentity({}));
});
