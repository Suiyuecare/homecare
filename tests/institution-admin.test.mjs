import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';

const password = 'synthetic-institution-admin-password';
const path = (entity, item, suffix = '') => `/api/${entity}${item ? '/' + item.id : ''}${suffix}`;

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  const request = async (client, method, route, data, headers = {}) => {
    const response = await fetch(base + route, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成機構管理員', email: 'institution-admin@example.test', password, organizationName: '合成機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken,
    org: setup.body.organizations[0].id, user: setup.body.user };
  const create = async (entity, data, client = admin, headers = {}) => {
    const result = await request(client, 'POST', path(entity), data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  };
  const employee = await create('employees', { name: '合成受理員工', employeeNo: 'INSTITUTION-EMP' });
  const caseItem = await create('cases', { name: '合成相關個案', caseNo: 'INSTITUTION-CASE' });
  const clients = { admin };
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = `institution-${role}@example.test`;
    await create('users', { name: '合成機構' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const event = overrides => ({ title: '合成機構會議', date: '2026-10-10', startTime: '09:00', endTime: '10:00', category: 'meeting', ...overrides });
  const complaint = overrides => ({ title: '合成服務申訴', receivedDate: '2026-10-10', category: 'service_quality', content: '合成申訴內容',
    receiverEmployeeId: employee.id, responsibleEmployeeId: employee.id, ...overrides });
  const patch = async (entity, item, values, client = admin) => {
    const result = await request(client, 'PATCH', path(entity, item), { version: item.version, ...values });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  };
  const raw = () => {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    return { schema, tables: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name,
      app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all()])) };
  };
  const changes = () => app.db.prepare('SELECT total_changes() n').get().n;
  const foreign = async () => {
    const organization = await create('organizations', { name: '合成機構乙' });
    const client = { ...admin, org: organization.id };
    const employee = await create('employees', { name: 'SYNTHETIC-FOREIGN-EMPLOYEE', employeeNo: 'FOREIGN-EMP' }, client);
    const caseItem = await create('cases', { name: 'SYNTHETIC-FOREIGN-CASE', caseNo: 'FOREIGN-CASE' }, client);
    const eventItem = await create('institution-events', event({ title: 'SYNTHETIC-FOREIGN-EVENT' }), client);
    const complaintItem = await create('complaints', complaint({ title: 'SYNTHETIC-FOREIGN-COMPLAINT', receiverEmployeeId: employee.id, responsibleEmployeeId: employee.id }), client);
    return { client, employee, caseItem, eventItem, complaintItem };
  };
  return { app, request, admin, clients, employee, caseItem, event, complaint, create, patch, raw, changes, foreign };
}

test('institution events are common to four roles but only admin and supervisor can maintain them', async t => {
  const f = await fixture(t);
  const item = await f.create('institution-events', f.event({ title: ' 合成會議 ', note: ' 合成備註\n第二行 ' }), f.clients.supervisor);
  assert.equal(item.title, '合成會議'); assert.equal(item.note, '合成備註\n第二行'); assert.equal(item.location, ''); assert.equal(item.status, 'active');
  const before = f.raw(), totalChanges = f.changes();
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const client = f.clients[role];
    assert.equal((await f.request(client, 'GET', path('institution-events'))).body.total, 1);
    assert.deepEqual((await f.request(client, 'GET', path('institution-events', item))).body.item, item);
    assert.equal((await f.request(client, 'GET', path('institution-events', item, '/history?compare=previous'))).body.items.length, 1);
  }
  for (const role of ['finance', 'caregiver']) {
    assert.equal((await f.request(f.clients[role], 'POST', path('institution-events'), f.event())).status, 403);
    assert.equal((await f.request(f.clients[role], 'PATCH', path('institution-events', item), { version: 1, note: '合成越權' })).status, 403);
  }
  assert.deepEqual(f.raw(), before); assert.equal(f.changes(), totalChanges);
});

test('complaints reject finance and caregiver every known method and history before revealing records', async t => {
  const f = await fixture(t), item = await f.create('complaints', f.complaint()), before = f.raw();
  for (const role of ['finance', 'caregiver']) for (const target of [undefined, item, { id: randomUUID() }]) {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      const result = await f.request(f.clients[role], method, path('complaints', target) + '?unknown=1', method === 'GET' ? undefined : { unknown: true });
      assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN');
    }
    if (target) assert.equal((await f.request(f.clients[role], 'GET', path('complaints', target, '/history?compare=wrong'))).status, 403);
  }
  assert.deepEqual(f.raw(), before);
});

