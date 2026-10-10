import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_ITEM_RECORD_FIELDS, isServiceItemRecordDetailsId, serviceItemRecordDetailsIdentity,
  confirmServiceItemRecordDetails } from '../public/data/service-item-record-details.js';
import { isSavedRecordDetailsId, savedRecordDetailsIdentity } from '../public/data/saved-record-details.js';
import { getHistoryFields } from '../public/data/history-fields.js';

const id = 'abc123-ef09', orgId = 'synthetic-service-item-details-org';
const requested = () => ({ id, orgId });
const record = extra => ({ id, orgId, version: 3, createdAt: '原保存建立文字\r\n不轉時區', updatedAt: '原保存更新文字\n0000',
  code: 'SYN-SERVICE-001', name: '合成服務名稱', minutes: 30, unitPriceCents: 1,
  validFrom: '0000-99-99', validTo: '不解析的日期', status: 'inactive', note: '合成原備註', ...extra });
const confirm = item => confirmServiceItemRecordDetails({ item }, requested());
const field = (result, key) => result.fields.find(value => value.key === key);
const projected = (item, key) => {
  const result = field(confirm(item), key);
  return { kind: result.kind, text: result.text };
};
const unconfirmed = error => error.code === 'SERVICE_ITEM_RECORD_DETAILS_UNCONFIRMED'
  && error.message === '服務項目紀錄回應無法確認；請重新讀取。';
const tag = type => `非文字值（${type}）`;

test('eight immutable labels and order agree with the saved service-item history contract', () => {
  const expected = [['code', '服務代碼'], ['name', '服務名稱'], ['minutes', '預設服務分鐘'],
    ['unitPriceCents', '測試單價（新臺幣元）'], ['validFrom', '有效起日'], ['validTo', '有效迄日'],
    ['status', '服務項目狀態'], ['note', '備註']];
  assert.deepEqual(SERVICE_ITEM_RECORD_FIELDS.map(value => [value.key, value.label]), expected);
  assert.deepEqual(getHistoryFields('service-items').map(value => [value.key, value.label]), expected);
  assert(Object.isFrozen(SERVICE_ITEM_RECORD_FIELDS)); assert(SERVICE_ITEM_RECORD_FIELDS.every(Object.isFrozen));
  assert.throws(() => { SERVICE_ITEM_RECORD_FIELDS[0].label = 'changed'; }, TypeError);
});

test('ID alias keeps the route grammar rather than inventing a UUID requirement', () => {
  assert.equal(isServiceItemRecordDetailsId, isSavedRecordDetailsId);
  for (const value of [id, 'a', '--', 'f--012']) assert(isServiceItemRecordDetailsId(value));
  for (const value of ['', 'ABC', ' abc', 'abc ', 'abc\n', 'abc/def', 'xyz', null, 1, {}, []])
    assert.equal(isServiceItemRecordDetailsId(value), false);
});

test('identity alias captures four primitives with the existing nullish organization fallback', () => {
  assert.equal(serviceItemRecordDetailsIdentity, savedRecordDetailsIdentity);
  assert.equal(serviceItemRecordDetailsIdentity(undefined), '[null,null,null,null]');
  assert.equal(serviceItemRecordDetailsIdentity({ user: { id: '', employeeId: '' }, organizationId: '', orgId: 'fallback', role: '' }), '["","","",""]');
  assert.equal(serviceItemRecordDetailsIdentity({ user: { id: 'u', employeeId: 'e' }, organizationId: null, orgId: 'o', role: 'finance' }), '["u","o","finance","e"]');
});

test('nested user replacement retains identity but each authorization primitive changes it', () => {
  const context = { user: { id: 'u', employeeId: 'e' }, organizationId: 'o', role: 'supervisor' };
  const identity = serviceItemRecordDetailsIdentity(context);
  assert.equal(serviceItemRecordDetailsIdentity({ ...context, user: { ...context.user } }), identity);
  for (const changed of [{ ...context, user: { ...context.user, id: 'other' } }, { ...context, organizationId: 'other' },
    { ...context, role: 'finance' }, { ...context, user: { ...context.user, employeeId: 'other' } }])
    assert.notEqual(serviceItemRecordDetailsIdentity(changed), identity);
});

test('fresh safe version and arbitrary timestamp strings are accepted without old-row comparison', () => {
  const source = record({ version: Number.MAX_SAFE_INTEGER, createdAt: '', updatedAt: '  0000-99-99\r\n原時間文字  ' });
  const result = confirm(source);
  assert.equal(result.version, Number.MAX_SAFE_INTEGER); assert.equal(result.createdAt, '');
  assert.equal(result.updatedAt, source.updatedAt);
  assert.deepEqual(Object.keys(result), ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'fields']);
});

