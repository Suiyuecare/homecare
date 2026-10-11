// Manual local reminder DTO and ordinary form adapter; no automatic deadline policy.
export const contractDeadlineEntity = 'contract-deadline-reminders';
export const contractDeadlineFields = Object.freeze(['contractId', 'contractVersion', 'contractSnapshot', 'title', 'content', 'assigneeEmployeeId', 'dueDate', 'priority', 'status', 'statusDate', 'result', 'statusReason', 'note']);
export const contractDeadlineSnapshotFields = Object.freeze(['id', 'version', 'caseId', 'number', 'title', 'startDate', 'endDate']);
export const contractDeadlineStatuses = Object.freeze({ pending: '待處理', in_progress: '處理中', completed: '已人工完成', cancelled: '已取消' });
export const contractDeadlinePriorities = Object.freeze({ low: '低', normal: '一般', high: '高' });
export const contractDeadlineWorkStates = Object.freeze({ before_due: '指定日尚未到人工期限', on_due: '指定日為人工期限', past_due: '指定日已超過人工期限', closed: '已人工完成或取消' });
export const contractDeadlineLabels = Object.freeze({ contractId: '來源契約', contractVersion: '來源保存版次', contractSnapshot: '建立時契約快照', title: '提醒標題', content: '人工工作內容', assigneeEmployeeId: '受指派員工', dueDate: '人工應完成日期', priority: '優先程度', status: '提醒狀態', statusDate: '最近處理日期', result: '本次完成結果', statusReason: '本次取消原因', note: '備註' });
export const contractDeadlineLimits = Object.freeze({ contractId: 100, title: 200, content: 10000, assigneeEmployeeId: 100, dueDate: 10, priority: 30, status: 30, statusDate: 10, result: 10000, statusReason: 10000, note: 10000 });
export const contractDeadlineDefaults = Object.freeze({ priority: 'normal', status: 'pending', statusDate: '', result: '', statusReason: '', note: '' });
const meta = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function deadlineOwn(value, key) {
  if (!plain(value)) return { valid: false, present: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return !descriptor ? { valid: true, present: false } : descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    ? { valid: true, present: true, value: descriptor.value } : { valid: false, present: true };
}
export function deadlineClosed(value, keys) {
  return plain(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && deadlineOwn(value, key).valid);
}
export const contractDeadlineDate = value => typeof value === 'string' && value.length === 10 && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const identifier = value => typeof value === 'string' && !!value && value.length <= 100 && value.trim() === value && !/[\r\n]/.test(value);
const timestamp = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function contractDeadlineSnapshotValid(value) {
  return deadlineClosed(value, contractDeadlineSnapshotFields) && identifier(value.id) && identifier(value.caseId) && Number.isSafeInteger(value.version) && value.version >= 1
    && typeof value.number === 'string' && !!value.number.trim() && value.number.length <= 100 && !/[\r\n]/.test(value.number)
    && typeof value.title === 'string' && !!value.title.trim() && value.title.length <= 200 && !/[\r\n]/.test(value.title)
    && contractDeadlineDate(value.startDate) && contractDeadlineDate(value.endDate) && value.startDate <= value.endDate;
}
export function contractDeadlineSnapshotRows(value) {
  if (!contractDeadlineSnapshotValid(value)) return null;
  const labels = { id: '來源保存識別碼', version: '來源保存版次', caseId: '來源個案識別碼', number: '建立時契約編號', title: '建立時契約標題', startDate: '建立時開始日期', endDate: '建立時結束日期' };
  return contractDeadlineSnapshotFields.map(key => ({ key, label: labels[key], value: String(value[key]) }));
}
export function contractDeadlineRecordValid(item, metadata = true) {
  if (!deadlineClosed(item, metadata ? [...contractDeadlineFields, ...meta] : contractDeadlineFields)) return false;
  if (Object.entries(contractDeadlineLimits).some(([key, maximum]) => typeof item[key] !== 'string' || item[key].length > maximum)) return false;
  if (!identifier(item.contractId) || !identifier(item.assigneeEmployeeId) || !item.title.trim() || /[\r\n]/.test(item.title) || !item.content.trim()
    || !contractDeadlineDate(item.dueDate) || !Object.hasOwn(contractDeadlinePriorities, item.priority) || !Object.hasOwn(contractDeadlineStatuses, item.status)) return false;
  if (!Number.isSafeInteger(item.contractVersion) || item.contractVersion < 1 || !contractDeadlineSnapshotValid(item.contractSnapshot)
    || item.contractSnapshot.id !== item.contractId || item.contractSnapshot.version !== item.contractVersion) return false;
  if (metadata && (!identifier(item.id) || !identifier(item.orgId) || !Number.isSafeInteger(item.version) || item.version < 1 || !timestamp(item.createdAt) || !timestamp(item.updatedAt) || item.updatedAt < item.createdAt)) return false;
  if (item.status === 'pending') return !item.statusDate && !item.result && !item.statusReason;
  if (!contractDeadlineDate(item.statusDate)) return false;
  if (item.status === 'completed') return !!item.result.trim() && !item.statusReason;
  if (item.status === 'cancelled') return !!item.statusReason.trim() && !item.result;
  return !item.result && !item.statusReason;
}
export function contractDeadlineWorkState(item, asOf) {
  if (!contractDeadlineRecordValid(item) || !contractDeadlineDate(asOf)) return null;
  return ['completed', 'cancelled'].includes(item.status) ? 'closed' : asOf < item.dueDate ? 'before_due' : asOf === item.dueDate ? 'on_due' : 'past_due';
}
function invalid(key, message) { throw Object.assign(new Error(message), { fields: { [key]: message } }); }
const display = (key, value) => ['content', 'note', 'result', 'statusReason'].includes(key) ? value.replace(/\r\n?/g, '\n') : value.replace(/[\r\n]/g, '');
function safeOptions(options) {
  if (!Array.isArray(options) || Object.getPrototypeOf(options) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(options, 'length')?.value;
  if (!Number.isSafeInteger(length) || length > 10000 || Reflect.ownKeys(options).length !== length + 1) return false;
  const ids = new Set();
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(options, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !deadlineClosed(descriptor.value, ['value', 'label', 'active'])) return false;
    const option = descriptor.value;
    if (!identifier(option.value) || typeof option.label !== 'string' || typeof option.active !== 'boolean' || ids.has(option.value)) return false;
    ids.add(option.value);
  }
  return true;
}
function copyRecord(record) { return Object.fromEntries([...contractDeadlineFields, ...meta].map(key => [key, key === 'contractSnapshot' ? Object.fromEntries(contractDeadlineSnapshotFields.map(k => [k, record[key][k]])) : record[key]])); }
export function checkContractDeadlineRecord(response, { id, orgId, original, payload } = {}) {
  if (!deadlineClosed(response, ['item']) || !contractDeadlineRecordValid(response.item) || response.item.orgId !== orgId || id && response.item.id !== id) invalid('title', '契約提醒保存回應無法確認；請保留輸入並重新讀取。');
  const item = response.item;
  if (payload) {
    if (!plain(payload) || Reflect.ownKeys(payload).some(key => typeof key !== 'string' || !contractDeadlineFields.includes(key) || key === 'contractSnapshot' || !deadlineOwn(payload, key).valid)) invalid('title', '契約提醒提交內容無法確認。');
    if (original && (!contractDeadlineRecordValid(original) || item.id !== original.id || item.orgId !== original.orgId || item.version !== original.version + 1 || item.createdAt !== original.createdAt || item.updatedAt < original.updatedAt)
      || !original && item.version !== 1) invalid('title', '契約提醒版次無法確認。');
    for (const key of contractDeadlineFields) {
      const expected = original ? original[key] : Object.hasOwn(contractDeadlineDefaults, key) ? contractDeadlineDefaults[key] : undefined;
      if (key === 'contractSnapshot') { if (original && contractDeadlineSnapshotFields.some(k => item[key][k] !== original[key][k])) invalid('title', '建立時來源快照改變。'); continue; }
      if (Object.hasOwn(payload, key) ? item[key] !== payload[key] : expected !== undefined && item[key] !== expected) invalid(key, '保存內容與本次提交不符。');
    }
  }
  return item;
}
export function createContractDeadlineEditor({ existing, source, employees = [] } = {}) {
  if (!safeOptions(employees)) invalid('assigneeEmployeeId', '同機構员工選項無法確認。');
  if (existing && !contractDeadlineRecordValid(existing)) invalid('title', '既有提醒格式無法確認。');
  if (!existing && !contractDeadlineSnapshotValid(source)) invalid('contractId', '請先核對目前生效契約來源。');
  if (existing && !['pending', 'in_progress'].includes(existing.status)) invalid('status', '已完成或取消提醒鎖定。');
  const saved = existing ? copyRecord(existing) : undefined;
  const sourceCopy = saved ? saved.contractSnapshot : Object.fromEntries(contractDeadlineSnapshotFields.map(key => [key, source[key]]));
  const keys = ['title', 'content', 'assigneeEmployeeId', 'dueDate', 'priority', 'note'];
  const baseline = Object.fromEntries(keys.map(key => [key, saved ? display(key, saved[key]) : key === 'title' ? '人工核對契約期限：' + sourceCopy.number : key === 'priority' ? 'normal' : '']));
  const fields = keys.map(key => ({ name: key, label: contractDeadlineLabels[key], type: ['content', 'note'].includes(key) ? 'textarea' : key === 'dueDate' ? 'date' : ['assigneeEmployeeId', 'priority'].includes(key) ? 'select' : 'text',
    required: key !== 'note', maxLength: contractDeadlineLimits[key], ...(['content', 'note'].includes(key) ? { wide: true } : {}),
    ...(key === 'assigneeEmployeeId' ? { options: employees.filter(option => option.active || saved && option.value === saved.assigneeEmployeeId).map(({ value, label, active }) => ({ value, label: active ? label : label + '（目前停用，保留指派）' })) }
      : key === 'priority' ? { options: Object.entries(contractDeadlinePriorities).map(([value, label]) => ({ value, label })) } : {}),
    ...(key === 'dueDate' ? { help: '人工指定内部工作日期；不推定法定期限、不改契約狀態或發訊息。' } : {}) }));
  return { fields, initial: { ...baseline }, buildPayload(values) {
    if (!deadlineClosed(values, keys)) invalid('title', '提醒表單欄位無法確認。');
    const payload = saved ? {} : { contractId: sourceCopy.id, contractVersion: sourceCopy.version };
    for (const key of keys) {
      let value = values[key]; if (typeof value !== 'string') invalid(key, '請使用文字或選項輸入。');
      if (saved && value === baseline[key]) continue;
      if (!['content', 'note'].includes(key)) value = value.trim();
      if (value.length > contractDeadlineLimits[key] || key !== 'note' && !value.trim() || key === 'title' && /[\r\n]/.test(value)
        || key === 'dueDate' && !contractDeadlineDate(value) || key === 'priority' && !Object.hasOwn(contractDeadlinePriorities, value)) invalid(key, '請核對必要欄位、格式與字數。');
      if (key === 'assigneeEmployeeId' && !employees.some(option => option.value === value && option.active)) invalid(key, '新指派須選擇同機構使用中員工。');
      if (!saved || value !== saved[key]) payload[key] = value;
    }
    return payload;
  } };
}
export function createContractDeadlineTransitionEditor(original, target) {
  if (!contractDeadlineRecordValid(original) || !({ pending: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'] }[original.status] || []).includes(target)) invalid('status', '目前提醒不支援此處理。');
  const saved = copyRecord(original), reason = target === 'completed' ? 'result' : target === 'cancelled' ? 'statusReason' : null;
  const fields = [{ name: 'statusDate', label: '本次人工處理日期', type: 'date', required: true }, ...(reason ? [{ name: reason, label: contractDeadlineLabels[reason], type: 'textarea', required: true, wide: true, maxLength: 10000 }] : [])];
  return { fields, initial: Object.fromEntries(fields.map(field => [field.name, ''])), buildPayload(values) {
    if (!deadlineClosed(values, fields.map(field => field.name)) || !contractDeadlineDate(values.statusDate) || saved.statusDate && values.statusDate < saved.statusDate) invalid('statusDate', '請核對有效且不早於上次處理的本次日期。');
    if (reason && (typeof values[reason] !== 'string' || !values[reason].trim() || values[reason].length > 10000)) invalid(reason, '請明確提交本次結果或原因。');
    return { status: target, statusDate: values.statusDate, ...(reason ? { [reason]: values[reason] } : {}) };
  } };
}
