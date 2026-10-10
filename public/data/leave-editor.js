// Pure adapter: keep saved JSON and option membership outside mutable form descriptors.
const names = ['employeeId', 'date', 'startTime', 'endTime', 'type', 'reason', 'status'];
const controls = names.slice(0, -1);
const labels = { employeeId: '員工', date: '請假日期', startTime: '開始時間', endTime: '結束時間', type: '假別', reason: '請假原因' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('employeeId', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}
function nativeDate(value) {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
const nativeTime = value => typeof value === 'string' && value.length === 5 && /^\d{2}:\d{2}$/.test(value)
  && Number(value.slice(0, 2)) < 24 && Number(value.slice(3)) < 60;
const singleLine = value => typeof value === 'string' && !/[\r\n]/.test(value);
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}

export function createLeaveEditor({ existing, employees = [], defaultDate = '' } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('employeeId', '原請假資料格式無法取得，請重新讀取。');
  const employeeIds = new Set(), employeeOptions = [];
  for (const employee of Array.isArray(employees) ? employees : []) {
    if (!plain(employee) || !own(employee, 'id') || !singleLine(employee.id) || !employee.id.trim()
      || employee.id.length > 500 || employeeIds.has(employee.id)) continue;
    employeeIds.add(employee.id);
    const name = own(employee, 'name') && singleLine(employee.name) && employee.name.trim() ? employee.name : '未提供姓名';
    const number = own(employee, 'employeeNo') && singleLine(employee.employeeNo) && employee.employeeNo.trim() ? employee.employeeNo : '';
    employeeOptions.push({ value: employee.id, label: name + (number ? ` · ${number}` : '') });
  }
  const compatible = (name, value) => name === 'employeeId' ? typeof value === 'string' && employeeIds.has(value)
    : name === 'date' ? nativeDate(value) : ['startTime', 'endTime'].includes(name) ? nativeTime(value)
      : name === 'reason' ? typeof value === 'string' && !/\r/.test(value) : singleLine(value);
  function replacement(name, value) {
    if (!compatible(name, value) || value.length > (name === 'reason' ? 10000 : 500) || (name !== 'reason' && value === ''))
      invalid(name, '請提供符合此欄格式與範圍的內容；必要欄位不可空白。');
    return value;
  }
  const original = {}, baseline = {}, fields = [], requiredIntents = new Set();
  const identity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(existing[name])])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(existing[name]));
  for (const name of controls) {
    const present = editing && own(original, name), unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(name === 'reason' ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? '' : original[name]
      : name === 'date' ? nativeDate(defaultDate) ? defaultDate : '' : name === 'startTime' ? '09:00' : name === 'endTime' ? '10:00' : '';
    fields.push({ name, label: labels[name], type: name === 'employeeId' ? 'select' : name === 'date' ? 'date'
      : ['startTime', 'endTime'].includes(name) ? 'time' : name === 'reason' ? 'textarea' : 'text',
      required: !unsafe && name !== 'reason', disabled: unsafe,
      ...(name === 'employeeId' ? { options: employeeOptions.map(option => ({ ...option })) } : {}),
      ...(name === 'reason' ? { wide: true } : {}),
      ...(name === 'type' ? { help: '由機構依實際假別填寫。' } : {}),
      ...(['startTime', 'endTime'].includes(name) ? { help: '取代時填同日時間；保留原 ISO 時段不截短或換算，改日期後仍須通過同日驗證。' } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => requiredIntents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function buildPayload(values) {
    if (!plain(values)) invalid('employeeId', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of controls) {
      let value = valueOf(values, name);
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(name === 'reason' ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[name]) continue;
      value = replacement(name, value);
      if (!editing || !own(original, name) || JSON.stringify(original[name]) !== JSON.stringify(value)) payload[name] = value;
    }
    if (!editing) payload.status = 'pending';
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
  return { initial: { ...baseline }, fields, needsIntent, enabled, buildPayload, confirm };
}
