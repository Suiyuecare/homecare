import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaveEditor } from '../public/data/leave-editor.js';

const keys = ['employeeId', 'date', 'startTime', 'endTime', 'type', 'reason', 'status'];
const employees = [{ id: 'employee-a', name: ' 合成甲 ', employeeNo: 'TEST-A', status: 'active' }, { id: 'employee-b', name: '合成乙', employeeNo: 'TEST-B', status: 'inactive' }];
const row = changes => ({ id: 'leave-a', orgId: 'org-a', version: 4, employeeId: 'employee-a', date: '2026-10-09', startTime: '09:00', endTime: '10:00', type: ' 自訂假別 ', reason: ' 原因\n第二行\n', status: 'pending', ...changes });
const edit = existing => createLeaveEditor({ existing, employees, defaultDate: '2026-10-09' });
const next = (saved, payload = {}) => ({ ...saved, ...payload, version: saved.version + 1 });
const fieldError = (fn, name) => assert.throws(fn, error => !!error.fields && Object.hasOwn(error.fields, name));
const unconfirmed = fn => assert.throws(fn, error => error.code === 'SAVE_UNCONFIRMED');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('create adds explicit-date controls while legacy payload retains the original seven fields', () => {
  const e = edit();
  assert.deepEqual(e.initial, { employeeId: '', date: '2026-10-09', startTime: '09:00', endTime: '10:00', type: '', reason: '', spanMode: 'legacy', endDate: '' });
  assert.deepEqual(e.fields.map(f => [f.name, f.type]), [['spanMode', 'select'], ['employeeId', 'select'], ['date', 'date'], ['endDate', 'date'], ['startTime', 'time'], ['endTime', 'time'], ['type', 'text'], ['reason', 'textarea']]);
  assert.deepEqual(e.fields.filter(f => f.required).map(f => f.name), ['spanMode', ...keys.slice(0, 5)]);
  fieldError(() => e.buildPayload(e.initial), 'employeeId');
  assert.deepEqual(e.buildPayload({ employeeId: 'employee-b', type: ' 　', reason: '  原因\n' }), { employeeId: 'employee-b', date: '2026-10-09', startTime: '09:00', endTime: '10:00', type: ' 　', reason: '  原因\n', status: 'pending' });
  for (const defaultDate of ['', '0000-01-01', '2026-02-30', null, {}]) assert.equal(createLeaveEditor({ defaultDate }).initial.date, '');
});

test('employee options include inactive staff use only safe text and cannot be expanded by descriptor or caller mutation', () => {
  const people = [...structuredClone(employees), { id: 'nameless', name: { secret: 'PRIVATE' }, employeeNo: ['PRIVATE'] }, { id: 'line', name: 'PRIVATE\nname', employeeNo: 'PRIVATE\rno' }, { id: {}, name: 'PRIVATE' }, { id: '', name: 'PRIVATE' }, { id: 'employee-a', name: 'duplicate' }];
  const e = createLeaveEditor({ existing: row(), employees: people });
  assert.deepEqual(e.fields.find(f => f.name === 'employeeId').options.map(x => x.value), ['employee-a', 'employee-b', 'nameless', 'line']);
  assert.equal(e.fields.find(f => f.name === 'employeeId').options[2].label, '未提供姓名'); assert.equal(e.fields.find(f => f.name === 'employeeId').options[3].label, '未提供姓名');
  assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
  people[1].id = 'injected'; people.push({ id: 'injected-two', name: 'x' }); e.fields.find(f => f.name === 'employeeId').options.push({ value: 'injected', label: 'x' }); e.initial.employeeId = 'injected';
  assert.deepEqual(e.buildPayload({ employeeId: 'employee-b' }), { employeeId: 'employee-b' });
  for (const value of ['injected', 'injected-two', '', null, {}, ['employee-a']]) fieldError(() => e.buildPayload({ employeeId: value }), 'employeeId');
  assert.deepEqual(e.buildPayload({}), {});
});

test('normal edits and reversions omit unchanged values without exposing status or unrelated metadata', () => {
  const original = freeze(row({ billingSnapshot: { secret: 'PRIVATE' }, extra: 'PRIVATE' })), e = edit(original);
  assert.deepEqual(e.buildPayload(e.initial), {}); assert.deepEqual(e.buildPayload({ type: original.type, reason: ' 改原因\n' }), { reason: ' 改原因\n' });
  assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
  assert.equal(Object.hasOwn(e.initial, 'status'), false); assert.equal(e.fields.some(f => f.name === 'status'), false);
  fieldError(() => e.buildPayload({ status: 'approved' }), 'status'); fieldError(() => e.buildPayload({ statusIntent: 'replace' }), 'statusIntent');
  assert.deepEqual(e.buildPayload({ startTime: '11:00', endTime: '09:00' }), { startTime: '11:00', endTime: '09:00' }, 'cross-field interval validation stays with original API');
});

