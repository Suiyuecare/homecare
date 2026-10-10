import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { PDF_BYTES, filePayload } from './attachment-fixtures.mjs';

const entity = 'personal-calendar-events', prefix = '/api/' + entity, monthRoute = prefix + '/calendar';
const maximumBytes = 2 * 1024 * 1024;
const monthPath = (params = {}) => monthRoute + '?' + new URLSearchParams({ month: '2026-10', ...params });
const keys = ['month', 'q', 'status', 'orgId', 'ownerUserId', 'items', 'total', 'undatedCount'];
const password = 'synthetic-calendar-month-password';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, path, data, headers = {}, rawBody) {
    const hasBody = data !== undefined || rawBody !== undefined;
    const response = await fetch(base + path, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(hasBody ? { body: rawBody === undefined ? JSON.stringify(data) : rawBody } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成月份管理員', email: 'month-admin@example.test', password, organizationName: '合成月份機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(kind, data, client = admin, headers = {}) {
    const response = await request(client, 'POST', '/api/' + kind, data, headers);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  const employee = await create('employees', { name: '合成月份居服員', employeeNo: 'MONTH-EMP', hourlyRateCents: 12345 });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = 'month-' + role + '@example.test';
    await create('users', { name: '合成月份' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const organization = await create('organizations', { name: '合成月份機構乙' }), foreign = { ...admin, org: organization.id };
  const payload = overrides => ({ title: '合成月份事件', date: '2026-10-10', startTime: '09:00', endTime: '10:00', note: '', status: 'active', ...overrides });
  function imported(data, { owner = admin.user.id, includeOwner = true, orgId = admin.org, version = 1, recordId = id(), rawData, createdAt = '2026-10-01T00:00:00.000Z' } = {}) {
    const stored = { ...data, ...(includeOwner ? { ownerUserId: owner } : {}) };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, orgId, entity, rawData === undefined ? JSON.stringify(stored) : rawData, version, createdAt, createdAt);
    return { ...stored, id: recordId, orgId, version, createdAt, updatedAt: createdAt };
  }
  function raw() {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(row => row.type === 'table');
    assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
    return { schema, tables: Object.fromEntries(tables.map(row => {
      const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true);
      return [row.name, statement.all()];
    })), totalChanges: app.db.prepare('SELECT total_changes() n').get().n };
  }
  async function checked(client, method, path, status = 200, code, data, headers = {}, rawBody) {
    const before = raw(), response = await request(client, method, path, data, headers, rawBody);
    assert.equal(response.status, status, response.body.error ? JSON.stringify(response.body.error) : 'Unexpected HTTP status');
    if (code) assert.equal(response.body.error.code, code);
    assert.deepEqual(raw(), before, 'Month reads and rejected operations preserve eleven tables, six triggers, schema, all BLOB bytes and total_changes');
    return response.body;
  }
  const read = (client = admin, path = monthPath(), status = 200, code) => checked(client, 'GET', path, status, code);
  return { app, request, create, admin, clients, employee, foreign, payload, imported, raw, checked, read };
}

test('closed month envelope reads each of four roles own events and isolates even admin from other owners and institutions', async t => {
  const f = await fixture(t), owned = new Map();
  for (const [role, client] of Object.entries(f.clients)) {
    const item = await f.create(entity, f.payload({ title: '本人' + role }), client); owned.set(role, item);
  }
  const foreign = await f.create(entity, f.payload({ title: '同人不同機構' }), f.foreign);
  for (const [role, client] of Object.entries(f.clients)) {
    const response = await f.read(client);
    assert.deepEqual(Object.keys(response).sort(), keys.toSorted());
    assert.deepEqual(response, { month: '2026-10', q: '', status: '', orgId: client.org, ownerUserId: client.user.id, items: [owned.get(role)], total: 1, undatedCount: 0 });
    assert(!JSON.stringify(response).includes(foreign.id));
    for (const [otherRole, item] of owned) if (otherRole !== role) assert(!JSON.stringify(response).includes(item.id));
  }
  assert.deepEqual((await f.read(f.foreign)).items.map(item => item.id), [foreign.id]);
  const empty = await f.read(f.admin, monthPath({ month: '2026-11' })); assert.equal(empty.total, 0); assert.equal(empty.undatedCount, 0); assert.deepEqual(empty.items, []);
});

test('dedicated exact GET route preserves role-first, caregiver, authentication, Origin/CSRF and body-before-405 boundaries', async t => {
  const f = await fixture(t);
  await f.read(null, monthPath(), 401, 'AUTH_REQUIRED');
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'])
    await f.checked(f.admin, method, monthRoute + '?month=bad&extra=1', 405, 'METHOD_NOT_ALLOWED', undefined, { 'Content-Type': 'text/plain' }, '{');
  for (const path of [monthRoute + '/', monthRoute + '/extra', prefix + '/calendarish']) await f.read(f.admin, path, 404, 'NOT_FOUND');
  await f.checked(f.admin, 'POST', monthPath(), 403, 'ORIGIN_FORBIDDEN', undefined, { Origin: 'https://synthetic-foreign.example.test' }, '{');
  await f.checked(f.admin, 'POST', monthPath(), 403, 'CSRF_INVALID', undefined, { 'X-CSRF-Token': '0'.repeat(64) }, '{');
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('synthetic-unknown', f.foreign.org, f.admin.user.id);
  await f.read(f.foreign, monthRoute + '?month=bad&month=bad&ownerUserId=forged', 403, 'ROLE_FORBIDDEN');
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'])
    await f.checked(f.foreign, method, monthRoute + '?extra=1', 403, 'ROLE_FORBIDDEN', undefined, { 'Content-Type': 'text/plain' }, '{');
  const inactive = await f.request(f.admin, 'PATCH', '/api/employees/' + f.employee.id, { version: f.employee.version, status: 'inactive' }); assert.equal(inactive.status, 200);
  await f.read(f.clients.caregiver, monthPath(), 403, 'EMPLOYEE_LINK_REQUIRED');
});

test('closed three-key query rejects missing, duplicate, forged, malformed and out-of-range values without writes', async t => {
  const f = await fixture(t);
  for (const query of ['', 'month=', 'month=0000-01', 'month=10000-01', 'month=2026-00', 'month=2026-13', 'month=2026-1', 'month=026-01', 'month=2026-10-01', 'month=%202026-10', 'month=2026-10%0A'])
    await f.read(f.admin, monthRoute + '?' + query, 422, 'INVALID_DATE');
  for (const query of ['month=2026-10&month=2026-10', 'month=2026-10&q=a&q=b', 'month=2026-10&status=&status=active', 'month=2026-10&page=1', 'month=2026-10&pageSize=100', 'month=2026-10&date=2026-10-10', 'month=2026-10&ownerUserId=other', 'month=2026-10&orgId=other', 'month=2026-10&compare=previous'])
    await f.read(f.admin, monthRoute + '?' + query, 422, 'INVALID_QUERY');
  for (const status of ['unknown', 'ACTIVE', ' active', 'cancelled ']) await f.read(f.admin, monthPath({ status }), 422, 'INVALID_STATUS');
  await f.read(f.admin, monthPath({ q: '字'.repeat(201) }), 422, 'INVALID_QUERY');
  await f.read(f.admin, monthPath({ q: '😀'.repeat(101) }), 422, 'INVALID_QUERY');
  const q = '😀'.repeat(100), result = await f.read(f.admin, monthPath({ q, status: '' })); assert.equal(result.q, q); assert.equal(result.status, '');
});

test('Gregorian year boundaries and literal month dates separate valid other-month dates from undated typed or invalid dates', async t => {
  const f = await fixture(t);
  for (const date of ['0001-01-01', '2024-02-29', '2000-02-29', '9999-12-31', '2026-11-01']) f.imported(f.payload({ date }));
  const invalidDates = [undefined, null, false, 0, [], { private: 'synthetic-undated-hidden' }, '', '0000-01-01', '2023-02-29', '1900-02-29', '2026-02-30', '2026-10-10T00:00:00Z', ' 2026-10-10', '2026-10-10 '];
  const undated = invalidDates.map(date => f.imported(f.payload({ date, title: 'synthetic-undated-hidden' })));
  for (const month of ['0001-01', '2024-02', '2000-02', '9999-12', '2026-11']) {
    const response = await f.read(f.admin, monthPath({ month }));
    assert.equal(response.total, 1); assert.equal(response.items[0].date.slice(0, 7), month); assert.equal(response.undatedCount, invalidDates.length);
    for (const item of undated) assert(!JSON.stringify(response).includes(item.id));
    assert(!JSON.stringify(response).includes('synthetic-undated-hidden'));
  }
  const empty = await f.read(f.admin, monthPath({ month: '2026-10' })); assert.deepEqual(empty.items, []); assert.equal(empty.total, 0); assert.equal(empty.undatedCount, invalidDates.length);
});

test('q matches literal own string title or note independently; status filtering occurs before dating and safe versions', async t => {
  const f = await fixture(t), q = ' NEEDLE \r\n';
  const title = f.imported(f.payload({ title: 'prefix' + q.toLowerCase() + 'suffix', status: 'active' }));
  const note = f.imported(f.payload({ title: 'other', note: 'prefix' + q + 'suffix', status: 'cancelled' }));
  f.imported(f.payload({ title: 'NEEDLE', note: '', unknown: q }));
  f.imported(f.payload({ title: { nested: q }, note: [q] }));
  f.imported(f.payload({ title: ' NEED', note: 'LE \r\n' }));
  const unclassified = f.imported(f.payload({ title: q, status: 'legacy-status' }));
  const undated = f.imported(f.payload({ title: q, date: null, status: 'active' }));
  f.imported(f.payload({ title: 'unmatched poisoned', date: null }), { version: 9007199254740993n });
  f.imported(f.payload({ title: q, date: '2026-10-12', status: 'cancelled' }), { version: 9007199254740993n });
  const active = await f.read(f.admin, monthPath({ q, status: 'active' }));
  assert.equal(active.q, q); assert.equal(active.status, 'active'); assert.deepEqual(active.items.map(item => item.id), [title.id]); assert.equal(active.undatedCount, 1);
  assert(!JSON.stringify(active).includes(undated.id));
  await f.read(f.admin, monthPath({ q }), 409, 'CALENDAR_DATA_INVALID');
  const safeUnknown = await f.read(f.admin, monthPath({ q: 'prefix', status: '' })); assert.deepEqual(new Set(safeUnknown.items.map(item => item.id)), new Set([title.id, note.id]));
  const statusRaw = await f.read(f.admin, monthPath({ q: 'legacy-status' })); assert.equal(statusRaw.total, 0, 'status text is not searchable');
  assert.equal(unclassified.status, 'legacy-status');
});

test('full unpaginated month preserves raw six fields and own-presence and sorts date/time/id literally without coercion', async t => {
  const f = await fixture(t), expected = [];
  for (let index = 0; index < 29; index++) expected.push(f.imported(f.payload({ date: index % 2 ? '2026-10-11' : '2026-10-10', startTime: index % 3 ? '09:00' : '08:00', endTime: index % 4 ? '10:00' : '09:30', title: '  raw ' + index + '\t ', note: '\r\nfull raw note ' + index + '\r ' }), { createdAt: '2026-10-' + String(30 - index).padStart(2, '0') + 'T00:00:00.000Z' }));
  for (const values of [{ startTime: null, endTime: 0, title: false, note: { hidden: 'synthetic nested value' } }, { startTime: [], endTime: {}, title: null, status: null }, { startTime: 'not-a-time', endTime: '  end  ', note: ['hidden'] }]) expected.push(f.imported({ date: '2026-10-10', ...values }));
  expected.push(f.imported({ date: '2026-10-10', startTime: '09:00', endTime: '10:00', title: 'Tie a', extra: { unchanged: true } }, { recordId: '00000000-0000-0000-0000-000000000001' }));
  expected.push(f.imported({ date: '2026-10-10', startTime: '09:00', endTime: '10:00', title: 'Tie b' }, { recordId: '00000000-0000-0000-0000-000000000002' }));
  // Assert expected order independently through lexicographic arrays, not the server comparator.
  const tuple = item => ['date', 'startTime', 'endTime', 'id'].map(key => typeof item[key] === 'string' ? item[key] : '');
  expected.sort((a, b) => {
    const left = tuple(a), right = tuple(b);
    const different = left.findIndex((value, index) => value !== right[index]);
    return different === -1 ? 0 : left[different] < right[different] ? -1 : 1;
  });
  const response = await f.read(); assert.equal(response.total, 34); assert.equal(response.items.length, 34); assert.deepEqual(response.items, expected);
  const absent = response.items.find(item => item.id === '00000000-0000-0000-0000-000000000001'); assert(!Object.hasOwn(absent, 'note')); assert(!Object.hasOwn(absent, 'status')); assert.deepEqual(absent.extra, { unchanged: true });
  const list = await f.read(f.admin, prefix + '?pageSize=100');
  assert.deepEqual(new Map(list.items.map(item => [item.id, item])), new Map(response.items.map(item => [item.id, item])));
});

test('all matching monthly and undated versions are checked before count limits; other-month and invisible poison stays hidden', async t => {
  const f = await fixture(t), safe = f.imported(f.payload({ title: 'safe maximum' }), { version: Number.MAX_SAFE_INTEGER });
  f.imported(f.payload({ date: '2026-11-01' }), { version: 9007199254740993n });
  for (const owner of [f.clients.finance.user.id, null, 3, {}, []]) f.imported(f.payload({ date: null }), { owner, version: 9007199254740993n });
  f.imported(f.payload(), { includeOwner: false, version: 9007199254740993n });
  f.imported(f.payload(), { orgId: f.foreign.org, version: 9007199254740993n });
  for (const rawData of ['null', '[]', '3', '{']) f.imported({}, { rawData, version: 9007199254740993n });
  assert.deepEqual((await f.read()).items.map(item => item.id), [safe.id]);
  const poisoned = f.imported(f.payload({ date: null }), { version: 9007199254740993n });
  for (let index = 0; index < 1001; index++) f.imported(f.payload({ title: 'many ' + index }));
  await f.read(f.admin, monthPath(), 409, 'CALENDAR_DATA_INVALID');
  f.app.db.prepare('DELETE FROM records WHERE id=?').run(poisoned.id);
  await f.read(f.admin, monthPath(), 422, 'CALENDAR_LIMIT');
  const result = await f.read(f.admin, monthPath({ q: 'safe maximum' })); assert.equal(result.items[0].version, Number.MAX_SAFE_INTEGER);
});

test('matching invalid SQL identity or zero/unsafe version returns original 409 while filtered records do not block', async t => {
  const f = await fixture(t);
  for (const options of [{ version: 0 }, { version: 9007199254740993n }, { recordId: '' }]) {
    const monthly = f.imported(f.payload({ title: 'match bad' }), options);
    await f.read(f.admin, monthPath({ q: 'match bad' }), 409, 'CALENDAR_DATA_INVALID');
    assert.equal((await f.read(f.admin, monthPath({ q: 'unmatched' }))).total, 0);
    f.app.db.prepare('DELETE FROM records WHERE id=?').run(monthly.id);
    const undated = f.imported(f.payload({ title: 'match bad', date: false }), options);
    await f.read(f.admin, monthPath({ q: 'match bad' }), 409, 'CALENDAR_DATA_INVALID');
    f.app.db.prepare('DELETE FROM records WHERE id=?').run(undated.id);
  }
});

test('1000-item complete boundary accepts exactly, 1001 rejects with no partial response and filters can safely narrow', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 1000; index++) f.imported(f.payload({ title: 'bounded ' + index, status: index === 0 ? 'cancelled' : 'active' }));
  for (let index = 0; index < 4; index++) f.imported(f.payload({ date: null }));
  const boundary = await f.read(); assert.equal(boundary.total, 1000); assert.equal(boundary.items.length, 1000); assert.equal(boundary.undatedCount, 4);
  f.imported(f.payload({ title: 'bounded overflow' }));
  const error = await f.read(f.admin, monthPath(), 422, 'CALENDAR_LIMIT'); assert(!Object.hasOwn(error, 'items')); assert.equal(Object.keys(error).length, 1); assert.match(error.error.message, /搜尋文字.*狀態.*清單/);
  const narrowed = await f.read(f.admin, monthPath({ status: 'cancelled' })); assert.equal(narrowed.total, 1); assert.equal(narrowed.undatedCount, 0);
  assert.equal((await f.read(f.admin, monthPath({ q: 'bounded overflow' }))).total, 1);
});

test('2MiB UTF8 bound measures the complete serialized envelope including echoes and raw values, not character length', async t => {
  const f = await fixture(t), q = ' NEEDLE ', status = 'active';
  const item = f.imported(f.payload({ title: q, note: '' }));
  const envelope = { month: '2026-10', q, status, orgId: f.admin.org, ownerUserId: f.admin.user.id, items: [item], total: 1, undatedCount: 0 };
  const capacity = maximumBytes - Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  const note = '字'.repeat(Math.floor(capacity / 3)) + 'x'.repeat(capacity % 3);
  const saved = { ...f.payload({ title: q, note }), ownerUserId: f.admin.user.id };
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(saved), item.id);
  const exact = await f.read(f.admin, monthPath({ q, status })); assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), maximumBytes); assert.equal(exact.items[0].note, note); assert(note.length < maximumBytes);
  saved.note += 'x'; f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(saved), item.id);
  const oversized = await f.read(f.admin, monthPath({ q, status }), 422, 'CALENDAR_LIMIT'); assert(!Object.hasOwn(oversized, 'items'));
  // Query echo alone changes the full payload boundary: removing the literal q fits again.
  const smallerEcho = await f.read(f.admin, monthPath({ status })); assert.equal(smallerEcho.total, 1); assert.equal(smallerEcho.items[0].note, note + 'x');
  assert(Buffer.byteLength(JSON.stringify(smallerEcho), 'utf8') <= maximumBytes);
});

