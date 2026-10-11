import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createApp } from '../src/server/index.mjs';
import { inspectSyntheticDatabase } from '../src/server/synthetic-backup.mjs';
import { createSyntheticEncryptedWorkspace, syntheticEncryptedDatabasePath, captureEncryptedSyntheticBackup, readEncryptedSyntheticBackup, restoreEncryptedSyntheticBackup, promoteEncryptedSyntheticRestore, disposeSyntheticEncryptedWorkspace } from '../src/server/synthetic-encrypted-backup.mjs';
import { createSyntheticBackupFixture, syntheticClient, readSyntheticRawState } from '../tests/synthetic-backup-fixtures.mjs';

// No operator path, argv secret, environment secret or HTTP surface exists.
// Refusing TTY prevents an interactive terminal from echoing an unmasked secret.
const invalidInput = code => Object.assign(new Error('Synthetic encrypted rehearsal input is invalid.'), { code });
async function stdinPassphrase() {
  if (process.stdin.isTTY) throw invalidInput('TTY_INPUT_REJECTED');
  const chunks = []; let size = 0, joined;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1026) { chunk.fill(0); throw invalidInput('STDIN_CAPACITY_EXCEEDED'); }
      chunks.push(Buffer.from(chunk)); chunk.fill(0);
    }
    joined = Buffer.concat(chunks);
    let length = joined.length;
    if (length && joined[length - 1] === 10) { length--; if (length && joined[length - 1] === 13) length--; }
    const value = joined.subarray(0, length);
    if (length < 16 || length > 1024 || value.includes(0) || value.includes(10) || value.includes(13)) throw invalidInput('PASSPHRASE_INVALID');
    try { new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { throw invalidInput('PASSPHRASE_INVALID'); }
    return Buffer.from(value);
  } finally { joined?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b, message) => assert(isDeepStrictEqual(a, b), message);
