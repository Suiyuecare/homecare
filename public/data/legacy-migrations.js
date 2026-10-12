const fail = () => { const error = new Error('移轉紀錄回應無法確認；請重新讀取。'); error.code = 'LEGACY_MIGRATIONS_UNCONFIRMED'; throw error; };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const token = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length <= 100000
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
  && (!Number.isInteger(value) || Number.isSafeInteger(value))) || text(value);
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value >= 1;
function closed(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) return false;
  return keys.every(key => { const desc = Object.getOwnPropertyDescriptor(value, key); return desc && Object.hasOwn(desc, 'value') && desc.enumerable; });
}
function array(value, max) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let index = 0; index < value.length; index++) { const desc = Object.getOwnPropertyDescriptor(value, String(index)); if (!desc || !Object.hasOwn(desc, 'value') || !desc.enumerable) fail(); }
  return value;
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const baseKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const batchKeys = [...baseKeys, 'provider', 'tenant', 'sourceHash', 'payloadHash', 'archiveManifestSha256', 'archiveId', 'importedBy', 'importedAt',
  'importedCount', 'caseCount', 'employeeCount', 'status', 'sourceSystemComplete', 'operationalImportCompleted'];
const summaryKeys = [...baseKeys, 'batchId', 'entity', 'sourceId', 'targetId', 'name', 'businessNo', 'businessNoOrigin', 'sourceCreatedAt', 'sourceFileId', 'rowNumber'];
const caseFields = [['name', '姓名'], ['caseNo', '個案編號'], ['birthDate', '出生日期'], ['gender', '性別'], ['phone', '聯絡電話'], ['address', '地址'], ['status', '服務狀態'],
  ['cmsLevel', 'CMS 等級'], ['welfare', '福利身分'], ['supervisorId', '督導識別碼'], ['primaryCarer', '主要照顧者'], ['contactName', '聯絡人'], ['contactPhone', '聯絡人電話'], ['note', '備註']];
const employeeFields = [['name', '姓名'], ['employeeNo', '員工編號'], ['role', '職務'], ['phone', '聯絡電話'], ['email', '電子郵件'], ['status', '員工狀態'],
  ['qualification', '資格與證照'], ['regions', '服務區域'], ['note', '備註']];
