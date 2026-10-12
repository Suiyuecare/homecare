import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { insert, replace, business, now } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { commitAccountChange, readAccount } from '../src/server/account-administration.mjs';
import { createSyntheticLegacyHistoryFixture } from './helpers/legacy-history-fixture.mjs';
import { captureLegacyArchive } from '../src/server/legacy-migration-archive.mjs';
import { createVerifiedLegacyHistorySource, legacyHistorySourceHash, previewLegacyHistoryImport, commitLegacyHistoryImport } from '../src/server/legacy-history-import.mjs';

const BASE = '/api/legacy-history';
const BATCH = 'legacy-history-batches', ROW = 'legacy-history-rows';
const password = 'synthetic-history-http-password-only';
const sorted = object => Object.keys(object).sort();
const flagKeys = ['sourceSystemComplete', 'operationalConversionCompleted', 'approvalCompleted', 'payrollApproved'];
const metadataKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const batchKeys = [...metadataKeys, 'provider', 'tenant', 'sourceHash', 'payloadHash', 'archiveManifestSha256', 'archiveId', 'importedBy', 'importedAt', 'rowCount', 'categories', 'reportingPeriods', 'status', ...flagKeys].sort();
const rowKeys = [...metadataKeys, 'batchId', 'category', 'reportingPeriod', 'sourceNativeId', 'sourceCreatedAt', 'caseId', 'employeeId', 'sourceFileId', 'sourceFileSha256', 'locator', 'identityKind', 'caseReference', 'employeeReference'].sort();
const flagsFalse = object => { for (const key of flagKeys) assert.equal(object[key], false, key); };

