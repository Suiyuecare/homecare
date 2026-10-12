import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { insert, replace, business, now } from '../src/server/model.mjs';
import { commitAccountChange, readAccount } from '../src/server/account-administration.mjs';
import { createSyntheticLegacyMigrationFixture } from './helpers/legacy-migration-fixture.mjs';

const BASE = '/api/legacy-migrations';
const SOURCE_ENTITY = 'legacy-operational-source';
const password = 'synthetic-http-migration-password-only';
const sorted = object => Object.keys(object).sort();
const batchKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'provider', 'tenant', 'sourceHash', 'payloadHash', 'archiveManifestSha256', 'archiveId', 'importedBy', 'importedAt', 'importedCount', 'caseCount', 'employeeCount', 'status', 'sourceSystemComplete', 'operationalImportCompleted'].sort();
const mappingKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'batchId', 'entity', 'sourceId', 'targetId', 'name', 'businessNo', 'businessNoOrigin', 'sourceCreatedAt', 'sourceFileId', 'rowNumber'].sort();

async function fixture(t, { count = 4 } = {}) {
  // Actual application HTTP on an owned in-memory store; no real database,
  // original platform session, Portal binding, import path or key is consumed.
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(async () => { const closing = app.close(); app.server.closeAllConnections(); await closing; });
  const request = async (client, method, path, payload) => {
    const response = await fetch(base + path, { method, headers: {
      Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };
  const email = 'synthetic-http-migration@example.invalid';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成HTTP移轉管理者', email, password, organizationName: '合成HTTP移轉甲' });
  assert.equal(setup.status, 201, setup.text);
  const org = setup.body.organizations[0].id, user = setup.body.user;
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], org, csrf: setup.body.csrfToken, user };
  const ctx = { orgId: org, role: 'admin', user };
  const secondOrg = randomUUID(), outsiderOrg = randomUUID(), otherAdminId = randomUUID();
  for (const id of [secondOrg, outsiderOrg]) app.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(id, '合成額外機構', now());
  app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(secondOrg, user.id, 'admin', null);
  app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(otherAdminId, '合成第二管理者', 'synthetic-http-second@example.invalid', 'synthetic-not-a-login-password', now());
  app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org, otherAdminId, 'admin', null);
  const source = createSyntheticLegacyMigrationFixture(app.db, ctx, { count, commit: true });
  t.after(() => source.cleanup());
  const batchId = source.receipt.batchId;
  const batch = await request(admin, 'GET', BASE + '/batches/' + batchId + '?pageSize=100');
  assert.equal(batch.status, 200, batch.text);
  const login = async (selectedOrg = org) => {
    const output = await request(null, 'POST', '/api/login', { email, password });
    assert.equal(output.status, 200, output.text);
    return { cookie: output.headers.get('set-cookie').split(';')[0], org: selectedOrg, csrf: output.body.csrfToken, user: output.body.user };
  };
  const state = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()];
  }));
  const changes = () => app.db.prepare('SELECT total_changes() AS n').get().n;
  const readonly = async operation => {
    const before = state(), countBefore = changes(), result = await operation();
    assert.deepEqual(state(), before); assert.equal(changes(), countBefore); return result;
  };
  const urls = [BASE, BASE + '/batches/' + batchId, BASE + '/records/' + batch.body.records[0].id];
  const change = payload => {
    const acting = { orgId: org, role: 'admin', user: { id: otherAdminId } };
    const version = readAccount(app.db, acting, user.id).item.version;
    app.db.exec('BEGIN IMMEDIATE');
    try { const result = commitAccountChange(app.db, acting, user.id, { version, role: 'admin', employeeId: null, status: 'active', reason: '合成HTTP權限變更', ...payload }); app.db.exec('COMMIT'); return result; }
    catch (error) { app.db.exec('ROLLBACK'); throw error; }
  };
  return { app, base, request, admin, ctx, org, secondOrg, outsiderOrg, source, batchId, mappings: batch.body.records, login, state, changes, readonly, urls, change };
}
function denial(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.body.error.code, code, result.text);
  assert.equal(result.body.items, undefined); assert.equal(result.body.records, undefined); assert.equal(result.body.currentTarget, undefined);
  assert(!result.text.includes('合成個案')); assert(!result.text.includes('首行')); assert(!result.text.includes('HYPERLINK'));
}

