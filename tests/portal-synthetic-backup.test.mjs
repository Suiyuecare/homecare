import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { constants, chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import * as portal from '../src/server/synthetic-portal-backup.mjs';
import * as legacy from '../src/server/synthetic-backup.mjs';
import { initDb } from '../src/server/model.mjs';
import { initPortalStorage, PORTAL_ORIGIN } from '../src/server/portal-handoff.mjs';
import { createSyntheticPortalBackupFixture, readPortalSyntheticRawState } from './portal-synthetic-backup-fixtures.mjs';
import { syntheticClient } from './synthetic-backup-fixtures.mjs';

// This independent typed oracle deliberately differs from both the private core
// and fixture serializer. No raw values enter assertions, logs or JSON receipts.
const TABLES = ['attachment_files', 'audit', 'certification_attachment_files', 'demo_seeds', 'idempotency', 'memberships', 'organizations', 'portal_handoff_nonces', 'portal_identity_bindings', 'record_versions', 'records', 'sessions', 'users'];
const TRIGGERS = ['attachment_files_no_delete', 'attachment_files_no_update', 'certification_attachment_files_no_delete', 'certification_attachment_files_no_update', 'versions_no_delete', 'versions_no_update'];
const EXPORTS = ['captureSyntheticBackup', 'createSyntheticPortalWorkspace', 'disposeSyntheticWorkspace', 'inspectSyntheticDatabase', 'promoteSyntheticRestore', 'restoreSyntheticBackup', 'syntheticDatabasePath'];
const SHA = value => createHash('sha256').update(value).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const owned = new Set(), localOwned = new Set(), applications = new Set(), fixtures = new Set();
const stamp = '2026-10-10T00:00:00.000Z';
let full, fullWorkspace, fullReference, fullOracle, fullReport;

function oracle(db) {
  const columns = ['type', 'name', 'tbl_name', 'sql'];
  const schema = db.prepare('SELECT ' + columns.map((name, i) => `CASE WHEN ${quote(name)} IS NULL THEN NULL ELSE hex(CAST(${quote(name)} AS BLOB)) END AS s${i}`).join(',') + " FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => columns.map((_, i) => row['s' + i]));
  const tables = {};
  for (const table of TABLES) {
    const fields = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
    const projection = fields.flatMap((field, i) => [`typeof(${quote(field)}) AS t${i}`, `CASE WHEN typeof(${quote(field)})='text' THEN hex(CAST(${quote(field)} AS BLOB)) ELSE ${quote(field)} END AS v${i}`]);
    const statement = db.prepare(`SELECT ${projection.join(',')} FROM ${quote(table)}`); statement.setReadBigInts(true);
    const rows = statement.all().map(row => JSON.stringify(fields.map((_, i) => {
      const kind = row['t' + i], value = row['v' + i];
      if (kind === 'null') return ['N'];
      if (kind === 'text') return ['T8', value];
      if (kind === 'integer') { assert.equal(typeof value, 'bigint'); return ['I64', String(value)]; }
      if (kind === 'real') { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ['F64', bytes.toString('hex')]; }
      if (kind === 'blob') return ['BYTES', Buffer.from(value).toString('hex')];
      throw new Error('Unexpected stored SQLite class in private oracle');
    }))).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    tables[table] = { columns: fields, count: rows.length, digest: SHA(JSON.stringify({ fields, rows })) };
  }
  const body = { schema, tables, userVersion: db.prepare('PRAGMA user_version').get().user_version, applicationId: db.prepare('PRAGMA application_id').get().application_id };
  return { ...body, schemaDigest: SHA(JSON.stringify({ schema, userVersion: body.userVersion, applicationId: body.applicationId })), digest: SHA(JSON.stringify(body)) };
}
function fileOracle(filename, { closed = false } = {}) {
  const scratch = closed ? mkdtempSync(path.join(path.dirname(filename), '.portal-oracle-')) : null;
  const filenameRead = scratch ? path.join(scratch, 'oracle.sqlite') : filename;
  if (scratch) copyFileSync(filename, filenameRead, constants.COPYFILE_EXCL);
  const db = new DatabaseSync(filenameRead, { readOnly: true });
  try { return oracle(db); } finally { db.close(); if (scratch) rmSync(scratch, { recursive: true }); }
}
const same = (a, b, label = 'All thirteen table columns and schema are byte-preserved') => assert.equal(a.digest, b.digest, label);
const slot = (ws, name) => portal.syntheticDatabasePath(ws, name);
const root = ws => path.dirname(slot(ws, 'source'));
function workspace() { const ws = portal.createSyntheticPortalWorkspace(); owned.add(ws); return ws; }
function localWorkspace() { const ws = legacy.createSyntheticWorkspace(); localOwned.add(ws); return ws; }
function rejectsCode(work, expected) {
  let error;
  try { work(); } catch (caught) { error = caught; }
  assert(error, 'Forbidden operation rejects'); assert.equal(error.name, 'SyntheticBackupError'); assert.equal(error.code, expected);
  return error;
}
function summary(report) {
  assert.equal(report.format, 'suiyue-synthetic-portal-sqlite-inspection-v1');
  assert.equal(report.tableCount, 13); assert.equal(report.triggerCount, 6); assert.equal(report.userVersion, 0); assert.equal(report.applicationId, 0);
  assert.deepEqual(Object.keys(report.tables).sort(), TABLES);
  for (const digest of [report.fingerprint, report.schemaSha256, report.versionsSha256, report.billingSnapshotsSha256, report.mainFileSha256, ...Object.values(report.blobSha256), ...Object.values(report.tables).map(table => table.sha256)]) assert.match(digest, /^[0-9a-f]{64}$/);
  for (const table of Object.values(report.tables)) assert(Number.isSafeInteger(table.count) && table.count >= 0);
  assert.deepEqual(Object.keys(report).sort(), ['applicationId', 'billingSnapshotsSha256', 'blobSha256', 'fingerprint', 'format', 'mainFileBytes', 'mainFileSha256', 'schemaSha256', 'tableCount', 'tables', 'triggerCount', 'userVersion', 'versionsSha256'].sort());
}
function mini(ws, { reverse = false, legacyOnly = false } = {}) {
  const filename = legacyOnly ? legacy.syntheticDatabasePath(ws, 'source') : slot(ws, 'source');
  const db = new DatabaseSync(filename); initDb(db); if (!legacyOnly) initPortalStorage(db); chmodSync(filename, 0o600);
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('org-mini', '合成 Portal\u0000機構', stamp);
  const userRows = [['u-one', '合成\u0000雪山', 'one@portal-mini.example.test', 'synthetic-hash\u0000first', stamp], ['u-two', '', 'two@portal-mini.example.test', 'synthetic-hash-two', stamp]];
  for (const row of reverse ? [...userRows].reverse() : userRows) db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(...row);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('org-mini', 'u-one', 'admin', null);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('org-mini', 'u-two', 'finance', '');
  const sessionRows = [[SHA('synthetic-max'), 'u-one', 'max\u0000csrf', 9223372036854775807n], [SHA('synthetic-min'), 'u-two', '', -9223372036854775808n], [SHA('synthetic-real'), 'u-one', 'real-csrf', 1.25]];
  for (const row of reverse ? [...sessionRows].reverse() : sessionRows) db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(...row);
  const data = '{"name":"合成 mini 個案","note":"JSON preserved\\u0000tail","number":1.2500}';
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run('r-mini', 'org-mini', 'cases', data, 2, stamp, stamp);
  for (const version of [1, 2]) db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run('org-mini', 'cases', 'r-mini', version, '{"version":' + version + ',"value":"saved-byte-order"}', stamp, version === 1 ? 'create' : 'update');
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run('a-mini', null, null, 'synthetic\u0000audit', null, 'r-mini', '{"note":"raw-byte-order","a":0}', stamp);
  db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run('org-mini', 'u-one', 'key\u0000tail', '/api/cases', 'synthetic-hash', '{"item":{"id":"r-mini"}}', 201, stamp);
  db.prepare('INSERT INTO demo_seeds VALUES(?,?)').run('org-mini', stamp);
  const caseBlob = Buffer.from([0, 255, 1, 128, 0, 32, 10]), certBlob = Buffer.from([255, 0, 254, 128, 10, 13, 0, 1]);
  db.prepare('INSERT INTO attachment_files VALUES(?,?,?,?,?,?,?,?,?,?)').run('f-case', 'org-mini', 'r-mini', 'r-mini', '合成\u0000case.pdf', 'application/pdf', caseBlob.length, SHA(caseBlob), caseBlob, stamp);
  db.prepare('INSERT INTO certification_attachment_files VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('f-cert', 'org-mini', 'r-mini', 'r-mini', 'r-mini', '合成\u0000cert.png', 'image/png', certBlob.length, SHA(certBlob), certBlob, stamp);
  if (!legacyOnly) {
    const rows = [['https://synthetic.example.test\u0000issuer', 'subject\u0000tail', 'auth\u0000tail', 'one@portal-mini.example.test', 'u-one', 'org-mini', 1, stamp], ['https://synthetic.example.test', '', 'auth-two', 'two@portal-mini.example.test', 'u-two', 'org-mini', 0, stamp]];
    for (const row of reverse ? [...rows].reverse() : rows) db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run(...row);
    const nonces = [['nonce\u0000tail', 'issuer\u0000tail', 'u-one', 'org-mini', 1.25, 9223372036854775807n], ['', '', 'u-two', 'org-mini', -9223372036854775808n, -1]];
    for (const row of reverse ? [...nonces].reverse() : nonces) db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run(...row);
  }
  return db;
}
function closedMini(options) { const ws = workspace(), db = mini(ws, options); db.close(); return ws; }
async function fullFixture() { const ws = workspace(), fixture = await createSyntheticPortalBackupFixture({ workspace: ws }); fixtures.add(fixture); return { ws, fixture }; }
async function start(fixture, slotName = 'live') { const app = fixture.createAppForSlot(slotName); applications.add(app); const base = await app.listen(); return { app, base }; }
async function rawHandoff(base, envelope, { origin = PORTAL_ORIGIN, host, cookie = '' } = {}) {
  // Node fetch/Undici can ignore caller Host overrides. Native HTTP transmits
  // the actual adversarial Host, so this assertion tests the receiver's guard.
  const address = new URL(base);
  assert.equal(address.hostname, '127.0.0.1'); assert(address.port && address.port !== '4310');
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: address.hostname, port: address.port, path: '/api/auth/handoff', method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...(host ? { Host: host } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
    });
    request.on('error', reject); request.end(new URLSearchParams(envelope).toString());
  });
}
async function expectHttp(response, status, code) { assert.equal(response.status, status); const value = await response.json(); assert.equal(value.error?.code, code); }
async function closeTracked(app) { await app.close(); applications.delete(app); }

