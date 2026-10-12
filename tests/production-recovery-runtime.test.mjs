import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, chmodSync, readFileSync, realpathSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { createApp } from '../src/server/index.mjs';
import { createProductionBackup, restoreProductionBackupIsolated } from '../src/server/production-backup.mjs';

test('actual createApp rejects pending restored database and aliases before opening or initializing SQLite', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'hc-recovery-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source.sqlite'), archive = join(root, 'saved.hcbak'), key = randomBytes(32);
  t.after(() => key.fill(0));
  const db = new DatabaseSync(source);
  try { initDb(db); initPortalStorage(db); } finally { db.close(); }
  chmodSync(source, 0o600);
  await createProductionBackup({ databasePath: source, outputPath: archive, key });
  const destination = join(root, 'quarantine');
  const restored = await restoreProductionBackupIsolated({ backupPath: archive, destinationDirectory: destination, key });
  assert.equal(restored.productionReady, false);
  const isolated = join(destination, 'isolated.sqlite'), bytes = readFileSync(isolated), names = readdirSync(destination).sort();
  const directoryAlias = join(root, 'directory-alias'), fileAlias = join(root, 'file-alias.sqlite');
  symlinkSync(destination, directoryAlias); symlinkSync(isolated, fileAlias);
  for (const path of [isolated, join(directoryAlias, 'isolated.sqlite'), fileAlias]) {
    assert.throws(() => createApp({ dbPath: path, port: 0 }), error => error.code === 'RECOVERY_PENDING');
    assert.deepEqual(readFileSync(isolated), bytes);
    assert.deepEqual(readdirSync(destination).sort(), names);
  }
  assert.equal(names.some(name => /-wal$|-shm$|-journal$/.test(name)), false);
});

test('ordinary memory runtime keeps its existing initialization and local login contract', async t => {
  const app = createApp({ dbPath: ':memory:', port: 0 });
  t.after(() => app.close());
  const origin = await app.listen(), response = await fetch(origin + '/api/setup/status');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).needsSetup, true);
});
