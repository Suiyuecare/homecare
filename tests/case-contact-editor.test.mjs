import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseContactEditor, confirmCaseContactList, formatContactText, formatContactCategory, formatContactStatus } from '../public/data/case-contact-editor.js';

const caseId = 'synthetic-case-A', orgId = 'synthetic-org-A';
const saved = (changes = {}) => ({ id: 'synthetic-contact-A', orgId, version: 4, caseId,
  name: '合成聯絡人', category: 'general', relationship: '親友', phone: '+886 TEST #123', alternatePhone: '',
  email: 'person@example.test', organization: '合成單位', status: 'active', note: '第一行\n第二行', ...changes });
const editorOf = record => createCaseContactEditor({ existing: record, caseId });
const acknowledgement = (record, payload) => ({ ...record, ...payload, version: record.version + 1 });
const unconfirmed = action => assert.throws(action, error => error.code === 'SAVE_UNCONFIRMED' && error.message === '儲存結果未確認；請保留輸入並重新讀取確認。');
const listRequest = { page: 1, pageSize: 25, orgId, caseId };
const listOf = (items, total = items.length, page = 1) => ({ items, total, page, pageSize: 25 });

test('create canonical payload contains all ten business fields, fixed case and active status', () => {
  const editor = createCaseContactEditor({ caseId });
  const payload = editor.buildPayload({ ...editor.initial, name: '  合成家屬  ', phone: ' +886 TEST #123 ', note: ' 首行\n次行 ' });
  assert.deepEqual(Object.keys(payload).sort(), ['caseId', 'name', 'category', 'relationship', 'phone', 'alternatePhone', 'email', 'organization', 'status', 'note'].sort());
  assert.equal(payload.name, '合成家屬'); assert.equal(payload.phone, '+886 TEST #123'); assert.equal(payload.note, '首行\n次行');
  assert.equal(payload.caseId, caseId); assert.equal(payload.category, 'general'); assert.equal(payload.status, 'active');
  assert.deepEqual(editor.confirm({ ...payload, id: 'new-contact', orgId, version: 1, ignoredMetadata: { any: true } }, orgId, payload), { ...payload, id: 'new-contact', orgId, version: 1 });
});

test('unchanged edit has no payload; single changed field omits saved whitespace and all other values', () => {
  const record = saved({ name: '  原姓名  ', phone: ' 電話原文 ', note: ' 備註原文\n ' }), editor = editorOf(record);
  assert.deepEqual(editor.buildPayload(editor.initial), {});
  const payload = editor.buildPayload({ ...editor.initial, relationship: ' 新關係 ' });
  assert.deepEqual(payload, { relationship: '新關係' });
  const item = acknowledgement(record, payload); editor.confirm(item, orgId, payload);
  unconfirmed(() => editor.confirm({ ...item, name: record.name.trim() }, orgId, payload));
});

test('single-line CRLF and CR note use opaque keep; unrelated edit never normalizes them', () => {
  const record = saved({ name: '原\r\n姓名', phone: '電話\n分機', note: '第一行\r\n第二行' }), editor = editorOf(record);
  for (const name of ['name', 'phone', 'note']) { assert(editor.needsIntent(name)); assert.equal(editor.initial[name], ''); assert.equal(editor.initial[name + 'Intent'], 'keep'); assert(!editor.enabled(name, editor.initial)); }
  const payload = editor.buildPayload({ ...editor.initial, relationship: '人工變更' });
  assert.deepEqual(payload, { relationship: '人工變更' }); editor.confirm(acknowledgement(record, payload), orgId, payload);
  unconfirmed(() => editor.confirm({ ...acknowledgement(record, payload), note: record.note.replaceAll('\r\n', '\n') }, orgId, payload));
});

test('LF note can be edited losslessly and untouched LF endpoints remain untrimmed', () => {
  const record = saved({ note: ' \n保存LF\n ' }), editor = editorOf(record);
  assert(!editor.needsIntent('note')); assert.equal(editor.initial.note, record.note); assert.deepEqual(editor.buildPayload(editor.initial), {});
  assert.deepEqual(editor.buildPayload({ ...editor.initial, note: ' 新首行\n新末行 ' }), { note: '新首行\n新末行' });
});

