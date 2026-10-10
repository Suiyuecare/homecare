import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, insert, business } from '../src/server/model.mjs';

const ENTITY = 'leave-requests';
const password = 'synthetic-leave-history-password';
const actor = client => ({ id: client.user.id, name: client.user.name });
const noPrevious = status => ({ status, previousVersion: null, previousSnapshot: null });
const historyUrl = (item, query = 'compare=previous', entity = ENTITY) => `/api/${entity}/${item.id}/history` + (query ? '?' + query : '');
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extraHeaders = {}) {
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成請假管理員', email: 'leave-history-admin@example.test', password, organizationName: '合成請假甲機構' });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const clientFrom = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = clientFrom(setup);
  async function create(entity, data, caller = admin, headers) {
    const response = await request(caller, 'POST', '/api/' + entity, data, headers);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const response = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...data });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const employeeA = await create('employees', { name: '合成員工甲', employeeNo: 'TEST-LH-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成員工乙', employeeNo: 'TEST-LH-B', hourlyRateCents: 26000 });
  const clients = { admin };
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB]]) {
    const email = key + '@leave-history.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = clientFrom(login);
  }
  const data = overrides => ({ employeeId: employeeA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', type: '合成機構自由假別', reason: '合成請假原因', status: 'pending', ...overrides });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  // Explicit memory-only imported/legacy fixtures do not overwrite immutable history.
  function addSnapshot(item, version, changes = {}, scope = {}) {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(scope.orgId || admin.org, scope.entity || ENTITY, item.id, version, JSON.stringify(snapshot), now(), 'baseline');
    return snapshot;
  }
  function imported(fields, version = 1) {
    const time = now(), item = { ...data(fields), id: id(), orgId: admin.org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, admin.org, ENTITY, JSON.stringify(business(item)), version, time, time);
    return item;
  }
  function auditEvent(item, changes = {}) {
    const { orgId = admin.org, entity = ENTITY, recordId = item.id, userId = admin.user.id, action = 'record.update', detail = { version: item.version }, rawDetail } = changes;
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, rawDetail ?? JSON.stringify(detail), now());
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, data, state, addSnapshot, imported, auditEvent };
}

