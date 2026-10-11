import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { business, id, now } from '../src/server/model.mjs';
import { interviewExtensionSpec } from '../src/server/interview-extension.mjs';

const entity = 'interview-applicants';
const fields = ['name', 'phone', 'interviewDate', 'city', 'district', 'interviewContent', 'note', 'status'];
const route = (item, suffix = '') => '/api/' + entity + (item ? '/' + item.id : '') + suffix;
const password = 'synthetic-interview-password';

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
  const setup = await request(null, 'POST', '/api/setup', { name: '合成面試管理員', email: 'interview-admin@example.test', password, organizationName: '合成面試機構甲' });
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
  const employee = await create('employees', { name: '合成原居服員', employeeNo: 'IA-EMP', hourlyRateCents: 12345 });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = `interview-${role}@example.test`;
    await create('users', { name: '合成面試' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const payload = overrides => ({ name: '合成面試者', phone: '合成電話文字', interviewDate: '2026-10-10', interviewContent: '合成面試內容', ...overrides });
  function ledger() { return Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare('SELECT count(*) n FROM ' + table).get().n])); }
  function raw() {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(x => x.type === 'table'); assert.equal(tables.length, 11); assert.equal(schema.filter(x => x.type === 'trigger').length, 6);
    return { schema, tables: Object.fromEntries(tables.map(x => [x.name, app.db.prepare('SELECT * FROM "' + x.name + '" ORDER BY rowid').all()])), totalChanges: app.db.prepare('SELECT total_changes() n').get().n };
  }
  function unrelated() {
    const state = raw(); delete state.totalChanges;
    state.tables.records = state.tables.records.filter(x => x.entity !== entity);
    state.tables.record_versions = state.tables.record_versions.filter(x => x.entity !== entity);
    state.tables.audit = state.tables.audit.filter(x => x.entity !== entity);
    state.tables.idempotency = state.tables.idempotency.filter(x => !x.route.startsWith('POST /api/' + entity));
    return state;
  }
  function imported(data, { version = 1, savedVersions = [version] } = {}) {
    const recordId = id(), time = now(), full = { ...data, id: recordId, orgId: admin.org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, admin.org, entity, JSON.stringify(data), version, time, time);
    for (const v of savedVersions) app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(admin.org, entity, recordId, v, JSON.stringify({ ...full, version: v, note: v === version ? data.note : '合成匯入第' + v + '版' }), time, 'baseline');
    return full;
  }
  async function foreign() {
    const org = await create('organizations', { name: '合成面試機構乙' }), client = { ...admin, org: org.id };
    return { client, item: await create(entity, payload({ name: 'SYNTHETIC-FOREIGN-INTERVIEW' }), client) };
  }
  return { app, base, request, create, patch, admin, clients, employee, payload, ledger, raw, unrelated, imported, foreign };
}

test('original eight fields retain supplied trim, new POST has18 fields/defaults, and status toggles have no hiring side effects', async t => {
  const f = await fixture(t), protectedBefore = f.unrelated();
  let item = await f.create(entity, f.payload({ name: ' 合成姓名 ', phone: ' 合成不作格式審查的電話+ext ', interviewDate: ' 2026-10-10 ', city: ' 合成縣市 ', district: ' 合成鄉鎮 ', interviewContent: ' 合成面試\r\n第二行 ', note: ' 合成備註\n ', status: ' active ' }), f.clients.supervisor);
  assert.deepEqual(Object.keys(business(item)).sort(), interviewExtensionSpec.fields.split(' ').sort());
  for (const key of fields) assert.equal(item[key], item[key].trim());
  assert.equal(item.interviewContent, '合成面試\r\n第二行');
  const defaults = await f.create(entity, f.payload());
  assert.deepEqual(business(defaults), { ...interviewExtensionSpec.defaults, ...f.payload() });
  const duplicate = await f.create(entity, f.payload()); assert.notEqual(duplicate.id, defaults.id, 'No unapproved name/phone deduplication policy');
  item = await f.patch(item, { status: 'inactive' }); assert.equal(item.status, 'inactive');
  item = await f.patch(item, { status: 'active' }, f.clients.supervisor); assert.equal(item.status, 'active'); assert.equal(item.version, 3);
  assert.deepEqual(f.unrelated(), protectedBefore); assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404);
});