before(async () => {
  ({ ws: fullWorkspace, fixture: full } = await fullFixture());
  fullOracle = oracle(full.app.db);
});
after(async () => {
  for (const app of applications) await app.close();
  for (const fixture of fixtures) await fixture.close();
  for (const ws of owned) portal.disposeSyntheticWorkspace(ws);
  for (const ws of localOwned) legacy.disposeSyntheticWorkspace(ws);
});

test('Portal facade has exactly seven fixed-arity operations and an opaque factory workspace', () => {
  assert.deepEqual(Object.keys(portal).sort(), EXPORTS);
  for (const [name, arity] of [['createSyntheticPortalWorkspace', 0], ['syntheticDatabasePath', 2], ['inspectSyntheticDatabase', 2], ['captureSyntheticBackup', 1], ['restoreSyntheticBackup', 3], ['promoteSyntheticRestore', 2], ['disposeSyntheticWorkspace', 1]]) assert.equal(portal[name].length, arity);
  const ws = workspace(), dir = root(ws);
  assert(Object.isFrozen(ws)); assert.equal(Reflect.ownKeys(ws).length, 0); assert.equal(path.dirname(dir), realpathSync(tmpdir())); assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(new Set(['source', 'backup', 'staged', 'live', 'previous'].map(name => slot(ws, name))).size, 5);
  for (const fake of [{}, { ...ws }, JSON.parse(JSON.stringify(ws)), 'data/care.sqlite']) rejectsCode(() => portal.syntheticDatabasePath(fake, 'source'), 'WORKSPACE_INVALID');
  for (const invalid of [undefined, '../source', '/source', 'source/../live']) rejectsCode(() => slot(ws, invalid), 'INVALID_ARGUMENT');
  rejectsCode(() => portal.createSyntheticPortalWorkspace({ profile: 'legacy' }), 'INVALID_ARGUMENT');
  rejectsCode(() => portal.inspectSyntheticDatabase(ws, 'source', { tableCount: 11 }), 'INVALID_ARGUMENT');
  rejectsCode(() => portal.captureSyntheticBackup(ws, { profile: 'legacy' }), 'INVALID_ARGUMENT');
  rejectsCode(() => portal.inspectSyntheticDatabase(ws, 'source'), 'SLOT_MISSING');
});

