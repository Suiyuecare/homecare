import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id } from '../src/server/model.mjs';
import { shiftBatchDefinition, guardShiftBatchAccess, shiftBatchQuery, previewShiftBatch, commitShiftBatch } from '../src/server/shift-batches.mjs';

const route = action => '/api/shift-batches/' + action;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, payload, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const password = 'synthetic-shift-batch-password', setup = await request(null, 'POST', '/api/setup', { name: '合成批次管理員', email: 'shift-batch-admin@example.test', password, organizationName: '合成批次機構甲' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user }, clients = { admin };
  const create = async (entity, data, client = admin) => { const result = await request(client, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const patch = async (entity, item, data, client = admin) => { const result = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item; };
  const employeeA = await create('employees', { name: '合成原居服員甲', employeeNo: 'SB-A' }), employeeB = await create('employees', { name: '合成改派居服員乙', employeeNo: 'SB-B' }), employeeC = await create('employees', { name: '合成其他居服員丙', employeeNo: 'SB-C' }), inactive = await create('employees', { name: '合成停用員工', employeeNo: 'SB-INACTIVE', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = `shift-batch-${role}@example.test`; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseA = await create('cases', { name: '合成批次個案甲', caseNo: 'SB-CA' }), caseB = await create('cases', { name: '合成批次個案乙', caseNo: 'SB-CB' }), service = await create('service-items', { code: 'SB-SERVICE', name: '合成服務', minutes: 60, unitPriceCents: 12345 }), services = [{ serviceItemId: service.id, quantity: 2 }];
  const plan = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services });
  const planA = await create('care-plans', plan(caseA.id)), planB = await create('care-plans', plan(caseB.id));
  const shiftData = overrides => ({ caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-10', startTime: '09:00', endTime: '10:00', services, note: ' 原交班\r\n末行 ', ...overrides });
  const first = await create('shifts', shiftData()), second = await create('shifts', shiftData({ startTime: '10:00', endTime: '11:00' }));
  const organization = await create('organizations', { name: '合成批次機構乙' }), foreign = { ...admin, org: organization.id }, foreignEmployee = await create('employees', { name: '合成跨機構員工', employeeNo: 'SB-FOREIGN' }, foreign);
  const foreignCase = await create('cases', { name: '合成跨機構個案', caseNo: 'SB-FOREIGN-CASE' }, foreign), foreignService = await create('service-items', { code: 'SB-FOREIGN-SERVICE', name: '跨機構服務', minutes: 60, unitPriceCents: 0 }, foreign), foreignServices = [{ serviceItemId: foreignService.id, quantity: 1 }];
  const foreignPlan = await create('care-plans', { ...plan(foreignCase.id), services: foreignServices }, foreign), foreignShift = await create('shifts', { ...shiftData(), caseId: foreignCase.id, employeeId: foreignEmployee.id, carePlanId: foreignPlan.id, services: foreignServices }, foreign);
  const definition = (action = 'reassign', items = [first, second], overrides = {}) => ({ action, items: items.map(item => ({ id: item.id, version: item.version })), ...(action === 'reassign' ? { employeeId: employeeB.id } : {}), reason: ' 合成本次原因\n保留原文 ', ...overrides });
  const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files'];
  const state = () => Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  const counts = () => Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n]));
  const record = item => create('service-records', { shiftId: item.id, caseId: item.caseId, employeeId: item.employeeId, date: item.date, actualStart: item.startTime, actualEnd: item.endTime, services: item.services, status: 'draft' }, clients.caregiver);
  const commit = (payload, client = admin, key = id()) => request(client, 'POST', route('commit'), payload, { 'Idempotency-Key': key });
  return { app, request, create, patch, state, counts, admin, clients, employeeA, employeeB, employeeC, inactive, caseA, caseB, service, services, planA, planB, first, second, foreign, foreignEmployee, foreignShift, shiftData, definition, record, commit };
}

test('read-only batch preview and atomic reassignment preserve every non-operation shift field and keep exact reason in actual version audit', async t => {
  const f = await fixture(t), payload = f.definition(), before = f.state(), changes = f.app.db.prepare('SELECT total_changes() n').get().n;
  const preview = await f.request(f.clients.supervisor, 'POST', route('preview'), payload); assert.equal(preview.status, 200); assert.equal(preview.body.canCommit, true); assert.equal(preview.body.readyCount, 2); assert.deepEqual(f.state(), before); assert.equal(f.app.db.prepare('SELECT total_changes() n').get().n, changes);
  const result = await f.commit(payload, f.clients.supervisor); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.total, 2); assert.equal(result.body.reason, payload.reason);
  for (let index = 0; index < 2; index++) {
    const original = [f.first, f.second][index], item = result.body.items[index]; assert.equal(item.id, original.id); assert.equal(item.version, 2); assert.equal(item.employeeId, f.employeeB.id);
    for (const key of ['caseId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note', 'createdAt']) assert.deepEqual(item[key], original[key], key);
    const history = await f.request(f.admin, 'GET', '/api/shifts/' + item.id + '/history?compare=previous'); assert.equal(history.status, 200); assert.equal(history.body.items[0].actor.id, f.clients.supervisor.user.id); assert.equal(history.body.items[0].comparison.previousSnapshot.employeeId, f.employeeA.id);
    const events = f.app.db.prepare('SELECT detail FROM audit WHERE org_id=? AND entity=? AND record_id=? ORDER BY rowid').all(f.admin.org, 'shifts', item.id).map(row => JSON.parse(row.detail));
    assert.equal(events.at(-1).batchId, result.body.batchId); assert.equal(events.at(-1).reason, payload.reason); assert.deepEqual(events.at(-1).fields, ['employeeId']);
  }
  assert.deepEqual(f.state().records.filter(row => row.entity !== 'shifts'), before.records.filter(row => row.entity !== 'shifts')); assert.deepEqual(f.state().attachment_files, before.attachment_files);
});