test('same-day ISO and year0000 stay private and unchanged until explicit native replacement', () => {
  const original = freeze(row({ date: '0000-02-29', startTime: '0000-02-29T09:30:51+08:00', endTime: '0000-02-29T10:15:20+08:00' })), e = edit(original);
  for (const name of ['date', 'startTime', 'endTime']) { assert.equal(e.initial[name], ''); assert.equal(e.initial[name + 'Intent'], 'keep'); assert.equal(e.enabled(name, e.initial), false); assert.equal(e.fields.find(f => f.name === name).required, false); }
  assert.deepEqual(e.buildPayload({ reason: '只改原因' }), { reason: '只改原因' }); e.confirm(next(original, { reason: '只改原因' }), original.orgId, { reason: '只改原因' });
  assert.ok(!JSON.stringify(e.fields).includes('0000-02-29T'));
  assert.deepEqual(e.buildPayload({ dateIntent: 'replace', date: '2026-10-10' }), { date: '2026-10-10' }, 'kept ISO is never silently redated');
  assert.deepEqual(e.buildPayload({ startTimeIntent: 'replace', startTime: '09:30', endTimeIntent: 'replace', endTime: '10:15' }), { startTime: '09:30', endTime: '10:15' });
});

test('native date and time replacements validate complete calendar and minute strings without coercion', () => {
  const e = edit(row());
  for (const date of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) assert.deepEqual(e.buildPayload({ date }), { date });
  for (const date of ['', '0000-01-01', '1900-02-29', '2026-02-29', '2026-02-30', '2026-13-01', '10000-01-01', '2026-10-09\n', false, null, ['2026-10-09']]) fieldError(() => e.buildPayload({ date }), 'date');
  for (const name of ['startTime', 'endTime']) {
    for (const value of ['00:00', '23:59']) assert.deepEqual(e.buildPayload({ [name]: value }), { [name]: value });
    for (const value of ['', '9:00', '24:00', '09:60', '09:00:00', '09:00\n', ' 09:00', '09:00 ', '2026-10-09T09:00:00Z', 900, null, {}, ['09:00']]) fieldError(() => e.buildPayload({ [name]: value }), name);
  }
});

test('missing and typed JSON values stay outside controls with exact own-presence and reason-only clear', () => {
  const originals = [{ id: 'leave-a', orgId: 'org-a', version: 1 }, row(Object.fromEntries(keys.map(k => [k, null]))), row({ employeeId: ['PRIVATE'], date: false, startTime: {}, endTime: 42, type: { hidden: 'PRIVATE' }, reason: ['PRIVATE'], status: 'unknown' })];
  for (const original of originals) {
    const e = edit(freeze(original)); assert.deepEqual(e.buildPayload(e.initial), {});
    for (const name of keys.slice(0, -1)) { assert.equal(e.needsIntent(name), true); assert.equal(e.initial[name], ''); assert.equal(e.enabled(name, { [name + 'Intent']: 'replace' }), true); assert.equal(e.fields.find(f => f.name === name).required, false); }
    assert.ok(!JSON.stringify({ fields: e.fields, initial: e.initial }).includes('PRIVATE')); e.confirm(next(original), original.orgId, {});
    assert.deepEqual(e.buildPayload({ reasonIntent: 'clear', reason: { ignored: true } }), { reason: '' });
    for (const name of keys.slice(0, -2)) fieldError(() => e.buildPayload({ [name + 'Intent']: 'clear' }), name + 'Intent');
    assert.deepEqual(e.buildPayload({ employeeId: 'injected', type: false, reason: NaN }), {}, 'keep ignores disabled values');
  }
});

test('CRLF is preserved privately while LF reason and whitespace free-text retain exact native text', () => {
  const e = edit(row({ type: 'PRIVATE\r\n假別', reason: 'PRIVATE\r\n原因' }));
  assert.equal(e.needsIntent('type'), true); assert.equal(e.needsIntent('reason'), true); assert.deepEqual(e.buildPayload(e.initial), {});
  assert.deepEqual(e.buildPayload({ typeIntent: 'replace', type: ' 自訂\t假別 ', reasonIntent: 'replace', reason: ' 原因\n\n尾端\n' }), { type: ' 自訂\t假別 ', reason: ' 原因\n\n尾端\n' });
  for (const type of ['a\rb', 'a\nb', 'a\r\nb', '', false]) fieldError(() => e.buildPayload({ typeIntent: 'replace', type }), 'type');
  for (const reason of ['a\rb', 'a\r\nb', null, []]) fieldError(() => e.buildPayload({ reasonIntent: 'replace', reason }), 'reason');
  assert.deepEqual(edit(row()).buildPayload({ reason: '' }), { reason: '' });
});

