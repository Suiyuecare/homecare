import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const entityCodes = ['care-plans', 'shifts', 'service-records', 'assessments'];
const rowKeys = ['entity', 'id', 'orgId', 'caseId', 'version', 'updatedAt'];
const envelopeKeys = ['items', 'total', 'page', 'pageSize', 'entity', 'orgId', 'caseId'];
const password = 'synthetic-case-record-index-password';
const indexPath = (parent, query = 'entity=care-plans') => '/api/cases/' + parent.id + '/record-index' + (query === null ? '' : '?' + query);
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
  const setup = await request(null, 'POST', '/api/setup', { name: '合成索引管理者', email: 'record-index-admin@example.test', password, organizationName: '合成索引機構甲' });
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
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = 'record-index-' + role + '@example.test';
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
  async function read(client = admin, path = indexPath(caseA), method = 'GET', data, headers = {}, rawBody) {
    const before = state(), result = await request(client, method, path, data, headers, rawBody);
    assert.deepEqual(state(), before, 'Index/read/rejected operation changed raw tables/schema/triggers/total_changes: ' + method + ' ' + path);
    return result;
  }
  function imported(entity, data, options = {}) {
    const recordId = options.id ?? id(), org = options.org ?? admin.org, version = options.version ?? 1, created = options.created ?? now(), updated = options.updated ?? created;
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, org, entity, options.rawData ?? JSON.stringify(data), version, created, updated);
    return { id: recordId, orgId: org, version, entity, caseId: data?.caseId, updatedAt: updated };
  }
  async function foreign() {
    const organization = await create('organizations', { name: '合成索引機構乙' }), client = { ...admin, org: organization.id };
    const parent = await create('cases', { name: caseA.name, caseNo: 'INDEX-FOREIGN' }, client);
    return { client, parent };
  }
  return { app, admin, clients, employee, caseA, caseB, plan, shift, approved, attachment, certAttachment, services, create, patch, request, read, state, imported, foreign };
}

test('four current entity indexes include every saved status with exact metadata-only DTO and explicit scope echoes', async t => {
  const f = await fixture(t), statuses = { 'care-plans': ['draft', 'active', 'ended'], shifts: ['scheduled', 'completed', 'cancelled'], 'service-records': ['draft', 'submitted', 'approved', 'returned'], assessments: ['draft', 'submitted'] };
  for (const entity of entityCodes) {
    const expected = new Set();
    for (const status of [...statuses[entity], 'SYNTHETIC-UNKNOWN-STATUS']) expected.add(f.imported(entity, { caseId: f.caseB.id, status, note: 'HIDDEN-BUSINESS-MARKER', answers: { q001: 'HIDDEN-ANSWER' }, billingSnapshot: { marker: 'HIDDEN-PRICE' } }).id);
    for (const actor of [f.admin, f.clients.supervisor]) {
      const result = await f.read(actor, indexPath(f.caseB, 'entity=' + entity)); assert.equal(result.status, 200);
      keys(result.body, envelopeKeys); assert.equal(result.body.entity, entity); assert.equal(result.body.orgId, f.admin.org); assert.equal(result.body.caseId, f.caseB.id);
      assert.equal(result.body.page, 1); assert.equal(result.body.pageSize, 25); assert.equal(result.body.total, expected.size);
      assert.deepEqual(new Set(result.body.items.map(row => row.id)), expected);
      for (const row of result.body.items) { keys(row, rowKeys); assert.equal(row.entity, entity); assert.equal(row.orgId, f.admin.org); assert.equal(row.caseId, f.caseB.id); assert.equal(row.version, 1); }
      for (const marker of ['HIDDEN-BUSINESS', 'HIDDEN-ANSWER', 'HIDDEN-PRICE', 'status', 'snapshot', 'actor', 'createdAt']) assert(!JSON.stringify(result.body).includes(marker));
    }
  }
});

test('exact same-org cases are parents regardless of names/paused/closed and wrong-entity or foreign IDs remain404', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  const one = f.imported('assessments', { caseId: f.caseA.id }), two = f.imported('assessments', { caseId: f.caseB.id });
  let parent = f.caseB;
  for (const status of ['paused', 'closed']) {
    parent = await f.patch('cases', parent, { status });
    assert.deepEqual((await f.read(f.clients.supervisor, indexPath(parent, 'entity=assessments'))).body.items.map(row => row.id), [two.id]);
    assert.deepEqual((await f.read(f.admin, indexPath(f.caseA, 'entity=assessments'))).body.items.map(row => row.id), [one.id]);
  }
  const spoofed = f.imported('employees', { caseId: f.caseA.id, entity: 'cases', id: f.caseA.id });
  for (const parentId of [foreign.parent.id, f.employee.id, spoofed.id, id()]) assertError(await f.read(f.admin, indexPath({ id: parentId })), 404, 'NOT_FOUND');
  assert.equal((await f.read(foreign.client, indexPath(foreign.parent))).body.total, 0);
  assertError(await f.read(foreign.client, indexPath(f.caseA)), 404, 'NOT_FOUND');
});

