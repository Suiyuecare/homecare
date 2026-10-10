import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERVIEW_RECORD_FIELDS, isInterviewRecordDetailsId, interviewRecordDetailsIdentity,
  confirmInterviewRecordDetails } from '../public/data/interview-record-details.js';
import { getHistoryFields } from '../public/data/history-fields.js';

const id = 'abcdef12-3456-7890-abcd-ef1234567890', orgId = 'synthetic-interview-org';
const expected = () => ({ id, orgId });
const record = extra => ({ id, orgId, version: 4, createdAt: '保存建立時間\r\n0000', updatedAt: '原更新文字\n未轉時區',
  name: '合成面試者', phone: '合成電話', interviewDate: '2026-10-10', city: '', district: '',
  interviewContent: '合成內容', note: '', status: 'inactive', ...extra });
const confirm = item => confirmInterviewRecordDetails({ item }, expected());
const field = (result, key) => result.fields.find(item => item.key === key);
const unconfirmed = error => error.code === 'INTERVIEW_RECORD_DETAILS_UNCONFIRMED'
  && error.message === '面試紀錄回應無法確認；請重新讀取。';

test('eight field labels preserve the existing interview contract and are immutable', () => {
  const contract = [
    ['name', '姓名'], ['phone', '電話'], ['interviewDate', '面試日期'], ['city', '縣市'],
    ['district', '鄉鎮區'], ['interviewContent', '面試內容'], ['note', '備註'], ['status', '名單狀態'],
  ];
  assert.deepEqual(INTERVIEW_RECORD_FIELDS.map(item => [item.key, item.label]), contract);
  assert.deepEqual(getHistoryFields('interview-applicants').map(item => [item.key, item.label]), contract);
  assert(Object.isFrozen(INTERVIEW_RECORD_FIELDS));
  assert(INTERVIEW_RECORD_FIELDS.every(Object.isFrozen));
  assert.throws(() => { INTERVIEW_RECORD_FIELDS[0].label = 'changed'; }, TypeError);
});

test('route IDs use the existing route grammar without inventing UUID requirements', () => {
  for (const value of [id, 'a', 'f--012', '--']) assert.equal(isInterviewRecordDetailsId(value), true);
  for (const value of ['', 'ABC123', ' abc', 'abc ', 'abc\n', 'abc/def', 'xyz', null, 123, {}, []])
    assert.equal(isInterviewRecordDetailsId(value), false);
});

test('identity includes all four authorization primitives and nullish organization fallback', () => {
  assert.equal(interviewRecordDetailsIdentity(undefined), '[null,null,null,null]');
  assert.equal(interviewRecordDetailsIdentity({ user: { id: 'u', employeeId: 'e' }, orgId: 'o', role: 'admin' }), '["u","o","admin","e"]');
  assert.equal(interviewRecordDetailsIdentity({ user: { id: '', employeeId: '' }, organizationId: '', orgId: 'fallback', role: '' }), '["","","",""]');
  assert.equal(interviewRecordDetailsIdentity({ organizationId: null, orgId: 'fallback' }), '[null,"fallback",null,null]');
});

test('nested references are irrelevant to primitive identity but each authorization change matters', () => {
  const context = { user: { id: 'u', employeeId: 'e' }, organizationId: 'o', role: 'supervisor' };
  const baseline = interviewRecordDetailsIdentity(context);
  assert.equal(interviewRecordDetailsIdentity({ ...context, user: { ...context.user }, ignored: { another: 'reference' } }), baseline);
  for (const changed of [{ ...context, user: { ...context.user, id: 'other' } }, { ...context, organizationId: 'other' },
    { ...context, role: 'finance' }, { ...context, user: { ...context.user, employeeId: 'other' } }])
    assert.notEqual(interviewRecordDetailsIdentity(changed), baseline);
});

test('fresh versions and arbitrary saved timestamps are preserved without parsing or row-version comparison', () => {
  const source = record({ version: 9, createdAt: '', updatedAt: '  0000-00-00\r\n保存時間不是ISO  ' });
  const result = confirm(source);
  assert.equal(result.version, 9);
  assert.equal(result.createdAt, '');
  assert.equal(result.updatedAt, source.updatedAt);
  assert.equal(field(result, 'status').text, 'inactive');
  assert.deepEqual(Object.keys(result), ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'fields']);
});

test('safe maximum version is valid for reading; metadata types and scope must be exact', () => {
  assert.equal(confirm(record({ version: Number.MAX_SAFE_INTEGER })).version, Number.MAX_SAFE_INTEGER);
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '4', null, undefined])
    assert.throws(() => confirm(record({ version })), unconfirmed);
  for (const changed of [{ id: 'different-id' }, { orgId: 'foreign-org' }, { id: id.toUpperCase() },
    { createdAt: null }, { updatedAt: 123 }, { createdAt: undefined }, { updatedAt: {} }])
    assert.throws(() => confirm(record(changed)), unconfirmed);
});

