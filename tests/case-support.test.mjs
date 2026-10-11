import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { insert, id, now } from '../src/server/model.mjs';
import { caseSupportEntities } from '../src/server/case-support.mjs';

const entities = Object.keys(caseSupportEntities), password = 'synthetic-support-password';
const route = (entity, item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, path, body, headers = {}) {
    const response = await fetch(base + path, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成支持管理員', email: 'support-admin@example.test', password, organizationName: '合成支持機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(entity, payload, client = admin, headers = {}) {
    const result = await request(client, 'POST', route(entity), payload, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成居服員', employeeNo: 'SUPPORT-E' });
  const clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = `support-${role}@example.test`;
    await create('users', { name: `合成${role}`, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password });
    assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseA = await create('cases', { name: '合成支持個案', caseNo: 'SUPPORT-A' });
  const caseB = await create('cases', { name: '合成結案個案', caseNo: 'SUPPORT-B', status: 'closed' });
  const foreignOrg = await create('organizations', { name: '合成支持機構乙' }), foreign = { ...admin, org: foreignOrg.id };
  const foreignCase = await create('cases', { name: '合成跨機構個案', caseNo: 'SUPPORT-FOREIGN' }, foreign);
  const payload = (entity, overrides = {}) => ({ caseId: caseA.id, date: '2026-10-10',
    ...(entity === 'case-relationships' ? { kind: 'family', name: '合成家人', relationship: '合成親屬' } : { practitionerName: '合成醫事人員', summary: '合成人工摘要' }), ...overrides });
  const counts = () => Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const preserved = () => ({ records: app.db.prepare("SELECT * FROM records WHERE entity NOT IN ('case-relationships','medical-opinions') ORDER BY id").all(), versions: app.db.prepare("SELECT * FROM record_versions WHERE entity NOT IN ('case-relationships','medical-opinions') ORDER BY record_id,version").all(), files: app.db.prepare('SELECT * FROM attachment_files ORDER BY id').all() });
  return { app, request, create, clients, admin, employee, caseA, caseB, foreign, foreignCase, payload, counts, preserved };
}

test('case support CRUD preserves manual text, supports inactive cases and immutable versions without changing clinical or scheduling data', async t => {
  const f = await fixture(t), before = f.preserved();
  for (const entity of entities) {
    const defaultPayload = f.payload(entity);
    if (entity === 'case-relationships') delete defaultPayload.kind;
    const defaults = await f.create(entity, defaultPayload);
    assert.equal(defaults.status, 'active');
    if (entity === 'case-relationships') { assert.equal(defaults.kind, 'family'); assert.equal(defaults.support, 'unknown'); }
    let item = await f.create(entity, f.payload(entity, { caseId: ` ${f.caseB.id} `, note: ' 合成完整人工紀錄\n第二行 ', source: ' 合成轉錄來源 ' }), f.clients.supervisor);
    assert.equal(item.caseId, f.caseB.id); assert.equal(item.note, '合成完整人工紀錄\n第二行'); assert.equal(item.version, 1);
    for (const status of ['inactive', 'active']) {
      const result = await f.request(f.clients.supervisor, 'PATCH', route(entity, item), { version: item.version, status, note: status === 'active' ? '' : '合成停用原因' });
      assert.equal(result.status, 200, JSON.stringify(result.body)); item = result.body.item;
    }
    const history = await f.request(f.admin, 'GET', route(entity, item, '/history?compare=previous'));
    assert.equal(history.status, 200); assert.deepEqual(history.body.items.map(row => row.version), [3, 2, 1]);
    assert.equal(history.body.items[0].comparison.previousSnapshot.status, 'inactive');
    assert.equal(history.body.items[0].actor.id, f.clients.supervisor.user.id);
    assert.equal((await f.request(f.admin, 'DELETE', route(entity, item))).status, 404);
    assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('rewritten', item.id), /immutable/);
  }
  assert.deepEqual(f.preserved(), before);
});

test('case support rejects unknown fields, missing text, invalid dates/options/types and cross-org parents with zero writes', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity)), before = f.counts();
    const invalid = [{ caseId: f.foreignCase.id }, { caseId: f.employee.id }, { caseId: id() }, { caseId: '' }, { date: '2026-02-30' }, { date: '2026-1-01' }, { date: '0000-01-01' }, { status: 'deleted' }, { note: '字'.repeat(10001) }, { source: '字'.repeat(501) }, { billingSnapshot: {} }, { clinicalScore: 1 }];
    if (entity === 'case-relationships') invalid.push({ kind: 'family-tree' }, { direction: 'automatic' }, { support: 'risk' }, { name: '字'.repeat(101) }, { relationship: ' ' });
    else invalid.push({ practitionerName: '' }, { summary: ' ' }, { summary: '字'.repeat(501) }, { followUpDate: '2026-02-29' });
    for (const key of caseSupportEntities[entity].fields.split(' ')) for (const value of [null, [], {}, 10, true]) invalid.push({ [key]: value });
    for (const data of invalid) assert.equal((await f.request(f.admin, 'POST', route(entity), f.payload(entity, data), { 'Idempotency-Key': 'failed-' + id() })).status, 422, JSON.stringify(data));
    for (const key of caseSupportEntities[entity].required) {
      if (Object.hasOwn(caseSupportEntities[entity].defaults, key)) continue;
      const payload = f.payload(entity); delete payload[key]; assert.equal((await f.request(f.admin, 'POST', route(entity), payload)).status, 422, key);
    }
    for (const caseId of [f.caseB.id, f.foreignCase.id, id()]) {
      const result = await f.request(f.admin, 'PATCH', route(entity, item), { version: 1, caseId });
      assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CASE_IMMUTABLE');
    }
    assert.deepEqual(f.counts(), before); assert.deepEqual((await f.request(f.admin, 'GET', route(entity, item))).body.item, item);
  }
});

