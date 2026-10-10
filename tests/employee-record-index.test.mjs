import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const entityCodes = ['employee-certifications', 'employee-training', 'leave-requests'];
const rowKeys = ['entity', 'id', 'orgId', 'employeeId', 'version', 'updatedAt'];
const envelopeKeys = ['items', 'total', 'page', 'pageSize', 'entity', 'orgId', 'employeeId'];
const password = 'synthetic-employee-record-index-password';
const indexPath = (parent, query = 'entity=employee-certifications') => '/api/employees/' + parent.id + '/record-index' + (query === null ? '' : '?' + query);
const keys = (actual, expected) => assert.deepEqual(Object.keys(actual).sort(), [...expected].sort());
const assertError = (response, status, code) => { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body?.error.code, code); };

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  assert.equal(app.dbPath, ':memory:'); assert.notEqual(new URL(base).port, '4310');
  t.after(() => app.close());
  async function request(client, method, path, data, headers = {}, rawBody) {
    const hasBody = data !== undefined || rawBody !== undefined;
    const response = await fetch(base + path, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(hasBody ? { body: rawBody === undefined ? JSON.stringify(data) : rawBody } : {}) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成索引管理者', email: 'employee-index-admin@example.test', password, organizationName: '合成索引機構甲' });
  assert.equal(setup.status, 201);
  const clientFrom = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, client = admin) {
    const result = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, client = admin) {
    const result = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成索引居服員', employeeNo: 'INDEX-E', hourlyRateCents: 24123 });
  const employeeA = employee, employeeB = await create('employees', { name: employee.name, employeeNo: 'INDEX-SAME-NAME' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = 'employee-index-' + role + '@example.test';
    await create('users', { name: '合成索引' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成同名索引個案', caseNo: 'INDEX-A' }), caseB = await create('cases', { name: '合成同名索引個案', caseNo: 'INDEX-B' });
  const service = await create('service-items', { code: 'INDEX-S', name: '合成保存服務', minutes: 60, unitPriceCents: 12345 });
  const services = [{ serviceItemId: service.id, quantity: 2 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services });
  const submitted = await create('service-records', { caseId: caseA.id, employeeId: employee.id, shiftId: shift.id, date: shift.date, actualStart: '09:03', actualEnd: '09:54', services, status: 'submitted', note: '合成原紀錄' });
  const review = await request(clients.supervisor, 'POST', '/api/service-records/' + submitted.id + '/review', { version: 1, decision: 'approved', reviewNote: '合成原核閱' });
  assert.equal(review.status, 200);
  const approvedResult = await request(admin, 'GET', '/api/service-records/' + submitted.id);
  assert.equal(approvedResult.status, 200); const approved = approvedResult.body.item; assert(Object.hasOwn(approved, 'billingSnapshot'));
  const certification = await create('employee-certifications', { employeeId: employee.id, name: '合成索引證照', issuedOn: '2026-01-01' });
  const attachment = await create('case-attachments/upload', { caseId: caseA.id, title: '合成索引PDF', ...filePayload(PDF_BYTES) });
  const certAttachment = await create('certification-attachments/upload', { certificationId: certification.id, title: '合成索引PNG', ...filePayload(PNG_BYTES, '合成索引.png', 'image/png') });
  function state() {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(row => row.type === 'table'); assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
    const contents = Object.fromEntries(tables.map(row => { const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [row.name, statement.all()]; }));
    assert.equal(contents.attachment_files.length, 1); assert.equal(contents.certification_attachment_files.length, 1);
    return { schema, tables: contents, changes: app.db.prepare('SELECT total_changes() n').get().n };
  }
  async function read(client = admin, path = indexPath(employeeA), method = 'GET', data, headers = {}, rawBody) {
    const before = state(), result = await request(client, method, path, data, headers, rawBody);
    assert.deepEqual(state(), before, 'Index/read/rejected operation changed raw tables/schema/triggers/total_changes: ' + method + ' ' + path);
    return result;
  }
  function imported(entity, data, options = {}) {
    const recordId = options.id ?? id(), org = options.org ?? admin.org, version = options.version ?? 1, created = options.created ?? now(), updated = options.updated ?? created;
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, org, entity, options.rawData ?? JSON.stringify(data), version, created, updated);
    return { id: recordId, orgId: org, version, entity, employeeId: data?.employeeId, updatedAt: updated };
  }
  async function foreign() {
    const organization = await create('organizations', { name: '合成索引機構乙' }), client = { ...admin, org: organization.id };
    const parent = await create('employees', { name: employeeA.name, employeeNo: 'INDEX-FOREIGN' }, client);
    return { client, parent };
  }
  return { app, admin, clients, employee, employeeA, employeeB, certification, caseA, caseB, plan, shift, approved, attachment, certAttachment, services, create, patch, request, read, state, imported, foreign };
}

test('three current employee indexes include every saved status with exact metadata-only DTO and scope echoes', async t => {
  const f = await fixture(t), statuses = { 'employee-certifications': ['active', 'revoked'], 'employee-training': ['completed', 'cancelled'], 'leave-requests': ['pending', 'approved', 'rejected', 'cancelled'] };
  for (const entity of entityCodes) {
    const expected = new Set();
    for (const status of [...statuses[entity], 'SYNTHETIC-UNKNOWN-STATUS']) expected.add(f.imported(entity, { employeeId: f.employeeB.id, status, name: 'HIDDEN-NAME', note: 'HIDDEN-BUSINESS-MARKER', reason: 'HIDDEN-LEAVE', hourlyRateCents: 54321, billingSnapshot: { marker: 'HIDDEN-PRICE' } }).id);
    for (const actor of [f.admin, f.clients.supervisor]) {
      const result = await f.read(actor, indexPath(f.employeeB, 'entity=' + entity)); assert.equal(result.status, 200);
      keys(result.body, envelopeKeys); assert.equal(result.body.entity, entity); assert.equal(result.body.orgId, f.admin.org); assert.equal(result.body.employeeId, f.employeeB.id);
      assert.equal(result.body.page, 1); assert.equal(result.body.pageSize, 25); assert.equal(result.body.total, expected.size);
      assert.deepEqual(new Set(result.body.items.map(row => row.id)), expected);
      for (const row of result.body.items) { keys(row, rowKeys); assert.equal(row.entity, entity); assert.equal(row.orgId, f.admin.org); assert.equal(row.employeeId, f.employeeB.id); assert.equal(row.version, 1); }
      for (const marker of ['HIDDEN-', 'hourlyRateCents', 'status', 'snapshot', 'actor', 'createdAt']) assert(!JSON.stringify(result.body).includes(marker));
    }
  }
});

test('same-org SQL employee parents remain precise with same names and inactive status; foreign/wrong-entity parents404', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  const one = f.imported('employee-training', { employeeId: f.employeeA.id }), two = f.imported('employee-training', { employeeId: f.employeeB.id });
  let parent = f.employeeB;
  for (const status of ['inactive', 'active']) {
    parent = await f.patch('employees', parent, { status });
    assert.deepEqual((await f.read(f.clients.supervisor, indexPath(parent, 'entity=employee-training'))).body.items.map(row => row.id), [two.id]);
    assert.deepEqual((await f.read(f.admin, indexPath(f.employeeA, 'entity=employee-training'))).body.items.map(row => row.id), [one.id]);
  }
  const spoofed = f.imported('cases', { employeeId: f.employeeA.id, entity: 'employees', id: f.employeeA.id });
  for (const parentId of [foreign.parent.id, f.caseA.id, spoofed.id, id()]) assertError(await f.read(f.admin, indexPath({ id: parentId })), 404, 'NOT_FOUND');
  assert.equal((await f.read(foreign.client, indexPath(foreign.parent))).body.total, 0);
  assertError(await f.read(foreign.client, indexPath(f.employeeA)), 404, 'NOT_FOUND');
});

test('parent and candidate identities come from SQL, ignoring shadow employee body metadata and raw update text formatting', async t => {
  const f = await fixture(t), rawTime = ' 原更新文字\r\n<script>literal</script> ' + '時'.repeat(1800), longId = 'a'.repeat(1200) + '-f';
  const parent = f.imported('employees', { id: f.employeeA.id, orgId: 'HIDDEN-FOREIGN', entity: 'cases', status: 'inactive' });
  const item = f.imported('employee-training', { employeeId: parent.id, id: f.employeeA.id, orgId: 'HIDDEN-SPOOF', entity: 'leave-requests', version: 999, updatedAt: 'HIDDEN-TIME', createdAt: 'HIDDEN-CREATED' }, { id: longId, version: 7, updated: rawTime });
  const result = await f.read(f.admin, indexPath(parent, 'entity=employee-training')); assert.equal(result.status, 200);
  assert.equal(result.body.employeeId, parent.id);
  assert.deepEqual(result.body.items, [{ entity: 'employee-training', id: item.id, orgId: f.admin.org, employeeId: parent.id, version: 7, updatedAt: rawTime }]);
  const emptyTime = f.imported('employee-training', { employeeId: parent.id }, { updated: '' });
  assert.equal((await f.read(f.admin, indexPath(parent, 'entity=employee-training'))).body.items.find(row => row.id === emptyTime.id).updatedAt, '');
  f.app.db.prepare('UPDATE records SET updated_at=? WHERE id=?').run(Buffer.from('SYNTHETIC-BLOB-TIMESTAMP'), emptyTime.id);
  assertError(await f.read(f.admin, indexPath(parent, 'entity=employee-training')), 409, 'EMPLOYEE_RECORD_INDEX_INVALID');
  f.app.db.prepare('UPDATE records SET updated_at=? WHERE id=?').run('restored raw text', emptyTime.id);
  for (const badId of ['', 'uppercase-A', 'not-hex-id']) {
    const malformed = f.imported('employee-training', { employeeId: parent.id }, { id: badId });
    assertError(await f.read(f.admin, indexPath(parent, 'entity=employee-training')), 409, 'EMPLOYEE_RECORD_INDEX_INVALID');
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ employeeId: f.employeeA.id }), malformed.id);
  }
});

