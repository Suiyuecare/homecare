import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  constants, chmodSync, copyFileSync, existsSync, linkSync, lstatSync,
  mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import * as core from '../src/server/synthetic-backup.mjs';
import { initDb } from '../src/server/model.mjs';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticBackupFixture } from './synthetic-backup-fixtures.mjs';

// This suite opens only factory-created synthetic slots. Its oracle reads saved
// columns independently; assertion failures show digests, never raw secret rows.
const TABLES = [
  'attachment_files', 'audit', 'certification_attachment_files', 'demo_seeds',
  'idempotency', 'memberships', 'organizations', 'record_versions', 'records',
  'sessions', 'users',
];
const TRIGGERS = [
  'attachment_files_no_delete', 'attachment_files_no_update',
  'certification_attachment_files_no_delete', 'certification_attachment_files_no_update',
  'versions_no_delete', 'versions_no_update',
];
const EXPORTS = [
  'captureSyntheticBackup', 'createSyntheticWorkspace', 'disposeSyntheticWorkspace',
  'inspectSyntheticDatabase', 'promoteSyntheticRestore', 'restoreSyntheticBackup',
  'syntheticDatabasePath',
];
const sha = value => createHash('sha256').update(value).digest('hex');
const owned = new Set(), applications = new Set();
const stamp = '2026-10-09T00:00:00.000Z';
let fixture, fixtureWorkspace, fixtureRef, fixtureCaptureProof;

