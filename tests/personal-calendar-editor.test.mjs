import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalCalendarEditor, confirmPersonalCalendarList, personalCalendarIdentity,
  isPersonalCalendarDate, isPersonalCalendarTime, formatPersonalCalendarText, formatPersonalCalendarStatus } from '../public/data/personal-calendar-editor.js';
import { getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

const orgId = 'calendar-org', ownerUserId = 'calendar-user';
const baseline = () => ({ id: 'event-one', orgId, ownerUserId, version: 7,
  title: '  合成日內事件  ', date: '2026-10-10', startTime: '09:00', endTime: '10:00', note: '  原備註\n第二行  ', status: 'active' });
const editor = existing => createPersonalCalendarEditor({ existing, ownerUserId });
const requested = overrides => ({ page: 1, pageSize: 25, orgId, ownerUserId, ...overrides });
const list = rows => ({ items: rows, total: rows.length, page: 1, pageSize: 25 });
const updated = (row, payload) => ({ ...structuredClone(row), ...payload, version: row.version + 1 });
const unconfirmed = error => error.code === 'SAVE_UNCONFIRMED' && error.message === '儲存結果未確認；請保留輸入並重新讀取確認。';

test('new events keep whitespace and LF and derive no owner payload', () => {
  const state = createPersonalCalendarEditor({ ownerUserId, defaultDate: '2026-10-10' });
  const payload = state.buildPayload({ ...state.initial, title: '  合成日內事件  ', startTime: '09:00', endTime: '10:00', note: '  合成\n備註  ' });
  assert.deepEqual(payload, { title: '  合成日內事件  ', date: '2026-10-10', startTime: '09:00', endTime: '10:00', note: '  合成\n備註  ', status: 'active' });
  assert.equal(state.fields.some(field => field.name === 'ownerUserId'), false);
  assert.equal(state.fields.find(field => field.name === 'status').disabled, true);
  assert.equal(state.confirm({ id: 'event-new', orgId, ownerUserId, version: 1, ...payload }, orgId, payload).ownerUserId, ownerUserId);
});

test('date and time accept exact literal boundaries, without timezone parsing', () => {
  for (const value of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) assert.equal(isPersonalCalendarDate(value), true, value);
  for (const value of ['0000-01-01', '1900-02-29', '2026-02-29', '2026-04-31', '2026-13-01', '2026-10-10T00:00:00Z', ' 2026-10-10', null, 20261010]) assert.equal(isPersonalCalendarDate(value), false);
  for (const value of ['00:00', '23:59']) assert.equal(isPersonalCalendarTime(value), true);
  for (const value of ['24:00', '09:60', '9:00', '09:00:00', '09:00Z', ' 09:00', null]) assert.equal(isPersonalCalendarTime(value), false);
});

test('untouched valid event emits no business fields, even with padding', () => {
  const row = baseline(), state = editor(row);
  assert.equal(state.initial.title, row.title);
  assert.equal(state.initial.note, row.note);
  assert.deepEqual(state.buildPayload(state.initial), {});
  assert.deepEqual(state.buildPayload({ ...state.initial, title: '  新合成標題  ' }), { title: '  新合成標題  ' });
});

test('opaque values and missing own presence stay private until an explicit repair', () => {
  const row = baseline(); row.title = { hidden: '不得展示合成原值' }; row.date = '0000-01-01'; row.startTime = null; row.endTime = ['09:00']; delete row.note;
  const state = editor(row);
  for (const name of ['title', 'date', 'startTime', 'endTime', 'note']) {
    assert.equal(state.needsIntent(name), true); assert.equal(state.initial[name], ''); assert.equal(state.initial[name + 'Intent'], 'keep'); assert.equal(state.enabled(name, state.initial), false);
  }
  assert.equal(JSON.stringify(state.initial).includes('不得展示'), false);
  assert.equal(JSON.stringify(state.fields).includes('不得展示'), false);
  assert.deepEqual(state.buildPayload({ ...state.initial, title: '偶然輸入', date: '2026-10-11' }), {});
  const payload = state.buildPayload({ ...state.initial, titleIntent: 'replace', title: '修復合成事件', dateIntent: 'replace', date: '2026-10-11', startTimeIntent: 'replace', startTime: '09:00', endTimeIntent: 'replace', endTime: '10:00' });
  assert.deepEqual(payload, { title: '修復合成事件', date: '2026-10-11', startTime: '09:00', endTime: '10:00' });
  const ack = updated(row, payload); assert.equal(state.confirm(ack, orgId, payload).title, '修復合成事件');
  assert.throws(() => state.confirm({ ...ack, note: '' }, orgId, payload), unconfirmed);
});

test('native CR preservation leaves old note untouched and explicit replacement keeps supplied bytes', () => {
  const row = baseline(); row.note = '  合成\r\n原換行\r末行  ';
  const state = editor(row);
  assert.equal(state.needsIntent('note'), true);
  assert.deepEqual(state.buildPayload({ ...state.initial, title: '只改合成標題' }), { title: '只改合成標題' });
  const first = { title: '只改合成標題' }; assert.equal(state.confirm(updated(row, first), orgId, first).note, row.note);
  const payload = state.buildPayload({ ...state.initial, noteIntent: 'replace', note: '  明確\r\n新換行  ' });
  assert.deepEqual(payload, { note: '  明確\r\n新換行  ' });
  assert.equal(state.confirm(updated(row, payload), orgId, payload).note, payload.note);
  assert.throws(() => state.confirm(updated(row, { note: payload.note.replaceAll('\r', '') }), orgId, payload), unconfirmed);
});

test('optional note clear is distinct from keep, while mandatory fields cannot clear', () => {
  const row = baseline(); row.note = { opaque: true }; row.title = null;
  const state = editor(row);
  assert.deepEqual(state.buildPayload(state.initial), {});
  assert.deepEqual(state.buildPayload({ ...state.initial, noteIntent: 'clear' }), { note: '' });
  assert.throws(() => state.buildPayload({ ...state.initial, titleIntent: 'clear' }), error => Boolean(error.fields.titleIntent));
  assert.equal(state.fields.find(field => field.name === 'noteIntent').options.some(option => option.value === 'clear'), true);
});

test('text limits preserve exact supplied lengths and reject mandatory blank or multiline title', () => {
  const state = editor(baseline());
  assert.equal(state.buildPayload({ title: '字'.repeat(200), note: '字'.repeat(10000) }).note.length, 10000);
  for (const title of ['', ' \t ', '合成\r標題', '合成\n標題', '字'.repeat(201), false]) assert.throws(() => state.buildPayload({ title }), error => Boolean(error.fields.title));
  assert.throws(() => state.buildPayload({ note: '字'.repeat(10001) }), error => Boolean(error.fields.note));
  assert.deepEqual(state.buildPayload({ note: ' \n\r ' }), { note: ' \n\r ' });
});

test('time ordering validates changed same-day pair without inventing conflict or duration rules', () => {
  const state = editor(baseline());
  for (const endTime of ['08:59', '09:00', '00:00']) assert.throws(() => state.buildPayload({ endTime }), error => Boolean(error.fields.endTime));
  assert.deepEqual(state.buildPayload({ startTime: '00:00', endTime: '23:59' }), { startTime: '00:00', endTime: '23:59' });
  const raw = baseline(); raw.startTime = { hidden: 1 }; const legacy = editor(raw);
  assert.deepEqual(legacy.buildPayload({ ...legacy.initial, note: '只改備註，merged由伺服器核對' }), { note: '只改備註，merged由伺服器核對' });
});

test('known status stays outside edit; independent cancellation changes only status', () => {
  const row = baseline(), state = editor(row);
  assert.throws(() => state.buildPayload({ ...state.initial, status: 'cancelled' }), error => Boolean(error.fields.status));
  const payload = state.buildStatusChange('cancelled'); assert.deepEqual(payload, { status: 'cancelled' });
  assert.equal(state.confirm(updated(row, payload), orgId, payload).note, row.note);
  assert.throws(() => state.buildStatusChange('active'));
  const cancelled = editor({ ...row, status: 'cancelled' }); assert.deepEqual(cancelled.buildStatusChange('active'), { status: 'active' });
  assert.equal(cancelled.enabled('status'), false);
});

test('unknown/missing status requires explicit repair and has no guessed action', () => {
  for (const raw of ['future', null, { hidden: '合成狀態' }, undefined]) {
    const row = baseline(); if (raw === undefined) delete row.status; else row.status = raw;
    const state = editor(row);
    assert.equal(state.initial.statusRepair, 'keep'); assert.equal(Object.hasOwn(state.initial, 'status'), false);
    assert.deepEqual(state.buildPayload(state.initial), {});
    assert.deepEqual(state.buildPayload({ ...state.initial, statusRepair: 'cancelled' }), { status: 'cancelled' });
    assert.throws(() => state.buildStatusChange('active'));
    assert.throws(() => state.buildPayload({ ...state.initial, statusRepair: 'future' }), error => Boolean(error.fields.statusRepair));
  }
});

test('original identity requires own valid org/owner/id/version and never permits transfer', () => {
  for (const replacement of [{ ownerUserId: 'someone-else' }, { id: '' }, { version: 0 }, { version: '7' }, { orgId: null }]) assert.throws(() => editor({ ...baseline(), ...replacement }));
  const row = baseline(); delete row.ownerUserId; assert.throws(() => editor(row));
  assert.throws(() => createPersonalCalendarEditor());
  assert.throws(() => editor(baseline()).buildPayload({ ownerUserId: 'someone-else' }));
});

test('acknowledgement rejects wrong id/org/owner/version and every supplied field mismatch', () => {
  const row = baseline(), state = editor(row), payload = { title: '明確更新合成事件' }, ack = updated(row, payload);
  for (const patch of [{ id: 'wrong' }, { orgId: 'other-org' }, { ownerUserId: 'other-user' }, { version: 7 }, { version: 9 }, { version: '8' }]) assert.throws(() => state.confirm({ ...ack, ...patch }, orgId, payload), unconfirmed);
  for (const name of ['title', 'date', 'startTime', 'endTime', 'note', 'status']) {
    assert.throws(() => state.confirm({ ...ack, [name]: '改錯保存內容' }, orgId, payload), unconfirmed);
    const absent = { ...ack }; delete absent[name]; assert.throws(() => state.confirm(absent, orgId, payload), unconfirmed);
  }
  assert.throws(() => state.confirm(null, orgId, payload), unconfirmed);
  assert.throws(() => state.confirm(ack, orgId, { ...payload, ownerUserId }), unconfirmed);
});

test('create acknowledgement requires version one, all six fields and exact untrimmed title', () => {
  const state = createPersonalCalendarEditor({ ownerUserId, defaultDate: '2026-10-10' });
  const payload = state.buildPayload({ title: '  新合成  ', startTime: '09:00', endTime: '10:00' });
  const ack = { id: 'new', orgId, ownerUserId, version: 1, ...payload };
  for (const patch of [{ title: '新合成' }, { version: 2 }, { ownerUserId: 'other' }, { id: null }]) assert.throws(() => state.confirm({ ...ack, ...patch }, orgId, payload), unconfirmed);
  const absent = { ...ack }; delete absent.note; assert.throws(() => state.confirm(absent, orgId, payload), unconfirmed);
  assert.throws(() => state.confirm(ack, orgId, { ...payload, version: 1 }), unconfirmed);
});

test('saved opaque JSON is detached, prototype-safe, and compared without revealing hidden content', () => {
  const row = baseline(); row.note = JSON.parse('{"__proto__":{"polluted":true},"nested":[false,null,2]}');
  const state = editor(row); row.note.nested[2] = 9;
  const payload = { title: '合成新標題' }, ack = updated(baseline(), payload);
  ack.note = JSON.parse('{"__proto__":{"polluted":true},"nested":[false,null,2]}');
  assert.equal(state.confirm(ack, orgId, payload).note.nested[2], 2);
  assert.equal({}.polluted, undefined);
  ack.note.nested[2] = 3; assert.throws(() => state.confirm(ack, orgId, payload), unconfirmed);
  assert.equal(formatPersonalCalendarText(row.note), '保存物件（內容未展示）');
  assert.equal(formatPersonalCalendarText(false), '保存布林值（內容未展示）');
  assert.equal(formatPersonalCalendarText(undefined), '未保存');
});

test('unsupported prototypes, accessors, cycles and sparse arrays cannot enter a private baseline', () => {
  let getterCalls = 0;
  const getter = {}; Object.defineProperty(getter, 'hidden', { enumerable: true, get() { getterCalls++; return 'secret'; } });
  const cycle = {}; cycle.self = cycle;
  for (const note of [getter, cycle, new Date(), [1, , 3], Infinity]) assert.throws(() => editor({ ...baseline(), note }));
  assert.equal(getterCalls, 0);
  const row = baseline(); Object.defineProperty(row, 'ownerUserId', { enumerable: true, get() { getterCalls++; return ownerUserId; } });
  assert.throws(() => editor(row)); assert.equal(getterCalls, 0);
});

test('maximum safe current version cannot be acknowledged as a fabricated next version', () => {
  const row = { ...baseline(), version: Number.MAX_SAFE_INTEGER }, state = editor(row);
  assert.throws(() => state.confirm({ ...row, version: Number.MAX_SAFE_INTEGER + 1, title: '合成' }, orgId, { title: '合成' }), unconfirmed);
});

test('list confirmation accepts exact own rows and legitimate out-of-range empty page', () => {
  assert.equal(confirmPersonalCalendarList(list([baseline()]), requested()).items[0].ownerUserId, ownerUserId);
  assert.deepEqual(confirmPersonalCalendarList({ items: [], total: 26, page: 3, pageSize: 25 }, requested({ page: 3 })).items, []);
  const legacy = baseline(); legacy.note = { hidden: 1 }; delete legacy.date;
  assert.equal(confirmPersonalCalendarList(list([legacy]), requested()).items[0].note.hidden, 1);
});

test('list confirmation rejects other owners, duplicate ids, partial pages and untrusted envelope', () => {
  for (const row of [{ ...baseline(), ownerUserId: 'other' }, { ...baseline(), orgId: 'other' }, { ...baseline(), id: '' }, { ...baseline(), version: false }]) assert.throws(() => confirmPersonalCalendarList(list([row]), requested()));
  assert.throws(() => confirmPersonalCalendarList(list([baseline(), baseline()]), requested()));
  for (const patch of [{ total: 2 }, { total: -1 }, { page: 2 }, { pageSize: 100 }, { extra: true }, { items: [baseline(), , baseline()] }]) assert.throws(() => confirmPersonalCalendarList({ ...list([baseline()]), ...patch }, requested()));
  const row = baseline(); delete row.ownerUserId; assert.throws(() => confirmPersonalCalendarList(list([row]), requested()));
});

test('list conditions confirm exact date/status and q in separate own title/note strings', () => {
  const row = baseline(); row.title = 'Alpha'; row.note = 'Beta';
  assert.equal(confirmPersonalCalendarList(list([row]), requested({ q: 'ALPH', date: row.date, status: 'active' })).total, 1);
  for (const query of [{ q: 'haBe' }, { q: ' Alpha' }, { date: '2026-10-11' }, { status: 'cancelled' }, { q: 'x'.repeat(201) }, { date: '0000-01-01' }, { status: 'future' }]) assert.throws(() => confirmPersonalCalendarList(list([row]), requested(query)));
  row.note = { hidden: 'Beta' }; assert.throws(() => confirmPersonalCalendarList(list([row]), requested({ q: 'Beta' })));
});

test('primitive identity cannot collide and stays stable for equivalent nested references', () => {
  const context = { user: { id: ownerUserId, employeeId: 'emp' }, organizationId: orgId, role: 'caregiver', organizations: [{ id: orgId }] };
  assert.equal(personalCalendarIdentity(context), personalCalendarIdentity({ ...context, user: { ...context.user }, organizations: [{ id: orgId }] }));
  for (const changed of [{ ...context, role: 'finance' }, { ...context, user: { ...context.user, id: 'other' } }, { ...context, user: { ...context.user, employeeId: null } }, { ...context, organizationId: 'other' }]) assert.notEqual(personalCalendarIdentity(context), personalCalendarIdentity(changed));
  assert.notEqual(personalCalendarIdentity({ user: { id: 'a:b' }, orgId: 'c' }), personalCalendarIdentity({ user: { id: 'a' }, orgId: 'b:c' }));
});

test('new history descriptors expose only six business fields and preserve literal text', () => {
  assert.deepEqual(getHistoryFields('personal-calendar-events').map(field => field.key), ['title', 'date', 'startTime', 'endTime', 'note', 'status']);
  const row = baseline(), normalized = normalizeHistorySnapshot('personal-calendar-events', row);
  assert.equal(normalized.title, row.title); assert.equal(normalized.note, row.note);
  assert.deepEqual(diffHistorySnapshots('personal-calendar-events', row, { ...row, note: '明確修改\n末行' }).map(field => field.key), ['note']);
  assert.deepEqual(normalizeHistorySnapshot('personal-calendar-events', { title: { hidden: '不得展示' } }).title, { invalid: true });
  assert.equal(formatPersonalCalendarStatus('active'), '有效'); assert.equal(formatPersonalCalendarStatus('cancelled'), '已取消');
});
