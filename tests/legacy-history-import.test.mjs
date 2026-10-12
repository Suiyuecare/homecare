import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { initDb, insert, replace, business, entities } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';
import { captureLegacyArchive } from '../src/server/legacy-migration-archive.mjs';
import { parseLegacyJson } from '../src/server/legacy-migration-archive-metadata.mjs';
import { createSyntheticLegacyHistoryFixture } from './helpers/legacy-history-fixture.mjs';
import { createVerifiedLegacyHistorySource, previewLegacyHistoryImport, commitLegacyHistoryImport, listLegacyHistoryBatches,
  readLegacyHistoryBatch, readLegacyHistoryRow, legacyHistorySourceHash, legacyHistoryHash, legacyHistoryRowId, normalizeLegacyHistoryPayload } from '../src/server/legacy-history-import.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const fails = (fn, code) => assert.throws(fn, error => error.code === code);
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); initDb(db); initPortalStorage(db);
  const orgId = randomUUID(), actorId = randomUUID(), ctx = { orgId, user: { id: actorId }, role: 'admin' }, stamp = '2020-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成歷史機構', stamp);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(actorId, '合成歷史管理員', 'synthetic-history@example.test', 'synthetic-no-password', stamp);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, actorId, 'admin', null);
  const source = createSyntheticLegacyHistoryFixture(db, ctx, options);
  t.after(() => { db.close(); source.cleanup(); });
  const state = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [row.name, db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all()]));
  return { db, ctx, ...source, state, changes: () => db.prepare('SELECT total_changes() AS count').get().count };
}
function hashSource(payload) { payload.sourceHash = legacyHistorySourceHash({ provider: payload.provider, tenant: payload.tenant, sourceFiles: payload.sourceFiles, records: payload.records }); return payload; }
function commit(f, payload = f.payload) { const p = previewLegacyHistoryImport(f.db, f.ctx, payload, f.capability); return commitLegacyHistoryImport(f.db, f.ctx, payload, f.capability, p.previewHash); }
function rewriteHead(db, id, mutate) {
  // Synthetic out-of-band corruption only, never the application write path.
  db.exec('DROP TRIGGER IF EXISTS versions_no_update');
  const row = db.prepare('SELECT * FROM records WHERE id=?').get(id), data = JSON.parse(row.data); mutate(data);
  db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data), id);
  db.prepare('UPDATE record_versions SET snapshot=? WHERE record_id=? AND version=?').run(JSON.stringify({ ...data, id, orgId: row.org_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }), id, row.version);
}
function measuredAuditReads(db) {
  let reads = 0;
  const measured = new Proxy(db, { get(target, property) {
    if (property === 'prepare') return sql => {
      const statement = target.prepare(sql), auditRead = /\bselect\b/i.test(sql) && /\baudit\b/i.test(sql);
      return new Proxy(statement, { get(value, key) {
        const member = Reflect.get(value, key, value);
        if (typeof member !== 'function') return member;
        return (...args) => { if (auditRead && ['get', 'all', 'iterate'].includes(key)) reads++; return member.apply(value, args); };
      } });
    };
    const member = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  return { db: measured, count: () => reads, reset: () => { reads = 0; } };
}

test('audit query executions remain bounded for a 200-row complete batch and single offpage row read', t => {
  const f = fixture(t, { count: 200, commit: true }), measure = measuredAuditReads(f.db), batch = readLegacyHistoryBatch(measure.db, f.ctx, f.receipt.batchId, { page: 1, pageSize: 1 });
  assert.equal(batch.total, 200); assert.equal(batch.records.length, 1); assert(measure.count() <= 4, 'audit reads must remain bounded, got ' + measure.count());
  const rowId = legacyHistoryRowId(f.ctx.orgId, f.payload.provider, f.payload.tenant, f.payload.sourceFiles[0].sha256, f.payload.records[199].locator);
  measure.reset(); assert.equal(readLegacyHistoryRow(measure.db, f.ctx, rowId).item.locator.pointer, '/rows/199'); assert(measure.count() <= 4, 'single-row audit reads must remain bounded, got ' + measure.count());
});

test('offpage missing duplicate and wrong-actor audits reject the entire batch without writes', t => {
  for (const mode of ['missing', 'duplicate', 'wrong-actor']) {
    const f = fixture(t, { count: 100, commit: true }), rowId = legacyHistoryRowId(f.ctx.orgId, f.payload.provider, f.payload.tenant, f.payload.sourceFiles[0].sha256, f.payload.records[99].locator);
    const original = f.db.prepare("SELECT * FROM audit WHERE entity='legacy-history-rows' AND record_id=?").get(rowId);
    if (mode === 'missing') f.db.prepare('DELETE FROM audit WHERE id=?').run(original.id);
    if (mode === 'duplicate') f.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), original.org_id, original.user_id, original.action, original.entity, original.record_id, original.detail, original.created_at);
    if (mode === 'wrong-actor') f.db.prepare('UPDATE audit SET user_id=? WHERE id=?').run(randomUUID(), original.id);
    const before = f.state(), changes = f.changes();
    fails(() => readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId, { page: 1, pageSize: 1 }), 'LEGACY_HISTORY_STATE_INVALID'); fails(() => readLegacyHistoryRow(f.db, f.ctx, rowId), 'LEGACY_HISTORY_STATE_INVALID'); assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes);
  }
});

