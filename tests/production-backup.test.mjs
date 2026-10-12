import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, readdirSync, chmodSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, linkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, insert } from '../src/server/model.mjs';
import { initPortalStorage, portalMembershipForUser } from '../src/server/portal-handoff.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';
import { inspectProductionDatabase } from '../src/server/production-backup-inspection.mjs';
import {
  createProductionBackup, verifyProductionBackup, restoreProductionBackupIsolated,
  prepareProductionRecoveryReconciliation, assertProductionRecoveryStartAllowed,
  readProductionEncryptionKeyFile, PRODUCTION_RECOVERY_DATABASE, PRODUCTION_RECOVERY_MARKER,
} from '../src/server/production-backup.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rejects = code => error => error?.name === 'ProductionBackupError' && (!code || error.code === code);
const privateModes = directory => { for (const name of readdirSync(directory)) if (statSync(join(directory, name)).isFile()) chmodSync(join(directory, name), 0o600); };
function fixture(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'homecare-production-backup-owned-'));
  const databasePath = join(directory, 'source.sqlite'), db = new DatabaseSync(databasePath), key = randomBytes(32);
  initDb(db); initPortalStorage(db); db.exec('PRAGMA wal_autocheckpoint=0');
  const orgId = randomUUID(), adminId = randomUUID(), supervisorId = randomUUID(), stamp = '2026-10-12T00:00:00.000Z';
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成機構\u0000完整尾字', stamp);
  for (const [userId, role] of [[adminId, 'admin'], [supervisorId, 'supervisor']]) {
    const email = 'synthetic-' + role + '@example.invalid';
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId, '合成' + role, email, '!portal-only!', stamp);
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, userId, role, null);
    db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run('https://synthetic.example.invalid', 'synthetic-subject-' + role, randomUUID(), email, userId, orgId, 1, stamp);
  }
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('synthetic-cookie-hash', supervisorId, 'synthetic-csrf\u0000完整', 9223372036854775807n);
  const caseItem = insert(db, orgId, 'cases', { name: '合成個案', caseNo: 'SYN-PROD-BACKUP', note: '保存JSON\u0000尾' });
  const record = insert(db, orgId, 'service-records', { caseId: caseItem.id, note: '合成快照', billingSnapshot: { priceCents: 10001, ruleVersion: 1, neverAnActualPayment: true } });
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), orgId, adminId, 'synthetic-only', 'service-records', record.id, '{"number":1.2500,"text":"尾\\u0000"}', stamp);
  db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run(orgId, adminId, 'synthetic-action-key', 'POST /synthetic-only', 'synthetic-hash', '{"amount":1.2500}', 201, stamp);
  db.prepare('INSERT INTO demo_seeds VALUES(?,?)').run(orgId, stamp);
  const blob = Buffer.from([0, 255, 128, 10, 13, 1]);
  db.prepare('INSERT INTO attachment_files VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), orgId, caseItem.id, caseItem.id, '合成.pdf', 'application/pdf', blob.length, sha(blob), blob, stamp);
  db.prepare('INSERT INTO certification_attachment_files VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), orgId, caseItem.id, caseItem.id, caseItem.id, '合成.png', 'image/png', blob.length, sha(blob), blob, stamp);
  const nonceId = randomUUID();
  db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run(nonceId, 'https://synthetic.example.invalid', supervisorId, orgId, 1.25, 9223372036854775807n);
  privateModes(directory);
  t.after(() => { db.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); });
  return { directory, databasePath, db, key, orgId, adminId, supervisorId, nonceId, record, backupPath: join(directory, 'archive.hcb') };
}
async function backup(f) { return createProductionBackup({ databasePath: f.databasePath, outputPath: f.backupPath, key: f.key }); }
async function restore(f, name = 'isolation') {
  const destinationDirectory = join(f.directory, name);
  const result = await restoreProductionBackupIsolated({ backupPath: f.backupPath, destinationDirectory, key: f.key });
  return { directory: destinationDirectory, path: join(destinationDirectory, PRODUCTION_RECOVERY_DATABASE), result };
}
function readProof(path) { const db = new DatabaseSync(path, { readOnly: true }); try { return inspectProductionDatabase(db); } finally { db.close(); } }