test('Every cross-profile operation rejects before filesystem access including path and dispose', () => {
  const p = workspace(), l = localWorkspace();
  for (const [wrong, ws, dir] of [[legacy, p, root(p)], [portal, l, path.dirname(legacy.syntheticDatabasePath(l, 'source'))]]) {
    const moved = dir + '-profile-probe'; renameSync(dir, moved);
    try {
      for (const work of [() => wrong.syntheticDatabasePath(ws, 'source'), () => wrong.inspectSyntheticDatabase(ws, 'source'), () => wrong.captureSyntheticBackup(ws), () => wrong.restoreSyntheticBackup(ws, {}, 'live'), () => wrong.promoteSyntheticRestore(ws, { forceRollback: false }), () => wrong.disposeSyntheticWorkspace(ws)]) rejectsCode(work, 'WORKSPACE_INVALID');
    } finally { renameSync(moved, dir); }
  }
  assert.equal(lstatSync(root(p)).mode & 0o777, 0o700);
});

test('Owner and profile bound references reject before reading a moved target root or accepting caller metadata', () => {
  const p = closedMini(), q = closedMini(), l = localWorkspace(), db = mini(l, { legacyOnly: true }); db.close();
  const pRef = portal.captureSyntheticBackup(p), lRef = legacy.captureSyntheticBackup(l);
  const dir = root(q), moved = dir + '-owner-probe'; renameSync(dir, moved);
  try { rejectsCode(() => portal.restoreSyntheticBackup(q, pRef, 'live'), 'BACKUP_REFERENCE_INVALID'); rejectsCode(() => portal.restoreSyntheticBackup(q, lRef, 'live'), 'BACKUP_REFERENCE_INVALID'); }
  finally { renameSync(moved, dir); }
  for (const fake of [{}, { ...pRef }, JSON.parse(JSON.stringify(pRef)), { format: 'suiyue-synthetic-portal-sqlite-backup-v1' }]) rejectsCode(() => portal.restoreSyntheticBackup(p, fake, 'live'), 'BACKUP_REFERENCE_INVALID');
  rejectsCode(() => legacy.restoreSyntheticBackup(l, pRef, 'live'), 'BACKUP_REFERENCE_INVALID');
  rejectsCode(() => portal.restoreSyntheticBackup(p, pRef, 'source'), 'INVALID_ARGUMENT');
  assert.equal(existsSync(slot(q, 'live')), false);
});