test('closed query and lexical pagination reject missing/duplicate/unknown params without trimming or coercion', async t => {
  const f = await fixture(t), entity = 'employee-certifications';
  const invalid = [null, '', 'entity=', 'entity=employees', 'entity=Employee-training', 'entity=%20employee-training', 'entity=employee-training%20', 'entity=employee-training&entity=employee-training'];
  for (const key of ['q', 'status', 'employeeId', 'caseId', 'compare', 'date', 'unknown']) invalid.push('entity=' + entity + '&' + key + '=');
  for (const key of ['page', 'pageSize']) {
    invalid.push('entity=' + entity + '&' + key + '=1&' + key + '=1');
    for (const value of ['', '0', '-1', '+1', '01', '1.0', '1e1', 'NaN', 'Infinity', ' 1', '1 ', '9007199254740992']) invalid.push('entity=' + entity + '&' + key + '=' + encodeURIComponent(value));
  }
  invalid.push('entity=' + entity + '&pageSize=101');
  for (const query of invalid) assert.equal((await f.read(f.admin, indexPath(f.employeeA, query))).status, 422, String(query));
  const maximum = await f.read(f.admin, indexPath(f.employeeA, 'entity=' + entity + '&page=9007199254740991&pageSize=100'));
  assert.equal(maximum.status, 200); assert.equal(maximum.body.total, 1); assert.deepEqual(maximum.body.items, []); assert.equal(maximum.body.pageSize, 100);
});

