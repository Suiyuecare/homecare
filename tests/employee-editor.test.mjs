import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmployeeEditor } from '../public/data/employee-editor.js';

const keys = ['name', 'employeeNo', 'role', 'phone', 'email', 'status', 'qualification', 'regions', 'note', 'hourlyRateCents'];
const control = k => k === 'hourlyRateCents' ? 'hourlyRate' : k;
const row = changes => ({ id: 'synthetic-employee', orgId: 'synthetic-org', version: 4, name: ' 合成🙂 姓名 ', employeeNo: ' TEST-001 ', role: ' 自訂職務 ', phone: '分機#原文', email: '非Email格式也保留', status: 'active', qualification: '第一行\n第二行', regions: ' 北區\n南區 ', note: ' 合成備註\n', hourlyRateCents: 12345, ...changes });
const edit = existing => createEmployeeEditor({ existing });
const values = (e, change = {}) => ({ ...e.initial, ...change });
const next = (saved, payload = {}) => ({ ...saved, ...payload, version: saved.version + 1 });
const fieldError = (fn, name) => assert.throws(fn, e => !!e.fields && Object.hasOwn(e.fields, name));
const unconfirmed = fn => assert.throws(fn, e => e.code === 'SAVE_UNCONFIRMED');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('create defines ten fields with text email, multiline regions and exact zero/active defaults without trimming', () => {
  const e = edit();
  assert.deepEqual(e.initial, { name: '', employeeNo: '', role: '', phone: '', email: '', status: 'active', qualification: '', regions: '', note: '', hourlyRate: '0.00' });
  assert.deepEqual(e.fields.map(f => [f.name, f.type]), [['name', 'text'], ['employeeNo', 'text'], ['role', 'text'], ['phone', 'tel'], ['email', 'text'], ['status', 'select'], ['qualification', 'textarea'], ['regions', 'textarea'], ['note', 'textarea'], ['hourlyRate', 'text']]);
  assert.deepEqual(e.fields.filter(f => f.required).map(f => f.name), ['name', 'employeeNo', 'status', 'hourlyRate']);
  assert.equal(e.fields.find(f => f.name === 'hourlyRate').inputMode, 'decimal');
  assert.deepEqual(e.buildPayload(values(e, { name: ' 合成🙂　 ', employeeNo: ' TEST\t', email: 'not an email', regions: '\n 北區\n' })), { name: ' 合成🙂　 ', employeeNo: ' TEST\t', role: '', phone: '', email: 'not an email', status: 'active', qualification: '', regions: '\n 北區\n', note: '', hourlyRateCents: 0 });
});

test('hourly cents round-trip at zero one cent fractional amounts and one-billion boundary, equivalent decimals omit', () => {
  for (const [cents, text, alternative] of [[0, '0.00', '000.0'], [1, '0.01', '00.01'], [29, '0.29', '000.29'], [12300, '123.00', '00123'], [12345, '123.45', '00123.45'], [999999999, '9999999.99', '09999999.99'], [1000000000, '10000000.00', '00010000000']]) {
    const e = edit(row({ hourlyRateCents: cents })); assert.equal(e.initial.hourlyRate, text); assert.deepEqual(e.buildPayload(e.initial), {}); assert.deepEqual(e.buildPayload({ hourlyRate: alternative }), {});
    const create = edit(); assert.equal(create.buildPayload({ name: '合成', employeeNo: 'TEST', hourlyRate: text }).hourlyRateCents, cents);
  }
  assert.deepEqual(edit(row()).buildPayload({ hourlyRate: '0'.repeat(2000) + '1.01' }), { hourlyRateCents: 101 });
});

test('hourly replacement rejects nonstrings signs whitespace exponent precision and exact overflow without alias injection', () => {
  const e = edit(row());
  for (const hourlyRate of ['', ' ', ' 1', '1 ', '+1', '-0', '-1', '1e2', '1,000', '.01', '1.', '0.001', '1.000', '10000000.01', '10000001', '9'.repeat(1000), '１２.３４', '1\n', '1.2\r\n', '1.2\r', '1.2\u2028', '1.2\u2029', '1.2\t', 1, 0, null, false, [], {}, undefined]) fieldError(() => e.buildPayload({ hourlyRate }), 'hourlyRate');
  fieldError(() => e.buildPayload({ hourlyRateCents: 1 }), 'hourlyRateCents');
});

