import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { initDb, insert } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import * as portal from '../src/server/synthetic-portal-backup.mjs';
import { sealSyntheticPortalBackupBytes as seal, openSyntheticPortalBackupBytes as open, rehearseSyntheticEncryptedPortalBackup as rehearse } from '../scripts/rehearse-synthetic-encrypted-portal-backup.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const password = () => Buffer.from(randomBytes(48).toString('hex'));
const errorCode = code => error => error?.name === 'SyntheticEncryptedPortalError' && error.code === code && !error.message.includes('secret');
function fixture(t) {
  const workspace = portal.createSyntheticPortalWorkspace(); t.after(() => portal.disposeSyntheticWorkspace(workspace));
  const filename = portal.syntheticDatabasePath(workspace, 'source'), db = new DatabaseSync(filename), stamp = '2026-10-11T00:00:00.000Z';
  try {
    initDb(db); initPortalStorage(db);
    db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('synthetic-org', '完整TEXT\u0000尾部', stamp);
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('synthetic-user', '合成人員\u0000保留', 'synthetic-crypto@example.test', 'synthetic-no-real-password', stamp);
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('synthetic-org', 'synthetic-user', 'admin', null);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('synthetic-token', 'synthetic-user', 'synthetic-csrf\u0000尾', 9223372036854775807n);
    const item = insert(db, 'synthetic-org', 'cases', { name: '合成個案', caseNo: 'SYNTHETIC-CRYPTO', note: 'JSON保留\u0000與1.2500' });
    db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run('synthetic-audit', null, null, 'synthetic-only', null, item.id, '{"fraction":1.2500,"text":"尾部\\u0000"}', stamp);
    db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run('synthetic-org', 'synthetic-user', 'synthetic-key', 'POST /synthetic', 'synthetic-hash', '{"fraction":1.2500}', 201, stamp);
    db.prepare('INSERT INTO demo_seeds VALUES(?,?)').run('synthetic-org', stamp);
    const blob = Buffer.from([0, 255, 1, 128, 10, 13]);
    db.prepare('INSERT INTO attachment_files VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-case-file', 'synthetic-org', item.id, item.id, '合成.pdf', 'application/pdf', blob.length, sha(blob), blob, stamp);
    db.prepare('INSERT INTO certification_attachment_files VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-cert-file', 'synthetic-org', item.id, item.id, item.id, '合成.png', 'image/png', blob.length, sha(blob), blob, stamp);
    db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run('https://synthetic.example.test\u0000尾', 'synthetic-subject', 'synthetic-auth', 'synthetic-crypto@example.test', 'synthetic-user', 'synthetic-org', 0, stamp);
    db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run('synthetic-consumed\u0000尾', 'https://synthetic.example.test', 'synthetic-user', 'synthetic-org', 1.25, -9223372036854775808n);
  } finally { db.close(); }
  const proof = portal.inspectSyntheticDatabase(workspace, 'source'), bytes = readFileSync(filename), pass = password(); t.after(() => { bytes.fill(0); pass.fill(0); });
  return { workspace, proof, bytes, pass };
}
const changed = (envelope, operation) => { const value = JSON.parse(envelope); operation(value); return Buffer.from(JSON.stringify(value)); };

test('authenticated randomized13-table envelope retains complete bytes, schema proof, NUL, INTEGER/REAL and BLOB', async t => {
  const f = fixture(t), first = await seal(f.bytes, f.proof, f.pass), second = await seal(f.bytes, f.proof, f.pass), original = Buffer.from(f.bytes), pass = Buffer.from(f.pass);
  try {
    assert(!first.equals(second)); const meta = JSON.parse(first); assert.equal(meta.format, 'suiyue-synthetic-encrypted-portal-sqlite-v1'); assert.equal(meta.recoveryPolicy, 'clear-sessions-disable-bindings-rotate-key-v1'); assert.equal(meta.kdf.N, 32768);
    assert(!first.includes(Buffer.from('SQLite format 3'))); assert(!first.includes(f.pass));
    const recovered = await open(first, f.pass);
    try {
      assert(recovered.bytes.equals(f.bytes)); assert.deepEqual(recovered.proof, f.proof);
      const staged = portal.syntheticDatabasePath(f.workspace, 'staged'); writeFileSync(staged, recovered.bytes, { flag: 'wx', mode: 0o600 }); assert.deepEqual(portal.inspectSyntheticDatabase(f.workspace, 'staged'), f.proof);
    } finally { recovered.bytes.fill(0); }
    assert(f.bytes.equals(original)); assert(f.pass.equals(pass));
  } finally { first.fill(0); second.fill(0); original.fill(0); pass.fill(0); }
});