async function fixture(t, { count = 4, columnCount = 8, references = false, nullableCreatedAt = false } = {}) {
  // Actual HTTP server, owned in-memory DB and owned synthetic JSON archive only.
  // Empty Portal storage lets the write proof cover all 13 application tables;
  // this creates no real binding, Portal session or authority.
  const app = createApp({ dbPath: ':memory:', port: 0 });
  initPortalStorage(app.db);
  const base = await app.listen();
  t.after(async () => { const closing = app.close(); app.server.closeAllConnections(); await closing; });
  const request = async (client, method, path, payload, headers = {}) => {
    const response = await fetch(base + path, { method, headers: {
      Origin: base, ...(client ? { Cookie: client.cookie, ...(client.org ? { 'X-Org-Id': client.org } : {}), 'X-CSRF-Token': client.csrf } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };
  const email = 'synthetic-history-http@example.invalid';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成歷史HTTP管理者', email, password, organizationName: '合成歷史HTTP甲' });
  assert.equal(setup.status, 201, setup.text);
  const org = setup.body.organizations[0].id, user = setup.body.user;
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], org, csrf: setup.body.csrfToken, user };
  const ctx = { orgId: org, role: 'admin', user }, secondOrg = randomUUID(), outsiderOrg = randomUUID(), otherAdminId = randomUUID();
  for (const id of [secondOrg, outsiderOrg]) app.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(id, '合成額外機構', now());
  app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(secondOrg, user.id, 'admin', null);
  app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(otherAdminId, '合成另一管理者', 'synthetic-history-other@example.invalid', 'synthetic-not-a-login-password', now());
  app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org, otherAdminId, 'admin', null);
  const employee = insert(app.db, org, 'employees', { name: '合成歷史離職員工', employeeNo: 'SYN-HISTORY-E', status: 'inactive', phone: 'SYNTHETIC-PRIVATE-PHONE' });
  const caregiverEmployee = insert(app.db, org, 'employees', { name: '合成居服帳號員工', employeeNo: 'SYN-CAREGIVER-E', status: 'active' });
  const currentCase = insert(app.db, org, 'cases', { name: '合成歷史結案個案', caseNo: 'SYN-HISTORY-C', status: 'closed', supervisorId: employee.id, note: 'SYNTHETIC-PRIVATE-CASE-NOTE' });
  const source = createSyntheticLegacyHistoryFixture(app.db, ctx, { count, columnCount, commit: !nullableCreatedAt, caseId: references ? currentCase.id : null, employeeId: references ? employee.id : null });
  t.after(() => source.cleanup());
  if (nullableCreatedAt) {
    // Capture a genuine second synthetic JSON original with the nullable value;
    // retain actual /rows/n locators rather than inventing a worksheet source.
    source.payload.records[0].sourceCreatedAt = null;
    const original = Buffer.from(JSON.stringify({ rows: source.payload.records })), outputParent = join(source.rootPath, 'nullable-archives');
    writeFileSync(join(source.incomingPath, 'synthetic.json'), original, { mode: 0o600 }); mkdirSync(outputParent, { mode: 0o700 });
    source.capture = captureLegacyArchive({ inputPath: source.incomingPath, outputParent, scope: {
      format: 'suiyue-legacy-export-scope-v1', provider: 'synthetic', tenant: 'synthetic-tenant', exportedAt: '2020-01-02T03:04:05.000Z',
      datasets: [{ id: 'synthetic-history', sourceFiles: ['synthetic.json'], sourceRowCount: count, reportedCoverage: 'partial', range: { kind: 'unknown' } }],
      missingDatasets: ['synthetic-attachments'], unresolved: ['synthetic-no-business-conversion'],
    } });
    source.archivePath = join(outputParent, source.capture.archiveId);
    source.capability = createVerifiedLegacyHistorySource({ archivePath: source.archivePath, expectedManifestSha256: source.capture.manifestSha256 });
    source.payload.archiveManifestSha256 = source.capture.manifestSha256;
    source.payload.sourceFiles = [{ fileId: 'file-00000001', sha256: createHash('sha256').update(original).digest('hex') }]; original.fill(0);
    source.payload.sourceHash = legacyHistorySourceHash({ provider: source.payload.provider, tenant: source.payload.tenant, sourceFiles: source.payload.sourceFiles, records: source.payload.records });
    writeFileSync(source.sourcePath, JSON.stringify(source.payload), { mode: 0o600 });
    const preview = previewLegacyHistoryImport(app.db, ctx, source.payload, source.capability);
    source.receipt = commitLegacyHistoryImport(app.db, ctx, source.payload, source.capability, preview.previewHash);
  }
  const batchId = source.receipt.batchId;
  const batch = await request(admin, 'GET', BASE + '/batches/' + batchId + '?pageSize=100');
  assert.equal(batch.status, 200, batch.text);
  const rows = batch.body.records, urls = [BASE, BASE + '/batches/' + batchId, BASE + '/rows/' + rows[0].id];
  const state = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()];
  }));
  assert.equal(Object.keys(state()).length, 13);
  const changes = () => app.db.prepare('SELECT total_changes() AS n').get().n;
  const readonly = async operation => {
    const before = state(), countBefore = changes(), result = await operation();
    assert.deepEqual(state(), before, 'HTTP read/refusal must preserve every table');
    assert.equal(changes(), countBefore, 'HTTP read/refusal must execute zero SQL writes');
    return result;
  };
  const login = async (selectedOrg = org) => {
    const result = await request(null, 'POST', '/api/login', { email, password }); assert.equal(result.status, 200, result.text);
    return { cookie: result.headers.get('set-cookie').split(';')[0], org: selectedOrg, csrf: result.body.csrfToken, user: result.body.user };
  };
  const change = payload => {
    const acting = { orgId: org, role: 'admin', user: { id: otherAdminId } }, version = readAccount(app.db, acting, user.id).item.version;
    app.db.exec('BEGIN IMMEDIATE');
    try { const result = commitAccountChange(app.db, acting, user.id, { version, role: 'admin', employeeId: null, status: 'active', reason: '合成歷史HTTP撤權', ...payload }); app.db.exec('COMMIT'); return result; }
    catch (error) { app.db.exec('ROLLBACK'); throw error; }
  };
  return { app, base, request, admin, ctx, org, secondOrg, outsiderOrg, source, batchId, rows, urls, readonly, login, change, employee, caregiverEmployee, currentCase };
}

function denial(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.body.error.code, code, result.text);
  assert.deepEqual(sorted(result.body), ['error']);
  for (const secret of ['合成原文', 'HYPERLINK', 'SYNTHETIC-PRIVATE', 'synthetic-history-http@example.invalid']) assert(!result.text.includes(secret));
}
function rewriteHead(db, id, mutate) {
  // Intentionally corrupted owned synthetic storage, never an app write path.
  const row = db.prepare('SELECT * FROM records WHERE id=?').get(id), data = JSON.parse(row.data); mutate(data);
  db.exec('DROP TRIGGER versions_no_update');
  try {
    db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data), id);
    db.prepare('UPDATE record_versions SET snapshot=? WHERE record_id=? AND version=?').run(JSON.stringify({ ...data, id, orgId: row.org_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }), id, row.version);
  } finally { db.exec("CREATE TRIGGER versions_no_update BEFORE UPDATE ON record_versions BEGIN SELECT RAISE(ABORT,'Version history is immutable'); END"); }
}