test('new limits count UTF16 units while unchanged compatible oversized imported strings omit', () => {
  for (const [name, size] of [['type', 500], ['reason', 10000]]) {
    const e = edit(row()), boundary = '🙂'.repeat(size / 2); assert.deepEqual(e.buildPayload({ [name]: boundary }), { [name]: boundary });
    fieldError(() => e.buildPayload({ [name]: boundary + 'x' }), name);
    const imported = edit(row({ [name]: boundary + 'x' })); assert.equal(imported.needsIntent(name), false); assert.deepEqual(imported.buildPayload(imported.initial), {});
  }
});

test('unknown fields illegal intent and special own keys cannot modify the private field or employee policy', () => {
  const e = edit(row({ reason: null }));
  for (const bad of [null, [], false, 'x']) fieldError(() => e.buildPayload(bad), 'employeeId');
  for (const key of ['id', 'orgId', 'version', 'status', 'billingSnapshot', 'employeeIdIntent', 'delete', 'constructor']) fieldError(() => e.buildPayload({ [key]: 'inject' }), key);
  fieldError(() => e.buildPayload(JSON.parse('{"__proto__":{"polluted":true}}')), '__proto__');
  for (const intent of ['', 'delete', null, false, {}]) fieldError(() => e.buildPayload({ reasonIntent: intent }), 'reasonIntent');
  e.fields.find(f => f.name === 'reasonIntent').options.push({ value: 'delete', label: 'delete' }); e.initial.reasonIntent = 'delete';
  assert.deepEqual(e.buildPayload({}), {}); assert.equal(e.enabled('unknown', {}), false); assert.equal({}.polluted, undefined);
});

test('private own JSON and identity resist later mutation without serializing special-key contents into fields', () => {
  const special = JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false],"prototype":null}');
  const original = freeze(row({ type: special, reason: { nested: special } })), saved = structuredClone(original), e = edit(original);
  e.confirm(next(saved, { status: 'approved' }), saved.orgId, { status: 'approved' }); assert.deepEqual(original, saved); assert.ok(!JSON.stringify(e.fields).includes('PRIVATE')); assert.equal({}.secret, undefined);
  const mutable = row({ reason: structuredClone(special) }), copy = structuredClone(mutable), captured = edit(mutable);
  mutable.reason.constructor[0] = 9; mutable.id = 'changed'; mutable.orgId = 'other'; mutable.version = 99;
  captured.confirm(next(copy), copy.orgId, {}); unconfirmed(() => captured.confirm(next(mutable), copy.orgId, {}));
  for (const reason of [undefined, NaN, Infinity, () => {}]) fieldError(() => edit(row({ reason })), 'employeeId');
  const cycle = {}; cycle.self = cycle; fieldError(() => edit(row({ reason: cycle })), 'employeeId');
});

test('new save confirmation requires own identity version1 and every exact seven-field value', () => {
  const e = edit(), p = e.buildPayload({ employeeId: 'employee-a', type: '合成' }), good = { id: 'new', orgId: 'org-a', version: 1, ...p };
  assert.equal(e.confirm(good, good.orgId, p), good);
  for (const bad of [null, [], {}, Object.create(good), { ...good, id: '' }, { ...good, orgId: 'other' }, { ...good, version: '1' }, { ...good, version: 2 }, { ...good, status: 'approved' }]) unconfirmed(() => e.confirm(bad, good.orgId, p));
  for (const key of ['id', 'orgId', 'version', ...keys]) { const bad = { ...good }; delete bad[key]; unconfirmed(() => e.confirm(bad, good.orgId, p)); }
  unconfirmed(() => e.confirm(good, '', p)); unconfirmed(() => e.confirm(good, good.orgId, { ...p, extra: 1 })); unconfirmed(() => e.confirm(good, good.orgId, { type: '合成' }));
});

test('edit and status-only confirmation include six untouched fields own presence and exact captured next version', () => {
  const original = row({ type: ['原假別'], reason: null }), e = edit(original), payload = { status: 'approved' }, good = next(original, payload);
  e.confirm(good, original.orgId, payload); e.confirm(good, original.orgId, { ...payload, version: original.version });
  for (const key of keys) { const bad = { ...good, [key]: { changed: true } }; unconfirmed(() => e.confirm(bad, original.orgId, payload)); }
  for (const patch of [{ id: 'other' }, { orgId: 'other' }, { version: 4 }, { version: 6 }, { version: '5' }, { type: '原假別' }, { reason: '' }]) unconfirmed(() => e.confirm({ ...good, ...patch }, original.orgId, payload));
  const missing = row(); delete missing.reason; const absent = edit(missing), reply = next(missing); absent.confirm(reply, missing.orgId, {}); unconfirmed(() => absent.confirm({ ...reply, reason: '' }, missing.orgId, {}));
  unconfirmed(() => e.confirm(good, original.orgId, { ...payload, version: 3 }));
  for (const version of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER]) { const invalid = row({ version }); unconfirmed(() => edit(invalid).confirm({ ...invalid, version: 5 }, invalid.orgId, {})); }
});
