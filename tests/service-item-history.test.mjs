import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, insert, now } from '../src/server/model.mjs';

const password = 'synthetic-service-item-history-password';
const fields = ['code', 'name', 'minutes', 'unitPriceCents', 'validFrom', 'validTo', 'status', 'note'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const history = (item, query = 'compare=previous', entity = 'service-items') => `/api/${entity}/${item.id}/history${query ? '?' + query : ''}`;
const detail = item => '/api/service-items/' + item.id;
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
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成服務主檔管理者', email: 'service-item-admin@example.test', password, organizationName: '合成服務主檔甲機構' });
  assert.equal(setup.status, 201);
  const clientFrom = result => ({ cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken, org: setup.body.organizations[0].id, user: result.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin) {
    const result = await request(caller, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成居服甲', employeeNo: 'TEST-SIH-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成居服乙', employeeNo: 'TEST-SIH-B', hourlyRateCents: 26000 });
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB]]) {
    const email = key + '@service-item-history.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-SIH-CA' });
  const serviceData = { code: 'TEST-SIH-SA', name: '合成測試服務甲', minutes: 60, unitPriceCents: 12345, validFrom: '', validTo: '', status: 'active', note: '合成主檔初版' };
  const serviceA = await create('service-items', serviceData), serviceB = await create('service-items', { ...serviceData, code: 'TEST-SIH-SB', name: '合成測試服務乙', unitPriceCents: 5000 });
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 30 }, { serviceItemId: serviceB.id, quantity: 30 }] });
  const shiftData = { caseId: caseA.id, employeeId: employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: serviceA.id, quantity: 1 }], status: 'scheduled', note: '合成可改派班次' };
  const shift = await create('shifts', shiftData);
  function auditEvent({ orgId = admin.org, entity = 'service-items', recordId = serviceA.id, userId = admin.user.id, action = 'record.update', detail: eventDetail = {}, rawDetail } = {}) {
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, rawDetail ?? JSON.stringify(eventDetail), now());
  }
  function addSnapshot(item, version, changes = {}, { orgId = admin.org, entity = 'service-items', source = 'baseline' } = {}) {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, item.id, version, JSON.stringify(snapshot), now(), source);
    return snapshot;
  }
  function importedItem(data, version = 1) {
    const time = now(), item = { ...data, id: id(), orgId: admin.org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, admin.org, 'service-items', JSON.stringify(data), version, time, time);
    return item;
  }
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  async function approve(caller = admin) {
    const record = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services: [{ serviceItemId: serviceA.id, quantity: 3 }], status: 'submitted', note: '合成實際47分鐘' }, clients.carerA);
    const response = await request(caller, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(response.status, 200); return response.body.item;
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, caseA, serviceData, serviceA, serviceB, plan, shiftData, shift, auditEvent, addSnapshot, importedItem, state, approve };
}

test('real service master lifecycle preserves all eight saved fields and exact admin/supervisor actors', async t => {
  const f = await fixture(t);
  const v2 = await f.patch('service-items', f.serviceA, { code: 'TEST-SIH-RENAMED', name: ' 合成保留前後空白 ', minutes: 45, unitPriceCents: 12346, validFrom: '2026-01-01', validTo: '2026-12-31', note: '合成一分差' }, f.clients.supervisor);
  const v3 = await f.patch('service-items', v2, { status: 'inactive' });
  const v4 = await f.patch('service-items', v3, { status: 'active', validFrom: '', validTo: '' }, f.clients.supervisor);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const result = await f.request(caller, 'GET', history(v4)); assert.equal(result.status, 200); assert.equal(result.body.total, 4);
    const items = result.body.items;
    assert.deepEqual(items.map(row => saved(row.snapshot)), [v4, v3, v2, f.serviceA].map(saved));
    assert.deepEqual(items.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin), actor(f.clients.supervisor), actor(f.admin)]);
    assert.equal(items[0].snapshot.name, ' 合成保留前後空白 '); assert.equal(items[0].snapshot.unitPriceCents, 12346);
    for (let n = 0; n < 3; n++) assert.deepEqual(items[n].comparison, { status: 'available', previousVersion: items[n].version - 1, previousSnapshot: items[n + 1].snapshot });
    assert.deepEqual(items[3].comparison, noPrevious('initial'));
    const raw = await f.request(caller, 'GET', history(v4, '')); assert.deepEqual(raw.body.items.map(row => row.snapshot), items.map(row => row.snapshot));
    assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  assert.deepEqual(f.state(), before);
});