const quote = identifier => `"${identifier.replaceAll('"', '""')}"`;
function cell(value) {
  if (value === null) return ['N'];
  if (typeof value === 'bigint') return ['I', value.toString()];
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value);
    return ['R', bytes.toString('hex')];
  }
  if (typeof value === 'string') return ['T', value];
  if (value instanceof Uint8Array) return ['B', Buffer.from(value).toString('hex')];
  throw new Error('Unsupported independent SQLite storage-class oracle');
}
function queryBig(db, sql) {
  const statement = db.prepare(sql); statement.setReadBigInts(true);
  return statement.all();
}
function oracleDb(db) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = {};
  for (const { name } of schema.filter(row => row.type === 'table')) {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => row.name);
    // The minimum node:sqlite driver truncates returned JS TEXT at embedded NUL.
    // SQL-derived UTF8 bytes avoid that read path. This independent oracle keeps
    // its own T8 tag/hex form; the core's serializer is never imported or reused.
    const projection = columns.flatMap((column, index) => [quote(column),
      `CASE WHEN typeof(${quote(column)})='text' THEN hex(CAST(${quote(column)} AS BLOB)) ELSE NULL END AS ${quote('__oracle_utf8_' + index)}`]);
    const rows = queryBig(db, `SELECT ${projection.join(',')} FROM ${quote(name)}`)
      .map(row => JSON.stringify(columns.map((column, index) => row['__oracle_utf8_' + index] === null
        ? cell(row[column]) : ['T8', row['__oracle_utf8_' + index]])))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    tables[name] = { columns, rows, count: rows.length, digest: sha(JSON.stringify({ columns, rows })) };
  }
  const userVersion = db.prepare('PRAGMA user_version').get().user_version;
  const applicationId = db.prepare('PRAGMA application_id').get().application_id;
  const body = { schema, tables, userVersion, applicationId };
  return { ...body, digest: sha(JSON.stringify(body)), schemaDigest: sha(JSON.stringify({ schema, userVersion, applicationId })) };
}
function oracleFile(filename, { closed = false } = {}) {
  // Closed WAL files can get sidecars even from readonly access. The independent
  // oracle therefore inspects an exclusive owned copy, leaving original bytes alone.
  const scratch = closed ? mkdtempSync(path.join(path.dirname(filename), '.test-oracle-')) : null;
  const inspected = scratch ? path.join(scratch, 'oracle.sqlite') : filename;
  if (scratch) copyFileSync(filename, inspected, constants.COPYFILE_EXCL);
  let db;
  try { db = new DatabaseSync(inspected, { readOnly: true }); return oracleDb(db); }
  finally { db?.close(); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
function sameData(actual, expected, message) { assert.equal(actual.digest, expected.digest, message); }
function slot(ws, name) { return core.syntheticDatabasePath(ws, name); }
function rootOf(ws) { return path.dirname(slot(ws, 'source')); }
async function workspace() { const ws = await core.createSyntheticWorkspace(); owned.add(ws); return ws; }
async function dispose(ws) { await core.disposeSyntheticWorkspace(ws); owned.delete(ws); }
async function rejectsCode(work, code) {
  let error;
  try { await work(); } catch (caught) { error = caught; }
  assert.ok(error, 'The forbidden synthetic operation must reject');
  assert.equal(error.name, 'SyntheticBackupError', 'Synthetic rejection uses its documented error type');
  assert.equal(error.code, code, 'Synthetic rejection uses its documented error code');
  return error;
}
function assertSummary(report) {
  assert.equal(report.format, 'suiyue-synthetic-sqlite-inspection-v1');
  assert.equal(report.tableCount, 11); assert.equal(report.triggerCount, 6);
  assert.equal(report.userVersion, 0); assert.equal(report.applicationId, 0);
  assert.deepEqual(Object.keys(report.tables).sort(), TABLES);
  for (const digest of [report.schemaSha256, report.fingerprint, report.versionsSha256,
    report.billingSnapshotsSha256, report.mainFileSha256, ...Object.values(report.blobSha256),
    ...Object.values(report.tables).map(table => table.sha256)]) {
    assert.match(digest, /^[a-f0-9]{64}$/, 'Only bounded SHA256 metadata is exposed');
  }
  for (const table of Object.values(report.tables)) assert.ok(Number.isSafeInteger(table.count) && table.count >= 0);
  assert.ok(Number.isSafeInteger(report.mainFileBytes) && report.mainFileBytes > 0);
  assert.deepEqual(Object.keys(report).sort(), ['applicationId', 'billingSnapshotsSha256', 'blobSha256',
    'fingerprint', 'format', 'mainFileBytes', 'mainFileSha256', 'schemaSha256', 'tableCount',
    'tables', 'triggerCount', 'userVersion', 'versionsSha256'].sort());
}
function newMiniSource(ws, { reverse = false } = {}) {
  const filename = slot(ws, 'source');
  const db = new DatabaseSync(filename); initDb(db); chmodSync(filename, 0o600);
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('org-mini', '合成 mini 機構', stamp);
  const users = [
    ['u-one', '合成\u0000雪山', 'one@mini.example.test', 'synthetic-password-hash-one', stamp],
    ['u-two', '', 'two@mini.example.test', 'synthetic-password-hash-two', stamp],
  ];
  for (const row of reverse ? [...users].reverse() : users) db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(...row);
  const members = [['org-mini', 'u-one', 'admin', null], ['org-mini', 'u-two', 'finance', '']];
  for (const row of reverse ? [...members].reverse() : members) db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(...row);
  const sessions = [
    [sha('max-session'), 'u-one', 'synthetic-max-csrf', 9223372036854775807n],
    [sha('min-session'), 'u-two', 'synthetic-min-csrf', -9223372036854775808n],
    [sha('real-session'), 'u-one', 'synthetic-real-csrf', 1.25],
    [sha('ordinary-session'), 'u-two', 'synthetic-ordinary-csrf', 1000],
  ];
  for (const row of reverse ? [...sessions].reverse() : sessions) db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(...row);
  const data = '{"name":"合成 mini 個案","caseNo":"MINI-1","note":"完整保存\\u0000字串"}';
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run('r-mini', 'org-mini', 'cases', data, 2, stamp, stamp);
  for (const version of [1, 2]) db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(
    'org-mini', 'cases', 'r-mini', version,
    JSON.stringify({ name: '合成 mini 個案', caseNo: 'MINI-1', note: `合成版本${version}`, id: 'r-mini', orgId: 'org-mini', version, createdAt: stamp, updatedAt: stamp }),
    stamp, version === 1 ? 'create' : 'update');
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run('a-mini', 'org-mini', 'u-one', 'synthetic-oracle', 'cases', 'r-mini', '{"preserved":"原JSON順序","zero":0}', stamp);
  db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run('org-mini', 'u-one', 'mini-key', '/api/cases', 'mini-input-hash', '{"item":{"id":"r-mini"}}', 201, stamp);
  return db;
}
async function miniClosed(options) {
  const ws = await workspace(), db = newMiniSource(ws, options); db.close(); return ws;
}
async function promotedPair() {
  const ws = await miniClosed(), ref = await core.captureSyntheticBackup(ws);
  await core.restoreSyntheticBackup(ws, ref, 'live');
  await core.restoreSyntheticBackup(ws, ref, 'staged');
  const db = new DatabaseSync(slot(ws, 'live'));
  db.prepare('UPDATE organizations SET name=? WHERE id=?').run('合成獨立 original live generation B', 'org-mini'); db.close();
  return { ws, ref };
}

before(async () => {
  fixtureWorkspace = await workspace();
  fixture = await createSyntheticBackupFixture({ workspace: fixtureWorkspace });
  applications.add(fixture.app);
});
after(async () => {
  for (const app of applications) await app.close();
  for (const ws of owned) await core.disposeSyntheticWorkspace(ws);
});

test('synthetic workspace exposes exactly seven operations and rejects forged capabilities/arguments', async () => {
  assert.deepEqual(Object.keys(core).sort(), EXPORTS);
  const ws = await workspace(), root = rootOf(ws);
  assert.ok(Object.isFrozen(ws)); assert.equal(Reflect.ownKeys(ws).length, 0);
  assert.equal(path.dirname(root), realpathSync(tmpdir()));
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  const names = ['source', 'backup', 'staged', 'live', 'previous'];
  const paths = names.map(name => slot(ws, name));
  assert.equal(new Set(paths).size, 5);
  assert.ok(paths.every(filename => path.dirname(filename) === root));
  for (const fake of [{}, { ...ws }, JSON.parse(JSON.stringify(ws)), 'data/care.sqlite']) {
    await rejectsCode(() => core.syntheticDatabasePath(fake, 'source'), 'WORKSPACE_INVALID');
  }
  for (const invalid of [undefined, 'snapshot', '../source', '/source', 'source/../live']) {
    await rejectsCode(() => core.syntheticDatabasePath(ws, invalid), 'INVALID_ARGUMENT');
  }
  await rejectsCode(() => core.createSyntheticWorkspace({ path: root }), 'INVALID_ARGUMENT');
  await rejectsCode(() => core.syntheticDatabasePath(ws, 'source', {}), 'INVALID_ARGUMENT');
  await rejectsCode(() => core.inspectSyntheticDatabase(ws, 'source'), 'SLOT_MISSING');
  await dispose(ws);
  await rejectsCode(() => core.syntheticDatabasePath(ws, 'source'), 'WORKSPACE_INVALID');
  await rejectsCode(() => core.disposeSyntheticWorkspace(ws), 'WORKSPACE_INVALID');
});

test('eleven-table schema, explicit indexes and all six immutable triggers survive and enforce their original rules', async () => {
  const ws = await miniClosed(), expected = oracleFile(slot(ws, 'source'), { closed: true });
  const ref = await core.captureSyntheticBackup(ws); await core.restoreSyntheticBackup(ws, ref, 'live');
  const actual = oracleFile(slot(ws, 'live'), { closed: true });
  assert.deepEqual(Object.keys(actual.tables).sort(), TABLES);
  assert.equal(actual.schemaDigest, expected.schemaDigest);
  assert.deepEqual(actual.schema.filter(row => row.type === 'trigger').map(row => row.name).sort(), TRIGGERS);
  assert.equal(actual.schema.filter(row => row.type === 'index').length, 5);
  const db = new DatabaseSync(slot(ws, 'live'));
  try {
    // Empty BLOB tables still have real trigger enforcement: insert legal bytes
    // and matching parent rows, then verify attempted UPDATE/DELETE cannot change them.
    db.exec('PRAGMA foreign_keys=ON');
    for (const [table, extraColumns, extraValues] of [
      ['attachment_files', 'case_id', ['r-mini']],
      ['certification_attachment_files', 'certification_id,employee_id', ['r-mini', 'r-mini']],
    ]) {
      const columns = `id,org_id,attachment_id,${extraColumns},file_name,mime_type,size_bytes,sha256,content,created_at`;
      const values = ['file-' + table, 'org-mini', 'r-mini', ...extraValues, '合成.bin', 'application/octet-stream', 3, sha(Buffer.from([0, 128, 255])), Buffer.from([0, 128, 255]), stamp];
      db.prepare(`INSERT INTO ${table}(${columns}) VALUES(${values.map(() => '?').join(',')})`).run(...values);
    }
    const before = oracleDb(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
    for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
      for (const operation of [`UPDATE ${table} SET ${table === 'record_versions' ? 'source' : 'file_name'}='changed'`, `DELETE FROM ${table}`]) {
        let rejected = false;
        try { db.exec(operation); } catch (error) { rejected = /immutable/i.test(error.message); }
        assert.ok(rejected, 'The original immutable trigger rejects the SQL mutation');
      }
    }
    sameData(oracleDb(db), before, 'Rejected trigger mutations preserve all saved columns');
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  } finally { db.close(); }
});

test('capture includes a normal API commit after TRUNCATE checkpoint while main bytes remain stale', async () => {
  const source = slot(fixtureWorkspace, 'source');
  assert.equal(fixture.walProof.beforeVersion, 2); assert.equal(fixture.walProof.afterVersion, 3);
  assert.equal(fixture.walProof.mainHashAtCheckpoint, fixture.walProof.mainHashAfterWalWrite);
  assert.ok(fixture.walProof.walBytes > 32);
  const expected = oracleDb(fixture.app.db);
  const mainBefore = sha(readFileSync(source)), walBefore = sha(readFileSync(source + '-wal'));
  const changesBefore = fixture.app.db.prepare('SELECT total_changes() AS n').get().n;
  fixtureRef = await core.captureSyntheticBackup(fixtureWorkspace);
  assert.ok(Object.isFrozen(fixtureRef)); assert.equal(Reflect.ownKeys(fixtureRef).length, 0);
  await core.restoreSyntheticBackup(fixtureWorkspace, fixtureRef, 'staged');
  sameData(oracleFile(slot(fixtureWorkspace, 'staged'), { closed: true }), expected, 'Restored snapshot includes all committed WAL rows');
  const scratch = mkdtempSync(path.join(rootOf(fixtureWorkspace), '.stale-main-proof-'));
  try {
    const stale = path.join(scratch, 'stale.sqlite'); copyFileSync(source, stale, constants.COPYFILE_EXCL);
    const db = new DatabaseSync(stale, { readOnly: true });
    try { assert.equal(db.prepare('SELECT version FROM records WHERE id=?').get(fixture.items.case.id).version, 2); }
    finally { db.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  assert.equal(fixture.app.db.prepare('SELECT version FROM records WHERE id=?').get(fixture.items.case.id).version, 3);
  assert.equal(sha(readFileSync(source)), mainBefore); assert.equal(sha(readFileSync(source + '-wal')), walBefore);
  assert.equal(fixture.app.db.prepare('SELECT total_changes() AS n').get().n, changesBefore);
  fixtureCaptureProof = { expected, mainBefore, walBefore, changesBefore };
});

test('separate readonly capture excludes an uncommitted transaction and preserves the committed generation', async () => {
  const ws = await workspace(), db = newMiniSource(ws);
  const before = oracleDb(db);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run('uncommitted-audit', 'org-mini', 'u-one', 'uncommitted-only', null, null, '{}', stamp);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n, 2);
    const ref = await core.captureSyntheticBackup(ws); await core.restoreSyntheticBackup(ws, ref, 'staged');
    sameData(oracleFile(slot(ws, 'staged'), { closed: true }), before, 'Uncommitted rows are absent from accepted snapshot');
    sameData(oracleFile(slot(ws, 'source')), before, 'A separate connection still sees only committed rows');
  } finally { db.exec('ROLLBACK'); db.close(); }
  sameData(oracleFile(slot(ws, 'source'), { closed: true }), before, 'Caller rollback preserves its original generation');
});

test('successful inspection and rejected repeat capture leave source bytes, WAL, all raw columns and counters unchanged', async () => {
  assert.ok(fixtureCaptureProof, 'The committed capture proof must exist');
  const source = slot(fixtureWorkspace, 'source');
  assertSummary(await core.inspectSyntheticDatabase(fixtureWorkspace, 'source'));
  await rejectsCode(() => core.captureSyntheticBackup(fixtureWorkspace), 'TARGET_EXISTS');
  sameData(oracleDb(fixture.app.db), fixtureCaptureProof.expected, 'All eleven source tables remain exact');
  assert.equal(sha(readFileSync(source)), fixtureCaptureProof.mainBefore);
  assert.equal(sha(readFileSync(source + '-wal')), fixtureCaptureProof.walBefore);
  assert.equal(fixture.app.db.prepare('SELECT total_changes() AS n').get().n, fixtureCaptureProof.changesBefore);
  assert.equal(lstatSync(slot(fixtureWorkspace, 'backup')).mode & 0o777, 0o600);
  assert.equal(lstatSync(path.join(rootOf(fixtureWorkspace), 'backup.manifest.json')).mode & 0o777, 0o600);
});

test('typed raw roundtrip preserves full int64 extrema, REAL bytes, Unicode/NUL, empty text and NULL', async () => {
  const ws = await miniClosed(), expected = oracleFile(slot(ws, 'source'), { closed: true });
  const ref = await core.captureSyntheticBackup(ws), restored = await core.restoreSyntheticBackup(ws, ref, 'live');
  assert.equal(restored.status, 'restored'); assert.equal(restored.target, 'live');
  const actual = oracleFile(slot(ws, 'live'), { closed: true }); sameData(actual, expected, 'All SQLite storage classes survive exact roundtrip');
  const encoded = actual.tables.sessions.rows.join('\n');
  assert.ok(encoded.includes('9223372036854775807')); assert.ok(encoded.includes('-9223372036854775808'));
  const real = Buffer.alloc(8); real.writeDoubleBE(1.25);
  assert.ok(encoded.includes(JSON.stringify(['R', real.toString('hex')])), 'REAL is preserved as IEEE bytes rather than integer/string');
  assert.ok(actual.tables.memberships.rows.some(row => row.includes('["N"]')));
  assert.ok(actual.tables.memberships.rows.some(row => row.includes('["T8",""]')));
  const completeNameHex = Buffer.from('合成\u0000雪山', 'utf8').toString('hex').toUpperCase();
  assert.ok(actual.tables.users.rows.some(row => row.includes(JSON.stringify(['T8', completeNameHex]))),
    'Independent SQL UTF8 hex retains both the embedded NUL and complete suffix');
});

test('fingerprints ignore insertion/hidden-rowid order but detect type, one-unit, NULL/text and raw JSON-byte changes', async () => {
  const first = await miniClosed(), second = await miniClosed({ reverse: true });
  sameData(oracleFile(slot(first, 'source'), { closed: true }), oracleFile(slot(second, 'source'), { closed: true }), 'Independent sorted persisted-column oracle ignores insertion order');
  const firstReport = await core.inspectSyntheticDatabase(first, 'source');
  const secondReport = await core.inspectSyntheticDatabase(second, 'source');
  assert.equal(firstReport.fingerprint, secondReport.fingerprint);
  for (const [sql, values] of [
    ['UPDATE sessions SET expires_at=? WHERE token_hash=?', [1001, sha('ordinary-session')]],
    ['UPDATE sessions SET expires_at=? WHERE token_hash=?', [1000.25, sha('ordinary-session')]],
    ['UPDATE memberships SET employee_id=? WHERE user_id=?', ['', 'u-one']],
    ['UPDATE records SET data=? WHERE id=?', ['{"caseNo":"MINI-1","name":"合成 mini 個案","note":"完整保存\\u0000字串"}', 'r-mini']],
  ]) {
    const ws = await miniClosed(), before = await core.inspectSyntheticDatabase(ws, 'source');
    const db = new DatabaseSync(slot(ws, 'source')); db.prepare(sql).run(...values); db.close();
    const after = await core.inspectSyntheticDatabase(ws, 'source');
    assert.notEqual(after.fingerprint, before.fingerprint, 'A distinct persisted value or raw JSON byte order changes fingerprint');
  }
  // Identical text up to NUL, with only a suffix change, defeats the old driver's
  // JS-string read path. Independently read stored UTF8 bytes and require the
  // product fingerprint to distinguish this one saved-field mutation.
  const nulWorkspace = await miniClosed();
  const nulBeforeRaw = oracleFile(slot(nulWorkspace, 'source'), { closed: true });
  const nulBefore = await core.inspectSyntheticDatabase(nulWorkspace, 'source');
  const nulDb = new DatabaseSync(slot(nulWorkspace, 'source'));
  nulDb.prepare('UPDATE users SET name=? WHERE id=?').run('合成\u0000海風', 'u-one'); nulDb.close();
  const nulAfterRaw = oracleFile(slot(nulWorkspace, 'source'), { closed: true });
  const nulAfter = await core.inspectSyntheticDatabase(nulWorkspace, 'source');
  assert.notEqual(nulAfterRaw.tables.users.digest, nulBeforeRaw.tables.users.digest, 'Only the complete saved UTF8 suffix differs');
  assert.notEqual(nulAfter.tables.users.sha256, nulBefore.tables.users.sha256, 'Core table digest distinguishes NUL suffix bytes');
  assert.notEqual(nulAfter.fingerprint, nulBefore.fingerprint, 'Core fingerprint cannot conflate text sharing the same NUL prefix');
});

test('full fixture restore preserves both BLOBs, versions, audit, idempotency, sessions and approved raw pricing snapshots', async () => {
  assert.ok(fixtureRef, 'Full committed backup must have an opaque reference');
  await core.restoreSyntheticBackup(fixtureWorkspace, fixtureRef, 'live');
  const source = oracleDb(fixture.app.db), staged = oracleFile(slot(fixtureWorkspace, 'staged'), { closed: true });
  const live = oracleFile(slot(fixtureWorkspace, 'live'), { closed: true });
  sameData(staged, source, 'Staged all-table raw restore is exact'); sameData(live, source, 'Live all-table raw restore is exact');
  for (const table of ['attachment_files', 'certification_attachment_files', 'record_versions', 'audit', 'idempotency', 'sessions']) {
    assert.ok(source.tables[table].count > 0); assert.equal(live.tables[table].digest, source.tables[table].digest);
  }
  assert.equal(source.tables.sessions.count, 5);
  const db = new DatabaseSync(slot(fixtureWorkspace, 'live'));
  try {
    const caseFile = db.prepare('SELECT content FROM attachment_files WHERE attachment_id=?').get(fixture.items.caseAttachment.id);
    const certFile = db.prepare('SELECT content FROM certification_attachment_files WHERE attachment_id=?').get(fixture.items.certAttachment.id);
    assert.equal(sha(caseFile.content), sha(fixture.expected.caseBytes)); assert.equal(sha(certFile.content), sha(fixture.expected.certBytes));
    for (const record of [fixture.items.ownRecord, fixture.items.otherRecord]) {
      const saved = JSON.parse(db.prepare('SELECT data FROM records WHERE id=?').get(record.id).data);
      assert.equal(sha(JSON.stringify(saved.billingSnapshot)), sha(JSON.stringify(record.billingSnapshot)));
      assert.equal(saved.billingSnapshot.items[0].unitPriceCents, 101);
    }
  } finally { db.close(); }
});

test('missing current version is rejected before capture and never repaired into baseline history', async () => {
  const ws = await workspace(), db = newMiniSource(ws);
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run('missing-head', 'org-mini', 'cases', '{"name":"合成缺head","caseNo":"MISSING"}', 9, stamp, stamp);
  db.close(); const before = oracleFile(slot(ws, 'source'), { closed: true });
  await rejectsCode(() => core.inspectSyntheticDatabase(ws, 'source'), 'HISTORY_INCOMPLETE');
  await rejectsCode(() => core.captureSyntheticBackup(ws), 'HISTORY_INCOMPLETE');
  sameData(oracleFile(slot(ws, 'source'), { closed: true }), before, 'Missing history is rejected without baseline repair');
  assert.equal(existsSync(slot(ws, 'backup')), false);
  assert.equal(existsSync(path.join(rootOf(ws), 'backup.manifest.json')), false);
});

test('restored startup is zero-write, original valid/expired sessions retain semantics and login changes are explicitly accounted', async () => {
  const before = oracleFile(slot(fixtureWorkspace, 'live'), { closed: true });
  const app = createApp({ dbPath: slot(fixtureWorkspace, 'live'), host: '127.0.0.1', port: 0 }); applications.add(app);
  try {
    sameData(oracleDb(app.db), before, 'initDb startup performs no baseline or session reconstruction');
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, 0);
    const base = await app.listen(); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
    const valid = await fetch(`${base}/api/session`, { headers: { Cookie: fixture.sourceCookies.admin, 'X-Org-Id': fixture.orgId } });
    assert.equal(valid.status, 200); assert.equal((await valid.json()).user.id, fixture.users.admin.id);
    const expired = await fetch(`${base}/api/session`, { headers: { Cookie: fixture.secrets.expiredCookie } });
    assert.equal(expired.status, 200); assert.equal((await expired.json()).user, null);
    sameData(oracleDb(app.db), before, 'Session reads leave every raw table unchanged');
    const expiredBefore = app.db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at<?').get(Date.now()).n;
    assert.equal(expiredBefore, 1);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: fixture.users.admin.email, password: fixture.secrets.password }) });
    assert.equal(login.status, 200); const loggedIn = await login.json(); assert.equal(loggedIn.user.id, fixture.users.admin.id);
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, expiredBefore + 1, 'Normal login deletes expired rows and inserts exactly one session');
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 5);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at<?').get(Date.now()).n, 0);
    const afterLogin = oracleDb(app.db);
    for (const name of TABLES.filter(name => name !== 'sessions')) assert.equal(afterLogin.tables[name].digest, before.tables[name].digest, 'Login modifies only the documented session rows');
  } finally { await app.close(); applications.delete(app); }
});

