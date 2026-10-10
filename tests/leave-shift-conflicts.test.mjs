import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, insert, business } from '../src/server/model.mjs';

const LEAVE = 'leave-requests', password = 'synthetic-leave-shift-conflicts-password';
const route = (item, query = '') => '/api/leave-requests/' + item.id + '/shift-conflicts' + (query ? '?' + query : '');
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, extraHeaders = {}) {
    const response = await fetch(base + url, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成請假衝突管理員', email: 'leave-conflicts-admin@example.test', password, organizationName: '合成衝突甲機構' });
  assert.equal(setup.status, 201);
  const clientFrom = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = clientFrom(setup);
  async function create(entity, data, client = admin, headers) {
    const result = await request(client, 'POST', '/api/' + entity, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, client = admin) {
    const result = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成員工甲', employeeNo: 'TEST-LSC-A', hourlyRateCents: 24000, phone: 'PRIVATE-EMPLOYEE-PHONE', note: 'PRIVATE-EMPLOYEE-NOTE' });
  const employeeB = await create('employees', { name: '合成員工乙', employeeNo: 'TEST-LSC-B', hourlyRateCents: 26000 });
  const clients = { admin };
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB]]) {
    const email = key + '@leave-conflicts.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    clients[key] = clientFrom(await request(null, 'POST', '/api/login', { email, password }));
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-LSC-CASE-A', phone: 'PRIVATE-CASE-PHONE', address: 'PRIVATE-CASE-ADDRESS', note: 'PRIVATE-CASE-NOTE' });
  const caseB = await create('cases', { name: '合成個案乙', caseNo: 'TEST-LSC-CASE-B' });
  const service = await create('service-items', { name: '合成試算服務', code: 'TEST-LSC-SERVICE', minutes: 60, unitPriceCents: 10000 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const planData = caseItem => ({ caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const planA = await create('care-plans', planData(caseA)), planB = await create('care-plans', planData(caseB));
  const leaveData = overrides => ({ employeeId: employeeA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', type: '合成自由假別<&>', reason: 'PRIVATE-LEAVE-REASON', status: 'pending', ...overrides });
  const shiftData = overrides => ({ caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services, note: 'PRIVATE-SHIFT-NOTE', ...overrides });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  // Explicit synthetic imported data may represent impossible/legacy states. Saved
  // versions are inserted once and never updated/deleted by these fixtures.
  const imported = (entity, data, orgId = admin.org) => insert(app.db, orgId, entity, data);
  async function serviceRecord(shift, status = 'draft') {
    const data = { shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date, actualStart: shift.startTime, actualEnd: shift.endTime, services, status: status === 'draft' ? 'draft' : 'submitted', note: 'PRIVATE-SERVICE-NOTE' };
    let item = await create('service-records', data);
    if (['returned', 'approved'].includes(status)) {
      const result = await request(clients.supervisor, 'POST', '/api/service-records/' + item.id + '/review', { version: item.version, decision: status, reviewNote: 'PRIVATE-REVIEW-NOTE' });
      assert.equal(result.status, 200, JSON.stringify(result.body)); item = result.body.item;
    }
    return item;
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, caseA, caseB, service, services, planA, planB, leaveData, shiftData, state, imported, serviceRecord };
}

test('fresh conflict DTO shows only allowed current fields and all GETs preserve the eleven tables', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData()), shift = await f.create('shifts', f.shiftData());
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor]) {
    const response = await f.request(caller, 'GET', route(leave)); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = response.body;
    assert.deepEqual(Object.keys(body).sort(), ['generatedAt', 'items', 'leave', 'note', 'page', 'pageSize', 'total']);
    assert.deepEqual(Object.keys(body.leave).sort(), ['date', 'employee', 'endTime', 'id', 'startTime', 'status', 'type', 'version']);
    assert.deepEqual(body.leave, { id: leave.id, version: 1, employee: { id: f.employeeA.id, name: f.employeeA.name, employeeNo: f.employeeA.employeeNo, status: 'active' }, date: leave.date, startTime: leave.startTime, endTime: leave.endTime, type: leave.type, status: 'pending' });
    assert.deepEqual(body.items, [{ shiftId: shift.id, version: 1, date: shift.date, startTime: shift.startTime, endTime: shift.endTime, status: 'scheduled', employee: body.leave.employee, case: { id: f.caseA.id, name: f.caseA.name, caseNo: f.caseA.caseNo, status: 'active' }, hasServiceRecord: false }]);
    assert.equal(body.total, 1); assert.equal(body.page, 1); assert.equal(body.pageSize, 25);
    assert.equal(new Date(body.generatedAt).toISOString(), body.generatedAt);
    assert.ok(!JSON.stringify(body).includes('PRIVATE')); assert.ok(!JSON.stringify(body).includes('billingSnapshot')); assert.ok(!Object.hasOwn(body, 'canApprove'));
  }
  assert.deepEqual(f.state(), before);
});

test('new conflict endpoint rejects other roles before query and rows while preserving original leave permissions', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData());
  await f.create('shifts', f.shiftData());
  const org = await f.create('organizations', { name: '合成衝突乙機構' }), foreign = { ...f.admin, org: org.id };
  const employee = await f.create('employees', { name: '合成外機構員工', employeeNo: 'TEST-LSC-FOREIGN' }, foreign);
  const foreignLeave = await f.create(LEAVE, f.leaveData({ employeeId: employee.id }), foreign);
  const before = f.state();
  for (const caller of [f.clients.finance, f.clients.carerA, f.clients.carerB]) for (const item of [leave, foreignLeave, { id: id() }]) {
    const result = await f.request(caller, 'GET', route(item, 'unknown=x')); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ROLE_FORBIDDEN');
  }
  assert.equal((await f.request(null, 'GET', route(leave))).status, 401);
  for (const caller of [f.admin, f.clients.supervisor]) assert.equal((await f.request(caller, 'GET', route(foreignLeave))).status, 404);
  assert.equal((await f.request(foreign, 'GET', route(leave))).status, 404);
  assert.equal((await f.request({ ...f.clients.supervisor, org: org.id }, 'GET', route(leave))).body.error.code, 'ORG_FORBIDDEN');
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const suffix of ['', '/history', '/history?compare=previous']) assert.equal((await f.request(caller, 'GET', '/api/' + LEAVE + '/' + leave.id + suffix)).status, 200);
  assert.equal((await f.request(f.clients.carerB, 'GET', '/api/' + LEAVE + '/' + leave.id)).status, 404);
  assert.deepEqual(f.state(), before);
});

