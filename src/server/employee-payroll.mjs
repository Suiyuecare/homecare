import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountMembershipActive } from './account-administration.mjs';
import { fail, now, saveVersion, audit, validatePayload, entities } from './model.mjs';
import { readApprovedCalculationSource, readVerifiedSyntheticDemoCalculationSource } from './calculation-engine.mjs';
import { CALCULATION_ROUNDINGS, CalculationError, exactCentsOperation, immutableCalculationCopy, canonicalCalculationJson } from '../../public/data/calculation-core.js';
import { serviceSpan, spanCoveredByDates } from '../../public/data/shift-span.js';
import { LTC_BA_AA_CATALOG } from '../../public/data/ltc-ba-aa-catalog.js';
import { EMPLOYEE_PAYROLL_WARNINGS } from '../../public/data/employee-payroll-policy.js';

export const EMPLOYEE_PAYROLL_ENTITY = 'employee-payroll-profiles';
export const EMPLOYEE_PAYROLL_MODE = 'employee-payroll-preview-v1';
export const EMPLOYEE_PAYROLL_FIELDS = Object.freeze(['employeeId', 'validFrom', 'validTo', 'payrollMode', 'hourlyRateCents', 'shareBasisPoints', 'splitBasis', 'aaTreatment', 'rounding', 'approvalReference', 'note', 'status']);
const META = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && own(value, key)?.enumerable && Object.hasOwn(own(value, key), 'value'));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safe = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && !value.includes('\0') && (!required || !!value.trim());
const ref = value => text(value, 100, true) && value === value.trim() && !/[\r\n]/.test(value);
const date = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const monthValid = value => typeof value === 'string' && value.length === 7 && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const iso = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = message => fail(422, 'EMPLOYEE_PAYROLL_INVALID', message);
const broken = message => fail(409, 'EMPLOYEE_PAYROLL_STORED_INVALID', message);
const dataOf = item => Object.fromEntries(EMPLOYEE_PAYROLL_FIELDS.map(key => [key, item[key]]));
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function literal(value) { try { if (!(value instanceof Uint8Array)) throw new Error(); return utf8.decode(value); } catch { broken('保存文字的 SQL 型態或 UTF-8 無法確認。'); } }
function sqlRows(db, sql, args) { const statement = db.prepare(sql); statement.setReadBigInts(true); return statement.all(...args); }
function response(value) { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2 * 1024 * 1024) fail(413, 'EMPLOYEE_PAYROLL_TOO_LARGE', '完整薪資回應超過 2MiB，請縮小範圍；不會省略來源。'); return immutableCalculationCopy(value); }
function mapped(action) { try { return action(); } catch (error) { if (error instanceof CalculationError) fail(error.status, error.code, error.message); throw error; } }

export function guardEmployeePayrollAccess(db, ctx, write = false) {
  if (!(write ? ['admin'] : ['admin', 'finance']).includes(ctx?.role) || !ref(ctx?.orgId) || !ref(ctx?.user?.id)
    || db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(ctx.orgId, ctx.user.id)?.role !== ctx.role || !accountMembershipActive(db, ctx.orgId, ctx.user.id))
    fail(403, 'ROLE_FORBIDDEN', write ? '僅目前機構有效管理者可維護員工薪資設定。' : '僅目前機構有效管理者或財務可查閱及試算員工薪資。');
}

