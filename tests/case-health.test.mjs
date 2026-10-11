import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, dateValid } from '../src/server/model.mjs';
import { caseHealthEntities, validateCaseHealth, normalizeCaseHealthPayload, caseHealthQuery } from '../src/server/case-health.mjs';

const entities = Object.keys(caseHealthEntities), route = (entity, item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, payload, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const password = 'synthetic-health-password', setup = await request(null, 'POST', '/api/setup', { name: '合成健康管理員', email: 'health-admin@example.test', password, organizationName: '合成健康機構甲' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  const create = async (entity, data, client = admin, headers = {}) => { const result = await request(client, 'POST', route(entity), data, headers); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const employee = await create('employees', { name: '合成居服員', employeeNo: 'HEALTH-E' }), clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = `health-${role}@example.test`; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseA = await create('cases', { name: '合成健康個案', caseNo: 'HEALTH-A' }), caseB = await create('cases', { name: '合成歷史個案', caseNo: 'HEALTH-B', status: 'closed' });
  const org = await create('organizations', { name: '合成健康機構乙' }), foreign = { ...admin, org: org.id }, foreignCase = await create('cases', { name: '合成跨機構個案', caseNo: 'HEALTH-FOREIGN' }, foreign);
  const payload = (entity, overrides = {}) => ({ caseId: caseA.id, date: '2026-10-10', ...(entity === 'case-vaccinations' ? { vaccine: '合成疫苗名稱' } : entity === 'case-infection-records' ? { category: '合成人工分類', observation: '合成觀察第一行\n第二行' } : { time: '09:05', metric: '合成人工量測', value: '00036.500', unit: '合成人工單位' }), ...overrides });
  const patch = async (entity, item, data, client = admin) => { const result = await request(client, 'PATCH', route(entity, item), { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item; };
  const counts = () => Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const preserved = () => ({ records: app.db.prepare("SELECT * FROM records WHERE entity NOT IN ('case-vaccinations','case-infection-records','case-vitals') ORDER BY id").all(), versions: app.db.prepare("SELECT * FROM record_versions WHERE entity NOT IN ('case-vaccinations','case-infection-records','case-vitals') ORDER BY record_id,version").all(), files: app.db.prepare('SELECT * FROM attachment_files ORDER BY id').all() });
  return { app, request, create, patch, payload, counts, preserved, admin, clients, caseA, caseB, foreign, foreignCase };
}

test('manual health CRUD preserves raw text, closed case documentation, precise literal decimals and actual version actors', async t => {
  const f = await fixture(t), before = f.preserved();
  for (const entity of entities) {
    let item = await f.create(entity, f.payload(entity, { caseId: ' ' + f.caseB.id + ' ', note: ' 完整人工備註\r\n第二行 ', source: ' 保留來源 ' }), f.clients.supervisor);
    assert.equal(item.status, 'active'); assert.equal(item.caseId, f.caseB.id); assert.equal(item.note, ' 完整人工備註\r\n第二行 '); assert.equal(item.source, ' 保留來源 ');
    if (entity === 'case-vitals') assert.equal(item.value, '00036.500');
    for (const status of ['inactive', 'active']) item = await f.patch(entity, item, { status }, f.clients.supervisor);
    assert.equal(item.version, 3); assert.equal(item.note, ' 完整人工備註\r\n第二行 ');
    const history = await f.request(f.admin, 'GET', route(entity, item, '/history?compare=previous')); assert.equal(history.status, 200, JSON.stringify(history.body)); assert.deepEqual(history.body.items.map(row => row.version), [3, 2, 1]);
    assert.equal(history.body.items[0].comparison.previousSnapshot.status, 'inactive'); assert.equal(history.body.items[0].actor.id, f.clients.supervisor.user.id);
    assert.equal((await f.request(f.admin, 'DELETE', route(entity, item))).status, 404); assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('rewritten', item.id), /immutable/);
  }
  assert.deepEqual(f.preserved(), before);
});

test('health role authorization precedes payload parsing and isolates current, list, history and immutable parent writes', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity)), foreign = await f.create(entity, f.payload(entity, { caseId: f.foreignCase.id }), f.foreign), before = f.counts();
    for (const role of ['finance', 'caregiver']) {
      for (const path of [route(entity), route(entity, item), route(entity, item, '/history?compare=previous')]) assert.equal((await f.request(f.clients[role], 'GET', path)).status, 403);
      assert.equal((await f.request(f.clients[role], 'POST', route(entity), [])).status, 403); assert.equal((await f.request(f.clients[role], 'PATCH', route(entity, item), { unknown: true })).status, 403);
    }
    for (const client of [f.admin, f.clients.supervisor]) {
      assert.equal((await f.request(client, 'GET', route(entity, foreign))).status, 404); assert.equal((await f.request(client, 'GET', route(entity, foreign, '/history'))).status, 404);
      assert.equal((await f.request(client, 'PATCH', route(entity, foreign), { version: 1, note: 'cross' })).status, 404);
      assert.equal((await f.request(client, 'PATCH', route(entity, item), { version: 1, caseId: f.caseB.id })).status, 409);
    }
    assert.equal((await f.request(f.admin, 'POST', route(entity), f.payload(entity, { caseId: f.foreignCase.id }))).status, 422); assert.deepEqual(f.counts(), before);
  }
});