async function scheduling(f) {
  const caseItem = await f.create('cases', { name: '合成請假衝突個案', caseNo: 'TEST-LH-CASE' });
  const service = await f.create('service-items', { code: 'TEST-LH-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 10000 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await f.create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shiftData = { caseId: caseItem.id, employeeId: f.employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services };
  const shift = await f.create('shifts', shiftData);
  async function approve() {
    const submitted = await f.create('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: f.employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, f.clients.carerA);
    const response = await f.request(f.admin, 'POST', `/api/service-records/${submitted.id}/review`, { version: submitted.version, decision: 'approved', reviewNote: '合成真實核准' });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  return { caseItem, service, services, plan, shiftData, shift, approve };
}

test('real pending edit, approval, cancellation and rejection preserve seven saved fields and exact record.create/update actors', async t => {
  const f = await fixture(t), v1 = await f.create(ENTITY, f.data());
  const changed = { date: '2026-10-09', startTime: '2026-10-09T11:03:19+08:00', endTime: '2026-10-09T12:08:51+08:00', type: '機構自訂自由假別<&>', reason: '合成修改原因' };
  const v2 = await f.patch(ENTITY, v1, changed, f.clients.supervisor);
  const v3 = await f.patch(ENTITY, v2, { status: 'approved' });
  const v4 = await f.patch(ENTITY, v3, { status: 'cancelled' }, f.clients.supervisor);
  const pendingOther = await f.create(ENTITY, f.data({ reason: '合成待駁回' }));
  const rejected = await f.patch(ENTITY, pendingOther, { status: 'rejected' }, f.clients.supervisor);
  await f.patch('employees', f.employeeA, { name: '合成員工甲目前新名' });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const response = await f.request(caller, 'GET', historyUrl(v4)); assert.equal(response.status, 200); assert.equal(response.body.total, 4);
    const items = response.body.items;
    assert.deepEqual(items.map(row => row.version), [4, 3, 2, 1]);
    assert.deepEqual(items.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin), actor(f.clients.supervisor), actor(f.admin)]);
    assert.deepEqual(items.map(row => row.snapshot.status), ['cancelled', 'approved', 'pending', 'pending']);
    for (const [key, value] of Object.entries(changed)) assert.equal(items[2].snapshot[key], value);
    assert.equal(items[3].snapshot.startTime, '09:00'); assert.equal(items[3].snapshot.type, f.data().type);
    assert.ok(!JSON.stringify(items).includes('合成員工甲目前新名'));
    for (const row of items) for (const key of ['hours', 'minutes', 'balance', 'statutoryHours']) assert.ok(!Object.hasOwn(row.snapshot, key));
    for (let i = 0; i < 3; i++) { assert.equal(items[i].comparison.previousVersion, items[i].version - 1); assert.deepEqual(items[i].comparison.previousSnapshot, items[i + 1].snapshot); }
    assert.deepEqual(items[3].comparison, noPrevious('initial'));
    const raw = await f.request(caller, 'GET', historyUrl(v4, ''));
    assert.deepEqual(raw.body.items.map(row => row.snapshot), items.map(row => row.snapshot));
    assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
    const denied = await f.request(caller, 'GET', historyUrl(rejected)); assert.equal(denied.body.items[0].snapshot.status, 'rejected'); assert.deepEqual(denied.body.items[0].actor, actor(f.clients.supervisor));
  }
  assert.deepEqual(f.state(), before);
});

test('true A to B to A leave reassignment keeps privileged history and caregiver exact-predecessor gaps without fixed-parent filtering', async t => {
  const f = await fixture(t), v1 = await f.create(ENTITY, f.data());
  const v2 = await f.patch(ENTITY, v1, { employeeId: f.employeeB.id, reason: 'PRIVATE-B-LEAVE', date: '2026-10-09' }, f.clients.supervisor);
  let before = f.state();
  for (const query of ['', 'compare=previous']) {
    assert.equal((await f.request(f.clients.carerA, 'GET', historyUrl(v2, query))).status, 404);
    const ownB = await f.request(f.clients.carerB, 'GET', historyUrl(v2, query)); assert.equal(ownB.status, 200); assert.deepEqual(ownB.body.items.map(row => row.version), [2]);
    assert.ok(!JSON.stringify(ownB.body).includes(f.employeeA.id)); if (query) assert.deepEqual(ownB.body.items[0].comparison, noPrevious('unavailable'));
  }
  assert.deepEqual(f.state(), before);
  const v3 = await f.patch(ENTITY, v2, { employeeId: f.employeeA.id, reason: '合成回派員工甲' });
  before = f.state();
  for (const query of ['', 'compare=previous']) {
    const own = await f.request(f.clients.carerA, 'GET', historyUrl(v3, query)); assert.equal(own.status, 200); assert.deepEqual(own.body.items.map(row => row.version), [3, 1]);
    for (const secret of ['PRIVATE-B-LEAVE', f.employeeB.id]) assert.ok(!JSON.stringify(own.body).includes(secret));
    if (query) { assert.deepEqual(own.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(own.body.items[1].comparison, noPrevious('initial')); }
    assert.equal((await f.request(f.clients.carerB, 'GET', historyUrl(v3, query))).status, 404);
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) {
      const all = await f.request(caller, 'GET', historyUrl(v3, query)); assert.equal(all.body.total, 3);
      if (query) { assert.equal(all.body.items[0].comparison.previousSnapshot.employeeId, f.employeeB.id); assert.equal(all.body.items[1].comparison.previousSnapshot.employeeId, f.employeeA.id); }
    }
  }
  assert.deepEqual(f.state(), before);
});

test('leave raw/compare preserve four-role scope, cross-organization rejection and inactive or invalid caregiver-link behavior', async t => {
  const f = await fixture(t), mine = await f.create(ENTITY, f.data()), other = await f.create(ENTITY, f.data({ employeeId: f.employeeB.id }));
  const organization = await f.create('organizations', { name: '合成請假乙機構' }), foreign = { ...f.admin, org: organization.id };
  const foreignEmployee = await f.create('employees', { name: '合成跨機構員工', employeeNo: 'TEST-LH-FOREIGN' }, foreign);
  let before = f.state();
  for (const query of ['', 'compare=previous']) {
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) assert.equal((await f.request(caller, 'GET', historyUrl(mine, query))).status, 200);
    for (const caller of [foreign, f.clients.carerB]) assert.equal((await f.request(caller, 'GET', historyUrl(mine, query))).status, 404);
    assert.equal((await f.request(f.clients.carerA, 'GET', historyUrl(other, query))).status, 404);
    assert.equal((await f.request(f.admin, 'GET', historyUrl({ id: id() }, query))).status, 404);
    assert.equal((await f.request(null, 'GET', historyUrl(mine, query))).status, 401);
  }
  for (const caller of [f.clients.finance, f.clients.carerA]) {
    assert.equal((await f.request(caller, 'POST', '/api/' + ENTITY, f.data())).status, 403);
    assert.equal((await f.request(caller, 'PATCH', `/api/${ENTITY}/${mine.id}`, { version: mine.version, reason: '禁止修改' })).status, 403);
  }
  assert.deepEqual(f.state(), before);
  const inactive = await f.patch('employees', f.employeeA, { status: 'inactive' });
  const updated = await f.patch(ENTITY, mine, { reason: '合成停用員工仍可維護' }, f.clients.supervisor);
  const createdInactive = await f.create(ENTITY, f.data({ status: 'approved' }), f.clients.supervisor);
  before = f.state();
  for (const item of [updated, createdInactive]) for (const query of ['', 'compare=previous']) {
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', historyUrl(item, query))).status, 200);
    const denied = await f.request(f.clients.carerA, 'GET', historyUrl(item, query)); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
  }
  assert.deepEqual(f.state(), before);
  await f.patch('employees', inactive, { status: 'active' });
  for (const employeeId of [null, 'synthetic-missing-employee', foreignEmployee.id]) {
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.carerA.user.id);
    before = f.state();
    for (const query of ['', 'compare=previous']) { const denied = await f.request(f.clients.carerA, 'GET', historyUrl(updated, query)); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.deepEqual(f.state(), before);
  }
});

