import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, linkSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDb } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { createSyntheticLegacyMigrationFixture } from './helpers/legacy-migration-fixture.mjs';

const script = fileURLToPath(new URL('../scripts/legacy-operational-import.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const db = new DatabaseSync(':memory:'), orgId = randomUUID(), actorId = randomUUID(), stamp = '2020-01-01T00:00:00.000Z';
  initDb(db); initPortalStorage(db);
  const ctx = { orgId, user: { id: actorId }, role: 'admin' }, source = createSyntheticLegacyMigrationFixture(db, ctx), filename = path.join(source.rootPath, 'care.sqlite');
  db.close();
  const disk = new DatabaseSync(filename); initDb(disk, { configureJournalMode: false }); initPortalStorage(disk);
  disk.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成CLI機構', stamp);
  disk.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(actorId, '合成CLI管理員', 'synthetic-cli@example.test', 'synthetic-no-password', stamp);
  disk.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, actorId, 'admin', null); disk.close(); chmodSync(filename, 0o600);
  t.after(source.cleanup);
  const args = operation => [operation, '--source', source.sourcePath, '--db', filename, '--org-id', orgId, '--actor-id', actorId, '--archive', source.archivePath, '--expected-manifest-sha256', source.capture.manifestSha256];
  const run = values => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...values], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 20000 });
    assert.equal(result.signal, null); return result;
  };
  return { ...source, filename, orgId, actorId, args, run };
}

test('actual operator CLI preview preserves exact existing SQLite bytes; commit/replay creates no accounts or rates', t => {
  const f = fixture(t), before = hash(readFileSync(f.filename)), names = readdirSync(f.rootPath), preview = f.run(f.args('preview'));
  assert.equal(preview.status, 0, preview.stderr); assert.equal(preview.stderr, ''); assert.equal(hash(readFileSync(f.filename)), before); assert.deepEqual(readdirSync(f.rootPath), names);
  const data = JSON.parse(preview.stdout); assert.equal(data.totalCount, 2); assert.equal(data.sourceSystemComplete, false);
  assert(!preview.stdout.includes('合成CLI')); assert(!preview.stdout.includes(f.rootPath)); assert(!preview.stdout.includes('HYPERLINK')); assert(!preview.stdout.includes('synthetic-cli@example.test'));
  const committed = f.run([...f.args('commit'), '--preview-hash', data.previewHash]); assert.equal(committed.status, 0, committed.stderr); const receipt = JSON.parse(committed.stdout);
  assert.equal(receipt.importedCount, 2); const after = hash(readFileSync(f.filename));
  const replay = f.run([...f.args('commit'), '--preview-hash', data.previewHash]); assert.equal(replay.status, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).replayed, true); assert.equal(hash(readFileSync(f.filename)), after);
  const db = new DatabaseSync(f.filename, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memberships').get().n, 1);
    const employee = JSON.parse(db.prepare("SELECT data FROM records WHERE entity='employees'").get().data); assert(!Object.hasOwn(employee, 'hourlyRateCents'));
  } finally { db.close(); }
});

test('missing preview hash, unsupported args and missing existing DB fail without creating or altering files', t => {
  const f = fixture(t), before = hash(readFileSync(f.filename)), bad = [...f.args('preview'), '--watch'];
  for (const args of [[], bad, f.args('commit'), [...f.args('preview'), '--actor-id', f.actorId]]) {
    const result = f.run(args); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).code, 'LEGACY_IMPORT_ARGUMENTS_INVALID'); assert(!result.stderr.includes(f.rootPath));
  }
  const missing = f.args('preview'); missing[missing.indexOf('--db') + 1] = path.join(f.rootPath, 'missing.sqlite');
  assert.equal(f.run(missing).status, 1); assert(!readdirSync(f.rootPath).includes('missing.sqlite')); assert.equal(hash(readFileSync(f.filename)), before);
});

test('non-admin current actor and wrong organization cannot use the operator CLI even with an admin actor argument', t => {
  const f = fixture(t);
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const db = new DatabaseSync(f.filename); db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run(role, f.orgId, f.actorId); db.close();
    const before = hash(readFileSync(f.filename)), result = f.run(f.args('preview')); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'ROLE_FORBIDDEN'); assert.equal(hash(readFileSync(f.filename)), before);
  }
  const args = f.args('preview'); args[args.indexOf('--org-id') + 1] = randomUUID();
  const result = f.run(args); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'ROLE_FORBIDDEN');
});

test('private source and DB path guards reject symlinks, hardlinks and unsafe modes before SQLite writes', t => {
  const f = fixture(t), before = hash(readFileSync(f.filename)), alias = path.join(f.rootPath, 'alias.sqlite');
  for (const make of [() => symlinkSync(f.filename, alias), () => linkSync(f.filename, alias)]) {
    make(); const args = f.args('preview'); args[args.indexOf('--db') + 1] = alias; assert.equal(f.run(args).status, 1); unlinkSync(alias);
  }
  chmodSync(f.filename, 0o644); assert.equal(f.run(f.args('preview')).status, 1); chmodSync(f.filename, 0o600);
  chmodSync(f.sourcePath, 0o644); assert.equal(f.run(f.args('preview')).status, 1); chmodSync(f.sourcePath, 0o600);
  assert.equal(hash(readFileSync(f.filename)), before);
});

test('duplicate JSON keys, unknown raw data and changed archived source are fixed-code failures with zero writes', t => {
  const f = fixture(t), before = hash(readFileSync(f.filename)), original = readFileSync(f.sourcePath, 'utf8');
  writeFileSync(f.sourcePath, '{"format":"x",' + original.slice(1)); let result = f.run(f.args('preview')); assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.deepEqual(Object.keys(JSON.parse(result.stderr)), ['status', 'code']); assert(!result.stderr.includes(f.rootPath));
  const wrong = JSON.parse(original); wrong.records[0].columns[0].raw = { private: 'synthetic-bank-account' }; writeFileSync(f.sourcePath, JSON.stringify(wrong));
  result = f.run(f.args('preview')); assert.equal(result.status, 1); const error = JSON.parse(result.stderr); assert.equal(error.code, 'LEGACY_IMPORT_INVALID'); assert.equal(error.recordIndex, 1); assert(!result.stderr.includes('synthetic-bank-account'));
  writeFileSync(f.sourcePath, original); const preview = JSON.parse(f.run(f.args('preview')).stdout);
  writeFileSync(path.join(f.archivePath, 'files', '00000001.csv'), 'synthetic archive changed'); result = f.run([...f.args('commit'), '--preview-hash', preview.previewHash]);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'LEGACY_IMPORT_ARCHIVE_INVALID'); assert.equal(hash(readFileSync(f.filename)), before);
});