test('unknown payloads, missing required text, invalid dates and lengths fail with zero data, history, audit or idempotency writes', async t => {
  const f = await fixture(t), before = f.counts();
  for (const entity of entities) {
    const invalid = [{ diagnosis: 'inferred' }, { riskScore: 5 }, { caseId: id() }, { date: '0000-01-01' }, { date: '2026-02-30' }, { status: 'deleted' }, { note: '字'.repeat(10001) }, { source: '字'.repeat(501) }, { note: {} }];
    for (const key of caseHealthEntities[entity].required) invalid.push({ [key]: '' });
    for (const fields of invalid) assert.equal((await f.request(f.admin, 'POST', route(entity), f.payload(entity, fields), { 'Idempotency-Key': id() })).status, 422, JSON.stringify(fields));
    assert.equal((await f.request(f.admin, 'POST', route(entity), [])).status, 400);
  }
  assert.deepEqual(f.counts(), before);
  const infection = await f.create('case-infection-records', f.payload('case-infection-records', { observation: '觀'.repeat(2000), action: '處'.repeat(2000), note: '字'.repeat(10000), followUpDate: '2026-10-10' })); assert.equal(infection.observation.length, 2000);
});

test('follow-up dates and decimal literal formats enforce only structural constraints without float rounding or clinical ranges', async t => {
  const f = await fixture(t), before = f.counts();
  for (const fields of [{ category: '字'.repeat(101) }, { observation: '字'.repeat(2001) }, { action: '字'.repeat(2001) }, { followUpDate: '2026-10-09' }, { followUpDate: '0000-01-01' }, { followUpDate: '2026-02-30' }]) assert.equal((await f.request(f.admin, 'POST', route('case-infection-records'), f.payload('case-infection-records', fields))).status, 422);
  for (const value of [36.5, '-1', '+1', '1e2', '.5', '1.', ' 36.5', '36.5 ', '1\n', '1\r\n', '1,000', '0'.repeat(41)]) assert.equal((await f.request(f.admin, 'POST', route('case-vitals'), f.payload('case-vitals', { value }))).status, 422);
  for (const time of ['24:00', '23:60', '9:05', '09:05:00']) assert.equal((await f.request(f.admin, 'POST', route('case-vitals'), f.payload('case-vitals', { time }))).status, 422);
  assert.deepEqual(f.counts(), before);
  for (const value of ['0', '0.00', '00036.500', '12345678901234567890.' + '0'.repeat(19)]) assert.equal((await f.create('case-vitals', f.payload('case-vitals', { value }))).value, value);
  const firstYear = await f.create('case-vaccinations', f.payload('case-vaccinations', { date: '0001-01-01' })); assert.equal(firstYear.date, '0001-01-01');
});

test('health creation retries are idempotent and competing version updates yield one winner without duplicate versions', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const payload = f.payload(entity), key = id(), first = await f.request(f.admin, 'POST', route(entity), payload, { 'Idempotency-Key': key }); assert.equal(first.status, 201); const before = f.counts();
    const retry = await f.request(f.admin, 'POST', route(entity), payload, { 'Idempotency-Key': key }); assert.deepEqual(retry.body, first.body); assert.deepEqual(f.counts(), before);
    assert.equal((await f.request(f.admin, 'POST', route(entity), { ...payload, note: 'different' }, { 'Idempotency-Key': key })).status, 409);
    const item = first.body.item, results = await Promise.all(['甲', '乙'].map(note => f.request(f.admin, 'PATCH', route(entity, item), { version: 1, note })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]); const after = f.counts(); assert.equal(after.records, before.records); assert.equal(after.record_versions, before.record_versions + 1); assert.equal(after.audit, before.audit + 1);
  }
});

test('closed queries filter current case/date/status and page safely while single and history reject unrelated parameters', async t => {
  const f = await fixture(t);
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity, { note: '合成查詢關鍵字' })); await f.create(entity, f.payload(entity, { caseId: f.caseB.id, date: '2026-10-11' }));
    const list = await f.request(f.clients.supervisor, 'GET', route(entity) + `?caseId=${f.caseA.id}&date=2026-10-10&status=active&q=關鍵字&page=1&pageSize=25`); assert.equal(list.status, 200); assert.equal(list.body.total, 1); assert.equal(list.body.items[0].id, item.id);
    for (const query of ['date=0000-01-01', 'date=2026-02-30', 'status=deleted', 'caseId=', 'q=' + 'x'.repeat(201), 'page=0', 'page=1%0A', 'pageSize=25%0A', 'pageSize=101', 'status=active&status=inactive', 'month=2026-10', 'caseId=' + f.caseA.id + '&caseId=' + f.caseB.id]) assert.equal((await f.request(f.admin, 'GET', route(entity) + '?' + query)).status, 422, query);
    assert.equal((await f.request(f.admin, 'GET', route(entity, item) + '?status=active')).status, 422);
    for (const query of ['caseId=' + f.caseA.id, 'compare=previous&compare=previous', 'page=1&page=2', 'compare=latest']) assert.equal((await f.request(f.admin, 'GET', route(entity, item, '/history?' + query))).status, 422, query);
  }
  for (let index = 0; index < 25; index++) await f.create('case-vitals', f.payload('case-vitals', { note: '分頁' + index }));
  const page1 = await f.request(f.admin, 'GET', route('case-vitals') + '?caseId=' + f.caseA.id + '&page=1&pageSize=25'), page2 = await f.request(f.admin, 'GET', route('case-vitals') + '?caseId=' + f.caseA.id + '&page=2&pageSize=25');
  assert.equal(page1.body.total, 26); assert.equal(page1.body.items.length, 25); assert.equal(page2.body.items.length, 1); assert.ok(!page1.body.items.some(item => item.id === page2.body.items[0].id));
});

