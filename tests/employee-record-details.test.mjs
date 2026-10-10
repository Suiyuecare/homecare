import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPLOYEE_RECORD_FIELDS, isEmployeeRecordDetailsId, employeeRecordDetailsIdentity,
  confirmEmployeeRecordDetails } from '../public/data/employee-record-details.js';
import { isSavedRecordDetailsId, savedRecordDetailsIdentity, confirmSavedRecordDetails } from '../public/data/saved-record-details.js';
import { confirmInterviewRecordDetails, INTERVIEW_RECORD_FIELDS } from '../public/data/interview-record-details.js';
import { getHistoryFields } from '../public/data/history-fields.js';

const id = 'abc123-ef09', orgId = 'synthetic-employee-details-org';
const requested = () => ({ id, orgId });
const record = extra => ({ id, orgId, version: 3, createdAt: '原保存建立時間\r\n0000', updatedAt: '原保存更新時間\n未轉時區',
  name: '合成员工', employeeNo: 'SYN-EMP-001', role: '原職務／不是登入權限', phone: '  原電話\r\n分機  ',
  email: '原Email@example.invalid', status: 'inactive', qualification: '原資格文字', regions: ['原區域'],
  note: '原備註', hourlyRateCents: 1, ...extra });
const confirm = item => confirmEmployeeRecordDetails({ item }, requested());
const field = (result, key) => result.fields.find(value => value.key === key);
const unconfirmed = error => error.code === 'EMPLOYEE_RECORD_DETAILS_UNCONFIRMED'
  && error.message === '員工紀錄回應無法確認；請重新讀取。';
const nonText = type => `非文字值（${type}）`;

test('ten immutable business fields match employee history labels and order without metadata fields', () => {
  const expected = [['name', '姓名'], ['employeeNo', '員工編號'], ['role', '職務'], ['phone', '聯絡電話'],
    ['email', '電子郵件'], ['status', '員工狀態'], ['qualification', '資格與證照'], ['regions', '服務區域'],
    ['note', '備註'], ['hourlyRateCents', '試算時薪（新臺幣元）']];
  assert.deepEqual(EMPLOYEE_RECORD_FIELDS.map(value => [value.key, value.label]), expected);
  assert.deepEqual(getHistoryFields('employees').map(value => [value.key, value.label]), expected);
  assert(Object.isFrozen(EMPLOYEE_RECORD_FIELDS)); assert(EMPLOYEE_RECORD_FIELDS.every(Object.isFrozen));
  assert.throws(() => { EMPLOYEE_RECORD_FIELDS[0].label = 'changed'; }, TypeError);
});

test('shared and employee IDs retain the existing route grammar rather than a UUID policy', () => {
  assert.equal(isEmployeeRecordDetailsId, isSavedRecordDetailsId);
  for (const value of [id, 'a', '--', 'f--012']) assert(isEmployeeRecordDetailsId(value));
  for (const value of ['', 'ABC', ' abc', 'abc ', 'abc\n', 'abc/def', 'xyz', null, 1, {}, []])
    assert.equal(isEmployeeRecordDetailsId(value), false);
});

test('employee identity captures all four primitives and preserves nullish rather than truthy fallback', () => {
  assert.equal(employeeRecordDetailsIdentity, savedRecordDetailsIdentity);
  assert.equal(employeeRecordDetailsIdentity(undefined), '[null,null,null,null]');
  assert.equal(employeeRecordDetailsIdentity({ user: { id: '', employeeId: '' }, organizationId: '', orgId: 'fallback', role: '' }), '["","","",""]');
  assert.equal(employeeRecordDetailsIdentity({ user: { id: 'u', employeeId: 'e' }, organizationId: null, orgId: 'o', role: 'finance' }), '["u","o","finance","e"]');
});

