// Pure adapter. Saved JSON and the acknowledgement baseline remain private.
export const INTERVIEW_STATUSES = Object.freeze([
  { value: 'active', label: '啟用' }, { value: 'inactive', label: '停用' },
].map(item => Object.freeze(item)));
const names = ['name', 'phone', 'interviewDate', 'city', 'district', 'interviewContent', 'note', 'status'];
const optional = new Set(['city', 'district', 'note']);
const singleLine = new Set(['name', 'phone', 'city', 'district']);
const labels = { name: '姓名', phone: '電話', interviewDate: '面試日期', city: '縣市', district: '鄉鎮區', interviewContent: '面試內容', note: '備註', status: '名單狀態' };
const limits = { name: 200, phone: 64, city: 100, district: 100, interviewContent: 10000, note: 10000 };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('name', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}
export function isInterviewDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
export const formatInterviewText = value => typeof value === 'string' ? value || '未提供' : value === undefined ? '未提供' : '內容未取得';
export const formatInterviewDate = value => isInterviewDate(value) ? value.replaceAll('-', '/') : value === '' || value === undefined ? '未提供' : '日期未取得';
export const formatInterviewStatus = value => INTERVIEW_STATUSES.find(item => item.value === value)?.label || '狀態未取得';

export function confirmInterviewApplicantList(result, { page, pageSize = 25, orgId, status = '', interviewDate = '' } = {}) {
  const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && !/[\r\n]/.test(value);
  if (!plain(result) || Object.keys(result).sort().join(',') !== 'items,page,pageSize,total'
    || !Number.isSafeInteger(page) || page < 1 || pageSize !== 25 || !identity(orgId)
    || status !== '' && !INTERVIEW_STATUSES.some(item => item.value === status) || interviewDate !== '' && !isInterviewDate(interviewDate)
    || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
    || result.page !== page || result.pageSize !== pageSize
    || result.items.length !== Math.min(pageSize, Math.max(0, result.total - (page - 1) * pageSize))
    || new Set(result.items.map(item => item?.id)).size !== result.items.length
    || result.items.some(item => !plain(item) || !own(item, 'id') || !identity(item.id)
      || !own(item, 'orgId') || item.orgId !== orgId || !own(item, 'version') || !Number.isSafeInteger(item.version) || item.version < 1
      || status !== '' && (!own(item, 'status') || item.status !== status)
      || interviewDate !== '' && (!own(item, 'interviewDate') || item.interviewDate !== interviewDate)))
    throw new Error('面試者清單回應無法確認，請重新讀取。');
  return result;
}

export function createInterviewApplicantEditor({ existing, defaultDate = '' } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('name', '原面試紀錄無法確認，請重新讀取。');
  const original = {}, baseline = {}, fields = [], intents = new Set();
  const identity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(existing[name])])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(existing[name]));
  const statusValues = new Set(INTERVIEW_STATUSES.map(item => item.value));
  const lockedStatus = editing && statusValues.has(original.status);
  const compatible = (name, value) => name === 'status' ? statusValues.has(value)
    : name === 'interviewDate' ? isInterviewDate(value)
      : typeof value === 'string' && value.length <= limits[name]
        && !(singleLine.has(name) ? /[\r\n]/.test(value) : /\r/.test(value))
        && (optional.has(name) || Boolean(value.trim()));
  function replacement(name, value) {
    if (typeof value !== 'string') invalid(name, '請填寫符合此欄格式的文字。');
    const result = value.trim();
    if (!compatible(name, result)) invalid(name, name === 'interviewDate' ? '請提供有效的面試日期。' : `請提供符合${labels[name]}格式與範圍的內容。`);
    return result;
  }
  for (const name of names) {
    const present = editing && own(original, name), unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      intents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? '' : original[name] : name === 'status' ? 'active' : name === 'interviewDate' && isInterviewDate(defaultDate) ? defaultDate : '';
    fields.push({ name, label: labels[name], type: name === 'status' ? 'select' : name === 'interviewDate' ? 'date' : ['interviewContent', 'note'].includes(name) ? 'textarea' : 'text',
      required: !unsafe && !optional.has(name) && !(name === 'status' && lockedStatus), disabled: unsafe || name === 'status' && lockedStatus,
      ...(name === 'status' ? { options: INTERVIEW_STATUSES.map(item => ({ ...item })), help: lockedStatus ? '名單狀態保持原值；請使用列表上的「啟用」或「停用」。不代表錄取或到職。' : '只代表名單啟用或停用，不代表錄取或到職。' } : {}),
      ...(limits[name] ? { maxLength: limits[name] } : {}),
      ...(name === 'interviewDate' ? { help: '人工記錄的面試日期。' } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => intents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && !(name === 'status' && lockedStatus)
    && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function buildPayload(values) {
    if (!plain(values)) invalid('name', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of names) {
      let value = valueOf(values, name);
      if (name === 'status' && lockedStatus) {
        if (value !== baseline.status) invalid(name, '請使用列表上的「啟用」或「停用」變更名單狀態。');
        continue;
      }
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(optional.has(name) ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[name]) continue;
      value = replacement(name, value);
      if (!editing || !own(original, name) || JSON.stringify(original[name]) !== JSON.stringify(value)) payload[name] = value;
    }
    return payload;
  }
  function buildStatusChange(status) {
    if (!editing || !statusValues.has(original.status) || !statusValues.has(status) || status === original.status)
      invalid('status', '名單狀態無法確認，請重新讀取後再操作。');
    return { status };
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
  return { initial: { ...baseline }, fields, needsIntent, enabled, buildPayload, buildStatusChange, confirm };
}
