import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeAssessmentAnswer, normalizeAssessmentAnswers, compareAssessmentAnswers } from '../public/data/assessment-answers.js';
import { getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
};
const templateA = freeze({ id: 'synthetic-a', name: '合成模板甲', fields: [
  { name: 'q002', label: '同名題目', type: 'date' },
  { name: 'q001', label: '同名題目', type: 'text' },
  { name: 'q003', label: '第三題', type: 'textarea' },
  { name: 'q004', label: '第四題', type: 'time' },
] });
const templateB = freeze({ id: 'synthetic-b', name: '合成模板乙', fields: [
  { name: 'q001', label: '完全不同的題目', type: 'text' },
] });
const templates = new Map([[templateA.id, templateA], [templateB.id, templateB]]);
const saved = (answers = {}, extra = {}) => ({ caseId: 'synthetic-case', templateId: templateA.id,
  date: '2026-10-08', answers, status: 'draft', ...extra });
const first = projection => projection.questions.find(question => question.key === 'q001').answer;

test('assessment history has exactly five saved fields and never projects internal metadata', () => {
  const record = freeze(saved({ q001: '合成文字', unknownSecret: 'must-not-leak' }, {
    id: 'assessment-a', orgId: 'org-a', version: 2, actor: { name: 'private-actor' },
    billingSnapshot: { fee: 999 }, fileId: 'private-file', riskScore: 99,
  }));
  const keys = ['caseId', 'templateId', 'date', 'answers', 'status'];
  assert.deepEqual(getHistoryFields('assessments').map(field => field.key), keys);
  const result = normalizeHistorySnapshot('assessments', record, templates);
  assert.deepEqual(Object.keys(result), keys);
  assert.equal(first(result.answers).value, '合成文字');
  assert.equal(result.answers.hasUnknownKeys, true);
  for (const secret of ['must-not-leak', 'unknownSecret', 'billingSnapshot', 'fileId', 'riskScore', 'private-actor']) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(diffHistorySnapshots('assessments', record, { ...record, id: 'other', version: 3,
    riskScore: 20, billingSnapshot: { fee: 1 } }, templates), []);
});

