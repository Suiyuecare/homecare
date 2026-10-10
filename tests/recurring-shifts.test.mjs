import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { id } from '../src/server/model.mjs';

const PREVIEW = '/api/recurring-shifts/preview';
const COMMIT = '/api/recurring-shifts/commit';
const key = value => ({ 'Idempotency-Key': value });

async function fixture(t, dbPath = ':memory:') {
  let app = createApp({ dbPath, port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, url, data, headers = {}) {
    const response = await fetch(base + url, {
      method,
      headers: {
        Origin: base,
        ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成週期管理員', email: 'recurring-admin@example.test', password: 'recurring-test-password', organizationName: '合成週期機構甲' });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(entity, data, client = admin) {
    const result = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, client = admin) {
    const result = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成居服員甲', employeeNo: 'TEST-RECURRING-A', hourlyRateCents: 20000 });
  const otherEmployee = await create('employees', { name: '合成居服員乙', employeeNo: 'TEST-RECURRING-B' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = role + '@recurring.example.test';
    await create('users', { name: '合成' + role, email, password: 'recurring-test-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password: 'recurring-test-password' });
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const service = await create('service-items', { code: 'TEST-RECURRING', name: '合成服務', minutes: 60, unitPriceCents: 10000 });
  const caseA = await create('cases', { name: '合成週期個案', caseNo: 'TEST-RECURRING-A' });
  const caseB = await create('cases', { name: '其他合成個案', caseNo: 'TEST-RECURRING-B' });
  const planData = caseId => ({ caseId, validFrom: '2020-01-01', validTo: '2030-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 100 }] });
  const plan = await create('care-plans', planData(caseA.id)), otherPlan = await create('care-plans', planData(caseB.id));
  const definition = (overrides = {}) => ({ caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, startDate: '2026-10-05', endDate: '2026-10-09', intervalWeeks: 1, weekdays: [1, 3, 5], startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 2 }], note: ' 合成交班備註 ', ...overrides });
  const shiftData = (overrides = {}) => ({ caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-05', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 2 }], ...overrides });
  function counts() { return Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n])); }
  return { get app() { return app; }, request, create, patch, admin, clients, employee, otherEmployee, service, caseA, caseB, plan, otherPlan, definition, shiftData, counts, async reopen() { await app.close(); app = createApp({ dbPath, port: 0 }); base = await app.listen(); } };
}

test('recurring previews anchor weeks to Monday and expand inclusive calendar dates across months, years and leap days without writes', async t => {
  const f = await fixture(t);
  const cases = [
    [{ startDate: '2026-10-07', endDate: '2026-10-26', intervalWeeks: 2, weekdays: [7, 1, 3] }, ['2026-10-07', '2026-10-11', '2026-10-19', '2026-10-21', '2026-10-25']],
    [{ startDate: '2026-12-30', endDate: '2027-01-12', intervalWeeks: 2, weekdays: [1, 3] }, ['2026-12-30', '2027-01-11']],
    [{ startDate: '2026-12-30', endDate: '2027-01-31', intervalWeeks: 4, weekdays: [1, 3, 7] }, ['2026-12-30', '2027-01-03', '2027-01-25', '2027-01-27', '2027-01-31']],
    [{ startDate: '2024-02-26', endDate: '2024-03-04', intervalWeeks: 1, weekdays: [4, 1] }, ['2024-02-26', '2024-02-29', '2024-03-04']],
    [{ startDate: '2026-10-11', endDate: '2026-10-19', intervalWeeks: 2, weekdays: [1, 7] }, ['2026-10-11', '2026-10-19']],
    [{ startDate: '2026-10-05', endDate: '2026-10-05', intervalWeeks: undefined, weekdays: [1] }, ['2026-10-05']],
  ];
  const before = f.counts(), changes = f.app.db.prepare('SELECT total_changes() AS n').get().n;
  for (const [overrides, expected] of cases) {
    const payload = f.definition(overrides);
    const result = await f.request(f.clients.supervisor, 'POST', PREVIEW, payload, key('ignored-preview-key'));
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result.body.items.map(item => item.date), expected);
    assert.equal(result.body.total, expected.length); assert.equal(result.body.readyCount, expected.length); assert.equal(result.body.conflictCount, 0); assert.equal(result.body.canCommit, true);
    assert.deepEqual(result.body.definition.weekdays, [...overrides.weekdays].sort((a, b) => a - b));
    assert.equal(result.body.definition.intervalWeeks, overrides.intervalWeeks || 1); assert.equal(result.body.definition.note, '合成交班備註');
    assert.deepEqual(result.body.definition.services, payload.services);
    assert.ok(result.body.items.every(item => item.status === 'ready' && item.conflicts.length === 0 && item.startTime === '09:00' && item.endTime === '10:00'));
  }
  const maximum = await f.request(f.admin, 'POST', PREVIEW, f.definition({ startDate: '2026-01-01', endDate: '2026-04-03', weekdays: [1, 2, 3, 4, 5, 6, 7] }));
  assert.equal(maximum.status, 200); assert.equal(maximum.body.total, 93);
  assert.equal(maximum.body.items[0].date, '2026-01-01'); assert.equal(maximum.body.items.at(-1).date, '2026-04-03');
  assert.deepEqual(f.counts(), before); assert.equal(f.app.db.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('recurring definitions reject invalid dates, weekdays, intervals, clocks, service shapes and client-supplied outcomes', async t => {
  const f = await fixture(t), before = f.counts();
  const invalid = [
    { startDate: '2026-02-30' }, { endDate: '2025-02-29' }, { startDate: '2026-1-01' }, { startDate: '2026-10-05T00:00:00Z' },
    { startDate: '2026-01-01', endDate: '2026-04-04' }, { endDate: '2026-10-04' }, { startDate: '', endDate: '' },
    { weekdays: [] }, { weekdays: [1, 1] }, { weekdays: [0] }, { weekdays: [8] }, { weekdays: ['1'] }, { weekdays: [1.5] }, { weekdays: null },
    { weekdays: [2], startDate: '2026-10-05', endDate: '2026-10-05' },
    { intervalWeeks: 0 }, { intervalWeeks: 5 }, { intervalWeeks: 1.5 }, { intervalWeeks: '2' }, { intervalWeeks: null },
    { startTime: '9:00' }, { startTime: '24:00' }, { endTime: '10:60' }, { endTime: '09:00' }, { startTime: '23:00', endTime: '01:00' }, { startTime: '2026-10-05T09:00:00Z' },
    { caseId: 1 }, { caseId: '' }, { employeeId: null }, { carePlanId: '  ' }, { note: 'x'.repeat(10001) }, { note: null },
    { services: [] }, { services: null }, { services: [{ serviceItemId: f.service.id, quantity: 0 }] },
    { services: [{ serviceItemId: f.service.id, quantity: 1.5 }] }, { services: [{ serviceItemId: f.service.id, quantity: 10001 }] },
    { services: [{ serviceItemId: f.service.id, quantity: '1' }] }, { services: [{ serviceItemId: f.service.id, quantity: 1, extra: true }] },
    { services: [{ serviceItemId: f.service.id, quantity: 1 }, { serviceItemId: f.service.id, quantity: 2 }] },
    { status: 'cancelled' }, { dates: ['2026-10-05'] }, { items: [] }, { ready: true }, { batchId: 'forged' },
  ];
  for (const overrides of invalid) {
    const result = await f.request(f.admin, 'POST', PREVIEW, f.definition(overrides));
    assert.equal(result.status, 422, JSON.stringify(overrides));
  }
  const tooLarge = await f.request(f.admin, 'POST', PREVIEW, f.definition({ note: 'x'.repeat(131072) }));
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, 'BODY_TOO_LARGE');
  assert.deepEqual(f.counts(), before);
});

test('recurring endpoints reject read-only roles before payload parsing, require CSRF and a commit key, and scope foreign references', async t => {
  const f = await fixture(t);
  const org = await f.create('organizations', { name: '合成週期機構乙' }), foreignClient = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: '跨機構合成個案', caseNo: 'TEST-FOREIGN' }, foreignClient);
  const before = f.counts();
  for (const client of [f.clients.caregiver, f.clients.finance]) for (const url of [PREVIEW, COMMIT]) {
    assert.equal((await f.request(client, 'POST', url, {})).status, 403);
  }
  for (const url of [PREVIEW, COMMIT]) assert.equal((await f.request(f.admin, 'POST', url, f.definition(), { ...key('csrf-check'), 'X-CSRF-Token': '' })).status, 403);
  const absent = await f.request(f.admin, 'POST', COMMIT, f.definition());
  assert.equal(absent.status, 422); assert.equal(absent.body.error.code, 'IDEMPOTENCY_REQUIRED');
  assert.equal((await f.request(f.admin, 'POST', COMMIT, f.definition(), key('a'.repeat(129)))).body.error.code, 'IDEMPOTENCY_KEY');
  assert.equal((await f.request(f.admin, 'POST', PREVIEW, f.definition(), key('a'.repeat(129)))).status, 200, 'preview ignores rather than persists or validates a mutation key');
  for (const overrides of [{ caseId: foreignCase.id }, { employeeId: id() }, { carePlanId: id() }]) {
    const payload = f.definition(overrides);
    const preview = await f.request(f.admin, 'POST', PREVIEW, payload);
    assert.equal(preview.status, 200); assert.equal(preview.body.canCommit, false); assert.equal(preview.body.conflictCount, 3);
    assert.ok(preview.body.items.every(item => item.conflicts[0].code === 'INVALID_REFERENCE'));
    const commit = await f.request(f.admin, 'POST', COMMIT, payload, key('foreign-' + Object.keys(overrides)[0]));
    assert.equal(commit.status, 409); assert.equal(commit.body.error.code, 'BATCH_CONFLICT'); assert.deepEqual(commit.body.error.details.preview, preview.body);
  }
  assert.deepEqual(f.counts(), before);
});

test('recurring preview reuses employee/case overlap and approved leave rules without exposing existing records', async t => {
  const f = await fixture(t);
  const caseOverlap = await f.create('shifts', f.shiftData({ employeeId: f.otherEmployee.id, note: 'PRIVATE-CASE-OVERLAP' }));
  const workerOverlap = await f.create('shifts', f.shiftData({ caseId: f.caseB.id, carePlanId: f.otherPlan.id, date: '2026-10-07', note: 'PRIVATE-EMPLOYEE-OVERLAP' }));
  const leave = await f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-09', startTime: '09:30', endTime: '10:30', type: '合成請假', reason: 'PRIVATE-LEAVE', status: 'approved' });
  const before = f.counts(), changes = f.app.db.prepare('SELECT total_changes() AS n').get().n;
  const preview = await f.request(f.admin, 'POST', PREVIEW, f.definition());
  assert.equal(preview.body.readyCount, 0); assert.equal(preview.body.conflictCount, 3); assert.equal(preview.body.canCommit, false);
  assert.deepEqual(preview.body.items.map(item => item.conflicts[0].code), ['SHIFT_CONFLICT', 'SHIFT_CONFLICT', 'LEAVE_CONFLICT']);
  for (const secret of [caseOverlap.id, workerOverlap.id, leave.id, 'PRIVATE-', f.otherEmployee.id, f.caseB.id]) assert.ok(!JSON.stringify(preview.body.items).includes(secret));
  assert.ok(preview.body.items.every(item => item.conflicts.length === 1));
  assert.deepEqual(f.counts(), before); assert.equal(f.app.db.prepare('SELECT total_changes() AS n').get().n, changes);
  await f.create('shifts', f.shiftData({ date: '2026-10-12', status: 'cancelled' }));
  await f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-12', startTime: '09:00', endTime: '10:00', type: '合成待審', status: 'pending' });
  assert.equal((await f.request(f.admin, 'POST', PREVIEW, f.definition({ startDate: '2026-10-12', endDate: '2026-10-12', weekdays: [1] }))).body.canCommit, true);
});

test('recurring commit revalidates every date after new conflicts or assignment/plan/service state changes and writes no partial batch', async t => {
  const scenarios = [
    ['new shift', 'SHIFT_CONFLICT', f => f.create('shifts', f.shiftData({ date: '2026-10-07' }))],
    ['approved leave', 'LEAVE_CONFLICT', f => f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-07', startTime: '09:30', endTime: '10:30', type: '合成', status: 'approved' })],
    ['inactive case', 'INACTIVE_ASSIGNMENT', f => f.patch('cases', f.caseA, { status: 'paused' })],
    ['inactive employee', 'INACTIVE_ASSIGNMENT', f => f.patch('employees', f.employee, { status: 'inactive' })],
    ['inactive service', 'INACTIVE_SERVICE', f => f.patch('service-items', f.service, { status: 'inactive' })],
    ['service date', 'INACTIVE_SERVICE', f => f.patch('service-items', f.service, { validTo: '2026-10-06' })],
    ['ended plan', 'INVALID_PLAN', f => f.patch('care-plans', f.plan, { status: 'ended' })],
    ['plan date', 'INVALID_PLAN', f => f.patch('care-plans', f.plan, { validTo: '2026-10-06' })],
    ['plan services', 'PLAN_SERVICE', async f => {
      const other = await f.create('service-items', { code: 'TEST-CHANGED', name: '合成其他服務', minutes: 30, unitPriceCents: 5000 });
      return f.patch('care-plans', f.plan, { services: [{ serviceItemId: other.id, quantity: 1 }] });
    }],
  ];
  for (const [name, code, change] of scenarios) await t.test(name, async child => {
    const f = await fixture(child), payload = f.definition();
    assert.equal((await f.request(f.admin, 'POST', PREVIEW, payload)).body.canCommit, true);
    await change(f);
    const before = f.counts(), changes = f.app.db.prepare('SELECT total_changes() AS n').get().n;
    const result = await f.request(f.admin, 'POST', COMMIT, payload, key('race-check'));
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'BATCH_CONFLICT');
    assert.ok(result.body.error.details.preview.items.some(item => item.conflicts[0]?.code === code));
    assert.equal(result.body.error.details.preview.canCommit, false);
    assert.deepEqual(f.counts(), before); assert.equal(f.app.db.prepare('SELECT total_changes() AS n').get().n, changes);
  });
});

test('recurring success creates scheduled version-one shifts and exact audit batch trace; same-key retries precede conflict checks', async t => {
  const f = await fixture(t), payload = f.definition();
  const parents = [f.caseA, f.employee, f.plan].map(item => f.app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id));
  const before = f.counts();
  const committed = await f.request(f.clients.supervisor, 'POST', COMMIT, payload, key('recurring-success'));
  assert.equal(committed.status, 201); assert.equal(committed.body.total, 3); assert.match(committed.body.batchId, /^[a-f0-9-]+$/);
  assert.deepEqual(committed.body.items.map(item => item.date), ['2026-10-05', '2026-10-07', '2026-10-09']);
  for (const item of committed.body.items) {
    assert.equal(item.version, 1); assert.equal(item.status, 'scheduled'); assert.equal(item.note, '合成交班備註'); assert.deepEqual(item.services, payload.services);
    assert.equal(item.orgId, f.admin.org); assert.equal(item.caseId, payload.caseId); assert.equal(item.employeeId, payload.employeeId); assert.equal(item.carePlanId, payload.carePlanId);
    assert.ok(!Object.hasOwn(item, 'batchId')); assert.ok(!Object.hasOwn(item, 'billingSnapshot'));
    const history = await f.request(f.clients.caregiver, 'GET', '/api/shifts/' + item.id + '/history');
    assert.equal(history.body.total, 1); assert.deepEqual(history.body.items[0].snapshot, item);
    const event = f.app.db.prepare("SELECT * FROM audit WHERE record_id=? AND action='record.create'").get(item.id), detail = JSON.parse(event.detail);
    assert.equal(event.user_id, f.clients.supervisor.user.id); assert.equal(event.org_id, f.admin.org);
    assert.equal(detail.version, 1); assert.equal(detail.operation, 'recurring-shifts'); assert.equal(detail.batchId, committed.body.batchId);
  }
  const after = f.counts();
  assert.equal(after.records - before.records, 3); assert.equal(after.record_versions - before.record_versions, 3); assert.equal(after.audit - before.audit, 3); assert.equal(after.idempotency - before.idempotency, 1);
  assert.equal((await f.request(f.admin, 'POST', PREVIEW, payload)).body.canCommit, false);
  const retry = await f.request(f.clients.supervisor, 'POST', COMMIT, payload, key('recurring-success'));
  assert.equal(retry.status, 201); assert.deepEqual(retry.body, committed.body); assert.deepEqual(f.counts(), after);
  const different = await f.request(f.clients.supervisor, 'POST', COMMIT, { ...payload, note: 'different' }, key('recurring-success'));
  assert.equal(different.status, 409); assert.equal(different.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual([f.caseA, f.employee, f.plan].map(item => f.app.db.prepare('SELECT * FROM records WHERE id=?').get(item.id)), parents);
});

test('a forced second shift insert failure rolls back the entire batch and permits retry with the same key', async t => {
  const f = await fixture(t), payload = f.definition(), headers = key('rollback-batch');
  f.app.db.exec("CREATE TRIGGER test_reject_second_shift BEFORE INSERT ON records WHEN NEW.entity='shifts' AND json_extract(NEW.data,'$.date')='2026-10-07' BEGIN SELECT RAISE(ABORT,'Synthetic second shift failure'); END;");
  const before = f.counts();
  const result = await f.request(f.admin, 'POST', COMMIT, payload, headers);
  assert.equal(result.status, 500); assert.equal(result.body.error.message, '系統錯誤，請稍後再試'); assert.ok(!result.body.error.details);
  assert.deepEqual(f.counts(), before); assert.equal((await f.request(f.admin, 'GET', '/api/shifts')).body.total, 0);
  f.app.db.exec('DROP TRIGGER test_reject_second_shift');
  const retry = await f.request(f.admin, 'POST', COMMIT, payload, headers);
  assert.equal(retry.status, 201); assert.equal(retry.body.total, 3);
});

test('recurring batches never modify approved billing snapshots or source records', async t => {
  const f = await fixture(t);
  const shift = await f.create('shifts', f.shiftData({ date: '2026-10-01' }));
  const record = await f.create('service-records', { shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date, actualStart: '09:00', actualEnd: '10:00', services: shift.services, status: 'submitted' });
  const approved = await f.request(f.admin, 'POST', '/api/service-records/' + record.id + '/review', { version: 1, decision: 'approved' });
  assert.equal(approved.status, 200);
  const saved = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(record.id);
  const history = f.app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(record.id);
  const batch = await f.request(f.admin, 'POST', COMMIT, f.definition(), key('billing-preserved'));
  assert.equal(batch.status, 201);
  assert.deepEqual(f.app.db.prepare('SELECT * FROM records WHERE id=?').get(record.id), saved);
  assert.deepEqual(f.app.db.prepare('SELECT * FROM record_versions WHERE record_id=? ORDER BY version').all(record.id), history);
  assert.deepEqual(JSON.parse(saved.data).billingSnapshot, approved.body.item.billingSnapshot);
});

test('recurring batches and successful idempotency responses survive reopening a temporary database', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'suiyue-recurring-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, path.join(directory, 'test.sqlite')), payload = f.definition(), headers = key('persisted-batch');
  const initial = await f.request(f.admin, 'POST', COMMIT, payload, headers);
  assert.equal(initial.status, 201);
  const before = f.counts();
  await f.reopen();
  assert.deepEqual(f.counts(), before);
  const retry = await f.request(f.admin, 'POST', COMMIT, payload, headers);
  assert.equal(retry.status, 201); assert.deepEqual(retry.body, initial.body); assert.deepEqual(f.counts(), before);
});