test('all roles filter missing and foreign historical employees while a missing current parent retains earlier readable employees', async t => {
  const f = await fixture(t), organization = await f.create('organizations', { name: '合成請假污染來源' }), foreign = { ...f.admin, org: organization.id };
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN-EMPLOYEE', employeeNo: 'TEST-LH-FOREIGN' }, foreign), missing = id();
  const item = await f.create(ENTITY, f.data());
  f.addSnapshot(item, 2, { employeeId: f.employeeB.id, reason: '合成可讀不同父項' });
  f.addSnapshot(item, 3, { employeeId: missing, reason: 'PRIVATE-MISSING-EMPLOYEE' });
  f.addSnapshot(item, 4, { employeeId: foreignEmployee.id, reason: 'PRIVATE-FOREIGN-EMPLOYEE' });
  const current = f.addSnapshot(item, 5, { reason: '合成可讀第五版' });
  f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(JSON.stringify(business(current)), 5, item.id);
  f.addSnapshot(item, 6, { reason: 'PRIVATE-WRONG-ORG' }, { orgId: organization.id });
  f.addSnapshot(item, 7, { reason: 'PRIVATE-WRONG-ENTITY' }, { entity: 'shifts' });
  const orphan = f.imported({ employeeId: missing, reason: 'PRIVATE-MISSING-CURRENT-PARENT' }, 3);
  f.addSnapshot(orphan, 1, { employeeId: f.employeeA.id, reason: '合成早期員工甲' });
  f.addSnapshot(orphan, 2, { employeeId: f.employeeB.id, reason: '合成早期員工乙' });
  f.addSnapshot(orphan, 3);
  const onlyMissing = insert(f.app.db, f.admin.org, ENTITY, f.data({ employeeId: missing }));
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', historyUrl(current, query)); assert.equal(result.status, 200);
    const visible = caller === f.clients.carerA ? [5, 1] : [5, 2, 1]; assert.deepEqual(result.body.items.map(row => row.version), visible);
    for (const secret of ['PRIVATE-', missing, foreignEmployee.id]) assert.ok(!JSON.stringify(result.body).includes(secret));
    if (query) { assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable')); if (caller !== f.clients.carerA) assert.equal(result.body.items[1].comparison.previousVersion, 1); }
    const page = await f.request(caller, 'GET', historyUrl(current, (query ? query + '&' : '') + 'page=2&pageSize=1'));
    assert.equal(page.body.total, visible.length); assert.equal(page.body.items[0].version, visible[1]);
  }
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) for (const query of ['', 'compare=previous']) {
    assert.equal((await f.request(caller, 'GET', `/api/${ENTITY}/${orphan.id}`)).status, 200, 'no new current-parent join');
    const result = await f.request(caller, 'GET', historyUrl(orphan, query)); assert.equal(result.status, 200); assert.deepEqual(result.body.items.map(row => row.version), [2, 1]);
    assert.ok(!JSON.stringify(result.body).includes(missing)); if (query) assert.equal(result.body.items[0].comparison.previousSnapshot.employeeId, f.employeeA.id);
    const empty = await f.request(caller, 'GET', historyUrl(onlyMissing, query)); assert.equal(empty.status, 200); assert.equal(empty.body.total, 0); assert.deepEqual(empty.body.items, []);
  }
  for (const caller of [f.clients.carerA, f.clients.carerB]) assert.equal((await f.request(caller, 'GET', historyUrl(orphan))).status, 404);
  assert.deepEqual(f.state(), before);
});

