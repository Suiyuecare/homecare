// Pure, display-only projection. Never retain unknown keys or nested answer data.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const supportedKinds = new Set(['missing', 'null', 'empty-string', 'string', 'number', 'boolean']);

export function normalizeAssessmentAnswer(value, present = true) {
  if (!present) return { kind: 'missing' };
  if (value === null) return { kind: 'null' };
  if (typeof value === 'string') return value === '' ? { kind: 'empty-string' } : { kind: 'string', value };
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'non-finite-number' };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (Array.isArray(value)) return { kind: 'array' };
  if (object(value)) return { kind: 'object' };
  return { kind: 'unsupported' };
}

function containerKind(snapshot) {
  if (!Object.hasOwn(snapshot, 'answers')) return 'missing';
  const value = snapshot.answers;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (object(value)) return Object.keys(value).length ? 'object' : 'empty-object';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return typeof value;
  return 'unsupported';
}

export function normalizeAssessmentAnswers(snapshot, templates) {
  const source = object(snapshot) ? snapshot : {};
  const template = typeof source.templateId === 'string' ? templates?.get?.(source.templateId) : null;
  // Unknown templates never inspect or expose their answer container.
  if (!template || !Array.isArray(template.fields)) return {
    templateState: 'unknown', container: 'unavailable', questions: [], hasUnknownKeys: false, hasUnsupportedValues: false,
  };
  const container = containerKind(source);
  const readable = container === 'object' || container === 'empty-object';
  const known = new Set(template.fields.map(field => field.name));
  const questions = readable ? template.fields.map(field => ({
    key: field.name, label: field.label,
    answer: normalizeAssessmentAnswer(Object.hasOwn(source.answers, field.name) ? source.answers[field.name] : undefined,
      Object.hasOwn(source.answers, field.name)),
  })) : [];
  return {
    templateState: 'known', container, questions,
    hasUnknownKeys: readable && Object.keys(source.answers).some(key => !known.has(key)),
    hasUnsupportedValues: questions.some(question => !supportedKinds.has(question.answer.kind)),
  };
}

export function compareAssessmentAnswers(previous, current, templates) {
  const before = normalizeAssessmentAnswers(previous, templates);
  const after = normalizeAssessmentAnswers(current, templates);
  const templateChanged = previous?.templateId !== current?.templateId;
  const sameKnownTemplate = !templateChanged && before.templateState === 'known' && after.templateState === 'known';
  const readable = item => item.container === 'object' || item.container === 'empty-object';
  // Adding an unknown key to an empty object is not a known business-field change.
  const containerType = item => readable(item) ? 'object' : item.container;
  const canCompareQuestions = sameKnownTemplate && readable(before) && readable(after);
  const changes = canCompareQuestions ? after.questions.flatMap((question, index) => {
    const saved = before.questions[index].answer;
    return saved.kind === question.answer.kind && Object.is(saved.value, question.answer.value)
      ? [] : [{ key: question.key, label: question.label, before: saved, after: question.answer }];
  }) : [];
  return {
    mode: templateChanged ? 'template-changed' : sameKnownTemplate ? 'same-template' : 'unavailable',
    before, after, changes, canCompareQuestions,
    containerChanged: sameKnownTemplate && containerType(before) !== containerType(after),
    limited: !canCompareQuestions || before.hasUnknownKeys || after.hasUnknownKeys
      || before.hasUnsupportedValues || after.hasUnsupportedValues,
  };
}
