import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { business, id, now } from '../src/server/model.mjs';
import { PDF_BYTES, filePayload } from './attachment-fixtures.mjs';

const entity = 'personal-calendar-events';
const fields = ['title', 'date', 'startTime', 'endTime', 'note', 'status'];
const route = (item, suffix = '') => '/api/' + entity + (item ? '/' + item.id : '') + suffix;
const password = 'synthetic-personal-calendar-password';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, path, data, headers = {}, rawBody) {
    const hasBody = data !== undefined || rawBody !== undefined;
    const response = await fetch(base + path, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(hasBody ? { body: rawBody === undefined ? JSON.stringify(data) : rawBody } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成行事管理員', email: 'personal-admin@example.test', password, organizationName: '合成行事機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(kind, data, client = admin, headers = {}) {
    const result = await request(client, 'POST', '/api/' + kind, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(item, data, client = admin) {
    const result = await request(client, 'PATCH', route(item), { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成原居服員', employeeNo: 'PC-EMP', hourlyRateCents: 12345 });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = `personal-${role}@example.test`;
    await create('users', { name: '合成行事' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const org = await create('organizations', { name: '合成行事機構乙' }), foreign = { ...admin, org: org.id };
  const payload = overrides => ({ title: '合成人工事件', date: '2026-10-10', startTime: '09:00', endTime: '10:00', ...overrides });
  function raw() {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(x => x.type === 'table'); assert.equal(tables.length, 11); assert.equal(schema.filter(x => x.type === 'trigger').length, 6);
    return { schema, tables: Object.fromEntries(tables.map(x => {
      const statement = app.db.prepare('SELECT * FROM "' + x.name + '" ORDER BY rowid'); statement.setReadBigInts(true);
      return [x.name, statement.all()];
    })), totalChanges: app.db.prepare('SELECT total_changes() n').get().n };
  }
  function unrelated() {
    const state = raw(); delete state.totalChanges;
    state.tables.records = state.tables.records.filter(x => x.entity !== entity);
    state.tables.record_versions = state.tables.record_versions.filter(x => x.entity !== entity);
    state.tables.audit = state.tables.audit.filter(x => x.entity !== entity);
    state.tables.idempotency = state.tables.idempotency.filter(x => !x.route.startsWith('POST /api/' + entity));
    return state;
  }
  function imported(data, { owner = admin.user.id, orgId = admin.org, version = 1, createdAt = now(), savedVersions = [version], snapshot = {} } = {}) {
    const recordId = id(), stored = { ...data, ...(owner === undefined ? {} : { ownerUserId: owner }) };
    const full = { ...stored, id: recordId, orgId, version: typeof version === 'bigint' ? Number(version) : version, createdAt, updatedAt: createdAt };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, orgId, entity, JSON.stringify(stored), version, createdAt, createdAt);
    for (const v of savedVersions) app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, recordId, v, JSON.stringify({ ...full, version: typeof v === 'bigint' ? Number(v) : v, ...snapshot }), createdAt, 'baseline');
    return full;
  }
  async function readOnly(client, path, status = 200, code) {
    const before = raw(), result = await request(client, 'GET', path);
    assert.equal(result.status, status, JSON.stringify(result.body)); if (code) assert.equal(result.body.error.code, code);
    assert.deepEqual(raw(), before, 'GET must preserve all eleven tables, six triggers and total_changes'); return result;
  }
  async function reject(client, method, path, data, status, code, headers = {}, rawBody) {
    const before = raw(), result = await request(client, method, path, data, headers, rawBody);
    assert.equal(result.status, status, JSON.stringify(result.body)); if (code) assert.equal(result.body.error.code, code);
    assert.deepEqual(raw(), before, 'Rejected request must leave complete storage unchanged'); return result;
  }
  return { app, request, create, patch, admin, clients, employee, foreign, payload, raw, unrelated, imported, readOnly, reject };
}

test('all four roles own their six-field events; even admin cannot read or edit another owner', async t => {
  const f = await fixture(t), protectedBefore = f.unrelated(), owned = new Map();
  for (const [role, client] of Object.entries(f.clients)) {
    let item = await f.create(entity, f.payload({ title: '合成' + role }), client);
    assert.equal(item.orgId, client.org); assert.equal(item.ownerUserId, client.user.id);
    assert.deepEqual(Object.keys(business(item)).sort(), [...fields, 'ownerUserId'].sort());
    assert.equal(item.status, 'active'); assert.equal(item.note, '');
    item = await f.patch(item, { note: '原文 ' + role + '\r\n末句 ' }, client);
    owned.set(role, item);
    const history = await f.readOnly(client, route(item, '/history?compare=previous'));
    assert.deepEqual(history.body.items.map(x => x.version), [2, 1]);
    assert(history.body.items.every(x => x.actor.id === client.user.id && x.snapshot.ownerUserId === client.user.id));
  }
  for (const [role, client] of Object.entries(f.clients)) {
    const list = await f.readOnly(client, route()); assert.deepEqual(list.body.items.map(x => x.id), [owned.get(role).id]);
    for (const [otherRole, item] of owned) if (otherRole !== role) {
      await f.readOnly(client, route(item), 404, 'NOT_FOUND');
      await f.readOnly(client, route(item, '/history?compare=previous'), 404, 'NOT_FOUND');
      await f.reject(client, 'PATCH', route(item), { version: 2, title: '越界' }, 404, 'NOT_FOUND');
    }
  }
  assert.deepEqual(f.unrelated(), protectedBefore);
});

test('same user in another institution is isolated, and poisoned invisible SQL versions never cause 500', async t => {
  const f = await fixture(t), local = await f.create(entity, f.payload()), other = await f.create(entity, f.payload({ title: '機構乙' }), f.foreign);
  for (const [client, hidden] of [[f.admin, other], [f.foreign, local]]) {
    await f.readOnly(client, route(hidden), 404); await f.readOnly(client, route(hidden, '/history?bad=1'), 404);
    await f.reject(client, 'PATCH', route(hidden), undefined, 404, 'NOT_FOUND', {}, '{');
  }
  for (const owner of [f.clients.finance.user.id, null, 123, {}, []]) f.imported(f.payload(), { owner, version: 9007199254740993n });
  const missing = f.imported(f.payload(), { owner: f.admin.user.id, version: 9007199254740993n });
  const missingRaw = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(missing.id).data); delete missingRaw.ownerUserId;
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(missingRaw), missing.id);
  const foreignUnsafe = f.imported(f.payload(), { orgId: f.foreign.org, version: 9007199254740993n });
  for (const data of ['null', '[]', '3', '{']) {
    const recordId = id(), time = now();
    f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, entity, data, 9007199254740993n, time, time);
    await f.readOnly(f.admin, route({ id: recordId }), 404);
  }
  await f.readOnly(f.admin, route(missing), 404); await f.readOnly(f.admin, route(foreignUnsafe), 404);
  const list = await f.readOnly(f.admin, route()); assert.deepEqual(list.body.items.map(x => x.id), [local.id]);
  assert.equal((await f.readOnly(f.foreign, route(other))).body.item.id, other.id);
});

test('unknown roles fail throughout the dedicated prefix before malformed query/body; original caregiver employee guard remains', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload());
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('synthetic-unknown', f.foreign.org, f.admin.user.id);
  for (const suffix of ['', '/' + item.id, '/' + item.id + '/history', '/unknown/action']) {
    await f.readOnly(f.foreign, route() + suffix + '?page=invalid&bad=1', 403, 'ROLE_FORBIDDEN');
    for (const method of ['POST', 'PATCH', 'DELETE']) await f.reject(f.foreign, method, route() + suffix + '?bad=1', undefined, 403, 'ROLE_FORBIDDEN', {}, '{');
  }
  const employee = await f.request(f.admin, 'PATCH', '/api/employees/' + f.employee.id, { version: f.employee.version, status: 'inactive' }); assert.equal(employee.status, 200);
  await f.readOnly(f.clients.caregiver, route(), 403, 'EMPLOYEE_LINK_REQUIRED');
  await f.reject(f.clients.caregiver, 'POST', route(), f.payload(), 403, 'EMPLOYEE_LINK_REQUIRED');
});

test('valid text and literal dates keep exact whitespace/CRLF; overlap is allowed and cancel/restore alters only status', async t => {
  const f = await fixture(t);
  for (const date of ['0001-01-01', '2024-02-29', '9999-12-31']) {
    let item = await f.create(entity, f.payload({ title: '  合成標題\t ', note: ' \r\n原文\n末句\r ', date, startTime: '00:00', endTime: '23:59' }));
    assert.equal(item.title, '  合成標題\t '); assert.equal(item.note, ' \r\n原文\n末句\r '); assert.equal(item.date, date);
    await f.create(entity, f.payload({ date, startTime: '00:00', endTime: '23:59' }));
    const initial = business(item);
    item = await f.patch(item, { status: 'cancelled' }); assert.deepEqual(business(item), { ...initial, status: 'cancelled' });
    item = await f.patch(item, { status: 'active' }); assert.deepEqual(business(item), initial);
    const saved = (await f.readOnly(f.admin, route(item, '/history'))).body.items;
    assert.deepEqual(saved.map(x => x.snapshot.status), ['active', 'cancelled', 'active']);
    assert(saved.every(x => x.snapshot.title === initial.title && x.snapshot.note === initial.note));
    assert(saved.every(x => !Object.hasOwn(x, 'actor') && !Object.hasOwn(x, 'comparison')));
  }
  const boundary = await f.create(entity, f.payload({ title: '字'.repeat(200), note: '字'.repeat(10000) }));
  assert.equal(boundary.title.length, 200); assert.equal(boundary.note.length, 10000);
});

test('fields, exact same-day time, nonwhite title, calendar year and forged ownership reject atomically', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload());
  const invalid = [
    { title: '' }, { title: ' \t　 ' }, { title: '字'.repeat(201) }, { note: '字'.repeat(10001) }, { title: '合成\r文' }, { title: '合成\n文' },
    { date: '0000-01-01' }, { date: '10000-01-01' }, { date: '2026-02-29' }, { date: '2024-02-30' }, { date: '2026-1-01' }, { date: ' 2026-10-10' }, { date: '2026-10-10T00:00:00Z' },
    { startTime: '9:00' }, { startTime: ' 09:00' }, { startTime: '24:00' }, { startTime: '09:60' }, { startTime: '09:00:00' }, { startTime: '2026-10-10T09:00Z' },
    { endTime: '09:00' }, { endTime: '08:59' }, { startTime: '23:00', endTime: '01:00' }, { endTime: '10:00+08:00' },
    { status: '' }, { status: 'Active' }, { status: 'ended' }, { ownerUserId: f.admin.user.id }, { ownerUserId: f.clients.supervisor.user.id }, { id: id() }, { orgId: f.foreign.org }, { employeeId: f.employee.id }, { caseId: id() }, { billingSnapshot: {} },
  ];
  for (const key of fields) for (const value of [null, 1, false, [], {}]) invalid.push({ [key]: value });
  for (const patch of invalid) {
    await f.reject(f.admin, 'POST', route(), f.payload(patch), 422);
    await f.reject(f.admin, 'PATCH', route(item), { version: 1, ...patch }, 422);
  }
  for (const key of ['title', 'date', 'startTime', 'endTime']) { const data = f.payload(); delete data[key]; const r = await f.reject(f.admin, 'POST', route(), data, 422); assert(Object.hasOwn(r.body.error.fields, key)); }
  for (const data of [null, []]) await f.reject(f.admin, 'POST', route(), data, 400, 'INVALID_BODY');
  await f.reject(f.admin, 'POST', route(), undefined, 400, 'INVALID_JSON', {}, '{');
  await f.reject(f.admin, 'POST', route(), f.payload(), 415, 'CONTENT_TYPE', { 'Content-Type': 'text/plain' });
});

