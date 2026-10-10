import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, business } from '../src/server/model.mjs';
import { toCsv, csvCell } from '../src/server/reports.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const endpoints = ['/api/leave-report', '/api/leave-report/export', '/api/leave-report.csv'];
const range = { startDate: '2026-01-01', endDate: '2026-12-31' };
const url = (endpoint = endpoints[0], filters = {}) => endpoint + '?' + new URLSearchParams({ ...range, ...filters });
const keys = ['leaveId', 'version', 'date', 'employeeId', 'employeeNo', 'employee', 'startTime', 'endTime', 'type', 'reason', 'status', 'statusLabel'];
const columns = [['date', '請假日期'], ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'], ['startTime', '開始時間'], ['endTime', '結束時間'], ['type', '假別'], ['statusLabel', '請假狀態'], ['reason', '請假原因']].map(([key, label]) => ({ key, label }));
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extra = {}) {
    const response = await fetch(base + route, { method, headers: {
      Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra,
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, headers: response.headers,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const password = 'synthetic-leave-report-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成請假報表管理者', email: 'leave-report-admin@example.test', password, organizationName: '合成請假報表甲機構' });
  assert.equal(setup.status, 201);
  const client = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = client(setup), clients = { admin };
  async function create(entity, data, caller = admin, headers) {
    const result = await request(caller, 'POST', '/api/' + entity, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, changes, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...changes });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成 Alpha', employeeNo: 'TEST-ER-A', role: '合成照顧職務', qualification: '保存資格文字', regions: '臺北', phone: 'PRIVATE-PHONE', email: 'private@example.test', note: 'PRIVATE-NOTE', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成 Beta', employeeNo: 'TEST-ER-B', role: '合成督導職務', regions: ['臺南', '', '臺南'], hourlyRateCents: 26000 });
  const inactive = await create('employees', { name: '合成停用員工', employeeNo: 'TEST-ER-I', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@leave-report.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseItem = await create('cases', { name: '合成個案', caseNo: 'TEST-ER-C' });
  let sequence = 0;
  function imported(changes = {}, { version = 1, orgId = admin.org, recordId = id() } = {}) {
    // Explicit synthetic legacy imports in memory, with no rewrite of immutable history.
    const stamp = now(), data = { employeeId: employeeA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', type: '合成假別', reason: 'TEST-LEAVE-' + String(sequence++).padStart(5, '0'), status: 'pending', ...changes };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, orgId, 'leave-requests', JSON.stringify(data), version, stamp, stamp);
    return { ...data, id: recordId, orgId, version, createdAt: stamp, updatedAt: stamp };
  }
  const overwrite = (item, changes) => app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(item), ...changes }), item.id);
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => { const statement = app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid'); statement.setReadBigInts(true); return [table, statement.all()]; })),
    triggers: app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
  });
  const leavePayload = (changes = {}) => ({ employeeId: employeeA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', type: '合成假別', reason: '合成請假原因', ...changes });
  return { app, request, create, patch, admin, clients, employeeA, employeeB, inactive, caseItem, imported, overwrite, state, leavePayload };
}

test('leave reports enforce date-bearing strict query, exact defaults, full pagination rejection and readonly headers', async t => {
  const f = await fixture(t), before = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(null, 'GET', url(endpoint))).status, 401);
    const empty = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('cache-control'), 'no-store'); assert.equal(empty.headers.get('x-content-type-options'), 'nosniff');
    if (endpoint !== endpoints[2]) {
      assert.deepEqual(empty.body.filters, { ...range, q: '', employeeId: '', status: '' });
      assert.deepEqual(empty.body.selection, { employee: '全部可讀員工', status: '全部狀態' });
      assert.equal(empty.body.page, 1); assert.equal(empty.body.pageSize, endpoint === endpoints[0] ? 25 : 0);
      assert.deepEqual(empty.body.columns, columns); assert.deepEqual(empty.body.rows, []); assert.deepEqual(empty.body.totals, { count: 0 });
    }
    assert.equal((await f.request(f.admin, 'GET', endpoint)).status, 422);
    for (const extra of ['caseId=', 'supervisorId=', 'month=2026-10', 'format=csv', 'unknown=', 'q=&q=', 'employeeId=&employeeId=', 'status=&status=', 'startDate=2026-01-01', 'endDate=2026-12-31', 'status=active', 'status=__proto__']) assert.equal((await f.request(f.admin, 'GET', url(endpoint) + '&' + extra)).status, 422, extra);
    for (const dates of [{ startDate: '' }, { endDate: '' }, { startDate: '2026-02-30' }, { endDate: '2026-13-01' }, { startDate: '2026-1-01' }, { startDate: '2026-10-09', endDate: '2026-10-08' }, { startDate: '2024-01-01', endDate: '2025-01-01' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, dates))).status, 422);
    for (const dates of [{ startDate: '2024-01-01', endDate: '2024-12-31' }, { startDate: '2026-10-08', endDate: '2026-10-08' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, dates))).status, 200);
  }
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e0', 'page=01', 'page=', 'page=9007199254740992', 'pageSize=101', 'pageSize=0', 'pageSize=25.0', 'pageSize=', 'page=1&page=1']) assert.equal((await f.request(f.admin, 'GET', url() + '&' + query)).status, 422, query);
  for (const endpoint of endpoints.slice(1)) for (const key of ['page', 'pageSize']) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { [key]: '1' }))).status, 422);
  for (const pageSize of ['1', '100']) assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], { pageSize }))).status, 200);
  assert.deepEqual(f.state(), before);
});

