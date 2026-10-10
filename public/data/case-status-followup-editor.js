// Pure adapter. The fixed parent, saved JSON and confirmation baseline stay private.
export const FOLLOWUP_KINDS = Object.freeze([
  { value: 'pause', label: '暫停' }, { value: 'closure', label: '結案' },
].map(item => Object.freeze(item)));
export const FOLLOWUP_STATUSES = Object.freeze([
  { value: 'pending', label: '待追蹤' }, { value: 'completed', label: '已完成追蹤' },
  { value: 'cancelled', label: '已取消追蹤' },
].map(item => Object.freeze(item)));
const names = ['caseId', 'kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status'];
const controls = names.filter(name => name !== 'caseId');
const optional = new Set(['endDate', 'followUpDate', 'outcome', 'note']);
const labels = { kind: '追蹤類型', startDate: '開始日期', endDate: '結束日期', reason: '原因', followUpDate: '追蹤日期', outcome: '追蹤結果', note: '備註', status: '追蹤狀態' };
const limits = { reason: 10000, note: 10000, outcome: 500 };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('reason', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}
function nativeDate(value) {
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
export const formatFollowupText = value => typeof value === 'string' ? value || '未提供' : value === undefined ? '未提供' : '內容未取得';
export const formatFollowupDate = value => nativeDate(value) ? value.replaceAll('-', '/') : value === '' || value === undefined ? '未提供' : '日期未取得';
export const formatFollowupKind = value => FOLLOWUP_KINDS.find(item => item.value === value)?.label || (typeof value === 'string' && value ? '類型未取得' : '未提供');
export const formatFollowupStatus = value => FOLLOWUP_STATUSES.find(item => item.value === value)?.label || '狀態未取得';

export function createCaseStatusFollowupEditor({ existing, caseId, defaultDate = '' } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (typeof caseId !== 'string' || !caseId.trim() || caseId !== caseId.trim() || caseId.length > 500 || /[\r\n]/.test(caseId))
    invalid('reason', '所屬個案無法確認，請重新讀取。');
  if (editing && (!plain(existing) || !own(existing, 'caseId') || existing.caseId !== caseId))
    invalid('reason', '原追蹤資料的所屬個案無法確認，請重新讀取。');
  const original = {}, baseline = {}, fields = [], intents = new Set();
  const identity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(existing[name])])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(existing[name]));
  const kindValues = new Set(FOLLOWUP_KINDS.map(item => item.value));
  // Cancel and reopen share the confirmed card action. Cancelled forms keep status.
  const cancelled = editing && original.status === 'cancelled';
  const statusOptions = FOLLOWUP_STATUSES.filter(item => cancelled ? item.value === 'cancelled' : item.value !== 'cancelled');
  const statusValues = new Set(statusOptions.map(item => item.value));
  const compatible = (name, value) => name === 'kind' ? kindValues.has(value)
    : name === 'status' ? statusValues.has(value)
      : ['startDate', 'endDate', 'followUpDate'].includes(name) ? optional.has(name) && value === '' || nativeDate(value)
        : typeof value === 'string' && value.length <= limits[name]
          && !(/[\r\n]/.test(value) && name === 'outcome') && !(/\r/.test(value) && ['reason', 'note'].includes(name))
          && (optional.has(name) || Boolean(value.trim()));
  function replacement(name, value) {
    if (typeof value !== 'string') invalid(name, '請填寫符合此欄格式的文字。');
    const result = value.trim();
    if (!compatible(name, result)) invalid(name, name === 'reason' ? '請填寫原因，最多 10000 個字元。' : '請提供符合此欄格式與範圍的內容。');
    return result;
  }
  for (const name of controls) {
    const present = editing && own(original, name), unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      intents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? '' : original[name] : name === 'kind' ? 'pause' : name === 'status' ? 'pending' : name === 'startDate' && nativeDate(defaultDate) ? defaultDate : '';
    fields.push({ name, label: labels[name], type: ['kind', 'status'].includes(name) ? 'select' : ['startDate', 'endDate', 'followUpDate'].includes(name) ? 'date' : ['reason', 'note'].includes(name) ? 'textarea' : 'text',
      required: !unsafe && !optional.has(name) && !(name === 'status' && cancelled), disabled: unsafe || name === 'status' && cancelled,
      ...(['kind', 'status'].includes(name) ? { options: (name === 'kind' ? FOLLOWUP_KINDS : statusOptions).map(item => ({ ...item })) } : {}),
      ...(limits[name] ? { maxLength: limits[name] } : {}),
      ...(name === 'kind' ? { help: '建立後仍屬於這筆個案；這裡只保存追蹤紀錄。' } : {}),
      ...(name === 'reason' ? { help: '記錄實際原因，最多 10000 個字元。' } : {}),
      ...(name === 'status' ? { help: cancelled ? '這筆追蹤已取消；狀態保持。請先使用紀錄卡上的「恢復追蹤」，再變更完成狀態。' : '人工追蹤狀態，不會更改個案服務狀態或班次。取消追蹤請使用紀錄卡上的動作。' } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => intents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && !(name === 'status' && cancelled) && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function buildPayload(values) {
    if (!plain(values)) invalid('reason', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of controls) {
      let value = valueOf(values, name);
      if (name === 'status' && cancelled) {
        if (value !== baseline.status) invalid(name, '請先使用紀錄卡上的「恢復追蹤」，再變更完成狀態。');
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
    if (!editing) payload.caseId = caseId;
    const start = own(payload, 'startDate') ? payload.startDate : original.startDate;
    const end = own(payload, 'endDate') ? payload.endDate : original.endDate;
    if (nativeDate(start) && nativeDate(end) && end < start) invalid('endDate', '結束日期不得早於開始日期。');
    return payload;
  }
  function buildStatusChange(status) {
    if (!editing || !FOLLOWUP_STATUSES.some(item => item.value === original.status)
      || !(status === 'cancelled' && original.status !== 'cancelled' || status === 'pending' && original.status === 'cancelled'))
      invalid('status', '追蹤狀態無法確認，請重新讀取後再操作。');
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
      if (own(payload, 'caseId') && payload.caseId !== caseId) unconfirmed();
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