test('leave actor attribution ignores invented review events and wrong scopes or versions and handles duplicate, missing and conflicting users exactly', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data()), approved = await f.patch(ENTITY, first, { status: 'approved' }, f.clients.supervisor);
  const organization = await f.create('organizations', { name: '合成錯稽核機構' });
  for (const change of [
    { orgId: organization.id }, { entity: 'service-records' }, { recordId: id() },
    { action: 'leave.review' }, { action: 'service.review' }, { action: 'shift.complete' }, { action: 'unrelated.action' },
    { detail: { version: '2' } }, { detail: { version: 2.5 } }, { detail: { version: 99 } }, { detail: {} }, { rawDetail: '{invalid' },
  ]) f.auditEvent(approved, change);
  let before = f.state(), result = await f.request(f.admin, 'GET', historyUrl(approved));
  assert.deepEqual(result.body.items[0].actor, actor(f.clients.supervisor)); assert.deepEqual(result.body.items[1].actor, actor(f.admin)); assert.deepEqual(f.state(), before);
  f.auditEvent(approved, { userId: f.clients.supervisor.user.id });
  before = f.state(); result = await f.request(f.admin, 'GET', historyUrl(approved)); assert.deepEqual(result.body.items[0].actor, actor(f.clients.supervisor)); assert.deepEqual(f.state(), before);
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成核准者目前新名', f.clients.supervisor.user.id);
  before = f.state(); result = await f.request(f.admin, 'GET', historyUrl(approved)); assert.equal(result.body.items[0].actor.name, '合成核准者目前新名'); assert.deepEqual(f.state(), before);
  f.auditEvent(approved); f.auditEvent(first, { userId: 'synthetic-missing-user' });
  before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) assert.deepEqual((await f.request(caller, 'GET', historyUrl(approved))).body.items.map(row => row.actor), [null, null]);
  assert.deepEqual(f.state(), before);
});