test('atomic cancellation preserves notes and service selections and does not create service records or reset the schedule', async t => {
  const f = await fixture(t), before = f.counts(), payload = f.definition('cancel'), result = await f.commit(payload); assert.equal(result.status, 200); assert.equal(result.body.total, 2);
  for (const item of result.body.items) { assert.equal(item.status, 'cancelled'); assert.equal(item.employeeId, f.employeeA.id); assert.equal(item.note, f.first.note); assert.deepEqual(item.services, f.services); }
  const after = f.counts(); assert.equal(after.records, before.records); assert.equal(after.record_versions, before.record_versions + 2); assert.equal(after.audit, before.audit + 2); assert.equal(after.idempotency, before.idempotency + 1);
  const snapshot = f.state(); assert.equal((await f.commit(payload)).status, 409); assert.deepEqual(f.state(), snapshot);
});

test('batch role guard runs before malformed body and cross-organization rows reveal no before/after snapshots or partial writes', async t => {
  const f = await fixture(t), before = f.state();
  for (const role of ['finance', 'caregiver']) for (const operation of ['preview', 'commit']) assert.equal((await f.request(f.clients[role], 'POST', route(operation), [], { 'Idempotency-Key': id() })).status, 403);
  const mixed = f.definition('cancel', [f.first, f.foreignShift]), preview = await f.request(f.admin, 'POST', route('preview'), mixed); assert.equal(preview.status, 200); assert.equal(preview.body.canCommit, false); assert.equal(preview.body.readyCount, 1); assert.equal(preview.body.items[1].conflicts[0].code, 'NOT_FOUND'); assert.ok(!Object.hasOwn(preview.body.items[1], 'before')); assert.ok(!Object.hasOwn(preview.body.items[1], 'after'));
  assert.equal((await f.commit(mixed)).status, 409); assert.deepEqual(f.state(), before);
});

