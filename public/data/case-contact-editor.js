import { CONTACT_CATEGORIES, CONTACT_STATUSES } from './history-fields.js';

// Saved business JSON and the fixed parent remain private to this adapter.
const names = ['caseId', 'name', 'category', 'relationship', 'phone', 'alternatePhone', 'email', 'organization', 'status', 'note'];
const controls = ['name', 'category', 'relationship', 'organization', 'phone', 'alternatePhone', 'email', 'note'];
const optional = new Set(['relationship', 'organization', 'phone', 'alternatePhone', 'email', 'note']);
const limits = { name: 100, relationship: 100, phone: 100, alternatePhone: 100, email: 254, organization: 200, note: 10000 };
const labels = { name: '聯絡人姓名', category: '聯絡人分類', relationship: '關係', organization: '所屬單位', phone: '主要電話', alternatePhone: '其他電話', email: '電子信箱', note: '備註' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const identity = value => typeof value === 'string' && Boolean(value.trim());
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function savedValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) invalid('name', '保存資料不是可安全保留的 JSON，請重新讀取。');
  return descriptor.value;
}
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('name', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value')) invalid('name', '保存資料不是可安全保留的 JSON，請重新讀取。');
    put(result, key, copyJson(descriptor.value, ancestors));
  }
  if (Array.isArray(value) && (result.length !== value.length
    || Reflect.ownKeys(value).filter(key => key !== 'length').some((key, index) => key !== String(index))))
    invalid('name', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.delete(value);
  return result;
}
function kind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
export function formatContactText(value, present = value !== undefined) {
  if (!present) return '未保存';
  if (typeof value === 'string') return value || '未提供';
  return `保存${kind(true, value)}（內容未展示）`;
}
export const formatContactCategory = value => CONTACT_CATEGORIES.find(item => item.value === value)?.label || '分類未取得';
export const formatContactStatus = value => CONTACT_STATUSES.find(item => item.value === value)?.label || '狀態未取得';

export function confirmCaseContactList(result, { page, pageSize = 25, orgId, caseId, category = '', status = '' } = {}) {
  if (!plain(result) || Reflect.ownKeys(result).sort().join(',') !== 'items,page,pageSize,total'
    || !Number.isSafeInteger(page) || page < 1 || pageSize !== 25 || !identity(orgId) || !identity(caseId)
    || category !== '' && !CONTACT_CATEGORIES.some(item => item.value === category)
    || status !== '' && !CONTACT_STATUSES.some(item => item.value === status)
    || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
    || result.page !== page || result.pageSize !== pageSize
    || result.items.length !== Math.min(pageSize, Math.max(0, result.total - (page - 1) * pageSize))
    || new Set(result.items.map(item => item?.id)).size !== result.items.length
    || result.items.some(item => !plain(item) || !own(item, 'id') || !identity(item.id)
      || !own(item, 'orgId') || item.orgId !== orgId || !own(item, 'caseId') || item.caseId !== caseId
      || !own(item, 'version') || !Number.isSafeInteger(item.version) || item.version < 1
      || category !== '' && (!own(item, 'category') || item.category !== category)
      || status !== '' && (!own(item, 'status') || item.status !== status)))
    throw new Error('聯絡人清單回應無法確認，請重新讀取。');
  return result;
}

