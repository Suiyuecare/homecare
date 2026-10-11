import test from 'node:test';
import assert from 'node:assert/strict';
import { institutionHolidayDate, institutionHolidayYear, institutionHolidayRecordValid, createInstitutionHolidayEditor, checkInstitutionHolidayRecord } from '../public/data/institution-holiday-editor.js';
const item = (extra = {}) => ({ date: '2026-10-10', title: '  合成指定日期  ', kind: 'holiday', sourceReference: '  原依據\r\n末行  ', note: '  原備註\r\n末行  ', status: 'active',
  id: 'synthetic-holiday', orgId: 'synthetic-org', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra });
test('strict literal dates and exact four-digit years reject whitespace, LF, zero year and rollover', () => {
  for (const valid of ['0001-01-01', '2024-02-29', '9999-12-31']) assert.equal(institutionHolidayDate(valid), true);
  for (const invalid of ['0000-01-01', '2026-02-29', '2026-04-31', '2026-10-10\n', '2026-1-01', ' 2026-01-01']) assert.equal(institutionHolidayDate(invalid), false);
  for (const valid of ['0001', '2026', '9999']) assert.equal(institutionHolidayYear(valid), true);
  for (const invalid of ['0000', '2026\n', '2026\r', ' 2026', '26', '10000', 2026]) assert.equal(institutionHolidayYear(invalid), false);
});
test('closed DTO hides unknown nested keys, accessors, symbols, wrong organization and unsafe versions without invoking getter', () => {
  assert.equal(institutionHolidayRecordValid(item(), 'synthetic-org'), true);
  assert.equal(institutionHolidayRecordValid(item(), 'other-org'), false);
  for (const value of [item({ unknown: { secret: 'synthetic-only' } }), item({ note: {} }), item({ version: 0 }), item({ version: Number.MAX_SAFE_INTEGER + 1 }), item({ createdAt: 'invalid' }), item({ kind: 'constructor' }), item({ date: '2026-02-30' })]) assert.equal(institutionHolidayRecordValid(value), false);
  let calls = 0; const accessor = item(); Object.defineProperty(accessor, 'note', { enumerable: true, get() { calls++; return 'forbidden'; } });
  assert.equal(institutionHolidayRecordValid(accessor), false); assert.throws(() => checkInstitutionHolidayRecord({ item: accessor }));
  const envelope = {}; Object.defineProperty(envelope, 'item', { enumerable: true, get() { calls++; return item(); } }); assert.throws(() => checkInstitutionHolidayRecord(envelope));
  const symbol = item(); symbol[Symbol('hidden')] = 'synthetic'; assert.equal(institutionHolidayRecordValid(symbol), false); assert.equal(calls, 0);
});
test('unchanged textarea CRLF display and leading/trailing spaces produce no PATCH', () => {
  const existing = item(), editor = createInstitutionHolidayEditor({ existing });
  assert.equal(editor.initial.sourceReference, '  原依據\n末行  '); assert.equal(editor.initial.title, existing.title);
  assert.deepEqual(editor.buildPayload({ ...editor.initial }), {}); assert.deepEqual(existing, item());
});
test('editing only the title omits untouched raw multiline data and status', () => {
  const editor = createInstitutionHolidayEditor({ existing: item() }); assert.deepEqual(editor.buildPayload({ ...editor.initial, title: '  明確改名稱  ' }), { title: '  明確改名稱  ' });
});
test('deliberate text edits and empty optional fields preserve exact submitted values', () => {
  const editor = createInstitutionHolidayEditor({ existing: item() });
  assert.deepEqual(editor.buildPayload({ ...editor.initial, sourceReference: '  本次依據\n末行  ', note: '' }), { sourceReference: '  本次依據\n末行  ', note: '' });
  assert.deepEqual(editor.buildPayload({ ...editor.initial, date: '2026-10-11', kind: 'working-day' }), { date: '2026-10-11', kind: 'working-day' });
});
test('ordinary create needs explicitly chosen date/title/kind, not a statutory default', () => {
  const editor = createInstitutionHolidayEditor({ defaultDate: '2026-10-10' }); assert.equal(editor.initial.kind, '');
  assert.throws(() => editor.buildPayload(editor.initial));
  const payload = editor.buildPayload({ ...editor.initial, title: '合成機構日期', kind: 'closure' });
  assert.deepEqual(payload, { date: '2026-10-10', title: '合成機構日期', kind: 'closure', sourceReference: '', note: '' });
  assert.equal(editor.fields.some(field => ['payroll', 'invoice', 'leave', 'graceMinutes'].includes(field.name)), false);
});
test('invalid fields, unknown input and getter values are rejected without reading hidden content', () => {
  const editor = createInstitutionHolidayEditor({ existing: item() });
  for (const overrides of [{ title: ' ' }, { title: 'x\ny' }, { kind: '__proto__' }, { date: '2026-02-29' }, { sourceReference: '字'.repeat(2001) }, { note: '字'.repeat(10001) }, { extra: 'hidden' }]) assert.throws(() => editor.buildPayload({ ...editor.initial, ...overrides }));
  let calls = 0; const values = { ...editor.initial }; Object.defineProperty(values, 'note', { enumerable: true, get() { calls++; return 'hidden'; } }); assert.throws(() => editor.buildPayload(values)); assert.equal(calls, 0);
});
test('exact create/PATCH/status acknowledgements require complete content, identity and next version', () => {
  const original = item(), payload = { title: '新名稱' }, saved = item({ ...payload, version: 2 });
  assert.deepEqual(checkInstitutionHolidayRecord({ item: saved }, { id: original.id, orgId: original.orgId, original, payload }), saved);
  for (const extra of [{ version: 1 }, { id: 'different' }, { orgId: 'different' }, { note: 'silently trimmed' }, { createdAt: '2026-10-02T00:00:00.000Z' }, { extra: {} }]) assert.throws(() => checkInstitutionHolidayRecord({ item: { ...saved, ...extra } }, { id: original.id, orgId: original.orgId, original, payload }));
  const cancelled = item({ status: 'inactive', version: 2 }); checkInstitutionHolidayRecord({ item: cancelled }, { original, orgId: original.orgId, payload: { status: 'inactive' } });
  assert.throws(() => checkInstitutionHolidayRecord({ item: item({ status: 'inactive', version: 2, sourceReference: 'changed' }) }, { original, orgId: original.orgId, payload: { status: 'inactive' } }));
  let calls = 0; const badPayload = {}; Object.defineProperty(badPayload, 'note', { enumerable: true, get() { calls++; return 'hidden'; } }); assert.throws(() => checkInstitutionHolidayRecord({ item: saved }, { original, orgId: original.orgId, payload: badPayload })); assert.equal(calls, 0);
});