test('server protects sensitive list, item, history and writes from finance/caregiver and isolates organizations', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity)), foreign = await f.create(entity, f.payload(entity, { caseId: f.foreignCase.id, note: 'SYNTHETIC-FOREIGN-SENSITIVE' }), f.foreign);
    const before = f.counts();
    for (const role of ['finance', 'caregiver']) {
      const client = f.clients[role];
      for (const path of [route(entity), route(entity, item), route(entity, item, '/history?compare=previous')]) {
        const result = await f.request(client, 'GET', path); assert.equal(result.status, 403); assert.ok(!JSON.stringify(result.body).includes('SYNTHETIC-FOREIGN-SENSITIVE'));
      }
      assert.equal((await f.request(client, 'POST', route(entity), f.payload(entity))).status, 403);
      assert.equal((await f.request(client, 'PATCH', route(entity, item), { version: 1, note: '無權變更' })).status, 403);
    }
    for (const path of [route(entity, foreign), route(entity, foreign, '/history?compare=previous')]) assert.equal((await f.request(f.admin, 'GET', path)).status, 404);
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, foreign), { version: 1, note: '跨機構變更' })).status, 404);
    const list = await f.request(f.admin, 'GET', route(entity)); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].id, item.id);
    assert.deepEqual(f.counts(), before);
  }
});

test('idempotent creates replay once while changed payloads and stale concurrent edits preserve the committed version', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const payload = f.payload(entity), key = 'support-' + entity;
    const first = await f.request(f.admin, 'POST', route(entity), payload, { 'Idempotency-Key': key }), before = f.counts();
    const replay = await f.request(f.admin, 'POST', route(entity), payload, { 'Idempotency-Key': key });
    assert.equal(first.status, 201); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.counts(), before);
    assert.equal((await f.request(f.admin, 'POST', route(entity), { ...payload, note: '不同請求' }, { 'Idempotency-Key': key })).status, 409);
    const item = first.body.item;
    const results = await Promise.all(['甲', '乙'].map(note => f.request(f.admin, 'PATCH', route(entity, item), { version: 1, note })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const count = f.counts(); assert.equal(count.records, before.records); assert.equal(count.record_versions, before.record_versions + 1); assert.equal(count.audit, before.audit + 1);
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, item), { version: 1, note: '舊版覆蓋' })).status, 409); assert.deepEqual(f.counts(), count);
  }
});

test('case-scoped search, status/date filters and bounded pagination reject malformed queries without writes', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity, { note: '合成可搜尋關鍵字' }));
    await f.create(entity, f.payload(entity, { caseId: f.caseB.id, status: 'inactive' }));
    const before = f.counts();
    const list = await f.request(f.admin, 'GET', route(entity) + `?caseId=${f.caseA.id}&status=active&date=2026-10-10&q=關鍵字&page=1&pageSize=1`);
    assert.equal(list.status, 200); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].id, item.id);
    const later = await f.request(f.admin, 'GET', route(entity) + '?page=2&pageSize=1'); assert.equal(later.body.items.length, 1);
    const foreign = await f.request(f.admin, 'GET', route(entity) + '?caseId=' + f.foreignCase.id); assert.equal(foreign.body.total, 0);
    for (const query of ['page=0', 'pageSize=101', 'q=' + 'a'.repeat(201), 'status=deleted', 'status=active&status=inactive', 'caseId=', 'date=2026-02-30', 'date=0000-01-01', 'kind=family', 'month=2026-10'])
      assert.equal((await f.request(f.admin, 'GET', route(entity) + '?' + query)).status, 422, query);
    assert.deepEqual(f.counts(), before);
  }
});

test('orphan and forged foreign-parent historical snapshots are hidden instead of leaking through current/list/history reads', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity));
    const hidden = insert(f.app.db, f.admin.org, entity, { ...caseSupportEntities[entity].defaults, ...f.payload(entity, { caseId: f.foreignCase.id, note: 'SYNTHETIC-ORPHAN-SECRET' }) });
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, 2, JSON.stringify({ ...item, version: 2, caseId: f.foreignCase.id, note: 'SYNTHETIC-FOREIGN-HISTORY' }), now(), 'synthetic-import');
    const before = f.counts();
    assert.equal((await f.request(f.admin, 'GET', route(entity, hidden))).status, 404);
    assert.equal((await f.request(f.admin, 'GET', route(entity, hidden, '/history'))).status, 404);
    const list = await f.request(f.admin, 'GET', route(entity)); assert.equal(list.body.total, 1);
    const history = await f.request(f.admin, 'GET', route(entity, item, '/history?compare=previous'));
    assert.equal(history.status, 200); assert.equal(history.body.total, 1); assert.equal(history.body.items[0].version, 1);
    assert.ok(!JSON.stringify(history.body).includes('SYNTHETIC-FOREIGN-HISTORY')); assert.deepEqual(f.counts(), before);
  }
});

test('origin, CSRF, missing versions, and invalid methods fail without appending records, history or audit', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity)), before = f.counts();
    assert.equal((await f.request(f.admin, 'POST', route(entity), f.payload(entity), { Origin: 'https://synthetic-other.example.test' })).status, 403);
    assert.equal((await f.request(f.admin, 'POST', route(entity), f.payload(entity), { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, item), { note: '未附版次' })).status, 422);
    assert.equal((await f.request(f.admin, 'DELETE', route(entity, item))).status, 404);
    assert.equal((await f.request(null, 'GET', route(entity))).status, 401);
    assert.deepEqual(f.counts(), before);
  }
});