test('real saved events and history, both attachment BLOB stores and approved pricing snapshots remain byte-exact across month reads and failures', async t => {
  const f = await fixture(t), caseItem = await f.create('cases', { name: '合成月份保護個案', caseNo: 'MONTH-CASE' });
  const service = await f.create('service-items', { code: 'MONTH-SERVICE', name: '合成月份服務', minutes: 60, unitPriceCents: 9876 });
  const plan = await f.create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
  const shift = await f.create('shifts', { caseId: caseItem.id, employeeId: f.employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: f.employee.id, date: shift.date, actualStart: shift.startTime, actualEnd: shift.endTime, services: shift.services, status: 'submitted' });
  const approved = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成原核閱' }); assert.equal(approved.status, 200); assert(!Object.hasOwn(approved.body.item, 'billingSnapshot'));
  const billingSnapshot = (await f.read(f.admin, '/api/service-records/' + record.id)).item.billingSnapshot; assert(billingSnapshot);
  const attachment = await f.request(f.admin, 'POST', '/api/case-attachments/upload', { caseId: caseItem.id, title: '合成保護附件', ...filePayload(PDF_BYTES, '合成月份.pdf', 'application/pdf') }); assert.equal(attachment.status, 201);
  const certification = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成月份證照', issuedOn: '2026-01-01' });
  const certificationFile = await f.request(f.admin, 'POST', '/api/certification-attachments/upload', { certificationId: certification.id, title: '合成保護證照檔', ...filePayload(PDF_BYTES, '合成月份證照.pdf', 'application/pdf') }); assert.equal(certificationFile.status, 201);
  let event = await f.create(entity, f.payload({ title: '  合成原文\t ', note: '\r\n保存原文與末句\r ' }), f.admin, { 'Idempotency-Key': 'synthetic-month-event' });
  const updated = await f.request(f.admin, 'PATCH', prefix + '/' + event.id, { version: event.version, status: 'cancelled' }); assert.equal(updated.status, 200); event = updated.body.item;
  const historyPath = prefix + '/' + event.id + '/history?compare=previous';
  const historyBefore = await f.read(f.admin, historyPath), baseline = f.raw();
  assert(baseline.tables.attachment_files.some(row => row.content.length > 0)); assert(baseline.tables.certification_attachment_files.some(row => row.content.length > 0));
  assert.equal(baseline.tables.idempotency.filter(row => row.key === 'synthetic-month-event').length, 1);
  assert.deepEqual((await f.read()).items, [event]);
  assert.equal((await f.read(f.admin, monthPath({ status: 'active' }))).total, 0);
  await f.read(f.admin, monthPath({ month: '0000-01' }), 422, 'INVALID_DATE');
  await f.checked(f.admin, 'POST', monthPath(), 405, 'METHOD_NOT_ALLOWED', undefined, {}, '{');
  assert.deepEqual(await f.read(f.admin, historyPath), historyBefore);
  assert.deepEqual((await f.read(f.admin, '/api/service-records/' + record.id)).item.billingSnapshot, billingSnapshot);
  assert.deepEqual(f.raw(), baseline, 'Complete storage including event versions/actors, idempotency, BLOBs and approved snapshots remains byte-exact');
  assert.deepEqual(historyBefore.items.map(row => row.version), [2, 1]); assert(historyBefore.items.every(row => row.actor.id === f.admin.user.id));
});