test('normal edits and reversions emit only changes and never expose arbitrary metadata', () => {
  const original = freeze(row({ billingSnapshot: { secret: 'PRIVATE' }, extra: 'PRIVATE', fileId: 'PRIVATE' })), e = edit(original);
  assert.deepEqual(e.buildPayload(e.initial), {}); assert.deepEqual(e.buildPayload({ name: ' 明確新名稱 ', hourlyRate: '00123.45' }), { name: ' 明確新名稱 ' });
  assert.deepEqual(e.buildPayload(values(e, { role: original.role, regions: original.regions })), {});
  assert.equal(Object.keys(e.initial).length, 10); assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
});

test('every saved regions list stays private and whole including empty items duplicates ordered LF and CR', () => {
  for (const regions of [[], [''], ['空字串'], ['', '北區', '北區', '南\n區', '東\r區', 'PRIVATE'], Array(50).fill('同區')]) {
    const original = freeze(row({ regions })), e = edit(original);
    assert.equal(e.needsIntent('regions'), true); assert.equal(e.initial.regions, ''); assert.equal(e.initial.regionsIntent, 'keep');
    assert.equal(e.enabled('regions', e.initial), false); assert.equal(e.fields.find(f => f.name === 'regions').disabled, true);
    assert.deepEqual(e.fields.find(f => f.name === 'regionsIntent').options, [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '改存文字' }, { value: 'clear', label: '清空為空文字' }]);
    assert.match(e.fields.find(f => f.name === 'regionsIntent').help, /整份原清單/); assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
    assert.deepEqual(e.buildPayload({ regions: '這不是明確取代' }), {});
    e.confirm(next(original, { note: '只改備註' }), original.orgId, { note: '只改備註' }); assert.deepEqual(original.regions, regions);
    assert.deepEqual(e.buildPayload({ regionsIntent: 'replace', regions: ' 北區\n北區\n ' }), { regions: ' 北區\n北區\n ' });
    assert.deepEqual(e.buildPayload({ regionsIntent: 'clear', regions: { ignored: true } }), { regions: '' });
    assert.equal(e.enabled('regions', { regionsIntent: 'clear' }), false);
    fieldError(() => e.buildPayload({ regionsIntent: 'replace', regions: ['北區'] }), 'regions');
  }
});

test('missing null and unsafe JSON values get blank disabled controls while preserving exact own presence', () => {
  const cases = [row(Object.fromEntries(keys.map(k => [k, null]))), row({ name: 0, employeeNo: false, role: ['PRIVATE'], phone: {}, email: true, status: '__proto__', qualification: { private: 'PRIVATE' }, regions: 42, note: ['PRIVATE'], hourlyRateCents: '12345' }), { id: 'synthetic-employee', orgId: 'synthetic-org', version: 1 }];
  for (const original of cases) {
    const e = edit(freeze(original)); assert.deepEqual(e.buildPayload(e.initial), {});
    for (const name of keys.map(control)) {
      assert.equal(e.needsIntent(name), true); assert.equal(e.initial[name], ''); assert.equal(e.initial[name + 'Intent'], 'keep');
      assert.equal(e.enabled(name, e.initial), false); assert.equal(e.enabled(name, { [name + 'Intent']: 'replace' }), true);
      const f = e.fields.find(f => f.name === name); assert.equal(f.disabled, true); assert.equal(f.required, false);
    }
    assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
    e.confirm(next(original), original.orgId, {});
  }
});

test('single-line CRLF and textarea CR use keep, textarea LF stays safe and exact without email format policy', () => {
  for (const key of ['name', 'employeeNo', 'role', 'phone', 'email']) for (const value of ['PRIVATE\rX', 'PRIVATE\nX', 'PRIVATE\r\nX']) {
    const e = edit(row({ [key]: value })); assert.equal(e.needsIntent(key), true); assert.equal(e.initial[key], ''); assert.deepEqual(e.buildPayload(e.initial), {});
    fieldError(() => e.buildPayload({ [key + 'Intent']: 'replace', [key]: value }), key);
  }
  for (const key of ['qualification', 'regions', 'note']) {
    const text = ' 開頭\n\n尾端\n', normal = edit(row({ [key]: text })); assert.equal(normal.initial[key], text); assert.deepEqual(normal.buildPayload(normal.initial), {});
    const unsafe = edit(row({ [key]: 'PRIVATE\r\n' })); assert.equal(unsafe.needsIntent(key), true); assert.deepEqual(unsafe.buildPayload({ [key + 'Intent']: 'replace', [key]: text }), { [key]: text });
  }
  const e = edit(row()); assert.deepEqual(e.buildPayload({ email: ' a b@@非信箱 ', role: '__proto__' }), { role: '__proto__', email: ' a b@@非信箱 ' });
});

