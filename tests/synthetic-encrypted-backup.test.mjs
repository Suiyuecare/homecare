import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { initDb } from '../src/server/model.mjs';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticWorkspace, disposeSyntheticWorkspace, inspectSyntheticDatabase } from '../src/server/synthetic-backup.mjs';
import { createSyntheticPortalWorkspace, disposeSyntheticWorkspace as disposeSyntheticPortalWorkspace } from '../src/server/synthetic-portal-backup.mjs';
import { createSyntheticBackupFixture, syntheticClient, readSyntheticRawState } from './synthetic-backup-fixtures.mjs';
import * as encrypted from '../src/server/synthetic-encrypted-backup.mjs';

const { createSyntheticEncryptedWorkspace: create, syntheticEncryptedDatabasePath: path, captureEncryptedSyntheticBackup: capture, readEncryptedSyntheticBackup: read, restoreEncryptedSyntheticBackup: restore, promoteEncryptedSyntheticRestore: promote, disposeSyntheticEncryptedWorkspace: dispose, sealSyntheticBackupBytes: seal, openSyntheticBackupBytes: open } = encrypted;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pass = () => Buffer.from('合成演練密碼-' + randomBytes(18).toString('hex'));
const changed = (bytes, transform) => { const parsed = JSON.parse(bytes.toString('utf8')); transform(parsed); return Buffer.from(JSON.stringify(parsed)); };
const code = expected => error => error?.name === 'SyntheticEncryptedBackupError' && error.code === expected && !/\/Users\/|suiyue-synthetic-backup-/.test(error.message);
const same = (a, b, message) => assert(isDeepStrictEqual(a, b), message);
function emptySource(workspace) {
  const db = new DatabaseSync(path(workspace, 'source'));
  try { initDb(db); } finally { db.close(); }
  return inspectSyntheticDatabase(workspace, 'source');
}
async function sealedEmpty(workspace) {
  const proof = emptySource(workspace), bytes = readFileSync(path(workspace, 'source')), password = pass();
  return { proof, bytes, password, envelope: await seal(bytes, proof, password) };
}
function byteIdentity(file) { const s = lstatSync(file); return { dev: s.dev, ino: s.ino, uid: s.uid, sha256: sha(readFileSync(file)) }; }

test('facade exports only nine operations and rejects forged, legacy, Portal and disposed capabilities', async () => {
  assert.equal(Object.keys(encrypted).length, 9);
  const ordinary = createSyntheticWorkspace(), portal = createSyntheticPortalWorkspace(), own = create();
  try {
    for (const workspace of [Object.freeze({}), ordinary, portal]) {
      assert.throws(() => path(workspace, 'source'), code('WORKSPACE_INVALID'));
      await assert.rejects(capture(workspace, pass()), code('WORKSPACE_INVALID'));
      await assert.rejects(restore(workspace, Buffer.alloc(0), pass(), 'live'), code('WORKSPACE_INVALID'));
    }
    assert(Object.isFrozen(own)); assert.equal(Reflect.ownKeys(own).length, 0);
    assert.throws(() => create({ path: '/unowned' }), code('INVALID_ARGUMENT'));
    assert.throws(() => path(own, '../source'), code('INVALID_ARGUMENT'));
    assert.throws(() => path(own, 'source', {}), code('INVALID_ARGUMENT'));
    dispose(own);
    assert.throws(() => path(own, 'source'), code('WORKSPACE_INVALID'));
  } finally { disposeSyntheticWorkspace(ordinary); disposeSyntheticPortalWorkspace(portal); }
});