test('four real sessions use original leave scope and references validate before filters or empty results', async t => {
  const f = await fixture(t), own = await f.create('leave-requests', f.leavePayload()), other = await f.create('leave-requests', f.leavePayload({ employeeId: f.employeeB.id })), inactive = await f.create('leave-requests', f.leavePayload({ employeeId: f.inactive.id }));
  const org = await f.create('organizations', { name: '合成外機構' }), foreignClient = { ...f.admin, org: org.id };
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN', employeeNo: 'FOREIGN' }, foreignClient);
  await f.create('leave-requests', f.leavePayload({ employeeId: foreignEmployee.id, reason: 'PRIVATE-FOREIGN-LEAVE' }), foreignClient);
  const before = f.state();
  assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/shifts')).body.total, 0);
  for (const caller of Object.values(f.clients)) for (const endpoint of endpoints) {
    const result = await f.request(caller, 'GET', url(endpoint)); assert.equal(result.status, 200);
    if (endpoint !== endpoints[2]) { assert.equal(result.body.total, caller === f.clients.caregiver ? 1 : 3); assert.deepEqual(new Set(result.body.rows.map(row => row.leaveId)), new Set((caller === f.clients.caregiver ? [own] : [own, other, inactive]).map(item => item.id))); }
    assert.ok(!JSON.stringify(result.body).includes('PRIVATE-FOREIGN'));
    for (const employeeId of [foreignEmployee.id, f.caseItem.id, id(), ...(caller === f.clients.caregiver ? [f.employeeB.id, f.inactive.id] : [])]) {
      const denied = await f.request(caller, 'GET', url(endpoint, { employeeId, q: 'no-match', status: 'rejected' })); assert.equal(denied.status, 404); assert.ok(!JSON.stringify(denied.body).includes(employeeId));
    }
  }
  assert.deepEqual(f.state(), before);
});