test('real operator-path backup includes committed WAL, all13 tables, typed bytes and zero source writes', async t => {
  const f = fixture(t), original = inspectProductionDatabase(f.db), main = readFileSync(f.databasePath), wal = readFileSync(f.databasePath + '-wal');
  const changes = f.db.prepare('SELECT total_changes() AS n').get().n;
  // The currently uncommitted writer update must never appear in the backup.
  f.db.exec('BEGIN IMMEDIATE'); f.db.prepare('UPDATE organizations SET name=? WHERE id=?').run('synthetic-uncommitted', f.orgId);
  const keyBefore = Buffer.from(f.key);
  const result = await backup(f); assert.equal(result.verified, true); assert.equal(result.tableCount, 13);
  f.db.exec('ROLLBACK');
  assert(f.key.equals(keyBefore)); keyBefore.fill(0);
  assert(readFileSync(f.databasePath).equals(main)); assert(readFileSync(f.databasePath + '-wal').equals(wal));
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes + 1);
  const cipher = readFileSync(f.backupPath);
  assert.equal(result.encryptedSha256, sha(cipher)); assert(!cipher.includes(Buffer.from('SQLite format 3'))); assert(!cipher.includes(Buffer.from('SYN-PROD-BACKUP'))); assert(!cipher.includes(f.key));
  assert.equal((await verifyProductionBackup({ backupPath: f.backupPath, key: f.key })).verified, true);
  const stage = await restore(f), actual = readProof(stage.path);
  for (const table of Object.keys(original.tables)) if (!['sessions', 'portal_identity_bindings'].includes(table)) assert.deepEqual(actual.tables[table], original.tables[table], table);
  assert.equal(actual.tables.sessions.count, 0); assert.deepEqual(actual.blobSha256, original.blobSha256); assert.equal(actual.versionsSha256, original.versionsSha256);
  assert.equal(statSync(f.backupPath).mode & 0o777, 0o600); assert.equal(statSync(stage.directory).mode & 0o777, 0o700); assert.equal(statSync(stage.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory).filter(x => x.startsWith('.homecare-backup-')), []);
});

