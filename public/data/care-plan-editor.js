// Pure care-plan adapter. Saved JSON stays private; service replacement is whole-list only.
const names = ['caseId', 'validFrom', 'validTo', 'status', 'services', 'goals', 'note'];
const editControls = names.filter(name => name !== 'status');
const labels = { caseId: '個案', validFrom: '生效日期', validTo: '結束日期', status: '計畫狀態', services: '服務項目與計畫數量', goals: '照顧目標', note: '計畫備註' };
const optional = new Set(['goals', 'note']);
const statuses = { draft: '草稿', active: '生效中', ended: '已結束' };
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const singleLine = value => typeof value === 'string' && !/[\r\n]/.test(value);
const safeId = value => singleLine(value) && value.trim() !== '' && value.length <= 500;
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('services', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))))
    invalid('services', '保存資料不是可安全保留的 JSON，請重新讀取。');
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}
function dateValid(value, allowYearZero = false) {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if ((!allowYearZero && !year) || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
export const formatCarePlanText = value => typeof value === 'string' ? value || '未提供' : value === undefined ? '未提供' : '未取得';
export const formatCarePlanDate = value => dateValid(value, true) ? value.replaceAll('-', '/') : value === '' || value === undefined ? '未提供' : '日期未取得';
export const formatCarePlanStatus = value => value === '' || value === undefined ? '未提供' : typeof value === 'string' && own(statuses, value) ? statuses[value] : '狀態未取得';
export function formatCarePlanServices(services, items) {
  if (!Array.isArray(services)) return '服務明細未取得';
  if (!services.length) return '尚未設定';
  return services.map(entry => {
    if (!plain(entry)) return '服務明細未取得';
    const item = own(entry, 'serviceItemId') && typeof entry.serviceItemId === 'string' && items instanceof Map ? items.get(entry.serviceItemId) : null;
    const name = plain(item) && typeof item.name === 'string' && item.name ? item.name : '服務項目名稱未取得';
    const code = plain(item) && typeof item.code === 'string' && item.code ? item.code + ' ' : '';
    const quantity = own(entry, 'quantity') && Number.isSafeInteger(entry.quantity) && entry.quantity >= 1 && entry.quantity <= 10000 ? String(entry.quantity) : '數量未取得';
    return `${code}${name} × ${quantity}`;
  }).join('、');
}

export function createCarePlanEditor({ existing, cases = [], serviceItems = [], defaultDate = '', fixedCaseId = '' } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('caseId', '原照顧計畫資料格式無法取得，請重新讀取。');
  const original = {}, baseline = {}, fields = [], requiredIntents = new Set();
  const identity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(existing[name])])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(existing[name]));
  const caseIds = new Set(), caseOptions = [];
  for (const item of Array.isArray(cases) ? cases : []) {
    if (!plain(item) || !own(item, 'id') || !safeId(item.id) || caseIds.has(item.id)
      || !(item.status === 'active' || (editing && item.id === original.caseId))) continue;
    caseIds.add(item.id);
    const number = singleLine(item.caseNo) && item.caseNo ? item.caseNo : '未編案號';
    const name = singleLine(item.name) && item.name ? item.name : '個案名稱未取得';
    caseOptions.push({ value: item.id, label: `${number} ${name}` });
  }
  const originalServiceIds = new Set(Array.isArray(original.services) ? original.services
    .filter(entry => plain(entry) && own(entry, 'serviceItemId') && typeof entry.serviceItemId === 'string').map(entry => entry.serviceItemId) : []);
  const serviceIds = new Set(), serviceOptions = [];
  for (const item of Array.isArray(serviceItems) ? serviceItems : []) {
    if (!plain(item) || !own(item, 'id') || !safeId(item.id) || serviceIds.has(item.id)
      || !(item.status === 'active' || originalServiceIds.has(item.id))) continue;
    serviceIds.add(item.id);
    const code = singleLine(item.code) && item.code ? item.code : '未提供代碼';
    const name = singleLine(item.name) && item.name ? item.name : '服務項目名稱未取得';
    serviceOptions.push({ value: item.id, label: `${code} ${name}` });
  }
  const compatible = (name, value) => name === 'caseId' ? typeof value === 'string' && caseIds.has(value)
    : name === 'validFrom' || name === 'validTo' ? dateValid(value)
      : optional.has(name) ? typeof value === 'string' && !/\r/.test(value)
        : name === 'status' ? ['draft', 'active'].includes(value) : false;
  const controlNames = editing ? editControls : names;
  for (const name of controlNames) {
    const present = editing && own(original, name);
    const unsafe = editing && (name === 'services' || !present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: name === 'services' ? '保持時不更動整份原服務清單。選擇取代後只保存本次選擇，未選取的原項目會移除。'
          : `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = name === 'services' ? [] : editing ? unsafe ? '' : original[name]
      : name === 'caseId' ? caseIds.has(fixedCaseId) ? fixedCaseId : ''
        : name === 'validFrom' ? dateValid(defaultDate) ? defaultDate : '' : name === 'status' ? 'draft' : '';
    fields.push({ name, label: labels[name], type: name === 'services' ? 'services' : ['caseId', 'status'].includes(name) ? 'select'
      : ['validFrom', 'validTo'].includes(name) ? 'date' : 'textarea',
      required: name === 'services' || (!unsafe && !optional.has(name)), disabled: unsafe,
      ...(name === 'caseId' ? { placeholder: '請選擇個案', options: caseOptions.map(value => ({ ...value })) } : {}),
      ...(name === 'status' ? { options: ['draft', 'active'].map(value => ({ value, label: statuses[value] })), help: '只有生效中的照顧計畫可用來新增排班。' } : {}),
      ...(name === 'services' ? { wide: true, preserveWhenDisabled: true, options: serviceOptions.map(value => ({ ...value })), help: '填寫大於 0 的數量才會加入計畫；0 代表未選取。計畫數量不代表可用額度。' } : {}),
      ...(optional.has(name) ? { wide: true } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => requiredIntents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function replacement(name, value) {
    if (name === 'services') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100
        || Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))
        invalid(name, '請選擇 1 至 100 項服務並填寫數量。');
      const seen = new Set();
      return value.map(entry => {
        if (!plain(entry) || Object.keys(entry).length !== 2 || !own(entry, 'serviceItemId') || !own(entry, 'quantity')
          || typeof entry.serviceItemId !== 'string' || !serviceIds.has(entry.serviceItemId) || seen.has(entry.serviceItemId)
          || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 10000)
          invalid(name, '服務須為目前可選項目，數量須為 1 至 10000 的整數，且不能重複。');
        seen.add(entry.serviceItemId);
        return { serviceItemId: entry.serviceItemId, quantity: entry.quantity };
      });
    }
    if (!compatible(name, value) || value.length > (optional.has(name) ? 10000 : 500))
      invalid(name, '請提供符合此欄格式與範圍的內容；必要欄位不可空白。');
    return value;
  }
  function buildPayload(values) {
    if (!plain(values)) invalid('caseId', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of controlNames) {
      let value = valueOf(values, name);
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(optional.has(name) ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[name]) continue;
      value = replacement(name, value);
      if (!editing || !own(original, name) || JSON.stringify(original[name]) !== JSON.stringify(value)) put(payload, name, value);
    }
    return payload;
  }
  function confirm(item, orgId, payload) {
    try {
      if (!plain(item) || !plain(payload) || typeof orgId !== 'string' || !orgId.trim()
        || !own(item, 'id') || typeof item.id !== 'string' || !item.id.trim()
        || !own(item, 'orgId') || item.orgId !== orgId || !own(item, 'version') || !Number.isSafeInteger(item.version)
        || (editing ? !Number.isSafeInteger(identity.version) || identity.version < 1 || identity.version >= Number.MAX_SAFE_INTEGER
          || identity.orgId !== orgId || item.id !== identity.id || item.version !== identity.version + 1 : item.version !== 1)) unconfirmed();
      for (const name of Object.keys(payload)) if (!names.includes(name) && !(editing && name === 'version' && payload.version === identity.version)) unconfirmed();
      for (const name of names) {
        const supplied = own(payload, name), present = supplied || (editing && own(original, name));
        if ((!editing && !supplied) || own(item, name) !== present) unconfirmed();
        if (present && JSON.stringify(copyJson(item[name])) !== JSON.stringify(supplied ? copyJson(payload[name]) : original[name])) unconfirmed();
      }
    } catch { unconfirmed(); }
    return item;
  }
  return { initial: copyJson(baseline), fields, needsIntent, enabled, buildPayload, confirm };
}