test('baseline gaps and empty histories do not invent actors; current and exact previous snapshots retain existing publicRecord masking', async t => {
  const f = await fixture(t), baseline = f.imported({ reason: '合成第三版基準' }, 3);
  f.addSnapshot(baseline, 1, { reason: '合成第一版' }); f.addSnapshot(baseline, 3);
  f.auditEvent(baseline, { detail: { version: '3' } });
  const empty = f.imported({ reason: '合成無歷程匯入' });
  const paired = f.imported({ billingSnapshot: { marker: 'PRIVATE-LEAVE-FINANCIAL', employee: { hourlyRateCents: 987654321 } }, fileId: 'PRIVATE-LEAVE-BLOB' }, 2);
  f.addSnapshot(paired, 1); f.addSnapshot(paired, 2);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', historyUrl(baseline, query)); assert.equal(result.status, 200); assert.deepEqual(result.body.items.map(row => row.version), [3, 1]);
    if (query) { assert.ok(result.body.items.every(row => row.actor === null)); assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(result.body.items[1].comparison, noPrevious('initial')); }
    const none = await f.request(caller, 'GET', historyUrl(empty, query)); assert.equal(none.status, 200); assert.equal(none.body.total, 0); assert.deepEqual(none.body.items, []);
    const pair = await f.request(caller, 'GET', historyUrl(paired, query)); assert.equal(pair.status, 200);
    const snapshots = pair.body.items.map(row => row.snapshot);
    if (query) { assert.equal(pair.body.items[0].comparison.status, 'available'); snapshots.push(pair.body.items[0].comparison.previousSnapshot); }
    const financial = caller === f.admin || caller === f.clients.finance;
    for (const snapshot of snapshots) { assert.equal(Object.hasOwn(snapshot, 'billingSnapshot'), financial); assert.ok(!Object.hasOwn(snapshot, 'fileId')); }
    if (!financial) assert.ok(!JSON.stringify(pair.body).includes('PRIVATE-LEAVE'));
  }
  assert.deepEqual(f.state(), before);
});

test('28 real leave versions compare across 25-row page boundaries while raw schema and invalid comparison handling stay unchanged', async t => {
  const f = await fixture(t);
  const unsupported = await f.create('announcements', { title: '合成仍不支援比較的公告', body: '保留原比較拒絕驗收' }); let item = await f.create(ENTITY, f.data());
  for (let version = 2; version <= 28; version++) item = await f.patch(ENTITY, item, { reason: '合成真實修改第' + version + '版' }, version % 2 ? f.admin : f.clients.supervisor);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const first = await f.request(caller, 'GET', historyUrl(item));
    const second = await f.request(caller, 'GET', historyUrl(item, 'compare=previous&page=2&pageSize=25'));
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(first.body.total, 28); assert.equal(second.body.total, 28);
    assert.equal(first.body.pageSize, 25); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
    assert.equal(first.body.items.at(-1).version, 4); assert.equal(first.body.items.at(-1).comparison.previousVersion, 3);
    assert.deepEqual(first.body.items.at(-1).comparison.previousSnapshot, second.body.items[0].snapshot); assert.deepEqual(second.body.items.at(-1).comparison, noPrevious('initial'));
    assert.deepEqual(first.body.items[0].actor, actor(f.clients.supervisor));
    const raw = await f.request(caller, 'GET', historyUrl(item, 'page=2&pageSize=25'));
    assert.deepEqual(raw.body.items.map(row => row.snapshot), second.body.items.map(row => row.snapshot)); assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) {
    const invalid = await f.request(f.admin, 'GET', historyUrl(item, query)); assert.equal(invalid.status, 422); assert.equal(invalid.body.error.code, 'INVALID_COMPARE');
  }
  assert.equal((await f.request(f.admin, 'GET', historyUrl(unsupported, 'compare=next', 'announcements'))).status, 422);
  assert.deepEqual(f.state(), before);
});