test('both entities isolate current, patch and precise history by institution and record kind', async t => {
  const f = await fixture(t), ownEvent = await f.create('institution-events', f.event()), ownComplaint = await f.create('complaints', f.complaint()), foreign = await f.foreign(), before = f.raw();
  for (const client of [f.admin, f.clients.supervisor]) for (const [entity, own, remote] of [['institution-events', ownEvent, foreign.eventItem], ['complaints', ownComplaint, foreign.complaintItem]]) {
    for (const target of [remote, f.employee, { id: randomUUID() }]) {
      for (const suffix of ['', '/history', '/history?compare=previous']) {
        const response = await f.request(client, 'GET', path(entity, target, suffix)); assert.equal(response.status, 404);
        assert(!JSON.stringify(response.body).includes('SYNTHETIC-FOREIGN'));
      }
      assert.equal((await f.request(client, 'PATCH', path(entity, target), { version: 1, title: '合成越界改寫' })).status, 404);
    }
    assert.equal((await f.request(client, 'GET', path(entity))).body.total, 1);
    assert.equal((await f.request(foreign.client, 'GET', path(entity, own))).status, 404);
  }
  assert.deepEqual(f.raw(), before);
});

test('complaint employees and optional case references must belong to the current institution', async t => {
  const f = await fixture(t), foreign = await f.foreign(), before = f.raw(), totalChanges = f.changes();
  for (const overrides of [{ receiverEmployeeId: foreign.employee.id }, { responsibleEmployeeId: foreign.employee.id }, { employeeId: foreign.employee.id }, { caseId: foreign.caseItem.id },
    { receiverEmployeeId: randomUUID() }, { responsibleEmployeeId: '' }, { caseId: f.employee.id }, { employeeId: f.caseItem.id }]) {
    assert.equal((await f.request(f.admin, 'POST', path('complaints'), f.complaint(overrides))).status, 422);
  }
  assert.deepEqual(f.raw(), before); assert.equal(f.changes(), totalChanges);
  const own = await f.create('complaints', f.complaint({ caseId: f.caseItem.id, employeeId: f.employee.id }));
  assert.equal(own.caseId, f.caseItem.id); assert.equal(own.employeeId, f.employee.id);
});

test('complaint state transitions require manual reception, result and valid closure date', async t => {
  const f = await fixture(t);
  let item = await f.create('complaints', f.complaint()); assert.equal(item.status, 'received');
  let before = f.raw();
  for (const overrides of [{ status: 'closed', closedDate: '2026-10-11', resolution: '合成結果' }, { status: 'in_progress' }, { status: 'cancelled', resolution: '合成取消' }])
    assert.equal((await f.request(f.admin, 'POST', path('complaints'), f.complaint(overrides))).status, 422);
  assert.equal((await f.request(f.admin, 'PATCH', path('complaints', item), { version: 1, status: 'closed', resolution: '合成結果', closedDate: '2026-10-11' })).status, 409);
  assert.deepEqual(f.raw(), before);
  item = await f.patch('complaints', item, { status: 'in_progress', handlingLog: '合成處理紀錄' }, f.clients.supervisor);
  before = f.raw();
  for (const values of [{ status: 'received' }, { status: 'closed' }, { status: 'closed', resolution: '合成結果' }, { status: 'closed', resolution: '合成結果', closedDate: '2026-10-09' },
    { status: 'closed', resolution: '合成結果', closedDate: '2026-02-29' }, { status: 'cancelled' }])
    assert([409, 422].includes((await f.request(f.admin, 'PATCH', path('complaints', item), { version: item.version, ...values })).status));
  assert.deepEqual(f.raw(), before);
  item = await f.patch('complaints', item, { status: 'closed', resolution: '合成處理完成', closedDate: '2026-10-11' }); assert.equal(item.version, 3);
  before = f.raw();
  for (const status of ['received', 'in_progress', 'cancelled']) assert.equal((await f.request(f.admin, 'PATCH', path('complaints', item), { version: item.version, status })).status, 409);
  assert.deepEqual(f.raw(), before);
  item = await f.patch('complaints', item, { resolution: '合成更正結果' }); assert.equal(item.status, 'closed'); assert.equal(item.version, 4);
});

test('cancelled complaint retains history, needs a reason and cannot silently reopen', async t => {
  const f = await fixture(t); let item = await f.create('complaints', f.complaint());
  const before = f.raw();
  assert.equal((await f.request(f.admin, 'PATCH', path('complaints', item), { version: 1, status: 'cancelled' })).status, 422);
  assert.equal((await f.request(f.admin, 'PATCH', path('complaints', item), { version: 1, status: 'cancelled', resolution: '合成取消', closedDate: '2026-10-10' })).status, 422);
  assert.deepEqual(f.raw(), before);
  item = await f.patch('complaints', item, { status: 'cancelled', resolution: '合成申訴撤回' });
  assert.equal((await f.request(f.admin, 'PATCH', path('complaints', item), { version: item.version, status: 'received' })).status, 409);
  const history = (await f.request(f.admin, 'GET', path('complaints', item, '/history?compare=previous'))).body.items;
  assert.equal(history.length, 2); assert.equal(history[0].comparison.previousSnapshot.status, 'received'); assert.equal(history[0].snapshot.resolution, '合成申訴撤回');
});