test('audit data and privileges are freshly checked across requests after a successful read', t => {
  const f = fixture(t, { count: 100, commit: true }), batch = readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId, { page: 1, pageSize: 1 }), rowId = legacyHistoryRowId(f.ctx.orgId, f.payload.provider, f.payload.tenant, f.payload.sourceFiles[0].sha256, f.payload.records[99].locator);
  f.db.prepare('UPDATE audit SET detail=? WHERE record_id=?').run('{}', rowId); fails(() => readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId, { page: 1, pageSize: 1 }), 'LEGACY_HISTORY_STATE_INVALID'); fails(() => readLegacyHistoryRow(f.db, f.ctx, batch.records[0].id), 'LEGACY_HISTORY_STATE_INVALID');
  f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance', f.ctx.orgId, f.ctx.user.id); fails(() => readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId), 'ROLE_FORBIDDEN');
});

test('zero-write preview and atomic historical storage preserve exact complete columns and all existing rows', t => {
  const f = fixture(t, { columnCount: 8 });
  insert(f.db, f.ctx.orgId, 'employees', { name: '合成既有員工', employeeNo: 'SYN-PRESERVE', status: 'inactive' });
  const before = f.state(), changes = f.changes(), preview = previewLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability);
  assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes); assert.equal(preview.rowCount, 2);
  const receipt = commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash), detail = readLegacyHistoryBatch(f.db, f.ctx, receipt.batchId);
  assert.equal(receipt.replayed, false); assert.equal(detail.total, 2); assert.deepEqual(detail.item.categories, ['employee-profile', 'service-export']); assert.deepEqual(detail.item.reportingPeriods, ['2020-01', '2020-02']);
  for (const [index, summary] of detail.records.entries()) {
    const row = readLegacyHistoryRow(f.db, f.ctx, summary.id).item, original = f.payload.records[index];
    assert.deepEqual(row.columns, original.columns); assert.equal(row.sourceNativeId, original.sourceNativeId); assert.equal(row.sourceCreatedAt, original.sourceCreatedAt);
    assert.equal(row.identityKind, 'archive-locator'); assert.equal(row.createdAt, detail.item.importedAt); assert.equal(row.caseReference, null); assert.equal(row.employeeReference, null);
    assert.equal(row.id, legacyHistoryRowId(f.ctx.orgId, f.payload.provider, f.payload.tenant, f.payload.sourceFiles[0].sha256, original.locator));
  }
  const after = f.state();
  for (const table of ['organizations', 'users', 'memberships', 'sessions', 'portal_identity_bindings', 'portal_handoff_nonces', 'demo_seeds', 'attachment_files', 'certification_attachment_files', 'idempotency']) assert.deepEqual(after[table], before[table]);
  for (const table of ['records', 'record_versions', 'audit']) assert.deepEqual(after[table].slice(0, before[table].length), before[table]);
  assert.deepEqual(Object.keys(after), Object.keys(before)); assert(!entities['legacy-history-rows']); assert(!entities['legacy-history-batches']);
  for (const key of ['sourceSystemComplete', 'operationalConversionCompleted', 'approvalCompleted', 'payrollApproved']) { assert.equal(receipt[key], false); assert.equal(detail[key], false); assert.equal(detail.item[key], false); }
});