test('finance/caregiver/unknown roles are forbidden before query/method/body parsing; existing read permissions stay unchanged', async t => {
  const f = await fixture(t);
  const leave = await f.create('leave-requests', { employeeId: f.employeeA.id, date: '2026-10-11', startTime: '09:00', endTime: '10:00', type: '合成測試假別', reason: '合成保存原因' });
  for (const role of ['finance', 'caregiver']) {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) assertError(await f.read(f.clients[role], indexPath(f.employeeA, 'unknown=1&page=0'), method, undefined, { 'Content-Type': 'text/plain' }, ['GET', 'OPTIONS'].includes(method) ? undefined : '{'), 403, 'ROLE_FORBIDDEN');
    assert.equal((await f.read(f.clients[role], indexPath(f.employeeA), 'HEAD')).status, 403);
    assert.equal((await f.read(f.clients[role], '/api/employees/' + f.employeeA.id)).status, 200);
    assert.equal((await f.read(f.clients[role], '/api/leave-requests/' + leave.id + '/history?compare=previous')).status, 200);
  }
  assert.equal((await f.read(f.clients.caregiver, '/api/employee-certifications/' + f.certification.id + '/history?compare=previous')).status, 200);
  assertError(await f.read(f.clients.finance, '/api/employee-certifications/' + f.certification.id), 403, 'ROLE_FORBIDDEN');
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('synthetic-unknown-role', f.admin.org, f.clients.finance.user.id);
  assertError(await f.read(f.clients.finance, indexPath(f.employeeA, 'unknown=x'), 'POST', undefined, { 'Content-Type': 'text/plain' }, '{'), 403, 'ROLE_FORBIDDEN');
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance', f.admin.org, f.clients.finance.user.id);
  assertError(await f.read(null), 401, 'AUTH_REQUIRED');
  assertError(await f.read({ ...f.admin, org: '' }), 400, 'ORG_REQUIRED');
  assertError(await f.read({ ...f.admin, org: id() }), 403, 'ORG_FORBIDDEN');
});

