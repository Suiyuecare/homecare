import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initDb, insert } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { createProductionBackup, verifyProductionBackup, restoreProductionBackupIsolated } from '../src/server/production-backup.mjs';

const rejected = code => error => error?.name === 'ProductionBackupError' && error.code === code;
async function fixture(t) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'homecare-stream-failure-synthetic-'));
  fs.chmodSync(root, 0o700);
  const databasePath = join(root, 'source.sqlite'), backupPath = join(root, 'archive.hcb'), key = randomBytes(32);
  const db = new DatabaseSync(databasePath);
  try {
    initDb(db); initPortalStorage(db);
    const orgId = randomUUID();
    db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成機構', '2026-10-13T00:00:00.000Z');
    insert(db, orgId, 'cases', { caseNo: 'SYN-STREAM-FAILURE', note: '完整\u0000尾字' });
    db.exec('PRAGMA journal_mode=DELETE');
  } finally { db.close(); }
  fs.chmodSync(databasePath, 0o600);
  t.after(() => { key.fill(0); fs.rmSync(root, { recursive: true, force: true }); });
  await createProductionBackup({ databasePath, outputPath: backupPath, key });
  return { root, databasePath, backupPath, key };
}
function observeDescriptors(t, onWrite, onSync) {
  const original = { open: fs.openSync, close: fs.closeSync, write: fs.writeSync, sync: fs.fsyncSync };
  const opened = new Map();
  t.mock.method(fs, 'openSync', function(path, ...args) {
    const fd = original.open.call(this, path, ...args); opened.set(fd, path); return fd;
  });
  t.mock.method(fs, 'closeSync', function(fd) {
    const result = original.close.call(this, fd); opened.delete(fd); return result;
  });
  t.mock.method(fs, 'writeSync', function(fd, ...args) {
    onWrite?.(opened.get(fd), fd); return original.write.call(this, fd, ...args);
  });
  t.mock.method(fs, 'fsyncSync', function(fd) {
    onSync?.(opened.get(fd), fd); return original.sync.call(this, fd);
  });
  syncBuiltinESMExports();
  return { opened, restore() { t.mock.restoreAll(); syncBuiltinESMExports(); } };
}

for (const fault of ['write', 'fsync']) test('stream candidate ' + fault + ' failure closes all descriptors, preserves inputs, and publishes no restore', async t => {
  const f = await fixture(t), sourceBefore = fs.readFileSync(f.databasePath), archiveBefore = fs.readFileSync(f.backupPath), keyBefore = Buffer.from(f.key);
  const destinationDirectory = join(f.root, 'isolation'), foreign = join(f.root, 'foreign');
  fs.writeFileSync(foreign, 'foreign file preserved', { mode: 0o600 });
  let fired = false;
  const failOnce = path => {
    if (!fired && typeof path === 'string' && path.endsWith('/restored.sqlite')) {
      fired = true; throw Object.assign(new Error('synthetic owned I/O failure'), { code: 'EIO' });
    }
  };
  const observer = observeDescriptors(t, fault === 'write' ? failOnce : undefined, fault === 'fsync' ? failOnce : undefined);
  try {
    await assert.rejects(restoreProductionBackupIsolated({ backupPath: f.backupPath, destinationDirectory, key: f.key }), rejected('OPERATION_FAILED'));
    assert(fired, 'fault must execute on the actual candidate descriptor'); assert.equal(observer.opened.size, 0);
    assert.equal(fs.existsSync(destinationDirectory), false);
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.homecare-backup-')), []);
    assert(fs.readFileSync(f.databasePath).equals(sourceBefore)); assert(fs.readFileSync(f.backupPath).equals(archiveBefore)); assert(f.key.equals(keyBefore));
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign file preserved');
  } finally { observer.restore(); keyBefore.fill(0); }
  assert((await verifyProductionBackup({ backupPath: f.backupPath, key: f.key })).verified, 'unmodified input remains usable after the failed attempt');
});

test('stream candidate identity replacement is rejected without deleting the displaced original or foreign replacement', async t => {
  const f = await fixture(t), archiveBefore = fs.readFileSync(f.backupPath), keyBefore = Buffer.from(f.key);
  const destinationDirectory = join(f.root, 'isolation');
  let displaced, replacement, fired = false;
  const observer = observeDescriptors(t, undefined, path => {
    if (!fired && typeof path === 'string' && path.endsWith('/restored.sqlite')) {
      fired = true; replacement = path; displaced = join(dirname(path), 'displaced-original.sqlite');
      fs.renameSync(path, displaced); fs.writeFileSync(path, 'foreign replacement preserved', { mode: 0o600 });
    }
  });
  try {
    await assert.rejects(restoreProductionBackupIsolated({ backupPath: f.backupPath, destinationDirectory, key: f.key }), rejected('UNSAFE_PATH'));
    assert(fired); assert.equal(observer.opened.size, 0); assert.equal(fs.existsSync(destinationDirectory), false);
    assert.equal(fs.readFileSync(replacement, 'utf8'), 'foreign replacement preserved');
    assert.equal(fs.readFileSync(displaced).subarray(0, 16).toString(), 'SQLite format 3\u0000');
    assert.equal(fs.statSync(displaced).mode & 0o777, 0o600);
    assert(fs.readFileSync(f.backupPath).equals(archiveBefore)); assert(f.key.equals(keyBefore));
  } finally { observer.restore(); keyBefore.fill(0); }
});
