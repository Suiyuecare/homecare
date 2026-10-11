import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_SUPPORT_PROFILES, createCaseSupportEditor, assertCaseSupportItem, confirmCaseSupportList, validCaseSupportDate } from '../public/data/case-support-editor.js';

const orgId = 'synthetic-org', caseId = 'synthetic-case';
function editor(entity, existing = null) { return createCaseSupportEditor({ entity, existing, caseId, orgId, defaultDate: '2026-10-10' }); }
function values(entity, overrides = {}) {
  return { ...editor(entity).initial, ...(entity === 'case-relationships' ? { name: '合成親友', relationship: '合成親屬' } : { practitionerName: '合成醫事人員', summary: '合成人工摘要' }), ...overrides };
}
function item(entity, overrides = {}) { return { ...editor(entity).buildPayload(values(entity)), id: 'synthetic-record', orgId, version: 1, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', ...overrides }; }

test('case support create adapters use explicit choices and dates and trim supplied text without inventing clinical conclusions', () => {
  for (const entity of Object.keys(CASE_SUPPORT_PROFILES)) {
    const form = editor(entity), payload = form.buildPayload(values(entity, { note: ' 合成人工備註\n第二行 ' }));
    assert.equal(payload.caseId, caseId); assert.equal(payload.date, '2026-10-10'); assert.equal(payload.note, '合成人工備註\n第二行');
    assert.deepEqual(Object.keys(payload).sort(), ['caseId', ...CASE_SUPPORT_PROFILES[entity].fields].sort());
    assert.equal(payload.status, 'active');
    assert.equal(form.confirm({ ...payload, id: 'saved', orgId, version: 1 }, payload).id, 'saved');
    assert.ok(!Object.hasOwn(payload, 'clinicalScore')); assert.ok(!Object.hasOwn(payload, 'diagnosis'));
  }
  assert.equal(editor('case-relationships').buildPayload(values('case-relationships')).support, 'unknown');
  assert.equal(editor('medical-opinions').buildPayload(values('medical-opinions')).followUpDate, '');
});

test('case support no-op edits omit every field and explicit edits send only their changes', () => {
  for (const entity of Object.keys(CASE_SUPPORT_PROFILES)) {
    const original = item(entity), form = editor(entity, original);
    assert.deepEqual(form.buildPayload(form.initial), {});
    const payload = form.buildPayload({ ...form.initial, note: ' 改寫合成備註 ' }); assert.deepEqual(payload, { note: '改寫合成備註' });
    const response = { ...original, ...payload, version: 2 }; assert.equal(form.confirm(response, payload), response);
    assert.deepEqual(original, item(entity), 'saved baseline stays untouched');
  }
});

test('typed, missing, unknown option and newline-unrepresentable saved values remain private until explicit replacement/clear', () => {
  for (const entity of Object.keys(CASE_SUPPORT_PROFILES)) {
    const original = item(entity, { note: ['SYNTHETIC-PRIVATE-RAW'], source: '保留\r\n原行', status: 'unknown', date: '0000-01-01' });
    delete original[entity === 'case-relationships' ? 'role' : 'profession'];
    const form = editor(entity, original); assert.deepEqual(form.buildPayload(form.initial), {});
    assert.equal(form.initial.note, ''); assert.equal(form.initial.noteIntent, 'keep'); assert.equal(form.enabled('note', form.initial), false);
    assert.ok(!JSON.stringify(form.fields).includes('SYNTHETIC-PRIVATE-RAW'));
    const note = form.buildPayload({ ...form.initial, noteIntent: 'replace', note: '新的人工紀錄' }); assert.deepEqual(note, { note: '新的人工紀錄' });
    const clear = form.buildPayload({ ...form.initial, noteIntent: 'clear' }); assert.deepEqual(clear, { note: '' });
    const status = form.buildPayload({ ...form.initial, statusIntent: 'replace', status: 'active' }); assert.deepEqual(status, { status: 'active' });
    assert.throws(() => form.buildPayload({ ...form.initial, statusIntent: 'clear' }), /有效處理方式/);
    assert.equal(form.confirm({ ...original, ...note, version: 2 }, note).source, original.source);
  }
});

test('unconfirmed scope, version, own-presence or saved field responses cannot announce success', () => {
  for (const entity of Object.keys(CASE_SUPPORT_PROFILES)) {
    const original = item(entity), form = editor(entity, original), payload = { note: '明確變更' }, confirmed = { ...original, ...payload, version: 2 };
    for (const patch of [{ id: 'other' }, { caseId: 'other' }, { orgId: 'other' }, { version: 1 }, { version: 3 }, { note: '未保存' }, { source: null }])
      assert.throws(() => form.confirm({ ...confirmed, ...patch }, payload), /確認/);
    const missing = { ...confirmed }; delete missing.source; assert.throws(() => form.confirm(missing, payload), /未確認/);
    for (const value of [null, [], {}, { ...confirmed, version: '2' }]) assert.throws(() => assertCaseSupportItem(value, { entity, caseId, orgId }), /確認/);
  }
});

test('form guards reject unknown controls, invalid dates, excessive text and invalid selections', () => {
  for (const entity of Object.keys(CASE_SUPPORT_PROFILES)) {
    const form = editor(entity), initial = values(entity);
    for (const patch of [{ note: '字'.repeat(10001) }, { source: '字'.repeat(501) }, { date: '2026-02-30' }, { status: 'deleted' }, { unknown: 'payload' }, { note: {} }])
      assert.throws(() => form.buildPayload({ ...initial, ...patch }));
    for (const field of CASE_SUPPORT_PROFILES[entity].required) assert.throws(() => form.buildPayload({ ...initial, [field]: '' }), field);
  }
  for (const value of ['2024-02-29', '0001-01-01', '9999-12-31']) assert.equal(validCaseSupportDate(value), true);
  for (const value of ['0000-01-01', '2026-02-29', '2026-13-01', '2026-1-01', '2026-10-10T00:00:00Z', null]) assert.equal(validCaseSupportDate(value), false);
});

test('list confirmation bounds, duplicates, status filter and parent scope reject misleading or partial responses', () => {
  for (const entity of Object.keys(CASE_SUPPORT_PROFILES)) {
    const record = item(entity), request = { entity, caseId, orgId, page: 1, pageSize: 25, status: 'active' };
    const response = { items: [record], total: 1, page: 1, pageSize: 25 }; assert.equal(confirmCaseSupportList(response, request), response);
    for (const patch of [{ total: '1' }, { total: -1 }, { page: 2 }, { pageSize: 100 }, { items: [] }, { total: 2, items: [record, record] }, { items: [{ ...record, caseId: 'other' }] }, { items: [{ ...record, status: 'inactive' }] }])
      assert.throws(() => confirmCaseSupportList({ ...response, ...patch }, request), /確認/);
    assert.equal(confirmCaseSupportList({ items: [], total: 1, page: 2, pageSize: 25 }, { ...request, page: 2 }).items.length, 0);
  }
});

test('medical textarea drafts and saved multiline summaries/recommendations preserve LF exactly and confirm each saved line', () => {
  const entity = 'medical-opinions', form = editor(entity);
  const draft = values(entity, { summary: ' 第一行\n第二行 ', recommendation: ' 建議甲\n建議乙 ' });
  const payload = form.buildPayload(draft);
  assert.equal(payload.summary, '第一行\n第二行'); assert.equal(payload.recommendation, '建議甲\n建議乙');
  const created = { ...payload, id: 'synthetic-multiline-record', orgId, version: 1 };
  assert.equal(form.confirm(created, payload), created);
  const editing = editor(entity, created);
  assert.equal(editing.initial.summary, payload.summary); assert.equal(editing.initial.recommendation, payload.recommendation);
  assert.ok(!Object.hasOwn(editing.initial, 'summaryIntent')); assert.ok(!Object.hasOwn(editing.initial, 'recommendationIntent'));
  assert.deepEqual(editing.buildPayload(editing.initial), {});
  const patch = editing.buildPayload({ ...editing.initial, recommendation: '建議甲\n建議乙\n第三行' });
  assert.deepEqual(patch, { recommendation: '建議甲\n建議乙\n第三行' });
  const updated = { ...created, ...patch, version: 2 }; assert.equal(editing.confirm(updated, patch), updated);
  assert.throws(() => editing.confirm({ ...updated, recommendation: '建議甲 建議乙 第三行' }, patch), /未確認/);
  for (const key of ['summary', 'recommendation']) {
    assert.throws(() => form.buildPayload({ ...draft, [key]: '第一行\r\n第二行' }));
    assert.throws(() => form.buildPayload({ ...draft, [key]: '字'.repeat(501) }));
  }
});

test('create acknowledgements and lists reject empty, whitespace-only and whitespace-padded record IDs', () => {
  for (const entity of Object.keys(CASE_SUPPORT_PROFILES)) {
    const form = editor(entity), payload = form.buildPayload(values(entity));
    const request = { entity, caseId, orgId, page: 1, pageSize: 25, status: 'active' };
    for (const id of ['', ' ', '\t\n', ' record', 'record ', 'record\n']) {
      const saved = { ...payload, id, orgId, version: 1 };
      assert.throws(() => form.confirm(saved, payload), /確認/, JSON.stringify(id));
      assert.throws(() => confirmCaseSupportList({ items: [saved], total: 1, page: 1, pageSize: 25 }, request), /確認/, JSON.stringify(id));
    }
    const saved = { ...payload, id: 'synthetic-trimmed-id', orgId, version: 1 };
    assert.equal(form.confirm(saved, payload), saved);
  }
});
