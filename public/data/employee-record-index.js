export const EMPLOYEE_RECORD_INDEX_PAGE_SIZE = 25;
export const EMPLOYEE_RECORD_INDEX_ENTITIES = Object.freeze([
  Object.freeze({ value: 'employee-certifications', label: '證照' }),
  Object.freeze({ value: 'employee-training', label: '訓練' }),
  Object.freeze({ value: 'leave-requests', label: '請假' }),
]);
const envelopeKeys = ['items', 'total', 'page', 'pageSize', 'entity', 'orgId', 'employeeId'];
const rowKeys = ['entity', 'id', 'orgId', 'employeeId', 'version', 'updatedAt'];
const requestedKeys = ['entity', 'orgId', 'employeeId', 'page', 'pageSize'];
const knownEntity = value => EMPLOYEE_RECORD_INDEX_ENTITIES.some(item => item.value === value);
const identifier = value => typeof value === 'string' && Boolean(value.trim());
export const isEmployeeRecordIndexId = value => typeof value === 'string' && /^[a-f0-9-]+$/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
function unconfirmed() {
  throw Object.assign(new Error('紀錄索引回應無法確認；請重新讀取。'), { code: 'EMPLOYEE_RECORD_INDEX_UNCONFIRMED' });
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
    || length.value < 0 || length.value > EMPLOYEE_RECORD_INDEX_PAGE_SIZE
    || Reflect.ownKeys(value).length !== length.value + 1) unconfirmed();
  const rows = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) unconfirmed();
    rows.push(exactData(descriptor.value, rowKeys));
  }
  return rows;
}

export function employeeRecordIndexIdentity(context) {
  return JSON.stringify([context.user?.id ?? null, context.organizationId ?? context.orgId ?? null,
    context.role ?? null, context.user?.employeeId ?? null]);
}

export function employeeRecordIndexQuery(entity, page = 1) {
  if (!knownEntity(entity)) throw Object.assign(new Error('請選擇有效的紀錄種類。'), { fields: { entity: '請選擇有效的紀錄種類。' } });
  if (!positiveInteger(page)) throw new Error('請選擇有效的紀錄頁次。');
  return Object.freeze({ entity, page, pageSize: EMPLOYEE_RECORD_INDEX_PAGE_SIZE });
}

/** Metadata-only, safe copied response. The unreturned created_at sort cannot be confirmed here. */
export function confirmEmployeeRecordIndex(response, requested) {
  try {
    const query = exactData(requested, requestedKeys), result = exactData(response, envelopeKeys);
    if (!knownEntity(query.entity) || !identifier(query.orgId) || !isEmployeeRecordIndexId(query.employeeId)
      || !positiveInteger(query.page) || query.pageSize !== EMPLOYEE_RECORD_INDEX_PAGE_SIZE
      || requestedKeys.some(key => result[key] !== query[key])
      || !Number.isSafeInteger(result.total) || result.total < 0) unconfirmed();
    const rows = copiedRows(result.items), ids = new Set();
    const expectedLength = Math.max(0, Math.min(EMPLOYEE_RECORD_INDEX_PAGE_SIZE,
      result.total - (query.page - 1) * EMPLOYEE_RECORD_INDEX_PAGE_SIZE));
    if (rows.length !== expectedLength) unconfirmed();
    for (const row of rows) {
      if (row.entity !== query.entity || row.orgId !== query.orgId || row.employeeId !== query.employeeId
        || !isEmployeeRecordIndexId(row.id) || ids.has(row.id) || !positiveInteger(row.version)
        || typeof row.updatedAt !== 'string') unconfirmed();
      ids.add(row.id); Object.freeze(row);
    }
    return Object.freeze({ ...result, items: Object.freeze(rows) });
  } catch { unconfirmed(); }
}