test('merged validation preserves omitted raw fields/own-presence and requires explicit repair of incompatible fields', async t => {
  const f = await fixture(t);
  let raw = f.imported(f.payload({ title: ' 合成未改標題 ', note: ' 原始\r\n末句\r ', status: 'active' }));
  raw = await f.patch(raw, { status: 'cancelled' }); assert.equal(raw.title, ' 合成未改標題 '); assert.equal(raw.note, ' 原始\r\n末句\r ');
  let missing = f.imported(f.payload({ status: 'active' })); assert(!Object.hasOwn(missing, 'note'));
  missing = await f.patch(missing, { title: '合成改標題' }); assert(!Object.hasOwn(missing, 'note'));
  for (const incompatible of [{ title: ' \t ' }, { note: null }, { date: '0000-01-01' }, { startTime: '09:00:00' }, { status: 'future' }]) {
    let item = f.imported(f.payload({ note: '合成', status: 'active', ...incompatible }));
    const unchanged = await f.readOnly(f.admin, route(item)); assert.deepEqual(unchanged.body.item, item);
    await f.reject(f.admin, 'PATCH', route(item), { version: 1, endTime: '11:00' }, 422);
    const key = Object.keys(incompatible)[0], value = { title: '合成修復', note: '明確取代\r\n', date: '2026-10-10', startTime: '09:00', status: 'active' }[key];
    item = await f.patch(item, { [key]: value }); assert.equal(item[key], value);
  }
});