test('Complete normal business fixture capture includes committed Portal WAL and exposes only counts and digests', () => {
  const before = oracle(full.app.db), sourceHash = SHA(readFileSync(slot(fullWorkspace, 'source'))), walHash = SHA(readFileSync(slot(fullWorkspace, 'source') + '-wal'));
  const changes = full.app.db.prepare('SELECT total_changes() AS n').get().n;
  assert(full.walProof.walBytes > 32); assert.equal(full.walProof.mainHashAtCheckpoint, full.walProof.mainHashAfterWalWrite);
  fullReference = portal.captureSyntheticBackup(fullWorkspace);
  fullReport = portal.inspectSyntheticDatabase(fullWorkspace, 'backup'); summary(fullReport);
  same(fileOracle(slot(fullWorkspace, 'backup'), { closed: true }), fullOracle);
  same(oracle(full.app.db), before); assert.equal(full.app.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(SHA(readFileSync(slot(fullWorkspace, 'source'))), sourceHash); assert.equal(SHA(readFileSync(slot(fullWorkspace, 'source') + '-wal')), walHash);
  const manifest = JSON.parse(readFileSync(path.join(root(fullWorkspace), 'backup.manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'suiyue-synthetic-portal-sqlite-backup-v1'); assert.equal(manifest.tableCount, 13); assert.equal(manifest.syntheticOnly, true);
  assert.equal(manifest.fileSha256, fullReport.mainFileSha256);
  const publicBytes = JSON.stringify(manifest) + JSON.stringify(fullReport) + JSON.stringify(fullReference);
  for (const privateValue of [full.identities.admin.email, full.identities.admin.authUserId, full.identities.admin.googleSubject, full.portalConfig.signingSecret, full.actors.admin.cookie, full.snapshotReplayEnvelope.payload, full.secrets.expiredNonceJti]) assert.equal(publicBytes.includes(privateValue), false, 'Public metadata contains no private synthetic identity or authentication values');
  for (const value of [full, full.identities, full.portalConfig, full.expected, full.expected.rawState, full.actors, full.secrets, full.snapshotReplayEnvelope]) { assert.throws(() => JSON.stringify(value), /memory-only/); assert.match(inspect(value), /redacted/); }
  rejectsCode(() => portal.captureSyntheticBackup(fullWorkspace), 'TARGET_EXISTS');
  same(oracle(full.app.db), before);
});

test('Independent all-column oracle preserves TEXT after NUL, signed int64 extrema, REAL bits, empty TEXT, NULL and both BLOBs', () => {
  const ws = closedMini(), expected = fileOracle(slot(ws, 'source'), { closed: true });
  const ref = portal.captureSyntheticBackup(ws), report = portal.restoreSyntheticBackup(ws, ref, 'live');
  summary(portal.inspectSyntheticDatabase(ws, 'backup')); same(fileOracle(slot(ws, 'live'), { closed: true }), expected);
  assert.equal(report.status, 'restored');
  const db = new DatabaseSync(slot(ws, 'live'), { readOnly: true });
  try {
    const integer = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?'); integer.setReadBigInts(true);
    assert.equal(integer.get(SHA('synthetic-max')).expires_at, 9223372036854775807n);
    assert.equal(integer.get(SHA('synthetic-min')).expires_at, -9223372036854775808n);
    assert.equal(db.prepare('SELECT typeof(consumed_at) AS t FROM portal_handoff_nonces WHERE jti=?').get('nonce\u0000tail').t, 'real');
    const saved = readPortalSyntheticRawState(db);
    assert.equal(SHA(saved.tables.users.find(row => row.id === 'u-one').name), SHA('合成\u0000雪山'));
    assert.equal(SHA(saved.tables.portal_identity_bindings.find(row => row.user_id === 'u-one').google_subject), SHA('subject\u0000tail'));
    assert.equal(saved.tables.portal_identity_bindings.find(row => row.user_id === 'u-two').active, 0);
    assert.equal(saved.tables.memberships.find(row => row.user_id === 'u-one').employee_id, null);
    assert.equal(saved.tables.memberships.find(row => row.user_id === 'u-two').employee_id, '');
    assert.equal(saved.tables.attachment_files[0].content.length, 7); assert.equal(saved.tables.certification_attachment_files[0].content.length, 8);
    assert.equal(Object.values(expected.tables).filter(table => table.count > 0).length, 13, 'All thirteen tables have actual saved rows in the typed fixture');
  } finally { db.close(); }
});

test('Fingerprint ignores hidden rowid and insertion order but detects Portal typed and one-byte mutations', () => {
  const a = closedMini(), b = closedMini({ reverse: true });
  assert.equal(portal.inspectSyntheticDatabase(a, 'source').fingerprint, portal.inspectSyntheticDatabase(b, 'source').fingerprint);
  same(fileOracle(slot(a, 'source'), { closed: true }), fileOracle(slot(b, 'source'), { closed: true }));
  for (const [sql, values] of [
    ['UPDATE portal_identity_bindings SET active=0 WHERE user_id=?', ['u-one']],
    ['UPDATE portal_identity_bindings SET google_subject=? WHERE user_id=?', ['subject\u0000TAIL', 'u-one']],
    ['UPDATE portal_handoff_nonces SET consumed_at=1 WHERE jti=?', ['nonce\u0000tail']],
    ['UPDATE sessions SET expires_at=expires_at-1 WHERE token_hash=?', [SHA('synthetic-max')]],
    ['UPDATE memberships SET employee_id=? WHERE user_id=?', ['', 'u-one']],
    ['UPDATE records SET data=? WHERE id=?', ['{"number":1.25,"name":"合成 mini 個案","note":"JSON preserved\\u0000tail"}', 'r-mini']],
  ]) {
    const ws = closedMini(), before = portal.inspectSyntheticDatabase(ws, 'source'), db = new DatabaseSync(slot(ws, 'source'));
    db.prepare(sql).run(...values); db.close();
    assert.notEqual(portal.inspectSyntheticDatabase(ws, 'source').fingerprint, before.fingerprint, 'A preserved type, byte, integer unit or nullness change is detected');
  }
});

test('Thirteen-table complete schema, six immutable triggers and saved record/billing/attachment data survive restore', () => {
  portal.restoreSyntheticBackup(fullWorkspace, fullReference, 'live');
  const actual = fileOracle(slot(fullWorkspace, 'live'), { closed: true }); same(actual, fullOracle);
  assert.equal(actual.schemaDigest, fullOracle.schemaDigest);
  const db = new DatabaseSync(slot(fullWorkspace, 'live'));
  try {
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(names, TRIGGERS); assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%'").get().n, 6);
    const before = oracle(db);
    for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) for (const command of ['UPDATE', 'DELETE']) {
      const sql = command === 'UPDATE' ? `UPDATE ${quote(table)} SET ${table === 'record_versions' ? 'source=source' : 'file_name=file_name'}` : `DELETE FROM ${quote(table)}`;
      assert.throws(() => db.exec(sql), /immutable/);
    }
    same(oracle(db), before, 'Original immutable saved history and BLOB guards enforce unchanged behavior');
  } finally { db.close(); }
});

test('Restored Portal startup and role reads make zero logical writes while absolute session expiry is unchanged', async () => {
  const before = fileOracle(slot(fullWorkspace, 'live'), { closed: true });
  const { app, base } = await start(full);
  try {
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, 0); same(oracle(app.db), before);
    const sourceSessions = full.expected.rawState.tables.sessions;
    const restoredSessions = readPortalSyntheticRawState(app.db).tables.sessions;
    assert.equal(SHA(JSON.stringify(restoredSessions)), SHA(JSON.stringify(sourceSessions)), 'Startup retains original absolute expiry, csrf and token hashes without renewing eight hours');
    const clients = {};
    for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
      const client = syntheticClient(base, 'restored-' + role, { cookie: full.sourceCookies[role] }), auth = await client.json('GET', 'session'); client.bindAuth(auth); clients[role] = client;
      assert.equal(auth.user.id, full.identities[role].userId); assert.equal(auth.organizations[0].role, role);
    }
    const admin = clients.admin;
    for (const kind of ['fees', 'payroll']) {
      const result = await admin.json('GET', `reports/${kind}?month=${full.month}&spanMode=calendar-two-day-v1`, undefined, { orgId: full.orgId });
      assert.equal(SHA(JSON.stringify(result)), SHA(JSON.stringify(full.expected.frozenReports[kind])), 'Stored approved prices remain unchanged after current service/rate edits');
      const csv = await admin.response('GET', `reports/${kind}.csv?month=${full.month}&spanMode=calendar-two-day-v1`, undefined, { orgId: full.orgId }); assert.equal(csv.status, 200);
      assert.equal(SHA(Buffer.from(await csv.arrayBuffer())), SHA(full.expected.csvBytes[kind]));
    }
    for (const [entity, item] of [['cases', full.items.case], ['service-records', full.items.ownRecord], ['employee-certifications', full.items.certification], ['case-attachments', full.items.caseAttachment], ['certification-attachments', full.items.certAttachment]]) {
      const history = await admin.json('GET', `${entity}/${item.id}/history?compare=previous`, undefined, { orgId: full.orgId });
      assert.equal(SHA(JSON.stringify(history)), SHA(JSON.stringify(full.expected.histories[entity])));
    }
    for (const [entity, item, bytes] of [['case-attachments', full.items.caseAttachment, full.expected.caseBytes], ['certification-attachments', full.items.certAttachment, full.expected.certBytes]]) {
      const response = await admin.response('GET', `${entity}/${item.id}/download`, undefined, { orgId: full.orgId }); assert.equal(response.status, 200);
      assert.equal(SHA(Buffer.from(await response.arrayBuffer())), SHA(bytes));
    }
    await clients.finance.json('GET', 'employee-certifications', undefined, { orgId: full.orgId, status: 403 });
    await clients.caregiver.json('GET', `cases/${full.items.otherCase.id}`, undefined, { orgId: full.orgId, status: 404 });
    await clients.admin.json('GET', 'cases', undefined, { orgId: full.foreignOrgId, status: 403 });
    const status = await admin.json('GET', 'setup/status'); assert.equal(status.authMode, 'portal'); assert.equal(status.needsSetup, false);
    await admin.json('POST', 'login', { email: 'synthetic-local@example.test', password: 'synthetic-only' }, { status: 403 });
    await admin.json('POST', 'setup', {}, { status: 403 });
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, 0); same(oracle(app.db), before, 'Session, reports, role failures and versions read no rows into new state');
  } finally { await closeTracked(app); }
});