test('fresh authorization retains inactive and unlinked caregiver guards without blocking management access', async t => {
  const f = await fixture(t); await f.create('leave-requests', f.leavePayload());
  const inactive = await f.patch('employees', f.employeeA, { status: 'inactive' }); let before = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 403);
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', url(endpoint, { employeeId: inactive.id }))).status, 200);
  }
  assert.deepEqual(f.state(), before); await f.patch('employees', inactive, { status: 'active' });
  const org = await f.create('organizations', { name: '合成外機構' }), foreign = await f.create('employees', { name: '合成外員工', employeeNo: 'TEST-FOREIGN-LINK' }, { ...f.admin, org: org.id });
  for (const employeeId of [null, id(), f.caseItem.id, foreign.id]) {
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.caregiver.user.id); before = f.state();
    for (const endpoint of endpoints) { const result = await f.request(f.clients.caregiver, 'GET', url(endpoint)); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(f.employeeA.id, f.admin.org, f.clients.caregiver.user.id);
  const restored = await f.request(f.clients.caregiver, 'GET', url(endpoints[1])); assert.equal(restored.body.total, 1);
});

test('saved leaves with missing foreign or wrong-entity parents remain present without leaking current lookup data', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成外機構' });
  const foreign = await f.create('employees', { name: 'PRIVATE-FOREIGN-NAME', employeeNo: 'PRIVATE-FOREIGN-NO' }, { ...f.admin, org: org.id });
  const parentIds = [id(), foreign.id, f.caseItem.id], imported = parentIds.map(employeeId => f.imported({ employeeId, type: 'PARENT-GROUP' }));
  const malformed = f.imported({ employeeId: { secret: 'PRIVATE-PARENT' }, type: 'PARENT-GROUP' });
  f.overwrite(f.employeeA, { name: { secret: 'PRIVATE-NAME' }, employeeNo: ['PRIVATE-NO'] });
  const own = f.imported({ type: 'PARENT-GROUP', reason: { secret: 'PRIVATE-REASON' } }); const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) {
    const result = await f.request(caller, 'GET', url(endpoints[1], { q: 'PARENT-GROUP' })); assert.equal(result.status, 200); assert.equal(result.body.total, 5);
    for (const item of imported) { const row = result.body.rows.find(row => row.leaveId === item.id); assert.equal(row.employeeId, item.employeeId); assert.equal(row.employee, ''); assert.equal(row.employeeNo, ''); }
    assert.equal(result.body.rows.find(row => row.leaveId === malformed.id).employeeId, ''); assert.equal(result.body.rows.find(row => row.leaveId === own.id).reason, '');
    assert.ok(!JSON.stringify(result.body).includes('PRIVATE-')); const csv = await f.request(caller, 'GET', url(endpoints[2], { q: 'PARENT-GROUP' })); assert.equal(csv.body, toCsv(result.body));
    for (const employeeId of parentIds) assert.equal((await f.request(caller, 'GET', url(endpoints[1], { employeeId }))).status, 404);
  }
  const ownReport = await f.request(f.clients.caregiver, 'GET', url(endpoints[1])); assert.equal(ownReport.body.total, 1); assert.equal(ownReport.body.rows[0].leaveId, own.id);
  const selected = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: f.employeeA.id })); assert.equal(selected.body.selection.employee, '名稱未取得');
  for (const q of ['名稱未取得', '全部可讀員工', 'PRIVATE-FOREIGN', 'PRIVATE-NAME', 'PRIVATE-REASON']) assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q }))).body.total, 0);
  assert.deepEqual(f.state(), before);
  for (const name of [' \t\n ', '  合成保留姓名  ']) {
    f.overwrite(f.employeeA, { name }); const result = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: f.employeeA.id })); assert.equal(result.body.rows[0].employee, name); assert.equal(result.body.selection.employee, name.trim() ? name : '名稱未取得');
  }
});