test('pure seal/open is randomized, authenticated, canonical, closed, and preserves caller buffers', async t => {
  const workspace = create(); t.after(() => dispose(workspace));
  const fixture = await sealedEmpty(workspace), original = Buffer.from(fixture.bytes), password = Buffer.from(fixture.password);
  const second = await seal(fixture.bytes, fixture.proof, fixture.password);
  assert(!second.equals(fixture.envelope));
  const a = JSON.parse(fixture.envelope), b = JSON.parse(second);
  assert.notEqual(a.kdf.salt, b.kdf.salt); assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.equal(a.kdf.N, 32768); assert.equal(a.cipher.name, 'aes-256-gcm'); assert.equal(a.syntheticOnly, true);
  assert(!fixture.envelope.includes(fixture.password)); assert(!fixture.envelope.includes(Buffer.from('SQLite format 3')));
  const result = await open(fixture.envelope, fixture.password);
  try { assert(result.bytes.equals(original)); same(result.proof, fixture.proof, 'Pure authenticated proof retains every closed field'); }
  finally { result.bytes.fill(0); }
  assert(fixture.bytes.equals(original)); assert(fixture.password.equals(password));
  fixture.password.fill(0); password.fill(0); original.fill(0);
});

test('wrong password, GCM tag, ciphertext, authenticated IV and salt reject without a partial result', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  const flip = text => { const bytes = Buffer.from(text, 'base64'); bytes[0] ^= 1; return bytes.toString('base64'); };
  await assert.rejects(open(f.envelope, pass()), code('AUTHENTICATION_FAILED'));
  for (const transform of [e => { e.cipher.tag = flip(e.cipher.tag); }, e => { e.cipher.iv = flip(e.cipher.iv); }, e => { e.kdf.salt = flip(e.kdf.salt); }, e => { e.ciphertext = flip(e.ciphertext); }]) {
    await assert.rejects(open(changed(f.envelope, transform), f.password), code('AUTHENTICATION_FAILED'));
  }
  f.password.fill(0);
});

test('unknown keys, duplicate keys, reordered JSON, whitespace, bad base64 and KDF escalation fail before decryption', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  const canonical = f.envelope.toString('utf8');
  const altered = [
    changed(f.envelope, e => { e.extra = 'unknown'; }), changed(f.envelope, e => { e.kdf.N *= 2; }),
    changed(f.envelope, e => { e.kdf.r = 1; }), changed(f.envelope, e => { e.kdf.extra = 1; }),
    changed(f.envelope, e => { e.cipher.extra = 1; }), changed(f.envelope, e => { e.cipher.iv += '\n'; }),
    changed(f.envelope, e => { e.version = 2; }), changed(f.envelope, e => { e.syntheticOnly = false; }),
    Buffer.from(canonical.replace('{"format":', '{"version":1,"format":')), Buffer.from(canonical + '\n'),
    Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(canonical)).reverse()))), Buffer.from(canonical.slice(0, -1))
  ];
  for (const bytes of altered) await assert.rejects(open(bytes, f.password), code('ENVELOPE_INVALID'));
  await assert.rejects(open(Buffer.from([0xff]), f.password), code('ENVELOPE_INVALID'));
  f.password.fill(0);
});

test('closed proof rejects getters, symbol/unknown nested keys, count corruption, hash mismatch and short secret with zero getters', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  let calls = 0; const getter = { ...f.proof }; Object.defineProperty(getter, 'tables', { enumerable: true, get() { calls++; return f.proof.tables; } });
  await assert.rejects(seal(f.bytes, getter, f.password), code('PROOF_INVALID')); assert.equal(calls, 0);
  const nested = JSON.parse(JSON.stringify(f.proof)); Object.defineProperty(nested.tables.users, 'count', { enumerable: true, get() { calls++; return 0; } });
  await assert.rejects(seal(f.bytes, nested, f.password), code('PROOF_INVALID')); assert.equal(calls, 0);
  for (const mutate of [p => { p[Symbol('extra')] = true; }, p => { p.tables.users.extra = 1; }, p => { p.tableCount = 13; }, p => { p.fingerprint = '0'.repeat(64); }, p => { p.mainFileSha256 = '0'.repeat(64); }]) {
    const value = JSON.parse(JSON.stringify(f.proof)); mutate(value); await assert.rejects(seal(f.bytes, value, f.password), code('PROOF_INVALID'));
  }
  for (const value of [Buffer.alloc(15, 97), Buffer.alloc(1025, 97), Buffer.from('sixteen-bytes-ok\n'), Buffer.from('sixteen\0bytes-ok--'), 'string-secret-is-not-buffer', Buffer.alloc(16, 255)]) await assert.rejects(seal(f.bytes, f.proof, value), code('PASSPHRASE_INVALID'));
  await assert.rejects(seal(Buffer.alloc(32 * 1024 * 1024 + 1), f.proof, f.password), code('CAPACITY_EXCEEDED'));
  await assert.rejects(open(Buffer.alloc(48 * 1024 * 1024 + 1), f.password), code('CAPACITY_EXCEEDED'));
  f.password.fill(0);
});

