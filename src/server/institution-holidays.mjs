import { institutionHolidayFields, institutionHolidayKinds, institutionHolidayStatuses, institutionHolidayLimits,
  institutionHolidayBusinessValid, institutionHolidayRecordValid, institutionHolidayYear } from '../../public/data/institution-holiday-editor.js';

export const institutionHolidayEntities = { 'institution-holidays': {
  fields: institutionHolidayFields.join(' '), required: ['date', 'title', 'kind'], statuses: Object.keys(institutionHolidayStatuses),
  defaults: { sourceReference: '', note: '', status: 'active' }, maxLengths: institutionHolidayLimits,
} };
export const isInstitutionHolidayEntity = entity => entity === 'institution-holidays';
export function guardInstitutionHolidayAccess(entity, ctx, _readOnly, fail) {
  if (isInstitutionHolidayEntity(entity) && !['admin', 'supervisor'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '只有管理者與督導可查閱及維護機構人工指定日期。');
}
export function normalizeInstitutionHolidayPayload(entity, payload) {
  if (!isInstitutionHolidayEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, ['date', 'kind', 'status'].includes(key) && typeof value === 'string' ? value.trim() : value]));
}
export function institutionHolidayVisible(_db, ctx, entity, item) {
  if (!isInstitutionHolidayEntity(entity)) return true;
  return ['admin', 'supervisor'].includes(ctx.role) && institutionHolidayRecordValid(item, ctx.orgId);
}
export function institutionHolidayHistoryVisible(db, ctx, entity, snapshot, current) {
  return institutionHolidayVisible(db, ctx, entity, current) && institutionHolidayVisible(db, ctx, entity, snapshot)
    && snapshot.id === current.id && snapshot.createdAt === current.createdAt && snapshot.version <= current.version;
}
/** Call within the generic write/idempotency transaction. No model import or calendar effects. */
export function validateInstitutionHoliday(db, ctx, entity, data, old, fail, _dateValid, rows) {
  if (!isInstitutionHolidayEntity(entity)) return;
  guardInstitutionHolidayAccess(entity, ctx, false, fail);
  if (old && !institutionHolidayVisible(db, ctx, entity, old)) fail(404, 'NOT_FOUND', '找不到可維護的指定日期。');
  if (old && old.version === Number.MAX_SAFE_INTEGER) fail(409, 'VERSION_LIMIT', '保存版次已達安全上限，請核對資料。');
  if (!institutionHolidayBusinessValid(data)) {
    const fields = {};
    for (const key of institutionHolidayFields) if (typeof data?.[key] !== 'string' || data[key].length > institutionHolidayLimits[key]) fields[key] = '欄位格式或長度不符';
    if (!Object.hasOwn(institutionHolidayKinds, data?.kind)) fields.kind = '請選擇支援的人工類型';
    fail(422, 'INVALID_HOLIDAY', '請核對完整日期、單行名稱與人工指定類型。', fields);
  }
  if (!old && data.status !== 'active') fail(422, 'INITIAL_STATUS', '新指定日期先建立使用中紀錄；停用由明確操作保存。');
  let occupied;
  try { occupied = rows(db, ctx.orgId, entity); } catch { fail(409, 'HOLIDAY_DATA_INVALID', '既有指定日期無法完整確認，請先核對資料。'); }
  const count = db.prepare('SELECT count(*) n FROM records WHERE org_id=? AND entity=?'); count.setReadBigInts(true);
  if (!Array.isArray(occupied) || BigInt(occupied.length) !== count.get(ctx.orgId, entity).n
    || occupied.some(item => !institutionHolidayRecordValid(item, ctx.orgId))) fail(409, 'HOLIDAY_DATA_INVALID', '既有指定日期資料不完整或格式不符，請先核對資料。');
  if (data.status === 'active' && occupied.some(item => item.id !== old?.id && item.status === 'active' && item.date === data.date))
    fail(409, 'HOLIDAY_DATE_CONFLICT', '同機構此日已有使用中的設定，請先核對或停用原紀錄。', { date: '同日最多一筆使用中設定' });
}
export function institutionHolidayQuery(entity, params, fail, mode = 'list') {
  if (!isInstitutionHolidayEntity(entity)) return {};
  const allowed = mode === 'single' ? [] : mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'q', 'status', 'year'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '指定日期查詢欄位不合法或重複。');
  const positive = (key, fallback, maximum) => { const raw = params.get(key) ?? String(fallback), n = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || /[\r\n]/.test(raw) || !Number.isSafeInteger(n) || n > maximum) fail(422, 'INVALID_QUERY', '分頁須為合法正整數。', { [key]: '請核對分頁' }); return n; };
  const page = positive('page', 1, Number.MAX_SAFE_INTEGER), pageSize = positive('pageSize', 25, 100);
  if (params.has('year') && !institutionHolidayYear(params.get('year'))) fail(422, 'INVALID_QUERY', '年度須為0001至9999的四位數。', { year: '請核對年度' });
  if (params.has('status') && !Object.hasOwn(institutionHolidayStatuses, params.get('status'))) fail(422, 'INVALID_QUERY', '指定日期狀態不合法。');
  if (params.has('q') && params.get('q').length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字。');
  if (params.has('compare') && params.get('compare') !== 'previous') fail(422, 'INVALID_QUERY', '只可比較精確前版。');
  return { page, pageSize, q: params.get('q') || '', status: params.get('status') || '', year: params.get('year') || '' };
}
export function filterInstitutionHolidays(items, query) {
  const q = (query.q || '').toLocaleLowerCase('zh-TW');
  return items.filter(item => (!query.year || item.date.slice(0, 4) === query.year) && (!query.status || item.status === query.status)
    && (!q || [item.date, item.title, institutionHolidayKinds[item.kind], item.sourceReference, item.note].some(text => text.toLocaleLowerCase('zh-TW').includes(q))))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'zh-TW') || a.id.localeCompare(b.id));
}
