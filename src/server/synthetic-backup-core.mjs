import { createHash } from 'node:crypto';
import { constants, chmodSync, closeSync, copyFileSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initDb } from './model.mjs';
import { initPortalStorage } from './portal-handoff.mjs';

// This module is deliberately unmounted. Its capabilities own only new synthetic
// scratch directories; they are not an operator interface for existing databases.
const workspaces = new WeakMap();
const backupReferences = new WeakMap();
const slotFiles = Object.freeze({ source: 'source.sqlite', backup: 'backup.sqlite', staged: 'staged.sqlite', live: 'live.sqlite', previous: 'previous.sqlite' });
const sidecarSuffixes = Object.freeze(['-wal', '-shm', '-journal']);
// These profiles never come from workspace properties, caller options, metadata,
// manifests or table discovery. Each exported facade closes over one fixed object.
const legacyProfile = Object.freeze({
  tableCount: 11, prefix: 'suiyue-synthetic-backup-',
  inspectionFormat: 'suiyue-synthetic-sqlite-inspection-v1',
  backupFormat: 'suiyue-synthetic-sqlite-backup-v1'
});
const portalProfile = Object.freeze({
  tableCount: 13, prefix: 'suiyue-synthetic-portal-backup-',
  inspectionFormat: 'suiyue-synthetic-portal-sqlite-inspection-v1',
  backupFormat: 'suiyue-synthetic-portal-sqlite-backup-v1'
});
const manifestName = 'backup.manifest.json';
const expectedSchemas = new WeakMap();

const messages = Object.freeze({
  INVALID_ARGUMENT: 'Unsupported synthetic backup argument.',
  WORKSPACE_INVALID: 'Synthetic workspace capability is invalid.',
  UNSAFE_PATH: 'Synthetic scratch file identity is unsafe.',
  SLOT_MISSING: 'Required synthetic database slot is missing.',
  TARGET_EXISTS: 'Synthetic target must be new.',
  SIDECAR_PRESENT: 'Closed synthetic database has a journal sidecar.',
  SCHEMA_MISMATCH: 'Synthetic database schema does not match the current model.',
  INTEGRITY_FAILED: 'Synthetic database integrity verification failed.',
  FOREIGN_KEY_FAILED: 'Synthetic database foreign key verification failed.',
  HISTORY_INCOMPLETE: 'Synthetic database current history is incomplete.',
  BACKUP_REFERENCE_INVALID: 'Synthetic backup reference is invalid.',
  BACKUP_CHANGED: 'Trusted synthetic backup has changed.',
  RESTORE_CHANGED: 'Trusted synthetic restored candidate has changed.',
  PROMOTION_FAILED: 'Synthetic promotion failed; inspect retained generations.',
  ROLLBACK_FAILED: 'Synthetic rollback failed; inspect retained generations.',
  SQLITE_OPERATION_FAILED: 'Synthetic SQLite or scratch operation failed.'
});

