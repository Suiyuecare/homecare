import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initDb, insert } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { inspectProductionDatabase } from '../src/server/production-backup-inspection.mjs';
import { makeWorkspace, identity } from '../src/server/production-backup-storage.mjs';
import { createProductionBackup, verifyProductionBackup, restoreProductionBackupIsolated } from '../src/server/production-backup.mjs';

const rejected = error => error?.name === 'ProductionBackupError' && error.code === 'UNSAFE_PATH';
function owner(t) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'homecare-backup-space-owned-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function slot(workspace, name, text) {
  const created = workspace.create(name);
  fs.writeSync(created.fd, Buffer.from(text)); fs.closeSync(created.fd);
  return created;
}
function database(t) {
  const root = owner(t), path = join(root, 'source.sqlite'), db = new DatabaseSync(path), key = randomBytes(32);
  initDb(db); initPortalStorage(db);
  const orgId = randomUUID(), userId = randomUUID(), stamp = '2026-10-13T00:00:00.000Z';
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成完整尾\u0000', stamp);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId, '合成管理者', 'synthetic-space@example.invalid', '!portal-only!', stamp);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, userId, 'admin', null);
  db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run('https://synthetic.invalid', 'synthetic-subject', randomUUID(), 'synthetic-space@example.invalid', userId, orgId, 1, stamp);
  insert(db, orgId, 'cases', { name: '合成保存欄位', caseNo: 'SYN-SPACE', note: '原樣\u0000\r\n尾字' });
  for (const name of fs.readdirSync(root)) if (fs.statSync(join(root, name)).isFile()) fs.chmodSync(join(root, name), 0o600);
  t.after(() => { db.close(); key.fill(0); });
  return { root, path, db, key, backupPath: join(root, 'archive.hcbak') };
}

test('backup releases its captured plaintext before decryption while preserving exact thirteen-table source and v1 restore', async t => {
  const f = database(t), before = inspectProductionDatabase(f.db), keyBefore = Buffer.from(f.key), originalOpen = fs.openSync, originalWrite = fs.writeSync;
  const databaseBytes = f.db.prepare('PRAGMA page_count').get().page_count * f.db.prepare('PRAGMA page_size').get().page_size;
  let authenticatedOpens = 0, snapshotBeforeFirstAuth, workspaceRoot, peakDatabaseCopies = 0;
  t.mock.method(fs, 'openSync', function(path, ...args) {
    if (typeof path === 'string' && path.endsWith('/authenticated.payload') && (args[0] & fs.constants.O_CREAT)) {
      authenticatedOpens++;
      workspaceRoot = path.slice(0, path.lastIndexOf('/'));
      if (authenticatedOpens === 1) snapshotBeforeFirstAuth = fs.existsSync(join(workspaceRoot, 'snapshot.sqlite'));
    }
    return originalOpen.call(this, path, ...args);
  });
  t.mock.method(fs, 'writeSync', function(...args) {
    const result = originalWrite.apply(this, args);
    if (workspaceRoot && fs.existsSync(workspaceRoot)) {
      const count = fs.readdirSync(workspaceRoot).filter(name => fs.statSync(join(workspaceRoot, name)).size >= databaseBytes).length;
      peakDatabaseCopies = Math.max(peakDatabaseCopies, count);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); keyBefore.fill(0); });
  const result = await createProductionBackup({ databasePath: f.path, outputPath: f.backupPath, key: f.key });
  assert.equal(result.format, 'suiyue-production-encrypted-sqlite-v1'); assert(result.verified);
  process.stdout.write('# owned workarea measured peak database-sized copies: ' + peakDatabaseCopies + '\n');
  assert.equal(snapshotBeforeFirstAuth, false, 'captured plaintext must be gone before authenticated payload allocation');
  assert.equal(peakDatabaseCopies, 3, 'verified backup must never retain a fourth database-sized workarea copy');
  assert.equal(authenticatedOpens, 1); assert.deepEqual(inspectProductionDatabase(f.db), before); assert(f.key.equals(keyBefore));
  assert((await verifyProductionBackup({ backupPath: f.backupPath, key: f.key })).verified);
  const destinationDirectory = join(f.root, 'isolated');
  const restored = await restoreProductionBackupIsolated({ backupPath: f.backupPath, destinationDirectory, key: f.key });
  assert(restored.recoveryPending && restored.productionReady === false);
  const db = new DatabaseSync(join(destinationDirectory, 'isolated.sqlite'), { readOnly: true });
  try { const after = inspectProductionDatabase(db); for (const name of Object.keys(before.tables)) if (!['sessions', 'portal_identity_bindings'].includes(name)) assert.deepEqual(after.tables[name], before.tables[name]); assert.equal(db.prepare('SELECT count(*) n FROM portal_identity_bindings WHERE active<>0').get().n, 0); }
  finally { db.close(); }
  assert.equal(authenticatedOpens, 3); assert.deepEqual(inspectProductionDatabase(f.db), before);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.homecare-backup-')), []);
});

test('discard accepts only the captured owned identity and preserves every other owned file', t => {
  const root = owner(t), w = makeWorkspace(root), a = slot(w, 'first', 'first original'), b = slot(w, 'second', 'second original');
  assert.throws(() => w.discardOwned(a.path, { ...a.identity, ino: a.identity.ino + 1 }), rejected);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'first original');
  w.discardOwned(a.path, a.identity); assert.equal(fs.existsSync(a.path), false); assert.equal(fs.readFileSync(b.path, 'utf8'), 'second original');
  assert.throws(() => w.discardOwned(a.path, a.identity), rejected);
  w.cleanup(); assert.equal(fs.existsSync(w.root), false);
});