test('nested replacement retains primitive identity while each authorization primitive changes it', () => {
  const context = { user: { id: 'u', employeeId: 'e' }, organizationId: 'o', role: 'supervisor' };
  const identity = employeeRecordDetailsIdentity(context);
  assert.equal(employeeRecordDetailsIdentity({ ...context, user: { ...context.user } }), identity);
  for (const changed of [{ ...context, user: { ...context.user, id: 'other' } }, { ...context, organizationId: 'other' },
    { ...context, role: 'finance' }, { ...context, user: { ...context.user, employeeId: 'other' } }])
    assert.notEqual(employeeRecordDetailsIdentity(changed), identity);
});

test('fresh version and arbitrary timestamp strings are kept exactly without parsing or old-row comparison', () => {
  const source = record({ version: Number.MAX_SAFE_INTEGER, createdAt: '', updatedAt: '  0000-99-99\r\n保存全文  ' });
  const result = confirm(source);
  assert.equal(result.version, Number.MAX_SAFE_INTEGER); assert.equal(result.createdAt, '');
  assert.equal(result.updatedAt, source.updatedAt);
  assert.deepEqual(Object.keys(result), ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'fields']);
});

test('cross-org, wrong ID and invalid metadata values fail with a fixed payload-free error', () => {
  for (const change of [{ id: 'def123' }, { orgId: 'SYNTHETIC-FOREIGN-SECRET' }, { id: id.toUpperCase() },
    { createdAt: null }, { updatedAt: 123 }, { createdAt: undefined }, { updatedAt: {} }])
    assert.throws(() => confirm(record(change)), error => unconfirmed(error) && !error.message.includes('SYNTHETIC-FOREIGN-SECRET'));
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '3', null, undefined])
    assert.throws(() => confirm(record({ version })), unconfirmed);
});

test('null-prototype envelope, scope and record are valid plain saved data', () => {
  const result = confirmEmployeeRecordDetails(Object.assign(Object.create(null), { item: Object.assign(Object.create(null), record()) }),
    Object.assign(Object.create(null), requested()));
  assert.equal(result.id, id); assert.equal(field(result, 'name').text, '合成员工');
});

test('response envelope is closed and descriptor-confirmed without executing accessor or extra getters', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'item', { enumerable: true, get() { calls++; return record(); } });
  const hidden = Object.defineProperty({}, 'item', { value: record(), enumerable: false });
  const extra = Object.defineProperty({ item: record() }, 'unknown', { enumerable: true, get() { calls++; throw Error('unknown'); } });
  for (const response of [null, [], 'response', {}, { item: record(), extra: true }, extra, accessor, hidden,
    { item: record(), [Symbol('extra')]: true }, Object.create({ item: record() })])
    assert.throws(() => confirmEmployeeRecordDetails(response, requested()), unconfirmed);
  assert.equal(calls, 0);
});

test('requested ID/org data is exact and rejects inherited, hidden and accessor scope', () => {
  let calls = 0;
  const accessor = Object.defineProperty({ orgId }, 'id', { enumerable: true, get() { calls++; return id; } });
  const hidden = Object.defineProperty({ orgId }, 'id', { value: id, enumerable: false });
  for (const query of [{}, { id }, { orgId }, { id, orgId, version: 3 }, { id, orgId: '' }, { id, orgId: '   ' },
    { id: 'not-a-route-id', orgId }, { id, orgId, [Symbol('extra')]: true }, accessor, hidden, Object.create(requested())])
    assert.throws(() => confirmEmployeeRecordDetails({ item: record() }, query), unconfirmed);
  assert.equal(calls, 0);
});