test('real history GET routes return closed scoped DTO and exact literal columns with no SQL writes', async t => {
  const f = await fixture(t, { count: 27, nullableCreatedAt: true });
  await f.readonly(async () => {
    const list = await f.request(f.admin, 'GET', BASE);
    assert.equal(list.status, 200, list.text); assert.deepEqual(sorted(list.body), ['orgId', 'items', 'total', 'page', 'pageSize', ...flagKeys].sort());
    assert.equal(list.headers.get('cache-control'), 'no-store'); assert.equal(list.body.orgId, f.org); assert.equal(list.body.total, 1); assert.equal(list.body.page, 1); assert.equal(list.body.pageSize, 25); flagsFalse(list.body);
    const meta = list.body.items[0]; assert.deepEqual(sorted(meta), batchKeys); assert.equal(meta.id, f.batchId); assert.equal(meta.rowCount, 27); flagsFalse(meta);
    assert.equal(meta.status, 'historical-original-records'); assert.deepEqual(meta.categories, ['employee-profile', 'service-export']); assert.deepEqual(meta.reportingPeriods, ['2020-01', '2020-02']);
    const first = await f.request(f.admin, 'GET', f.urls[1]), last = await f.request(f.admin, 'GET', f.urls[1] + '?page=2&pageSize=25');
    for (const page of [first, last]) { assert.equal(page.status, 200, page.text); assert.deepEqual(sorted(page.body), ['orgId', 'item', 'records', 'total', 'page', 'pageSize', ...flagKeys].sort()); assert.equal(page.body.total, 27); flagsFalse(page.body); assert.deepEqual(sorted(page.body.item), batchKeys); }
    assert.equal(first.body.records.length, 25); assert.equal(last.body.records.length, 2); assert.deepEqual(last.body.records.map(x => x.id), f.rows.slice(25).map(x => x.id));
    for (const row of first.body.records) { assert.deepEqual(sorted(row), rowKeys); assert.equal(row.columns, undefined); assert.equal(row.identityKind, 'archive-locator'); assert.equal(row.caseReference, null); assert.equal(row.employeeReference, null); }
    const detail = await f.request(f.admin, 'GET', f.urls[2]); assert.equal(detail.status, 200, detail.text);
    assert.deepEqual(sorted(detail.body), ['orgId', 'item', 'batch', ...flagKeys].sort()); assert.deepEqual(sorted(detail.body.item), [...rowKeys, 'columns'].sort()); flagsFalse(detail.body); flagsFalse(detail.body.batch);
    assert.deepEqual(detail.body.item.columns, f.source.payload.records[0].columns); assert.deepEqual(detail.body.item.locator, { kind: 'json-pointer', pointer: '/rows/0' });
    assert.equal(detail.body.item.sourceNativeId, null); assert.equal(detail.body.item.sourceCreatedAt, null); assert.equal(detail.body.item.columns[0].label, detail.body.item.columns[1].label);
    assert(detail.body.item.columns[0].raw.includes('\u0000之後')); assert.equal(detail.body.item.columns[0].formula, '=HYPERLINK("https://synthetic.example.test","僅留原文")');
    assert.equal(detail.body.item.columns[1].raw, ''); assert.equal(detail.body.item.columns[2].raw, null); assert.equal(detail.body.item.columns[3].raw, false); assert.equal(detail.body.item.columns[4].raw, 1.25);
    assert.equal(detail.body.item.columns[0].cached, null); assert.equal(detail.body.item.columns[1].cached, true); assert.equal(detail.body.item.columns[2].cached, 2.5); assert.equal(detail.body.item.columns[3].cached, ' 合成快取 ');
    const other = await f.request(f.admin, 'GET', BASE + '/rows/' + f.rows[1].id); assert.equal(other.body.item.sourceNativeId, f.source.payload.records[1].sourceNativeId); assert.equal(other.body.item.sourceCreatedAt, '原文109年2月3日');
    for (const out of [list, first, last, detail]) { assert(!out.text.includes(f.source.rootPath)); assert(!out.text.includes(f.source.archivePath)); assert(!out.text.includes('SYNTHETIC-PRIVATE')); }
  });
});

