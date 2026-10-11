import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseContactFootprintEditor, assertCaseContactFootprintItem, confirmCaseContactFootprintList, validCaseContactFootprintDate } from '../public/data/case-contact-footprint-editor.js';
const caseId = 'synthetic-case-a', orgId = 'synthetic-org', cases = [{ id: caseId, orgId, caseNo: 'SYN-A', name: '合成原個案' }, { id: 'synthetic-case-b', orgId, caseNo: 'SYN-B', name: '合成相關個案' }], scope = { caseId, orgId }, form = existing => createCaseContactFootprintEditor({ ...scope, cases, existing, defaultDate: '2026-10-10' });
const values = () => ({ ...form().initial, location: ' 人工場所 ', contactDescription: ' 人工情形\n末行 ', relatedCaseId: 'synthetic-case-b', source: ' 人工来源 ', note: ' 完整備註\n末行 ' }), item = (patch = {}) => ({ ...form().buildPayload(values()), id: 'synthetic-footprint', orgId, version: 1, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', ...patch });
test('ordinary create adapter exposes labeled text/select/date/time inputs, unknown time remains blank and exact manual source confirms', () => {
  const editor = form(), payload = editor.buildPayload(values()); assert.equal(payload.time, ''); assert.equal(payload.location, ' 人工場所 '); assert.equal(payload.source, ' 人工来源 '); assert.ok(editor.fields.every(field => field.label)); assert.ok(!editor.fields.some(field => /json|gps|diagnosis|score|notification/i.test(field.name))); assert.equal(editor.fields.find(field => field.name === 'relatedCaseId').options.length, 2);
  const result = { item: item() }; assert.equal(editor.confirm(result, payload), result.item);
});
test('no-op and metadata-only edits preserve maximum long text/padding/CRLF with explicit replace/clear intent only', () => {
  const original = item({ contactDescription: ' 觀察原文\r\n末行 ', note: '字'.repeat(9997) + '\r\n ', source: '原\n來源', location: ' 原\n場所 ' }), editor = form(original); assert.equal(original.note.length, 10000);
  assert.equal(editor.initial.contactDescriptionIntent, 'keep'); assert.equal(editor.initial.contactDescription, ''); assert.equal(editor.enabled('contactDescription'), false); assert.deepEqual(editor.buildPayload(editor.initial), {});
  const payload = editor.buildPayload({ ...editor.initial, status: 'inactive' }); assert.deepEqual(payload, { status: 'inactive' }); assert.equal(editor.confirm({ item: { ...original, ...payload, version: 2 } }, payload).note, original.note);
  assert.deepEqual(editor.buildPayload({ ...editor.initial, contactDescriptionIntent: 'replace', contactDescription: ' 明確取代\n边界 ' }), { contactDescription: ' 明確取代\n边界 ' }); assert.deepEqual(editor.buildPayload({ ...editor.initial, sourceIntent: 'clear' }), { source: '' }); assert.throws(() => editor.buildPayload({ ...editor.initial, contactDescriptionIntent: 'clear' }));
});
test('complete ACK identity/CAS/raw-text/metadata rules reject omissions and nested executable data with zero getter reads', () => {
  const original = item(), editor = form(original), payload = { note: ' 本次變更 ' }, ack = { ...original, ...payload, version: 2 };
  for (const patch of [{ id: 'another' }, { orgId: 'another' }, { caseId: 'synthetic-case-b' }, { version: 1 }, { version: '2' }, { source: 'changed' }, { createdAt: 'changed' }, { updatedAt: '' }, { note: {} }, { latitude: 25 }]) assert.throws(() => editor.confirm({ item: { ...ack, ...patch } }, payload));
  for (const key of Object.keys(ack)) { const missing = { ...ack }; delete missing[key]; assert.throws(() => editor.confirm({ item: missing }, payload)); }
  let reads = 0; const unsafe = Object.defineProperty({ ...ack }, 'note', { enumerable: true, get() { reads++; return payload.note; } }); assert.throws(() => editor.confirm({ item: unsafe }, payload)); assert.throws(() => editor.confirm(Object.defineProperty({}, 'item', { enumerable: true, get() { reads++; return ack; } }), payload)); assert.equal(reads, 0);
  assert.throws(() => editor.confirm({ item: Object.defineProperty({ ...ack }, 'hidden', { value: true }) }, payload)); assert.throws(() => editor.confirm({ item: ack, extra: true }, payload));
});
test('closed 25-item pages refuse sparse/accessor/extra-key arrays, partial pages, duplicate IDs and wrong date/status/parent', () => {
  const row = item(), request = { ...scope, page: 1, pageSize: 25, date: row.date, status: 'active' }, response = { items: [row], page: 1, pageSize: 25, total: 1 }; assert.equal(confirmCaseContactFootprintList(response, request), response);
  for (const patch of [{ items: [] }, { total: 2, items: [row, row] }, { page: 2 }, { total: '1' }, { items: [{ ...row, status: 'inactive' }] }, { items: [{ ...row, date: '2026-10-09' }] }, { items: [{ ...row, caseId: 'synthetic-case-b' }] }, { clinicalData: true }]) assert.throws(() => confirmCaseContactFootprintList({ ...response, ...patch }, request));
  for (const decorate of [array => { delete array[0]; }, array => { array.hidden = true; }, array => { array[Symbol('hidden')] = true; }, array => Object.defineProperty(array, '0', { enumerable: true, get() { throw new Error('getter must not run'); } })]) { const list = [row]; decorate(list); assert.throws(() => confirmCaseContactFootprintList({ ...response, items: list }, request), error => !error.message.includes('getter must not run')); }
});
test('dates/time/identity/length controls are literal and immutable case cannot be submitted from the form', () => {
  for (const value of ['0000-01-01', '2026-02-29', '2026-10-10\n']) assert.equal(validCaseContactFootprintDate(value), false); assert.equal(validCaseContactFootprintDate('0001-01-01'), true);
  const editor = form(); for (const patch of [{ caseId: 'other' }, { date: '0000-01-01' }, { time: '09:00\n' }, { time: '09:00\r\n' }, { time: '24:00' }, { time: 9 }, { location: '字'.repeat(201) }, { contactDescription: '字'.repeat(2001) }, { source: '字'.repeat(501) }, { relatedCaseId: 'foreign-case' }, { contactDescription: ' ' }, { note: '字'.repeat(10001) }]) assert.throws(() => editor.buildPayload({ ...values(), ...patch }));
  assert.throws(() => assertCaseContactFootprintItem(item({ id: ' padded' }), scope)); assert.equal(editor.buildPayload({ ...values(), time: '23:59', relatedCaseId: '' }).time, '23:59');
});