test('same-day literal ISO minutes and half-open overlap keep completed shifts and exclude touching, cancelled or unrelated shifts', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData({ startTime: '2026-10-08T09:00:59+14:00', endTime: '2026-10-08T10:00:01-10:00' }));
  await f.create('shifts', f.shiftData({ startTime: '08:00', endTime: '09:00' }));
  await f.create('shifts', f.shiftData({ startTime: '10:00', endTime: '11:00' }));
  const first = await f.create('shifts', f.shiftData({ startTime: '09:00', endTime: '09:10' }));
  const second = await f.create('shifts', f.shiftData({ startTime: '2026-10-08T09:10:59Z', endTime: '2026-10-08T09:20:01-10:00' }));
  await f.create('shifts', f.shiftData({ status: 'cancelled', startTime: '09:00', endTime: '10:00' }));
  await f.create('shifts', f.shiftData({ date: '2026-10-09' }));
  await f.create('shifts', f.shiftData({ employeeId: f.employeeB.id, caseId: f.caseB.id, carePlanId: f.planB.id }));
  await f.serviceRecord(first, 'approved');
  const before = f.state(), response = await f.request(f.admin, 'GET', route(leave));
  assert.equal(response.status, 200); assert.deepEqual(response.body.items.map(item => item.shiftId), [first.id, second.id]);
  assert.equal(response.body.items[0].status, 'completed'); assert.equal(response.body.items[0].hasServiceRecord, true);
  assert.equal(response.body.items[1].startTime, second.startTime); assert.equal(response.body.items[1].endTime, second.endTime);
  assert.equal(response.body.leave.startTime, leave.startTime); assert.equal(response.body.leave.endTime, leave.endTime);
  assert.equal(response.body.items[1].hasServiceRecord, false);
  const approval = await f.request(f.admin, 'PATCH', '/api/' + LEAVE + '/' + leave.id, { version: leave.version, status: 'approved' });
  assert.equal(approval.status, 409); assert.equal(approval.body.error.code, 'SHIFT_CONFLICT'); assert.deepEqual(f.state(), before);
});

