// Pure case adapter: saved values and option membership remain private and lossless.
const names = ['name', 'caseNo', 'birthDate', 'gender', 'phone', 'address', 'status', 'cmsLevel', 'welfare', 'supervisorId', 'primaryCarer', 'contactName', 'contactPhone', 'note'];
const controls = names.filter(name => name !== 'status');
const optional = new Set(controls.filter(name => !['name', 'caseNo'].includes(name)));
const labels = { name: '姓名', caseNo: '案號', birthDate: '出生日期', gender: '性別', phone: '聯絡電話', address: '服務地址', cmsLevel: 'CMS 等級', welfare: '福利身分別', supervisorId: '主責督導', primaryCarer: '主要照顧者', contactName: '聯絡人姓名', contactPhone: '聯絡人電話', note: '照顧注意事項' };
const genderLabels = { female: '女性', male: '男性', other: '其他' };
const statuses = { active: '服務中', paused: '暫停', closed: '結案' };
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
const singleLine = value => typeof value === 'string' && !/[\r\n]/.test(value);
const validCms = value => Number.isSafeInteger(value) && value >= 1 && value <= 8;
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
export const formatCaseText = value => typeof value === 'string' ? value || '未提供' : value === undefined ? '未提供' : '未取得';
export const formatCaseCms = value => validCms(value) ? String(value) : value === '' || value === undefined ? '未提供' : '未取得';
export const formatCaseBirthDate = value => dateValid(value, true) ? value.replaceAll('-', '/') : value === '' || value === undefined ? '未提供' : '日期未取得';
export const formatCaseStatus = value => typeof value === 'string' ? own(statuses, value) ? statuses[value] : value || '未提供' : '狀態未取得';

export function createCaseEditor({ existing, employees = [] } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('name', '原個案資料格式無法取得，請重新讀取。');
  const original = {}, baseline = {}, fields = [], requiredIntents = new Set();
  const identity = editing ? Object.fromEntries(['id', 'orgId', 'version'].filter(name => own(existing, name)).map(name => [name, copyJson(existing[name])])) : null;
  for (const name of names) if (editing && own(existing, name)) put(original, name, copyJson(existing[name]));
  const supervisorIds = new Set(), supervisorOptions = [];
  for (const employee of Array.isArray(employees) ? employees : []) {
    if (!plain(employee) || !own(employee, 'id') || !singleLine(employee.id) || !employee.id.trim() || employee.id.length > 500
      || supervisorIds.has(employee.id) || !((employee.status === 'active' && ['admin', 'supervisor'].includes(employee.role)) || (editing && employee.id === original.supervisorId))) continue;
    supervisorIds.add(employee.id);
    supervisorOptions.push({ value: employee.id, label: own(employee, 'name') && singleLine(employee.name) && employee.name ? employee.name : '未提供姓名' });
  }
  const genders = ['未指定', '女性', '男性', '其他'].map(value => ({ value, label: value }));
  if (editing && singleLine(original.gender) && original.gender && !genders.some(option => option.value === original.gender))
    genders.push({ value: original.gender, label: own(genderLabels, original.gender) ? genderLabels[original.gender] : original.gender });
  const genderValues = new Set(genders.map(option => option.value));
  const compatible = (name, value) => name === 'cmsLevel' ? value === '' || validCms(value)
    : name === 'birthDate' ? value === '' || dateValid(value)
      : name === 'supervisorId' ? value === '' || typeof value === 'string' && supervisorIds.has(value)
        : name === 'gender' ? value === '' || typeof value === 'string' && genderValues.has(value)
          : name === 'note' ? typeof value === 'string' && !/\r/.test(value) : singleLine(value);
  function replacement(name, value) {
    if (name === 'cmsLevel') {
      if (value === null || value === '') return '';
      if (!validCms(value)) invalid(name, '請輸入 1 至 8 的整數，或明確留空。');
      return value;
    }
    if (!compatible(name, value) || value.length > (name === 'note' ? 10000 : 500) || (!optional.has(name) && value === ''))
      invalid(name, '請提供符合此欄格式與範圍的內容；必要欄位不可空白。');
    return value;
  }
  for (const name of controls) {
    const present = editing && own(original, name), unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? name === 'cmsLevel' ? null : '' : name === 'cmsLevel' && original[name] === '' ? null : original[name]
      : name === 'cmsLevel' ? null : name === 'gender' ? '未指定' : '';
    fields.push({ name, label: labels[name], type: ['gender', 'supervisorId'].includes(name) ? 'select' : name === 'birthDate' ? 'date'
      : name === 'cmsLevel' ? 'number' : name === 'note' ? 'textarea' : ['phone', 'contactPhone'].includes(name) ? 'tel' : 'text',
      required: !unsafe && !optional.has(name), disabled: unsafe,
      ...(name === 'supervisorId' ? { placeholder: '尚未指定', options: supervisorOptions.map(option => ({ ...option })) } : {}),
      ...(name === 'gender' ? { placeholder: '未提供', options: genders.map(option => ({ ...option })) } : {}),
      ...(name === 'cmsLevel' ? { min: 1, max: 8, step: 1 } : {}),
      ...(['address', 'note'].includes(name) ? { wide: true } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => requiredIntents.has(name);
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