test('layout sharing reconstructs different schemas and remains byte-equivalent to normalized logical payload', t => {
  const f = fixture(t, { count: 4, columnCount: 6 }); f.payload.records[2].columns[1].label = '另版欄位'; f.payload.records[3].columns.reverse();
  const receipt = commit(f), detail = readLegacyHistoryBatch(f.db, f.ctx, receipt.batchId), data = JSON.parse(f.db.prepare('SELECT data FROM records WHERE id=?').get(receipt.batchId).data);
  assert.equal(data.layouts.length, 3);
  const records = detail.records.map(summary => { const row = readLegacyHistoryRow(f.db, f.ctx, summary.id).item; return { category: row.category, reportingPeriod: row.reportingPeriod, sourceNativeId: row.sourceNativeId, sourceCreatedAt: row.sourceCreatedAt, caseId: row.caseId, employeeId: row.employeeId, sourceFileId: row.sourceFileId, locator: row.locator, columns: row.columns }; });
  assert.deepEqual(records, f.payload.records); assert.equal(legacyHistoryHash(normalizeLegacyHistoryPayload({ ...f.payload, records })), detail.item.payloadHash);
  for (const row of f.db.prepare("SELECT data FROM records WHERE entity='legacy-history-rows'").all()) { const stored = JSON.parse(row.data); assert(!Object.hasOwn(stored.record, 'columns')); assert.equal(stored.values.length, 6); }
});

test('exact replay performs no SQL writes; same selections altered content or period reject', t => {
  const f = fixture(t), preview = previewLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability), receipt = commit(f), before = f.state(), changes = f.changes();
  assert.equal(commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash).replayed, true); assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes);
  for (const field of ['raw', 'formula', 'cached']) { const p = copy(f.payload); p.records[0].columns[0][field] = '合成改動'; fails(() => previewLegacyHistoryImport(f.db, f.ctx, p, f.capability), 'LEGACY_HISTORY_SOURCE_CONFLICT'); }
  const period = copy(f.payload); period.records[0].reportingPeriod = '2021-01'; fails(() => commitLegacyHistoryImport(f.db, f.ctx, period, f.capability, preview.previewHash), 'LEGACY_HISTORY_SOURCE_CONFLICT');
  assert.equal(receipt.rowCount, 2); assert.deepEqual(f.state(), before);
});

test('same file disjoint locator batches succeed; overlap and recategorization cannot recreate a source row', t => {
  const f = fixture(t, { count: 3 }), a = hashSource({ ...copy(f.payload), records: [copy(f.payload.records[0])] }), b = hashSource({ ...copy(f.payload), records: [copy(f.payload.records[1])] });
  assert.notEqual(a.sourceHash, b.sourceHash); commit(f, a); commit(f, b); assert.equal(listLegacyHistoryBatches(f.db, f.ctx).total, 2);
  const overlap = hashSource({ ...copy(f.payload), records: [copy(f.payload.records[0]), copy(f.payload.records[2])] }); overlap.records[0].category = 'form-record'; const before = f.state();
  fails(() => previewLegacyHistoryImport(f.db, f.ctx, overlap, f.capability), 'LEGACY_HISTORY_EXISTING'); assert.deepEqual(f.state(), before);
  const duplicate = copy(f.payload); duplicate.records[1] = copy(duplicate.records[0]); fails(() => normalizeLegacyHistoryPayload(duplicate), 'LEGACY_HISTORY_DUPLICATE');
});

