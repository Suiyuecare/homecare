import { recurringShiftSpan } from '../../public/data/shift-span.js';
import { entitySpan, spanIntervalsOverlap } from './shift-span.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HttpError, fail, dateValid, get, rows, business, validatePayload, validate, writeGuard, insert, replace, saveVersion, interval, overlaps, audit, id, publicRecord, entities } from './model.mjs';
import { shiftBatchDefinition, previewShiftBatch, commitShiftBatch } from './shift-batches.mjs';
import { SHIFT_SERIES_ENTITY, SHIFT_SERIES_FIELDS_STRING } from './shift-series-schema.mjs';
export { shiftSeriesEntities } from './shift-series-schema.mjs';

export const SHIFT_SERIES_MAX_DAYS = 93;
const DAY_MS = 86400000, entityName = SHIFT_SERIES_ENTITY;
const fields = SHIFT_SERIES_FIELDS_STRING;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && !/[\r\n]/.test(value) && value.length <= 500;
const day = value => typeof value === 'string' && !value.startsWith('0000-') && dateValid(value) ? Date.parse(value + 'T00:00:00Z') : NaN;
const reject = (field, message, code = 'INVALID_FIELD') => fail(422, code, message, { [field]: message });
const issue = error => ({ code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) });
// This capability is created only by the synchronous server move preflight.
// Neither a request property nor a caller-owned skip list can activate it.
const moveScopes = new WeakMap();
const contextKey = ctx => JSON.stringify([ctx.orgId, ctx.role, ctx.user?.id, ctx.user?.employeeId]);
function withMoveScope(db, ctx, pairs, callback) {
  if (moveScopes.has(db)) fail(500, 'MOVE_SCOPE_NESTED', '整組移日驗證不可巢狀');
  const scope = { ctx, key: contextKey(ctx), pairs: new Map(pairs.map(pair => [pair.old.id, pair])) };
  moveScopes.set(db, scope);
  try { return callback(); } finally { moveScopes.delete(db); }
}
function isScopedMoveTarget(db, ctx, old, data) {
  const scope = moveScopes.get(db), pair = scope?.pairs.get(old?.id);
  return Boolean(scope && scope.ctx === ctx && scope.key === contextKey(ctx) && ['admin', 'supervisor'].includes(ctx.role)
    && pair && pair.old === old && pair.old.version === old.version && pair.data === data);
}
/** Model overlap filter: exact selected old positions, only within preflight. */
export function excludeShiftSeriesMoveOldPosition(db, ctx, old, data, other) {
  if (!isScopedMoveTarget(db, ctx, old, data)) return false;
  const pair = moveScopes.get(db).pairs.get(other?.id);
  return Boolean(pair && pair.old.version === other.version && isDeepStrictEqual(pair.old, other));
}
function assertDataOnly(value, ancestors = new Set(), depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object' || depth > 20 || ancestors.has(value)) fail(400, 'INVALID_BODY', '操作只接受有限JSON資料');
  const array = Array.isArray(value), descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) fail(400, 'INVALID_BODY', '操作只接受普通JSON資料');
  if (array && (!Number.isSafeInteger(descriptors.length?.value) || descriptors.length.value > 10000 || keys.length !== descriptors.length.value + 1)) fail(400, 'INVALID_BODY', '陣列須為完整有限JSON資料');
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= descriptors.length.value)) fail(400, 'INVALID_BODY', '操作不接受存取器或非JSON欄位');
    assertDataOnly(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
function storageIssue() { fail(409, 'BROKEN_OCCURRENCE', '本機構關鍵資料或不可變版本無法完整確認；請先核對，未略過或修補'); }
function assertTrialBillingSnapshot(record) {
  const snapshot = record.billingSnapshot, employee = snapshot?.employee, string = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
  const closed = (value, keys) => plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
  if (record.status !== 'approved' || !closed(snapshot, ['capturedAt', 'currency', 'trial', 'source', 'serviceMinutes', 'employee', 'items'])
    || !string(snapshot.capturedAt) || !Number.isFinite(Date.parse(snapshot.capturedAt)) || snapshot.currency !== 'TWD' || snapshot.trial !== true || snapshot.source !== 'approval'
    || !Number.isSafeInteger(snapshot.serviceMinutes) || snapshot.serviceMinutes < 1 || snapshot.serviceMinutes > (Object.hasOwn(record, 'actualEndDate') ? 2879 : 1439)
    || !closed(employee, ['id', 'name', 'employeeNo', 'hourlyRateCents']) || employee.id !== record.employeeId || !identity(employee.id)
    || !string(employee.name) || !string(employee.employeeNo) || !Number.isSafeInteger(employee.hourlyRateCents) || employee.hourlyRateCents < 0 || employee.hourlyRateCents > 1e9
    || !Array.isArray(record.services) || !Array.isArray(snapshot.items) || snapshot.items.length !== record.services.length || !snapshot.items.length || snapshot.items.length > 100) storageIssue();
  const actualSpan = entitySpan('service-records', record, fail);
  if (snapshot.serviceMinutes !== actualSpan.durationMinutes) storageIssue();
  snapshot.items.forEach((item, index) => {
    const source = record.services[index];
    if (!closed(item, ['serviceItemId', 'code', 'name', 'quantity', 'unitPriceCents', 'amountCents']) || !identity(item.serviceItemId) || item.serviceItemId !== source?.serviceItemId
      || !string(item.code) || !string(item.name) || !Number.isSafeInteger(item.quantity) || item.quantity !== source.quantity || item.quantity < 1 || item.quantity > 10000
      || !Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0 || item.unitPriceCents > 1e9
      || !Number.isSafeInteger(item.amountCents) || item.amountCents !== item.unitPriceCents * item.quantity) storageIssue();
  });
}
function readSnapshot(db, orgId, entity, recordId, version) {
  const statement = db.prepare('SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?'); statement.setReadBigInts(true);
  const row = statement.get(orgId, entity, recordId, version); let snapshot;
  try { snapshot = JSON.parse(row?.snapshot); } catch { storageIssue(); }
  const allowed = entities[entity]?.fields.split(' ');
  if (!row || row.org_id !== orgId || row.entity !== entity || row.record_id !== recordId || row.version !== BigInt(version)
    || !plain(snapshot) || !allowed || Object.keys(snapshot).length !== allowed.length + metadata.length - ['endDate','endDay'].filter(key=>allowed.includes(key)&&!Object.hasOwn(snapshot,key)).length
    || Object.keys(snapshot).some(key => ![...allowed, ...metadata].includes(key)) || snapshot.id !== recordId || snapshot.orgId !== orgId
    || snapshot.version !== version || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1
    || !identity(snapshot.createdAt) || !identity(snapshot.updatedAt) || row.created_at !== snapshot.updatedAt || !identity(row.source)) storageIssue();
  return snapshot;
}
/** Fail closed on every SQL row; malformed dependencies may not disappear. */
function criticalRows(db, orgId, entity) {
  const statement = db.prepare('SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY id'); statement.setReadBigInts(true);
  const raw = statement.all(orgId, entity), businessFields = entities[entity]?.fields.split(' '), allowed = businessFields && [...businessFields, ...(entity === 'service-records' ? ['billingSnapshot'] : [])];
  if (!allowed) storageIssue();
  return raw.map(row => {
    let data; try { data = JSON.parse(row.data); } catch { storageIssue(); }
    if (!plain(data) || row.org_id !== orgId || row.entity !== entity || !identity(row.id) || typeof row.version !== 'bigint'
      || row.version < 1n || row.version > BigInt(Number.MAX_SAFE_INTEGER) || !identity(row.created_at) || !identity(row.updated_at)
      || Object.keys(data).some(key => !allowed.includes(key))) storageIssue();
    try {
      const payload = entity === 'service-records' ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'billingSnapshot')) : data;
      validatePayload(entity, payload);
      if (Object.hasOwn(data, 'billingSnapshot')) assertTrialBillingSnapshot(data);
      const spec = entities[entity];
      if (spec.required.some(key => data[key] === undefined || data[key] === null || data[key] === '' || Array.isArray(data[key]) && !data[key].length) || spec.statuses && !spec.statuses.includes(data.status)) storageIssue();
      for (const key of ['date', 'validFrom', 'validTo']) if (Object.hasOwn(data, key) && data[key] !== '' && !dateValid(data[key])) storageIssue();
      if (Object.hasOwn(data, 'services') && (!Array.isArray(data.services) || !data.services.length || data.services.length > 100 || new Set(data.services.map(line => line?.serviceItemId)).size !== data.services.length || data.services.some(line => !plain(line) || Object.keys(line).length !== 2 || !identity(line.serviceItemId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000))) storageIssue();
      if (['shifts', 'leave-requests'].includes(entity)) entitySpan(entity, data, fail);
      if (entity === 'service-records') entitySpan(entity, data, fail);
    } catch { storageIssue(); }
    const item = { ...data, id: row.id, orgId, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at };
    // Older generic records may omit optional fields: compare their exact head,
    // not a synthesized default or a silently repaired current row.
    const headStatement = db.prepare('SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?'); headStatement.setReadBigInts(true);
    const head = headStatement.get(orgId, entity, row.id, item.version); let snapshot;
    try { snapshot = JSON.parse(head?.snapshot); } catch { storageIssue(); }
    if (!head || head.version !== row.version || head.org_id !== orgId || head.entity !== entity || head.record_id !== row.id
      || head.created_at !== item.updatedAt || !identity(head.source) || !isDeepStrictEqual(snapshot, item)) storageIssue();
    return item;
  });
}
function assertOccurrenceOrigin(db, ctx, link, shift) {
  const origin = readSnapshot(db, ctx.orgId, 'shifts', shift.id, 1);
  if (origin.date !== link.date || origin.caseId !== shift.caseId || origin.createdAt !== shift.createdAt
    || !Number.isFinite(day(origin.date)) || !['scheduled', 'completed', 'cancelled'].includes(origin.status)) storageIssue();
}
function movedDate(date, daysOffset) {
  const target = day(date) + daysOffset * DAY_MS;
  if (!Number.isFinite(target) || target < day('0001-01-01') || target > day('9999-12-31')) reject('daysOffset', '移日後須在0001-01-01至9999-12-31內');
  return new Date(target).toISOString().slice(0, 10);
}
export const isShiftSeriesEntity = entity => entity === entityName;
export function guardShiftSeriesAccess(entity, ctx, readOnly, failer = fail) { if (isShiftSeriesEntity(entity) && !['admin', 'supervisor'].includes(ctx.role)) failer(403, 'ROLE_FORBIDDEN', '只有管理者或督導可維護永久週期排班'); }
export function normalizeShiftSeriesPayload(entity, payload) {
  if (!isShiftSeriesEntity(entity) || !plain(payload)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' && ['name', 'status'].includes(key) ? value.trim() : value]));
}
function shape(data) {
  if (!plain(data) || Object.keys(data).some(key => !fields.split(' ').includes(key))) reject('name', '週期設定含未知欄位');
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100) reject('name', '週期名稱必填，最多100字');
  for (const key of ['caseId', 'employeeId', 'carePlanId']) if (!identity(data[key])) reject(key, '請選擇同機構的個案、計畫與人員');
  if (!Number.isFinite(day(data.startDate))) reject('startDate', '開始日期須為有效YYYY-MM-DD且年份從0001起');
  if (data.endDate !== '' && !Number.isFinite(day(data.endDate))) reject('endDate', '尾日留空或填寫有效YYYY-MM-DD');
  if (data.endDate && data.endDate < data.startDate) reject('endDate', '尾日不可早於開始日期');
  if (!Number.isSafeInteger(data.intervalWeeks) || data.intervalWeeks < 1 || data.intervalWeeks > 4) reject('intervalWeeks', '每隔1至4週，必須是整數');
  if (!Array.isArray(data.weekdays) || !data.weekdays.length || data.weekdays.length > 7 || new Set(data.weekdays).size !== data.weekdays.length || data.weekdays.some(value => !Number.isSafeInteger(value) || value < 1 || value > 7)) reject('weekdays', '星期須為不重複的1至7整數');
  if (!Array.isArray(data.services) || !data.services.length || data.services.length > 100 || new Set(data.services.map(line => line?.serviceItemId)).size !== data.services.length) reject('services', '請設定1至100項不重複服務');
  for (const line of data.services) if (!plain(line) || Object.keys(line).length !== 2 || Object.keys(line).some(key => !['serviceItemId', 'quantity'].includes(key)) || !identity(line.serviceItemId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000) reject('services', '服務識別及1至10000整數數量不合法');
  for (const key of ['startTime', 'endTime']) if (typeof data[key] !== 'string' || data[key].length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data[key])) reject(key, '時間須為同日有效HH:mm');
  seriesSpan(data.startDate,data);
  if (!['active', 'paused', 'ended'].includes(data.status)) reject('status', '週期狀態不合法');
  if (typeof data.note !== 'string' || data.note.length > 10000) reject('note', '交班備註最多10000字');
  return data;
}
export function validateShiftSeries(db, ctx, entity, data, old, failer = fail) {
  if (!isShiftSeriesEntity(entity)) return; guardShiftSeriesAccess(entity, ctx, false, failer); shape(data);
  if (old && (data.caseId !== old.caseId || data.startDate !== old.startDate)) failer(409, 'IMMUTABLE_SERIES', '個案與週期起算日期建立後固定；請另建週期');
  if (old?.status === 'ended') failer(409, 'SERIES_ENDED', '已結束週期設定不能再更改');
  const caseItem = get(db, ctx.orgId, 'cases', data.caseId), employee = get(db, ctx.orgId, 'employees', data.employeeId), plan = get(db, ctx.orgId, 'care-plans', data.carePlanId);
  if (!caseItem || !employee || !plan || plan.caseId !== data.caseId) failer(422, 'INVALID_REFERENCE', '個案、人員及相符計畫須屬於本機構');
  if (data.status === 'active' && (caseItem.status !== 'active' || employee.status !== 'active' || plan.status !== 'active')) failer(422, 'INACTIVE_ASSIGNMENT', '啟用週期需要服務中的個案、人員與計畫');
  if (data.services.some(line => !plan.services.some(allowed => allowed.serviceItemId === line.serviceItemId))) failer(422, 'PLAN_SERVICE', '服務項目不在照顧計畫內');
  for (const line of data.services) { const service = get(db, ctx.orgId, 'service-items', line.serviceItemId); if (!service || data.status === 'active' && service.status !== 'active') failer(422, 'INVALID_SERVICE', '服務須屬於本機構，啟用時須為使用中'); }
}
export function shiftSeriesHistoryVisible(db, ctx, snapshot, current) {
  try {
    guardShiftSeriesAccess(entityName, ctx, true); if (!plain(snapshot) || snapshot.orgId !== ctx.orgId || snapshot.id !== current.id || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || snapshot.caseId !== current.caseId || snapshot.startDate !== current.startDate) return false;
    shape(business(snapshot));
    return Boolean(get(db, ctx.orgId, 'cases', snapshot.caseId) && get(db, ctx.orgId, 'employees', snapshot.employeeId) && get(db, ctx.orgId, 'care-plans', snapshot.carePlanId)?.caseId === current.caseId
      && snapshot.services.every(line => get(db, ctx.orgId, 'service-items', line.serviceItemId)));
  } catch { return false; }
}
export function shiftSeriesQuery(entity, params) {
  if (!isShiftSeriesEntity(entity)) return {};
  const allowed = ['page', 'pageSize', 'q', 'caseId', 'employeeId', 'status'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) reject(key, '不接受未知或重複查詢', 'INVALID_QUERY');
  const result = {};
  for (const key of ['caseId', 'employeeId']) if (params.has(key)) { if (!identity(params.get(key))) reject(key, '查詢識別不合法', 'INVALID_QUERY'); result[key] = params.get(key); }
  if (params.has('status')) { if (!['active', 'paused', 'ended'].includes(params.get('status'))) reject('status', '狀態查詢不合法', 'INVALID_QUERY'); result.status = params.get('status'); }
  if (params.has('q')) { if (params.get('q').length > 200) reject('q', '搜尋最多200字', 'INVALID_QUERY'); result.q = params.get('q'); }
  for (const key of ['page', 'pageSize']) if (params.has(key)) { const value = params.get(key); if (value !== value.trim() || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || key === 'pageSize' && Number(value) > 100) reject(key, '分頁格式不合法', 'INVALID_QUERY'); result[key] = Number(value); }
  return result;
}
/** Internal records preserve the existing complete backup/restore schema. */
export const SHIFT_SERIES_OCCURRENCE_ENTITY = 'shift-series-occurrences';
export function initShiftSeriesTables() { /* Compatibility hook: no extra table, trigger or schema. */ }
export function shiftSeriesOccurrenceId(orgId, seriesId, date) {
  const bytes = createHash('sha256').update(JSON.stringify([orgId, seriesId, date])).digest().subarray(0, 16); bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const occurrenceLinks = (db, ctx) => {
  const statement = db.prepare('SELECT id,version FROM records WHERE org_id=? AND entity=?'); statement.setReadBigInts(true);
  const raw = statement.all(ctx.orgId, SHIFT_SERIES_OCCURRENCE_ENTITY), links = rows(db, ctx.orgId, SHIFT_SERIES_OCCURRENCE_ENTITY);
  // Guarded generic reads omit malformed storage; ownership links may never be
  // omitted, since absence would unlock the original case/date for editing.
  if (raw.length !== links.length || raw.some(row => row.version !== 1n || !links.some(link => link.id === row.id && link.version === 1))) fail(409, 'BROKEN_OCCURRENCE', '本機構有無法確認的產班追溯，請先核對；未略過或修補');
  for (const link of links) {
    const statement = db.prepare('SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=1'); statement.setReadBigInts(true);
    const head = statement.get(ctx.orgId, SHIFT_SERIES_OCCURRENCE_ENTITY, link.id); let frozen;
    try { frozen = JSON.parse(head?.snapshot); } catch { storageIssue(); }
    if (!head || head.version !== 1n || head.created_at !== link.updatedAt || !identity(head.source) || !isDeepStrictEqual(frozen, link)) storageIssue();
    try { occurrence(db, ctx, requireSeries(db, ctx, link.seriesId), link); }
    catch { fail(409, 'BROKEN_OCCURRENCE', '本機構有無法確認的產班追溯，請先核對；未略過或修補'); }
  }
  return links;
};
const occurrenceLink = (db, ctx, seriesId, date) => {
  const matches = occurrenceLinks(db, ctx).filter(link => link.seriesId === seriesId && link.date === date);
  if (matches.length > 1 || matches.some(link => link.id !== shiftSeriesOccurrenceId(ctx.orgId, seriesId, date))) fail(409, 'BROKEN_OCCURRENCE', '產班原日期有重複或錯誤追溯');
  return matches[0];
};
function requireSeries(db, ctx, seriesId, version) {
  guardShiftSeriesAccess(entityName, ctx, true); if (!identity(seriesId)) fail(404, 'NOT_FOUND', '找不到本機構週期');
  const series = criticalRows(db, ctx.orgId, entityName).find(item => item.id === seriesId); if (!series || !shiftSeriesHistoryVisible(db, ctx, series, series)) fail(404, 'NOT_FOUND', '找不到可操作的本機構週期');
  if (version !== undefined && series.version !== version) fail(409, 'VERSION_CONFLICT', '週期設定已更新，請重新讀取'); return series;
}
function boundedRange(payload, names) {
  if (!plain(payload)) fail(400, 'INVALID_BODY', '請提供JSON物件');
  for (const key of Object.keys(payload)) if (!names.includes(key)) reject(key, '不允許的週期操作欄位', 'UNKNOWN_FIELD');
  if (!Number.isSafeInteger(payload.version) || payload.version < 1) reject('version', '目前週期版次必填');
  for (const key of ['fromDate', 'toDate']) if (!Number.isFinite(day(payload[key]))) reject(key, '請填寫有效YYYY-MM-DD範圍');
  if (payload.toDate < payload.fromDate || (day(payload.toDate) - day(payload.fromDate)) / DAY_MS + 1 > SHIFT_SERIES_MAX_DAYS) reject('toDate', '含起訖最多93個日曆日，尾日不可早於起日');
  return { version: payload.version, fromDate: payload.fromDate, toDate: payload.toDate };
}
export function shiftSeriesDates(series, range) {
  shape(business(series)); const first = day(range.fromDate), last = day(range.toDate), anchor = day(series.startDate);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || (last - first) / DAY_MS + 1 > SHIFT_SERIES_MAX_DAYS) reject('toDate', '產班範圍須為有效且含兩端最多93日');
  const monday = anchor - ((new Date(anchor).getUTCDay() + 6) % 7) * DAY_MS, days = [];
  for (let date = first; date <= last; date += DAY_MS) { const text = new Date(date).toISOString().slice(0, 10); if (text < series.startDate || series.endDate && text > series.endDate) continue;
    const week = Math.floor((date - monday) / (7 * DAY_MS)), weekday = (new Date(date).getUTCDay() + 6) % 7 + 1; if (week % series.intervalWeeks === 0 && series.weekdays.includes(weekday)) days.push(text); }
  return days;
}
function candidate(series, date) { return validatePayload('shifts', { ...seriesSpan(date,series), caseId: series.caseId, employeeId: series.employeeId, carePlanId: series.carePlanId, date, startTime: series.startTime, endTime: series.endTime, services: series.services.map(line => ({ ...line })), status: 'scheduled', note: series.note }); }
function occurrence(db, ctx, series, link) {
  const snapshot = link.seriesSnapshot, shift = criticalRows(db, ctx.orgId, 'shifts').find(item => item.id === link.shiftId);
  if (!plain(link) || Object.keys(link).some(key => !['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'seriesId', 'date', 'shiftId', 'seriesVersion', 'seriesSnapshot'].includes(key)) || link.orgId !== ctx.orgId || link.seriesId !== series.id || link.version !== 1 || link.id !== shiftSeriesOccurrenceId(ctx.orgId, series.id, link.date) || !identity(link.shiftId) || !Number.isSafeInteger(link.seriesVersion) || link.seriesVersion < 1 || !Number.isFinite(day(link.date))
    || !shiftSeriesHistoryVisible(db, ctx, snapshot, series) || snapshot.version !== link.seriesVersion || !shift || !Number.isFinite(day(shift.date)) || shift.caseId !== series.caseId || !Number.isSafeInteger(shift.version) || shift.version < 1
    || typeof link.createdAt !== 'string' || typeof link.updatedAt !== 'string') fail(409, 'BROKEN_OCCURRENCE', '產班追溯與目前班次不相符，請先核對');
  assertOccurrenceOrigin(db, ctx, link, shift);
  if(Object.hasOwn(snapshot,'endDay')){const expected=candidate(snapshot,link.date),original=readSnapshot(db,ctx.orgId,'shifts',shift.id,1);if(!Object.hasOwn(original,'endDate')||original.endDate!==expected.endDate||original.startTime!==expected.startTime||original.endTime!==expected.endTime)storageIssue();}
  if (!shiftSeriesDates(snapshot, { fromDate: link.date, toDate: link.date }).includes(link.date)) fail(409, 'BROKEN_OCCURRENCE', '產班日期不符合原週期快照');
  const hasRecord = criticalRows(db, ctx.orgId, 'service-records').some(record => record.shiftId === shift.id), editable = shift.status === 'scheduled' && !hasRecord;
  return { date: link.date, ...(shift.date !== link.date ? { movedDate: shift.date } : {}), shiftId: shift.id, seriesVersion: link.seriesVersion, seriesSnapshot: publicRecord(ctx, snapshot), shift: publicRecord(ctx, shift), createdAt: link.createdAt, editable, lockReason: hasRecord ? '已有服務紀錄' : shift.status === 'completed' ? '班次已完成' : shift.status === 'cancelled' ? '班次已取消' : '' };
}
export function readShiftSeriesOccurrences(db, ctx, seriesId, range) {
  guardShiftSeriesAccess(entityName, ctx, true); range = boundedRange(range, ['version', 'fromDate', 'toDate']);
  const series = requireSeries(db, ctx, seriesId, range.version);
  const links = occurrenceLinks(db, ctx).filter(link => link.seriesId === series.id && link.date >= range.fromDate && link.date <= range.toDate).sort((left, right) => left.date.localeCompare(right.date));
  return { series: publicRecord(ctx, series), range, items: links.map(link => occurrence(db, ctx, series, link)), total: links.length };
}
export function shiftSeriesOccurrenceQuery(params) {
  const keys = ['fromDate', 'toDate', 'version']; for (const key of params.keys()) if (!keys.includes(key) || params.getAll(key).length !== 1) reject(key, '追溯查詢不接受未知或重複欄位', 'INVALID_QUERY');
  const version = params.get('version') || ''; if (version !== version.trim() || !/^[1-9]\d*$/.test(version)) reject('version', '請提供目前週期版次', 'INVALID_QUERY');
  return boundedRange({ version: Number(params.get('version')), fromDate: params.get('fromDate'), toDate: params.get('toDate') }, keys);
}
export function previewShiftSeriesGeneration(db, ctx, seriesId, payload) {
  guardShiftSeriesAccess(entityName, ctx, false); const range = boundedRange(payload, ['version', 'fromDate', 'toDate']), series = requireSeries(db, ctx, seriesId, range.version);
  if (series.status !== 'active') fail(409, 'SERIES_NOT_ACTIVE', '只有使用中的週期可產班');
  validateShiftSeries(db, ctx, entityName, business(series), null);
  const items = shiftSeriesDates(series, range).map(date => {
    const link = occurrenceLink(db, ctx, series.id, date);
    try {
      if (link) return { date, status: 'existing', occurrence: occurrence(db, ctx, series, link), conflicts: [] };
      const data = candidate(series, date); writeGuard(ctx, 'shifts', data); validate(db, ctx, 'shifts', data);
      return { date, status: 'ready', candidate: data, conflicts: [] };
    } catch (error) { if (!(error instanceof HttpError)) throw error; return { date, status: 'conflict', conflicts: [issue(error)] }; }
  });
  markFinalSpanConflicts(items.filter(item=>item.status==='ready'), row=>row.candidate,'逐期產班的完整時段互相重疊');
  const readyCount = items.filter(item => item.status === 'ready').length, existingCount = items.filter(item => item.status === 'existing').length, conflictCount = items.filter(item => item.status === 'conflict').length;
  return { series: publicRecord(ctx, series), range, items, total: items.length, readyCount, existingCount, conflictCount, canCommit: readyCount > 0 && conflictCount === 0 };
}
export function commitShiftSeriesGeneration(db, ctx, seriesId, payload) {
  guardShiftSeriesAccess(entityName, ctx, false); if (!db.isTransaction) fail(500, 'SERIES_TRANSACTION_REQUIRED', '產班必須在單一交易內保存');
  const preview = previewShiftSeriesGeneration(db, ctx, seriesId, payload);
  if (!preview.total) reject('toDate', '本期間沒有符合週期的日期', 'NO_OCCURRENCES');
  if (preview.conflictCount) { const error = new HttpError(409, 'SERIES_GENERATION_CONFLICT', '逐期產班重新檢查有衝突，沒有任何新班次保存'); error.details = { preview }; throw error; }
  const batchId = id(), items = [];
  for (const entry of preview.items) {
    if (entry.status === 'existing') { items.push({ date: entry.date, created: false, occurrence: entry.occurrence }); continue; }
    const series = requireSeries(db, ctx, seriesId, payload.version), data = candidate(series, entry.date); validateShiftSeries(db, ctx, entityName, business(series), null); writeGuard(ctx, 'shifts', data); validate(db, ctx, 'shifts', data);
    const shift = insert(db, ctx.orgId, 'shifts', data), timestamp = new Date().toISOString();
    if (occurrenceLinks(db, ctx).some(link => link.shiftId === shift.id)) fail(409, 'DUPLICATE_OCCURRENCE', '班次已有週期追溯');
    const linkData = { seriesId: series.id, date: entry.date, shiftId: shift.id, seriesVersion: series.version, seriesSnapshot: series }, linkId = shiftSeriesOccurrenceId(ctx.orgId, series.id, entry.date);
    const linkItem = { ...linkData, id: linkId, orgId: ctx.orgId, version: 1, createdAt: timestamp, updatedAt: timestamp };
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(linkId, ctx.orgId, SHIFT_SERIES_OCCURRENCE_ENTITY, JSON.stringify(linkData), 1, timestamp, timestamp); saveVersion(db, linkItem, 'create');
    audit(db, ctx, 'record.create', 'shifts', shift.id, { operation: 'shift-series-generation', seriesId, seriesVersion: series.version, batchId, status: shift.status, version: 1 });
    const link = occurrenceLink(db, ctx, seriesId, entry.date);
    items.push({ date: entry.date, created: true, occurrence: occurrence(db, ctx, series, link) });
  }
  return { batchId, series: preview.series, range: preview.range, items, total: items.length, createdCount: items.filter(item => item.created).length, existingCount: items.filter(item => !item.created).length };
}
/** Ordinary single-shift edits retain the immutable occurrence ownership/date. */
export function assertShiftSeriesShiftEdit(db, ctx, entity, data, old) {
  if (entity !== 'shifts' || !old) return;
  const links = occurrenceLinks(db, ctx).filter(link => link.shiftId === old.id); if (!links.length) return; if (links.length !== 1) fail(409, 'BROKEN_OCCURRENCE', '班次有重複週期追溯'); const link = links[0];
  const series = requireSeries(db, ctx, link.seriesId); occurrence(db, ctx, series, link);
  if (data.caseId !== old.caseId || data.date !== old.date && !isScopedMoveTarget(db, ctx, old, data)) fail(409, 'SERIES_SHIFT_IMMUTABLE', '週期產生的班次個案與原日期固定；請取消該班，再另行人工安排');
}
function adjustmentDefinition(payload) {
  assertDataOnly(payload);
  const range = boundedRange(payload, ['version', 'fromDate', 'toDate', 'action', 'items', 'employeeId', 'startTime', 'endTime', 'daysOffset', 'reason', 'endDay']);
  if (payload.action === 'move') {
    if (['employeeId', 'startTime', 'endTime', 'endDay'].some(key => Object.hasOwn(payload, key))) reject('action', '整組移日僅接受日數、班次及原因');
    if (!Number.isSafeInteger(payload.daysOffset) || payload.daysOffset === 0 || Math.abs(payload.daysOffset) > 3652058) reject('daysOffset', '移動日數須為非零安全整數，正數往後、負數往前');
    const base = shiftBatchDefinition({ action: 'cancel', items: payload.items, reason: payload.reason });
    return { range, definition: { ...base, action: 'move', daysOffset: payload.daysOffset } };
  }
  if (Object.hasOwn(payload, 'daysOffset')) reject('daysOffset', '只有整組移日可提供日數');
  if (payload.action === 'reschedule') {
    if (Object.hasOwn(payload, 'employeeId')) reject('employeeId', '調整時段不接受改派人員');
    for (const key of ['startTime', 'endTime']) if (typeof payload[key] !== 'string' || payload[key].length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload[key])) reject(key, '請填寫同日有效HH:mm');
    if(Object.hasOwn(payload,'endDay')&&!['same','next'].includes(payload.endDay))reject('endDay','只接受same或next；missing沿原班保存模式');
    if(Object.hasOwn(payload,'endDay'))seriesSpan(range.fromDate,payload);
    const base = shiftBatchDefinition({ action: 'cancel', items: payload.items, reason: payload.reason }); return { range, definition: { ...base, action: 'reschedule', startTime: payload.startTime, endTime: payload.endTime, ...(Object.hasOwn(payload,'endDay')?{endDay:payload.endDay}:{}) } };
  }
  if (Object.hasOwn(payload, 'startTime') || Object.hasOwn(payload, 'endTime') || Object.hasOwn(payload,'endDay')) reject('startTime', '改派或取消不接受調整時段');
  const definition = shiftBatchDefinition(Object.fromEntries(Object.entries(payload).filter(([key]) => !['version', 'fromDate', 'toDate'].includes(key)))); return { range, definition };
}
export function previewShiftSeriesAdjustment(db, ctx, seriesId, payload) {
  guardShiftSeriesAccess(entityName, ctx, false); const { range, definition } = adjustmentDefinition(payload), all = readShiftSeriesOccurrences(db, ctx, seriesId, range);
  if (definition.action === 'move') return prepareSeriesMove(db, ctx, seriesId, range, definition, all).response;
  const records = rows(db, ctx.orgId, 'service-records'), editable = all.items.filter(item => item.shift.status === 'scheduled' && !records.some(record => record.shiftId === item.shiftId));
  const selected = new Map(definition.items.map(item => [item.id, item.version]));
  if (editable.length !== selected.size || editable.some(item => selected.get(item.shiftId) !== item.shift.version)) fail(409, 'SERIES_SELECTION_CHANGED', '範圍內可操作整組與選取版次不一致；請重新讀取明確清單');
  let preview;
  if (definition.action !== 'reschedule') preview = previewShiftBatch(db, ctx, definition);
  else return prepareSeriesReschedule(db,ctx,seriesId,range,definition,all).response;
  return { series: all.series, range, excluded: all.items.filter(item => !selected.has(item.shiftId)), preview };
}
export function commitShiftSeriesAdjustment(db, ctx, seriesId, payload) {
  guardShiftSeriesAccess(entityName, ctx, false); if (!db.isTransaction) fail(500, 'SERIES_TRANSACTION_REQUIRED', '週期整組調整必須在單一交易內保存');
  const { range, definition } = adjustmentDefinition(payload);
  if (definition.action === 'move') return commitSeriesMove(db, ctx, seriesId, range, definition);
  const prepared = previewShiftSeriesAdjustment(db, ctx, seriesId, payload);
  let result;
  if (prepared.preview.definition.action !== 'reschedule') result = commitShiftBatch(db, ctx, prepared.preview.definition);
  else return commitSeriesReschedule(db,ctx,seriesId,range,definition);
  return { series: prepared.series, range: prepared.range, excluded: prepared.excluded, result };
}

function prepareSeriesMove(db, ctx, seriesId, range, definition, existing) {
  // Read all dependencies, including unrelated rows in the same institution.
  // A corrupt collision, leave or service record must not be omitted to unlock
  // a target or to change the membership of the explicitly selected group.
  const dependencies = Object.fromEntries(['cases', 'employees', 'care-plans', 'service-items', 'shifts', 'leave-requests', 'service-records'].map(entity => [entity, criticalRows(db, ctx.orgId, entity)]));
  const all = existing || readShiftSeriesOccurrences(db, ctx, seriesId, range), selected = new Map(definition.items.map(item => [item.id, item.version]));
  const editable = all.items.filter(item => item.editable);
  if (editable.length !== selected.size || editable.some(item => selected.get(item.shiftId) !== item.shift.version)) fail(409, 'SERIES_SELECTION_CHANGED', '原產班日期範圍內全部可操作班次與選取版次不一致；請重新讀取');
  const occurrences = new Map(editable.map(item => [item.shiftId, item])), pairs = [], items = definition.items.map(selection => {
    try {
      const old = dependencies.shifts.find(shift => shift.id === selection.id), link = occurrences.get(selection.id);
      if (!old || !link || old.version !== selection.version || old.status !== 'scheduled' || dependencies['service-records'].some(record => record.shiftId === old.id)) fail(409, 'SERIES_SELECTION_CHANGED', '整組班次目前版次、狀態或服務紀錄已改變');
      if (old.version === Number.MAX_SAFE_INTEGER) fail(409, 'VERSION_LIMIT', '班次版次已達安全上限');
      // Preserve ISO source strings exactly. A calendar move cannot crop or
      // reinterpret them as native HH:mm; the user can explicitly replace
      // the same-day times through the existing reschedule operation first.
      for (const key of ['startTime', 'endTime']) if (typeof old[key] !== 'string' || old[key].length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(old[key])) fail(409, 'MOVE_CLOCK_REPLACEMENT_REQUIRED', '原班次保存ISO時段；請先以同日調時明確取代為HH:mm，再重新預覽移日');
      const data = validatePayload('shifts', { ...business(old), date: movedDate(old.date, definition.daysOffset), ...(Object.hasOwn(old,'endDate')?{endDate:movedDate(old.endDate,definition.daysOffset)}:{}) });
      const row = { id: selection.id, version: selection.version, originalDate: link.date, status: 'ready', before: publicRecord(ctx, old), after: data, conflicts: [] };
      pairs.push({ old, data, row }); return row;
    } catch (error) { if (!(error instanceof HttpError)) throw error; return { id: selection.id, version: selection.version, originalDate: occurrences.get(selection.id)?.date, status: 'conflict', conflicts: [issue(error)] }; }
  });
  withMoveScope(db, ctx, pairs, () => {
    for (const pair of pairs) {
      try { writeGuard(ctx, 'shifts', pair.data, pair.old); validate(db, ctx, 'shifts', pair.data, pair.old); }
      catch (error) { if (!(error instanceof HttpError)) throw error; pair.row.status = 'conflict'; pair.row.conflicts.push(issue(error)); }
    }
  });
  // Stored selected positions were excluded only inside the private scope;
  // compare every final target pair before any write, including pairs whose
  // individual parent or leave check failed. No partially valid batch saves.
  for (let left = 0; left < pairs.length; left++) for (let right = left + 1; right < pairs.length; right++) {
    const a = pairs[left].data, b = pairs[right].data; if (a.employeeId !== b.employeeId && a.caseId !== b.caseId) continue;
    if (spanIntervalsOverlap('shifts',a,'shifts',b)) for (const pair of [pairs[left], pairs[right]]) {
      pair.row.status = 'conflict'; pair.row.conflicts.push({ code: 'BATCH_SHIFT_CONFLICT', message: '移日後整組班次互相重疊' });
    }
  }
  const conflictCount = items.filter(row => row.status === 'conflict').length;
  const preview = { definition, items, total: items.length, readyCount: items.length - conflictCount, conflictCount, canCommit: conflictCount === 0 };
  return { pairs, response: { series: all.series, range, excluded: all.items.filter(item => !selected.has(item.shiftId)), preview } };
}
function commitSeriesMove(db, ctx, seriesId, range, definition) {
  // Caller holds BEGIN IMMEDIATE with mandatory idempotency. This preflight
  // completes every head, CAS, source membership and target validation while
  // all old positions still exist, then the write loop performs only CAS saves.
  const prepared = prepareSeriesMove(db, ctx, seriesId, range, definition);
  if (!prepared.response.preview.canCommit) { const error = new HttpError(409, 'BATCH_CONFLICT', '整組移日重新檢查有衝突，沒有任何班次已保存'); error.details = { preview: prepared.response }; throw error; }
  requireSeries(db, ctx, seriesId, range.version);
  const batchId = id(), items = [];
  for (const pair of prepared.pairs) {
    const saved = replace(db, ctx.orgId, 'shifts', pair.old, pair.data);
    audit(db, ctx, 'record.update', 'shifts', saved.id, { operation: 'shift-series-adjustment', action: 'move', seriesId, seriesVersion: range.version,
      batchId, reason: definition.reason, daysOffset: definition.daysOffset, originalDate: pair.row.originalDate, fromDate: pair.old.date, toDate: saved.date, fields: ['date',...(Object.hasOwn(saved,'endDate')?['endDate']:[])], version: saved.version });
    items.push(publicRecord(ctx, saved));
  }
  const result = { batchId, action: 'move', daysOffset: definition.daysOffset, reason: definition.reason, items, total: items.length };
  return { series: prepared.response.series, range, excluded: prepared.response.excluded, result };
}

/** Idempotency preflight authenticates even cached move receipts, zero writes.
 * It deliberately does not reapply the old CAS or scheduled-state predicates:
 * those changed during the already successful operation being acknowledged.
 */
export function preflightShiftSeriesAdjustmentReplay(db, ctx, seriesId, payload) {
  assertDataOnly(payload); if (payload.action !== 'move') return;
  guardShiftSeriesAccess(entityName, ctx, false);
  const { range, definition } = adjustmentDefinition(payload), series = requireSeries(db, ctx, seriesId);
  for (const entity of ['cases', 'employees', 'care-plans', 'service-items', 'shifts', 'leave-requests', 'service-records']) criticalRows(db, ctx.orgId, entity);
  const links = occurrenceLinks(db, ctx);
  for (const selection of definition.items) {
    const matching = links.filter(link => link.shiftId === selection.id && link.seriesId === series.id && link.date >= range.fromDate && link.date <= range.toDate);
    if (matching.length !== 1) fail(409, 'BROKEN_OCCURRENCE', '已選取班次的原週期歸屬無法確認；不回傳舊保存回執');
  }
}

function seriesSpan(date,definition){try{return recurringShiftSpan(date,{startTime:definition.startTime,endTime:definition.endTime,...(Object.hasOwn(definition,'endDay')?{endDay:definition.endDay}:{})});}catch(error){reject('endDay',error.message,error.code||'INVALID_TIME');}}
function markFinalSpanConflicts(items,projection,message){const values=items.map(projection);for(let a=0;a<items.length;a++)for(let b=a+1;b<items.length;b++){const left=values[a],right=values[b];if((left.employeeId===right.employeeId||left.caseId===right.caseId)&&spanIntervalsOverlap('shifts',left,'shifts',right))for(const row of[items[a],items[b]]){row.status='conflict';row.conflicts.push({code:'BATCH_SHIFT_CONFLICT',message});}}for(const row of items)if(row.status==='conflict'&&Object.hasOwn(row,'candidate'))delete row.candidate;}
function rescheduledData(old,definition){const dayMode=Object.hasOwn(definition,'endDay')?{endDay:definition.endDay}:Object.hasOwn(old,'endDate')?{endDay:old.endDate===old.date?'same':'next'}:{};return validatePayload('shifts',{...business(old),...seriesSpan(old.date,{startTime:definition.startTime,endTime:definition.endTime,...dayMode})});}
function prepareSeriesReschedule(db,ctx,seriesId,range,definition,existing){
 const deps=Object.fromEntries(['cases','employees','care-plans','service-items','shifts','leave-requests','service-records'].map(entity=>[entity,criticalRows(db,ctx.orgId,entity)]));
 const all=existing||readShiftSeriesOccurrences(db,ctx,seriesId,range),editable=all.items.filter(item=>item.editable),selection=new Map(definition.items.map(item=>[item.id,item.version]));
 if(editable.length!==selection.size||editable.some(item=>selection.get(item.shiftId)!==item.shift.version))fail(409,'SERIES_SELECTION_CHANGED','完整可操作範圍或版次已改變');
 const pairs=[],items=definition.items.map(selected=>{try{const old=deps.shifts.find(shift=>shift.id===selected.id);if(!old||old.version!==selected.version||old.status!=='scheduled'||deps['service-records'].some(record=>record.shiftId===old.id))fail(409,'SERIES_SELECTION_CHANGED','班次狀態、服務或版次已變更');if(old.version===Number.MAX_SAFE_INTEGER)fail(409,'VERSION_LIMIT','班次已達安全版次上限');const data=rescheduledData(old,definition);if(['startTime','endTime','endDate'].every(key=>Object.hasOwn(old,key)===Object.hasOwn(data,key)&&old[key]===data[key]))fail(409,'TIME_UNCHANGED','此班次完整日期與時段相同');const row={id:old.id,version:old.version,status:'ready',before:publicRecord(ctx,old),after:data,conflicts:[]};pairs.push({old,data,row});return row;}catch(error){if(!(error instanceof HttpError))throw error;return{id:selected.id,version:selected.version,status:'conflict',conflicts:[issue(error)]};}});
 withMoveScope(db,ctx,pairs,()=>{for(const pair of pairs){try{writeGuard(ctx,'shifts',pair.data,pair.old);validate(db,ctx,'shifts',pair.data,pair.old);}catch(error){if(!(error instanceof HttpError))throw error;pair.row.status='conflict';pair.row.conflicts.push(issue(error));}}});
 markFinalSpanConflicts(pairs.map(pair=>pair.row),row=>row.after,'調時後整組完整時段互相重疊');
 const conflictCount=items.filter(row=>row.status==='conflict').length,preview={definition,items,total:items.length,readyCount:items.length-conflictCount,conflictCount,canCommit:conflictCount===0};
 return{pairs,response:{series:all.series,range,excluded:all.items.filter(item=>!selection.has(item.shiftId)),preview}};
}
function commitSeriesReschedule(db,ctx,seriesId,range,definition){const ready=prepareSeriesReschedule(db,ctx,seriesId,range,definition);if(!ready.response.preview.canCommit){const error=new HttpError(409,'BATCH_CONFLICT','完整時段重新檢查有衝突，未保存任何班次');error.details={preview:ready.response};throw error;}requireSeries(db,ctx,seriesId,range.version);const batchId=id(),items=[];for(const pair of ready.pairs){const saved=replace(db,ctx.orgId,'shifts',pair.old,pair.data);audit(db,ctx,'record.update','shifts',saved.id,{operation:'shift-series-adjustment',action:'reschedule',seriesId,seriesVersion:range.version,batchId,reason:definition.reason,fields:['startTime','endTime',...(Object.hasOwn(saved,'endDate')?['endDate']:[])],version:saved.version});items.push(publicRecord(ctx,saved));}return{series:ready.response.series,range,excluded:ready.response.excluded,result:{batchId,action:'reschedule',reason:definition.reason,items,total:items.length}};}