test('closed batch syntax rejects duplicates, unknown/nested data, invalid versions, empty reasons, excess selection and query bypasses without writing', async t => {
  const f = await fixture(t), before = f.state();
  const invalid = [{ action: 'delete' }, { items: [] }, { items: Array(51).fill({ id: f.first.id, version: 1 }) }, { items: [{ id: f.first.id, version: 1 }, { id: f.first.id, version: 1 }] }, { items: [{ id: f.first.id, version: '1' }] }, { items: [{ id: ' padded', version: 1 }] }, { items: [{ id: f.first.id, version: 1, hidden: true }] }, { reason: '' }, { reason: ' \n ' }, { reason: '字'.repeat(2001) }, { reason: {} }, { employeeId: f.foreignEmployee.id }, { employeeId: f.inactive.id }, { hidden: true }];
  for (const fields of invalid) {
    const response = await f.request(f.admin, 'POST', route('preview'), { ...f.definition(), ...fields }); assert.ok([200, 422].includes(response.status)); if (response.status === 200) assert.equal(response.body.canCommit, false);
    assert.ok([409, 422].includes((await f.commit({ ...f.definition(), ...fields })).status), JSON.stringify(fields));
  }
  assert.equal((await f.request(f.admin, 'POST', route('preview'), [])).status, 400);
  assert.equal((await f.request(f.admin, 'POST', route('preview'), { ...f.definition('cancel'), employeeId: '' })).status, 422);
  for (const path of [route('preview') + '?page=1', route('commit') + '?action=cancel', route('preview') + '?q=x&q=y']) assert.equal((await f.request(f.admin, 'POST', path, f.definition(), { 'Idempotency-Key': id() })).status, 422);
  assert.equal((await f.request(f.admin, 'POST', route('commit'), f.definition())).status, 422); assert.deepEqual(f.state(), before);
});

test('existing shifts, approved leave and mutually overlapping final batch assignments block reassignment without choosing partial success', async t => {
  const f = await fixture(t), extra = await f.create('shifts', f.shiftData({ caseId: f.caseB.id, carePlanId: f.planB.id, employeeId: f.employeeC.id, startTime: '09:30', endTime: '10:30' }));
  let before = f.state(), payload = f.definition('reassign', [f.first, extra]), preview = await f.request(f.admin, 'POST', route('preview'), payload); assert.equal(preview.status, 200); assert.equal(preview.body.conflictCount, 2); assert.ok(preview.body.items.every(item => item.conflicts.some(problem => problem.code === 'BATCH_SHIFT_CONFLICT'))); assert.equal((await f.commit(payload)).status, 409); assert.deepEqual(f.state(), before);
  await f.create('leave-requests', { employeeId: f.employeeB.id, date: f.first.date, startTime: '09:00', endTime: '10:00', type: '合成假別', status: 'approved' }); before = f.state();
  payload = f.definition('reassign', [f.first, f.second]); preview = await f.request(f.admin, 'POST', route('preview'), payload); assert.equal(preview.body.readyCount, 1); assert.equal(preview.body.items[0].conflicts[0].code, 'LEAVE_CONFLICT'); assert.equal((await f.commit(payload)).status, 409); assert.deepEqual(f.state(), before);
  const unchanged = await f.request(f.admin, 'POST', route('preview'), f.definition('reassign', [f.first], { employeeId: f.employeeA.id })); assert.equal(unchanged.body.items[0].conflicts[0].code, 'ASSIGNMENT_UNCHANGED');
});

test('successful preview conveys no authorization: late records, employee state, service validity or current versions are fully rechecked', async t => {
  const f = await fixture(t), payload = f.definition('cancel'), preview = await f.request(f.admin, 'POST', route('preview'), payload); assert.equal(preview.body.canCommit, true);
  await f.record(f.second); let before = f.state(), result = await f.commit(payload); assert.equal(result.status, 409); assert.equal(result.body.error.details.preview.items[1].conflicts[0].code, 'SHIFT_HAS_RECORD'); assert.deepEqual(f.state(), before);
  const reassignment = f.definition('reassign', [f.first]); assert.equal((await f.request(f.admin, 'POST', route('preview'), reassignment)).body.canCommit, true);
  const inactiveService = await f.patch('service-items', f.service, { status: 'inactive' }); before = f.state(); result = await f.commit(reassignment); assert.equal(result.status, 409); assert.equal(result.body.error.details.preview.items[0].conflicts[0].code, 'INACTIVE_SERVICE'); assert.deepEqual(f.state(), before);
  await f.patch('service-items', inactiveService, { status: 'active' }); assert.equal((await f.request(f.admin, 'POST', route('preview'), reassignment)).body.canCommit, true);
  await f.patch('employees', f.employeeB, { status: 'inactive' }); before = f.state(); result = await f.commit(reassignment); assert.equal(result.status, 409); assert.deepEqual(f.state(), before);
  const cancel = f.definition('cancel', [f.first]); await f.patch('shifts', f.first, { note: '更新後原文' }); before = f.state(); result = await f.commit(cancel); assert.equal(result.status, 409); assert.equal(result.body.error.details.preview.items[0].conflicts[0].code, 'VERSION_CONFLICT'); assert.deepEqual(f.state(), before);
});