test('real HTTP enforces login, selected organization, same-org identity and wrong-entity privacy', async t => {
  const f = await fixture(t);
  await f.readonly(async () => {
    for (const path of f.urls) {
      denial(await f.request(null, 'GET', path), 401, 'AUTH_REQUIRED');
      denial(await f.request({ ...f.admin, org: null }, 'GET', path), 400, 'ORG_REQUIRED');
      denial(await f.request({ ...f.admin, org: f.outsiderOrg }, 'GET', path), 403, 'ORG_FORBIDDEN');
    }
    const other = { ...f.admin, org: f.secondOrg }, empty = await f.request(other, 'GET', BASE); assert.equal(empty.status, 200); assert.equal(empty.body.orgId, f.secondOrg); assert.equal(empty.body.total, 0); assert.deepEqual(empty.body.items, []); flagsFalse(empty.body);
    for (const path of f.urls.slice(1)) denial(await f.request(other, 'GET', path), 404, 'NOT_FOUND');
    for (const path of [BASE + '/batches/' + f.rows[0].id, BASE + '/rows/' + f.batchId, BASE + '/rows/' + f.currentCase.id, BASE + '/batches/' + randomUUID(), BASE + '/rows/' + randomUUID(), BASE + '/batches/not-an-id']) denial(await f.request(f.admin, 'GET', path), 404, 'NOT_FOUND');
  });
  const freshOther = await f.login(f.secondOrg);
  await f.readonly(async () => { for (const path of f.urls.slice(1)) denial(await f.request(freshOther, 'GET', path), 404, 'NOT_FOUND'); });
});

test('actual membership changes revoke old cookies and fresh nonadmin roles cannot claim admin HTTP access', async t => {
  const f = await fixture(t); let old = f.admin;
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const changed = f.change({ role, employeeId: role === 'caregiver' ? f.caregiverEmployee.id : null }); assert.equal(changed.item.role, role); assert(changed.sessionsRevoked >= 1);
    await f.readonly(async () => { for (const path of f.urls) denial(await f.request(old, 'GET', path), 401, 'AUTH_REQUIRED'); });
    const fresh = await f.login();
    await f.readonly(async () => { for (const path of f.urls) denial(await f.request(fresh, 'GET', path, undefined, { 'X-Role': 'admin' }), 403, 'ROLE_FORBIDDEN'); });
    old = fresh;
  }
});

test('true account suspension revokes the old session while other-org fresh login remains isolated', async t => {
  const f = await fixture(t), changed = f.change({ status: 'suspended' }); assert(changed.sessionsRevoked >= 1);
  await f.readonly(async () => { for (const path of f.urls) denial(await f.request(f.admin, 'GET', path), 401, 'AUTH_REQUIRED'); });
  const fresh = await f.login();
  await f.readonly(async () => {
    for (const path of f.urls) denial(await f.request(fresh, 'GET', path), 403, 'ACCOUNT_SUSPENDED');
    const other = await f.request({ ...fresh, org: f.secondOrg }, 'GET', BASE); assert.equal(other.status, 200); assert.equal(other.body.total, 0); flagsFalse(other.body);
  });
});

test('closed HTTP queries reject unknown, duplicate, noncanonical and unsafe page end arithmetic', async t => {
  const f = await fixture(t);
  await f.readonly(async () => {
    for (const route of f.urls.slice(0, 2)) {
      for (const query of ['page=1&page=2', 'pageSize=1&pageSize=2', 'page=0', 'page=-1', 'page=01', 'page=1.0', 'page=1e2', 'page=', 'page=%2B1', 'page=9007199254740992', 'pageSize=0', 'pageSize=101', 'pageSize=9007199254740992', 'unknown=1', 'category=service-export', 'reportingPeriod=2020-01', 'archivePath=private']) denial(await f.request(f.admin, 'GET', route + '?' + query), 422, 'INVALID_QUERY');
      for (const query of ['page=9007199254740991&pageSize=100', 'page=4503599627370496&pageSize=2']) denial(await f.request(f.admin, 'GET', route + '?' + query), 422, 'LEGACY_HISTORY_QUERY_INVALID');
    }
    for (const query of ['page=1', 'pageSize=25', 'page=1&page=1', 'path=private', 'commit=true', 'sourceFileId=file-00000001']) denial(await f.request(f.admin, 'GET', f.urls[2] + '?' + query), 422, 'INVALID_QUERY');
    const empty = await f.request(f.admin, 'GET', f.urls[1] + '?page=100&pageSize=100'); assert.equal(empty.status, 200); assert.deepEqual(empty.body.records, []); assert.equal(empty.body.total, 4); flagsFalse(empty.body);
  });
});