export function createCaseContactEditor({ existing, caseId } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (!identity(caseId) || caseId.length > 500 || caseId !== caseId.trim() || /[\r\n]/.test(caseId))
    invalid('name', '所屬個案無法確認，請重新讀取。');
  if (editing) {
    if (!plain(existing)) invalid('name', '原聯絡人資料無法確認，請重新讀取。');
    if (!own(existing, 'caseId') || savedValue(existing, 'caseId') !== caseId) invalid('name', '原聯絡人的所屬個案無法確認，請重新讀取。');
  }
  const original = {}, baseline = {}, fields = [], intents = new Set();
  const savedIdentity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(savedValue(existing, name))])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(savedValue(existing, name)));
  const knownStatus = editing && CONTACT_STATUSES.some(item => item.value === original.status);
  const compatible = (name, value) => name === 'category' ? CONTACT_CATEGORIES.some(item => item.value === value)
    : typeof value === 'string' && value.length <= limits[name]
      && !(name === 'note' ? /\r/.test(value) : /[\r\n]/.test(value))
      && (name !== 'name' || Boolean(value.trim()))
      && (name !== 'email' || value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  function replacement(name, value) {
    if (typeof value !== 'string') invalid(name, '請填寫符合此欄格式的文字。');
    const result = value.trim();
    if (!compatible(name, result)) invalid(name, `請提供符合${labels[name]}格式與範圍的內容。`);
    return result;
  }
  for (const name of controls) {
    const present = editing && own(original, name), unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      intents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${kind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? '' : original[name] : name === 'category' ? 'general' : '';
    fields.push({ name, label: labels[name], type: name === 'category' ? 'select' : name === 'note' ? 'textarea' : name === 'email' ? 'email' : ['phone', 'alternatePhone'].includes(name) ? 'tel' : 'text',
      required: !unsafe && !optional.has(name), disabled: unsafe,
      ...(limits[name] ? { maxLength: limits[name] } : {}),
      ...(name === 'category' ? { options: CONTACT_CATEGORIES.map(item => ({ ...item })), help: '同分類可以有多筆；分類不代表法定代理人或唯一主聯絡人。' } : {}),
      ...(name === 'name' ? { help: '所屬個案固定；建立後不能更換個案。' } : {}),
      ...(name === 'phone' ? { help: '可填寫分機或國際格式，亦可留空。' } : {}),
      ...(name === 'email' ? { wide: true } : {}),
      ...(name === 'note' ? { help: '最多 10000 個字元。' } : {}),
    });
  }
  if (editing && !knownStatus) {
    baseline.statusRepair = 'keep';
    fields.push({ name: 'statusRepair', label: '聯絡人狀態修復', type: 'select', required: true,
      options: [{ value: 'keep', label: '保持原值' }, ...CONTACT_STATUSES.map(item => ({ value: item.value, label: `明確改為${item.label}` }))],
      help: `保存類型：${kind(own(original, 'status'), original.status)}。未知狀態不推測；只有明確選擇才取代。` });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, name) => own(values, name) ? values[name] : baseline[name];
  const needsIntent = name => intents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function buildPayload(values) {
    if (!plain(values)) invalid('name', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of controls) {
      let value = valueOf(values, name);
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(optional.has(name) ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[name]) continue;
      value = replacement(name, value);
      if (!editing || !own(original, name) || original[name] !== value) put(payload, name, value);
    }
    if (!editing) { payload.caseId = caseId; payload.status = 'active'; }
    else if (!knownStatus) {
      const repair = valueOf(values, 'statusRepair');
      if (repair !== 'keep' && !CONTACT_STATUSES.some(item => item.value === repair)) invalid('statusRepair', '請明確選擇有效的聯絡人狀態。');
      if (repair !== 'keep') payload.status = repair;
    }
    return payload;
  }
  function buildStatusChange(status) {
    if (!editing || !knownStatus || !CONTACT_STATUSES.some(item => item.value === status) || status === original.status)
      invalid('status', '請使用已確認的聯絡人狀態動作。');
    return { status };
  }
  function confirm(item, orgId, payload) {
    try {
      if (!plain(item) || !plain(payload) || !identity(orgId)) unconfirmed();
      const confirmed = {};
      for (const name of ['id', 'orgId', 'version', ...names]) if (own(item, name)) put(confirmed, name, copyJson(savedValue(item, name)));
      item = confirmed; payload = copyJson(payload);
      if (!own(item, 'id') || !identity(item.id) || !own(item, 'orgId') || item.orgId !== orgId
        || !own(item, 'caseId') || item.caseId !== caseId || !own(item, 'version') || !Number.isSafeInteger(item.version)
        || (editing ? !Number.isSafeInteger(savedIdentity.version) || savedIdentity.version < 1 || savedIdentity.version >= Number.MAX_SAFE_INTEGER
          || savedIdentity.orgId !== orgId || item.id !== savedIdentity.id || item.version !== savedIdentity.version + 1 : item.version !== 1)) unconfirmed();
      for (const name of Object.keys(payload)) if (!names.includes(name) || editing && name === 'caseId') unconfirmed();
      for (const name of names) {
        const supplied = own(payload, name), present = supplied || editing && own(original, name);
        if (!editing && !supplied || own(item, name) !== Boolean(present)) unconfirmed();
        const expected = supplied ? typeof payload[name] === 'string' ? payload[name].trim() : payload[name] : original[name];
        if (present && JSON.stringify(item[name]) !== JSON.stringify(expected)) unconfirmed();
      }
    } catch { unconfirmed(); }
    return item;
  }
  return { initial: { ...baseline }, fields, needsIntent, enabled, buildPayload, buildStatusChange, confirm };
}
