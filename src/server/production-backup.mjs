import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, readSync, openSync, constants, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as sqlite from 'node:sqlite';
import { accountMembershipActive } from './account-administration.mjs';
import { inspectProductionDatabase } from './production-backup-inspection.mjs';
import { failProductionBackup as fail, guardProductionBackup } from './production-backup-errors.mjs';
import {
  canonicalPath, privateDirectory, privateFile, sourceLease, openPrivateRead,
  readExact, writeAll, makeWorkspace, requireNewFile, createIsolationDirectory,
  publishNewPrivateFile, syncPrivateDirectory, statMaybe,
} from './production-backup-storage.mjs';

export { ProductionBackupError } from './production-backup-errors.mjs';
export { readProductionEncryptionKeyFile } from './production-backup-storage.mjs';

const MAGIC = Buffer.from('SYHCBAK1');
const FORMAT = 'suiyue-production-encrypted-sqlite-v1';
const RECOVERY_FORMAT = 'suiyue-production-recovery-pending-v1';
export const PRODUCTION_RECOVERY_MARKER = 'RECOVERY_PENDING.json';
export const PRODUCTION_RECOVERY_DATABASE = 'isolated.sqlite';
const PLAN_NAME = 'RECOVERY_RECONCILIATION_PLAN.json';
// Keep the accepted per-IV payload well below AES-GCM's 64 GiB limit.
const DEFAULT_LIMIT = 2 * 1024 ** 3, MAXIMUM_LIMIT = 32 * 1024 ** 3;
const PROOF_LIMIT = 1024 ** 2, HEADER_LIMIT = 4096, CHUNK = 256 * 1024;
const SECURITY_CHANGED = new Set(['sessions', 'portal_identity_bindings']);
const RECOVERY_REQUIREMENTS = Object.freeze(['fresh-authority-attestation', 'explicit-per-identity-grant-and-revocation-reconciliation', 'retire-all-previous-portal-signing-keys', 'new-signing-key-replay-window-validation', 'approved-host-and-storage-and-operator-cutover']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLES = new Set(['admin', 'supervisor', 'caregiver', 'finance']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const digestValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get;
const typedSet = Uint8Array.prototype.set;

function closed(value, allowed, required = allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Array.isArray(value)) fail('INVALID_ARGUMENT');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(k => typeof k !== 'string' || !allowed.includes(k) || !Object.hasOwn(descriptors[k], 'value')) || required.some(k => !Object.hasOwn(descriptors, k))) fail('INVALID_ARGUMENT');
  return value;
}
function limit(value = DEFAULT_LIMIT) {
  if (!Number.isSafeInteger(value) || value < 4096 || value > MAXIMUM_LIMIT) fail('INVALID_ARGUMENT');
  return value;
}
function copyKey(value) {
  let copy;
  try {
    if (!Buffer.isBuffer(value) || typedLength.call(value) !== 32) fail('KEY_INVALID');
    copy = Buffer.alloc(32); typedSet.call(copy, value); return copy;
  } catch {
    copy?.fill(0); fail('KEY_INVALID');
  }
}
function runtime() {
  if (typeof sqlite.backup !== 'function' || typeof sqlite.DatabaseSync !== 'function') fail('UNSUPPORTED_RUNTIME');
}
function readPrivateBytes(path, maximum) {
  const h = openPrivateRead(path, maximum);
  try { const bytes = readExact(h.fd, h.size, 0); h.verify(); return bytes; }
  finally { closeSync(h.fd); }
}
function fileDigest(path, maximum) {
  const h = openPrivateRead(path, maximum), digest = createHash('sha256'), chunk = Buffer.alloc(CHUNK);
  try {
    let offset = 0;
    while (offset < h.size) {
      const n = readSync(h.fd, chunk, 0, Math.min(CHUNK, h.size - offset), offset);
      if (!n) fail('BACKUP_CHANGED');
      digest.update(chunk.subarray(0, n)); offset += n;
    }
    h.verify(); return { sha256: digest.digest('hex'), bytes: h.size };
  } finally { chunk.fill(0); closeSync(h.fd); }
}
function inspectClosed(path) {
  let db;
  try { db = new sqlite.DatabaseSync(path, { readOnly: true }); return inspectProductionDatabase(db); }
  finally { db?.close(); }
}
function assertInspectionEqual(a, b) { if (!isDeepStrictEqual(a, b)) fail('SNAPSHOT_CHANGED'); }
function noSidecars(path) {
  if (['-wal', '-shm', '-journal'].some(s => statMaybe(path + s))) fail('RESTORE_CHANGED');
}
async function captureCommitted(databasePath, workspace, maximum) {
  runtime();
  const source = sourceLease(databasePath), slot = workspace.create('snapshot.sqlite');
  closeSync(slot.fd);
  let db;
  try {
    source.verify();
    db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
    // Pin a real read transaction before inspecting or invoking SQLite backup.
    db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
    const pages = db.prepare('PRAGMA page_count').get().page_count, pageSize = db.prepare('PRAGMA page_size').get().page_size;
    if (!Number.isSafeInteger(pages * pageSize) || pages * pageSize > maximum) fail('CAPACITY_EXCEEDED');
    const before = inspectProductionDatabase(db);
    await sqlite.backup(db, slot.path, { rate: 128 });
    assertInspectionEqual(inspectProductionDatabase(db), before);
    db.exec('ROLLBACK'); db.close(); db = null;
    source.verify(); privateFile(slot.path, { maximum, expected: slot.identity });
    // Normalize only our new private snapshot, never the operator source/WAL.
    const normalized = new sqlite.DatabaseSync(slot.path);
    try { normalized.exec('PRAGMA journal_mode=DELETE'); }
    finally { normalized.close(); }
    workspace.adoptSidecars(slot.path); noSidecars(slot.path);
    const inspection = inspectClosed(slot.path); assertInspectionEqual(inspection, before);
    const digest = fileDigest(slot.path, maximum);
    return { path: slot.path, identity: slot.identity, inspection, ...digest };
  } finally {
    if (db) { try { db.exec('ROLLBACK'); } catch {} db.close(); }
    workspace.adoptSidecars(slot.path);
  }
}
function headerBytes(createdAt, iv) {
  return encode({ format: FORMAT, version: 1, cipher: 'aes-256-gcm', iv: iv.toString('base64'), createdAt });
}
function encryptSnapshot(snapshot, key, workspace, createdAt) {
  let encrypted, h, proof; const chunk = Buffer.alloc(CHUNK);
  try {
    encrypted = workspace.create('archive.pending');
    const iv = randomBytes(12), header = headerBytes(createdAt, iv), headerSize = Buffer.alloc(4); headerSize.writeUInt32BE(header.length);
    const aad = Buffer.concat([MAGIC, headerSize, header]);
    proof = encode({ format: 'suiyue-production-backup-proof-v1', createdAt, inspection: snapshot.inspection, databaseSha256: snapshot.sha256, databaseBytes: snapshot.bytes });
    if (proof.length > PROOF_LIMIT) fail('CAPACITY_EXCEEDED');
    const proofSize = Buffer.alloc(4); proofSize.writeUInt32BE(proof.length);
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    h = openPrivateRead(snapshot.path, snapshot.bytes);
    writeAll(encrypted.fd, aad); writeAll(encrypted.fd, cipher.update(proofSize)); writeAll(encrypted.fd, cipher.update(proof));
    let offset = 0;
    while (offset < h.size) {
      const n = readSync(h.fd, chunk, 0, Math.min(CHUNK, h.size - offset), offset);
      if (!n) fail('SNAPSHOT_CHANGED');
      writeAll(encrypted.fd, cipher.update(chunk.subarray(0, n))); offset += n;
    }
    h.verify(); writeAll(encrypted.fd, cipher.final()); writeAll(encrypted.fd, cipher.getAuthTag()); fsyncSync(encrypted.fd);
    return encrypted;
  } finally { chunk.fill(0); proof?.fill(0); if (h) closeSync(h.fd); if (encrypted) closeSync(encrypted.fd); }
}
function parseHeader(bytes) {
  let h;
  try { h = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('ENVELOPE_INVALID'); }
  try { closed(h, ['format', 'version', 'cipher', 'iv', 'createdAt']); }
  catch { fail('ENVELOPE_INVALID'); }
  if (h.format !== FORMAT || h.version !== 1 || h.cipher !== 'aes-256-gcm' || !canonicalTime(h.createdAt) || typeof h.iv !== 'string' || !encode(h).equals(bytes)) fail('ENVELOPE_INVALID');
  const iv = Buffer.from(h.iv, 'base64');
  if (iv.length !== 12 || iv.toString('base64') !== h.iv) fail('ENVELOPE_INVALID');
  return { ...h, iv };
}
function openArchive(backupPath, key, workspace, maximum) {
  let h, payload, snapshot;
  const chunk = Buffer.alloc(CHUNK);
  try {
    h = openPrivateRead(backupPath, maximum + PROOF_LIMIT + HEADER_LIMIT + 32);
    payload = workspace.create('authenticated.payload');
    if (h.size < MAGIC.length + 4 + 16 + 104) fail('ENVELOPE_INVALID');
    const prefix = readExact(h.fd, MAGIC.length + 4, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) fail('ENVELOPE_INVALID');
    const headerLength = prefix.readUInt32BE(MAGIC.length);
    if (headerLength < 1 || headerLength > HEADER_LIMIT) fail('ENVELOPE_INVALID');
    const hb = readExact(h.fd, headerLength, prefix.length), header = parseHeader(hb), start = prefix.length + headerLength, end = h.size - 16;
    if (end - start < 104 || end - start > maximum + PROOF_LIMIT + 4) fail('CAPACITY_EXCEEDED');
    const tag = readExact(h.fd, 16, end), archiveDigest = createHash('sha256'); archiveDigest.update(prefix).update(hb);
    const decipher = createDecipheriv('aes-256-gcm', key, header.iv);
    decipher.setAAD(Buffer.concat([prefix, hb])); decipher.setAuthTag(tag);
    let offset = start;
    while (offset < end) {
      const n = readSync(h.fd, chunk, 0, Math.min(CHUNK, end - offset), offset);
      if (!n) fail('BACKUP_CHANGED');
      archiveDigest.update(chunk.subarray(0, n));
      const plain = decipher.update(chunk.subarray(0, n));
      try { writeAll(payload.fd, plain); } finally { plain.fill(0); }
      offset += n;
    }
    let final;
    try { final = decipher.final(); } catch { fail('AUTHENTICATION_FAILED'); }
    try { writeAll(payload.fd, final); } finally { final.fill(0); }
    archiveDigest.update(tag);
    fsyncSync(payload.fd); h.verify(); closeSync(payload.fd); payload.fd = null;
    // No database/proof is parsed or published until the GCM tag is accepted.
    const ph = openPrivateRead(payload.path, maximum + PROOF_LIMIT + 4);
    try {
      const proofLength = readExact(ph.fd, 4, 0).readUInt32BE();
      if (!proofLength || proofLength > PROOF_LIMIT || ph.size - 4 - proofLength < 100 || ph.size - 4 - proofLength > maximum) fail('ENVELOPE_INVALID');
      const pb = readExact(ph.fd, proofLength, 4); let proof;
      try { proof = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pb)); closed(proof, ['format', 'createdAt', 'inspection', 'databaseSha256', 'databaseBytes']); }
      catch { fail('ENVELOPE_INVALID'); }
      if (proof.format !== 'suiyue-production-backup-proof-v1' || proof.createdAt !== header.createdAt || !digestValid(proof.databaseSha256) || proof.databaseBytes !== ph.size - 4 - proofLength || !encode(proof).equals(pb)) fail('ENVELOPE_INVALID');
      snapshot = workspace.create('restored.sqlite'); const digest = createHash('sha256'); let offset = 4 + proofLength;
      while (offset < ph.size) {
        const n = readSync(ph.fd, chunk, 0, Math.min(CHUNK, ph.size - offset), offset);
        if (!n) fail('BACKUP_CHANGED');
        writeAll(snapshot.fd, chunk.subarray(0, n)); digest.update(chunk.subarray(0, n)); offset += n;
      }
      ph.verify(); fsyncSync(snapshot.fd); closeSync(snapshot.fd); snapshot.fd = null;
      if (digest.digest('hex') !== proof.databaseSha256) fail('SNAPSHOT_CHANGED');
      noSidecars(snapshot.path);
      const inspection = inspectClosed(snapshot.path); assertInspectionEqual(inspection, proof.inspection);
      h.verify(); return { path: snapshot.path, identity: snapshot.identity, proof, inspection, encryptedSha256: archiveDigest.digest('hex') };
    } finally { closeSync(ph.fd); }
  } finally {
    chunk.fill(0); if (h) closeSync(h.fd);
    if (payload && payload.fd !== null) closeSync(payload.fd);
    if (snapshot?.fd !== null && snapshot?.fd !== undefined) closeSync(snapshot.fd);
    if (payload) workspace.adoptSidecars(payload.path);
    if (snapshot) workspace.adoptSidecars(snapshot.path);
  }
}
function newPrivateJson(path, value) {
  requireNewFile(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeAll(fd, encode(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncPrivateDirectory(dirname(path));
}
function quarantine(snapshot, workspace) {
  const db = new sqlite.DatabaseSync(snapshot.path);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try { db.exec('DELETE FROM sessions; UPDATE portal_identity_bindings SET active=0; COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    db.exec('PRAGMA journal_mode=DELETE');
  } finally { db.close(); workspace.adoptSidecars(snapshot.path); }
  noSidecars(snapshot.path);
  const after = inspectClosed(snapshot.path);
  if (after.tables.sessions.count !== 0) fail('RESTORE_CHANGED');
  for (const name of Object.keys(snapshot.inspection.tables)) if (!SECURITY_CHANGED.has(name) && !isDeepStrictEqual(after.tables[name], snapshot.inspection.tables[name])) fail('RESTORE_CHANGED');
  const check = new sqlite.DatabaseSync(snapshot.path, { readOnly: true });
  try { if (check.prepare('SELECT 1 FROM portal_identity_bindings WHERE active<>0 LIMIT 1').get()) fail('RESTORE_CHANGED'); }
  finally { check.close(); }
  return after;
}

export async function createProductionBackup(options) {
  return guardProductionBackup(async () => {
    closed(options, ['databasePath', 'outputPath', 'key', 'maxBytes'], ['databasePath', 'outputPath', 'key']);
    const maximum = limit(options.maxBytes); requireNewFile(options.outputPath); sourceLease(options.databasePath);
    let workspace, key;
    try {
      key = copyKey(options.key); workspace = makeWorkspace(dirname(options.outputPath));
      const snapshot = await captureCommitted(options.databasePath, workspace, maximum);
      const encrypted = encryptSnapshot(snapshot, key, workspace, new Date().toISOString());
      // Encryption has finished and closed both descriptors. The immutable
      // captured proof remains; reopening still authenticates every byte.
      workspace.discardOwned(snapshot.path, snapshot.identity);
      const reopened = openArchive(encrypted.path, key, workspace, maximum);
      assertInspectionEqual(reopened.inspection, snapshot.inspection);
      const digest = fileDigest(encrypted.path, maximum + PROOF_LIMIT + HEADER_LIMIT + 32);
      publishNewPrivateFile(encrypted.path, options.outputPath, encrypted.identity);
      return Object.freeze({ ok: true, operation: 'backup', format: FORMAT, tableCount: 13, encryptedSha256: digest.sha256, verified: true });
    } finally { key?.fill(0); workspace?.cleanup(); }
  });
}
export async function verifyProductionBackup(options) {
  return guardProductionBackup(async () => {
    closed(options, ['backupPath', 'key', 'maxBytes'], ['backupPath', 'key']);
    const maximum = limit(options.maxBytes); let workspace, key;
    try {
      key = copyKey(options.key); workspace = makeWorkspace(dirname(options.backupPath));
      openArchive(options.backupPath, key, workspace, maximum);
      return Object.freeze({ ok: true, operation: 'verify', tableCount: 13, verified: true });
    } finally { key?.fill(0); workspace?.cleanup(); }
  });
}
export async function restoreProductionBackupIsolated(options) {
  return guardProductionBackup(async () => {
    closed(options, ['backupPath', 'destinationDirectory', 'key', 'maxBytes'], ['backupPath', 'destinationDirectory', 'key']);
    const maximum = limit(options.maxBytes); canonicalPath(options.destinationDirectory); privateDirectory(dirname(options.destinationDirectory));
    if (statMaybe(options.destinationDirectory)) fail('TARGET_EXISTS');
    let workspace, key;
    try {
      key = copyKey(options.key); workspace = makeWorkspace(dirname(options.destinationDirectory));
      const restored = openArchive(options.backupPath, key, workspace, maximum), after = quarantine(restored, workspace);
      const digest = fileDigest(restored.path, maximum);
      createIsolationDirectory(options.destinationDirectory);
      const marker = {
        format: RECOVERY_FORMAT, recoveryId: randomUUID(), createdAt: new Date().toISOString(), databaseName: PRODUCTION_RECOVERY_DATABASE,
        originalSnapshot: restored.inspection, quarantinedSnapshot: after, quarantinedDatabaseSha256: digest.sha256,
        encryptedBackupSha256: restored.encryptedSha256, sessionsCleared: true, allPortalBindingsDisabled: true,
        capturedConsumedNoncesRetained: true, productionReady: false, oldSigningKeyMayBeReused: false,
        activationRequirements: RECOVERY_REQUIREMENTS,
      };
      // Publish the pending guard before the isolated database can be opened.
      newPrivateJson(join(options.destinationDirectory, PRODUCTION_RECOVERY_MARKER), marker);
      publishNewPrivateFile(restored.path, join(options.destinationDirectory, PRODUCTION_RECOVERY_DATABASE), restored.identity);
      return Object.freeze({ ok: true, operation: 'restore-isolated', tableCount: 13, recoveryId: marker.recoveryId, sessionsCleared: true, allPortalBindingsDisabled: true, productionReady: false, recoveryPending: true });
    } finally { key?.fill(0); workspace?.cleanup(); }
  });
}

/** Call before DatabaseSync/initDb on every runtime entrypoint, including direct createApp. */
export function assertProductionRecoveryStartAllowed(databasePath) {
  if (databasePath === ':memory:') return;
  try {
    if (typeof databasePath !== 'string' || !databasePath || /[\x00-\x1f\x7f]/.test(databasePath)) fail('UNSAFE_PATH');
    const lexical = resolve(databasePath), paths = new Set([lexical]);
    // Preserve ordinary runtime path compatibility while also detecting a
    // pending recovery reached through a directory/file alias.
    if (statMaybe(lexical)) paths.add(realpathSync(lexical));
    else if (statMaybe(dirname(lexical))) paths.add(join(realpathSync(dirname(lexical)), lexical.slice(dirname(lexical).length + 1)));
    if ([...paths].some(path => basename(path) === PRODUCTION_RECOVERY_DATABASE || statMaybe(join(dirname(path), PRODUCTION_RECOVERY_MARKER)))) fail('RECOVERY_PENDING');
  } catch (error) {
    if (error?.code === 'RECOVERY_PENDING') throw error;
    fail('UNSAFE_PATH');
  }
}

function restoreMarker(directory, maximum) {
  privateDirectory(directory);
  const path = join(directory, PRODUCTION_RECOVERY_DATABASE);
  const raw = readPrivateBytes(join(directory, PRODUCTION_RECOVERY_MARKER), PROOF_LIMIT); let marker;
  try { marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { fail('RESTORE_CHANGED'); }
  closed(marker, ['format', 'recoveryId', 'createdAt', 'databaseName', 'originalSnapshot', 'quarantinedSnapshot', 'quarantinedDatabaseSha256', 'encryptedBackupSha256', 'sessionsCleared', 'allPortalBindingsDisabled', 'capturedConsumedNoncesRetained', 'productionReady', 'oldSigningKeyMayBeReused', 'activationRequirements']);
  if (marker.format !== RECOVERY_FORMAT || marker.databaseName !== PRODUCTION_RECOVERY_DATABASE || marker.productionReady !== false || marker.oldSigningKeyMayBeReused !== false || marker.sessionsCleared !== true || marker.allPortalBindingsDisabled !== true || marker.capturedConsumedNoncesRetained !== true || !UUID.test(marker.recoveryId) || !digestValid(marker.quarantinedDatabaseSha256)) fail('RESTORE_CHANGED');
  if (!isDeepStrictEqual(marker.activationRequirements, RECOVERY_REQUIREMENTS)) fail('RESTORE_CHANGED');
  noSidecars(path);
  if (fileDigest(path, maximum).sha256 !== marker.quarantinedDatabaseSha256) fail('RESTORE_CHANGED');
  const actual = inspectClosed(path); assertInspectionEqual(actual, marker.quarantinedSnapshot);
  if (actual.tables.sessions.count !== 0 || actual.schemaSha256 !== marker.originalSnapshot?.schemaSha256) fail('RESTORE_CHANGED');
  for (const name of Object.keys(actual.tables)) if (!SECURITY_CHANGED.has(name) && !isDeepStrictEqual(actual.tables[name], marker.originalSnapshot?.tables?.[name])) fail('RESTORE_CHANGED');
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  try { if (db.prepare('SELECT 1 FROM portal_identity_bindings WHERE active<>0 LIMIT 1').get()) fail('RESTORE_CHANGED'); }
  finally { db.close(); }
  return { marker, path };
}
function membershipCandidates(restoredPath, authorityPath) {
  let staged, authority;
  try {
    staged = new sqlite.DatabaseSync(restoredPath, { readOnly: true });
    authority = new sqlite.DatabaseSync(authorityPath, { readOnly: true });
    const result = [];
    for (const member of staged.prepare('SELECT org_id,user_id,role,employee_id FROM memberships ORDER BY org_id,user_id').iterate()) {
      if (!UUID.test(member.org_id) || !UUID.test(member.user_id) || !ROLES.has(member.role) || (member.employee_id !== null && !UUID.test(member.employee_id))) fail('AUTHORITY_UNCONFIRMED');
      const current = authority.prepare('SELECT role,employee_id FROM memberships WHERE org_id=? AND user_id=?').get(member.org_id, member.user_id);
      let decision = 'CURRENT_MEMBERSHIP_MISSING';
      if (current) {
        try {
          if (!accountMembershipActive(authority, member.org_id, member.user_id)) decision = 'CURRENTLY_SUSPENDED';
          else if (current.role !== member.role || current.employee_id !== member.employee_id) decision = 'ROLE_OR_EMPLOYEE_CHANGED';
          else {
            const fields = ['issuer', 'google_subject', 'portal_auth_user_id', 'email', 'user_id', 'org_id'];
            const projection = fields.map(k => 'hex(CAST(' + k + ' AS BLOB)) AS ' + k).join(',');
            const a = staged.prepare('SELECT ' + projection + ' FROM portal_identity_bindings WHERE user_id=? AND org_id=?').get(member.user_id, member.org_id);
            const b = authority.prepare('SELECT ' + projection + ' FROM portal_identity_bindings WHERE user_id=? AND org_id=? AND active=1').get(member.user_id, member.org_id);
            decision = a && b && isDeepStrictEqual(a, b) ? 'REQUIRES_FRESH_AUTHORITY_ATTESTATION_AND_EXPLICIT_GRANT' : 'IDENTITY_MISMATCH_OR_DISABLED';
            if (current.role === 'caregiver') {
              const employee = authority.prepare("SELECT data FROM records WHERE id=? AND org_id=? AND entity='employees'").get(current.employee_id, member.org_id);
              if (!employee || JSON.parse(employee.data).status !== 'active') decision = 'CURRENT_EMPLOYEE_INACTIVE_OR_MISSING';
            }
          }
        } catch { decision = 'CURRENT_STATE_INVALID'; }
      }
      result.push({ userId: member.user_id, orgId: member.org_id, snapshotRole: member.role, snapshotEmployeeId: member.employee_id, decision, enableGrant: false });
    }
    return result;
  } finally { authority?.close(); staged?.close(); }
}
export async function prepareProductionRecoveryReconciliation(options) {
  return guardProductionBackup(async () => {
    closed(options, ['destinationDirectory', 'authorityDatabasePath', 'maxBytes'], ['destinationDirectory']);
    const maximum = limit(options.maxBytes), restored = restoreMarker(options.destinationDirectory, maximum);
    const planPath = join(options.destinationDirectory, PLAN_NAME); requireNewFile(planPath);
    let workspace, authority, candidates = [];
    try {
      if (options.authorityDatabasePath !== undefined) {
        if (options.authorityDatabasePath === restored.path) fail('AUTHORITY_UNCONFIRMED');
        workspace = makeWorkspace(options.destinationDirectory);
        authority = await captureCommitted(options.authorityDatabasePath, workspace, maximum);
        candidates = membershipCandidates(restored.path, authority.path);
      }
      const plan = {
        format: 'suiyue-production-reconciliation-preparation-v1', recoveryId: restored.marker.recoveryId, preparedAt: new Date().toISOString(),
        authorityDatabaseProvided: Boolean(authority), authoritySnapshotFingerprint: authority?.inspection.fingerprint || null,
        freshAuthorityAttested: false, providerAuthorityValidated: false, candidateGrants: candidates, grantsEnabled: 0,
        quarantineDatabaseSha256: restored.marker.quarantinedDatabaseSha256, productionReady: false, recoveryPending: true,
        oldSigningKeyMayBeReused: false, activationRequirements: restored.marker.activationRequirements,
      };
      // Recheck the stage after preparing; no identity is enabled or merged here.
      restoreMarker(options.destinationDirectory, maximum); newPrivateJson(planPath, plan);
      return Object.freeze({ ok: true, operation: 'prepare-reconcile', authorityDatabaseProvided: Boolean(authority), grantsEnabled: 0, productionReady: false, recoveryPending: true });
    } finally { workspace?.cleanup(); }
  });
}
