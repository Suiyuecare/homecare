// Institution-entered dates only. No statutory, schedule, payroll or leave rules.
export const institutionHolidayFields = ['date', 'title', 'kind', 'sourceReference', 'note', 'status'];
export const institutionHolidayKinds = { holiday: '機構指定假日', 'working-day': '機構指定工作日', closure: '機構停止服務日', other: '其他人工指定' };
export const institutionHolidayStatuses = { active: '使用中', inactive: '已停用' };
export const institutionHolidayLimits = { date: 10, title: 200, kind: 20, sourceReference: 2000, note: 10000, status: 10 };
const editable = ['date', 'title', 'kind', 'sourceReference', 'note'];
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function holidayClosed(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
const own = (value, key) => {
  const descriptor = plain(value) && Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const identifier = value => typeof value === 'string' && !!value && value.length <= 100 && value.trim() === value && !/[\r\n]/.test(value);
const timestamp = value => typeof value === 'string' && value.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const institutionHolidayYear = value => typeof value === 'string' && value.length === 4 && /^(?!0000)\d{4}$/.test(value);
export const institutionHolidayDate = value => typeof value === 'string' && value.length === 10 && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
function validBusinessFields(value) {
  if (institutionHolidayFields.some(key => typeof value[key] !== 'string' || value[key].length > institutionHolidayLimits[key])) return false;
  return institutionHolidayDate(value.date) && !!value.title.trim() && !/[\r\n]/.test(value.title)
    && Object.hasOwn(institutionHolidayKinds, value.kind) && Object.hasOwn(institutionHolidayStatuses, value.status);
}
export const institutionHolidayBusinessValid = value => holidayClosed(value, institutionHolidayFields) && validBusinessFields(value);
export function institutionHolidayRecordValid(value, orgId) {
  return holidayClosed(value, [...institutionHolidayFields, ...metadata]) && validBusinessFields(value)
    && identifier(value.id) && identifier(value.orgId) && value.orgId === orgId && Number.isSafeInteger(value.version) && value.version > 0
    && timestamp(value.createdAt) && timestamp(value.updatedAt) && value.updatedAt >= value.createdAt;
}
function invalid(key, message) { const error = new Error(message); error.fields = { [key]: message }; throw error; }
export function checkInstitutionHolidayRecord(response, { id, orgId, original, payload } = {}) {
  if (!holidayClosed(response, ['item'])) invalid('title', '指定日期回應格式無法確認，請保留輸入並重新讀取。');
  const item = own(response, 'item');
  if (!institutionHolidayRecordValid(item, orgId) || id !== undefined && item.id !== id) invalid('title', '無法確認指定日期完整保存內容，請保留輸入並重新讀取。');
  if (payload !== undefined) {
    if (original !== undefined && !institutionHolidayRecordValid(original, orgId)) invalid('title', '原保存資料無法完整確認。');
    if (!plain(payload) || Reflect.ownKeys(payload).some(key => typeof key !== 'string' || !institutionHolidayFields.includes(key)
      || typeof own(payload, key) !== 'string')) invalid('title', '保存確認欄位無法核對。');
    const expected = { ...(original || { sourceReference: '', note: '', status: 'active' }), ...payload };
    if (item.version !== (original ? original.version + 1 : 1) || original && (item.id !== original.id || item.createdAt !== original.createdAt)
      || institutionHolidayFields.some(key => item[key] !== expected[key])) invalid('title', '保存回應的完整內容或版次不符，輸入仍保留。');
  }
  return item;
}
export function createInstitutionHolidayEditor({ existing, defaultDate = '' } = {}) {
  if (existing !== undefined && !institutionHolidayRecordValid(existing, own(existing, 'orgId'))) invalid('title', '原指定日期資料無法完整確認。');
  const fields = [
    { name: 'date', label: '指定日期', type: 'date', required: true, maxLength: 10 },
    { name: 'title', label: '名稱', required: true, maxLength: 200 },
    { name: 'kind', label: '人工指定類型', type: 'select', required: true, maxLength: 20, placeholder: '請選擇人工指定類型', options: Object.entries(institutionHolidayKinds).map(([value, label]) => ({ value, label })) },
    { name: 'sourceReference', label: '人工設定依據', type: 'textarea', maxLength: 2000, wide: true, help: '人工決定的文件識別或依據；不推定法定假日或正式核准。' },
    { name: 'note', label: '備註', type: 'textarea', maxLength: 10000, wide: true },
  ];
  const initial = Object.fromEntries(editable.map(key => [key, existing ? (['sourceReference', 'note'].includes(key) ? existing[key].replace(/\r\n?/g, '\n') : existing[key])
    : key === 'date' && institutionHolidayDate(defaultDate) ? defaultDate : '']));
  const baseline = { ...initial };
  return { fields, initial, buildPayload(values) {
    if (!holidayClosed(values, editable)) invalid('title', '表單欄位無法確認，請重新讀取。');
    const payload = {};
    for (const key of editable) {
      const raw = own(values, key); if (typeof raw !== 'string') invalid(key, '請提供文字輸入。');
      if (existing && raw === baseline[key]) continue;
      const value = ['date', 'kind'].includes(key) ? raw.trim() : raw;
      if (value.length > institutionHolidayLimits[key]) invalid(key, '內容超過允許長度。');
      if (!existing || value !== existing[key]) payload[key] = value;
    }
    const merged = { ...(existing || { sourceReference: '', note: '', status: 'active' }), ...payload };
    if (!institutionHolidayDate(merged.date)) invalid('date', '請選擇0001至9999年的有效完整日期。');
    if (typeof merged.title !== 'string' || !merged.title.trim() || /[\r\n]/.test(merged.title)) invalid('title', '請填寫非空白的單行名稱。');
    if (!Object.hasOwn(institutionHolidayKinds, merged.kind)) invalid('kind', '請明確選擇人工指定類型。');
    if (!institutionHolidayBusinessValid(Object.fromEntries(institutionHolidayFields.map(key => [key, merged[key]])))) invalid('title', '請核對完整保存欄位。');
    return payload;
  } };
}
