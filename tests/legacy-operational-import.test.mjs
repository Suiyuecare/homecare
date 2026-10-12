import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { initDb, insert, replace, business } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';
import { createSyntheticLegacyMigrationFixture } from './helpers/legacy-migration-fixture.mjs';
import { createVerifiedLegacyImportSource, legacyOperationalId, previewLegacyOperationalImport, commitLegacyOperationalImport,
  listLegacyImportBatches, readLegacyImportBatch, readLegacyImportedSource } from '../src/server/legacy-operational-import.mjs';
import { normalizeLegacyOperationalPayload, legacyOperationalSourceHash } from '../src/server/legacy-operational-import-format.mjs';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); initDb(db); initPortalStorage(db);
  const orgId = randomUUID(), actorId = randomUUID(), ctx = { orgId, user: { id: actorId }, role: 'admin' }, stamp = '2020-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成移轉機構', stamp);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(actorId, '合成移轉管理員', 'synthetic-import@example.test', 'synthetic-no-password', stamp);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, actorId, 'admin', null);
  const source = createSyntheticLegacyMigrationFixture(db, ctx, options);
  t.after(() => { db.close(); source.cleanup(); });
  const state = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [row.name, db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all()]));
  const changes = () => db.prepare('SELECT total_changes() AS count').get().count;
  return { db, ctx, ...source, state, changes };
}
const code = (operation, expected) => assert.throws(operation, error => error.code === expected);
const copy = value => JSON.parse(JSON.stringify(value));

test('zero-write preview and atomic first slice preserve original raw columns, current creation time, UUID mapping and empty rates', t => {
  const f = fixture(t), before = f.state(), changes = f.changes(), preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability);
  assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes); assert.equal(preview.totalCount, 2); assert.equal(preview.sourceSystemComplete, false);
  const receipt = commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash);
  assert.equal(receipt.replayed, false); assert.equal(receipt.sourceSystemComplete, false);
  const list = listLegacyImportBatches(f.db, f.ctx), detail = readLegacyImportBatch(f.db, f.ctx, receipt.batchId);
  assert.equal(list.total, 1); assert.equal(detail.total, 2); assert.equal(detail.pageSize, 25);
  for (const summary of detail.records) {
    const read = readLegacyImportedSource(f.db, f.ctx, summary.id), original = f.payload.records.find(record => record.sourceId === summary.sourceId);
    assert.deepEqual(read.item.columns, original.columns); assert.deepEqual(read.item.data, original.data); assert.equal(read.item.sourceCreatedAt, original.sourceCreatedAt);
    assert.equal(read.currentTarget.createdAt, detail.item.importedAt); assert.notEqual(read.currentTarget.createdAt, original.sourceCreatedAt);
    assert.equal(read.currentTarget.id, legacyOperationalId(f.ctx.orgId, f.payload.provider, f.payload.tenant, original.entity, original.sourceId));
    assert.equal(read.currentTarget.version, 1); assert(!Object.hasOwn(read.item.data, 'hourlyRateCents')); assert(!Object.hasOwn(read.currentTarget, 'hourlyRateCents'));
  }
  const after = f.state();
  for (const table of ['organizations', 'users', 'memberships', 'sessions', 'portal_identity_bindings', 'portal_handoff_nonces', 'idempotency', 'attachment_files', 'certification_attachment_files']) assert.deepEqual(after[table], before[table]);
});

test('exact replay is zero-write; altered content for the same source fails instead of overwriting', t => {
  const f = fixture(t), preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability);
  const receipt = commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash), before = f.state(), changes = f.changes();
  const again = commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash);
  assert.equal(again.batchId, receipt.batchId); assert.equal(again.replayed, true); assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes);
  const altered = copy(f.payload); altered.records[0].columns[0].raw += '改值';
  code(() => previewLegacyOperationalImport(f.db, f.ctx, altered, f.capability), 'LEGACY_IMPORT_SOURCE_CONFLICT');
  code(() => commitLegacyOperationalImport(f.db, f.ctx, altered, f.capability, preview.previewHash), 'LEGACY_IMPORT_SOURCE_CONFLICT'); assert.deepEqual(f.state(), before);
});

test('CAS preview refuses added or changed current data and preserves every existing row', t => {
  const f = fixture(t), preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability);
  insert(f.db, f.ctx.orgId, 'cases', { name: '合成新增', caseNo: 'SYN-LATER', status: 'active' });
  const before = f.state(), changes = f.changes();
  code(() => commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash), 'LEGACY_IMPORT_PREVIEW_STALE');
  assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes);
});