test('all four authorized roles retain inactive and expired current/raw/compare access without crossing organizations', async t => {
  const f = await fixture(t), current = await f.patch('service-items', f.serviceA, { status: 'inactive', validFrom: '2020-01-01', validTo: '2020-12-31' });
  const org = await f.create('organizations', { name: '合成服務主檔乙機構' }), foreign = { ...f.admin, org: org.id };
  const other = await f.create('service-items', f.serviceData, foreign);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const url of [detail(current), history(current, ''), history(current)]) {
    const result = await f.request(caller, 'GET', url); assert.equal(result.status, 200); assert.ok(JSON.stringify(result.body).includes('2020-12-31'));
  }
  for (const caller of [f.clients.carerB, foreign]) for (const url of [detail(current), history(current, ''), history(current)]) assert.equal((await f.request(caller, 'GET', url)).status, 404);
  for (const url of [detail(other), history(other, ''), history(other), history({ id: id() })]) assert.equal((await f.request(f.admin, 'GET', url)).status, 404);
  assert.equal((await f.request(null, 'GET', history(current))).status, 401);
  assert.deepEqual(f.state(), before);
});

test('caregiver service scope is own current shift references including completed/cancelled, not plan or service-record references', async t => {
  const f = await fixture(t);
  const onlyRecord = await f.create('service-items', { ...f.serviceData, code: 'TEST-SIH-RECORD-ONLY' });
  // Explicit imported record with no own-shift reference must not expand service master scope.
  insert(f.app.db, f.admin.org, 'service-records', { employeeId: f.employeeA.id, services: [{ serviceItemId: onlyRecord.id, quantity: 1 }], status: 'draft', shiftId: id() });
  for (const item of [f.serviceB, onlyRecord]) for (const url of [detail(item), history(item, ''), history(item)]) assert.equal((await f.request(f.clients.carerA, 'GET', url)).status, 404);
  await f.approve();
  assert.equal((await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item.status, 'completed');
  await f.create('shifts', { ...f.shiftData, date: '2026-01-01', status: 'cancelled', services: [{ serviceItemId: f.serviceB.id, quantity: 1 }] });
  const before = f.state();
  for (const item of [f.serviceA, f.serviceB]) for (const query of ['', 'compare=previous']) assert.equal((await f.request(f.clients.carerA, 'GET', history(item, query))).status, 200);
  assert.equal((await f.request(f.clients.carerA, 'GET', '/api/service-items')).body.total, 2);
  assert.deepEqual(f.state(), before);
});

test('real shift A to B to A and removing/restoring services revoke and restore the complete service history', async t => {
  const f = await fixture(t), current = await f.patch('service-items', f.serviceA, { note: '合成服務第二版' });
  let shift = await f.patch('shifts', f.shift, { employeeId: f.employeeB.id });
  for (const url of [detail(current), history(current, ''), history(current)]) assert.equal((await f.request(f.clients.carerA, 'GET', url)).status, 404);
  assert.equal((await f.request(f.clients.carerB, 'GET', history(current))).body.total, 2);
  shift = await f.patch('shifts', shift, { employeeId: f.employeeA.id });
  assert.equal((await f.request(f.clients.carerA, 'GET', history(current))).body.total, 2);
  shift = await f.patch('shifts', shift, { services: [{ serviceItemId: f.serviceB.id, quantity: 1 }] });
  for (const url of [detail(current), history(current, ''), history(current)]) assert.equal((await f.request(f.clients.carerA, 'GET', url)).status, 404);
  shift = await f.patch('shifts', shift, { services: f.shift.services, status: 'cancelled' });
  const before = f.state();
  for (const query of ['', 'compare=previous']) { const result = await f.request(f.clients.carerA, 'GET', history(current, query)); assert.equal(result.body.total, 2); if (query) assert.equal(result.body.items[0].comparison.previousVersion, 1); }
  for (const url of [detail(current), history(current, ''), history(current)]) assert.equal((await f.request(f.clients.carerB, 'GET', url)).status, 404);
  assert.equal(shift.status, 'cancelled'); assert.deepEqual(f.state(), before);
});

test('service history adds no case/plan joins while missing, foreign and inactive caregiver links keep existing 403', async t => {
  const f = await fixture(t), special = await f.create('service-items', { ...f.serviceData, code: 'TEST-SIH-NO-PARENTS' });
  insert(f.app.db, f.admin.org, 'shifts', { ...f.shiftData, caseId: id(), carePlanId: id(), services: [{ serviceItemId: special.id, quantity: 1 }], status: 'cancelled' });
  const before = f.state();
  for (const url of [detail(special), history(special, ''), history(special)]) assert.equal((await f.request(f.clients.carerA, 'GET', url)).status, 200);
  assert.deepEqual(f.state(), before);
  const org = await f.create('organizations', { name: '合成其他員工機構' }), foreignEmployee = await f.create('employees', { name: '合成外機構員工', employeeNo: 'TEST-SIH-FOREIGN' }, { ...f.admin, org: org.id });
  for (const employeeId of [null, id(), foreignEmployee.id]) {
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.carerA.user.id);
    const state = f.state();
    for (const url of [detail(special), history(special, ''), history(special)]) { const result = await f.request(f.clients.carerA, 'GET', url); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.deepEqual(f.state(), state);
  }
  f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(f.employeeA.id, f.admin.org, f.clients.carerA.user.id);
  await f.patch('employees', f.employeeA, { status: 'inactive' });
  const state = f.state();
  for (const url of [detail(special), history(special, ''), history(special)]) assert.equal((await f.request(f.clients.carerA, 'GET', url)).status, 403);
  assert.equal((await f.request(f.clients.finance, 'GET', history(special))).status, 200); assert.deepEqual(f.state(), state);
});

test('actors require exact scope and integer version, allow duplicate identity and use the current user name', async t => {
  const f = await fixture(t), current = await f.patch('service-items', f.serviceA, { note: '合成精確第二版' }, f.clients.supervisor);
  const org = await f.create('organizations', { name: '合成錯誤稽核機構' });
  for (const extra of [{ orgId: org.id }, { entity: 'shifts' }, { recordId: f.serviceB.id }, { action: 'service.review' }, { action: 'shift.complete' }, { detail: { version: '2' } }, { detail: { version: 2.5 } }, { detail: { version: 99 } }, { detail: {} }, { rawDetail: '{broken' }]) f.auditEvent({ detail: { version: 2 }, ...extra });
  f.auditEvent({ detail: { version: 2 }, userId: f.clients.supervisor.user.id });
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成督導目前姓名', f.clients.supervisor.user.id);
  const before = f.state(), result = await f.request(f.admin, 'GET', history(current));
  assert.deepEqual(result.body.items[0].actor, { id: f.clients.supervisor.user.id, name: '合成督導目前姓名' }); assert.deepEqual(result.body.items[1].actor, actor(f.admin));
  assert.deepEqual(f.state(), before);
});

test('unknown or ambiguous actors stay null and service.review/shift.complete never identify a service master editor', async t => {
  const f = await fixture(t), current = await f.patch('service-items', f.serviceA, { note: '合成衝突身份' }, f.clients.supervisor);
  f.auditEvent({ detail: { version: 2 }, userId: f.admin.user.id }); f.auditEvent({ detail: { version: 1 }, userId: 'missing-user' });
  const imported = f.importedItem({ ...f.serviceData, code: 'TEST-SIH-UNKNOWN' }); f.addSnapshot(imported, 1);
  for (const action of ['service.review', 'shift.complete']) f.auditEvent({ recordId: imported.id, action, detail: { version: 1 } });
  const before = f.state();
  assert.ok((await f.request(f.admin, 'GET', history(current))).body.items.every(row => row.actor === null));
  const baseline = (await f.request(f.admin, 'GET', history(imported))).body.items[0]; assert.equal(baseline.actor, null); assert.deepEqual(baseline.comparison, noPrevious('initial'));
  assert.deepEqual(f.state(), before);
});

test('baseline, empty and missing versions never invent actors or skip gaps, and history selects exact org/entity/ID', async t => {
  const f = await fixture(t), current = f.importedItem({ ...f.serviceData, code: 'TEST-SIH-GAP' }, 3), empty = f.importedItem({ ...f.serviceData, code: 'TEST-SIH-EMPTY' });
  f.addSnapshot(current, 1, { note: '合成早版' }); f.addSnapshot(current, 3, { note: '合成基準第三版' });
  const org = await f.create('organizations', { name: '合成污染歷程機構' });
  f.addSnapshot(current, 99, { note: 'PRIVATE-WRONG-ORG' }, { orgId: org.id }); f.addSnapshot(current, 98, { note: 'PRIVATE-WRONG-ENTITY' }, { entity: 'employees' });
  insert(f.app.db, f.admin.org, 'shifts', { ...f.shiftData, status: 'cancelled', services: [current, empty].map(item => ({ serviceItemId: item.id, quantity: 1 })) });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const result = await f.request(caller, 'GET', history(current)); assert.equal(result.status, 200); assert.deepEqual(result.body.items.map(row => row.version), [3, 1]);
    assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(result.body.items[1].comparison, noPrevious('initial')); assert.ok(result.body.items.every(row => row.actor === null)); assert.ok(!JSON.stringify(result.body).includes('PRIVATE-'));
    for (const query of ['', 'compare=previous']) { const response = await f.request(caller, 'GET', history(empty, query)); assert.equal(response.status, 200); assert.equal(response.body.total, 0); assert.deepEqual(response.body.items, []); }
  }
  assert.deepEqual(f.state(), before);
});

