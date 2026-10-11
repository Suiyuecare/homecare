import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
const entity = 'institution-holidays', password = 'synthetic-institution-holidays-password';
const route = (item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, payload, headers = {}, raw = false) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload === undefined ? {} : { body: raw ? payload : JSON.stringify(payload) }) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = null; } return { status: response.status, text, body, headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成假日管理員', email: 'holiday-admin@example.test', password, organizationName: '合成假日機構甲' }); assert.equal(setup.status, 201);
  const admin = { org: setup.body.organizations[0].id, cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken };
  const createOther = async (kind, data, client = admin) => { const r = await request(client, 'POST', '/api/' + kind, data); assert.equal(r.status, 201, r.text); return r.body.item; };
  const employee = await createOther('employees', { name: '合成假日員工', employeeNo: 'HOLIDAY-E01' }), clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = `holiday-${role}@example.test`; await createOther('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { org: admin.org, cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken };
  }
  const draft = (overrides = {}) => ({ date: '2026-10-10', title: '合成機構指定日期', kind: 'holiday', ...overrides });
  const create = async (data, client = admin, headers = {}) => { const result = await request(client, 'POST', route(), draft(data), headers); assert.equal(result.status, 201, result.text); return result.body.item; };
  const patch = async (old, data, client = admin) => { const result = await request(client, 'PATCH', route(old), { version: old.version, ...data }); assert.equal(result.status, 200, result.text); return result.body.item; };
  const raw = () => Object.fromEntries(app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => { const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [row.name, statement.all()]; }));
  return { app, base, admin, clients, request, createOther, create, patch, raw, draft };
}
test('admin/supervisor ordinary CRUD, explicit deactivate/restore and all original text/date histories', async t => {
  const f = await fixture(t); let item = await f.create({ title: '  機構日期  ', sourceReference: '  原依據\r\n末行  ', note: '  原備註\r\n末行  ' }, f.clients.supervisor);
  const original = structuredClone(item); item = await f.patch(item, { title: '  明確名稱  ', date: '2026-10-11', kind: 'working-day' });
  assert.equal(item.version, 2); assert.equal(item.sourceReference, original.sourceReference); assert.equal(item.note, original.note);
  item = await f.patch(item, { status: 'inactive' }, f.clients.supervisor); assert.equal(item.status, 'inactive'); item = await f.patch(item, { status: 'active' }); assert.equal(item.version, 4);
  const frozen = f.raw(); const history = await f.request(f.admin, 'GET', route(item, '/history?compare=previous')); assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => row.version), [4, 3, 2, 1]);
  assert.deepEqual(history.body.items.at(-1).snapshot, original); assert.deepEqual(f.raw(), frozen);
});
test('duplicate active date and concurrent creation are atomic; inactivity releases date and restoration conflicts', async t => {
  const f = await fixture(t), requests = await Promise.all([f.request(f.admin, 'POST', route(), f.draft()), f.request(f.admin, 'POST', route(), f.draft({ title: '合成並行另一設定', kind: 'other' }))]);
  assert.deepEqual(requests.map(r => r.status).sort(), [201, 409]); let item = requests.find(r => r.status === 201).body.item;
  const before = f.raw(); assert.equal((await f.request(f.admin, 'POST', route(), f.draft())).status, 409); assert.deepEqual(f.raw(), before);
  item = await f.patch(item, { status: 'inactive' }); const replacement = await f.create({ kind: 'closure' }); const beforeRestore = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, status: 'active' })).status, 409); assert.deepEqual(f.raw(), beforeRestore);
  await f.patch(replacement, { status: 'inactive' }); item = await f.patch(item, { status: 'active' }); assert.equal(item.status, 'active');
});
test('roles precede malformed body/query and single/history access; cross-org IDs are hidden', async t => {
  const f = await fixture(t), item = await f.create();
  for (const role of ['finance', 'caregiver']) for (const [method, path, body] of [['GET', route() + '?unknown=1'], ['GET', route(item)], ['GET', route(item, '/history?compare=wrong')], ['POST', route(), '{'], ['PATCH', route(item), '{']]) {
    const before = f.raw(); assert.equal((await f.request(f.clients[role], method, path, body, {}, typeof body === 'string')).status, 403); assert.deepEqual(f.raw(), before);
  }
  const other = await f.createOther('organizations', { name: '合成假日機構乙' }), client = { ...f.admin, org: other.id }, foreign = await f.create({ title: 'SYNTHETIC-FOREIGN-DATE' }, client), before = f.raw();
  for (const [method, suffix, payload] of [['GET', ''], ['GET', '/history'], ['PATCH', '', { version: foreign.version, title: 'forbidden' }]]) assert.equal((await f.request(f.admin, method, route(foreign, suffix), payload)).status, 404);
  assert.equal((await f.request(f.admin, 'GET', route())).body.items.some(row => row.id === foreign.id), false); assert.deepEqual(f.raw(), before);
});
test('POST idempotency/CAS/CSRF/Origin/missing-version/delete failures preserve every table', async t => {
  const f = await fixture(t), key = randomUUID(), request = () => f.request(f.admin, 'POST', route(), f.draft(), { 'Idempotency-Key': key });
  const first = await request(); assert.equal(first.status, 201); const beforeRetry = f.raw(), retry = await request(); assert.equal(retry.status, 201); assert.deepEqual(retry.body, first.body); assert.deepEqual(f.raw(), beforeRetry);
  assert.equal((await f.request(f.admin, 'POST', route(), f.draft({ date: '2026-10-11' }), { 'Idempotency-Key': key })).status, 409); assert.deepEqual(f.raw(), beforeRetry);
  const item = first.body.item, before = f.raw();
  for (const [body, headers, expected] of [[{ version: 2, title: 'x' }, {}, 409], [{ title: 'x' }, {}, 422], [{ version: 1, title: 'x' }, { 'X-CSRF-Token': 'invalid' }, 403], [{ version: 1, title: 'x' }, { Origin: 'https://synthetic-other.example.test' }, 403]]) {
    assert.equal((await f.request(f.admin, 'PATCH', route(item), body, headers)).status, expected); assert.deepEqual(f.raw(), before);
  }
  assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404); assert.deepEqual(f.raw(), before);
});
test('literal year/status/q and pagination are strict and read-only with no calendar effects', async t => {
  const f = await fixture(t), old = await f.create({ date: '2026-01-01', kind: 'closure' }), leap = await f.create({ date: '2024-02-29', title: '合成閏日' }); await f.patch(old, { status: 'inactive' }); await f.create({ date: '2026-12-31', kind: 'working-day' });
  const before = f.raw(), result = await f.request(f.admin, 'GET', route() + '?year=2026&status=active&q=工作日&page=1&pageSize=25'); assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].date, '2026-12-31');
  assert.equal((await f.request(f.admin, 'GET', route() + '?year=2024')).body.items[0].id, leap.id);
  for (const query of ['year=2026%0A', 'year=0000', 'year=2026&year=2027', 'page=1%0A', 'pageSize=101', 'unknown=1', 'kind=holiday', 'q=' + 'x'.repeat(201)]) assert.equal((await f.request(f.admin, 'GET', route() + '?' + query)).status, 422);
  assert.equal((await f.request(f.admin, 'GET', route(old) + '?year=2026')).status, 422); assert.equal((await f.request(f.admin, 'GET', route(old, '/history?year=2026'))).status, 422); assert.deepEqual(f.raw(), before);
});
test('bad date/type/unknown nested/extra business fields and new inactive status fail with zero writes', async t => {
  const f = await fixture(t), before = f.raw();
  for (const fields of [{ date: '2026-02-29' }, { date: '0000-01-01' }, { title: ' ' }, { kind: 'constructor' }, { note: {} }, { sourceReference: 'x'.repeat(2001) }, { unknown: { value: 'hidden' } }, { status: 'inactive' }]) {
    assert.equal((await f.request(f.admin, 'POST', route(), f.draft(fields))).status, 422); assert.deepEqual(f.raw(), before);
  }
});
test('malformed current JSON, null, unknown nested keys and unsafe SQL versions are hidden and block writes', async t => {
  const f = await fixture(t), item = await f.create(), valid = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data;
  for (const corrupted of ['{', 'null', '[]', JSON.stringify({ ...JSON.parse(valid), unknown: { secret: 'synthetic-import' } })]) {
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(corrupted, item.id); const before = f.raw();
    assert.equal((await f.request(f.admin, 'GET', route())).body.total, 0);
    for (const suffix of ['', '/history']) assert.equal((await f.request(f.admin, 'GET', route(item, suffix))).status, 404);
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, title: 'x' })).status, 404); assert.deepEqual(f.raw(), before);
    assert.equal((await f.request(f.admin, 'POST', route(), f.draft({ date: '2026-10-11' }))).status, 409); assert.deepEqual(f.raw(), before);
  }
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(valid, item.id);
  for (const version of [0n, -1n, 9007199254740992n, 9223372036854775807n]) { f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, item.id); const before = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(item))).status, 404); assert.equal((await f.request(f.admin, 'GET', route())).body.total, 0); assert.deepEqual(f.raw(), before); }
});
test('history rejects malformed/null/unknown metadata and SQL version mismatch while keeping editable-date prior versions', async t => {
  const f = await fixture(t), original = await f.create(), item = await f.patch(original, { date: '2026-10-11', note: '合成新日期紀錄' });
  const snapshots = ['{', 'null', '[]', JSON.stringify({ ...item, version: 6, unknown: {} }), JSON.stringify({ ...item, version: 99 })];
  snapshots.forEach((snapshot, i) => f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, i + 3, snapshot, item.updatedAt, 'synthetic-import'));
  const before = f.raw(), history = await f.request(f.admin, 'GET', route(item, '/history?compare=previous')); assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => row.version), [2, 1]); assert.equal(history.body.items[1].snapshot.date, original.date); assert.deepEqual(f.raw(), before);
});