test('authorized nonGET returns405 without body or idempotency consumption; original Origin/CSRF guards stay enforced', async t => {
  const f = await fixture(t);
  for (const actor of [f.admin, f.clients.supervisor]) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assertError(await f.read(actor, indexPath(f.employeeA, 'unknown=1'), method, undefined, { 'Content-Type': 'text/plain', 'Idempotency-Key': 'bad key' }, '{'), 405, 'METHOD_NOT_ALLOWED');
      assertError(await f.read(actor, indexPath(f.employeeA), method, undefined, {}, '{"unknown":"' + 'X'.repeat(140000) + '"}'), 405, 'METHOD_NOT_ALLOWED');
    }
    assertError(await f.read(actor, indexPath(f.employeeA), 'OPTIONS'), 405, 'METHOD_NOT_ALLOWED');
    assert.equal((await f.read(actor, indexPath(f.employeeA), 'HEAD')).status, 405);
  }
  assertError(await f.read(f.admin, indexPath(f.employeeA), 'POST', {}, { 'X-CSRF-Token': '' }), 403, 'CSRF_INVALID');
  assertError(await f.read(f.admin, indexPath(f.employeeA), 'POST', {}, { Origin: 'https://synthetic-wrong-origin.example.test' }), 403, 'ORIGIN_FORBIDDEN');
  for (const path of [indexPath(f.employeeA).split('?')[0] + '/', indexPath(f.employeeA).split('?')[0] + '/history', '/api/employees/not-routable/record-index?entity=employee-training']) assertError(await f.read(f.admin, path), 404, 'NOT_FOUND');
});

test('malformed/nonobject/nonstring/missing associations remain hidden and unsafe foreign or other-employee versions do not poison query', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  for (const entity of entityCodes) {
    const visible = f.imported(entity, { employeeId: f.employeeB.id });
    for (const rawData of ['{', 'null', '[]', '"HIDDEN-STRING"', '77', 'false', '{"note":"HIDDEN-MISSING-EMPLOYEE"}', '{"employeeId":null}', '{"employeeId":7}', '{"employeeId":["' + f.employeeB.id + '"]}', '{"__proto__":{"employeeId":"' + f.employeeB.id + '"}}']) f.imported(entity, null, { rawData, version: 9007199254740992n });
    f.imported(entity, { employeeId: f.employeeA.id, note: 'HIDDEN-OTHER-EMPLOYEE' }, { version: 9007199254740992n });
    f.imported(entity, { employeeId: f.employeeB.id, note: 'HIDDEN-FOREIGN-ORG' }, { org: foreign.client.org, version: 9007199254740992n });
    f.imported(entity, { employeeId: ' ' + f.employeeB.id + ' ' }, { version: 9007199254740992n });
    const result = await f.read(f.admin, indexPath(f.employeeB, 'entity=' + entity)); assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].id, visible.id);
    assert(!JSON.stringify(result.body).includes('HIDDEN'));
  }
});