test('closed query and lexical pagination reject missing/duplicate/unknown params without trimming or coercing values', async t => {
  const f = await fixture(t);
  const invalid = [null, '', 'entity=', 'entity=cases', 'entity=Care-plans', 'entity=%20care-plans', 'entity=care-plans%20', 'entity=care-plans&entity=care-plans'];
  for (const key of ['q', 'status', 'caseId', 'compare', 'date', 'unknown']) invalid.push('entity=care-plans&' + key + '=');
  for (const key of ['page', 'pageSize']) {
    invalid.push('entity=care-plans&' + key + '=1&' + key + '=1');
    for (const value of ['', '0', '-1', '+1', '01', '1.0', '1e1', 'NaN', 'Infinity', ' 1', '1 ', '9007199254740992']) invalid.push('entity=care-plans&' + key + '=' + encodeURIComponent(value));
  }
  invalid.push('entity=care-plans&pageSize=101');
  for (const query of invalid) assert.equal((await f.read(f.admin, indexPath(f.caseA, query))).status, 422, String(query));
  const maximum = await f.read(f.admin, indexPath(f.caseA, 'entity=care-plans&page=9007199254740991&pageSize=100'));
  assert.equal(maximum.status, 200); assert.equal(maximum.body.total, 1); assert.deepEqual(maximum.body.items, []); assert.equal(maximum.body.pageSize, 100);
});

test('finance/caregiver/unknown role are forbidden before query/method/body parsing while old read permissions are preserved', async t => {
  const f = await fixture(t);
  for (const role of ['finance', 'caregiver']) {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) assertError(await f.read(f.clients[role], indexPath(f.caseA, 'unknown=1&page=0'), method, undefined, { 'Content-Type': 'text/plain' }, ['GET', 'OPTIONS'].includes(method) ? undefined : '{'), 403, 'ROLE_FORBIDDEN');
    assert.equal((await f.read(f.clients[role], indexPath(f.caseA), 'HEAD')).status, 403);
  }
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('synthetic-unknown-role', f.admin.org, f.clients.finance.user.id);
  assertError(await f.read(f.clients.finance, indexPath(f.caseA, 'unknown=x'), 'POST', undefined, { 'Content-Type': 'text/plain' }, '{'), 403, 'ROLE_FORBIDDEN');
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance', f.admin.org, f.clients.finance.user.id);
  assert.equal((await f.read(f.clients.finance, '/api/cases/' + f.caseA.id)).status, 200);
  assert.equal((await f.read(f.clients.finance, '/api/care-plans/' + f.plan.id + '/history?compare=previous')).status, 200);
  assertError(await f.read(null), 401, 'AUTH_REQUIRED');
  assertError(await f.read({ ...f.admin, org: '' }), 400, 'ORG_REQUIRED');
  assertError(await f.read({ ...f.admin, org: id() }), 403, 'ORG_FORBIDDEN');
});

test('authorized nonGET returns405 without consuming invalid/oversized bodies or idempotency while common Origin/CSRF guards remain', async t => {
  const f = await fixture(t);
  for (const actor of [f.admin, f.clients.supervisor]) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assertError(await f.read(actor, indexPath(f.caseA, 'unknown=1'), method, undefined, { 'Content-Type': 'text/plain', 'Idempotency-Key': 'bad key' }, '{'), 405, 'METHOD_NOT_ALLOWED');
      assertError(await f.read(actor, indexPath(f.caseA), method, undefined, {}, '{"unknown":"' + 'X'.repeat(140000) + '"}'), 405, 'METHOD_NOT_ALLOWED');
    }
    assertError(await f.read(actor, indexPath(f.caseA), 'OPTIONS'), 405, 'METHOD_NOT_ALLOWED');
    assert.equal((await f.read(actor, indexPath(f.caseA), 'HEAD')).status, 405);
  }
  assertError(await f.read(f.admin, indexPath(f.caseA), 'POST', {}, { 'X-CSRF-Token': '' }), 403, 'CSRF_INVALID');
  assertError(await f.read(f.admin, indexPath(f.caseA), 'POST', {}, { Origin: 'https://synthetic-wrong-origin.example.test' }), 403, 'ORIGIN_FORBIDDEN');
  for (const path of [indexPath(f.caseA).split('?')[0] + '/', indexPath(f.caseA).split('?')[0] + '/history', '/api/cases/not-routable/record-index?entity=care-plans']) assertError(await f.read(f.admin, path), 404, 'NOT_FOUND');
});