test('isolation never revives a cookie or binding; captured nonces remain and post-snapshot revocation is prepared but not auto-enabled', async t => {
  const f = fixture(t); await backup(f);
  f.db.exec('BEGIN IMMEDIATE');
  try { commitAccountChange(f.db, { orgId: f.orgId, role: 'admin', user: { id: f.adminId } }, f.supervisorId, { version: 0, role: 'supervisor', employeeId: null, status: 'suspended', reason: '合成快照後撤權' }); f.db.exec('COMMIT'); }
  catch (error) { f.db.exec('ROLLBACK'); throw error; }
  f.db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run(randomUUID(), 'https://synthetic.example.invalid', f.adminId, f.orgId, 2, 1000);
  const current = inspectProductionDatabase(f.db), stage = await restore(f), restored = new DatabaseSync(stage.path, { readOnly: true });
  try {
    assert.equal(restored.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.equal(restored.prepare('SELECT count(*) AS n FROM portal_identity_bindings WHERE active<>0').get().n, 0);
    assert.equal(portalMembershipForUser(restored, f.supervisorId), null);
    assert.equal(restored.prepare('SELECT count(*) AS n FROM portal_handoff_nonces').get().n, 1);
    assert(restored.prepare('SELECT 1 FROM portal_handoff_nonces WHERE jti=?').get(f.nonceId));
  } finally { restored.close(); }
  assert.throws(() => assertProductionRecoveryStartAllowed(stage.path), rejects('RECOVERY_PENDING'));
  const result = await prepareProductionRecoveryReconciliation({ destinationDirectory: stage.directory, authorityDatabasePath: f.databasePath });
  assert.equal(result.grantsEnabled, 0); assert.equal(result.productionReady, false);
  const plan = JSON.parse(readFileSync(join(stage.directory, 'RECOVERY_RECONCILIATION_PLAN.json')));
  assert.equal(plan.freshAuthorityAttested, false); assert.equal(plan.providerAuthorityValidated, false); assert.equal(plan.oldSigningKeyMayBeReused, false);
  assert.equal(plan.candidateGrants.find(x => x.userId === f.supervisorId).decision, 'CURRENTLY_SUSPENDED');
  assert(plan.candidateGrants.every(x => x.enableGrant === false)); assert.deepEqual(inspectProductionDatabase(f.db), current);
  assert.throws(() => assertProductionRecoveryStartAllowed(stage.path), rejects('RECOVERY_PENDING'));
});

test('missing current authority only creates a blocked preparation, never an activation or inferred grant', async t => {
  const f = fixture(t); await backup(f); const stage = await restore(f);
  const result = await prepareProductionRecoveryReconciliation({ destinationDirectory: stage.directory });
  assert.deepEqual(result, { ok: true, operation: 'prepare-reconcile', authorityDatabaseProvided: false, grantsEnabled: 0, productionReady: false, recoveryPending: true });
  const plan = JSON.parse(readFileSync(join(stage.directory, 'RECOVERY_RECONCILIATION_PLAN.json')));
  assert.deepEqual(plan.candidateGrants, []); assert.equal(plan.productionReady, false);
  assert.throws(() => assertProductionRecoveryStartAllowed(stage.path), rejects('RECOVERY_PENDING'));
});

test('bad key/tag/header/truncation never publishes an isolated directory or parses an unauthenticated database', async t => {
  const f = fixture(t); await backup(f); const original = readFileSync(f.backupPath);
  await assert.rejects(verifyProductionBackup({ backupPath: f.backupPath, key: randomBytes(32) }), rejects('AUTHENTICATION_FAILED'));
  for (const [name, mutate] of [
    ['tag', b => { b[b.length - 1] ^= 1; return b; }],
    ['cipher', b => { b[b.length - 40] ^= 1; return b; }],
    ['header', b => { b[0] ^= 1; return b; }],
    ['truncated', b => b.subarray(0, 24)],
  ]) {
    const path = join(f.directory, name + '.hcb'); writeFileSync(path, mutate(Buffer.from(original)), { mode: 0o600 });
    const destination = join(f.directory, name + '-isolation');
    await assert.rejects(restoreProductionBackupIsolated({ backupPath: path, destinationDirectory: destination, key: f.key }), rejects());
    assert(!readdirSync(f.directory).includes(name + '-isolation'));
  }
  assert(readFileSync(f.backupPath).equals(original)); assert.deepEqual(readdirSync(f.directory).filter(x => x.startsWith('.homecare-backup-')), []);
});

test('existing backup, directory, occupied sidecar and recovery preparation are never overwritten', async t => {
  const f = fixture(t); await backup(f); const old = readFileSync(f.backupPath);
  await assert.rejects(backup(f), rejects('TARGET_EXISTS')); assert(readFileSync(f.backupPath).equals(old));
  const stage = await restore(f); const before = readFileSync(stage.path);
  await assert.rejects(restoreProductionBackupIsolated({ backupPath: f.backupPath, destinationDirectory: stage.directory, key: f.key }), rejects('TARGET_EXISTS')); assert(readFileSync(stage.path).equals(before));
  await prepareProductionRecoveryReconciliation({ destinationDirectory: stage.directory });
  const planPath = join(stage.directory, 'RECOVERY_RECONCILIATION_PLAN.json'), plan = readFileSync(planPath);
  await assert.rejects(prepareProductionRecoveryReconciliation({ destinationDirectory: stage.directory }), rejects('TARGET_EXISTS')); assert(readFileSync(planPath).equals(plan));
});

test('unsafe source alias, hardlink, permissions and WAL/shm/journal aliases fail before output creation', async t => {
  const f = fixture(t), alias = join(f.directory, 'source-alias.sqlite'); symlinkSync(f.databasePath, alias);
  await assert.rejects(createProductionBackup({ databasePath: alias, outputPath: f.backupPath, key: f.key }), rejects('UNSAFE_PATH'));
  rmSync(alias); linkSync(f.databasePath, alias);
  await assert.rejects(backup(f), rejects('UNSAFE_PATH')); rmSync(alias);
  chmodSync(f.databasePath, 0o640); await assert.rejects(backup(f), rejects('UNSAFE_PATH')); chmodSync(f.databasePath, 0o600);
  const foreign = join(f.directory, 'synthetic-no-secret'); writeFileSync(foreign, 'owned-only', { mode: 0o600 });
  const journal = f.databasePath + '-journal'; symlinkSync(foreign, journal);
  await assert.rejects(backup(f), rejects('UNSAFE_PATH')); rmSync(journal);
  linkSync(foreign, journal); await assert.rejects(backup(f), rejects('UNSAFE_PATH')); rmSync(journal);
  writeFileSync(journal, '', { mode: 0o640 }); await assert.rejects(backup(f), rejects('UNSAFE_PATH')); rmSync(journal);
  assert(!readdirSync(f.directory).includes('archive.hcb'));
  // An invalid owned main file proves each sidecar is refused before SQLite
  // can open/parse it; no actual WAL/shm of the active fixture is replaced.
  const leaseOnly = join(f.directory, 'lease-only.sqlite'); writeFileSync(leaseOnly, 'owned-not-a-database', { mode: 0o600 });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = leaseOnly + suffix, options = { databasePath: leaseOnly, outputPath: f.backupPath, key: f.key };
    symlinkSync(foreign, sidecar); await assert.rejects(createProductionBackup(options), rejects('UNSAFE_PATH')); rmSync(sidecar);
    linkSync(foreign, sidecar); await assert.rejects(createProductionBackup(options), rejects('UNSAFE_PATH')); rmSync(sidecar);
    writeFileSync(sidecar, 'owned-only', { mode: 0o640 }); await assert.rejects(createProductionBackup(options), rejects('UNSAFE_PATH')); rmSync(sidecar);
  }
});

