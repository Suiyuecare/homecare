import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { business, id, now } from '../src/server/model.mjs';
import { interviewExtensionSpec } from '../src/server/interview-extension.mjs';
const entity = 'interview-applicants', password = 'synthetic-interview-extension-password';
const route = (item, suffix = '') => '/api/' + entity + (item ? '/' + item.id : '') + suffix;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), baseUrl = await app.listen(); t.after(() => app.close());
  async function request(client, method, path, data, headers = {}, rawBody) {
    const hasBody = data !== undefined || rawBody !== undefined;
    const response = await fetch(baseUrl + path, { method, headers: { Origin: baseUrl,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(hasBody ? { body: rawBody === undefined ? JSON.stringify(data) : rawBody } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成18欄面試管理員', email: 'extension-admin@example.test', password, organizationName: '合成面試擴充機構甲' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(kind, data, client = admin, headers = {}) {
    const result = await request(client, 'POST', '/api/' + kind, data, headers); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(item, data, client = admin) {
    const result = await request(client, 'PATCH', route(item), { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成面試員工甲', employeeNo: 'EXT-A', hourlyRateCents: 12345 });
  const inactive = await create('employees', { name: '合成已停用員工乙', employeeNo: 'EXT-B', hourlyRateCents: 23456, status: 'inactive' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = `extension-${role}@example.test`;
    await create('users', { name: '合成擴充' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200);
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const payload = overrides => ({ name: '合成18欄面試者', phone: '合成人工電話', interviewDate: '2026-10-10', interviewContent: '合成面試內容', ...overrides });
  function raw() {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(), tables = schema.filter(x => x.type === 'table');
    return { schema, tables: Object.fromEntries(tables.map(x => [x.name, app.db.prepare('SELECT * FROM "' + x.name + '" ORDER BY rowid').all()])), totalChanges: app.db.prepare('SELECT total_changes() n').get().n };
  }
  function unrelated() {
    const result = raw(); delete result.totalChanges;
    for (const name of ['records', 'record_versions', 'audit']) result.tables[name] = result.tables[name].filter(row => row.entity !== entity);
    result.tables.idempotency = result.tables.idempotency.filter(row => !row.route.startsWith('POST /api/' + entity)); return result;
  }
  function ledger() { return Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare('SELECT count(*) n FROM ' + table).get().n])); }
  function imported(data, { version = 1, org = admin.org, history = [] } = {}) {
    const recordId = id(), time = now(), item = { ...data, id: recordId, orgId: org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, org, entity, typeof data === 'string' ? data : JSON.stringify(data), version, time, time);
    const snapshots = history.length ? history : [{ sqlVersion: version, snapshot: item }];
    for (const { sqlVersion, snapshot } of snapshots) app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(org, entity, recordId, sqlVersion,
      typeof snapshot === 'string' ? snapshot : JSON.stringify({ ...snapshot, id: recordId, orgId: org, createdAt: time, updatedAt: time }), time, 'synthetic-baseline');
    return item;
  }
  async function foreign() {
    const org = await create('organizations', { name: '合成面試擴充機構乙' }), client = { ...admin, org: org.id };
    return { client, employee: await create('employees', { name: 'SYNTHETIC-FOREIGN-INTERVIEWER', employeeNo: 'EXT-FOREIGN', hourlyRateCents: 98765 }, client), item: await create(entity, payload({ name: 'SYNTHETIC-FOREIGN-APPLICANT' }), client) };
  }
  return { app, request, admin, clients, employee, inactive, create, patch, payload, raw, unrelated, ledger, imported, foreign };
}

test('new eighteen-field company records save full exact extension values and status toggles cause no employment, grants or finance side effects', async t => {
  const f = await fixture(t), protectedBefore = f.unrelated();
  let item = await f.create(entity, f.payload({ name: ' 合成原8姓名 ', interviewContent: ' 合成原8內容\r\n ', appliedPosition: '  合成居家職務  ', education: '\t合成學歷 ', workExperience: ' 合成經歷\r\n ', availableFrom: ' 2026-10-10 ', availableHours: ' 合成時段\r\n ', certificateNotes: ' 合成證照說明\r\n ', interviewQuestions: ' 合成提問\r\n ', interviewerEmployeeId: f.employee.id, decision: ' selected ', decisionReason: '  合成本次人工依據\r\n ' }), f.clients.supervisor);
  assert.deepEqual(Object.keys(business(item)).sort(), interviewExtensionSpec.fields.split(' ').sort());
  assert.equal(item.name, '合成原8姓名'); assert.equal(item.interviewContent, '合成原8內容'); assert.equal(item.workExperience, ' 合成經歷\r\n '); assert.equal(item.decisionReason, '  合成本次人工依據\r\n ');
  assert.equal(item.appliedPosition, '  合成居家職務  '); assert.equal(item.decision, 'selected'); assert.equal(item.availableFrom, '2026-10-10');
  const defaults = await f.create(entity, f.payload()); assert.equal(defaults.decision, 'pending'); assert.equal(defaults.interviewerEmployeeId, ''); assert.equal(defaults.education, '');
  item = await f.patch(item, { status: 'inactive' }); item = await f.patch(item, { status: 'active' }, f.clients.supervisor); assert.equal(item.decision, 'selected'); assert.equal(item.version, 3);
  assert.deepEqual(f.unrelated(), protectedBefore); assert.equal((await f.request(f.admin, 'DELETE', route(item))).status, 404);
});

test('legacy eight-field records are not backfilled; unrelated editing and histories preserve missing extension fields and original CRLF exactly', async t => {
  const f = await fixture(t), legacyData = { ...f.payload({ name: ' 合成原姓名 ', interviewContent: ' \r\n合成原內容\r\n ' }), city: '', district: '', note: ' \r合成原備註\r\n ', status: 'active' }, old = f.imported(legacyData);
  assert.deepEqual((await f.request(f.admin, 'GET', route(old))).body.item, old);
  const updated = await f.patch(old, { city: ' 合成改縣市 ' }); assert.equal(updated.city, '合成改縣市'); assert.equal(updated.interviewContent, legacyData.interviewContent); assert.equal(updated.note, legacyData.note);
  for (const key of interviewExtensionSpec.fields.split(' ').filter(key => !Object.hasOwn(legacyData, key))) assert.equal(Object.hasOwn(updated, key), false, key);
  const before = f.raw(), history = (await f.request(f.admin, 'GET', route(updated, '/history?compare=previous'))).body.items;
  assert.equal(history[0].comparison.previousSnapshot.interviewContent, legacyData.interviewContent); assert(!Object.hasOwn(history[0].snapshot, 'decision'));
  assert.deepEqual(f.raw(), before);
  const malformedOld = f.imported({ ...legacyData, note: { legacy: '合成只可顯示型別標記' } }); assert.equal((await f.request(f.admin, 'GET', route(malformedOld))).status, 200);
  const malformedBefore = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(malformedOld), { version: 1, district: '合成改他欄' })).status, 422); assert.deepEqual(f.raw(), malformedBefore);
});

test('closed extension types, scalar constraints, length bounds and real optional dates fail without writes', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), before = f.raw();
  const invalid = [{ unknown: 'synthetic' }, { employeeId: f.employee.id }, { hired: true }, { decision: 'hired' }, { availableFrom: '2026-02-29' }, { availableFrom: '0000-01-01' }, { availableFrom: '2026-1-01' }, { appliedPosition: '合成\n跨行' }, { education: '合成\r跨行' }];
  for (const key of ['appliedPosition', 'education', 'workExperience', 'availableFrom', 'availableHours', 'certificateNotes', 'interviewQuestions', 'interviewerEmployeeId', 'decision', 'decisionReason']) {
    for (const value of [null, [], {}, 1, true]) invalid.push({ [key]: value });
    invalid.push({ [key]: '字'.repeat(interviewExtensionSpec.maxLengths[key] + 1) });
  }
  for (const patch of invalid) {
    assert.equal((await f.request(f.admin, 'POST', route(), f.payload(patch))).status, 422, JSON.stringify(patch).slice(0, 120));
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, ...patch })).status, 422); assert.deepEqual(f.raw(), before);
  }
});