test('malformed/nonobject/nonstring/missing case association cannot be guessed and hidden unsafe versions never block the chosen case', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  for (const entity of entityCodes) {
    const visible = f.imported(entity, { caseId: f.caseB.id });
    for (const rawData of ['{', 'null', '[]', '"HIDDEN-STRING"', '77', 'false', '{"note":"HIDDEN-MISSING-CASE"}', '{"caseId":null}', '{"caseId":7}', '{"caseId":["' + f.caseB.id + '"]}', '{"__proto__":{"caseId":"' + f.caseB.id + '"}}']) f.imported(entity, null, { rawData, version: 9007199254740992n });
    f.imported(entity, { caseId: f.caseA.id, note: 'HIDDEN-OTHER-CASE' }, { version: 9007199254740992n });
    f.imported(entity, { caseId: f.caseB.id, note: 'HIDDEN-FOREIGN-ORG' }, { org: foreign.client.org, version: 9007199254740992n });
    f.imported(entity, { caseId: ' ' + f.caseB.id + ' ' }, { version: 9007199254740992n });
    const result = await f.read(f.admin, indexPath(f.caseB, 'entity=' + entity)); assert.equal(result.status, 200); assert.equal(result.body.total, 1); assert.equal(result.body.items[0].id, visible.id);
    assert(!JSON.stringify(result.body).includes('HIDDEN'));
  }
});

test('complete25-plus3 paging preserves SQL created-desc/id-asc order and safe huge-page empty results', async t => {
  const f = await fixture(t), time = '2026-10-10T03:00:00.000Z', expected = [];
  for (let n = 28; n >= 1; n--) expected.push(f.imported('assessments', { caseId: f.caseB.id }, { id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), created: time }).id);
  expected.sort();
  const first = await f.read(f.admin, indexPath(f.caseB, 'entity=assessments')), second = await f.read(f.clients.supervisor, indexPath(f.caseB, 'entity=assessments&page=2'));
  assert.equal(first.body.total, 28); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
  assert.deepEqual([...first.body.items, ...second.body.items].map(row => row.id), expected);
  const newer = f.imported('assessments', { caseId: f.caseB.id }, { created: '2026-10-11T00:00:00Z' }), older = f.imported('assessments', { caseId: f.caseB.id }, { created: '2026-10-09T00:00:00Z' });
  const all = await f.read(f.admin, indexPath(f.caseB, 'entity=assessments&pageSize=100'));
  assert.equal(all.body.items[0].id, newer.id); assert.equal(all.body.items.at(-1).id, older.id); assert.equal(all.body.total, 30); assert.equal(new Set(all.body.items.map(row => row.id)).size, 30);
  const empty = await f.read(f.admin, indexPath(f.caseB, 'entity=assessments&page=9007199254740991'));
  assert.equal(empty.status, 200); assert.equal(empty.body.total, 30); assert.deepEqual(empty.body.items, []);
});

test('unsafe SQL versions beyond first page invalidate the entire matching result before pagination for all four entities', async t => {
  const f = await fixture(t);
  for (const entity of entityCodes) {
    for (let n = 0; n < 25; n++) f.imported(entity, { caseId: f.caseB.id }, { created: '2026-10-11T00:00:00Z' });
    const poison = f.imported(entity, { caseId: f.caseB.id, version: 1 }, { created: '2026-10-01T00:00:00Z', version: 9007199254740992n });
    for (const query of ['entity=' + entity, 'entity=' + entity + '&page=2', 'entity=' + entity + '&page=999']) assertError(await f.read(f.admin, indexPath(f.caseB, query)), 409, 'CASE_RECORD_INDEX_INVALID');
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, poison.id);
    const last = await f.read(f.clients.supervisor, indexPath(f.caseB, 'entity=' + entity + '&page=2'));
    assert.equal(last.status, 200); assert.equal(last.body.items[0].version, Number.MAX_SAFE_INTEGER);
    for (const version of [0, -1, 1.5, 'not-a-version']) {
      f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, poison.id);
      assertError(await f.read(f.admin, indexPath(f.caseB, 'entity=' + entity)), 409, 'CASE_RECORD_INDEX_INVALID');
    }
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(1, poison.id);
  }
});

