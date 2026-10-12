import { isDeepStrictEqual } from 'node:util';
import { audit, fail, entities, validatePayload, validate, now, dateValid } from './model.mjs';
import { guardAccountAdministration } from './account-administration.mjs';
import { inspectVerifiedLegacyArchive, readVerifiedLegacyFile } from './legacy-migration-archive.mjs';
import { legacyClosed, parseLegacyJson } from './legacy-migration-archive-metadata.mjs';
import { LEGACY_OPERATIONAL_FORMAT, LEGACY_OPERATIONAL_MAX_BYTES, LEGACY_OPERATIONAL_MAX_RECORDS, LEGACY_OPERATIONAL_BATCH_ENTITY as BATCH,
  LEGACY_OPERATIONAL_SOURCE_ENTITY as SOURCE, legacyUuid, legacyDigest, legacyTime, legacyDenseList, legacyOperationalHash, legacyOperationalId,
  legacyOperationalSourceHash, legacyDerivedBusinessNo, normalizeLegacyOperationalPayload } from './legacy-operational-import-format.mjs';
export { LEGACY_OPERATIONAL_FORMAT, LEGACY_OPERATIONAL_MAX_BYTES, legacyOperationalSourceHash, legacyDerivedBusinessNo, legacyOperationalId } from './legacy-operational-import-format.mjs';

const archives = new WeakMap();
const batchKeys = ['format', 'provider', 'tenant', 'archiveManifestSha256', 'archiveId', 'sourceFiles', 'sourceHash', 'payloadHash', 'previewHash', 'importedBy', 'importedAt', 'recordOrder', 'sourceSystemComplete', 'operationalImportCompleted', 'status'];
const mappingKeys = ['batchId', 'sourceHash', 'payloadHash', 'targetId', 'record'];
const stateInvalid = () => fail(409, 'LEGACY_IMPORT_STATE_INVALID', '移轉紀錄、父子連結或保存版本無法確認');
const archiveInvalid = () => fail(409, 'LEGACY_IMPORT_ARCHIVE_INVALID', '封存來源完整性無法確認，整批未保存');
const metadata = item => ({ id: item.id, orgId: item.orgId, version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt });

export function guardLegacyOperationalImport(db, ctx) {
  if (!ctx || !legacyUuid(ctx.orgId) || !ctx.user || !legacyUuid(ctx.user.id) || ctx.role !== 'admin') fail(403, 'ROLE_FORBIDDEN', '僅本機構有效管理者可讀取或操作移轉資料');
  const actor = db.prepare('SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.org_id WHERE u.id=? AND m.org_id=? AND m.role=?').get(ctx.user.id, ctx.orgId, 'admin');
  if (!actor) fail(403, 'ROLE_FORBIDDEN', '僅本機構有效管理者可讀取或操作移轉資料');
  guardAccountAdministration(db, ctx);
}
export function createVerifiedLegacyImportSource(options) {
  try {
    if (!legacyClosed(options, ['archivePath', 'expectedManifestSha256']) || !legacyDigest(options.expectedManifestSha256)) archiveInvalid();
    const verified = inspectVerifiedLegacyArchive(options);
    const capability = Object.freeze({ manifestSha256: options.expectedManifestSha256 });
    archives.set(capability, { ...options, archiveId: verified.manifest.archiveId });
    return capability;
  } catch { archiveInvalid(); }
}
function verifySource(capability, payload) {
  try {
    const options = archives.get(capability);
    if (!options || options.expectedManifestSha256 !== payload.archiveManifestSha256) archiveInvalid();
    const verified = inspectVerifiedLegacyArchive({ archivePath: options.archivePath, expectedManifestSha256: options.expectedManifestSha256 });
    if (verified.manifest.archiveId !== options.archiveId || verified.manifest.source.provider !== payload.provider || verified.manifest.source.tenant !== payload.tenant) archiveInvalid();
    for (const file of payload.sourceFiles) {
      const read = readVerifiedLegacyFile({ archivePath: options.archivePath, expectedManifestSha256: options.expectedManifestSha256, fileId: file.fileId, maxBytes: LEGACY_OPERATIONAL_MAX_BYTES });
      try { if (read.file.sha256 !== file.sha256 || read.source.provider !== payload.provider || read.source.tenant !== payload.tenant) archiveInvalid(); }
      finally { read.bytes.fill(0); }
    }
    return verified.manifest.archiveId;
  } catch { archiveInvalid(); }
}
const projection = "id,org_id,entity,version,typeof(version) AS versionType,typeof(data) AS dataType,hex(CAST(data AS BLOB)) AS dataHex,hex(CAST(created_at AS BLOB)) AS createdHex,hex(CAST(updated_at AS BLOB)) AS updatedHex";
function decodeHex(value) { if (typeof value !== 'string' || !/^(?:[A-F0-9]{2})*$/.test(value)) stateInvalid(); return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'hex')); }
function jsonHex(value) {
  const bytes = Buffer.from(value, 'hex');
  try { return parseLegacyJson(bytes, LEGACY_OPERATIONAL_MAX_BYTES); } catch { stateInvalid(); } finally { bytes.fill(0); }
}
function stored(db, orgId, entity, identity, required = true) {
  try {
    const row = db.prepare(`SELECT ${projection} FROM records WHERE org_id=? AND entity=? AND id=?`).get(orgId, entity, identity);
    if (!row) { if (required) stateInvalid(); return null; }
    if (!legacyUuid(row.id) || row.org_id !== orgId || row.entity !== entity || row.versionType !== 'integer' || row.dataType !== 'text' || !Number.isSafeInteger(row.version) || row.version < 1) stateInvalid();
    const data = jsonHex(row.dataHex), createdAt = decodeHex(row.createdHex), updatedAt = decodeHex(row.updatedHex);
    if (!legacyClosed(data, Object.keys(data)) || !legacyTime(createdAt) || !legacyTime(updatedAt) || createdAt > updatedAt) stateInvalid();
    const item = { ...data, id: row.id, orgId, version: row.version, createdAt, updatedAt };
    const head = db.prepare("SELECT org_id,entity,version,typeof(snapshot) AS snapshotType,hex(CAST(snapshot AS BLOB)) AS snapshotHex,hex(CAST(created_at AS BLOB)) AS timeHex,hex(CAST(source AS BLOB)) AS sourceHex FROM record_versions WHERE record_id=? AND version=?").get(row.id, row.version);
    if (!head || head.org_id !== orgId || head.entity !== entity || head.snapshotType !== 'text' || decodeHex(head.timeHex) !== updatedAt || !isDeepStrictEqual(jsonHex(head.snapshotHex), item)) stateInvalid();
    const chain = db.prepare("SELECT COUNT(*) AS count,MIN(version) AS first,MAX(version) AS last,SUM(CASE WHEN typeof(version)!='integer' OR org_id!=? OR entity!=? THEN 1 ELSE 0 END) AS invalid FROM record_versions WHERE record_id=?").get(orgId, entity, row.id);
    if (chain.count !== row.version || chain.first !== 1 || chain.last !== row.version || chain.invalid !== 0) stateInvalid();
    if ([BATCH, SOURCE].includes(entity) && (row.version !== 1 || createdAt !== updatedAt || decodeHex(head.sourceHex) !== (entity === BATCH ? 'legacy.import.batch' : 'legacy.import.source'))) stateInvalid();
    return { row, data, item };
  } catch (error) { if (error?.code === 'LEGACY_IMPORT_STATE_INVALID') throw error; stateInvalid(); }
}
function operationalRecord(db, orgId, entity, identity) {
  const value = stored(db, orgId, entity, identity);
  try {
    const keys = entities[entity].fields.split(' ');
    if (!legacyClosed(value.data, ['name', entity === 'cases' ? 'caseNo' : 'employeeNo', 'status'], keys.filter(key => !['name', 'caseNo', 'employeeNo', 'status'].includes(key))) || !entities[entity].statuses.includes(value.data.status)) stateInvalid();
    validatePayload(entity, value.data);
    const key = entity === 'cases' ? 'caseNo' : 'employeeNo', data = value.data;
    if (!data.name.trim() || !data[key] || data[key] !== data[key].trim() || data[key].length > 200 || /[\u0000-\u001f\u007f]/.test(data[key]) ||
        data.birthDate && !dateValid(data.birthDate) || data.cmsLevel !== undefined && data.cmsLevel !== '' && (data.cmsLevel < 1 || data.cmsLevel > 8) || data.supervisorId && !legacyUuid(data.supervisorId)) stateInvalid();
    // An administrative history read permits an inactive employee, but never
    // an absent, foreign, differently typed or unverifiable current parent.
    if (entity === 'cases' && data.supervisorId) operationalRecord(db, orgId, 'employees', data.supervisorId);
  } catch { stateInvalid(); }
  return value;
}
function current(db, ctx) {
  try {
    const result = [];
    for (const row of db.prepare("SELECT id,entity FROM records WHERE org_id=? AND entity IN ('cases','employees') ORDER BY entity,id").iterate(ctx.orgId)) {
      if (result.length >= 200000) stateInvalid();
      const value = operationalRecord(db, ctx.orgId, row.entity, row.id); result.push({ entity: row.entity, item: value.item });
    }
    return result;
  } catch { stateInvalid(); }
}
function mappingDto(value) {
  const record = value.data.record;
  return { ...metadata(value.item), batchId: value.data.batchId, entity: record.entity, sourceId: record.sourceId, targetId: value.data.targetId,
    name: record.data.name, businessNo: record.data[record.entity === 'cases' ? 'caseNo' : 'employeeNo'], businessNoOrigin: record.businessNoOrigin,
    sourceCreatedAt: record.sourceCreatedAt, sourceFileId: record.sourceFileId, rowNumber: record.rowNumber };
}
function batchDto(value, records) {
  const data = value.data;
  return { ...metadata(value.item), provider: data.provider, tenant: data.tenant, sourceHash: data.sourceHash, payloadHash: data.payloadHash,
    archiveManifestSha256: data.archiveManifestSha256, archiveId: data.archiveId, importedBy: data.importedBy, importedAt: data.importedAt,
    importedCount: records.length, caseCount: records.filter(record => record.data.record.entity === 'cases').length,
    employeeCount: records.filter(record => record.data.record.entity === 'employees').length, status: data.status, sourceSystemComplete: false, operationalImportCompleted: true };
}
function loadBatch(db, ctx, identity, required = true) {
  const batch = stored(db, ctx.orgId, BATCH, identity, required);
  if (!batch) return null;
  try {
    const data = batch.data;
    if (!legacyClosed(data, batchKeys) || data.format !== LEGACY_OPERATIONAL_FORMAT || !legacyDigest(data.payloadHash) || !legacyDigest(data.previewHash) || !legacyUuid(data.importedBy) || data.importedAt !== batch.item.createdAt ||
        !/^archive-[a-f0-9-]{36}$/.test(data.archiveId) || data.sourceSystemComplete !== false || data.operationalImportCompleted !== true || data.status !== 'operational-first-slice') stateInvalid();
    legacyDenseList(data.recordOrder, LEGACY_OPERATIONAL_MAX_RECORDS);
    if (!data.recordOrder.length || new Set(data.recordOrder).size !== data.recordOrder.length || data.recordOrder.some(id => !legacyUuid(id))) stateInvalid();
    const records = data.recordOrder.map(id => stored(db, ctx.orgId, SOURCE, id));
    const payload = normalizeLegacyOperationalPayload({ format: data.format, provider: data.provider, tenant: data.tenant, archiveManifestSha256: data.archiveManifestSha256, sourceFiles: data.sourceFiles, sourceHash: data.sourceHash, records: records.map(record => record.data.record) });
    if (legacyOperationalHash(payload) !== data.payloadHash || identity !== legacyOperationalId(ctx.orgId, data.provider, data.tenant, 'batch', data.sourceHash, 'batch')) stateInvalid();
    const expectedCount = db.prepare('SELECT COUNT(*) AS count FROM records WHERE org_id=? AND entity=? AND json_extract(data,\'$.batchId\')=?').get(ctx.orgId, SOURCE, identity).count;
    if (expectedCount !== records.length) stateInvalid();
    for (const value of records) {
      const source = value.data, record = source.record;
      if (!legacyClosed(source, mappingKeys) || source.batchId !== identity || source.sourceHash !== data.sourceHash || source.payloadHash !== data.payloadHash || value.item.createdAt !== data.importedAt ||
          value.item.id !== legacyOperationalId(ctx.orgId, data.provider, data.tenant, record.entity, record.sourceId, 'mapping') || source.targetId !== legacyOperationalId(ctx.orgId, data.provider, data.tenant, record.entity, record.sourceId)) stateInvalid();
      operationalRecord(db, ctx.orgId, record.entity, source.targetId);
      const first = db.prepare("SELECT org_id,entity,typeof(snapshot) AS snapshotType,hex(CAST(snapshot AS BLOB)) AS snapshotHex,hex(CAST(created_at AS BLOB)) AS timeHex,hex(CAST(source AS BLOB)) AS sourceHex FROM record_versions WHERE record_id=? AND version=1").get(source.targetId);
      const original = { ...record.data, id: source.targetId, orgId: ctx.orgId, version: 1, createdAt: data.importedAt, updatedAt: data.importedAt };
      if (!first || first.org_id !== ctx.orgId || first.entity !== record.entity || first.snapshotType !== 'text' || decodeHex(first.timeHex) !== data.importedAt || decodeHex(first.sourceHex) !== 'legacy.operational.import' || !isDeepStrictEqual(jsonHex(first.snapshotHex), original)) stateInvalid();
      const audits = db.prepare("SELECT user_id,hex(CAST(detail AS BLOB)) AS detailHex FROM audit WHERE org_id=? AND entity=? AND record_id=? AND action='record.import'").all(ctx.orgId, record.entity, source.targetId);
      if (audits.length !== 1 || audits[0].user_id !== data.importedBy || !isDeepStrictEqual(jsonHex(audits[0].detailHex), { version: 1, batchId: identity, mappingId: value.item.id, sourceHash: data.sourceHash, payloadHash: data.payloadHash })) stateInvalid();
    }
    return { batch, records, dto: batchDto(batch, records) };
  } catch { stateInvalid(); }
}
function receipt(verified, replayed) {
  return { batchId: verified.dto.id, orgId: verified.dto.orgId, sourceHash: verified.dto.sourceHash, payloadHash: verified.dto.payloadHash,
    importedCount: verified.dto.importedCount, caseCount: verified.dto.caseCount, employeeCount: verified.dto.employeeCount,
    replayed, mode: 'operational-first-slice', sourceSystemComplete: false, operationalImportCompleted: true };
}
function plan(db, ctx, input, capability) {
  guardLegacyOperationalImport(db, ctx);
  const payload = normalizeLegacyOperationalPayload(input), archiveId = verifySource(capability, payload), payloadHash = legacyOperationalHash(payload);
  const batchId = legacyOperationalId(ctx.orgId, payload.provider, payload.tenant, 'batch', payload.sourceHash, 'batch');
  const existing = loadBatch(db, ctx, batchId, false);
  if (existing) {
    if (existing.dto.payloadHash !== payloadHash) fail(409, 'LEGACY_IMPORT_SOURCE_CONFLICT', '同一封存來源已有不同內容，不能覆寫或重送新的內容');
    return { payload, payloadHash, archiveId, batchId, existing, previewHash: existing.batch.data.previewHash };
  }
  const snapshot = current(db, ctx), usedNumbers = new Set(snapshot.map(value => value.entity + ':' + value.item[value.entity === 'cases' ? 'caseNo' : 'employeeNo']));
  const prepared = payload.records.map(record => ({ record, targetId: legacyOperationalId(ctx.orgId, payload.provider, payload.tenant, record.entity, record.sourceId), mappingId: legacyOperationalId(ctx.orgId, payload.provider, payload.tenant, record.entity, record.sourceId, 'mapping') }));
  const employeeIds = new Set([...snapshot.filter(value => value.entity === 'employees').map(value => value.item.id), ...prepared.filter(value => value.record.entity === 'employees').map(value => value.targetId)]);
  for (const [index, value] of prepared.entries()) {
    const record = value.record, key = record.entity === 'cases' ? 'caseNo' : 'employeeNo';
    if (usedNumbers.has(record.entity + ':' + record.data[key]) || db.prepare('SELECT 1 FROM records WHERE id IN (?,?)').get(value.targetId, value.mappingId)) fail(409, 'LEGACY_IMPORT_EXISTING', '來源身分或業務編號已有資料，不能覆寫既有主檔');
    if (record.data.supervisorId && !employeeIds.has(record.data.supervisorId)) fail(422, 'LEGACY_IMPORT_REFERENCE', '督導連結須為同機構既有或本批明確員工');
    try { validate(db, ctx, record.entity, record.data.supervisorId ? { ...record.data, supervisorId: '' } : record.data); } catch { fail(422, 'LEGACY_IMPORT_TARGET_INVALID', '主檔欄位或關聯未通過目前系統檢核', { recordIndex: index + 1 }); }
  }
  const member = db.prepare('SELECT role,employee_id FROM memberships WHERE org_id=? AND user_id=?').get(ctx.orgId, ctx.user.id);
  const lifecycle = db.prepare("SELECT id,version,hex(CAST(data AS BLOB)) AS dataHex FROM records WHERE org_id=? AND entity='account-lifecycle' ORDER BY id").all(ctx.orgId);
  const previewHash = legacyOperationalHash({ sourceHash: payload.sourceHash, payloadHash, orgId: ctx.orgId, actorId: ctx.user.id, member, lifecycle, snapshot });
  return { payload, payloadHash, archiveId, batchId, prepared, previewHash };
}
export function previewLegacyOperationalImport(db, ctx, payload, capability) {
  const value = plan(db, ctx, payload, capability);
  return { orgId: ctx.orgId, ready: true, batchId: value.batchId, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, previewHash: value.previewHash,
    totalCount: value.payload.records.length, caseCount: value.payload.records.filter(record => record.entity === 'cases').length,
    employeeCount: value.payload.records.filter(record => record.entity === 'employees').length, alreadyImported: Boolean(value.existing), sourceSystemComplete: false, operationalImportCompleted: Boolean(value.existing) };
}
function save(db, orgId, entity, identity, data, timestamp, source) {
  const item = { ...data, id: identity, orgId, version: 1, createdAt: timestamp, updatedAt: timestamp };
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(identity, orgId, entity, JSON.stringify(data), 1, timestamp, timestamp);
  db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, identity, 1, JSON.stringify(item), timestamp, source);
}
export function commitLegacyOperationalImport(db, ctx, payload, capability, previewHash) {
  guardLegacyOperationalImport(db, ctx);
  if (!legacyDigest(previewHash)) fail(422, 'LEGACY_IMPORT_PREVIEW_REQUIRED', '正式匯入須提供完整預覽識別');
  if (db.isTransaction) fail(409, 'LEGACY_IMPORT_TRANSACTION_ACTIVE', '移轉須使用獨立完整交易');
  try {
    db.exec('BEGIN IMMEDIATE');
    const value = plan(db, ctx, payload, capability);
    if (value.previewHash !== previewHash) fail(409, 'LEGACY_IMPORT_PREVIEW_STALE', '來源、權限或主檔已改變，請重新預覽');
    if (value.existing) { db.exec('COMMIT'); return receipt(value.existing, true); }
    const stamp = now();
    const batch = { format: LEGACY_OPERATIONAL_FORMAT, provider: value.payload.provider, tenant: value.payload.tenant,
      archiveManifestSha256: value.payload.archiveManifestSha256, archiveId: value.archiveId, sourceFiles: value.payload.sourceFiles,
      sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, previewHash: value.previewHash, importedBy: ctx.user.id, importedAt: stamp,
      recordOrder: value.prepared.map(item => item.mappingId), sourceSystemComplete: false, operationalImportCompleted: true, status: 'operational-first-slice' };
    save(db, ctx.orgId, BATCH, value.batchId, batch, stamp, 'legacy.import.batch');
    for (const item of value.prepared) {
      save(db, ctx.orgId, item.record.entity, item.targetId, item.record.data, stamp, 'legacy.operational.import');
      save(db, ctx.orgId, SOURCE, item.mappingId, { batchId: value.batchId, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, targetId: item.targetId, record: item.record }, stamp, 'legacy.import.source');
      audit(db, ctx, 'record.import', item.record.entity, item.targetId, { version: 1, batchId: value.batchId, mappingId: item.mappingId, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash });
    }
    audit(db, ctx, 'batch.legacy-import', BATCH, value.batchId, { version: 1, sourceHash: value.payload.sourceHash, payloadHash: value.payloadHash, count: value.prepared.length });
    verifySource(capability, value.payload);
    const verified = loadBatch(db, ctx, value.batchId);
    db.exec('COMMIT'); return receipt(verified, false);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (error && Number.isInteger(error.status) && typeof error.code === 'string' && (error.code.startsWith('LEGACY_IMPORT_') || error.code === 'ROLE_FORBIDDEN' || error.code === 'ACCOUNT_STATE_INVALID')) throw error;
    fail(500, 'LEGACY_IMPORT_FAILED', '移轉未完整保存；整批交易已撤回，請核對私人操作紀錄');
  }
}
function pagination(query) {
  if (!legacyClosed(query, ['page', 'pageSize']) || !Number.isSafeInteger(query.page) || query.page < 1 || !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100 || !Number.isSafeInteger((query.page - 1) * query.pageSize) || !Number.isSafeInteger(query.page * query.pageSize)) fail(422, 'LEGACY_IMPORT_QUERY_INVALID', '分頁須為正整數，pageSize介於1至100');
  return query;
}
export function listLegacyImportBatches(db, ctx, query = { page: 1, pageSize: 25 }) {
  guardLegacyOperationalImport(db, ctx); pagination(query);
  const items = db.prepare('SELECT id FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id').all(ctx.orgId, BATCH).map(row => loadBatch(db, ctx, row.id).dto);
  return { orgId: ctx.orgId, items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize, sourceSystemComplete: false };
}
export function readLegacyImportBatch(db, ctx, identity, query = { page: 1, pageSize: 25 }) {
  guardLegacyOperationalImport(db, ctx); pagination(query);
  if (!legacyUuid(identity) || !db.prepare('SELECT 1 FROM records WHERE org_id=? AND entity=? AND id=?').get(ctx.orgId, BATCH, identity)) fail(404, 'NOT_FOUND', '找不到本機構移轉批次');
  const verified = loadBatch(db, ctx, identity);
  return { orgId: ctx.orgId, item: verified.dto, records: verified.records.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(mappingDto),
    total: verified.records.length, page: query.page, pageSize: query.pageSize, sourceSystemComplete: false };
}
export function readLegacyImportedSource(db, ctx, identity) {
  guardLegacyOperationalImport(db, ctx);
  if (!legacyUuid(identity) || !db.prepare('SELECT 1 FROM records WHERE org_id=? AND entity=? AND id=?').get(ctx.orgId, SOURCE, identity)) fail(404, 'NOT_FOUND', '找不到本機構移轉來源');
  const value = stored(db, ctx.orgId, SOURCE, identity);
  if (!legacyClosed(value.data, mappingKeys)) stateInvalid();
  const verified = loadBatch(db, ctx, value.data.batchId), index = verified.records.findIndex(record => record.item.id === identity);
  if (index < 0) stateInvalid();
  const source = verified.records[index], target = operationalRecord(db, ctx.orgId, source.data.record.entity, source.data.targetId);
  return { orgId: ctx.orgId, item: { ...mappingDto(source), data: source.data.record.data, columns: source.data.record.columns }, batch: verified.dto, currentTarget: target.item, sourceSystemComplete: false };
}
