import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';

const endpoint = '/api/case-followup-worklist';
const entity = 'case-status-followups';
const fields = ['kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status'];
const rowKeys = ['id', 'orgId', 'version', 'caseId', 'caseNo', 'caseName', 'fields'];
const password = 'synthetic-worklist-password';
const single = item => endpoint + '/' + encodeURIComponent(item.id);
const generic = item => '/api/' + entity + (item ? '/' + encodeURIComponent(item.id) : '');
const keys = (actual, expected) => assert.deepEqual(Object.keys(actual).sort(), [...expected].sort());
const error = (response, status, code) => { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.error.code, code); };

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, headers = {}, rawBody) {
    const hasBody = data !== undefined || rawBody !== undefined;
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(hasBody ? { body: rawBody === undefined ? JSON.stringify(data) : rawBody } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成人工追蹤管理員', email: 'worklist-admin@example.test', password, organizationName: '合成人工追蹤機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(kind, data, client = admin, headers = {}) {
    const result = await request(client, 'POST', '/api/' + kind, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(kind, item, data, client = admin) {
    const result = await request(client, 'PATCH', '/api/' + kind + '/' + item.id, { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成人工追蹤居服員', employeeNo: 'WL-EMP' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = 'worklist-' + role + '@example.test';
    await create('users', { name: '合成人工追蹤' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseA = await create('cases', { name: '合成人工追蹤同名個案', caseNo: 'WL-CASE-A' });
  const payload = overrides => ({ caseId: caseA.id, kind: 'pause', startDate: '2026-10-01', endDate: '', reason: '合成人工追蹤原因', followUpDate: '2026-10-10', outcome: '', note: '', status: 'pending', ...overrides });
  function raw() {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(row => row.type === 'table'); assert.equal(tables.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
    return { schema, tables: Object.fromEntries(tables.map(row => {
      const statement = app.db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid'); statement.setReadBigInts(true);
      return [row.name, statement.all()];
    })), totalChanges: app.db.prepare('SELECT total_changes() n').get().n };
  }
  async function read(client, route = endpoint, method = 'GET', data, headers = {}, rawBody) {
    const before = raw(), response = await request(client, method, route, data, headers, rawBody);
    assert.deepEqual(raw(), before, 'Pure read/rejection must keep11 tables,6 triggers,schema and total_changes unchanged: ' + method + ' ' + route);
    return response;
  }
  function imported(data, options = {}) {
    const recordId = options.id ?? id(), org = options.org ?? admin.org, kind = options.entity ?? entity, version = options.version ?? 1;
    const created = options.created ?? now();
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, org, kind, options.rawData ?? JSON.stringify(data), version, created, created);
    return { ...data, id: recordId, orgId: org, version };
  }
  async function foreign() {
    const org = await create('organizations', { name: '合成人工追蹤機構乙' }), client = { ...admin, org: org.id };
    const parent = await create('cases', { name: 'SYNTHETIC-FOREIGN-CASE', caseNo: 'WL-FOREIGN' }, client);
    const item = await create(entity, payload({ caseId: parent.id, reason: 'SYNTHETIC-FOREIGN-REASON' }), client);
    return { client, parent, item };
  }
  async function assigned(approved = false) {
    const service = await create('service-items', { code: 'WL-SVC', name: '合成保護服務', minutes: 60, unitPriceCents: 8765 });
    const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 3 }] });
    const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: plan.services });
    let record;
    if (approved) {
      record = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:55', services: shift.services, status: 'submitted' });
      assert.equal((await request(clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成核閱' })).status, 200);
    }
    return { service, plan, shift, record };
  }
  return { app, admin, clients, employee, caseA, payload, request, create, patch, raw, read, imported, foreign, assigned };
}

test('dedicated exact DTO keeps raw eight saved strings and reads current paused or closed parent names', async t => {
  const f = await fixture(t), raw = f.payload({ kind: ' raw-kind ', status: ' raw-status ', startDate: 'raw-start', endDate: 'raw-end', followUpDate: ' raw-date ', reason: ' \r\n合成原原因<script>literal</script>\n' + '長'.repeat(12000), outcome: ' 原結果\r\n ', note: '\n原備註\r ' });
  const item = f.imported(raw), list = await f.read(f.admin); assert.equal(list.status, 200);
  keys(list.body, ['items', 'total', 'page', 'pageSize', 'filters']); assert.deepEqual(list.body.filters, { q: '', kind: '', status: '', followUpDate: '', caseId: '' });
  assert.equal(list.body.total, 1); assert.equal(list.body.page, 1); assert.equal(list.body.pageSize, 25);
  const row = list.body.items[0]; keys(row, rowKeys); keys(row.fields, fields);
  for (const key of fields) assert.deepEqual(row.fields[key], { kind: 'string', value: raw[key] });
  assert.equal(row.caseId, f.caseA.id); assert.equal(row.caseName, f.caseA.name); assert.equal(row.caseNo, f.caseA.caseNo);
  let parent = await f.patch('cases', f.caseA, { name: '合成目前改名', caseNo: 'WL-CURRENT', status: 'paused' });
  const fresh = await f.read(f.clients.supervisor, single(item)); keys(fresh.body, ['item']); assert.equal(fresh.body.item.caseName, parent.name); assert.equal(fresh.body.item.caseNo, parent.caseNo);
  assert.deepEqual(fresh.body.item.fields, row.fields);
  parent = await f.patch('cases', parent, { status: 'closed' }); assert.equal((await f.read(f.admin, single(item))).status, 200);
  const original = (await f.read(f.admin, generic(item))).body.item; for (const key of fields) assert.equal(original[key], raw[key]);
});

test('eight typed fields distinguish missing/null/empty/zero/false and hide unknown or nested contents', async t => {
  const f = await fixture(t), secret = 'SYNTHETIC-HIDDEN-FIELD';
  const data = { caseId: f.caseA.id, kind: '', startDate: null, endDate: [secret], reason: { nested: secret }, followUpDate: 0, outcome: false, note: '0', unknown: secret };
  const item = f.imported(data), response = await f.read(f.admin, single(item)); assert.equal(response.status, 200);
  assert.deepEqual(response.body.item.fields, { kind: { kind: 'string', value: '' }, startDate: { kind: 'null' }, endDate: { kind: 'array' }, reason: { kind: 'object' }, followUpDate: { kind: 'number' }, outcome: { kind: 'boolean' }, note: { kind: 'string', value: '0' }, status: { kind: 'missing' } });
  assert(!JSON.stringify(response.body).includes(secret)); assert(!JSON.stringify(response.body).includes('unknown'));
  for (const [key, value] of [['reason', true], ['outcome', 1.5], ['note', {}], ['status', []], ['kind', null]]) {
    const next = f.imported(f.payload({ [key]: value })); const row = (await f.read(f.admin, single(next))).body.item;
    assert.deepEqual(row.fields[key], { kind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value });
  }
  const parent = f.imported({ name: { nested: secret }, caseNo: [secret], status: 'paused' }, { entity: 'cases' });
  const child = f.imported(f.payload({ caseId: parent.id })); const row = (await f.read(f.admin, single(child))).body.item;
  assert.equal(row.caseName, ''); assert.equal(row.caseNo, ''); assert(!JSON.stringify(row).includes(secret));
});

test('q searches only each own reason/outcome/note string without trimming or concatenating metadata and hidden values', async t => {
  const f = await fixture(t); f.imported(f.payload({ reason: 'FIRST-MARKER', outcome: 'SECOND-MARKER', note: ' 原文\r\n保留 ', kind: 'KIND-MARKER', startDate: 'START-MARKER', endDate: 'END-MARKER', followUpDate: 'DATE-MARKER', status: 'STATUS-MARKER', unknown: 'UNKNOWN-MARKER' }));
  f.imported(f.payload({ reason: { nested: 'NESTED-MARKER' }, outcome: ['ARRAY-MARKER'], note: false }));
  for (const q of ['first-marker', 'SECOND-marker', ' 原文\r\n保留 ']) {
    const result = await f.read(f.admin, endpoint + '?q=' + encodeURIComponent(q)); assert.equal(result.body.total, 1); assert.equal(result.body.filters.q, q);
  }
  for (const q of ['FIRST-MARKERSECOND-MARKER', 'KIND-MARKER', 'START-MARKER', 'END-MARKER', 'DATE-MARKER', 'STATUS-MARKER', 'UNKNOWN-MARKER', 'NESTED-MARKER', 'ARRAY-MARKER', 'false', 'object', f.caseA.name, f.caseA.caseNo, f.caseA.id, f.admin.org])
    assert.equal((await f.read(f.clients.supervisor, endpoint + '?q=' + encodeURIComponent(q))).body.total, 0, q);
  assert.equal((await f.read(f.admin, endpoint + '?q=' + '字'.repeat(200))).status, 200);
  error(await f.read(f.admin, endpoint + '?q=' + '😀'.repeat(101)), 422, 'INVALID_QUERY');
});

test('exact artificial date/kind/status/case filters separate same-name IDs and do not infer a deadline or active parent', async t => {
  const f = await fixture(t), second = await f.create('cases', { name: f.caseA.name, caseNo: 'WL-CASE-B', status: 'closed' });
  const one = f.imported(f.payload()), two = f.imported(f.payload({ caseId: second.id, kind: 'closure', status: 'completed', followUpDate: '2026-10-11', startDate: '2026-10-10', endDate: '2026-10-10', note: '2026-10-10' }));
  const emptyDate = f.imported(f.payload({ followUpDate: '' }));
  assert.deepEqual((await f.read(f.admin, endpoint + '?caseId=' + f.caseA.id)).body.items.map(x => x.id).sort(), [one.id, emptyDate.id].sort());
  const result = await f.read(f.clients.supervisor, endpoint + '?caseId=' + second.id + '&followUpDate=2026-10-11&kind=closure&status=completed');
  assert.deepEqual(result.body.items.map(x => x.id), [two.id]); assert.deepEqual(result.body.filters, { q: '', kind: 'closure', status: 'completed', followUpDate: '2026-10-11', caseId: second.id });
  assert.equal((await f.read(f.admin, endpoint + '?followUpDate=2026-10-10')).body.total, 1, 'Only saved followUpDate matches, not start/end or note');
  assert.equal((await f.read(f.admin, endpoint + '?kind=&status=&followUpDate=&caseId=&q=')).body.total, 3, 'Empty date includes unscheduled saved records');
  const foreign = await f.foreign();
  for (const caseId of [foreign.parent.id, f.employee.id, id(), ' ' + f.caseA.id + ' ']) error(await f.read(f.admin, endpoint + '?caseId=' + encodeURIComponent(caseId)), 404, 'NOT_FOUND');
  for (const caseId of [' ', '\r\n', '字'.repeat(501)]) error(await f.read(f.admin, endpoint + '?caseId=' + encodeURIComponent(caseId)), 422, 'INVALID_QUERY');
  error(await f.read(f.admin, endpoint + '?caseId=' + '字'.repeat(500)), 404, 'NOT_FOUND');
});

test('25-plus3 pagination preserves underlying created-desc/id order and stable totals including empty high pages', async t => {
  const f = await fixture(t), ids = [], created = '2026-10-10T03:00:00.000Z';
  for (let n = 28; n >= 1; n--) ids.push(f.imported(f.payload({ reason: '共同人工追蹤' + n }), { id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), created }).id);
  ids.sort(); const older = f.imported(f.payload(), { created: '2026-10-09T23:00:00.000Z' }), newer = f.imported(f.payload(), { created: '2026-10-10T04:00:00.000Z' });
  const first = await f.read(f.admin, endpoint + '?q=共同人工追蹤'), second = await f.read(f.clients.supervisor, endpoint + '?q=共同人工追蹤&page=2');
  assert.equal(first.body.total, 28); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
  assert.deepEqual([...first.body.items, ...second.body.items].map(x => x.id), ids); assert.equal(new Set([...first.body.items, ...second.body.items].map(x => x.id)).size, 28);
  const all = await f.read(f.admin, endpoint + '?pageSize=100'); assert.equal(all.body.items[0].id, newer.id); assert.equal(all.body.items.at(-1).id, older.id);
  const empty = await f.read(f.admin, endpoint + '?page=9007199254740991'); assert.equal(empty.body.total, 30); assert.deepEqual(empty.body.items, []);
});

test('closed seven-key query rejects duplicate/unknown/nonlexical values but permits exact leap dates and year0000', async t => {
  const f = await fixture(t); f.imported(f.payload({ followUpDate: '0000-01-01' })); f.imported(f.payload({ followUpDate: '2028-02-29' }));
  const invalid = ['unknown=1', 'startDate=2026-10-10', 'date=2026-10-10', 'month=2026-10', 'compare=previous', 'employeeId=x', 'kind=Pause', 'kind=%20pause', 'status=active', 'status=%20pending', 'followUpDate=2026-02-29', 'followUpDate=2026-1-01', 'followUpDate=2026-10-10T00:00:00Z', 'followUpDate=%202026-10-10%20', 'q=' + '字'.repeat(201)];
  for (const key of ['page', 'pageSize', 'q', 'kind', 'status', 'followUpDate', 'caseId']) invalid.push(key + '=1&' + key + '=1');
  for (const key of ['page', 'pageSize']) for (const value of ['', '0', '-1', '+1', '01', '1.0', '1.2', '1e1', 'NaN', 'Infinity', ' 1', '1 ', '9007199254740992']) invalid.push(key + '=' + encodeURIComponent(value));
  invalid.push('pageSize=101'); for (const query of invalid) assert.equal((await f.read(f.admin, endpoint + '?' + query)).status, 422, query);
  for (const date of ['0000-01-01', '2028-02-29']) {
    const response = await f.read(f.admin, endpoint + '?q=&kind=&status=&caseId=&followUpDate=' + date + '&page=1&pageSize=100'); assert.equal(response.status, 200); assert.equal(response.body.total, 1); assert.equal(response.body.items[0].fields.followUpDate.value, date);
  }
});

test('fresh single read rejects every query and hides foreign, missing or wrong-entity parents without repairing the original API', async t => {
  const f = await fixture(t), current = await f.create(entity, f.payload()), foreign = await f.foreign();
  const missing = f.imported(f.payload({ caseId: id() })), wrong = f.imported(f.payload({ caseId: f.employee.id })), crossParent = f.imported(f.payload({ caseId: foreign.parent.id }));
  for (const client of [f.admin, f.clients.supervisor]) {
    for (const item of [foreign.item, missing, wrong, crossParent, { id: f.employee.id }, { id: id() }]) error(await f.read(client, single(item)), 404, 'NOT_FOUND');
    for (const query of ['q=', 'page=1', 'pageSize=25', 'status=pending', 'kind=pause', 'followUpDate=2026-10-10', 'caseId=', 'unknown=', 'q=x&q=x']) error(await f.read(client, single(current) + '?' + query), 422, 'INVALID_QUERY');
    for (const path of [endpoint + '/', single(current) + '/history', single(current) + '/unknown']) error(await f.read(client, path), 404, 'NOT_FOUND');
  }
  const changed = await f.patch(entity, current, { reason: '合成真正新版原因', status: 'completed' }, f.clients.supervisor);
  const fresh = await f.read(f.admin, single(current)); assert.equal(fresh.body.item.version, 2); assert.equal(fresh.body.item.fields.reason.value, changed.reason);
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(f.payload({ caseId: id() })), current.id);
  error(await f.read(f.admin, single(current)), 404, 'NOT_FOUND'); error(await f.read(f.admin, generic(current)), 404, 'NOT_FOUND');
});

test('dedicated four-role guards run before query/body parsing while original four-role reads and histories stay authorized', async t => {
  const f = await fixture(t), current = await f.create(entity, f.payload()); await f.assigned();
  for (const role of ['finance', 'caregiver']) for (const path of [endpoint, single(current), endpoint + '/' + id(), single(current) + '/history', endpoint + '/unknown/tail']) {
    error(await f.read(f.clients[role], path + '?unknown=1&page=0&followUpDate=bogus'), 403, 'ROLE_FORBIDDEN');
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) error(await f.read(f.clients[role], path + '?unknown=1', method, undefined, { 'Content-Type': 'text/plain' }, method === 'OPTIONS' ? undefined : '{'), 403, 'ROLE_FORBIDDEN');
  }
  for (const client of Object.values(f.clients)) {
    assert.equal((await f.read(client, generic(current))).status, 200);
    assert.equal((await f.read(client, generic(current) + '/history?compare=previous')).status, 200);
  }
  for (const client of [f.admin, f.clients.supervisor]) assert.equal((await f.read(client)).status, 200);
  error(await f.read(null), 401, 'AUTH_REQUIRED'); error(await f.read({ ...f.admin, org: '' }), 400, 'ORG_REQUIRED'); error(await f.read({ ...f.admin, org: id() }), 403, 'ORG_FORBIDDEN');
  error(await f.read(f.admin, generic() + '?followUpDate=2026-10-10'), 422, 'INVALID_QUERY');
});

test('authorized known routes return405 before body parsing and unknown tails404 without weakening Origin or CSRF', async t => {
  const f = await fixture(t), item = f.imported(f.payload());
  for (const client of [f.admin, f.clients.supervisor]) for (const path of [endpoint, single(item)]) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      error(await f.read(client, path + '?unknown=1', method, undefined, { 'Content-Type': 'text/plain', 'Idempotency-Key': 'bad key' }, '{'), 405, 'METHOD_NOT_ALLOWED');
      error(await f.read(client, path, method, undefined, {}, '{"secret":"' + 'X'.repeat(140000) + '"}'), 405, 'METHOD_NOT_ALLOWED');
    }
    error(await f.read(client, path, 'OPTIONS'), 405, 'METHOD_NOT_ALLOWED'); assert.equal((await f.read(client, path, 'HEAD')).status, 405);
  }
  error(await f.read(f.admin, endpoint, 'POST', {}, { 'X-CSRF-Token': '' }), 403, 'CSRF_INVALID');
  error(await f.read(f.admin, endpoint, 'POST', {}, { Origin: 'https://synthetic-wrong-origin.example.test' }), 403, 'ORIGIN_FORBIDDEN');
  error(await f.read(f.admin, single(item) + '/unknown', 'POST', undefined, { 'Content-Type': 'text/plain' }, '{'), 404, 'NOT_FOUND');
  assert.equal((await f.read(f.admin, endpoint, 'GET', undefined, { 'Idempotency-Key': 'synthetic-read-key' })).status, 200);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM idempotency').get().n, 0);
});