test('Expired snapshot session and inactive binding stay denied; existing snapshot nonce still rejects replay without writes', async () => {
  const { app, base } = await start(full), before = oracle(app.db);
  try {
    for (const cookie of [full.secrets.expiredCookie, full.secrets.inactiveCookie]) {
      const client = syntheticClient(base, 'snapshot-denied', { cookie });
      assert.equal((await client.json('GET', 'session')).user, null);
      await client.json('GET', 'cases', undefined, { orgId: full.orgId, status: 401 });
    }
    await expectHttp(await rawHandoff(base, full.snapshotReplayEnvelope), 409, 'HANDOFF_REPLAYED');
    await expectHttp(await rawHandoff(base, full.mintHandoff('inactive')), 403, 'PORTAL_IDENTITY_DENIED');
    const now = Math.floor(Date.now() / 1000);
    await expectHttp(await rawHandoff(base, full.mintHandoff('admin', { iat: now - 90, exp: now - 30 })), 401, 'HANDOFF_EXPIRED');
    const signed = full.mintHandoff('admin');
    await expectHttp(await rawHandoff(base, signed, { origin: 'https://synthetic-untrusted.example.test' }), 403, 'HANDOFF_ORIGIN_FORBIDDEN');
    await expectHttp(await rawHandoff(base, signed, { host: 'synthetic-untrusted.example.test' }), 403, 'HOST_FORBIDDEN');
    await expectHttp(await rawHandoff(base, { payload: signed.payload, signature: 'A'.repeat(43) }), 401, 'HANDOFF_INVALID');
    await expectHttp(await rawHandoff(base, full.mintHandoff('admin', { extraClaim: 'synthetic-only' })), 401, 'HANDOFF_INVALID');
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, 0); same(oracle(app.db), before);
  } finally { await closeTracked(app); }
});

