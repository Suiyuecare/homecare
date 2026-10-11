import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initDb, insert, replace, business, get, rows, fail } from '../src/server/model.mjs';
import { customFormEntities, validateCustomForm, customFormVisible, customFormHistoryVisible, customFormPrintModel, customFormQuery } from '../src/server/custom-forms.mjs';
import { assertFormDefinition, assertFormAnswers, isCustomFormNumber, isCustomFormDate, assertFormRecord } from '../public/data/custom-form-engine.js';
import { createCustomFormRecordEditor, confirmCustomFormSave, customFormFieldEditor } from '../public/data/custom-form-editor.js';

const field = (key, type = 'text', overrides = {}) => ({ key, label: `合成${key}`, type, groupId: '', required: false, options: [], visibleIf: null, ...overrides });
const schema = () => [field('hasIssue', 'boolean', { required: true }), field('detail', 'textarea', { required: true, visibleIf: { field: 'hasIssue', equals: true } }),
  field('reading', 'number'), field('observed', 'date'), field('category', 'select', { options: [{ value: 'a', label: '合成甲' }, { value: 'b', label: '合成乙' }] }),
  field('actions', 'multiselect', { options: [{ value: 'x', label: '合成處置甲' }, { value: 'y', label: '合成處置乙' }] }), field('summary')];
function fixture(t) {
  const db = new DatabaseSync(':memory:'); initDb(db); t.after(() => db.close());
  const orgId = randomUUID(), otherOrg = randomUUID(); for (const id of [orgId, otherOrg]) db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(id, '合成表單機構', '2026-10-10T00:00:00Z');
  const ctx = { orgId, role: 'supervisor', user: { id: randomUUID() } };
  const c = insert(db, orgId, 'cases', { name: '合成個案', caseNo: 'FORM-C', status: 'active' });
  const otherCase = insert(db, otherOrg, 'cases', { name: '合成外機構個案', caseNo: 'FORM-OTHER', status: 'active' });
  const create = (entity, payload) => { const data = { ...customFormEntities[entity].defaults, ...payload }; validateCustomForm(db, ctx, entity, data, null, fail, get, rows); return insert(db, orgId, entity, data); };
  const patch = (entity, item, payload) => { const data = { ...business(item), ...payload }; validateCustomForm(db, ctx, entity, data, item, fail, get, rows); return replace(db, orgId, entity, item, data); };
  const template = create('form-templates', { code: 'SYNTHETIC-FORM', name: '合成自訂紀錄', fields: schema() });
  const publish = item => patch('form-templates', item, { status: 'published' });
  const record = (parent, overrides = {}) => create('form-records', { caseId: c.id, templateId: parent.id, templateVersion: parent.version, date: '2026-10-10', ...overrides });
  const changes = () => db.prepare('SELECT total_changes() n').get().n;
  return { db, ctx, orgId, otherOrg, c, otherCase, create, patch, template, publish, record, changes };
}