test('a different opaque file ID and archive cannot recreate the same original SHA and locator', t => {
  const f = fixture(t); commit(f);
  const incomingPath = path.join(f.rootPath, 'alternate-incoming'), outputParent = path.join(f.rootPath, 'alternate-archives'); mkdirSync(incomingPath, { mode: 0o700 }); mkdirSync(outputParent, { mode: 0o700 });
  const original = readFileSync(path.join(f.incomingPath, 'synthetic.json')); writeFileSync(path.join(incomingPath, 'a.json'), '{}', { mode: 0o600 }); writeFileSync(path.join(incomingPath, 'b.json'), original, { mode: 0o600 }); original.fill(0);
  const capture = captureLegacyArchive({ inputPath: incomingPath, outputParent, scope: { format: 'suiyue-legacy-export-scope-v1', provider: 'synthetic', tenant: 'synthetic-tenant', exportedAt: '2020-01-02T03:04:05.000Z', datasets: [{ id: 'synthetic-history', sourceFiles: ['a.json', 'b.json'], sourceRowCount: 2, reportedCoverage: 'partial', range: { kind: 'unknown' } }], missingDatasets: [], unresolved: [] } });
  const capability = createVerifiedLegacyHistorySource({ archivePath: path.join(outputParent, capture.archiveId), expectedManifestSha256: capture.manifestSha256 }), p = copy(f.payload);
  p.archiveManifestSha256 = capture.manifestSha256; p.sourceFiles[0].fileId = 'file-00000002'; p.records.forEach(record => { record.sourceFileId = 'file-00000002'; }); hashSource(p);
  const before = f.state(); fails(() => previewLegacyHistoryImport(f.db, f.ctx, p, capability), 'LEGACY_HISTORY_EXISTING'); assert.deepEqual(f.state(), before);
});

test('live parent summaries allow closed/inactive, expose only five fields, and CAS detects parent changes', t => {
  const f = fixture(t), employee = insert(f.db, f.ctx.orgId, 'employees', { name: '合成離職員工', employeeNo: 'SYN-REF-E', status: 'inactive', phone: 'synthetic-private' }), c = insert(f.db, f.ctx.orgId, 'cases', { name: '合成結案個案', caseNo: 'SYN-REF-C', status: 'closed', supervisorId: employee.id });
  f.payload.records.forEach(row => { row.caseId = c.id; row.employeeId = employee.id; });
  const preview = previewLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability);
  replace(f.db, f.ctx.orgId, 'employees', employee, { ...business(employee), name: '合成改名' }); const before = f.state();
  fails(() => commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, preview.previewHash), 'LEGACY_HISTORY_PREVIEW_STALE'); assert.deepEqual(f.state(), before);
  const receipt = commit(f), row = readLegacyHistoryBatch(f.db, f.ctx, receipt.batchId).records[0];
  assert.deepEqual(row.employeeReference, { id: employee.id, name: '合成改名', employeeNo: 'SYN-REF-E', version: 2, status: 'inactive' }); assert.deepEqual(Object.keys(row.caseReference).sort(), ['caseNo', 'id', 'name', 'status', 'version']);
});

test('missing/foreign/different-entity parent and corrupt current heads are never accepted', t => {
  const f = fixture(t), other = randomUUID(); f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(other, '合成外機構', '2020-01-01T00:00:00.000Z');
  const foreign = insert(f.db, other, 'employees', { name: '合成外員工', employeeNo: 'SYN-FOREIGN', status: 'inactive' }), own = insert(f.db, f.ctx.orgId, 'employees', { name: '合成本機構', employeeNo: 'SYN-OWN', status: 'active' });
  for (const [key, id] of [['employeeId', randomUUID()], ['employeeId', foreign.id], ['caseId', own.id]]) { const p = copy(f.payload); p.records[0][key] = id; fails(() => previewLegacyHistoryImport(f.db, f.ctx, p, f.capability), 'LEGACY_HISTORY_STATE_INVALID'); }
  const c = insert(f.db, f.ctx.orgId, 'cases', { name: '合成父案', caseNo: 'SYN-PARENT', status: 'closed', supervisorId: own.id }); f.payload.records[0].caseId = c.id; const receipt = commit(f), read = () => readLegacyHistoryBatch(f.db, f.ctx, receipt.batchId);
  rewriteHead(f.db, c.id, data => { data.supervisorId = foreign.id; }); fails(read, 'LEGACY_HISTORY_STATE_INVALID'); fails(() => previewLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability), 'LEGACY_HISTORY_STATE_INVALID');
  rewriteHead(f.db, c.id, data => { data.supervisorId = own.id; }); f.db.prepare('UPDATE record_versions SET snapshot=? WHERE record_id=?').run('{}', own.id); fails(read, 'LEGACY_HISTORY_STATE_INVALID');
});

