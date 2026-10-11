import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';

const entity = 'case-contact-footprints', route = (item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, payload, extra = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const password = 'synthetic-contact-footprints-password', setup = await request(null, 'POST', '/api/setup', { name: '合成人工足跡管理員', email: 'footprints-admin@example.test', password, organizationName: '合成人工足跡甲' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], org: setup.body.organizations[0].id, csrf: setup.body.csrfToken, user: setup.body.user }, clients = { admin };
  const create = async (type, payload, client = admin, headers = {}) => { const response = await request(client, 'POST', '/api/' + type, payload, headers); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item; };
  const employee = await create('employees', { name: '合成足跡居服', employeeNo: 'FOOTPRINT-E1' });
  for (const role of ['supervisor', 'finance', 'caregiver']) { const email = 'footprints-' + role + '@example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) }); const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], org: admin.org, csrf: login.body.csrfToken, user: login.body.user }; }
  const caseA = await create('cases', { name: '合成足跡原案', caseNo: 'FOOTPRINT-A' }), caseB = await create('cases', { name: '合成足跡相關案', caseNo: 'FOOTPRINT-B', status: 'closed' }), caseC = await create('cases', { name: '合成足跡無關案', caseNo: 'FOOTPRINT-C' });
  const orgB = await create('organizations', { name: '合成人工足跡乙' }), foreign = { ...admin, org: orgB.id }, foreignCase = await create('cases', { name: '合成跨機構足跡案', caseNo: 'FOOTPRINT-FOREIGN' }, foreign);
  const payload = (fields = {}) => ({ caseId: caseA.id, date: '2026-10-10', location: ' 人工保存場所 ', contactDescription: ' 人工回報第一行\r\n最後一行 ', time: '', relatedCaseId: caseB.id, source: ' 保存來源\r\n來源末行 ', note: ' 完整備註\r\n末行 ', ...fields });
  const patch = async (item, fields, client = admin) => { const response = await request(client, 'PATCH', route(item), { version: item.version, ...fields }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item; };
  const raw = table => { const statement = app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid'); statement.setReadBigInts(true); return statement.all(); };
  const state = () => Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency', 'attachment_files'].map(table => [table, raw(table)]));
  const unrelated = () => { const saved = state(); saved.records = saved.records.filter(row => row.entity !== entity); saved.record_versions = saved.record_versions.filter(row => row.entity !== entity); return { records: saved.records, versions: saved.record_versions, files: saved.attachment_files }; };
  return { app, request, create, patch, payload, state, unrelated, clients, admin, caseA, caseB, caseC, foreign, foreignCase };
}

test('real HTTP ordinary manual CRUD preserves unknown time and original CRLF text through edit/status/history, recording the actual actor', async t => {
  const f = await fixture(t), unchanged = f.unrelated(); let item = await f.create(entity, f.payload({ caseId: f.caseB.id, relatedCaseId: f.caseA.id }), f.clients.supervisor);
  assert.equal(item.time, ''); assert.equal(item.status, 'active'); assert.equal(item.version, 1); assert.equal(item.contactDescription, f.payload().contactDescription); assert.equal(item.source, f.payload().source);
  item = await f.patch(item, { location: ' 本次僅改人工場所 ' }, f.clients.supervisor); item = await f.patch(item, { status: 'inactive' }, f.clients.supervisor); item = await f.patch(item, { status: 'active' }, f.clients.supervisor);
  assert.equal(item.version, 4); assert.equal(item.contactDescription, f.payload().contactDescription); assert.equal(item.note, f.payload().note);
  const saved = await f.request(f.admin, 'GET', route(item)); assert.deepEqual(saved.body.item, item);
  const history = await f.request(f.admin, 'GET', route(item, '/history?compare=previous&pageSize=25')); assert.equal(history.status, 200, JSON.stringify(history.body)); assert.deepEqual(history.body.items.map(row => row.version), [4, 3, 2, 1]); assert.equal(history.body.items[0].actor.id, f.clients.supervisor.user.id); assert.equal(history.body.items[0].comparison.previousSnapshot.status, 'inactive'); assert.equal(history.body.items[3].snapshot.location, f.payload().location);
  assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404); assert.throws(() => f.app.db.prepare('UPDATE record_versions SET snapshot=? WHERE record_id=?').run('{}', item.id), /immutable/); assert.deepEqual(f.unrelated(), unchanged);
});

test('real HTTP role denial precedes payload and query validation without exposing records, snapshots or cross-org references', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), other = await f.create(entity, f.payload({ caseId: f.foreignCase.id, relatedCaseId: '' }), f.foreign), before = f.state();
  for (const role of ['finance', 'caregiver']) {
    for (const path of [route(), route() + '?unknown=1&page=1e0', route(item), route(item, '/history?compare=unknown')]) assert.equal((await f.request(f.clients[role], 'GET', path)).status, 403);
    assert.equal((await f.request(f.clients[role], 'POST', route(), [])).status, 403); assert.equal((await f.request(f.clients[role], 'PATCH', route(item), { version: 'bad', arbitrary: true })).status, 403);
  }
  for (const client of [f.admin, f.clients.supervisor]) {
    assert.equal((await f.request(client, 'GET', route(other))).status, 404); assert.equal((await f.request(client, 'GET', route(other, '/history'))).status, 404); assert.equal((await f.request(client, 'PATCH', route(other), { version: 1, note: 'foreign' })).status, 404);
    assert.equal((await f.request(client, 'PATCH', route(item), { version: item.version, caseId: f.caseB.id })).status, 409);
    for (const fields of [{ caseId: f.foreignCase.id }, { relatedCaseId: f.foreignCase.id }]) assert.equal((await f.request(client, 'POST', route(), f.payload(fields))).status, 422);
  }
  assert.deepEqual(f.state(), before);
});