test('wrong identity and malformed metadata fail with a fixed payload-free domain error', () => {
  for (const extra of [{ id: 'def123' }, { orgId: 'SYNTHETIC-FOREIGN-PRIVATE' }, { id: id.toUpperCase() },
    { createdAt: null }, { updatedAt: 123 }, { createdAt: undefined }, { updatedAt: {} }]) {
    assert.throws(() => confirm(record(extra)), error => {
      assert(unconfirmed(error)); assert.deepEqual(Object.keys(error), ['code']);
      assert(!error.message.includes('SYNTHETIC-FOREIGN-PRIVATE')); return true;
    });
  }
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '3', null, undefined])
    assert.throws(() => confirm(record({ version })), unconfirmed);
});

test('null-prototype request envelope and saved item remain supported plain data', () => {
  const result = confirmServiceItemRecordDetails(Object.assign(Object.create(null), { item: Object.assign(Object.create(null), record()) }),
    Object.assign(Object.create(null), requested()));
  assert.equal(result.id, id); assert.equal(field(result, 'name').text, '合成服務名稱');
});

test('closed response rejects extra fields symbols hidden data and accessors without invoking getters', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'item', { enumerable: true, get() { calls++; throw Error('item'); } });
  const hidden = Object.defineProperty({}, 'item', { value: record(), enumerable: false });
  const extra = Object.defineProperty({ item: record() }, 'unknown', { enumerable: true, get() { calls++; throw Error('extra'); } });
  for (const response of [null, [], 'response', {}, { item: record(), extra: true }, extra, accessor, hidden,
    { item: record(), [Symbol('extra')]: true }, Object.create({ item: record() })])
    assert.throws(() => confirmServiceItemRecordDetails(response, requested()), unconfirmed);
  assert.equal(calls, 0);
});

test('requested scope is exact own enumerable data and never executes scope accessors', () => {
  let calls = 0;
  const accessor = Object.defineProperty({ orgId }, 'id', { enumerable: true, get() { calls++; throw Error('id'); } });
  const hidden = Object.defineProperty({ orgId }, 'id', { value: id, enumerable: false });
  for (const query of [{}, { id }, { orgId }, { id, orgId, version: 3 }, { id, orgId: '' }, { id, orgId: '   ' },
    { id: 'not-a-route-id', orgId }, { id, orgId, [Symbol('extra')]: true }, accessor, hidden, Object.create(requested())])
    assert.throws(() => confirmServiceItemRecordDetails({ item: record() }, query), unconfirmed);
  assert.equal(calls, 0);
});

test('all five metadata descriptors must be own enumerable data with zero getter execution', () => {
  let calls = 0;
  for (const key of ['id', 'orgId', 'version', 'createdAt', 'updatedAt']) {
    const missing = record(); delete missing[key]; assert.throws(() => confirm(missing), unconfirmed);
    const hidden = record(); Object.defineProperty(hidden, key, { enumerable: false }); assert.throws(() => confirm(hidden), unconfirmed);
    const accessor = record(); Object.defineProperty(accessor, key, { get() { calls++; throw Error('metadata'); } });
    assert.throws(() => confirm(accessor), unconfirmed);
  }
  assert.equal(calls, 0);
});

test('each of the eight known business accessors rejects the complete response before running', () => {
  let calls = 0;
  for (const { key } of SERVICE_ITEM_RECORD_FIELDS) {
    const source = record(); Object.defineProperty(source, key, { get() { calls++; throw Error('business'); } });
    assert.throws(() => confirm(source), unconfirmed);
  }
  assert.equal(calls, 0);
});

test('record classes inherited items and arrays are rejected rather than treated as saved plain records', () => {
  class Record { constructor() { Object.assign(this, record()); } }
  for (const source of [null, [], new Record(), Object.create(record()), 'record'])
    assert.throws(() => confirm(source), unconfirmed);
});

test('unknown record getters and keys are not inspected or enumerated by the projection', () => {
  let calls = 0; const descriptors = [], source = record();
  Object.defineProperty(source, 'private', { enumerable: true, get() { calls++; throw Error('private'); } });
  Object.defineProperty(source, Symbol('private'), { get() { calls++; throw Error('symbol'); } });
  const guarded = new Proxy(source, { ownKeys() { throw Error('do not enumerate saved record'); }, get() { throw Error('no direct record read'); },
    getOwnPropertyDescriptor(target, key) { descriptors.push(key); return Reflect.getOwnPropertyDescriptor(target, key); } });
  const result = confirm(guarded);
  assert.deepEqual(descriptors, ['id', 'orgId', 'version', 'createdAt', 'updatedAt', ...SERVICE_ITEM_RECORD_FIELDS.map(value => value.key)]);
  assert.equal(calls, 0); assert(!JSON.stringify(result).includes('private'));
});