test('input validation rejects nonwhite required values, types, length, single-line violations and impossible dates atomically', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), before = f.raw();
  const invalid = [
    { status: '' }, { status: 'hired' }, { status: 'Active' }, { interviewDate: '2026-02-29' }, { interviewDate: '2026-1-01' }, { interviewDate: '2026-10-10T00:00:00Z' },
    { name: '字'.repeat(201) }, { phone: '字'.repeat(65) }, { city: '字'.repeat(101) }, { district: '字'.repeat(101) }, { interviewContent: '字'.repeat(10001) }, { note: '字'.repeat(10001) },
    { employeeId: f.employee.id }, { billingSnapshot: {} }, { hire: true }, { salary: 100 }, { id: id() },
  ];
  for (const key of fields) for (const value of [null, 1, false, [], {}]) invalid.push({ [key]: value });
  for (const key of ['name', 'phone', 'interviewDate', 'interviewContent']) for (const value of ['', ' \t\r\n　 ']) invalid.push({ [key]: value });
  for (const key of ['name', 'phone', 'city', 'district']) for (const value of ['合成\r文字', '合成\n文字', '合成\r\n文字']) invalid.push({ [key]: value });
  for (const patch of invalid) {
    const result = await f.request(f.admin, 'POST', route(), f.payload(patch)); assert.equal(result.status, 422, JSON.stringify(patch));
    assert.deepEqual(f.raw(), before);
  }
  for (const key of ['name', 'phone', 'interviewDate', 'interviewContent']) { const data = f.payload(); delete data[key]; const r = await f.request(f.admin, 'POST', route(), data); assert.equal(r.status, 422); assert(Object.hasOwn(r.body.error.fields, key)); }
  for (const data of [null, []]) assert.equal((await f.request(f.admin, 'POST', route(), data)).status, 400);
  assert.equal((await f.request(f.admin, 'POST', route(), undefined, {}, '{')).body.error.code, 'INVALID_JSON');
  assert.equal((await f.request(f.admin, 'POST', route(), f.payload(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request(f.admin, 'POST', route(), undefined, {}, '{"name":"' + 'x'.repeat(1048576) + '"}')).status, 413);
  assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, phone: '合成\n無效' })).status, 422);
  assert.deepEqual(f.raw(), before);
});

test('exact boundaries allow 10000 content characters and preserve other entities existing limits', async t => {
  const f = await fixture(t);
  for (const interviewDate of ['0000-01-01', '2024-02-29', '9999-12-31']) {
    const item = await f.create(entity, f.payload({ name: '字'.repeat(200), phone: '字'.repeat(64), city: '字'.repeat(100), district: '字'.repeat(100), interviewContent: '字'.repeat(10000), note: '字'.repeat(10000), interviewDate }));
    assert.equal(item.interviewContent.length, 10000); assert.equal(item.interviewDate, interviewDate);
    const updated = await f.patch(item, { interviewContent: '新'.repeat(10000) }); assert.equal(updated.interviewContent.length, 10000);
  }
  const before = f.raw();
  const oldEntityResult = await f.request(f.admin, 'POST', '/api/employees', { name: '字'.repeat(501), employeeNo: 'IA-NARROW-LIMIT' });
  assert.equal(oldEntityResult.status, 422); assert.deepEqual(f.raw(), before);
});

test('finance and caregiver all methods and history reject before parsing any query or body without existence leakage', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), missing = { id: id() }, before = f.raw();
  for (const role of ['finance', 'caregiver']) {
    const client = f.clients[role];
    for (const path of [route(), route(item), route(missing), route(item, '/history'), route(missing, '/history'), route(item, '/unknown-suffix')]) {
      const read = await f.request(client, 'GET', path + '?page=0&status=bogus&compare=wrong&unknown=1');
      assert.equal(read.status, 403); assert.equal(read.body.error.code, 'ROLE_FORBIDDEN');
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const write = await f.request(client, method, path + '?page=0', undefined, { 'Content-Type': 'text/plain' }, '{');
        assert.equal(write.status, 403); assert.equal(write.body.error.code, 'ROLE_FORBIDDEN');
      }
    }
  }
  assert.deepEqual(f.raw(), before);
});

