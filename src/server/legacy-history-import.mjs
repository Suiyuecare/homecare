import { isDeepStrictEqual } from 'node:util';
import { audit, fail, entities, validatePayload, now, dateValid } from './model.mjs';
import { guardLegacyOperationalImport } from './legacy-operational-import.mjs';
import { inspectVerifiedLegacyArchive, readVerifiedLegacyFile } from './legacy-migration-archive.mjs';
import { legacyClosed, parseLegacyJson } from './legacy-migration-archive-metadata.mjs';
import { legacyTime } from './legacy-operational-import-format.mjs';
import { LEGACY_HISTORY_FORMAT, LEGACY_HISTORY_MAX_BYTES, LEGACY_HISTORY_MAX_RECORDS,
  LEGACY_HISTORY_BATCH_ENTITY as BATCH, LEGACY_HISTORY_ROW_ENTITY as ROW, LEGACY_HISTORY_FLAGS as FLAGS,
  LEGACY_HISTORY_CATEGORIES, legacyUuid, legacyDigest, historyDenseList, historySources,
  historyUnicode, historyReportingPeriod, legacyHistoryHash, legacyHistoryBatchId, legacyHistoryRowId,
  legacyHistorySelectionSourceHash, normalizeLegacyHistoryPayload } from './legacy-history-format.mjs';
export { LEGACY_HISTORY_FORMAT, LEGACY_HISTORY_MAX_BYTES, LEGACY_HISTORY_MAX_RECORDS, legacyHistorySourceHash,
  legacyHistoryHash, legacyHistoryBatchId, legacyHistoryRowId, normalizeLegacyHistoryPayload } from './legacy-history-format.mjs';

const archives = new WeakMap();
const recordKeys = ['category', 'reportingPeriod', 'sourceNativeId', 'sourceCreatedAt', 'caseId', 'employeeId', 'sourceFileId', 'locator'];
const batchKeys = ['format', 'provider', 'tenant', 'archiveManifestSha256', 'archiveId', 'sourceFiles', 'sourceHash', 'payloadHash',
  'previewHash', 'importedBy', 'importedAt', 'recordOrder', 'selections', 'layouts', 'categories', 'reportingPeriods', 'status', ...Object.keys(FLAGS)];
const rowKeys = ['batchId', 'sourceHash', 'payloadHash', 'sourceFileSha256', 'identityKind', 'layoutIndex', 'record', 'values'];
const invalid = () => fail(409, 'LEGACY_HISTORY_STATE_INVALID', '歷史原始紀錄、來源定位或保存版本無法確認');
const archiveInvalid = () => fail(409, 'LEGACY_HISTORY_ARCHIVE_INVALID', '原檔封存完整性無法確認，整批未保存');
const metadata = item => ({ id: item.id, orgId: item.orgId, version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt });

export function guardLegacyHistoryAccess(db, ctx) { guardLegacyOperationalImport(db, ctx); }
export function createVerifiedLegacyHistorySource(options) {
  try {
    if (!legacyClosed(options, ['archivePath', 'expectedManifestSha256']) || !legacyDigest(options.expectedManifestSha256)) archiveInvalid();
    const { manifest } = inspectVerifiedLegacyArchive(options), capability = Object.freeze({ manifestSha256: options.expectedManifestSha256 });
    archives.set(capability, { ...options, archiveId: manifest.archiveId }); return capability;
  } catch { archiveInvalid(); }
}
function verifySource(capability, payload) {
  try {
    const options = archives.get(capability);
    if (!options || options.expectedManifestSha256 !== payload.archiveManifestSha256) archiveInvalid();
    const { manifest } = inspectVerifiedLegacyArchive({ archivePath: options.archivePath, expectedManifestSha256: options.expectedManifestSha256 });
    if (manifest.archiveId !== options.archiveId || manifest.source.provider !== payload.provider || manifest.source.tenant !== payload.tenant) archiveInvalid();
    for (const file of payload.sourceFiles) {
      const read = readVerifiedLegacyFile({ archivePath: options.archivePath, expectedManifestSha256: options.expectedManifestSha256, fileId: file.fileId, maxBytes: LEGACY_HISTORY_MAX_BYTES });
      try { if (read.file.sha256 !== file.sha256 || read.source.provider !== payload.provider || read.source.tenant !== payload.tenant) archiveInvalid(); }
      finally { read.bytes.fill(0); }
    }
    return manifest.archiveId;
  } catch { archiveInvalid(); }
}
const projection = "id,org_id,entity,version,typeof(version) AS versionType,typeof(data) AS dataType,hex(CAST(data AS BLOB)) AS dataHex,hex(CAST(created_at AS BLOB)) AS createdHex,hex(CAST(updated_at AS BLOB)) AS updatedHex";
function decodeHex(value) {
  if (typeof value !== 'string' || !/^(?:[A-F0-9]{2})*$/.test(value)) invalid();
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'hex'));
}
function jsonHex(value) {
  const bytes = Buffer.from(value, 'hex');
  try { return parseLegacyJson(bytes, LEGACY_HISTORY_MAX_BYTES); } catch { invalid(); } finally { bytes.fill(0); }
}
function stored(db, orgId, entity, identity, required = true) {
  try {
    const row = db.prepare(`SELECT ${projection} FROM records WHERE org_id=? AND entity=? AND id=?`).get(orgId, entity, identity);
    if (!row) { if (required) invalid(); return null; }
    if (!legacyUuid(row.id) || row.org_id !== orgId || row.entity !== entity || row.versionType !== 'integer' || row.dataType !== 'text' || !Number.isSafeInteger(row.version) || row.version < 1) invalid();
    const data = jsonHex(row.dataHex), createdAt = decodeHex(row.createdHex), updatedAt = decodeHex(row.updatedHex);
    if (!legacyClosed(data, Object.keys(data)) || !legacyTime(createdAt) || !legacyTime(updatedAt) || createdAt > updatedAt) invalid();
    const item = { ...data, id: row.id, orgId, version: row.version, createdAt, updatedAt };
    const head = db.prepare("SELECT org_id,entity,version,typeof(snapshot) AS snapshotType,hex(CAST(snapshot AS BLOB)) AS snapshotHex,hex(CAST(created_at AS BLOB)) AS timeHex,hex(CAST(source AS BLOB)) AS sourceHex FROM record_versions WHERE record_id=? AND version=?").get(row.id, row.version);
    if (!head || head.org_id !== orgId || head.entity !== entity || head.snapshotType !== 'text' || decodeHex(head.timeHex) !== updatedAt || !isDeepStrictEqual(jsonHex(head.snapshotHex), item)) invalid();
    const chain = db.prepare("SELECT COUNT(*) AS count,MIN(version) AS first,MAX(version) AS last,SUM(CASE WHEN typeof(version)!='integer' OR org_id!=? OR entity!=? THEN 1 ELSE 0 END) AS invalid FROM record_versions WHERE record_id=?").get(orgId, entity, row.id);
    if (chain.count !== row.version || chain.first !== 1 || chain.last !== row.version || chain.invalid !== 0) invalid();
    if ([BATCH, ROW].includes(entity) && (row.version !== 1 || createdAt !== updatedAt || decodeHex(head.sourceHex) !== (entity === BATCH ? 'legacy.history.batch' : 'legacy.history.row'))) invalid();
    return { row, data, item };
  } catch { invalid(); }
}
function parent(db, orgId, entity, identity, cache) {
  const key = entity + ':' + identity;
  if (cache.has(key)) return cache.get(key);
  const value = stored(db, orgId, entity, identity);
  try {
    const fields = entities[entity].fields.split(' '), number = entity === 'cases' ? 'caseNo' : 'employeeNo', data = value.data;
    if (!legacyClosed(data, ['name', number, 'status'], fields.filter(key => !['name', number, 'status'].includes(key))) || !entities[entity].statuses.includes(data.status)) invalid();
    validatePayload(entity, data);
    if (!historyUnicode(data.name) || !data.name.trim() || data.name.length > 200 || !historyUnicode(data[number]) || !data[number] || data[number] !== data[number].trim() || data[number].length > 200 || /[\u0000-\u001f\u007f]/.test(data[number]) ||
        data.birthDate && !dateValid(data.birthDate) || data.cmsLevel !== undefined && data.cmsLevel !== '' && (data.cmsLevel < 1 || data.cmsLevel > 8) || data.supervisorId && !legacyUuid(data.supervisorId)) invalid();
    if (entity === 'cases' && data.supervisorId) parent(db, orgId, 'employees', data.supervisorId, cache);
    cache.set(key, value); return value;
  } catch { invalid(); }
}
function reference(db, ctx, entity, id, cache) {
  if (id === null) return null;
  const value = parent(db, ctx.orgId, entity, id, cache), number = entity === 'cases' ? 'caseNo' : 'employeeNo';
  return { id: value.item.id, name: value.data.name, [number]: value.data[number], version: value.item.version, status: value.data.status };
}
function rowDto(db, ctx, value, cache, columns = false) {
  const record = value.record;
  return { ...metadata(value.item), batchId: value.data.batchId, category: record.category, reportingPeriod: record.reportingPeriod,
    sourceNativeId: record.sourceNativeId, sourceCreatedAt: record.sourceCreatedAt, caseId: record.caseId, employeeId: record.employeeId,
    sourceFileId: record.sourceFileId, sourceFileSha256: value.data.sourceFileSha256, locator: record.locator, identityKind: 'archive-locator',
    caseReference: reference(db, ctx, 'cases', record.caseId, cache), employeeReference: reference(db, ctx, 'employees', record.employeeId, cache),
    ...(columns ? { columns: record.columns } : {}) };
}
function batchDto(value) {
  const data = value.data;
  return { ...metadata(value.item), provider: data.provider, tenant: data.tenant, sourceHash: data.sourceHash, payloadHash: data.payloadHash,
    archiveManifestSha256: data.archiveManifestSha256, archiveId: data.archiveId, importedBy: data.importedBy, importedAt: data.importedAt,
    rowCount: data.recordOrder.length, categories: data.categories, reportingPeriods: data.reportingPeriods, status: 'historical-original-records', ...FLAGS };
}
function verifyAudit(db, ctx, entity, identity, action, actorId, expected) {
  const rows = db.prepare('SELECT user_id,hex(CAST(detail AS BLOB)) AS detailHex FROM audit WHERE org_id=? AND entity=? AND record_id=? AND action=?').all(ctx.orgId, entity, identity, action);
  if (rows.length !== 1 || rows[0].user_id !== actorId || !isDeepStrictEqual(jsonHex(rows[0].detailHex), expected)) invalid();
}
function batchRowAudits(db, ctx, records) {
  // A request-local, bounded lookup preserves the per-row proof without N
  // scans of the organization's audit history. Never cache across requests.
  const identities = records.map(value => value.item.id);
  if (!identities.length || identities.length > LEGACY_HISTORY_MAX_RECORDS || new Set(identities).size !== identities.length) invalid();
  const rows = db.prepare(`SELECT record_id,user_id,hex(CAST(detail AS BLOB)) AS detailHex FROM audit WHERE org_id=? AND entity=? AND action=? AND record_id IN (${identities.map(() => '?').join(',')}) LIMIT ?`).all(ctx.orgId, ROW, 'record.history-import', ...identities, identities.length + 1);
  if (rows.length !== identities.length) invalid();
  const allowed = new Set(identities), result = new Map();
  for (const row of rows) {
    if (!allowed.has(row.record_id) || result.has(row.record_id)) invalid();
    result.set(row.record_id, row);
  }
  if (result.size !== identities.length) invalid();
  return result;
}
function validLayouts(layouts) {
  historyDenseList(layouts, LEGACY_HISTORY_MAX_RECORDS);
  const unique = new Set();
  if (!layouts.length) invalid();
  for (const layout of layouts) {
    historyDenseList(layout, 500); if (!layout.length) invalid(); const indices = new Set();
    for (const header of layout) {
      if (!legacyClosed(header, ['columnIndex', 'label']) || !Number.isSafeInteger(header.columnIndex) || header.columnIndex < 1 || header.columnIndex > 16384 || indices.has(header.columnIndex) || !historyUnicode(header.label) || header.label.length > 1000) invalid();
      indices.add(header.columnIndex);
    }
    const hash = legacyHistoryHash(layout); if (unique.has(hash)) invalid(); unique.add(hash);
  }
}
function loadMeta(db, ctx, identity, required = true) {
  const batch = stored(db, ctx.orgId, BATCH, identity, required); if (!batch) return null;
  try {
    const data = batch.data;
    if (!legacyClosed(data, batchKeys) || data.format !== LEGACY_HISTORY_FORMAT || !legacyDigest(data.payloadHash) || !legacyDigest(data.previewHash) || !legacyDigest(data.archiveManifestSha256) || !legacyUuid(data.importedBy) || data.importedAt !== batch.item.createdAt ||
        !/^archive-[a-f0-9-]{36}$/.test(data.archiveId) || data.status !== 'historical-original-records' || Object.keys(FLAGS).some(key => data[key] !== false)) invalid();
    historyDenseList(data.recordOrder, LEGACY_HISTORY_MAX_RECORDS); historyDenseList(data.categories, LEGACY_HISTORY_CATEGORIES.length); historyDenseList(data.reportingPeriods, LEGACY_HISTORY_MAX_RECORDS); historyDenseList(data.selections, LEGACY_HISTORY_MAX_RECORDS);
    if (!data.recordOrder.length || new Set(data.recordOrder).size !== data.recordOrder.length || data.recordOrder.some(id => !legacyUuid(id)) || data.selections.length !== data.recordOrder.length || !data.categories.length ||
        !isDeepStrictEqual(data.categories, [...new Set(data.categories)].sort()) || data.categories.some(category => !LEGACY_HISTORY_CATEGORIES.includes(category))) invalid();
    const files = historySources(data.sourceFiles), refs = new Map(files.map(file => [file.fileId, file.sha256]));
    if (!isDeepStrictEqual(files, data.sourceFiles) || legacyHistorySelectionSourceHash({ provider: data.provider, tenant: data.tenant, sourceFiles: files, selections: data.selections }) !== data.sourceHash || identity !== legacyHistoryBatchId(ctx.orgId, data.provider, data.tenant, data.sourceHash)) invalid();
    for (const [index, selection] of data.selections.entries()) if (data.recordOrder[index] !== legacyHistoryRowId(ctx.orgId, data.provider, data.tenant, refs.get(selection.sourceFileId), selection.locator)) invalid();
    if (!isDeepStrictEqual(data.reportingPeriods, [...new Set(data.reportingPeriods)].sort()) || data.reportingPeriods.some(period => !historyReportingPeriod(period))) invalid();
    validLayouts(data.layouts);
    verifyAudit(db, ctx, BATCH, identity, 'batch.legacy-history-import', data.importedBy, { version: 1, sourceHash: data.sourceHash, payloadHash: data.payloadHash, count: data.recordOrder.length, metadataHash: legacyHistoryHash(data) });
    return { batch, dto: batchDto(batch) };
  } catch { invalid(); }
}
function reconstruct(value, meta, index) {
  const data = value.data, batch = meta.batch.data;
  if (!legacyClosed(data, rowKeys) || data.batchId !== meta.dto.id || data.sourceHash !== batch.sourceHash || data.payloadHash !== batch.payloadHash || data.identityKind !== 'archive-locator' || !legacyDigest(data.sourceFileSha256) ||
      !Number.isSafeInteger(data.layoutIndex) || data.layoutIndex < 0 || data.layoutIndex >= batch.layouts.length || !legacyClosed(data.record, recordKeys) || value.item.createdAt !== batch.importedAt) invalid();
  const layout = batch.layouts[data.layoutIndex], values = historyDenseList(data.values, 500);
  if (values.length !== layout.length || value.item.id !== batch.recordOrder[index] || !isDeepStrictEqual({ sourceFileId: data.record.sourceFileId, locator: data.record.locator }, batch.selections[index]) ||
      data.sourceFileSha256 !== batch.sourceFiles.find(file => file.fileId === data.record.sourceFileId)?.sha256) invalid();
  const columns = layout.map((header, i) => {
    const cell = historyDenseList(values[i], 3); if (cell.length !== 3) invalid();
    return { ...header, raw: cell[0], formula: cell[1], cached: cell[2] };
  });
  return { ...data.record, columns };
}
function loadBatch(db, ctx, identity, required = true) {
  const meta = loadMeta(db, ctx, identity, required); if (!meta) return null;
  try {
    const data = meta.batch.data, cache = new Map(), records = data.recordOrder.map((id, index) => {
      const value = stored(db, ctx.orgId, ROW, id); value.record = reconstruct(value, meta, index); return value;
    });
    const payload = normalizeLegacyHistoryPayload({ format: data.format, provider: data.provider, tenant: data.tenant, archiveManifestSha256: data.archiveManifestSha256, sourceFiles: data.sourceFiles, sourceHash: data.sourceHash, records: records.map(value => value.record) });
    if (legacyHistoryHash(payload) !== data.payloadHash || !isDeepStrictEqual([...new Set(payload.records.map(record => record.category))].sort(), data.categories) || !isDeepStrictEqual([...new Set(payload.records.map(record => record.reportingPeriod).filter(period => period !== null))].sort(), data.reportingPeriods) || new Set(records.map(value => value.data.layoutIndex)).size !== data.layouts.length) invalid();
    const count = db.prepare("SELECT COUNT(*) AS count FROM records WHERE org_id=? AND entity=? AND json_extract(data,'$.batchId')=?").get(ctx.orgId, ROW, identity).count;
    if (count !== records.length) invalid();
    const audits = batchRowAudits(db, ctx, records);
    for (const value of records) {
      reference(db, ctx, 'cases', value.record.caseId, cache); reference(db, ctx, 'employees', value.record.employeeId, cache);
      const row = audits.get(value.item.id), expected = { version: 1, batchId: identity, rowId: value.item.id, sourceHash: data.sourceHash, payloadHash: data.payloadHash };
      if (!row || row.user_id !== data.importedBy || !isDeepStrictEqual(jsonHex(row.detailHex), expected)) invalid();
    }
    return { ...meta, records, cache };
  } catch { invalid(); }
}
function storage(payload, orgId, batchId, payloadHash) {
  const layouts = [], indices = new Map(), refs = new Map(payload.sourceFiles.map(file => [file.fileId, file.sha256]));
  const prepared = payload.records.map(record => {
    const layout = record.columns.map(column => ({ columnIndex: column.columnIndex, label: column.label })), key = legacyHistoryHash(layout);
    if (!indices.has(key)) { indices.set(key, layouts.length); layouts.push(layout); }
    const { columns, ...original } = record, sha = refs.get(record.sourceFileId), id = legacyHistoryRowId(orgId, payload.provider, payload.tenant, sha, record.locator);
    return { id, data: { batchId, sourceHash: payload.sourceHash, payloadHash, sourceFileSha256: sha, identityKind: 'archive-locator', layoutIndex: indices.get(key), record: original,
      values: columns.map(column => [column.raw, column.formula, column.cached]) } };
  });
  return { layouts, prepared };
}
function plan(db, ctx, input, capability) {
  guardLegacyHistoryAccess(db, ctx);
  const payload = normalizeLegacyHistoryPayload(input), archiveId = verifySource(capability, payload), payloadHash = legacyHistoryHash(payload), batchId = legacyHistoryBatchId(ctx.orgId, payload.provider, payload.tenant, payload.sourceHash);
  const existing = loadBatch(db, ctx, batchId, false);
  if (existing) {
    if (existing.dto.payloadHash !== payloadHash) fail(409, 'LEGACY_HISTORY_SOURCE_CONFLICT', '同一原檔定位集合已有不同內容，不能覆寫');
    return { payload, archiveId, payloadHash, batchId, existing, previewHash: existing.batch.data.previewHash };
  }
  if (db.prepare('SELECT 1 FROM records WHERE id=?').get(batchId)) fail(409, 'LEGACY_HISTORY_EXISTING', '歷史原始紀錄識別已有資料，整批未保存');
  const cache = new Map(), values = storage(payload, ctx.orgId, batchId, payloadHash);
  for (const value of values.prepared) if (db.prepare('SELECT 1 FROM records WHERE id=?').get(value.id)) fail(409, 'LEGACY_HISTORY_EXISTING', '同一原檔定位已保存，不得重複分類或建立另一歷史原列');
  for (const record of payload.records) { reference(db, ctx, 'cases', record.caseId, cache); reference(db, ctx, 'employees', record.employeeId, cache); }
  const member = db.prepare('SELECT role,employee_id FROM memberships WHERE org_id=? AND user_id=?').get(ctx.orgId, ctx.user.id);
  const lifecycle = db.prepare("SELECT id,version,hex(CAST(data AS BLOB)) AS dataHex FROM records WHERE org_id=? AND entity='account-lifecycle' ORDER BY id").all(ctx.orgId);
  const parents = [...cache.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, item: value.item }));
  const previewHash = legacyHistoryHash({ sourceHash: payload.sourceHash, payloadHash, archiveId, orgId: ctx.orgId, actorId: ctx.user.id, member, lifecycle, parents });
  return { payload, archiveId, payloadHash, batchId, previewHash, ...values };
}
export function previewLegacyHistoryImport(db, ctx, payload, capability) {
  const value = plan(db, ctx, payload, capability);
  const estimate = value.existing ? undefined : storageEstimate(value, ctx);
  return { orgId: ctx.orgId, ready: true, batchId: value.batchId, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, previewHash: value.previewHash,
    rowCount: value.payload.records.length, categories: [...new Set(value.payload.records.map(record => record.category))].sort(), alreadyImported: Boolean(value.existing), ...(estimate ? { storageEstimate: estimate } : {}), ...FLAGS };
}
function batchData(value, ctx, stamp) {
  return { format: LEGACY_HISTORY_FORMAT, provider: value.payload.provider, tenant: value.payload.tenant,
    archiveManifestSha256: value.payload.archiveManifestSha256, archiveId: value.archiveId, sourceFiles: value.payload.sourceFiles,
    sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, previewHash: value.previewHash, importedBy: ctx.user.id, importedAt: stamp,
    recordOrder: value.prepared.map(row => row.id), selections: value.payload.records.map(record => ({ sourceFileId: record.sourceFileId, locator: record.locator })),
    layouts: value.layouts, categories: [...new Set(value.payload.records.map(record => record.category))].sort(), reportingPeriods: [...new Set(value.payload.records.map(record => record.reportingPeriod).filter(period => period !== null))].sort(), status: 'historical-original-records', ...FLAGS };
}
function storageEstimate(value, ctx) {
  // Exact UTF8 bytes of JSON columns planned for records/version/audit. This
  // deliberately excludes SQLite pages, indexes, WAL, backups and raw archive.
  const stamp = '2000-01-01T00:00:00.000Z', batch = batchData(value, ctx, stamp);
  const jsonBytes = data => Buffer.byteLength(JSON.stringify(data));
  const versionBytes = (data, id) => jsonBytes({ ...data, id, orgId: ctx.orgId, version: 1, createdAt: stamp, updatedAt: stamp });
  let bytes = jsonBytes(batch) + versionBytes(batch, value.batchId) + jsonBytes({ version: 1, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, count: value.prepared.length, metadataHash: legacyHistoryHash(batch) });
  for (const row of value.prepared) bytes += jsonBytes(row.data) + versionBytes(row.data, row.id) + jsonBytes({ version: 1, batchId: value.batchId, rowId: row.id, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash });
  return { kind: 'stored-json-columns-only', bytes, layoutCount: value.layouts.length };
}
function save(db, ctx, entity, identity, data, stamp, source) {
  const item = { ...data, id: identity, orgId: ctx.orgId, version: 1, createdAt: stamp, updatedAt: stamp };
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(identity, ctx.orgId, entity, JSON.stringify(data), 1, stamp, stamp);
  db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(ctx.orgId, entity, identity, 1, JSON.stringify(item), stamp, source);
}
function receipt(verified, replayed) {
  return { batchId: verified.dto.id, orgId: verified.dto.orgId, sourceHash: verified.dto.sourceHash, payloadHash: verified.dto.payloadHash,
    rowCount: verified.dto.rowCount, categories: verified.dto.categories, replayed, mode: 'historical-original-records', ...FLAGS };
}
export function commitLegacyHistoryImport(db, ctx, payload, capability, previewHash) {
  guardLegacyHistoryAccess(db, ctx);
  if (!legacyDigest(previewHash)) fail(422, 'LEGACY_HISTORY_PREVIEW_REQUIRED', '保存須提供完整預覽識別');
  if (db.isTransaction) fail(409, 'LEGACY_HISTORY_TRANSACTION_ACTIVE', '歷史保存須使用獨立完整交易');
  try {
    db.exec('BEGIN IMMEDIATE'); const value = plan(db, ctx, payload, capability);
    if (value.previewHash !== previewHash) fail(409, 'LEGACY_HISTORY_PREVIEW_STALE', '來源、目前關聯或權限已改變，請重新預覽');
    if (value.existing) { db.exec('COMMIT'); return receipt(value.existing, true); }
    const stamp = now(), batch = batchData(value, ctx, stamp);
    save(db, ctx, BATCH, value.batchId, batch, stamp, 'legacy.history.batch');
    for (const row of value.prepared) {
      save(db, ctx, ROW, row.id, row.data, stamp, 'legacy.history.row');
      audit(db, ctx, 'record.history-import', ROW, row.id, { version: 1, batchId: value.batchId, rowId: row.id, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash });
    }
    audit(db, ctx, 'batch.legacy-history-import', BATCH, value.batchId, { version: 1, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, count: value.prepared.length, metadataHash: legacyHistoryHash(batch) });
    verifySource(capability, value.payload); guardLegacyHistoryAccess(db, ctx);
    const verified = loadBatch(db, ctx, value.batchId); db.exec('COMMIT'); return receipt(verified, false);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (error && Number.isInteger(error.status) && typeof error.code === 'string' && (error.code.startsWith('LEGACY_HISTORY_') || ['ROLE_FORBIDDEN', 'ACCOUNT_STATE_INVALID'].includes(error.code))) throw error;
    fail(500, 'LEGACY_HISTORY_FAILED', '歷史原始紀錄未完整保存，整批交易已撤回');
  }
}
function pagination(query) {
  if (!legacyClosed(query, ['page', 'pageSize']) || !Number.isSafeInteger(query.page) || query.page < 1 || !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100 || !Number.isSafeInteger((query.page - 1) * query.pageSize) || !Number.isSafeInteger(query.page * query.pageSize)) fail(422, 'LEGACY_HISTORY_QUERY_INVALID', '分頁須為正整數，pageSize介於1至100');
}
export function listLegacyHistoryBatches(db, ctx, query = { page: 1, pageSize: 25 }) {
  guardLegacyHistoryAccess(db, ctx); pagination(query);
  const total = db.prepare('SELECT COUNT(*) AS count FROM records WHERE org_id=? AND entity=?').get(ctx.orgId, BATCH).count;
  const items = db.prepare('SELECT id FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(ctx.orgId, BATCH, query.pageSize, (query.page - 1) * query.pageSize).map(row => loadMeta(db, ctx, row.id).dto);
  return { orgId: ctx.orgId, items, total, page: query.page, pageSize: query.pageSize, ...FLAGS };
}
export function readLegacyHistoryBatch(db, ctx, identity, query = { page: 1, pageSize: 25 }) {
  guardLegacyHistoryAccess(db, ctx); pagination(query);
  if (!legacyUuid(identity) || !db.prepare('SELECT 1 FROM records WHERE org_id=? AND entity=? AND id=?').get(ctx.orgId, BATCH, identity)) fail(404, 'NOT_FOUND', '找不到本機構歷史保存批次');
  const value = loadBatch(db, ctx, identity);
  return { orgId: ctx.orgId, item: value.dto, records: value.records.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(row => rowDto(db, ctx, row, value.cache)), total: value.records.length, page: query.page, pageSize: query.pageSize, ...FLAGS };
}
export function readLegacyHistoryRow(db, ctx, identity) {
  guardLegacyHistoryAccess(db, ctx);
  if (!legacyUuid(identity) || !db.prepare('SELECT 1 FROM records WHERE org_id=? AND entity=? AND id=?').get(ctx.orgId, ROW, identity)) fail(404, 'NOT_FOUND', '找不到本機構歷史原始列');
  const row = stored(db, ctx.orgId, ROW, identity); if (!legacyClosed(row.data, rowKeys)) invalid();
  const value = loadBatch(db, ctx, row.data.batchId), verified = value.records.find(item => item.item.id === identity); if (!verified) invalid();
  return { orgId: ctx.orgId, item: rowDto(db, ctx, verified, value.cache, true), batch: value.dto, ...FLAGS };
}
