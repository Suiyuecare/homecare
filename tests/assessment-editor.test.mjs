import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createAssessmentEditor } from '../public/data/assessment-editor.js';

const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
};
const template = freeze({ id: 'synthetic-template', name: '合成模板', fields: [
  { name: 'q001', label: '文字題', type: 'text' }, { name: 'q002', label: '日期題', type: 'date' },
  { name: 'q003', label: '多行題', type: 'textarea' }, { name: 'q004', label: '時間題', type: 'time' },
] });
const row = (answers, extra = {}) => ({ id: 'record-a', version: 7, caseId: 'case-a', templateId: template.id,
  date: '2026-10-08', status: 'draft', answers, ...extra });
const values = (editor, changes = {}) => ({ ...editor.initial, ...changes });
const payload = answers => ({ caseId: 'case-a', templateId: template.id, date: '2026-10-08', status: 'draft', answers });
const rejectsField = (fn, field) => assert.throws(fn, error => error instanceof Error
  && Object.hasOwn(error.fields, field) && typeof error.fields[field] === 'string');

test('metadata always comes from row fields and fixed template while answer collisions are preserved solely inside answers', () => {
  const original = freeze(row({ caseId: 'hidden-case', date: '0001-01-01', status: 'submitted', templateId: 'hidden-template',
    q001: '原答案', version: 'hidden-version', id: 'hidden-id', answerIntent_q001: 'clear' }));
  const editor = createAssessmentEditor(template, original, '2030-01-01');
  assert.equal(editor.editing, true);
  assert.equal(editor.hasPreservedAnswers, true);
  assert.deepEqual(editor.initial, { caseId: 'case-a', date: '2026-10-08', status: 'draft', q001: '原答案', q002: '', q003: '', q004: '' });
  assert.deepEqual(editor.buildPayload(values(editor, { status: 'submitted' })),
    { caseId: 'case-a', templateId: template.id, date: '2026-10-08', status: 'submitted' });
  const changed = editor.buildPayload(values(editor, { q001: '更新答案' }));
  assert.deepEqual(changed.answers, { ...original.answers, q001: '更新答案' });
  assert.equal(changed.templateId, template.id);
  assert.equal(Object.hasOwn(changed, 'version'), false);
  assert.equal(Object.hasOwn(changed, 'id'), false);
});

test('metadata-only edits preserve all JSON answer types and require explicit intent without exposing protected values', () => {
  const original = freeze(row({ q001: 0, q002: false, q003: { private: ['nested-private'] }, q004: null,
    hidden: { another: ['private-unknown'] } }));
  const editor = createAssessmentEditor(template, original, '2026-10-08');
  assert.equal(editor.answersEditable, true);
  assert.equal(editor.hasPreservedAnswers, true);
  assert.deepEqual(editor.questions.map(question => [question.name, question.initialValue, question.requiresIntent,
    question.intentName, question.savedKind]), [
    ['q001', '', true, 'answerIntent_q001', 'number'], ['q002', '', true, 'answerIntent_q002', 'boolean'],
    ['q003', '', true, 'answerIntent_q003', 'object'], ['q004', '', true, 'answerIntent_q004', 'null'],
  ]);
  assert.equal(JSON.stringify({ initial: editor.initial, questions: editor.questions }).includes('private'), false);
  const result = editor.buildPayload(values(editor, { caseId: 'case-b', date: '2026-10-09', status: 'submitted' }));
  assert.deepEqual(result, { caseId: 'case-b', templateId: template.id, date: '2026-10-09', status: 'submitted' });
  assert.deepEqual(original.answers.q003, { private: ['nested-private'] });
});

test('missing, null and empty strings remain distinct when another answer changes', () => {
  const original = freeze(row({ q002: null, q003: '', q004: '' }));
  const editor = createAssessmentEditor(template, original, '2026-10-08');
  assert.equal(editor.questions[0].requiresIntent, false);
  assert.equal(editor.questions[1].requiresIntent, true);
  assert.equal(editor.questions[2].requiresIntent, false);
  assert.equal(Object.hasOwn(editor.buildPayload(editor.initial), 'answers'), false);
  const changed = editor.buildPayload(values(editor, { q003: '本次更動' }));
  assert.equal(Object.hasOwn(changed.answers, 'q001'), false);
  assert.equal(changed.answers.q002, null);
  assert.equal(changed.answers.q004, '');
  assert.equal(changed.answers.q003, '本次更動');
  const added = editor.buildPayload(values(editor, { q001: '新保存' }));
  assert.equal(added.answers.q001, '新保存');
  assert.equal(Object.hasOwn(editor.buildPayload(values(editor, { q001: '' })), 'answers'), false);
});

