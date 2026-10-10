import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { insert } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

// Actual HTTP contracts for the existing server, independently of the new UI adapter.
// Every app owns memory SQLite and a random loopback port. Imported values are synthetic.
const ENTITY = 'case-contacts';
const businessKeys = ['caseId', 'name', 'category', 'relationship', 'phone', 'alternatePhone', 'email', 'organization', 'status', 'note'];
const route = item => '/api/' + ENTITY + (item ? '/' + item.id : '');
const projection = item => Object.fromEntries(businessKeys.filter(key => Object.hasOwn(item, key)).map(key => [key, structuredClone(item[key])]));

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  assert.equal(app.dbPath, ':memory:'); assert.equal(new URL(base).hostname, '127.0.0.1'); assert.notEqual(new URL(base).port, '4310');
  t.after(() => app.close());
  const password = 'synthetic-contact-edit-safety-password';
  const headers = client => ({ Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}) });
  async function request(client, method, url, payload, extra = {}) {
    const response = await fetch(base + url, { method, headers: { ...headers(client), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function malformed(client, method, url, bytes, contentType = 'application/json') {
    const response = await fetch(base + url, { method, headers: { ...headers(client), 'Content-Type': contentType }, ...(bytes === undefined ? {} : { body: bytes }) });
    return { status: response.status, body: await response.json() };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成聯絡安全管理者', email: 'admin@contact-edit.example.test', password, organizationName: '合成聯絡安全機構甲' });
  assert.equal(setup.status, 201);
  const client = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = client(setup), clients = { admin };
  async function create(entity, data, actor = admin, extra = {}) {
    const result = await request(actor, 'POST', '/api/' + entity, data, extra); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成聯絡居服員', employeeNo: 'CONTACT-SAFE-E', hourlyRateCents: 24000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@contact-edit.example.test';
    await create('users', { name: '合成聯絡' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseA = await create('cases', { name: '合成聯絡個案甲', caseNo: 'CONTACT-SAFE-A', primaryCarer: '原描述照顧者', contactName: '原主檔聯絡人', contactPhone: '原主檔電話' });
  const caseB = await create('cases', { name: '合成聯絡個案乙', caseNo: 'CONTACT-SAFE-B' });
  const service = await create('service-items', { code: 'CONTACT-SAFE-S', name: '合成服務', minutes: 60, unitPriceCents: 12345 });
  const services = [{ serviceItemId: service.id, quantity: 2 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services });
  const submitted = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:03', actualEnd: '09:55', services, status: 'submitted', note: '合成核閱前觀察' });
  const reviewed = await request(clients.supervisor, 'POST', '/api/service-records/' + submitted.id + '/review', { version: submitted.version, decision: 'approved', reviewNote: '合成核閱保存' });
  assert.equal(reviewed.status, 200);
  const approved = await request(admin, 'GET', '/api/service-records/' + submitted.id); assert.equal(approved.status, 200); assert(Object.hasOwn(approved.body.item, 'billingSnapshot'));
  const certification = await create('employee-certifications', { employeeId: employee.id, name: '合成保全證照', issuedOn: '2026-01-01' });
  await create('case-attachments/upload', { caseId: caseA.id, title: '合成非空PDF', ...filePayload(PDF_BYTES) });
  await create('certification-attachments/upload', { certificationId: certification.id, title: '合成非空PNG', ...filePayload(PNG_BYTES, '合成保全.png', 'image/png') });
  const orgB = await create('organizations', { name: '合成聯絡安全機構乙' }), foreign = { ...admin, org: orgB.id };
  const foreignCase = await create('cases', { name: '合成跨機構個案', caseNo: 'CONTACT-SAFE-FOREIGN' }, foreign);
  const contact = extra => ({ caseId: caseA.id, name: '合成聯絡人', ...extra });
  const imported = data => insert(app.db, admin.org, ENTITY, contact({ category: 'general', status: 'active', ...data }));
  const state = () => {
    const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const names = schema.filter(row => row.type === 'table').map(row => row.name);
    assert.equal(names.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
    const tables = Object.fromEntries(names.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; }));
    assert(tables.attachment_files.length && tables.certification_attachment_files.length);
    return { schema, tables, totalChanges: app.db.prepare('SELECT total_changes() n').get().n };
  };
  async function readOnly(action, expectedStatus, expectedCode) {
    const before = state(), result = await action();
    if (expectedStatus !== undefined) assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
    if (expectedCode) assert.equal(result.body.error.code, expectedCode);
    assert.deepEqual(state(), before, 'Every table, schema, six triggers and total_changes remain exact'); return result;
  }
  async function get(item, actor = admin) { return (await readOnly(() => request(actor, 'GET', route(item)), 200)).body.item; }
  async function patch(item, payload, actor = admin) {
    const result = await request(actor, 'PATCH', route(item), { ...payload, version: item.version }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  return { app, request, malformed, clients, admin, create, caseA, caseB, foreign, foreignCase, contact, imported, state, readOnly, get, patch };
}

function targetWrite(before, after, item, actor, { create = false, fields = [], key } = {}) {
  assert.deepEqual(after.schema, before.schema);
  for (const [table, rows] of Object.entries(before.tables)) if (!['records','record_versions','audit','idempotency'].includes(table)) assert.deepEqual(after.tables[table], rows, table + ' exact');
  assert.deepEqual(after.tables.records.filter(row => row.id !== item.id), before.tables.records.filter(row => row.id !== item.id));
  assert.equal(after.tables.records.length, before.tables.records.length + Number(create));
  assert.equal(after.tables.record_versions.length, before.tables.record_versions.length + 1);
  assert.deepEqual(after.tables.record_versions.slice(0, before.tables.record_versions.length), before.tables.record_versions);
  const version = after.tables.record_versions.at(-1); assert.equal(version.record_id, item.id); assert.equal(version.org_id, actor.org); assert.equal(version.entity, ENTITY); assert.equal(version.version, BigInt(item.version)); assert.deepEqual(JSON.parse(version.snapshot), item);
  assert.equal(after.tables.audit.length, before.tables.audit.length + 1); assert.deepEqual(after.tables.audit.slice(0, before.tables.audit.length), before.tables.audit);
  const event = after.tables.audit.at(-1); assert.equal(event.user_id, actor.user.id); assert.equal(event.record_id, item.id); assert.equal(event.org_id, actor.org); assert.equal(event.action, create ? 'record.create' : 'record.update');
  const detail = JSON.parse(event.detail); assert.equal(detail.version, item.version); if (!create) assert.deepEqual(detail.fields, fields);
  if (key) { assert.equal(after.tables.idempotency.length, before.tables.idempotency.length + 1); assert.deepEqual(after.tables.idempotency.slice(0, before.tables.idempotency.length), before.tables.idempotency); assert.equal(after.tables.idempotency.at(-1).key, key); }
  else assert.deepEqual(after.tables.idempotency, before.tables.idempotency);
  assert.equal(after.totalChanges - before.totalChanges, key ? 4 : 3, 'Only record, version, audit and optional POST key write');
}

test('contact edit omits raw CRLF/whitespace and missing fields while trimming only submitted strings', async t => {
  const f = await fixture(t);
  const raw = { name: '  合成原姓名\r\n保留  ', relationship: ' 原關係\r\n保留 ', phone: ' +886\r\n合成分機 ', alternatePhone: '\t原其他電話\t', email: 'raw@contact-edit.example.test', note: ' 原備註\r\n第二行 ', syntheticUnknown: { nested: ['合成未知保存', null] } };
  const item = f.imported(raw), before = f.state();
  const saved = await f.patch(item, { note: ' \t本次備註\r\n第二行 \n' }, f.clients.supervisor);
  assert.equal(saved.note, '本次備註\r\n第二行');
  for (const key of Object.keys(raw).filter(key => key !== 'note')) assert.deepEqual(saved[key], raw[key], key + ' omitted raw unchanged');
  assert.equal(Object.hasOwn(saved, 'organization'), false);
  assert.equal(saved.caseId, item.caseId); assert.equal(saved.version, item.version + 1);
  targetWrite(before, f.state(), saved, f.clients.supervisor, { fields: ['note'] });
  assert.deepEqual(await f.get(saved), saved);
  const history = await f.readOnly(() => f.request(f.admin, 'GET', route(saved) + '/history?compare=previous'), 200);
  assert.deepEqual(history.body.items[0].comparison.previousSnapshot, item);
  assert.deepEqual(history.body.items[0].actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name });
});

test('complete contact creation on paused and closed parents preserves parent records, nonempty BLOBs and approved snapshots', async t => {
  const f = await fixture(t);
  for (const status of ['paused', 'closed']) {
    const parent = await f.create('cases', { name: '合成' + status + '個案', caseNo: 'CONTACT-SAFE-' + status, status });
    const payload = { caseId: ' ' + parent.id + ' ', name: ' 合成\r\n聯絡人 ', category: ' other ', relationship: ' 親友 ', phone: ' 主要\r\n電話 ', alternatePhone: ' 其他電話 ', email: ' person@contact-edit.example.test ', organization: ' 合成單位 ', status: ' active ', note: ' 首行\r\n尾行 ' };
    const key = 'contact-parent-' + status, before = f.state();
    const result = await f.request(f.clients.supervisor, 'POST', route(), payload, { 'Idempotency-Key': key }); assert.equal(result.status, 201);
    const item = result.body.item; assert.deepEqual(Object.keys(projection(item)).sort(), businessKeys.slice().sort());
    for (const [name, value] of Object.entries(payload)) assert.equal(item[name], value.trim());
    assert.equal(item.version, 1); targetWrite(before, f.state(), item, f.clients.supervisor, { create: true, key });
    const editedBefore = f.state(), updated = await f.patch(item, { phone: ' 明確新電話 ' });
    assert.equal(updated.phone, '明確新電話'); targetWrite(editedBefore, f.state(), updated, f.admin, { fields: ['phone'] });
  }
});

test('keeping imported invalid values cannot bypass merged validation, while explicit repair preserves other raw fields', async t => {
  const f = await fixture(t);
  for (const [legacy, repair, expectedCode] of [
    [{ phone: null }, { phone: '' }, 'INVALID_FIELD'],
    [{ organization: { nested: '合成物件' } }, { organization: ' 合成修復單位 ' }, 'INVALID_FIELD'],
    [{ category: 'unknown_category' }, { category: 'other' }, 'INVALID_CATEGORY'],
    [{ status: 'unknown_status' }, { status: 'inactive' }, 'INVALID_STATUS'],
  ]) {
    const item = f.imported({ name: ' 原姓名 ', alternatePhone: ' 原其他\r\n電話 ', ...legacy });
    await f.readOnly(() => f.request(f.admin, 'PATCH', route(item), { version: item.version, note: ' 保持異型不能繞過 ' }), 422, expectedCode);
    assert.deepEqual(await f.get(item), item);
    const before = f.state(), updated = await f.patch(item, { ...repair, note: ' 明確修復後保存 ' });
    assert.equal(updated.note, '明確修復後保存'); assert.equal(updated.name, item.name); assert.equal(updated.alternatePhone, item.alternatePhone);
    targetWrite(before, f.state(), updated, f.admin, { fields: [...Object.keys(repair), 'note'] });
  }
});

test('legacy whitespace-only name remains the actual merged rule; submitting new whitespace is rejected atomically', async t => {
  const f = await fixture(t), item = f.imported({ name: ' \t\r\n ', note: '原備註' });
  const before = f.state(), updated = await f.patch(item, { note: ' 本次非姓名變動 ' });
  assert.equal(updated.name, item.name); assert.equal(updated.note, '本次非姓名變動'); targetWrite(before, f.state(), updated, f.admin, { fields: ['note'] });
  await f.readOnly(() => f.request(f.admin, 'PATCH', route(updated), { version: updated.version, name: ' \t\r\n ' }), 422, 'REQUIRED');
  await f.readOnly(() => f.request(f.admin, 'POST', route(), f.contact({ name: ' \t\r\n ' }), { 'Idempotency-Key': 'rejected-white-name' }), 422, 'REQUIRED');
  assert.deepEqual(await f.get(updated), updated);
});

test('known status-only changes preserve all other raw values and own-presence instead of resending the form', async t => {
  const f = await fixture(t), item = f.imported({ name: ' 原姓名 ', phone: ' 原電話\r\n分機 ', note: ' 原備註\r\n尾句 ', email: 'contact@contact-edit.example.test' });
  let current = item;
  for (const status of ['inactive', 'active']) {
    const before = f.state(), updated = await f.patch(current, { status }, f.clients.supervisor);
    assert.deepEqual(projection(updated), { ...projection(current), status });
    assert.equal(Object.hasOwn(updated, 'relationship'), false); assert.equal(Object.hasOwn(updated, 'organization'), false);
    targetWrite(before, f.state(), updated, f.clients.supervisor, { fields: ['status'] }); current = updated;
  }
});

test('a real competing actor changes the version, stale edit writes zero and explicit fresh retry changes only its field', async t => {
  const f = await fixture(t), item = f.imported({ phone: ' 原電話 ', note: '原備註\r\n完整保留' });
  const firstBefore = f.state(), competing = await f.patch(item, { phone: ' 督導已保存電話 ' }, f.clients.supervisor);
  targetWrite(firstBefore, f.state(), competing, f.clients.supervisor, { fields: ['phone'] });
  await f.readOnly(() => f.request(f.admin, 'PATCH', route(item), { version: item.version, note: '本次過時輸入' }), 409, 'VERSION_CONFLICT');
  const fresh = await f.get(competing), before = f.state(), retried = await f.patch(fresh, { note: ' 人工重新讀取後明確保存 ' });
  assert.equal(retried.phone, competing.phone); assert.equal(retried.note, '人工重新讀取後明確保存');
  targetWrite(before, f.state(), retried, f.admin, { fields: ['note'] });
});

test('POST commit followed by unknown acknowledgement can replay identical payload and key without any second write', async t => {
  const f = await fixture(t), payload = f.contact({ name: ' 同payload合成聯絡人 ', category: 'case_manager', phone: '', alternatePhone: '', relationship: '', email: '', organization: '', note: '完整輸入', status: 'active' });
  const key = 'same-canonical-contact-payload', extra = { 'Idempotency-Key': key }, before = f.state();
  const committed = await f.request(f.admin, 'POST', route(), payload, extra); assert.equal(committed.status, 201);
  targetWrite(before, f.state(), committed.body.item, f.admin, { create: true, key });
  const replay = await f.readOnly(() => f.request(f.admin, 'POST', route(), payload, extra), 201);
  assert.deepEqual(replay.body, committed.body);
  // Existing idempotency binds raw request JSON, not merely the normalized saved result.
  await f.readOnly(() => f.request(f.admin, 'POST', route(), { ...payload, name: payload.name.trim() }, extra), 409, 'IDEMPOTENCY_CONFLICT');
  await f.readOnly(() => f.request(f.admin, 'POST', route(), { ...payload, note: '改變內容' }, extra), 409, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await f.get(committed.body.item), committed.body.item);
});

test('readonly roles are rejected before malformed write bodies and retain inactive reads with foreign history isolation', async t => {
  const f = await fixture(t), mine = await f.create(ENTITY, f.contact({ status: 'inactive' })), otherCase = await f.create(ENTITY, f.contact({ caseId: f.caseB.id })), foreign = await f.create(ENTITY, { caseId: f.foreignCase.id, name: '合成跨機構聯絡人' }, f.foreign);
  for (const actor of [f.clients.finance, f.clients.caregiver]) {
    for (const [method, url, bytes, contentType] of [
      ['POST', route(), '{', 'application/json'], ['POST', route(), 'x'.repeat(132000), 'text/plain'],
      ['PATCH', route(mine), '{', 'application/json'], ['PATCH', route(foreign), 'null', 'text/plain'], ['DELETE', route(mine), undefined, 'application/json'],
    ]) await f.readOnly(() => f.malformed(actor, method, url, bytes, contentType), 403, 'ROLE_FORBIDDEN');
    assert.equal((await f.get(mine, actor)).status, 'inactive');
    await f.readOnly(() => f.request(actor, 'GET', route(mine) + '/history?compare=previous'), 200);
    await f.readOnly(() => f.request(actor, 'GET', route(foreign)), 404);
    await f.readOnly(() => f.request(actor, 'GET', route(foreign) + '/history?compare=previous'), 404);
  }
  await f.readOnly(() => f.request(f.clients.caregiver, 'GET', route(otherCase)), 404);
  await f.readOnly(() => f.request(f.clients.caregiver, 'GET', route(otherCase) + '/history?compare=previous'), 404);
  const hidden = await f.readOnly(() => f.request(f.clients.caregiver, 'GET', route() + '?caseId=' + f.caseB.id), 200); assert.equal(hidden.body.total, 0);
  for (const actor of [f.admin, f.clients.supervisor]) {
    await f.readOnly(() => f.request(actor, 'GET', route(foreign) + '/history?compare=previous'), 404);
    await f.readOnly(() => f.request(actor, 'PATCH', route(foreign), { version: 1, note: '不可跨機構' }), 404);
  }
});

test('new PATCH payload rejects unsupported values and immutable parent changes without cleaning stored data', async t => {
  const f = await fixture(t), item = f.imported({ name: ' 原姓名 ', note: ' 原備註\r\n尾句 ', phone: '原電話' });
  for (const [payload, status, code] of [
    [{ name: '缺少版本' }, 422, 'VERSION_REQUIRED'], [{ version: '1', note: '版本不coerce' }, 422, 'VERSION_REQUIRED'],
    [{ version: 1, note: null }, 422, 'INVALID_FIELD'], [{ version: 1, phone: ['合成異型'] }, 422, 'INVALID_FIELD'],
    [{ version: 1, name: '😀'.repeat(51) }, 422, 'INVALID_FIELD'], [{ version: 1, phone: 'x'.repeat(101) }, 422, 'INVALID_FIELD'],
    [{ version: 1, note: '字'.repeat(10001) }, 422, 'INVALID_FIELD'], [{ version: 1, email: 'a b@contact-edit.example.test' }, 422, 'INVALID_EMAIL'],
    [{ version: 1, syntheticUnknown: null }, 422, 'UNKNOWN_FIELD'], [{ version: 1, category: 'unknown' }, 422, 'INVALID_CATEGORY'],
    [{ version: 1, caseId: f.caseB.id }, 409, 'CASE_IMMUTABLE'], [{ version: 1, caseId: f.foreignCase.id }, 409, 'CASE_IMMUTABLE'],
  ]) await f.readOnly(() => f.request(f.admin, 'PATCH', route(item), payload), status, code);
  assert.deepEqual(await f.get(item), item);
});
