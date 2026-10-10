// The saved JSON baseline stays private. No network, DOM or mutable shared state.
export const PERSONAL_CALENDAR_STATUSES = Object.freeze([
  { value: 'active', label: '有效' }, { value: 'cancelled', label: '已取消' },
].map(item => Object.freeze(item)));
const names = ['title', 'date', 'startTime', 'endTime', 'note', 'status'];
const controls = names.filter(name => name !== 'status');
const labels = { title: '事件標題', date: '事件日期', startTime: '開始時間', endTime: '結束時間', note: '備註' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const identity = value => typeof value === 'string' && Boolean(value.trim());
const knownStatus = value => PERSONAL_CALENDAR_STATUSES.some(item => item.value === value);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function savedValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
  return descriptor.value;
}
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value')) invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
    put(result, key, copyJson(descriptor.value, ancestors));
  }
  if (Array.isArray(value) && (result.length !== value.length
    || Reflect.ownKeys(value).filter(key => key !== 'length').some((key, index) => key !== String(index))))
    invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.delete(value);
  return result;
}
export function personalCalendarIdentity(context) {
  return JSON.stringify([context.user?.id ?? null, context.organizationId ?? context.orgId ?? null,
    context.role ?? null, context.user?.employeeId ?? null]);
}
export function isPersonalCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export const isPersonalCalendarTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function kind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
export function formatPersonalCalendarText(value, present = value !== undefined) {
  if (!present) return '未保存';
  if (typeof value === 'string') return value || '未提供';
  return `保存${kind(true, value)}（內容未展示）`;
}
export const formatPersonalCalendarStatus = value => PERSONAL_CALENDAR_STATUSES.find(item => item.value === value)?.label
  || (typeof value === 'string' ? `保存文字：${value || '空字串'}` : formatPersonalCalendarText(value));

export function confirmPersonalCalendarList(result, { page, pageSize = 25, orgId, ownerUserId, q = '', status = '', date = '' } = {}) {
  try {
    result = copyJson(result);
    if (!plain(result) || Object.keys(result).sort().join(',') !== 'items,page,pageSize,total'
      || !Number.isSafeInteger(page) || page < 1 || pageSize !== 25 || !identity(orgId) || !identity(ownerUserId)
      || typeof q !== 'string' || q.length > 200 || status !== '' && !knownStatus(status) || date !== '' && !isPersonalCalendarDate(date)
      || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
      || result.page !== page || result.pageSize !== pageSize
      || result.items.length !== Math.min(pageSize, Math.max(0, result.total - (page - 1) * pageSize))
      || new Set(result.items.map(item => item?.id)).size !== result.items.length
      || result.items.some(item => !plain(item) || !own(item, 'id') || !identity(item.id)
        || !own(item, 'orgId') || item.orgId !== orgId || !own(item, 'ownerUserId') || item.ownerUserId !== ownerUserId
        || !own(item, 'version') || !Number.isSafeInteger(item.version) || item.version < 1
        || status !== '' && (!own(item, 'status') || item.status !== status)
        || date !== '' && (!own(item, 'date') || item.date !== date)
        || q !== '' && !['title', 'note'].some(name => own(item, name) && typeof item[name] === 'string'
          && item[name].toLowerCase().includes(q.toLowerCase())))) throw new Error();
  } catch { throw new Error('個人事件清單回應無法確認，請重新讀取。'); }
  return result;
}