test('metadata must be own enumerable data and every known business accessor rejects without running', () => {
  let calls = 0;
  for (const key of ['id', 'orgId', 'version', 'createdAt', 'updatedAt']) {
    const missing = record(); delete missing[key]; assert.throws(() => confirm(missing), unconfirmed);
    const hidden = record(); Object.defineProperty(hidden, key, { enumerable: false }); assert.throws(() => confirm(hidden), unconfirmed);
    const accessor = record(); Object.defineProperty(accessor, key, { get() { calls++; throw Error('metadata'); } });
    assert.throws(() => confirm(accessor), unconfirmed);
  }
  for (const { key } of EMPLOYEE_RECORD_FIELDS) {
    const accessor = record(); Object.defineProperty(accessor, key, { get() { calls++; throw Error('known business'); } });
    assert.throws(() => confirm(accessor), unconfirmed);
  }
  assert.equal(calls, 0);
});

test('record classes, arrays and inherited data fail; unknown record descriptors are never inspected', () => {
  class Record { constructor() { Object.assign(this, record()); } }
  for (const item of [null, [], new Record(), Object.create(record()), 'record']) assert.throws(() => confirm(item), unconfirmed);
  let calls = 0; const descriptors = [], source = record();
  Object.defineProperty(source, 'private', { enumerable: true, get() { calls++; throw Error('secret'); } });
  Object.defineProperty(source, Symbol('private'), { get() { calls++; throw Error('symbol'); } });
  const guarded = new Proxy(source, { ownKeys() { throw Error('do not enumerate record'); }, get() { throw Error('do not read record'); },
    getOwnPropertyDescriptor(target, key) { descriptors.push(key); return Reflect.getOwnPropertyDescriptor(target, key); } });
  const result = confirm(guarded);
  assert.equal(result.fields.length, 10); assert.equal(calls, 0); assert(!descriptors.includes('private'));
  assert(!JSON.stringify(result).includes('private'));
});

test('ordinary fields distinguish missing, empty, null, own undefined and saved typed values', () => {
  const item = record({ phone: '', email: null, role: 7, qualification: false, note: undefined }); delete item.name;
  const result = confirm(item);
  for (const [key, kind, text] of [['name', 'missing', '未保存'], ['phone', 'empty', '空白'], ['email', 'null', '未提供（null）'],
    ['role', 'non-text', nonText('number')], ['qualification', 'non-text', nonText('boolean')], ['note', 'non-text', nonText('undefined')]])
    assert.deepEqual({ kind: field(result, key).kind, text: field(result, key).text }, { kind, text });
  Object.defineProperty(item, 'name', { value: '隱藏但明確保存的文字', enumerable: false });
  assert.equal(field(confirm(item), 'name').text, '隱藏但明確保存的文字');
});

test('full saved contact, job, qualification, unknown status and HTML text are literal and untrimmed', () => {
  const html = '  <script>globalThis.syntheticEmployeeLeak = true</script>\r\n<img src=x onerror=syntheticEmployeeLeak()>  ';
  const source = record({ note: html, status: '  未辨識狀態\r\n保存碼  ', qualification: '  原資格\n不等於認定  ' });
  const result = confirm(source);
  for (const key of ['phone', 'email', 'role', 'qualification', 'status', 'note']) {
    assert.equal(field(result, key).kind, 'text'); assert.equal(field(result, key).text, source[key]);
  }
  assert.equal(globalThis.syntheticEmployeeLeak, undefined);
});

test('long text retains distant ends, supplementary characters and original line endings', () => {
  const note = '  合成首端\r\n' + '🌱完整備註'.repeat(5000) + '\r\n合成尾端  ';
  const qualification = '\t合成資格首端\n' + '原文字'.repeat(5000) + '\n合成資格尾端\t';
  const result = confirm(record({ note, qualification }));
  assert.equal(field(result, 'note').text, note); assert.equal(field(result, 'qualification').text, qualification);
  assert(note.length > 10000);
});