test('null-prototype envelope, requested identity and record remain valid plain data', () => {
  const result = confirmInterviewRecordDetails(Object.assign(Object.create(null), { item: Object.assign(Object.create(null), record()) }),
    Object.assign(Object.create(null), expected()));
  assert.equal(result.id, id);
  assert.equal(field(result, 'name').text, '合成面試者');
});

test('outer response is closed and rejects inherited, hidden, symbolic or accessor item without invoking it', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'item', { enumerable: true, get() { calls++; return record(); } });
  const hidden = Object.defineProperty({}, 'item', { value: record(), enumerable: false });
  const symbolic = { item: record(), [Symbol('extra')]: 'not allowed' };
  for (const response of [null, [], 'not object', {}, { item: record(), extra: true }, Object.create({ item: record() }), hidden, accessor, symbolic])
    assert.throws(() => confirmInterviewRecordDetails(response, expected()), unconfirmed);
  assert.equal(calls, 0);
});

test('requested identity is exact data and cannot hide scope-changing extras or accessors', () => {
  let calls = 0;
  const accessor = Object.defineProperty({ orgId }, 'id', { enumerable: true, get() { calls++; return id; } });
  const hidden = Object.defineProperty({ orgId }, 'id', { value: id, enumerable: false });
  for (const requested of [{}, { id }, { orgId }, { id, orgId, version: 4 }, { id, orgId: '' }, { id, orgId: '   ' },
    { id: 'not-route-id', orgId }, { id, orgId, [Symbol('extra')]: true }, accessor, hidden, Object.create(expected())])
    assert.throws(() => confirmInterviewRecordDetails({ item: record() }, requested), unconfirmed);
  assert.equal(calls, 0);
});

test('all five metadata properties must be own enumerable data descriptors', () => {
  let calls = 0;
  for (const key of ['id', 'orgId', 'version', 'createdAt', 'updatedAt']) {
    const missing = record(); delete missing[key];
    assert.throws(() => confirm(missing), unconfirmed);
    const hidden = record(); Object.defineProperty(hidden, key, { enumerable: false });
    assert.throws(() => confirm(hidden), unconfirmed);
    const accessor = record(); Object.defineProperty(accessor, key, { enumerable: true, get() { calls++; throw new Error('do not evaluate metadata'); } });
    assert.throws(() => confirm(accessor), unconfirmed);
  }
  assert.equal(calls, 0);
});

test('record must be a plain object rather than an array, class or inherited record', () => {
  class Record { constructor() { Object.assign(this, record()); } }
  for (const item of [null, [], new Record(), Object.create(record()), 'record']) assert.throws(() => confirm(item), unconfirmed);
});

test('known business accessors are rejected before any getter can execute', () => {
  let calls = 0;
  for (const { key } of INTERVIEW_RECORD_FIELDS) {
    const item = record();
    Object.defineProperty(item, key, { enumerable: true, get() { calls++; throw new Error('private known getter'); } });
    assert.throws(() => confirm(item), unconfirmed);
  }
  assert.equal(calls, 0);
});