test('invalid payloads, literal dates/time and unknown clinical/GPS fields fail with exact zero writes', async t => {
  const f = await fixture(t), before = f.state();
  const bad = [{ caseId: ' ' + f.caseA.id }, { caseId: '' }, { caseId: id() }, { relatedCaseId: ' ' }, { relatedCaseId: id() }, { date: '0000-01-01' }, { date: '2026-02-30' }, { date: '2026-10-10\n' }, { time: '24:00' }, { time: '09:00\n' }, { time: '09:00\r\n' }, { time: '9:00' }, { time: 9 }, { location: ' ' }, { location: '字'.repeat(201) }, { contactDescription: '' }, { contactDescription: '字'.repeat(2001) }, { source: '字'.repeat(501) }, { note: '字'.repeat(10001) }, { note: {} }, { status: 'deleted' }, { latitude: 25 }, { longitude: 121 }, { diagnosis: 'inferred' }, { clinicalScore: 5 }, { notificationTarget: 'someone' }, { createdAt: 'forged' }, { version: 1 }];
  for (const fields of bad) assert.equal((await f.request(f.admin, 'POST', route(), f.payload(fields), { 'Idempotency-Key': id() })).status, 422, JSON.stringify(fields));
  assert.equal((await f.request(f.admin, 'POST', route(), [])).status, 400); assert.deepEqual(f.state(), before);
  for (const fields of [{ date: '0001-01-01', time: '00:00', relatedCaseId: '' }, { time: '23:59', contactDescription: '字'.repeat(2000), note: '字'.repeat(10000) }]) assert.equal((await f.create(entity, f.payload(fields))).time, fields.time);
});

