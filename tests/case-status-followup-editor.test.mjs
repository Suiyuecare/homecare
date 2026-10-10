import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseStatusFollowupEditor, FOLLOWUP_KINDS, FOLLOWUP_STATUSES, formatFollowupText, formatFollowupDate, formatFollowupKind, formatFollowupStatus } from '../public/data/case-status-followup-editor.js';
import { getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

const names = ['caseId', 'kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status'];
const row = changes => ({ id: 'followup-synthetic', orgId: 'org-synthetic', version: 4, caseId: 'case-synthetic', kind: 'pause', startDate: '2026-10-09', endDate: '', reason: ' 原因\n第二行\n', followUpDate: '', outcome: ' 原結果 ', note: ' 原備註 ', status: 'pending', ...changes });
const edit = existing => createCaseStatusFollowupEditor({ existing, caseId: 'case-synthetic', defaultDate: '2026-10-09' });
const next = (existing, payload = {}) => ({ ...existing, ...payload, version: existing.version + 1 });
const fieldError = (fn, name) => assert.throws(fn, error => Boolean(error.fields && Object.hasOwn(error.fields, name)));
const unconfirmed = fn => assert.throws(fn, error => error.code === 'SAVE_UNCONFIRMED');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('new form fixes the parent and emits all nine fields with native date/select controls', () => {
  const e = edit();
  assert.deepEqual(e.initial, { kind: 'pause', startDate: '2026-10-09', endDate: '', reason: '', followUpDate: '', outcome: '', note: '', status: 'pending' });
  assert.deepEqual(e.fields.map(f => [f.name, f.type]), [['kind', 'select'], ['startDate', 'date'], ['endDate', 'date'], ['reason', 'textarea'], ['followUpDate', 'date'], ['outcome', 'text'], ['note', 'textarea'], ['status', 'select']]);
  assert.deepEqual(e.fields.filter(f => f.required).map(f => f.name), ['kind', 'startDate', 'reason', 'status']);
  fieldError(() => e.buildPayload(e.initial), 'reason');
  const p = e.buildPayload({ reason: '  人工原因\n第二行  ', outcome: '  合成結果  ' });
  assert.deepEqual(p, { kind: 'pause', startDate: '2026-10-09', endDate: '', reason: '人工原因\n第二行', followUpDate: '', outcome: '合成結果', note: '', status: 'pending', caseId: 'case-synthetic' });
  const saved = { ...p, id: 'created', orgId: 'org-synthetic', version: 1 }; assert.equal(e.confirm(saved, saved.orgId, p), saved);
});

test('fixed parent validation rejects missing, different or coerced parents without exposing parent control', () => {
  for (const caseId of ['', ' ', null, false, ['case-synthetic'], {}, ' case-synthetic ', 'case\nsynthetic', 'x'.repeat(501)])
    fieldError(() => createCaseStatusFollowupEditor({ caseId }), 'reason');
  for (const saved of [[], false, 'saved', row({ caseId: 'another-case' }), row({ caseId: null })]) fieldError(() => edit(saved), 'reason');
  const missing = row(); delete missing.caseId; fieldError(() => edit(missing), 'reason');
  const e = edit(row()); assert.equal(e.fields.some(f => f.name === 'caseId'), false);
  fieldError(() => e.buildPayload({ caseId: 'another-case' }), 'caseId'); fieldError(() => e.buildPayload({ caseId: 'case-synthetic' }), 'caseId');
});

test('only changed fields are supplied and unmodified whitespace stays exact', () => {
  const saved = freeze(row({ unknown: { secret: 'PRIVATE' }, billingSnapshot: 'PRIVATE' })), e = edit(saved);
  assert.deepEqual(e.buildPayload(e.initial), {}); assert.deepEqual(e.buildPayload({}), {});
  assert.deepEqual(e.buildPayload({ reason: saved.reason, outcome: '  改結果\t ' }), { outcome: '改結果' });
  const payload = e.buildPayload({ reason: '  改原因\n\n尾段\n' }); assert.deepEqual(payload, { reason: '改原因\n\n尾段' });
  e.confirm(next(saved, payload), saved.orgId, payload);
  assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
  assert.deepEqual(e.buildPayload({ note: saved.note }), {});
});

test('missing, null, typed, unknown enums and CR text are kept privately until an explicit intent', () => {
  const samples = [Object.fromEntries(names.filter(n => n !== 'caseId').map(n => [n, null])),
    { kind: 'private-kind', startDate: '0000-01-01', endDate: ['PRIVATE'], reason: { nested: 'PRIVATE' }, followUpDate: true, outcome: 'PRIVATE\nline', note: 'PRIVATE\r\nline', status: 'private-status' }];
  const absent = row(); for (const name of names.filter(n => n !== 'caseId')) delete absent[name];
  for (const saved of [absent, ...samples.map(values => row(values))]) {
    const e = edit(freeze(saved)); assert.deepEqual(e.buildPayload(e.initial), {});
    for (const name of names.filter(n => n !== 'caseId')) {
      assert.equal(e.needsIntent(name), true); assert.equal(e.initial[name], ''); assert.equal(e.enabled(name, e.initial), false);
      assert.equal(e.enabled(name, { [name + 'Intent']: 'replace' }), true);
      assert.equal(e.fields.find(f => f.name === name).required, false);
    }
    assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
    e.confirm(next(saved), saved.orgId, {});
    assert.deepEqual(e.buildPayload({ reason: false, kind: 'injected', note: NaN }), {}, 'disabled keep ignores submitted control values');
  }
});

test('clear is explicit and only available for the four optional fields', () => {
  const e = edit(row({ endDate: [], followUpDate: null, outcome: { private: true }, note: false, reason: null }));
  for (const name of ['endDate', 'followUpDate', 'outcome', 'note']) {
    assert.deepEqual(e.buildPayload({ [name + 'Intent']: 'clear', [name]: { ignored: true } }), { [name]: '' });
    assert.equal(e.enabled(name, { [name + 'Intent']: 'clear' }), false);
  }
  fieldError(() => e.buildPayload({ reasonIntent: 'clear' }), 'reasonIntent');
  for (const name of ['kind', 'startDate', 'status']) {
    const unsafe = edit(row({ [name]: null })); fieldError(() => unsafe.buildPayload({ [name + 'Intent']: 'clear' }), name + 'Intent');
  }
  assert.deepEqual(edit(row({ outcome: '結果' })).buildPayload({ outcome: '   ' }), { outcome: '' });
});

test('date replacements validate the complete calendar and interval without inventing a follow-up deadline', () => {
  const e = edit(row());
  for (const startDate of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) assert.deepEqual(e.buildPayload({ startDate }), { startDate });
  for (const startDate of ['', '0000-01-01', '1900-02-29', '2026-02-29', '2026-02-30', '2026-13-01', '10000-01-01', false, null, ['2026-10-09']]) fieldError(() => e.buildPayload({ startDate }), 'startDate');
  fieldError(() => e.buildPayload({ endDate: '2026-10-08' }), 'endDate');
  assert.deepEqual(e.buildPayload({ endDate: '2026-10-09', followUpDate: '2025-01-01' }), { endDate: '2026-10-09', followUpDate: '2025-01-01' });
  assert.deepEqual(e.buildPayload({ startDate: ' 2026-10-10 ', endDate: '2026-10-11' }), { startDate: '2026-10-10', endDate: '2026-10-11' });
  fieldError(() => edit(row({ endDate: '2026-10-10' })).buildPayload({ startDate: '2026-10-11' }), 'endDate');
  for (const defaultDate of ['', '0000-01-01', '2026-02-30', null, {}]) assert.equal(createCaseStatusFollowupEditor({ caseId: 'case-synthetic', defaultDate }).initial.startDate, '');
});

test('UTF16 limits, trim and required nonblank reason apply to supplied values', () => {
  for (const [name, size] of [['reason', 10000], ['note', 10000], ['outcome', 500]]) {
    const e = edit(row()), boundary = '🙂'.repeat(size / 2);
    assert.deepEqual(e.buildPayload({ [name]: boundary }), { [name]: boundary });
    fieldError(() => e.buildPayload({ [name]: boundary + 'x' }), name);
    const imported = edit(row({ [name]: boundary + 'x' })); assert.equal(imported.needsIntent(name), true); assert.deepEqual(imported.buildPayload(imported.initial), {});
  }
  for (const reason of ['', ' \t\n　 ', false, null, [], {}]) fieldError(() => edit(row()).buildPayload({ reason }), 'reason');
  for (const outcome of ['a\nb', 'a\rb']) fieldError(() => edit(row()).buildPayload({ outcome }), 'outcome');
  for (const note of ['a\rb', 'a\r\nb']) fieldError(() => edit(row()).buildPayload({ note }), 'note');
  assert.deepEqual(edit(row()).buildPayload({ note: '\n首\n\n末\n' }), { note: '首\n\n末' });
});

test('manual status and kind are limited independently of mutable public descriptors', () => {
  const e = edit(row()); assert.deepEqual(e.buildPayload({ kind: 'closure', status: 'completed' }), { kind: 'closure', status: 'completed' });
  assert.deepEqual(e.fields.find(f => f.name === 'status').options.map(o => o.value), ['pending', 'completed']);
  e.fields.find(f => f.name === 'kind').options.push({ value: 'invented', label: 'x' }); e.initial.kind = 'invented';
  e.fields.find(f => f.name === 'status').options.push({ value: 'cancelled', label: 'x' }); e.initial.status = 'cancelled';
  fieldError(() => e.buildPayload({ kind: 'invented' }), 'kind'); fieldError(() => e.buildPayload({ status: 'cancelled' }), 'status');
  assert.deepEqual(e.buildPayload({}), {});
  const cancelled = edit(row({ status: 'cancelled' })); assert.deepEqual(cancelled.buildPayload(cancelled.initial), {});
  assert.equal(cancelled.fields.find(f => f.name === 'status').disabled, true); assert.equal(cancelled.enabled('status'), false);
  fieldError(() => cancelled.buildPayload({ status: 'pending' }), 'status'); fieldError(() => cancelled.buildPayload({ status: 'completed' }), 'status');
  assert.ok(Object.isFrozen(FOLLOWUP_KINDS) && Object.isFrozen(FOLLOWUP_KINDS[0]) && Object.isFrozen(FOLLOWUP_STATUSES));
});

test('cancel and reopen action payloads only alter the known manual status', () => {
  for (const status of ['pending', 'completed']) {
    const saved = row({ status, note: { private: ['synthetic'] } }), e = edit(saved), p = e.buildStatusChange('cancelled');
    assert.deepEqual(p, { status: 'cancelled' }); e.confirm(next(saved, p), saved.orgId, p);
    fieldError(() => e.buildStatusChange('pending'), 'status'); fieldError(() => e.buildStatusChange('completed'), 'status');
  }
  const e = edit(row({ status: 'cancelled' })); assert.deepEqual(e.buildStatusChange('pending'), { status: 'pending' });
  fieldError(() => e.buildStatusChange('cancelled'), 'status'); fieldError(() => edit(row({ status: 'unknown' })).buildStatusChange('cancelled'), 'status');
  fieldError(() => edit().buildStatusChange('cancelled'), 'status');
});

test('unknown fields, illegal intents and hostile own keys cannot extend the contract', () => {
  const e = edit(row({ reason: null }));
  for (const value of [null, [], false, 'text', new Date()]) fieldError(() => e.buildPayload(value), 'reason');
  for (const key of ['id', 'orgId', 'version', 'caseId', 'billingSnapshot', 'kindIntent', 'delete', 'constructor']) fieldError(() => e.buildPayload({ [key]: 'injected' }), key);
  fieldError(() => e.buildPayload(JSON.parse('{"__proto__":{"polluted":true}}')), '__proto__');
  for (const reasonIntent of ['', 'delete', null, false, {}]) fieldError(() => e.buildPayload({ reasonIntent }), 'reasonIntent');
  e.fields.find(f => f.name === 'reasonIntent').options.push({ value: 'delete', label: 'x' }); e.initial.reasonIntent = 'delete';
  assert.deepEqual(e.buildPayload({}), {}); assert.equal(e.enabled('unknown'), false); assert.equal({}.polluted, undefined);
});

test('saved JSON and identity resist mutation without publishing hidden values in descriptors', () => {
  const special = JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false],"prototype":null}');
  const saved = freeze(row({ reason: special, note: { nested: special } })), e = edit(saved);
  assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
  e.confirm(next(saved, { outcome: '改結果' }), saved.orgId, { outcome: '改結果' }); assert.equal({}.secret, undefined);
  const mutable = row({ note: structuredClone(special) }), baseline = structuredClone(mutable), captured = edit(mutable);
  mutable.note.constructor[0] = 9; mutable.caseId = 'changed'; mutable.id = 'changed'; mutable.orgId = 'changed'; mutable.version = 99;
  captured.confirm(next(baseline), baseline.orgId, {}); unconfirmed(() => captured.confirm(next(mutable), baseline.orgId, {}));
  for (const note of [undefined, NaN, Infinity, () => {}]) fieldError(() => edit(row({ note })), 'reason');
  const cycle = {}; cycle.self = cycle; fieldError(() => edit(row({ note: cycle })), 'reason');
});

