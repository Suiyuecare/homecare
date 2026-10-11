import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createSyntheticWorkspace, syntheticDatabasePath, inspectSyntheticDatabase, captureSyntheticBackup, disposeSyntheticWorkspace } from './synthetic-backup.mjs';

// Deliberately unmounted: capabilities can only own newly created synthetic
// scratch roots. This module never accepts existing paths or a schema profile.
const workspaces = new WeakMap();
const derive = promisify(scrypt);
const FORMAT = 'suiyue-synthetic-encrypted-sqlite-v1';
const DB_LIMIT = 32 * 1024 * 1024, ENVELOPE_LIMIT = 48 * 1024 * 1024, PROOF_LIMIT = 64 * 1024;
const TABLES = ['attachment_files', 'audit', 'certification_attachment_files', 'demo_seeds', 'idempotency', 'memberships', 'organizations', 'record_versions', 'records', 'sessions', 'users'];
const PROOF_KEYS = ['format', 'tableCount', 'triggerCount', 'userVersion', 'applicationId', 'schemaSha256', 'tables', 'blobSha256', 'versionsSha256', 'billingSnapshotsSha256', 'fingerprint', 'mainFileSha256', 'mainFileBytes'];
const SUFFIXES = ['-wal', '-shm', '-journal'];
const MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Unsupported synthetic encrypted backup argument.', WORKSPACE_INVALID: 'Synthetic encrypted workspace capability is invalid.',
  UNSAFE_PATH: 'Synthetic scratch file identity is unsafe.', SLOT_MISSING: 'Required synthetic scratch slot is missing.', TARGET_EXISTS: 'Synthetic target must be new.',
  SIDECAR_PRESENT: 'Closed synthetic database has a journal sidecar.', CAPACITY_EXCEEDED: 'Synthetic backup exceeds a declared technical capacity.',
  PASSPHRASE_INVALID: 'Synthetic passphrase input is invalid.', ENVELOPE_INVALID: 'Synthetic encrypted envelope is invalid.', PROOF_INVALID: 'Synthetic backup proof is invalid.',
  AUTHENTICATION_FAILED: 'Synthetic encrypted backup authentication failed.', BACKUP_CHANGED: 'Synthetic encrypted backup has changed.', RESTORE_CHANGED: 'Synthetic restored candidate has changed.',
  PROMOTION_FAILED: 'Synthetic promotion failed; retained generations require inspection.', ROLLBACK_FAILED: 'Synthetic rollback failed; retained generations require inspection.',
  SQLITE_VERIFICATION_FAILED: 'Synthetic SQLite inspection failed.', SCRATCH_OPERATION_FAILED: 'Synthetic scratch operation failed.'
});
class EncryptedBackupError extends Error {
  constructor(code) { super(MESSAGES[code]); this.name = 'SyntheticEncryptedBackupError'; this.code = code; }
}
const fail = code => { throw new EncryptedBackupError(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value), 'utf8');
const arity = (actual, expected) => { if (actual !== expected) fail('INVALID_ARGUMENT'); };
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get;
const typedSet = Uint8Array.prototype.set;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
function closed(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) fail(code);
  for (const key of keys) if (!descriptors[key] || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) fail(code);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function proofProjection(value) {
  const p = closed(value, PROOF_KEYS, 'PROOF_INVALID');
  if (p.format !== 'suiyue-synthetic-sqlite-inspection-v1' || p.tableCount !== 11 || p.triggerCount !== 6 || !safeInteger(p.userVersion) || !safeInteger(p.applicationId) || !safeInteger(p.mainFileBytes) || p.mainFileBytes < 100) fail('PROOF_INVALID');
  for (const key of ['schemaSha256', 'versionsSha256', 'billingSnapshotsSha256', 'fingerprint', 'mainFileSha256']) if (!hex(p[key])) fail('PROOF_INVALID');
  const tableInput = closed(p.tables, TABLES, 'PROOF_INVALID'), tables = {};
  for (const name of TABLES) {
    const row = closed(tableInput[name], ['count', 'sha256'], 'PROOF_INVALID');
    if (!safeInteger(row.count) || !hex(row.sha256)) fail('PROOF_INVALID');
    tables[name] = row;
  }
  const blobs = closed(p.blobSha256, ['attachment_files', 'certification_attachment_files'], 'PROOF_INVALID');
  if (!hex(blobs.attachment_files) || !hex(blobs.certification_attachment_files)) fail('PROOF_INVALID');
  const content = { tableCount: 11, triggerCount: 6, userVersion: p.userVersion, applicationId: p.applicationId, schemaSha256: p.schemaSha256, tables, blobSha256: blobs, versionsSha256: p.versionsSha256, billingSnapshotsSha256: p.billingSnapshotsSha256 };
  if (hash(encode(content)) !== p.fingerprint) fail('PROOF_INVALID');
  return frozen({ format: p.format, ...content, fingerprint: p.fingerprint, mainFileSha256: p.mainFileSha256, mainFileBytes: p.mainFileBytes });
}
function bufferArgument(value, maximum, code) {
  if (!Buffer.isBuffer(value)) fail(code);
  const length = typedLength.call(value);
  if (length > maximum) fail('CAPACITY_EXCEEDED');
  return length;
}
function passphraseCopy(value) {
  if (!Buffer.isBuffer(value)) fail('PASSPHRASE_INVALID');
  const length = typedLength.call(value);
  if (length < 16 || length > 1024) fail('PASSPHRASE_INVALID');
  const copy = Buffer.alloc(length); typedSet.call(copy, value);
  try {
    if (copy.includes(0) || copy.includes(10) || copy.includes(13)) fail('PASSPHRASE_INVALID');
    try { new TextDecoder('utf-8', { fatal: true }).decode(copy); } catch { fail('PASSPHRASE_INVALID'); }
    return copy;
  } catch (error) { copy.fill(0); throw error; }
}
function safeBufferCopy(value, maximum, code) {
  const length = bufferArgument(value, maximum, code), copy = Buffer.alloc(length);
  typedSet.call(copy, value); return copy;
}
function canonicalBase64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('ENVELOPE_INVALID');
  if (length !== undefined && value.length !== 4 * Math.ceil(length / 3)) fail('ENVELOPE_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) fail('ENVELOPE_INVALID');
  return bytes;
}
function header(kdf, cipher) { return { format: FORMAT, version: 1, syntheticOnly: true, kdf, cipher: { name: 'aes-256-gcm', iv: cipher.iv } }; }
function parseEnvelope(bytes) {
  bufferArgument(bytes, ENVELOPE_LIMIT, 'ENVELOPE_INVALID');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('ENVELOPE_INVALID'); }
  const e = closed(parsed, ['format', 'version', 'syntheticOnly', 'kdf', 'cipher', 'ciphertext'], 'ENVELOPE_INVALID');
  if (e.format !== FORMAT || e.version !== 1 || e.syntheticOnly !== true) fail('ENVELOPE_INVALID');
  const kdf = closed(e.kdf, ['name', 'N', 'r', 'p', 'keyLength', 'salt'], 'ENVELOPE_INVALID');
  if (kdf.name !== 'scrypt' || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1 || kdf.keyLength !== 32) fail('ENVELOPE_INVALID');
  const cipher = closed(e.cipher, ['name', 'iv', 'tag'], 'ENVELOPE_INVALID');
  if (cipher.name !== 'aes-256-gcm') fail('ENVELOPE_INVALID');
  const salt = canonicalBase64(kdf.salt, 32), iv = canonicalBase64(cipher.iv, 12), tag = canonicalBase64(cipher.tag, 16);
  const ciphertext = canonicalBase64(e.ciphertext);
  if (ciphertext.length < 104 || ciphertext.length > DB_LIMIT + PROOF_LIMIT + 4) fail('CAPACITY_EXCEEDED');
  if (!encode({ format: FORMAT, version: 1, syntheticOnly: true, kdf, cipher, ciphertext: e.ciphertext }).equals(bytes)) fail('ENVELOPE_INVALID');
  return { kdf, cipher, salt, iv, tag, ciphertext };
}
async function asyncGuard(operation) {
  try { return await operation(); } catch (error) { if (error instanceof EncryptedBackupError) throw error; fail('SCRATCH_OPERATION_FAILED'); }
}
function syncGuard(operation) {
  try { return operation(); } catch (error) { if (error instanceof EncryptedBackupError) throw error; fail('SCRATCH_OPERATION_FAILED'); }
}
export async function sealSyntheticBackupBytes(bytes, proof, passphraseBuffer) {
  arity(arguments.length, 3);
  return asyncGuard(async () => {
    let password, key, plaintext, ownedBytes, proofBytes;
    try {
      ownedBytes = safeBufferCopy(bytes, DB_LIMIT, 'INVALID_ARGUMENT');
      const projected = proofProjection(proof); proofBytes = encode(projected);
      if (proofBytes.length > PROOF_LIMIT) fail('CAPACITY_EXCEEDED');
      if (ownedBytes.length !== projected.mainFileBytes || hash(ownedBytes) !== projected.mainFileSha256) fail('PROOF_INVALID');
      password = passphraseCopy(passphraseBuffer);
      const salt = randomBytes(32), iv = randomBytes(12);
      const kdf = { name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32, salt: salt.toString('base64') };
      const cipherMeta = { name: 'aes-256-gcm', iv: iv.toString('base64') };
      plaintext = Buffer.alloc(4 + proofBytes.length + ownedBytes.length);
      plaintext.writeUInt32BE(proofBytes.length); proofBytes.copy(plaintext, 4); ownedBytes.copy(plaintext, 4 + proofBytes.length);
      key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(encode(header(kdf, cipherMeta)));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return encode({ format: FORMAT, version: 1, syntheticOnly: true, kdf, cipher: { ...cipherMeta, tag: cipher.getAuthTag().toString('base64') }, ciphertext: ciphertext.toString('base64') });
    } finally { password?.fill(0); key?.fill(0); plaintext?.fill(0); ownedBytes?.fill(0); proofBytes?.fill(0); }
  });
}
export async function openSyntheticBackupBytes(envelopeBytes, passphraseBuffer) {
  arity(arguments.length, 2);
  return asyncGuard(async () => {
    let password, key, plaintext, decrypted, ownedEnvelope;
    try {
      ownedEnvelope = safeBufferCopy(envelopeBytes, ENVELOPE_LIMIT, 'ENVELOPE_INVALID');
      const e = parseEnvelope(ownedEnvelope);
      password = passphraseCopy(passphraseBuffer);
      key = await derive(password, e.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      try {
        const cipher = createDecipheriv('aes-256-gcm', key, e.iv); cipher.setAAD(encode(header(e.kdf, e.cipher))); cipher.setAuthTag(e.tag);
        // Keep unauthenticated output private and clear it even when final fails.
        decrypted = cipher.update(e.ciphertext);
        const final = cipher.final();
        try { plaintext = Buffer.concat([decrypted, final]); } finally { final.fill(0); }
      } catch { fail('AUTHENTICATION_FAILED'); }
      const length = plaintext.readUInt32BE(0);
      if (length > PROOF_LIMIT || length === 0 || plaintext.length - 4 - length < 100 || plaintext.length - 4 - length > DB_LIMIT) fail('PROOF_INVALID');
      const rawProof = plaintext.subarray(4, 4 + length);
      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawProof)); } catch { fail('PROOF_INVALID'); }
      const proof = proofProjection(parsed);
      if (!encode(proof).equals(rawProof)) fail('PROOF_INVALID');
      const database = plaintext.subarray(4 + length);
      if (database.length !== proof.mainFileBytes || hash(database) !== proof.mainFileSha256) fail('PROOF_INVALID');
      return { bytes: Buffer.from(database), proof };
    } finally { password?.fill(0); key?.fill(0); plaintext?.fill(0); decrypted?.fill(0); ownedEnvelope?.fill(0); }
  });
}

