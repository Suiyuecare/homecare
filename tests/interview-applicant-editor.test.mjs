import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterviewApplicantEditor, INTERVIEW_STATUSES, confirmInterviewApplicantList,
  isInterviewDate, formatInterviewText, formatInterviewDate, formatInterviewStatus } from '../public/data/interview-applicant-editor.js';
import { getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

const names = ['name', 'phone', 'interviewDate', 'city', 'district', 'interviewContent', 'note', 'status'];
const row = (extra = {}) => ({ id: 'applicant-synthetic', orgId: 'org-synthetic', version: 3,
  name: '合成面試者', phone: '合成電話', interviewDate: '2026-10-10', city: '合成縣市', district: '合成鄉鎮區',
  interviewContent: '合成面試內容', note: '合成備註', status: 'active', ...extra });
const edit = existing => createInterviewApplicantEditor({ existing });
const next = (existing, payload) => ({ ...existing, ...payload, version: existing.version + 1 });
function fieldError(action, name) { assert.throws(action, error => Object.hasOwn(error.fields || {}, name)); }
function unconfirmed(action) { assert.throws(action, error => error.code === 'SAVE_UNCONFIRMED' && error.message === '儲存結果未確認；請保留輸入並重新讀取確認。'); }

test('create submits exactly eight independent fields with supplied trim and explicit local date', () => {
  const e = createInterviewApplicantEditor({ defaultDate: '2026-10-10' });
  const p = e.buildPayload({ name: ' 合成姓名 ', phone: ' 合成電話 ', interviewContent: '\n合成內容\n' });
  assert.deepEqual(p, { name: '合成姓名', phone: '合成電話', interviewDate: '2026-10-10', city: '', district: '', interviewContent: '合成內容', note: '', status: 'active' });
  assert.deepEqual(Object.keys(p), names);
  assert.equal(e.fields.length, 8); assert.equal(e.fields.find(f => f.name === 'interviewDate').type, 'date');
  e.confirm({ ...p, id: 'new-synthetic', orgId: 'org-synthetic', version: 1 }, 'org-synthetic', p);
  assert(!Object.keys(p).some(k => ['employeeId', 'userId', 'salary', 'offer'].includes(k)));
});

test('PATCH sends only changes and preserves whitespace, CRLF, typed values and absent originals', () => {
  const saved = row({ name: ' 合成姓名 ', interviewContent: '前\r\n後 ', city: { private: ['合成'] }, note: null }); delete saved.district;
  const e = edit(saved);
  assert.deepEqual(e.buildPayload(e.initial), {});
  const p = e.buildPayload({ phone: ' 新合成電話 ' }); assert.deepEqual(p, { phone: '新合成電話' });
  e.confirm(next(saved, p), saved.orgId, p);
  assert.equal(e.initial.name, saved.name); assert.equal(e.initial.interviewContent, '');
  assert(!JSON.stringify(e.initial).includes('private'));
});

test('unsupported native values default to keep, never coerce or display unknown raw JSON', () => {
  for (const name of names) for (const value of [null, false, 7, [], { hiddenSynthetic: 'never-display' }]) {
    const e = edit(row({ [name]: value }));
    assert(e.needsIntent(name)); assert.equal(e.initial[name + 'Intent'], 'keep'); assert.equal(e.initial[name], '');
    assert.equal(e.enabled(name, e.initial), false);
    assert.deepEqual(e.buildPayload({ [name]: { ignored: true } }), {});
    assert(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('never-display'));
  }
  const missing = row(); delete missing.phone;
  assert(edit(missing).needsIntent('phone'));
});

test('clear is explicit and available only for optional city, district and note', () => {
  const e = edit(row({ city: [], district: null, note: false, name: null, phone: null, interviewContent: null, interviewDate: null, status: null }));
  for (const name of ['city', 'district', 'note']) {
    assert.deepEqual(e.buildPayload({ [name + 'Intent']: 'clear', [name]: { ignored: true } }), { [name]: '' });
    assert.equal(e.enabled(name, { [name + 'Intent']: 'clear' }), false);
  }
  for (const name of ['name', 'phone', 'interviewContent', 'interviewDate', 'status']) fieldError(() => e.buildPayload({ [name + 'Intent']: 'clear' }), name + 'Intent');
  fieldError(() => e.buildPayload({ noteIntent: 'typo' }), 'noteIntent');
});

test('unsafe replacement requires explicit intent and retains invalid replacement choices', () => {
  const e = edit(row({ phone: ['synthetic'], note: { hidden: true } }));
  assert.deepEqual(e.buildPayload({ phone: 'ignored-new' }), {});
  assert.deepEqual(e.buildPayload({ phoneIntent: 'replace', phone: ' 合成替代電話 ' }), { phone: '合成替代電話' });
  assert.equal(e.enabled('phone', { phoneIntent: 'replace' }), true);
  fieldError(() => e.buildPayload({ phoneIntent: 'replace', phone: '  ' }), 'phone');
  fieldError(() => e.buildPayload({ noteIntent: 'replace', note: false }), 'note');
  assert.deepEqual(e.buildPayload(e.initial), {}, 'a failed replacement does not mutate the private baseline');
});

test('known edit status is permanently disabled and changes only through confirmed action payload', () => {
  for (const status of ['active', 'inactive']) {
    const saved = row({ status, note: { imported: true } }), e = edit(saved), target = status === 'active' ? 'inactive' : 'active';
    assert.equal(e.fields.find(f => f.name === 'status').disabled, true); assert.equal(e.enabled('status'), false);
    assert.deepEqual(e.buildPayload({ status }), {}); fieldError(() => e.buildPayload({ status: target }), 'status');
    const p = e.buildStatusChange(target); assert.deepEqual(p, { status: target }); e.confirm(next(saved, p), saved.orgId, p);
    fieldError(() => e.buildStatusChange(status), 'status'); fieldError(() => e.buildStatusChange('approved'), 'status');
  }
  fieldError(() => createInterviewApplicantEditor().buildStatusChange('inactive'), 'status');
});

test('unknown saved status can be kept or explicitly repaired without an automatic active assumption', () => {
  for (const status of ['toString', 'legacy', '', { status: 'active' }]) {
    const e = edit(row({ status })); assert(e.needsIntent('status')); assert.deepEqual(e.buildPayload(e.initial), {});
    assert.equal(e.enabled('status', { statusIntent: 'replace' }), true);
    assert.deepEqual(e.buildPayload({ statusIntent: 'replace', status: 'inactive' }), { status: 'inactive' });
    fieldError(() => e.buildPayload({ statusIntent: 'replace', status: 'approved' }), 'status');
    fieldError(() => e.buildStatusChange('active'), 'status');
  }
  assert(Object.isFrozen(INTERVIEW_STATUSES) && Object.isFrozen(INTERVIEW_STATUSES[0]));
});

test('manual native dates reject invalid calendars and preserve year zero until explicit replace', () => {
  for (const value of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) {
    assert(isInterviewDate(value)); assert.deepEqual(edit(row()).buildPayload({ interviewDate: value }), { interviewDate: value });
  }
  for (const value of ['', '0000-01-01', '1900-02-29', '2026-02-29', '2026-02-30', '2026-13-01', '10000-01-01', null, []]) {
    assert.equal(isInterviewDate(value), false); fieldError(() => edit(row()).buildPayload({ interviewDate: value }), 'interviewDate');
    assert.equal(createInterviewApplicantEditor({ defaultDate: value }).initial.interviewDate, '');
  }
  const saved = row({ interviewDate: '0000-01-01' }), e = edit(saved), p = e.buildPayload({ note: '合成新備註' });
  assert(e.needsIntent('interviewDate')); assert.deepEqual(p, { note: '合成新備註' }); e.confirm(next(saved, p), saved.orgId, p);
  assert.deepEqual(e.buildPayload({ interviewDateIntent: 'replace', interviewDate: ' 2026-10-11 ' }), { interviewDate: '2026-10-11' });
});

test('required nonblank and UTF16 lengths match local server contracts without phone or region guesses', () => {
  for (const name of ['name', 'phone', 'interviewContent']) for (const value of ['', ' \t\n　 ', false, null, [], {}]) fieldError(() => edit(row()).buildPayload({ [name]: value }), name);
  for (const [name, size] of [['name', 200], ['phone', 64], ['city', 100], ['district', 100], ['interviewContent', 10000], ['note', 10000]]) {
    const boundary = '🙂'.repeat(size / 2), e = edit(row());
    assert.deepEqual(e.buildPayload({ [name]: boundary }), { [name]: boundary }); fieldError(() => e.buildPayload({ [name]: boundary + 'x' }), name);
    const imported = edit(row({ [name]: boundary + 'x' })); assert(imported.needsIntent(name)); assert.deepEqual(imported.buildPayload(imported.initial), {});
  }
  assert.deepEqual(edit(row()).buildPayload({ phone: '文字及分機 / 尚待聯絡', city: '自訂縣市', district: '自訂鄉鎮區' }), { phone: '文字及分機 / 尚待聯絡', city: '自訂縣市', district: '自訂鄉鎮區' });
});

test('native single-line and textarea CR preservation are distinct from LF replacements', () => {
  for (const name of ['name', 'phone', 'city', 'district']) for (const value of ['前\n後', '前\r後', '前\r\n後']) {
    fieldError(() => edit(row()).buildPayload({ [name]: value }), name);
    const e = edit(row({ [name]: value })); assert(e.needsIntent(name)); assert.deepEqual(e.buildPayload(e.initial), {});
  }
  for (const name of ['interviewContent', 'note']) {
    assert.deepEqual(edit(row()).buildPayload({ [name]: '\n前\n\n後\n' }), { [name]: '前\n\n後' });
    for (const value of ['前\r後', '前\r\n後']) { const e = edit(row({ [name]: value })); assert(e.needsIntent(name)); assert.deepEqual(e.buildPayload(e.initial), {}); fieldError(() => e.buildPayload({ [name + 'Intent']: 'replace', [name]: value }), name); }
  }
});

test('public initial and descriptors cannot alter saved raw data, intent rules or status options', () => {
  const saved = row({ city: { nested: ['合成原值'] } }), e = edit(saved);
  saved.city.nested[0] = '外部變動'; saved.orgId = 'other'; saved.version = 99;
  e.initial.cityIntent = 'replace'; e.fields.find(f => f.name === 'status').options.push({ value: 'invented' });
  assert.deepEqual(e.buildPayload({}), {});
  e.confirm({ ...row(), city: { nested: ['合成原值'] }, version: 4 }, 'org-synthetic', {});
  fieldError(() => e.buildPayload({ employeeId: 'invented' }), 'employeeId');
  fieldError(() => e.buildPayload({ version: 1 }), 'version');
  fieldError(() => createInterviewApplicantEditor({ defaultDate: '2026-10-10' }).buildPayload({ name: '合成', phone: '合成', interviewContent: '合成', status: 'invented' }), 'status');
});

test('create acknowledgement requires eight own fields and exact submitted contents', () => {
  const e = createInterviewApplicantEditor({ defaultDate: '2026-10-10' }), p = e.buildPayload({ name: '合成', phone: '合成', interviewContent: '合成' });
  const item = { ...p, id: 'new-synthetic', orgId: 'org-synthetic', version: 1 };
  for (const name of names) {
    const missing = { ...item }; delete missing[name]; unconfirmed(() => e.confirm(missing, 'org-synthetic', p));
    unconfirmed(() => e.confirm({ ...item, [name]: 'wrong-synthetic-value' }, 'org-synthetic', p));
  }
  unconfirmed(() => e.confirm(Object.assign(Object.create({ note: '' }), { ...item, note: undefined }), 'org-synthetic', p));
  unconfirmed(() => e.confirm(item, 'org-synthetic', { ...p, employeeId: 'injected' }));
  const partial = { ...p }; delete partial.city; unconfirmed(() => e.confirm(item, 'org-synthetic', partial));
});

test('edit acknowledgement compares original raw JSON and own absence without cleaned projection', () => {
  const saved = row({ city: ['a', { b: false }], note: ' 前\r\n後 ', interviewDate: '0000-01-01' }); delete saved.district;
  const e = edit(saved), p = e.buildPayload({ phone: '合成新電話' }), item = next(saved, p);
  assert.equal(e.confirm(item, saved.orgId, p), item);
  unconfirmed(() => e.confirm({ ...item, district: '' }, saved.orgId, p));
  unconfirmed(() => e.confirm({ ...item, city: 'a' }, saved.orgId, p));
  unconfirmed(() => e.confirm({ ...item, note: '前\n後' }, saved.orgId, p));
  e.confirm({ ...item, district: '' }, saved.orgId, { ...p, district: '' });
  e.confirm(item, saved.orgId, { ...p, version: saved.version });
  unconfirmed(() => e.confirm(item, saved.orgId, { ...p, version: saved.version + 1 }));
});

test('identity and version confirmation fails closed for unknown 2xx envelopes and invalid saved identities', () => {
  const saved = row(), e = edit(saved), p = { note: '合成新備註' }, item = next(saved, p);
  for (const bad of [null, [], {}, { ...item, id: '' }, { ...item, id: 'other' }, { ...item, orgId: 'other' }, { ...item, version: 3 }, { ...item, version: 5 }, { ...item, version: 4.5 }]) unconfirmed(() => e.confirm(bad, saved.orgId, p));
  unconfirmed(() => e.confirm(item, '', p)); unconfirmed(() => e.confirm(item, 'other', p));
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, null, '3']) {
    const unsafe = edit(row({ version })); unconfirmed(() => unsafe.confirm(item, saved.orgId, p));
  }
});