test('list validates closed lexical query and single/history reject every unexpected or empty compare query without writes', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload());
  const invalid = ['bad=1', 'ownerUserId=' + f.admin.user.id, 'q=a&q=b', 'status=active&status=active', 'date=2026-10-10&date=2026-10-10', 'page=1&page=1', 'pageSize=25&pageSize=25', 'q=' + '字'.repeat(201), 'status=future', 'status=Active', 'date=0000-01-01', 'date=2026-02-29'];
  for (const key of ['page', 'pageSize']) for (const value of ['', '0', '-1', '01', '+1', '1.0', '1e0', 'NaN', '9007199254740992']) invalid.push(key + '=' + encodeURIComponent(value));
  invalid.push('pageSize=101');
  for (const query of invalid) await f.readOnly(f.admin, route(null, '?' + query), 422);
  assert.deepEqual((await f.readOnly(f.admin, route(null, '?q=&status=&date=&page=1&pageSize=100'))).body, { items: [item], total: 1, page: 1, pageSize: 100 });
  for (const query of ['page=1', 'q=', 'status=', 'date=', 'compare=previous']) await f.readOnly(f.admin, route(item, '?' + query), 422, 'INVALID_QUERY');
  for (const query of ['q=', 'date=2026-10-10', 'ownerUserId=' + f.admin.user.id, 'compare=', 'compare=raw', 'compare=previous&compare=previous', 'page=01', 'pageSize=101']) await f.readOnly(f.admin, route(item, '/history?' + query), 422);
  await f.readOnly(f.clients.supervisor, route(item, '/history?compare='), 404);
  await f.reject(f.admin, 'POST', route(null, '?q='), f.payload(), 422, 'INVALID_QUERY');
  await f.reject(f.admin, 'PATCH', route(item, '?page=1'), { version: 1, title: '合成' }, 422, 'INVALID_QUERY');
});

