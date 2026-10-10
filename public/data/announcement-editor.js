// Pure, same-record form adapter. Unrepresentable saved JSON stays outside controls.
const names = ['title', 'body', 'audience', 'status'];
const labels = { title: '公告標題', body: '公告內容', audience: '閱讀對象', status: '公告狀態' };
const audiences = { all: '全體同仁', caregiver: '居服員', supervisor: '督導', finance: '財務', admin: '管理者' };
const statuses = { draft: '草稿', published: '發布至本系統' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, name) => Object.hasOwn(value, name);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
const options = dictionary => Object.entries(dictionary).map(([value, label]) => ({ value, label }));

function invalid(name, message) {
  const error = new Error(message);
  error.fields = { [name]: message };
  throw error;
}
function unconfirmed() {
  const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。');
  error.code = 'SAVE_UNCONFIRMED';
  throw error;
}
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}
function compatible(name, value) {
  if (typeof value !== 'string') return false;
  if (name === 'title') return !/[\r\n]/.test(value);
  if (name === 'body') return !/\r/.test(value);
  if (name === 'audience') return own(audiences, value);
  return name === 'status' && own(statuses, value);
}
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
function validateReplacement(name, value, clear = false) {
  if (name === 'audience' && clear && value === '') return;
  if (typeof value !== 'string' || value.length > (name === 'body' ? 10000 : 500)
    || !compatible(name, value) || (['title', 'body'].includes(name) && value === '')) {
    invalid(name, '請提供符合此欄格式與長度的文字；必要欄位不可空白。');
  }
}

export function createAnnouncementEditor({ existing } = {}) {
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) invalid('title', '原公告格式無法取得，請重新讀取。');
  const original = {}, baseline = {}, requiredIntents = new Set(), fields = [];
  const identity = editing ? { id: existing.id, orgId: existing.orgId, version: existing.version } : null;
  for (const name of names) {
    const present = editing && own(existing, name);
    if (present) put(original, name, copyJson(existing[name]));
    const unsafe = editing && (!present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(name);
      baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(name === 'audience' ? [{ value: 'clear', label: '清空閱讀對象' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = editing ? unsafe ? '' : original[name] : name === 'audience' ? 'all' : name === 'status' ? 'draft' : '';
    fields.push({ name, label: labels[name], type: name === 'body' ? 'textarea' : ['audience', 'status'].includes(name) ? 'select' : 'text',
      required: !unsafe, disabled: unsafe, ...(name === 'body' ? { wide: true } : {}),
      ...(name === 'audience' ? { options: options(audiences) } : name === 'status' ? { options: options(statuses), help: '發布後會顯示於系統內；不寄送郵件或外部訊息。' } : {}) });
  }
  const allowed = new Set(Object.keys(baseline));
  const valueOf = (values, name) => own(values, name) ? values[name] : baseline[name];
  const needsIntent = name => requiredIntents.has(name);
  function enabled(name, values = {}) {
    if (!allowed.has(name) || !plain(values)) return false;
    return !needsIntent(name) || valueOf(values, name + 'Intent') === 'replace';
  }
  function buildPayload(values) {
    if (!plain(values)) invalid('title', '表單資料格式不正確，請保留輸入並重試。');
    for (const name of Object.keys(values)) if (!allowed.has(name)) invalid(name, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of names) {
      let value = valueOf(values, name), clear = false;
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(name === 'audience' ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') { value = ''; clear = true; }
      } else if (editing && value === baseline[name]) continue;
      validateReplacement(name, value, clear);
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
      for (const name of Object.keys(payload)) {
        if (!names.includes(name) && !(editing && name === 'version' && payload.version === identity.version)) unconfirmed();
      }
      for (const name of names) {
        const supplied = own(payload, name), expectedPresent = supplied || (editing && own(original, name));
        if (!editing && !supplied) unconfirmed();
        if (own(item, name) !== expectedPresent) unconfirmed();
        if (expectedPresent) {
          const expected = supplied ? copyJson(payload[name]) : original[name];
          if (JSON.stringify(copyJson(item[name])) !== JSON.stringify(expected)) unconfirmed();
        }
      }
    } catch { unconfirmed(); }
    return item;
  }
  return { initial: { ...baseline }, fields, needsIntent, enabled, buildPayload, confirm };
}