test('all operations verify actual current admin membership and suspension rather than supplied context', t => {
  const f = fixture(t, { commit: true }), rowId = readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId).records[0].id;
  const operations = ctx => [() => previewLegacyHistoryImport(f.db, ctx, f.payload, f.capability), () => commitLegacyHistoryImport(f.db, ctx, f.payload, f.capability, 'a'.repeat(64)), () => listLegacyHistoryBatches(f.db, ctx), () => readLegacyHistoryBatch(f.db, ctx, f.receipt.batchId), () => readLegacyHistoryRow(f.db, ctx, rowId)];
  for (const role of ['supervisor', 'caregiver', 'finance']) { for (const operation of operations({ ...f.ctx, role })) fails(operation, 'ROLE_FORBIDDEN'); f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run(role, f.ctx.orgId, f.ctx.user.id); for (const operation of operations(f.ctx)) fails(operation, 'ROLE_FORBIDDEN'); f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('admin', f.ctx.orgId, f.ctx.user.id); }
  for (const operation of operations({ ...f.ctx, user: { id: randomUUID() } })) fails(operation, 'ROLE_FORBIDDEN');
  const second = randomUUID(); f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(second, '合成第二管理員', 'synthetic-history-second@example.test', 'synthetic-no-password', '2020-01-01T00:00:00.000Z'); f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(f.ctx.orgId, second, 'admin', null);
  f.db.exec('BEGIN IMMEDIATE'); commitAccountChange(f.db, { ...f.ctx, user: { id: second } }, f.ctx.user.id, { version: 0, role: 'admin', employeeId: null, status: 'suspended', reason: '合成撤權' }); f.db.exec('COMMIT');
  const before = f.state(); for (const operation of operations(f.ctx)) fails(operation, 'ROLE_FORBIDDEN'); assert.deepEqual(f.state(), before);
});

test('raw history data and batches are strictly same-org, including an admin active in two orgs', t => {
  const f = fixture(t, { commit: true }), other = randomUUID(), row = readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId).records[0]; f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(other, '合成另一機構', '2020-01-01T00:00:00.000Z'); f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(other, f.ctx.user.id, 'admin', null);
  const ctx = { ...f.ctx, orgId: other }; assert.equal(listLegacyHistoryBatches(f.db, ctx).total, 0); fails(() => readLegacyHistoryBatch(f.db, ctx, f.receipt.batchId), 'NOT_FOUND'); fails(() => readLegacyHistoryRow(f.db, ctx, row.id), 'NOT_FOUND');
});

test('partial SQL insertion and missing/stale preview roll back the entire batch', t => {
  const f = fixture(t, { count: 3 }), p = previewLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability);
  f.db.exec("CREATE TEMP TRIGGER synthetic_history_failure BEFORE INSERT ON records WHEN NEW.entity='legacy-history-rows' AND (SELECT COUNT(*) FROM records WHERE entity='legacy-history-rows')=1 BEGIN SELECT RAISE(ABORT,'synthetic-private-details'); END");
  const before = f.state(); fails(() => commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, p.previewHash), 'LEGACY_HISTORY_FAILED'); assert.deepEqual(f.state(), before);
  fails(() => commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, 'a'.repeat(64)), 'LEGACY_HISTORY_PREVIEW_STALE'); assert.deepEqual(f.state(), before);
  fails(() => commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, ''), 'LEGACY_HISTORY_PREVIEW_REQUIRED'); f.db.exec('BEGIN IMMEDIATE'); fails(() => commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, p.previewHash), 'LEGACY_HISTORY_TRANSACTION_ACTIVE'); f.db.exec('ROLLBACK');
});

