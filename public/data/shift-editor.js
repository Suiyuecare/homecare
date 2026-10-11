import { createEndDateControl } from './shift-span-editor.js';
// Pure single-shift adapter. Saved JSON and selectable membership remain private.
const names = ['caseId', 'employeeId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note', 'endDate'];
const controls = ['carePlanId', 'employeeId', 'date', 'startTime', 'endTime', 'services', 'note'];
const labels = { carePlanId: '個案與照顧計畫', employeeId: '服務人員', date: '服務日期', startTime: '開始時間', endTime: '結束時間', services: '本次服務與數量', note: '交班備註' };
const statuses = { scheduled: '已排班', completed: '已完成', cancelled: '已取消' };
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const singleLine = value => typeof value === 'string' && !/[\r\n]/.test(value);
const safeId = value => singleLine(value) && value.trim() !== '' && value.length <= 500;
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('carePlanId', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))))
    invalid('carePlanId', '保存資料不是可安全保留的 JSON，請重新讀取。');
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
const nativeTime = value => typeof value === 'string' && value.length === 5 && /^\d{2}:\d{2}$/.test(value)
  && Number(value.slice(0, 2)) < 24 && Number(value.slice(3)) < 60;
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
export const formatShiftText = value => typeof value === 'string' ? value || '未提供' : value === undefined ? '未提供' : '未取得';
export const formatShiftDate = value => dateValid(value, true) ? value.replaceAll('-', '/') : value === '' || value === undefined ? '未提供' : '日期未取得';
export const formatShiftTime = value => nativeTime(value) || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
  && dateValid(value.slice(0, 10), true) && nativeTime(value.slice(11, 16)) && Number.isFinite(Date.parse(value)))
  ? value : value === '' || value === undefined ? '未提供' : '時間未取得';
export const formatShiftStatus = value => value === '' || value === undefined ? '未提供' : typeof value === 'string' && own(statuses, value) ? statuses[value] : '狀態未取得';
export function formatShiftServices(services, items) {
  if (!Array.isArray(services)) return '服務明細未取得';
  if (!services.length) return '尚未設定';
  if (Object.keys(services).length !== services.length || Object.keys(services).some((key, index) => key !== String(index))) return '服務明細未取得';
  return services.map(entry => {
    if (!plain(entry)) return '服務明細未取得';
    const item = own(entry, 'serviceItemId') && typeof entry.serviceItemId === 'string' && items instanceof Map ? items.get(entry.serviceItemId) : null;
    const name = plain(item) && own(item, 'name') && typeof item.name === 'string' && item.name ? item.name : '服務項目名稱未取得';
    const code = plain(item) && own(item, 'code') && typeof item.code === 'string' && item.code ? item.code + ' ' : '';
    const quantity = own(entry, 'quantity') && Number.isSafeInteger(entry.quantity) && entry.quantity >= 1 && entry.quantity <= 10000 ? String(entry.quantity) : '數量未取得';
    return `${code}${name} × ${quantity}`;
  }).join('、');
}

