import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';
import { createEmployeeEditor } from '../public/data/employee-editor.js';

const ENTITY = 'employees', password = 'synthetic-employee-editor-password';
const keys = ['name', 'employeeNo', 'role', 'phone', 'email', 'status', 'qualification', 'regions', 'note', 'hourlyRateCents'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const route = item => `/api/${ENTITY}/${item.id}`;
const history = (item, compare = true) => route(item) + '/history' + (compare ? '?compare=previous' : '');
const editorFor = existing => createEmployeeEditor({ existing });
const values = (e, changes = {}) => ({ ...e.initial, ...changes });
const projection = item => Object.fromEntries(keys.filter(k => Object.hasOwn(item, k)).map(k => [k, item[k]]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  async function request(client, method, url, data, headers = {}) {
    const r = await fetch(base + url, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await r.arrayBuffer()), text = bytes.toString('utf8');
    return { status: r.status, headers: r.headers, bytes, body: r.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成員工管理者', email: 'admin@employee-editor.example.test', password, organizationName: '合成員工甲機構' }); assert.equal(setup.status, 201);
  const clientFrom = r => ({ cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.body.csrfToken, org: setup.body.organizations[0].id, user: r.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin, headers = {}) { const r = await request(caller, 'POST', '/api/' + entity, data, headers); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.item; }
  async function patch(entity, item, data, caller = admin) { const r = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { ...data, version: item.version }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.item; }
  const data = extra => ({ name: '合成居服員', employeeNo: 'TEST-EMP-' + id(), role: ' 自訂職務 ', phone: '測試分機', email: '非郵件格式也可保存', status: 'active', qualification: '摘要\n原文', regions: '北區\n南區', note: '', hourlyRateCents: 24000, ...extra });
  const employee = await create(ENTITY, data({ employeeNo: 'TEST-EMP-BASE' }));
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@employee-editor.example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const service = await create('service-items', { code: 'TEST-EMP-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const careCase = await create('cases', { caseNo: 'TEST-SIE-CASE', name: '合成服務個案' }), services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: careCase.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-09', startTime: '09:00', endTime: '10:00', services });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  const imported = data => insert(app.db, admin.org, ENTITY, data); // Explicit INSERT-only synthetic imports; no real database or normal-write claim.
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const reviewed = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(reviewed.status, 200);
    return (await request(admin, 'GET', '/api/service-records/' + record.id)).body.item;
  }
  return { app, request, create, patch, admin, clients, employee, careCase, services, service, plan, shift, data, state, imported, approve };
}

test('ten-field real creates preserve exact cents arbitrary job text and email, with selective/no-op versions and actual actors', async t => {
  const f = await fixture(t);
  const memberships = f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all();
  for (const [text, cents] of [['0', 0], ['0.01', 1], ['123.45', 12345], ['10000000.00', 1000000000]]) {
    const e = editorFor(), p = e.buildPayload(values(e, { name: ' 合成🙂 姓名 ', employeeNo: ' TEST-' + id() + ' ', role: 'admin', email: ' 不是 Email 格式 ', phone: ' 分機# ', qualification: '資格\n摘要', regions: '\n 北區\n北區 ', note: '\n原文<&> ', hourlyRate: text }));
    assert.deepEqual(Object.keys(p), keys); const first = await f.create(ENTITY, p); e.confirm(first, f.admin.org, p); assert.deepEqual(projection(first), p); assert.equal(first.hourlyRateCents, cents);
    const edit = editorFor(first), payload = edit.buildPayload({ note: ' 督導只改備註\n' }), second = await f.patch(ENTITY, first, payload, f.clients.supervisor); edit.confirm(second, f.admin.org, payload);
    const e2 = editorFor(second), noOp = e2.buildPayload({ hourlyRate: text, role: 'admin' }); assert.deepEqual(noOp, {});
    const third = await f.patch(ENTITY, second, noOp); e2.confirm(third, f.admin.org, noOp); assert.equal(third.version, 3);
    const before = f.state(), h = await f.request(f.admin, 'GET', history(third)); assert.equal(h.status, 200); assert.deepEqual(h.body.items.map(x => x.actor.id), [f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]);
    assert.deepEqual(projection(h.body.items[0].snapshot), projection(second)); assert.deepEqual(projection(h.body.items[1].comparison.previousSnapshot), p); assert.deepEqual(f.state(), before);
    const audits = f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=? ORDER BY rowid').all(first.id, 'record.update').map(x => JSON.parse(x.detail)); assert.deepEqual(audits.map(x => x.fields), [['note'], []]);
  }
  assert.deepEqual(f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(), memberships, 'job text does not edit membership roles');
});

test('normal API CRLF strings keep exact original bytes and explicit text replacement or clear produces honest history', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data({ name: '合成\r\n姓名', employeeNo: 'TEST-CR\r\nLF', role: 'PRIVATE\r職務', phone: 'PRIVATE\n分機', email: 'PRIVATE\r\n不是Email', qualification: 'PRIVATE\r\n資格', regions: 'PRIVATE\r\n區域', note: 'PRIVATE\r\n備註' }));
  const e = editorFor(first); for (const k of keys.filter(k => !['status', 'hourlyRateCents'].includes(k))) { assert.equal(e.needsIntent(k), true); assert.equal(e.initial[k], ''); }
  assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
  const payload = e.buildPayload({ hourlyRate: '0.01' }), second = await f.patch(ENTITY, first, payload, f.clients.supervisor); e.confirm(second, f.admin.org, payload);
  for (const k of keys.filter(k => k !== 'hourlyRateCents')) assert.deepEqual(second[k], first[k]);
  const e2 = editorFor(second), update = e2.buildPayload({ nameIntent: 'replace', name: ' 新姓名 ', employeeNoIntent: 'replace', employeeNo: ' TEST-已修復 ', roleIntent: 'clear', phoneIntent: 'clear', emailIntent: 'replace', email: ' 仍非 email 格式 ', qualificationIntent: 'replace', qualification: '資格\n文字', regionsIntent: 'replace', regions: ' 北區\n南區 ', noteIntent: 'clear' });
  const third = await f.patch(ENTITY, second, update); e2.confirm(third, f.admin.org, update); assert.equal(third.email, ' 仍非 email 格式 '); assert.equal(third.regions, ' 北區\n南區 '); assert.equal(third.role, '');
  const before = f.state(), h = await f.request(f.admin, 'GET', history(third)); assert.deepEqual(projection(h.body.items.at(-1).snapshot), projection(first)); assert.deepEqual(f.state(), before);
});

test('legal API region lists preserve empty items order duplicates LF CR through unrelated edits then explicit whole conversion', async t => {
  const f = await fixture(t);
  for (const regions of [[], [''], ['空字串'], ['北區', '', '北區', '南\n區', '東\r區'], Array(50).fill('x'.repeat(99))]) {
    const first = await f.create(ENTITY, f.data({ regions })), e = editorFor(first); assert.equal(e.initial.regions, ''); assert.equal(e.needsIntent('regions'), true);
    const p = e.buildPayload({ note: '只改備註' }); assert.deepEqual(p, { note: '只改備註' }); const second = await f.patch(ENTITY, first, p); e.confirm(second, f.admin.org, p); assert.deepEqual(second.regions, regions);
    const e2 = editorFor(second), replace = e2.buildPayload({ regionsIntent: 'replace', regions: ' 北區\n北區\n ' }); const third = await f.patch(ENTITY, second, replace, f.clients.supervisor); e2.confirm(third, f.admin.org, replace); assert.equal(third.regions, ' 北區\n北區\n ');
    const before = f.state(), h = await f.request(f.admin, 'GET', history(third)); assert.deepEqual(h.body.items[0].comparison.previousSnapshot.regions, regions); assert.equal(h.body.items[0].snapshot.regions, third.regions); assert.deepEqual(f.state(), before);
    const again = await f.patch(ENTITY, third, { regions }); const e3 = editorFor(again), clear = e3.buildPayload({ regionsIntent: 'clear', regions: ['ignored'] }); assert.deepEqual(clear, { regions: '' }); const fourth = await f.patch(ENTITY, again, clear); e3.confirm(fourth, f.admin.org, clear); assert.equal(fourth.regions, '');
  }
});

test('explicit INSERT-only unusual JSON and absent optional values remain exact without guessed hourly defaults', async t => {
  const f = await fixture(t), special = JSON.parse('{"__proto__":{"private":"PRIVATE"},"constructor":[0,false],"prototype":null}');
  for (const data of [f.data({ name: 0, employeeNo: false, role: special, phone: null, email: [], qualification: false, regions: special, note: ['PRIVATE'], hourlyRateCents: false }), f.data({ name: special, employeeNo: ['TEST-nonempty'], role: null, email: 0, regions: null, hourlyRateCents: -1 }), f.data({ name: false, hourlyRateCents: { private: 'PRIVATE' } }), f.data({ hourlyRateCents: '1000000001' })]) {
    const first = f.imported(data), e = editorFor(first), payload = e.buildPayload({ status: 'inactive' }); assert.deepEqual(payload, { status: 'inactive' });
    const second = await f.patch(ENTITY, first, payload); e.confirm(second, f.admin.org, payload); for (const k of keys.filter(k => k !== 'status')) assert.deepEqual(second[k], first[k]);
    assert.ok(!JSON.stringify(e.fields).includes('PRIVATE')); assert.equal({}.private, undefined);
    const before = f.state(), h = await f.request(f.admin, 'GET', history(second)); assert.deepEqual(projection(h.body.items[0].comparison.previousSnapshot), projection(first)); assert.equal(h.body.items.at(-1).actor, null); assert.deepEqual(f.state(), before);
  }
  const data = f.data(); for (const k of ['role', 'phone', 'email', 'qualification', 'regions', 'note', 'hourlyRateCents']) delete data[k];
  const first = f.imported(data), e = editorFor(first), payload = e.buildPayload({ name: '只改姓名' }), second = await f.patch(ENTITY, first, payload); e.confirm(second, f.admin.org, payload);
  for (const k of ['role', 'phone', 'email', 'qualification', 'regions', 'note', 'hourlyRateCents']) assert.equal(Object.hasOwn(second, k), false);
  const e2 = editorFor(second), repair = e2.buildPayload({ regionsIntent: 'clear', hourlyRateIntent: 'replace', hourlyRate: '0.01' }), third = await f.patch(ENTITY, second, repair); e2.confirm(third, f.admin.org, repair); assert.equal(third.regions, ''); assert.equal(third.hourlyRateCents, 1); assert.equal(Object.hasOwn(third, 'email'), false);
});

test('kept missing null empty required data and invalid status still fail original merged guards until explicit repair', async t => {
  const f = await fixture(t);
  for (const key of ['name', 'employeeNo']) for (const bad of [undefined, null, '', []]) {
    const data = f.data(); if (bad === undefined) delete data[key]; else data[key] = bad; const first = f.imported(data), e = editorFor(first); assert.deepEqual(e.buildPayload(e.initial), {});
    const before = f.state(), rejected = await f.request(f.admin, 'PATCH', route(first), { version: 1 }); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'REQUIRED'); assert.deepEqual(f.state(), before);
    const value = ' TEST-修復-' + id(), payload = e.buildPayload({ [key]: value, ...(e.needsIntent(key) ? { [key + 'Intent']: 'replace' } : {}) }); const second = await f.patch(ENTITY, first, payload); e.confirm(second, f.admin.org, payload); assert.equal(second[key], value);
  }
  for (const status of ['constructor', '', null, [], false]) {
    const first = f.imported(f.data({ status })), e = editorFor(first), before = f.state(); const rejected = await f.request(f.admin, 'PATCH', route(first), { version: 1, ...e.buildPayload(e.initial) }); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'INVALID_STATUS'); assert.deepEqual(f.state(), before);
    const payload = e.buildPayload({ statusIntent: 'replace', status: 'active' }), second = await f.patch(ENTITY, first, payload); e.confirm(second, f.admin.org, payload);
  }
});