test('Current restored receiver rejects revoked session and fresh handoff; failed replay cannot bypass current binding status', async () => {
  portal.restoreSyntheticBackup(fullWorkspace, fullReference, 'staged');
  const { app, base } = await start(full, 'staged');
  try {
    const before = app.db.prepare('SELECT total_changes() AS n').get().n;
    app.db.prepare('UPDATE portal_identity_bindings SET active=0 WHERE user_id=?').run(full.identities.admin.userId);
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n - before, 1, 'Revocation is explicitly one row write');
    const revoked = oracle(app.db), changes = app.db.prepare('SELECT total_changes() AS n').get().n;
    const client = syntheticClient(base, 'current-revoked', { cookie: full.sourceCookies.admin });
    assert.equal((await client.json('GET', 'session')).user, null);
    await client.json('GET', 'cases', undefined, { orgId: full.orgId, status: 401 });
    await expectHttp(await rawHandoff(base, full.mintHandoff('admin')), 403, 'PORTAL_IDENTITY_DENIED');
    await expectHttp(await rawHandoff(base, full.snapshotReplayEnvelope), 403, 'PORTAL_IDENTITY_DENIED');
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, changes); same(oracle(app.db), revoked);
  } finally { await closeTracked(app); }
});

test('Point-in-time restore demonstrably omits post-snapshot revocation, consumed nonce and new normal API records', async () => {
  const { ws, fixture } = await fullFixture(), captured = oracle(fixture.app.db), ref = portal.captureSyntheticBackup(ws);
  const beforeRevocation = fixture.app.db.prepare('SELECT total_changes() AS n').get().n;
  fixture.app.db.prepare('UPDATE portal_identity_bindings SET active=0 WHERE user_id=?').run(fixture.identities.admin.userId);
  assert.equal(fixture.app.db.prepare('SELECT total_changes() AS n').get().n - beforeRevocation, 1);
  const post = await fixture.normalHandoff('finance', { cookie: fixture.actors.finance.cookie });
  const claims = JSON.parse(Buffer.from(post.envelope.payload, 'base64url').toString('utf8'));
  assert(fixture.app.db.prepare('SELECT 1 FROM portal_handoff_nonces WHERE jti=?').get(claims.jti));
  const sourceSupervisor = fixture.actors.supervisor.client;
  const postCase = (await sourceSupervisor.json('POST', 'cases', { name: '合成 snapshot 之後個案', caseNo: 'POST-SNAPSHOT-ONLY' }, { status: 201, orgId: fixture.orgId })).item;
  const revoked = syntheticClient(fixture.base, 'source-post-revoke', { cookie: fixture.sourceCookies.admin });
  assert.equal((await revoked.json('GET', 'session')).user, null);
  const sourceAfter = oracle(fixture.app.db); assert.notEqual(sourceAfter.digest, captured.digest);
  portal.restoreSyntheticBackup(ws, ref, 'live'); same(fileOracle(slot(ws, 'live'), { closed: true }), captured);
  const { app, base } = await start(fixture);
  try {
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, 0);
    assert.equal(app.db.prepare('SELECT active FROM portal_identity_bindings WHERE user_id=?').get(fixture.identities.admin.userId).active, 1, 'Snapshot restores historical active state, not later revocation');
    assert.equal(Boolean(app.db.prepare('SELECT 1 FROM records WHERE id=?').get(postCase.id)), false);
    assert.equal(Boolean(app.db.prepare('SELECT 1 FROM portal_handoff_nonces WHERE jti=?').get(claims.jti)), false, 'Snapshot cannot preserve a nonce consumed later on the source');
    const client = syntheticClient(base, 'snapshot-original-session', { cookie: fixture.sourceCookies.admin });
    assert.equal((await client.json('GET', 'session')).user.id, fixture.identities.admin.userId);
    same(oracle(app.db), captured);
    await expectHttp(await rawHandoff(base, fixture.snapshotReplayEnvelope), 409, 'HANDOFF_REPLAYED');
    const beforeLogin = app.db.prepare('SELECT total_changes() AS n').get().n;
    const replayLaterSourceNonce = await rawHandoff(base, post.envelope);
    assert.equal(replayLaterSourceNonce.status, 303, 'An unexpired post-snapshot source nonce is absent here; reconciliation is explicitly not provided');
    assert(app.db.prepare('SELECT total_changes() AS n').get().n > beforeLogin, 'New receiver handoff cleanup/nonce/session/audit writes are separately observed');
    assert(app.db.prepare('SELECT 1 FROM portal_handoff_nonces WHERE jti=?').get(claims.jti));
    same(oracle(fixture.app.db), sourceAfter, 'Restored receiver work never alters current source state');
  } finally { await closeTracked(app); }
});

test('Changing memory signing key does not implicitly revoke an existing snapshot session', async () => {
  const { ws, fixture } = await fullFixture(), ref = portal.captureSyntheticBackup(ws); portal.restoreSyntheticBackup(ws, ref, 'live');
  const original = fixture.createAppForSlot('live'); applications.add(original); await closeTracked(original);
  // Reopening uses an explicit new synthetic key; sessions still use DB binding
  // and absolute expiry, so rotation cannot be sold as session reconciliation.
  const { createApp } = await import('../src/server/index.mjs');
  const app = createApp({ dbPath: slot(ws, 'live'), host: '127.0.0.1', port: 0, portalConfig: { mode: 'portal', publicOrigin: 'http://127.0.0.1:0', portalOrigin: PORTAL_ORIGIN, signingSecret: 'different-synthetic-memory-signing-key-only-045' } }); applications.add(app);
  const base = await app.listen(), before = oracle(app.db);
  try {
    const client = syntheticClient(base, 'rotated-existing-session', { cookie: fixture.sourceCookies.admin });
    assert.equal((await client.json('GET', 'session')).user.id, fixture.identities.admin.userId);
    await expectHttp(await rawHandoff(base, fixture.mintHandoff('admin')), 401, 'HANDOFF_INVALID');
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, 0); same(oracle(app.db), before);
  } finally { await closeTracked(app); }
});