test('opaque backup references, required restore target and fixed manifest tampering reject without target creation', async () => {
  const ws = await miniClosed(), ref = await core.captureSyntheticBackup(ws), foreign = await miniClosed();
  const sourceBefore = oracleFile(slot(ws, 'source'), { closed: true });
  assert.ok(Object.isFrozen(ref)); assert.equal(Reflect.ownKeys(ref).length, 0);
  for (const fake of [{}, { ...ref }, JSON.parse(JSON.stringify(ref))]) await rejectsCode(() => core.restoreSyntheticBackup(ws, fake, 'staged'), 'BACKUP_REFERENCE_INVALID');
  await rejectsCode(() => core.restoreSyntheticBackup(foreign, ref, 'staged'), 'BACKUP_REFERENCE_INVALID');
  for (const target of [undefined, 'source', 'backup', '../live']) await rejectsCode(() => core.restoreSyntheticBackup(ws, ref, target), 'INVALID_ARGUMENT');
  const filename = path.join(rootOf(ws), 'backup.manifest.json'), original = readFileSync(filename);
  const manifest = JSON.parse(original);
  assert.equal(manifest.format, 'suiyue-synthetic-sqlite-backup-v1'); assert.equal(manifest.syntheticOnly, true);
  try {
    for (const bytes of [Buffer.from('{'), Buffer.from(JSON.stringify({ ...manifest, format: 'untrusted-v0' })),
      Buffer.from(JSON.stringify({ ...manifest, fileSha256: '0'.repeat(64) })), Buffer.from(JSON.stringify({ ...manifest, filename: '../../data/care.sqlite' }))]) {
      writeFileSync(filename, bytes); await rejectsCode(() => core.restoreSyntheticBackup(ws, ref, 'staged'), 'BACKUP_CHANGED');
      assert.equal(existsSync(slot(ws, 'staged')), false);
    }
  } finally { writeFileSync(filename, original); }
  sameData(oracleFile(slot(ws, 'source'), { closed: true }), sourceBefore, 'Untrusted references/manifests cannot modify source');
});