test('SQL metadata is authoritative and update time stays raw text; nonroutable IDs or nontext update metadata fail409', async t => {
  const f = await fixture(t), rawTime = ' 原更新文字\r\n<script>literal</script> ' + '時'.repeat(1800), longId = 'a'.repeat(1200) + '-f';
  const item = f.imported('assessments', { caseId: f.caseB.id, id: f.employee.id, orgId: 'HIDDEN-SPOOF', entity: 'care-plans', version: 999, updatedAt: 'HIDDEN-TIME', createdAt: 'HIDDEN-CREATED' }, { id: longId, version: 7, updated: rawTime });
  const result = await f.read(f.admin, indexPath(f.caseB, 'entity=assessments')); assert.equal(result.status, 200);
  assert.deepEqual(result.body.items, [{ entity: 'assessments', id: item.id, orgId: f.admin.org, caseId: f.caseB.id, version: 7, updatedAt: rawTime }]);
  const emptyTime = f.imported('assessments', { caseId: f.caseB.id }, { updated: '' });
  assert.equal((await f.read(f.admin, indexPath(f.caseB, 'entity=assessments'))).body.items.find(row => row.id === emptyTime.id).updatedAt, '');
  f.app.db.prepare('UPDATE records SET updated_at=? WHERE id=?').run(Buffer.from('SYNTHETIC-BLOB-TIMESTAMP'), emptyTime.id);
  assertError(await f.read(f.admin, indexPath(f.caseB, 'entity=assessments')), 409, 'CASE_RECORD_INDEX_INVALID');
  f.app.db.prepare('UPDATE records SET updated_at=? WHERE id=?').run('restored raw text', emptyTime.id);
  for (const badId of ['', 'uppercase-A', 'not-hex-id']) {
    const malformed = f.imported('assessments', { caseId: f.caseB.id }, { id: badId });
    assertError(await f.read(f.admin, indexPath(f.caseB, 'entity=assessments')), 409, 'CASE_RECORD_INDEX_INVALID');
    f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ caseId: f.caseA.id }), malformed.id);
  }
});

test('current reparenting changes index membership without rewriting or reinterpreting the existing full record history', async t => {
  const f = await fixture(t);
  const original = await f.create('care-plans', { caseId: f.caseB.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'draft', services: f.services });
  const current = await f.patch('care-plans', original, { caseId: f.caseA.id, status: 'ended' });
  const currentIndex = await f.read(f.admin, indexPath(f.caseA)); assert(currentIndex.body.items.some(row => row.id === current.id && row.version === 2));
  assert.equal((await f.read(f.admin, indexPath(f.caseB))).body.total, 0);
  const history = await f.read(f.admin, '/api/care-plans/' + current.id + '/history?compare=previous'); assert.equal(history.status, 200);
  assert.equal(history.body.items[0].snapshot.caseId, f.caseA.id); assert.equal(history.body.items[0].comparison.previousSnapshot.caseId, f.caseB.id);
  assert.equal(history.body.items[0].actor.id, f.admin.user.id);
  assert(!JSON.stringify(currentIndex.body).includes(f.caseB.id));
});

test('index never consumes record_versions/audit/business content and preserves original approved snapshot, both BLOBs and complete state', async t => {
  const f = await fixture(t), item = f.imported('assessments', { caseId: f.caseB.id, answers: { deep: 'HIDDEN-SAVED-ANSWERS' }, note: 'HIDDEN-NOTE', billingSnapshot: { secret: 'HIDDEN-SNAPSHOT' } });
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, 'assessments', item.id, 1, '{malformed-history', now(), 'SYNTHETIC-UNKNOWN-SOURCE');
  f.app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), f.admin.org, f.admin.user.id, 'record.create', 'assessments', item.id, '{malformed-audit', now());
  const before = f.state();
  for (const entity of entityCodes) assert.equal((await f.read(f.clients.supervisor, indexPath(f.caseB, 'entity=' + entity))).status, 200);
  const result = await f.read(f.admin, indexPath(f.caseB, 'entity=assessments')); assert.equal(result.body.total, 1); keys(result.body.items[0], rowKeys);
  assert(!JSON.stringify(result.body).includes('HIDDEN')); assert(!JSON.stringify(result.body).includes('SYNTHETIC-UNKNOWN-SOURCE'));
  const approved = await f.read(f.admin, '/api/service-records/' + f.approved.id); assert.deepEqual(approved.body.item.billingSnapshot, f.approved.billingSnapshot);
  assert.deepEqual(f.state(), before);
  assert(before.tables.attachment_files[0].content instanceof Uint8Array); assert(before.tables.certification_attachment_files[0].content instanceof Uint8Array);
});
