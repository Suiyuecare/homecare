import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initDb } from './model.mjs';
import { initPortalStorage } from './portal-handoff.mjs';
import { ProductionBackupError, failProductionBackup } from './production-backup-errors.mjs';

// This validates complete saved storage, not every entity's semantic rules. The
// owner supplies a consistent snapshot transaction; this inspector never starts,
// commits or rolls back that transaction, or initializes the supplied database.
const TABLES = Object.freeze([
  'attachment_files', 'audit', 'certification_attachment_files', 'demo_seeds',
  'idempotency', 'memberships', 'organizations', 'portal_handoff_nonces',
  'portal_identity_bindings', 'record_versions', 'records', 'sessions', 'users',
]);
const BLOB_TABLES = Object.freeze(['attachment_files', 'certification_attachment_files']);
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};
let model;

// Frames include their byte length, so adjacent serialized rows cannot alias.
function frame(hash, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

function schemaDigest(db) {
  const fields = ['type', 'name', 'tbl_name', 'sql'];
  const projection = fields.map(field => 'CASE WHEN ' + quote(field) + ' IS NULL THEN NULL ELSE hex(CAST(' + quote(field) + ' AS BLOB)) END AS ' + quote(field));
  const statement = db.prepare('SELECT ' + projection.join(',') + ' FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY');
  const hash = createHash('sha256');
  let count = 0;
  for (const row of statement.iterate()) { frame(hash, fields.map(field => row[field])); count++; }
  return { count, sha256: hash.digest('hex') };
}

function headers(db) {
  return { userVersion: db.prepare('PRAGMA user_version').get().user_version, applicationId: db.prepare('PRAGMA application_id').get().application_id };
}

function healthyModel() {
  if (model) return model;
  const db = new DatabaseSync(':memory:');
  try {
    initDb(db); initPortalStorage(db);
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name COLLATE BINARY").all().map(row => row.name);
    const triggerCount = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='trigger'").get().count;
    if (JSON.stringify(names) !== JSON.stringify(TABLES) || triggerCount !== 6) failProductionBackup('SCHEMA_MISMATCH');
    const tables = TABLES.map(name => {
      const info = db.prepare('PRAGMA table_info(' + quote(name) + ')').all();
      const columns = info.map(row => row.name);
      const primaryKey = info.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk).map(row => row.name);
      if (!primaryKey.length) failProductionBackup('SCHEMA_MISMATCH');
      return { name, columns, primaryKey };
    });
    model = freeze({ tables, triggerCount, schema: schemaDigest(db), ...headers(db) });
    return model;
  } finally { db.close(); }
}

function typedField(storage, value) {
  if (storage === 'null' && value === null) return ['null'];
  if (storage === 'integer' && typeof value === 'bigint') return ['integer', value.toString(10)];
  if (storage === 'real' && typeof value === 'number') {
    const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value);
    return ['real', bytes.toString('hex')];
  }
  // SQL hex preserves complete TEXT bytes on Node versions which otherwise
  // truncate returned strings at NUL. JSON snapshots remain opaque saved bytes.
  if (storage === 'text' && typeof value === 'string' && /^(?:[0-9A-F]{2})*$/.test(value)) return ['text', value];
  if (storage === 'blob' && value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  failProductionBackup('INTEGRITY_FAILED');
}

function storedBlob(row, columns) {
  const at = name => columns.indexOf(name);
  const sizeIndex = at('size_bytes'), digestIndex = at('sha256'), contentIndex = at('content');
  const size = row['_value_' + sizeIndex], content = row['_value_' + contentIndex];
  if (row['_storage_' + sizeIndex] !== 'integer' || typeof size !== 'bigint' || row['_storage_' + contentIndex] !== 'blob'
      || !(content instanceof Uint8Array) || size !== BigInt(content.byteLength) || row['_storage_' + digestIndex] !== 'text') failProductionBackup('INTEGRITY_FAILED');
  const saved = Buffer.from(row['_value_' + digestIndex], 'hex');
  const digest = Buffer.from(sha(content), 'ascii');
  if (!saved.equals(digest)) failProductionBackup('INTEGRITY_FAILED');
}