test('all 16 current templates retain 359 ordered known question IDs and the original catalog bytes', () => {
  const bytes = readFileSync(new URL('../public/data/assessment-templates.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'be564dc73b1c8a2a9932d362f2a56f22a37f6d30e68604a533176718cecaaab9');
  const catalog = freeze(JSON.parse(bytes));
  assert.equal(catalog.length, 16);
  assert.equal(catalog.reduce((count, template) => count + template.fields.length, 0), 359);
  const map = new Map(catalog.map(template => [template.id, template]));
  for (const template of catalog) {
    const answers = Object.fromEntries(template.fields.map((field, index) => [field.name, `保存 ${index}`]));
    const snapshot = freeze(saved({ ...answers, unknownKey: 'secret' }, { templateId: template.id }));
    const projection = normalizeAssessmentAnswers(snapshot, map);
    assert.equal(new Set(template.fields.map(field => field.name)).size, template.fields.length);
    assert.deepEqual(projection.questions.map(({ key, label }) => ({ key, label })),
      template.fields.map(({ name, label }) => ({ key: name, label })));
    assert.equal(projection.hasUnknownKeys, true);
    assert.equal(JSON.stringify(projection).includes('secret'), false);
  }
});

test('own question keys distinguish missing, null, empty text, zero, booleans and literal marker strings', () => {
  const variants = [
    { kind: 'missing' }, { kind: 'null' }, { kind: 'empty-string' },
    { kind: 'string', value: '0' }, { kind: 'number', value: 0 },
    { kind: 'string', value: 'false' }, { kind: 'boolean', value: false },
    { kind: 'boolean', value: true }, { kind: 'string', value: 'null' },
    { kind: 'string', value: '[欄位格式無法判讀]' },
    { kind: 'string', value: '未保存此題' }, { kind: 'string', value: '保存空字串（文字）' },
  ];
  const originals = [undefined, null, '', '0', 0, 'false', false, true, 'null', '[欄位格式無法判讀]', '未保存此題', '保存空字串（文字）'];
  for (let index = 0; index < variants.length; index++) {
    const answers = index ? { q001: originals[index] } : {};
    assert.deepEqual(first(normalizeAssessmentAnswers(saved(answers), templates)), variants[index]);
    for (let next = index + 1; next < variants.length; next++) {
      const comparison = compareAssessmentAnswers(saved(answers), saved({ q001: originals[next] }), templates);
      assert.equal(comparison.canCompareQuestions, true);
      assert.deepEqual(comparison.changes, [{ key: 'q001', label: '同名題目', before: variants[index], after: variants[next] }]);
    }
  }
  const inherited = Object.create({ q001: 'inherited-secret', inheritedKey: 'other-secret' });
  inherited.q002 = 'own answer';
  const result = normalizeAssessmentAnswers(saved(inherited), templates);
  assert.deepEqual(first(result), { kind: 'missing' });
  assert.equal(result.hasUnknownKeys, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('plain answer text retains whitespace, newlines, HTML-looking strings and unparsed date/time text', () => {
  const values = freeze({ q001: '  第一行\n第二行  ', q002: 'not-a-date',
    q003: '<img src=x onerror="must-stay-text()">', q004: '29:99+08:00' });
  const result = normalizeAssessmentAnswers(saved(values), templates);
  for (const { key, answer } of result.questions) assert.deepEqual(answer, { kind: 'string', value: values[key] });
  assert.equal(compareAssessmentAnswers(saved(values), saved({ ...values, q001: values.q001.trim() }), templates).changes.length, 1);
});

test('array, object, non-finite and unsupported answer tags retain no source data and do not collide with text', () => {
  const sources = [[], ['nested-secret'], {}, { nested: { private: 'nested-secret' } }, NaN, Infinity, -Infinity, undefined, 2n, Symbol('nested-secret'), () => 'nested-secret'];
  const expected = ['array', 'array', 'object', 'object', 'non-finite-number', 'non-finite-number', 'non-finite-number', 'unsupported', 'unsupported', 'unsupported', 'unsupported'];
  sources.forEach((value, index) => {
    const answer = normalizeAssessmentAnswer(value);
    assert.deepEqual(answer, { kind: expected[index] });
    assert.equal(JSON.stringify(answer).includes('nested-secret'), false);
    const comparison = compareAssessmentAnswers(saved({ q001: value }), saved({ q001: expected[index] }), templates);
    assert.equal(comparison.changes.length, 1);
    assert.equal(comparison.limited, true);
    assert.deepEqual(comparison.changes[0].after, { kind: 'string', value: expected[index] });
  });
});

test('hidden nested or unknown changes are not fabricated differences and always mark comparison limited', () => {
  const previous = freeze(saved({ q001: ['private-one'], q002: { keyOne: 'private-two' }, hiddenOne: 'private-three' }));
  const current = freeze(saved({ q001: ['different-private-one'], q002: { keyTwo: 'different-private-two' }, hiddenTwo: 'private-four' }));
  const result = compareAssessmentAnswers(previous, current, templates);
  assert.deepEqual(result.changes, []);
  assert.equal(result.limited, true);
  assert.deepEqual(diffHistorySnapshots('assessments', previous, current, templates), []);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('hiddenOne'), false);
  const unknownOnly = compareAssessmentAnswers(saved({ hiddenKey: 'one' }), saved({ hiddenKey: 'two' }), templates);
  assert.deepEqual(unknownOnly.changes, []);
  assert.equal(unknownOnly.limited, true);
  const unknownAdded = compareAssessmentAnswers(saved({}), saved({ hiddenKey: 'new' }), templates);
  assert.equal(unknownAdded.containerChanged, false);
  assert.deepEqual(unknownAdded.changes, []);
  assert.equal(unknownAdded.limited, true);
  assert.deepEqual(diffHistorySnapshots('assessments', saved({}), saved({ hiddenKey: 'new' }), templates), []);
  const changedType = compareAssessmentAnswers(previous, saved({ q001: { private: 'secret' } }), templates);
  assert.deepEqual(changedType.changes.find(item => item.key === 'q001'),
    { key: 'q001', label: '同名題目', before: { kind: 'array' }, after: { kind: 'object' } });
});

test('unknown templates never inspect answer content or fall back to a known template', () => {
  const unknown = { templateId: 'unapproved-template' };
  Object.defineProperty(unknown, 'answers', { enumerable: true, get() { throw new Error('must not inspect unknown template answers'); } });
  const projection = normalizeAssessmentAnswers(unknown, templates);
  assert.deepEqual(projection, { templateState: 'unknown', container: 'unavailable', questions: [], hasUnknownKeys: false, hasUnsupportedValues: false });
  for (const templateId of ['unknown', '__proto__', null, '', ['synthetic-a'], { id: 'synthetic-a' }]) {
    assert.equal(normalizeAssessmentAnswers(saved({ q001: 'never render' }, { templateId }), templates).templateState, 'unknown');
  }
  const compared = compareAssessmentAnswers(unknown, unknown, templates);
  assert.equal(compared.mode, 'unavailable');
  assert.equal(compared.limited, true);
  assert.deepEqual(compared.changes, []);
});

test('answer containers have separate safe states and no scalar or array content is retained', () => {
  const noAnswers = saved(); delete noAnswers.answers;
  const records = [noAnswers, saved(null), saved({}), saved({ q001: 'known' }), saved(['private']),
    saved('private'), saved(321), saved(false), { ...saved(), answers: undefined }];
  const kinds = ['missing', 'null', 'empty-object', 'object', 'array', 'string', 'number', 'boolean', 'unsupported'];
  records.forEach((record, index) => {
    const result = normalizeAssessmentAnswers(record, templates);
    assert.equal(result.container, kinds[index]);
    if (index !== 2 && index !== 3) assert.deepEqual(result.questions, []);
    assert.equal(JSON.stringify(result).includes('private'), false);
    for (let next = index + 1; next < records.length; next++) {
      const comparison = compareAssessmentAnswers(record, records[next], templates);
      assert.equal(comparison.containerChanged, !(index === 2 && next === 3));
      if (index !== 2 || next !== 3) assert.equal(comparison.limited, true);
    }
  });
  const scalarInnerChange = compareAssessmentAnswers(saved('old secret'), saved('new secret'), templates);
  assert.equal(scalarInnerChange.containerChanged, false);
  assert.equal(scalarInnerChange.limited, true);
  assert.deepEqual(scalarInnerChange.changes, []);
});

test('same-template comparisons preserve catalog order, distinguish duplicate labels and show only changed known questions', () => {
  const previous = freeze(saved({ q001: 'same', q002: 0, q003: false, q004: 'same time', secret: 'old' }));
  const current = freeze(saved({ q001: 'changed', q002: '0', q003: false, q004: 'same time', secret: 'new' }));
  const result = compareAssessmentAnswers(previous, current, templates);
  assert.equal(result.mode, 'same-template');
  assert.deepEqual(result.changes.map(item => item.key), ['q002', 'q001']);
  assert.deepEqual(result.changes.map(item => item.label), ['同名題目', '同名題目']);
  assert.deepEqual(diffHistorySnapshots('assessments', previous, current, templates).map(field => field.key), ['answers']);
  const metadataChange = diffHistorySnapshots('assessments', previous, { ...current, caseId: 'case-b', date: '2026-10-09', status: 'submitted' }, templates);
  assert.deepEqual(metadataChange.map(field => field.key), ['caseId', 'date', 'answers', 'status']);
});

test('changed templates separate each own question projection and never pair repeated q001 across templates', () => {
  const previous = freeze(saved({ q001: '甲保存文字', q002: '甲另一題' }));
  const current = freeze(saved({ q001: '乙保存文字', q002: 'secret-unknown-in-B' }, { templateId: templateB.id }));
  const result = compareAssessmentAnswers(previous, current, templates);
  assert.equal(result.mode, 'template-changed');
  assert.equal(result.canCompareQuestions, false);
  assert.deepEqual(result.changes, []);
  assert.equal(first(result.before).value, '甲保存文字');
  assert.equal(first(result.after).value, '乙保存文字');
  assert.equal(result.before.questions.find(item => item.key === 'q001').label, '同名題目');
  assert.equal(result.after.questions[0].label, '完全不同的題目');
  assert.deepEqual(result.after.questions.map(item => item.key), ['q001']);
  assert.equal(JSON.stringify(result).includes('secret-unknown-in-B'), false);
  const unknown = compareAssessmentAnswers(previous, saved({ q001: 'secret' }, { templateId: 'unknown' }), templates);
  assert.equal(unknown.mode, 'template-changed');
  assert.equal(unknown.after.templateState, 'unknown');
  assert.equal(JSON.stringify(unknown).includes('secret'), false);
});

test('normalizers and comparisons do not mutate frozen sources or retain mutable source containers', () => {
  const previous = freeze(saved({ q001: 'before', q002: { secret: ['nested'] }, q003: false }));
  const current = freeze(saved({ q001: 'after', q002: ['nested'], q003: true }));
  const initial = JSON.stringify([previous, current, templateA, templateB]);
  const result = compareAssessmentAnswers(previous, current, templates);
  result.before.questions[0].answer.kind = 'changed-local';
  result.after.questions.push({ key: 'local-only' });
  result.changes[0].label = 'local-only';
  assert.equal(JSON.stringify([previous, current, templateA, templateB]), initial);
  assert.deepEqual(first(normalizeAssessmentAnswers(previous, templates)), { kind: 'string', value: 'before' });
});

test('finite numeric answers preserve numbers without rounding, parsing strings or treating signed zero alike', () => {
  for (const value of [0, -0, 0.000001, -19.25, Number.MAX_VALUE, Number.MIN_VALUE]) {
    const answer = normalizeAssessmentAnswer(value);
    assert.equal(answer.kind, 'number');
    assert.equal(Object.is(answer.value, value), true);
    assert.equal(compareAssessmentAnswers(saved({ q001: value }), saved({ q001: String(value) }), templates).changes.length, 1);
  }
  const signedZero = compareAssessmentAnswers(saved({ q001: -0 }), saved({ q001: 0 }), templates);
  assert.equal(signedZero.changes.length, 1);
  assert.equal(Object.is(signedZero.changes[0].before.value, -0), true);
});

test('current catalog labels are used and optional template context leaves existing history behavior unchanged', () => {
  const renamedMap = new Map([[templateA.id, { ...templateA, name: '目前模板名稱', fields: templateA.fields.map(field => ({ ...field, label: `目前${field.label}` })) }]]);
  const record = saved({ q001: '保存文字' }, { templateName: 'do-not-use-saved-name', questionLabels: { q001: 'do-not-use-saved-label' } });
  const result = normalizeAssessmentAnswers(record, renamedMap);
  assert.equal(result.questions.find(item => item.key === 'q001').label, '目前同名題目');
  assert.equal(JSON.stringify(result).includes('do-not-use'), false);
  for (const entity of ['cases', 'employees', 'service-items', 'leave-requests', 'service-records']) {
    const before = { name: '', note: '', phone: ['bad'], regions: ['臺北', ''], services: [{ serviceItemId: 'x', quantity: 1 }] };
    const after = { ...before, note: 'new' };
    assert.deepEqual(normalizeHistorySnapshot(entity, before, templates), normalizeHistorySnapshot(entity, before));
    assert.deepEqual(diffHistorySnapshots(entity, before, after, templates), diffHistorySnapshots(entity, before, after));
  }
});