test('batch duplicates, existing numbers and matching source mapping reject whole input', t => {
  const f = fixture(t), duplicate = copy(f.payload); duplicate.records[1] = copy(duplicate.records[0]);
  const before = f.state(); code(() => previewLegacyOperationalImport(f.db, f.ctx, duplicate, f.capability), 'LEGACY_IMPORT_DUPLICATE'); assert.deepEqual(f.state(), before);
  insert(f.db, f.ctx.orgId, 'employees', { name: '合成既有', employeeNo: f.payload.records[0].data.employeeNo, status: 'active' });
  const existing = f.state(); code(() => previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), 'LEGACY_IMPORT_EXISTING'); assert.deepEqual(f.state(), existing);
});

test('current database role, actor existence and lifecycle override a forged admin context for every operation', t => {
  const f = fixture(t, { commit: true }), batch = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), mappingId = batch.records[0].id;
  const operations = ctx => [() => previewLegacyOperationalImport(f.db, ctx, f.payload, f.capability),
    () => commitLegacyOperationalImport(f.db, ctx, f.payload, f.capability, 'a'.repeat(64)), () => listLegacyImportBatches(f.db, ctx),
    () => readLegacyImportBatch(f.db, ctx, f.receipt.batchId), () => readLegacyImportedSource(f.db, ctx, mappingId)];
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const before = f.state(); for (const operation of operations({ ...f.ctx, role })) code(operation, 'ROLE_FORBIDDEN'); assert.deepEqual(f.state(), before);
    f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run(role, f.ctx.orgId, f.ctx.user.id);
    for (const operation of operations(f.ctx)) code(operation, 'ROLE_FORBIDDEN');
    f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('admin', f.ctx.orgId, f.ctx.user.id);
  }
  for (const operation of operations({ ...f.ctx, user: { id: randomUUID() } })) code(operation, 'ROLE_FORBIDDEN');
  const second = randomUUID(); f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(second, '合成第二管理員', 'synthetic-admin2@example.test', 'synthetic-no-password', '2020-01-01T00:00:00.000Z');
  f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(f.ctx.orgId, second, 'admin', null);
  const secondCtx = { ...f.ctx, user: { id: second } }; f.db.exec('BEGIN IMMEDIATE');
  commitAccountChange(f.db, secondCtx, f.ctx.user.id, { version: 0, role: 'admin', employeeId: null, status: 'suspended', reason: '合成撤權測試' }); f.db.exec('COMMIT');
  const suspended = f.state(); for (const operation of operations(f.ctx)) code(operation, 'ROLE_FORBIDDEN'); assert.deepEqual(f.state(), suspended);
});

test('same business numbers in another organization are isolated and raw sources stay admin-only same-org', t => {
  const f = fixture(t), other = randomUUID(), stamp = '2020-01-01T00:00:00.000Z';
  f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(other, '合成外機構', stamp); f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(other, f.ctx.user.id, 'admin', null);
  insert(f.db, other, 'employees', { name: '合成外機構員工', employeeNo: f.payload.records[0].data.employeeNo, status: 'active' });
  const preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), receipt = commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash);
  const detail = readLegacyImportBatch(f.db, f.ctx, receipt.batchId), ctx = { ...f.ctx, orgId: other };
  assert.equal(listLegacyImportBatches(f.db, ctx).total, 0); code(() => readLegacyImportBatch(f.db, ctx, receipt.batchId), 'NOT_FOUND'); code(() => readLegacyImportedSource(f.db, ctx, detail.records[0].id), 'NOT_FOUND');
});

test('whole-batch SQL failure preserves rows, history, audit, identity and original source', t => {
  const f = fixture(t), preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability);
  f.db.exec("CREATE TEMP TRIGGER synthetic_legacy_failure BEFORE INSERT ON records WHEN NEW.entity='cases' BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END");
  const before = f.state(); code(() => commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash), 'LEGACY_IMPORT_FAILED'); assert.deepEqual(f.state(), before);
  f.db.exec('DROP TRIGGER synthetic_legacy_failure'); assert.equal(previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability).ready, true);
});

test('archive tampering after a valid preview and ordinary counterfeit capability both refuse writes', t => {
  const f = fixture(t), preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), before = f.state();
  code(() => previewLegacyOperationalImport(f.db, f.ctx, f.payload, { manifestSha256: f.capture.manifestSha256 }), 'LEGACY_IMPORT_ARCHIVE_INVALID');
  writeFileSync(path.join(f.archivePath, 'files', '00000001.csv'), '合成篡改', { mode: 0o600 });
  code(() => commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash), 'LEGACY_IMPORT_ARCHIVE_INVALID'); assert.deepEqual(f.state(), before);
  code(() => createVerifiedLegacyImportSource({ archivePath: f.archivePath, expectedManifestSha256: f.capture.manifestSha256 }), 'LEGACY_IMPORT_ARCHIVE_INVALID');
});