test('complete25-plus5 paging preserves SQL created-desc/id-asc order and huge-page empty responses', async t => {
  const f = await fixture(t), time = '2026-10-10T03:00:00.000Z', expected = [];
  for (let n = 30; n >= 1; n--) expected.push(f.imported('employee-training', { employeeId: f.employeeB.id }, { id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), created: time }).id);
  expected.sort();
  const first = await f.read(f.admin, indexPath(f.employeeB, 'entity=employee-training')), second = await f.read(f.clients.supervisor, indexPath(f.employeeB, 'entity=employee-training&page=2'));
  assert.equal(first.body.total, 30); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 5);
  assert.deepEqual([...first.body.items, ...second.body.items].map(row => row.id), expected);
  const newer = f.imported('employee-training', { employeeId: f.employeeB.id }, { created: '2026-10-11T00:00:00Z' }), older = f.imported('employee-training', { employeeId: f.employeeB.id }, { created: '2026-10-09T00:00:00Z' });
  const all = await f.read(f.admin, indexPath(f.employeeB, 'entity=employee-training&pageSize=100'));
  assert.equal(all.body.items[0].id, newer.id); assert.equal(all.body.items.at(-1).id, older.id); assert.equal(all.body.total, 32); assert.equal(new Set(all.body.items.map(row => row.id)).size, 32);
  const empty = await f.read(f.admin, indexPath(f.employeeB, 'entity=employee-training&page=9007199254740991'));
  assert.equal(empty.status, 200); assert.equal(empty.body.total, 32); assert.deepEqual(empty.body.items, []);
});

test('unsafe SQL versions off-page invalidate the whole matching set for every employee entity before paging', async t => {
  const f = await fixture(t);
  for (const entity of entityCodes) {
    for (let n = 0; n < 25; n++) f.imported(entity, { employeeId: f.employeeB.id }, { created: '2026-10-11T00:00:00Z' });
    const poison = f.imported(entity, { employeeId: f.employeeB.id, version: 1 }, { created: '2026-10-01T00:00:00Z', version: 9007199254740992n });
    for (const query of ['entity=' + entity, 'entity=' + entity + '&page=2', 'entity=' + entity + '&page=999']) assertError(await f.read(f.admin, indexPath(f.employeeB, query)), 409, 'EMPLOYEE_RECORD_INDEX_INVALID');
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, poison.id);
    const last = await f.read(f.clients.supervisor, indexPath(f.employeeB, 'entity=' + entity + '&page=2'));
    assert.equal(last.status, 200); assert.equal(last.body.items[0].version, Number.MAX_SAFE_INTEGER);
    for (const version of [0, -1, 1.5, 'not-a-version']) {
      f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, poison.id);
      assertError(await f.read(f.admin, indexPath(f.employeeB, 'entity=' + entity)), 409, 'EMPLOYEE_RECORD_INDEX_INVALID');
    }
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(1, poison.id);
  }
});

test('original leave reparenting and full history keep their own semantics while index follows current employee only', async t => {
  const f = await fixture(t);
  const original = await f.create('leave-requests', { employeeId: f.employeeB.id, date: '2026-10-11', startTime: '09:00', endTime: '10:00', type: '合成假別', reason: '合成追溯原因' });
  const current = await f.patch('leave-requests', original, { employeeId: f.employeeA.id, status: 'rejected' });
  const currentIndex = await f.read(f.admin, indexPath(f.employeeA, 'entity=leave-requests')); assert(currentIndex.body.items.some(row => row.id === current.id && row.version === 2));
  assert.equal((await f.read(f.admin, indexPath(f.employeeB, 'entity=leave-requests'))).body.total, 0);
  const history = await f.read(f.admin, '/api/leave-requests/' + current.id + '/history?compare=previous'); assert.equal(history.status, 200);
  assert.equal(history.body.items[0].snapshot.employeeId, f.employeeA.id); assert.equal(history.body.items[0].comparison.previousSnapshot.employeeId, f.employeeB.id);
  assert.equal(history.body.items[0].actor.id, f.admin.user.id);
  assert(!JSON.stringify(currentIndex.body).includes(f.employeeB.id));
});