test('owner/filter precede stable created-desc/id pagination and q searches only own string title/note', async t => {
  const f = await fixture(t), expected = [];
  for (let n = 0; n < 28; n++) expected.push(f.imported(f.payload({ title: 'SYNTHETIC needle ' + n, note: '原文', status: 'active' }), { createdAt: '2026-10-' + String(1 + n % 2).padStart(2, '0') + 'T00:00:00.000Z' }));
  f.imported(f.payload({ title: 'Needle hidden owner', note: '', status: 'active' }), { owner: f.clients.supervisor.user.id });
  f.imported(f.payload({ title: 'Needle other day', note: '', date: '2026-10-11', status: 'active' }));
  f.imported(f.payload({ title: 'Needle cancelled', note: '', status: 'cancelled' }));
  f.imported(f.payload({ title: 'metadata only', note: '', status: 'active', hidden: 'Needle' }));
  f.imported(f.payload({ title: { hidden: 'Needle' }, note: ['Needle'], status: 'active' }));
  const ordered = expected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(x => x.id), filter = '?q=NEEDLE&status=active&date=2026-10-10';
  const a = (await f.readOnly(f.admin, route(null, filter))).body, b = (await f.readOnly(f.admin, route(null, filter + '&page=2'))).body;
  assert.deepEqual(Object.keys(a).sort(), ['items', 'total', 'page', 'pageSize'].sort());
  assert.equal(a.total, 28); assert.equal(a.items.length, 25); assert.equal(b.items.length, 3); assert.equal(b.page, 2);
  assert.deepEqual([...a.items, ...b.items].map(x => x.id), ordered);
  assert.equal((await f.readOnly(f.admin, route(null, filter + '&page=3'))).body.items.length, 0);
  assert.equal((await f.readOnly(f.admin, route(null, '?q=' + f.admin.user.id))).body.total, 0);
  assert.equal((await f.readOnly(f.admin, route(null, '?q=' + encodeURIComponent(' needle ')))).body.total, 28, 'q retains literal spaces');
});