test('all saved leave statuses remain readable with inactive employees while only the new endpoint requires a current scoped parent', async t => {
  const f = await fixture(t), shift = await f.create('shifts', f.shiftData());
  const leaves = [];
  for (const status of ['pending', 'rejected', 'cancelled']) leaves.push(await f.create(LEAVE, f.leaveData({ status })));
  // Explicit imported approved overlap, impossible through the validated API.
  leaves.push(f.imported(LEAVE, f.leaveData({ status: 'approved' })));
  await f.patch('employees', f.employeeA, { status: 'inactive' });
  const org = await f.create('organizations', { name: '合成父項外機構' }), foreign = { ...f.admin, org: org.id };
  const foreignEmployee = await f.create('employees', { name: '合成外員工', employeeNo: 'TEST-LSC-PARENT' }, foreign);
  const invalid = [id(), foreignEmployee.id, f.caseA.id].map(employeeId => f.imported(LEAVE, f.leaveData({ employeeId })));
  const namelessEmployee = f.imported('employees', { status: 'inactive' });
  const namelessLeave = f.imported(LEAVE, f.leaveData({ employeeId: namelessEmployee.id }));
  const before = f.state();
  for (const client of [f.admin, f.clients.supervisor]) {
    for (const leave of leaves) {
      const response = await f.request(client, 'GET', route(leave)); assert.equal(response.status, 200);
      assert.equal(response.body.leave.status, leave.status); assert.equal(response.body.leave.employee.status, 'inactive'); assert.equal(response.body.items[0].shiftId, shift.id);
    }
    for (const leave of invalid) {
      assert.equal((await f.request(client, 'GET', route(leave))).status, 404);
      assert.equal((await f.request(client, 'GET', '/api/' + LEAVE + '/' + leave.id)).status, 200);
      assert.equal((await f.request(client, 'GET', '/api/' + LEAVE + '/' + leave.id + '/history?compare=previous')).body.total, 0);
    }
    const missingNames = (await f.request(client, 'GET', route(namelessLeave))).body;
    assert.deepEqual(missingNames.leave.employee, { id: namelessEmployee.id, name: null, employeeNo: null, status: 'inactive' });
  }
  const inactiveCaregiver = await f.request(f.clients.carerA, 'GET', route(leaves[0])); assert.equal(inactiveCaregiver.status, 403); assert.equal(inactiveCaregiver.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
  assert.deepEqual(f.state(), before);
});

test('hasServiceRecord follows every same-organization record status and existing locks without leaking record IDs or contents', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData({ endTime: '11:00' })), shifts = [], records = [];
  for (const [index, status] of ['draft', 'submitted', 'returned', 'approved'].entries()) {
    const minute = index * 10, startTime = '09:' + String(minute).padStart(2, '0'), endTime = '09:' + String(minute + 10).padStart(2, '0');
    const shift = await f.create('shifts', f.shiftData({ startTime, endTime })); shifts.push(shift); records.push(await f.serviceRecord(shift, status));
  }
  const unrecorded = await f.create('shifts', f.shiftData({ startTime: '09:40', endTime: '09:50' }));
  const polluted = await f.create('shifts', f.shiftData({ startTime: '09:50', endTime: '10:00' }));
  f.imported('service-records', { shiftId: polluted.id, employeeId: id(), caseId: id(), status: 'draft', billingSnapshot: { secret: 'PRIVATE-CORRUPTED-RECORD' } });
  const foreignOrg = await f.create('organizations', { name: '合成鎖定外機構' });
  f.imported('service-records', { shiftId: unrecorded.id, employeeId: f.employeeA.id, caseId: f.caseA.id, status: 'approved' }, foreignOrg.id);
  const before = f.state(), result = await f.request(f.admin, 'GET', route(leave));
  assert.equal(result.status, 200); assert.equal(result.body.total, 6);
  assert.deepEqual(result.body.items.map(item => item.hasServiceRecord), [true, true, true, true, false, true]);
  assert.deepEqual(result.body.items.map(item => item.status), ['scheduled', 'scheduled', 'scheduled', 'completed', 'scheduled', 'scheduled']);
  for (const record of records) assert.ok(!JSON.stringify(result.body).includes(record.id));
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
  for (const shift of shifts) {
    const current = (await f.request(f.admin, 'GET', '/api/shifts/' + shift.id)).body.item;
    for (const change of [{ status: 'cancelled' }, { employeeId: f.employeeB.id }]) {
      const blocked = await f.request(f.admin, 'PATCH', '/api/shifts/' + shift.id, { version: current.version, ...change });
      assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'SHIFT_HAS_RECORD');
    }
  }
  assert.deepEqual(f.state(), before);
  const draftShift = shifts[0];
  const noteOnly = await f.patch('shifts', draftShift, { note: '合成純備註仍可修改' }); assert.equal(noteOnly.version, 2);
});

