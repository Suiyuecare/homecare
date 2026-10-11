// Closed DTO and native-control adapter. No DOM, side effects or guessed legal rules.
export const contractStatuses = { draft: '草稿', active: '已記錄生效', terminated: '已人工終止', expired: '已人工處理到期', cancelled: '已取消草稿' };
export const internalTaskStatuses = { pending: '待處理', in_progress: '處理中', completed: '已完成', cancelled: '已取消' };
export const priorities = { low: '低', normal: '一般', high: '高' };
export const expiryLabels = { not_active: '目前非生效狀態', not_started: '指定日早於開始日', within_term: '指定日在期間內', past_end: '指定日已超過結束日' };
export const contractFields = ['caseId', 'number', 'title', 'startDate', 'endDate', 'signedDate', 'documentReference', 'sourceReference', 'renewedFromId', 'status', 'statusDate', 'statusReason', 'note'];
export const internalTaskFields = ['title', 'content', 'assigneeEmployeeId', 'dueDate', 'priority', 'status', 'statusDate', 'result', 'statusReason', 'note'];
const fieldNames = entity => entity === 'case-contracts' ? contractFields : entity === 'internal-tasks' ? internalTaskFields : null;
const maxima = { caseId: 100, number: 100, title: 200, startDate: 10, endDate: 10, signedDate: 10, documentReference: 2000, sourceReference: 2000,
  renewedFromId: 100, status: 30, statusDate: 10, statusReason: 10000, note: 10000, content: 10000, assigneeEmployeeId: 100, dueDate: 10, priority: 30, result: 10000 };
const labels = { caseId: '契約個案', number: '契約編號', title: '標題', startDate: '開始日期', endDate: '結束日期', signedDate: '簽署日期', documentReference: '文件識別',
  sourceReference: '人工核對來源', renewedFromId: '原契約識別', status: '狀態', statusDate: '本次處理日期', statusReason: '本次原因', note: '備註',
  content: '待辦內容', assigneeEmployeeId: '受指派員工', dueDate: '應完成日期', priority: '優先程度', result: '本次完成結果' };