test('caller Buffer length/valueOf/copy/includes accessors are never called and original caller bytes remain unchanged', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  const raw = Buffer.from(f.bytes), password = Buffer.from(f.password), envelope = Buffer.from(f.envelope); let calls = 0;
  for (const buffer of [raw, password, envelope]) for (const key of ['length', 'valueOf', 'copy', 'includes']) Object.defineProperty(buffer, key, { configurable: true, get() { calls++; throw new Error('SECRET getter must not execute'); } });
  const newlySealed = await seal(raw, f.proof, password), opened = await open(envelope, password), reopened = await open(newlySealed, password);
  try { assert(opened.bytes.equals(f.bytes)); assert(reopened.bytes.equals(f.bytes)); assert.equal(calls, 0); }
  finally { opened.bytes.fill(0); reopened.bytes.fill(0); }
  for (const buffer of [raw, password, envelope]) for (const key of ['length', 'valueOf', 'copy', 'includes']) delete buffer[key];
  assert(raw.equals(f.bytes)); assert(password.equals(f.password)); assert(envelope.equals(f.envelope)); assert.equal(calls, 0);
  raw.fill(0); password.fill(0); f.password.fill(0);
});

test('capture deletes only newly owned plaintext and restore uses only the encrypted bytes; fixed slots reject sidecars/symlink/hardlink', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); emptySource(workspace); const password = pass();
  const info = await capture(workspace, password), ciphertext = read(workspace), root = dirname(path(workspace, 'source'));
  assert.equal(info.plaintextDeleted, true); assert(!existsSync(path(workspace, 'backup'))); assert(!existsSync(join(root, 'backup.manifest.json')));
  assert.equal(lstatSync(path(workspace, 'encrypted')).mode & 0o777, 0o600);
  await restore(workspace, ciphertext, password, 'live');
  assert.equal(inspectSyntheticDatabase(workspace, 'live').fingerprint, info.inspection.fingerprint);
  const stage = path(workspace, 'staged'), live = path(workspace, 'live'), before = byteIdentity(live);
  writeFileSync(stage + '-wal', 'synthetic occupied journal');
  await assert.rejects(restore(workspace, ciphertext, password, 'staged'), code('SIDECAR_PRESENT')); rmSync(stage + '-wal');
  symlinkSync(live, stage); await assert.rejects(restore(workspace, ciphertext, password, 'staged'), error => ['UNSAFE_PATH', 'SCRATCH_OPERATION_FAILED'].includes(error.code)); rmSync(stage);
  linkSync(live, stage); await assert.rejects(restore(workspace, ciphertext, password, 'staged'), error => ['UNSAFE_PATH', 'SCRATCH_OPERATION_FAILED'].includes(error.code)); rmSync(stage);
  same(byteIdentity(live), before, 'Unsafe staged paths never change live inode or bytes');
  await assert.rejects(capture(workspace, password), code('TARGET_EXISTS'));
  assert.throws(() => path(workspace, 'outside.sqlite'), code('INVALID_ARGUMENT'));
  password.fill(0);
});