test('all matching metadata is checked before paging and unsafe versions fail409 without unrelated records poisoning filters', async t => {
  const f = await fixture(t), other = await f.create('cases', { name: '合成分頁父項', caseNo: 'WL-PAGE' }), foreign = await f.foreign(), unsafe = 9007199254740993n;
  const good = f.imported(f.payload({ reason: '合成安全匹配' }));
  f.imported(f.payload({ caseId: id() }), { version: unsafe }); f.imported(f.payload({ caseId: foreign.parent.id }), { version: unsafe });
  f.imported(f.payload({ caseId: foreign.parent.id }), { version: unsafe, org: foreign.client.org }); f.imported(f.payload(), { version: unsafe, entity: 'assessments' });
  assert.deepEqual((await f.read(f.admin)).body.items.map(x => x.id), [good.id]);
  for (let n = 0; n < 26; n++) f.imported(f.payload({ caseId: other.id, reason: '合成全頁匹配' }), { created: '2026-10-10T06:00:00.000Z' });
  const damaged = f.imported(f.payload({ caseId: other.id, reason: '合成全頁匹配' }), { version: unsafe, created: '2026-10-09T00:00:00.000Z' });
  error(await f.read(f.admin, endpoint + '?caseId=' + other.id + '&page=1'), 409, 'FOLLOWUP_DATA_INVALID'); error(await f.read(f.admin, single(damaged)), 409, 'FOLLOWUP_DATA_INVALID');
  assert.equal((await f.read(f.admin, endpoint + '?q=合成安全匹配')).status, 200);
  for (const version of [0, -1, 1.5]) error(await f.read(f.admin, single(f.imported(f.payload(), { version }))), 409, 'FOLLOWUP_DATA_INVALID');
  const blank = f.imported(f.payload(), { id: '   ' }); error(await f.read(f.admin, single(blank)), 409, 'FOLLOWUP_DATA_INVALID');
  const parent = f.imported({ name: '合成空白識別父項', caseNo: 'WL-BLANK', status: 'active' }, { entity: 'cases', id: '\t ' });
  error(await f.read(f.admin, single(f.imported(f.payload({ caseId: parent.id })))), 409, 'FOLLOWUP_DATA_INVALID');
  const max = f.imported(f.payload({ reason: '合成最大安全版次' }), { version: Number.MAX_SAFE_INTEGER }); assert.equal((await f.read(f.admin, single(max))).body.item.version, Number.MAX_SAFE_INTEGER);
});