test('new confirmation requires own identity version one and every exact business field', () => {
  const e = edit(), p = e.buildPayload({ reason: '合成原因' }), good = { ...p, id: 'new-synthetic', orgId: 'org-synthetic', version: 1 };
  assert.equal(e.confirm(good, good.orgId, p), good);
  for (const bad of [null, [], {}, Object.create(good), { ...good, id: '' }, { ...good, orgId: 'another-org' }, { ...good, version: '1' }, { ...good, version: 2 }]) unconfirmed(() => e.confirm(bad, good.orgId, p));
  for (const key of ['id', 'orgId', 'version', ...names]) {
    const absent = { ...good }; delete absent[key]; unconfirmed(() => e.confirm(absent, good.orgId, p));
    if (names.includes(key)) unconfirmed(() => e.confirm({ ...good, [key]: { changed: true } }, good.orgId, p));
  }
  unconfirmed(() => e.confirm(good, '', p)); unconfirmed(() => e.confirm(good, good.orgId, { ...p, extra: 1 }));
  const missing = { ...p }; delete missing.note; unconfirmed(() => e.confirm(good, good.orgId, missing));
});

test('edit confirmation checks next version, fixed parent, own presence and all untouched raw values', () => {
  const saved = row({ reason: ['raw-synthetic'], note: null }), e = edit(saved), p = { outcome: '改結果' }, good = next(saved, p);
  e.confirm(good, saved.orgId, p); e.confirm(good, saved.orgId, { ...p, version: saved.version });
  for (const key of names) unconfirmed(() => e.confirm({ ...good, [key]: { changed: true } }, saved.orgId, p));
  for (const bad of [{ ...good, id: 'other' }, { ...good, orgId: 'other' }, { ...good, version: saved.version }, { ...good, version: saved.version + 2 }]) unconfirmed(() => e.confirm(bad, saved.orgId, p));
  unconfirmed(() => e.confirm({ ...good, caseId: 'other' }, saved.orgId, { ...p, caseId: 'other' }));
  unconfirmed(() => e.confirm(good, saved.orgId, { ...p, version: saved.version + 1 }));
  fieldError(() => edit(row({ version: undefined })), 'reason');
  for (const version of [null, 0, -1, '4', Number.MAX_SAFE_INTEGER]) {
    const invalid = row({ version }); unconfirmed(() => edit(invalid).confirm(next(invalid, p), saved.orgId, p));
  }
  const absent = row(); delete absent.note; const preserving = edit(absent); preserving.confirm(next(absent, p), absent.orgId, p);
  unconfirmed(() => preserving.confirm({ ...next(absent, p), note: '' }, absent.orgId, p));
});