test('forty leaves across four statuses paginate 25 plus 15, export all, and sort by date wall minute and code-unit ties', async t => {
  const f = await fixture(t), statuses = ['pending', 'approved', 'rejected', 'cancelled'];
  const items = Array.from({ length: 40 }, (_, n) => f.imported({ date: n < 20 ? '2026-09-30' : '2026-10-01', status: statuses[n % 4], reason: 'COHORT-' + n, startTime: String(8 + n % 10).padStart(2, '0') + ':00', endTime: '19:00' }));
  const before = f.state(), first = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COHORT-' })), second = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COHORT-', page: '2' })), full = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'COHORT-' }));
  assert.equal(first.body.rows.length, 25); assert.equal(second.body.rows.length, 15); assert.deepEqual([...first.body.rows, ...second.body.rows], full.body.rows);
  assert.deepEqual(new Set(full.body.rows.map(row => row.leaveId)), new Set(items.map(row => row.id)));
  for (const result of [first, second, full]) { assert.equal(result.body.total, 40); assert.deepEqual(result.body.totals, { count: 40 }); }
  const beyond = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COHORT-', page: '3' })); assert.deepEqual(beyond.body.rows, []); assert.equal(beyond.body.total, 40);
  for (const status of statuses) assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q: 'COHORT-', status }))).body.total, 10);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2], { q: 'COHORT-' }))).body, toCsv(full.body)); assert.deepEqual(f.state(), before);
  const ties = [
    f.imported({ reason: 'TIE', startTime: '2026-10-08T09:00:59+14:00', endTime: '2026-10-08T10:00:01+14:00' }, { recordId: 'tie-z' }),
    f.imported({ reason: 'TIE', startTime: '09:00' }, { recordId: 'tie-a' }),
    f.imported({ reason: 'TIE', startTime: '2026-10-08T09:00:00-12:00', endTime: '2026-10-08T10:00:59-12:00' }, { recordId: 'tie-m' }),
    f.imported({ reason: 'TIE', employeeId: f.employeeB.id }, { recordId: 'tie-0' }),
    f.imported({ reason: 'TIE', date: '2026-10-07' }, { recordId: 'tie-last-id' }),
  ];
  const sorted = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'TIE' })); assert.deepEqual(sorted.body.rows.map(row => row.leaveId), [ties[4], ties[1], ties[2], ties[0], ties[3]].map(row => row.id));
  for (const item of ties) { const row = sorted.body.rows.find(row => row.leaveId === item.id); assert.equal(row.startTime, item.startTime); assert.equal(row.endTime, item.endTime); }
});

test('q searches only individual permitted strings with AND semantics, raw echo and UTF-16 limit', async t => {
  const f = await fixture(t); f.overwrite(f.employeeA, { name: 'UniqueName', employeeNo: 'UNIQUE-NUMBER', phone: 'PRIVATE-PHONE', role: 'PRIVATE-ROLE', note: 'PRIVATE-NOTE' });
  const item = f.imported({ type: 'UniqueType', reason: '  UniqueReason  ', status: 'rejected', billingSnapshot: { secret: 'PRIVATE-BILLING' }, note: 'PRIVATE-LEAVE-NOTE' });
  const before = f.state();
  for (const q of ['uniquename', 'unique-number', 'UNIQUETYPE', '  UniqueReason  ', '已駁回']) {
    const result = await f.request(f.admin, 'GET', url(endpoints[1], { q, employeeId: f.employeeA.id, status: 'rejected' })); assert.equal(result.body.total, 1, q); assert.equal(result.body.filters.q, q);
  }
  for (const q of [' UniqueName', 'UniqueName ', 'UniqueNameUniqueType', 'UniqueType  UniqueReason', 'PRIVATE-', '09:00', '2026-10-08', item.id, f.employeeA.id, '名稱未取得']) assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q }))).body.total, 0, q);
  for (const filters of [{ status: 'approved' }, { employeeId: f.employeeB.id }]) assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q: 'Unique', ...filters }))).body.total, 0);
  for (const q of ['x'.repeat(200), '😀'.repeat(100)]) { const response = await f.request(f.admin, 'GET', url(endpoints[1], { q })); assert.equal(response.status, 200); assert.equal(response.body.filters.q, q); }
  for (const q of ['x'.repeat(201), '😀'.repeat(100) + 'x']) for (const endpoint of endpoints) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { q }))).status, 422);
  assert.deepEqual(f.state(), before);
});

