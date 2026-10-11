/** Pure adapters for manually authored health records. No thresholds or clinical interpretation. */
const common = { caseId: 500, date: 10, source: 500, status: 8, note: 10000 };
export const CASE_HEALTH_STATUSES = Object.freeze([{ value: 'active', label: '使用中' }, { value: 'inactive', label: '已停用' }]);
export const CASE_HEALTH_PROFILES = Object.freeze({
  'case-vaccinations': {
    title: '疫苗接種紀錄', singular: '疫苗紀錄', fields: ['date', 'vaccine', 'dose', 'provider', 'lotNumber', 'source', 'status', 'note'],
    required: ['date', 'vaccine', 'status'], defaults: { status: 'active' },
    maxLengths: { ...common, vaccine: 100, dose: 100, provider: 100, lotNumber: 100 },
    labels: { date: '接種日期', vaccine: '疫苗名稱', dose: '劑次或劑量紀錄', provider: '接種單位', lotNumber: '批號', source: '資料來源', status: '紀錄狀態', note: '完整備註' },
    description: '依接種證明或人工紀錄保存名稱、劑次及來源。',
  },
  'case-infection-records': {
    title: '感染觀察與處置紀錄', singular: '感染觀察紀錄', fields: ['date', 'category', 'observation', 'action', 'followUpDate', 'source', 'status', 'note'],
    required: ['date', 'category', 'observation', 'status'], defaults: { status: 'active' },
    maxLengths: { ...common, category: 100, observation: 2000, action: 2000, followUpDate: 10 },
    labels: { date: '紀錄日期', category: '人工紀錄分類', observation: '觀察內容', action: '人工處置紀錄', followUpDate: '人工追蹤日期', source: '資料來源', status: '紀錄狀態', note: '完整備註' },
    description: '人工記錄觀察、處置及追蹤日期；分類不代表診斷。',
  },
  'case-vitals': {
    title: '生理量測紀錄', singular: '量測紀錄', fields: ['date', 'time', 'metric', 'value', 'unit', 'source', 'status', 'note'],
    required: ['date', 'time', 'metric', 'value', 'unit', 'status'], defaults: { status: 'active' },
    maxLengths: { ...common, time: 5, metric: 100, value: 40, unit: 100 },
    labels: { date: '量測日期', time: '量測時間', metric: '量測項目名稱', value: '保存數值', unit: '保存單位', source: '資料來源', status: '紀錄狀態', note: '完整備註' },
    description: '保存量測名稱、數值原文與單位，不換算單位或判讀健康狀態。',
  },
});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const invalid = (field, message) => { const error = new Error(message); error.fields = { [field]: message }; throw error; };
const normalized = new Set(['date', 'followUpDate', 'time', 'status']);
const multiline = new Set(['observation', 'action', 'note']);
const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim();
export function validCaseHealthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export const caseHealthText = value => typeof value === 'string' ? value || '未提供' : '內容格式未確認。';
export const caseHealthStatusLabel = value => CASE_HEALTH_STATUSES.find(status => status.value === value)?.label || '狀態未確認';
function assertBusiness(entity, data) {
  const profile = CASE_HEALTH_PROFILES[entity]; if (!profile || !plain(data)) invalid('note', '健康紀錄格式未確認。');
  for (const key of ['caseId', ...profile.fields]) if (!own(data, key) || typeof data[key] !== 'string' || data[key].length > profile.maxLengths[key]) invalid(key, '健康紀錄欄位格式或長度未確認。');
  if (!identity(data.caseId)) invalid('note', '所屬個案未確認。');
  for (const key of profile.required) if (!data[key].trim()) invalid(key, '必要內容未確認。');
  if (!validCaseHealthDate(data.date) || profile.fields.includes('followUpDate') && data.followUpDate && (!validCaseHealthDate(data.followUpDate) || data.followUpDate < data.date)) invalid('date', '保存日期未確認。');
  if (!CASE_HEALTH_STATUSES.some(status => status.value === data.status)) invalid('status', '保存狀態未確認。');
  if (entity === 'case-vitals' && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time) || !/^\d+(?:\.\d+)?$/.test(data.value) || data.value !== data.value.trim())) invalid('value', '量測時間或十進位數值原文未確認。');
  return data;
}
export function assertCaseHealthItem(item, { entity, caseId, orgId, id, version } = {}) {
  const profile = CASE_HEALTH_PROFILES[entity];
  if (!profile || !plain(item) || !identity(item.id) || !identity(orgId) || item.orgId !== orgId || item.caseId !== caseId
    || id !== undefined && item.id !== id || !Number.isSafeInteger(item.version) || item.version < 1 || version !== undefined && item.version !== version) invalid('note', '無法確認健康紀錄的個案、機構、識別或版次。');
  const allowed = new Set(['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'caseId', ...profile.fields]);
  if (Object.keys(item).some(key => !allowed.has(key))) invalid('note', '健康紀錄含未確認欄位。');
  for (const key of ['createdAt', 'updatedAt']) if (own(item, key) && (typeof item[key] !== 'string' || item[key].length > 500)) invalid('note', '保存時間格式未確認。');
  return assertBusiness(entity, item);
}
export function confirmCaseHealthList(response, request) {
  if (!plain(response) || !Array.isArray(response.items) || !Number.isSafeInteger(request.page) || request.page < 1 || request.pageSize !== 25
    || response.page !== request.page || response.pageSize !== 25 || !Number.isSafeInteger(response.total) || response.total < 0
    || response.items.length !== Math.max(0, Math.min(25, response.total - (request.page - 1) * 25))) invalid('note', '健康紀錄清單回應未確認。');
  const seen = new Set();
  for (const item of response.items) {
    assertCaseHealthItem(item, request);
    if (seen.has(item.id) || request.status && item.status !== request.status || request.date && item.date !== request.date) invalid('note', '健康紀錄清單範圍未確認。');
    seen.add(item.id);
  }
  return response;
}
export function createCaseHealthEditor({ entity, existing = null, caseId, orgId, defaultDate = '' } = {}) {
  const profile = CASE_HEALTH_PROFILES[entity]; if (!profile || !identity(caseId) || !identity(orgId)) invalid('note', '個案健康紀錄範圍未確認。');
  const editing = existing !== null, original = editing ? structuredClone(assertCaseHealthItem(existing, { entity, caseId, orgId })) : {}, initial = {}, fields = [], intents = new Set();
  const optional = key => !profile.required.includes(key);
  const representable = (key, value) => typeof value === 'string' && !(multiline.has(key) ? /\r/.test(value) : /[\r\n]/.test(value));
  for (const key of profile.fields) {
    const unsafe = editing && !representable(key, original[key]);
    if (unsafe) {
      intents.add(key); initial[key + 'Intent'] = 'keep';
      fields.push({ name: key + 'Intent', label: profile.labels[key] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原文' }, { value: 'replace', label: '以本次輸入取代' }, ...(optional(key) ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: '原文包含控制項無法無損呈現的換行；保持時不覆寫。' });
    }
    initial[key] = editing ? unsafe ? '' : original[key] : profile.defaults[key] || (key === 'date' && validCaseHealthDate(defaultDate) ? defaultDate : '');
    fields.push({ name: key, label: profile.labels[key], type: key === 'status' ? 'select' : ['date', 'followUpDate'].includes(key) ? 'date' : key === 'time' ? 'time' : multiline.has(key) ? 'textarea' : 'text',
      required: !unsafe && profile.required.includes(key), disabled: unsafe, maxLength: profile.maxLengths[key],
      ...(key === 'status' ? { options: CASE_HEALTH_STATUSES.map(status => ({ ...status })) } : {}),
      ...(key === 'value' ? { inputMode: 'decimal', help: '輸入非負十進位原文，最多40字；不使用指數、不換算或判讀。' } : {}),
      ...(key === 'followUpDate' ? { help: '人工指定且不可早於紀錄日期；不會自動發送訊息。' } : {}),
    });
  }
  const controls = new Set(Object.keys(initial));
  const enabled = (key, values = initial) => !intents.has(key) || (values[key + 'Intent'] ?? initial[key + 'Intent']) === 'replace';
  function buildPayload(values) {
    if (!plain(values) || Object.keys(values).some(key => !controls.has(key))) invalid('note', '健康表單含未知欄位。');
    const payload = editing ? {} : { caseId };
    for (const key of profile.fields) {
      let value = own(values, key) ? values[key] : initial[key];
      if (intents.has(key)) {
        const intent = values[key + 'Intent'] ?? initial[key + 'Intent'];
        if (intent === 'keep') continue;
        if (intent === 'clear' && optional(key)) value = '';
        else if (intent !== 'replace') invalid(key + 'Intent', '請選擇有效處理方式。');
      } else if (editing && value === initial[key]) continue;
      if (!representable(key, value)) invalid(key, '請提供可保存的文字；多行欄位使用一般換行。');
      payload[key] = normalized.has(key) ? value.trim() : value;
    }
    assertBusiness(entity, { ...original, ...payload }); return payload;
  }
  function confirm(item, payload) {
    assertCaseHealthItem(item, { entity, caseId, orgId, ...(editing ? { id: original.id, version: original.version + 1 } : { version: 1 }) });
    const expected = { ...original, ...payload };
    for (const key of ['caseId', ...profile.fields]) if (own(item, key) !== own(expected, key) || item[key] !== expected[key]) invalid('note', '健康紀錄保存結果未確認；請保留輸入並重新讀取。');
    return item;
  }
  return { initial, fields, enabled, buildPayload, confirm };
}