test('nonfinite visible scalar is rejected but unknown/nested values remain hidden and original exactprevious actors persist', async t => {
  const f = await fixture(t), data = f.payload({ note: null });
  const damaged = f.imported(data, { rawData: JSON.stringify(data).replace('"note":null', '"note":1e400') }); error(await f.read(f.admin, single(damaged)), 409, 'FOLLOWUP_DATA_INVALID');
  const hidden = f.imported(data, { rawData: JSON.stringify(data).replace('"note":null', '"note":{"private":1e400},"unknown":1e400') }); assert.deepEqual((await f.read(f.admin, single(hidden))).body.item.fields.note, { kind: 'object' });
  assert.equal((await f.read(f.admin, endpoint + '?q=Infinity')).body.total, 0);
  let item = await f.create(entity, f.payload(), f.admin, { 'Idempotency-Key': 'synthetic-original-create' });
  item = await f.patch(entity, item, { reason: '合成第二版', outcome: '合成已處理' }, f.clients.supervisor);
  item = await f.patch(entity, item, { note: '合成第三版', status: 'completed' });
  const history = await f.read(f.clients.supervisor, generic(item) + '/history?compare=previous'); assert.equal(history.status, 200);
  assert.deepEqual(history.body.items.map(row => row.version), [3, 2, 1]); assert.equal(history.body.items[0].actor.id, f.admin.user.id); assert.equal(history.body.items[1].actor.id, f.clients.supervisor.user.id);
  assert.equal(history.body.items[0].comparison.previousVersion, 2); assert.equal(history.body.items[0].comparison.previousSnapshot.reason, '合成第二版');
  const before = f.raw(); assert.equal((await f.read(f.admin, single(item))).body.item.version, 3);
  assert.deepEqual((await f.read(f.clients.finance, generic(item) + '/history?compare=previous')).body, history.body); assert.deepEqual(f.raw(), before);
});