test('missing optional fields retain absence rather than being silently backfilled', () => {
  const record = saved(); delete record.alternatePhone; delete record.organization;
  const editor = editorOf(record), payload = editor.buildPayload({ ...editor.initial, note: '本次備註' });
  assert(editor.needsIntent('alternatePhone')); assert(editor.needsIntent('organization')); assert.deepEqual(payload, { note: '本次備註' });
  const item = acknowledgement(record, payload); editor.confirm(item, orgId, payload);
  unconfirmed(() => editor.confirm({ ...item, alternatePhone: '' }, orgId, payload));
});

test('null, numbers, booleans, arrays and objects remain private independent copies', () => {
  const record = saved({ relationship: null, phone: 12, alternatePhone: false, organization: ['HIDDEN_ARRAY'], note: { nested: 'HIDDEN_OBJECT' } });
  const original = structuredClone(record), editor = editorOf(record);
  for (const name of ['relationship', 'phone', 'alternatePhone', 'organization', 'note']) assert(editor.needsIntent(name));
  record.organization.push('MUTATED_AFTER_OPEN'); record.note.nested = 'MUTATED_AFTER_OPEN';
  const payload = editor.buildPayload({ ...editor.initial, name: '修正姓名' }); assert.deepEqual(payload, { name: '修正姓名' });
  editor.confirm(acknowledgement(original, payload), orgId, payload);
  unconfirmed(() => editor.confirm(acknowledgement(record, payload), orgId, payload));
});

test('optional clear and replace are explicit; required fields cannot select clear', () => {
  const record = saved({ relationship: null, phone: 12, alternatePhone: false, email: 'invalid', organization: ['HIDDEN'], note: { nested: 'HIDDEN' }, name: null, category: 'unknown' });
  const editor = editorOf(record), values = { ...editor.initial, nameIntent: 'replace', name: '新姓名', categoryIntent: 'replace', category: 'other' };
  for (const name of ['relationship', 'phone', 'alternatePhone', 'email', 'organization', 'note']) values[name + 'Intent'] = 'clear';
  const payload = editor.buildPayload(values); assert.deepEqual(payload, { name: '新姓名', category: 'other', relationship: '', organization: '', phone: '', alternatePhone: '', email: '', note: '' });
  assert.throws(() => editor.buildPayload({ ...values, nameIntent: 'clear' })); assert.throws(() => editor.buildPayload({ ...values, categoryIntent: 'clear' }));
  assert.throws(() => editor.buildPayload({ ...values, name: ' \n ' })); assert.throws(() => editor.buildPayload({ ...values, category: 'not-a-category' }));
});

test('original field limits, replacement CRLF and email regex remain enforced', () => {
  const editor = createCaseContactEditor({ caseId }), base = { ...editor.initial, name: '合成聯絡人' };
  for (const [name, limit] of Object.entries({ name: 100, relationship: 100, phone: 100, alternatePhone: 100, organization: 200, note: 10000 })) {
    assert.equal(editor.buildPayload({ ...base, [name]: '字'.repeat(limit) })[name].length, limit);
    assert.throws(() => editor.buildPayload({ ...base, [name]: '字'.repeat(limit + 1) }));
  }
  const email = 'a'.repeat(241) + '@example.test'; assert.equal(email.length, 254); assert.equal(editor.buildPayload({ ...base, email }).email, email);
  for (const email of ['invalid', 'a@@example.test', 'a b@example.test', 'a@example', 'a'.repeat(242) + '@example.test']) assert.throws(() => editor.buildPayload({ ...base, email }));
  for (const name of ['name', 'relationship', 'phone', 'alternatePhone', 'organization']) assert.throws(() => editor.buildPayload({ ...base, [name]: 'a\r\nb' }));
  assert.throws(() => editor.buildPayload({ ...base, note: 'a\rb' }));
});