const identity = file => { const s = lstatSync(file); return { dev: s.dev, ino: s.ino, uid: s.uid, sha256: hash(readFileSync(file)) }; };
let workspace, source, liveApp, password, ciphertext, report, failureCode, disposed = false;
try {
  if (process.argv.length !== 2) throw invalidInput('CLI_ARGUMENTS_REJECTED');
  password = await stdinPassphrase();
  workspace = createSyntheticEncryptedWorkspace(); source = await createSyntheticBackupFixture({ workspace });
  const rawA = source.readRawState(), beforeChanges = source.app.db.prepare('SELECT total_changes() AS n').get().n;
  const capture = await captureEncryptedSyntheticBackup(workspace, password); ciphertext = readEncryptedSyntheticBackup(workspace);
  same(source.readRawState(), rawA, 'Capture preserves the committed source generation'); assert.equal(source.app.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
  const path = slot => syntheticEncryptedDatabasePath(workspace, slot), root = dirname(path('source'));
  assert(!existsSync(path('backup')) && !existsSync(join(root, 'backup.manifest.json')), 'No plaintext backup remains before decrypting');
  assert.equal(capture.inspection.tableCount, 11); assert.equal(capture.inspection.triggerCount, 6);
  await restoreEncryptedSyntheticBackup(workspace, ciphertext, password, 'live');
  const restored = inspectSyntheticDatabase(workspace, 'live');
  liveApp = createApp({ dbPath: path('live'), host: '127.0.0.1', port: 0 });
  same(readSyntheticRawState(liveApp.db), rawA, 'Encrypted-only startup retains complete original typed values'); assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
  const base = await liveApp.listen(), client = syntheticClient(base, 'encrypted-cli-admin', { cookie: source.sourceCookies.admin, auth: source.actors.admin.auth });
  for (const kind of ['fees', 'payroll']) same(await client.json('GET', `reports/${kind}?month=${source.month}`, undefined, { orgId: source.orgId }), source.expected.frozenReports[kind], 'Restored approved pricing is not recomputed');
  const beforeEdit = liveApp.db.prepare('SELECT total_changes() AS n').get().n;
  const edit = await client.json('PATCH', `cases/${source.items.case.id}`, { version: source.items.case.version, note: '合成加密演練 live 第二代\r\n完整原文保留' }, { orgId: source.orgId });
  assert.equal(edit.item.version, source.items.case.version + 1);
  const liveBusinessChanges = liveApp.db.prepare('SELECT total_changes() AS n').get().n - beforeEdit, rawB = readSyntheticRawState(liveApp.db);
  assert(liveBusinessChanges > 0); await liveApp.close(); liveApp = null;
  const original = identity(path('live'));
  await restoreEncryptedSyntheticBackup(workspace, ciphertext, password, 'staged');
  const candidate = identity(path('staged')), rollbacks = [];
  for (const failurePoint of ['after-live-retired', 'after-candidate-promoted']) {
    const rollback = promoteEncryptedSyntheticRestore(workspace, { failurePoint }); assert.equal(rollback.status, 'rolled_back');
    same(identity(path('live')), original, 'Actual rename rollback returns the original inode and closed bytes'); same(identity(path('staged')), candidate, 'Actual rename rollback retains the candidate'); assert(!existsSync(path('previous')));
    liveApp = createApp({ dbPath: path('live'), host: '127.0.0.1', port: 0 }); same(readSyntheticRawState(liveApp.db), rawB, 'Rollback restores complete live second generation'); assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
    await liveApp.close(); liveApp = null; rollbacks.push({ failurePoint, status: rollback.status, originalInodeRestored: true, originalBytesRestored: true });
  }
  const promotion = promoteEncryptedSyntheticRestore(workspace, { failurePoint: 'none' }); assert.equal(promotion.status, 'promoted'); same(identity(path('previous')), original, 'Success retains the complete original previous generation');
  liveApp = createApp({ dbPath: path('live'), host: '127.0.0.1', port: 0 }); same(readSyntheticRawState(liveApp.db), rawA, 'Final startup restores every source value from encrypted bytes'); assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
  await liveApp.close(); liveApp = null; same(source.readRawState(), rawA, 'Entire rehearsal preserves source'); assert.equal(source.app.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
  await source.close(); source = null; disposeSyntheticEncryptedWorkspace(workspace); disposed = true;
  report = { format: 'suiyue-synthetic-encrypted-rehearsal-v1', status: 'passed', syntheticOnly: true, runtime: process.version, passphraseInput: 'bounded-non-tty-stdin', encryptedFormat: capture.format,
    plaintextBackupDeletedBeforeRestore: true, cipherOnlyRestoreVerified: true, committedWalSourcePreserved: true, tableCount: 11, triggerCount: 6, fullTypedValuesAndTextNulExact: true,
    immutableBlobFamiliesExact: true, versionsAndSavedPricingExact: true, sourceTotalChangesUnchanged: true, restoredStartupChanges: 0, liveBusinessChanges, rollbacks,
    promotionStatus: promotion.status, previousOriginalInodeAndBytesRetained: true, encryptedSha256: capture.encryptedSha256, originalLiveClosedSha256: original.sha256,
    restoredFingerprint: restored.fingerprint, disposed: true, actual4310Accessed: false, portalProfileChanged: false, formalDeployment: false, formalKmsOrRecoveryPolicyApproved: false };
} catch (error) {
  // Only fixed sanitized codes leave the process; never driver paths or rows.
  failureCode = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'REHEARSAL_FAILED';
} finally {
  password?.fill(0); ciphertext?.fill(0);
  for (const resource of [liveApp, source]) if (resource) try { await resource.close(); } catch { failureCode = 'REHEARSAL_CLEANUP_FAILED'; }
  if (workspace && !disposed) try { disposeSyntheticEncryptedWorkspace(workspace); disposed = true; } catch { failureCode = 'REHEARSAL_CLEANUP_FAILED'; }
}
if (failureCode) { console.error(JSON.stringify({ status: 'failed', syntheticOnly: true, code: failureCode })); process.exitCode = 1; }
else console.log(JSON.stringify(report));