test('keep, replace and clear express distinct intentions and preserve unsaved input when keep is selected again', () => {
  const original = freeze(row({ q001: false, q002: { unknownDate: 'private' }, q003: ['private-array'], q004: 9 }));
  const editor = createAssessmentEditor(template, original, '2026-10-08');
  assert.equal(Object.hasOwn(editor.buildPayload(values(editor, { q001: '待取代文字' })), 'answers'), false);
  const replaced = editor.buildPayload(values(editor, { answerIntent_q001: 'replace', q001: 'false' }));
  assert.equal(replaced.answers.q001, 'false');
  assert.equal(typeof replaced.answers.q001, 'string');
  assert.deepEqual(replaced.answers.q003, ['private-array']);
  const cleared = editor.buildPayload(values(editor, { answerIntent_q001: 'clear', q001: '尚未送出的其他輸入' }));
  assert.equal(cleared.answers.q001, '');
  assert.equal(Object.hasOwn(cleared.answers, 'q001'), true);
  assert.equal(Object.hasOwn(editor.buildPayload(values(editor, { answerIntent_q001: 'keep', q001: '尚未送出的其他輸入' })), 'answers'), false);
  const emptyReplacement = editor.buildPayload(values(editor, { answerIntent_q001: 'replace', q001: '' }));
  assert.equal(emptyReplacement.answers.q001, '');
  assert.equal(Object.keys(replaced).some(key => key.startsWith('answerIntent_')), false);
  assert.equal(Object.keys(replaced.answers).some(key => key.startsWith('answerIntent_')), false);
});

test('ordinary final-value comparisons preserve unmodified text and allow clearing without trimming or touching other keys', () => {
  const original = freeze(row({ q001: '  原文字  ', q002: '2026-10-08', q003: '第一行\n第二行', q004: '23:59', hidden: [0, false, null] }));
  const editor = createAssessmentEditor(template, original, '2026-10-08');
  assert.equal(editor.questions.some(question => question.requiresIntent), false);
  assert.equal(Object.hasOwn(editor.buildPayload(values(editor, { q001: '  原文字  ' })), 'answers'), false);
  const changed = editor.buildPayload(values(editor, { q001: '', q003: '  第一行\n第二行  ' }));
  assert.deepEqual(changed.answers, { ...original.answers, q001: '', q003: '  第一行\n第二行  ' });
  const changedBack = editor.buildPayload(values(editor, { q001: original.answers.q001 }));
  assert.equal(Object.hasOwn(changedBack, 'answers'), false);
});

test('native-sanitized newlines and incompatible saved number, boolean, date and time values are not prefilled', () => {
  const samples = [
    [{ q001: 'line\nbreak', q002: '2026-02-30', q003: 'line\r\nbreak', q004: '12:34:56' }, ['string', 'string', 'string', 'string']],
    [{ q001: 'line\rbreak', q002: '0000-01-01', q003: false, q004: '24:00' }, ['string', 'string', 'boolean', 'string']],
    [{ q001: 42, q002: '2026-1-01', q003: ['x'], q004: ' 12:30 ' }, ['number', 'string', 'array', 'string']],
  ];
  for (const [answers, kinds] of samples) {
    const editor = createAssessmentEditor(template, freeze(row(answers)), '2026-10-08');
    assert.deepEqual(editor.questions.map(question => question.savedKind), kinds);
    assert.equal(editor.questions.every(question => question.requiresIntent && question.initialValue === ''), true);
    assert.equal(Object.hasOwn(editor.buildPayload(editor.initial), 'answers'), false);
  }
  const editor = createAssessmentEditor(template, row({ q001: 'simple', q003: 'line\nbreak' }), '2026-10-08');
  assert.equal(editor.questions[0].initialValue, 'simple');
  assert.equal(editor.questions[2].initialValue, 'line\nbreak');
});