test('saved ordinary fields distinguish absent empty null own undefined and typed primitives', () => {
  const source = record({ name: '', validFrom: null, validTo: undefined, status: false, note: 7 }); delete source.code;
  const result = confirm(source);
  for (const [key, kind, text] of [['code', 'missing', '未保存'], ['name', 'empty', '空白'],
    ['validFrom', 'null', '未提供（null）'], ['validTo', 'non-text', tag('undefined')],
    ['status', 'non-text', tag('boolean')], ['note', 'non-text', tag('number')]])
    assert.deepEqual({ kind: field(result, key).kind, text: field(result, key).text }, { kind, text });
  Object.defineProperty(source, 'code', { value: '隱藏但明確保存的代碼', enumerable: false });
  assert.equal(field(confirm(source), 'code').text, '隱藏但明確保存的代碼');
});

test('names status dates and HTML text remain literal untrimmed and preserve line endings', () => {
  const html = '  <script>globalThis.syntheticServiceItemLeak = true</script>\r\n<img src=x onerror=syntheticServiceItemLeak()>  ';
  const source = record({ code: '  原代碼\r\n  ', name: '  原名稱🌱\r\n  ', validFrom: '0000-02-31\r\n原文',
    validTo: '未核定日期文字', status: '  未辨識狀態\n原保存碼  ', note: html });
  const result = confirm(source);
  for (const key of ['code', 'name', 'validFrom', 'validTo', 'status', 'note']) {
    assert.equal(field(result, key).kind, 'text'); assert.equal(field(result, key).text, source[key]);
  }
  assert.equal(globalThis.syntheticServiceItemLeak, undefined);
});

test('long saved note retains distant ends supplementary characters and CR/LF without editor limits', () => {
  const note = '\t合成首端\r\n' + '🌱完整保存備註'.repeat(5000) + '\r\n合成尾端  ';
  assert(note.length > 10000); assert.equal(field(confirm(record({ note })), 'note').text, note);
});

test('nested ordinary values produce only a type tag without toJSON toString or getter access', () => {
  let calls = 0;
  const nested = Object.defineProperties({}, { secret: { enumerable: true, get() { calls++; throw Error('secret'); } },
    toJSON: { value() { calls++; throw Error('serialize'); } }, toString: { value() { calls++; throw Error('coerce'); } } });
  const array = []; Object.defineProperty(array, '0', { get() { calls++; throw Error('nested index'); } });
  for (const [value, type] of [[nested, 'object'], [array, 'array'], [1n, 'bigint'], [Symbol('SYNTHETIC-SECRET'), 'symbol'],
    [() => { calls++; }, 'function']]) {
    assert.deepEqual(projected(record({ note: value }), 'note'), { kind: 'non-text', text: tag(type) });
  }
  assert.equal(calls, 0);
});

test('finite numeric minutes retain their primitive text even outside normal write validation', () => {
  for (const [minutes, text] of [[0, '0'], [-0, '0'], [-1, '-1'], [1.25, '1.25'], [1441, '1441'], [1e9, '1000000000'],
    [Number.MAX_SAFE_INTEGER + 1, '9007199254740992'], [Number.MIN_VALUE, '5e-324'], [Number.MAX_VALUE, '1.7976931348623157e+308']])
    assert.deepEqual(projected(record({ minutes }), 'minutes'), { kind: 'text', text });
});

test('minutes string spelling whitespace and line endings are preserved without coercion', () => {
  for (const minutes of ['030', '1.25', '  30  ', '-1', '1e3', '原分鐘\r\n未轉換'])
    assert.deepEqual(projected(record({ minutes }), 'minutes'), { kind: 'text', text: minutes });
});

test('missing empty and null minutes stay distinct and nonfinite or typed values stay type tags', () => {
  const missing = record(); delete missing.minutes;
  assert.deepEqual(projected(missing, 'minutes'), { kind: 'missing', text: '未保存' });
  for (const [minutes, kind, text] of [['', 'empty', '空白'], [null, 'null', '未提供（null）'],
    [NaN, 'non-text', tag('number')], [Infinity, 'non-text', tag('number')], [-Infinity, 'non-text', tag('number')],
    [false, 'non-text', tag('boolean')], [undefined, 'non-text', tag('undefined')], [1n, 'non-text', tag('bigint')]])
    assert.deepEqual(projected(record({ minutes }), 'minutes'), { kind, text });
});