test('history HTTP never imports, reviews, approves, reads arbitrary files or mutates even with a payload', async t => {
  const f = await fixture(t), sentinelPath = join(f.source.rootPath, 'synthetic-private-sentinel.txt'), sentinel = 'SYNTHETIC-PRIVATE-HTTP-SENTINEL'; writeFileSync(sentinelPath, sentinel, { mode: 0o600 });
  await f.readonly(async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const route of [...f.urls, BASE + '/import', BASE + '/commit', BASE + '/review']) {
      const out = await f.request(f.admin, method, route, { archivePath: sentinelPath, sourcePath: sentinelPath, payload: f.source.payload, previewHash: 'a'.repeat(64), payrollApproved: true }); denial(out, 405, 'METHOD_NOT_ALLOWED'); assert(!out.text.includes(sentinelPath));
    }
    for (const route of [BASE + '/import', BASE + '/commit', BASE + '/files/file-00000001', BASE + '/rows/' + f.rows[0].id + '/approve', BASE + '/path/' + encodeURIComponent(sentinelPath)]) denial(await f.request(f.admin, 'GET', route), 404, 'NOT_FOUND');
    for (const route of f.urls) denial(await f.request(f.admin, 'GET', route + '?archivePath=' + encodeURIComponent(sentinelPath)), 422, 'INVALID_QUERY');
  });
  assert.equal(readFileSync(sentinelPath, 'utf8'), sentinel);
});

test('fresh closed-case/inactive-employee references expose only five fields without changing archived original columns', async t => {
  const f = await fixture(t, { references: true });
  const first = await f.readonly(() => f.request(f.admin, 'GET', f.urls[2])); assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.item.caseReference, { id: f.currentCase.id, name: f.currentCase.name, caseNo: f.currentCase.caseNo, version: 1, status: 'closed' });
  assert.deepEqual(first.body.item.employeeReference, { id: f.employee.id, name: f.employee.name, employeeNo: f.employee.employeeNo, version: 1, status: 'inactive' });
  const changedEmployee = replace(f.app.db, f.org, 'employees', f.employee, { ...business(f.employee), name: '合成後續員工姓名', phone: 'SYNTHETIC-PRIVATE-NEW-PHONE' });
  const changedCase = replace(f.app.db, f.org, 'cases', f.currentCase, { ...business(f.currentCase), name: '合成後續個案姓名' });
  await f.readonly(async () => {
    for (const path of [f.urls[1], f.urls[2]]) {
      const out = await f.request(f.admin, 'GET', path); assert.equal(out.status, 200, out.text); const row = out.body.item.columns ? out.body.item : out.body.records[0];
      assert.deepEqual(sorted(row.caseReference), ['id', 'name', 'caseNo', 'version', 'status'].sort()); assert.deepEqual(sorted(row.employeeReference), ['id', 'name', 'employeeNo', 'version', 'status'].sort());
      assert.equal(row.employeeReference.name, changedEmployee.name); assert.equal(row.employeeReference.version, 2); assert.equal(row.caseReference.name, changedCase.name); assert.equal(row.caseReference.version, 2); assert(!out.text.includes('SYNTHETIC-PRIVATE'));
    }
    const detail = await f.request(f.admin, 'GET', f.urls[2]); assert.deepEqual(detail.body.item.columns, first.body.item.columns); assert.deepEqual(detail.body.batch, first.body.batch); flagsFalse(detail.body);
  });
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(changedEmployee), name: '合成損壞目前版本' }), changedEmployee.id);
  await f.readonly(async () => { for (const route of [f.urls[1], f.urls[1] + '?page=100&pageSize=100', f.urls[2]]) denial(await f.request(f.admin, 'GET', route), 409, 'LEGACY_HISTORY_STATE_INVALID'); });
});

test('offpage original-row corruption refuses full batch and detail but metadata list does not claim child integrity', async t => {
  const f = await fixture(t, { count: 27 }); rewriteHead(f.app.db, f.rows[26].id, data => { data.values[0][0] = '合成篡改原始內容'; });
  await f.readonly(async () => {
    const list = await f.request(f.admin, 'GET', BASE); assert.equal(list.status, 200, list.text); assert.equal(list.body.items[0].rowCount, 27); flagsFalse(list.body); flagsFalse(list.body.items[0]);
    for (const path of [f.urls[1] + '?page=1&pageSize=1', f.urls[1] + '?page=100&pageSize=100', f.urls[2]]) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_HISTORY_STATE_INVALID');
  });
});