test('every matching visible SQL version is checked before pagination; nonmatching corrupt rows stay irrelevant', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 26; n++) f.imported(f.payload({ title: 'valid target ' + n, status: 'active' }), { createdAt: '2026-10-10T00:00:00.000Z' });
  const unsafe = f.imported(f.payload({ title: 'target unsafe', status: 'active' }), { version: 9007199254740993n, createdAt: '2020-01-01T00:00:00.000Z' });
  await f.readOnly(f.admin, route(null, '?q=target&pageSize=25'), 409, 'CALENDAR_DATA_INVALID');
  await f.readOnly(f.admin, route(unsafe), 409, 'CALENDAR_DATA_INVALID');
  await f.readOnly(f.admin, route(unsafe, '/history'), 409, 'CALENDAR_DATA_INVALID');
  await f.reject(f.admin, 'PATCH', route(unsafe), { version: 1, note: '不得寫入' }, 409, 'CALENDAR_DATA_INVALID');
  assert.equal((await f.readOnly(f.admin, route(null, '?q=valid'))).body.total, 26);
  for (const version of [0, -1, 1.5]) {
    const item = f.imported(f.payload({ title: 'invalid ' + version }), { version, savedVersions: [] });
    await f.readOnly(f.admin, route(item), 409, 'CALENDAR_DATA_INVALID');
  }
  const max = f.imported(f.payload({ title: 'safe maximum', status: 'active' }), { version: Number.MAX_SAFE_INTEGER });
  assert.equal((await f.readOnly(f.admin, route(max))).body.item.version, Number.MAX_SAFE_INTEGER);
  await f.reject(f.admin, 'PATCH', route(max), { version: Number.MAX_SAFE_INTEGER, title: 'overflow' }, 409, 'CALENDAR_DATA_INVALID');
});