test('finance/caregiver read and writes reject before malformed bodies/queries; anonymous, CSRF and cross-Origin fail without mutation', async t => {
  const f = await fixture(t), item = await f.create(entity, f.payload()), before = f.raw();
  for (const role of ['finance', 'caregiver']) for (const path of [route(), route(item), route({ id: id() }), route(item, '/history'), route(item, '/unknown-suffix')]) {
    assert.equal((await f.request(f.clients[role], 'GET', path + '?unknown=1&page=0')).status, 403);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal((await f.request(f.clients[role], method, path, undefined, { 'Content-Type': 'text/plain' }, '{')).status, 403);
  }
  assert.equal((await f.request(null, 'GET', route())).status, 401);
  for (const headers of [{ 'X-CSRF-Token': '' }, { Origin: 'https://synthetic-wrong-origin.example.test' }]) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, decision: 'selected', decisionReason: '合成不能保存' }, headers)).status, 403);
  assert.deepEqual(f.raw(), before);
});

test('new interviewer assignments require active same-org references; original inactive references stay readable in current/history without broadening roles', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  let item = await f.create(entity, f.payload({ interviewerEmployeeId: f.employee.id }));
  const employeeUpdate = await f.request(f.admin, 'PATCH', '/api/employees/' + f.employee.id, { version: f.employee.version, status: 'inactive' }); assert.equal(employeeUpdate.status, 200);
  const before = f.raw(); assert.equal((await f.request(f.admin, 'GET', route(item))).body.item.interviewerEmployeeId, f.employee.id); assert.equal((await f.request(f.admin, 'GET', route(item, '/history'))).body.total, 1);
  for (const interviewerEmployeeId of [f.inactive.id, foreign.employee.id, id()]) assert.equal((await f.request(f.admin, 'POST', route(), f.payload({ interviewerEmployeeId }))).status, 422);
  for (const target of [foreign.item, { id: f.employee.id }, { id: id() }]) for (const suffix of ['', '/history', '/history?compare=previous']) assert.equal((await f.request(f.admin, 'GET', route(target, suffix))).status, 404);
  assert.equal((await f.request(foreign.client, 'PATCH', route(item), { version: item.version, note: '合成跨機構修改' })).status, 404); assert.deepEqual(f.raw(), before);
  item = await f.patch(item, { workExperience: '合成只改人工經歷' }); assert.equal(item.interviewerEmployeeId, f.employee.id);
  item = await f.patch(item, { interviewerEmployeeId: '' }); assert.equal(item.interviewerEmployeeId, '');
  assert.equal((await f.request(f.admin, 'GET', route(item, '/history'))).body.total, 3, 'Inactive prior same-org reference remains historically readable');
});