test('authentication failures preserve live inode and directory; authenticated wrong SQLite is removed after actual inspection', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  await restore(workspace, f.envelope, f.password, 'live');
  const live = path(workspace, 'live'), root = dirname(live), before = byteIdentity(live), entries = readdirSync(root).sort();
  for (const envelope of [changed(f.envelope, e => { e.cipher.tag = Buffer.alloc(16).toString('base64'); }), f.envelope.subarray(0, f.envelope.length - 1)]) {
    await assert.rejects(restore(workspace, envelope, f.password, 'staged'));
    same(readdirSync(root).sort(), entries, 'Failed authentication creates no files'); same(byteIdentity(live), before, 'Existing live is untouched');
  }
  await assert.rejects(restore(workspace, f.envelope, pass(), 'staged'), code('AUTHENTICATION_FAILED'));
  await assert.rejects(restore(workspace, f.envelope, f.password, 'live'), code('TARGET_EXISTS'));
  const fake = Buffer.alloc(f.bytes.length, 120), fakeProof = { ...f.proof, mainFileSha256: sha(fake) };
  const malicious = await seal(fake, fakeProof, f.password);
  // Pure proof/hash validation is intentionally not a SQLite inspection.
  const purelyOpened = await open(malicious, f.password); purelyOpened.bytes.fill(0);
  await assert.rejects(restore(workspace, malicious, f.password, 'staged'), code('SQLITE_VERIFICATION_FAILED'));
  assert(!existsSync(path(workspace, 'staged'))); same(readdirSync(root).sort(), entries, 'Failed actual SQLite verification removes only newly owned target'); same(byteIdentity(live), before, 'Actual SQLite rejection preserves live');
  f.password.fill(0); fake.fill(0);
});

test('actual SQLite verification rejects a dishonest full typed proof and a dropped immutable trigger without overwriting live', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  await restore(workspace, f.envelope, f.password, 'live');
  const before = byteIdentity(path(workspace, 'live')), entries = readdirSync(dirname(path(workspace, 'live'))).sort();
  const fakeProof = JSON.parse(JSON.stringify(f.proof)); fakeProof.tables.users.count++;
  const content = Object.fromEntries(['tableCount', 'triggerCount', 'userVersion', 'applicationId', 'schemaSha256', 'tables', 'blobSha256', 'versionsSha256', 'billingSnapshotsSha256'].map(key => [key, fakeProof[key]]));
  fakeProof.fingerprint = sha(Buffer.from(JSON.stringify(content)));
  const dishonest = await seal(f.bytes, fakeProof, f.password);
  await assert.rejects(restore(workspace, dishonest, f.password, 'staged'), code('RESTORE_CHANGED'));
  same(readdirSync(dirname(path(workspace, 'live'))).sort(), entries, 'Full proof mismatch leaves zero new target files'); same(byteIdentity(path(workspace, 'live')), before, 'Full proof mismatch preserves live');
  const db = new DatabaseSync(path(workspace, 'source')); try { db.exec('DROP TRIGGER versions_no_update'); } finally { db.close(); }
  const raw = readFileSync(path(workspace, 'source')), schemaEnvelope = await seal(raw, { ...f.proof, mainFileSha256: sha(raw), mainFileBytes: raw.length }, f.password);
  await assert.rejects(restore(workspace, schemaEnvelope, f.password, 'staged'), code('SQLITE_VERIFICATION_FAILED'));
  assert(!existsSync(path(workspace, 'staged'))); same(byteIdentity(path(workspace, 'live')), before, 'Missing immutable trigger cannot overwrite live'); f.password.fill(0); raw.fill(0);
});

