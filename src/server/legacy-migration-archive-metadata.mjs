import { createHash } from 'node:crypto';

export const LEGACY_SCOPE_FORMAT = 'suiyue-legacy-export-scope-v1';
export const LEGACY_ARCHIVE_FORMAT = 'suiyue-legacy-export-archive-v1';
export const LEGACY_SCOPE_MAX_BYTES = 1024 * 1024;
export const LEGACY_MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
export const LEGACY_MAX_FILES = 100000;
export const LEGACY_MAX_TOTAL_BYTES = 2 ** 40;
export const LEGACY_FILE_READ_MAX_BYTES = 32 * 1024 * 1024;

export class LegacyArchiveError extends Error {
  constructor(code) { super('Legacy export archive could not be confirmed.'); this.name = 'LegacyArchiveError'; this.code = code; }
}
export const legacyFail = code => { throw new LegacyArchiveError(code); };
export const legacyHash = value => createHash('sha256').update(value).digest('hex');
const token = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const unicode = value => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
export function legacyClosed(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value), allowed = [...required, ...optional];
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) return false;
  return keys.every(key => { const desc = Object.getOwnPropertyDescriptor(value, key); return desc && Object.hasOwn(desc, 'value') && desc.enumerable; });
}
function list(value, max = LEGACY_MAX_FILES) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) legacyFail('INVALID_METADATA');
  for (let index = 0; index < value.length; index++) {
    const desc = Object.getOwnPropertyDescriptor(value, String(index));
    if (!desc || !Object.hasOwn(desc, 'value') || !desc.enumerable) legacyFail('INVALID_METADATA');
  }
  return value;
}
function tokens(value) {
  const result = list(value, 5000);
  if (result.some(item => !token(item)) || new Set(result).size !== result.length) legacyFail('INVALID_METADATA');
  return [...result].sort();
}
export function legacyRelativePath(value) {
  if (!unicode(value) || !value || Buffer.byteLength(value) > 4096 || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) legacyFail('INVALID_METADATA');
  const parts = value.split('/');
  if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..')) legacyFail('INVALID_METADATA');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) legacyFail('INVALID_METADATA');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) legacyFail('INVALID_METADATA');
  return value;
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) legacyFail('INVALID_METADATA');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) legacyFail('INVALID_METADATA');
  return value;
}
function exportRange(value) {
  if (!legacyClosed(value, ['kind'], ['startDate', 'endDate']) || !['unknown', 'all-source-rows', 'date-window', 'filtered'].includes(value.kind)) legacyFail('INVALID_METADATA');
  const hasDates = Object.hasOwn(value, 'startDate') || Object.hasOwn(value, 'endDate');
  if (value.kind === 'date-window') {
    if (!Object.hasOwn(value, 'startDate') || !Object.hasOwn(value, 'endDate')) legacyFail('INVALID_METADATA');
    const startDate = day(value.startDate), endDate = day(value.endDate);
    if (endDate < startDate) legacyFail('INVALID_METADATA');
    return { kind: value.kind, startDate, endDate };
  }
  if (hasDates) legacyFail('INVALID_METADATA');
  return { kind: value.kind };
}
export function normalizeLegacyScope(value) {
  if (!legacyClosed(value, ['format', 'provider', 'tenant', 'exportedAt', 'datasets', 'missingDatasets', 'unresolved'])
      || value.format !== LEGACY_SCOPE_FORMAT || !token(value.provider) || !token(value.tenant)) legacyFail('INVALID_METADATA');
  const ids = new Set(), paths = new Set();
  const datasets = list(value.datasets, 5000).map(dataset => {
    if (!legacyClosed(dataset, ['id', 'sourceFiles', 'reportedCoverage', 'range'], ['sourceRowCount']) || !token(dataset.id)
        || ids.has(dataset.id) || !['unknown', 'partial', 'provider-declared-full'].includes(dataset.reportedCoverage)) legacyFail('INVALID_METADATA');
    ids.add(dataset.id);
    const sourceFiles = list(dataset.sourceFiles).map(legacyRelativePath).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const file of sourceFiles) { if (paths.has(file)) legacyFail('INVALID_METADATA'); paths.add(file); }
    const sourceRowCount = Object.hasOwn(dataset, 'sourceRowCount') ? dataset.sourceRowCount : null;
    if (sourceRowCount !== null && !safeInteger(sourceRowCount)) legacyFail('INVALID_METADATA');
    return { id: dataset.id, sourceFiles, sourceRowCount, reportedCoverage: dataset.reportedCoverage, range: exportRange(dataset.range) };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (paths.size > LEGACY_MAX_FILES) legacyFail('INVALID_METADATA');
  const missingDatasets = tokens(value.missingDatasets);
  if (missingDatasets.some(id => ids.has(id))) legacyFail('INVALID_METADATA');
  return { format: LEGACY_SCOPE_FORMAT, provider: value.provider, tenant: value.tenant, exportedAt: timestamp(value.exportedAt), datasets,
    missingDatasets, unresolved: tokens(value.unresolved) };
}

// Parse only bounded JSON; reject duplicate keys (including escaped aliases).
// No formula, script, macro, ZIP member or export row is evaluated here.
export function parseLegacyJson(bytes, maximum = LEGACY_SCOPE_MAX_BYTES) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maximum) legacyFail('INVALID_METADATA');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { legacyFail('INVALID_METADATA'); }
  let index = 0, nodes = 0;
  const space = () => { while (/[\t\r\n ]/.test(text[index] || '\0')) index++; };
  const string = () => {
    const start = index++; let escaped = false;
    while (index < text.length) {
      const char = text[index++];
      if (!escaped && char === '"') { try { return JSON.parse(text.slice(start, index)); } catch { legacyFail('INVALID_METADATA'); } }
      escaped = !escaped && char === '\\';
    }
    legacyFail('INVALID_METADATA');
  };
  const value = depth => {
    if (++nodes > 2000000 || depth > 16) legacyFail('INVALID_METADATA');
    space(); const char = text[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; space(); const result = {}, keys = new Set();
      if (text[index] === '}') { index++; return result; }
      for (;;) {
        space(); if (text[index] !== '"') legacyFail('INVALID_METADATA'); const key = string();
        if (keys.has(key)) legacyFail('INVALID_METADATA'); keys.add(key); space(); if (text[index++] !== ':') legacyFail('INVALID_METADATA');
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space(); const next = text[index++]; if (next === '}') return result; if (next !== ',') legacyFail('INVALID_METADATA');
      }
    }
    if (char === '[') {
      index++; space(); const result = []; if (text[index] === ']') { index++; return result; }
      for (;;) { result.push(value(depth + 1)); space(); const next = text[index++]; if (next === ']') return result; if (next !== ',') legacyFail('INVALID_METADATA'); }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) legacyFail('INVALID_METADATA'); index += number[0].length; return Number(number[0]);
  };
  const result = value(0); space(); if (index !== text.length) legacyFail('INVALID_METADATA'); return result;
}
export function createLegacyManifest(scope, files, archiveId, capturedAt) {
  const byPath = new Map(files.map(file => [file.sourceRelativePathSha256, file]));
  const referenced = new Set(), unresolved = new Set(scope.unresolved);
  const datasets = scope.datasets.map(dataset => {
    const fileIds = [], missingSourcePathSha256 = [];
    for (const path of dataset.sourceFiles) {
      const pathHash = legacyHash(Buffer.from(path)); const file = byPath.get(pathHash);
      if (file) { fileIds.push(file.id); referenced.add(file.id); } else missingSourcePathSha256.push(pathHash);
    }
    if (missingSourcePathSha256.length) unresolved.add('declared-source-files-missing');
    return { id: dataset.id, fileIds, missingSourcePathSha256, sourceRowCount: dataset.sourceRowCount, rowCountVerified: false,
      reportedCoverage: dataset.reportedCoverage, range: dataset.range };
  });
  if (!datasets.length) unresolved.add('dataset-inventory-not-provided');
  const unassignedFileIds = files.filter(file => !referenced.has(file.id)).map(file => file.id);
  if (unassignedFileIds.length) unresolved.add('unassigned-source-files');
  return { format: LEGACY_ARCHIVE_FORMAT, archiveId, capturedAt, integrity: 'verified', source: { provider: scope.provider, tenant: scope.tenant, exportedAt: scope.exportedAt },
    sourceSystemComplete: false, businessImportCompleted: false, files, totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    datasets, missingDatasets: scope.missingDatasets, unresolved: [...unresolved].sort(), unassignedFileIds };
}
export function validateLegacyManifest(value) {
  if (!legacyClosed(value, ['format', 'archiveId', 'capturedAt', 'integrity', 'source', 'sourceSystemComplete', 'businessImportCompleted', 'files', 'totalBytes', 'datasets', 'missingDatasets', 'unresolved', 'unassignedFileIds'])
      || value.format !== LEGACY_ARCHIVE_FORMAT || !/^archive-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.archiveId)
      || value.integrity !== 'verified' || value.sourceSystemComplete !== false || value.businessImportCompleted !== false
      || !legacyClosed(value.source, ['provider', 'tenant', 'exportedAt']) || !token(value.source.provider) || !token(value.source.tenant)) legacyFail('INVALID_MANIFEST');
  timestamp(value.capturedAt); timestamp(value.source.exportedAt);
  const paths = new Set(), hashes = new Set(), ids = new Set(); let total = 0;
  list(value.files).forEach((file, index) => {
    const id = 'file-' + String(index + 1).padStart(8, '0');
    if (!legacyClosed(file, ['id', 'sourceRelativePathSha256', 'archivedPath', 'bytes', 'sha256']) || file.id !== id || !digest(file.sourceRelativePathSha256)
        || !digest(file.sha256) || !safeInteger(file.bytes) || !new RegExp('^files/' + String(index + 1).padStart(8, '0') + '\\.[a-z0-9]{1,8}$').test(file.archivedPath)
        || paths.has(file.archivedPath) || hashes.has(file.sourceRelativePathSha256)) legacyFail('INVALID_MANIFEST');
    ids.add(file.id); paths.add(file.archivedPath); hashes.add(file.sourceRelativePathSha256); total += file.bytes;
  });
  if (!value.files.length || !safeInteger(value.totalBytes) || total !== value.totalBytes || total > LEGACY_MAX_TOTAL_BYTES) legacyFail('INVALID_MANIFEST');
  const datasetIds = new Set(), referenced = new Set(), missingHashes = new Set();
  for (const dataset of list(value.datasets, 5000)) {
    if (!legacyClosed(dataset, ['id', 'fileIds', 'missingSourcePathSha256', 'sourceRowCount', 'rowCountVerified', 'reportedCoverage', 'range']) || !token(dataset.id)
        || datasetIds.has(dataset.id) || dataset.rowCountVerified !== false || (dataset.sourceRowCount !== null && !safeInteger(dataset.sourceRowCount))
        || !['unknown', 'partial', 'provider-declared-full'].includes(dataset.reportedCoverage)) legacyFail('INVALID_MANIFEST');
    datasetIds.add(dataset.id); exportRange(dataset.range);
    for (const id of list(dataset.fileIds)) { if (!ids.has(id) || referenced.has(id)) legacyFail('INVALID_MANIFEST'); referenced.add(id); }
    const missing = list(dataset.missingSourcePathSha256);
    for (const hash of missing) {
      if (!digest(hash) || hashes.has(hash) || missingHashes.has(hash)) legacyFail('INVALID_MANIFEST');
      missingHashes.add(hash);
    }
  }
  const missingDatasets = tokens(value.missingDatasets), unresolved = tokens(value.unresolved);
  if (missingDatasets.some(id => datasetIds.has(id))) legacyFail('INVALID_MANIFEST');
  const unassigned = list(value.unassignedFileIds);
  if (unassigned.some(id => !ids.has(id) || referenced.has(id)) || new Set(unassigned).size !== unassigned.length
      || referenced.size + unassigned.length !== ids.size) legacyFail('INVALID_MANIFEST');
  if ((!value.datasets.length && !unresolved.includes('dataset-inventory-not-provided'))
      || (unassigned.length && !unresolved.includes('unassigned-source-files'))
      || (value.datasets.some(dataset => dataset.missingSourcePathSha256.length) && !unresolved.includes('declared-source-files-missing'))) legacyFail('INVALID_MANIFEST');
  return value;
}