test('counterfeit source capabilities, wrong manifest/file/provider, and archive mutation refuse every write', t => {
  const f = fixture(t), p = previewLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability), before = f.state();
  fails(() => previewLegacyHistoryImport(f.db, f.ctx, f.payload, { manifestSha256: f.capture.manifestSha256 }), 'LEGACY_HISTORY_ARCHIVE_INVALID');
  for (const change of [payload => { payload.archiveManifestSha256 = 'a'.repeat(64); }, payload => { payload.provider = 'other'; hashSource(payload); }, payload => { payload.sourceFiles[0].sha256 = 'a'.repeat(64); hashSource(payload); }]) { const payload = copy(f.payload); change(payload); fails(() => previewLegacyHistoryImport(f.db, f.ctx, payload, f.capability), 'LEGACY_HISTORY_ARCHIVE_INVALID'); }
  writeFileSync(path.join(f.archivePath, 'files', '00000001.json'), 'synthetic-tamper', { mode: 0o600 }); fails(() => commitLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability, p.previewHash), 'LEGACY_HISTORY_ARCHIVE_INVALID'); assert.deepEqual(f.state(), before);
});

test('full batch integrity is checked before slicing; cheap list verifies metadata without claiming child integrity', t => {
  const f = fixture(t, { count: 30, commit: true }), batch = readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId), last = readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId, { page: 2, pageSize: 25 }).records.at(-1);
  assert.equal(batch.records.length, 25); assert.equal(batch.total, 30);
  rewriteHead(f.db, last.id, data => { data.values[0][0] = '合成篡改'; });
  assert.equal(listLegacyHistoryBatches(f.db, f.ctx).items[0].rowCount, 30); fails(() => readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId, { page: 1, pageSize: 1 }), 'LEGACY_HISTORY_STATE_INVALID'); fails(() => readLegacyHistoryRow(f.db, f.ctx, batch.records[0].id), 'LEGACY_HISTORY_STATE_INVALID');
});

test('batch metadata checksum rejects mirrored month/category/header corruption on the bounded global list', t => {
  for (const mutate of [data => { data.reportingPeriods = ['2022-01']; }, data => { data.categories = ['form-record']; }, data => { data.layouts[0][0].label = '合成改欄名'; }]) {
    const f = fixture(t, { commit: true }), original = listLegacyHistoryBatches(f.db, f.ctx).items[0]; assert.equal(original.id, f.receipt.batchId);
    rewriteHead(f.db, f.receipt.batchId, mutate); const before = f.state(), changes = f.changes();
    fails(() => listLegacyHistoryBatches(f.db, f.ctx), 'LEGACY_HISTORY_STATE_INVALID'); fails(() => readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId), 'LEGACY_HISTORY_STATE_INVALID'); assert.deepEqual(f.state(), before); assert.equal(f.changes(), changes);
  }
});

test('corrupt header layout, batch categories/months/audit/head, and child audit cannot show success', t => {
  for (const mutation of [data => { data.layouts[0][0].label = '合成改欄'; }, data => { data.categories = ['form-record']; }, data => { data.reportingPeriods = ['2021-01']; }, data => { data.payrollApproved = true; }, data => { data.recordOrder.reverse(); }]) {
    const f = fixture(t, { commit: true }); rewriteHead(f.db, f.receipt.batchId, mutation); fails(() => readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId), 'LEGACY_HISTORY_STATE_INVALID');
  }
  const f = fixture(t, { commit: true }), row = readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId).records[0]; f.db.prepare("UPDATE audit SET detail='{}' WHERE record_id=?").run(row.id); fails(() => readLegacyHistoryRow(f.db, f.ctx, row.id), 'LEGACY_HISTORY_STATE_INVALID');
  f.db.exec('DROP TRIGGER IF EXISTS versions_no_update'); f.db.prepare("UPDATE record_versions SET source='synthetic-wrong' WHERE record_id=?").run(f.receipt.batchId); fails(() => listLegacyHistoryBatches(f.db, f.ctx), 'LEGACY_HISTORY_STATE_INVALID');
});