test('ordinary nested values are type tags without toJSON, toString, getter or function invocation', () => {
  let calls = 0;
  const nested = Object.defineProperties({}, { secret: { enumerable: true, get() { calls++; throw Error('secret'); } },
    toJSON: { value() { calls++; throw Error('serialize'); } }, toString: { value() { calls++; throw Error('coerce'); } } });
  const array = []; Object.defineProperty(array, '0', { get() { calls++; throw Error('nested array'); } });
  const result = confirm(record({ note: nested, qualification: array }));
  assert.equal(field(result, 'note').text, nonText('object')); assert.equal(field(result, 'qualification').text, nonText('array'));
  for (const [value, type] of [[1n, 'bigint'], [Symbol('SYNTHETIC-HIDDEN'), 'symbol'], [() => { calls++; }, 'function']])
    assert.equal(field(confirm(record({ note: value })), 'note').text, nonText(type));
  assert.equal(calls, 0); assert(!JSON.stringify(result).includes('secret'));
});

test('regions distinguish absent/null/empty from saved text, empty list and original list order', () => {
  const missing = record(); delete missing.regions;
  assert.deepEqual({ kind: field(confirm(missing), 'regions').kind, text: field(confirm(missing), 'regions').text }, { kind: 'missing', text: '未保存' });
  for (const [value, kind, text] of [[null, 'null', '未提供（null）'], ['', 'empty', '空白'], ['  台北\r\n原文  ', 'text', '保存文字：  台北\r\n原文  '],
    [[], 'text', '空清單（0 項）'], [['', '北', '北', '  南\n區  '], 'text', '保存清單（4 項）\n1. 空字串\n2. 「北」\n3. 「北」\n4. 「  南\n區  」']]) {
    const result = field(confirm(record({ regions: value })), 'regions');
    assert.equal(result.kind, kind); assert.equal(result.text, text);
  }
});

test('dense region lists detach own data including nonenumerable string indices before the formatter', () => {
  const regions = ['原甲', '原乙']; Object.defineProperty(regions, '0', { enumerable: false });
  const result = confirm(record({ regions })); regions[0] = 'changed'; regions.push('changed');
  assert.equal(field(result, 'regions').text, '保存清單（2 項）\n1. 「原甲」\n2. 「原乙」');
  assert(!Object.isFrozen(regions));
  const guarded = new Proxy(['純描述元'], { get() { throw Error('array direct read forbidden'); } });
  assert.equal(field(confirm(record({ regions: guarded })), 'regions').text, '保存清單（1 項）\n1. 「純描述元」');
});

test('region holes, mixed values, extras and symbols remain an array tag without inspecting unknown values', () => {
  let calls = 0;
  const hole = new Array(2); hole[1] = '原乙';
  const extra = ['原甲']; Object.defineProperty(extra, 'secret', { enumerable: true, get() { calls++; throw Error('extra'); } });
  const symbolic = ['原甲']; Object.defineProperty(symbolic, Symbol('secret'), { get() { calls++; throw Error('symbol'); } });
  const noncanonical = ['原甲']; Object.defineProperty(noncanonical, '01', { get() { calls++; throw Error('not index'); } });
  const nested = Object.defineProperty({}, 'secret', { get() { calls++; throw Error('nested'); } });
  for (const regions of [hole, ['原甲', 1], [nested], extra, symbolic, noncanonical, [undefined], [null]]) {
    const result = field(confirm(record({ regions })), 'regions');
    assert.equal(result.kind, 'non-text'); assert.equal(result.text, nonText('array'));
  }
  assert.equal(calls, 0);
});

test('every present region index accessor rejects even when another value, hole or extra already invalidates the list', () => {
  let calls = 0;
  for (const regions of [['原甲'], [null, '原乙'], new Array(2), ['原甲', '原乙']]) {
    const index = regions.length === 1 ? '0' : '1';
    Object.defineProperty(regions, index, { configurable: true, enumerable: true, get() { calls++; throw Error('known index'); } });
    Object.defineProperty(regions, 'extra', { get() { calls++; throw Error('unknown extra'); } });
    assert.throws(() => confirm(record({ regions })), unconfirmed);
  }
  assert.equal(calls, 0);
});