test('direct API new-value guards preserve exact text and regions limits and do not add email format or job-role policies', async t => {
  const f = await fixture(t), item = f.employee, before = f.state();
  for (const data of [{ hourlyRateCents: false }, { hourlyRateCents: '1' }, { hourlyRateCents: 1.5 }, { hourlyRateCents: -1 }, { hourlyRateCents: 1000000001 }, { name: false }, { employeeNo: [] }, { role: {} }, { phone: [] }, { email: null }, { qualification: 'x'.repeat(501) }, { email: 'x'.repeat(501) }, { name: 'x'.repeat(501) }, { note: 'x'.repeat(10001) }, { regions: 'x'.repeat(1001) }, { regions: Array(51).fill('') }, { regions: ['x'.repeat(100)] }, { regions: [null] }, { regions: {} }, { regions: null }, { status: 'draft' }, { hourlyRate: '0.01' }]) {
    const response = await f.request(f.admin, 'PATCH', route(item), { version: 1, ...data }); assert.equal(response.status, 422, JSON.stringify(data));
  }
  assert.deepEqual(f.state(), before);
  const e = editorFor(item), payload = e.buildPayload({ role: 'constructor', email: ' '.repeat(500), qualification: '資'.repeat(500), regions: '區'.repeat(1000), note: '註'.repeat(10000), hourlyRate: '10000000.00' });
  const updated = await f.patch(ENTITY, item, payload); e.confirm(updated, f.admin.org, payload); for (const [key, value] of Object.entries(payload)) assert.equal(updated[key], value);
  const blank = await f.create(ENTITY, f.data({ name: ' ', employeeNo: ' ', role: 'finance', email: 'no at sign' })); assert.equal(blank.name, ' '); assert.equal(blank.employeeNo, ' ');
});

