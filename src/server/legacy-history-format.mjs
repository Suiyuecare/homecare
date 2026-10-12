import { createHash } from 'node:crypto';
import { fail } from './model.mjs';
import { legacyClosed, parseLegacyJson } from './legacy-migration-archive-metadata.mjs';
import { legacyUuid, legacyDigest, legacyCanonical } from './legacy-operational-import-format.mjs';

export { legacyUuid, legacyDigest };
export const LEGACY_HISTORY_FORMAT = 'suiyue-legacy-history-import-v1';
export const LEGACY_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
export const LEGACY_HISTORY_MAX_RECORDS = 1000;
export const LEGACY_HISTORY_BATCH_ENTITY = 'legacy-history-batches';
export const LEGACY_HISTORY_ROW_ENTITY = 'legacy-history-rows';
export const LEGACY_HISTORY_CATEGORIES = Object.freeze(['attachment-metadata', 'care-plan-history', 'case-profile', 'company-settings', 'employee-profile', 'fa-export', 'form-record', 'service-export']);
export const LEGACY_HISTORY_FLAGS = Object.freeze({ sourceSystemComplete: false, operationalConversionCompleted: false, approvalCompleted: false, payrollApproved: false });
export const historyUnicode = value => typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
export const historyReportingPeriod = value => typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) >= 1;
const token = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const fileId = value => typeof value === 'string' && /^file-[0-9]{8}$/.test(value) && value !== 'file-00000000';
const rawText = (value, max) => value === null || historyUnicode(value) && value.length <= max;
const scalar = value => value === null || typeof value === 'boolean' || historyUnicode(value) && value.length <= 100000 ||
  typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const invalid = () => fail(422, 'LEGACY_HISTORY_INVALID', '歷史原始紀錄封包或原始欄位無法確認');