test('missing, foreign and wrong-entity cases remain visible conflicts as null without exposing their raw IDs or requiring a care plan', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData());
  const org = await f.create('organizations', { name: '合成個案外機構' }), foreign = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'PRIVATE-FOREIGN-NO' }, foreign);
  const privateIds = [id(), foreignCase.id, f.employeeB.id];
  const shifts = privateIds.map(caseId => f.imported('shifts', f.shiftData({ caseId, carePlanId: id(), status: 'scheduled' })));
  const namelessCase = f.imported('cases', { status: 'closed' });
  const namedShift = f.imported('shifts', f.shiftData({ caseId: namelessCase.id, carePlanId: id(), status: 'completed' }));
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor]) {
    const result = await f.request(caller, 'GET', route(leave)); assert.equal(result.status, 200); assert.equal(result.body.total, 4);
    const map = new Map(result.body.items.map(item => [item.shiftId, item]));
    for (const shift of shifts) assert.equal(map.get(shift.id).case, null);
    assert.deepEqual(map.get(namedShift.id).case, { id: namelessCase.id, name: null, caseNo: null, status: 'closed' });
    assert.equal(map.get(namedShift.id).hasServiceRecord, false, 'completed alone does not invent a service record');
    for (const hiddenId of privateIds) assert.ok(!JSON.stringify(result.body).includes(hiddenId));
    assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
  }
  const approval = await f.request(f.admin, 'PATCH', '/api/' + LEAVE + '/' + leave.id, { version: 1, status: 'approved' });
  assert.equal(approval.body.error.code, 'SHIFT_CONFLICT'); assert.deepEqual(f.state(), before);
});