function tableDigest(db, table) {
  const { name, columns, primaryKey } = table;
  const projection = columns.flatMap((column, index) => {
    const identifier = quote(column), storage = 'typeof(' + identifier + ')';
    return [storage + ' AS ' + quote('_storage_' + index), 'CASE WHEN ' + storage + "='text' THEN hex(CAST(" + identifier + ' AS BLOB)) ELSE ' + identifier + ' END AS ' + quote('_value_' + index)];
  });
  // These exact healthy-model primary keys use SQLite's BINARY indices. Native
  // ordering retains full TEXT/NUL and storage-class order without expression
  // sorts which could spill plaintext rows to SQLite's system temp storage.
  const order = primaryKey.map(column => quote(column) + ' COLLATE BINARY');
  const statement = db.prepare('SELECT ' + projection.join(',') + ' FROM ' + quote(name) + ' ORDER BY ' + order.join(','));
  statement.setReadBigInts(true);
  const hash = createHash('sha256'), blob = BLOB_TABLES.includes(name) ? createHash('sha256') : null;
  frame(hash, ['columns', name, columns]);
  if (blob) frame(blob, ['columns', name, ['id', 'content']]);
  const primaryIndexes = primaryKey.map(column => columns.indexOf(column));
  let count = 0;
  for (const row of statement.iterate()) {
    if (primaryIndexes.some(index => row['_storage_' + index] === 'null')) failProductionBackup('INTEGRITY_FAILED');
    if (blob) storedBlob(row, columns);
    const fields = columns.map((_column, index) => typedField(row['_storage_' + index], row['_value_' + index]));
    frame(hash, fields);
    if (blob) frame(blob, [fields[columns.indexOf('id')], fields[columns.indexOf('content')]]);
    count++;
    if (!Number.isSafeInteger(count)) failProductionBackup('INTEGRITY_FAILED');
  }
  return { count, sha256: hash.digest('hex'), blobSha256: blob?.digest('hex') };
}

export function inspectProductionDatabase(db) {
  try {
    if (arguments.length !== 1 || !(db instanceof DatabaseSync)) failProductionBackup('OPERATION_FAILED');
    const reference = healthyModel();
    let integrityRows = 0;
    for (const row of db.prepare('PRAGMA integrity_check').iterate()) {
      if (row.integrity_check !== 'ok' || ++integrityRows !== 1) failProductionBackup('INTEGRITY_FAILED');
    }
    if (integrityRows !== 1) failProductionBackup('INTEGRITY_FAILED');
    const schema = schemaDigest(db), header = headers(db);
    if (schema.count !== reference.schema.count || schema.sha256 !== reference.schema.sha256
        || header.userVersion !== reference.userVersion || header.applicationId !== reference.applicationId) failProductionBackup('SCHEMA_MISMATCH');
    for (const _row of db.prepare('PRAGMA foreign_key_check').iterate()) failProductionBackup('FOREIGN_KEY_FAILED');
    if (db.prepare('SELECT 1 FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_versions v WHERE v.record_id=r.id AND v.version=r.version AND v.org_id=r.org_id AND v.entity=r.entity) LIMIT 1').get()) failProductionBackup('HISTORY_INCOMPLETE');
    const tables = {}, blobSha256 = {};
    for (const table of reference.tables) {
      const digest = tableDigest(db, table);
      tables[table.name] = { count: digest.count, sha256: digest.sha256 };
      if (digest.blobSha256) blobSha256[table.name] = digest.blobSha256;
    }
    const content = { tableCount: TABLES.length, triggerCount: reference.triggerCount, ...header, schemaSha256: schema.sha256, tables, blobSha256, versionsSha256: tables.record_versions.sha256 };
    return freeze({ format: 'suiyue-production-sqlite-inspection-v1', ...content, fingerprint: sha(Buffer.from(JSON.stringify(content), 'utf8')) });
  } catch (error) {
    if (error instanceof ProductionBackupError) throw error;
    failProductionBackup('OPERATION_FAILED');
  }
}