test('required commit idempotency retries exactly and competing batches cannot duplicate versions or rewrite stale choices', async t => {
  const f = await fixture(t), payload = f.definition(), key = id(), first = await f.commit(payload, f.admin, key); assert.equal(first.status, 200); const before = f.state();
  const replay = await f.commit(payload, f.admin, key); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.state(), before);
  assert.equal((await f.commit({ ...payload, reason: '不同原因' }, f.admin, key)).status, 409); assert.deepEqual(f.state(), before);
  const fresh = await f.create('shifts', f.shiftData({ date: '2026-10-11' })), competing = f.definition('cancel', [fresh]), counts = f.counts();
  const results = await Promise.all([id(), id()].map(key => f.commit(competing, f.admin, key))); assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const after = f.counts(); assert.equal(after.records, counts.records); assert.equal(after.record_versions, counts.record_versions + 1); assert.equal(after.audit, counts.audit + 1); assert.equal(after.idempotency, counts.idempotency + 1);
});

test('a failure after earlier rows were replaced rolls back every record, version, audit and retry-key write', async t => {
  const f = await fixture(t), payload = f.definition('cancel'), key = id(), before = f.state();
  f.app.db.exec(`CREATE TEMP TRIGGER synthetic_batch_second_failure BEFORE INSERT ON audit WHEN NEW.entity='shifts' AND NEW.record_id='${f.second.id}' AND json_extract(NEW.detail,'$.operation')='shift-batches' BEGIN SELECT RAISE(ABORT,'synthetic second-row failure'); END;`);
  const failed = await f.commit(payload, f.admin, key); assert.equal(failed.status, 500); assert.deepEqual(f.state(), before);
  f.app.db.exec('DROP TRIGGER synthetic_batch_second_failure'); const retry = await f.commit(payload, f.admin, key); assert.equal(retry.status, 200); assert.equal(retry.body.total, 2);
});

test('maximum 50-row cancellation remains one atomic batch and role/query/transaction helpers reject before touching storage', async t => {
  const f = await fixture(t), shifts = [];
  for (let index = 0; index < 50; index++) shifts.push(await f.create('shifts', f.shiftData({ date: new Date(Date.UTC(2026, 10, index + 1)).toISOString().slice(0, 10) })));
  const before = f.counts(), result = await f.commit(f.definition('cancel', shifts)); assert.equal(result.status, 200); assert.equal(result.body.total, 50); assert.equal(new Set(result.body.items.map(item => item.id)).size, 50);
  const after = f.counts(); assert.equal(after.records, before.records); assert.equal(after.record_versions, before.record_versions + 50); assert.equal(after.audit, before.audit + 50); assert.equal(after.idempotency, before.idempotency + 1);
  for (const role of ['finance', 'caregiver']) { assert.throws(() => guardShiftBatchAccess({ role }), error => error.status === 403); assert.throws(() => previewShiftBatch(null, { role }, []), error => error.status === 403); }
  assert.throws(() => shiftBatchQuery(new URLSearchParams('page=1')), error => error.status === 422);
  assert.throws(() => shiftBatchDefinition({ ...f.definition('cancel'), reason: {} }), error => error.status === 422);
  assert.throws(() => commitShiftBatch(f.app.db, { orgId: f.admin.org, role: 'admin', user: f.admin.user }, f.definition('cancel')), error => error.code === 'BATCH_TRANSACTION_REQUIRED');
});

test('origin and CSRF safeguards apply to both preview and commit without altering the schedule', async t => {
  const f = await fixture(t), before = f.state();
  for (const operation of ['preview', 'commit']) {
    assert.equal((await f.request(f.admin, 'POST', route(operation), f.definition(), { Origin: 'https://synthetic-other.example.test', 'Idempotency-Key': id() })).status, 403);
    assert.equal((await f.request(f.admin, 'POST', route(operation), f.definition(), { 'X-CSRF-Token': '', 'Idempotency-Key': id() })).status, 403);
  }
  assert.deepEqual(f.state(), before);
});