test('CAS, Origin/CSRF and POST idempotency preserve transactions; different users have independent keys', async t => {
  const f = await fixture(t), payload = f.payload(), headers = { 'Idempotency-Key': 'synthetic-personal-one' }, protectedBefore = f.unrelated();
  const before = f.raw(), first = await f.request(f.admin, 'POST', route(), payload, headers); assert.equal(first.status, 201);
  const after = f.raw(); assert.equal(after.totalChanges - before.totalChanges, 4);
  const retry = await f.request(f.admin, 'POST', route(), payload, headers); assert.deepEqual(retry.body, first.body); assert.equal(retry.status, 201); assert.deepEqual(f.raw(), after);
  await f.reject(f.admin, 'POST', route(), f.payload({ title: '不同內容' }), 409, 'IDEMPOTENCY_CONFLICT', headers);
  const other = await f.create(entity, payload, f.clients.finance, headers); assert.notEqual(other.id, first.body.item.id); assert.equal(other.ownerUserId, f.clients.finance.user.id);
  const item = await f.patch(first.body.item, { title: '合成新版本' });
  await f.reject(f.admin, 'PATCH', route(item), { version: 1, note: 'stale' }, 409, 'VERSION_CONFLICT');
  for (const version of [null, 0, 1.5, '2', 9007199254740992]) await f.reject(f.admin, 'PATCH', route(item), { version, note: 'badversion' }, 422, 'VERSION_REQUIRED');
  await f.reject(f.admin, 'POST', route(), payload, 403, 'ORIGIN_FORBIDDEN', { Origin: 'https://foreign.example.test' });
  await f.reject(f.admin, 'PATCH', route(item), { version: 2, note: 'badcsrf' }, 403, 'CSRF_INVALID', { 'X-CSRF-Token': '0'.repeat(64) });
  await f.reject(null, 'POST', route(), payload, 401, 'AUTH_REQUIRED');
  for (const method of ['DELETE', 'PUT']) await f.reject(f.admin, method, route(item), undefined, 404, 'NOT_FOUND', {}, '{');
  await f.reject(f.admin, 'POST', route(item, '/unknown'), undefined, 404, 'NOT_FOUND', {}, '{');
  assert.deepEqual(f.unrelated(), protectedBefore);
});

test('each saved history owner/org is authorized before unsafe version, exact previous gaps never jump and actors use actual audit identities', async t => {
  const f = await fixture(t), item = f.imported(f.payload({ note: '合成第六版\r\n ', status: 'active' }), { version: 6, savedVersions: [] });
  function saved(version, overrides = {}, sqlVersion = version) {
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, sqlVersion, JSON.stringify({ ...item, version, note: '合成第' + version + '版\r\n ', ...overrides }), now(), 'synthetic-import');
  }
  saved(1); saved(2); saved(3, { ownerUserId: f.clients.supervisor.user.id }); saved(4); saved(5, { orgId: f.foreign.org }); saved(6);
  saved(9007199254740992, { ownerUserId: null }, 9007199254740993n);
  for (const [v, user] of [[1, f.admin.user], [2, f.clients.finance.user], [2, f.clients.finance.user], [4, f.admin.user], [4, f.clients.supervisor.user]]) {
    f.app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), f.admin.org, user.id, v === 1 ? 'record.create' : 'record.update', entity, item.id, JSON.stringify({ version: v }), now());
  }
  const response = (await f.readOnly(f.admin, route(item, '/history?compare=previous&pageSize=100'))).body;
  assert.deepEqual(response.items.map(x => x.version), [6, 4, 2, 1]);
  const by = new Map(response.items.map(x => [x.version, x]));
  assert.equal(by.get(1).comparison.status, 'initial'); assert.equal(by.get(1).actor.id, f.admin.user.id);
  assert.equal(by.get(2).comparison.previousVersion, 1); assert.equal(by.get(2).comparison.previousSnapshot.note, '合成第1版\r\n '); assert.equal(by.get(2).actor.id, f.clients.finance.user.id);
  for (const v of [4, 6]) assert.deepEqual(by.get(v).comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
  assert.equal(by.get(4).actor, null); assert.equal(by.get(6).actor, null);
  assert(!JSON.stringify(response).includes('ownerUserId":"' + f.clients.supervisor.user.id));
  await f.readOnly(f.clients.supervisor, route(item, '/history?compare=previous'), 404);
  const raw = (await f.readOnly(f.admin, route(item, '/history'))).body; assert(raw.items.every(x => !Object.hasOwn(x, 'actor') && !Object.hasOwn(x, 'comparison')));
});