test('all roles receive exactly twelve whitelisted row keys, eight columns and count-only totals', async t => {
  const f = await fixture(t), item = f.imported({ fileId: 'PRIVATE-FILE', billingSnapshot: { hourlyRateCents: 77777 }, extraFinance: 'PRIVATE-EXTRA', type: ['PRIVATE-TYPE'], reason: { secret: 'PRIVATE-REASON' } });
  f.app.db.prepare('UPDATE records SET created_at=?,updated_at=? WHERE id=?').run('INVALID-CREATION', 'INVALID-UPDATE', item.id); const before = f.state();
  for (const caller of Object.values(f.clients)) {
    const result = await f.request(caller, 'GET', url(endpoints[1])); assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['title', 'organization', 'filters', 'selection', 'generatedAt', 'columns', 'rows', 'totals', 'total', 'page', 'pageSize', 'note'].sort());
    assert.deepEqual(Object.keys(result.body.rows[0]), keys); assert.deepEqual(result.body.columns, columns); assert.deepEqual(result.body.totals, { count: 1 });
    assert.equal(result.body.rows[0].type, ''); assert.equal(result.body.rows[0].reason, ''); assert.equal(result.body.rows[0].employeeId, f.employeeA.id);
    for (const secret of ['PRIVATE-', 'hourlyRateCents', 'phone', 'email', 'billingSnapshot', 'createdAt', 'updatedAt', 'INVALID-CREATION', 'INVALID-UPDATE', 'serviceMinutes']) assert.ok(!JSON.stringify(result.body).includes(secret), secret);
  }
  assert.deepEqual(f.state(), before);
});

test('candidate date validation precedes date range while unrelated employee status or q filters exclude bad data', async t => {
  const f = await fixture(t); f.imported({ reason: 'GOOD-GROUP' }); const bad = f.imported({ employeeId: f.employeeB.id, status: 'rejected', reason: 'BAD-GROUP' });
  for (const date of [undefined, null, '', '2026-02-30', 'not-a-date', '2026-1-01', ['2026-10-08']]) {
    f.overwrite(bad, { date }); const before = f.state();
    for (const endpoint of endpoints) {
      const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 409, JSON.stringify(date)); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID'); assert.ok(!Object.hasOwn(result.body, 'rows'));
      for (const filters of [{ employeeId: f.employeeA.id }, { status: 'pending' }, { q: 'GOOD-GROUP' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filters))).status, 200);
      assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  f.overwrite(bad, { date: '2025-12-31', startTime: 'broken', status: 'unknown' }); f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(9007199254740992n, bad.id);
  for (const endpoint of endpoints) assert.equal((await f.request(f.admin, 'GET', url(endpoint))).status, 200);
});

test('all in-range matches validate times safe versions statuses and ids before pagination, including BigInt scope exclusions', async t => {
  const f = await fixture(t); for (let n = 0; n < 27; n++) f.imported({ reason: 'GOOD-GROUP' });
  const bad = f.imported({ employeeId: f.employeeB.id, reason: 'BAD-GROUP', status: 'rejected' });
  const variants = [
    { startTime: '9:00' }, { startTime: '24:00' }, { startTime: '09:60' }, { endTime: '09:00' }, { endTime: '08:59' }, { startTime: null },
    { startTime: '2026-10-07T09:00:00Z' }, { endTime: '2026-10-09T10:00:00Z' }, { startTime: '2026-10-08T09:00:00+99:00' },
    { status: undefined }, { status: null }, { status: '' }, { status: 'unknown' }, { status: '__proto__' }, { status: ['pending'] },
  ];
  for (const changes of variants) {
    f.overwrite(bad, changes); const before = f.state();
    for (const endpoint of endpoints) {
      const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 409, JSON.stringify(changes)); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID');
      for (const filter of [{ q: 'GOOD-GROUP' }, { employeeId: f.employeeA.id }, { status: 'pending' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filter))).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  f.overwrite(bad, {});
  for (const version of [0, -1, 1.5, 'invalid', 9007199254740992n, -9007199254740992n]) {
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, bad.id); const before = f.state();
    for (const endpoint of endpoints) {
      assert.equal((await f.request(f.admin, 'GET', url(endpoint))).status, 409);
      for (const filter of [{ q: 'GOOD-GROUP' }, { employeeId: f.employeeA.id }, { status: 'pending' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filter))).status, 200);
      assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, bad.id);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q: 'BAD-GROUP' }))).body.rows[0].version, Number.MAX_SAFE_INTEGER);
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(9007199254740992n, f.employeeB.id);
  const employeeVersion = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: f.employeeB.id })); assert.equal(employeeVersion.status, 200); assert.equal(employeeVersion.body.rows[0].employee, f.employeeB.name);
  f.imported({ reason: 'INVALID-ID' }, { recordId: '' });
  for (const endpoint of endpoints) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { q: 'INVALID-ID' }))).status, 409);
});