test('wrong password, changed tag/IV/salt/ciphertext return no partial result', async t => {
  const f = fixture(t), envelope = await seal(f.bytes, f.proof, f.pass), wrong = password();
  try {
    await assert.rejects(open(envelope, wrong), errorCode('AUTHENTICATION_FAILED'));
    const flip = text => { const bytes = Buffer.from(text, 'base64'); bytes[0] ^= 1; return bytes.toString('base64'); };
    for (const operation of [e => { e.cipher.tag = flip(e.cipher.tag); }, e => { e.cipher.iv = flip(e.cipher.iv); }, e => { e.kdf.salt = flip(e.kdf.salt); }, e => { e.ciphertext = flip(e.ciphertext); }]) await assert.rejects(open(changed(envelope, operation), f.pass), errorCode('AUTHENTICATION_FAILED'));
  } finally { envelope.fill(0); wrong.fill(0); }
});

test('closed canonical envelope refuses policy changes, KDF escalation, unknown/duplicate keys and cross-profile format', async t => {
  const f = fixture(t), envelope = await seal(f.bytes, f.proof, f.pass), text = envelope.toString();
  try {
    for (const bytes of [changed(envelope, e => { e.recoveryPolicy = 'restore-old-sessions'; }), changed(envelope, e => { e.format = 'suiyue-synthetic-encrypted-sqlite-v1'; }), changed(envelope, e => { e.version = 2; }), changed(envelope, e => { e.syntheticOnly = false; }), changed(envelope, e => { e.kdf.N *= 2; }), changed(envelope, e => { e.kdf.r = 1; }), changed(envelope, e => { e.kdf.extra = true; }), changed(envelope, e => { e.cipher.extra = true; }), changed(envelope, e => { e.cipher.iv += '\n'; }), changed(envelope, e => { e.extra = true; }), Buffer.from(text.replace('{"format":', '{"version":1,"format":')), Buffer.from(text + '\n'), Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).reverse()))), Buffer.from(text.slice(0, -1)), Buffer.from([255])]) await assert.rejects(open(bytes, f.pass), errorCode('ENVELOPE_INVALID'));
  } finally { envelope.fill(0); }
});

test('proof format, fixed13-table list, counts/hash and capacity cannot be supplied loosely', async t => {
  const f = fixture(t);
  for (const alter of [p => { p.tableCount = 11; }, p => { p.format = 'suiyue-synthetic-sqlite-inspection-v1'; }, p => { delete p.tables.portal_handoff_nonces; }, p => { p.tables.extra = { count: 0, sha256: '0'.repeat(64) }; }, p => { p.tables.users.count = -1; }, p => { p.mainFileSha256 = '0'.repeat(64); }, p => { p.fingerprint = '0'.repeat(64); }, p => { p.extra = true; }]) { const proof = structuredClone(f.proof); alter(proof); await assert.rejects(seal(f.bytes, proof, f.pass), errorCode('PROOF_INVALID')); }
  const oversized = Buffer.alloc(32 * 1024 * 1024 + 1); try { await assert.rejects(seal(oversized, f.proof, f.pass), errorCode('CAPACITY_EXCEEDED')); } finally { oversized.fill(0); }
  for (const pass of [Buffer.alloc(15, 97), Buffer.from('synthetic-invalid\nsecret'), Buffer.alloc(16, 255), 'synthetic-string-not-buffer']) await assert.rejects(seal(f.bytes, f.proof, pass), errorCode('PASSPHRASE_INVALID'));
});

