import { createInterviewApplicantEditor } from './interview-applicant-editor.js';

// Ten optional company-defined fields; not evidence of the original platform's 18 fields.
export const INTERVIEW_EXTENSION_FIELDS = Object.freeze(['appliedPosition', 'education', 'workExperience', 'availableFrom', 'availableHours', 'certificateNotes', 'interviewQuestions', 'interviewerEmployeeId', 'decision', 'decisionReason']);
export const INTERVIEW_BASE_FIELDS = Object.freeze(['name', 'phone', 'interviewDate', 'city', 'district', 'interviewContent', 'note', 'status']);
export const INTERVIEW_LOCAL_FIELDS = Object.freeze([...INTERVIEW_BASE_FIELDS, ...INTERVIEW_EXTENSION_FIELDS]);
export const INTERVIEW_DECISIONS = Object.freeze({ pending: '待人工評估', considering: '人工考慮中', selected: '人工選用意向', not_selected: '人工未選用意向' });
export const INTERVIEW_EXTENSION_LIMITS = Object.freeze({ appliedPosition: 200, education: 500, workExperience: 10000, availableFrom: 10, availableHours: 2000, certificateNotes: 10000, interviewQuestions: 10000, interviewerEmployeeId: 100, decision: 20, decisionReason: 10000 });
export const INTERVIEW_EXTENSION_DEFAULTS = Object.freeze(Object.fromEntries(INTERVIEW_EXTENSION_FIELDS.map(key => [key, key === 'decision' ? 'pending' : ''])));
export const INTERVIEW_EXTENSION_LABELS = Object.freeze({ appliedPosition: '應徵職務', education: '學歷說明', workExperience: '工作經歷', availableFrom: '可到職日期', availableHours: '可配合時段', certificateNotes: '證照說明', interviewQuestions: '面試提問與回應', interviewerEmployeeId: '面試員工', decision: '人工評估', decisionReason: '本次人工判斷原因' });
export const INTERVIEW_FIELD_GROUPS = Object.freeze([
  { label: '基本資料', keys: ['name', 'phone', 'city', 'district'] },
  { label: '工作意願與經歷', keys: ['appliedPosition', 'education', 'workExperience', 'availableFrom', 'availableHours', 'certificateNotes'] },
  { label: '面試紀錄', keys: ['interviewDate', 'interviewContent', 'interviewQuestions', 'interviewerEmployeeId', 'note'] },
  { label: '人工評估', keys: ['decision', 'decisionReason', 'status'] },
].map(group => Object.freeze({ ...group, keys: Object.freeze(group.keys) })));
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const multiline = new Set(['workExperience', 'availableHours', 'certificateNotes', 'interviewQuestions', 'decisionReason']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const interviewExtensionDate = value => typeof value === 'string' && value.length === 10 && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export function interviewOwnField(value, key) {
  if (!plain(value)) return { valid: false, present: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { valid: true, present: false };
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return { valid: false, present: true };
  return { valid: true, present: true, value: descriptor.value };
}
export function interviewExtensionValueValid(key, value) {
  if (!Object.hasOwn(INTERVIEW_EXTENSION_LIMITS, key) || typeof value !== 'string' || value.length > INTERVIEW_EXTENSION_LIMITS[key]) return false;
  if (['appliedPosition', 'education', 'interviewerEmployeeId'].includes(key) && /[\r\n]/.test(value)) return false;
  if (key === 'availableFrom') return value === '' || interviewExtensionDate(value);
  if (key === 'interviewerEmployeeId') return value === '' || !!value.trim() && value === value.trim();
  if (key === 'decision') return Object.hasOwn(INTERVIEW_DECISIONS, value);
  return true;
}
export function interviewExtensionFieldsValid(record) {
  if (!plain(record)) return false;
  for (const key of INTERVIEW_EXTENSION_FIELDS) {
    const field = interviewOwnField(record, key);
    if (!field.valid || field.present && !interviewExtensionValueValid(key, field.value)) return false;
  }
  const decision = interviewOwnField(record, 'decision'), reason = interviewOwnField(record, 'decisionReason');
  return !decision.present || decision.value === 'pending' || reason.present && !!reason.value.trim();
}
function invalid(key, message) { const error = new Error(message); error.fields = { [key]: message }; throw error; }
function safeJson(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('name', '保存內容不是可安全保持的 JSON。');
  ancestors.add(value);
  const array = Array.isArray(value), result = array ? [] : {};
  if (array && Object.getPrototypeOf(value) !== Array.prototype) invalid('name', '保存清單格式無法確認。');
  const length = array ? Object.getOwnPropertyDescriptor(value, 'length').value : 0;
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) invalid('name', '保存內容含無法安全保持的欄位。');
    Object.defineProperty(result, key, { value: safeJson(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
  }
  if (array && Object.keys(result).length !== length) invalid('name', '保存清單含未取得項目。');
  ancestors.delete(value); return result;
}
const displayValue = (key, value) => typeof value === 'string' ? multiline.has(key) ? value.replace(/\r\n?/g, '\n') : value : '';
function safeChoices(choices) {
  if (!Array.isArray(choices) || Object.getPrototypeOf(choices) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(choices, 'length')?.value;
  if (!Number.isSafeInteger(length) || length > 10000 || Reflect.ownKeys(choices).length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(choices, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !plain(descriptor.value) || Reflect.ownKeys(descriptor.value).length !== 3) return false;
    const option = descriptor.value, value = interviewOwnField(option, 'value'), label = interviewOwnField(option, 'label'), active = interviewOwnField(option, 'active');
    if (![value, label, active].every(field => field.valid && field.present) || typeof value.value !== 'string' || !value.value || value.value.length > 100 || value.value.trim() !== value.value
      || typeof label.value !== 'string' || typeof active.value !== 'boolean') return false;
  }
  return new Set(choices.map(option => option.value)).size === choices.length;
}
export function createExtendedInterviewEditor({ existing, defaultDate = '', interviewers = [] } = {}) {
  if (!safeChoices(interviewers)) invalid('interviewerEmployeeId', '面試員工選項無法確認。');
  const editing = existing !== undefined && existing !== null, baseSaved = {}, original = {}, baseline = {}, intents = new Set();
  if (editing) {
    if (!plain(existing)) invalid('name', '原面試資料無法確認。');
    for (const key of [...INTERVIEW_LOCAL_FIELDS, ...metadata]) {
      const field = interviewOwnField(existing, key); if (!field.valid) invalid(key, '原保存欄位無法確認。');
      if (field.present) { const value = safeJson(field.value); if (INTERVIEW_EXTENSION_FIELDS.includes(key)) Object.defineProperty(original, key, { value, enumerable: true });
        else Object.defineProperty(baseSaved, key, { value, enumerable: true }); }
    }
  }
  const base = createInterviewApplicantEditor({ existing: editing ? baseSaved : undefined, defaultDate }), extensionFields = [];
  for (const key of INTERVIEW_EXTENSION_FIELDS) {
    const present = Object.hasOwn(original, key), valid = !present || interviewExtensionValueValid(key, original[key])
      && !(key === 'interviewerEmployeeId' && original[key] && !interviewers.some(option => option.value === original[key]));
    if (editing && !valid) {
      intents.add(key); baseline[key + 'Intent'] = 'keep'; extensionFields.push({ name: key + 'Intent', label: INTERVIEW_EXTENSION_LABELS[key] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原保存值' }, { value: 'replace', label: '以本次輸入取代' }, ...(key === 'decision' ? [] : [{ value: 'clear', label: '明確清空' }])], help: '原保存型別或指派選項尚未完整核對；保持時不覆寫或展開內容。' });
    }
    baseline[key] = editing ? present && valid ? displayValue(key, original[key]) : key === 'decision' && !present ? 'pending' : '' : INTERVIEW_EXTENSION_DEFAULTS[key];
    const options = key === 'decision' ? Object.entries(INTERVIEW_DECISIONS).map(([value, label]) => ({ value, label }))
      : key === 'interviewerEmployeeId' ? [{ value: '', label: '未指定面試員工' }, ...interviewers.filter(option => option.active || present && option.value === original[key]).map(({ value, label, active }) => ({ value, label: active ? label : label + '（目前已停用，保留原指派）' }))] : undefined;
    extensionFields.push({ name: key, label: INTERVIEW_EXTENSION_LABELS[key], type: multiline.has(key) ? 'textarea' : key === 'availableFrom' ? 'date' : options ? 'select' : 'text',
      maxLength: INTERVIEW_EXTENSION_LIMITS[key], disabled: editing && !valid, ...(options ? { options } : {}), ...(multiline.has(key) ? { wide: true } : {}),
      ...(key === 'decision' ? { help: '只保存人工意向；不會建立員工、帳號、到職或薪資。改變時必須填本次原因。' } : key === 'decisionReason' ? { help: '變更人工意向須明確填寫本次原因；不可直接沿用未改動的先前原因。' } : key === 'certificateNotes' ? { help: '人工說明，不代表證照或長照資格已正式核定。' } : {}) });
  }
  const allFields = [...base.fields, ...extensionFields], fields = [];
  for (const group of INTERVIEW_FIELD_GROUPS) {
    const grouped = group.keys.flatMap(key => allFields.filter(field => field.name === key || field.name === key + 'Intent'));
    grouped.forEach((field, i) => fields.push({ ...field, ...(i === 0 ? { groupLabel: group.label } : {}) }));
  }
  const initial = { ...base.initial, ...baseline }, allowed = new Set(Object.keys(initial));
  const needsIntent = name => base.needsIntent(name) || intents.has(name);
  const enabled = (name, values = {}) => {
    if (!plain(values) || Reflect.ownKeys(values).some(key => typeof key !== 'string' || !allowed.has(key) || !interviewOwnField(values, key).valid)) return false;
    return INTERVIEW_EXTENSION_FIELDS.includes(name) ? !intents.has(name) || interviewOwnField(values, name + 'Intent').value === 'replace' : base.enabled(name, values);
  };
  return { fields, initial, needsIntent, enabled, buildStatusChange: status => base.buildStatusChange(status), buildPayload(values) {
    if (!plain(values) || Reflect.ownKeys(values).some(key => typeof key !== 'string' || !allowed.has(key) || !interviewOwnField(values, key).valid)) invalid('name', '表單欄位無法確認。');
    const baseValues = Object.fromEntries(Object.keys(base.initial).map(key => [key, Object.hasOwn(values, key) ? interviewOwnField(values, key).value : base.initial[key]])), payload = base.buildPayload(baseValues);
    for (const key of INTERVIEW_EXTENSION_FIELDS) {
      let value = Object.hasOwn(values, key) ? interviewOwnField(values, key).value : baseline[key];
      if (intents.has(key)) {
        const intent = Object.hasOwn(values, key + 'Intent') ? interviewOwnField(values, key + 'Intent').value : baseline[key + 'Intent'];
        if (!['keep', 'replace', ...(key === 'decision' ? [] : ['clear'])].includes(intent)) invalid(key + 'Intent', '請選擇有效處理方式。');
        if (intent === 'keep') continue; if (intent === 'clear') value = '';
      } else if (editing && value === baseline[key]) continue;
      if (typeof value !== 'string') invalid(key, '請提供文字輸入。');
      if (['availableFrom', 'interviewerEmployeeId', 'decision'].includes(key)) value = value.trim();
      if (!interviewExtensionValueValid(key, value)) invalid(key, '請核對本機欄位的格式與範圍。');
      if (key === 'interviewerEmployeeId' && value && !interviewers.some(option => option.value === value && option.active)) invalid(key, '新指派須選擇同機構使用中的員工。');
      if (!editing || !Object.hasOwn(original, key) || value !== original[key]) payload[key] = value;
    }
    const merged = { ...(editing ? original : INTERVIEW_EXTENSION_DEFAULTS), ...payload };
    if (Object.hasOwn(payload, 'decision') && (editing || payload.decision !== 'pending')
      && (!Object.hasOwn(payload, 'decisionReason') || !payload.decisionReason.trim())) invalid('decisionReason', '變更人工評估必須明確填寫本次原因，原原因仍保留於歷程。');
    if (!interviewExtensionFieldsValid(merged)) invalid('decisionReason', '請核對人工意向與完整保存欄位。');
    return payload;
  }, confirm(item, orgId, payload) {
    try {
      const safeItem = {}, safePayload = {}, permitted = new Set([...INTERVIEW_LOCAL_FIELDS, ...metadata]);
      if (!plain(item) || !plain(payload) || Reflect.ownKeys(item).some(key => typeof key !== 'string' || !permitted.has(key))
        || Reflect.ownKeys(payload).some(key => typeof key !== 'string' || !(INTERVIEW_LOCAL_FIELDS.includes(key) || editing && key === 'version'))) throw new Error();
      for (const key of Reflect.ownKeys(item)) {
        const field = interviewOwnField(item, key); if (!field.valid) throw new Error();
        Object.defineProperty(safeItem, key, { value: safeJson(field.value), enumerable: true });
      }
      for (const key of Reflect.ownKeys(payload)) {
        const field = interviewOwnField(payload, key); if (!field.valid) throw new Error();
        Object.defineProperty(safePayload, key, { value: safeJson(field.value), enumerable: true });
      }
      base.confirm(safeItem, orgId, Object.fromEntries(Object.entries(safePayload).filter(([key]) => INTERVIEW_BASE_FIELDS.includes(key) || key === 'version')));
      if (!interviewExtensionFieldsValid(safeItem)) throw new Error();
      for (const key of INTERVIEW_EXTENSION_FIELDS) {
        const saved = interviewOwnField(safeItem, key), present = Object.hasOwn(safePayload, key) || editing && Object.hasOwn(original, key);
        if (!saved.valid || saved.present !== !!present || present && saved.value !== (Object.hasOwn(safePayload, key) ? safePayload[key] : original[key])) throw new Error();
      }
      if (editing && Object.hasOwn(baseSaved, 'createdAt') && safeItem.createdAt !== baseSaved.createdAt) throw new Error();
      return item;
    } catch { const error = new Error('完整18欄儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
  } };
}