test('three real GET routes return exact scoped DTO, pagination and literal source bytes with zero SQL writes', async t => {
  const f = await fixture(t, { count: 27 });
  await f.readonly(async () => {
    const list = await f.request(f.admin, 'GET', BASE);
    assert.equal(list.status, 200, list.text); assert.deepEqual(sorted(list.body), ['orgId', 'items', 'total', 'page', 'pageSize', 'sourceSystemComplete'].sort());
    assert.equal(list.headers.get('cache-control'), 'no-store'); assert.equal(list.body.orgId, f.org); assert.equal(list.body.total, 1); assert.equal(list.body.page, 1); assert.equal(list.body.pageSize, 25); assert.equal(list.body.sourceSystemComplete, false);
    assert.deepEqual(sorted(list.body.items[0]), batchKeys); assert.equal(list.body.items[0].id, f.batchId); assert.equal(list.body.items[0].importedCount, 27); assert.equal(list.body.items[0].caseCount, 13); assert.equal(list.body.items[0].employeeCount, 14);
    assert.equal(list.body.items[0].operationalImportCompleted, true); assert.equal(list.body.items[0].status, 'operational-first-slice');
    const page = await f.request(f.admin, 'GET', BASE + '/batches/' + f.batchId + '?page=2&pageSize=25');
    assert.equal(page.status, 200, page.text); assert.deepEqual(sorted(page.body), ['orgId', 'item', 'records', 'total', 'page', 'pageSize', 'sourceSystemComplete'].sort());
    assert.equal(page.body.total, 27); assert.equal(page.body.records.length, 2); assert.deepEqual(page.body.records.map(x => x.id), f.mappings.slice(25).map(x => x.id));
    assert.deepEqual(sorted(page.body.item), batchKeys);
    for (const mapping of page.body.records) { assert.deepEqual(sorted(mapping), mappingKeys); assert.equal(mapping.batchId, f.batchId); assert.equal(mapping.orgId, f.org); assert.equal(mapping.columns, undefined); }
    const mapping = f.mappings[0], detail = await f.request(f.admin, 'GET', BASE + '/records/' + mapping.id);
    assert.equal(detail.status, 200, detail.text); assert.deepEqual(sorted(detail.body), ['orgId', 'item', 'batch', 'currentTarget', 'sourceSystemComplete'].sort());
    assert.deepEqual(sorted(detail.body.item), [...mappingKeys, 'data', 'columns'].sort()); assert.equal(detail.body.item.id, mapping.id); assert.equal(detail.body.item.batchId, f.batchId); assert.equal(detail.body.currentTarget.id, mapping.targetId); assert.equal(detail.body.currentTarget.orgId, f.org);
    assert.deepEqual(detail.body.item.data, f.source.payload.records[0].data); assert.deepEqual(detail.body.item.columns, f.source.payload.records[0].columns);
    assert.equal(detail.body.item.sourceCreatedAt, ''); assert.equal(detail.body.item.columns[0].label, detail.body.item.columns[1].label); assert(detail.body.item.columns[0].raw.includes('\u0000之後'));
    assert.equal(detail.body.item.columns[0].formula, '=HYPERLINK("https://synthetic.example.test","合成公式")'); assert.equal(detail.body.item.columns[1].raw, ''); assert.equal(detail.body.item.columns[1].cached, false);
    const caseDetail = await f.request(f.admin, 'GET', BASE + '/records/' + f.mappings[1].id);
    assert.equal(caseDetail.body.item.sourceCreatedAt, '民國109年1月2日原文'); assert.equal(caseDetail.body.item.columns[1].raw, null);
    assert.equal(detail.body.sourceSystemComplete, false); assert(!detail.text.includes(f.source.archivePath)); assert(!detail.text.includes(f.source.sourcePath)); assert(!detail.text.includes('synthetic-http-migration@example.invalid'));
  });
});

test('same user separate organization is scoped; outsiders, wrong entity IDs and unknown identities disclose no migration data', async t => {
  const f = await fixture(t);
  await f.readonly(async () => {
    denial(await f.request(null, 'GET', BASE), 401, 'AUTH_REQUIRED');
    const other = { ...f.admin, org: f.secondOrg }, empty = await f.request(other, 'GET', BASE);
    assert.equal(empty.status, 200); assert.equal(empty.body.orgId, f.secondOrg); assert.equal(empty.body.total, 0); assert.deepEqual(empty.body.items, []);
    for (const path of f.urls.slice(1)) denial(await f.request(other, 'GET', path), 404, 'NOT_FOUND');
    for (const path of f.urls) denial(await f.request({ ...f.admin, org: f.outsiderOrg }, 'GET', path), 403, 'ORG_FORBIDDEN');
    for (const path of [BASE + '/batches/' + f.mappings[0].id, BASE + '/records/' + f.batchId, BASE + '/batches/' + randomUUID(), BASE + '/records/' + randomUUID(), BASE + '/batches/not-an-id']) denial(await f.request(f.admin, 'GET', path), 404, 'NOT_FOUND');
  });
});