test('date and time compatibility uses real Gregorian 0001–9999 dates and exact minute text without timezone conversion', () => {
  for (const date of ['', '0001-01-01', '0004-02-29', '0400-02-29', '2000-02-29', '2024-02-29', '9999-12-31']) {
    const editor = createAssessmentEditor(template, row({ q002: date, q004: '00:00' }), '2026-10-08');
    assert.equal(editor.questions[1].requiresIntent, false, date);
    assert.equal(editor.questions[1].initialValue, date);
  }
  for (const date of ['0000-01-01', '0100-02-29', '1900-02-29', '2026-02-29', '2026-04-31', '2026-00-01', '2026-01-00', '10000-01-01', '2026-10-08T00:00:00Z', ' 2026-10-08']) {
    const editor = createAssessmentEditor(template, row({ q002: date }), '2026-10-08');
    assert.equal(editor.questions[1].requiresIntent, true, date);
    rejectsField(() => editor.buildPayload(values(editor, { answerIntent_q002: 'replace', q002: date })), 'q002');
  }
  for (const time of ['', '00:00', '09:07', '23:59']) {
    assert.equal(createAssessmentEditor(template, row({ q004: time }), '2026-10-08').questions[3].requiresIntent, false);
  }
  for (const time of ['24:00', '23:60', '9:07', '09:7', '09:07:00', '09:07Z', ' 09:07']) {
    const editor = createAssessmentEditor(template, row({ q004: time }), '2026-10-08');
    assert.equal(editor.questions[3].requiresIntent, true);
    rejectsField(() => editor.buildPayload(values(editor, { answerIntent_q004: 'replace', q004: time })), 'q004');
  }
});

