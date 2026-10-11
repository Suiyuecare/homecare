import { accessSync, constants, lstatSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { normalizePortalConfig } from './portal-handoff.mjs';

// A probe is observational. It does not initialize schema, checkpoint the WAL,
// create a file, test an INSERT, or return configuration or business rows.
const BASE_TABLES = Object.freeze({
  organizations: ['id', 'name', 'created_at'],
  users: ['id', 'name', 'email', 'password_hash', 'created_at'],
  memberships: ['org_id', 'user_id', 'role', 'employee_id'],
  sessions: ['token_hash', 'user_id', 'csrf', 'expires_at'],
  records: ['id', 'org_id', 'entity', 'data', 'version', 'created_at', 'updated_at'],
  record_versions: ['org_id', 'entity', 'record_id', 'version', 'snapshot', 'created_at', 'source'],
  audit: ['id', 'org_id', 'user_id', 'action', 'entity', 'record_id', 'detail', 'created_at'],
  idempotency: ['org_id', 'user_id', 'key', 'route', 'hash', 'response', 'status', 'created_at'],
  demo_seeds: ['org_id', 'created_at'],
  attachment_files: ['id', 'org_id', 'attachment_id', 'case_id', 'file_name', 'mime_type', 'size_bytes', 'sha256', 'content', 'created_at'],
  certification_attachment_files: ['id', 'org_id', 'attachment_id', 'certification_id', 'employee_id', 'file_name', 'mime_type', 'size_bytes', 'sha256', 'content', 'created_at'],
});
const PORTAL_TABLES = Object.freeze({
  portal_identity_bindings: ['issuer', 'google_subject', 'portal_auth_user_id', 'email', 'user_id', 'org_id', 'active', 'created_at'],
  portal_handoff_nonces: ['jti', 'issuer', 'user_id', 'org_id', 'consumed_at', 'expires_at'],
});
const TRIGGERS = Object.freeze({
  versions_no_update: 'record_versions', versions_no_delete: 'record_versions',
  attachment_files_no_update: 'attachment_files', attachment_files_no_delete: 'attachment_files',
  certification_attachment_files_no_update: 'certification_attachment_files', certification_attachment_files_no_delete: 'certification_attachment_files',
});
export const READINESS_ISSUES = Object.freeze([
  'APPLICATION_CLOSED', 'DATABASE_UNAVAILABLE', 'DATABASE_READ_ONLY', 'SCHEMA_UNAVAILABLE',
  'PORTAL_CONFIGURATION_INVALID', 'PORTAL_STORAGE_MODE_MISMATCH', 'READINESS_POLICY_INVALID',
  'PERSISTENT_STORAGE_REQUIRED', 'STORAGE_DURABILITY_UNCONFIRMED', 'STORAGE_UNAVAILABLE',
  'STORAGE_NOT_WRITABLE', 'STORAGE_SPACE_INSUFFICIENT',
]);
const defaultMinimumFreeBytes = 64 * 1024 * 1024;
const quote = value => '"' + value.replaceAll('"', '""') + '"';

// Startup is the only place that should opt into environment configuration.
// Imported applications can supply explicit policies for their synthetic store.
export function readinessOptionsFromEnv(environment = {}) {
  const required = environment.HOME_CARE_REQUIRE_PERSISTENT_STORAGE;
  const durability = environment.HOME_CARE_STORAGE_DURABILITY;
  const minimum = environment.HOME_CARE_MIN_FREE_BYTES;
  const mandatory = environment.NODE_ENV === 'production' || environment.HOME_CARE_AUTH_MODE === 'portal';
  return {
    requirePersistent: mandatory || required === '1',
    storageConfirmed: durability === 'persistent',
    minFreeBytes: minimum === undefined ? defaultMinimumFreeBytes : /^\d+$/.test(minimum) ? Number(minimum) : NaN,
    policyValid: (required === undefined || ['0', '1'].includes(required)) && !(mandatory && required === '0') && (durability === undefined || durability === 'persistent'),
  };
}

function storageCheck(dbPath, options) {
  if (dbPath === ':memory:') return options.requirePersistent ? 'PERSISTENT_STORAGE_REQUIRED' : null;
  if (typeof dbPath !== 'string' || !dbPath.trim()) return 'STORAGE_UNAVAILABLE';
  const filename = path.resolve(dbPath), directory = path.dirname(filename);
  try {
    const file = lstatSync(filename), folder = lstatSync(directory);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !folder.isDirectory() || folder.isSymbolicLink()) return 'STORAGE_UNAVAILABLE';
    // Do not rely solely on access(W_OK), which can succeed for a privileged
    // process even when an operator deliberately removed every write bit.
    if (!(file.mode & 0o222) || !(folder.mode & 0o222) || !(folder.mode & 0o111)) return 'STORAGE_NOT_WRITABLE';
    accessSync(filename, constants.R_OK | constants.W_OK);
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    const space = statfsSync(directory, { bigint: true });
    if (space.bavail < 0n || space.bsize <= 0n || space.bavail * space.bsize < BigInt(options.minFreeBytes)) return 'STORAGE_SPACE_INSUFFICIENT';
  } catch (error) {
    return ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? 'STORAGE_NOT_WRITABLE' : 'STORAGE_UNAVAILABLE';
  }
  return options.requirePersistent && !options.storageConfirmed ? 'STORAGE_DURABILITY_UNCONFIRMED' : null;
}