test('manual decision reversals require explicit current reasons while status remains independent and versioned histories show the original reason', async t => {
  const f = await fixture(t); let item = await f.create(entity, f.payload({ decision: 'selected', decisionReason: '合成原人工原因', status: 'inactive' }));
  for (const decision of ['selected', 'considering', 'not_selected', 'pending']) {
    const before = f.raw();
    for (const decisionReason of [undefined, '', ' \t\r\n ']) assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: item.version, decision, ...(decisionReason === undefined ? {} : { decisionReason }) })).status, 422);
    assert.deepEqual(f.raw(), before);
    item = await f.patch(item, { decision, decisionReason: '  合成本次' + decision + '依據\r\n ' }); assert.equal(item.status, 'inactive'); assert.equal(item.decision, decision);
  }
  const before = f.raw(), history = (await f.request(f.clients.supervisor, 'GET', route(item, '/history?compare=previous'))).body.items;
  assert.equal(history.length, 5); assert.equal(history.at(-1).snapshot.decisionReason, '合成原人工原因'); assert.equal(history[0].comparison.previousSnapshot.decision, 'not_selected'); assert.deepEqual(f.raw(), before);
});

test('closed current/history sources hide unknown new nested values and foreign parents; SQL metadata mismatches and invalid JSON histories do not leak or write', async t => {
  const f = await fixture(t), foreign = await f.foreign();
  const corrupted = [];
  for (const patch of [{ workExperience: { private: 'SYNTHETIC-HIDDEN-NESTED' } }, { decisionReason: null }, { interviewerEmployeeId: foreign.employee.id }, { unexpectedNewField: 'SYNTHETIC-HIDDEN-FIELD' }]) corrupted.push(f.imported({ ...f.payload(), ...interviewExtensionSpec.defaults, ...patch }));
  for (const data of ['{', 'null', '[]']) corrupted.push(f.imported(data));
  const valid = f.imported({ ...f.payload(), ...interviewExtensionSpec.defaults }, { version: 5, history: [
    { sqlVersion: 1, snapshot: { ...f.payload(), ...interviewExtensionSpec.defaults, ...{ version: 1 } } },
    { sqlVersion: 2, snapshot: '{' }, { sqlVersion: 3, snapshot: 'null' },
    { sqlVersion: 4, snapshot: { ...f.payload(), ...interviewExtensionSpec.defaults, version: 4, interviewerEmployeeId: foreign.employee.id } },
    { sqlVersion: 5, snapshot: { ...f.payload(), ...interviewExtensionSpec.defaults, version: 6 } },
  ] });
  const before = f.raw();
  for (const item of corrupted) {
    for (const suffix of ['', '/history', '/history?compare=previous']) assert.equal((await f.request(f.admin, 'GET', route(item, suffix))).status, 404);
    assert.equal((await f.request(f.admin, 'PATCH', route(item), { version: 1, note: '合成拒絕' })).status, 404);
  }
  const list = (await f.request(f.admin, 'GET', route())).body; assert.equal(list.total, 1); assert.equal(list.items[0].id, valid.id);
  const history = (await f.request(f.admin, 'GET', route(valid, '/history?compare=previous'))).body; assert.equal(history.total, 1); assert.equal(history.items[0].version, 1);
  assert(!JSON.stringify({ list, history }).includes('SYNTHETIC-HIDDEN')); assert.deepEqual(f.raw(), before);
});