test('POST replay same key duplicate employee number true CAS and CSRF failures preserve committed rows and ledger', async t => {
  const f = await fixture(t), e = editorFor(), payload = e.buildPayload({ name: '合成一次', employeeNo: 'TEST-ONCE', hourlyRate: '0.01' }), headers = { 'Idempotency-Key': 'synthetic-employee-edit-once' };
  const first = await f.request(f.admin, 'POST', '/api/employees', payload, headers); assert.equal(first.status, 201); e.confirm(first.body.item, f.admin.org, payload);
  const committed = f.state(), replay = await f.request(f.admin, 'POST', '/api/employees', payload, headers); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.state(), committed);
  const keyConflict = await f.request(f.admin, 'POST', '/api/employees', { ...payload, name: 'different' }, headers); assert.equal(keyConflict.status, 409); assert.equal(keyConflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const duplicate = await f.request(f.admin, 'POST', '/api/employees', payload); assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'DUPLICATE_CODE'); assert.deepEqual(f.state(), committed);
  const old = first.body.item, captured = editorFor(old), pending = captured.buildPayload({ hourlyRate: '0.29' }), fresh = await f.patch(ENTITY, old, { name: '督導已更新' }, f.clients.supervisor), before = f.state();
  const stale = await f.request(f.admin, 'PATCH', route(old), { version: old.version, ...pending }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  const dupPatch = await f.request(f.admin, 'PATCH', route(fresh), { version: fresh.version, employeeNo: f.employee.employeeNo }); assert.equal(dupPatch.status, 409); assert.equal(dupPatch.body.error.code, 'DUPLICATE_CODE');
  for (const csrf of ['', 'invalid']) assert.equal((await f.request(f.admin, 'PATCH', route(fresh), { version: fresh.version, note: 'blocked' }, { 'X-CSRF-Token': csrf })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(fresh), { version: fresh.version, note: 'blocked' }, { Origin: 'https://untrusted.example.test' })).status, 403);
  assert.deepEqual(pending, { hourlyRateCents: 29 }); assert.throws(() => captured.confirm(fresh, f.admin.org, pending), /未確認/); assert.deepEqual((await f.request(f.admin, 'GET', route(old))).body.item, fresh); assert.deepEqual(f.state(), before);
});