test('unsupported minute objects and arrays never invoke coercion or inspect embedded values', () => {
  let calls = 0;
  const boxed = Object.assign(new Number(30), { valueOf() { calls++; throw Error('valueOf'); }, toString() { calls++; throw Error('toString'); } });
  const array = []; Object.defineProperty(array, '0', { get() { calls++; throw Error('index'); } });
  const nested = Object.defineProperty({}, 'minutes', { get() { calls++; throw Error('minutes'); } });
  for (const [minutes, type] of [[boxed, 'object'], [array, 'array'], [nested, 'object']])
    assert.deepEqual(projected(record({ minutes }), 'minutes'), { kind: 'non-text', text: tag(type) });
  assert.equal(calls, 0);
});

test('trial cents display exact zero one-cent ordinary and safe-maximum stored amounts', () => {
  for (const [unitPriceCents, text] of [[0, '新臺幣 0.00 元（保存 0 分）'], [-0, '新臺幣 0.00 元（保存 0 分）'],
    [1, '新臺幣 0.01 元（保存 1 分）'], [12345, '新臺幣 123.45 元（保存 12345 分）'],
    [1000000000, '新臺幣 10000000.00 元（保存 1000000000 分）'],
    [Number.MAX_SAFE_INTEGER, '新臺幣 90071992547409.91 元（保存 9007199254740991 分）']])
    assert.deepEqual(projected(record({ unitPriceCents }), 'unitPriceCents'), { kind: 'text', text });
});

test('legacy trial-price primitive values retain the existing formatter invalid-value meaning', () => {
  for (const [unitPriceCents, text] of [[-1, '-1（金額無法判讀）'], [1.5, '1.5（金額無法判讀）'],
    [Number.MAX_SAFE_INTEGER + 1, '9007199254740992（金額無法判讀）'],
    ['001', '001（金額無法判讀）'], [' 1 ', ' 1 （金額無法判讀）'], ['1e2', '1e2（金額無法判讀）'],
    [true, 'true（金額無法判讀）'], [false, 'false（金額無法判讀）'],
    [NaN, '[欄位格式無法判讀]（金額無法判讀）'], [Infinity, '[欄位格式無法判讀]（金額無法判讀）'],
    [-Infinity, '[欄位格式無法判讀]（金額無法判讀）']])
    assert.deepEqual(projected(record({ unitPriceCents }), 'unitPriceCents'), { kind: 'text', text });
});

test('price missing empty null and own undefined are not collapsed by the formatter', () => {
  const missing = record(); delete missing.unitPriceCents;
  assert.deepEqual(projected(missing, 'unitPriceCents'), { kind: 'missing', text: '未保存' });
  for (const [unitPriceCents, kind, text] of [['', 'empty', '空白'], [null, 'null', '未提供（null）'],
    [undefined, 'non-text', tag('undefined')]])
    assert.deepEqual(projected(record({ unitPriceCents }), 'unitPriceCents'), { kind, text });
});

test('unsupported prices stay type-only tags and never expose nested price or secret properties', () => {
  let calls = 0;
  const nested = Object.defineProperties({}, { secret: { get() { calls++; throw Error('secret'); } },
    unitPriceCents: { enumerable: true, get() { calls++; throw Error('price'); } }, toString: { value() { calls++; throw Error('coerce'); } } });
  const array = []; Object.defineProperty(array, '0', { get() { calls++; throw Error('nested index'); } });
  for (const [unitPriceCents, type] of [[nested, 'object'], [array, 'array'], [new Number(1), 'object'],
    [1n, 'bigint'], [Symbol('SYNTHETIC-PRIVATE'), 'symbol'], [() => { calls++; }, 'function']])
    assert.deepEqual(projected(record({ unitPriceCents }), 'unitPriceCents'), { kind: 'non-text', text: tag(type) });
  assert.equal(calls, 0);
});

test('confirmation returns immutable detached string fields and does not freeze or change source data', () => {
  const source = record(), snapshot = structuredClone(source), result = confirm(source);
  assert.deepEqual(source, snapshot); assert(!Object.isFrozen(source));
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.fields)); assert(result.fields.every(Object.isFrozen));
  assert(result.fields.every(value => typeof value.text === 'string'));
  assert.throws(() => { result.version = 4; }, TypeError);
  assert.throws(() => { result.fields.push({}); }, TypeError);
  assert.throws(() => { result.fields[0].text = 'changed'; }, TypeError);
  source.name = 'changed'; source.minutes = 99; source.note = 'changed';
  assert.equal(field(result, 'name').text, '合成服務名稱'); assert.equal(field(result, 'minutes').text, '30');
  assert.equal(field(result, 'note').text, '合成原備註');
});
