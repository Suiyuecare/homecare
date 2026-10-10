import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';

import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const password = 'synthetic-employee-history-password';
const fields = ['name', 'employeeNo', 'role', 'phone', 'email', 'status', 'qualification', 'regions', 'note', 'hourlyRateCents'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const history = (item, query = 'compare=previous', entity = 'employees') => `/api/${entity}/${item.id}/history${query ? '?' + query : ''}`;
const detail = item => '/api/employees/' + item.id;
const noPrevious = status => ({ status, previousVersion: null, previousSnapshot: null });
const actor = client => ({ id: client.user.id, name: client.user.name });
const saved = item => Object.fromEntries(fields.map(key => [key, item[key]]));

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extraHeaders = {}) {
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text, bytes, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成員工主檔管理者', email: 'employee-history-admin@example.test', password, organizationName: '合成員工主檔甲機構' });
  assert.equal(setup.status, 201);
  const clientFrom = result => ({ cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken, org: setup.body.organizations[0].id, user: result.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin) {
    const result = await request(caller, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeData = { name: '合成居服甲', employeeNo: 'TEST-EH-A', role: '合成職務', phone: 'TEST-PHONE-A', email: 'synthetic-a@example.test', status: 'active', qualification: '合成資格文字非正式認定', regions: '臺北、 合成區', note: '合成人員初版', hourlyRateCents: 24000 };
  const employeeA = await create('employees', employeeData);
  const employeeB = await create('employees', { name: '合成居服乙', employeeNo: 'TEST-EH-B', hourlyRateCents: 26000 });
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB]]) {
    const email = key + '@employee-history.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-EH-CA' });
  const serviceData = { code: 'TEST-EH-SA', name: '合成測試服務甲', minutes: 60, unitPriceCents: 12345, validFrom: '', validTo: '', status: 'active', note: '合成主檔初版' };
  const serviceA = await create('service-items', serviceData), serviceB = await create('service-items', { ...serviceData, code: 'TEST-EH-SB', name: '合成測試服務乙', unitPriceCents: 5000 });
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 30 }, { serviceItemId: serviceB.id, quantity: 30 }] });
  const shiftData = { caseId: caseA.id, employeeId: employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: serviceA.id, quantity: 1 }], status: 'scheduled', note: '合成可改派班次' };
  const shift = await create('shifts', shiftData);
  function auditEvent({ orgId = admin.org, entity = 'employees', recordId = employeeA.id, userId = admin.user.id, action = 'record.update', detail: eventDetail = {}, rawDetail } = {}) {
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, rawDetail ?? JSON.stringify(eventDetail), now());
  }
  function addSnapshot(item, version, changes = {}, { orgId = admin.org, entity = 'employees', source = 'baseline' } = {}) {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, item.id, version, JSON.stringify(snapshot), now(), source);
    return snapshot;
  }
  function importedItem(data, version = 1) {
    const time = now(), item = { ...data, id: id(), orgId: admin.org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, admin.org, 'employees', JSON.stringify(data), version, time, time);
    return item;
  }
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  async function approve(caller = admin) {
    const record = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services: [{ serviceItemId: serviceA.id, quantity: 3 }], status: 'submitted', note: '合成實際47分鐘' }, clients.carerA);
    const response = await request(caller, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(response.status, 200); return response.body.item;
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, employeeData, caseA, serviceData, serviceA, serviceB, plan, shiftData, shift, auditEvent, addSnapshot, importedItem, state, approve };
}