function metadata(value, orgId) {
  if (!uuid(value.id) || value.orgId !== orgId || !positive(value.version) || !time(value.createdAt) || !time(value.updatedAt)) fail();
}
function batch(value, orgId) {
  if (!closed(value, batchKeys)) fail(); metadata(value, orgId);
  if (!token(value.provider) || !token(value.tenant) || !sha(value.sourceHash) || !sha(value.payloadHash) || !sha(value.archiveManifestSha256)
      || typeof value.archiveId !== 'string' || !/^archive-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.archiveId)
      || !uuid(value.importedBy) || !time(value.importedAt) || !positive(value.importedCount) || value.importedCount > 2000 || !nonnegative(value.caseCount)
      || !nonnegative(value.employeeCount) || value.caseCount + value.employeeCount !== value.importedCount || value.status !== 'operational-first-slice'
      || value.sourceSystemComplete !== false || value.operationalImportCompleted !== true) fail();
  return Object.fromEntries(batchKeys.map(key => [key, value[key]]));
}
function summary(value, orgId, batchId, provider) {
  if (!closed(value, summaryKeys)) fail(); metadata(value, orgId);
  if (!uuid(value.batchId) || (batchId && value.batchId !== batchId) || !['cases', 'employees'].includes(value.entity) || !/^[a-f0-9]{24}$/.test(value.sourceId)
      || !uuid(value.targetId) || !text(value.name) || !value.name.trim() || !text(value.businessNo) || !value.businessNo.trim()
      || !['source', 'derived'].includes(value.businessNoOrigin) || (value.sourceCreatedAt !== null && (!text(value.sourceCreatedAt) || value.sourceCreatedAt.length > 1000))
      || !/^file-[0-9]{8}$/.test(value.sourceFileId) || value.sourceFileId === 'file-00000000' || !positive(value.rowNumber) || value.rowNumber > 1000000000) fail();
  if (value.businessNoOrigin === 'derived' && (value.entity !== 'employees' || !provider || value.businessNo !== provider.toUpperCase() + '-' + value.sourceId)) fail();
  return Object.fromEntries(summaryKeys.map(key => [key, value[key]]));
}
function request(value, keys) {
  if (!closed(value, keys) || !uuid(value.orgId)) fail();
  if (keys.includes('page') && (!positive(value.page) || value.pageSize !== 25)) fail();
  if (keys.includes('id') && !uuid(value.id)) fail();
}
function paging(value, requested, rows) {
  if (value.orgId !== requested.orgId || value.sourceSystemComplete !== false || value.page !== requested.page || value.pageSize !== requested.pageSize || !nonnegative(value.total)) fail();
  array(rows, 25); const start = (value.page - 1) * value.pageSize;
  if (!Number.isSafeInteger(start) || rows.length !== Math.min(25, Math.max(0, value.total - start))) fail();
}
export function legacyMigrationsIdentity(context) {
  return JSON.stringify([context?.user?.id ?? null, context?.organizationId ?? context?.orgId ?? null, context?.role ?? null,
    context?.user?.employeeId ?? context?.employeeId ?? null]);
}
export function confirmLegacyMigrationList(value, requested) {
  request(requested, ['orgId', 'page', 'pageSize']);
  if (!closed(value, ['orgId', 'items', 'total', 'page', 'pageSize', 'sourceSystemComplete'])) fail(); paging(value, requested, value.items);
  const ids = new Set(), items = value.items.map(item => { const checked = batch(item, requested.orgId); if (ids.has(checked.id)) fail(); ids.add(checked.id); return checked; });
  return freeze({ orgId: requested.orgId, items, total: value.total, page: value.page, pageSize: value.pageSize, sourceSystemComplete: false });
}
export function confirmLegacyMigrationBatch(value, requested) {
  request(requested, ['orgId', 'id', 'page', 'pageSize']);
  if (!closed(value, ['orgId', 'item', 'records', 'total', 'page', 'pageSize', 'sourceSystemComplete'])) fail(); paging(value, requested, value.records);
  const item = batch(value.item, requested.orgId); if (item.id !== requested.id || value.total !== item.importedCount) fail();
  const ids = new Set(), records = value.records.map(row => { const checked = summary(row, requested.orgId, requested.id, item.provider); if (ids.has(checked.id)) fail(); ids.add(checked.id); return checked; });
  return freeze({ orgId: requested.orgId, item, records, total: value.total, page: value.page, pageSize: value.pageSize, sourceSystemComplete: false });
}
function targetData(value, entity, current = false) {
  const fields = entity === 'cases' ? caseFields : employeeFields, required = entity === 'cases' ? ['name', 'caseNo', 'status'] : ['name', 'employeeNo', 'status'];
  const optional = fields.map(([key]) => key).filter(key => !required.includes(key));
  if (current) optional.push(...baseKeys, ...(entity === 'employees' ? ['hourlyRateCents'] : []));
  if (!closed(value, required, optional)) fail();
  const result = {};
  for (const [key] of fields) if (Object.hasOwn(value, key)) {
    const saved = value[key];
    if (key === 'cmsLevel') { if (saved !== '' && (!Number.isInteger(saved) || saved < 1 || saved > 8)) fail(); }
    else if (key === 'regions' && Array.isArray(saved)) { array(saved, 50); if (saved.some(value => !text(value) || value.length >= 100)) fail(); }
    else if (!text(saved)) fail();
    result[key] = Array.isArray(saved) ? [...saved] : saved;
  }
  if (!result.name.trim() || !(result.caseNo ?? result.employeeNo).trim() || !(entity === 'cases' ? ['active', 'paused', 'closed'] : ['active', 'inactive']).includes(result.status)) fail();
  if (current && Object.hasOwn(value, 'hourlyRateCents')) { if (!nonnegative(value.hourlyRateCents) || value.hourlyRateCents > 1000000000) fail(); result.hourlyRateCents = value.hourlyRateCents; }
  return result;
}
export function confirmLegacyMigrationRecord(value, requested) {
  request(requested, ['orgId', 'id']);
  if (!closed(value, ['orgId', 'item', 'batch', 'currentTarget', 'sourceSystemComplete']) || value.orgId !== requested.orgId || value.sourceSystemComplete !== false
      || !closed(value.item, [...summaryKeys, 'data', 'columns'])) fail();
  const parent = batch(value.batch, requested.orgId), summaryValue = Object.fromEntries(summaryKeys.map(key => [key, value.item[key]])), item = summary(summaryValue, requested.orgId, parent.id, parent.provider);
  if (item.id !== requested.id) fail();
  const data = targetData(value.item.data, item.entity), currentTarget = targetData(value.currentTarget, item.entity, true); metadata(value.currentTarget, requested.orgId);
  if (value.currentTarget.id !== item.targetId || data.name !== item.name || (data.caseNo ?? data.employeeNo) !== item.businessNo) fail();
  const indexes = new Set(), columns = array(value.item.columns, 500).map(column => {
    if (!closed(column, ['columnIndex', 'label', 'raw', 'formula', 'cached']) || !positive(column.columnIndex) || column.columnIndex > 16384 || indexes.has(column.columnIndex)
        || !text(column.label) || column.label.length > 1000 || !scalar(column.raw) || !scalar(column.cached) || (column.formula !== null && !text(column.formula))) fail();
    indexes.add(column.columnIndex); return { columnIndex: column.columnIndex, label: column.label, raw: column.raw, formula: column.formula, cached: column.cached };
  });
  if (!columns.length) fail();
  const fields = (item.entity === 'cases' ? caseFields : employeeFields).filter(([key]) => Object.hasOwn(data, key)).map(([key, label]) => ({ key, label, source: data[key],
    current: Object.hasOwn(currentTarget, key) ? currentTarget[key] : undefined, comparison: !Object.hasOwn(currentTarget, key) ? 'missing' : JSON.stringify(data[key]) === JSON.stringify(currentTarget[key]) ? 'same' : 'changed' }));
  return freeze({ orgId: requested.orgId, item: { ...item, data, columns }, batch: parent, currentTarget: { ...currentTarget, ...Object.fromEntries(baseKeys.map(key => [key, value.currentTarget[key]])) }, fields, sourceSystemComplete: false });
}
export function legacyScalarText(value) {
  if (value === null) return '空值（null）'; if (value === '') return '空白文字';
  if (typeof value === 'boolean') return value ? 'true（布林值）' : 'false（布林值）';
  if (typeof value === 'number' && Number.isFinite(value)) return `${Object.is(value, -0) ? '-0' : value}（數字）`;
  if (text(value)) return value; if (Array.isArray(value) && value.every(text)) return value.length ? value.join('\n') : '空白清單';
  if (value === undefined) return '目前未提供'; fail();
}