test('leave CAS, CSRF, idempotency, field validation and immutable versions stay enforced without introducing a pending-only state machine', async t => {
  const f = await fixture(t), data = f.data({ status: 'approved' }), headers = { 'Idempotency-Key': 'synthetic-leave-history' };
  const first = await f.request(f.admin, 'POST', '/api/' + ENTITY, data, headers), replay = await f.request(f.admin, 'POST', '/api/' + ENTITY, data, headers);
  assert.equal(first.status, 201); assert.equal(replay.status, 201); assert.deepEqual(first.body, replay.body);
  const changedApproved = await f.patch(ENTITY, first.body.item, { employeeId: f.employeeB.id, startTime: '11:00', endTime: '12:00', reason: '合成核准後仍依原API合法修改' }, f.clients.supervisor);
  assert.equal(changedApproved.status, 'approved');
  const rejected = await f.patch(ENTITY, changedApproved, { status: 'rejected' });
  const item = await f.patch(ENTITY, rejected, { status: 'pending' }, f.clients.supervisor);
  const before = f.state();
  const stale = await f.request(f.admin, 'PATCH', `/api/${ENTITY}/${item.id}`, { version: 1, reason: '合成過時' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal((await f.request(f.admin, 'POST', '/api/' + ENTITY, { ...data, reason: '不同內容' }, headers)).status, 409);
  for (const method of ['POST', 'PATCH']) {
    const response = await f.request(f.admin, method, method === 'POST' ? '/api/' + ENTITY : `/api/${ENTITY}/${item.id}`, method === 'POST' ? data : { version: item.version, reason: '合成錯誤CSRF' }, { 'X-CSRF-Token': 'invalid' });
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'CSRF_INVALID');
  }
  for (const fields of [{ employeeId: id() }, { date: '2026-02-30' }, { startTime: '10:00', endTime: '09:00' }, { startTime: '09:00', endTime: '09:00' }, { startTime: '2026-10-09T09:00:00Z' }, { status: 'submitted' }, { balance: 12 }]) {
    assert.equal((await f.request(f.admin, 'POST', '/api/' + ENTITY, f.data(fields))).status, 422);
  }
  const history = await f.request(f.admin, 'GET', historyUrl(item)); assert.equal(history.body.total, 4); assert.equal(history.body.items[0].snapshot.status, 'pending');
  assert.deepEqual(f.state(), before);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', item.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(item.id), /immutable/);
  assert.deepEqual(f.state(), before);
});

test('approved leave revalidates scheduled and completed shift overlaps on POST/PATCH, preserves half-open boundaries and reciprocal leave conflicts', async t => {
  const f = await fixture(t), s = await scheduling(f);
  const pending = await f.create(ENTITY, f.data({ startTime: '09:30', endTime: '10:30' }));
  async function assertApprovalBlocked(item) {
    const before = f.state();
    const response = await f.request(f.admin, 'PATCH', `/api/${ENTITY}/${item.id}`, { version: item.version, status: 'approved' });
    assert.equal(response.status, 409); assert.equal(response.body.error.code, 'SHIFT_CONFLICT');
    assert.equal((await f.request(f.admin, 'GET', historyUrl(item))).body.total, 1); assert.deepEqual(f.state(), before);
  }
  await assertApprovalBlocked(pending);
  await s.approve();
  assert.equal((await f.request(f.admin, 'GET', `/api/shifts/${s.shift.id}`)).body.item.status, 'completed');
  await assertApprovalBlocked(pending);
  let before = f.state();
  const blockedPost = await f.request(f.admin, 'POST', '/api/' + ENTITY, f.data({ startTime: '09:30', endTime: '10:30', status: 'approved' }), { 'Idempotency-Key': 'synthetic-conflicting-approved-leave' });
  assert.equal(blockedPost.status, 409); assert.equal(blockedPost.body.error.code, 'SHIFT_CONFLICT'); assert.deepEqual(f.state(), before);
  await f.create(ENTITY, f.data({ startTime: '08:00', endTime: '09:00', status: 'approved' }));
  await f.create(ENTITY, f.data({ startTime: '10:00', endTime: '11:00', status: 'approved' }));
  const approved = await f.create(ENTITY, f.data({ startTime: '12:00', endTime: '13:00', status: 'approved' }));
  before = f.state();
  const changedTime = await f.request(f.admin, 'PATCH', `/api/${ENTITY}/${approved.id}`, { version: approved.version, startTime: '09:30', endTime: '10:30' });
  assert.equal(changedTime.status, 409); assert.equal(changedTime.body.error.code, 'SHIFT_CONFLICT');
  const blockedShift = await f.request(f.admin, 'POST', '/api/shifts', { ...s.shiftData, startTime: '12:30', endTime: '13:30' });
  assert.equal(blockedShift.status, 409); assert.equal(blockedShift.body.error.code, 'LEAVE_CONFLICT'); assert.deepEqual(f.state(), before);
  // Touching both approved leave endpoints is permitted by the original half-open rule.
  await f.create('shifts', { ...s.shiftData, startTime: '11:00', endTime: '12:00' });
  await f.create(ENTITY, f.data({ startTime: '12:30', endTime: '12:45', status: 'approved' })); // No new leave-vs-leave restriction.
  const laterPending = await f.create(ENTITY, f.data({ startTime: '14:00', endTime: '15:00' }));
  const laterShift = await f.create('shifts', { ...s.shiftData, startTime: '14:00', endTime: '15:00' }); // Pending does not block scheduling.
  await assertApprovalBlocked(laterPending);
  await f.patch('shifts', laterShift, { status: 'cancelled' });
  const laterApproved = await f.patch(ENTITY, laterPending, { status: 'approved' });
  assert.equal(laterApproved.version, 2); assert.equal(laterApproved.status, 'approved');
});

test('leave history reads preserve all eleven tables, approved billing snapshots, old five reports and existing service/shift locks', async t => {
  const f = await fixture(t), s = await scheduling(f), approved = await s.approve();
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 10000);
  let leave = await f.create(ENTITY, f.data({ startTime: '12:00', endTime: '13:00' })); leave = await f.patch(ENTITY, leave, { status: 'approved' }, f.clients.supervisor);
  const reports = {};
  for (const kind of ['cases', 'shifts', 'services', 'fees', 'payroll']) { const response = await f.request(f.admin, 'GET', `/api/reports/${kind}?month=2026-10`); assert.equal(response.status, 200); reports[kind] = response.body; }
  assert.equal(reports.fees.totals.amountCents, 30000); assert.equal(reports.payroll.totals.amountCents, 18800);
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999 }); await f.patch('service-items', s.service, { unitPriceCents: 88888 });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) assert.equal((await f.request(caller, 'GET', historyUrl(leave, query))).status, 200);
  assert.deepEqual((await f.request(f.admin, 'GET', `/api/service-records/${approved.id}`)).body.item, approved);
  for (const kind of Object.keys(reports)) assert.deepEqual((await f.request(f.admin, 'GET', `/api/reports/${kind}?month=2026-10`)).body, reports[kind]);
  assert.deepEqual((await f.request(f.admin, 'GET', historyUrl(approved, 'compare=previous', 'service-records'))).body.items[0].actor, actor(f.admin));
  const completed = (await f.request(f.admin, 'GET', `/api/shifts/${s.shift.id}`)).body.item;
  assert.deepEqual((await f.request(f.admin, 'GET', historyUrl(completed, 'compare=previous', 'shifts'))).body.items[0].actor, actor(f.admin));
  assert.deepEqual(f.state(), before);
  const lockedRecord = await f.request(f.admin, 'PATCH', `/api/service-records/${approved.id}`, { version: approved.version, note: '禁止修改核准' }); assert.equal(lockedRecord.status, 409); assert.equal(lockedRecord.body.error.code, 'RECORD_LOCKED');
  const lockedShift = await f.request(f.admin, 'PATCH', `/api/shifts/${completed.id}`, { version: completed.version, employeeId: f.employeeB.id }); assert.equal(lockedShift.status, 409); assert.equal(lockedShift.body.error.code, 'SHIFT_HAS_RECORD');
  assert.deepEqual(f.state(), before);
});
