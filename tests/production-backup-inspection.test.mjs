import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initDb } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { inspectProductionDatabase } from '../src/server/production-backup-inspection.mjs';

const stamp = '2026-10-12T00:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error?.name === 'ProductionBackupError' && error.code === expected && !error.message.includes('synthetic-private-marker') && !Object.hasOwn(error, 'cause');
function database(t) {
  const db = new DatabaseSync(':memory:'); initDb(db); initPortalStorage(db);
  t.after(() => db.close()); return db;
}
function populated(t, { snapshot = 'opaque-snapshot\u0000tail', data = '{"fraction":1.2500,"text":"opaque\\u0000"}', blobDigest } = {}) {
  const db = database(t), org = 'synthetic-org\u0000tail', record = 'synthetic-record\u0000tail', blob = Buffer.from([0, 255, 1, 128, 10, 13]);
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org, '完整TEXT\u0000尾部', stamp);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('synthetic-user', '合成人員\u0000尾部', 'synthetic-inspection@example.test', 'synthetic-private-marker\u0000尾部', stamp);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org, 'synthetic-user', 'admin', null);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('synthetic-token', 'synthetic-user', 'synthetic-csrf\u0000尾部', 9223372036854775807n);
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(record, org, 'service-records', data, 4, stamp, stamp);
  // Legacy backfill may have only its current version. Storage inspection does
  // not invent a complete historical chain or parse domain snapshot JSON.
  db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(org, 'service-records', record, 4, snapshot, stamp, 'baseline');
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run('synthetic-audit', null, null, 'synthetic-only', null, record, '{"amount":1.2500}\u0000尾部', stamp);
  db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run(org, 'synthetic-user', 'synthetic-key', 'POST /synthetic', 'synthetic-hash', '{"amount":1.2500}\u0000尾部', 201, stamp);
  db.prepare('INSERT INTO demo_seeds VALUES(?,?)').run(org, stamp);
  db.prepare('INSERT INTO attachment_files VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-case-file', org, record, record, '合成\u0000.pdf', 'application/pdf', blob.length, blobDigest ?? hash(blob), blob, stamp);
  db.prepare('INSERT INTO certification_attachment_files VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-cert-file', org, record, record, record, '合成.png', 'image/png', blob.length, hash(blob), blob, stamp);
  db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run('https://synthetic.example.test\u0000尾部', 'synthetic-subject', 'synthetic-auth', 'synthetic-inspection@example.test', 'synthetic-user', org, 0, stamp);
  db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run('synthetic-jti\u0000尾部', 'https://synthetic.example.test', 'synthetic-user', org, 1.25, -9223372036854775808n);
  return db;
}

test('fixed thirteen-table proof retains caller transaction and performs zero operator writes', t => {
  const db = populated(t), before = db.prepare('SELECT total_changes() AS value').get().value;
  db.exec('BEGIN IMMEDIATE');
  const proof = inspectProductionDatabase(db);
  assert.equal(db.isTransaction, true); assert.equal(db.prepare('SELECT total_changes() AS value').get().value, before);
  db.exec('ROLLBACK'); assert.equal(db.isTransaction, false);
  assert.equal(proof.format, 'suiyue-production-sqlite-inspection-v1'); assert.equal(proof.tableCount, 13); assert.equal(proof.triggerCount, 6);
  assert.equal(Object.keys(proof.tables).length, 13); assert(Object.values(proof.tables).every(value => value.count === 1));
  assert.equal(proof.versionsSha256, proof.tables.record_versions.sha256); assert.equal(Object.keys(proof.blobSha256).length, 2);
  assert.equal(proof.userVersion, 0); assert.equal(proof.applicationId, 0); assert(Object.isFrozen(proof)); assert(Object.isFrozen(proof.tables.users));
  assert.deepEqual(inspectProductionDatabase(db), proof); assert.equal(db.isTransaction, false);
});

test('complete NUL suffixes, 64-bit integers, REAL bits and opaque JSON changes affect exact saved-row proof', t => {
  const db = populated(t), original = inspectProductionDatabase(db);
  db.prepare('UPDATE organizations SET name=?').run('完整TEXT\u0000另一尾部');
  let changed = inspectProductionDatabase(db); assert.notEqual(changed.tables.organizations.sha256, original.tables.organizations.sha256);
  db.prepare('UPDATE sessions SET expires_at=?').run(9223372036854775806n);
  const next = inspectProductionDatabase(db); assert.notEqual(next.tables.sessions.sha256, changed.tables.sessions.sha256);
  db.prepare('UPDATE portal_handoff_nonces SET consumed_at=?').run(1.2500000000000002);
  changed = inspectProductionDatabase(db); assert.notEqual(changed.tables.portal_handoff_nonces.sha256, next.tables.portal_handoff_nonces.sha256);
  const alternate = inspectProductionDatabase(populated(t, { data: '{"fraction":1.25,"text":"opaque\\u0000"}', snapshot: 'opaque-snapshot\u0000another-tail' }));
  assert.notEqual(alternate.tables.records.sha256, original.tables.records.sha256); assert.notEqual(alternate.versionsSha256, original.versionsSha256);
  assert.equal(alternate.blobSha256.attachment_files, original.blobSha256.attachment_files); assert.notEqual(alternate.fingerprint, original.fingerprint);
});

