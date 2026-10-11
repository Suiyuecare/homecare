import { createHash } from 'node:crypto';
import { fail as defaultFail } from './model.mjs';
import { guardCalculationAccess, readApprovedCalculationSource } from './calculation-engine.mjs';
import { CalculationError, immutableCalculationCopy, canonicalCalculationJson } from '../../public/data/calculation-core.js';
import { LTC_CODE_CALCULATION_MODE, calculateLtcCodeAmount, ltcCatalogSnapshot } from '../../public/data/ltc-code-calculation.js';

const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && own(value, key)?.enumerable && Object.hasOwn(own(value, key), 'value'));
const closed = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const safe = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const ref = value => text(value, 100) && value.length > 0 && value === value.trim() && !/[\r\n]/.test(value);
const invalid = (fail, message) => fail(422, 'LTC_CALCULATION_INVALID', message);
function boundedResponse(value, fail) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2 * 1024 * 1024) fail(413, 'LTC_CALCULATION_TOO_LARGE', '完整官方代碼試算超過 2MiB，請縮小查詢；不省略來源或適用條件。');
  return immutableCalculationCopy(value);
}

export function ltcCatalogQuery(params, fail = defaultFail) {
  if (!(params instanceof URLSearchParams)) invalid(fail, '官方清冊查詢格式無法確認。');
  for (const key of params.keys()) if (!['page', 'pageSize', 'q', 'category'].includes(key) || params.getAll(key).length !== 1) invalid(fail, '官方清冊查詢欄位未知或重複。');
  const pageText = params.get('page') ?? '1', sizeText = params.get('pageSize') ?? '25', q = params.get('q') ?? '', category = params.get('category') ?? '';
  if (!/^[1-9]\d*$/.test(pageText) || /[\r\n]/.test(pageText) || !/^[1-9]\d*$/.test(sizeText) || /[\r\n]/.test(sizeText)
    || !safe(Number(pageText), 1) || !safe(Number(sizeText), 1, 100) || !safe((Number(pageText) - 1) * Number(sizeText)) || !text(q, 200) || !['', 'BA', 'AA'].includes(category))
    invalid(fail, '官方清冊分頁、搜尋或代碼類別不合法。');
  return { page: Number(pageText), pageSize: Number(sizeText), q, category };
}
export function listLtcCatalog(db, ctx, query, { fail = defaultFail } = {}) {
  guardCalculationAccess(db, ctx, fail);
  if (!closed(query, ['page', 'pageSize', 'q', 'category']) || !safe(query.page, 1) || !safe(query.pageSize, 1, 100)
    || !safe((query.page - 1) * query.pageSize) || !text(query.q, 200) || !['', 'BA', 'AA'].includes(query.category)) invalid(fail, '請使用完整官方清冊查詢。');
  const catalog = ltcCatalogSnapshot(), selected = query.q.toLocaleLowerCase('zh-TW');
  const items = catalog.items.filter(item => (!query.category || item.code.startsWith(query.category))
    && (!selected || [item.code, item.name, item.conditions].some(value => value.toLocaleLowerCase('zh-TW').includes(selected))));
  const { items: _items, ...catalogMetadata } = catalog;
  return boundedResponse({ mode: LTC_CODE_CALCULATION_MODE, orgId: ctx.orgId, catalog: catalogMetadata,
    items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize }, fail);
}
export function validateLtcCalculationPayload(payload, fail = defaultFail) {
  if (!closed(payload, ['catalogVersion', 'source', 'policy']) || !text(payload.catalogVersion, 200) || !closed(payload.source, ['id', 'version'])
    || !ref(payload.source.id) || !safe(payload.source.version, 1) || !plain(payload.policy))
    invalid(fail, '須提供固定官方清冊版次、原核閱來源識別與版次，以及本次明確的適用政策。');
  return payload;
}
export function previewLtcCodeCalculation(db, ctx, payload, { fail = defaultFail } = {}) {
  guardCalculationAccess(db, ctx, fail); validateLtcCalculationPayload(payload, fail);
  const source = readApprovedCalculationSource(db, ctx, payload.source, { fail }); let preview;
  try { preview = calculateLtcCodeAmount({ catalogVersion: payload.catalogVersion, source, policy: payload.policy }); }
  catch (error) { if (error instanceof CalculationError) fail(error.status, error.code, error.message); throw error; }
  const previewHash = createHash('sha256').update(canonicalCalculationJson(preview), 'utf8').digest('hex');
  return boundedResponse({ ...preview, previewHash }, fail);
}