test('closed payload forbids accounts, prices, rates, sparse/accessor columns and false completeness', t => {
  const f = fixture(t), alterations = [];
  const rate = copy(f.payload); rate.records[0].data.hourlyRateCents = 0; alterations.push(rate);
  const wrong = copy(f.payload); wrong.records[0].entity = 'users'; alterations.push(wrong);
  const derived = copy(f.payload); derived.records[0].data.employeeNo = '假裝真編號'; alterations.push(derived);
  const nested = copy(f.payload); nested.records[0].columns[0].raw = { hidden: '合成巢狀' }; alterations.push(nested);
  const sparse = copy(f.payload); sparse.records[0].columns = Array(1); alterations.push(sparse);
  alterations.push({ ...f.payload, sourceSystemComplete: true });
  let getters = 0; const accessor = copy(f.payload); Object.defineProperty(accessor.records[0].columns[0], 'raw', { enumerable: true, get() { getters++; return '不可執行'; } }); alterations.push(accessor);
  const before = f.state(); for (const payload of alterations) code(() => previewLegacyOperationalImport(f.db, f.ctx, payload, f.capability), 'LEGACY_IMPORT_INVALID');
  assert.equal(getters, 0); assert.deepEqual(f.state(), before);
});

test('provider aliases and mismatched source file hash cannot pass a real archive proof', t => {
  const f = fixture(t), changed = copy(f.payload); changed.provider = 'another'; changed.sourceHash = legacyOperationalSourceHash({ provider: changed.provider, tenant: changed.tenant, sourceFiles: changed.sourceFiles });
  changed.records[0].data.employeeNo = 'ANOTHER-' + changed.records[0].sourceId;
  code(() => previewLegacyOperationalImport(f.db, f.ctx, changed, f.capability), 'LEGACY_IMPORT_ARCHIVE_INVALID');
  const hash = copy(f.payload); hash.sourceFiles[0].sha256 = 'a'.repeat(64); hash.sourceHash = legacyOperationalSourceHash({ provider: hash.provider, tenant: hash.tenant, sourceFiles: hash.sourceFiles });
  code(() => previewLegacyOperationalImport(f.db, f.ctx, hash, f.capability), 'LEGACY_IMPORT_ARCHIVE_INVALID');
});

test('original source persists while authorized later main-record versions remain distinct and replay stays read-only', t => {
  const f = fixture(t, { commit: true }), detail = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), summary = detail.records.find(record => record.entity === 'cases');
  const original = readLegacyImportedSource(f.db, f.ctx, summary.id);
  replace(f.db, f.ctx.orgId, 'cases', original.currentTarget, { ...business(original.currentTarget), note: '合成後續核定變更' });
  const now = readLegacyImportedSource(f.db, f.ctx, summary.id); assert.equal(now.currentTarget.version, 2); assert.equal(now.currentTarget.note, '合成後續核定變更'); assert.deepEqual(now.item.data, original.item.data);
  const preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), before = f.state(), changes = f.changes();
  assert.equal(commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash).replayed, true); assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes);
});

test('paged batch proves every child and refuses corrupt source/head even outside the requested page', t => {
  const f = fixture(t, { count: 27, commit: true }), first = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), second = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId, { page: 2, pageSize: 25 });
  assert.equal(first.records.length, 25); assert.equal(second.records.length, 2); assert.equal(second.page, 2);
  f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{bad', second.records[0].id);
  const before = f.state(); code(() => readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), 'LEGACY_IMPORT_STATE_INVALID'); code(() => listLegacyImportBatches(f.db, f.ctx), 'LEGACY_IMPORT_STATE_INVALID'); assert.deepEqual(f.state(), before);
});

test('maximum 2000 operational rows are atomic, complete and paged; 2001 rows refuse', { timeout: 120000 }, t => {
  const f = fixture(t, { count: 2000 }), preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), receipt = commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash);
  assert.equal(receipt.importedCount, 2000); assert.equal(receipt.employeeCount, 1000); assert.equal(receipt.caseCount, 1000);
  const last = readLegacyImportBatch(f.db, f.ctx, receipt.batchId, { page: 80, pageSize: 25 }); assert.equal(last.total, 2000); assert.equal(last.records.length, 25);
  const tooMany = copy(f.payload); tooMany.records.push(copy(tooMany.records[0])); code(() => normalizeLegacyOperationalPayload(tooMany), 'LEGACY_IMPORT_INVALID');
});