test('safe list formatters expose saved text and dates without coercing nested or prototype enum values', () => {
  assert.equal(formatFollowupText(' 原因\n第二行 '), ' 原因\n第二行 ');
  for (const value of [null, false, 42, [], { private: 'PRIVATE' }]) assert.equal(formatFollowupText(value), '內容未取得');
  assert.equal(formatFollowupText(undefined), '未提供'); assert.equal(formatFollowupText(''), '未提供');
  assert.equal(formatFollowupDate('2024-02-29'), '2024/02/29');
  for (const date of ['2026-02-30', '0000-01-01', {}, []]) assert.equal(formatFollowupDate(date), '日期未取得');
  assert.equal(formatFollowupKind('pause'), '暫停'); assert.equal(formatFollowupKind('closure'), '結案');
  for (const value of ['constructor', '__proto__', 'toString', {}]) { assert.ok(!formatFollowupKind(value).includes('function')); assert.equal(formatFollowupStatus(value), '狀態未取得'); }
  assert.equal(formatFollowupStatus('completed'), '已完成追蹤');
});

test('history lists exactly nine business fields and compares explicit previous values only', () => {
  assert.deepEqual(getHistoryFields('case-status-followups').map(f => f.key), names);
  const before = row(), after = { ...before, outcome: '新結果', status: 'completed', billingSnapshot: 'PRIVATE', version: 5 };
  assert.deepEqual(diffHistorySnapshots('case-status-followups', before, after).map(f => f.key), ['outcome', 'status']);
  const projection = normalizeHistorySnapshot('case-status-followups', { ...before, reason: { private: 'PRIVATE' } });
  assert.deepEqual(Object.keys(projection), names); assert.equal(projection.reason, '[欄位格式無法判讀]'); assert.ok(!JSON.stringify(projection).includes('PRIVATE'));
});