test('event time/date/status/text validation and complaint required fields reject atomically', async t => {
  const f = await fixture(t), before = f.raw(), totalChanges = f.changes();
  const badEvents = [{ title: ' ' }, { title: '合成\n會議' }, { title: '字'.repeat(201) }, { date: '0000-01-01' }, { date: '2026-02-29' }, { date: '2026-1-01' },
    { startTime: '24:00' }, { startTime: '9:00' }, { startTime: '10:00', endTime: '10:00' }, { endTime: '08:00' }, { category: 'holiday' }, { status: 'completed' },
    { location: '字'.repeat(301) }, { location: '合成\n地點' }, { note: '字'.repeat(10001) }, { note: {} }, { orgId: f.admin.org }, { version: 1 }];
  for (const value of badEvents) assert.equal((await f.request(f.admin, 'POST', path('institution-events'), f.event(value))).status, 422, JSON.stringify(value));
  const badComplaints = [{ receivedDate: '0000-01-01' }, { receivedDate: '2026-02-29' }, { category: 'unapproved' }, { content: ' ' }, { content: '字'.repeat(10001) },
    { handlingLog: null }, { resolution: [] }, { closedDate: '2026-10-10' }, { title: '合成\r\n申訴' }, { status: 'pending' }, { receiverEmployeeId: null }];
  for (const value of badComplaints) assert.equal((await f.request(f.admin, 'POST', path('complaints'), f.complaint(value))).status, 422, JSON.stringify(value));
  for (const key of ['title', 'receivedDate', 'category', 'content', 'receiverEmployeeId', 'responsibleEmployeeId']) {
    const payload = f.complaint(); delete payload[key]; assert.equal((await f.request(f.admin, 'POST', path('complaints'), payload)).status, 422);
  }
  assert.deepEqual(f.raw(), before); assert.equal(f.changes(), totalChanges);
});

test('10000-character complaint and event text is retained exactly without widening unrelated field limits', async t => {
  const f = await fixture(t);
  const item = await f.create('complaints', f.complaint({ content: '字'.repeat(10000), handlingLog: '紀'.repeat(10000), resolution: '結'.repeat(10000) }));
  assert.equal(item.content.length, 10000); assert.equal(item.handlingLog.length, 10000); assert.equal(item.resolution.length, 10000);
  const event = await f.create('institution-events', f.event({ note: '字'.repeat(10000), date: '9999-12-31' })); assert.equal(event.note.length, 10000);
  const before = f.raw(); assert.equal((await f.request(f.admin, 'POST', '/api/employees', { name: '字'.repeat(501), employeeNo: 'SYNTHETIC-TOO-LONG' })).status, 422);
  assert.deepEqual(f.raw(), before);
});

test('closed list/history queries reject unknown duplicate invalid and overlarge pagination values', async t => {
  const f = await fixture(t), event = await f.create('institution-events', f.event()), complaint = await f.create('complaints', f.complaint()), before = f.raw();
  for (const [entity, item, dateKey] of [['institution-events', event, 'date'], ['complaints', complaint, 'receivedDate']]) {
    const invalid = ['unknown=1', 'month=2026-10', 'caseId=x', 'employeeId=x', 'q=' + '字'.repeat(201), 'status=', 'status=bogus', 'category=', 'category=bogus',
      dateKey + '=', dateKey + '=2026-02-29', dateKey + '=0000-01-01', 'page=0', 'page=1.5', 'page=01', 'page=9007199254740991', 'pageSize=0', 'pageSize=101', 'compare=previous'];
    for (const key of ['page', 'pageSize', 'q', 'status', 'category', dateKey]) invalid.push(`${key}=1&${key}=1`);
    for (const query of invalid) for (const target of [undefined, item]) assert.equal((await f.request(f.admin, 'GET', path(entity, target) + '?' + query)).status, 422, entity + ':' + query);
    for (const query of ['unknown=1', 'q=secret', 'compare=wrong', 'compare=previous&compare=previous', 'page=0'])
      assert.equal((await f.request(f.admin, 'GET', path(entity, item, '/history?' + query))).status, 422);
  }
  assert.deepEqual(f.raw(), before);
});