test('truncated and byte-tampered owned snapshot files reject even when fresh target has never existed', async () => {
  const ws = await miniClosed(), ref = await core.captureSyntheticBackup(ws), filename = slot(ws, 'backup');
  const original = readFileSync(filename), sourceBefore = oracleFile(slot(ws, 'source'), { closed: true });
  const changed = Buffer.from(original); changed[100] ^= 0xff;
  try {
    for (const bytes of [original.subarray(0, 100), changed]) {
      writeFileSync(filename, bytes); await rejectsCode(() => core.restoreSyntheticBackup(ws, ref, 'live'), 'BACKUP_CHANGED');
      assert.equal(existsSync(slot(ws, 'live')), false);
      sameData(oracleFile(slot(ws, 'source'), { closed: true }), sourceBefore, 'Bad snapshot cannot overwrite or repair source');
    }
  } finally { writeFileSync(filename, original); }
});

test('schema SQL/version mismatches and real SQL foreign-key violations fail preflight without accepted backup artifacts', async () => {
  for (const [mutation, code] of [
    ['CREATE TABLE extra_fixture(value TEXT)', 'SCHEMA_MISMATCH'],
    ['DROP TRIGGER versions_no_delete', 'SCHEMA_MISMATCH'],
    ['DROP INDEX records_org_entity', 'SCHEMA_MISMATCH'],
    ['PRAGMA user_version=7', 'SCHEMA_MISMATCH'],
    ["PRAGMA foreign_keys=OFF; INSERT INTO memberships VALUES('org-mini','missing-user','finance',NULL)", 'FOREIGN_KEY_FAILED'],
  ]) {
    const ws = await workspace(), db = newMiniSource(ws); db.exec(mutation); db.close();
    const before = oracleFile(slot(ws, 'source'), { closed: true });
    await rejectsCode(() => core.inspectSyntheticDatabase(ws, 'source'), code);
    await rejectsCode(() => core.captureSyntheticBackup(ws), code);
    sameData(oracleFile(slot(ws, 'source'), { closed: true }), before, 'Invalid synthetic schema/FK data remains untouched');
    assert.equal(existsSync(slot(ws, 'backup')), false); assert.equal(existsSync(slot(ws, 'staged')), false);
  }
  // Corrupt only a generated table's b-tree page header after closing the DB.
  // Schema SQL stays identical; this exercises actual integrity rejection without
  // mutating sqlite_schema, which modern SQLite defensive mode correctly forbids.
  const corrupt = await workspace(), db = newMiniSource(corrupt);
  const rootPage = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='organizations'").get().rootpage;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  db.close(); const filename = slot(corrupt, 'source'), corruptedBytes = readFileSync(filename);
  assert(rootPage > 1 && pageSize > 0, 'Only an owned table page is corrupted');
  corruptedBytes[(rootPage - 1) * pageSize] = 0;
  writeFileSync(filename, corruptedBytes);
  const beforeHash = sha(readFileSync(filename));
  await rejectsCode(() => core.inspectSyntheticDatabase(corrupt, 'source'), 'INTEGRITY_FAILED');
  await rejectsCode(() => core.captureSyntheticBackup(corrupt), 'INTEGRITY_FAILED');
  assert.equal(sha(readFileSync(filename)), beforeHash, 'Structural corruption is rejected without repair');
  assert.equal(existsSync(slot(corrupt, 'backup')), false);
});

