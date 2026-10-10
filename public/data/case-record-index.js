export const CASE_RECORD_INDEX_PAGE_SIZE = 25;
export const CASE_RECORD_INDEX_ENTITIES = Object.freeze([
  { value: 'care-plans', label: '照顧計畫' },
  { value: 'shifts', label: '班次' },
  { value: 'service-records', label: '服務紀錄' },
  { value: 'assessments', label: '評估填答' },
].map(Object.freeze));

const envelopeKeys = ['items', 'total', 'page', 'pageSize', 'entity', 'orgId', 'caseId'];
const rowKeys = ['entity', 'id', 'orgId', 'caseId', 'version', 'updatedAt'];
const requestedKeys = ['entity', 'orgId', 'caseId', 'page', 'pageSize'];
const knownEntity = value => CASE_RECORD_INDEX_ENTITIES.some(item => item.value === value);
const identifier = value => typeof value === 'string' && Boolean(value.trim());
export const isCaseRecordIndexId = value => typeof value === 'string' && /^[a-f0-9-]+$/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
function unconfirmed() {
  throw Object.assign(new Error('紀錄索引回應無法確認；請重新讀取。'), { code: 'CASE_RECORD_INDEX_UNCONFIRMED' });
}

// Inspect descriptors before reading values; rejected accessors never run.
function exactData(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) unconfirmed();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) unconfirmed();
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) unconfirmed();
    copy[key] = descriptor.value;
  }
  return copy;
}
function copiedRows(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) unconfirmed();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > CASE_RECORD_INDEX_PAGE_SIZE
    || Reflect.ownKeys(value).length !== length.value + 1) unconfirmed();
  const rows = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) unconfirmed();
    rows.push(exactData(descriptor.value, rowKeys));
  }
  return rows;
}

export function caseRecordIndexIdentity(context) {
  return JSON.stringify([context.user?.id ?? null, context.organizationId ?? context.orgId ?? null,
    context.role ?? null, context.user?.employeeId ?? null]);
}

export function caseRecordIndexQuery(entity, page = 1) {
  if (!knownEntity(entity)) throw Object.assign(new Error('請選擇有效的紀錄種類。'), { fields: { entity: '請選擇有效的紀錄種類。' } });
  if (!positiveInteger(page)) throw new Error('請選擇有效的紀錄頁次。');
  return Object.freeze({ entity, page, pageSize: CASE_RECORD_INDEX_PAGE_SIZE });
}

/** Metadata-only, safe copied response. The unreturned created_at sort cannot be confirmed here. */
export function confirmCaseRecordIndex(response, requested) {
  try {
    const query = exactData(requested, requestedKeys), result = exactData(response, envelopeKeys);
    if (!knownEntity(query.entity) || !identifier(query.orgId) || !isCaseRecordIndexId(query.caseId)
      || !positiveInteger(query.page) || query.pageSize !== CASE_RECORD_INDEX_PAGE_SIZE
      || requestedKeys.some(key => result[key] !== query[key])
      || !Number.isSafeInteger(result.total) || result.total < 0) unconfirmed();
    const rows = copiedRows(result.items), ids = new Set();
    const expectedLength = Math.max(0, Math.min(CASE_RECORD_INDEX_PAGE_SIZE,
      result.total - (query.page - 1) * CASE_RECORD_INDEX_PAGE_SIZE));
    if (rows.length !== expectedLength) unconfirmed();
    for (const row of rows) {
      if (row.entity !== query.entity || row.orgId !== query.orgId || row.caseId !== query.caseId
        || !isCaseRecordIndexId(row.id) || ids.has(row.id) || !positiveInteger(row.version)
        || typeof row.updatedAt !== 'string') unconfirmed();
      ids.add(row.id); Object.freeze(row);
    }
    return Object.freeze({ ...result, items: Object.freeze(rows) });
  } catch { unconfirmed(); }
}