test('over-limit and invalid native-email saved text require intent without exposing the raw form value', () => {
  const record = saved({ name: '字'.repeat(101), email: ' person@example.test ', note: '字'.repeat(10001) }), editor = editorOf(record);
  for (const name of ['name', 'email', 'note']) { assert(editor.needsIntent(name)); assert.equal(editor.initial[name], ''); }
  assert.deepEqual(editor.buildPayload(editor.initial), {});
  assert.deepEqual(editor.buildPayload({ ...editor.initial, nameIntent: 'replace', name: '新姓名', emailIntent: 'replace', email: 'person@example.test', noteIntent: 'clear' }), { name: '新姓名', email: 'person@example.test', note: '' });
});

test('known status cannot enter edit payload; independent status change contains only status', () => {
  const record = saved(), editor = editorOf(record);
  assert(!editor.fields.some(field => field.name === 'status' || field.name === 'statusRepair'));
  assert.deepEqual(editor.buildStatusChange('inactive'), { status: 'inactive' });
  assert.throws(() => editor.buildPayload({ ...editor.initial, status: 'inactive' }));
  assert.throws(() => editor.buildStatusChange('active')); assert.throws(() => editor.buildStatusChange('unknown'));
  editor.confirm(acknowledgement(record, { status: 'inactive' }), orgId, { status: 'inactive' });
});

test('unknown and missing status keep by default; only explicit known repair enters payload', () => {
  for (const status of ['unknown', null, { hidden: 'HIDDEN_STATUS' }, undefined]) {
    const record = saved({ status }); if (status === undefined) delete record.status;
    const editor = editorOf(record); assert.equal(editor.initial.statusRepair, 'keep'); assert.deepEqual(editor.buildPayload(editor.initial), {});
    assert.deepEqual(editor.fields.find(field => field.name === 'statusRepair').options.map(option => option.value), ['keep', 'active', 'inactive']);
    assert.deepEqual(editor.buildPayload({ ...editor.initial, statusRepair: 'active' }), { status: 'active' });
    assert.throws(() => editor.buildStatusChange('inactive')); assert.throws(() => editor.buildPayload({ ...editor.initial, statusRepair: 'replace' }));
  }
});

test('fixed parent and unknown form fields cannot change or supplement an edit', () => {
  assert.throws(() => createCaseContactEditor({ caseId: '  case  ' })); assert.throws(() => createCaseContactEditor({ existing: saved({ caseId: 'other-case' }), caseId }));
  const editor = editorOf(saved());
  for (const field of ['caseId', 'id', 'version', 'billingSnapshot', 'unknownIntent']) assert.throws(() => editor.buildPayload({ ...editor.initial, [field]: 'other' }));
  unconfirmed(() => editor.confirm(acknowledgement(saved(), {}), orgId, { caseId }));
});

test('ack verifies ID, organization, parent and exact safe next-version before success', () => {
  const record = saved(), editor = editorOf(record), payload = { phone: '+886 TEST #456' }, item = acknowledgement(record, payload);
  editor.confirm(item, orgId, payload);
  for (const variant of [{ id: '' }, { id: 'wrong-contact' }, { orgId: 'other-org' }, { caseId: 'other-case' }, { version: 4 }, { version: 6 }, { version: 5.5 }, { phone: 'not-requested' }]) unconfirmed(() => editor.confirm({ ...item, ...variant }, orgId, payload));
  for (const key of ['id', 'orgId', 'caseId', 'version', 'category', 'status', 'phone']) { const missing = { ...item }; delete missing[key]; unconfirmed(() => editor.confirm(missing, orgId, payload)); }
  unconfirmed(() => editorOf(saved({ version: Number.MAX_SAFE_INTEGER })).confirm(saved({ version: Number.MAX_SAFE_INTEGER }), orgId, {}));
});

test('create ack rejects incomplete fields and invalid version; legitimate new-ID substitution is explicitly unknowable', () => {
  const editor = createCaseContactEditor({ caseId }), payload = editor.buildPayload({ ...editor.initial, name: '合成姓名' }), item = { ...payload, id: 'new-id', orgId, version: 1 };
  for (const variant of [{ id: '  ' }, { orgId: 'wrong-org' }, { caseId: 'wrong-case' }, { version: 2 }, { name: 'wrong-name' }]) unconfirmed(() => editor.confirm({ ...item, ...variant }, orgId, payload));
  const missing = { ...item }; delete missing.note; unconfirmed(() => editor.confirm(missing, orgId, payload));
  assert.equal(editor.confirm({ ...item, id: 'another-valid-new-id' }, orgId, payload).id, 'another-valid-new-id');
});

