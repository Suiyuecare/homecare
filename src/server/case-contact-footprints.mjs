/** Candidate only: human-recorded visits/contact context, no GPS or diagnosis. */
export const CASE_CONTACT_FOOTPRINT_ENTITY = 'case-contact-footprints';
const fields = ['caseId', 'date', 'time', 'location', 'contactDescription', 'relatedCaseId', 'source', 'status', 'note'];
const required = ['caseId', 'date', 'location', 'contactDescription'];
const maxLengths = { caseId: 500, date: 10, time: 5, location: 200, contactDescription: 2000, relatedCaseId: 500, source: 500, status: 8, note: 10000 };
export const caseContactFootprintEntities = { [CASE_CONTACT_FOOTPRINT_ENTITY]: { fields: fields.join(' '), required, statuses: ['active', 'inactive'], defaults: { time: '', relatedCaseId: '', source: '', status: 'active', note: '' }, maxLengths } };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 500;
const dateValid = value => { if (typeof value !== 'string' || value.length !== 10 || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(value + 'T00:00:00Z'); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; };
export const isCaseContactFootprintEntity = entity => entity === CASE_CONTACT_FOOTPRINT_ENTITY;
export function guardCaseContactFootprintAccess(entity, ctx, _readOnly, fail) { if (isCaseContactFootprintEntity(entity) && !['admin', 'supervisor'].includes(ctx?.role)) fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可讀取與維護人工接觸足跡'); }
export function normalizeCaseContactFootprintPayload(entity, payload) {
  if (!isCaseContactFootprintEntity(entity) || !plain(payload)) return payload;
  // Free text, IDs, dates and times preserve exact input; strict validation never
  // turns an invalid padded identity/date/time into a seemingly valid record.
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, key === 'status' && typeof value === 'string' ? value.trim() : value]));
}
function shape(data, fail, calendarValid = dateValid) {
  if (!plain(data) || Object.keys(data).length !== fields.length || Object.keys(data).some(key => !fields.includes(key))) fail(422, 'UNKNOWN_FIELD', '接觸足跡須完整且不含未知欄位');
  for (const key of fields) if (typeof data[key] !== 'string' || data[key].length > maxLengths[key]) fail(422, 'INVALID_FIELD', '接觸足跡格式或長度不符', { [key]: `最多${maxLengths[key]}字文字` });
  for (const key of required) if (!data[key].trim()) fail(422, 'REQUIRED', '必要人工紀錄尚未填寫', { [key]: '必填且不可只有空白' });
  if (!identity(data.caseId) || data.relatedCaseId !== '' && !identity(data.relatedCaseId)) fail(422, 'INVALID_REFERENCE', '個案識別格式不合法');
  if (!dateValid(data.date) || !calendarValid(data.date)) fail(422, 'INVALID_DATE', '接觸日期須為有效YYYY-MM-DD且年份從0001起', { date: '請核對日期' });
  if (data.time !== '' && (data.time.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data.time))) fail(422, 'INVALID_TIME', '時間留空或填写00:00至23:59的HH:mm', { time: '未知可留空；不使用推定時間' });
  if (!['active', 'inactive'].includes(data.status)) fail(422, 'INVALID_STATUS', '接觸足跡狀態不合法');
  return data;
}
/** Called after generic closed payload assembly, inside the write transaction. */
export function validateCaseContactFootprint(entity, data, old, fail, calendarValid, db, ctx, get) {
  if (!isCaseContactFootprintEntity(entity)) return;
  guardCaseContactFootprintAccess(entity, ctx, false, fail); shape(data, fail, calendarValid);
  if (old && data.caseId !== old.caseId) fail(409, 'CASE_IMMUTABLE', '人工接觸足跡所屬個案建立後固定', { caseId: '不可更換原個案' });
  if (!get(db, ctx.orgId, 'cases', data.caseId)) fail(422, 'INVALID_REFERENCE', '原個案不存在或不屬於本機構', { caseId: '同機構原個案必要' });
  if (data.relatedCaseId && !get(db, ctx.orgId, 'cases', data.relatedCaseId)) fail(422, 'INVALID_REFERENCE', '相關個案不存在或不屬於本機構', { relatedCaseId: '請選擇同機構相關個案，未知可留空' });
}
export function caseContactFootprintQuery(entity, params, fail, calendarValid = dateValid, mode = 'list') {
  if (!isCaseContactFootprintEntity(entity)) return {};
  if (!['list', 'single', 'history'].includes(mode)) fail(422, 'INVALID_QUERY', '接觸足跡查詢模式未確認');
  const allowed = mode === 'single' ? [] : mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'q', 'caseId', 'relatedCaseId', 'date', 'status'], result = mode === 'single' ? {} : { page: 1, pageSize: 25 };
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '不接受未知或重複接觸足跡查詢', { [key]: '只提供一次合法欄位' });
  for (const key of ['page', 'pageSize']) if (params.has(key)) { const value = params.get(key); if (value !== value.trim() || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || key === 'pageSize' && Number(value) > 100) fail(422, 'INVALID_QUERY', '分頁格式不符', { [key]: '請使用合法正整數' }); result[key] = Number(value); }
  if (mode === 'history') { if (params.has('compare')) { if (params.get('compare') !== 'previous') fail(422, 'INVALID_QUERY', '歷程只接受與前版比較'); result.compare = 'previous'; } return result; }
  for (const key of ['caseId', 'relatedCaseId']) if (params.has(key)) { if (!identity(params.get(key))) fail(422, 'INVALID_QUERY', '個案查詢識別格式不符'); result[key] = params.get(key); }
  if (params.has('date')) { if (!dateValid(params.get('date')) || !calendarValid(params.get('date'))) fail(422, 'INVALID_DATE', '查詢日期不合法'); result.date = params.get('date'); }
  if (params.has('status')) { if (!['active', 'inactive'].includes(params.get('status'))) fail(422, 'INVALID_STATUS', '查詢狀態不合法'); result.status = params.get('status'); }
  if (params.has('q')) { if (params.get('q').length > 200) fail(422, 'INVALID_QUERY', '搜尋最多200字'); result.q = params.get('q'); }
  return result;
}
/** Current same-org references remain necessary for any historical snapshot. */
export function caseContactFootprintHistoryVisible(db, ctx, snapshot, current, get, calendarValid = dateValid) {
  if (!['admin', 'supervisor'].includes(ctx?.role) || !plain(snapshot) || !plain(current)) return false;
  try {
    const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
    if (Object.keys(snapshot).length !== fields.length + metadata.length || Object.keys(snapshot).some(key => ![...fields, ...metadata].includes(key)) || snapshot.id !== current.id || snapshot.orgId !== ctx.orgId || snapshot.caseId !== current.caseId || !identity(snapshot.id) || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || ['createdAt', 'updatedAt'].some(key => typeof snapshot[key] !== 'string' || !snapshot[key])) return false;
    const data = Object.fromEntries(fields.map(key => [key, snapshot[key]])), fail = () => { throw new Error('invalid snapshot'); }; shape(data, fail, calendarValid);
    return Boolean(get(db, ctx.orgId, 'cases', data.caseId) && (!data.relatedCaseId || get(db, ctx.orgId, 'cases', data.relatedCaseId)));
  } catch { return false; }
}