test('real A to B to A reassignment and status edits stay fresh without weakening idempotency CAS CSRF or role guards', async t => {
  const f = await fixture(t), payload = f.leavePayload(), created = await f.create('leave-requests', payload, f.admin, { 'Idempotency-Key': 'leave-report-create' });
  const beforeReplay = f.state(), replay = await f.request(f.admin, 'POST', '/api/leave-requests', payload, { 'Idempotency-Key': 'leave-report-create' }); assert.deepEqual(replay.body.item, created); assert.deepEqual(f.state(), beforeReplay);
  let current = await f.patch('leave-requests', created, { employeeId: f.employeeB.id, status: 'approved', reason: '最新B原因' }, f.clients.supervisor);
  assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoints[1]))).body.total, 0);
  current = await f.patch('leave-requests', current, { employeeId: f.employeeA.id, status: 'rejected', reason: '最新A原因' });
  const restored = await f.request(f.clients.caregiver, 'GET', url(endpoints[1])); assert.equal(restored.body.rows[0].version, 3); assert.equal(restored.body.rows[0].reason, '最新A原因');
  current = await f.patch('leave-requests', current, { status: 'cancelled' }); const before = f.state();
  assert.equal((await f.request(f.admin, 'PATCH', '/api/leave-requests/' + created.id, { version: 1, reason: '過時' })).status, 409);
  assert.equal((await f.request(f.admin, 'PATCH', '/api/leave-requests/' + created.id, { version: 4, reason: 'CSRF' }, { 'X-CSRF-Token': 'é'.repeat(64) })).status, 403);
  for (const caller of [f.clients.finance, f.clients.caregiver]) {
    assert.equal((await f.request(caller, 'PATCH', '/api/leave-requests/' + created.id, { version: 4, reason: '拒絕' })).status, 403);
    assert.equal((await f.request(caller, 'POST', '/api/leave-requests', payload)).status, 403);
  }
  assert.equal((await f.request(f.admin, 'POST', '/api/leave-requests', { ...payload, reason: '不同' }, { 'Idempotency-Key': 'leave-report-create' })).status, 409);
  for (const endpoint of endpoints) { const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 200); if (endpoint !== endpoints[2]) { assert.equal(result.body.rows[0].version, 4); assert.equal(result.body.rows[0].statusLabel, '已取消'); } else assert.ok(result.body.includes('最新A原因')); }
  assert.deepEqual(f.state(), before);
});