test('capture refuses synthetic foreign keys or missing current history and creates neither plaintext backup nor encrypted envelope', async () => {
  for (const kind of ['foreign-key', 'current-history']) {
    const workspace = create(), password = pass();
    try {
      emptySource(workspace); const db = new DatabaseSync(path(workspace, 'source'));
      try {
        db.exec('PRAGMA foreign_keys=OFF');
        if (kind === 'current-history') db.prepare('INSERT INTO organizations (id,name,created_at) VALUES (?,?,?)').run('synthetic-orphan-org', '合成缺歷程機構', '2026-10-11T00:00:00.000Z');
        db.prepare('INSERT INTO records (id,org_id,entity,data,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('synthetic-orphan-record', 'synthetic-orphan-org', 'cases', '{}', 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
      } finally { db.close(); }
      const original = byteIdentity(path(workspace, 'source')), root = dirname(path(workspace, 'source')), entries = readdirSync(root).sort();
      await assert.rejects(capture(workspace, password), code('SCRATCH_OPERATION_FAILED'));
      same(byteIdentity(path(workspace, 'source')), original, 'Bad source capture never rewrites source bytes or inode'); same(readdirSync(root).sort(), entries, 'Bad source capture leaves no new plaintext or encrypted files');
    } finally { password.fill(0); dispose(workspace); }
  }
});

test('promotion options/getter and changed candidates fail without writes; both rename fault points restore original inode', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  await restore(workspace, f.envelope, f.password, 'live'); await restore(workspace, f.envelope, f.password, 'staged');
  const live = path(workspace, 'live'), stage = path(workspace, 'staged'), root = dirname(live), original = byteIdentity(live), staged = byteIdentity(stage), entries = readdirSync(root).sort();
  let calls = 0; const malicious = {}; Object.defineProperty(malicious, 'failurePoint', { enumerable: true, get() { calls++; return 'none'; } });
  assert.throws(() => promote(workspace, malicious), code('INVALID_ARGUMENT')); assert.equal(calls, 0);
  assert.throws(() => promote(workspace, { failurePoint: 'none', extra: true }), code('INVALID_ARGUMENT'));
  for (const failurePoint of ['after-live-retired', 'after-candidate-promoted']) {
    const rollback = promote(workspace, { failurePoint }); assert.equal(rollback.status, 'rolled_back'); assert.equal(rollback.failurePoint, failurePoint);
    same(byteIdentity(live), original, 'Rollback restores actual original inode and bytes'); same(byteIdentity(stage), staged, 'Rollback retains exact candidate inode and bytes');
    same(readdirSync(root).sort(), entries, 'Rollback restores original directory slots'); assert(!existsSync(path(workspace, 'previous')));
  }
  const current = readFileSync(stage); current[100] ^= 1; writeFileSync(stage, current);
  assert.throws(() => promote(workspace, { failurePoint: 'none' }), error => ['SQLITE_VERIFICATION_FAILED', 'RESTORE_CHANGED'].includes(error.code));
  same(byteIdentity(live), original, 'Changed stage never retires live'); f.password.fill(0);
});

test('promotion requires its own verified stage capability and closed journals; raw stage bytes and sidecars leave both generations unchanged', async t => {
  const workspace = create(); t.after(() => dispose(workspace)); const f = await sealedEmpty(workspace);
  await restore(workspace, f.envelope, f.password, 'live');
  const live = path(workspace, 'live'), stage = path(workspace, 'staged'), root = dirname(live), original = byteIdentity(live);
  writeFileSync(stage, f.bytes, { flag: 'wx', mode: 0o600 }); const rawStage = byteIdentity(stage), entries = readdirSync(root).sort();
  assert.throws(() => promote(workspace, { failurePoint: 'none' }), code('RESTORE_CHANGED'));
  same(byteIdentity(live), original, 'Unverified raw candidate never retires live'); same(byteIdentity(stage), rawStage, 'Unverified raw candidate is not removed'); same(readdirSync(root).sort(), entries, 'No new promotion files are created');
  rmSync(stage); await restore(workspace, f.envelope, f.password, 'staged'); const verified = byteIdentity(stage);
  for (const file of [stage, live]) {
    writeFileSync(file + '-journal', 'synthetic closed journal is occupied', { flag: 'wx' });
    assert.throws(() => promote(workspace, { failurePoint: 'none' }), code('SIDECAR_PRESENT')); rmSync(file + '-journal');
    same(byteIdentity(live), original, 'Sidecar rejection preserves live'); same(byteIdentity(stage), verified, 'Sidecar rejection preserves verified stage'); assert(!existsSync(path(workspace, 'previous')));
  }
  f.password.fill(0);
});