const long = ['content', 'sourceReference', 'result', 'statusReason', 'note'];
const dates = ['startDate', 'endDate', 'signedDate', 'statusDate', 'dueDate'];
const identifier = value => typeof value === 'string' && !!value.trim() && value.length <= 100 && !/[\r\n]/.test(value);
export const contractsTasksDate = value => typeof value === 'string' && value.length === 10 && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function closed(value, fields) {
  if (!plain(value) || Reflect.ownKeys(value).length !== fields.length) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function invalid(key, message) { const error = new Error(message); error.fields = { [key]: message }; throw error; }
const own = (object, key) => {
  const descriptor = plain(object) && Object.getOwnPropertyDescriptor(object, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
function safeChoices(values) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(values, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 10000 || Reflect.ownKeys(values).length !== length + 1) return false;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !closed(descriptor.value, ['value', 'label'])
      || typeof descriptor.value.value !== 'string' || !descriptor.value.value || typeof descriptor.value.label !== 'string') return false;
  }
  return true;
}
function businessValid(entity, item) {
  const fields = fieldNames(entity), statuses = entity === 'case-contracts' ? contractStatuses : internalTaskStatuses;
  if (!fields || fields.some(key => typeof item[key] !== 'string' || item[key].length > maxima[key]) || !Object.hasOwn(statuses, item.status) || !item.title.trim() || /[\r\n]/.test(item.title)) return false;
  if (entity === 'case-contracts') {
    if (!identifier(item.caseId) || item.renewedFromId && !identifier(item.renewedFromId) || !item.number.trim() || /[\r\n]/.test(item.number + item.documentReference)
      || !contractsTasksDate(item.startDate) || !contractsTasksDate(item.endDate) || item.endDate < item.startDate || item.signedDate && !contractsTasksDate(item.signedDate)) return false;
    if (item.status === 'draft') return !item.statusDate && !item.statusReason;
    if (!contractsTasksDate(item.statusDate)) return false;
    if (item.status !== 'cancelled' && (!contractsTasksDate(item.signedDate) || !item.documentReference.trim() || !item.sourceReference.trim() || item.statusDate < item.signedDate)) return false;
    return item.status === 'active' ? !item.statusReason : !!item.statusReason.trim() && (item.status !== 'expired' || item.statusDate > item.endDate);
  }
  if (!item.content.trim() || !identifier(item.assigneeEmployeeId) || !contractsTasksDate(item.dueDate) || !Object.hasOwn(priorities, item.priority)) return false;
  if (item.status === 'pending') return !item.statusDate && !item.result && !item.statusReason;
  if (!contractsTasksDate(item.statusDate)) return false;
  if (item.status === 'completed') return !!item.result.trim() && !item.statusReason;
  if (item.status === 'cancelled') return !!item.statusReason.trim() && !item.result;
  return !item.result && !item.statusReason;
}
export function checkContractsTasksRecord(result, { entity, id, orgId, original, payload } = {}) {
  const fields = fieldNames(entity), item = own(result, 'item');
  if (!fields || !closed(item, [...fields, 'id', 'orgId', 'version', 'createdAt', 'updatedAt'])
    || !identifier(item.id) || !identifier(item.orgId) || item.orgId !== orgId || id && item.id !== id
    || !Number.isSafeInteger(item.version) || item.version < 1 || typeof item.createdAt !== 'string' || !item.createdAt || typeof item.updatedAt !== 'string' || !item.updatedAt || !businessValid(entity, item))
    invalid('title', '無法確認契約或待辦保存內容，請保留輸入並重新讀取。');
  if (payload) {
    if (original && (!closed(original, [...fields, 'id', 'orgId', 'version', 'createdAt', 'updatedAt']) || original.orgId !== orgId
      || !identifier(original.id) || !Number.isSafeInteger(original.version) || original.version < 1 || !businessValid(entity, original))) invalid('title', '原保存資料無法確認。');
    if (!plain(payload) || Reflect.ownKeys(payload).some(key => typeof key !== 'string' || !fields.includes(key) || own(payload, key) === undefined)) invalid('title', '保存確認欄位無法核對。');
    const defaults = entity === 'case-contracts' ? { signedDate: '', documentReference: '', sourceReference: '', renewedFromId: '', status: 'draft', statusDate: '', statusReason: '', note: '' }
      : { priority: 'normal', status: 'pending', statusDate: '', result: '', statusReason: '', note: '' };
    const expected = { ...(original || defaults), ...payload };
    if (item.version !== (original ? original.version + 1 : 1) || original && (item.id !== original.id || item.createdAt !== original.createdAt)
      || fields.some(key => item[key] !== expected[key])) invalid('title', '保存回應的完整內容或版次不符，輸入仍保留。');
  }
  return item;
}
export function contractExpiryForDisplay(item, asOf) {
  if (!contractsTasksDate(asOf)) return null;
  if (item.status !== 'active') return 'not_active';
  return asOf < item.startDate ? 'not_started' : asOf > item.endDate ? 'past_end' : 'within_term';
}
function options(values) { return Object.entries(values).map(([value, label]) => ({ value, label })); }
function controlDisplay(field, value) {
  if (field.type === 'textarea') return value.replace(/\r\n?/g, '\n');
  if (field.type === 'date') return contractsTasksDate(value) ? value : '';
  if (field.type === 'select') return field.options.some(option => option.value === value) ? value : '';
  return value.replace(/[\r\n]/g, '');
}
export function createContractsTasksEditor({ entity, existing, references = [], renewal } = {}) {
  const contract = entity === 'case-contracts';
  if (!fieldNames(entity) || !safeChoices(references)) invalid('title', '表單參照選項無法確認。');
  if (existing) checkContractsTasksRecord({ item: existing }, { entity, orgId: own(existing, 'orgId') });
  if (renewal) checkContractsTasksRecord({ item: renewal }, { entity, orgId: own(renewal, 'orgId') });
  if (!fieldNames(entity) || existing && (contract ? existing.status !== 'draft' : !['pending', 'in_progress'].includes(existing.status))) invalid('title', '此紀錄已鎖定，請重新讀取。');
  if (renewal && (!contract || existing || !['active', 'terminated', 'expired'].includes(renewal.status))) invalid('renewedFromId', '續約來源無法確認。');
  const names = contract ? ['caseId', 'number', 'title', 'startDate', 'endDate', 'signedDate', 'documentReference', 'sourceReference', 'note']
    : ['title', 'content', 'assigneeEmployeeId', 'dueDate', 'priority', 'note'];
  const editable = existing && contract ? names.filter(key => !['caseId', 'number'].includes(key)) : renewal ? names.filter(key => key !== 'caseId') : names;
  const initial = Object.fromEntries(editable.map(key => [key, existing?.[key] || (key === 'priority' ? 'normal' : '')]));
  const fixed = renewal ? { caseId: renewal.caseId, renewedFromId: renewal.id } : {};
  const fields = editable.map(name => ({ name, label: labels[name], type: dates.includes(name) ? 'date' : long.includes(name) ? 'textarea' : ['caseId', 'assigneeEmployeeId', 'priority'].includes(name) ? 'select' : 'text',
    required: (contract ? ['caseId', 'number', 'title', 'startDate', 'endDate'] : ['title', 'content', 'assigneeEmployeeId', 'dueDate', 'priority']).includes(name), maxLength: maxima[name],
    ...(long.includes(name) ? { wide: true } : {}), ...(name === 'priority' ? { options: options(priorities) } : ['caseId', 'assigneeEmployeeId'].includes(name) ? { options: references } : {}) }));
  const baseline = Object.fromEntries(fields.map(field => [field.name, controlDisplay(field, initial[field.name])]));
  return { fields, initial, buildPayload(values) {
    if (!closed(values, editable)) invalid('title', '表單欄位無法確認，請重新讀取。');
    const payload = existing ? {} : { ...fixed };
    for (const key of editable) {
      const value = own(values, key); if (typeof value !== 'string') invalid(key, '請提供文字輸入。');
      if (existing && value === baseline[key]) continue;
      const normalized = long.includes(key) ? value : value.trim();
      if (normalized.length > maxima[key]) invalid(key, '內容超過允許長度。');
      if (!existing || normalized !== existing[key]) payload[key] = normalized;
    }
    const merged = { ...initial, ...existing, ...payload, ...fixed };
    for (const field of fields) if (field.required && !merged[field.name].trim()) invalid(field.name, '請填寫必要欄位。');
    for (const key of dates.filter(key => editable.includes(key))) if (merged[key] && !contractsTasksDate(merged[key])) invalid(key, '請選擇有效日期。');
    if (contract && merged.startDate > merged.endDate) invalid('endDate', '結束日期不可早於開始日期。');
    if (renewal && merged.startDate <= renewal.endDate) invalid('startDate', '續約開始日須晚於原契約結束日。');
    if (!existing || Object.hasOwn(payload, contract ? 'caseId' : 'assigneeEmployeeId')) {
      const ref = contract ? 'caseId' : 'assigneeEmployeeId';
      if (!renewal && !references.some(option => option.value === merged[ref])) invalid(ref, '請選擇已核對的同機構選項。');
    }
    return payload;
  } };
}
export function createContractsTasksTransitionEditor(entity, original, target) {
  const contract = entity === 'case-contracts';
  checkContractsTasksRecord({ item: original }, { entity, orgId: own(original, 'orgId') });
  const allowed = contract ? { draft: ['active', 'cancelled'], active: ['terminated', 'expired'] } : { pending: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'] };
  if (!fieldNames(entity) || !allowed[original.status]?.includes(target)) invalid('status', '目前狀態不可執行此操作。');
  const names = ['statusDate', ...(['cancelled', 'terminated', 'expired'].includes(target) ? ['statusReason'] : target === 'completed' ? ['result'] : []),
    ...(contract && target === 'active' ? ['signedDate', 'documentReference', 'sourceReference'] : [])];
  const initial = Object.fromEntries(names.map(key => [key, ['signedDate', 'documentReference', 'sourceReference'].includes(key) ? original[key] : '']));
  const fields = names.map(name => ({ name, label: labels[name], type: dates.includes(name) ? 'date' : long.includes(name) ? 'textarea' : 'text', required: true, maxLength: maxima[name], ...(long.includes(name) ? { wide: true } : {}) }));
  return { fields, initial, buildPayload(values) {
    if (!closed(values, names)) invalid('status', '本次處理欄位無法確認。');
    const payload = { status: target };
    for (const field of fields) {
      const key = field.name, value = own(values, key);
      if (typeof value !== 'string' || !value.trim()) invalid(key, '本次操作必填。');
      if (value.length > maxima[key]) invalid(key, '內容超過允許長度。');
      if (dates.includes(key) && !contractsTasksDate(value)) invalid(key, '請選擇有效日期。');
      payload[key] = ['signedDate', 'documentReference', 'sourceReference'].includes(key) && value === controlDisplay(field, initial[key]) ? original[key] : long.includes(key) ? value : value.trim();
    }
    if (original.statusDate && payload.statusDate < original.statusDate) invalid('statusDate', '本次處理日期不可早於上一處理日期。');
    if (target === 'active' && payload.statusDate < payload.signedDate) invalid('statusDate', '處理日期不可早於簽署日期。');
    if (target === 'expired' && payload.statusDate <= original.endDate) invalid('statusDate', '人工到期處理日期須晚於保存結束日期。');
    return payload;
  } };
}