test('twenty-eight real non-overlapping shifts paginate after numeric-time sorting with stable exact-time ID ties', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData()), shifts = [];
  for (let minute = 27; minute >= 0; minute--) {
    const start = '09:' + String(minute).padStart(2, '0'), end = '09:' + String(minute + 1).padStart(2, '0');
    shifts.push(await f.create('shifts', f.shiftData({ startTime: minute % 2 ? '2026-10-08T' + start + ':59+14:00' : start, endTime: minute % 2 ? '2026-10-08T' + end + ':01-10:00' : end })));
  }
  const before = f.state();
  const first = (await f.request(f.admin, 'GET', route(leave))).body, second = (await f.request(f.admin, 'GET', route(leave, 'page=2'))).body;
  assert.equal(first.total, 28); assert.equal(first.items.length, 25); assert.equal(second.items.length, 3);
  assert.deepEqual([...first.items, ...second.items].map(item => item.shiftId), shifts.reverse().map(item => item.id));
  const beyond = (await f.request(f.admin, 'GET', route(leave, 'page=3'))).body; assert.equal(beyond.total, 28); assert.deepEqual(beyond.items, []);
  assert.equal((await f.request(f.admin, 'GET', route(leave, 'pageSize=100'))).body.items.length, 28); assert.deepEqual(f.state(), before);
  const tieLeave = await f.create(LEAVE, f.leaveData({ startTime: '12:00', endTime: '13:00' }));
  const ties = [
    f.imported('shifts', f.shiftData({ startTime: '12:00', endTime: '12:10', status: 'scheduled' })),
    f.imported('shifts', f.shiftData({ startTime: '2026-10-08T12:00:42-10:00', endTime: '2026-10-08T12:10:30Z', status: 'scheduled' })),
  ];
  const earlierEnd = f.imported('shifts', f.shiftData({ startTime: '12:00', endTime: '12:05', status: 'scheduled' }));
  const tieBefore = f.state(), sorted = (await f.request(f.admin, 'GET', route(tieLeave))).body.items;
  assert.deepEqual(sorted.map(item => item.shiftId), [earlierEnd.id, ...ties.map(item => item.id).sort()]); assert.deepEqual(f.state(), tieBefore);
});

test('query keys reject unknown and repeated parameters while numeric pagination retains existing Number semantics', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData());
  const before = f.state();
  for (const query of ['employeeId=' + f.employeeA.id, 'date=2026-10-08', 'status=pending', 'page=1&page=1', 'pageSize=25&pageSize=25', 'compare=previous', 'unknown=']) {
    const response = await f.request(f.admin, 'GET', route(leave, query)); assert.equal(response.status, 422); assert.equal(response.body.error.code, 'INVALID_QUERY');
  }
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=NaN', 'page=Infinity', 'page=9007199254740992', 'page=%20', 'pageSize=0', 'pageSize=101', 'pageSize=1.5']) {
    const response = await f.request(f.admin, 'GET', route(leave, query)); assert.equal(response.status, 422); assert.equal(response.body.error.code, 'PAGINATION');
  }
  for (const query of ['', 'page=&pageSize=', 'page=1.0&pageSize=25.0', 'page=1e0&pageSize=2.5e1', 'page=0x1&pageSize=0x19', 'page=01&pageSize=025']) {
    const response = await f.request(f.admin, 'GET', route(leave, query)); assert.equal(response.status, 200);
    assert.equal(response.body.page, 1); assert.equal(response.body.pageSize, 25); assert.equal(response.body.total, 0); assert.deepEqual(response.body.items, []);
  }
  assert.equal((await f.request(f.admin, 'POST', route(leave), {})).status, 404);
  assert.equal((await f.request(f.admin, 'GET', route(leave), undefined, { 'Idempotency-Key': 'ignored-read-key' })).status, 200);
  assert.deepEqual(f.state(), before);
});