test('private output parents, raw32 key-file safety and closed API reject unsafe permissions and options', async t => {
  const f = fixture(t), keyPath = join(f.directory, 'key.bin'); writeFileSync(keyPath, f.key, { mode: 0o600 });
  const loaded = readProductionEncryptionKeyFile(keyPath); assert(loaded.equals(f.key)); loaded.fill(0);
  chmodSync(keyPath, 0o640); assert.throws(() => readProductionEncryptionKeyFile(keyPath), rejects('UNSAFE_PATH')); chmodSync(keyPath, 0o600);
  const keyAlias = join(f.directory, 'key-alias'); symlinkSync(keyPath, keyAlias); assert.throws(() => readProductionEncryptionKeyFile(keyAlias), rejects('UNSAFE_PATH'));
  const openParent = join(f.directory, 'public-parent'); mkdirSync(openParent, { mode: 0o755 });
  await assert.rejects(createProductionBackup({ databasePath: f.databasePath, outputPath: join(openParent, 'backup'), key: f.key }), rejects('UNSAFE_PATH'));
  await assert.rejects(createProductionBackup({ databasePath: f.databasePath, outputPath: f.backupPath, key: f.key, force: true }), rejects('INVALID_ARGUMENT'));
  await assert.rejects(createProductionBackup({ databasePath: f.databasePath, outputPath: f.backupPath, key: Buffer.alloc(31) }), rejects('KEY_INVALID'));
  await assert.rejects(createProductionBackup({ databasePath: f.databasePath, outputPath: f.backupPath, key: f.key, maxBytes: 4096 }), rejects('CAPACITY_EXCEEDED'));
  await assert.rejects(createProductionBackup({ databasePath: f.databasePath, outputPath: f.backupPath, key: f.key, maxBytes: 64 * 1024 ** 3 }), rejects('INVALID_ARGUMENT'));
});

test('pending runtime guard catches direct paths and aliases but preserves memory and ordinary runtime paths', async t => {
  const f = fixture(t); assert.doesNotThrow(() => assertProductionRecoveryStartAllowed(':memory:')); assert.doesNotThrow(() => assertProductionRecoveryStartAllowed(f.databasePath));
  await backup(f); const stage = await restore(f), alias = join(f.directory, 'restore-alias.sqlite'); symlinkSync(stage.path, alias);
  assert.throws(() => assertProductionRecoveryStartAllowed(alias), rejects('RECOVERY_PENDING'));
  rmSync(join(stage.directory, PRODUCTION_RECOVERY_MARKER));
  assert.throws(() => assertProductionRecoveryStartAllowed(stage.path), rejects('RECOVERY_PENDING'));
  assert.throws(() => assertProductionRecoveryStartAllowed(alias), rejects('RECOVERY_PENDING'));
  const malformedMarkerDirectory = join(f.directory, 'pending-empty'); mkdirSync(malformedMarkerDirectory, { mode: 0o700 });
  writeFileSync(join(malformedMarkerDirectory, PRODUCTION_RECOVERY_MARKER), 'malformed-not-authority', { mode: 0o600 });
  assert.throws(() => assertProductionRecoveryStartAllowed(join(malformedMarkerDirectory, 'not-created.sqlite')), rejects('RECOVERY_PENDING'));
});

test('post-restore mutation or sidecar refuses reconciliation and cannot remove the pending guard', async t => {
  const f = fixture(t); await backup(f); const stage = await restore(f);
  const db = new DatabaseSync(stage.path); try { db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('synthetic-injected-session', f.adminId, 'synthetic-csrf', 10000); } finally { db.close(); }
  await assert.rejects(prepareProductionRecoveryReconciliation({ destinationDirectory: stage.directory }), rejects('RESTORE_CHANGED'));
  assert.throws(() => assertProductionRecoveryStartAllowed(stage.path), rejects('RECOVERY_PENDING'));
  assert(!readdirSync(stage.directory).includes('RECOVERY_RECONCILIATION_PLAN.json'));
});