test('Capture excludes uncommitted Portal transaction state and observes no logical source writes', () => {
  const ws = workspace(), db = mini(ws), committed = oracle(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
  db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE portal_identity_bindings SET active=0 WHERE user_id=?').run('u-one');
  assert.notEqual(oracle(db).digest, committed.digest);
  const afterPending = db.prepare('SELECT total_changes() AS n').get().n;
  const ref = portal.captureSyntheticBackup(ws); assert(ref);
  same(fileOracle(slot(ws, 'backup'), { closed: true }), committed);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, afterPending);
  db.exec('ROLLBACK'); same(oracle(db), committed); assert.equal(afterPending - changes, 1); db.close();
});

test('Schema/header/foreign-key/current-history and real corruption failures reject without repair or backup artifacts', () => {
  const probes = [
    ['CREATE TABLE unexpected(value TEXT)', 'SCHEMA_MISMATCH'],
    ['DROP TABLE portal_handoff_nonces', 'SCHEMA_MISMATCH'],
    ['ALTER TABLE portal_identity_bindings ADD COLUMN unexpected TEXT', 'SCHEMA_MISMATCH'],
    ['DROP INDEX portal_nonces_expiry', 'SCHEMA_MISMATCH'],
    ['DROP TRIGGER versions_no_delete', 'SCHEMA_MISMATCH'],
    ['PRAGMA user_version=1', 'SCHEMA_MISMATCH'],
    ['PRAGMA application_id=7', 'SCHEMA_MISMATCH'],
    ["PRAGMA foreign_keys=OFF; INSERT INTO portal_handoff_nonces VALUES('bad-fk','synthetic','missing','org-mini',1,2)", 'FOREIGN_KEY_FAILED'],
    ['UPDATE records SET version=3', 'HISTORY_INCOMPLETE'],
  ];
  for (const [mutation, code] of probes) {
    const ws = workspace(), db = mini(ws); db.exec(mutation); db.close(); const filename = slot(ws, 'source'), bytes = SHA(readFileSync(filename));
    rejectsCode(() => portal.inspectSyntheticDatabase(ws, 'source'), code); rejectsCode(() => portal.captureSyntheticBackup(ws), code);
    assert.equal(SHA(readFileSync(filename)), bytes, 'Invalid saved source remains untouched'); assert.equal(existsSync(slot(ws, 'backup')), false);
  }
  const ws = workspace(), db = mini(ws), page = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='portal_identity_bindings'").get().rootpage, size = db.prepare('PRAGMA page_size').get().page_size; db.close();
  const filename = slot(ws, 'source'), bytes = readFileSync(filename); assert(page > 1); bytes[(page - 1) * size] = 0; writeFileSync(filename, bytes);
  const digest = SHA(readFileSync(filename)); rejectsCode(() => portal.inspectSyntheticDatabase(ws, 'source'), 'INTEGRITY_FAILED'); rejectsCode(() => portal.captureSyntheticBackup(ws), 'INTEGRITY_FAILED'); assert.equal(SHA(readFileSync(filename)), digest);
  const legacyWS = localWorkspace(), legacyDb = mini(legacyWS, { legacyOnly: true }); legacyDb.close();
  const p = workspace(); copyFileSync(legacy.syntheticDatabasePath(legacyWS, 'source'), slot(p, 'source'), constants.COPYFILE_EXCL);
  rejectsCode(() => portal.inspectSyntheticDatabase(p, 'source'), 'SCHEMA_MISMATCH');
  const l = localWorkspace(), fromP = closedMini(); copyFileSync(slot(fromP, 'source'), legacy.syntheticDatabasePath(l, 'source'), constants.COPYFILE_EXCL);
  rejectsCode(() => legacy.inspectSyntheticDatabase(l, 'source'), 'SCHEMA_MISMATCH');
});

test('Manifest and snapshot byte/identity changes reject restore without allocating a target', () => {
  for (const mutation of ['manifest-format', 'manifest-bytes', 'backup-byte', 'backup-truncated', 'backup-replaced']) {
    const ws = closedMini(), ref = portal.captureSyntheticBackup(ws), backup = slot(ws, 'backup'), manifestPath = path.join(root(ws), 'backup.manifest.json');
    if (mutation === 'manifest-format') { const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.format = 'suiyue-synthetic-sqlite-backup-v1'; writeFileSync(manifestPath, JSON.stringify(manifest)); }
    if (mutation === 'manifest-bytes') writeFileSync(manifestPath, '{');
    if (mutation === 'backup-byte') { const bytes = readFileSync(backup); bytes[bytes.length - 1] ^= 1; writeFileSync(backup, bytes); }
    if (mutation === 'backup-truncated') writeFileSync(backup, readFileSync(backup).subarray(0, 100));
    if (mutation === 'backup-replaced') { const bytes = readFileSync(backup); renameSync(backup, backup + '.old'); writeFileSync(backup, bytes); chmodSync(backup, 0o600); }
    rejectsCode(() => portal.restoreSyntheticBackup(ws, ref, 'live'), 'BACKUP_CHANGED'); assert.equal(existsSync(slot(ws, 'live')), false);
  }
});