test('invalid current dates or matching candidate intervals reject the complete read even beyond the requested page', async t => {
  const f = await fixture(t);
  for (const fields of [
    { date: '2026-02-30' }, { date: 'not-a-date' }, { date: '' }, { startTime: '24:00' },
    { startTime: '10:00', endTime: '09:00' }, { endTime: '09:00' }, { startTime: '2026-10-09T09:00:00Z' },
  ]) {
    const leave = f.imported(LEAVE, f.leaveData(fields)), before = f.state();
    const response = await f.request(f.admin, 'GET', route(leave)); assert.equal(response.status, 409); assert.equal(response.body.error.code, 'CONFLICT_DATA_INVALID');
    assert.ok(!Object.hasOwn(response.body, 'items')); assert.deepEqual(f.state(), before);
  }
  for (const [index, fields] of [{ startTime: 'invalid' }, { endTime: '24:00' }, { endTime: '09:00' }, { startTime: '10:00', endTime: '09:00' }, { startTime: '2026-10-09T09:00:00Z' }].entries()) {
    const date = '2026-10-' + String(20 + index), leave = await f.create(LEAVE, f.leaveData({ date }));
    f.imported('shifts', f.shiftData({ date, status: 'scheduled', ...fields }));
    f.imported('shifts', f.shiftData({ date, status: 'scheduled' }));
    const before = f.state();
    for (const query of ['', 'pageSize=1', 'page=999']) {
      const response = await f.request(f.admin, 'GET', route(leave, query)); assert.equal(response.status, 409); assert.equal(response.body.error.code, 'CONFLICT_DATA_INVALID');
      assert.ok(!Object.hasOwn(response.body, 'items'));
    }
    assert.deepEqual(f.state(), before);
  }
  const clean = await f.create(LEAVE, f.leaveData({ date: '2026-10-30' }));
  for (const fields of [{ employeeId: f.employeeB.id }, { date: 'not-matching-date' }, { status: 'cancelled' }]) f.imported('shifts', f.shiftData({ date: clean.date, status: 'scheduled', startTime: 'invalid', ...fields }));
  const before = f.state(), response = await f.request(f.admin, 'GET', route(clean));
  assert.equal(response.status, 200); assert.equal(response.body.total, 0); assert.deepEqual(f.state(), before);
});

test('the shared lazy predicate preserves original first-hit write errors while the read consumes all candidates', async t => {
  const f = await fixture(t);
  function orderedShift(data, createdAt) {
    const item = { ...data, id: id(), orgId: f.admin.org, version: 1, createdAt, updatedAt: createdAt };
    f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, item.orgId, 'shifts', JSON.stringify(business(item)), 1, createdAt, createdAt);
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(item.orgId, 'shifts', item.id, 1, JSON.stringify(item), createdAt, 'baseline');
  }
  for (const [index, conflictFirst] of [true, false].entries()) {
    const date = '2026-11-0' + (index + 1), leave = await f.create(LEAVE, f.leaveData({ date }));
    orderedShift(f.shiftData({ date, status: 'scheduled' }), conflictFirst ? '2030-01-02T00:00:00.000Z' : '2030-01-01T00:00:00.000Z');
    orderedShift(f.shiftData({ date, status: 'scheduled', startTime: 'invalid' }), conflictFirst ? '2030-01-01T00:00:00.000Z' : '2030-01-02T00:00:00.000Z');
    const before = f.state();
    for (const method of ['PATCH', 'POST']) {
      const url = '/api/' + LEAVE + (method === 'PATCH' ? '/' + leave.id : '');
      const data = method === 'PATCH' ? { version: leave.version, status: 'approved' } : f.leaveData({ date, status: 'approved' });
      const response = await f.request(f.admin, method, url, data, { 'Idempotency-Key': 'short-circuit-' + method + '-' + index });
      assert.equal(response.status, conflictFirst ? 409 : 422); assert.equal(response.body.error.code, conflictFirst ? 'SHIFT_CONFLICT' : 'TIME_RANGE');
    }
    const read = await f.request(f.admin, 'GET', route(leave)); assert.equal(read.status, 409); assert.equal(read.body.error.code, 'CONFLICT_DATA_INVALID');
    assert.deepEqual(f.state(), before);
  }
});