export function historyDenseList(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return value;
}
export function legacyHistoryHash(value) {
  let nodes = 0;
  const check = (item, depth) => {
    if (++nodes > 3000000 || depth > 32) invalid();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0) || Number.isInteger(item) && !Number.isSafeInteger(item)) invalid(); return; }
    if (typeof item === 'string') { if (!historyUnicode(item)) invalid(); return; }
    if (Array.isArray(item)) { historyDenseList(item, 500000); for (const child of item) check(child, depth + 1); return; }
    if (!item || typeof item !== 'object' || !legacyClosed(item, Object.keys(item))) invalid();
    for (const key of Object.keys(item)) { if (!historyUnicode(key)) invalid(); check(Object.getOwnPropertyDescriptor(item, key).value, depth + 1); }
  };
  check(value, 0); return createHash('sha256').update(legacyCanonical(value)).digest('hex');
}
export function historySources(value) {
  const files = historyDenseList(value, 16), used = new Set();
  if (!files.length) invalid();
  for (const item of files) {
    if (!legacyClosed(item, ['fileId', 'sha256']) || !fileId(item.fileId) || !legacyDigest(item.sha256) || used.has(item.fileId)) invalid();
    used.add(item.fileId);
  }
  return files.map(item => ({ fileId: item.fileId, sha256: item.sha256 })).sort((a, b) => a.fileId.localeCompare(b.fileId));
}
export function validateHistoryLocator(locator) {
  if (!legacyClosed(locator, ['kind'], ['sheetIndex', 'rowNumber', 'pointer'])) invalid();
  if (locator.kind === 'worksheet-row') {
    if (!legacyClosed(locator, ['kind', 'sheetIndex', 'rowNumber']) || !Number.isSafeInteger(locator.sheetIndex) || locator.sheetIndex < 1 || locator.sheetIndex > 100000 ||
        !Number.isSafeInteger(locator.rowNumber) || locator.rowNumber < 1 || locator.rowNumber > 1048576) invalid();
  } else if (locator.kind === 'json-pointer') {
    if (!legacyClosed(locator, ['kind', 'pointer']) || !historyUnicode(locator.pointer) || locator.pointer.length > 4000 ||
        locator.pointer !== '' && !locator.pointer.startsWith('/') || /~(?![01])/.test(locator.pointer)) invalid();
  } else invalid();
  return locator;
}
export function historyLocatorKey(sha256, locator) {
  if (!legacyDigest(sha256)) invalid(); validateHistoryLocator(locator);
  return legacyCanonical({ fileSha256: sha256, locator });
}
export function validateLegacyHistoryRecord(record, refs) {
  if (!legacyClosed(record, ['category', 'reportingPeriod', 'sourceNativeId', 'sourceCreatedAt', 'caseId', 'employeeId', 'sourceFileId', 'locator', 'columns']) ||
      !LEGACY_HISTORY_CATEGORIES.includes(record.category) || !(record.reportingPeriod === null || historyReportingPeriod(record.reportingPeriod)) ||
      !rawText(record.sourceNativeId, 4000) || !rawText(record.sourceCreatedAt, 4000) || !(record.caseId === null || legacyUuid(record.caseId)) || !(record.employeeId === null || legacyUuid(record.employeeId)) ||
      !fileId(record.sourceFileId) || !refs.has(record.sourceFileId)) invalid();
  validateHistoryLocator(record.locator);
  const columns = historyDenseList(record.columns, 500), indices = new Set();
  if (!columns.length) invalid();
  for (const column of columns) {
    if (!legacyClosed(column, ['columnIndex', 'label', 'raw', 'formula', 'cached']) || !Number.isSafeInteger(column.columnIndex) || column.columnIndex < 1 || column.columnIndex > 16384 || indices.has(column.columnIndex) ||
        !historyUnicode(column.label) || column.label.length > 1000 || !scalar(column.raw) || !scalar(column.cached) || !rawText(column.formula, 100000)) invalid();
    indices.add(column.columnIndex);
  }
  return record;
}
function records(value, files) {
  const rows = historyDenseList(value, LEGACY_HISTORY_MAX_RECORDS), refs = new Map(files.map(file => [file.fileId, file.sha256])), used = new Set(), identities = new Set();
  if (!rows.length) invalid();
  for (const [index, row] of rows.entries()) {
    try { validateLegacyHistoryRecord(row, refs); } catch { fail(422, 'LEGACY_HISTORY_INVALID', '歷史原始欄位或定位無法確認', { recordIndex: index + 1 }); }
    const identity = historyLocatorKey(refs.get(row.sourceFileId), row.locator);
    if (identities.has(identity)) fail(409, 'LEGACY_HISTORY_DUPLICATE', '本批同一原檔定位重複，整批未保存');
    identities.add(identity); used.add(row.sourceFileId);
  }
  if (used.size !== refs.size) invalid();
  return rows;
}
export function legacyHistorySelectionSourceHash(value) {
  if (!legacyClosed(value, ['provider', 'tenant', 'sourceFiles', 'selections']) || !token(value.provider) || !token(value.tenant)) invalid();
  const files = historySources(value.sourceFiles), refs = new Map(files.map(file => [file.fileId, file.sha256])), selected = historyDenseList(value.selections, LEGACY_HISTORY_MAX_RECORDS), used = new Set(), identities = new Set();
  if (!selected.length) invalid();
  const selections = selected.map(item => {
    if (!legacyClosed(item, ['sourceFileId', 'locator']) || !refs.has(item.sourceFileId)) invalid();
    validateHistoryLocator(item.locator); const identity = historyLocatorKey(refs.get(item.sourceFileId), item.locator);
    if (identities.has(identity)) invalid(); identities.add(identity); used.add(item.sourceFileId);
    return { sourceFileId: item.sourceFileId, fileSha256: refs.get(item.sourceFileId), locator: item.locator };
  }).sort((a, b) => legacyCanonical(a).localeCompare(legacyCanonical(b)));
  if (used.size !== refs.size) invalid();
  return legacyHistoryHash({ format: 'suiyue-legacy-history-logical-source-v1', provider: value.provider, tenant: value.tenant, sourceFiles: files, selections });
}
export function legacyHistorySourceHash(value) {
  if (!legacyClosed(value, ['provider', 'tenant', 'sourceFiles', 'records']) || !token(value.provider) || !token(value.tenant)) invalid();
  const files = historySources(value.sourceFiles), rows = records(value.records, files);
  return legacyHistorySelectionSourceHash({ provider: value.provider, tenant: value.tenant, sourceFiles: files, selections: rows.map(row => ({ sourceFileId: row.sourceFileId, locator: row.locator })) });
}
function identifier(parts) {
  const bytes = createHash('sha1').update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')).update(legacyCanonical(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex'); return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
export function legacyHistoryRowId(orgId, provider, tenant, sha256, locator) {
  if (!legacyUuid(orgId) || !token(provider) || !token(tenant)) invalid();
  return identifier(['suiyue-homecare-history-v1', 'archive-locator', orgId, provider, tenant, historyLocatorKey(sha256, locator)]);
}
export function legacyHistoryBatchId(orgId, provider, tenant, sourceHash) {
  if (!legacyUuid(orgId) || !token(provider) || !token(tenant) || !legacyDigest(sourceHash)) invalid();
  return identifier(['suiyue-homecare-history-v1', 'batch', orgId, provider, tenant, sourceHash]);
}
export function normalizeLegacyHistoryPayload(payload) {
  if (!legacyClosed(payload, ['format', 'provider', 'tenant', 'archiveManifestSha256', 'sourceFiles', 'sourceHash', 'records']) || payload.format !== LEGACY_HISTORY_FORMAT || !token(payload.provider) || !token(payload.tenant) ||
      !legacyDigest(payload.archiveManifestSha256) || !legacyDigest(payload.sourceHash)) invalid();
  const files = historySources(payload.sourceFiles), rows = records(payload.records, files);
  if (payload.sourceHash !== legacyHistorySourceHash({ provider: payload.provider, tenant: payload.tenant, sourceFiles: files, records: rows })) invalid();
  const bytes = Buffer.from(legacyCanonical({ ...payload, sourceFiles: files }));
  try { if (bytes.length > LEGACY_HISTORY_MAX_BYTES) invalid(); return parseLegacyJson(bytes, LEGACY_HISTORY_MAX_BYTES); }
  catch { invalid(); } finally { bytes.fill(0); }
}
