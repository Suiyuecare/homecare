/** Pure form adapter shared by the case support islands and synthetic tests. */
export const CASE_SUPPORT_PROFILES = Object.freeze({
  'case-relationships': {
    title: '家系與生態關係', singular: '關係紀錄',
    fields: ['kind', 'name', 'role', 'relationship', 'direction', 'support', 'date', 'source', 'status', 'note'],
    required: ['kind', 'name', 'relationship', 'date', 'direction', 'support', 'status'],
    defaults: { kind: 'family', direction: 'bidirectional', support: 'unknown', status: 'active' },
    labels: { kind: '關係類型', name: '家人、人士或單位名稱', role: '角色', relationship: '與個案的關係', direction: '支持方向', support: '人工記錄的關係狀況', date: '紀錄日期', source: '資料來源', status: '紀錄狀態', note: '關係說明與完整備註' },
    options: {
      kind: [{ value: 'family', label: '家系關係' }, { value: 'community', label: '生態支持關係' }],
      direction: [{ value: 'toward_case', label: '對方 → 個案' }, { value: 'from_case', label: '個案 → 對方' }, { value: 'bidirectional', label: '個案 ↔ 對方' }],
      support: [{ value: 'supportive', label: '支持' }, { value: 'strained', label: '緊張或衝突' }, { value: 'neutral', label: '一般' }, { value: 'unknown', label: '尚未確認' }],
    },
  },
  'medical-opinions': {
    title: '醫事意見', singular: '醫事意見',
    fields: ['date', 'practitionerName', 'profession', 'organization', 'summary', 'recommendation', 'followUpDate', 'source', 'status', 'note'],
    required: ['date', 'practitionerName', 'summary', 'status'], defaults: { status: 'active' },
    labels: { date: '意見日期', practitionerName: '提供意見者', profession: '醫事職類', organization: '服務單位', summary: '意見摘要', recommendation: '照顧建議摘要', followUpDate: '人工追蹤日期', source: '資料來源', status: '紀錄狀態', note: '完整意見與追蹤備註' },
    options: {},
  },
});
export const CASE_SUPPORT_STATUSES = Object.freeze([{ value: 'active', label: '使用中' }, { value: 'inactive', label: '已停用' }]);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const maximum = key => key === 'note' ? 10000 : ['name', 'practitionerName', 'profession', 'role', 'relationship'].includes(key) ? 100 : 500;
const error = (field, message) => { const result = new Error(message); result.fields = { [field]: message }; throw result; };
export function validCaseSupportDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export const formatCaseSupportText = value => typeof value === 'string' ? value || '未提供' : value === undefined ? '未保存' : '非文字保存值；內容未展示。';
export const caseSupportOptionLabel = (entity, key, value) =>
  (key === 'status' ? CASE_SUPPORT_STATUSES : CASE_SUPPORT_PROFILES[entity]?.options[key])?.find(item => item.value === value)?.label || formatCaseSupportText(value);

export function assertCaseSupportItem(item, { entity, caseId, orgId, id, version } = {}) {
  const profile = CASE_SUPPORT_PROFILES[entity];
  if (!profile || !plain(item) || !own(item, 'id') || typeof item.id !== 'string' || !item.id.trim() || item.id !== item.id.trim() || item.caseId !== caseId || item.orgId !== orgId
    || !Number.isSafeInteger(item.version) || item.version < 1 || id && item.id !== id || version !== undefined && item.version !== version)
    error('note', '無法確認紀錄的個案、機構或版次，請重新讀取。');
  return item;
}
export function confirmCaseSupportList(response, request) {
  if (!plain(response) || !Array.isArray(response.items) || response.page !== request.page || response.pageSize !== request.pageSize
    || !Number.isSafeInteger(response.total) || response.total < 0 || response.items.length > request.pageSize
    || response.items.length !== Math.max(0, Math.min(request.pageSize, response.total - (request.page - 1) * request.pageSize)))
    error('note', '紀錄清單回應未確認，請重新讀取。');
  const ids = new Set();
  for (const item of response.items) {
    assertCaseSupportItem(item, request);
    if (ids.has(item.id) || request.status && item.status !== request.status) error('note', '紀錄清單範圍未確認，請重新讀取。');
    ids.add(item.id);
  }
  return response;
}