test('optional text clear is explicit while name employee number status hourly require valid replacement and never clear', () => {
  const e = edit(row(Object.fromEntries(keys.map(k => [k, null]))));
  const optional = ['role', 'phone', 'email', 'qualification', 'regions', 'note'];
  assert.deepEqual(e.buildPayload(Object.fromEntries(optional.map(k => [k + 'Intent', 'clear']))), Object.fromEntries(optional.map(k => [k, ''])));
  for (const k of ['name', 'employeeNo', 'status', 'hourlyRate']) fieldError(() => e.buildPayload({ [k + 'Intent']: 'clear' }), k + 'Intent');
  for (const k of ['name', 'employeeNo']) fieldError(() => e.buildPayload({ [k + 'Intent']: 'replace', [k]: '' }), k);
  assert.deepEqual(e.buildPayload({ nameIntent: 'replace', name: ' ', employeeNoIntent: 'replace', employeeNo: ' ', statusIntent: 'replace', status: 'inactive', hourlyRateIntent: 'replace', hourlyRate: '0.01' }), { name: ' ', employeeNo: ' ', status: 'inactive', hourlyRateCents: 1 });
  assert.deepEqual(e.buildPayload({ name: {}, regions: ['ignored'], hourlyRate: NaN }), {}, 'keep ignores disabled-control values');
});

test('new text limits match field-specific API lengths while unmodified compatible overlength imports omit', () => {
  for (const [key, limit] of [['name', 500], ['employeeNo', 500], ['role', 500], ['phone', 500], ['email', 500], ['qualification', 500], ['regions', 1000], ['note', 10000]]) {
    const e = edit(row()); assert.deepEqual(e.buildPayload({ [key]: 'x'.repeat(limit) }), { [key]: 'x'.repeat(limit) });
    fieldError(() => e.buildPayload({ [key]: 'x'.repeat(limit + 1) }), key);
    const imported = edit(row({ [key]: 'x'.repeat(limit + 1) })); assert.equal(imported.needsIntent(key), false); assert.deepEqual(imported.buildPayload(imported.initial), {});
  }
  for (const status of ['', 'constructor', 'published', false, []]) fieldError(() => edit(row()).buildPayload({ status }), 'status');
});

test('missing and unsafe hourly rate never become zero unless explicitly replaced', () => {
  const missing = row(); delete missing.hourlyRateCents;
  for (const original of [missing, ...[null, false, 0.5, -1, 1000000001, '0', {}].map(hourlyRateCents => row({ hourlyRateCents }))]) {
    const e = edit(original); assert.equal(e.needsIntent('hourlyRate'), true); assert.equal(e.initial.hourlyRate, ''); assert.deepEqual(e.buildPayload({ note: '備註' }), { note: '備註' });
    assert.deepEqual(e.buildPayload({ hourlyRateIntent: 'replace', hourlyRate: '0' }), { hourlyRateCents: 0 });
  }
});

test('unknown fields and illegal intents cannot inject metadata or mutate private validation via descriptors', () => {
  const e = edit(row({ regions: [] }));
  for (const bad of [null, [], false, 'x']) fieldError(() => e.buildPayload(bad), 'name');
  for (const key of ['id', 'orgId', 'version', 'billingSnapshot', 'hourlyRateCents', 'nameIntent', 'membership']) fieldError(() => e.buildPayload({ [key]: 'inject' }), key);
  fieldError(() => e.buildPayload(JSON.parse('{"__proto__":{"polluted":true}}')), '__proto__');
  for (const intent of ['', 'delete', null, false, {}]) fieldError(() => e.buildPayload({ regionsIntent: intent }), 'regionsIntent');
  e.initial.name = 'changed'; e.fields.find(f => f.name === 'status').options.push({ value: 'constructor', label: 'inject' });
  assert.deepEqual(e.buildPayload({}), {}); fieldError(() => e.buildPayload({ status: 'constructor' }), 'status'); assert.equal(e.enabled('unknown', {}), false); assert.equal({}.polluted, undefined);
});