/** SQL identity and immutable current head are checked before using any source. */
function raw(db, orgId, entity, id) {
  const rows = sqlRows(db, `SELECT *, CAST(id AS BLOB) id_bytes,CAST(org_id AS BLOB) org_bytes,CAST(entity AS BLOB) entity_bytes,CAST(data AS BLOB) data_bytes,CAST(created_at AS BLOB) created_bytes,CAST(updated_at AS BLOB) updated_bytes,
    typeof(id) id_type,typeof(org_id) org_type,typeof(entity) entity_type,typeof(data) data_type,typeof(version) version_type,typeof(created_at) created_type,typeof(updated_at) updated_type FROM records WHERE org_id=? AND entity=? AND id=?`, [orgId, entity, id]);
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length !== 1 || ['id_type', 'org_type', 'entity_type', 'data_type', 'created_type', 'updated_type'].some(key => row[key] !== 'text') || row.version_type !== 'integer' || typeof row.version !== 'bigint' || row.version < 1n || row.version > BigInt(Number.MAX_SAFE_INTEGER)) broken('保存身份或版次的 SQL 型態無法確認。');
  const createdAt = literal(row.created_bytes), updatedAt = literal(row.updated_bytes);
  if (literal(row.id_bytes) !== id || literal(row.org_bytes) !== orgId || literal(row.entity_bytes) !== entity || !iso(createdAt) || !iso(updatedAt) || updatedAt < createdAt) broken('保存身份或時間無法確認。');
  let data; try { data = JSON.parse(literal(row.data_bytes)); } catch { broken('保存业务資料無法解析。'); }
  if (!plain(data) || META.some(key => Object.hasOwn(data, key))) broken('業務欄位不能覆寫 SQL 身份。');
  const item = { ...data, id, orgId, version: Number(row.version), createdAt, updatedAt };
  const heads = sqlRows(db, `SELECT *,CAST(snapshot AS BLOB) snapshot_bytes,CAST(org_id AS BLOB) org_bytes,CAST(entity AS BLOB) entity_bytes,CAST(record_id AS BLOB) record_bytes,CAST(created_at AS BLOB) created_bytes,CAST(source AS BLOB) source_bytes,
    typeof(snapshot) snapshot_type,typeof(version) version_type,typeof(org_id) org_type,typeof(entity) entity_type,typeof(record_id) record_type,typeof(created_at) created_type,typeof(source) source_type FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?`, [orgId, entity, id, item.version]);
  if (heads.length !== 1 || ['snapshot_type', 'org_type', 'entity_type', 'record_type', 'created_type', 'source_type'].some(key => heads[0][key] !== 'text') || heads[0].version_type !== 'integer' || heads[0].version !== row.version
    || literal(heads[0].org_bytes) !== orgId || literal(heads[0].entity_bytes) !== entity || literal(heads[0].record_bytes) !== id || literal(heads[0].created_bytes) !== updatedAt || !literal(heads[0].source_bytes)) broken('目前保存內容缺少唯一不可改寫版次。');
  let snapshot; try { snapshot = JSON.parse(literal(heads[0].snapshot_bytes)); } catch { broken('不可改寫版次無法解析。'); }
  if (!isDeepStrictEqual(item, snapshot)) broken('目前保存內容與不可改寫版本不一致。');
  return item;
}