test('renamed/replaced factory root cannot redirect capability operations into another synthetic workspace', async () => {
  const ws = await workspace(), neighbor = await workspace();
  const root = rootOf(ws), outside = rootOf(neighbor), moved = root + '-renamed-probe';
  const sentinel = path.join(outside, 'sentinel.txt'); writeFileSync(sentinel, '合成 external sentinel'); const expected = sha(readFileSync(sentinel));
  renameSync(root, moved);
  try {
    await rejectsCode(() => core.syntheticDatabasePath(ws, 'source'), 'WORKSPACE_INVALID');
    symlinkSync(outside, root, 'dir');
    try {
      await rejectsCode(() => core.syntheticDatabasePath(ws, 'source'), 'WORKSPACE_INVALID');
      await rejectsCode(() => core.disposeSyntheticWorkspace(ws), 'WORKSPACE_INVALID');
      assert.equal(sha(readFileSync(sentinel)), expected);
    } finally { unlinkSync(root); }
  } finally { renameSync(moved, root); }
  assert.equal(rootOf(ws), root); assert.equal(sha(readFileSync(sentinel)), expected);
});

test('fixed slots reject symlink, hardlink, directory and same-inode aliases without dereferencing neighboring data', async () => {
  const ws = await workspace(), source = slot(ws, 'source'), backup = slot(ws, 'backup');
  writeFileSync(source, '合成 slot sentinel'); const expected = sha(readFileSync(source));
  symlinkSync(source, backup);
  try { await rejectsCode(() => core.syntheticDatabasePath(ws, 'backup'), 'UNSAFE_PATH'); }
  finally { unlinkSync(backup); }
  linkSync(source, backup);
  try {
    await rejectsCode(() => core.syntheticDatabasePath(ws, 'source'), 'UNSAFE_PATH');
    await rejectsCode(() => core.syntheticDatabasePath(ws, 'backup'), 'UNSAFE_PATH');
  } finally { unlinkSync(backup); }
  mkdirSync(backup);
  try { await rejectsCode(() => core.syntheticDatabasePath(ws, 'backup'), 'UNSAFE_PATH'); }
  finally { rmSync(backup, { recursive: true }); }
  assert.equal(sha(readFileSync(source)), expected);
});