test('actual lifecycle transitions to finance, supervisor and caregiver reject fresh HTTP requests rather than trusting old client role', async t => {
  const f = await fixture(t), employeeId = f.mappings.find(x => x.entity === 'employees').targetId;
  let old = f.admin;
  for (const role of ['finance', 'supervisor', 'caregiver']) {
    const changed = f.change({ role, employeeId: role === 'caregiver' ? employeeId : null }); assert.equal(changed.item.role, role); assert(changed.sessionsRevoked >= 1);
    await f.readonly(async () => { for (const path of f.urls) denial(await f.request(old, 'GET', path), 401, 'AUTH_REQUIRED'); });
    const fresh = await f.login();
    await f.readonly(async () => { for (const path of f.urls) denial(await f.request({ ...fresh, role: 'admin' }, 'GET', path), 403, 'ROLE_FORBIDDEN'); });
    old = fresh;
  }
});

test('true suspension revokes old cookie and fresh other-org login cannot read the selected suspended organization', async t => {
  const f = await fixture(t), changed = f.change({ status: 'suspended' }); assert.equal(changed.item.status, 'suspended'); assert(changed.sessionsRevoked >= 1);
  await f.readonly(async () => { for (const path of f.urls) denial(await f.request(f.admin, 'GET', path), 401, 'AUTH_REQUIRED'); });
  const fresh = await f.login();
  await f.readonly(async () => {
    for (const path of f.urls) denial(await f.request(fresh, 'GET', path), 403, 'ACCOUNT_SUSPENDED');
    const other = await f.request({ ...fresh, org: f.secondOrg }, 'GET', BASE); assert.equal(other.status, 200); assert.equal(other.body.total, 0);
  });
});

test('closed HTTP queries reject duplicate, noncanonical, huge and unsafe start/end page arithmetic without writes', async t => {
  const f = await fixture(t);
  await f.readonly(async () => {
    for (const route of [BASE, BASE + '/batches/' + f.batchId]) {
      for (const query of ['page=1&page=2', 'pageSize=1&pageSize=2', 'page=0', 'page=-1', 'page=01', 'page=1.0', 'page=1e2', 'page=', 'page=%2B1', 'page=9007199254740992', 'pageSize=0', 'pageSize=101', 'pageSize=9007199254740992', 'unknown=1', 'archivePath=arbitrary-private-file']) denial(await f.request(f.admin, 'GET', route + '?' + query), 422, 'INVALID_QUERY');
      for (const query of ['page=9007199254740991&pageSize=100', 'page=4503599627370496&pageSize=2']) denial(await f.request(f.admin, 'GET', route + '?' + query), 422, 'LEGACY_IMPORT_QUERY_INVALID');
    }
    for (const query of ['page=1', 'pageSize=25', 'page=1&page=1', 'path=arbitrary-private-file', 'fileId=file-00000001', 'commit=true']) denial(await f.request(f.admin, 'GET', f.urls[2] + '?' + query), 422, 'INVALID_QUERY');
  });
});

test('HTTP never imports, commits, opens arbitrary filesystem paths or changes sources through any mutation route', async t => {
  const f = await fixture(t), path = join(f.source.rootPath, 'synthetic-private-sentinel.txt'), sentinel = 'SYNTHETIC-PRIVATE-SENTINEL-NEVER-HTTP'; writeFileSync(path, sentinel, { mode: 0o600 });
  await f.readonly(async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const route of [...f.urls, BASE + '/commit', BASE + '/import', BASE + '/preview']) {
      const out = await f.request(f.admin, method, route, { archivePath: path, path, capability: { manifestSha256: f.source.capture.manifestSha256 }, payload: f.source.payload, previewHash: 'a'.repeat(64) });
      denial(out, 405, 'METHOD_NOT_ALLOWED'); assert(!out.text.includes(path)); assert(!out.text.includes(sentinel));
    }
    for (const route of [BASE + '/commit', BASE + '/import', BASE + '/files/file-00000001', BASE + '/path/' + encodeURIComponent(path)]) denial(await f.request(f.admin, 'GET', route), 404, 'NOT_FOUND');
    for (const route of f.urls) { const out = await f.request(f.admin, 'GET', route + '?archivePath=' + encodeURIComponent(path)); denial(out, 422, 'INVALID_QUERY'); assert(!out.text.includes(path)); }
  });
  assert.equal(readFileSync(path, 'utf8'), sentinel);
});