export function validateEmployeePayrollPayload(payload, patch = false) {
  if (!exact(payload, [...EMPLOYEE_PAYROLL_FIELDS, ...(patch ? ['version'] : [])]) || patch && !safe(payload.version, 1)) invalid('請提供完整薪資設定及保存版次，不可加入未知欄位。');
  if (!ref(payload.employeeId) || !date(payload.validFrom) || !date(payload.validTo) || payload.validTo < payload.validFrom || !['hourly', 'split'].includes(payload.payrollMode) || !CALCULATION_ROUNDINGS.includes(payload.rounding) || !text(payload.approvalReference, 2000) || !text(payload.note, 10000) || !['draft', 'approved', 'inactive'].includes(payload.status)) invalid('請明確指定員工、有效期間、薪資制度與進位方式。');
  if (payload.payrollMode === 'hourly' ? !safe(payload.hourlyRateCents, 1, 1000000000) || payload.shareBasisPoints !== null || payload.splitBasis !== null || payload.aaTreatment !== 'not-applicable'
    : payload.hourlyRateCents !== null || !safe(payload.shareBasisPoints, 1, 10000) || !['approved-service-snapshot', 'collected-receipts'].includes(payload.splitBasis) || !['include', 'exclude'].includes(payload.aaTreatment)) invalid('時薪或拆帳參數必須完整明確，不能使用另一制度的欄位或預設規則。');
  if (payload.status === 'approved' && (!payload.approvalReference.trim() || payload.approvalReference !== payload.approvalReference.trim() || /[\u0000-\u001f\u007f]/.test(payload.approvalReference))) invalid('核定前須填寫明確且單行的核定依據。');
  return payload;
}
function assertProfile(item) {
  if (!exact(item, [...EMPLOYEE_PAYROLL_FIELDS, ...META]) || !ref(item.id) || !ref(item.orgId) || !safe(item.version, 1) || !iso(item.createdAt) || !iso(item.updatedAt) || item.updatedAt < item.createdAt) broken('薪資設定保存身份無法確認。');
  try { validateEmployeePayrollPayload(dataOf(item)); } catch { broken('薪資設定保存欄位無法確認。'); }
  return item;
}
function employee(db, ctx, id, requireActive = true) {
  const item = raw(db, ctx.orgId, 'employees', id);
  if (!item) fail(404, 'NOT_FOUND', '找不到本機構員工。');
  const data = Object.fromEntries(Object.entries(item).filter(([key]) => !META.includes(key)));
  try { validatePayload('employees', data); } catch { broken('員工保存欄位無法確認。'); }
  if (Object.keys(data).some(key => !entities.employees.fields.split(' ').includes(key)) || !['active', 'inactive'].includes(item.status) || !text(item.name, 500, true) || !text(item.employeeNo, 500, true)) broken('員工保存身份無法確認。');
  if (requireActive && item.status !== 'active') fail(409, 'EMPLOYEE_PAYROLL_EMPLOYEE_INACTIVE', '薪資設定與試算須使用同機構有效員工。');
  return { id: item.id, name: item.name, employeeNo: item.employeeNo, version: item.version };
}
function chain(db, ctx, item) {
  const versions = sqlRows(db, `SELECT *,CAST(snapshot AS BLOB) snapshot_bytes,CAST(org_id AS BLOB) org_bytes,CAST(entity AS BLOB) entity_bytes,CAST(record_id AS BLOB) record_bytes,CAST(created_at AS BLOB) created_bytes,CAST(source AS BLOB) source_bytes,
    typeof(snapshot) snapshot_type,typeof(version) version_type,typeof(org_id) org_type,typeof(entity) entity_type,typeof(record_id) record_type,typeof(created_at) created_type,typeof(source) source_type FROM record_versions WHERE org_id=? AND entity=? AND record_id=? ORDER BY version`, [ctx.orgId, EMPLOYEE_PAYROLL_ENTITY, item.id]);
  if (versions.length !== item.version) broken('薪資設定版本歷程不完整。');
  let previous; const result = versions.map((row, index) => {
    if (row.version_type !== 'integer' || row.version !== BigInt(index + 1) || ['snapshot_type', 'org_type', 'entity_type', 'record_type', 'created_type', 'source_type'].some(key => row[key] !== 'text') || literal(row.org_bytes) !== ctx.orgId || literal(row.entity_bytes) !== EMPLOYEE_PAYROLL_ENTITY || literal(row.record_bytes) !== item.id) broken('薪資設定歷程版次或來源無法確認。');
    const source = literal(row.source_bytes), createdAt = literal(row.created_bytes);
    if (!iso(createdAt) || !['employee-payroll.create', 'employee-payroll.update', 'employee-payroll.approve', 'employee-payroll.inactivate'].includes(source)) broken('薪資設定歷程時間或來源無法確認。');
    let snapshot; try { snapshot = JSON.parse(literal(row.snapshot_bytes)); } catch { broken('薪資設定歷程無法解析。'); }
    assertProfile(snapshot);
    const expectedSource = index === 0 ? 'employee-payroll.create' : snapshot.status === 'approved' ? 'employee-payroll.approve' : snapshot.status === 'inactive' ? 'employee-payroll.inactivate' : 'employee-payroll.update';
    if (snapshot.id !== item.id || snapshot.orgId !== ctx.orgId || snapshot.version !== index + 1 || snapshot.createdAt !== item.createdAt || snapshot.updatedAt !== createdAt || source !== expectedSource || index === 0 && snapshot.status !== 'draft'
      || previous && (snapshot.employeeId !== previous.employeeId || snapshot.updatedAt < previous.updatedAt || previous.status === 'inactive' || previous.status === 'approved' && (snapshot.status !== 'inactive' || !EMPLOYEE_PAYROLL_FIELDS.filter(key => key !== 'status').every(key => isDeepStrictEqual(snapshot[key], previous[key]))))) broken('薪資設定不可改寫的歷程與狀態不一致。');
    previous = snapshot; return { version: index + 1, source, createdAt, snapshot };
  });
  if (!isDeepStrictEqual(previous, item)) broken('薪資設定目前版本與歷程不一致。');
  return result;
}
function profile(db, ctx, id) { if (!ref(id)) fail(404, 'NOT_FOUND', '找不到薪資設定。'); const item = raw(db, ctx.orgId, EMPLOYEE_PAYROLL_ENTITY, id); if (!item) fail(404, 'NOT_FOUND', '找不到本機構薪資設定。'); assertProfile(item); chain(db, ctx, item); employee(db, ctx, item.employeeId, false); return item; }
function all(db, ctx) { return sqlRows(db, 'SELECT CAST(id AS BLOB) id,typeof(id) id_type FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id', [ctx.orgId, EMPLOYEE_PAYROLL_ENTITY]).map(row => { if (row.id_type !== 'text') broken('薪資設定識別型態無法確認。'); return profile(db, ctx, literal(row.id)); }); }
export function employeePayrollQuery(params, mode = 'single') {
  if (!(params instanceof URLSearchParams)) invalid('查詢格式無法確認。');
  const list = mode === 'list', candidates = mode === 'candidates', allowed = list ? ['employeeId', 'status', 'q', 'page', 'pageSize'] : candidates ? ['employeeId', 'month', 'q', 'page', 'pageSize'] : [];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid('查詢欄位未知或重複。');
  if (!list && !candidates) return {};
  const q = params.get('q') ?? '', employeeId = params.get('employeeId') ?? null, status = params.get('status') ?? null, month = params.get('month') ?? null;
  if (!text(q, 200) || employeeId !== null && !ref(employeeId) || status !== null && !['draft', 'approved', 'inactive'].includes(status) || candidates && (!ref(employeeId) || !monthValid(month))) invalid('請核對員工、月份或薪資查詢條件。');
  const pageText = params.get('page') ?? '1', sizeText = params.get('pageSize') ?? '25', page = Number(pageText), pageSize = Number(sizeText);
  if (!/^[1-9]\d*$/.test(pageText) || !/^[1-9]\d*$/.test(sizeText) || /[\r\n]/.test(pageText + sizeText) || !safe(page, 1) || !safe(pageSize, 1, 100) || !safe((page - 1) * pageSize)) invalid('分頁須為安全正整數，pageSize最多100。');
  return { employeeId, ...(candidates ? { month } : { status }), q, page, pageSize };
}
const page = (items, query) => ({ items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize });
function assertPageQuery(query, candidates = false) {
  if (!exact(query, ['employeeId', candidates ? 'month' : 'status', 'q', 'page', 'pageSize']) || !text(query.q, 200) || !safe(query.page, 1) || !safe(query.pageSize, 1, 100) || !safe((query.page - 1) * query.pageSize)
    || (candidates ? !ref(query.employeeId) || !monthValid(query.month) : query.employeeId !== null && !ref(query.employeeId) || query.status !== null && !['draft', 'approved', 'inactive'].includes(query.status))) invalid('請使用完整且有效的薪資分頁查詢。');
}
export function listEmployeePayrollProfiles(db, ctx, query) {
  guardEmployeePayrollAccess(db, ctx); assertPageQuery(query);
  if (query.employeeId) employee(db, ctx, query.employeeId, false);
  const q = query.q.toLocaleLowerCase('zh-TW'), saved = all(db, ctx), people = new Map();
  for (const item of saved) if (!people.has(item.employeeId)) people.set(item.employeeId, employee(db, ctx, item.employeeId, false));
  const items = saved.filter(item => (!query.employeeId || item.employeeId === query.employeeId) && (!query.status || item.status === query.status)
    && (!q || [people.get(item.employeeId).name, people.get(item.employeeId).employeeNo, item.employeeId, item.approvalReference, item.note].some(value => value.toLocaleLowerCase('zh-TW').includes(q))));
  const result = page(items, query), employeeSnapshots = [...new Set(result.items.map(item => item.employeeId))].map(id => people.get(id));
  return response({ orgId: ctx.orgId, ...result, employeeSnapshots });
}
export function readEmployeePayrollProfile(db, ctx, id) { guardEmployeePayrollAccess(db, ctx); return response({ item: profile(db, ctx, id) }); }
export function readEmployeePayrollHistory(db, ctx, id) { guardEmployeePayrollAccess(db, ctx); const item = profile(db, ctx, id), items = chain(db, ctx, item).reverse(); return response({ orgId: ctx.orgId, id, items, total: items.length }); }
export function preflightEmployeePayrollReceipt(db, ctx, id) { guardEmployeePayrollAccess(db, ctx, true); if (id) profile(db, ctx, id); }
export function commitEmployeePayrollProfile(db, ctx, id, payload) {
  if (!db.isTransaction) fail(500, 'EMPLOYEE_PAYROLL_TRANSACTION_REQUIRED', '薪資設定須在完整交易內保存。');
  guardEmployeePayrollAccess(db, ctx, true); validateEmployeePayrollPayload(payload, !!id); employee(db, ctx, payload.employeeId);
  const old = id ? profile(db, ctx, id) : null, data = dataOf(payload);
  if (!old && payload.status !== 'draft') invalid('新薪資設定必須先建立待核定版本。');
  if (old && old.version !== payload.version) fail(409, 'VERSION_CONFLICT', '薪資設定已更新，請重新讀取。');
  if (old && payload.employeeId !== old.employeeId) fail(409, 'EMPLOYEE_PAYROLL_IDENTITY_IMMUTABLE', '薪資設定建立後不能更換員工。');
  if (old && old.status !== 'draft' && (old.status !== 'approved' || data.status !== 'inactive' || !EMPLOYEE_PAYROLL_FIELDS.filter(key => key !== 'status').every(key => isDeepStrictEqual(data[key], old[key])))) fail(409, 'EMPLOYEE_PAYROLL_LOCKED', '核定版本只能保持原內容停用；請另建新版本。');
  const saved = all(db, ctx);
  if (data.status === 'approved' && saved.some(item => item.id !== old?.id && item.employeeId === data.employeeId && item.status === 'approved' && item.validFrom <= data.validTo && data.validFrom <= item.validTo)) fail(409, 'EMPLOYEE_PAYROLL_PERIOD_CONFLICT', '同一員工已有重疊期間的核定薪資設定。');
  const time = now(), item = { ...data, id: old?.id ?? randomUUID(), orgId: ctx.orgId, version: old ? old.version + 1 : 1, createdAt: old?.createdAt ?? time, updatedAt: time };
  assertProfile(item);
  if (old) { if (!db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=? AND org_id=? AND entity=? AND version=?').run(JSON.stringify(data), time, item.id, ctx.orgId, EMPLOYEE_PAYROLL_ENTITY, old.version).changes) fail(409, 'VERSION_CONFLICT', '薪資設定已更新，請重新讀取。'); }
  else db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, ctx.orgId, EMPLOYEE_PAYROLL_ENTITY, JSON.stringify(data), 1, time, time);
  const operation = !old ? 'create' : data.status === 'approved' ? 'approve' : data.status === 'inactive' ? 'inactivate' : 'update';
  saveVersion(db, item, 'employee-payroll.' + operation); audit(db, ctx, 'employee-payroll.' + operation, EMPLOYEE_PAYROLL_ENTITY, item.id, { version: item.version, employeeId: item.employeeId, status: item.status, approvalReference: item.approvalReference });
  return readEmployeePayrollProfile(db, ctx, item.id);
}
export function confirmEmployeePayrollResponse(db, ctx, value) { guardEmployeePayrollAccess(db, ctx, true); if (!exact(value, ['item']) || !plain(value.item) || !ref(value.item.id)) broken('無法確認原保存回應。'); const current = profile(db, ctx, value.item.id); if (!isDeepStrictEqual(value.item, current)) fail(409, 'EMPLOYEE_PAYROLL_RECEIPT_STALE', '原保存回應已過期，請核對目前薪資設定。'); employee(db, ctx, current.employeeId); return response(value); }

export function listEmployeePayrollCandidates(db, ctx, query) {
  guardEmployeePayrollAccess(db, ctx); assertPageQuery(query, true); employee(db, ctx, query.employeeId); const items = [], q = query.q.toLocaleLowerCase('zh-TW');
  const ids = sqlRows(db, 'SELECT CAST(id AS BLOB) id,typeof(id) id_type FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id', [ctx.orgId, 'service-records']);
  for (const row of ids) {
    if (row.id_type !== 'text') broken('服務來源識別型態無法確認。'); const id = literal(row.id), record = raw(db, ctx.orgId, 'service-records', id);
    if (!record || record.employeeId !== query.employeeId || typeof record.date !== 'string' || record.date.slice(0, 7) !== query.month || record.status !== 'approved') continue;
    if (record.billingSnapshot?.source === 'synthetic-demo') { readVerifiedSyntheticDemoCalculationSource(db, ctx, { id, version: record.version }); continue; }
    const source = readApprovedCalculationSource(db, ctx, { id, version: record.version });
    const label = source.billingSnapshot.items.map(item => item.code + ' ' + item.name).join('、');
    if (!q || [source.date, label].some(value => value.toLocaleLowerCase('zh-TW').includes(q))) items.push({ id: source.id, orgId: ctx.orgId, employeeId: source.employeeId, version: source.version, date: source.date, serviceMinutes: source.billingSnapshot.serviceMinutes, label });
  }
  return response({ orgId: ctx.orgId, employeeId: query.employeeId, month: query.month, ...page(items, query) });
}
export function previewEmployeePayroll(db, ctx, payload) {
  guardEmployeePayrollAccess(db, ctx);
  if (!exact(payload, ['profile', 'month', 'sources']) || !exact(payload.profile, ['id', 'version']) || !ref(payload.profile.id) || !safe(payload.profile.version, 1) || !monthValid(payload.month) || !Array.isArray(payload.sources) || Object.getPrototypeOf(payload.sources) !== Array.prototype || payload.sources.length < 1 || payload.sources.length > 100 || Reflect.ownKeys(payload.sources).length !== payload.sources.length + 1 || Array.from({ length: payload.sources.length }, (_, i) => String(i)).some(key => !own(payload.sources, key)?.enumerable || !Object.hasOwn(own(payload.sources, key), 'value')) || payload.sources.some(selection => !exact(selection, ['id', 'version']) || !ref(selection.id) || !safe(selection.version, 1)) || new Set(payload.sources.map(selection => selection.id)).size !== payload.sources.length) invalid('每次月試算須明確提供核定設定、月份及1至100筆不重複的來源版次。');
  const selected = profile(db, ctx, payload.profile.id); if (selected.version !== payload.profile.version) fail(409, 'VERSION_CONFLICT', '薪資設定版次已變更。');
  if (selected.status !== 'approved') fail(409, 'EMPLOYEE_PAYROLL_NOT_APPROVED', '月試算只接受機構已核定的員工設定。');
  const employeeSnapshot = employee(db, ctx, selected.employeeId);
  if (selected.payrollMode === 'split' && selected.splitBasis === 'collected-receipts') fail(409, 'PAYROLL_BASIS_UNAVAILABLE', '目前缺少可核驗的實收款來源；不能以服務快照或核付金額代替實收。');
  const sourceSnapshots = payload.sources.map(selection => readApprovedCalculationSource(db, ctx, selection));
  let total = 0n;
  const lines = sourceSnapshots.map(source => {
    if (source.employeeId !== selected.employeeId || source.date.slice(0, 7) !== payload.month) fail(409, 'EMPLOYEE_PAYROLL_SOURCE_MISMATCH', '來源必須屬於設定的同一員工及月份。');
    const span = serviceSpan({ date: source.date, actualStart: source.actualStart, actualEnd: source.actualEnd, ...(Object.hasOwn(source, 'actualEndDate') ? { actualEndDate: source.actualEndDate } : {}) });
    if (!spanCoveredByDates(span, selected.validFrom, selected.validTo)) fail(409, 'EMPLOYEE_PAYROLL_DATE_MISMATCH', '完整服務日期必須包含在薪資設定有效期間內。');
    let basisCents = null, trace;
    if (selected.payrollMode === 'hourly') trace = mapped(() => exactCentsOperation({ operation: 'minutes-hourly', minutes: source.billingSnapshot.serviceMinutes, hourlyRateCents: selected.hourlyRateCents, rounding: selected.rounding }));
    else {
      let basis = 0n;
      for (const item of source.billingSnapshot.items) { if (!LTC_BA_AA_CATALOG.items.some(code => code.code === item.code)) fail(409, 'EMPLOYEE_PAYROLL_BASIS_CODE_UNSUPPORTED', '拆帳來源含未核定的服務代碼分類，不能默認納入或排除。'); if (item.code.startsWith('BA') || selected.aaTreatment === 'include') basis += BigInt(item.amountCents); }
      if (basis > BigInt(Number.MAX_SAFE_INTEGER)) fail(409, 'EMPLOYEE_PAYROLL_OVERFLOW', '拆帳基數超出安全整數分範圍。'); basisCents = Number(basis);
      trace = mapped(() => exactCentsOperation({ operation: 'basis-points', amountCents: basisCents, basisPoints: selected.shareBasisPoints, rounding: selected.rounding }));
    }
    total += BigInt(trace.resultCents); if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail(409, 'EMPLOYEE_PAYROLL_OVERFLOW', '月試算合計超出安全整數分範圍。');
    return { serviceRecordId: source.id, version: source.version, date: source.date, serviceMinutes: source.billingSnapshot.serviceMinutes, basisCents, amountCents: trace.resultCents, trace };
  });
  const result = response({ mode: EMPLOYEE_PAYROLL_MODE, previewOnly: true, orgId: ctx.orgId, month: payload.month, currency: 'TWD', employeeSnapshot, profileSnapshot: selected, sourceSnapshots, lines, totalAmountCents: Number(total), warnings: EMPLOYEE_PAYROLL_WARNINGS });
  return response({ ...result, previewHash: createHash('sha256').update(canonicalCalculationJson(result)).digest('hex') });
}
