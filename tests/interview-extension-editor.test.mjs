import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtendedInterviewEditor, INTERVIEW_LOCAL_FIELDS, INTERVIEW_EXTENSION_FIELDS, INTERVIEW_EXTENSION_LIMITS,
  INTERVIEW_EXTENSION_DEFAULTS, INTERVIEW_FIELD_GROUPS, interviewExtensionDate, interviewExtensionFieldsValid } from '../public/data/interview-extension-editor.js';
const orgId = 'synthetic-interview-extension-org', employeeId = 'synthetic-active-interviewer', inactiveId = 'synthetic-inactive-interviewer';
const choices = [{ value: employeeId, label: '合成面試員工甲', active: true }, { value: inactiveId, label: '合成面試員工乙', active: false }];
const base = { name: '合成面試者', phone: '合成人工電話', interviewDate: '2026-10-10', city: '合成市', district: '合成區', interviewContent: '合成面試紀錄', note: '', status: 'active' };
const meta = { id: 'synthetic-interview-record', orgId, version: 3, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T01:00:00.000Z' };
const saved = overrides => ({ ...base, ...INTERVIEW_EXTENSION_DEFAULTS, ...meta, ...overrides });
const blank = editor => ({ ...editor.initial, ...base });
const ack = (old, payload) => ({ ...old, ...payload, version: old.version + 1, updatedAt: '2026-10-10T02:00:00.000Z' });

test('new ordinary form has exactly18 real controls and four semantic first-control group descriptors', () => {
  const editor = createExtendedInterviewEditor({ defaultDate: '2026-10-10', interviewers: choices }), payload = editor.buildPayload(blank(editor));
  assert.equal(editor.fields.length, 18); assert.deepEqual(new Set(editor.fields.map(field => field.name)), new Set(INTERVIEW_LOCAL_FIELDS));
  assert.deepEqual(editor.fields.filter(field => Object.hasOwn(field, 'groupLabel')).map(field => [field.name, field.groupLabel]), [['name', '基本資料'], ['appliedPosition', '工作意願與經歷'], ['interviewDate', '面試紀錄'], ['decision', '人工評估']]);
  assert.deepEqual(editor.fields.map(field => field.name), INTERVIEW_FIELD_GROUPS.flatMap(group => group.keys));
  assert.deepEqual(Object.keys(payload).sort(), [...INTERVIEW_LOCAL_FIELDS].sort());
  assert.equal(payload.decision, 'pending'); assert.equal(payload.status, 'active');
  assert.equal(editor.fields.find(field => field.name === 'interviewerEmployeeId').options[0].value, '');
  assert(!editor.fields.find(field => field.name === 'interviewerEmployeeId').options.some(option => option.value === inactiveId));
  const item = { ...payload, ...meta, version: 1 }; assert.equal(editor.confirm(item, orgId, payload), item);
});

test('old eight-field rows remain absent in ten optional fields through no-op, single-field edits, status operations and acknowledgement', () => {
  const old = { ...base, ...meta }, editor = createExtendedInterviewEditor({ existing: old, interviewers: choices });
  assert.deepEqual(editor.buildPayload({ ...editor.initial }), {}); assert.equal(editor.initial.decision, 'pending');
  const payload = editor.buildPayload({ ...editor.initial, name: ' 合成改姓名 ' }); assert.deepEqual(payload, { name: '合成改姓名' });
  const item = ack(old, payload); assert.equal(editor.confirm(item, orgId, payload), item);
  assert.throws(() => editor.confirm({ ...item, decision: 'pending' }, orgId, payload), { code: 'SAVE_UNCONFIRMED' });
  const status = editor.buildStatusChange('inactive'); assert.deepEqual(status, { status: 'inactive' }); editor.confirm(ack(old, status), orgId, status);
  assert.throws(() => editor.buildPayload({ ...editor.initial, status: 'inactive' }), /名單狀態/);
});

test('unchanged CRLF, loneCR and leading/trailing whitespace stay private and are omitted; intentional long-field edits remain exact', () => {
  const old = saved({ name: ' 合成原姓名 ', interviewContent: ' \r\n合成原面試\r\n ', note: '\r合成原備註\r', workExperience: '  合成原經歷\r\n第二行\r第三行  ', availableHours: '\t合成時段\r\n ', certificateNotes: '  合成證照\n ', interviewQuestions: ' \r\n合成原提問\n ', decisionReason: '  合成原原因\r\n ' });
  const editor = createExtendedInterviewEditor({ existing: old, interviewers: choices });
  assert.equal(editor.initial.workExperience, '  合成原經歷\n第二行\n第三行  '); assert(editor.needsIntent('interviewContent'));
  assert.deepEqual(editor.buildPayload({ ...editor.initial }), {});
  const name = editor.buildPayload({ ...editor.initial, name: '合成新姓名' }); assert.deepEqual(name, { name: '合成新姓名' });
  editor.confirm(ack(old, name), orgId, name);
  for (const field of ['workExperience', 'availableHours', 'certificateNotes', 'interviewQuestions', 'decisionReason']) {
    const text = '  合成本次內容\n末行 \t', payload = editor.buildPayload({ ...editor.initial, [field]: text });
    assert.deepEqual(payload, { [field]: text }); editor.confirm(ack(old, payload), orgId, payload);
  }
});

test('manual decision changes require a fresh explicit reason and never change active/inactive or create employee fields', () => {
  const old = saved({ decisionReason: '原原因不可默默沿用' }), editor = createExtendedInterviewEditor({ existing: old, interviewers: choices });
  assert.throws(() => editor.buildPayload({ ...editor.initial, decision: 'selected' }), error => Object.hasOwn(error.fields, 'decisionReason'));
  assert.throws(() => editor.buildPayload({ ...editor.initial, decision: 'selected', decisionReason: '  \n' }), error => Object.hasOwn(error.fields, 'decisionReason'));
  const payload = editor.buildPayload({ ...editor.initial, decision: 'selected', decisionReason: '  合成本次選用意向依據\n ' });
  assert.deepEqual(payload, { decision: 'selected', decisionReason: '  合成本次選用意向依據\n ' });
  editor.confirm(ack(old, payload), orgId, payload); assert.equal(ack(old, payload).status, 'active');
  for (const decision of ['considering', 'selected', 'not_selected']) {
    const create = createExtendedInterviewEditor({ interviewers: choices });
    assert.throws(() => create.buildPayload({ ...blank(create), decision }), /原因/);
    assert.equal(create.buildPayload({ ...blank(create), decision, decisionReason: '合成當次原因' }).decision, decision);
  }
});

test('new/change interviewer selects only active organization choices while current inactive or unresolved assignment is preserved', () => {
  const old = saved({ interviewerEmployeeId: inactiveId }), editor = createExtendedInterviewEditor({ existing: old, interviewers: choices });
  assert.deepEqual(editor.buildPayload({ ...editor.initial }), {});
  assert(editor.fields.find(field => field.name === 'interviewerEmployeeId').options.find(option => option.value === inactiveId).label.includes('目前已停用'));
  const payload = editor.buildPayload({ ...editor.initial, interviewerEmployeeId: employeeId }); assert.deepEqual(payload, { interviewerEmployeeId: employeeId });
  editor.confirm(ack(old, payload), orgId, payload);
  const unassigned = createExtendedInterviewEditor({ existing: saved(), interviewers: choices });
  assert.throws(() => unassigned.buildPayload({ ...unassigned.initial, interviewerEmployeeId: inactiveId }), /使用中/);
  assert.throws(() => unassigned.buildPayload({ ...unassigned.initial, interviewerEmployeeId: 'synthetic-foreign-employee' }), /使用中/);
  const unresolved = createExtendedInterviewEditor({ existing: old, interviewers: [] });
  assert(unresolved.needsIntent('interviewerEmployeeId')); assert.equal(unresolved.enabled('interviewerEmployeeId', unresolved.initial), false);
  assert.deepEqual(unresolved.buildPayload({ ...unresolved.initial, name: '合成只改姓名' }), { name: '合成只改姓名' });
  assert.deepEqual(unresolved.buildPayload({ ...unresolved.initial, interviewerEmployeeIdIntent: 'clear' }), { interviewerEmployeeId: '' });
});

test('optional extension limits, strict real dates and closed enum/type guards reject no implicit qualification', () => {
  assert(interviewExtensionDate('2024-02-29')); assert(interviewExtensionDate('0001-01-01')); assert(interviewExtensionDate('9999-12-31'));
  for (const date of ['2026-02-29', '2026-10-10\n', '0000-01-01', '2026-1-01', '2026-10-10T00:00:00Z']) assert.equal(interviewExtensionDate(date), false);
  for (const key of INTERVIEW_EXTENSION_FIELDS) {
    const editor = createExtendedInterviewEditor({ existing: saved(), interviewers: choices });
    for (const value of [null, {}, [], 1, true, '字'.repeat(INTERVIEW_EXTENSION_LIMITS[key] + 1)]) assert.throws(() => editor.buildPayload({ ...editor.initial, [key]: value }), key);
  }
  for (const key of ['appliedPosition', 'education']) {
    const editor = createExtendedInterviewEditor({ existing: saved(), interviewers: choices });
    assert.throws(() => editor.buildPayload({ ...editor.initial, [key]: '合成\n換行' }));
    assert.deepEqual(editor.buildPayload({ ...editor.initial, [key]: '  合成單行說明  ' }), { [key]: '  合成單行說明  ' });
  }
  assert(interviewExtensionFieldsValid({})); assert(interviewExtensionFieldsValid({ decision: 'pending' }));
  assert.equal(interviewExtensionFieldsValid({ decision: 'selected', decisionReason: '' }), false);
});

test('acknowledgement checks all18 field values/presence, original identity, next version and immutable creation timestamp', () => {
  const old = saved({ workExperience: ' 原保存文字\r\n ' }), editor = createExtendedInterviewEditor({ existing: old, interviewers: choices }), payload = { name: '合成更新姓名' }, item = ack(old, payload);
  assert.equal(editor.confirm(item, orgId, payload), item);
  for (const patch of [{ id: 'other' }, { orgId: 'other' }, { version: old.version }, { version: old.version + 2 }, { name: '錯誤ACK' }, { workExperience: old.workExperience.trim() }, { createdAt: item.updatedAt }, { decisionReason: null }, { unknownField: 'synthetic-secret' }])
    assert.throws(() => editor.confirm({ ...item, ...patch }, orgId, payload), { code: 'SAVE_UNCONFIRMED' });
  const missing = { ...item }; delete missing.education; assert.throws(() => editor.confirm(missing, orgId, payload), { code: 'SAVE_UNCONFIRMED' });
  assert.throws(() => editor.confirm(item, orgId, { ...payload, employeeId }), { code: 'SAVE_UNCONFIRMED' });
});

test('malicious known-field, nested array and choice getters are rejected without executing them; unknown saved getters are not read', () => {
  let calls = 0;
  for (const field of ['name', 'workExperience', 'orgId']) {
    const old = saved(); Object.defineProperty(old, field, { get() { calls++; return 'synthetic-private'; }, enumerable: true });
    assert.throws(() => createExtendedInterviewEditor({ existing: old, interviewers: choices }));
  }
  const nested = []; Object.defineProperty(nested, '0', { get() { calls++; return 'synthetic-private'; }, enumerable: true });
  assert.throws(() => createExtendedInterviewEditor({ existing: saved({ note: nested }), interviewers: choices }));
  const badChoices = []; Object.defineProperty(badChoices, '0', { get() { calls++; return choices[0]; }, enumerable: true });
  assert.throws(() => createExtendedInterviewEditor({ existing: saved(), interviewers: badChoices }));
  const old = saved(); Object.defineProperty(old, 'unknownSaved', { get() { calls++; return 'synthetic-private'; }, enumerable: true });
  const editor = createExtendedInterviewEditor({ existing: old, interviewers: choices }); assert.deepEqual(editor.buildPayload(editor.initial), {});
  for (const target of ['values', 'item', 'payload']) {
    const malicious = target === 'values' ? { ...editor.initial } : target === 'item' ? ack(saved(), { name: '合成新姓名' }) : { name: '合成新姓名' };
    Object.defineProperty(malicious, target === 'values' ? 'decisionReason' : 'name', { get() { calls++; return 'synthetic-private'; }, enumerable: true });
    if (target === 'values') { assert.throws(() => editor.buildPayload(malicious)); assert.equal(editor.enabled('decisionReason', malicious), false); }
    else assert.throws(() => editor.confirm(target === 'item' ? malicious : ack(saved(), { name: '合成新姓名' }), orgId, target === 'payload' ? malicious : { name: '合成新姓名' }), { code: 'SAVE_UNCONFIRMED' });
  }
  assert.equal(calls, 0);
});

test('mutable public descriptors/initial values cannot replace the private saved baseline or ACK original values', () => {
  const old = saved({ workExperience: ' 合成原完整\r\n ' }), editor = createExtendedInterviewEditor({ existing: old, interviewers: choices });
  old.workExperience = '外部突變'; editor.initial.workExperience = '表單初始值外部突變';
  const payload = editor.buildPayload({ ...editor.initial, workExperience: ' 合成原完整\n ' }); assert.deepEqual(payload, {});
  const original = saved({ workExperience: ' 合成原完整\r\n ' }); editor.confirm(ack(original, { name: '合成更新' }), orgId, { name: '合成更新' });
  assert.throws(() => editor.confirm(ack(original, { workExperience: '表單初始值外部突變' }), orgId, {}), { code: 'SAVE_UNCONFIRMED' });
});