test('independent backups randomize encryption and complete storage verification refuses an extra table', async t => {
  const f = fixture(t); await backup(f);
  const second = join(f.directory, 'second.hcb'); await createProductionBackup({ databasePath: f.databasePath, outputPath: second, key: f.key });
  assert(!readFileSync(second).equals(readFileSync(f.backupPath)));
  f.db.exec('CREATE TABLE unapproved_extension(value TEXT)');
  await assert.rejects(createProductionBackup({ databasePath: f.databasePath, outputPath: join(f.directory, 'unsupported.hcb'), key: f.key }), rejects('SCHEMA_MISMATCH'));
  assert(!readdirSync(f.directory).includes('unsupported.hcb'));
});

test('key byte length is intrinsic and caller Buffer hooks cannot substitute bytes or escape diagnostics', async t => {
  const f = fixture(t), tooShort = Buffer.alloc(16, 7);
  Object.defineProperty(tooShort, 'length', { value: 32 });
  await assert.rejects(createProductionBackup({ databasePath: f.databasePath, outputPath: f.backupPath, key: tooShort }), rejects('KEY_INVALID'));
  const key = Buffer.from(f.key); let hooks = 0;
  Object.defineProperty(key, 'length', { get() { hooks++; throw new Error('synthetic-secret-hook'); } });
  key.valueOf = () => { hooks++; throw new Error('synthetic-secret-hook'); };
  const result = await createProductionBackup({ databasePath: f.databasePath, outputPath: f.backupPath, key });
  assert.equal(result.verified, true); assert.equal(hooks, 0);
  assert.equal((await verifyProductionBackup({ backupPath: f.backupPath, key: f.key })).verified, true);
  Uint8Array.prototype.fill.call(key, 0);
});

test('a commit while the online backup awaits cannot move its pinned source snapshot', async t => {
  const f = fixture(t), before = inspectProductionDatabase(f.db);
  const operation = backup(f);
  // createProductionBackup reaches await sqlite.backup only after BEGIN/read.
  // This independent writer commits while that native backup is still awaited.
  f.db.prepare('UPDATE organizations SET name=? WHERE id=?').run('合成備份期間新提交', f.orgId);
  f.db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run(randomUUID(), 'https://synthetic.example.invalid', f.adminId, f.orgId, 100, 200);
  assert.equal((await operation).verified, true);
  const stage = await restore(f), proof = readProof(stage.path);
  assert.deepEqual(proof.tables.organizations, before.tables.organizations);
  assert.deepEqual(proof.tables.portal_handoff_nonces, before.tables.portal_handoff_nonces);
  assert.equal(inspectProductionDatabase(f.db).tables.portal_handoff_nonces.count, 2);
});

test('a forged private marker cannot claim that restored sessions or active bindings are quarantined', async t => {
  const f = fixture(t); await backup(f); const stage = await restore(f);
  const db = new DatabaseSync(stage.path); try { db.prepare('UPDATE portal_identity_bindings SET active=1 WHERE user_id=?').run(f.adminId); } finally { db.close(); }
  const markerPath = join(stage.directory, PRODUCTION_RECOVERY_MARKER), marker = JSON.parse(readFileSync(markerPath));
  marker.quarantinedDatabaseSha256 = sha(readFileSync(stage.path)); marker.quarantinedSnapshot = readProof(stage.path);
  writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
  await assert.rejects(prepareProductionRecoveryReconciliation({ destinationDirectory: stage.directory }), rejects('RESTORE_CHANGED'));
  assert.throws(() => assertProductionRecoveryStartAllowed(stage.path), rejects('RECOVERY_PENDING'));
});

test('current identity changes are compared by complete binding, never automatically granted by the same email', async t => {
  const f = fixture(t); await backup(f);
  f.db.prepare('UPDATE portal_identity_bindings SET google_subject=? WHERE user_id=?').run('synthetic-changed-subject', f.supervisorId);
  const stage = await restore(f);
  await prepareProductionRecoveryReconciliation({ destinationDirectory: stage.directory, authorityDatabasePath: f.databasePath });
  const plan = JSON.parse(readFileSync(join(stage.directory, 'RECOVERY_RECONCILIATION_PLAN.json')));
  assert.equal(plan.candidateGrants.find(x => x.userId === f.supervisorId).decision, 'IDENTITY_MISMATCH_OR_DISABLED');
  assert(plan.candidateGrants.every(x => x.enableGrant === false));
});