function statIfPresent(path) { try { return lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
function lease(stat) { return { dev: stat.dev, ino: stat.ino, uid: stat.uid }; }
function identical(stat, expected) { return stat && stat.dev === expected.dev && stat.ino === expected.ino && stat.uid === expected.uid; }
function stateOf(workspace) {
  const state = workspaces.get(workspace);
  if (!state || state.disposed) fail('WORKSPACE_INVALID');
  let stat;
  try { stat = lstatSync(state.root); } catch { fail('WORKSPACE_INVALID'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !identical(stat, state.identity) || realpathSync(state.root) !== state.realRoot || (stat.mode & 0o777) !== 0o700) fail('WORKSPACE_INVALID');
  return state;
}
function pathOf(state, slot) {
  if (slot === 'encrypted') return join(state.root, 'sealed-backup.json');
  if (typeof slot !== 'string' || !['source', 'backup', 'staged', 'live', 'previous'].includes(slot)) fail('INVALID_ARGUMENT');
  return syntheticDatabasePath(state.workspace, slot);
}
function regular(state, path, identity, missing = 'SLOT_MISSING') {
  stateOf(state.workspace);
  const stat = statIfPresent(path);
  if (!stat) fail(missing);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== state.identity.uid || (identity && !identical(stat, identity))) fail('UNSAFE_PATH');
  return stat;
}
function closedFile(state, path) {
  stateOf(state.workspace);
  if (SUFFIXES.some(suffix => statIfPresent(path + suffix))) fail('SIDECAR_PRESENT');
}
function newTarget(state, path) {
  stateOf(state.workspace);
  if (statIfPresent(path)) fail('TARGET_EXISTS');
  closedFile(state, path);
}
function ownedRead(state, path, maximum, identity) {
  const before = regular(state, path, identity);
  if (before.size > maximum) fail('CAPACITY_EXCEEDED');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fstatSync(fd);
    if (!identical(opened, lease(before)) || !opened.isFile() || opened.nlink !== 1) fail('UNSAFE_PATH');
    bytes = readFileSync(fd);
    const after = regular(state, path, lease(before)), final = fstatSync(fd);
    if (!identical(final, lease(before)) || after.size !== before.size || final.size !== before.size || bytes.length !== before.size) fail('UNSAFE_PATH');
    return { bytes, identity: lease(before), sha256: hash(bytes) };
  } catch (error) { bytes?.fill(0); throw error; } finally { closeSync(fd); }
}
function syncDirectory(state) {
  stateOf(state.workspace);
  const fd = openSync(state.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if (!identical(fstatSync(fd), state.identity)) fail('UNSAFE_PATH'); fsyncSync(fd); } finally { closeSync(fd); }
}
function removeOwn(state, path, identity) {
  try { if (identical(regular(state, path), identity)) { rmSync(path); syncDirectory(state); } } catch { /* Retain uncertain identities. */ }
}
function writeNew(state, path, bytes) {
  newTarget(state, path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = lease(fstatSync(fd));
  try {
    if (!identical(regular(state, path), identity)) fail('UNSAFE_PATH');
    writeFileSync(fd, bytes); fsyncSync(fd);
    regular(state, path, identity); syncDirectory(state);
    return identity;
  } catch (error) { removeOwn(state, path, identity); throw error; } finally { closeSync(fd); }
}
function inspected(state, slot) {
  try { return proofProjection(inspectSyntheticDatabase(state.workspace, slot)); }
  catch (error) { if (error instanceof EncryptedBackupError) throw error; fail('SQLITE_VERIFICATION_FAILED'); }
}
function sameProof(a, b) { return encode(a).equals(encode(b)); }
export function createSyntheticEncryptedWorkspace() {
  arity(arguments.length, 0);
  return syncGuard(() => {
    const workspace = createSyntheticWorkspace(), root = dirname(syntheticDatabasePath(workspace, 'source'));
    workspaces.set(workspace, { workspace, root, realRoot: realpathSync(root), identity: lease(lstatSync(root)), disposed: false, restored: new Map(), encrypted: null });
    return workspace;
  });
}
export function syntheticEncryptedDatabasePath(workspace, slot) {
  arity(arguments.length, 2); return syncGuard(() => pathOf(stateOf(workspace), slot));
}
export async function captureEncryptedSyntheticBackup(workspace, passphraseBuffer) {
  arity(arguments.length, 2);
  return asyncGuard(async () => {
    const state = stateOf(workspace), encryptedPath = pathOf(state, 'encrypted'), backupPath = pathOf(state, 'backup'), manifestPath = join(state.root, 'backup.manifest.json');
    newTarget(state, encryptedPath); newTarget(state, backupPath); newTarget(state, manifestPath);
    const preflight = passphraseCopy(passphraseBuffer); preflight.fill(0);
    let backup, encryptedIdentity, backupIdentity, manifestIdentity;
    try {
      captureSyntheticBackup(workspace);
      backupIdentity = lease(regular(state, backupPath)); manifestIdentity = lease(regular(state, manifestPath));
      closedFile(state, backupPath);
      const proof = inspected(state, 'backup');
      backup = ownedRead(state, backupPath, DB_LIMIT, backupIdentity);
      const envelope = await sealSyntheticBackupBytes(backup.bytes, proof, passphraseBuffer);
      encryptedIdentity = writeNew(state, encryptedPath, envelope);
      const check = ownedRead(state, encryptedPath, ENVELOPE_LIMIT, encryptedIdentity);
      if (!check.bytes.equals(envelope)) fail('BACKUP_CHANGED');
      state.encrypted = { identity: encryptedIdentity, sha256: check.sha256 };
      regular(state, backupPath, backupIdentity); regular(state, manifestPath, manifestIdentity); closedFile(state, backupPath);
      rmSync(backupPath); rmSync(manifestPath); syncDirectory(state);
      return frozen({ format: FORMAT, syntheticOnly: true, plaintextDeleted: true, encryptedSha256: check.sha256, encryptedBytes: check.bytes.length, inspection: proof });
    } catch (error) {
      if (encryptedIdentity) removeOwn(state, encryptedPath, encryptedIdentity);
      if (backupIdentity) removeOwn(state, backupPath, backupIdentity);
      if (manifestIdentity) removeOwn(state, manifestPath, manifestIdentity);
      state.encrypted = null;
      throw error;
    } finally { backup?.bytes.fill(0); }
  });
}
export function readEncryptedSyntheticBackup(workspace) {
  arity(arguments.length, 1);
  return syncGuard(() => {
    const state = stateOf(workspace);
    if (!state.encrypted) fail('SLOT_MISSING');
    const read = ownedRead(state, pathOf(state, 'encrypted'), ENVELOPE_LIMIT, state.encrypted.identity);
    if (read.sha256 !== state.encrypted.sha256) fail('BACKUP_CHANGED');
    return read.bytes;
  });
}
export async function restoreEncryptedSyntheticBackup(workspace, envelopeBytes, passphraseBuffer, target) {
  arity(arguments.length, 4);
  return asyncGuard(async () => {
    const state = stateOf(workspace);
    if (!['staged', 'live'].includes(target)) fail('INVALID_ARGUMENT');
    const path = pathOf(state, target); newTarget(state, path);
    let opened, identity;
    try {
      opened = await openSyntheticBackupBytes(envelopeBytes, passphraseBuffer);
      identity = writeNew(state, path, opened.bytes);
      closedFile(state, path);
      const actual = inspected(state, target);
      if (!sameProof(actual, opened.proof)) fail('RESTORE_CHANGED');
      regular(state, path, identity); state.restored.set(target, { identity, proof: actual });
      return frozen({ status: 'restored', syntheticOnly: true, target, inspection: actual });
    } catch (error) { if (identity) removeOwn(state, path, identity); throw error; }
    finally { opened?.bytes.fill(0); }
  });
}
export function promoteEncryptedSyntheticRestore(workspace, options) {
  arity(arguments.length, 2);
  return syncGuard(() => {
    const state = stateOf(workspace), parsed = closed(options, ['failurePoint'], 'INVALID_ARGUMENT');
    if (!['none', 'after-live-retired', 'after-candidate-promoted'].includes(parsed.failurePoint)) fail('INVALID_ARGUMENT');
    const stage = pathOf(state, 'staged'), live = pathOf(state, 'live'), previous = pathOf(state, 'previous');
    const trusted = state.restored.get('staged'); if (!trusted) fail('RESTORE_CHANGED');
    newTarget(state, previous); closedFile(state, stage); closedFile(state, live);
    regular(state, stage, trusted.identity);
    const candidateProof = inspected(state, 'staged'); if (!sameProof(candidateProof, trusted.proof)) fail('RESTORE_CHANGED');
    const originalIdentity = lease(regular(state, live)), originalProof = inspected(state, 'live');
    let retired = false, promoted = false, injected = false;
    try {
      regular(state, live, originalIdentity); regular(state, stage, trusted.identity); newTarget(state, previous);
      renameSync(live, previous); retired = true; syncDirectory(state);
      if (parsed.failurePoint === 'after-live-retired') { injected = true; throw new Error('synthetic failure'); }
      regular(state, previous, originalIdentity); regular(state, stage, trusted.identity); newTarget(state, live);
      renameSync(stage, live); promoted = true; syncDirectory(state);
      if (parsed.failurePoint === 'after-candidate-promoted') { injected = true; throw new Error('synthetic failure'); }
      regular(state, live, trusted.identity); regular(state, previous, originalIdentity);
      if (!sameProof(inspected(state, 'live'), candidateProof) || !sameProof(inspected(state, 'previous'), originalProof)) fail('PROMOTION_FAILED');
      state.restored.delete('staged'); state.restored.set('live', trusted);
      return frozen({ status: 'promoted', syntheticOnly: true, originalLiveSha256: originalProof.mainFileSha256, candidateSha256: candidateProof.mainFileSha256, previousRetained: true });
    } catch {
      try {
        if (promoted) { regular(state, live, trusted.identity); newTarget(state, stage); renameSync(live, stage); syncDirectory(state); }
        if (retired) { regular(state, previous, originalIdentity); newTarget(state, live); renameSync(previous, live); syncDirectory(state); }
        regular(state, live, originalIdentity); regular(state, stage, trusted.identity);
        if (!sameProof(inspected(state, 'live'), originalProof) || !sameProof(inspected(state, 'staged'), candidateProof)) fail('ROLLBACK_FAILED');
      } catch { fail('ROLLBACK_FAILED'); }
      if (!injected) fail('PROMOTION_FAILED');
      return frozen({ status: 'rolled_back', syntheticOnly: true, failurePoint: parsed.failurePoint, originalInodeRestored: true, originalLiveSha256: originalProof.mainFileSha256, stagedSha256: candidateProof.mainFileSha256 });
    }
  });
}
export function disposeSyntheticEncryptedWorkspace(workspace) {
  arity(arguments.length, 1);
  return syncGuard(() => { const state = stateOf(workspace); disposeSyntheticWorkspace(workspace); state.disposed = true; state.restored.clear(); state.encrypted = null; });
}