test('orphan records cannot be listed/read/patched and forged history cannot switch same-org or foreign case parents', async t => {
  const f = await fixture(t), items = [];
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity)); items.push([entity, item]); let version = 2;
    for (const fields of [{ caseId: f.caseB.id }, { caseId: f.foreignCase.id }, { orgId: f.foreign.org }, { id: 'forged-id' }]) f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, version, JSON.stringify({ ...item, ...fields, version: version++ }), now(), 'synthetic-forged-import');
    const history = await f.request(f.admin, 'GET', route(entity, item, '/history?compare=previous')); assert.equal(history.status, 200); assert.equal(history.body.total, 1); assert.equal(history.body.items[0].version, 1);
  }
  // Keep the immutable version FK intact while synthesizing an unavailable
  // same-organization parent. There is no user-facing parent-move operation.
  f.app.db.prepare('UPDATE records SET org_id=? WHERE id=? AND org_id=? AND entity=?').run(f.foreign.org, f.caseA.id, f.admin.org, 'cases'); const before = f.counts();
  for (const [entity, item] of items) {
    const list = await f.request(f.admin, 'GET', route(entity)); assert.equal(list.status, 200); assert.equal(list.body.total, 0);
    for (const path of [route(entity, item), route(entity, item, '/history')]) assert.equal((await f.request(f.admin, 'GET', path)).status, 404);
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, item), { version: item.version, note: 'orphan update' })).status, 404);
  }
  assert.deepEqual(f.counts(), before);
});

test('server helpers recheck parent for each write and reject unauthorized validation before storage; exact text stays unchanged', () => {
  const fail = (status, code) => { const error = new Error(code); error.status = status; throw error; }, ctx = { orgId: 'synthetic-org', role: 'supervisor' };
  for (const entity of entities) {
    const spec = caseHealthEntities[entity], data = { ...spec.defaults, caseId: 'synthetic-case', date: '2026-10-10', ...(entity === 'case-vaccinations' ? { vaccine: '合成疫苗' } : entity === 'case-infection-records' ? { category: '合成分類', observation: '觀察' } : { time: '09:05', metric: '項目', value: '00036.500', unit: '單位' }) };
    let exists = true, reads = 0; const get = (_db, orgId, parentEntity, caseId) => { assert.deepEqual([orgId, parentEntity, caseId], [ctx.orgId, 'cases', data.caseId]); reads++; return exists ? { id: caseId, orgId } : undefined; };
    validateCaseHealth(entity, data, null, fail, dateValid, null, ctx, get); exists = false;
    assert.throws(() => validateCaseHealth(entity, { ...data, note: 'next' }, data, fail, dateValid, null, ctx, get), error => error.status === 422 && error.message === 'INVALID_REFERENCE'); assert.equal(reads, 2);
    for (const role of ['finance', 'caregiver']) assert.throws(() => validateCaseHealth(entity, null, null, fail, dateValid, null, { ...ctx, role }, () => { throw new Error('unexpected storage'); }), error => error.status === 403);
    const raw = { note: ' 原\r\n文 ', source: ' 來源 ', value: '00036.500' }; assert.deepEqual(normalizeCaseHealthPayload(entity, raw), raw);
    for (const query of ['page=0', 'page=1&page=2', 'pageSize=101', 'date=0000-01-01', 'unknown=1']) assert.throws(() => caseHealthQuery(entity, new URLSearchParams(query), fail, dateValid));
  }
});

test('CSRF, origin and missing CAS prevent health mutations without rewriting versions or source records', async t => {
  const f = await fixture(t), beforeUnrelated = f.preserved();
  for (const entity of entities) {
    const item = await f.create(entity, f.payload(entity)), before = f.counts();
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, item), { version: 1, note: 'bad-origin' }, { Origin: 'https://synthetic-other.example.test' })).status, 403);
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, item), { version: 1, note: 'bad-csrf' }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await f.request(f.admin, 'PATCH', route(entity, item), { note: 'missing version' })).status, 422); assert.deepEqual(f.counts(), before);
  }
  assert.deepEqual(f.preserved(), beforeUnrelated);
});