class SyntheticBackupError extends Error {
  constructor(code) { super(messages[code]); this.name = 'SyntheticBackupError'; this.code = code; }
}
const fail = code => { throw new SyntheticBackupError(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
const opaque = () => Object.freeze(Object.create(null));
const quoteIdentifier = value => '"' + value.replaceAll('"', '""') + '"';

function guarded(operation) {
  try { return operation(); }
  catch (error) { if (error instanceof SyntheticBackupError) throw error; fail('SQLITE_OPERATION_FAILED'); }
}
function exactArity(actual, expected) { if (actual !== expected) fail('INVALID_ARGUMENT'); }
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function lease(stat) { return { dev: stat.dev, ino: stat.ino, uid: stat.uid }; }
function sameIdentity(stat, identity) { return stat && stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === identity.uid; }
function workspaceState(capability, profile) {
  const state = workspaces.get(capability);
  // Reject a forged, disposed or cross-profile capability before any filesystem
  // lookup, including lstat/realpath of an otherwise valid owned scratch root.
  if (!state || state.disposed || state.profile !== profile) fail('WORKSPACE_INVALID');
  return state;
}
function rootState(capability, profile) {
  const state = workspaceState(capability, profile);
  let stat, real;
  try { stat = lstatSync(state.root); real = realpathSync(state.root); }
  catch { fail('WORKSPACE_INVALID'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, state.identity) || real !== state.realRoot || (stat.mode & 0o777) !== 0o700) fail('WORKSPACE_INVALID');
  return state;
}
function validateRoot(state) { rootState(state.capability, state.profile); }
function slotPath(state, slot) {
  if (typeof slot !== 'string' || !Object.hasOwn(slotFiles, slot)) fail('INVALID_ARGUMENT');
  return join(state.root, slotFiles[slot]);
}
function regularFile(state, path, missingCode = 'SLOT_MISSING') {
  validateRoot(state);
  const stat = statIfPresent(path);
  if (!stat) fail(missingCode);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== state.identity.uid) fail('UNSAFE_PATH');
  return stat;
}
function verifyLease(state, path, identity, changedCode = 'UNSAFE_PATH') {
  const stat = regularFile(state, path, changedCode);
  if (!sameIdentity(stat, identity)) fail(changedCode);
  return stat;
}
function sidecars(state, path) {
  validateRoot(state);
  const present = [];
  for (const suffix of sidecarSuffixes) {
    const candidate = path + suffix;
    if (statIfPresent(candidate)) { regularFile(state, candidate); present.push(candidate); }
  }
  return present;
}
function requireClosed(state, path) { if (sidecars(state, path).length) fail('SIDECAR_PRESENT'); }
function requireNew(state, path) {
  validateRoot(state);
  // lstat also sees dangling symbolic links: an occupied target is never reused.
  if (statIfPresent(path)) fail('TARGET_EXISTS');
  for (const suffix of sidecarSuffixes) if (statIfPresent(path + suffix)) fail('SIDECAR_PRESENT');
}
function fileDigest(state, path, identity, changedCode = 'UNSAFE_PATH') {
  const before = identity ? verifyLease(state, path, identity, changedCode) : regularFile(state, path);
  const bytes = readFileSync(path);
  const after = verifyLease(state, path, lease(before));
  if (before.size !== after.size || bytes.length !== after.size) fail('UNSAFE_PATH');
  return { hash: sha256(bytes), bytes: bytes.length, identity: lease(after) };
}
function removeCreated(state, path, identity) {
  // Cleanup never follows a replacement or removes a preexisting target.
  try {
    validateRoot(state);
    const stat = statIfPresent(path);
    if (stat?.isFile() && stat.nlink === 1 && sameIdentity(stat, identity)) rmSync(path);
  } catch { /* Retain uncertain artifacts rather than delete another identity. */ }
}
function newFile(state, path, content) {
  requireNew(state, path);
  const fd = openSync(path, 'wx', 0o600);
  let identity;
  try {
    identity = lease(regularFile(state, path));
    if (content !== undefined) writeFileSync(fd, content);
    return identity;
  } catch (error) {
    if (identity) removeCreated(state, path, identity);
    throw error;
  } finally { closeSync(fd); }
}

function schemaRows(db) {
  // Node 22.13 normal TEXT reads truncate at embedded NUL. SQL hexadecimal
  // projection retains every saved byte, including schema metadata and SQL.
  const fields = ['type', 'name', 'tbl_name', 'sql'];
  const projection = fields.map(field => 'CASE WHEN ' + quoteIdentifier(field) + ' IS NULL THEN NULL ELSE hex(CAST(' + quoteIdentifier(field) + ' AS BLOB)) END AS ' + quoteIdentifier(field));
  return db.prepare('SELECT ' + projection.join(',') + ' FROM sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY').all()
    .map(row => fields.map(field => row[field]));
}
function headers(db) {
  return { userVersion: db.prepare('PRAGMA user_version').get().user_version, applicationId: db.prepare('PRAGMA application_id').get().application_id };
}
function modelSchema(profile) {
  if (expectedSchemas.has(profile)) return expectedSchemas.get(profile);
  const db = new DatabaseSync(':memory:');
  try {
    initDb(db);
    if (profile === portalProfile) initPortalStorage(db);
    const schema = schemaRows(db);
    // Identifiers are decoded only from the healthy private memory model, never
    // from caller database metadata or an externally supplied table name.
    const names = schema.filter(row => row[0] === '7461626C65').map(row => Buffer.from(row[1], 'hex').toString('utf8')).sort();
    const tables = names.map(name => ({ name, columns: db.prepare('PRAGMA table_info(' + quoteIdentifier(name) + ')').all().map(row => row.name) }));
    const triggerCount = schema.filter(row => row[0] === '74726967676572').length;
    if (tables.length !== profile.tableCount || triggerCount !== 6) fail('SCHEMA_MISMATCH');
    const expectedSchema = freeze({ schema, schemaSha256: jsonHash(schema), tables, triggerCount, ...headers(db) });
    expectedSchemas.set(profile, expectedSchema);
    return expectedSchema;
  } finally { db.close(); }
}
function typedValue(value) {
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['integer', value.toString(10)];
  if (typeof value === 'number') {
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value);
    return ['real', bytes.toString('hex')];
  }
  if (typeof value === 'string') return ['text', value];
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  fail('INTEGRITY_FAILED');
}
function canonicalRows(columns, rows) {
  const serialized = rows.map(row => Buffer.from(JSON.stringify(columns.map(column => row[column])), 'utf8'));
  serialized.sort(Buffer.compare);
  return { count: rows.length, sha256: jsonHash({ columns, rows: serialized.map(bytes => bytes.toString('utf8')) }) };
}
function rawRows(db, table, columns) {
  const projection = columns.flatMap((column, index) => {
    const identifier = quoteIdentifier(column), storage = 'typeof(' + identifier + ')';
    return [storage + ' AS ' + quoteIdentifier('_storage_' + index),
      'CASE WHEN ' + storage + "='text' THEN hex(CAST(" + identifier + ' AS BLOB)) ELSE ' + identifier + ' END AS ' + quoteIdentifier('_value_' + index)];
  });
  const statement = db.prepare('SELECT ' + projection.join(',') + ' FROM ' + quoteIdentifier(table));
  statement.setReadBigInts(true);
  return statement.all().map(row => Object.fromEntries(columns.map((column, index) => {
    const value = row['_value_' + index];
    return [column, row['_storage_' + index] === 'text' ? ['text', value] : typedValue(value)];
  })));
}
function inspectConnection(db, profile) {
  const model = modelSchema(profile);
  db.exec('BEGIN');
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail('INTEGRITY_FAILED');
    const schema = schemaRows(db), header = headers(db);
    if (jsonHash(schema) !== model.schemaSha256 || header.userVersion !== model.userVersion || header.applicationId !== model.applicationId) fail('SCHEMA_MISMATCH');
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_FAILED');
    if (db.prepare('SELECT 1 FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_versions v WHERE v.record_id=r.id AND v.version=r.version) LIMIT 1').get()) fail('HISTORY_INCOMPLETE');
    const tables = {}, rows = new Map();
    for (const table of model.tables) {
      const saved = rawRows(db, table.name, table.columns);
      rows.set(table.name, saved);
      tables[table.name] = canonicalRows(table.columns, saved);
    }
    const blobSha256 = {};
    for (const name of ['attachment_files', 'certification_attachment_files']) blobSha256[name] = canonicalRows(['id', 'content'], rows.get(name)).sha256;
    const versionsSha256 = tables.record_versions.sha256;
    // Hash complete saved service-record JSON envelopes as TEXT, including their
    // pricing snapshots. Do not parse or round persisted numeric JSON values.
    const exactServiceRecord = row => row.entity[0] === 'text' && row.entity[1] === '736572766963652D7265636F726473';
    const current = rows.get('records').filter(exactServiceRecord);
    const historical = rows.get('record_versions').filter(exactServiceRecord);
    const billingSnapshotsSha256 = jsonHash({
      current: canonicalRows(['id', 'org_id', 'entity', 'data', 'version', 'created_at', 'updated_at'], current),
      historical: canonicalRows(['org_id', 'entity', 'record_id', 'version', 'snapshot', 'created_at', 'source'], historical)
    });
    const content = { tableCount: model.tables.length, triggerCount: model.triggerCount, ...header, schemaSha256: model.schemaSha256, tables, blobSha256, versionsSha256, billingSnapshotsSha256 };
    return freeze({ format: profile.inspectionFormat, ...content, fingerprint: jsonHash(content) });
  } finally { db.exec('ROLLBACK'); }
}
function inspectReadonly(path, profile) {
  let db;
  try { db = new DatabaseSync(path, { readOnly: true }); return inspectConnection(db, profile); }
  catch (error) { if (error instanceof SyntheticBackupError) throw error; fail('INTEGRITY_FAILED'); }
  finally { if (db) db.close(); }
}
function inspectSlot(state, slot) {
  const path = slotPath(state, slot);
  const before = fileDigest(state, path);
  const present = sidecars(state, path);
  let report;
  if (present.length) {
    if (slot !== 'source') fail('SIDECAR_PRESENT');
    // A separate readonly connection reads the last committed WAL snapshot.
    // Existing source sidecars are neither checkpointed nor removed here.
    report = inspectReadonly(path, state.profile);
    verifyLease(state, path, before.identity);
  } else {
    // Readonly SQLite can create WAL sidecars even on a closed database. Inspect
    // an exclusive owned copy, never the original closed promotion generation.
    const scratch = mkdtempSync(join(state.root, '.inspect-'));
    chmodSync(scratch, 0o700);
    const scratchIdentity = lease(lstatSync(scratch));
    try {
      copyFileSync(path, join(scratch, 'inspect.sqlite'), constants.COPYFILE_EXCL);
      chmodSync(join(scratch, 'inspect.sqlite'), 0o600);
      report = inspectReadonly(join(scratch, 'inspect.sqlite'), state.profile);
      requireClosed(state, path);
      const after = fileDigest(state, path, before.identity);
      if (after.hash !== before.hash || after.bytes !== before.bytes) fail('UNSAFE_PATH');
    } finally {
      // This internal scratch directory is the only inspection cleanup target.
      validateRoot(state);
      const current = statIfPresent(scratch);
      if (current?.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, scratchIdentity)) rmSync(scratch, { recursive: true });
    }
  }
  return freeze({ ...report, mainFileSha256: before.hash, mainFileBytes: before.bytes });
}
function sameContent(a, b) { return a.fingerprint === b.fingerprint && a.schemaSha256 === b.schemaSha256; }
function sameStandalone(a, b) { return sameContent(a, b) && a.mainFileSha256 === b.mainFileSha256 && a.mainFileBytes === b.mainFileBytes; }
function referenceState(state, reference) {
  const trusted = backupReferences.get(reference);
  if (!trusted || trusted.owner !== state || trusted.profile !== state.profile || trusted.format !== state.profile.backupFormat) fail('BACKUP_REFERENCE_INVALID');
  return trusted;
}
function verifiedBackup(state, reference) {
  const trusted = referenceState(state, reference);
  const path = slotPath(state, 'backup'), manifestPath = join(state.root, manifestName);
  const file = fileDigest(state, path, trusted.fileIdentity, 'BACKUP_CHANGED');
  const manifest = fileDigest(state, manifestPath, trusted.manifestIdentity, 'BACKUP_CHANGED');
  if (file.hash !== trusted.report.mainFileSha256 || file.bytes !== trusted.report.mainFileBytes || manifest.hash !== trusted.manifestSha256) fail('BACKUP_CHANGED');
  requireClosed(state, path);
  const current = inspectSlot(state, 'backup');
  if (!sameStandalone(current, trusted.report)) fail('BACKUP_CHANGED');
  return trusted;
}
function optionsRollback(options) {
  if (!options || typeof options !== 'object' || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) fail('INVALID_ARGUMENT');
  const keys = Reflect.ownKeys(options), descriptor = Object.getOwnPropertyDescriptor(options, 'forceRollback');
  if (keys.length !== 1 || keys[0] !== 'forceRollback' || !descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean') fail('INVALID_ARGUMENT');
  return descriptor.value;
}

function operationsFor(profile) {
  function createSyntheticWorkspace() {
    exactArity(arguments.length, 0);
    return guarded(() => {
      const parent = realpathSync(tmpdir());
      const root = mkdtempSync(join(parent, profile.prefix));
      chmodSync(root, 0o700);
      const capability = opaque(), stat = lstatSync(root);
      const state = { capability, profile, root, realRoot: realpathSync(root), identity: lease(stat), disposed: false, restores: new Map() };
      workspaces.set(capability, state);
      rootState(capability, profile);
      return capability;
    });
  }

  function syntheticDatabasePath(workspace, slot) {
    exactArity(arguments.length, 2);
    return guarded(() => {
      const state = rootState(workspace, profile), path = slotPath(state, slot);
      if (statIfPresent(path)) regularFile(state, path);
      sidecars(state, path);
      return path;
    });
  }

  function inspectSyntheticDatabase(workspace, slot) {
    exactArity(arguments.length, 2);
    return guarded(() => inspectSlot(rootState(workspace, profile), slot));
  }

  function captureSyntheticBackup(workspace) {
    exactArity(arguments.length, 1);
    return guarded(() => {
      const state = rootState(workspace, profile), sourcePath = slotPath(state, 'source'), backupPath = slotPath(state, 'backup'), manifestPath = join(state.root, manifestName);
      requireNew(state, backupPath); requireNew(state, manifestPath);
      const sourceIdentity = lease(regularFile(state, sourcePath)), sourceBefore = inspectSlot(state, 'source');
      let backupIdentity, manifestIdentity, db, accepted = false;
      try {
        backupIdentity = newFile(state, backupPath);
        verifyLease(state, sourcePath, sourceIdentity);
        db = new DatabaseSync(sourcePath, { readOnly: true });
        // Available in the declared Node 22.13 minimum; the filename is a bound
        // fixed capability slot, never interpolated caller SQL or an arbitrary path.
        db.prepare('VACUUM main INTO ?').run(backupPath);
        db.close(); db = null;
        verifyLease(state, backupPath, backupIdentity);
        const report = inspectSlot(state, 'backup'), sourceAfter = inspectSlot(state, 'source');
        verifyLease(state, sourcePath, sourceIdentity);
        if (!sameContent(report, sourceBefore) || !sameContent(sourceBefore, sourceAfter)) fail('BACKUP_CHANGED');
        const manifest = freeze({
          format: profile.backupFormat, syntheticOnly: true, fileSha256: report.mainFileSha256, fileBytes: report.mainFileBytes,
          tableCount: report.tableCount, triggerCount: report.triggerCount, userVersion: report.userVersion, applicationId: report.applicationId,
          schemaSha256: report.schemaSha256, fingerprint: report.fingerprint, tables: report.tables, blobSha256: report.blobSha256,
          versionsSha256: report.versionsSha256, billingSnapshotsSha256: report.billingSnapshotsSha256
        });
        const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        manifestIdentity = newFile(state, manifestPath, manifestBytes);
        const reference = opaque();
        backupReferences.set(reference, { owner: state, profile, format: profile.backupFormat, report, fileIdentity: backupIdentity, manifestIdentity, manifestSha256: sha256(manifestBytes) });
        accepted = true;
        return reference;
      } finally {
        if (db) db.close();
        // A successful reference owns these files. On failure, only files allocated
        // by this operation with unchanged identities are eligible for cleanup.
        if (!accepted) {
          if (manifestIdentity) removeCreated(state, manifestPath, manifestIdentity);
          if (backupIdentity) removeCreated(state, backupPath, backupIdentity);
        }
      }
    });
  }

  function restoreSyntheticBackup(workspace, reference, target) {
    exactArity(arguments.length, 3);
    if (target !== 'staged' && target !== 'live') fail('INVALID_ARGUMENT');
    return guarded(() => {
      const state = workspaceState(workspace, profile);
      // References are also owner-bound. Reject a foreign reference before even
      // validating this root on disk, so profiles cannot be inferred from files.
      referenceState(state, reference);
      validateRoot(state);
      const targetPath = slotPath(state, target);
      requireNew(state, targetPath);
      const trusted = verifiedBackup(state, reference);
      let targetIdentity;
      try {
        copyFileSync(slotPath(state, 'backup'), targetPath, constants.COPYFILE_EXCL);
        targetIdentity = lease(regularFile(state, targetPath));
        chmodSync(targetPath, 0o600);
        const report = inspectSlot(state, target);
        if (!sameStandalone(report, trusted.report)) fail('BACKUP_CHANGED');
        state.restores.set(target, { identity: targetIdentity, report, reference });
        return freeze({ status: 'restored', target, ...report });
      } catch (error) {
        if (targetIdentity) removeCreated(state, targetPath, targetIdentity);
        throw error;
      }
    });
  }

  function promoteSyntheticRestore(workspace, options) {
    exactArity(arguments.length, 2);
    return guarded(() => {
      const forceRollback = optionsRollback(options);
      const state = rootState(workspace, profile), livePath = slotPath(state, 'live'), stagedPath = slotPath(state, 'staged'), previousPath = slotPath(state, 'previous');
      regularFile(state, livePath); regularFile(state, stagedPath);
      requireClosed(state, livePath); requireClosed(state, stagedPath); requireNew(state, previousPath);
      const proof = state.restores.get('staged');
      if (!proof) fail('RESTORE_CHANGED');
      const stagedFile = fileDigest(state, stagedPath, proof.identity, 'RESTORE_CHANGED');
      if (stagedFile.hash !== proof.report.mainFileSha256 || stagedFile.bytes !== proof.report.mainFileBytes) fail('RESTORE_CHANGED');
      const candidate = inspectSlot(state, 'staged');
      if (!sameStandalone(candidate, proof.report)) fail('RESTORE_CHANGED');
      const before = inspectSlot(state, 'live'), liveIdentity = lease(regularFile(state, livePath));
      let previousMoved = false, candidateMoved = false;
      const forced = {};
      try {
        verifyLease(state, livePath, liveIdentity); verifyLease(state, stagedPath, proof.identity);
        requireClosed(state, livePath); requireClosed(state, stagedPath); requireNew(state, previousPath);
        renameSync(livePath, previousPath); previousMoved = true;
        requireNew(state, livePath); verifyLease(state, stagedPath, proof.identity);
        renameSync(stagedPath, livePath); candidateMoved = true;
        if (forceRollback) throw forced;
        const live = inspectSlot(state, 'live'), previous = inspectSlot(state, 'previous');
        if (!sameStandalone(live, candidate) || !sameStandalone(previous, before)) fail('PROMOTION_FAILED');
        state.restores.delete('staged');
        state.restores.set('live', { ...proof, report: live });
        return freeze({ status: 'promoted', before, candidate, live, previous, staged: null });
      } catch (error) {
        try {
          if (candidateMoved) {
            requireClosed(state, livePath); verifyLease(state, livePath, proof.identity); requireNew(state, stagedPath);
            renameSync(livePath, stagedPath); candidateMoved = false;
          }
          if (previousMoved) {
            requireClosed(state, previousPath); verifyLease(state, previousPath, liveIdentity); requireNew(state, livePath);
            renameSync(previousPath, livePath); previousMoved = false;
          }
          const live = inspectSlot(state, 'live'), staged = inspectSlot(state, 'staged');
          if (!sameStandalone(live, before) || !sameStandalone(staged, candidate)) fail('ROLLBACK_FAILED');
          // The candidate proof remains valid after the controlled rollback, so a
          // later closed success rehearsal can promote this same restored stage.
          if (error === forced) return freeze({ status: 'rolled_back', before, candidate, live, previous: null, staged });
        } catch { fail('ROLLBACK_FAILED'); }
        fail('PROMOTION_FAILED');
      }
    });
  }

  function disposeSyntheticWorkspace(workspace) {
    exactArity(arguments.length, 1);
    return guarded(() => {
      const state = rootState(workspace, profile);
      rmSync(state.root, { recursive: true });
      state.disposed = true; state.restores.clear();
      return freeze({ status: 'disposed' });
    });
  }
  return Object.freeze({ createSyntheticWorkspace, syntheticDatabasePath,
    inspectSyntheticDatabase, captureSyntheticBackup, restoreSyntheticBackup,
    promoteSyntheticRestore, disposeSyntheticWorkspace });
}

// Only fixed operation sets leave this private core. There is no public profile
// selector or schema/format override and no operation accepts an external path.
export const legacySyntheticBackup = operationsFor(legacyProfile);
export const portalSyntheticBackup = operationsFor(portalProfile);