test('real employee lifecycle retains ten saved fields, inactive history and exact admin/supervisor actors', async t => {
  const f = await fixture(t);
  const v2 = await f.patch('employees', f.employeeA, { name: ' 合成新姓名 ', employeeNo: 'TEST-EH-RENAMED', role: '督導職務文字', phone: 'TEST-PHONE-B', email: 'synthetic-b@example.test', qualification: '新的資格摘要', regions: ['臺南', '', ' 臺北 ', '臺南'], note: '更新保存文字', hourlyRateCents: 24001 }, f.clients.supervisor);
  const v3 = await f.patch('employees', v2, { status: 'inactive' });
  const v4 = await f.patch('employees', v3, { status: 'active' }, f.clients.supervisor), before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const result = await f.request(caller, 'GET', history(v4)); assert.equal(result.status, 200); assert.equal(result.body.total, 4);
    const items = result.body.items;
    assert.deepEqual(items.map(row => saved(row.snapshot)), [v4, v3, v2, f.employeeA].map(saved));
    assert.deepEqual(items.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin), actor(f.clients.supervisor), actor(f.admin)]);
    for (let n = 0; n < 3; n++) assert.deepEqual(items[n].comparison, { status: 'available', previousVersion: items[n].version - 1, previousSnapshot: items[n + 1].snapshot });
    assert.deepEqual(items.at(-1).comparison, noPrevious('initial'));
    const raw = await f.request(caller, 'GET', history(v4, '')); assert.deepEqual(raw.body.items.map(row => row.snapshot), items.map(row => row.snapshot));
    assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  assert.deepEqual(f.state(), before);
});

test('four roles keep current/raw scope, caregiver needs no shift, and cross-organization or other-employee IDs stay hidden', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成員工乙機構' }), foreign = { ...f.admin, org: org.id };
  const other = await f.create('employees', f.employeeData, foreign), before = f.state();
  assert.equal((await f.request(f.clients.carerB, 'GET', '/api/shifts')).body.total, 0);
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) for (const item of [f.employeeA, f.employeeB]) for (const url of [detail(item), history(item, ''), history(item)]) assert.equal((await f.request(caller, 'GET', url)).status, 200);
  for (const [caller, own, denied] of [[f.clients.carerA, f.employeeA, f.employeeB], [f.clients.carerB, f.employeeB, f.employeeA]]) {
    assert.deepEqual((await f.request(caller, 'GET', '/api/employees')).body.items.map(item => item.id), [own.id]);
    for (const url of [detail(own), history(own, ''), history(own)]) assert.equal((await f.request(caller, 'GET', url)).status, 200);
    for (const url of [detail(denied), history(denied, ''), history(denied)]) assert.equal((await f.request(caller, 'GET', url)).status, 404);
  }
  for (const url of [detail(f.employeeA), history(f.employeeA, ''), history(f.employeeA)]) assert.equal((await f.request(foreign, 'GET', url)).status, 404);
  for (const url of [detail(other), history(other, ''), history(other), history({ id: id() })]) assert.equal((await f.request(f.admin, 'GET', url)).status, 404);
  assert.equal((await f.request(null, 'GET', history(f.employeeA))).status, 401); assert.deepEqual(f.state(), before);
});