test('admin and supervisor current records and every history query retain organization isolation and wrong-entity404', async t => {
  const f = await fixture(t), own = await f.create(entity, f.payload()), foreign = await f.foreign(), before = f.raw();
  for (const client of [f.admin, f.clients.supervisor]) {
    for (const item of [foreign.item, { id: f.employee.id }, { id: id() }]) for (const suffix of ['', '/history', '/history?compare=previous']) {
      const response = await f.request(client, 'GET', route(item, suffix)); assert.equal(response.status, 404);
      assert(!JSON.stringify(response.body).includes('SYNTHETIC-FOREIGN-INTERVIEW'));
    }
    assert.equal((await f.request(client, 'GET', route())).body.total, 1);
    assert.deepEqual((await f.request(client, 'GET', route(own))).body.item, own);
  }
  assert.equal((await f.request(foreign.client, 'GET', route(own))).status, 404);
  assert.equal((await f.request(foreign.client, 'PATCH', route(own), { version: own.version, note: '合成跨機構修改' })).status, 404);
  assert.deepEqual(f.raw(), before);
});

test('closed five-key queries and single GET pagination are validated without mutating any original table', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), before = f.raw();
  const invalid = ['unknown=1', 'caseId=x', 'employeeId=x', 'date=2026-10-10', 'month=2026-10', 'compare=previous', 'q=' + '字'.repeat(201), 'status=', 'status=hired', 'interviewDate=', 'interviewDate=2026-02-29', 'interviewDate=%202026-10-10%20', 'page=0', 'page=-1', 'page=1.5', 'page=NaN', 'pageSize=0', 'pageSize=101'];
  for (const key of ['page', 'pageSize', 'q', 'status', 'interviewDate']) invalid.push(key + '=1&' + key + '=1');
  for (const query of invalid) for (const target of [null, item]) assert.equal((await f.request(f.admin, 'GET', route(target, '?' + query))).status, 422, query);
  assert.equal((await f.request(f.admin, 'GET', route(item, '?interviewDate=2024-02-29&status=inactive&q=not-current'))).status, 200, 'Single GET validates but does not reinterpret item identity as filters');
  assert.equal((await f.request(f.admin, 'GET', route(null, '?q=&pageSize=100&interviewDate=2026-10-10&status=active'))).body.total, 1);
  assert.deepEqual(f.raw(), before);
});