test('each read follows current leave reassignment, time changes, shift changes and newly created service locks', async t => {
  const f = await fixture(t); let leave = await f.create(LEAVE, f.leaveData());
  const shiftA = await f.create('shifts', f.shiftData());
  let shiftB = await f.create('shifts', f.shiftData({ employeeId: f.employeeB.id, caseId: f.caseB.id, carePlanId: f.planB.id }));
  async function readPure() {
    const before = f.state(), response = await f.request(f.clients.supervisor, 'GET', route(leave)); assert.equal(response.status, 200); assert.deepEqual(f.state(), before); return response.body;
  }
  assert.equal((await readPure()).items[0].shiftId, shiftA.id);
  leave = await f.patch(LEAVE, leave, { employeeId: f.employeeB.id }, f.clients.supervisor);
  let response = await readPure(); assert.equal(response.leave.version, 2); assert.equal(response.leave.employee.id, f.employeeB.id); assert.equal(response.items[0].shiftId, shiftB.id);
  leave = await f.patch(LEAVE, leave, { startTime: '11:00', endTime: '12:00' }); assert.equal((await readPure()).total, 0);
  shiftB = await f.patch('shifts', shiftB, { startTime: '11:00', endTime: '12:00' });
  response = await readPure(); assert.equal(response.items[0].version, 2); assert.equal(response.items[0].startTime, '11:00');
  shiftB = await f.patch('shifts', shiftB, { employeeId: f.employeeA.id }); assert.equal((await readPure()).total, 0);
  leave = await f.patch(LEAVE, leave, { employeeId: f.employeeA.id }); assert.equal((await readPure()).items[0].shiftId, shiftB.id);
  shiftB = await f.patch('shifts', shiftB, { status: 'cancelled' }); assert.equal((await readPure()).total, 0);
  const newShift = await f.create('shifts', f.shiftData({ startTime: '11:00', endTime: '12:00' }));
  assert.equal((await readPure()).items[0].hasServiceRecord, false);
  await f.serviceRecord(newShift, 'draft'); assert.equal((await readPure()).items[0].hasServiceRecord, true);
  await f.patch('employees', f.employeeA, { name: '合成目前員工新名稱' }); await f.patch('cases', f.caseA, { name: '合成目前個案新名稱' });
  response = await readPure(); assert.equal(response.leave.employee.name, '合成目前員工新名稱'); assert.equal(response.items[0].case.name, '合成目前個案新名稱');
});