test('strict current/list/history query parsing protects exact filter semantics and fixed 25-item pagination without writes', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload({ contactDescription: '合成搜尋關鍵字' })); await f.create(entity, f.payload({ caseId: f.caseC.id, date: '2026-10-11', relatedCaseId: '', status: 'inactive' }));
  const query = new URLSearchParams({ caseId: f.caseA.id, relatedCaseId: f.caseB.id, date: '2026-10-10', status: 'active', q: '搜尋關鍵字', page: '1', pageSize: '25' }), list = await f.request(f.admin, 'GET', route() + '?' + query); assert.equal(list.status, 200); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].id, item.id);
  const before = f.state();
  for (const query of ['q=' + '字'.repeat(201), 'page=0', 'page=1e0', 'page=1%0A', 'page=01', 'pageSize=25%0D%0A', 'pageSize=101', 'caseId=', 'relatedCaseId=%20', 'date=0000-01-01', 'date=2026-02-30', 'date=2026-10-10%0A', 'status=deleted', 'caseId=a&caseId=b', 'relatedCaseId=a&relatedCaseId=b', 'q=x&q=y', 'unknown=1']) assert.equal((await f.request(f.admin, 'GET', route() + '?' + query)).status, 422, query);
  for (const query of ['q=', 'page=1', 'status=active', 'unknown=1']) assert.equal((await f.request(f.admin, 'GET', route(item) + '?' + query)).status, 422, query);
  for (const query of ['caseId=' + f.caseA.id, 'relatedCaseId=' + f.caseB.id, 'q=', 'page=1e0', 'page=1%0A', 'pageSize=25%0D%0A', 'compare=latest', 'compare=previous&compare=previous', 'page=1&page=2', 'unknown=1']) assert.equal((await f.request(f.admin, 'GET', route(item, '/history?' + query))).status, 422, query);
  assert.deepEqual(f.state(), before);
  for (let index = 0; index < 25; index++) await f.create(entity, f.payload({ contactDescription: '合成分頁', note: String(index) }));
  const page1 = await f.request(f.admin, 'GET', route() + '?caseId=' + f.caseA.id + '&page=1&pageSize=25'), page2 = await f.request(f.admin, 'GET', route() + '?caseId=' + f.caseA.id + '&page=2&pageSize=25'); assert.equal(page1.body.total, 26); assert.equal(page1.body.items.length, 25); assert.equal(page2.body.items.length, 1); assert.ok(!page1.body.items.some(row => row.id === page2.body.items[0].id));
});

test('create retry remains idempotent and concurrent CAS has exactly one winner and one new immutable version', async t => {
  const f = await fixture(t), payload = f.payload(), key = id(), first = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.equal(first.status, 201); const before = f.state();
  const again = await f.request(f.admin, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.deepEqual(again.body, first.body); assert.deepEqual(f.state(), before);
  assert.equal((await f.request(f.admin, 'POST', route(), { ...payload, location: 'different' }, { 'Idempotency-Key': key })).status, 409); assert.deepEqual(f.state(), before);
  const races = await Promise.all([' 合成甲 ', ' 合成乙 '].map(location => f.request(f.admin, 'PATCH', route(first.body.item), { version: 1, location })));
  assert.deepEqual(races.map(result => result.status).sort(), [200, 409]); const winner = races.find(result => result.status === 200).body.item, after = f.state(); assert.equal(after.records.length, before.records.length); assert.equal(after.record_versions.length, before.record_versions.length + 1); assert.equal(after.audit.length, before.audit.length + 1); assert.equal(after.idempotency.length, before.idempotency.length); assert.equal(winner.version, 2); assert.equal(winner.note, payload.note);
  const history = await f.request(f.admin, 'GET', route(winner, '/history?compare=previous')); assert.deepEqual(history.body.items.map(row => row.version), [2, 1]);
});

test('current original and optional related case availability is rechecked before all reads and mutations, including orphaned imported records', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), independent = await f.create(entity, f.payload({ relatedCaseId: '' }));
  f.app.db.prepare('UPDATE records SET org_id=? WHERE org_id=? AND entity=? AND id=?').run(f.foreign.org, f.admin.org, 'cases', f.caseB.id); let before = f.state();
  assert.equal((await f.request(f.admin, 'GET', route())).body.total, 1); assert.equal((await f.request(f.admin, 'GET', route(independent))).status, 200);
  for (const path of [route(item), route(item, '/history')]) assert.equal((await f.request(f.admin, 'GET', path)).status, 404); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, relatedCaseId: '', note: 'silent repair' })).status, 404); assert.deepEqual(f.state(), before);
  f.app.db.prepare('UPDATE records SET org_id=? WHERE org_id=? AND entity=? AND id=?').run(f.foreign.org, f.admin.org, 'cases', f.caseA.id); before = f.state();
  assert.equal((await f.request(f.admin, 'GET', route())).body.total, 0); assert.equal((await f.request(f.admin, 'GET', route(independent))).status, 404); assert.equal((await f.request(f.admin, 'PATCH', route(independent), { version: 1, note: 'orphan update' })).status, 404); assert.deepEqual(f.state(), before);
});