test('occupied targets/previous, invalid promotion options and every journal sidecar forbid overwrite or switching', async () => {
  const { ws, ref } = await promotedPair();
  const live = slot(ws, 'live'), staged = slot(ws, 'staged'), previous = slot(ws, 'previous');
  const liveHash = sha(readFileSync(live)), stagedHash = sha(readFileSync(staged));
  await rejectsCode(() => core.restoreSyntheticBackup(ws, ref, 'live'), 'TARGET_EXISTS');
  await rejectsCode(() => core.restoreSyntheticBackup(ws, ref, 'staged'), 'TARGET_EXISTS');
  for (const options of [undefined, {}, { forceRollback: 1 }, { forceRollback: false, path: 'arbitrary' }]) {
    await rejectsCode(() => core.promoteSyntheticRestore(ws, options), 'INVALID_ARGUMENT');
  }
  let getterCalls = 0;
  const getterOption = Object.defineProperty({}, 'forceRollback', { enumerable: true, get() { getterCalls++; return false; } });
  await rejectsCode(() => core.promoteSyntheticRestore(ws, getterOption), 'INVALID_ARGUMENT');
  assert.equal(getterCalls, 0, 'Only an own boolean data option is accepted, without evaluating callbacks');
  const reflectionSentinel = 'SYNTHETIC_REFLECTION_SECRET_SENTINEL_039';
  const reflectionTrap = new Proxy({}, { ownKeys() { throw new Error(reflectionSentinel); } });
  const reflected = await rejectsCode(() => core.promoteSyntheticRestore(ws, reflectionTrap), 'SQLITE_OPERATION_FAILED');
  assert.ok(reflected.message === 'Synthetic SQLite or scratch operation failed.' && !reflected.message.includes(reflectionSentinel),
    'Unexpected option reflection errors are bounded and never echo the injected raw sentinel');
  writeFileSync(previous, '合成 occupied previous'); const previousHash = sha(readFileSync(previous));
  await rejectsCode(() => core.promoteSyntheticRestore(ws, { forceRollback: false }), 'TARGET_EXISTS');
  assert.equal(sha(readFileSync(previous)), previousHash); unlinkSync(previous);
  for (const filename of [live, staged]) for (const suffix of ['-wal', '-shm', '-journal']) {
    writeFileSync(filename + suffix, '合成 closed-handle sidecar probe');
    try { await rejectsCode(() => core.promoteSyntheticRestore(ws, { forceRollback: false }), 'SIDECAR_PRESENT'); }
    finally { unlinkSync(filename + suffix); }
  }
  assert.equal(sha(readFileSync(live)), liveHash); assert.equal(sha(readFileSync(staged)), stagedHash);
  assert.equal(existsSync(previous), false);
  const polluted = new DatabaseSync(staged);
  polluted.prepare('UPDATE organizations SET name=? WHERE id=?').run('合成 restore proof 之後污染', 'org-mini'); polluted.close();
  assert.notEqual(sha(readFileSync(staged)), stagedHash);
  await rejectsCode(() => core.promoteSyntheticRestore(ws, { forceRollback: false }), 'RESTORE_CHANGED');
  assert.equal(sha(readFileSync(live)), liveHash, 'Post-restore staged pollution cannot replace original live');
  assert.equal(existsSync(previous), false);
});

