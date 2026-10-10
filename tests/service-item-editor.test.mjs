import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceItemEditor } from '../public/data/service-item-editor.js';

const keys = ['code', 'name', 'minutes', 'unitPriceCents', 'validFrom', 'validTo', 'status', 'note'];
const control = key => key === 'unitPriceCents' ? 'unitPrice' : key;
const row = changes => ({ id: 'synthetic-service', orgId: 'synthetic-org', version: 4, code: ' TEST-原碼 ', name: ' 合成🙂服務 ', minutes: 30, unitPriceCents: 12345, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', note: '原文\n保留全形　空白', ...changes });
const edit = existing => createServiceItemEditor({ existing });
const values = (editor, changes = {}) => ({ ...editor.initial, ...changes });
const next = (saved, payload = {}) => ({ ...saved, ...payload, version: saved.version + 1 });
const fieldError = (fn, name) => assert.throws(fn, e => !!e.fields && Object.hasOwn(e.fields, name));
const unconfirmed = fn => assert.throws(fn, e => e.code === 'SAVE_UNCONFIRMED');
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

test('create sends eight untrimmed business fields with minutes30, exact zero text and active defaults', () => {
  const e = edit();
  assert.deepEqual(e.initial, { code: '', name: '', minutes: 30, unitPrice: '0.00', validFrom: '', validTo: '', status: 'active', note: '' });
  assert.deepEqual(e.fields.map(f => [f.name, f.type]), [['code', 'text'], ['name', 'text'], ['minutes', 'number'], ['unitPrice', 'text'], ['validFrom', 'date'], ['validTo', 'date'], ['status', 'select'], ['note', 'textarea']]);
  assert.equal(e.fields.find(f => f.name === 'unitPrice').inputMode, 'decimal');
  assert.deepEqual(e.fields.filter(f => f.required).map(f => f.name), ['code', 'name', 'minutes', 'unitPrice', 'status']);
  assert.deepEqual(e.buildPayload(values(e, { code: '  TEST-🙂\t', name: ' 全形　 ', note: '\n<&>\n' })), { code: '  TEST-🙂\t', name: ' 全形　 ', minutes: 30, unitPriceCents: 0, validFrom: '', validTo: '', status: 'active', note: '\n<&>\n' });
});

test('integer cents round-trip exactly at zero, one cent, fractional yuan and one-billion-cent boundary', () => {
  for (const [cents, text] of [[0, '0.00'], [1, '0.01'], [10, '0.10'], [29, '0.29'], [12345, '123.45'], [999999999, '9999999.99'], [1000000000, '10000000.00']]) {
    const e = edit(row({ unitPriceCents: cents })); assert.equal(e.initial.unitPrice, text); assert.equal(e.needsIntent('unitPrice'), false);
    assert.deepEqual(e.buildPayload(e.initial), {});
    const create = edit(); assert.equal(create.buildPayload(values(create, { code: 'TEST', name: '合成', unitPrice: text })).unitPriceCents, cents);
  }
});

test('equivalent decimal spellings omit price changes without floating point rounding or trimming', () => {
  for (const [saved, entries] of [[0, ['0', '00.0', '000.00']], [1, ['00.01']], [12300, ['123', '00123.0', '123.00']], [12345, ['000123.45']], [1000000000, ['10000000', '00010000000.00']]]) {
    const e = edit(row({ unitPriceCents: saved })); for (const unitPrice of entries) assert.deepEqual(e.buildPayload(values(e, { unitPrice })), {});
  }
  const e = edit(row()); assert.deepEqual(e.buildPayload(values(e, { unitPrice: '0.29' })), { unitPriceCents: 29 });
  assert.deepEqual(e.buildPayload(values(e, { unitPrice: '0'.repeat(2000) + '1.01' })), { unitPriceCents: 101 });
});

test('price rejects nonstrings, signs, exponent notation, whitespace, excess precision and exact overflow', () => {
  const e = edit(row());
  for (const unitPrice of ['', ' ', ' 1', '1 ', '+1', '-0', '-1', '1e2', '1E2', '1,000', '.01', '1.', '0.001', '1.000', '10000000.01', '10000001', '9'.repeat(1000), '１２.３４', '1\n', '1.2\n', '1.2\r\n', '1.2\r', '1.2\u2028', '1.2\u2029', '1.2\t', 1, 0, null, false, [], {}, undefined]) fieldError(() => e.buildPayload(values(e, { unitPrice })), 'unitPrice');
  fieldError(() => e.buildPayload({ unitPriceCents: 1 }), 'unitPriceCents');
});

test('normal edit emits only changes and exact reversion or no-op never spreads metadata', () => {
  const saved = freeze(row({ billingSnapshot: { secret: 'PRIVATE' }, fileId: 'PRIVATE', extra: 'PRIVATE' })), e = edit(saved);
  assert.deepEqual(e.buildPayload(values(e)), {}); assert.deepEqual(e.buildPayload({ name: '  明確新名字  ' }), { name: '  明確新名字  ' });
  assert.deepEqual(e.buildPayload(values(e, { code: saved.code, minutes: 30, note: saved.note, unitPrice: '00123.45' })), {});
  assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE')); assert.deepEqual(Object.keys(e.initial), keys.map(control));
});

test('missing, nullable, CRLF and typed JSON values stay out of controls and expose only keep/replace intent', () => {
  const cases = [row({ code: 'PRIVATE\rCODE', name: 'PRIVATE\nNAME', minutes: '30', unitPriceCents: '12345', validFrom: '0000-01-01', validTo: 'not-a-date', status: '__proto__', note: 'PRIVATE\r\nNOTE' }), row({ code: 0, name: false, minutes: {}, unitPriceCents: -1, validFrom: null, validTo: [], status: ['active'], note: { nested: 'PRIVATE' } }), { id: 'synthetic-service', orgId: 'synthetic-org', version: 1 }];
  for (const saved of cases) {
    const e = edit(freeze(saved)); assert.deepEqual(e.buildPayload(e.initial), {});
    for (const name of keys.map(control)) {
      assert.equal(e.needsIntent(name), true); assert.equal(e.initial[name], ''); assert.equal(e.initial[name + 'Intent'], 'keep');
      assert.equal(e.enabled(name, e.initial), false); assert.equal(e.enabled(name, values(e, { [name + 'Intent']: 'replace' })), true);
      const f = e.fields.find(f => f.name === name); assert.equal(f.disabled, true); assert.equal(f.required, false);
    }
    assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE')); assert.equal(e.needsIntent('unitPriceCents'), false);
  }
});

test('minute replacements are numeric safe integers1..1440 and unsupported saved numbers remain private', () => {
  for (const bad of [0, -1, 1441, 30.5, Number.MAX_SAFE_INTEGER + 1, '30', null, false, [], {}]) {
    const e = edit(row({ minutes: bad })); assert.equal(e.needsIntent('minutes'), true); assert.deepEqual(e.buildPayload(e.initial), {});
    fieldError(() => e.buildPayload(values(e, { minutesIntent: 'replace', minutes: bad })), 'minutes');
    assert.deepEqual(e.buildPayload(values(e, { minutesIntent: 'replace', minutes: 1 })), { minutes: 1 });
    assert.deepEqual(e.buildPayload(values(e, { minutesIntent: 'replace', minutes: 1440 })), { minutes: 1440 });
  }
  for (const bad of [null, false, '0', -1, 1000000001, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const e = edit(row({ unitPriceCents: bad })); assert.equal(e.needsIntent('unitPrice'), true); assert.deepEqual(e.buildPayload(values(e, { unitPriceIntent: 'replace', unitPrice: '0.01' })), { unitPriceCents: 1 });
  }
});

test('native dates use real nonzero four-digit years while range order remains the API responsibility', () => {
  const e = edit();
  for (const date of ['0001-01-01', '0099-12-31', '1900-02-28', '2000-02-29', '2024-02-29', '9999-12-31', '']) assert.equal(e.buildPayload(values(e, { code: 'TEST', name: '合成', validFrom: date })).validFrom, date);
  for (const date of ['0000-01-01', '1900-02-29', '2023-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-01', '10000-01-01', '2026-01-01T00:00:00Z', ' 2026-01-01', '2026-01-01\n', '2026-01-01\r\n', '2026-01-01\r', '2026-01-01\u2028', '2026-01-01\u2029', false]) {
    fieldError(() => e.buildPayload(values(e, { code: 'TEST', name: '合成', validFrom: date })), 'validFrom');
    const saved = edit(row({ validFrom: date })); assert.equal(saved.needsIntent('validFrom'), true); assert.deepEqual(saved.buildPayload(saved.initial), {});
  }
  assert.deepEqual(edit(row()).buildPayload({ validFrom: '2026-12-31', validTo: '2026-01-01' }), { validFrom: '2026-12-31', validTo: '2026-01-01' });
});

test('only optional dates and note can explicitly clear unsafe own values without leaking disabled input', () => {
  const e = edit(row({ validFrom: null, validTo: ['PRIVATE'], note: { secret: 'PRIVATE' }, minutes: '30', unitPriceCents: '0' }));
  assert.deepEqual(e.buildPayload(values(e, { validFromIntent: 'clear', validFrom: { ignored: true }, validToIntent: 'clear', noteIntent: 'clear' })), { validFrom: '', validTo: '', note: '' });
  for (const name of ['validFrom', 'validTo', 'note']) assert.equal(e.enabled(name, values(e, { [name + 'Intent']: 'clear' })), false);
  for (const name of ['minutes', 'unitPrice']) fieldError(() => e.buildPayload(values(e, { [name + 'Intent']: 'clear' })), name + 'Intent');
  const normal = edit(row()); assert.deepEqual(normal.buildPayload({ validFrom: '', validTo: '', note: '' }), { validFrom: '', validTo: '', note: '' });
  assert.deepEqual(e.buildPayload(values(e, { minutes: NaN, unitPrice: {}, note: ['ignored'] })), {}, 'keep ignores every disabled input');
});

test('text and status replacement enforce original lengths and representation without revalidating unchanged lengths', () => {
  const e = edit(row({ code: 0, name: false, status: 'unknown', note: null }));
  for (const [key, bad] of [['code', ''], ['name', ''], ['code', 'A\nB'], ['name', 'A\rB'], ['note', 'A\rB'], ['code', 'x'.repeat(501)], ['name', 'x'.repeat(501)], ['note', 'x'.repeat(10001)], ['status', 'constructor'], ['status', ''], ['code', false], ['name', 0]]) fieldError(() => e.buildPayload(values(e, { [key + 'Intent']: 'replace', [key]: bad })), key);
  assert.deepEqual(e.buildPayload(values(e, { codeIntent: 'replace', code: ' '.repeat(500), nameIntent: 'replace', name: ' 合成 ', statusIntent: 'replace', status: 'inactive', noteIntent: 'replace', note: '\n'.repeat(10000) })), { code: ' '.repeat(500), name: ' 合成 ', status: 'inactive', note: '\n'.repeat(10000) });
  const imported = edit(row({ code: 'x'.repeat(501), name: '', note: 'n'.repeat(10001) })); assert.deepEqual(imported.buildPayload(imported.initial), {});
});

test('unknown form keys and illegal intents reject without prototype pollution or mutable descriptor influence', () => {
  const e = edit(row({ note: null }));
  for (const input of [null, [], 'x', false]) fieldError(() => e.buildPayload(input), 'code');
  for (const key of ['id', 'orgId', 'version', 'billingSnapshot', 'codeIntent', 'unitPriceCents']) fieldError(() => e.buildPayload({ [key]: 'injected' }), key);
  fieldError(() => e.buildPayload(JSON.parse('{"__proto__":{"polluted":true}}')), '__proto__');
  for (const intent of ['', 'delete', false, null, {}]) fieldError(() => e.buildPayload(values(e, { noteIntent: intent })), 'noteIntent');
  e.fields.find(f => f.name === 'status').options.push({ value: 'constructor', label: 'inject' }); fieldError(() => e.buildPayload({ status: 'constructor' }), 'status');
  e.initial.unitPrice = '1.00'; assert.deepEqual(e.buildPayload({}), {}, 'public initial mutations do not mutate captured baseline'); assert.equal({}.polluted, undefined); assert.equal(e.enabled('missing', {}), false);
});

test('deep frozen JSON with special own keys preserves exact presence and captured identity independently of caller mutation', () => {
  const saved = freeze(row({ name: JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false],"prototype":null}'), note: ['PRIVATE', false] })), before = structuredClone(saved), e = edit(saved);
  const payload = e.buildPayload({ status: 'inactive' }); assert.equal(e.confirm(next(before, payload), saved.orgId, payload).status, 'inactive'); assert.deepEqual(saved, before); assert.ok(!JSON.stringify(e.fields).includes('PRIVATE')); assert.equal({}.secret, undefined);
  const mutable = row({ note: { nested: ['old'] } }), capture = structuredClone(mutable), editor = edit(mutable); mutable.note.nested[0] = 'changed'; mutable.version = 99; mutable.id = 'changed';
  editor.confirm(next(capture), capture.orgId, {}); unconfirmed(() => editor.confirm(next(mutable), mutable.orgId, {}));
  for (const value of [undefined, NaN, Infinity, () => {}]) fieldError(() => edit(row({ note: value })), 'code');
  const cycle = {}; cycle.self = cycle; fieldError(() => edit(row({ note: cycle })), 'code');
});

test('create confirmation requires own identity, version1 and all eight backend fields, never a price alias', () => {
  const e = edit(), p = e.buildPayload(values(e, { code: 'TEST', name: '合成', unitPrice: '0.01' })), good = { id: 'new', orgId: 'synthetic-org', version: 1, ...p };
  assert.equal(e.confirm(good, good.orgId, p), good);
  for (const bad of [null, [], 'x', { ...good, id: '' }, { ...good, orgId: 'other' }, { ...good, version: '1' }, { ...good, version: 2 }, { ...good, unitPriceCents: '1' }, Object.create(good)]) unconfirmed(() => e.confirm(bad, good.orgId, p));
  for (const key of ['id', 'orgId', 'version', ...keys]) { const bad = { ...good }; delete bad[key]; unconfirmed(() => e.confirm(bad, good.orgId, p)); }
  unconfirmed(() => e.confirm(good, '', p)); unconfirmed(() => e.confirm(good, good.orgId, { ...p, unitPrice: '0.01' })); unconfirmed(() => e.confirm(good, good.orgId, { code: 'TEST' }));
});

test('edit and status-only confirmation check all eight own-presence JSON fields, expected CAS and omitted values', () => {
  const saved = row({ minutes: '30', unitPriceCents: false, note: null }), e = edit(saved), payload = { status: 'inactive' }, good = next(saved, payload);
  assert.equal(e.confirm(good, saved.orgId, payload), good); assert.equal(e.confirm(good, saved.orgId, { ...payload, version: saved.version }), good);
  for (const key of keys) { const bad = { ...good, [key]: { changed: true } }; unconfirmed(() => e.confirm(bad, saved.orgId, payload)); }
  for (const patch of [{ id: 'other' }, { orgId: 'other' }, { version: 4 }, { version: 6 }, { version: '5' }]) unconfirmed(() => e.confirm({ ...good, ...patch }, saved.orgId, payload));
  const missing = row(); delete missing.validFrom; const absent = edit(missing), reply = next(missing); absent.confirm(reply, missing.orgId, {}); unconfirmed(() => absent.confirm({ ...reply, validFrom: '' }, missing.orgId, {}));
  unconfirmed(() => e.confirm(good, saved.orgId, { ...payload, version: 3 })); unconfirmed(() => e.confirm(good, saved.orgId, { ...payload, extra: 1 }));
  for (const version of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER]) { const x = row({ version }); unconfirmed(() => edit(x).confirm({ ...x, version: 5 }, x.orgId, {})); }
});