test('unknown record fields are neither enumerated nor read, including getters and hidden symbols', () => {
  let calls = 0;
  const item = record();
  Object.defineProperty(item, 'unknownSecret', { enumerable: true, get() { calls++; throw new Error('private extra'); } });
  Object.defineProperty(item, Symbol('private'), { get() { calls++; throw new Error('symbol extra'); } });
  const descriptors = [];
  const guarded = new Proxy(item, {
    ownKeys() { throw new Error('item enumeration is forbidden'); },
    get() { throw new Error('direct raw item reads are forbidden'); },
    getOwnPropertyDescriptor(target, key) { descriptors.push(key); return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const result = confirm(guarded);
  assert.equal(result.fields.length, 8);
  assert.equal(calls, 0);
  assert(!descriptors.includes('unknownSecret'));
  assert(!JSON.stringify(result).includes('unknownSecret'));
});

test('own-presence tags distinguish missing, empty, null and non-text instead of filling defaults', () => {
  const item = record({ phone: '', interviewDate: null, city: 7, district: false, interviewContent: [], note: {} });
  delete item.name;
  const result = confirm(item);
  assert.deepEqual(field(result, 'name'), { key: 'name', label: '姓名', kind: 'missing', text: '未保存' });
  assert.deepEqual(field(result, 'phone'), { key: 'phone', label: '電話', kind: 'empty', text: '空白' });
  assert.equal(field(result, 'interviewDate').kind, 'null');
  assert.equal(field(result, 'interviewDate').text, '未提供（null）');
  for (const [key, type] of [['city', 'number'], ['district', 'boolean'], ['interviewContent', 'array'], ['note', 'object']]) {
    assert.equal(field(result, key).kind, 'non-text');
    assert.equal(field(result, key).text, `非文字值（${type}）`);
  }
});

test('absent business fields remain missing; own data presence is not inferred from enumerability', () => {
  const item = { id, orgId, version: 1, createdAt: '', updatedAt: '' };
  Object.defineProperty(item, 'note', { enumerable: false, value: '明確保存的資料描述元' });
  const result = confirm(item);
  assert.equal(result.fields.filter(entry => entry.kind === 'missing').length, 7);
  assert.equal(field(result, 'note').kind, 'text');
  assert.equal(field(result, 'note').text, '明確保存的資料描述元');
});

test('nested objects and arrays are represented only by type without serializing or coercing hidden content', () => {
  let calls = 0;
  const hidden = Object.defineProperties({}, {
    secret: { enumerable: true, get() { calls++; throw new Error('nested secret'); } },
    toJSON: { value() { calls++; throw new Error('do not serialize'); } },
    toString: { value() { calls++; throw new Error('do not coerce'); } },
  });
  const array = []; Object.defineProperty(array, '0', { enumerable: true, get() { calls++; throw new Error('nested array'); } });
  const result = confirm(record({ interviewContent: hidden, note: array }));
  assert.equal(field(result, 'interviewContent').text, '非文字值（object）');
  assert.equal(field(result, 'note').text, '非文字值（array）');
  assert(!JSON.stringify(result).includes('secret'));
  assert.equal(calls, 0);
});

test('literal HTML, old invalid dates and unknown status text remain exact text rather than markup or business inference', () => {
  const html = '  <script>globalThis.syntheticLeak = true</script>\r\n<img src=x onerror=syntheticLeak()>  ';
  const item = record({ interviewContent: html, interviewDate: '0000-99-99\r\n原日期', status: '  未辨識/新狀態\n原文  ' });
  const result = confirm(item);
  for (const key of ['interviewContent', 'interviewDate', 'status']) {
    assert.equal(field(result, key).kind, 'text');
    assert.equal(field(result, key).text, item[key]);
  }
  assert.equal(globalThis.syntheticLeak, undefined);
});

test('full strings retain both distant ends, whitespace, line endings and supplementary characters', () => {
  const content = '  合成全文首端\r\n' + '🌱長文'.repeat(6000) + '\r\n合成全文尾端  ';
  const note = '\t原備註首端\n' + '完整備註'.repeat(3000) + '\n原備註尾端\t';
  const result = confirm(record({ interviewContent: content, note }));
  assert.equal(field(result, 'interviewContent').text, content);
  assert.equal(field(result, 'note').text, note);
  assert(content.length > 10000);
});

test('confirmed projection is detached and recursively frozen without freezing or mutating input', () => {
  const nested = { secret: 'SYNTHETIC-HIDDEN' }, item = record({ note: nested });
  const result = confirm(item);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.fields)); assert(result.fields.every(Object.isFrozen));
  assert(!Object.isFrozen(item)); assert(!Object.isFrozen(nested));
  item.name = 'changed'; item.updatedAt = 'changed'; nested.secret = 'changed';
  assert.equal(field(result, 'name').text, '合成面試者');
  assert.equal(result.updatedAt, '原更新文字\n未轉時區');
  assert.equal(field(result, 'note').text, '非文字值（object）');
  assert.throws(() => { result.version = 99; }, TypeError);
  assert.throws(() => { result.fields.push({}); }, TypeError);
  assert.throws(() => { field(result, 'name').text = 'changed'; }, TypeError);
});

test('non-text values never leak a value or coerce it; malformed metadata errors contain no source payload', () => {
  let calls = 0;
  const fn = () => { calls++; throw new Error('do not call'); };
  for (const [value, type] of [[undefined, 'undefined'], [NaN, 'number'], [Infinity, 'number'], [1n, 'bigint'], [Symbol('SYNTHETIC-HIDDEN'), 'symbol'], [fn, 'function']])
    assert.equal(field(confirm(record({ note: value })), 'note').text, `非文字值（${type}）`);
  assert.equal(calls, 0);
  assert.throws(() => confirm(record({ orgId: 'SYNTHETIC-HIDDEN-PAYLOAD' })), error => unconfirmed(error)
    && !error.message.includes('SYNTHETIC-HIDDEN-PAYLOAD'));
});
