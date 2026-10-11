import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_HEALTH_PROFILES, createCaseHealthEditor, assertCaseHealthItem, confirmCaseHealthList, validCaseHealthDate } from '../public/data/case-health-editor.js';

const orgId = 'synthetic-health-org', caseId = 'synthetic-health-case', entities = Object.keys(CASE_HEALTH_PROFILES);
const editor = (entity, existing = null) => createCaseHealthEditor({ entity, existing, caseId, orgId, defaultDate: '2026-10-10' });
const values = (entity, overrides = {}) => ({ ...editor(entity).initial,
  ...(entity === 'case-vaccinations' ? { vaccine: '合成疫苗名稱' } : entity === 'case-infection-records' ? { category: '合成人工分類', observation: '合成觀察第一行\n第二行' } : { time: '09:05', metric: '合成量測名稱', value: '00036.500', unit: '合成人工單位' }), ...overrides });
const item = (entity, overrides = {}) => ({ ...editor(entity).buildPayload(values(entity)), id: 'synthetic-health-record', orgId, version: 1, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', ...overrides });

test('three health forms produce closed manual text profiles without clinical defaults and confirm exact create responses', () => {
  for (const entity of entities) {
    const form = editor(entity), payload = form.buildPayload(values(entity, { note: ' 第一行\n第二行 ', source: ' 合成人工來源 ' }));
    assert.deepEqual(Object.keys(payload).sort(), ['caseId', ...CASE_HEALTH_PROFILES[entity].fields].sort());
    assert.equal(payload.note, ' 第一行\n第二行 '); assert.equal(payload.source, ' 合成人工來源 '); assert.equal(payload.status, 'active');
    const result = { ...payload, id: 'saved-synthetic-health', orgId, version: 1 }; assert.equal(form.confirm(result, payload), result);
    assert.ok(!form.fields.some(field => ['diagnosis', 'clinicalScore', 'referenceRange'].includes(field.name)));
  }
  const vital = editor('case-vitals'); for (const field of ['metric', 'value', 'unit', 'time']) assert.equal(vital.initial[field], '');
  assert.equal(vital.fields.find(field => field.name === 'value').type, 'text'); assert.equal(vital.fields.find(field => field.name === 'value').inputMode, 'decimal');
});

test('vital decimal text preserves zeros and precision without numeric conversion or inferred units', () => {
  const form = editor('case-vitals');
  for (const value of ['0', '0.00', '00036.500', '12345678901234567890.' + '0'.repeat(19)]) {
    const payload = form.buildPayload(values('case-vitals', { value })); assert.equal(payload.value, value);
    assert.equal(form.confirm({ ...payload, id: 'saved', orgId, version: 1 }, payload).value, value);
  }
  for (const value of [36.5, '-1', '+1', '1e2', ' 36.5', '36.5 ', '1\n', '1\r\n', '.5', '1.', '1,000', 'NaN', '字', '0'.repeat(41)]) assert.throws(() => form.buildPayload(values('case-vitals', { value })), String(value));
  assert.throws(() => assertCaseHealthItem(item('case-vitals', { value: '1\n' }), { entity: 'case-vitals', caseId, orgId }));
  for (const time of ['24:00', '23:60', '9:05', '09:05:00', '']) assert.throws(() => form.buildPayload(values('case-vitals', { time })));
});

test('no-op edits and single edits preserve untouched padding, maximum length and all original dates and text', () => {
  for (const entity of entities) {
    const original = item(entity, { note: '字'.repeat(10000), source: ' 保持原來源 ', ...(entity === 'case-infection-records' ? { observation: '觀'.repeat(2000), action: '處'.repeat(2000) } : {}) }), form = editor(entity, original);
    assert.deepEqual(form.buildPayload(form.initial), {});
    const payload = form.buildPayload({ ...form.initial, note: ' 明確更改\n第二行 ' }); assert.deepEqual(payload, { note: ' 明確更改\n第二行 ' });
    const response = { ...original, ...payload, version: 2 }; assert.equal(form.confirm(response, payload).source, original.source);
    assert.equal(original.note.length, 10000); assert.throws(() => form.buildPayload({ ...form.initial, caseId: 'other' }));
  }
});

test('native-unrepresentable CRLF and single-line newlines stay private until explicit replacement or permitted clear', () => {
  for (const entity of entities) {
    const name = entity === 'case-vaccinations' ? 'vaccine' : entity === 'case-infection-records' ? 'category' : 'metric';
    const original = item(entity, { note: '原\r\n完整備註 ', source: '原\n來源', [name]: '原\n名稱' }), form = editor(entity, original);
    assert.equal(form.initial.noteIntent, 'keep'); assert.equal(form.initial.note, ''); assert.equal(form.initial[name + 'Intent'], 'keep'); assert.equal(form.enabled('note'), false);
    assert.deepEqual(form.buildPayload(form.initial), {}); assert.ok(!JSON.stringify(form.fields).includes(original.note));
    const payload = form.buildPayload({ ...form.initial, noteIntent: 'replace', note: ' 明確替換\n保留空白 ' }); assert.deepEqual(payload, { note: ' 明確替換\n保留空白 ' });
    assert.equal(form.confirm({ ...original, ...payload, version: 2 }, payload)[name], original[name]);
    assert.deepEqual(form.buildPayload({ ...form.initial, sourceIntent: 'clear' }), { source: '' });
    assert.throws(() => form.buildPayload({ ...form.initial, [name + 'Intent']: 'clear' }));
  }
});

test('complete ACK guards reject wrong scope, identity, version, any omitted/changed field and unknown nested data', () => {
  for (const entity of entities) {
    const original = item(entity), form = editor(entity, original), payload = { note: '明確保存' }, correct = { ...original, ...payload, version: 2 };
    for (const patch of [{ id: ' ' }, { id: ' padded' }, { id: 'other' }, { caseId: 'other' }, { orgId: 'other' }, { version: 1 }, { version: '2' }, { source: '未核定來源' }, { note: '未保存' }, { diagnosis: { hidden: true } }, { source: { hidden: true } }, { updatedAt: { hidden: true } }]) assert.throws(() => form.confirm({ ...correct, ...patch }, payload));
    for (const key of CASE_HEALTH_PROFILES[entity].fields) { const missing = { ...correct }; delete missing[key]; assert.throws(() => form.confirm(missing, payload), key); }
    assert.equal(form.confirm(correct, payload), correct);
    const creation = editor(entity), fresh = creation.buildPayload(values(entity)); assert.throws(() => creation.confirm({ ...fresh, id: ' ', orgId, version: 1 }, fresh));
  }
});

test('closed list validation rejects partial pages, duplicates, wrong parent/date/status and unknown response fields on records', () => {
  for (const entity of entities) {
    const row = item(entity), request = { entity, caseId, orgId, page: 1, pageSize: 25, date: row.date, status: 'active' }, response = { items: [row], total: 1, page: 1, pageSize: 25 };
    assert.equal(confirmCaseHealthList(response, request), response);
    for (const patch of [{ page: 2 }, { pageSize: 100 }, { total: '1' }, { total: -1 }, { items: [] }, { total: 2, items: [row, row] }, { items: [{ ...row, caseId: 'other' }] }, { items: [{ ...row, date: '2026-10-11' }] }, { items: [{ ...row, status: 'inactive' }] }, { items: [{ ...row, hidden: [] }] }]) assert.throws(() => confirmCaseHealthList({ ...response, ...patch }, request));
    assert.equal(confirmCaseHealthList({ items: [], total: 1, page: 2, pageSize: 25 }, { ...request, page: 2 }).items.length, 0);
  }
});

test('dates, follow-up timing, maximum lengths, text types and required values are validated without diagnosis rules', () => {
  for (const value of ['0001-01-01', '2024-02-29', '9999-12-31']) assert.equal(validCaseHealthDate(value), true);
  for (const value of ['0000-01-01', '2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', null]) assert.equal(validCaseHealthDate(value), false);
  for (const entity of entities) {
    const form = editor(entity);
    for (const patch of [{ note: '字'.repeat(10001) }, { source: '字'.repeat(501) }, { date: '0000-01-01' }, { status: 'deleted' }, { unknown: 'text' }, { note: {} }]) assert.throws(() => form.buildPayload(values(entity, patch)));
    for (const key of CASE_HEALTH_PROFILES[entity].required) assert.throws(() => form.buildPayload(values(entity, { [key]: '' })), key);
  }
  const infection = editor('case-infection-records');
  for (const patch of [{ category: '字'.repeat(101) }, { observation: '字'.repeat(2001) }, { action: '字'.repeat(2001) }, { followUpDate: '2026-10-09' }, { followUpDate: '2026-02-30' }]) assert.throws(() => infection.buildPayload(values('case-infection-records', patch)));
  assert.equal(infection.buildPayload(values('case-infection-records', { followUpDate: '2026-10-10' })).followUpDate, '2026-10-10');
});