test('sparse large region lists and inherited getters are rejected as types without length-driven traversal', () => {
  let calls = 0, descriptors = 0;
  const sparse = new Array(4294967295);
  Object.setPrototypeOf(sparse, Object.create(Array.prototype, { 0: { get() { calls++; throw Error('inherited index'); } } }));
  const guarded = new Proxy(sparse, { get() { calls++; throw Error('direct read'); },
    getOwnPropertyDescriptor(target, key) { descriptors++; return Reflect.getOwnPropertyDescriptor(target, key); } });
  assert.equal(field(confirm(record({ regions: guarded })), 'regions').text, nonText('array'));
  assert.equal(descriptors, 1); assert.equal(calls, 0);
});

test('nonarray regions retain only their type and never serialize embedded content', () => {
  let calls = 0;
  const object = Object.defineProperties({}, { hidden: { get() { calls++; throw Error('hidden'); } },
    toString: { value() { calls++; throw Error('coercion'); } } });
  for (const [value, type] of [[object, 'object'], [false, 'boolean'], [3, 'number'], [undefined, 'undefined'], [1n, 'bigint']]) {
    const result = field(confirm(record({ regions: value })), 'regions');
    assert.equal(result.kind, 'non-text'); assert.equal(result.text, nonText(type));
  }
  assert.equal(calls, 0);
});

test('trial cents retain zero, one cent and safe maximum exactly without floating-point rounding', () => {
  for (const [value, text] of [[0, '新臺幣 0.00 元（保存 0 分）'], [1, '新臺幣 0.01 元（保存 1 分）'],
    [105, '新臺幣 1.05 元（保存 105 分）'], [Number.MAX_SAFE_INTEGER, '新臺幣 90071992547409.91 元（保存 9007199254740991 分）']]) {
    const result = field(confirm(record({ hourlyRateCents: value })), 'hourlyRateCents');
    assert.equal(result.kind, 'text'); assert.equal(result.text, text);
  }
});

test('trial cents preserve own missing/empty/null and primitive invalid text without Number coercion', () => {
  const missing = record(); delete missing.hourlyRateCents;
  assert.equal(field(confirm(missing), 'hourlyRateCents').text, '未保存');
  for (const [value, kind, text] of [['', 'empty', '空白'], [null, 'null', '未提供（null）'],
    ['001', 'text', '001（金額無法判讀）'], [' 1 ', 'text', ' 1 （金額無法判讀）'],
    [true, 'text', 'true（金額無法判讀）'], [false, 'text', 'false（金額無法判讀）'],
    [-1, 'text', '-1（金額無法判讀）'], [1.5, 'text', '1.5（金額無法判讀）'],
    [Number.MAX_SAFE_INTEGER + 1, 'text', '9007199254740992（金額無法判讀）'],
    [NaN, 'text', '[欄位格式無法判讀]（金額無法判讀）'], [Infinity, 'text', '[欄位格式無法判讀]（金額無法判讀）']]) {
    const result = field(confirm(record({ hourlyRateCents: value })), 'hourlyRateCents');
    assert.equal(result.kind, kind); assert.equal(result.text, text);
  }
});

test('nonprimitive trial cents and unsupported primitives expose type only and never coerce a payload', () => {
  let calls = 0;
  const object = { valueOf() { calls++; throw Error('coerce'); }, toJSON() { calls++; throw Error('serialize'); } };
  const array = []; Object.defineProperty(array, '0', { get() { calls++; throw Error('array getter'); } });
  for (const [value, type] of [[object, 'object'], [array, 'array'], [1n, 'bigint'], [undefined, 'undefined'],
    [Symbol('SECRET'), 'symbol'], [() => { calls++; }, 'function']]) {
    const result = field(confirm(record({ hourlyRateCents: value })), 'hourlyRateCents');
    assert.equal(result.kind, 'non-text'); assert.equal(result.text, nonText(type));
  }
  assert.equal(calls, 0);
});