test('bad current metadata, missing versions and wrong typed stored data refuse all source reading', t => {
  for (const alteration of ['timestamp', 'version', 'json']) {
    const f = fixture(t, { commit: true }), detail = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), mapping = detail.records[0];
    if (alteration === 'timestamp') f.db.prepare('UPDATE records SET created_at=created_at||? WHERE id=?').run('\u0000hidden-tail', mapping.targetId);
    else if (alteration === 'version') f.db.prepare('UPDATE records SET version=version+1 WHERE id=?').run(mapping.targetId);
    else f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{"name":4}', mapping.targetId);
    const before = f.state(); code(() => readLegacyImportedSource(f.db, f.ctx, mapping.id), 'LEGACY_IMPORT_STATE_INVALID'); code(() => listLegacyImportBatches(f.db, f.ctx), 'LEGACY_IMPORT_STATE_INVALID'); assert.deepEqual(f.state(), before);
  }
});

test('pagination is closed and admin guard precedes malformed queries or unknown identities', t => {
  const f = fixture(t, { commit: true });
  for (const query of [{ page: 1, pageSize: 101 }, { page: 0, pageSize: 25 }, { page: '1', pageSize: 25 }, { page: 1, pageSize: 25, unknown: 'synthetic-private' }]) {
    code(() => listLegacyImportBatches(f.db, f.ctx, query), 'LEGACY_IMPORT_QUERY_INVALID'); code(() => readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId, query), 'LEGACY_IMPORT_QUERY_INVALID');
    code(() => listLegacyImportBatches(f.db, { ...f.ctx, role: 'finance' }, query), 'ROLE_FORBIDDEN');
  }
  code(() => readLegacyImportedSource(f.db, { ...f.ctx, role: 'supervisor' }, 'bad'), 'ROLE_FORBIDDEN');
  assert.equal(readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId, { page: 100, pageSize: 25 }).records.length, 0);
});

test('safe page start with unsafe page end is rejected for lists and batch pages', t => {
  const f = fixture(t, { commit: true }), query = { page: Math.floor(Number.MAX_SAFE_INTEGER / 25) + 1, pageSize: 25 };
  assert(Number.isSafeInteger((query.page - 1) * query.pageSize)); assert(!Number.isSafeInteger(query.page * query.pageSize));
  code(() => listLegacyImportBatches(f.db, f.ctx, query), 'LEGACY_IMPORT_QUERY_INVALID'); code(() => readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId, query), 'LEGACY_IMPORT_QUERY_INVALID');
});

test('consistent current case heads cannot point to missing, wrong-entity or foreign-org supervisor parents', t => {
  for (const type of ['missing', 'wrong-entity', 'foreign', 'bad-parent-head']) {
    const f = fixture(t, { commit: true }), preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), detail = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), mapping = detail.records.find(record => record.entity === 'cases'), original = readLegacyImportedSource(f.db, f.ctx, mapping.id);
    let supervisorId = randomUUID();
    if (type === 'wrong-entity') supervisorId = mapping.targetId;
    else if (type === 'foreign') {
      const org = randomUUID(); f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org, '合成外機構督導', '2020-01-01T00:00:00.000Z');
      supervisorId = insert(f.db, org, 'employees', { name: '合成外機構督導', employeeNo: 'SYN-FOREIGN-PARENT', status: 'active' }).id;
    } else if (type === 'bad-parent-head') {
      supervisorId = original.currentTarget.supervisorId; f.db.prepare('UPDATE records SET version=version+1 WHERE id=?').run(supervisorId);
    }
    replace(f.db, f.ctx.orgId, 'cases', original.currentTarget, { ...business(original.currentTarget), supervisorId });
    const before = f.state();
    code(() => readLegacyImportedSource(f.db, f.ctx, mapping.id), 'LEGACY_IMPORT_STATE_INVALID'); code(() => listLegacyImportBatches(f.db, f.ctx), 'LEGACY_IMPORT_STATE_INVALID');
    code(() => previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), 'LEGACY_IMPORT_STATE_INVALID');
    code(() => commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash), 'LEGACY_IMPORT_STATE_INVALID');
    assert.deepEqual(f.state(), before);
  }
});

test('inactive same-org supervisor remains readable when its complete current head is valid', t => {
  const f = fixture(t, { commit: true }), detail = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), employee = detail.records.find(record => record.entity === 'employees'), original = readLegacyImportedSource(f.db, f.ctx, employee.id);
  replace(f.db, f.ctx.orgId, 'employees', original.currentTarget, { ...business(original.currentTarget), status: 'inactive' });
  const current = readLegacyImportBatch(f.db, f.ctx, f.receipt.batchId), child = current.records.find(record => record.entity === 'cases');
  assert.equal(readLegacyImportedSource(f.db, f.ctx, child.id).currentTarget.supervisorId, employee.targetId);
  const preview = previewLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability), before = f.state(), changes = f.changes();
  assert.equal(commitLegacyOperationalImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash).replayed, true); assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes);
});