test('index ignores versions/audit contents and preserves eleven tables, six triggers, both BLOBs and approved snapshot', async t => {
  const f = await fixture(t), item = f.imported('employee-training', { employeeId: f.employeeB.id, note: 'HIDDEN-NOTE', billingSnapshot: { secret: 'HIDDEN-SNAPSHOT' } });
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, 'employee-training', item.id, 1, '{malformed-history', now(), 'SYNTHETIC-UNKNOWN-SOURCE');
  f.app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), f.admin.org, f.admin.user.id, 'record.create', 'employee-training', item.id, '{malformed-audit', now());
  const before = f.state();
  for (const entity of entityCodes) assert.equal((await f.read(f.clients.supervisor, indexPath(f.employeeB, 'entity=' + entity))).status, 200);
  const result = await f.read(f.admin, indexPath(f.employeeB, 'entity=employee-training')); assert.equal(result.body.total, 1); keys(result.body.items[0], rowKeys);
  assert(!JSON.stringify(result.body).includes('HIDDEN')); assert(!JSON.stringify(result.body).includes('SYNTHETIC-UNKNOWN-SOURCE'));
  const approved = await f.read(f.admin, '/api/service-records/' + f.approved.id); assert.deepEqual(approved.body.item.billingSnapshot, f.approved.billingSnapshot);
  assert.deepEqual(f.state(), before);
  assert(before.tables.attachment_files[0].content instanceof Uint8Array); assert(before.tables.certification_attachment_files[0].content instanceof Uint8Array);
});

test('existing personnel CRUD/CAS/immutable ownership, employee member linkage and case index still work after mounting new endpoint', async t => {
  const f = await fixture(t);
  for (const [entity, payload, cancelled] of [
    ['employee-certifications', { employeeId: f.employeeB.id, name: ' 合成新增證照 ', issuedOn: '2026-01-01' }, 'revoked'],
    ['employee-training', { employeeId: f.employeeB.id, name: ' 合成新增訓練 ', category: 'in_service', date: '2026-10-11', trainingMinutes: 60 }, 'cancelled'],
  ]) {
    const original = await f.create(entity, payload, f.clients.supervisor);
    assert.equal(original.name, payload.name.trim());
    const patched = await f.patch(entity, original, { status: cancelled, note: '合成修改' });
    const result = await f.read(f.admin, indexPath(f.employeeB, 'entity=' + entity));
    assert.deepEqual(result.body.items, [{ entity, id: patched.id, orgId: f.admin.org, employeeId: f.employeeB.id, version: 2, updatedAt: patched.updatedAt }]);
    const history = await f.read(f.clients.supervisor, '/api/' + entity + '/' + patched.id + '/history?compare=previous');
    assert.equal(history.body.items[0].actor.id, f.admin.user.id); assert.equal(history.body.items[0].comparison.previousSnapshot.employeeId, f.employeeB.id);
    assertError(await f.read(f.admin, '/api/' + entity + '/' + original.id, 'PATCH', { version: 1, note: 'stale' }), 409, 'VERSION_CONFLICT');
    assertError(await f.read(f.admin, '/api/' + entity + '/' + patched.id, 'PATCH', { version: 2, employeeId: f.employeeA.id }), 409, 'EMPLOYEE_IMMUTABLE');
  }
  const caseIndex = await f.read(f.admin, '/api/cases/' + f.caseA.id + '/record-index?entity=care-plans');
  assert.equal(caseIndex.status, 200); assert.deepEqual(caseIndex.body.items.map(row => row.id), [f.plan.id]);
  const changedCase = await f.patch('cases', f.caseA, { note: '合成主檔更新' });
  assert.equal(changedCase.version, 2); assert.equal((await f.read(f.admin, '/api/cases/' + changedCase.id + '/history?compare=previous')).body.items[0].actor.id, f.admin.user.id);
  const disabled = await f.patch('employees', f.employeeA, { status: 'inactive' });
  assert.equal((await f.read(f.admin, indexPath(disabled))).status, 200);
  assertError(await f.read(f.clients.caregiver, '/api/employee-certifications/' + f.certification.id), 403, 'EMPLOYEE_LINK_REQUIRED');
  await f.patch('employees', disabled, { status: 'active' });
  assert.equal((await f.read(f.clients.caregiver, '/api/employee-certifications/' + f.certification.id)).status, 200);
  assert.deepEqual((await f.read(f.admin, '/api/service-records/' + f.approved.id)).body.item.billingSnapshot, f.approved.billingSnapshot);
});