test('inactive, missing, foreign and wrong-entity links keep caregiver auth 403 while managers retain inactive histories', async t => {
  const f = await fixture(t), inactive = await f.patch('employees', f.employeeA, { status: 'inactive' });
  let before = f.state();
  for (const url of [detail(inactive), history(inactive, ''), history(inactive)]) {
    const denied = await f.request(f.clients.carerA, 'GET', url); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', url)).status, 200);
  }
  assert.deepEqual(f.state(), before);
  const restored = await f.patch('employees', inactive, { status: 'active' });
  const org = await f.create('organizations', { name: '合成錯連結機構' }), foreign = await f.create('employees', f.employeeData, { ...f.admin, org: org.id });
  for (const employeeId of [null, id(), foreign.id, f.caseA.id]) {
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.carerA.user.id); before = f.state();
    for (const url of [detail(restored), history(restored, ''), history(restored)]) { const result = await f.request(f.clients.carerA, 'GET', url); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(f.employeeA.id, f.admin.org, f.clients.carerA.user.id); before = f.state();
  const own = await f.request(f.clients.carerA, 'GET', history(restored)); assert.deepEqual(own.body.items.map(row => row.snapshot.status), ['active', 'inactive', 'active']); assert.deepEqual(f.state(), before);
});

test('editing employee job title, name or number does not mutate login memberships or confer administrative permission', async t => {
  const f = await fixture(t), memberships = f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all();
  const changed = await f.patch('employees', f.employeeA, { role: 'admin', name: '合成職務不是帳號權限', employeeNo: ' TEST-EH-CHANGED ' });
  const before = f.state();
  const session = await f.request(f.clients.carerA, 'GET', '/api/session'); assert.equal(session.body.user.role, 'caregiver'); assert.equal(session.body.user.employeeId, changed.id); assert.equal(session.body.user.name, f.clients.carerA.user.name);
  assert.equal((await f.request(f.clients.carerA, 'POST', '/api/employees', { name: '禁止', employeeNo: 'TEST-DENIED' })).status, 403);
  assert.equal((await f.request(f.clients.carerA, 'PATCH', detail(changed), { version: changed.version, note: '禁止' })).status, 403);
  const result = await f.request(f.clients.carerA, 'GET', history(changed)); assert.equal(result.body.items[0].snapshot.role, 'admin'); assert.deepEqual(result.body.items[0].actor, actor(f.admin));
  assert.deepEqual(f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(), memberships); assert.deepEqual(f.state(), before);
});

test('legal regions preserve string/array types, ordering, repeated entries, whitespace and empty entries exactly', async t => {
  const f = await fixture(t); let current = f.employeeA;
  const values = ['臺北', ['臺北'], [], [''], ['', ' 臺北 ', '臺南', ' 臺北 '], '臺北、臺南, 保留分隔符', '', '區'.repeat(1000), Array.from({ length: 50 }, () => '區'.repeat(99))];
  for (const regions of values) current = await f.patch('employees', current, { regions });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const response = await f.request(caller, 'GET', history(current, query)); assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map(row => row.snapshot.regions), [...values].reverse().concat([f.employeeData.regions]));
    if (query) for (let i = 0; i < response.body.items.length - 1; i++) assert.deepEqual(response.body.items[i].comparison.previousSnapshot.regions, response.body.items[i + 1].snapshot.regions);
  }
  assert.deepEqual(f.state(), before);
});

test('employee actors match exact audit scope and integer version, use current users names and ignore review/complete events', async t => {
  const f = await fixture(t), current = await f.patch('employees', f.employeeA, { name: '合成员工新名稱與操作者不同' }, f.clients.supervisor);
  const org = await f.create('organizations', { name: '合成錯稽核機構' });
  for (const extra of [{ orgId: org.id }, { entity: 'shifts' }, { recordId: f.employeeB.id }, { action: 'service.review' }, { action: 'shift.complete' }, { detail: { version: '2' } }, { detail: { version: 2.5 } }, { detail: { version: 99 } }, { detail: {} }, { rawDetail: '{broken' }]) f.auditEvent({ detail: { version: 2 }, ...extra });
  f.auditEvent({ detail: { version: 2 }, userId: f.clients.supervisor.user.id });
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成督導目前帳號姓名', f.clients.supervisor.user.id);
  const before = f.state(), result = await f.request(f.admin, 'GET', history(current));
  assert.deepEqual(result.body.items[0].actor, { id: f.clients.supervisor.user.id, name: '合成督導目前帳號姓名' }); assert.deepEqual(result.body.items[1].actor, actor(f.admin)); assert.deepEqual(f.state(), before);
  f.auditEvent({ detail: { version: 2 } }); f.auditEvent({ detail: { version: 1 }, userId: 'missing-user' });
  const after = f.state(); assert.ok((await f.request(f.admin, 'GET', history(current))).body.items.every(row => row.actor === null)); assert.deepEqual(f.state(), after);
});