test('PK storage-type and complete byte ordering produces identical proof across insertion order', t => {
  const keys = ['synthetic\u0000a', 'synthetic\u0000b', 'é', 'a', Buffer.from([0, 255]), Buffer.from([0, 128])];
  const left = database(t), right = database(t);
  for (const value of keys) left.prepare('INSERT INTO organizations VALUES(?,?,?)').run(value, 'same\u0000complete', stamp);
  for (const value of [...keys].reverse()) right.prepare('INSERT INTO organizations VALUES(?,?,?)').run(value, 'same\u0000complete', stamp);
  assert.deepEqual(inspectProductionDatabase(left), inspectProductionDatabase(right));
});

test('operator table rows are streamed without whole-table all() reads', t => {
  const db = populated(t), prepare = db.prepare.bind(db); let streamedTables = 0;
  db.prepare = sql => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, property) {
      if (property === 'all') return () => { throw new Error('synthetic-private-marker: whole-table array forbidden'); };
      if (property === 'iterate') return (...args) => { if (sql.includes(' AS "_storage_0"')) streamedTables++; return target.iterate(...args); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  assert.equal(inspectProductionDatabase(db).tableCount, 13); assert.equal(streamedTables, 13);
});

test('all thirteen generated row scans use PK ordering without a temporary ORDER BY B-tree', t => {
  const db = populated(t), prepare = db.prepare.bind(db), scans = [];
  db.prepare = sql => {
    if (sql.includes(' AS "_storage_0"')) scans.push(sql);
    return prepare(sql);
  };
  inspectProductionDatabase(db);
  assert.equal(scans.length, 13);
  for (const sql of scans) {
    const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all();
    assert(plan.length > 0);
    assert(!plan.some(step => /USE TEMP B-TREE FOR ORDER BY/i.test(step.detail)), 'The actual generated PK scan must not spill sorted plaintext rows');
  }
});

test('unknown tables, extra columns, wrong trigger SQL and different schema headers fail closed', t => {
  for (const sql of [
    'CREATE TABLE synthetic_extra(value TEXT)',
    'ALTER TABLE organizations ADD COLUMN synthetic_extra TEXT',
    "DROP TRIGGER versions_no_update; CREATE TRIGGER versions_no_update BEFORE UPDATE ON record_versions BEGIN SELECT 1; END;",
    'PRAGMA user_version=1', 'PRAGMA application_id=1',
  ]) { const db = database(t); db.exec(sql); assert.throws(() => inspectProductionDatabase(db), code('SCHEMA_MISMATCH')); }
});

test('foreign-key violations cannot be accepted by a matching schema', t => {
  const db = database(t); db.exec('PRAGMA foreign_keys=OFF');
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('synthetic-missing-org', 'synthetic-missing-user', 'admin', null);
  db.exec('PRAGMA foreign_keys=ON'); assert.throws(() => inspectProductionDatabase(db), code('FOREIGN_KEY_FAILED'));
});

test('current history must exist with the same record, organization, entity and version', t => {
  for (const variant of ['missing', 'org', 'entity', 'version']) {
    const db = database(t); db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('synthetic-org', '合成', stamp);
    db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('synthetic-other-org', '合成二', stamp);
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run('synthetic-record', 'synthetic-org', 'cases', '{}', 2, stamp, stamp);
    if (variant !== 'missing') db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(variant === 'org' ? 'synthetic-other-org' : 'synthetic-org', variant === 'entity' ? 'employees' : 'cases', 'synthetic-record', variant === 'version' ? 1 : 2, '{}', stamp, 'baseline');
    assert.throws(() => inspectProductionDatabase(db), code('HISTORY_INCOMPLETE'));
  }
});

test('nullable SQLite TEXT primary keys and stored BLOB digest mismatches are refused', t => {
  const db = database(t); db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(null, '合成', stamp);
  assert.throws(() => inspectProductionDatabase(db), code('INTEGRITY_FAILED'));
  for (const digest of ['0'.repeat(64), hash(Buffer.from([0, 255, 1, 128, 10, 13])) + '\u0000synthetic-private-marker']) {
    assert.throws(() => inspectProductionDatabase(populated(t, { blobDigest: digest })), code('INTEGRITY_FAILED'));
  }
});

test('SQLite CHECK corruption, closed connections and unsupported argument objects expose only static codes', t => {
  const db = populated(t); db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare('INSERT INTO attachment_files VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-corrupt-blob', 'synthetic-org\u0000tail', 'synthetic-record\u0000tail', 'synthetic-record\u0000tail', '合成.pdf', 'application/pdf', 9, '0'.repeat(64), Buffer.from([1]), stamp);
  db.exec('PRAGMA ignore_check_constraints=OFF'); assert.throws(() => inspectProductionDatabase(db), code('INTEGRITY_FAILED'));
  const closed = new DatabaseSync(':memory:'); closed.close(); assert.throws(() => inspectProductionDatabase(closed), code('OPERATION_FAILED'));
  assert.throws(() => inspectProductionDatabase({ prepare() { throw new Error('synthetic-private-marker'); } }), code('OPERATION_FAILED'));
  assert.throws(() => inspectProductionDatabase(db, {}), code('OPERATION_FAILED'));
});