test('server pagination applies all date/status/category/text filters and does not search IDs', async t => {
  const f = await fixture(t), ids = [];
  for (let n = 1; n <= 28; n++) ids.push((await f.create('institution-events', f.event({ title: '合成共同會議' + n, category: n === 28 ? 'training' : 'meeting' }))).id);
  await f.create('institution-events', f.event({ title: '合成共同另一日', date: '2026-10-11' }));
  const first = (await f.request(f.clients.caregiver, 'GET', '/api/institution-events?date=2026-10-10&q=合成共同')).body;
  const second = (await f.request(f.clients.finance, 'GET', '/api/institution-events?date=2026-10-10&q=合成共同&page=2')).body;
  assert.equal(first.total, 28); assert.equal(first.items.length, 25); assert.equal(second.items.length, 3);
  assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set(ids));
  assert.equal((await f.request(f.admin, 'GET', '/api/institution-events?date=2026-10-10&category=training&status=active&q=合成共同')).body.total, 1);
  const complaint = await f.create('complaints', f.complaint({ handlingLog: '合成專用處理文字' }));
  assert.equal((await f.request(f.admin, 'GET', '/api/complaints?q=合成專用處理文字&receivedDate=2026-10-10')).body.total, 1);
  assert.equal((await f.request(f.admin, 'GET', '/api/complaints?q=' + encodeURIComponent(f.employee.id))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', '/api/complaints?q=' + complaint.id)).body.total, 0);
});

test('new creates are idempotent, changed payload conflicts and bad CSRF writes nothing', async t => {
  const f = await fixture(t);
  for (const [entity, payload] of [['institution-events', f.event()], ['complaints', f.complaint()]]) {
    const headers = { 'Idempotency-Key': `synthetic-${entity}-once` };
    const one = await f.request(f.admin, 'POST', path(entity), payload, headers); assert.equal(one.status, 201);
    const before = f.raw(), totalChanges = f.changes();
    const repeated = await f.request(f.admin, 'POST', path(entity), payload, headers); assert.deepEqual(repeated.body, one.body); assert.equal(repeated.status, 201);
    assert.equal((await f.request(f.admin, 'POST', path(entity), { ...payload, title: '合成不同標題' }, headers)).status, 409);
    assert.equal((await f.request(f.admin, 'POST', path(entity), payload, { 'X-CSRF-Token': 'synthetic-wrong-token' })).status, 403);
    assert.equal((await f.request(f.admin, 'PATCH', path(entity, one.body.item), { version: 1, title: '合成錯誤CSRF' }, { 'X-CSRF-Token': 'synthetic-wrong-token' })).status, 403);
    assert.deepEqual(f.raw(), before); assert.equal(f.changes(), totalChanges);
  }
});

test('competing updates retain exactly one new version and actual actor with immutable precise history', async t => {
  const f = await fixture(t);
  for (const [entity, payload, key] of [['institution-events', f.event(), 'note'], ['complaints', f.complaint(), 'handlingLog']]) {
    const item = await f.create(entity, payload), before = f.raw();
    for (const version of [undefined, 0, '1', 1.5]) assert.equal((await f.request(f.admin, 'PATCH', path(entity, item), { version, [key]: '合成無版次' })).status, 422);
    assert.deepEqual(f.raw(), before);
    const competing = await Promise.all([f.request(f.admin, 'PATCH', path(entity, item), { version: 1, [key]: '合成競爭甲' }),
      f.request(f.clients.supervisor, 'PATCH', path(entity, item), { version: 1, [key]: '合成競爭乙' })]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    const history = (await f.request(f.admin, 'GET', path(entity, item, '/history?compare=previous'))).body.items;
    assert.equal(history.length, 2); assert.equal(history[0].snapshot.version, 2); assert.equal(history[0].comparison.previousVersion, 1);
    assert.equal(history[1].actor.id, f.admin.user.id);
    assert.equal(history[0].actor.id, competing[0].status === 200 ? f.admin.user.id : f.clients.supervisor.user.id);
    assert.throws(() => f.app.db.prepare('UPDATE record_versions SET snapshot=? WHERE record_id=?').run('{}', item.id), /immutable/);
    assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(item.id), /immutable/);
    assert.equal((await f.request(f.admin, 'DELETE', path(entity, item))).status, 404);
  }
});

test('manual institutional events never assign shifts or modify leave, assessments and financial snapshots', async t => {
  const f = await fixture(t), before = f.raw();
  let event = await f.create('institution-events', f.event({ category: 'training' }));
  event = await f.patch('institution-events', event, { status: 'cancelled' });
  await f.patch('institution-events', event, { status: 'active', note: '合成人工恢復' });
  const after = f.raw();
  for (const table of Object.keys(before.tables)) {
    if (table === 'records' || table === 'record_versions' || table === 'audit') {
      const key = table === 'records' ? 'entity' : 'entity';
      assert.deepEqual(after.tables[table].filter(row => row[key] !== 'institution-events'), before.tables[table]);
    } else assert.deepEqual(after.tables[table], before.tables[table]);
  }
});