test('baseline, empty and exact-predecessor gaps never invent actors or read foreign-org/entity history', async t => {
  const f = await fixture(t), current = f.importedItem({ ...f.employeeData, employeeNo: 'TEST-EH-GAP' }, 3), empty = f.importedItem({ ...f.employeeData, employeeNo: 'TEST-EH-EMPTY' });
  f.addSnapshot(current, 1, { note: '合成早期保存' }); f.addSnapshot(current, 3, { note: '合成基準第三版' });
  const org = await f.create('organizations', { name: '合成污染歷程機構' });
  f.addSnapshot(current, 99, { note: 'PRIVATE-FOREIGN-HISTORY' }, { orgId: org.id }); f.addSnapshot(current, 98, { note: 'PRIVATE-WRONG-ENTITY' }, { entity: 'cases' });
  for (const action of ['service.review', 'shift.complete']) f.auditEvent({ recordId: current.id, action, detail: { version: 3 } });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) {
    const response = await f.request(caller, 'GET', history(current)); assert.deepEqual(response.body.items.map(row => row.version), [3, 1]); assert.ok(response.body.items.every(row => row.actor === null && row.source === 'baseline')); assert.deepEqual(response.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(response.body.items[1].comparison, noPrevious('initial')); assert.ok(!JSON.stringify(response.body).includes('PRIVATE-'));
    for (const query of ['', 'compare=previous']) { const result = await f.request(caller, 'GET', history(empty, query)); assert.equal(result.status, 200); assert.equal(result.body.total, 0); assert.deepEqual(result.body.items, []); }
  }
  assert.deepEqual(f.state(), before);
});