test('forced failure after the second rename returns rolled_back and restores exact original live bytes/state', async () => {
  const { ws } = await promotedPair(), live = slot(ws, 'live'), staged = slot(ws, 'staged');
  const beforeHash = sha(readFileSync(live)), before = oracleFile(live, { closed: true });
  const candidateHash = sha(readFileSync(staged)), candidate = oracleFile(staged, { closed: true });
  assert.notEqual(before.digest, candidate.digest, 'Forced rollback tests distinct generations');
  const result = await core.promoteSyntheticRestore(ws, { forceRollback: true });
  assert.equal(result.status, 'rolled_back'); assert.equal(result.previous, null);
  assert.equal(sha(readFileSync(live)), beforeHash); sameData(oracleFile(live, { closed: true }), before, 'Rollback restores original saved generation');
  assert.equal(sha(readFileSync(staged)), candidateHash); sameData(oracleFile(staged, { closed: true }), candidate, 'Candidate remains staged after rollback');
  assert.equal(result.before.mainFileSha256, beforeHash); assert.equal(result.live.mainFileSha256, beforeHash);
  assert.equal(result.candidate.mainFileSha256, candidateHash); assert.equal(result.staged.mainFileSha256, candidateHash);
  assert.equal(existsSync(slot(ws, 'previous')), false);
  for (const filename of [live, staged]) for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(filename + suffix), false);
});