test('an empty read never authorizes a later approval and manual reassignment preserves CAS, CSRF, idempotency and reciprocal leave guards', async t => {
  const f = await fixture(t), data = f.leaveData(), headers = { 'Idempotency-Key': 'leave-conflicts-original-write' };
  const leave = await f.create(LEAVE, data, f.admin, headers);
  const readBefore = f.state(); assert.equal((await f.request(f.admin, 'GET', route(leave))).body.total, 0); assert.deepEqual(f.state(), readBefore);
  let shift = await f.create('shifts', f.shiftData(), f.clients.supervisor);
  const beforeBlocked = f.state();
  const blocked = await f.request(f.admin, 'PATCH', '/api/' + LEAVE + '/' + leave.id, { version: 1, status: 'approved' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'SHIFT_CONFLICT');
  assert.equal((await f.request(f.admin, 'GET', route(leave))).body.total, 1); assert.deepEqual(f.state(), beforeBlocked);
  shift = await f.patch('shifts', shift, { employeeId: f.employeeB.id }, f.clients.supervisor);
  const beforeApproval = f.state(); assert.equal((await f.request(f.admin, 'GET', route(leave))).body.total, 0); assert.deepEqual(f.state(), beforeApproval);
  const approved = await f.patch(LEAVE, leave, { status: 'approved' }); assert.equal(approved.version, 2);
  const beforeRejectedWrites = f.state();
  const forbiddenShift = await f.request(f.admin, 'POST', '/api/shifts', f.shiftData({ caseId: f.caseB.id, carePlanId: f.planB.id }));
  assert.equal(forbiddenShift.status, 409); assert.equal(forbiddenShift.body.error.code, 'LEAVE_CONFLICT');
  const stale = await f.request(f.admin, 'PATCH', '/api/' + LEAVE + '/' + leave.id, { version: 1, status: 'cancelled' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  const noCsrf = await f.request(f.admin, 'PATCH', '/api/' + LEAVE + '/' + leave.id, { version: 2, status: 'cancelled' }, { 'X-CSRF-Token': '' }); assert.equal(noCsrf.status, 403);
  assert.equal((await f.create(LEAVE, data, f.admin, headers)).id, leave.id);
  assert.deepEqual(f.state(), beforeRejectedWrites);
  const cancelled = await f.patch(LEAVE, approved, { status: 'cancelled' });
  const fresh = await f.create('shifts', f.shiftData({ caseId: f.caseB.id, carePlanId: f.planB.id }));
  const finalBefore = f.state(), result = await f.request(f.admin, 'GET', route(cancelled));
  assert.equal(result.body.leave.status, 'cancelled'); assert.equal(result.body.items[0].shiftId, fresh.id); assert.deepEqual(f.state(), finalBefore);
});

test('conflict inspection preserves approved billing, parent histories, old reports and the eleven-table six-trigger schema', async t => {
  const f = await fixture(t), leave = await f.create(LEAVE, f.leaveData()), shift = await f.create('shifts', f.shiftData());
  let record = await f.create('service-records', { shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services: f.services, status: 'submitted' }, f.clients.carerA);
  const review = await f.request(f.admin, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved' }); assert.equal(review.status, 200); record = review.body.item;
  const kinds = ['cases', 'shifts', 'services', 'fees', 'payroll'];
  const reports = await Promise.all(kinds.map(async kind => (await f.request(f.admin, 'GET', '/api/reports/' + kind)).body));
  assert.equal(reports[3].totals.amountCents, 30000); assert.equal(reports[4].totals.amountCents, 18800);
  await f.patch('service-items', f.service, { unitPriceCents: 999999 }); await f.patch('employees', f.employeeA, { hourlyRateCents: 888888 });
  const parents = [[LEAVE, leave], ['shifts', shift], ['service-records', record], ['employees', f.employeeA], ['cases', f.caseA], ['care-plans', f.planA]];
  const histories = await Promise.all(parents.map(async ([entity, item]) => (await f.request(f.admin, 'GET', '/api/' + entity + '/' + item.id + '/history')).body));
  const schema = f.app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.equal(schema.filter(row => row.type === 'table').length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor]) for (const query of ['', 'page=2', 'pageSize=1']) {
    const response = await f.request(caller, 'GET', route(leave, query)); assert.equal(response.status, 200); assert.equal(response.body.total, 1);
    if (response.body.items.length) { assert.equal(response.body.items[0].status, 'completed'); assert.equal(response.body.items[0].hasServiceRecord, true); }
    assert.ok(!JSON.stringify(response.body).includes('billingSnapshot')); assert.ok(!JSON.stringify(response.body).includes('unitPriceCents')); assert.ok(!JSON.stringify(response.body).includes('hourlyRateCents'));
  }
  for (const caller of [f.clients.finance, f.clients.carerA]) assert.equal((await f.request(caller, 'GET', route(leave))).status, 403);
  assert.deepEqual(await Promise.all(kinds.map(async kind => (await f.request(f.admin, 'GET', '/api/reports/' + kind)).body)), reports);
  assert.deepEqual(await Promise.all(parents.map(async ([entity, item]) => (await f.request(f.admin, 'GET', '/api/' + entity + '/' + item.id + '/history')).body)), histories);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item.billingSnapshot, record.billingSnapshot);
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), schema);
  for (const sql of ['UPDATE record_versions SET source=source', 'DELETE FROM record_versions']) assert.throws(() => f.app.db.exec(sql), /immutable/);
  assert.deepEqual(f.state().tables, before.tables);
});