test('large legal eighteen-field Chinese payloads save completely under1MiB; oversized bodies reject413 while unrelated entity bound remains128KiB', async t => {
  const f = await fixture(t), large = Object.fromEntries(['interviewContent', 'note', 'workExperience', 'certificateNotes', 'interviewQuestions', 'decisionReason'].map(key => [key, '合'.repeat(10000)]));
  const data = f.payload(large); assert(Buffer.byteLength(JSON.stringify(data)) > 131072);
  let item = await f.create(entity, data); for (const [key, text] of Object.entries(large)) assert.equal(item[key], text);
  const patch = Object.fromEntries(Object.keys(large).map(key => [key, '新'.repeat(10000)])); item = await f.patch(item, patch); for (const [key, text] of Object.entries(patch)) assert.equal(item[key], text);
  const before = f.raw(); assert.equal((await f.request(f.admin, 'PATCH', route(item), undefined, {}, '{"version":2,"workExperience":"' + 'x'.repeat(1048576) + '"}')).status, 413);
  assert.equal((await f.request(f.admin, 'POST', '/api/employees', undefined, {}, '{"name":"' + 'x'.repeat(140000) + '"}')).status, 413); assert.deepEqual(f.raw(), before);
});

test('POST idempotency preserves raw extension content and exact replay; competing PATCH keeps CAS and immutable audit/version behavior', async t => {
  const f = await fixture(t), key = { 'Idempotency-Key': 'synthetic-extension-once' }, data = f.payload({ workExperience: ' 合成精確經歷\r\n ' }), before = f.ledger();
  const first = await f.request(f.admin, 'POST', route(), data, key); assert.equal(first.status, 201); const after = f.ledger(); for (const table of Object.keys(before)) assert.equal(after[table], before[table] + 1);
  const exact = f.raw(), retry = await f.request(f.admin, 'POST', route(), data, key); assert.equal(retry.status, 201); assert.deepEqual(retry.body, first.body); assert.deepEqual(f.raw(), exact);
  assert.equal((await f.request(f.admin, 'POST', route(), { ...data, workExperience: data.workExperience.trim() }, key)).status, 409); assert.deepEqual(f.raw(), exact);
  const results = await Promise.all([f.request(f.admin, 'PATCH', route(first.body.item), { version: 1, education: '合成競爭甲' }), f.request(f.clients.supervisor, 'PATCH', route(first.body.item), { version: 1, education: '合成競爭乙' })]); assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const latest = f.ledger(); assert.equal(latest.records, after.records); assert.equal(latest.record_versions, after.record_versions + 1); assert.equal(latest.audit, after.audit + 1); assert.equal(latest.idempotency, after.idempotency);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('synthetic-forbidden', first.body.item.id), /immutable/);
});

