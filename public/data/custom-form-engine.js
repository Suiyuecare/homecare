// Typed company forms. No scoring, expression evaluator or official template defaults.
export const FORM_TYPES = Object.freeze(['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'boolean']);
export const FORM_TYPE_LABELS = Object.freeze({ text: '短文字', textarea: '長文字', number: '十進位數值文字', date: '日期', select: '單選', multiselect: '多選', boolean: '是／否' });
export const FORM_MAX_SCHEMA_LENGTH = 1000000;
export const FORM_MAX_ANSWERS_LENGTH = 600000;
export const FORM_TEMPLATE_STATUSES = Object.freeze({ draft: '草稿', published: '已發布', inactive: '已停用' });
export const FORM_RECORD_STATUSES = Object.freeze({ draft: '草稿', submitted: '已提交' });
export const FORM_SNAPSHOT_KEYS = Object.freeze(['id', 'orgId', 'version', 'code', 'name', 'description', 'revision', 'groups', 'fields']);
const templateKeys = ['code', 'name', 'description', 'revision', 'previousTemplateId', 'groups', 'fields', 'status', 'note'];
const recordKeys = ['caseId', 'templateId', 'templateVersion', 'date', 'answers', 'attachmentIds', 'status', 'note', 'templateSnapshot'];
const metadataKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const reserved = new Set([...templateKeys, ...recordKeys, ...metadataKeys, '__proto__', 'constructor', 'prototype']);
const own = (value, key) => Object.hasOwn(value, key);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function formFailure(status, code, message, fields) { const error = new Error(message); Object.assign(error, { status, code, fields }); throw error; }
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && (() => { const d = Object.getOwnPropertyDescriptor(value, key); return d.enumerable && own(d, 'value'); })());
}
export const formClosed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
export function formArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(value).length !== length + 1) return false;
  for (let i = 0; i < length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !d.enumerable || !own(d, 'value')) return false; }
  return true;
}
export const formId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.trim() && !/[\r\n]/.test(value);
const word = (value, maximum, required = false) => typeof value === 'string' && value.length <= maximum && (!required || !!value.trim());
const positive = value => Number.isSafeInteger(value) && value > 0;
export function isCustomFormDate(value) {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && month > 0 && month <= 12 && day > 0 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export const isCustomFormNumber = value => typeof value === 'string' && value.length <= 29 && /^-?\d{1,15}(?:\.\d{1,12})?$/.test(value) && !/[\r\n]/.test(value);
const keyValid = value => typeof value === 'string' && value.length <= 50 && value === value.trim() && !/[\r\n]/.test(value) && /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && !reserved.has(value);
function typed(field, value) {
  if (field.type === 'text') return word(value, 500) && !/[\r\n]/.test(value);
  if (field.type === 'textarea') return word(value, 10000);
  if (field.type === 'number') return isCustomFormNumber(value);
  if (field.type === 'date') return isCustomFormDate(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'select') return typeof value === 'string' && field.options.some(option => option.value === value);
  if (field.type === 'multiselect') return formArray(value, 50) && new Set(value).size === value.length && value.every(entry => typeof entry === 'string' && field.options.some(option => option.value === entry));
  return false;
}
export function assertFormDefinition(groups, fields, fail = formFailure) {
  const invalid = message => fail(422, 'INVALID_FORM_SCHEMA', message, { fields: message });
  if (!formArray(groups, 20) || !formArray(fields, 50) || !fields.length) invalid('請建立1至50個題項及最多20個群組。');
  const groupIds = new Set(), previous = new Map();
  for (const group of groups) {
    if (!formClosed(group, ['id', 'label']) || !keyValid(group.id) || !word(group.label, 200, true) || groupIds.has(group.id)) invalid('群組需有不重複的代碼與名稱。');
    groupIds.add(group.id);
  }
  for (const field of fields) {
    if (!formClosed(field, ['key', 'label', 'type', 'groupId', 'required', 'options', 'visibleIf']) || !keyValid(field.key) || previous.has(field.key)
      || !word(field.label, 200, true) || !FORM_TYPES.includes(field.type) || typeof field.required !== 'boolean' || typeof field.groupId !== 'string'
      || field.groupId !== '' && !groupIds.has(field.groupId) || !formArray(field.options, 50)) invalid('題項代碼、名稱、型別、群組或必填設定無法確認。');
    const options = new Set();
    for (const option of field.options) {
      if (!formClosed(option, ['value', 'label']) || !word(option.value, 100, true) || !word(option.label, 200, true) || option.value !== option.value.trim() || /[\r\n]/.test(option.value) || options.has(option.value)) invalid('選項需有不重複的單行代碼與名稱。');
      options.add(option.value);
    }
    if (['select', 'multiselect'].includes(field.type) ? !options.size : options.size !== 0) invalid('單選與多選必須設定選項；其他型別不能設定選項。');
    if (field.visibleIf !== null) {
      if (!formClosed(field.visibleIf, ['field', 'equals'])) invalid('顯示條件只支援前序題項與一個相等值。');
      const controller = previous.get(field.visibleIf.field);
      if (!controller || controller.type === 'multiselect' || !typed(controller, field.visibleIf.equals)) invalid('顯示條件必須引用前序非多選題項，且相等值須符合該題型別。');
    }
    previous.set(field.key, field);
  }
  if (JSON.stringify({ groups, fields }).length > FORM_MAX_SCHEMA_LENGTH) invalid('題項定義超過1000000字元，請縮小表單。');
  return fields;
}
export function visibleFormFields(groups, fields, answers, fail = formFailure) {
  assertFormDefinition(groups, fields, fail);
  if (!object(answers)) fail(422, 'INVALID_FORM_ANSWERS', '填答須為封閉的題項資料。', { answers: '填答格式不符' });
  const visible = new Set();
  for (const field of fields) {
    const c = field.visibleIf;
    if (c === null || visible.has(c.field) && own(answers, c.field) && same(answers[c.field], c.equals)) visible.add(field.key);
  }
  return visible;
}
export function assertFormAnswers(groups, fields, answers, { submitted = false } = {}, fail = formFailure) {
  const visible = visibleFormFields(groups, fields, answers, fail), known = new Map(fields.map(field => [field.key, field]));
  for (const key of Object.keys(answers)) {
    const field = known.get(key);
    if (!field || !visible.has(key)) fail(422, 'HIDDEN_OR_UNKNOWN_ANSWER', '未知或未顯示的題項不能保存答案。', { [key]: '請確認顯示條件並明確清除不適用答案' });
    if (!typed(field, answers[key])) fail(422, 'INVALID_FORM_ANSWER', '答案不符合題項型別或選項。', { [key]: '請核對格式與允許選項' });
  }
  if (submitted) for (const field of fields) {
    if (!field.required || !visible.has(field.key)) continue;
    const value = answers[field.key];
    if (!own(answers, field.key) || typeof value === 'string' && !value.trim() || Array.isArray(value) && !value.length)
      fail(422, 'FORM_REQUIRED', '提交前請填寫所有已顯示的必填題項。', { [field.key]: '此題提交時必填' });
  }
  if (JSON.stringify(answers).length > FORM_MAX_ANSWERS_LENGTH) fail(422, 'FORM_ANSWERS_TOO_LARGE', '填答超過600000字元。', { answers: '請縮小填答內容' });
  return visible;
}
function metadata(item, orgId, fail) {
  if (!formId(item.id) || item.orgId !== orgId || !positive(item.version) || !word(item.createdAt, 100, true) || !word(item.updatedAt, 100, true)) fail(409, 'FORM_DATA_INVALID', '保存身份、機構或版次無法確認。');
}
export function assertFormTemplateRecord(item, orgId, fail = formFailure) {
  if (!formClosed(item, [...templateKeys, ...metadataKeys])) fail(409, 'FORM_DATA_INVALID', '模板保存資料無法確認。');
  metadata(item, orgId, fail);
  if (!word(item.code, 100, true) || item.code !== item.code.trim() || /[\r\n]/.test(item.code) || !word(item.name, 200, true) || !word(item.description, 10000)
    || !word(item.note, 10000) || !positive(item.revision) || !(item.previousTemplateId === '' || formId(item.previousTemplateId)) || !own(FORM_TEMPLATE_STATUSES, item.status)) fail(409, 'FORM_DATA_INVALID', '模板識別、文字或狀態無法確認。');
  if (item.revision === 1 ? item.previousTemplateId !== '' : !item.previousTemplateId) fail(409, 'FORM_DATA_INVALID', '模板修訂鏈無法確認。');
  assertFormDefinition(item.groups, item.fields, fail); return item;
}
export function captureFormTemplate(item, orgId, fail = formFailure) {
  assertFormTemplateRecord(item, orgId, fail);
  return Object.fromEntries(FORM_SNAPSHOT_KEYS.map(key => [key, structuredClone(item[key])]));
}
export function assertFormTemplateSnapshot(snapshot, orgId, fail = formFailure) {
  if (!formClosed(snapshot, FORM_SNAPSHOT_KEYS) || snapshot.orgId !== orgId || !formId(snapshot.id) || !positive(snapshot.version) || !positive(snapshot.revision)
    || !word(snapshot.code, 100, true) || !word(snapshot.name, 200, true) || !word(snapshot.description, 10000)) fail(409, 'FORM_DATA_INVALID', '保存模板快照無法確認。');
  assertFormDefinition(snapshot.groups, snapshot.fields, fail); return snapshot;
}
export function assertFormRecord(item, orgId, fail = formFailure) {
  if (!formClosed(item, [...recordKeys, ...metadataKeys])) fail(409, 'FORM_DATA_INVALID', '填答保存資料無法確認。');
  metadata(item, orgId, fail);
  if (!formId(item.caseId) || !formId(item.templateId) || !positive(item.templateVersion) || !isCustomFormDate(item.date) || !own(FORM_RECORD_STATUSES, item.status)
    || !word(item.note, 10000) || !formArray(item.attachmentIds, 20) || !item.attachmentIds.every(formId) || new Set(item.attachmentIds).size !== item.attachmentIds.length) fail(409, 'FORM_DATA_INVALID', '填答身份、日期、附件或狀態無法確認。');
  const snapshot = assertFormTemplateSnapshot(item.templateSnapshot, orgId, fail);
  if (snapshot.id !== item.templateId || snapshot.version !== item.templateVersion) fail(409, 'FORM_DATA_INVALID', '填答與保存模板版次不一致。');
  assertFormAnswers(snapshot.groups, snapshot.fields, item.answers, { submitted: item.status === 'submitted' }, fail); return item;
}
export function customFormValueText(field, answer) {
  if (answer === undefined) return '未填寫';
  if (field.type === 'boolean') return answer ? '是' : '否';
  if (field.type === 'select') return field.options.find(option => option.value === answer)?.label || '選項無法確認';
  if (field.type === 'multiselect') return answer.map(value => field.options.find(option => option.value === value)?.label || '選項無法確認').join('、') || '未選擇';
  return answer || '未填寫';
}
