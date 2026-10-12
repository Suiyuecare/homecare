import { legacyMigrationsIdentity, legacyScalarText } from './legacy-migrations.js';

export const legacyHistoryIdentity = legacyMigrationsIdentity;
export const legacyHistoryScalarText = legacyScalarText;
export const legacyHistoryCategories = Object.freeze({
  'service-export': '服務匯出', 'employee-profile': '員工原頁', 'case-profile': '個案原頁',
  'care-plan-history': '照顧計畫歷史', 'fa-export': 'FA 匯出', 'company-settings': '機構設定',
  'form-record': '表單原紀錄', 'attachment-metadata': '附件描述',
});
const flags = ['sourceSystemComplete', 'operationalConversionCompleted', 'approvalCompleted', 'payrollApproved'];
const baseKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const batchKeys = [...baseKeys, 'provider', 'tenant', 'sourceHash', 'payloadHash', 'archiveManifestSha256', 'archiveId',
  'importedBy', 'importedAt', 'rowCount', 'categories', 'reportingPeriods', 'status', ...flags];
const summaryKeys = [...baseKeys, 'batchId', 'category', 'reportingPeriod', 'sourceNativeId', 'sourceCreatedAt', 'caseId',
  'employeeId', 'sourceFileId', 'sourceFileSha256', 'locator', 'identityKind', 'caseReference', 'employeeReference'];