test('28 real employee versions compare across 25+3 pages while raw schema and invalid comparison contracts remain', async t => {
  const f = await fixture(t), unsupported = await f.create('announcements', { title: '合成未支援比較公告', body: '保留負向驗收' }); let current = f.employeeA;
  for (let version = 2; version <= 28; version++) current = await f.patch('employees', current, { note: '合成员工第' + version + '版' }, version % 2 ? f.admin : f.clients.supervisor);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const a = await f.request(caller, 'GET', history(current)), b = await f.request(caller, 'GET', history(current, 'compare=previous&page=2&pageSize=25'));
    assert.equal(a.body.total, 28); assert.equal(b.body.total, 28); assert.equal(a.body.items.length, 25); assert.equal(b.body.items.length, 3); assert.equal(a.body.items.at(-1).version, 4); assert.equal(a.body.items.at(-1).comparison.previousVersion, 3); assert.deepEqual(a.body.items.at(-1).comparison.previousSnapshot, b.body.items[0].snapshot); assert.deepEqual(b.body.items.at(-1).comparison, noPrevious('initial'));
    for (const row of [...a.body.items, ...b.body.items]) assert.deepEqual(row.actor, actor(row.version % 2 ? f.admin : f.clients.supervisor));
    const raw = await f.request(caller, 'GET', history(current, 'page=2&pageSize=25')); assert.deepEqual(raw.body.items.map(row => row.snapshot), b.body.items.map(row => row.snapshot)); assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) { const result = await f.request(f.admin, 'GET', history(current, query)); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_COMPARE'); }
  for (const query of ['page=0', 'page=1.5', 'pageSize=101']) assert.equal((await f.request(f.admin, 'GET', history(current, query))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', history(current, 'compare=previous&page=1e0&pageSize=25.0'))).body.items.length, 25);
  assert.equal((await f.request(f.admin, 'GET', history(unsupported, 'compare=next', 'announcements'))).body.error.code, 'INVALID_COMPARE');
  assert.equal((await f.request(f.clients.carerB, 'GET', history(current, 'compare=next'))).status, 404); assert.deepEqual(f.state(), before);
});

test('publicRecord masks both history snapshots without hiding authorized hourly rates or altering imported regions', async t => {
  const f = await fixture(t), data = { ...f.employeeData, employeeNo: 'TEST-EH-PROJECTION', hourlyRateCents: 0, fileId: 'PRIVATE-FILE', billingSnapshot: { marker: 'PRIVATE-FINANCE' }, regions: [{ secret: 'PRIVATE-NESTED' }] };
  const current = f.importedItem(data, 2); f.addSnapshot(current, 1, { hourlyRateCents: 1 }); f.addSnapshot(current, 2);
  f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(current.id, f.admin.org, f.clients.carerA.user.id);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', history(current, query)); assert.equal(result.status, 200); const financial = caller === f.admin || caller === f.clients.finance;
    const snapshots = result.body.items.flatMap(row => [row.snapshot, ...(row.comparison?.previousSnapshot ? [row.comparison.previousSnapshot] : [])]);
    for (const snapshot of snapshots) { assert.equal(Object.hasOwn(snapshot, 'fileId'), false); assert.equal(Object.hasOwn(snapshot, 'billingSnapshot'), financial); assert.ok([0, 1].includes(snapshot.hourlyRateCents)); assert.deepEqual(snapshot.regions, data.regions, 'raw API preserves imported business data; UI owns safe formatting'); }
    assert.ok(!JSON.stringify(result.body).includes('PRIVATE-FILE')); if (!financial) assert.ok(!JSON.stringify(result.body).includes('PRIVATE-FINANCE'));
    assert.equal((await f.request(caller, 'GET', detail(current))).body.item.hourlyRateCents, 0);
  }
  assert.deepEqual(f.state(), before);
});

test('employee role guards, stale CAS, CSRF and POST idempotency leave rejected operations unchanged', async t => {
  const f = await fixture(t), before = f.state();
  for (const caller of [f.clients.finance, f.clients.carerA]) {
    assert.equal((await f.request(caller, 'POST', '/api/employees', { ...f.employeeData, employeeNo: 'TEST-EH-DENIED' })).status, 403);
    assert.equal((await f.request(caller, 'PATCH', detail(f.employeeA), { version: 1, note: '禁止' })).status, 403);
  }
  for (const token of ['', 'invalid', 'é'.repeat(64)]) { const result = await f.request(f.admin, 'PATCH', detail(f.employeeA), { version: 1, note: '禁止CSRF' }, { 'X-CSRF-Token': token }); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'CSRF_INVALID'); }
  assert.deepEqual(f.state(), before);
  const payload = { ...f.employeeData, employeeNo: ' TEST-EH-IDEM ', name: ' 保留空白姓名 ', hourlyRateCents: 0 }, headers = { 'Idempotency-Key': 'employee-history-create' };
  const created = await f.request(f.clients.supervisor, 'POST', '/api/employees', payload, headers); assert.equal(created.status, 201); assert.equal(created.body.item.employeeNo, payload.employeeNo); assert.equal(created.body.item.name, payload.name);
  const after = f.state(), repeated = await f.request(f.clients.supervisor, 'POST', '/api/employees', payload, headers); assert.deepEqual(repeated.body, created.body); assert.equal(repeated.status, 201); assert.deepEqual(f.state(), after);
  assert.equal((await f.request(f.clients.supervisor, 'POST', '/api/employees', { ...payload, note: 'changed' }, headers)).body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.state(), after);
  const updated = await f.patch('employees', created.body.item, { name: '合成新員工名', employeeNo: 'TEST-EH-NEW-NO' });
  const savedState = f.state(), stale = await f.request(f.admin, 'PATCH', detail(updated), { version: 1, note: '過期' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT'); assert.deepEqual(f.state(), savedState);
});

test('invalid regions, numeric and string fields are rejected by unchanged model rules and exact same-org numbering stays unique', async t => {
  const f = await fixture(t), before = f.state();
  const invalid = [{ regions: null }, { regions: {} }, { regions: [1] }, { regions: ['ok', null] }, { regions: [['nested']] }, { regions: ['x'.repeat(100)] }, { regions: Array(51).fill('x') }, { regions: 'x'.repeat(1001) }, { hourlyRateCents: -1 }, { hourlyRateCents: 0.1 }, { hourlyRateCents: 1000000001 }, { hourlyRateCents: '1' }, { name: '' }, { employeeNo: '' }, { role: {} }, { qualification: 'x'.repeat(501) }, { phone: 'x'.repeat(501) }, { email: 'x'.repeat(501) }, { note: 'x'.repeat(10001) }, { fileId: 'forbidden' }, { billingSnapshot: {} }];
  for (const bad of invalid) { const response = await f.request(f.admin, 'PATCH', detail(f.employeeA), { version: 1, ...bad }); assert.equal(response.status, 422, JSON.stringify({ bad, response: response.body })); }
  const duplicate = await f.request(f.admin, 'PATCH', detail(f.employeeA), { version: 1, employeeNo: f.employeeB.employeeNo }); assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'DUPLICATE_CODE'); assert.deepEqual(f.state(), before);
  const max = await f.patch('employees', f.employeeA, { hourlyRateCents: 1000000000, qualification: 'x'.repeat(500), note: 'x'.repeat(10000), phone: '非電話格式仍是保存文字', email: '非email格式仍是保存文字', role: '非枚舉職務', regions: [] });
  const result = await f.request(f.clients.carerA, 'GET', history(max)); assert.equal(result.body.items[0].snapshot.hourlyRateCents, 1000000000); assert.deepEqual(result.body.items[0].snapshot.regions, []);
});

test('history GETs keep all eleven tables and two nonempty attachment BLOBs unchanged with six immutable triggers', async t => {
  const f = await fixture(t), cert = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成個案PDF', ...filePayload(PDF_BYTES, '合成個案.pdf', 'application/pdf') });
  const b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成證照PNG', ...filePayload(PNG_BYTES, '合成證照.png', 'image/png') });
  const downloads = [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]];
  const schema = f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all();
  assert.equal(schema.filter(row => row.type === 'table').length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  const before = f.state(); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA, f.clients.carerB]) for (const url of ['/api/employees', detail(f.employeeA), history(f.employeeA, ''), history(f.employeeA), history(f.employeeA, 'compare=previous&page=2&pageSize=1')]) {
    const result = await f.request(caller, 'GET', url); assert.ok([200, 404].includes(result.status)); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const caller of [f.admin, f.clients.supervisor, f.clients.carerA]) for (const [url, bytes] of downloads) for (const suffix of ['', '?recordVersion=1']) { const result = await f.request(caller, 'GET', url + suffix); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); assert.match(result.headers.get('content-disposition'), /^attachment;/); }
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all(), schema);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    const column = table === 'record_versions' ? 'source' : 'file_name';
    assert.throws(() => f.app.db.prepare(`UPDATE ${table} SET ${column}=?`).run('tamper'), /immutable/);
    assert.throws(() => f.app.db.prepare('DELETE FROM ' + table).run(), /immutable/);
  }
  assert.deepEqual(f.state(), before);
});

