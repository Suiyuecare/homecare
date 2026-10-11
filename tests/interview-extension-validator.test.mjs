import test from 'node:test';
import assert from 'node:assert/strict';
import { interviewExtensionSpec, normalizeExtendedInterviewPayload, assertInterviewExtensionPayload, validateInterviewExtension,
  interviewExtensionVisible, interviewExtensionHistoryVisible, interviewExtensionRecordValid } from '../src/server/interview-extension.mjs';
const orgId = 'synthetic-extension-org', entity = 'interview-applicants', ctx = { orgId, role: 'admin' };
const meta = { id: 'synthetic-interview', orgId, version: 1, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
const base = { name: '合成面試者', phone: '合成電話文字', interviewDate: '2026-10-10', city: '', district: '', interviewContent: '合成內容', note: '', status: 'active' };
const full = overrides => ({ ...interviewExtensionSpec.defaults, ...base, ...overrides });
const record = overrides => ({ ...full(), ...meta, ...overrides });
const fail = (status, code, message, fields) => { const error = new Error(message); Object.assign(error, { status, code, fields }); throw error; };
const employees = new Map(['active', 'inactive', 'foreign'].map(status => [status, { id: status, orgId: status === 'foreign' ? 'synthetic-other-org' : orgId, status: status === 'inactive' ? 'inactive' : 'active' }]));
const get = (_db, org, kind, id) => kind === 'employees' && employees.get(id)?.orgId === org ? employees.get(id) : null;
const validate = (data, old = null, current = ctx) => validateInterviewExtension(null, current, entity, data, old, fail,
  (db, org, kind, id) => kind === entity && old?.id === id && old.orgId === org ? old : get(db, org, kind, id));

test('extension spec contains exactly18 fields, old8 required, newoptional defaults and aligned longest limits', () => {
  assert.equal(interviewExtensionSpec.fields.split(' ').length, 18);
  assert.deepEqual(interviewExtensionSpec.required, ['name', 'phone', 'interviewDate', 'interviewContent']);
  assert.equal(interviewExtensionSpec.defaults.decision, 'pending'); assert.equal(interviewExtensionSpec.defaults.interviewerEmployeeId, '');
  for (const key of ['workExperience', 'certificateNotes', 'interviewQuestions', 'decisionReason']) assert.equal(interviewExtensionSpec.maxLengths[key], 10000);
  validate(full()); validate({ ...base });
});

test('replacement normalizer preserves every supplied new text byte while old8 and restricted ids/dates/enums keep existing trim semantics', () => {
  const input = { name: ' 原姓名 ', interviewContent: ' \r\n合成原面試\r\n ', note: ' 原備註\n ', workExperience: ' \r\n合成經歷\r\n ', appliedPosition: '  合成職務  ', education: '\t合成學歷 ', availableHours: ' \r合成時段\n ', certificateNotes: ' 合成證照\r\n ', interviewQuestions: ' 合成提問\r\n ', decisionReason: ' 合成當次原因\r\n ', availableFrom: ' 2026-10-10 ', interviewerEmployeeId: ' active ', decision: ' selected ' };
  const output = normalizeExtendedInterviewPayload(entity, input);
  for (const key of ['name', 'interviewContent', 'note', 'availableFrom', 'interviewerEmployeeId', 'decision']) assert.equal(output[key], input[key].trim());
  for (const key of ['workExperience', 'appliedPosition', 'education', 'availableHours', 'certificateNotes', 'interviewQuestions', 'decisionReason']) assert.equal(output[key], input[key]);
  assert.equal(normalizeExtendedInterviewPayload('cases', input), input); assert.equal(input.name, ' 原姓名 ');
});

test('raw explicit decision operations require a current reason before merge, even same-decision PATCH cannot inherit an old reason', () => {
  assert.doesNotThrow(() => assertInterviewExtensionPayload(entity, { decision: 'pending' }, fail, false));
  assert.doesNotThrow(() => assertInterviewExtensionPayload(entity, { decision: 'selected', decisionReason: '合成當次原因' }, fail, false));
  assert.doesNotThrow(() => assertInterviewExtensionPayload(entity, { name: '只改姓名' }, fail, true));
  for (const decision of ['pending', 'considering', 'selected', 'not_selected']) for (const reason of [undefined, '', '\r\n\t　', null, 1]) {
    const payload = { decision, ...(reason === undefined ? {} : { decisionReason: reason }) };
    assert.throws(() => assertInterviewExtensionPayload(entity, payload, fail, true), { status: 422, code: 'DECISION_REASON_REQUIRED' });
    if (decision !== 'pending') assert.throws(() => assertInterviewExtensionPayload(entity, payload, fail, false), { status: 422, code: 'DECISION_REASON_REQUIRED' });
  }
  validate(full({ decision: 'selected', decisionReason: '合成原因' }));
  assert.throws(() => validate(full({ decision: 'selected', decisionReason: '' })), { status: 422, code: 'DECISION_REASON_REQUIRED' });
});

test('same-org active newassignment, retained inactive oldassignment and explicitclear work; foreign/inactive-new/missing parent fail closed', () => {
  validate(full({ interviewerEmployeeId: 'active' }));
  const old = record({ interviewerEmployeeId: 'inactive' }); validate(full({ interviewerEmployeeId: 'inactive', workExperience: '合成新經歷' }), old);
  validate(full({ interviewerEmployeeId: '' }), old);
  for (const interviewerEmployeeId of ['inactive', 'foreign', 'missing']) assert.throws(() => validate(full({ interviewerEmployeeId })), { status: 422 });
  for (const role of ['finance', 'caregiver']) assert.throws(() => validate(full(), null, { ...ctx, role }), { status: 403 });
  assert.throws(() => validate(full(), record({ interviewerEmployeeId: 'foreign' })), { status: 404 });
});

test('read/historical sources close metadata and newfields while legacy8 scalar-kind values or missing optional extensions remain readable', () => {
  const old8 = { ...base, ...meta }; assert(interviewExtensionVisible(null, ctx, entity, old8, get));
  const legacy = { ...old8, interviewContent: { legacy: '合成只允許型別標記，不展開' }, city: false }; assert(interviewExtensionRecordValid(legacy, orgId));
  assert(interviewExtensionVisible(null, ctx, entity, record({ interviewerEmployeeId: 'inactive' }), get));
  for (const patch of [{ workExperience: { nested: '不能展開' } }, { certificateNotes: null }, { availableFrom: '2026-02-29' }, { decision: 'hired' }, { unknown: '不能展開' }, { orgId: 'foreign' }, { version: Number.MAX_SAFE_INTEGER + 1 }, { updatedAt: 'not-a-time' }, { createdAt: '2026-10-10T03:00:00.000Z' }, { interviewerEmployeeId: 'foreign' }])
    assert.equal(interviewExtensionVisible(null, ctx, entity, record(patch), get), false, JSON.stringify(patch));
  assert.equal(interviewExtensionVisible(null, { ...ctx, role: 'finance' }, entity, old8, get), false);
  const current = record({ version: 3 }), snapshot = { ...base, ...meta, version: 2 };
  assert(interviewExtensionHistoryVisible(null, ctx, entity, snapshot, current, get));
  for (const patch of [{ id: 'different' }, { version: 4 }, { createdAt: '2026-10-09T00:00:00.000Z' }, { interviewerEmployeeId: 'foreign' }, { decisionReason: { unknown: '合成' } }])
    assert.equal(interviewExtensionHistoryVisible(null, ctx, entity, { ...snapshot, ...patch }, current, get), false);
});

test('limits/types/dates are closed and malicious metadata/extensions/reference getters execute zero times', () => {
  const limits = { appliedPosition: 200, education: 500, workExperience: 10000, availableHours: 2000, certificateNotes: 10000, interviewQuestions: 10000, decisionReason: 10000 };
  for (const [key, maximum] of Object.entries(limits)) {
    validate(full({ [key]: '字'.repeat(maximum) }));
    for (const value of ['字'.repeat(maximum + 1), null, 1, true, [], {}]) assert.throws(() => validate(full({ [key]: value })), { status: 422 });
  }
  for (const key of ['appliedPosition', 'education']) for (const value of ['合成\n換行', '合成\r換行']) assert.throws(() => validate(full({ [key]: value })), { status: 422 });
  for (const availableFrom of ['2026-10-10\n', '0000-01-01', '2026-02-29']) assert.throws(() => validate(full({ availableFrom })), { status: 422 });
  let calls = 0;
  for (const key of ['workExperience', 'id', 'version']) {
    const item = record(); Object.defineProperty(item, key, { get() { calls++; return 'private'; }, enumerable: true });
    assert.equal(interviewExtensionVisible(null, ctx, entity, item, get), false);
  }
  const payload = {}; Object.defineProperty(payload, 'decision', { get() { calls++; return 'selected'; }, enumerable: true });
  assert.throws(() => assertInterviewExtensionPayload(entity, payload, fail, true), { status: 422 });
  const badEmployee = { ...employees.get('active') }; Object.defineProperty(badEmployee, 'status', { get() { calls++; return 'active'; }, enumerable: true });
  assert.equal(interviewExtensionVisible(null, ctx, entity, record({ interviewerEmployeeId: 'active' }), () => badEmployee), false);
  assert.equal(calls, 0);
});
