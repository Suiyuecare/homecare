import { formatCaseText } from './case-editor.js';

/** Candidate pure adapter; manual statements only, no location/clinical inference. */
export const CASE_CONTACT_FOOTPRINT_FIELDS = ['caseId', 'date', 'time', 'location', 'contactDescription', 'relatedCaseId', 'source', 'status', 'note'];
export const CASE_CONTACT_FOOTPRINT_STATUSES = [{ value: 'active', label: '使用中' }, { value: 'inactive', label: '已停用' }];
export const CASE_CONTACT_FOOTPRINT_PROFILE = { title: '人工接觸足跡', singular: '接觸足跡', fields: CASE_CONTACT_FOOTPRINT_FIELDS.filter(key => key !== 'caseId'), labels: { caseId: '所屬個案', date: '人工紀錄日期', time: '人工紀錄時間', location: '人工紀錄場所', contactDescription: '接觸情形說明', relatedCaseId: '同機構相關個案', source: '資料來源', status: '紀錄狀態', note: '完整備註' }, description: '依人工回報保存日期、場所與接觸情形；時間或相關個案未知可留空，不使用GPS、通報或臨床推論。' };
const required = new Set(['caseId', 'date', 'location', 'contactDescription', 'status']), multiline = new Set(['contactDescription', 'note']);
const maximum = { caseId: 500, date: 10, time: 5, location: 200, contactDescription: 2000, relatedCaseId: 500, source: 500, status: 8, note: 10000 };
const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 500;
const failure = (field, message) => { const error = new Error(message); if (field) error.fields = { [field]: message }; throw error; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function safeObject(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || keys && !keys.includes(key) || !Object.getOwnPropertyDescriptor(value, key).enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) failure(null, '人工接觸足跡資料格式未確認。'); return value;
}
function dense(array) { if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype || array.length > 10000 || Reflect.ownKeys(array).length !== array.length + 1) failure(null, '清單格式未確認。'); for (let i = 0; i < array.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(array, String(i)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) failure(null, '清單格式未確認。'); } return array; }
export function validCaseContactFootprintDate(value) { if (typeof value !== 'string' || value.length !== 10 || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function business(data) {
  safeObject(data); for (const key of CASE_CONTACT_FOOTPRINT_FIELDS) if (!Object.hasOwn(data, key) || typeof data[key] !== 'string' || data[key].length > maximum[key]) failure(key, '人工接觸足跡欄位格式或長度未確認。');
  for (const key of required) if (!data[key].trim()) failure(key, '必要內容未確認。');
  if (!identity(data.caseId) || data.relatedCaseId && !identity(data.relatedCaseId)) failure('relatedCaseId', '個案識別未確認。');
  if (!validCaseContactFootprintDate(data.date)) failure('date', '人工紀錄日期未確認。');
  if (data.time && (data.time.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data.time))) failure('time', '未知時間留空，或提供同日有效HH:mm。');
  if (!['active', 'inactive'].includes(data.status)) failure('status', '人工紀錄狀態未確認。'); return data;
}
export function assertCaseContactFootprintItem(item, { caseId, orgId, id, version } = {}) {
  safeObject(item, [...CASE_CONTACT_FOOTPRINT_FIELDS, 'id', 'orgId', 'version', 'createdAt', 'updatedAt']);
  if (!identity(item.id) || !identity(orgId) || item.orgId !== orgId || item.caseId !== caseId || id !== undefined && item.id !== id || !Number.isSafeInteger(item.version) || item.version < 1 || version !== undefined && item.version !== version || ['createdAt', 'updatedAt'].some(key => !Object.hasOwn(item, key) || typeof item[key] !== 'string' || !item[key] || item[key].length > 100)) failure(null, '接觸足跡識別、機構、個案、版次或時間戳未完整確認。'); return business(item);
}
export function confirmCaseContactFootprintList(response, request) {
  safeObject(response, ['items', 'page', 'pageSize', 'total']); safeObject(request);
  if (Object.keys(response).length !== 4 || response.page !== request.page || response.pageSize !== 25 || request.pageSize !== 25 || !Number.isSafeInteger(request.page) || request.page < 1 || !Number.isSafeInteger(response.total) || response.total < 0 || dense(response.items).length !== Math.max(0, Math.min(25, response.total - (request.page - 1) * 25))) failure(null, '人工接觸足跡完整分頁未確認。');
  const seen = new Set(); for (const item of response.items) { assertCaseContactFootprintItem(item, request); if (seen.has(item.id) || request.date && item.date !== request.date || request.status && item.status !== request.status) failure(null, '接觸足跡清單範圍未確認。'); seen.add(item.id); } return response;
}
/** Case IDs and scope remain strict; legacy display labels use the case owner's safe text projection. */
export function projectCaseContactFootprintCaseLookups(cases, { orgId } = {}) {
  dense(cases); if (!identity(orgId)) failure(null, '相關個案機構範圍未確認。');
  const seen = new Set();
  return cases.map(item => {
    safeObject(item);
    if (!identity(item.id) || item.orgId !== orgId || seen.has(item.id)) failure(null, '相關個案識別或機構範圍未確認。');
    seen.add(item.id);
    return { id: item.id, orgId: item.orgId, name: formatCaseText(item.name), caseNo: formatCaseText(item.caseNo) };
  });
}
export function createCaseContactFootprintEditor({ existing = null, caseId, orgId, defaultDate = '', cases = [] } = {}) {
  if (!identity(caseId) || !identity(orgId)) failure(null, '人工接觸足跡個案範圍未確認。'); dense(cases);
  for (const item of cases) { safeObject(item); if (!identity(item.id) || item.orgId !== orgId || typeof item.name !== 'string' || typeof item.caseNo !== 'string') failure(null, '相關個案選項未確認。'); }
  const editing = existing !== null, original = editing ? structuredClone(assertCaseContactFootprintItem(existing, { caseId, orgId })) : null, initial = {}, fields = [], intents = new Set();
  const representable = (key, value) => typeof value === 'string' && !(multiline.has(key) ? /\r/.test(value) : /[\r\n]/.test(value));
  for (const key of CASE_CONTACT_FOOTPRINT_PROFILE.fields) {
    const unsafe = editing && !representable(key, original[key]); if (unsafe) { intents.add(key); initial[key + 'Intent'] = 'keep'; fields.push({ name: key + 'Intent', label: CASE_CONTACT_FOOTPRINT_PROFILE.labels[key] + '處理方式', type: 'select', required: true, options: [{ value: 'keep', label: '保持原文' }, { value: 'replace', label: '以本次輸入取代' }, ...(!required.has(key) ? [{ value: 'clear', label: '明確清空' }] : [])], help: '原保存文字有原生欄位無法無損呈現的換行；保持時不覆寫。' }); }
    initial[key] = editing ? unsafe ? '' : original[key] : key === 'status' ? 'active' : key === 'date' && validCaseContactFootprintDate(defaultDate) ? defaultDate : '';
    fields.push({ name: key, label: CASE_CONTACT_FOOTPRINT_PROFILE.labels[key], type: key === 'status' || key === 'relatedCaseId' ? 'select' : key === 'date' ? 'date' : key === 'time' ? 'time' : multiline.has(key) ? 'textarea' : 'text', required: required.has(key) && !unsafe, disabled: unsafe, maxLength: maximum[key], ...(key === 'status' ? { options: CASE_CONTACT_FOOTPRINT_STATUSES } : key === 'relatedCaseId' ? { options: cases.map(item => ({ value: item.id, label: `${item.caseNo} ${item.name}` })), help: '只選同機構相關個案；未知可留空。' } : key === 'time' ? { help: '由人工回報填寫，未知可留空，不推定時間。' } : {}) });
  }
  const controls = Object.keys(initial), enabled = (key, values = initial) => !intents.has(key) || values[key + 'Intent'] === 'replace';
  function buildPayload(values) {
    safeObject(values, controls); const payload = editing ? {} : { caseId };
    for (const key of CASE_CONTACT_FOOTPRINT_PROFILE.fields) {
      let value = Object.hasOwn(values, key) ? values[key] : initial[key];
      if (intents.has(key)) { const intent = values[key + 'Intent'] ?? initial[key + 'Intent']; if (intent === 'keep') continue; if (intent === 'clear' && !required.has(key)) value = ''; else if (intent !== 'replace') failure(key + 'Intent', '處理方式未確認。'); }
      else if (editing && value === initial[key]) continue;
      if (!representable(key, value)) failure(key, '請提供可無損保存的文字。'); payload[key] = key === 'status' ? value.trim() : value;
    }
    const expected = { ...original, ...payload }; business(expected);
    if (expected.relatedCaseId && !cases.some(item => item.id === expected.relatedCaseId)) failure('relatedCaseId', '相關個案須屬於本機構且仍可讀取。'); return payload;
  }
  function confirm(response, payload) {
    safeObject(response, ['item']); if (Object.keys(response).length !== 1) failure(null, '接觸足跡保存回應未完整確認。'); safeObject(payload, CASE_CONTACT_FOOTPRINT_FIELDS);
    const item = assertCaseContactFootprintItem(response.item, { caseId, orgId, ...(editing ? { id: original.id, version: original.version + 1 } : { version: 1 }) }), expected = { ...original, ...payload };
    if (editing && item.createdAt !== original.createdAt) failure(null, '原保存時間未確認。');
    for (const key of CASE_CONTACT_FOOTPRINT_FIELDS) if (!Object.hasOwn(expected, key) || item[key] !== expected[key]) failure(null, '接觸足跡保存結果未完整確認；請保留輸入並重新讀取。'); return item;
  }
  return { initial, fields, enabled, buildPayload, confirm };
}