test('CSV contains only eight quoted columns with BOM and formula defenses, preserving exact raw ISO and free text', async t => {
  const f = await fixture(t), values = ['=1+2', '+SUM(1)', '-2', '@SUM(1)', '\t=1', '\r=1', '\n=1', ' \u0001=1', '中文,"引號"\n第二行'];
  for (const value of values) f.imported({ type: value, reason: value, startTime: '2026-10-08T09:00:59+08:00', endTime: '2026-10-08T10:00:01+08:00' });
  const before = f.state(), full = await f.request(f.admin, 'GET', url(endpoints[1])), csv = await f.request(f.admin, 'GET', url(endpoints[2]));
  assert.equal(csv.status, 200); assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="leave-report.csv"'); assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8'); assert.deepEqual(csv.bytes.subarray(0, 3), Buffer.from([239, 187, 191])); assert.equal(csv.body, toCsv(full.body));
  assert.ok(csv.body.endsWith('\r\n')); assert.equal(csv.body.split('\r\n')[0], '\uFEFF' + columns.map(column => csvCell(column.label)).join(','));
  for (const value of values) assert.ok(csv.body.includes(csvCell(value)), value);
  assert.ok(csv.body.includes('2026-10-08T09:00:59+08:00')); assert.ok(!csv.body.includes(f.employeeA.id)); assert.deepEqual(f.state(), before);
});

test('full exports allow exactly 1000 rows and exactly 2 MiB UTF-8, rejecting one extra without truncating pages', async t => {
  const f = await fixture(t); for (let n = 0; n < 1000; n++) f.imported({ reason: 'COUNT-GROUP' });
  let before = f.state(); const full = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'COUNT-GROUP' })); assert.equal(full.status, 200); assert.equal(full.body.rows.length, 1000);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2], { q: 'COUNT-GROUP' }))).body, toCsv(full.body)); assert.deepEqual(f.state(), before);
  f.imported({ reason: 'COUNT-GROUP' }); before = f.state();
  for (const endpoint of endpoints.slice(1)) { const response = await f.request(f.admin, 'GET', url(endpoint, { q: 'COUNT-GROUP' })); assert.equal(response.status, 413); assert.equal(response.body.error.code, 'REPORT_TOO_LARGE'); }
  const page = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COUNT-GROUP', page: '11', pageSize: '100' })); assert.equal(page.body.total, 1001); assert.equal(page.body.rows.length, 1); assert.deepEqual(f.state(), before);
  const items = Array.from({ length: 80 }, () => f.imported({ type: 'BYTE-GROUP', reason: '' }));
  const initial = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'BYTE-GROUP' })); assert.equal(initial.status, 200); let remaining = 2097152 - initial.bytes.length, last;
  for (const item of items) {
    const bytes = Math.min(29997, remaining), reason = '字'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3);
    assert.ok(reason.length <= 10000); f.overwrite(item, { reason }); remaining -= Buffer.byteLength(reason); last = { item, reason }; if (!remaining) break;
  }
  assert.equal(remaining, 0); before = f.state(); const exact = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'BYTE-GROUP' })); assert.equal(exact.status, 200); assert.equal(exact.bytes.length, 2097152);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2], { q: 'BYTE-GROUP' }))).status, 200); assert.deepEqual(f.state(), before);
  f.overwrite(last.item, { reason: last.reason + 'x' }); before = f.state();
  for (const endpoint of endpoints.slice(1)) { const response = await f.request(f.admin, 'GET', url(endpoint, { q: 'BYTE-GROUP' })); assert.equal(response.status, 413); assert.equal(response.body.error.code, 'REPORT_TOO_LARGE'); }
  const limited = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'BYTE-GROUP' })); assert.equal(limited.status, 200); assert.equal(limited.body.total, 80); assert.equal(limited.body.rows.length, 25); assert.deepEqual(f.state(), before);
});