test('malformed JSON, metadata injection and unsafe SQL versions are invisible and cannot be patched or silently repaired', async t => {
  const f = await fixture(t), healthy = await f.create(entity, f.payload()), corrupt = [];
  for (const modification of [{ data: '{broken-json' }, { data: JSON.stringify({ ...f.payload(), orgId: f.admin.org }) }, { data: JSON.stringify({ ...f.payload(), note: { inferred: true } }) }, { version: 9007199254740992n }, { version: 0n }]) {
    const item = await f.create(entity, f.payload()); const key = Object.keys(modification)[0]; f.app.db.prepare(`UPDATE records SET ${key}=? WHERE id=?`).run(modification[key], item.id); corrupt.push(item);
  }
  const before = f.state(), list = await f.request(f.admin, 'GET', route()); assert.equal(list.status, 200, JSON.stringify(list.body)); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].id, healthy.id);
  for (const item of corrupt) { for (const path of [route(item), route(item, '/history')]) assert.equal((await f.request(f.admin, 'GET', path)).status, 404); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: 'repair' })).status, 404); }
  assert.deepEqual(f.state(), before);
});

test('forged or corrupt historical rows cannot switch saved original case, org, identity, related scope or SQL version', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()); let version = 2;
  const insert = (snapshot, sqlVersion = version++) => f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, sqlVersion, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot), now(), 'synthetic-forged-import');
  for (const fields of [{ caseId: f.caseC.id }, { caseId: f.foreignCase.id }, { relatedCaseId: f.foreignCase.id }, { id: 'synthetic-forged-id' }, { orgId: f.foreign.org }, { note: {} }, { latitude: 25 }, { createdAt: '' }, { date: '0000-01-01' }, { version: 999 }]) insert({ ...item, version, ...fields });
  insert('{invalid-json'); insert({ ...item, version: 0 }, 0); insert({ ...item, version: 9007199254740992 }, 9007199254740992n); const before = f.state();
  const history = await f.request(f.admin, 'GET', route(item, '/history?compare=previous')); assert.equal(history.status, 200, JSON.stringify(history.body)); assert.equal(history.body.total, 1); assert.equal(history.body.items[0].version, 1); assert.deepEqual(history.body.items[0].snapshot, item); assert.deepEqual(f.state(), before);
});

test('missing CAS, invalid origin/CSRF and stale CAS stop writes while exact untouched free text remains unchanged', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), before = f.state();
  for (const version of [undefined, '1', 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await f.request(f.admin, 'PATCH', route(item), { ...(version === undefined ? {} : { version }), location: 'never saved' })).status, 422);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: 'bad origin' }, { Origin: 'https://synthetic-other.example.test' })).status, 403); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: 'bad token' }, { 'X-CSRF-Token': '' })).status, 403); assert.deepEqual(f.state(), before);
  const changed = await f.patch(item, { time: '12:34' }), beforeConflict = f.state(); assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: 'stale' })).status, 409); assert.deepEqual(f.state(), beforeConflict); assert.equal(changed.note, item.note); assert.equal(changed.source, item.source); assert.equal(changed.contactDescription, item.contactDescription); assert.equal(changed.location, item.location);
});