test('read successes and failures preserve approved snapshots, nonempty both BLOB tables and original idempotency receipts', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload(), f.admin, { 'Idempotency-Key': 'synthetic-protected-create' }), assigned = await f.assigned(true);
  const pdf = Buffer.from('%PDF-1.4\nSynthetic manual followup protected bytes\n%%EOF');
  await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成個案保護附件', fileName: 'synthetic-case.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') });
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成保護證照', issuedOn: '2026-01-01' });
  await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成證照保護附件', fileName: 'synthetic-cert.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') });
  const approved = (await f.read(f.admin, '/api/service-records/' + assigned.record.id)).body.item.billingSnapshot; assert(approved);
  const before = f.raw(); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1); assert.equal(before.tables.idempotency.length, 1);
  assert.deepEqual(Buffer.from(before.tables.attachment_files[0].content), pdf); assert.deepEqual(Buffer.from(before.tables.certification_attachment_files[0].content), pdf);
  for (const path of [endpoint, single(item), endpoint + '?followUpDate=2026-10-10&status=pending&kind=pause', endpoint + '?q=合成不存在', endpoint + '?caseId=' + id(), single(item) + '?q=']) await f.read(f.admin, path, 'GET', undefined, { 'Idempotency-Key': 'synthetic-read-reused-key' });
  await f.read(f.clients.finance, endpoint); await f.read(f.admin, single(item), 'POST', { note: '合成不允許的寫入' }, { 'Idempotency-Key': 'synthetic-rejected-write-key' });
  assert.deepEqual(f.raw(), before); assert.deepEqual((await f.read(f.admin, '/api/service-records/' + assigned.record.id)).body.item.billingSnapshot, approved);
});