test('private deep JSON and identity snapshots resist caller mutation and preserve special own property keys', () => {
  const special = JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false],"prototype":null}');
  const saved = freeze(row({ name: special, regions: ['PRIVATE', '', 'PRIVATE'], note: { inner: special } })), before = structuredClone(saved), e = edit(saved);
  e.confirm(next(before, { status: 'inactive' }), saved.orgId, { status: 'inactive' }); assert.deepEqual(saved, before); assert.ok(!JSON.stringify(e.fields).includes('PRIVATE')); assert.equal({}.secret, undefined);
  const mutable = row({ regions: ['old'], note: structuredClone(special) }), captured = structuredClone(mutable), editor = edit(mutable); mutable.regions.push('changed'); mutable.note.constructor[0] = 9; mutable.version = 99; mutable.id = 'other';
  editor.confirm(next(captured), captured.orgId, {}); unconfirmed(() => editor.confirm(next(mutable), captured.orgId, {}));
  for (const value of [undefined, NaN, Infinity, () => {}]) fieldError(() => edit(row({ note: value })), 'name');
  const cycle = {}; cycle.self = cycle; fieldError(() => edit(row({ note: cycle })), 'name');
});

test('create confirmation requires own identity exact version1 and all ten backend fields', () => {
  const e = edit(), p = e.buildPayload({ name: '合成', employeeNo: 'TEST', hourlyRate: '0.01' }), good = { id: 'new', orgId: 'synthetic-org', version: 1, ...p };
  assert.equal(e.confirm(good, good.orgId, p), good);
  for (const bad of [null, [], 'x', Object.create(good), { ...good, id: '' }, { ...good, orgId: 'other' }, { ...good, version: '1' }, { ...good, version: 2 }, { ...good, hourlyRateCents: '1' }]) unconfirmed(() => e.confirm(bad, good.orgId, p));
  for (const k of ['id', 'orgId', 'version', ...keys]) { const bad = { ...good }; delete bad[k]; unconfirmed(() => e.confirm(bad, good.orgId, p)); }
  unconfirmed(() => e.confirm(good, '', p)); unconfirmed(() => e.confirm(good, good.orgId, { ...p, hourlyRate: '0.01' })); unconfirmed(() => e.confirm(good, good.orgId, { name: '合成' }));
});

test('edit and status-only confirmation checks ten own-presence projections exact JSON and captured CAS identity', () => {
  const saved = row({ regions: ['', '北', '北', '\n', '\r'], role: false, hourlyRateCents: null }), e = edit(saved), payload = { status: 'inactive' }, good = next(saved, payload);
  e.confirm(good, saved.orgId, payload); e.confirm(good, saved.orgId, { ...payload, version: saved.version });
  for (const k of keys) { const bad = { ...good, [k]: { changed: true } }; unconfirmed(() => e.confirm(bad, saved.orgId, payload)); }
  for (const patch of [{ id: 'other' }, { orgId: 'other' }, { version: 4 }, { version: 6 }, { version: '5' }, { regions: ['', '北', '\n', '\r'] }]) unconfirmed(() => e.confirm({ ...good, ...patch }, saved.orgId, payload));
  for (const key of ['role', 'regions', 'hourlyRateCents']) { const missing = row(); delete missing[key]; const absent = edit(missing), reply = next(missing); absent.confirm(reply, missing.orgId, {}); unconfirmed(() => absent.confirm({ ...reply, [key]: key === 'hourlyRateCents' ? 0 : '' }, missing.orgId, {})); }
  unconfirmed(() => e.confirm(good, saved.orgId, { ...payload, version: 3 })); unconfirmed(() => e.confirm(good, saved.orgId, { ...payload, extra: 1 }));
  for (const version of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER]) { const bad = row({ version }); unconfirmed(() => edit(bad).confirm({ ...bad, version: 5 }, bad.orgId, {})); }
});