test('non-JSON inputs, cycles and private raw unknown-key contents never become editor output', () => {
  const circular = {}; circular.self = circular;
  for (const value of [undefined, NaN, Infinity, new Date(), circular, () => {}]) fieldError(() => edit(row({ note: value })), 'name');
  for (const existing of [[], false, 3, 'saved']) fieldError(() => edit(existing), 'name');
  const raw = JSON.parse('{"__proto__":{"private":"hidden"},"constructor":"hidden"}');
  const e = edit(row({ city: raw })); assert(!JSON.stringify(e.initial).includes('hidden')); assert.deepEqual(e.buildPayload(e.initial), {});
  e.confirm(next(row({ city: raw }), { phone: '合成新電話' }), 'org-synthetic', { phone: '合成新電話' });
  for (const values of [null, [], 'data', new Date()]) fieldError(() => edit(row()).buildPayload(values), 'name');
});

test('strict opt-in list confirmation validates captured requested page, org, count and unique identities', () => {
  const opts = { page: 1, pageSize: 25, orgId: 'org-synthetic' };
  const result = { items: [row({ note: { imported: true }, status: ['legacy'] })], total: 1, page: 1, pageSize: 25 };
  assert.equal(confirmInterviewApplicantList(result, opts), result, 'unfiltered legacy business values are allowed');
  const malformed = [null, [], { ...result, total: -1 }, { ...result, total: 1.5 }, { ...result, total: 2 }, { ...result, page: 2 }, { ...result, pageSize: 100 }, { ...result, orgId: 'org-synthetic' }, { ...result, items: [row({ orgId: 'other' })] }, { ...result, items: [row({ version: 0 })] }, { ...result, items: [row({ id: ' ' })] }, { ...result, items: [row(), row()], total: 2 }];
  for (const bad of malformed) assert.throws(() => confirmInterviewApplicantList(bad, opts), /清單回應無法確認/);
  assert.throws(() => confirmInterviewApplicantList(result, { ...opts, page: 2 }), /清單回應無法確認/);
  assert.throws(() => confirmInterviewApplicantList(result, { ...opts, orgId: 'other' }), /清單回應無法確認/);
  const second = { items: [row({ id: 'second-1' }), row({ id: 'second-2' })], total: 27, page: 2, pageSize: 25 };
  assert.equal(confirmInterviewApplicantList(second, { ...opts, page: 2 }), second);
  assert.equal(confirmInterviewApplicantList({ items: [], total: 27, page: 3, pageSize: 25 }, { ...opts, page: 3 }).items.length, 0);
  const filtered = { items: [row()], total: 1, page: 1, pageSize: 25 };
  confirmInterviewApplicantList(filtered, { ...opts, status: 'active', interviewDate: '2026-10-10' });
  for (const filters of [{ status: 'inactive' }, { interviewDate: '2026-10-11' }, { status: 'toString' }, { interviewDate: '0000-01-01' }]) assert.throws(() => confirmInterviewApplicantList(filtered, { ...opts, ...filters }), /清單回應無法確認/);
});

test('safe list/history projections expose exactly eight fields and never nested unknown values', () => {
  assert.equal(formatInterviewText({ private: true }), '內容未取得'); assert.equal(formatInterviewDate('0000-01-01'), '日期未取得');
  assert.equal(formatInterviewDate('2026-10-10'), '2026/10/10'); assert.equal(formatInterviewStatus('toString'), '狀態未取得');
  assert.deepEqual(getHistoryFields('interview-applicants').map(f => f.key), names);
  const projection = normalizeHistorySnapshot('interview-applicants', row({ city: { secret: 'hidden' }, note: 7, unknownSecret: 'hidden' }));
  assert.deepEqual(projection.city, { invalid: true }); assert.deepEqual(projection.note, { invalid: true });
  assert(!JSON.stringify(projection).includes('hidden'));
  const changes = diffHistorySnapshots('interview-applicants', row(), row({ note: '合成另一備註', unknown: 'not-shown' }));
  assert.deepEqual(changes.map(f => f.key), ['note']);
  assert.deepEqual(diffHistorySnapshots('interview-applicants', row({ city: { hidden: 'first' } }), row({ city: { hidden: 'second' } })), [], 'hidden nontext differences are outside the projected comparison, not evidence that raw records match');
});