test('successful promotion retains previous, exposes only bounded metadata and disposal preserves a neighboring factory root', async () => {
  const { ws } = await promotedPair(), neighbor = await workspace();
  const root = rootOf(ws), neighborRoot = rootOf(neighbor), sentinel = path.join(neighborRoot, 'sentinel.txt');
  writeFileSync(sentinel, '合成 neighboring owned generation'); const neighborHash = sha(readFileSync(sentinel));
  const oldHash = sha(readFileSync(slot(ws, 'live'))), candidateHash = sha(readFileSync(slot(ws, 'staged')));
  const oldData = oracleFile(slot(ws, 'live'), { closed: true }), candidateData = oracleFile(slot(ws, 'staged'), { closed: true });
  const captured = [], originals = {};
  for (const name of ['log', 'warn', 'error', 'info', 'debug']) { originals[name] = console[name]; console[name] = (...args) => captured.push(format(...args)); }
  let result;
  try { result = await core.promoteSyntheticRestore(ws, { forceRollback: false }); }
  finally { for (const [name, original] of Object.entries(originals)) console[name] = original; }
  assert.equal(result.status, 'promoted'); assert.equal(result.staged, null);
  assertSummary(result.before); assertSummary(result.candidate); assertSummary(result.live); assertSummary(result.previous);
  assert.equal(sha(readFileSync(slot(ws, 'live'))), candidateHash); assert.equal(sha(readFileSync(slot(ws, 'previous'))), oldHash);
  sameData(oracleFile(slot(ws, 'live'), { closed: true }), candidateData, 'Successful promotion installs exact candidate');
  sameData(oracleFile(slot(ws, 'previous'), { closed: true }), oldData, 'Previous original generation is retained');
  assert.equal(existsSync(slot(ws, 'staged')), false);
  const reportText = JSON.stringify(result) + captured.join('\n');
  const secretValues = fixture.app.db.prepare('SELECT password_hash FROM users').all().map(row => row.password_hash)
    .concat(fixture.app.db.prepare('SELECT token_hash,csrf FROM sessions').all().flatMap(row => [row.token_hash, row.csrf]),
      [fixture.secrets.password, fixture.secrets.expiredCookie, fixture.secrets.expiredCsrf,
        'synthetic-password-hash-one', 'synthetic-max-csrf', Buffer.from(fixture.expected.caseBytes).toString('hex'), Buffer.from(fixture.expected.certBytes).toString('hex')]);
  assert.ok(secretValues.every(secret => !reportText.includes(secret)), 'Core report/console output excludes raw synthetic secrets and BLOB bytes');
  assert.ok(!reportText.includes('sqlite_schema') && !reportText.includes('CREATE TABLE'), 'Core report never serializes raw schema SQL');
  assert.equal(JSON.stringify(ws), '{}'); assert.equal(JSON.stringify(fixtureRef), '{}');
  await dispose(ws); assert.equal(existsSync(root), false); assert.equal(sha(readFileSync(sentinel)), neighborHash);
  await dispose(neighbor); assert.equal(existsSync(neighborRoot), false);
});