test('search exact manual-date status and server pagination apply before25-plus3 page slicing', async t => {
  const f = await fixture(t), items = [];
  for (let n = 1; n <= 28; n++) items.push(await f.create(entity, f.payload({ name: '合成共同候選' + String(n).padStart(2, '0'), status: n === 25 ? 'inactive' : 'active' })));
  await f.create(entity, f.payload({ name: '合成共同另一日', interviewDate: '2026-10-11' }));
  const before = f.raw(), q = '?interviewDate=2026-10-10&q=' + encodeURIComponent('合成共同');
  const first = (await f.request(f.admin, 'GET', route(null, q))).body, second = (await f.request(f.clients.supervisor, 'GET', route(null, q + '&page=2'))).body;
  assert.equal(first.total, 28); assert.equal(first.items.length, 25); assert.equal(second.items.length, 3);
  assert.deepEqual(new Set([...first.items, ...second.items].map(x => x.id)), new Set(items.map(x => x.id)));
  const inactive = (await f.request(f.admin, 'GET', route(null, q + '&status=inactive'))).body;
  assert.equal(inactive.total, 1); assert.equal(inactive.items[0].name, '合成共同候選25');
  assert.equal((await f.request(f.admin, 'GET', route(null, '?interviewDate=2026-10-11'))).body.total, 1);
  assert.equal((await f.request(f.admin, 'GET', route(null, '?q=合成不存在候選'))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', route(null, q + '&pageSize=100'))).body.items.length, 28);
  assert.deepEqual(f.raw(), before);
});

test('idempotent creates atomic versions and actual audit commits with CAS conflict and exact raw-payload key digest', async t => {
  const f = await fixture(t), before = f.ledger(), headers = { 'Idempotency-Key': 'synthetic-interview-once' }, payload = f.payload({ name: ' 合成同鍵候選 ' });
  const one = await f.request(f.admin, 'POST', route(), payload, headers); assert.equal(one.status, 201);
  const after = f.ledger(); for (const key of Object.keys(before)) assert.equal(after[key], before[key] + 1);
  const saved = f.raw(), retry = await f.request(f.admin, 'POST', route(), payload, headers);
  assert.equal(retry.status, 201); assert.deepEqual(retry.body, one.body); assert.deepEqual(f.raw(), saved);
  const changed = await f.request(f.admin, 'POST', route(), { ...payload, name: payload.name.trim() }, headers);
  assert.equal(changed.status, 409); assert.equal(changed.body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.raw(), saved);
  for (const version of [undefined, 0, '1', 1.2]) assert.equal((await f.request(f.admin, 'PATCH', route(one.body.item), { version, note: '合成無效版次' })).status, 422);
  assert.deepEqual(f.raw(), saved);
  const results = await Promise.all([f.request(f.admin, 'PATCH', route(one.body.item), { version: 1, note: '合成競爭甲' }), f.request(f.clients.supervisor, 'PATCH', route(one.body.item), { version: 1, note: '合成競爭乙' })]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  const latest = f.ledger(); assert.equal(latest.records, after.records); assert.equal(latest.record_versions, after.record_versions + 1); assert.equal(latest.audit, after.audit + 1); assert.equal(latest.idempotency, after.idempotency);
  const history = (await f.request(f.admin, 'GET', route(one.body.item, '/history?compare=previous'))).body.items;
  assert.equal(history[0].comparison.previousVersion, 1); assert.equal(history[0].snapshot.version, 2); assert.equal(history[1].actor.id, f.admin.user.id);
});

test('only supplied fields normalize while meaningful saved whitespace and CRLF remain exact; invalid merged legacy fields fail without repair', async t => {
  const f = await fixture(t);
  const data = { ...f.payload({ name: ' 合成原姓名 ', phone: ' 合成原電話 ', interviewContent: ' \r\n合成原內容\r\n ' }), city: ' 合成原縣市 ', district: '', note: ' \r合成原備註\r\n ', status: 'active' };
  const item = f.imported(data), updated = await f.patch(item, { city: ' 合成新縣市 ' });
  for (const key of fields.filter(key => key !== 'city')) assert.equal(updated[key], data[key]); assert.equal(updated.city, '合成新縣市');
  const history = (await f.request(f.admin, 'GET', route(updated, '/history?compare=previous'))).body.items[0];
  assert.equal(history.snapshot.interviewContent, data.interviewContent); assert.equal(history.comparison.previousSnapshot.note, data.note);
  for (const bad of [{ name: '   ' }, { phone: '\t ' }, { interviewContent: ' \r\n　 ' }, { name: '合成\r\n姓名' }, { city: '合成\n縣市' }, { note: { private: 'synthetic-legacy-object' } }]) {
    const imported = f.imported({ ...data, ...bad }), before = f.raw();
    const result = await f.request(f.admin, 'PATCH', route(imported), { version: imported.version, district: '合成只改他欄' });
    assert.equal(result.status, 422); assert.deepEqual(f.raw(), before); assert.deepEqual((await f.request(f.admin, 'GET', route(imported))).body.item, imported);
  }
});

test('raw and compared histories read exact previous actor across pages and preserve all tables and immutable triggers', async t => {
  const f = await fixture(t); let item = await f.create(entity, f.payload());
  for (let v = 2; v <= 28; v++) item = await f.patch(item, { note: '合成面試第' + v + '版', status: v % 2 ? 'active' : 'inactive' }, v % 2 ? f.admin : f.clients.supervisor);
  const before = f.raw();
  const first = (await f.request(f.clients.supervisor, 'GET', route(item, '/history?compare=previous&page=1'))).body, second = (await f.request(f.admin, 'GET', route(item, '/history?compare=previous&page=2'))).body;
  assert.equal(first.total, 28); assert.equal(first.items.length, 25); assert.equal(second.items.length, 3);
  assert.deepEqual(first.items[0].actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name });
  assert.equal(first.items[0].comparison.previousVersion, 27); assert.deepEqual(first.items.at(-1).comparison.previousSnapshot, second.items[0].snapshot);
  assert.deepEqual(second.items.at(-1).actor, { id: f.admin.user.id, name: f.admin.user.name }); assert.equal(second.items.at(-1).comparison.status, 'initial');
  const raw = (await f.request(f.admin, 'GET', route(item, '/history'))).body.items;
  assert(raw.every(row => !Object.hasOwn(row, 'actor') && !Object.hasOwn(row, 'comparison')));
  for (const q of ['compare=', 'compare=next', 'compare=previous&compare=previous', 'page=0', 'pageSize=101']) assert.equal((await f.request(f.admin, 'GET', route(item, '/history?' + q))).status, 422);
  assert.deepEqual(f.raw(), before);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('synthetic-tamper', item.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(item.id), /immutable/);
});

test('imported history gaps remain unavailable and actual actor resolver ignores other entities and ambiguity', async t => {
  const f = await fixture(t), item = f.imported({ ...f.payload(), status: 'inactive', city: '', district: '', note: '合成第6版' }, { version: 6, savedVersions: [1, 2, 4, 6] });
  const time = now();
  const event = (userId, recordEntity, version) => f.app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), f.admin.org, userId, 'record.update', recordEntity, item.id, JSON.stringify({ version }), time);
  event(f.admin.user.id, 'employees', 6); event(f.admin.user.id, entity, 4); event(f.clients.supervisor.user.id, entity, 4);
  const before = f.raw(), history = (await f.request(f.admin, 'GET', route(item, '/history?compare=previous'))).body.items;
  assert.deepEqual(history.map(x => x.version), [6, 4, 2, 1]);
  assert.equal(history[0].actor, null); assert.equal(history[1].actor, null);
  for (const row of history.slice(0, 2)) assert.deepEqual(row.comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
  assert.equal(history[2].comparison.previousVersion, 1); assert.equal(history[2].comparison.status, 'available'); assert.deepEqual(f.raw(), before);
  const next = await f.patch(item, { note: '合成真操作第7版' }, f.clients.supervisor);
  const row = (await f.request(f.admin, 'GET', route(next, '/history?compare=previous'))).body.items[0];
  assert.equal(row.actor.id, f.clients.supervisor.user.id); assert.equal(row.comparison.previousVersion, 6);
});

test('authentication CSRF and Origin reject writes while administrative CRUD preserves original billing snapshots and both BLOB tables', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload());
  const caseItem = await f.create('cases', { name: '合成原個案', caseNo: 'IA-CASE' });
  const service = await f.create('service-items', { code: 'IA-SERVICE', name: '合成原服務', minutes: 60, unitPriceCents: 8765 });
  const plan = await f.create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 5 }] });
  const shift = await f.create('shifts', { caseId: caseItem.id, employeeId: f.employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: plan.services });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: f.employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:55', services: shift.services, status: 'submitted' });
  const approved = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成原核閱' }); assert.equal(approved.status, 200);
  const snapshot = (await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item.billingSnapshot; assert(snapshot);
  const pdf = Buffer.from('%PDF-1.4\nSynthetic interview protected attachment\n%%EOF');
  await f.create('case-attachments/upload', { caseId: caseItem.id, title: '合成原個案附件', fileName: 'synthetic-case.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') });
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成原證照', issuedOn: '2026-01-01' });
  await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成原證照附件', fileName: 'synthetic-cert.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') });
  const protectedBefore = f.unrelated(), before = f.raw();
  assert.equal(protectedBefore.tables.attachment_files.length, 1); assert.equal(protectedBefore.tables.certification_attachment_files.length, 1);
  assert.deepEqual(Buffer.from(protectedBefore.tables.attachment_files[0].content), pdf);
  assert.deepEqual(Buffer.from(protectedBefore.tables.certification_attachment_files[0].content), pdf);
  assert.equal((await f.request(null, 'GET', route())).status, 401);
  for (const headers of [{ 'X-CSRF-Token': '' }, { Origin: 'https://synthetic-wrong-origin.example.test' }]) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: '合成拒絕' }, headers)).status, 403);
  assert.deepEqual(f.raw(), before);
  const other = await f.create(entity, f.payload({ name: '合成另位面試者' })); await f.patch(other, { status: 'inactive', note: '合成人工封存' });
  assert.deepEqual(f.unrelated(), protectedBefore);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item.billingSnapshot, snapshot);
});
