// Pure adapter: keep saved JSON and option membership outside mutable form descriptors.
const names = ['employeeId', 'name', 'certificateNo', 'issuer', 'issuedOn', 'expiresOn', 'status', 'note'];
const controls = names.filter(name => name !== 'status');
const optional = new Set(['certificateNo', 'issuer', 'expiresOn', 'note']);
const labels = { employeeId: '員工', name: '證照名稱', certificateNo: '證照編號', issuer: '發證單位', issuedOn: '發證日期', expiresOn: '到期日期', note: '備註' };
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
const singleLine = value => typeof value === 'string' && !/[\r\n]/.test(value);
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}

export function createCertificationEditor({ existing, employees = [], defaultDate = '', defaultEmployeeId = '' } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('employeeId', '原證照資料格式無法取得，請重新讀取。');
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
    : name === 'issuedOn' ? nativeDate(value) : name === 'expiresOn' ? value === '' || nativeDate(value)
      : name === 'note' ? typeof value === 'string' && !/\r/.test(value) : singleLine(value);
  function replacement(name, value) {
    if (!compatible(name, value)) invalid(name, '請提供符合此欄格式的內容。');
    if (name === 'name') value = value.trim();
    if (value.length > (name === 'note' ? 10000 : 500) || (!optional.has(name) && value === ''))
      invalid(name, '請提供符合此欄範圍的內容；必要欄位不可空白。');
    return value;
  }
  const original = {}, baseline = {}, fields = [], requiredIntents = new Set();
  const identity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(existing[name])])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(existing[name]));
  for (const name of controls) {
    const present = editing && own(original, name), unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe && name !== 'employeeId') {
      requiredIntents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? '' : original[name]
      : name === 'issuedOn' ? nativeDate(defaultDate) ? defaultDate : ''
        : name === 'employeeId' && typeof defaultEmployeeId === 'string' && employeeIds.has(defaultEmployeeId) ? defaultEmployeeId : '';
    fields.push({ name, label: labels[name], type: name === 'employeeId' ? 'select'
      : ['issuedOn', 'expiresOn'].includes(name) ? 'date' : name === 'note' ? 'textarea' : 'text',
      required: !unsafe && !optional.has(name) && !(editing && name === 'employeeId'), disabled: unsafe || (editing && name === 'employeeId'),
      ...(name === 'employeeId' ? { options: employeeOptions.map(option => ({ ...option })),
        ...(editing ? { help: unsafe ? '所屬員工無法在目前可讀選項中表示；保留原歸屬且不可在此更換。' : '建立後不可更換所屬員工。' } : {}) } : {}),
      ...(name === 'note' ? { wide: true } : {}),
      ...(name === 'expiresOn' ? { help: '留空表示尚未提供到期日期；日期不可早於發證日期。' } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => requiredIntents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && !(editing && name === 'employeeId') && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function buildPayload(values) {
    if (!plain(values)) invalid('employeeId', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of controls) {
      let value = valueOf(values, name);
      if (editing && name === 'employeeId') {
        if (value !== baseline[name]) invalid(name, '建立後不可更換所屬員工。');
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
    if (!editing) payload.status = 'active';
    return payload;
  }
  function confirm(item, orgId, payload) {
    try {
      if (!plain(item) || !plain(payload) || typeof orgId !== 'string' || !orgId.trim()
        || !own(item, 'id') || typeof item.id !== 'string' || !item.id.trim()
        || !own(item, 'orgId') || item.orgId !== orgId || !own(item, 'version') || !Number.isSafeInteger(item.version)
        || (editing ? !Number.isSafeInteger(identity.version) || identity.version < 1 || identity.version >= Number.MAX_SAFE_INTEGER
          || identity.orgId !== orgId || item.id !== identity.id || item.version !== identity.version + 1 : item.version !== 1)) unconfirmed();
      for (const name of Object.keys(payload)) if ((editing && name === 'employeeId') || !names.includes(name) && !(editing && name === 'version' && payload.version === identity.version)) unconfirmed();
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
