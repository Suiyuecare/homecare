// Pure service-record adapter; saved JSON stays private, outside native controls.
const names = ['shiftId', 'caseId', 'employeeId', 'date', 'actualStart', 'actualEnd', 'services', 'status', 'note', 'reviewNote'];
const controls = ['actualStart', 'actualEnd', 'services', 'note', 'status'];
const labels = { actualStart: '實際開始時間', actualEnd: '實際結束時間', services: '實際服務與數量', note: '服務紀錄與觀察', status: '儲存方式' };
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeId = value => typeof value === 'string' && value.trim() !== '' && value.length <= 500 && !/[\r\n]/.test(value);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('actualStart', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const result = Array.isArray(value) ? [] : {};
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))))
    invalid('services', '保存資料不是可安全保留的 JSON，請重新讀取。');
  for (const key of Object.keys(value)) put(result, key, copyJson(value[key], ancestors));
  ancestors.delete(value);
  return result;
}
const nativeTime = value => typeof value === 'string' && value.length === 5 && /^\d{2}:\d{2}$/.test(value)
  && Number(value.slice(0, 2)) < 24 && Number(value.slice(3)) < 60;
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
function capture(existing) {
  if (!plain(existing)) invalid('actualStart', '原服務紀錄格式無法取得，請重新讀取。');
  const original = {}, identity = {};
  for (const name of names) if (own(existing, name)) put(original, name, copyJson(existing[name]));
  for (const name of ['id', 'orgId', 'version']) if (own(existing, name)) put(identity, name, copyJson(existing[name]));
  return { original, identity };
}
function confirmProjection(item, orgId, identity, original, expected, creating = false) {
  try {
    if (!plain(item) || !plain(expected) || typeof orgId !== 'string' || !orgId.trim()
      || !own(item, 'id') || !safeId(item.id) || !own(item, 'orgId') || item.orgId !== orgId
      || !own(item, 'version') || !Number.isSafeInteger(item.version)
      || (creating ? item.version !== 1 : !Number.isSafeInteger(identity.version) || identity.version < 1
        || identity.version >= Number.MAX_SAFE_INTEGER || identity.orgId !== orgId || item.id !== identity.id || item.version !== identity.version + 1)) unconfirmed();
    for (const name of names) {
      const supplied = own(expected, name), present = supplied || (!creating && own(original, name));
      if (own(item, name) !== present) unconfirmed();
      if (present && JSON.stringify(copyJson(item[name])) !== JSON.stringify(supplied ? copyJson(expected[name]) : original[name])) unconfirmed();
    }
  } catch { unconfirmed(); }
  return item;
}

