import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, readdirSync, chmodSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';

const CLI = fileURLToPath(new URL('../scripts/production-backup.mjs', import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'homecare-production-cli-owned-')), databasePath = join(directory, 'owned.sqlite'), keyPath = join(directory, 'key.bin'), backupPath = join(directory, 'backup.hcb'), key = randomBytes(32);
  const db = new DatabaseSync(databasePath); initDb(db); initPortalStorage(db);
  const id = randomUUID(), org = randomUUID(), stamp = '2026-10-12T00:00:00.000Z';
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org, '合成CLI機構', stamp);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, '合成CLI帳號', 'production-cli-synthetic@example.invalid', 'synthetic-password-not-real', stamp);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org, id, 'admin', null);
  for (const name of readdirSync(directory)) chmodSync(join(directory, name), 0o600);
  writeFileSync(keyPath, key, { mode: 0o600 });
  t.after(() => { db.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); });
  return { directory, databasePath, keyPath, backupPath, key };
}
const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, timeout: 15_000 });
const errorResult = result => JSON.parse(result.stderr.split('\n').find(line => line.startsWith('{"ok":false')));
function noReflections(result, f) {
  const text = result.stdout + result.stderr;
  for (const secret of [f.directory, f.key.toString('hex'), f.key.toString('base64'), 'production-cli-synthetic@example.invalid', 'synthetic-password-not-real']) assert(!text.includes(secret));
}

test('operator CLI backup/key-file, verify/piped key, new isolation and blocked reconciliation work with no secret reflection', t => {
  const f = fixture(t);
  const backup = run(['backup', '--database', f.databasePath, '--output', f.backupPath, '--key-file', f.keyPath]);
  assert.equal(backup.status, 0, backup.stderr); assert.equal(JSON.parse(backup.stdout).tableCount, 13); noReflections(backup, f);
  const verify = run(['verify', '--backup', f.backupPath, '--key-stdin'], f.key);
  assert.equal(verify.status, 0, verify.stderr); assert.equal(JSON.parse(verify.stdout).verified, true); noReflections(verify, f);
  const destination = join(f.directory, 'restore');
  const restore = run(['restore-isolated', '--backup', f.backupPath, '--destination', destination, '--key-file', f.keyPath]);
  assert.equal(restore.status, 0, restore.stderr); assert.equal(JSON.parse(restore.stdout).productionReady, false); noReflections(restore, f);
  const prepare = run(['prepare-reconcile', '--destination', destination]);
  assert.equal(prepare.status, 0, prepare.stderr); assert.equal(JSON.parse(prepare.stdout).grantsEnabled, 0); assert.equal(JSON.parse(prepare.stdout).recoveryPending, true); noReflections(prepare, f);
  assert.equal(statSync(join(destination, 'isolated.sqlite')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(destination, 'RECOVERY_PENDING.json'))).oldSigningKeyMayBeReused, false);
});

test('CLI refuses plaintext/dual/missing keys, force/live activation and duplicate flags before any destination write', t => {
  const f = fixture(t), secret = 'SYNTHETIC-ARGUMENT-SECRET-NEVER-REFLECT';
  for (const args of [
    ['backup', '--database', f.databasePath, '--output', f.backupPath, '--key', secret],
    ['backup', '--database', f.databasePath, '--output', f.backupPath],
    ['backup', '--database', f.databasePath, '--output', f.backupPath, '--key-file', f.keyPath, '--key-stdin'],
    ['backup', '--database', f.databasePath, '--output', f.backupPath, '--key-file', f.keyPath, '--force'],
    ['backup', '--database', f.databasePath, '--database', f.databasePath, '--output', f.backupPath, '--key-file', f.keyPath],
    ['activate', '--destination', f.directory],
    ['restore-live', '--database', f.databasePath],
    ['prepare-reconcile', '--destination', f.directory, '--allow-missing-authority'],
  ]) {
    const result = run(args); assert.equal(result.status, 2); assert.equal(errorResult(result).code, 'INVALID_ARGUMENT');
    assert(!result.stderr.includes(secret)); noReflections(result, f);
  }
  assert(!readdirSync(f.directory).includes('backup.hcb'));
});

test('CLI wrong key, unsafe key-file mode and oversized stdin return bounded native failures and preserve backup', t => {
  const f = fixture(t), valid = run(['backup', '--database', f.databasePath, '--output', f.backupPath, '--key-file', f.keyPath]); assert.equal(valid.status, 0);
  const before = readFileSync(f.backupPath);
  const wrong = run(['verify', '--backup', f.backupPath, '--key-stdin'], randomBytes(32)); assert.equal(wrong.status, 1); assert.equal(errorResult(wrong).code, 'AUTHENTICATION_FAILED'); noReflections(wrong, f);
  chmodSync(f.keyPath, 0o640); const unsafe = run(['verify', '--backup', f.backupPath, '--key-file', f.keyPath]); assert.equal(unsafe.status, 1); assert.equal(errorResult(unsafe).code, 'UNSAFE_PATH'); noReflections(unsafe, f);
  const tooLong = run(['verify', '--backup', f.backupPath, '--key-stdin'], Buffer.alloc(64, 5)); assert.equal(tooLong.status, 1); assert.equal(errorResult(tooLong).code, 'KEY_INVALID'); noReflections(tooLong, f);
  assert(readFileSync(f.backupPath).equals(before));
});