test('leave reports preserve original half-open conflict and service locks, eleven tables, BLOBs, billing and twenty-two previous exits', async t => {
  const f = await fixture(t), service = await f.create('service-items', { code: 'TEST-ER-SERVICE', name: '合成服務', unitPriceCents: 12345, minutes: 60 });
  const plan = await f.create('care-plans', { caseId: f.caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 30 }] });
  const shift = await f.create('shifts', { caseId: f.caseItem.id, employeeId: f.employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: f.caseItem.id, employeeId: f.employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services: [{ serviceItemId: service.id, quantity: 3 }], status: 'submitted' }, f.clients.caregiver);
  const approved = await f.request(f.admin, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成核阅' }); assert.equal(approved.status, 200);
  const snapshot = (await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item;
  const cert = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成證照', issuedOn: '2026-01-01' });
  const caseFile = await f.request(f.admin, 'POST', '/api/case-attachments/upload', { caseId: f.caseItem.id, title: '合成個案PDF', ...filePayload(PDF_BYTES, 'synthetic.pdf', 'application/pdf') }); assert.equal(caseFile.status, 201);
  const certFile = await f.request(f.admin, 'POST', '/api/certification-attachments/upload', { certificationId: cert.id, title: '合成證照PNG', ...filePayload(PNG_BYTES, 'synthetic.png', 'image/png') }); assert.equal(certFile.status, 201);
  const fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  assert.equal(fees.totals.amountCents, 37035); assert.equal(payroll.totals.amountCents, 18800);
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999, name: '合成最新員工姓名' }); await f.patch('service-items', service, { unitPriceCents: 99999 });
  const leave = await f.create('leave-requests', f.leavePayload({ startTime: '2026-10-08T09:59:59+08:00', endTime: '10:30', reason: '合成最新請假' }));
  const conflictBefore = f.state();
  const conflict = await f.request(f.admin, 'PATCH', '/api/leave-requests/' + leave.id, { version: 1, status: 'approved' }); assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'SHIFT_CONFLICT');
  const locked = await f.request(f.admin, 'PATCH', '/api/shifts/' + shift.id, { version: 2, employeeId: f.employeeB.id }); assert.equal(locked.status, 409); assert.equal(locked.body.error.code, 'SHIFT_HAS_RECORD'); assert.deepEqual(f.state(), conflictBefore);
  const boundary = await f.patch('leave-requests', leave, { startTime: '10:00', endTime: '11:00', status: 'approved' });
  const shiftPayload = { caseId: f.caseItem.id, employeeId: f.employeeA.id, carePlanId: plan.id, date: shift.date, startTime: '10:30', endTime: '11:30', services: [{ serviceItemId: service.id, quantity: 1 }] };
  const leaveConflictBefore = f.state(), leaveConflict = await f.request(f.admin, 'POST', '/api/shifts', shiftPayload); assert.equal(leaveConflict.status, 409); assert.equal(leaveConflict.body.error.code, 'LEAVE_CONFLICT'); assert.deepEqual(f.state(), leaveConflictBefore);
  await f.create('shifts', { ...shiftPayload, startTime: '11:00', endTime: '12:00' });
  assert.equal(boundary.version, 2);
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`);
  for (const suffix of ['', '/export', '.csv']) routes.push('/api/employee-report' + suffix);
  assert.equal(routes.length, 22);
  const readReports = async () => {
    const results = {};
    for (const route of routes) { const result = await f.request(f.admin, 'GET', route); assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); results[route] = typeof result.body === 'string' ? result.body : { ...result.body, generatedAt: '' }; }
    return results;
  };
  const before = f.state(), oldReports = await readReports(); assert.equal(Object.keys(before.tables).length, 11); assert.equal(before.triggers.length, 6);
  assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  for (const caller of Object.values(f.clients)) for (const endpoint of endpoints) {
    assert.equal((await f.request(caller, 'GET', url(endpoint))).status, 200);
    assert.equal((await f.request(caller, 'GET', url(endpoint, { employeeId: f.employeeA.id, q: '最新', status: 'approved' }))).status, 200);
  }
  assert.deepEqual(await readReports(), oldReports);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item, snapshot);
  for (const [entity, result, bytes] of [['case-attachments', caseFile, PDF_BYTES], ['certification-attachments', certFile, PNG_BYTES]]) {
    const download = await f.request(f.admin, 'GET', `/api/${entity}/${result.body.item.id}/download`); assert.equal(download.status, 200); assert.deepEqual(download.bytes, bytes);
  }
  assert.deepEqual(f.state(), before);
});