test('all 16 unchanged templates create every known string field while preserving their original 359-question catalog', () => {
  const bytes = readFileSync(new URL('../public/data/assessment-templates.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'be564dc73b1c8a2a9932d362f2a56f22a37f6d30e68604a533176718cecaaab9');
  const catalog = freeze(JSON.parse(bytes));
  assert.equal(catalog.length, 16);
  assert.equal(catalog.reduce((n, item) => n + item.fields.length, 0), 359);
  for (const item of catalog) {
    const editor = createAssessmentEditor(item, undefined, '2026-10-08');
    assert.equal(editor.editing, false);
    assert.equal(editor.answersEditable, true);
    assert.equal(editor.hasPreservedAnswers, false);
    assert.deepEqual(editor.questions.map(question => question.name), item.fields.map(field => field.name));
    const result = editor.buildPayload(values(editor, { caseId: 'case-a' }));
    assert.deepEqual(Object.keys(result.answers), item.fields.map(field => field.name));
    assert.equal(Object.values(result.answers).every(value => value === ''), true);
    assert.equal(result.templateId, item.id);
    assert.equal(result.status, 'draft');
  }
});

test('special own JSON keys and nested key order survive one known-answer replacement without prototype mutation', () => {
  const answers = JSON.parse('{"__proto__":{"nested":"private"},"constructor":{"prototype":[0,false,null]},"prototype":"saved","q001":"old","deep":{"z":1,"a":[{"__proto__":"inner"}]}}');
  const original = freeze(row(answers));
  const text = JSON.stringify(original);
  const editor = createAssessmentEditor(template, original, '2026-10-08');
  const result = editor.buildPayload(values(editor, { q001: 'new' }));
  assert.equal(Object.getPrototypeOf(result.answers), Object.prototype);
  assert.equal(Object.hasOwn(result.answers, '__proto__'), true);
  assert.deepEqual(result.answers.__proto__, { nested: 'private' });
  assert.deepEqual(result.answers.constructor, { prototype: [0, false, null] });
  assert.equal(result.answers.prototype, 'saved');
  assert.deepEqual(Object.keys(result.answers), Object.keys(answers));
  assert.deepEqual(Object.keys(result.answers.deep), ['z', 'a']);
  assert.notEqual(result.answers.deep, answers.deep);
  assert.notEqual(result.answers.deep.a, answers.deep.a);
  assert.equal(JSON.stringify(original), text);
  assert.equal({}.nested, undefined);
});

test('missing and malformed imported answer roots permit only metadata edits without inventing an object', () => {
  const missing = row({}); delete missing.answers;
  for (const original of [missing, row(null), row([]), row('private-root'), row(0), row(false)]) {
    const editor = createAssessmentEditor(template, freeze(original), '2026-10-08');
    assert.equal(editor.answersEditable, false);
    assert.equal(editor.hasPreservedAnswers, true);
    assert.equal(editor.questions.every(question => question.initialValue === '' && !question.requiresIntent), true);
    assert.deepEqual(editor.buildPayload(values(editor, { status: 'submitted' })),
      { caseId: 'case-a', templateId: template.id, date: '2026-10-08', status: 'submitted' });
    rejectsField(() => editor.buildPayload(values(editor, { q001: 'replace whole root' })), 'q001');
    assert.equal(JSON.stringify(editor.initial).includes('private-root'), false);
  }
});

test('unknown form keys, forged metadata, invalid intents and incompatible replacements fail with field errors', () => {
  const editor = createAssessmentEditor(template, row({ q001: 0, q002: 'bad-date' }), '2026-10-08');
  for (const key of ['unknown', 'q999', 'answerIntent_q999', 'templateId', 'version', 'id', '__proto__', 'constructor', 'prototype']) {
    const input = Object.fromEntries([...Object.entries(editor.initial), [key, 'injection']]);
    rejectsField(() => editor.buildPayload(input), key);
  }
  for (const intent of ['', 'KEEP', 'delete', false, null, ['keep'], {}]) {
    rejectsField(() => editor.buildPayload(values(editor, { answerIntent_q001: intent })), 'answerIntent_q001');
  }
  for (const replacement of [0, false, null, [], {}, undefined, NaN, Infinity, 'line\nbreak']) {
    rejectsField(() => editor.buildPayload(values(editor, { answerIntent_q001: 'replace', q001: replacement })), 'q001');
  }
  rejectsField(() => editor.buildPayload(values(editor, { caseId: '' })), 'caseId');
  rejectsField(() => editor.buildPayload(values(editor, { date: '2026-02-30' })), 'date');
  rejectsField(() => editor.buildPayload(values(editor, { status: ['draft'] })), 'status');
  rejectsField(() => editor.buildPayload(null), 'answers');
  const creating = createAssessmentEditor(template, null, '2026-10-08');
  rejectsField(() => creating.buildPayload(values(creating, { caseId: 'case-a', q999: 'new-unknown' })), 'q999');
});

test('frozen original inputs and captured baseline stay independent of returned payload, initial and descriptors', () => {
  const original = freeze(row({ q001: 'old', q002: null, q003: { nested: ['private'] }, unknown: ['keep'] }));
  const before = JSON.stringify([template, original]);
  const editor = createAssessmentEditor(template, original, '2026-10-08');
  const valid = { ...editor.initial, q001: 'new' };
  editor.initial.q001 = 'tampered baseline';
  editor.questions[0].initialValue = 'tampered descriptor';
  editor.questions[1].requiresIntent = false;
  const first = editor.buildPayload(valid);
  first.answers.q003.nested.push('local'); first.answers.unknown.push('local');
  const second = editor.buildPayload(valid);
  assert.deepEqual(second.answers.q003, { nested: ['private'] });
  assert.deepEqual(second.answers.unknown, ['keep']);
  assert.equal(Object.hasOwn(editor.buildPayload({ ...valid, q001: 'old' }), 'answers'), false);
  assert.equal(JSON.stringify([template, original]), before);
  const mutable = row({ q001: 'captured', unknown: { original: true } });
  const captured = createAssessmentEditor(template, mutable, '2026-10-08');
  mutable.answers.unknown.original = false; mutable.answers.q001 = 'changed elsewhere';
  const saved = captured.buildPayload(values(captured, { q001: 'my edit' }));
  assert.deepEqual(saved.answers.unknown, { original: true });
});

test('large hidden data remains intact for the API size guard, with no clipping or client normalization', () => {
  const text = '長'.repeat(50000);
  const original = freeze(row({ hidden: { text }, q001: 'old' }));
  const editor = createAssessmentEditor(template, original, '2026-10-08');
  assert.equal(Object.hasOwn(editor.buildPayload(values(editor, { status: 'submitted' })), 'answers'), false);
  const changed = editor.buildPayload(values(editor, { q001: 'new' }));
  assert.equal(changed.answers.hidden.text, text);
  assert.ok(JSON.stringify(changed.answers).length > 50000);
  assert.ok(Buffer.byteLength(JSON.stringify(changed)) > 131072);
  assert.equal(JSON.stringify(editor.questions).includes(text), false);
});

test('unapproved control definitions and non-JSON nested sources fail explicitly instead of losing saved content', () => {
  for (const fields of [
    [{ name: 'q001', label: 'future number', type: 'number' }],
    [{ name: 'caseId', label: 'collision', type: 'text' }],
    [{ name: 'q001', label: 'one', type: 'text' }, { name: 'q001', label: 'two', type: 'text' }],
  ]) rejectsField(() => createAssessmentEditor({ ...template, fields }, row({}), '2026-10-08'), 'templateId');
  for (const value of [undefined, NaN, Infinity, 2n, () => 'private', new Date('2026-10-08')]) {
    rejectsField(() => createAssessmentEditor(template, row({ unknown: value }), '2026-10-08'), 'answers');
  }
  const cyclic = {}; cyclic.self = cyclic;
  rejectsField(() => createAssessmentEditor(template, row({ unknown: cyclic }), '2026-10-08'), 'answers');
});