export function createServiceRecordEditor({ existing, shift, serviceItems = [] } = {}) {
  const editing = existing !== undefined && existing !== null;
  const { original, identity } = editing ? capture(existing) : { original: {}, identity: null };
  const parents = {};
  if (!editing) {
    if (!plain(shift)) invalid('actualStart', '班次資料無法取得，請重新讀取。');
    for (const [target, source] of [['shiftId', 'id'], ['caseId', 'caseId'], ['employeeId', 'employeeId'], ['date', 'date']]) {
      if (!own(shift, source) || typeof shift[source] !== 'string') invalid('actualStart', '班次關聯資料無法取得，請重新讀取。');
      put(parents, target, copyJson(shift[source]));
    }
  }
  const allowedServices = new Set();
  for (const entry of plain(shift) && own(shift, 'services') && Array.isArray(shift.services) ? shift.services : [])
    if (plain(entry) && own(entry, 'serviceItemId') && safeId(entry.serviceItemId)) allowedServices.add(entry.serviceItemId);
  const serviceOptions = [], selectedIds = new Set();
  for (const item of Array.isArray(serviceItems) ? serviceItems : []) {
    if (!plain(item) || !own(item, 'id') || !safeId(item.id) || !allowedServices.has(item.id) || selectedIds.has(item.id)) continue;
    selectedIds.add(item.id);
    const code = own(item, 'code') && typeof item.code === 'string' && !/[\r\n]/.test(item.code) && item.code ? item.code : '未提供代碼';
    const name = own(item, 'name') && typeof item.name === 'string' && !/[\r\n]/.test(item.name) && item.name ? item.name : '服務項目名稱未取得';
    serviceOptions.push({ value: item.id, label: `${code} ${name}` });
  }
  const statusOptions = [{ value: 'draft', label: '先存草稿' }, { value: 'submitted', label: '送督導核閱' },
    ...(editing && original.status === 'returned' ? [{ value: 'returned', label: '保持退回（尚未重送）' }] : [])];
  const statuses = new Set(statusOptions.map(option => option.value));
  const compatible = (name, value) => ['actualStart', 'actualEnd'].includes(name) ? nativeTime(value)
    : name === 'note' ? typeof value === 'string' && !/\r/.test(value) : name === 'status' ? typeof value === 'string' && statuses.has(value) : false;
  const baseline = {}, fields = [], requiredIntents = new Set();
  for (const name of controls) {
    const present = editing && own(original, name), unsafe = editing && (name === 'services' || !present || !compatible(name, original[name]));
    if (unsafe) {
      requiredIntents.add(name); baseline[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(name === 'note' ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: name === 'services' ? '保持時不更動整份原服務清單。取代後只保存本次選擇，未選取的原項目會移除。'
          : `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    baseline[name] = name === 'services' ? [] : editing ? unsafe ? '' : original[name] : name === 'status' ? 'draft' : '';
    fields.push({ name, label: labels[name], type: name === 'services' ? 'services' : name === 'note' ? 'textarea' : name === 'status' ? 'select' : 'time',
      required: name === 'services' || (!unsafe && name !== 'note'), disabled: unsafe,
      ...(name === 'services' ? { wide: true, preserveWhenDisabled: true, options: serviceOptions.map(option => ({ ...option })), help: '依實際完成內容填寫；0 代表未選取。數量不由班次或計畫數量推算。' } : {}),
      ...(name === 'note' ? { wide: true, help: editing && own(original, 'reviewNote') && typeof original.reviewNote === 'string' && original.reviewNote
        ? `督導退回說明：${original.reviewNote}` : '請記錄本次服務情形與需交班事項。' } : {}),
      ...(name === 'status' ? { options: statusOptions.map(option => ({ ...option })), help: '送出後不能直接修改；退回可先修正保持原狀態，明確選擇送核閱才重送。' } : {}),
      ...(['actualStart', 'actualEnd'].includes(name) ? { help: '取代時填同日時間；保持原 ISO 時段不裁切秒數或換算時區。' } : {}),
    });
  }
  const allowed = new Set(Object.keys(baseline)), valueOf = (values, key) => own(values, key) ? values[key] : baseline[key];
  const needsIntent = name => requiredIntents.has(name);
  const enabled = (name, values = {}) => allowed.has(name) && plain(values) && (!needsIntent(name) || valueOf(values, name + 'Intent') === 'replace');
  function replacement(name, value) {
    if (name === 'services') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || Object.keys(value).length !== value.length
        || Object.keys(value).some((key, index) => key !== String(index))) invalid(name, '請選擇 1 至 100 項服務並填寫數量。');
      const seen = new Set();
      return value.map(entry => {
        if (!plain(entry) || Object.keys(entry).length !== 2 || !own(entry, 'serviceItemId') || !own(entry, 'quantity')
          || typeof entry.serviceItemId !== 'string' || !selectedIds.has(entry.serviceItemId) || seen.has(entry.serviceItemId)
          || !Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 10000)
          invalid(name, '服務須為目前班次的可選項目，數量須為 1 至 10000 的整數，且不能重複。');
        seen.add(entry.serviceItemId); return { serviceItemId: entry.serviceItemId, quantity: entry.quantity };
      });
    }
    if (!compatible(name, value) || value.length > (name === 'note' ? 10000 : 500)) invalid(name, '請提供符合此欄格式與範圍的內容；必要欄位不可空白。');
    return value;
  }
  function buildPayload(values) {
    if (!plain(values)) invalid('actualStart', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(values)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    const payload = {};
    for (const name of controls) {
      let value = valueOf(values, name);
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(name === 'note' ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (editing && value === baseline[name]) continue;
      value = replacement(name, value);
      if (!editing || !own(original, name) || JSON.stringify(original[name]) !== JSON.stringify(value)) put(payload, name, value);
    }
    if (!editing) for (const name of Object.keys(parents)) put(payload, name, parents[name]);
    return payload;
  }
  function confirm(item, orgId, payload) {
    try {
      if (!plain(payload)) unconfirmed();
      for (const name of Object.keys(payload)) if (!(editing ? controls.includes(name) || (name === 'version' && payload.version === identity.version) : names.includes(name) && name !== 'reviewNote')) unconfirmed();
      if (!editing && names.slice(0, 9).some(name => !own(payload, name))) unconfirmed();
      return confirmProjection(item, orgId, identity, original, payload, !editing);
    } catch { unconfirmed(); }
  }
  return { initial: copyJson(baseline), fields, needsIntent, enabled, buildPayload, confirm };
}

export function createServiceRecordReview({ existing } = {}) {
  const { original, identity } = capture(existing);
  const initial = { decision: 'approved', reviewNote: '' };
  const fields = [
    { name: 'decision', label: '核閱結果', type: 'select', required: true, options: [{ value: 'approved', label: '通過核閱' }, { value: 'returned', label: '退回修正' }] },
    { name: 'reviewNote', label: '核閱說明', type: 'textarea', wide: true, help: '退回時請說明需要修正的內容。' },
  ];
  function buildPayload(values) {
    if (!plain(values) || Object.keys(values).some(name => !['decision', 'reviewNote'].includes(name))) invalid('decision', '核閱資料格式不正確。');
    const decision = own(values, 'decision') ? values.decision : initial.decision;
    const reviewNote = own(values, 'reviewNote') ? values.reviewNote : initial.reviewNote;
    if (!['approved', 'returned'].includes(decision)) invalid('decision', '請選擇有效的核閱結果。');
    if (typeof reviewNote !== 'string' || reviewNote.length > 10000 || (decision === 'returned' && !reviewNote.trim())) invalid('reviewNote', '退回時請填寫修正說明；核閱說明最多 10000 字。');
    return { decision, reviewNote };
  }
  function confirm(item, orgId, payload) {
    try {
      if (!plain(payload) || Object.keys(payload).some(name => !['decision', 'reviewNote', 'version'].includes(name))
        || !own(payload, 'decision') || !['approved', 'returned'].includes(payload.decision)
        || !own(payload, 'reviewNote') || typeof payload.reviewNote !== 'string'
        || (own(payload, 'version') && payload.version !== identity.version)) unconfirmed();
      return confirmProjection(item, orgId, identity, original, { status: payload.decision, reviewNote: payload.reviewNote });
    } catch { unconfirmed(); }
  }
  return { initial: { ...initial }, fields, buildPayload, confirm };
}
