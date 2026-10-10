// Pure form adapter: saved JSON is captured privately, never spread into controls.
const names = ['name', 'employeeNo', 'role', 'phone', 'email', 'status', 'qualification', 'regions', 'note', 'hourlyRateCents'];
const controlName = name => name === 'hourlyRateCents' ? 'hourlyRate' : name;
const labels = { name: '姓名', employeeNo: '員工編號', role: '職務', phone: '聯絡電話', email: '電子郵件', status: '狀態', qualification: '資格與證照', regions: '服務區域', note: '備註', hourlyRateCents: '試算時薪（新臺幣元）' };
const statuses = { active: '啟用', inactive: '停用' };
const optional = new Set(['role', 'phone', 'email', 'qualification', 'regions', 'note']);
const multiline = new Set(['qualification', 'regions', 'note']);
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
function compatible(name, value) {
  if (name === 'hourlyRateCents') return Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
  if (typeof value !== 'string') return false;
  if (name === 'status') return own(statuses, value);
  return multiline.has(name) ? !/\r/.test(value) : !/[\r\n]/.test(value);
}
function priceText(cents) {
  const exact = BigInt(cents);
  return `${exact / 100n}.${String(exact % 100n).padStart(2, '0')}`;
}
function priceCents(value) {
  if (typeof value !== 'string' || /\s/.test(value) || !/^\d+(?:\.\d{1,2})?$/.test(value)) invalid('hourlyRate', '請輸入非負金額，最多兩位小數，不含空白、符號或指數。');
  const [whole, fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+/, '') || '0';
  // Reject impossible magnitudes before allocating an unbounded BigInt.
  if (integer.length > 8) invalid('hourlyRate', '試算時薪不可超過新臺幣10,000,000.00元。');
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > 1000000000n) invalid('hourlyRate', '試算時薪不可超過新臺幣10,000,000.00元。');
  return Number(cents);
}
function replacement(name, value) {
  if (name === 'hourlyRateCents') return priceCents(value);
  const limit = name === 'note' ? 10000 : name === 'regions' ? 1000 : 500;
  if (!compatible(name, value) || value.length > limit || (['name', 'employeeNo'].includes(name) && value === ''))
    invalid(controlName(name), '請提供符合此欄格式與範圍的內容；必要欄位不可空白。');
  return value;
}
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}

export function createEmployeeEditor({ existing } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('name', '原員工資料格式無法取得，請重新讀取。');
  const original = {}, baseline = {}, fields = [], requiredIntents = new Set();
  const identity = editing ? { id: existing.id, orgId: existing.orgId, version: existing.version } : null;
  for (const name of names) {
    const control = controlName(name), present = editing && own(existing, name);
    if (present) put(original, name, copyJson(existing[name]));
    const unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(control); baseline[control + 'Intent'] = 'keep';
      fields.push({ name: control + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: name === 'regions' ? '改存文字' : '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: name === 'regions' ? '清空為空文字' : '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。${name === 'regions' ? '改存文字將以本次文字取代整份原清單，不保留清單項目結構；不會自動合併或拆分。' : ''}` });
    }
    baseline[control] = editing ? unsafe ? '' : name === 'hourlyRateCents' ? priceText(original[name]) : original[name]
      : name === 'hourlyRateCents' ? '0.00' : name === 'status' ? 'active' : '';
    fields.push({ name: control, label: labels[name], type: multiline.has(name) ? 'textarea' : name === 'status' ? 'select' : name === 'phone' ? 'tel' : 'text',
      required: !unsafe && !optional.has(name), disabled: unsafe,
      ...(name === 'hourlyRateCents' ? { inputMode: 'decimal', help: '用於本機薪資試算，非核定薪資。' } : {}),
      ...(name === 'status' ? { options: Object.entries(statuses).map(([value, label]) => ({ value, label })) } : {}),
      ...(multiline.has(name) ? { wide: true } : {}),
      ...(name === 'qualification' ? { help: '此處保留資格文字摘要；結構化證照與實際訓練請由員工列表的「證照」及「訓練」入口維護。' } : {}),
      ...(name === 'regions' ? { help: '此欄編輯文字；原清單須明確選擇改存文字，會取代整份清單。不自動合併、拆行或去重。' } : {}),
      ...(name === 'role' ? { help: '職務文字，不會變更登入權限。' } : {}),
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
    for (const name of names) {
      const control = controlName(name);
      let value = valueOf(values, control);
      if (needsIntent(control)) {
        const intent = valueOf(values, control + 'Intent');
        if (!['keep', 'replace', ...(optional.has(name) ? ['clear'] : [])].includes(intent)) invalid(control + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[control]) continue;
      value = replacement(name, value);
      if (!editing || !own(original, name) || JSON.stringify(original[name]) !== JSON.stringify(value)) payload[name] = value;
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
  return { initial: { ...baseline }, fields, needsIntent, enabled, buildPayload, confirm };
}