test('28 real versions compare precise predecessors across 25+3 pages and preserve existing compare/pagination validation', async t => {
  const f = await fixture(t);
  const unsupported = await f.create('announcements', { title: '合成仍不支援比較的公告', body: '保留原比較拒絕驗收' }); let current = f.serviceA;
  for (let version = 2; version <= 28; version++) current = await f.patch('service-items', current, { note: '合成服務第' + version + '版' }, version % 2 ? f.admin : f.clients.supervisor);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const first = await f.request(caller, 'GET', history(current, 'compare=previous&page=1&pageSize=25')), second = await f.request(caller, 'GET', history(current, 'compare=previous&page=2&pageSize=25'));
    assert.equal(first.body.total, 28); assert.equal(second.body.total, 28); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
    assert.equal(first.body.items.at(-1).version, 4); assert.equal(first.body.items.at(-1).comparison.previousVersion, 3); assert.deepEqual(first.body.items.at(-1).comparison.previousSnapshot, second.body.items[0].snapshot);
    assert.deepEqual(second.body.items.at(-1).comparison, noPrevious('initial'));
    for (const row of [...first.body.items, ...second.body.items]) assert.deepEqual(row.actor, actor(row.version % 2 || row.version === 1 ? f.admin : f.clients.supervisor));
    const raw = await f.request(caller, 'GET', history(current, 'page=2&pageSize=25')); assert.deepEqual(raw.body.items.map(row => row.snapshot), second.body.items.map(row => row.snapshot)); assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) { const result = await f.request(f.admin, 'GET', history(current, query)); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_COMPARE'); }
  for (const query of ['page=0', 'page=1.5', 'pageSize=101']) assert.equal((await f.request(f.admin, 'GET', history(current, query))).status, 422);
  assert.equal((await f.request(f.admin, 'GET', history(current, 'compare=previous&page=1e0&pageSize=25.0'))).body.items.length, 25, 'existing Number parser semantics are retained');
  assert.equal((await f.request(f.admin, 'GET', history(unsupported, 'compare=next', 'announcements'))).status, 422);
  assert.equal((await f.request(f.clients.carerB, 'GET', history(current, 'compare=next'))).status, 404, 'current authorization precedes compare validation');
  assert.deepEqual(f.state(), before);
});