test('closed schemas reject unsafe scalar, excessive/nested/accessor data without executing getters', t => {
  const f = fixture(t), bad = [];
  for (const value of [Infinity, NaN, -0, Number.MAX_SAFE_INTEGER + 1, {}, [], '\ud800']) { const p = copy(f.payload); p.records[0].columns[0].raw = value; bad.push(p); }
  for (const change of [p => { p.payrollApproved = true; }, p => { p.records[0].status = 'reviewed'; }, p => { p.records[0].hourlyRateCents = 0; }, p => { p.records[0].locator.rowNumber = 1; }, p => { p.records[0].columns[1].columnIndex = 1; }, p => { p.records[0].sourceCreatedAt = 3; }, p => { p.records[0].locator = { kind: 'json-pointer', pointer: '/x~2' }; }, p => { p.records[0].columns = new Array(2); }]) { const p = copy(f.payload); change(p); bad.push(p); }
  let executed = 0; const getter = copy(f.payload); Object.defineProperty(getter.records[0].columns[0], 'raw', { enumerable: true, get() { executed++; return 'unsafe'; } }); bad.push(getter);
  for (const p of bad) fails(() => normalizeLegacyHistoryPayload(p), 'LEGACY_HISTORY_INVALID'); assert.equal(executed, 0);
  fails(() => legacyHistoryHash(Object.defineProperty({}, 'x', { enumerable: true, get() { executed++; return 'unsafe'; } })), 'LEGACY_HISTORY_INVALID'); assert.equal(executed, 0);
});

test('parser rejects duplicate escaped keys and invalid UTF8; bounded rows/columns/sources reject', t => {
  assert.throws(() => parseLegacyJson(Buffer.from('{"x":1,"\\u0078":2}'), 100)); assert.throws(() => parseLegacyJson(Buffer.from([0xff]), 100));
  const f = fixture(t), tooManyRows = copy(f.payload); tooManyRows.records = Array.from({ length: 1001 }, () => copy(f.payload.records[0])); fails(() => normalizeLegacyHistoryPayload(tooManyRows), 'LEGACY_HISTORY_INVALID');
  const columns = copy(f.payload); columns.records[0].columns = Array.from({ length: 501 }, (_, index) => ({ ...copy(f.payload.records[0].columns[0]), columnIndex: index + 1 })); fails(() => normalizeLegacyHistoryPayload(columns), 'LEGACY_HISTORY_INVALID');
  const unused = copy(f.payload); unused.sourceFiles.push({ fileId: 'file-00000002', sha256: 'a'.repeat(64) }); fails(() => normalizeLegacyHistoryPayload(unused), 'LEGACY_HISTORY_INVALID');
});

test('worksheet locator is a distinct original location; null native IDs do not become fake platform IDs', t => {
  const f = fixture(t), a = f.payload.sourceFiles[0].sha256;
  const first = legacyHistoryRowId(f.ctx.orgId, f.payload.provider, f.payload.tenant, a, { kind: 'worksheet-row', sheetIndex: 1, rowNumber: 2 }), other = legacyHistoryRowId(f.ctx.orgId, f.payload.provider, f.payload.tenant, a, { kind: 'worksheet-row', sheetIndex: 2, rowNumber: 2 }); assert.notEqual(first, other);
  for (const locator of [{ kind: 'worksheet-row', sheetIndex: 0, rowNumber: 1 }, { kind: 'worksheet-row', sheetIndex: 1, rowNumber: 0 }, { kind: 'worksheet-row', sheetIndex: 1, rowNumber: 1048577 }]) fails(() => legacyHistoryRowId(f.ctx.orgId, f.payload.provider, f.payload.tenant, a, locator), 'LEGACY_HISTORY_INVALID');
  const receipt = commit(f), row = readLegacyHistoryRow(f.db, f.ctx, readLegacyHistoryBatch(f.db, f.ctx, receipt.batchId).records[0].id).item; assert.equal(row.sourceNativeId, null); assert.equal(row.identityKind, 'archive-locator');
});