export function createShiftEditor({ existing, cases = [], employees = [], carePlans = [], serviceItems = [], defaultDate = '', fixedPlanId = '' } = {}) {
  const editing = existing !== undefined && existing !== null;
  const spanControl = createEndDateControl({ existing, entity: 'shifts' });
  if (editing && !plain(existing)) invalid('carePlanId', '原班次資料格式無法取得，請重新讀取。');
  const original = {}, baseline = {}, fields = [], requiredIntents = new Set();
  const identity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(existing[name])])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(existing[name]));
  const caseItems = new Map();
  for (const item of Array.isArray(cases) ? cases : []) {
    if (!plain(item) || !own(item, 'id') || !safeId(item.id) || caseItems.has(item.id)) continue;
    caseItems.set(item.id, { active: own(item, 'status') && item.status === 'active',
      name: own(item, 'name') && singleLine(item.name) && item.name ? item.name : '個案名稱未取得' });
  }
  const plans = new Map(), planOptions = [];
  const fixed = !editing && fixedPlanId !== '';
  for (const item of Array.isArray(carePlans) ? carePlans : []) {
    if (!plain(item) || !own(item, 'id') || !safeId(item.id) || plans.has(item.id) || (fixed && item.id !== fixedPlanId)) continue;
    const caseId = own(item, 'caseId') && safeId(item.caseId) && caseItems.has(item.caseId) ? item.caseId : null;
    if (!((own(item, 'status') && item.status === 'active' && caseId !== null && caseItems.get(caseId).active)
      || (editing && item.id === original.carePlanId))) continue;
    const serviceIds = new Set();
    for (const entry of own(item, 'services') && Array.isArray(item.services) ? item.services : [])
      if (plain(entry) && own(entry, 'serviceItemId') && safeId(entry.serviceItemId)) serviceIds.add(entry.serviceItemId);
    plans.set(item.id, { caseId, serviceIds });
    planOptions.push({ value: item.id, label: `${caseId === null ? '個案名稱未取得' : caseItems.get(caseId).name}｜${formatShiftDate(own(item, 'validFrom') ? item.validFrom : undefined)} 起${own(item, 'validTo') && item.validTo ? `至 ${formatShiftDate(item.validTo)}` : ''}` });
  }
  const employeeIds = new Set(), employeeOptions = [];
  for (const item of Array.isArray(employees) ? employees : []) {
    if (!plain(item) || !own(item, 'id') || !safeId(item.id) || employeeIds.has(item.id)
      || !((own(item, 'status') && item.status === 'active') || (editing && item.id === original.employeeId))) continue;
    employeeIds.add(item.id);
    const number = own(item, 'employeeNo') && singleLine(item.employeeNo) && item.employeeNo ? item.employeeNo : '';
    const name = own(item, 'name') && singleLine(item.name) && item.name ? item.name : '服務人員名稱未取得';
    employeeOptions.push({ value: item.id, label: `${number} ${name}`.trim() });
  }
  const services = [], serviceIds = new Set();
  for (const item of Array.isArray(serviceItems) ? serviceItems : []) {
    if (!plain(item) || !own(item, 'id') || !safeId(item.id) || serviceIds.has(item.id)) continue;
    serviceIds.add(item.id);
    const code = own(item, 'code') && singleLine(item.code) && item.code ? item.code : '未提供代碼';
    const name = own(item, 'name') && singleLine(item.name) && item.name ? item.name : '服務項目名稱未取得';
    services.push({ value: item.id, label: `${code} ${name}` });
  }
  const compatible = (name, value) => name === 'carePlanId' ? typeof value === 'string' && plans.has(value)
    : name === 'employeeId' ? typeof value === 'string' && employeeIds.has(value)
      : name === 'date' ? dateValid(value) : ['startTime', 'endTime'].includes(name) ? nativeTime(value)
        : name === 'note' ? typeof value === 'string' && !/\r/.test(value) : false;
  for (const name of controls) {
    const present = editing && own(original, name);
    const unsafe = editing && (name === 'services' || !present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(name === 'note' ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: name === 'services' ? '保持時不更動整份原服務清單。選擇取代後只保存本次選擇，未選取的原項目會移除。'
          : `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = name === 'services' ? [] : editing ? unsafe ? '' : original[name]
      : name === 'carePlanId' ? planOptions[0]?.value || '' : name === 'date' ? dateValid(defaultDate) ? defaultDate : ''
        : name === 'startTime' ? '09:00' : name === 'endTime' ? '10:00' : '';
    fields.push({ name, label: labels[name], type: name === 'services' ? 'services' : ['carePlanId', 'employeeId'].includes(name) ? 'select'
      : name === 'date' ? 'date' : ['startTime', 'endTime'].includes(name) ? 'time' : 'textarea',
      required: name === 'services' || (!unsafe && name !== 'note'), disabled: unsafe,
      ...(name === 'carePlanId' ? { options: planOptions.map(value => ({ ...value })), help: '更換計畫不會更動保持的服務清單；服務與日期仍須通過既有計畫驗證。' } : {}),
      ...(name === 'employeeId' ? { placeholder: '請選擇服務人員', options: employeeOptions.map(value => ({ ...value })) } : {}),
      ...(name === 'services' ? { wide: true, preserveWhenDisabled: true, options: [], help: '填寫大於 0 的數量才會加入本次服務；0 代表未選取。計畫數量不代表班次数量額度。更換計畫時，取代輸入只保留新計畫仍可選的項目；保持原清單不受影響。' } : {}),
      ...(name === 'note' ? { wide: true, help: editing ? '已有服務紀錄的班次不能改派、改時段或取消。' : '排班重疊、已核准請假或計畫不適用時，系統會拒絕儲存。' } : {}),
      ...(['startTime', 'endTime'].includes(name) ? { help: '舊同日格式保持原 ISO 原文；完整日期模式須明確填 HH:mm 與同日／翌日結束日。' } : {}),
    });
  }
  Object.assign(baseline, spanControl.initial);
  fields.unshift(spanControl.fields[0]);
  const dateIndex = fields.findIndex(field => field.name === 'date');
  fields.splice(dateIndex + 1, 0, ...spanControl.fields.slice(1));
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => requiredIntents.has(name) || ['spanMode', 'endDate', 'endDateIntent'].includes(name);
  const enabled = (name, values = {}) => spanControl.enabled(name, values) ?? (allowed.has(name) && plain(values) && (!requiredIntents.has(name) || valueOf(values, name + 'Intent') === 'replace'));
  function selectedPlan(values) {
    if (!plain(values)) return null;
    const planId = needsIntent('carePlanId') && valueOf(values, 'carePlanIdIntent') === 'keep' ? original.carePlanId : valueOf(values, 'carePlanId');
    return typeof planId === 'string' ? plans.get(planId) || null : null;
  }
  function serviceOptions(values = {}) {
    const plan = selectedPlan(values);
    return plan ? services.filter(option => plan.serviceIds.has(option.value)).map(option => ({ ...option })) : [];
  }
  fields.find(field => field.name === 'services').options = serviceOptions();
  function replacement(name, value, values) {
    if (name === 'services') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100
        || Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))
        invalid(name, '請選擇 1 至 100 項服務並填寫數量。');
      const choices = new Set(serviceOptions(values).map(option => option.value)), seen = new Set();
      return value.map(entry => {
        if (!plain(entry) || Object.keys(entry).length !== 2 || !own(entry, 'serviceItemId') || !own(entry, 'quantity')
          || typeof entry.serviceItemId !== 'string' || !choices.has(entry.serviceItemId) || seen.has(entry.serviceItemId)
          || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 10000)
          invalid(name, '服務須為目前所選計畫的可選項目，數量須為 1 至 10000 的整數，且不能重複。');
        seen.add(entry.serviceItemId);
        return { serviceItemId: entry.serviceItemId, quantity: entry.quantity };
      });
    }
    if (!compatible(name, value) || value.length > (name === 'note' ? 10000 : 500))
      invalid(name, '請提供符合此欄格式與範圍的內容；必要欄位不可空白。');
    return value;
  }
  function buildPayload(values) {
    if (!plain(values)) invalid('carePlanId', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Reflect.ownKeys(values)) {
      const descriptor = Object.getOwnPropertyDescriptor(values, key);
      if (typeof key !== 'string' || !allowed.has(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(typeof key === 'string' ? key : 'spanMode', '表單包含未知欄位或存取器，請重新讀取。');
    }
    const payload = {};
    for (const name of controls) {
      let value = valueOf(values, name);
      if (requiredIntents.has(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(name === 'note' ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[name]) continue;
      value = replacement(name, value, values);
      if (!editing || !own(original, name) || JSON.stringify(original[name]) !== JSON.stringify(value)) put(payload, name, value);
    }
    if (!editing || own(payload, 'carePlanId')) {
      const plan = plans.get(payload.carePlanId);
      if (!plan || plan.caseId === null) invalid('carePlanId', '請選擇對應可讀個案的照顧計畫。');
      if (!editing || !own(original, 'caseId') || original.caseId !== plan.caseId) put(payload, 'caseId', plan.caseId);
    }
    if (!editing) payload.status = 'scheduled';
    return spanControl.apply(payload, values, original);
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
        if ((!editing && !supplied && name !== 'endDate') || own(item, name) !== present) unconfirmed();
        if (present && JSON.stringify(copyJson(item[name])) !== JSON.stringify(supplied ? copyJson(payload[name]) : original[name])) unconfirmed();
      }
    } catch { unconfirmed(); }
    return item;
  }
  return { initial: copyJson(baseline), fields, needsIntent, enabled, serviceOptions, buildPayload, confirm };
}