test('foreign, missing and wrong-entity current parent references refuse scoped history reads', async t => {
  for (const kind of ['foreign', 'missing', 'wrong-entity']) {
    const f = await fixture(t, { references: true }), foreign = insert(f.app.db, f.secondOrg, 'employees', { name: '合成外機構員工', employeeNo: 'SYN-FOREIGN-E', status: 'inactive' });
    const id = kind === 'foreign' ? foreign.id : kind === 'missing' ? randomUUID() : f.currentCase.id;
    rewriteHead(f.app.db, f.currentCase.id, data => { data.supervisorId = id; });
    await f.readonly(async () => { for (const path of [f.urls[1], f.urls[1] + '?page=100&pageSize=100', f.urls[2]]) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_HISTORY_STATE_INVALID'); });
  }
});

test('corrupt batch flags, bounded layout/order and head/audit metadata cannot produce a trusted HTTP DTO', async t => {
  for (const mutate of [data => { data.payrollApproved = true; }, data => { data.recordOrder = Array.from({ length: 1001 }, () => data.recordOrder[0]); }, data => { data.layouts[0] = Array.from({ length: 501 }, (_, i) => ({ columnIndex: i + 1, label: '合成過量欄位' })); }, data => { data.categories = ['service-export', 'employee-profile']; }, data => { data.reportingPeriods = ['2021-01']; }]) {
    const f = await fixture(t); rewriteHead(f.app.db, f.batchId, mutate);
    await f.readonly(async () => { for (const path of f.urls) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_HISTORY_STATE_INVALID'); });
  }
  const f = await fixture(t); f.app.db.prepare("UPDATE audit SET detail='{}' WHERE entity=? AND record_id=?").run(BATCH, f.batchId);
  await f.readonly(async () => { for (const path of f.urls) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_HISTORY_STATE_INVALID'); });
});

test('nested and nonfinite raw JSON scalar corruption is refused with no partial columns or writes', async t => {
  for (const invalid of [{ nested: true }, ['nested'], Number.MAX_SAFE_INTEGER + 1]) {
    const f = await fixture(t); rewriteHead(f.app.db, f.rows[0].id, data => { data.values[0][0] = invalid; });
    await f.readonly(async () => { for (const path of [f.urls[1], f.urls[2]]) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_HISTORY_STATE_INVALID'); });
  }
  const f = await fixture(t), id = f.rows[0].id;
  // Literal JSON 1e999 keeps the nonfinite witness intact; JSON.stringify(Infinity)
  // would turn it into null and would not test the intended rejection.
  const stored = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(id).data); stored.values[0][0] = 'SYNTHETIC-NONFINITE-SCALAR';
  const damaged = JSON.stringify(stored).replace('"SYNTHETIC-NONFINITE-SCALAR"', '1e999'); assert(damaged.includes('1e999'));
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(damaged, id);
  await f.readonly(async () => { for (const path of [f.urls[1], f.urls[2]]) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_HISTORY_STATE_INVALID'); });
});

test('1000 original rows and 500 complete columns have real HTTP boundary coverage without a production capacity claim', async t => {
  const large = await fixture(t, { count: 1000, columnCount: 2 });
  await large.readonly(async () => {
    const last = await large.request(large.admin, 'GET', large.urls[1] + '?page=10&pageSize=100'); assert.equal(last.status, 200, last.text); assert.equal(last.body.total, 1000); assert.equal(last.body.records.length, 100); assert.equal(last.body.item.rowCount, 1000); flagsFalse(last.body);
    const detail = await large.request(large.admin, 'GET', BASE + '/rows/' + last.body.records.at(-1).id); assert.equal(detail.status, 200, detail.text); assert.deepEqual(detail.body.item.columns, large.source.payload.records[999].columns); assert.deepEqual(detail.body.item.locator, { kind: 'json-pointer', pointer: '/rows/999' });
  });
  const wide = await fixture(t, { count: 1, columnCount: 500 });
  await wide.readonly(async () => { const detail = await wide.request(wide.admin, 'GET', wide.urls[2]); assert.equal(detail.status, 200, detail.text); assert.equal(detail.body.item.columns.length, 500); assert.deepEqual(detail.body.item.columns, wide.source.payload.records[0].columns); });
  rewriteHead(wide.app.db, wide.rows[0].id, data => { data.values.push([null, null, null]); });
  await wide.readonly(async () => { for (const path of [wide.urls[1], wide.urls[2]]) denial(await wide.request(wide.admin, 'GET', path), 409, 'LEGACY_HISTORY_STATE_INVALID'); });
});