test('ack compares only supplied strings after trim and opaque omitted business values exactly', () => {
  const record = saved({ note: { hidden: ['private', null, false, 7] }, phone: ' 保存电话原文 ' }), editor = editorOf(record), payload = { relationship: ' 新關係 ' };
  editor.confirm(acknowledgement(record, { relationship: '新關係' }), orgId, payload);
  unconfirmed(() => editor.confirm(acknowledgement(record, payload), orgId, payload));
  unconfirmed(() => editor.confirm({ ...acknowledgement(record, { relationship: '新關係' }), note: { hidden: ['changed'] } }, orgId, payload));
});

test('opaque JSON cloning preserves prototype-named keys and rejects non-JSON getters/cycles/sparse arrays', () => {
  const record = saved({ note: JSON.parse('{"__proto__":{"hidden":true},"constructor":"private"}') }), editor = editorOf(record);
  editor.confirm(acknowledgement(record, { name: '新姓名' }), orgId, { name: '新姓名' }); assert.equal({}.hidden, undefined);
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => editorOf(saved({ note: cyclic })));
  let accessed = false; const getter = {}; Object.defineProperty(getter, 'hidden', { enumerable: true, get() { accessed = true; return 'secret'; } });
  assert.throws(() => editorOf(saved({ note: getter }))); assert.equal(accessed, false);
  const sparse = ['first', , 'last']; assert.throws(() => editorOf(saved({ note: sparse })));
  assert.throws(() => editorOf(saved({ note: Infinity })));
});

test('list proof accepts legacy business tags and legitimate out-of-range empty page', () => {
  const record = saved({ name: null, category: { unknown: true }, note: ['hidden'], status: null });
  assert.equal(confirmCaseContactList(listOf([record]), listRequest).items[0], record);
  assert.deepEqual(confirmCaseContactList(listOf([], 26, 3), { ...listRequest, page: 3 }), listOf([], 26, 3));
  assert.equal(confirmCaseContactList(listOf(Array.from({ length: 25 }, (_, i) => saved({ id: 'contact-' + i })), 26), listRequest).items.length, 25);
});

test('list proof rejects partial pages, duplicate or wrong-parent identities and envelope mismatches', () => {
  const record = saved(), valid = listOf([record]);
  for (const variant of [{ items: [] }, { page: 2 }, { pageSize: 100 }, { total: -1 }, { total: 1.5 }, { extra: true }, { items: [{ ...record, id: '' }] }, { items: [{ ...record, orgId: 'other' }] }, { items: [{ ...record, caseId: 'other' }] }, { items: [{ ...record, version: 0 }] }]) assert.throws(() => confirmCaseContactList({ ...valid, ...variant }, listRequest));
  assert.throws(() => confirmCaseContactList(listOf([record, record]), listRequest));
  for (const key of ['id', 'orgId', 'caseId', 'version']) { const item = { ...record }; delete item[key]; assert.throws(() => confirmCaseContactList(listOf([item]), listRequest)); }
  assert.throws(() => confirmCaseContactList(valid, { ...listRequest, category: 'other' })); assert.throws(() => confirmCaseContactList(valid, { ...listRequest, status: 'inactive' }));
});

test('card projections never stringify nested or nontext data and known choices remain unchanged', () => {
  for (const value of [null, ['HIDDEN_ARRAY'], { hidden: 'HIDDEN_OBJECT' }, 7, false]) assert(!/HIDDEN|\[object Object\]|^7$|^false$/.test(formatContactText(value)));
  assert.equal(formatContactText(undefined), '未保存'); assert.equal(formatContactText('保存\r\n原文'), '保存\r\n原文');
  assert.equal(formatContactCategory('primary_caregiver'), '主要照顧者'); assert.equal(formatContactStatus('inactive'), '已停用');
  assert.equal(formatContactCategory(['HIDDEN']), '分類未取得'); assert.equal(formatContactStatus({ hidden: true }), '狀態未取得');
});