test('legal current target version changes remain separate from immutable original imported provenance', async t => {
  const f = await fixture(t), mapping = f.mappings.find(x => x.entity === 'cases'), first = await f.request(f.admin, 'GET', BASE + '/records/' + mapping.id);
  const saved = replace(f.app.db, f.org, 'cases', first.body.currentTarget, { ...business(first.body.currentTarget), note: '合成後續業務修改' }); assert.equal(saved.version, 2);
  await f.readonly(async () => {
    const current = await f.request(f.admin, 'GET', BASE + '/records/' + mapping.id); assert.equal(current.status, 200, current.text);
    assert.deepEqual(current.body.item, first.body.item); assert.deepEqual(current.body.batch, first.body.batch); assert.equal(current.body.currentTarget.version, 2); assert.equal(current.body.currentTarget.note, '合成後續業務修改');
    assert.equal(current.body.item.data.note, ' 原始操作備註\r\n留存 '); assert.equal(current.body.sourceSystemComplete, false);
  });
});

test('corruption outside requested page refuses the whole batch/list/source instead of returning partial trusted DTO', async t => {
  const f = await fixture(t, { count: 27 }), hidden = f.mappings[26];
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run('{"name":"synthetic-corruption-no-head"}', hidden.targetId);
  await f.readonly(async () => {
    for (const path of [BASE + '?page=1&pageSize=1', BASE + '/batches/' + f.batchId + '?page=1&pageSize=1', f.urls[2]]) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_IMPORT_STATE_INVALID');
  });
});

function addCorruptMapping(f, parentId) {
  const original = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(f.mappings[0].id), data = { ...JSON.parse(original.data), batchId: parentId }, id = randomUUID();
  const item = { ...data, id, orgId: f.org, version: 1, createdAt: original.created_at, updatedAt: original.updated_at };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id, f.org, SOURCE_ENTITY, JSON.stringify(data), 1, original.created_at, original.updated_at);
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.org, SOURCE_ENTITY, id, 1, JSON.stringify(item), original.updated_at, 'legacy.import.source');
  return id;
}
test('orphan and wrong-parent source records with internally matching heads cannot disclose or silently join a batch', async t => {
  const f = await fixture(t), orphan = addCorruptMapping(f, randomUUID());
  await f.readonly(async () => { denial(await f.request(f.admin, 'GET', BASE + '/records/' + orphan), 409, 'LEGACY_IMPORT_STATE_INVALID'); });
  const unlisted = addCorruptMapping(f, f.batchId);
  await f.readonly(async () => { for (const path of [BASE, f.urls[1], BASE + '/records/' + unlisted]) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_IMPORT_STATE_INVALID'); });
});

test('current case supervisor references require exact same-org employee and full head while inactive staff remains valid provenance', async t => {
  const f = await fixture(t), mapping = f.mappings.find(x => x.entity === 'cases'), first = await f.request(f.admin, 'GET', BASE + '/records/' + mapping.id);
  const foreign = insert(f.app.db, f.secondOrg, 'employees', { name: '合成外機構員工', employeeNo: 'SYN-FOREIGN-SUPERVISOR', status: 'active' });
  let target = replace(f.app.db, f.org, 'cases', first.body.currentTarget, { ...business(first.body.currentTarget), supervisorId: foreign.id });
  await f.readonly(async () => { for (const path of f.urls) denial(await f.request(f.admin, 'GET', path), 409, 'LEGACY_IMPORT_STATE_INVALID'); });
  target = replace(f.app.db, f.org, 'cases', target, { ...business(target), supervisorId: randomUUID() });
  await f.readonly(async () => { denial(await f.request(f.admin, 'GET', BASE + '/records/' + mapping.id), 409, 'LEGACY_IMPORT_STATE_INVALID'); });
  const inactive = insert(f.app.db, f.org, 'employees', { name: '合成已離職歷史督導', employeeNo: 'SYN-INACTIVE-SUPERVISOR', status: 'inactive' });
  target = replace(f.app.db, f.org, 'cases', target, { ...business(target), supervisorId: inactive.id });
  await f.readonly(async () => { const out = await f.request(f.admin, 'GET', BASE + '/records/' + mapping.id); assert.equal(out.status, 200, out.text); assert.equal(out.body.currentTarget.supervisorId, inactive.id); assert.deepEqual(out.body.item, first.body.item); });
  // This extra parent is not one of the mapped batch targets: its damaged head
  // must still be checked by the current case's same-org reference guard.
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(inactive), name: '合成父版本不一致' }), inactive.id);
  await f.readonly(async () => { denial(await f.request(f.admin, 'GET', BASE + '/records/' + mapping.id), 409, 'LEGACY_IMPORT_STATE_INVALID'); });
});