test('raw and both comparison snapshots retain publicRecord masking while every authorized role still reads saved unit prices', async t => {
  const f = await fixture(t), item = f.importedItem({ ...f.serviceData, code: 'TEST-SIH-PROJECTION', fileId: 'PRIVATE-FILE', billingSnapshot: { marker: 'PRIVATE-BILLING', employee: { hourlyRateCents: 987654321 } } }, 2);
  f.addSnapshot(item, 1, { unitPriceCents: 1 }); f.addSnapshot(item, 2, { unitPriceCents: 0 });
  insert(f.app.db, f.admin.org, 'shifts', { ...f.shiftData, status: 'cancelled', services: [{ serviceItemId: item.id, quantity: 1 }] });
  const before = f.state();
  for (const caller of [f.admin, f.clients.finance, f.clients.supervisor, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const response = await f.request(caller, 'GET', history(item, query)); assert.equal(response.status, 200);
    const financial = caller === f.admin || caller === f.clients.finance;
    const snapshots = response.body.items.flatMap(row => [row.snapshot, ...(row.comparison?.previousSnapshot ? [row.comparison.previousSnapshot] : [])]);
    for (const snapshot of snapshots) { assert.equal(Object.hasOwn(snapshot, 'fileId'), false); assert.equal(Object.hasOwn(snapshot, 'billingSnapshot'), financial); assert.ok([0, 1].includes(snapshot.unitPriceCents)); }
    assert.ok(!JSON.stringify(response.body).includes('PRIVATE-FILE')); if (!financial) assert.ok(!JSON.stringify(response.body).includes('PRIVATE-BILLING'));
    const current = (await f.request(caller, 'GET', detail(item))).body.item; assert.equal(current.unitPriceCents, 12345); assert.equal(Object.hasOwn(current, 'fileId'), false); assert.equal(Object.hasOwn(current, 'billingSnapshot'), financial);
  }
  assert.deepEqual(f.state(), before);
});

test('service writes retain role restrictions, CAS, CSRF, POST idempotency and existing scalar/date/unique-code boundaries', async t => {
  const f = await fixture(t), before = f.state();
  for (const caller of [f.clients.finance, f.clients.carerA]) {
    assert.equal((await f.request(caller, 'POST', '/api/service-items', { ...f.serviceData, code: 'TEST-DENIED' })).status, 403);
    assert.equal((await f.request(caller, 'PATCH', detail(f.serviceA), { version: 1, note: '禁止寫入' })).status, 403);
  }
  const csrf = await f.request(f.admin, 'PATCH', detail(f.serviceA), { version: 1, note: '禁止CSRF' }, { 'X-CSRF-Token': 'invalid' }); assert.equal(csrf.status, 403); assert.equal(csrf.body.error.code, 'CSRF_INVALID');
  for (const bad of [{ minutes: 0 }, { minutes: 1441 }, { minutes: 1.5 }, { unitPriceCents: -1 }, { unitPriceCents: 0.5 }, { unitPriceCents: 1000000001 }, { unitPriceCents: '1' }, { validFrom: '2026-02-30' }, { validFrom: '2026-02-01', validTo: '2026-01-31' }, { fileId: 'forbidden' }, { billingSnapshot: {} }, { name: '' }, { code: '' }]) {
    const result = await f.request(f.admin, 'PATCH', detail(f.serviceA), { version: 1, ...bad }); assert.equal(result.status, 422, JSON.stringify({ bad, result: result.body }));
  }
  assert.equal((await f.request(f.admin, 'PATCH', detail(f.serviceA), { version: 1, code: f.serviceB.code })).body.error.code, 'DUPLICATE_CODE'); assert.deepEqual(f.state(), before);
  const payload = { ...f.serviceData, code: ' TEST-SIH-IDEMPOTENT ', name: ' 保留原字串 ', minutes: 1, unitPriceCents: 0 }, headers = { 'Idempotency-Key': 'service-item-history-create' };
  const created = await f.request(f.clients.supervisor, 'POST', '/api/service-items', payload, headers); assert.equal(created.status, 201); assert.equal(created.body.item.code, payload.code); assert.equal(created.body.item.name, payload.name);
  const afterCreate = f.state(), repeat = await f.request(f.clients.supervisor, 'POST', '/api/service-items', payload, headers); assert.equal(repeat.status, 201); assert.deepEqual(repeat.body, created.body); assert.deepEqual(f.state(), afterCreate);
  assert.equal((await f.request(f.clients.supervisor, 'POST', '/api/service-items', { ...payload, note: 'different' }, headers)).body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.state(), afterCreate);
  const updated = await f.patch('service-items', created.body.item, { minutes: 1440, unitPriceCents: 1000000000, validFrom: '2024-02-29', validTo: '2024-02-29' });
  const afterPatch = f.state(), stale = await f.request(f.admin, 'PATCH', detail(updated), { version: 1, note: '合成過期' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT'); assert.deepEqual(f.state(), afterPatch);
  assert.equal((await f.request(f.admin, 'GET', history(updated))).body.total, 2);
});

test('pure GETs preserve all eleven tables, total_changes and six immutable triggers; historical versions cannot be rewritten', async t => {
  const f = await fixture(t), current = await f.patch('service-items', f.serviceA, { note: '合成唯讀基準' });
  const schema = f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all();
  assert.equal(schema.filter(row => row.type === 'table').length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA, f.clients.carerB]) for (const url of ['/api/service-items', detail(current), history(current, ''), history(current), history(current, 'compare=previous&page=2&pageSize=1')]) {
    const result = await f.request(caller, 'GET', url); assert.ok([200, 404].includes(result.status)); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all(), schema);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', current.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(current.id), /immutable/);
  assert.deepEqual(f.state(), before);
});

test('approved price/wage snapshots and old five plus three new reports remain compatible and read-only after master changes', async t => {
  const f = await fixture(t), approved = await f.approve();
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 12345); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000);
  const beforeFees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body;
  const beforePayroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  assert.equal(beforeFees.totals.amountCents, 37035); assert.equal(beforePayroll.totals.amountCents, 18800);
  const current = await f.patch('service-items', f.serviceA, { code: 'TEST-SIH-NEW-CODE', name: '合成主檔目前新名', unitPriceCents: 99999, minutes: 1, validFrom: '', validTo: '' }, f.clients.supervisor);
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999 });
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`);
  const normalize = value => typeof value === 'string' ? value : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'generatedAt'));
  const readReports = async () => {
    const responses = {};
    for (const route of routes) { const response = await f.request(f.admin, 'GET', route); assert.equal(response.status, 200, route + ': ' + JSON.stringify(response.body)); responses[route] = normalize(response.body); }
    return responses;
  };
  const before = f.state(), reports = await readReports();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', history(current, query)); assert.equal(result.status, 200); assert.equal(result.body.total, 2); assert.equal(result.body.items[0].snapshot.unitPriceCents, 99999); assert.equal(result.body.items[1].snapshot.unitPriceCents, 12345);
  }
  assert.deepEqual(await readReports(), reports);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, beforeFees);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, beforePayroll);
  assert.ok(JSON.stringify(reports['/api/shift-report/export?startDate=2026-01-01&endDate=2026-12-31']).includes('合成主檔目前新名'));
  assert.ok(JSON.stringify(reports['/api/service-report/export?startDate=2026-01-01&endDate=2026-12-31']).includes('合成主檔目前新名'));
  assert.deepEqual(f.state(), before);
  const recordLock = await f.request(f.admin, 'PATCH', '/api/service-records/' + approved.id, { version: approved.version, note: '禁止改核阅' }); assert.equal(recordLock.status, 409); assert.equal(recordLock.body.error.code, 'RECORD_LOCKED');
  const completed = (await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item;
  const shiftLock = await f.request(f.admin, 'PATCH', '/api/shifts/' + completed.id, { version: completed.version, employeeId: f.employeeB.id }); assert.equal(shiftLock.status, 409); assert.equal(shiftLock.body.error.code, 'SHIFT_HAS_RECORD');
  assert.deepEqual(f.state(), before);
});