const fail = () => { const error = new Error('歷史原始紀錄回應無法確認；請重新讀取。'); error.code = 'LEGACY_HISTORY_UNCONFIRMED'; throw error; };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const token = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const period = value => typeof value === 'string' && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const text = value => typeof value === 'string' && value.length <= 100000
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const scalar = value => value === null || typeof value === 'boolean' || text(value)
  || typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
  }) && own.every(key => typeof key === 'string' && keys.includes(key));
}
function array(value, max) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(); }
  return value;
}
function immutable(value) { if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); } return value; }
const project = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
function unconverted(value) { if (flags.some(key => value[key] !== false)) fail(); }
function metadata(value, orgId) {
  if (!uuid(value.id) || value.orgId !== orgId || !positive(value.version) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) fail();
}
function batch(value, orgId) {
  if (!closed(value, batchKeys)) fail(); metadata(value, orgId); unconverted(value);
  const categories = array(value.categories, 8), sorted = [...categories].sort(), reportingPeriods = array(value.reportingPeriods, 1000), sortedPeriods = [...reportingPeriods].sort();
  if (!categories.length || categories.some((category, i) => !Object.hasOwn(legacyHistoryCategories, category) || category !== sorted[i])
      || new Set(categories).size !== categories.length || !positive(value.rowCount) || value.rowCount > 1000
      || !token(value.provider) || !token(value.tenant) || !sha(value.sourceHash) || !sha(value.payloadHash) || !sha(value.archiveManifestSha256)
      || typeof value.archiveId !== 'string' || !/^archive-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.archiveId)
      || !uuid(value.importedBy) || !timestamp(value.importedAt) || value.status !== 'historical-original-records') fail();
  if (reportingPeriods.some((value, i) => !period(value) || value !== sortedPeriods[i]) || new Set(reportingPeriods).size !== reportingPeriods.length) fail();
  return { ...project(value, batchKeys), categories: [...categories], reportingPeriods: [...reportingPeriods] };
}
function reference(value, id, entity) {
  if (id === null) { if (value !== null) fail(); return null; }
  const number = entity === 'case' ? 'caseNo' : 'employeeNo', keys = ['id', 'name', number, 'version', 'status'];
  if (!uuid(id) || !closed(value, keys) || value.id !== id || !text(value.name) || !value.name.trim()
      || !text(value[number]) || !value[number].trim() || !positive(value.version)
      || !(entity === 'case' ? ['active', 'paused', 'closed'] : ['active', 'inactive']).includes(value.status)) fail();
  return project(value, keys);
}
function locator(value) {
  if (closed(value, ['kind', 'sheetIndex', 'rowNumber']) && value.kind === 'worksheet-row' && positive(value.sheetIndex) && value.sheetIndex <= 100000 && positive(value.rowNumber) && value.rowNumber <= 1048576) return project(value, ['kind', 'sheetIndex', 'rowNumber']);
  if (closed(value, ['kind', 'pointer']) && value.kind === 'json-pointer' && text(value.pointer)
      && value.pointer.length <= 4000 && (value.pointer === '' || value.pointer.startsWith('/')) && !/~(?![01])/u.test(value.pointer)) return project(value, ['kind', 'pointer']);
  fail();
}
function summary(value, orgId, batchId, categories, reportingPeriods) {
  if (!closed(value, summaryKeys)) fail(); metadata(value, orgId);
  if (!uuid(value.batchId) || value.batchId !== batchId || !Object.hasOwn(legacyHistoryCategories, value.category) || !categories.includes(value.category)
      || value.identityKind !== 'archive-locator' || value.reportingPeriod !== null && (!period(value.reportingPeriod) || !reportingPeriods.includes(value.reportingPeriod))
      || value.sourceNativeId !== null && (!text(value.sourceNativeId) || value.sourceNativeId.length > 4000)
      || value.sourceCreatedAt !== null && (!text(value.sourceCreatedAt) || value.sourceCreatedAt.length > 4000)
      || typeof value.sourceFileId !== 'string' || !/^file-[0-9]{8}$/.test(value.sourceFileId) || value.sourceFileId === 'file-00000000'
      || !sha(value.sourceFileSha256)) fail();
  return { ...project(value, summaryKeys), locator: locator(value.locator), caseReference: reference(value.caseReference, value.caseId, 'case'),
    employeeReference: reference(value.employeeReference, value.employeeId, 'employee') };
}
function request(value, keys) {
  if (!closed(value, keys) || !uuid(value.orgId) || keys.includes('id') && !uuid(value.id)
      || keys.includes('page') && (!positive(value.page) || !positive(value.pageSize) || value.pageSize > 100 || !Number.isSafeInteger(value.page * value.pageSize))) fail();
}
function paging(value, requested, rows) {
  unconverted(value);
  if (value.orgId !== requested.orgId || value.page !== requested.page || value.pageSize !== requested.pageSize || !nonnegative(value.total)) fail();
  array(rows, requested.pageSize); const start = (value.page - 1) * value.pageSize;
  if (!Number.isSafeInteger(start) || rows.length !== Math.min(value.pageSize, Math.max(0, value.total - start))) fail();
}
export function confirmLegacyHistoryList(value, requested) {
  request(requested, ['orgId', 'page', 'pageSize']);
  if (!closed(value, ['orgId', 'items', 'total', 'page', 'pageSize', ...flags])) fail(); paging(value, requested, value.items);
  const ids = new Set(), items = value.items.map(row => { const saved = batch(row, requested.orgId); if (ids.has(saved.id)) fail(); ids.add(saved.id); return saved; });
  return immutable({ orgId: requested.orgId, items, total: value.total, page: value.page, pageSize: value.pageSize, ...project(value, flags) });
}
export function confirmLegacyHistoryBatch(value, requested) {
  request(requested, ['orgId', 'id', 'page', 'pageSize']);
  if (!closed(value, ['orgId', 'item', 'records', 'total', 'page', 'pageSize', ...flags])) fail(); paging(value, requested, value.records);
  const item = batch(value.item, requested.orgId); if (item.id !== requested.id || value.total !== item.rowCount) fail();
  const ids = new Set(), records = value.records.map(row => { const saved = summary(row, requested.orgId, item.id, item.categories, item.reportingPeriods); if (ids.has(saved.id)) fail(); ids.add(saved.id); return saved; });
  return immutable({ orgId: requested.orgId, item, records, total: value.total, page: value.page, pageSize: value.pageSize, ...project(value, flags) });
}
export function confirmLegacyHistoryRow(value, requested) {
  request(requested, ['orgId', 'id']);
  if (!closed(value, ['orgId', 'item', 'batch', ...flags]) || value.orgId !== requested.orgId || !closed(value.item, [...summaryKeys, 'columns'])) fail();
  unconverted(value); const parent = batch(value.batch, requested.orgId), item = summary(project(value.item, summaryKeys), requested.orgId, parent.id, parent.categories, parent.reportingPeriods);
  if (item.id !== requested.id) fail();
  const indexes = new Set(), columns = array(value.item.columns, 500).map(column => {
    if (!closed(column, ['columnIndex', 'label', 'raw', 'formula', 'cached']) || !positive(column.columnIndex) || column.columnIndex > 16384 || indexes.has(column.columnIndex)
        || !text(column.label) || column.label.length > 1000 || !scalar(column.raw) || !scalar(column.cached) || column.formula !== null && !text(column.formula)) fail();
    indexes.add(column.columnIndex); return project(column, ['columnIndex', 'label', 'raw', 'formula', 'cached']);
  });
  if (!columns.length) fail();
  return immutable({ orgId: requested.orgId, item: { ...item, columns }, batch: parent, ...project(value, flags) });
}