export function createPersonalCalendarEditor({ existing, ownerUserId, defaultDate = '' } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (!identity(ownerUserId)) invalid('title', '本人事件身分無法確認，請重新讀取。');
  if (editing && !plain(existing)) invalid('title', '原個人事件資料無法確認，請重新讀取。');
  const original = {}, baseline = {}, fields = [], intents = new Set();
  const savedIdentity = editing ? Object.fromEntries(['id', 'orgId', 'ownerUserId', 'version'].filter(name => own(existing, name))
    .map(name => [name, copyJson(savedValue(existing, name))])) : null;
  if (editing && (!identity(savedIdentity.id) || !identity(savedIdentity.orgId) || savedIdentity.ownerUserId !== ownerUserId
    || !Number.isSafeInteger(savedIdentity.version) || savedIdentity.version < 1)) invalid('title', '原個人事件身分或版次無法確認，請重新讀取。');
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(savedValue(existing, name)));
  const lockedStatus = !editing || knownStatus(original.status);
  const valid = (name, value) => name === 'date' ? isPersonalCalendarDate(value)
    : ['startTime', 'endTime'].includes(name) ? isPersonalCalendarTime(value)
      : typeof value === 'string' && value.length <= (name === 'title' ? 200 : 10000)
        && (name !== 'title' || Boolean(value.trim()) && !/[\r\n]/.test(value));
  const compatible = (name, value) => valid(name, value) && !(name === 'note' && /\r/.test(value));
  for (const name of controls) {
    const present = editing && own(original, name), unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      intents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(name === 'note' ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${kind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? '' : original[name] : name === 'date' && isPersonalCalendarDate(defaultDate) ? defaultDate : '';
    fields.push({ name, label: labels[name], type: name === 'date' ? 'date' : ['startTime', 'endTime'].includes(name) ? 'time' : name === 'note' ? 'textarea' : 'text',
      required: !unsafe && name !== 'note', disabled: unsafe,
      ...(name === 'title' ? { maxLength: 200 } : {}), ...(name === 'note' ? { maxLength: 10000, help: '最多 10000 個字元；保持原備註時不更改其換行與前後空白。' } : {}),
      ...(name === 'date' ? { help: '以人工事件日期保存；不代表出勤或服務日期。' } : {}),
      ...(name === 'endTime' ? { help: '須晚於同日開始時間；跨夜請分為兩筆事件。' } : {}),
    });
  }
  if (lockedStatus) {
    baseline.status = editing ? original.status : 'active';
    fields.push({ name: 'status', label: '事件狀態', type: 'select', disabled: true,
      options: PERSONAL_CALENDAR_STATUSES.map(item => ({ ...item })),
      help: editing ? '保持原狀態；請使用列表上的「取消事件」或「恢復事件」。' : '新事件建立為有效；建立後可在列表取消。' });
  } else {
    baseline.statusRepair = 'keep';
    fields.push({ name: 'statusRepair', label: '事件狀態修復', type: 'select', required: true,
      options: [{ value: 'keep', label: '保持原值' }, ...PERSONAL_CALENDAR_STATUSES.map(item => ({ value: item.value, label: `明確改為${item.label}` }))],
      help: `保存類型：${kind(own(original, 'status'), original.status)}。未知狀態不推測；只有明確選擇才取代。` });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, name) => own(values, name) ? savedValue(values, name) : baseline[name];
  const needsIntent = name => intents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && name !== 'status' && plain(values)
    && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function buildPayload(values) {
    if (!plain(values)) invalid('title', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Reflect.ownKeys(values)) if (typeof key !== 'string' || !allowed.has(key)) invalid('title', '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of controls) {
      let value = valueOf(values, name);
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(name === 'note' ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[name]) continue;
      if (!valid(name, value)) invalid(name, `請提供符合${labels[name]}格式與範圍的內容。`);
      if (!editing || !own(original, name) || original[name] !== value) put(payload, name, value);
    }
    if (lockedStatus) {
      if (valueOf(values, 'status') !== baseline.status) invalid('status', '請使用列表上的「取消事件」或「恢復事件」变更事件狀態。');
      if (!editing) payload.status = 'active';
    } else {
      const repair = valueOf(values, 'statusRepair');
      if (repair !== 'keep' && !knownStatus(repair)) invalid('statusRepair', '請明確選擇有效的事件狀態。');
      if (repair !== 'keep') payload.status = repair;
    }
    const effective = name => own(payload, name) ? payload[name] : original[name];
    if ((!editing || own(payload, 'startTime') || own(payload, 'endTime'))
      && isPersonalCalendarTime(effective('startTime')) && isPersonalCalendarTime(effective('endTime'))
      && effective('endTime') <= effective('startTime')) invalid('endTime', '結束時間須晚於同日開始時間。');
    return payload;
  }
  function buildStatusChange(status) {
    if (!editing || !knownStatus(original.status) || !knownStatus(status) || status === original.status)
      invalid('status', '事件狀態無法確認，請重新讀取後再操作。');
    return { status };
  }
  function confirm(item, orgId, payload) {
    try {
      if (!plain(item) || !plain(payload) || !identity(orgId)) unconfirmed();
      const confirmed = {};
      for (const name of ['id', 'orgId', 'ownerUserId', 'version', ...names]) if (own(item, name)) put(confirmed, name, copyJson(savedValue(item, name)));
      item = confirmed; payload = copyJson(payload);
      if (!own(item, 'id') || !identity(item.id) || !own(item, 'orgId') || item.orgId !== orgId
        || !own(item, 'ownerUserId') || item.ownerUserId !== ownerUserId || !own(item, 'version') || !Number.isSafeInteger(item.version)
        || (editing ? savedIdentity.orgId !== orgId || savedIdentity.version >= Number.MAX_SAFE_INTEGER
          || item.id !== savedIdentity.id || item.version !== savedIdentity.version + 1 : item.version !== 1)) unconfirmed();
      for (const name of Object.keys(payload)) if (!names.includes(name)) unconfirmed();
      for (const name of names) {
        const supplied = own(payload, name), present = supplied || editing && own(original, name);
        if (!editing && !supplied || own(item, name) !== Boolean(present)) unconfirmed();
        if (present && JSON.stringify(item[name]) !== JSON.stringify(supplied ? payload[name] : original[name])) unconfirmed();
      }
    } catch { unconfirmed(); }
    return item;
  }
  return { initial: { ...baseline }, fields, needsIntent, enabled, buildPayload, buildStatusChange, confirm };
}