test('discard rejects replacement even when caller supplies its new identity; displaced original and replacement both remain', t => {
  const root = owner(t), w = makeWorkspace(root), a = slot(w, 'original', 'captured');
  const displaced = join(w.root, 'displaced'); fs.renameSync(a.path, displaced); fs.writeFileSync(a.path, 'replacement', { mode: 0o600 });
  assert.throws(() => w.discardOwned(a.path, identity(fs.statSync(a.path))), rejected);
  assert.throws(() => w.discardOwned(a.path, a.identity), rejected);
  assert.equal(fs.readFileSync(displaced, 'utf8'), 'captured'); assert.equal(fs.readFileSync(a.path, 'utf8'), 'replacement');
});

test('discard cannot remove a foreign sidecar even when adoptSidecars previously entered it in the owned map', t => {
  const root = owner(t), w = makeWorkspace(root), path = join(root, 'foreign.sqlite'), wal = path + '-wal';
  fs.writeFileSync(wal, 'foreign captured sidecar', { mode: 0o600 }); w.adoptSidecars(path);
  assert.throws(() => w.discardOwned(wal, identity(fs.statSync(wal))), rejected);
  assert.equal(fs.readFileSync(wal, 'utf8'), 'foreign captured sidecar');
});

test('discard rejects nonowned paths, aliases, unsafe mode, hardlink and symlink without deleting original bytes', t => {
  const root = owner(t), w = makeWorkspace(root), other = makeWorkspace(root), a = slot(w, 'original', 'captured original'), b = slot(other, 'other', 'other original');
  const foreign = join(root, 'source-or-key'); fs.writeFileSync(foreign, 'foreign preserved', { mode: 0o600 });
  for (const path of [foreign, b.path, join(w.root, '..', 'source-or-key'), join(w.root, 'not-owned')])
    assert.throws(() => w.discardOwned(path, a.identity), rejected);
  fs.chmodSync(a.path, 0o644); assert.throws(() => w.discardOwned(a.path, a.identity), rejected); fs.chmodSync(a.path, 0o600);
  const alias = a.path + '.hardlink'; fs.linkSync(a.path, alias); assert.throws(() => w.discardOwned(a.path, a.identity), rejected);
  assert.equal(fs.readFileSync(alias, 'utf8'), 'captured original'); fs.unlinkSync(alias);
  const displaced = a.path + '.displaced'; fs.renameSync(a.path, displaced); fs.symlinkSync(displaced, a.path);
  assert.throws(() => w.discardOwned(a.path, a.identity), rejected);
  assert.equal(fs.readFileSync(displaced, 'utf8'), 'captured original'); assert.equal(fs.readFileSync(b.path, 'utf8'), 'other original'); assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign preserved');
});

test('discard refuses a replaced root or parent before removing the displaced owned original', t => {
  for (const replaceParent of [false, true]) {
    const root = owner(t), w = makeWorkspace(root), a = slot(w, 'original', 'preserved original');
    const replaced = replaceParent ? root : w.root, held = replaced + '-held';
    t.after(() => fs.rmSync(held, { recursive: true, force: true }));
    fs.renameSync(replaced, held); fs.mkdirSync(replaced, { mode: 0o700 });
    assert.throws(() => w.discardOwned(a.path, a.identity), rejected);
    const heldOriginal = replaceParent ? join(held, w.root.slice(root.length + 1), 'original') : join(held, 'original');
    assert.equal(fs.readFileSync(heldOriginal, 'utf8'), 'preserved original');
  }
});

test('unlink or directory sync failure never publishes an unverified archive or changes operator source or key', async t => {
  for (const fault of ['unlink', 'sync']) {
    const f = database(t), before = inspectProductionDatabase(f.db), keyBefore = Buffer.from(f.key), sourceBytes = fs.readFileSync(f.path), originalUnlink = fs.unlinkSync, originalOpen = fs.openSync, originalSync = fs.fsyncSync;
    let triggered = false, workspaceRoot; const directories = new Map();
    t.mock.method(fs, 'openSync', function(path, ...args) {
      const fd = originalOpen.call(this, path, ...args);
      if (typeof path === 'string' && path.endsWith('/archive.pending')) workspaceRoot = path.slice(0, path.lastIndexOf('/'));
      if (typeof path === 'string' && (args[0] & fs.constants.O_DIRECTORY)) directories.set(fd, path);
      else directories.delete(fd);
      return fd;
    });
    t.mock.method(fs, 'unlinkSync', function(path) {
      if (fault === 'unlink' && !triggered && typeof path === 'string' && path.endsWith('/snapshot.sqlite')) { triggered = true; throw Object.assign(new Error('synthetic owned unlink failure'), { code: 'EIO' }); }
      return originalUnlink.call(this, path);
    });
    t.mock.method(fs, 'fsyncSync', function(fd) {
      if (fault === 'sync' && !triggered && workspaceRoot && directories.get(fd) === workspaceRoot && !fs.existsSync(join(workspaceRoot, 'snapshot.sqlite'))) { triggered = true; throw Object.assign(new Error('synthetic owned directory sync failure'), { code: 'EIO' }); }
      return originalSync.call(this, fd);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(createProductionBackup({ databasePath: f.path, outputPath: f.backupPath, key: f.key }), error => error?.code === 'OPERATION_FAILED');
      assert(triggered); assert.equal(fs.existsSync(f.backupPath), false); assert.deepEqual(inspectProductionDatabase(f.db), before); assert(f.key.equals(keyBefore)); assert(fs.readFileSync(f.path).equals(sourceBytes));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); keyBefore.fill(0); }
  }
});