test('four roles and cross-org boundaries remain exact and linked caregiver loses access only while current employee inactive', async t => {
  const f = await fixture(t), unrelated = await f.create(ENTITY, f.data()), org = await f.create('organizations', { name: '合成員工乙機構' }), other = { ...f.admin, org: org.id }, foreign = await f.create(ENTITY, f.data({ employeeNo: f.employee.employeeNo }), other);
  const memberships = f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(), sessions = f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(); let before = f.state();
  for (const client of [f.clients.finance, f.clients.caregiver]) {
    for (const data of [{ note: '禁止寫入' }, { status: 'inactive' }]) assert.equal((await f.request(client, 'PATCH', route(f.employee), { version: 1, ...data })).status, 403);
    assert.equal((await f.request(client, 'POST', '/api/employees', f.data())).status, 403);
  }
  for (const client of Object.values(f.clients)) for (const url of [route(f.employee), history(f.employee), history(f.employee, false)]) assert.equal((await f.request(client, 'GET', url)).status, 200);
  for (const url of [route(unrelated), history(unrelated), history(unrelated, false)]) { assert.equal((await f.request(f.clients.caregiver, 'GET', url)).status, 404); assert.equal((await f.request(f.clients.finance, 'GET', url)).status, 200); }
  for (const [client, item] of [[other, f.employee], [f.admin, foreign]]) for (const url of [route(item), history(item), history(item, false)]) assert.equal((await f.request(client, 'GET', url)).status, 404);
  assert.equal((await f.request(other, 'PATCH', route(f.employee), { version: 1, note: 'blocked' })).status, 404); assert.deepEqual(f.state(), before);
  const e = editorFor(f.employee), payload = e.buildPayload({ status: 'inactive', role: 'admin' }), inactive = await f.patch(ENTITY, f.employee, payload, f.clients.supervisor); e.confirm(inactive, f.admin.org, payload); before = f.state();
  for (const url of [route(inactive), history(inactive), history(inactive, false), '/api/employees', '/api/dashboard']) { const response = await f.request(f.clients.caregiver, 'GET', url); assert.equal(response.status, 403); assert.equal(response.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) for (const url of [route(inactive), history(inactive)]) assert.equal((await f.request(client, 'GET', url)).status, 200); assert.deepEqual(f.state(), before);
  const captured = editorFor(inactive), restored = await f.patch(ENTITY, inactive, { status: 'active' }); captured.confirm(restored, f.admin.org, { status: 'active' }); before = f.state();
  for (const url of [route(restored), history(restored), history(restored, false), '/api/employees', '/api/dashboard']) assert.equal((await f.request(f.clients.caregiver, 'GET', url)).status, 200);
  assert.deepEqual(f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(), memberships); assert.deepEqual(f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(), sessions); assert.deepEqual(f.state(), before);
});

test('malformed confirmation after a real commit cannot coerce absent or typed fields or pretend a rollback', async t => {
  const f = await fixture(t), data = f.data({ regions: ['', '北區', '北區', '南\n區', '東\r區'], hourlyRateCents: false, email: null }); delete data.role;
  const first = f.imported(data), e = editorFor(first), payload = e.buildPayload({ name: '合成已提交姓名' }), current = await f.patch(ENTITY, first, payload), before = f.state();
  for (const reply of [null, [], { ...current, id: 'wrong' }, { ...current, orgId: 'wrong' }, { ...current, version: 1 }, { ...current, role: '' }, { ...current, hourlyRateCents: 0 }, { ...current, email: '' }, { ...current, regions: current.regions.join('、') }, { ...current, regions: [...new Set(current.regions)] }, { ...current, name: 'not-committed' }]) assert.throws(() => e.confirm(reply, f.admin.org, payload), /未確認/);
  for (const key of keys.filter(k => k !== 'role')) { const reply = { ...current }; delete reply[key]; assert.throws(() => e.confirm(reply, f.admin.org, payload), /未確認/); }
  assert.deepEqual((await f.request(f.admin, 'GET', route(current))).body.item, current); e.confirm(current, f.admin.org, payload); assert.deepEqual(e.buildPayload({ name: '合成已提交姓名' }), payload); assert.deepEqual(f.state(), before);
});

test('employee hourly and activation changes have no invented in-use lock and cannot reprice approved snapshots or delete prior work', async t => {
  const f = await fixture(t), approved = await f.approve(), cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照', issuedOn: '2026-01-01' }), training = await f.create('employee-training', { employeeId: f.employee.id, name: '合成訓練', category: 'in_service', date: '2026-10-01', trainingMinutes: 30 });
  const shiftBefore = (await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item, fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  const e = editorFor(f.employee), payload = e.buildPayload({ name: '更新員工姓名', hourlyRate: '0.01', regions: '更新區域' }); let current = await f.patch(ENTITY, f.employee, payload); e.confirm(current, f.admin.org, payload); current = await f.patch(ENTITY, current, { status: 'inactive' });
  const futureShift = { caseId: f.careCase.id, employeeId: f.employee.id, carePlanId: f.plan.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services: f.services };
  let before = f.state(); const rejected = await f.request(f.admin, 'POST', '/api/shifts', futureShift); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'INACTIVE_ASSIGNMENT'); assert.deepEqual(f.state(), before);
  for (const url of ['/api/employee-certifications/' + cert.id, '/api/employee-training/' + training.id]) { assert.equal((await f.request(f.admin, 'GET', url)).status, 200); assert.equal((await f.request(f.clients.finance, 'GET', url)).status, 403); }
  current = await f.patch(ENTITY, current, { status: 'active' }); assert.equal((await f.create('shifts', futureShift)).employeeId, current.id); before = f.state();
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved); assert.deepEqual((await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item, shiftBefore);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees); assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  assert.equal(fees.totals.amountCents, 37035); assert.equal(payroll.totals.amountCents, 18800); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.employee.name, f.employee.name);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/employee-training/' + training.id)).body.item, training);
  const savedCert = (await f.request(f.admin, 'GET', '/api/employee-certifications/' + cert.id)).body.item; for (const k of ['employeeId', 'name', 'issuedOn', 'version']) assert.equal(savedCert[k], cert[k]); assert.deepEqual(f.state(), before);
});

