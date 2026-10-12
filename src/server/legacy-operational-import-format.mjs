import { createHash } from 'node:crypto';
import { fail, entities, validatePayload, dateValid } from './model.mjs';
import { legacyClosed, parseLegacyJson } from './legacy-migration-archive-metadata.mjs';

export const LEGACY_OPERATIONAL_FORMAT = 'suiyue-legacy-operational-import-v1';
export const LEGACY_OPERATIONAL_MAX_BYTES = 32 * 1024 * 1024;
export const LEGACY_OPERATIONAL_MAX_RECORDS = 2000;
export const LEGACY_OPERATIONAL_BATCH_ENTITY = 'legacy-operational-batch';
export const LEGACY_OPERATIONAL_SOURCE_ENTITY = 'legacy-operational-source';
export const legacyDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const legacyUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const legacyTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const token = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const sourceId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const fileId = value => typeof value === 'string' && /^file-[0-9]{8}$/.test(value) && value !== 'file-00000000';
const unicode = value => typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const scalar = value => value === null || typeof value === 'boolean' || (unicode(value) && value.length <= 100000) ||
  (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const invalid = () => fail(422, 'LEGACY_IMPORT_INVALID', '移轉封包格式、來源識別或原始欄位無法確認');
export function legacyDenseList(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return value;
}
export function legacyCanonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(legacyCanonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + legacyCanonical(value[key])).join(',') + '}';
}
export const legacyOperationalHash = value => createHash('sha256').update(legacyCanonical(value)).digest('hex');
function sources(value) {
  const files = legacyDenseList(value, 16), ids = new Set();
  if (!files.length) invalid();
  for (const file of files) {
    if (!legacyClosed(file, ['fileId', 'sha256']) || !fileId(file.fileId) || !legacyDigest(file.sha256) || ids.has(file.fileId)) invalid();
    ids.add(file.fileId);
  }
  return files.map(file => ({ fileId: file.fileId, sha256: file.sha256 })).sort((a, b) => a.fileId.localeCompare(b.fileId));
}
export function legacyOperationalSourceHash(value) {
  if (!legacyClosed(value, ['provider', 'tenant', 'sourceFiles']) || !token(value.provider) || !token(value.tenant)) invalid();
  return legacyOperationalHash({ format: 'suiyue-legacy-operational-source-v1', provider: value.provider, tenant: value.tenant, sourceFiles: sources(value.sourceFiles) });
}
export function legacyDerivedBusinessNo(provider, identity) {
  if (!token(provider) || !sourceId(identity)) invalid();
  return provider.toUpperCase() + '-' + identity;
}
export function legacyOperationalId(orgId, provider, tenant, entity, identity, kind = 'target') {
  if (!legacyUuid(orgId) || !token(provider) || !token(tenant) || !['cases', 'employees', 'batch'].includes(entity) || !['target', 'mapping', 'batch'].includes(kind) || typeof identity !== 'string') invalid();
  // RFC 9562 version 5, using the DNS namespace and a module-specific name.
  // This is a new target identifier, never a claim about the old platform ID.
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(JSON.stringify(['suiyue-homecare-legacy-v1', kind, orgId, provider, tenant, entity, identity])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex'); return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
export function validateLegacyOperationalRecord(record, refs) {
  if (!legacyClosed(record, ['entity', 'sourceId', 'sourceCreatedAt', 'businessNoOrigin', 'data', 'sourceFileId', 'rowNumber', 'columns']) ||
      !['cases', 'employees'].includes(record.entity) || !sourceId(record.sourceId) || !(record.sourceCreatedAt === null || unicode(record.sourceCreatedAt) && record.sourceCreatedAt.length <= 1000) ||
      !['source', 'derived'].includes(record.businessNoOrigin) || !fileId(record.sourceFileId) || !refs.has(record.sourceFileId) || !Number.isSafeInteger(record.rowNumber) || record.rowNumber < 1 || record.rowNumber > 1000000000) invalid();
  const allowed = entities[record.entity].fields.split(' ').filter(key => key !== 'hourlyRateCents');
  if (!legacyClosed(record.data, ['name', record.entity === 'cases' ? 'caseNo' : 'employeeNo', 'status'], allowed.filter(key => !['name', 'caseNo', 'employeeNo', 'status'].includes(key)))) invalid();
  const data = record.data, key = record.entity === 'cases' ? 'caseNo' : 'employeeNo';
  if (typeof data.name !== 'string' || !data.name.trim() || typeof data[key] !== 'string' || !data[key] || data[key] !== data[key].trim() || data[key].length > 200 || /[\u0000-\u001f\u007f]/.test(data[key]) ||
      !entities[record.entity].statuses.includes(data.status)) invalid();
  if (Array.isArray(data.regions)) {
    legacyDenseList(data.regions, 50);
    if (data.regions.some(value => !unicode(value) || value.length >= 100)) invalid();
  }
  try { validatePayload(record.entity, data); } catch { invalid(); }
  for (const value of Object.values(data)) if (typeof value === 'string' && !unicode(value)) invalid();
  if (data.birthDate && !dateValid(data.birthDate) || data.cmsLevel !== undefined && data.cmsLevel !== '' && (data.cmsLevel < 1 || data.cmsLevel > 8) || data.supervisorId && !legacyUuid(data.supervisorId)) invalid();
  const columns = legacyDenseList(record.columns, 500), indices = new Set();
  if (!columns.length) invalid();
  for (const column of columns) {
    if (!legacyClosed(column, ['columnIndex', 'label', 'raw', 'formula', 'cached']) || !Number.isSafeInteger(column.columnIndex) || column.columnIndex < 1 || column.columnIndex > 16384 || indices.has(column.columnIndex) ||
        !unicode(column.label) || column.label.length > 1000 || !scalar(column.raw) || !scalar(column.cached) || !(column.formula === null || unicode(column.formula) && column.formula.length <= 100000)) invalid();
    indices.add(column.columnIndex);
  }
  return record;
}
export function normalizeLegacyOperationalPayload(payload) {
  if (!legacyClosed(payload, ['format', 'provider', 'tenant', 'archiveManifestSha256', 'sourceFiles', 'sourceHash', 'records']) || payload.format !== LEGACY_OPERATIONAL_FORMAT || !token(payload.provider) || !token(payload.tenant) ||
      !legacyDigest(payload.archiveManifestSha256) || !legacyDigest(payload.sourceHash)) invalid();
  const files = sources(payload.sourceFiles), refs = new Set(files.map(file => file.fileId));
  if (payload.sourceHash !== legacyOperationalSourceHash({ provider: payload.provider, tenant: payload.tenant, sourceFiles: files })) invalid();
  const records = legacyDenseList(payload.records, LEGACY_OPERATIONAL_MAX_RECORDS), identities = new Set(), numbers = new Set(), used = new Set();
  if (!records.length) invalid();
  for (const [index, record] of records.entries()) {
    try { validateLegacyOperationalRecord(record, refs); }
    catch (error) { fail(422, 'LEGACY_IMPORT_INVALID', '移轉封包原始欄位或主檔無法確認', { recordIndex: index + 1 }); }
    const key = record.entity === 'cases' ? 'caseNo' : 'employeeNo', identity = record.entity + ':' + record.sourceId, number = record.entity + ':' + record.data[key];
    if (identities.has(identity) || numbers.has(number)) fail(409, 'LEGACY_IMPORT_DUPLICATE', '本批來源識別或業務編號重複，整批未保存');
    if (record.businessNoOrigin === 'derived' && (record.entity !== 'employees' || record.data.employeeNo !== legacyDerivedBusinessNo(payload.provider, record.sourceId))) invalid();
    identities.add(identity); numbers.add(number); used.add(record.sourceFileId);
  }
  if (used.size !== refs.size) invalid();
  const normalized = { ...payload, sourceFiles: files };
  const bytes = Buffer.from(legacyCanonical(normalized));
  if (bytes.length > LEGACY_OPERATIONAL_MAX_BYTES) invalid();
  // The clone strips references without converting raw strings, blanks,
  // scalar types, formulas, cached values or duplicate source column labels.
  try { return parseLegacyJson(bytes, LEGACY_OPERATIONAL_MAX_BYTES); } catch { invalid(); } finally { bytes.fill(0); }
}