export function createCaseSupportEditor({ entity, existing = null, caseId, orgId, defaultDate = '' } = {}) {
  const profile = CASE_SUPPORT_PROFILES[entity];
  if (!profile || typeof caseId !== 'string' || !caseId || caseId !== caseId.trim()) error('note', '所屬個案無法確認。');
  const editing = existing !== null;
  if (editing) assertCaseSupportItem(existing, { entity, caseId, orgId });
  const original = editing ? structuredClone(existing) : {}, initial = {}, fields = [], intents = new Set();
  const choices = key => key === 'status' ? CASE_SUPPORT_STATUSES : profile.options[key];
  const optional = key => !profile.required.includes(key);
  const compatible = (key, value) => typeof value === 'string' && value.length <= maximum(key)
    && (!profile.required.includes(key) || Boolean(value.trim()))
    && (choices(key) ? choices(key).some(item => item.value === value) : key === 'date' || key === 'followUpDate' ? optional(key) && value === '' || validCaseSupportDate(value) : ['note', 'summary', 'recommendation'].includes(key) ? !value.includes('\r') : !/[\r\n]/.test(value));
  for (const key of profile.fields) {
    const unsafe = editing && (!own(original, key) || !compatible(key, original[key]));
    if (unsafe) {
      intents.add(key); initial[key + 'Intent'] = 'keep';
      fields.push({ name: key + 'Intent', label: profile.labels[key] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional(key) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: '原值無法無損放入表單。保持時不覆寫此欄；需要修改時請明確選擇取代。' });
    }
    initial[key] = editing ? unsafe ? '' : original[key] : profile.defaults[key] || (key === 'date' && validCaseSupportDate(defaultDate) ? defaultDate : '');
    fields.push({ name: key, label: profile.labels[key], type: choices(key) ? 'select' : ['date', 'followUpDate'].includes(key) ? 'date' : ['note', 'summary', 'recommendation'].includes(key) ? 'textarea' : 'text',
      required: !unsafe && profile.required.includes(key), disabled: unsafe, maxLength: maximum(key),
      ...(choices(key) ? { options: choices(key).map(item => ({ ...item })) } : {}),
      ...(key === 'note' ? { help: '最多 10000 個字元，保存實際人工紀錄。' } : {}),
      ...(key === 'support' ? { help: '由督導人工選擇，不代表臨床評估或風險分數。' } : {}),
      ...(key === 'followUpDate' ? { help: '由使用者指定；系統不推定醫療期限或自動發送訊息。' } : {}),
    });
  }
  const names = new Set(Object.keys(initial));
  const enabled = (key, values = initial) => !intents.has(key) || (values[key + 'Intent'] ?? initial[key + 'Intent']) === 'replace';
  function buildPayload(values) {
    if (!plain(values) || Object.keys(values).some(key => !names.has(key))) error('note', '表單含未知欄位，請重新讀取。');
    const payload = {};
    if (!editing) payload.caseId = caseId;
    for (const key of profile.fields) {
      let value = own(values, key) ? values[key] : initial[key];
      if (intents.has(key)) {
        const intent = values[key + 'Intent'] ?? initial[key + 'Intent'];
        if (intent === 'keep') continue;
        if (intent === 'clear' && optional(key)) value = '';
        else if (intent !== 'replace') error(key + 'Intent', '請選擇有效處理方式。');
      } else if (editing && value === initial[key]) continue;
      if (typeof value !== 'string') error(key, '請提供有效文字。');
      value = value.trim();
      if (!compatible(key, value)) error(key, '請核對此欄的必要內容、選項、日期或長度。');
      payload[key] = value;
    }
    return payload;
  }
  function confirm(item, payload) {
    assertCaseSupportItem(item, { entity, caseId, orgId, ...(editing ? { id: original.id, version: original.version + 1 } : { version: 1 }) });
    const expected = { ...original, ...payload };
    for (const key of ['caseId', ...profile.fields]) {
      if (own(item, key) !== own(expected, key) || own(expected, key) && JSON.stringify(item[key]) !== JSON.stringify(expected[key]))
        error('note', '儲存結果未確認；請保留輸入並重新讀取。');
    }
    return item;
  }
  return { initial, fields, enabled, buildPayload, confirm };
}
