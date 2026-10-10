// Pure form adapter. Preserved JSON never becomes form metadata or display text.
const controls = new Set(['text', 'textarea', 'date', 'time']);
const metadataKeys = new Set(['caseId', 'date', 'status']);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (object, key) => Object.hasOwn(object, key);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

function invalid(name, message) {
  const error = new Error(message);
  error.fields = Object.fromEntries([[name, message]]);
  throw error;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day > 0 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function compatible(type, value) {
  if (typeof value !== 'string') return false;
  if (type === 'text') return !/[\r\n]/.test(value);
  if (type === 'textarea') return !/\r/.test(value);
  if (type === 'date') return value === '' || validDate(value);
  if (type === 'time') return value === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  return false;
}

function savedKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite-number';
  if (['string', 'number', 'boolean', 'object'].includes(typeof value)) return typeof value;
  return 'unsupported';
}

function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!Array.isArray(value) && !plainObject(value)) || ancestors.has(value)) {
    invalid('answers', '原填答不是可安全保留的 JSON 資料，請取消後重新讀取。');
  }
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}

/** Build a same-template editor; the caller retains record ID/version and API guards. */
export function createAssessmentEditor(template, row, defaultDate) {
  if (!plainObject(template) || typeof template.id !== 'string' || !template.id || !Array.isArray(template.fields)) {
    invalid('templateId', '模板規格無法取得，請重新讀取。');
  }
  const editing = row !== undefined && row !== null;
  if (editing && !plainObject(row)) invalid('answers', '原紀錄格式無法取得，請重新讀取。');
  const answersEditable = !editing || (own(row, 'answers') && plainObject(row.answers));
  const original = editing && answersEditable ? copyJson(row.answers) : {};
  const names = new Set();
  const questions = template.fields.map(field => {
    if (!plainObject(field) || typeof field.name !== 'string' || !field.name || names.has(field.name)
      || metadataKeys.has(field.name) || ['templateId', 'version', 'id', '__proto__', 'constructor', 'prototype'].includes(field.name)
      || field.name.startsWith('answerIntent_') || !controls.has(field.type) || typeof field.label !== 'string') {
      invalid('templateId', '模板題項規格無法取得，請重新讀取。');
    }
    names.add(field.name);
    const present = editing && answersEditable && own(original, field.name);
    const requiresIntent = present && !compatible(field.type, original[field.name]);
    return {
      name: field.name, type: field.type, label: field.label,
      initialValue: present && !requiresIntent ? original[field.name] : '', requiresIntent,
      ...(requiresIntent ? { intentName: `answerIntent_${field.name}`, savedKind: savedKind(original[field.name]) } : {}),
    };
  });
  const main = name => editing && own(row, name) && typeof row[name] === 'string' ? row[name] : '';
  const initial = { caseId: main('caseId'), date: editing ? main('date') : typeof defaultDate === 'string' ? defaultDate : '',
    status: editing ? main('status') : 'draft' };
  for (const question of questions) {
    put(initial, question.name, question.initialValue);
    if (question.requiresIntent) put(initial, question.intentName, 'keep');
  }
  const baseline = { ...initial };
  const allowed = new Set(Object.keys(baseline));
  const templateId = template.id;
  const hasPreservedAnswers = editing && (!answersEditable || questions.some(question => question.requiresIntent)
    || Object.keys(original).some(key => !names.has(key)));

  function buildPayload(values) {
    if (!plainObject(values)) invalid('answers', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const valueOf = name => own(values, name) ? values[name] : baseline[name];
    const caseId = valueOf('caseId'), date = valueOf('date'), status = valueOf('status');
    if (typeof caseId !== 'string' || !caseId) invalid('caseId', '請選擇個案。');
    if (typeof date !== 'string' || !validDate(date)) invalid('date', '請填寫有效的四位西元日期。');
    if (!['draft', 'submitted'].includes(status)) invalid('status', '請選擇儲存狀態。');
    const payload = { caseId, templateId, date, status };
    const changes = [];
    for (const question of questions) {
      const value = valueOf(question.name);
      if (!answersEditable) {
        if (value !== '') invalid(question.name, '原填答格式只允許保留，不能在此次編輯取代答案。');
        continue;
      }
      if (question.requiresIntent) {
        const intent = valueOf(question.intentName);
        if (!['keep', 'replace', 'clear'].includes(intent)) invalid(question.intentName, '請選擇保留、取代或清除保存答案。');
        if (intent === 'keep') continue;
        if (intent === 'clear') { changes.push([question.name, '']); continue; }
      } else if (editing && value === question.initialValue) continue;
      if (!compatible(question.type, value)) invalid(question.name, '輸入值不符合此題控制項格式，請修正後再儲存。');
      changes.push([question.name, value]);
    }
    if (!editing || changes.length) {
      const answers = copyJson(original);
      for (const [name, value] of changes) put(answers, name, value);
      payload.answers = answers;
    }
    return payload;
  }
  return { initial, questions: questions.map(question => ({ ...question })), answersEditable, editing, hasPreservedAnswers, buildPayload };
}