test('visible invalid saved history identity/version rejects before pagination while hidden missing/typed owners cannot leak', async t => {
  const f = await fixture(t), item = f.imported(f.payload({ status: 'active' }), { savedVersions: [] });
  for (const [version, owner] of [[2, null], [3, 3], [4, {}], [5, []]]) {
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, version, JSON.stringify({ ...item, ownerUserId: owner, version }), now(), 'synthetic-import');
  }
  const missing = { ...item, version: 6 }; delete missing.ownerUserId;
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, 6, JSON.stringify(missing), now(), 'synthetic-import');
  for (const [version, rawSnapshot] of [[8, 'null'], [9, '[]'], [10, '{']]) f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, version, rawSnapshot, now(), 'synthetic-import');
  assert.equal((await f.readOnly(f.admin, route(item, '/history'))).body.total, 0);
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, item.id, 7, JSON.stringify({ ...item, version: 7, id: id() }), now(), 'synthetic-import');
  await f.readOnly(f.admin, route(item, '/history?page=2&pageSize=1'), 409, 'CALENDAR_DATA_INVALID');
  const unsafe = f.imported(f.payload({ status: 'active' }), { savedVersions: [] });
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, entity, unsafe.id, 9007199254740993n, JSON.stringify({ ...unsafe, version: 9007199254740992 }), now(), 'synthetic-import');
  await f.readOnly(f.admin, route(unsafe, '/history'), 409, 'CALENDAR_DATA_INVALID');
});

test('real event writes and read history leave protected cases, shifts, leaves, attachments and approved billing snapshots unchanged', async t => {
  const f = await fixture(t), caseItem = await f.create('cases', { name: '合成保護個案', caseNo: 'PC-CASE' });
  const service = await f.create('service-items', { code: 'PC-SERVICE', name: '合成保護服務', minutes: 60, unitPriceCents: 9876 });
  const plan = await f.create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
  const shift = await f.create('shifts', { caseId: caseItem.id, employeeId: f.employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: f.employee.id, date: shift.date, actualStart: shift.startTime, actualEnd: shift.endTime, services: shift.services, status: 'submitted' });
  const approved = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成原核閱' }); assert.equal(approved.status, 200);
  const billingBefore = (await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item.billingSnapshot; assert(billingBefore);
  await f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-11', startTime: '09:00', endTime: '10:00', type: '合成人工假', reason: '合成', status: 'approved' });
  const attachment = await f.request(f.admin, 'POST', '/api/case-attachments/upload', { caseId: caseItem.id, title: '合成原附件', ...filePayload(PDF_BYTES, '合成保護.pdf', 'application/pdf') }); assert.equal(attachment.status, 201);
  const certification = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成原證照', issuedOn: '2026-01-01' });
  const certFile = await f.request(f.admin, 'POST', '/api/certification-attachments/upload', { certificationId: certification.id, title: '合成原證照附件', ...filePayload(PDF_BYTES, '合成證照.pdf', 'application/pdf') }); assert.equal(certFile.status, 201);
  const protectedBefore = f.unrelated(); assert(protectedBefore.tables.attachment_files.some(x => x.content.length > 0));
  assert(protectedBefore.tables.certification_attachment_files.some(x => x.content.length > 0));
  for (const client of Object.values(f.clients)) {
    let item = await f.create(entity, f.payload({ title: '合成人工事件不取消既有班次' }), client);
    item = await f.patch(item, { note: '合成修改\r\n末句' }, client);
    item = await f.patch(item, { status: 'cancelled' }, client); item = await f.patch(item, { status: 'active' }, client);
    await f.readOnly(client, route()); await f.readOnly(client, route(item)); await f.readOnly(client, route(item, '/history?compare=previous'));
  }
  assert.deepEqual(f.unrelated(), protectedBefore);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item.billingSnapshot, billingBefore);
});