test('all31 report exits both versioned BLOBs six triggers and eleven-table readonly history maintain billing and scopes', async t => {
  const f = await fixture(t), approved = await f.approve(), cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.careCase.id, title: '合成PDF', ...filePayload(PDF_BYTES) }), b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  const e = editorFor(f.employee), payload = e.buildPayload({ note: ' 合成只改備註\n' }), current = await f.patch(ENTITY, f.employee, payload); e.confirm(current, f.admin.org, payload);
  const urls = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(k => [`/api/reports/${k}?month=2026-10`, `/api/reports/${k}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave', 'training', 'certification']) for (const suffix of ['', '/export', '.csv']) urls.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind === 'certification' ? '&asOf=2026-10-09' : ''}`);
  for (const suffix of ['', '/export', '.csv']) urls.push('/api/employee-report' + suffix); assert.equal(urls.length, 31);
  const schema = f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), before = f.state(); assert.equal(schema.length, 6); assert.equal(Object.keys(before.tables).length, 11); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  const reports = async () => { const result = {}; for (const url of urls) { const response = await f.request(f.admin, 'GET', url); assert.equal(response.status, 200, url); result[url] = typeof response.body === 'string' ? response.body : Object.fromEntries(Object.entries(response.body).filter(([key]) => key !== 'generatedAt')); } return result; };
  const first = await reports();
  for (const [url, bytes] of [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) { const response = await f.request(f.admin, 'GET', url + suffix); assert.equal(response.status, 200); assert.deepEqual(response.bytes, bytes); assert.equal(sha(response.bytes), sha(bytes)); }
  for (const client of Object.values(f.clients)) for (const url of [route(current), history(current), history(current, false)]) assert.equal((await f.request(client, 'GET', url)).status, 200);
  assert.deepEqual(await reports(), first); assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  for (const client of [f.clients.supervisor, f.clients.caregiver]) assert.equal(Object.hasOwn((await f.request(client, 'GET', '/api/service-records/' + approved.id)).body.item, 'billingSnapshot'), false);
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), schema);
});
