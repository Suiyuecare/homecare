import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstitutionAdminPayloadBuilder } from '../public/data/institution-admin-editor.js';

const eventFields = [
  { name: 'title', type: 'text' }, { name: 'date', type: 'date' }, { name: 'startTime', type: 'time' }, { name: 'endTime', type: 'time' },
  { name: 'category', type: 'select', options: [{ value: 'meeting' }, { value: 'other' }] }, { name: 'location', type: 'text' },
  { name: 'note', type: 'textarea' }, { name: 'status', type: 'select', options: [{ value: 'active' }, { value: 'cancelled' }] },
];
const complaintFields = [{ name: 'title', type: 'text' }, { name: 'content', type: 'textarea' }, { name: 'handlingLog', type: 'textarea' }, { name: 'resolution', type: 'textarea' }];
const event = () => ({ id: 'synthetic-event', orgId: 'synthetic-org', version: 4, title: '  合成會議  ', date: '2026-10-10',
  startTime: '09:00', endTime: '10:00', category: 'meeting', location: '  合成會議室  ', note: '  合成第一行\r\n第二行\r第三行  ', status: 'active' });

test('untouched native displays omit every saved field and preserve padded single-line and CRLF text', () => {
  const existing = event(), before = structuredClone(existing);
  const editor = createInstitutionAdminPayloadBuilder({ fields: eventFields, initial: existing, existing });
  assert.equal(editor.initialDisplay.title, existing.title); assert.equal(editor.initialDisplay.location, existing.location);
  assert.equal(editor.initialDisplay.note, '  合成第一行\n第二行\n第三行  ');
  assert.deepEqual(editor.buildPayload(editor.initialDisplay), {}); assert.deepEqual(existing, before);
});

test('changing only the title never submits native-normalized notes or trims untouched padding', () => {
  const existing = event(), editor = createInstitutionAdminPayloadBuilder({ fields: eventFields, initial: existing, existing });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, title: '  合成新標題  ' }), { title: '合成新標題' });
  assert.deepEqual(editor.buildPayload({ title: '  合成新標題  ' }), { title: '合成新標題' });
  const effective = { ...existing, ...editor.buildPayload({ ...editor.initialDisplay, title: '合成新標題' }) };
  assert.equal(effective.note, existing.note); assert.equal(effective.location, existing.location);
});

test('complaint content, handling log and resolution remain exact when only title is edited', () => {
  const existing = { title: '  合成申訴  ', content: '  合成內容\r\n第二行  ', handlingLog: '  合成紀錄\r末行  ', resolution: '  合成結果\r\n確認  ' };
  const editor = createInstitutionAdminPayloadBuilder({ fields: complaintFields, initial: existing, existing });
  const payload = editor.buildPayload({ ...editor.initialDisplay, title: '新的合成申訴標題' });
  assert.deepEqual(payload, { title: '新的合成申訴標題' });
  const updated = { ...existing, ...payload };
  for (const key of ['content', 'handlingLog', 'resolution']) assert.equal(updated[key], existing[key]);
});

test('deliberately changed content is sent and normalized along the unchanged server trim contract', () => {
  const existing = { title: '合成申訴', content: '原合成\r\n內容', handlingLog: '原紀錄', resolution: '' };
  const editor = createInstitutionAdminPayloadBuilder({ fields: complaintFields, initial: existing, existing });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, content: '  明確新增\n處理內容  ' }), { content: '明確新增\n處理內容' });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, handlingLog: '' }), { handlingLog: '' });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, resolution: '  合成處理完成  ' }), { resolution: '合成處理完成' });
});

test('reverting an edit to its original display emits no patch; normalized no-op remains omitted', () => {
  const existing = { title: '合成申訴', content: '合成\r\n內容', handlingLog: '', resolution: '' };
  const editor = createInstitutionAdminPayloadBuilder({ fields: complaintFields, initial: existing, existing });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, title: '  合成申訴  ' }), {});
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, content: '合成\n內容' }), {});
});

test('new records still submit entered fields and trim supplied text without dropping empty optionals', () => {
  const editor = createInstitutionAdminPayloadBuilder({ fields: complaintFields, initial: {} });
  assert.deepEqual(editor.buildPayload({ title: '  合成新申訴  ', content: '  合成\n內容  ', handlingLog: '', resolution: '' }),
    { title: '合成新申訴', content: '合成\n內容', handlingLog: '', resolution: '' });
});

test('invalid native date/time/select displays do not erase untouched saved values', () => {
  const existing = { ...event(), date: '2026-02-29', startTime: '25:00', category: 'unobserved', location: '合成\r\n地點' };
  const editor = createInstitutionAdminPayloadBuilder({ fields: eventFields, initial: existing, existing });
  assert.equal(editor.initialDisplay.date, ''); assert.equal(editor.initialDisplay.startTime, ''); assert.equal(editor.initialDisplay.category, '');
  assert.equal(editor.initialDisplay.location, '合成地點');
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, title: '只改合成標題' }), { title: '只改合成標題' });
});

test('payload cannot inject metadata, unknown fields or invoke accessor values', () => {
  const existing = event(), editor = createInstitutionAdminPayloadBuilder({ fields: eventFields, initial: existing, existing });
  for (const values of [{ version: 4 }, { orgId: 'foreign-synthetic' }, { unknown: 'x' }, { title: null }, []]) assert.throws(() => editor.buildPayload(values));
  let calls = 0; const values = {}; Object.defineProperty(values, 'title', { enumerable: true, get() { calls++; return '不得讀取'; } });
  assert.throws(() => editor.buildPayload(values)); assert.equal(calls, 0);
});