test('old eight-field read DTO preserves literal metadata and kind values but hides unknown keys; raw legacy content cannot be silently overwritten',async t=>{
 const f=await fixture(t),recordId=id(),data={...f.payload(),city:{legacy:'only a type marker'},note:' 原文\r\n ',unknownSaved:{secret:'SYNTHETIC_UNKNOWN_NEVER_RETURNED'}};
 const createdAt='保存建立\r\n不是日期',updatedAt='保存更新\n原文字';
 const old={...data,id:recordId,orgId:f.admin.org,version:1,createdAt,updatedAt};
 f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId,f.admin.org,entity,JSON.stringify(data),1,createdAt,updatedAt);
 f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org,entity,recordId,1,JSON.stringify(old),createdAt,'synthetic-legacy-fixture');
 const before=f.raw(),result=await f.request(f.admin,'GET',route(old));assert.equal(result.status,200);assert.equal(result.body.item.createdAt,createdAt);assert.equal(result.body.item.updatedAt,updatedAt);assert.deepEqual(result.body.item.city,{legacy:'only a type marker'});assert.equal(result.body.item.note,' 原文\r\n ');assert.equal(Object.hasOwn(result.body.item,'unknownSaved'),false);
 const history=await f.request(f.admin,'GET',route(old,'/history?compare=previous'));assert.equal(history.status,200);assert.equal(history.body.total,1);assert.equal(Object.hasOwn(history.body.items[0].snapshot,'unknownSaved'),false);assert.equal(history.body.items[0].snapshot.createdAt,createdAt);assert.deepEqual(f.raw(),before);
 // A well-typed old record with unknown fields is readable but cannot lose them via PATCH.
 const writableLooking=f.imported({...f.payload(),unknownSaved:'SYNTHETIC_PRESERVE_STORED'}),beforePatch=f.raw();assert.equal((await f.request(f.admin,'PATCH',route(writableLooking),{version:1,city:'合成不得覆蓋'})).status,409);assert.deepEqual(f.raw(),beforePatch);
 // Presence of even one new field never uses the legacy metadata branch.
 const partial=f.imported({...f.payload(),education:''});f.app.db.prepare('UPDATE records SET updated_at=? WHERE id=?').run(updatedAt,partial.id);const closedBefore=f.raw();assert.equal((await f.request(f.admin,'GET',route(partial))).status,404);assert.deepEqual(f.raw(),closedBefore);
});