test('output is recursively frozen and detached while all input records, regions and nested objects remain mutable', () => {
  const regions = ['', '原甲'], nested = { hidden: 'SYNTHETIC-PRIVATE' }, item = record({ regions, note: nested });
  const result = confirm(item);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.fields)); assert(result.fields.every(Object.isFrozen));
  assert(!Object.isFrozen(item)); assert(!Object.isFrozen(regions)); assert(!Object.isFrozen(nested));
  item.name = 'changed'; item.updatedAt = 'changed'; regions[0] = 'changed'; nested.hidden = 'changed';
  assert.equal(field(result, 'name').text, '合成员工'); assert.equal(result.updatedAt, '原保存更新時間\n未轉時區');
  assert.equal(field(result, 'regions').text, '保存清單（2 項）\n1. 空字串\n2. 「原甲」');
  assert.equal(field(result, 'note').text, nonText('object')); assert(!JSON.stringify(result).includes('SYNTHETIC-PRIVATE'));
  assert.throws(() => { result.version = 99; }, TypeError); assert.throws(() => { result.fields.push({}); }, TypeError);
  assert.throws(() => { field(result, 'name').text = 'changed'; }, TypeError);
});

test('shared domain projection gets only the declared descriptor, default tag and fixed reject callback', () => {
  const calls = [], source = record();
  Object.defineProperty(source, 'unknown', { get() { throw Error('must not read'); } });
  const reject = () => { throw Object.assign(Error('synthetic domain rejected'), { code: 'SYNTHETIC_DOMAIN' }); };
  const result = confirmSavedRecordDetails({ item: source }, requested(), {
    fields: Object.freeze([{ key: 'name', label: '固定姓名' }]), unconfirmed: reject,
    projectField(...args) {
      assert.equal(args.length, 4); const [definition, saved, fallback, receivedReject] = args;
      calls.push(definition.key); assert(Object.isFrozen(saved)); assert(Object.isFrozen(fallback));
      assert.equal(receivedReject, reject); assert.deepEqual(saved, { present: true, value: '合成员工' });
      return { kind: 'text', text: `確認：${fallback.text}`, unknown: 'MUST-NOT-ESCAPE' };
    },
  });
  assert.deepEqual(calls, ['name']); assert.deepEqual(result.fields, [{ key: 'name', label: '固定姓名', kind: 'text', text: '確認：合成员工' }]);
  assert(!JSON.stringify(result).includes('MUST-NOT-ESCAPE'));
  assert.throws(() => confirmSavedRecordDetails({ item: source }, requested(), { fields: [{ key: 'name', label: '姓名' }],
    unconfirmed: reject, projectField() { return { kind: 'text', text: source }; } }), error => error.code === 'SYNTHETIC_DOMAIN');
});

test('interview wrapper retains its eight-field ordinary text projection and domain-specific failure', () => {
  const source = record({ interviewDate: '0000-99-99', city: null, district: false, interviewContent: ['nested'], note: '' });
  const result = confirmInterviewRecordDetails({ item: source }, requested());
  assert.equal(result.fields.length, 8); assert.deepEqual(result.fields.map(value => value.key), INTERVIEW_RECORD_FIELDS.map(value => value.key));
  assert.equal(field(result, 'interviewDate').text, '0000-99-99'); assert.equal(field(result, 'city').text, '未提供（null）');
  assert.equal(field(result, 'district').text, nonText('boolean')); assert.equal(field(result, 'interviewContent').text, nonText('array'));
  assert.equal(field(result, 'note').kind, 'empty');
  assert.throws(() => confirmInterviewRecordDetails({ item: record({ orgId: 'foreign' }) }, requested()), error =>
    error.code === 'INTERVIEW_RECORD_DETAILS_UNCONFIRMED' && error.message === '面試紀錄回應無法確認；請重新讀取。');
});