function schemaAvailable(db, mode) {
  const tables = mode === 'portal' ? { ...BASE_TABLES, ...PORTAL_TABLES } : BASE_TABLES;
  const definitions = db.prepare("SELECT type,name,tbl_name FROM sqlite_schema WHERE type IN ('table','trigger')").all();
  for (const [name, fields] of Object.entries(tables)) {
    if (!definitions.some(row => row.type === 'table' && row.name === name)) return false;
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => row.name);
    if (fields.some(field => !columns.includes(field))) return false;
    db.prepare(`SELECT ${fields.map(quote).join(',')} FROM ${quote(name)} LIMIT 0`).all();
  }
  return Object.entries(TRIGGERS).every(([name, table]) => definitions.some(row => row.type === 'trigger' && row.name === name && row.tbl_name === table));
}

export function createReadinessProbe({ db, dbPath, portalConfig = null, closed = () => false,
  databaseWritable = false, requirePersistent = false, storageConfirmed = false, minFreeBytes = defaultMinimumFreeBytes, policyValid = true } = {}) {
  return () => {
    const checks = { database: 'not_checked', schema: 'not_checked', storage: 'not_checked', portal: 'not_checked' };
    const issues = [];
    const answer = () => ({ status: issues.length ? 503 : 200, body: { ok: issues.length === 0, service: 'suiyue-home-care', checks, issues } });
    if (typeof requirePersistent !== 'boolean' || typeof storageConfirmed !== 'boolean' || policyValid !== true || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) {
      issues.push('READINESS_POLICY_INVALID'); return answer();
    }
    try { if (typeof closed !== 'function' || closed()) { issues.push('APPLICATION_CLOSED'); return answer(); } }
    catch { issues.push('APPLICATION_CLOSED'); return answer(); }
    let config;
    try { config = normalizePortalConfig(portalConfig); checks.portal = 'passed'; }
    catch { checks.portal = 'failed'; issues.push('PORTAL_CONFIGURATION_INVALID'); }
    try {
      if (!db || db.prepare('SELECT 1 AS reachable').get()?.reachable !== 1) throw new Error();
      checks.database = 'passed';
      // Node does not expose SQLite's connection-level sqlite3_db_readonly.
      // The owner must explicitly attest its constructor opened read/write.
      // An unknown connection is conservatively unsuitable for serving writes.
      if (databaseWritable !== true || db.prepare('PRAGMA query_only').get()?.query_only !== 0) {
        checks.database = 'failed'; issues.push('DATABASE_READ_ONLY');
      }
    } catch { checks.database = 'failed'; issues.push('DATABASE_UNAVAILABLE'); return answer(); }
    if (config) {
      try {
        const portalTables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('portal_identity_bindings','portal_handoff_nonces')").all();
        if (config.mode === 'local' && portalTables.length) {
          checks.portal = 'failed'; issues.push('PORTAL_STORAGE_MODE_MISMATCH');
        }
        checks.schema = schemaAvailable(db, config.mode) ? 'passed' : 'failed';
        if (checks.schema === 'failed') issues.push('SCHEMA_UNAVAILABLE');
      } catch { checks.schema = 'failed'; issues.push('SCHEMA_UNAVAILABLE'); }
    }
    const storageIssue = storageCheck(dbPath, { requirePersistent, storageConfirmed, minFreeBytes });
    checks.storage = storageIssue ? 'failed' : dbPath === ':memory:' ? 'not_required' : 'passed';
    if (storageIssue) issues.push(storageIssue);
    return answer();
  };
}