test('true committed-WAL fixture retains all eleven tables, six triggers, BLOBs, raw TEXT/NUL, versions and pricing through both rollbacks and promotion', async t => {
  const workspace = create(), password = pass(); let source, liveApp;
  t.after(async () => { if (liveApp) await liveApp.close(); if (source) await source.close(); password.fill(0); dispose(workspace); });
  source = await createSyntheticBackupFixture({ workspace }); const rawA = source.readRawState(), beforeChanges = source.app.db.prepare('SELECT total_changes() AS n').get().n;
  const backup = await capture(workspace, password), ciphertext = read(workspace);
  same(source.readRawState(), rawA, 'Capture preserves complete source including committed WAL'); assert.equal(source.app.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
  assert.equal(backup.inspection.tableCount, 11); assert.equal(backup.inspection.triggerCount, 6);
  assert(!existsSync(path(workspace, 'backup'))); assert(!existsSync(join(dirname(path(workspace, 'source')), 'backup.manifest.json')));
  await restore(workspace, ciphertext, password, 'live');
  liveApp = createApp({ dbPath: path(workspace, 'live'), host: '127.0.0.1', port: 0 }); same(readSyntheticRawState(liveApp.db), rawA, 'Startup preserves complete restored saved values'); assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
  const base = await liveApp.listen(), client = syntheticClient(base, 'encrypted-restored-admin', { cookie: source.sourceCookies.admin, auth: source.actors.admin.auth });
  for (const kind of ['fees', 'payroll']) same(await client.json('GET', `reports/${kind}?month=${source.month}`, undefined, { orgId: source.orgId }), source.expected.frozenReports[kind], 'Pricing uses the saved approved snapshot after restore');
  const changed = await client.json('PATCH', `cases/${source.items.case.id}`, { version: source.items.case.version, note: '合成 live 第二代\r\n保留完整原文' }, { orgId: source.orgId }); assert.equal(changed.item.version, source.items.case.version + 1);
  const rawB = readSyntheticRawState(liveApp.db); await liveApp.close(); liveApp = null;
  const original = byteIdentity(path(workspace, 'live')); await restore(workspace, ciphertext, password, 'staged');
  for (const failurePoint of ['after-live-retired', 'after-candidate-promoted']) {
    assert.equal(promote(workspace, { failurePoint }).status, 'rolled_back'); same(byteIdentity(path(workspace, 'live')), original, 'Both actual rename failures restore exact original inode/bytes');
    liveApp = createApp({ dbPath: path(workspace, 'live'), host: '127.0.0.1', port: 0 }); same(readSyntheticRawState(liveApp.db), rawB, 'Rollback restores all live second-generation typed fields'); assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0); await liveApp.close(); liveApp = null;
  }
  const result = promote(workspace, { failurePoint: 'none' }); assert.equal(result.status, 'promoted'); same(byteIdentity(path(workspace, 'previous')), original, 'Previous retains original live inode and bytes');
  liveApp = createApp({ dbPath: path(workspace, 'live'), host: '127.0.0.1', port: 0 }); same(readSyntheticRawState(liveApp.db), rawA, 'Successful encrypted-only promotion restores every source field'); assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
  await liveApp.close(); liveApp = null; same(source.readRawState(), rawA, 'Complete rehearsal preserves original source'); assert.equal(source.app.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
});