test('Fixed owned slots reject symlink/hardlink/directory and replaced roots while retaining neighboring bytes', () => {
  const ws = workspace(), neighbor = closedMini(), target = slot(ws, 'source'), sentinel = slot(neighbor, 'source'), digest = SHA(readFileSync(sentinel));
  symlinkSync(sentinel, target); rejectsCode(() => slot(ws, 'source'), 'UNSAFE_PATH'); unlinkSync(target);
  linkSync(sentinel, target); rejectsCode(() => slot(ws, 'source'), 'UNSAFE_PATH'); unlinkSync(target);
  mkdirSync(target); rejectsCode(() => slot(ws, 'source'), 'UNSAFE_PATH'); rmSync(target, { recursive: true });
  const dir = root(ws), moved = dir + '-renamed'; renameSync(dir, moved);
  try {
    symlinkSync(root(neighbor), dir, 'dir');
    try { rejectsCode(() => portal.disposeSyntheticWorkspace(ws), 'WORKSPACE_INVALID'); rejectsCode(() => portal.captureSyntheticBackup(ws), 'WORKSPACE_INVALID'); }
    finally { unlinkSync(dir); }
  } finally { renameSync(moved, dir); }
  assert.equal(SHA(readFileSync(sentinel)), digest);
});

test('Closed generation sidecars, occupied slots and post-restore candidate mutation prevent promotion', () => {
  const ws = closedMini(), ref = portal.captureSyntheticBackup(ws); portal.restoreSyntheticBackup(ws, ref, 'live'); portal.restoreSyntheticBackup(ws, ref, 'staged');
  const live = slot(ws, 'live'), staged = slot(ws, 'staged'), previous = slot(ws, 'previous'), liveDigest = SHA(readFileSync(live)), stagedDigest = SHA(readFileSync(staged));
  rejectsCode(() => portal.restoreSyntheticBackup(ws, ref, 'live'), 'TARGET_EXISTS');
  for (const options of [{}, undefined, { forceRollback: 1 }, { forceRollback: false, profile: 'legacy' }]) rejectsCode(() => portal.promoteSyntheticRestore(ws, options), 'INVALID_ARGUMENT');
  for (const filename of [live, staged]) for (const suffix of ['-wal', '-shm', '-journal']) {
    writeFileSync(filename + suffix, 'synthetic-sidecar');
    try { rejectsCode(() => portal.promoteSyntheticRestore(ws, { forceRollback: false }), 'SIDECAR_PRESENT'); }
    finally { unlinkSync(filename + suffix); }
  }
  writeFileSync(previous, 'occupied-synthetic-generation'); const previousDigest = SHA(readFileSync(previous));
  rejectsCode(() => portal.promoteSyntheticRestore(ws, { forceRollback: false }), 'TARGET_EXISTS'); assert.equal(SHA(readFileSync(previous)), previousDigest); unlinkSync(previous);
  assert.equal(SHA(readFileSync(live)), liveDigest); assert.equal(SHA(readFileSync(staged)), stagedDigest);
  const db = new DatabaseSync(staged); db.prepare('UPDATE portal_identity_bindings SET active=0 WHERE user_id=?').run('u-one'); db.close();
  rejectsCode(() => portal.promoteSyntheticRestore(ws, { forceRollback: false }), 'RESTORE_CHANGED'); assert.equal(SHA(readFileSync(live)), liveDigest);
});

test('Forced rollback restores exact distinct live and staged bytes; success retains exact previous generation and bounded metadata', () => {
  const ws = closedMini(), neighbor = closedMini(), neighborDigest = SHA(readFileSync(slot(neighbor, 'source'))), ref = portal.captureSyntheticBackup(ws);
  portal.restoreSyntheticBackup(ws, ref, 'live'); portal.restoreSyntheticBackup(ws, ref, 'staged');
  const live = slot(ws, 'live'), staged = slot(ws, 'staged'), db = new DatabaseSync(live); db.prepare('UPDATE portal_identity_bindings SET active=0 WHERE user_id=?').run('u-one'); db.close();
  const beforeBytes = SHA(readFileSync(live)), before = fileOracle(live, { closed: true }), candidateBytes = SHA(readFileSync(staged)), candidate = fileOracle(staged, { closed: true }); assert.notEqual(before.digest, candidate.digest);
  const failed = portal.promoteSyntheticRestore(ws, { forceRollback: true }); assert.equal(failed.status, 'rolled_back'); assert.equal(failed.previous, null);
  assert.equal(SHA(readFileSync(live)), beforeBytes); assert.equal(SHA(readFileSync(staged)), candidateBytes); same(fileOracle(live, { closed: true }), before); same(fileOracle(staged, { closed: true }), candidate); assert.equal(existsSync(slot(ws, 'previous')), false);
  const promoted = portal.promoteSyntheticRestore(ws, { forceRollback: false }); assert.equal(promoted.status, 'promoted'); assert.equal(promoted.staged, null);
  for (const report of [promoted.before, promoted.candidate, promoted.live, promoted.previous]) summary(report);
  assert.equal(SHA(readFileSync(live)), candidateBytes); assert.equal(SHA(readFileSync(slot(ws, 'previous'))), beforeBytes);
  same(fileOracle(live, { closed: true }), candidate); same(fileOracle(slot(ws, 'previous'), { closed: true }), before); assert.equal(existsSync(slot(ws, 'staged')), false);
  assert.equal(lstatSync(live).mode & 0o777, 0o600); assert.equal(lstatSync(slot(ws, 'previous')).mode & 0o777, 0o600);
  const result = portal.disposeSyntheticWorkspace(ws); owned.delete(ws); assert.equal(result.status, 'disposed'); assert.equal(SHA(readFileSync(slot(neighbor, 'source'))), neighborDigest);
  rejectsCode(() => portal.disposeSyntheticWorkspace(ws), 'WORKSPACE_INVALID');
});
