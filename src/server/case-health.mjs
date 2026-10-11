/** Human-authored health documentation only; no diagnosis, scoring or clinical advice. */
const shared = { caseId: 500, date: 10, source: 500, status: 8, note: 10000 };
export const caseHealthEntities = {
  'case-vaccinations': {
    fields: 'caseId date vaccine dose provider lotNumber source status note',
    required: ['caseId', 'date', 'vaccine'], statuses: ['active', 'inactive'],
    defaults: { dose: '', provider: '', lotNumber: '', source: '', status: 'active', note: '' },
    maxLengths: { ...shared, vaccine: 100, dose: 100, provider: 100, lotNumber: 100 },
  },
  'case-infection-records': {
    fields: 'caseId date category observation action followUpDate source status note',
    required: ['caseId', 'date', 'category', 'observation'], statuses: ['active', 'inactive'],
    defaults: { action: '', followUpDate: '', source: '', status: 'active', note: '' },
    maxLengths: { ...shared, category: 100, observation: 2000, action: 2000, followUpDate: 10 },
  },
  'case-vitals': {
    fields: 'caseId date time metric value unit source status note',
    required: ['caseId', 'date', 'time', 'metric', 'value', 'unit'], statuses: ['active', 'inactive'],
    defaults: { source: '', status: 'active', note: '' },
    maxLengths: { ...shared, time: 5, metric: 100, value: 40, unit: 100 },
  },
};
export const isCaseHealthEntity = entity => Object.hasOwn(caseHealthEntities, entity);
export function guardCaseHealthAccess(entity, ctx, _readOnly, fail) {
  if (isCaseHealthEntity(entity) && !['admin', 'supervisor'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可讀取與維護個案健康紀錄');
}
export function normalizeCaseHealthPayload(entity, payload) {
  if (!isCaseHealthEntity(entity)) return payload;
  // Free text and literal decimal values retain their exact representation.
  const normalized = new Set(['caseId', 'date', 'followUpDate', 'time', 'status']);
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, normalized.has(key) && typeof value === 'string' ? value.trim() : value]));
}
const validDate = (value, dateValid) => typeof value === 'string' && !value.startsWith('0000-') && dateValid(value);
export function validateCaseHealth(entity, data, old, fail, dateValid, db, ctx, get) {
  if (!isCaseHealthEntity(entity)) return;
  guardCaseHealthAccess(entity, ctx, false, fail);
  const spec = caseHealthEntities[entity];
  if (old && data.caseId !== old.caseId) fail(409, 'CASE_IMMUTABLE', '建立後不可更換紀錄所屬個案', { caseId: '不可變更' });
  for (const key of spec.fields.split(' ')) if (typeof data[key] !== 'string' || data[key].length > spec.maxLengths[key])
    fail(422, 'INVALID_FIELD', '健康紀錄欄位格式或長度不符', { [key]: `請提供最多${spec.maxLengths[key]}字的文字` });
  for (const key of spec.required) if (!data[key].trim()) fail(422, 'REQUIRED', '請填寫必要欄位', { [key]: '必填且不能只有空白' });
  if (!validDate(data.date, dateValid)) fail(422, 'INVALID_DATE', '紀錄日期須為有效YYYY-MM-DD', { date: '請核對日期' });
  if (!spec.statuses.includes(data.status)) fail(422, 'INVALID_STATUS', '健康紀錄狀態不合法', { status: '請選擇使用中或已停用' });
  if (entity === 'case-infection-records' && data.followUpDate) {
    if (!validDate(data.followUpDate, dateValid)) fail(422, 'INVALID_DATE', '人工追蹤日期格式不符', { followUpDate: '請核對日期' });
    if (data.followUpDate < data.date) fail(422, 'INVALID_FOLLOW_UP', '人工追蹤日期不可早於紀錄日期', { followUpDate: '請核對追蹤日期' });
  }
  if (entity === 'case-vitals') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)) fail(422, 'INVALID_TIME', '量測時間須為HH:mm', { time: '請提供00:00至23:59的時間' });
    if (!/^\d+(?:\.\d+)?$/.test(data.value) || data.value !== data.value.trim()) fail(422, 'INVALID_VALUE', '量測數值須為非負十進位文字', { value: '請使用整數或小數，不含符號、空白或指數' });
  }
  // Re-read the immutable parent inside the write transaction, including PATCH.
  if (!get(db, ctx.orgId, 'cases', data.caseId)) fail(422, 'INVALID_REFERENCE', '個案不存在或不屬於本機構', { caseId: '同機構個案必要' });
}
export function caseHealthQuery(entity, params, fail, dateValid) {
  if (!isCaseHealthEntity(entity)) return {};
  const allowed = new Set(['page', 'pageSize', 'q', 'caseId', 'date', 'status']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '查詢欄位不合法或重複', { [key]: '請使用單一合法欄位' });
  for (const key of ['page', 'pageSize']) if (params.has(key) && (!/^[1-9]\d*$/.test(params.get(key)) || params.get(key) !== params.get(key).trim() || !Number.isSafeInteger(Number(params.get(key))) || key === 'pageSize' && Number(params.get(key)) > 100))
    fail(422, 'INVALID_QUERY', '查詢分頁格式不符', { [key]: '請使用合法正整數分頁' });
  if (params.has('q') && params.get('q').length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字', { q: '文字過長' });
  if (params.has('caseId') && (!params.get('caseId').trim() || params.get('caseId').length > 500 || params.get('caseId') !== params.get('caseId').trim())) fail(422, 'INVALID_QUERY', '所屬個案查詢格式不符', { caseId: '請使用有效個案識別碼' });
  if (params.has('date') && !validDate(params.get('date'), dateValid)) fail(422, 'INVALID_DATE', '查詢日期格式不符', { date: '請使用有效日期' });
  if (params.has('status') && !caseHealthEntities[entity].statuses.includes(params.get('status'))) fail(422, 'INVALID_STATUS', '健康紀錄狀態不合法', { status: '請使用合法紀錄狀態' });
  return {};
}