test('caller Buffer/property getters are never invoked and originals survive', async t => {
  const f = fixture(t), envelope = await seal(f.bytes, f.proof, f.pass); let calls = 0;
  const proof = { ...f.proof }; Object.defineProperty(proof, 'tables', { enumerable: true, get() { calls++; throw new Error('secret getter'); } });
  await assert.rejects(seal(f.bytes, proof, f.pass), errorCode('PROOF_INVALID'));
  const raw = Buffer.from(f.bytes), pass = Buffer.from(f.pass), sealed = Buffer.from(envelope);
  for (const bytes of [raw, pass, sealed]) for (const name of ['length', 'valueOf', 'copy', 'includes']) Object.defineProperty(bytes, name, { configurable: true, get() { calls++; throw new Error('secret getter'); } });
  const next = await seal(raw, f.proof, pass), recovered = await open(sealed, pass);
  try { assert(recovered.bytes.equals(f.bytes)); assert.equal(calls, 0); }
  finally { recovered.bytes.fill(0); next.fill(0); for (const bytes of [raw, pass, sealed]) { for (const name of ['length', 'valueOf', 'copy', 'includes']) delete bytes[name]; } }
  assert(raw.equals(f.bytes)); assert(pass.equals(f.pass)); assert(sealed.equals(envelope)); for (const bytes of [raw, pass, sealed, envelope]) bytes.fill(0);
});

test('pure authenticated hashes do not replace actual SQLite validation', async t => {
  const f = fixture(t), fake = Buffer.alloc(f.bytes.length, 120), proof = { ...f.proof, mainFileSha256: sha(fake) }, envelope = await seal(fake, proof, f.pass), opened = await open(envelope, f.pass);
  try {
    const staged = portal.syntheticDatabasePath(f.workspace, 'staged'); writeFileSync(staged, opened.bytes, { flag: 'wx', mode: 0o600 }); assert.throws(() => portal.inspectSyntheticDatabase(f.workspace, 'staged'), error => error.name === 'SyntheticBackupError' && error.code === 'INTEGRITY_FAILED');
  } finally { fake.fill(0); envelope.fill(0); opened.bytes.fill(0); }
});

test('owned full recovery clears sessions/disables grants/rotates key and preserves business values', async () => {
  const report = await rehearse();
  for (const name of ['syntheticOnly', 'plaintextBackupDeletedBeforeRestore', 'cipherOnlyRestore', 'exactSchemaAndTypedSnapshot', 'snapshotLifecycleAndRulesExact', 'immutableBlobFamiliesExact', 'postSnapshotSourcePreserved', 'sessionsClearedBeforeStartup', 'allBindingsDisabledBeforeStartup', 'capturedNonceLedgerRetained', 'oldKeyRejectedIncludingPostSnapshotTokens', 'restoredOldCookieRejected', 'capturedNonceReplayRejectedAfterNewKey', 'postSnapshotRevokedSupervisorRemainsDenied', 'unknownGrantInactiveRemainsDenied', 'financialSnapshotAndRuleHistoryExact', 'securityReconciliationChangesSnapshot', 'disposed']) assert.equal(report[name], true, name);
  assert.equal(report.status, 'passed'); assert.equal(report.tableCount, 13); assert.equal(report.triggerCount, 6); assert.equal(report.explicitGrantCount, 3); assert.equal(report.scopedReadsLogicalWrites, 0);
  for (const name of ['formalDrAccepted', 'formalDeployment', 'actual4310Accessed', 'promotionPerformed', 'originalFacadesChanged']) assert.equal(report[name], false, name);
  assert(!JSON.stringify(report).includes('@')); assert(!JSON.stringify(report).includes('/tmp/')); assert(!JSON.stringify(report).includes('signingSecret'));
});

test('rehearsal API and real CLI reject arbitrary paths/accounts before creating a factory', async () => {
  let accessed = false; const argument = Object.defineProperty({}, 'path', { get() { accessed = true; throw new Error('secret'); } });
  await assert.rejects(rehearse(argument), errorCode('INVALID_ARGUMENT')); assert.equal(accessed, false);
  const child = spawnSync(process.execPath, ['scripts/rehearse-synthetic-encrypted-portal-backup.mjs', '--db-path', '/synthetic-secret-do-not-read.sqlite'], { encoding: 'utf8' });
  assert.equal(child.status, 2); assert.equal(child.signal, null); assert.equal(child.stdout, ''); assert(child.stderr.includes('CLI_ARGUMENTS_REJECTED')); assert(!child.stderr.includes('synthetic-secret'));
});