test('approved snapshots and fee/payroll amounts survive employee name, number, rate and status edits with all 19 report exits read-only', async t => {
  const f = await fixture(t), approved = await f.approve();
  assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.employee.name, f.employeeA.name); assert.equal(approved.billingSnapshot.serviceMinutes, 47);
  const fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  assert.equal(fees.totals.amountCents, 37035); assert.equal(payroll.totals.amountCents, 18800);
  const current = await f.patch('employees', f.employeeA, { name: '合成员工最新名稱', employeeNo: 'TEST-EH-LATEST', hourlyRateCents: 99999, status: 'inactive' }, f.clients.supervisor);
  await f.patch('service-items', f.serviceA, { unitPriceCents: 99999 });
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`);
  const normalize = value => typeof value === 'string' ? value : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'generatedAt'));
  const readReports = async () => {
    const results = {};
    for (const route of routes) { const result = await f.request(f.admin, 'GET', route); assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); results[route] = normalize(result.body); }
    return results;
  };
  const before = f.state(), reports = await readReports();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', history(current, query)); assert.equal(result.status, 200); assert.equal(result.body.items[0].snapshot.hourlyRateCents, 99999); assert.equal(result.body.items[1].snapshot.hourlyRateCents, 24000);
  }
  assert.equal((await f.request(f.clients.carerA, 'GET', history(current))).status, 403);
  assert.deepEqual(await readReports(), reports); assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees); assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  for (const kind of ['shift', 'service']) assert.ok(JSON.stringify(reports[`/api/${kind}-report/export?startDate=2026-01-01&endDate=2026-12-31`]).includes(current.name));
  assert.deepEqual(f.state(), before);
});
