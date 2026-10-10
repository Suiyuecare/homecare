// Pure form adapter: saved JSON is captured privately, never spread into controls.
const names = ['code', 'name', 'minutes', 'unitPriceCents', 'validFrom', 'validTo', 'status', 'note'];
const controlName = name => name === 'unitPriceCents' ? 'unitPrice' : name;
const labels = { code: '服務代碼', name: '服務名稱', minutes: '預設服務分鐘', unitPriceCents: '測試單價（新臺幣元）', validFrom: '有效起日', validTo: '有效迄日', status: '狀態', note: '備註' };
const statuses = { active: '啟用', inactive: '停用' };
const optional = new Set(['validFrom', 'validTo', 'note']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('code', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}
function nativeDate(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function compatible(name, value) {
  if (name === 'unitPriceCents') return Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
  if (name === 'minutes') return Number.isSafeInteger(value) && value >= 1 && value <= 1440;
  if (typeof value !== 'string') return false;
  if (name === 'code' || name === 'name') return !/[\r\n]/.test(value);
  if (name === 'note') return !/\r/.test(value);
  if (name === 'status') return own(statuses, value);
  return optional.has(name) && nativeDate(value);
}
function priceText(cents) {
  const exact = BigInt(cents);
  return `${exact / 100n}.${String(exact % 100n).padStart(2, '0')}`;
}
function priceCents(value) {
  if (typeof value !== 'string' || /\s/.test(value) || !/^\d+(?:\.\d{1,2})?$/.test(value)) invalid('unitPrice', '請輸入非負金額，最多兩位小數，不含空白、符號或指數。');
  const [whole, fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+/, '') || '0';
  // Reject impossible magnitudes before allocating an unbounded BigInt.
  if (integer.length > 8) invalid('unitPrice', '測試單價不可超過新臺幣10,000,000.00元。');
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > 1000000000n) invalid('unitPrice', '測試單價不可超過新臺幣10,000,000.00元。');
  return Number(cents);
}
function replacement(name, value) {
  if (name === 'unitPriceCents') return priceCents(value);
  if (!compatible(name, value) || (typeof value === 'string' && value.length > (name === 'note' ? 10000 : 500))
    || (['code', 'name'].includes(name) && value === '')) invalid(controlName(name), '請提供符合此欄格式與範圍的內容；必要欄位不可空白。');
  return value;
}
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}

export function createServiceItemEditor({ existing } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('code', '原服務項目格式無法取得，請重新讀取。');
  const original = {}, baseline = {}, fields = [], requiredIntents = new Set();
  const identity = editing ? { id: existing.id, orgId: existing.orgId, version: existing.version } : null;
  for (const name of names) {
    const control = controlName(name), present = editing && own(existing, name);
    if (present) put(original, name, copyJson(existing[name]));
    const unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(control); baseline[control + 'Intent'] = 'keep';
      fields.push({ name: control + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional.has(name) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[control] = editing ? unsafe ? '' : name === 'unitPriceCents' ? priceText(original[name]) : original[name]
      : name === 'minutes' ? 30 : name === 'unitPriceCents' ? '0.00' : name === 'status' ? 'active' : '';
    fields.push({ name: control, label: labels[name], type: name === 'minutes' ? 'number' : name === 'note' ? 'textarea' : name === 'status' ? 'select' : ['validFrom', 'validTo'].includes(name) ? 'date' : 'text',
      required: !unsafe && !optional.has(name), disabled: unsafe,
      ...(name === 'minutes' ? { min: 1, max: 1440, step: 1 } : {}),
      ...(name === 'unitPriceCents' ? { inputMode: 'decimal', help: '合成測試價格，不代表政府支付標準。' } : {}),
      ...(name === 'status' ? { options: Object.entries(statuses).map(([value, label]) => ({ value, label })) } : {}),
      ...(name === 'note' ? { wide: true } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => requiredIntents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function buildPayload(values) {
    if (!plain(values)) invalid('code', '表單資料格式不正確，請保留輸入並重試。');
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