test('all seven types use exact values; conditional required only applies to visible submitted fields', () => {
  const fields = schema(); const answers = { hasIssue: true, detail: '  合成長文\r\n尾端  ', reading: '-0001.250012', observed: '9999-12-31', category: 'b', actions: ['y', 'x'], summary: '合成' };
  assertFormAnswers([], fields, answers, { submitted: true }); assert.equal(answers.reading, '-0001.250012'); assert.equal(answers.detail, '  合成長文\r\n尾端  ');
  assertFormAnswers([], fields, {}, { submitted: false }); assertFormAnswers([], fields, { hasIssue: false }, { submitted: true });
  assert.throws(() => assertFormAnswers([], fields, { hasIssue: true }, { submitted: true }), /必填/);
  assert.throws(() => assertFormAnswers([], fields, { hasIssue: false, detail: '' }), /不能保存/);
  assert.throws(() => assertFormAnswers([], fields, { hasIssue: true, detail: '合成', unknown: { secret: 'synthetic' } }), /不能保存/);
  for (const value of [1, NaN, Infinity, '1e2', '.1', '1.', '1\n', '1.0000000000001', '1000000000000000']) assert.equal(isCustomFormNumber(value), false);
  for (const value of ['0', '0.10', '-0', '0001.00', '-999999999999999.999999999999']) assert.equal(isCustomFormNumber(value), true);
  for (const value of ['0000-01-01', '1900-02-29', '2026-10-10\n', '2026-02-30']) assert.equal(isCustomFormDate(value), false);
  for (const value of ['0001-01-01', '2000-02-29', '9999-12-31']) assert.equal(isCustomFormDate(value), true);
});
test('closed schemas/options/conditions reject getters, sparse arrays, unknown nested values and forward cycles without evaluation', () => {
  for (const suffix of ['\n', '\r', ' ']) { const fields = schema(); fields[0].key += suffix; assert.throws(() => assertFormDefinition([], fields)); assert.throws(() => assertFormDefinition([{ id: 'group' + suffix, label: '合成群組' }], schema())); }
  for (const mutate of [fields => { fields[0].extra = true; }, fields => { fields[1].visibleIf.eval = 'throw'; }, fields => { fields[1].visibleIf.field = 'summary'; }, fields => { fields[4].options[0].extra = 'secret'; }, fields => { fields[0].key = 'constructor'; }, fields => { fields[4].options.push({ ...fields[4].options[0] }); }]) {
    const fields = schema(); mutate(fields); assert.throws(() => assertFormDefinition([], fields));
  }
  let reads = 0; const fields = schema(); Object.defineProperty(fields[0], 'label', { get() { reads++; return 'unsafe'; }, enumerable: true }); assert.throws(() => assertFormDefinition([], fields)); assert.equal(reads, 0);
  const sparse = schema(); delete sparse[2]; assert.throws(() => assertFormDefinition([], sparse));
  const answers = {}; Object.defineProperty(answers, 'hasIssue', { get() { reads++; return true; }, enumerable: true }); assert.throws(() => assertFormAnswers([], schema(), answers)); assert.equal(reads, 0);
  assert.throws(() => assertFormAnswers([], schema(), { actions: ['x', 'x'] }));
  assert.throws(() => assertFormAnswers([], schema(), { category: 'x' }));
});
test('template revision and SQL version stay distinct, published content locks, new record preserves lineage', t => {
  const f = fixture(t), published = f.publish(f.template); assert.equal(published.revision, 1); assert.equal(published.version, 2);
  assert.throws(() => f.patch('form-templates', published, { name: '不可改寫' }), /鎖定/);
  const next = f.create('form-templates', { code: published.code, revision: 2, previousTemplateId: published.id, name: '合成新版', fields: schema() });
  assert.notEqual(next.id, published.id); assert.equal(next.version, 1);
  assert.throws(() => f.create('form-templates', { code: published.code, revision: 2, previousTemplateId: published.id, name: '重複', fields: schema() }), /修訂號/);
  assert.throws(() => f.patch('form-templates', next, { previousTemplateId: '' }), /不可更換/);
  assert.throws(() => f.create('form-templates', { code: 'OTHER', revision: 2, previousTemplateId: published.id, name: '不符', fields: schema() }), /新版/);
});
test('ordinary form draft saves, submits and remains immutable after template inactivation with frozen print/history', t => {
  const f = fixture(t), template = f.publish(f.template); let item = f.record(template, { answers: { hasIssue: false, reading: '0.10' }, note: '  合成備註\r\n尾端  ' });
  assert.equal(item.templateVersion, 2); assert.equal(item.templateSnapshot.revision, 1); assert.equal(item.templateSnapshot.version, 2); assertFormRecord(item, f.orgId);
  const first = structuredClone(item); item = f.patch('form-records', item, { status: 'submitted' });
  const frozen = structuredClone(item.templateSnapshot); f.patch('form-templates', template, { status: 'inactive' });
  assert.equal(customFormVisible(f.db, f.ctx, 'form-records', item, get), true);
  assert.equal(customFormHistoryVisible(f.db, f.ctx, 'form-records', first, item, get), true);
  const before = f.changes(), print = customFormPrintModel(f.db, f.ctx, item, get, fail);
  assert.equal(print.official, false); assert.equal(print.templateVersion, 2); assert.equal(print.fields.find(row => row.key === 'reading').answer, '0.10');
  assert.ok(!print.fields.some(row => row.key === 'detail')); assert.deepEqual(item.templateSnapshot, frozen); assert.equal(f.changes(), before);
  assert.throws(() => f.patch('form-records', item, { note: '不可改寫' }), /不可改寫/);
  assert.throws(() => f.record({ ...template, version: 3 }), /有效/);
});
test('roles and current same-org immutable parents are enforced before saves; rejected validation does not write', t => {
  const f = fixture(t), template = f.publish(f.template), item = f.record(template), before = f.changes();
  for (const role of ['finance', 'caregiver']) assert.throws(() => validateCustomForm(f.db, { ...f.ctx, role }, 'form-records', null, null, fail, get, rows), e => e.status === 403);
  assert.throws(() => f.patch('form-records', item, { caseId: f.otherCase.id }), /不可更換/);
  assert.throws(() => f.record(template, { caseId: f.otherCase.id }), /本機構/);
  assert.throws(() => f.record(template, { templateVersion: 1 }), /有效/);
  assert.throws(() => f.patch('form-records', item, { status: 'submitted', answers: { hasIssue: true } }), /必填/);
  assert.equal(f.changes(), before);
});
test('attachment references only use existing active same-case ids; old inactive reference remains readable, BLOB never copied', t => {
  const f = fixture(t), template = f.publish(f.template);
  const ownAttachment = insert(f.db, f.orgId, 'case-attachments', { caseId: f.c.id, title: '合成既有附件', status: 'active' });
  const wrong = insert(f.db, f.orgId, 'case-attachments', { caseId: f.otherCase.id, title: '錯誤個案附件', status: 'active' });
  const item = f.record(template, { answers: { hasIssue: false }, attachmentIds: [ownAttachment.id] });
  assert.throws(() => f.record(template, { attachmentIds: [wrong.id] }), /既有有效附件/);
  assert.throws(() => f.record(template, { attachmentIds: [ownAttachment.id, ownAttachment.id] }), /不重複/);
  const submitted = f.patch('form-records', item, { status: 'submitted' });
  replace(f.db, f.orgId, 'case-attachments', ownAttachment, { ...business(ownAttachment), status: 'inactive' });
  assert.equal(customFormVisible(f.db, f.ctx, 'form-records', submitted, get), true);
  assert.ok(!JSON.stringify(submitted).includes('fileId')); assert.equal(f.db.prepare('SELECT count(*) n FROM attachment_files').get().n, 0);
});
test('corrupt closed snapshots, mismatched template provenance and foreign history never become readable', t => {
  const f = fixture(t), template = f.publish(f.template), item = f.record(template), before = f.changes();
  for (const mutate of [row => { row.templateSnapshot.fields[0].secret = 'synthetic-secret'; }, row => { row.templateSnapshot.name = '假冒'; }, row => { row.templateVersion = 1; }, row => { row.orgId = f.otherOrg; }, row => { row.answers.unknown = 'secret'; }]) {
    const bad = structuredClone(item); mutate(bad); assert.equal(customFormVisible(f.db, f.ctx, 'form-records', bad, get), false);
    assert.equal(customFormHistoryVisible(f.db, f.ctx, 'form-records', bad, item, get), false);
  }
  const wrongIdentity = { ...item, id: randomUUID() }; assert.equal(customFormHistoryVisible(f.db, f.ctx, 'form-records', wrongIdentity, item, get), false);
  assert.equal(f.changes(), before);
});
test('query is closed, single-valued, strictly terminates dates/integers and is readonly', () => {
  for (const query of ['page=1%0A', 'pageSize=25%0D', 'date=2026-10-10%0A', 'q=a&q=b', 'secret=x', 'compare=x', 'page=9007199254740993', 'status=bogus']) assert.throws(() => customFormQuery('form-records', new URLSearchParams(query), fail));
  assert.throws(() => customFormQuery('form-templates', new URLSearchParams('caseId=x'), fail));
  assert.throws(() => customFormQuery('form-records', new URLSearchParams('date=2026-10-10'), fail, 'history'));
  assert.equal(customFormQuery('form-records', new URLSearchParams('page=2&pageSize=50&date=9999-12-31'), fail).page, 2);
});
test('fifty complete long answers and maximum bounded option definitions remain supported', () => {
  const fields = Array.from({ length: 50 }, (_, i) => field('question' + i, 'textarea', { required: true }));
  const answers = Object.fromEntries(fields.map(item => [item.key, '合'.repeat(10000)]));
  assert.ok(JSON.stringify(answers).length > 500000); assertFormAnswers([], fields, answers, { submitted: true });
  const options = Array.from({ length: 50 }, (_, i) => ({ value: 'v' + i + 'a'.repeat(95), label: '合'.repeat(200) }));
  assertFormDefinition([], Array.from({ length: 50 }, (_, i) => field('choice' + i, 'select', { options: structuredClone(options) })));
});
test('ordinary editor preserves CRLF/decimal text and keeps hidden saved answers until explicit confirmation', t => {
  const f = fixture(t), template = f.publish(f.template), item = f.record(template, { answers: { hasIssue: true, detail: '  合成\r\n尾端  ', reading: '0.10' }, note: '  合成\r\n備註  ' });
  const editor = createCustomFormRecordEditor({ template, existing: item, caseId: item.caseId });
  assert.deepEqual(editor.buildPayload(editor.initial), {});
  const next = { ...editor.initial, answer_hasIssue: 'false' };
  assert.deepEqual(editor.conditionalChange(editor.initial, next), ['detail']); assert.throws(() => editor.buildPayload(next), /清除/);
  assert.deepEqual(editor.buildPayload(editor.initial), {}); assert.equal(item.answers.detail, '  合成\r\n尾端  ');
  editor.confirmClear(['detail']); next.answer_detail = editor.clearValue('detail');
  const payload = editor.buildPayload(next); assert.deepEqual(payload.answers, { hasIssue: false, reading: '0.10' }); assert.ok(!Object.hasOwn(payload, 'note'));
});
test('record editor does not infer optional false values and confirms only exact closed acknowledgements', t => {
  const f = fixture(t), template = f.publish(f.template), editor = createCustomFormRecordEditor({ template, caseId: f.c.id, date: '2026-10-10' });
  const payload = editor.buildPayload(editor.initial); assert.deepEqual(payload.answers, {});
  const item = f.create('form-records', payload); assert.equal(confirmCustomFormSave({ item }, { entity: 'form-records', orgId: f.orgId, payload, snapshot: editor.snapshot }).id, item.id);
  assert.throws(() => confirmCustomFormSave({ item: { ...item, templateSnapshot: { ...item.templateSnapshot, name: '假冒' } } }, { entity: 'form-records', orgId: f.orgId, payload, snapshot: editor.snapshot }));
  let reads = 0; const result = {}; Object.defineProperty(result, 'item', { enumerable: true, get() { reads++; return item; } });
  assert.throws(() => confirmCustomFormSave(result, { entity: 'form-records', orgId: f.orgId, payload })); assert.equal(reads, 0);
  const values = { ...editor.initial }; Object.defineProperty(values, 'note', { enumerable: true, get() { reads++; return 'unsafe'; } }); assert.throws(() => editor.buildPayload(values)); assert.equal(reads, 0);
});
test('question builder uses ordinary controls and selectable boolean conditions instead of JSON', t => {
  const f = fixture(t), editor = customFormFieldEditor(f.template, f.template.fields[1], 1);
  const next = editor.build({ ...editor.initial, conditionChoice: 'false' }); assert.deepEqual(next[1].visibleIf, { field: 'hasIssue', equals: false });
  assert.throws(() => editor.build({ ...editor.initial, conditionChoice: 'bad' }));
  const choices = customFormFieldEditor(f.template, f.template.fields[4], 4).build({ ...customFormFieldEditor(f.template, f.template.fields[4], 4).initial, options: 'yes｜合成同意\nno｜合成拒絕' });
  assert.deepEqual(choices[4].options, [{ value: 'yes', label: '合成同意' }, { value: 'no', label: '合成拒絕' }]);
});
test('ordinary checkbox presentation preserves untouched stored option/attachment order', t => {
  const f = fixture(t), template = f.publish(f.template), a = insert(f.db, f.orgId, 'case-attachments', { caseId: f.c.id, title: '合成甲', status: 'active' }), b = insert(f.db, f.orgId, 'case-attachments', { caseId: f.c.id, title: '合成乙', status: 'active' });
  const item = f.record(template, { answers: { actions: ['y', 'x'] }, attachmentIds: [b.id, a.id] }), editor = createCustomFormRecordEditor({ template, existing: item, caseId: item.caseId, attachments: [a, b] });
  assert.deepEqual(editor.initial.answer_actions, ['x', 'y']); assert.deepEqual(editor.initial.attachmentIds, [a.id, b.id]); assert.deepEqual(editor.buildPayload(editor.initial), {});
  const payload = editor.buildPayload({ ...editor.initial, note: '合成僅改備註' }); assert.deepEqual(payload, { note: '合成僅改備註' });
});