test('pagination validates safe end offsets, closed queries and parent integrity even on empty pages', t => {
  const f = fixture(t, { commit: true });
  for (const query of [{ page: 0, pageSize: 25 }, { page: 1, pageSize: 101 }, { page: 1, pageSize: 25, extra: true }, { page: Math.floor(Number.MAX_SAFE_INTEGER / 25) + 1, pageSize: 25 }, { page: '1', pageSize: 25 }]) { fails(() => listLegacyHistoryBatches(f.db, f.ctx, query), 'LEGACY_HISTORY_QUERY_INVALID'); fails(() => readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId, query), 'LEGACY_HISTORY_QUERY_INVALID'); }
  assert.deepEqual(readLegacyHistoryBatch(f.db, f.ctx, f.receipt.batchId, { page: 100, pageSize: 25 }).records, []);
});

test('reporting months reject year zero while original created-time text remains unmodified', t => {
  const f = fixture(t), invalid = copy(f.payload); invalid.records[0].reportingPeriod = '0000-01';
  fails(() => normalizeLegacyHistoryPayload(invalid), 'LEGACY_HISTORY_INVALID'); fails(() => previewLegacyHistoryImport(f.db, f.ctx, invalid, f.capability), 'LEGACY_HISTORY_INVALID');
  f.payload.records[0].sourceCreatedAt = '0000-01 / 來源原文'; const receipt = commit(f), row = readLegacyHistoryBatch(f.db, f.ctx, receipt.batchId).records[0]; assert.equal(row.sourceCreatedAt, '0000-01 / 來源原文');
  rewriteHead(f.db, receipt.batchId, data => { data.reportingPeriods = ['0000-01']; }); fails(() => listLegacyHistoryBatches(f.db, f.ctx), 'LEGACY_HISTORY_STATE_INVALID');
});

test('1000 by 58 synthetic capacity preserves full data with shared layouts, no real 90k capacity claim', t => {
  const f = fixture(t, { count: 1000, columnCount: 58 }), before = f.state(), preview = previewLegacyHistoryImport(f.db, f.ctx, f.payload, f.capability), receipt = commit(f), batch = readLegacyHistoryBatch(f.db, f.ctx, receipt.batchId, { page: 10, pageSize: 100 });
  assert.equal(batch.total, 1000); assert.equal(batch.records.length, 100); assert.deepEqual(readLegacyHistoryRow(f.db, f.ctx, batch.records.at(-1).id).item.columns, f.payload.records[999].columns);
  const data = JSON.parse(f.db.prepare('SELECT data FROM records WHERE id=?').get(receipt.batchId).data); assert.equal(data.layouts.length, 1);
  const storedBytes = f.db.prepare("SELECT SUM(length(CAST(data AS BLOB))) AS count FROM records WHERE entity IN ('legacy-history-batches','legacy-history-rows')").get().count;
  const expandedBytes = Buffer.byteLength(JSON.stringify(f.payload.records)); assert(storedBytes < expandedBytes * 0.65);
  const storedJsonBytes = f.db.prepare("SELECT SUM(length(CAST(data AS BLOB))) AS count FROM records WHERE entity IN ('legacy-history-batches','legacy-history-rows')").get().count + f.db.prepare("SELECT SUM(length(CAST(snapshot AS BLOB))) AS count FROM record_versions WHERE entity IN ('legacy-history-batches','legacy-history-rows')").get().count + f.db.prepare("SELECT SUM(length(CAST(detail AS BLOB))) AS count FROM audit WHERE entity IN ('legacy-history-batches','legacy-history-rows')").get().count;
  assert.deepEqual(preview.storageEstimate, { kind: 'stored-json-columns-only', bytes: storedJsonBytes, layoutCount: 1 });
  for (const table of ['organizations', 'users', 'memberships', 'sessions', 'portal_identity_bindings', 'portal_handoff_nonces', 'demo_seeds', 'attachment_files', 'certification_attachment_files']) assert.deepEqual(f.state()[table], before[table]);
});
