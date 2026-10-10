import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, insert } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';
import { createLeaveEditor } from '../public/data/leave-editor.js';

const ENTITY = 'leave-requests', password = 'synthetic-leave-editor-password';
const keys = ['employeeId', 'date', 'startTime', 'endTime', 'type', 'reason', 'status'];
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const route = item => `/api/${ENTITY}/${item.id}`;
const history = (item, compare = true) => route(item) + '/history' + (compare ? '?compare=previous' : '');
const projection = item => Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  async function request(client, method, url, data, headers = {}, raw) {
    const response = await fetch(base + url, { method, headers: { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成請假管理者', email: 'admin@leave-editor.example.test', password, organizationName: '合成請假甲機構' }); assert.equal(setup.status, 201);
  const clientFrom = r => ({ cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.body.csrfToken, org: setup.body.organizations[0].id, user: r.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin, headers = {}) { const r = await request(caller, 'POST', '/api/' + entity, data, headers); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.item; }
  async function patch(entity, item, data, caller = admin) { const r = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { ...data, version: item.version }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.item; }
  const employee = await create('employees', { name: '合成甲員工', employeeNo: 'TEST-LEAVE-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成乙員工', employeeNo: 'TEST-LEAVE-B', hourlyRateCents: 24000 });
  const inactive = await create('employees', { name: '合成停用員工', employeeNo: 'TEST-LEAVE-INACTIVE', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@leave-editor.example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const service = await create('service-items', { code: 'TEST-LEAVE-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const careCase = await create('cases', { caseNo: 'TEST-LEAVE-CASE', name: '合成服務個案' }), services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: careCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shiftData = extra => ({ caseId: careCase.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-09', startTime: '09:00', endTime: '10:00', services, ...extra });
  const shift = await create('shifts', shiftData());
  const data = extra => ({ employeeId: employee.id, date: '2026-10-20', startTime: '09:00', endTime: '10:00', type: ' 自訂假别 ', reason: ' 合成原因\n', status: 'pending', ...extra });
  const editor = existing => createLeaveEditor({ existing, employees: [employee, employeeB, inactive], defaultDate: '2026-10-20' });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() n').get().n, tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])) });
  const imported = value => insert(app.db, admin.org, ENTITY, value); // INSERT-only memory imports, never normal-API claims or real data.
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: careCase.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const reviewed = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(reviewed.status, 200);
    return (await request(admin, 'GET', '/api/service-records/' + record.id)).body.item;
  }
  return { app, request, create, patch, admin, clients, employee, employeeB, inactive, careCase, services, service, plan, shift, shiftData, data, editor, state, imported, approve };
}

test('real seven-field creation selective update no-op and independent status actions preserve actors without inventing a pending lock', async t => {
  const f = await fixture(t), e = f.editor(), payload = e.buildPayload({ employeeId: f.employee.id, type: ' 自訂🙂假別 ', reason: ' 第一行\n第二行 ' });
  assert.deepEqual(Object.keys(payload), keys); const first = await f.create(ENTITY, payload); e.confirm(first, f.admin.org, payload); assert.deepEqual(projection(first), payload);
  const edit = f.editor(first), update = edit.buildPayload({ employeeId: f.employeeB.id, reason: ' 督導原因\n' });
  const second = await f.patch(ENTITY, first, update, f.clients.supervisor); edit.confirm(second, f.admin.org, update);
  const noOp = f.editor(second), unchanged = noOp.buildPayload(noOp.initial); assert.deepEqual(unchanged, {}); const third = await f.patch(ENTITY, second, unchanged); noOp.confirm(third, f.admin.org, unchanged);
  const beforeApproval = f.editor(third), fourth = await f.patch(ENTITY, third, { status: 'approved' }, f.clients.supervisor); beforeApproval.confirm(fourth, f.admin.org, { status: 'approved' });
  const approvedEdit = f.editor(fourth), note = approvedEdit.buildPayload({ reason: '原 API 允許非 pending 修改' }); const fifth = await f.patch(ENTITY, fourth, note); approvedEdit.confirm(fifth, f.admin.org, note);
  const cancel = f.editor(fifth), sixth = await f.patch(ENTITY, fifth, { status: 'cancelled' }); cancel.confirm(sixth, f.admin.org, { status: 'cancelled' });
  const before = f.state(), h = await f.request(f.admin, 'GET', history(sixth)); assert.equal(h.status, 200);
  assert.deepEqual(h.body.items.map(item => item.actor.id), [f.admin.user.id, f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id, f.clients.supervisor.user.id, f.admin.user.id]);
  assert.deepEqual(projection(h.body.items.at(-1).snapshot), payload); assert.deepEqual(f.state(), before);
  const audits = f.app.db.prepare('SELECT detail FROM audit WHERE record_id=? AND action=? ORDER BY rowid').all(first.id, 'record.update').map(item => JSON.parse(item.detail));
  assert.deepEqual(audits.map(item => item.fields), [['employeeId', 'reason'], [], ['status'], ['reason'], ['status']]);
});

test('normal API ISO with seconds offset and CRLF keep exact bytes while date-only changes still fail the original same-day guard', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data({ startTime: '2026-10-20T09:30:51+08:00', endTime: '2026-10-20T10:15:20-03:00', type: 'PRIVATE\r\n假別', reason: 'PRIVATE\r\n原因' })), e = f.editor(first);
  for (const key of ['startTime', 'endTime', 'type', 'reason']) { assert.equal(e.needsIntent(key), true); assert.equal(e.initial[key], ''); }
  assert.ok(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
  const update = e.buildPayload({ employeeId: f.employeeB.id }), second = await f.patch(ENTITY, first, update); e.confirm(second, f.admin.org, update);
  for (const key of keys.filter(key => key !== 'employeeId')) assert.deepEqual(second[key], first[key]);
  const edit = f.editor(second), changedDate = edit.buildPayload({ date: '2026-10-21' }), before = f.state();
  const rejected = await f.request(f.admin, 'PATCH', route(second), { version: second.version, ...changedDate }); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'TIME_RANGE'); assert.deepEqual(f.state(), before);
  const repaired = edit.buildPayload({ date: '2026-10-21', startTimeIntent: 'replace', startTime: '09:30', endTimeIntent: 'replace', endTime: '10:15', typeIntent: 'replace', type: ' 原文假別 ', reasonIntent: 'clear' });
  const third = await f.patch(ENTITY, second, repaired); edit.confirm(third, f.admin.org, repaired); assert.equal(third.reason, '');
  const h = await f.request(f.admin, 'GET', history(third)); assert.deepEqual(projection(h.body.items[0].comparison.previousSnapshot), projection(second));
});

test('API-valid year0000 remains outside native date and can survive metadata-only and explicit replacement edits', async t => {
  const f = await fixture(t);
  for (const times of [{ startTime: '09:00', endTime: '10:00' }, { startTime: '0000-02-29T09:00:51Z', endTime: '0000-02-29T10:00:02Z' }]) {
    const first = await f.create(ENTITY, f.data({ date: '0000-02-29', ...times })), e = f.editor(first);
    assert.equal(e.initial.date, ''); assert.equal(e.initial.dateIntent, 'keep'); const payload = e.buildPayload({ reason: '只改原因，年零保持' });
    const second = await f.patch(ENTITY, first, payload); e.confirm(second, f.admin.org, payload); assert.equal(second.date, '0000-02-29'); assert.equal(second.startTime, times.startTime);
    const edit = f.editor(second), repair = edit.buildPayload({ dateIntent: 'replace', date: '2026-10-22', ...(edit.needsIntent('startTime') ? { startTimeIntent: 'replace', startTime: '09:00', endTimeIntent: 'replace', endTime: '10:00' } : {}) });
    const third = await f.patch(ENTITY, second, repair); edit.confirm(third, f.admin.org, repair); assert.equal(third.date, '2026-10-22');
  }
});

test('INSERT-only typed and missing original values preserve own JSON but missing required data and invalid status still meet merged guards', async t => {
  const f = await fixture(t), special = JSON.parse('{"__proto__":{"private":"PRIVATE"},"constructor":[0,false],"prototype":null}');
  for (const value of [f.data({ type: special, reason: ['PRIVATE', '', false] }), f.data({ type: ['原假別'], reason: null }), f.data({ type: false, reason: 0 })]) {
    const first = f.imported(value), e = f.editor(first), payload = e.buildPayload({ date: '2026-10-21' });
    const second = await f.patch(ENTITY, first, payload); e.confirm(second, f.admin.org, payload); assert.deepEqual(second.type, first.type); assert.deepEqual(second.reason, first.reason); assert.ok(!JSON.stringify(e.fields).includes('PRIVATE'));
    const edit = f.editor(second), repair = edit.buildPayload({ typeIntent: 'replace', type: '明確文字', reasonIntent: 'clear' }); const third = await f.patch(ENTITY, second, repair); edit.confirm(third, f.admin.org, repair); assert.equal(third.reason, '');
  }
  const absent = f.data(); delete absent.reason; const first = f.imported(absent), e = f.editor(first), p = e.buildPayload({ type: '單改假別' }), second = await f.patch(ENTITY, first, p); e.confirm(second, f.admin.org, p); assert.equal(Object.hasOwn(second, 'reason'), false);
  for (const key of keys.slice(0, 5)) for (const value of [undefined, null, '', []]) {
    const data = f.data(); if (value === undefined) delete data[key]; else data[key] = value;
    const item = f.imported(data), captured = f.editor(item), before = f.state(), response = await f.request(f.admin, 'PATCH', route(item), { version: 1, ...captured.buildPayload(captured.initial) });
    assert.equal(response.status, 422); assert.equal(response.body.error.code, 'REQUIRED'); assert.deepEqual(f.state(), before);
  }
  for (const status of ['', null, [], 'unknown']) { const item = f.imported(f.data({ status })), before = f.state(); const response = await f.request(f.admin, 'PATCH', route(item), { version: 1 }); assert.equal(response.status, 422); assert.equal(response.body.error.code, 'INVALID_STATUS'); assert.deepEqual(f.state(), before); }
  assert.equal({}.private, undefined);
});

test('employee reassignment allows inactive same-org staff while missing foreign wrong-entity parents require explicit valid repair', async t => {
  const f = await fixture(t), e = f.editor(), p = e.buildPayload({ employeeId: f.inactive.id, type: '合成停用員工假別' }), first = await f.create(ENTITY, p); e.confirm(first, f.admin.org, p);
  const org = await f.create('organizations', { name: '合成請假乙機構' }), other = { ...f.admin, org: org.id }, foreign = await f.create('employees', { name: '合成外機構', employeeNo: 'TEST-FOREIGN' }, other);
  for (const employeeId of [id(), foreign.id, f.careCase.id]) {
    const item = f.imported(f.data({ employeeId })), captured = f.editor(item); assert.equal(captured.initial.employeeId, ''); assert.equal(captured.initial.employeeIdIntent, 'keep');
    const before = f.state(), response = await f.request(f.admin, 'PATCH', route(item), { version: 1, ...captured.buildPayload({ reason: '不能隱式改派' }) }); assert.equal(response.status, 422); assert.equal(response.body.error.code, 'INVALID_REFERENCE'); assert.deepEqual(f.state(), before);
    const payload = captured.buildPayload({ employeeIdIntent: 'replace', employeeId: f.employeeB.id }), fixed = await f.patch(ENTITY, item, payload); captured.confirm(fixed, f.admin.org, payload); assert.equal(fixed.employeeId, f.employeeB.id);
  }
});

test('new API guards retain exact UTF16 and 128KiB limits while oversized kept data is neither resent nor truncated', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data()), e = f.editor(first), before = f.state();
  for (const data of [{ type: null }, { reason: {} }, { type: '🙂'.repeat(250) + 'x' }, { reason: 'x'.repeat(10001) }, { date: '2026-02-30' }, { startTime: '09:00:00' }, { endTime: '08:59' }, { endTime: '09:00' }, { status: 'active' }, { unknown: 'x' }]) {
    const r = await f.request(f.admin, 'PATCH', route(first), { version: 1, ...data }); assert.equal(r.status, 422, JSON.stringify(data).slice(0, 100));
  }
  assert.deepEqual(f.state(), before);
  const boundary = e.buildPayload({ type: '🙂'.repeat(250), reason: '字'.repeat(10000) }), second = await f.patch(ENTITY, first, boundary); e.confirm(second, f.admin.org, boundary);
  const small = JSON.stringify({ version: second.version, reason: '128 KiB 合法空白包覆' }), exact = small + ' '.repeat(131072 - Buffer.byteLength(small));
  const accepted = await f.request(f.admin, 'PATCH', route(second), undefined, {}, exact); assert.equal(accepted.status, 200);
  const unchanged = f.state(), tooLarge = JSON.stringify({ version: accepted.body.item.version, reason: '不得寫入' });
  const rejected = await f.request(f.admin, 'PATCH', route(second), undefined, {}, tooLarge + ' '.repeat(131073 - Buffer.byteLength(tooLarge))); assert.equal(rejected.status, 413); assert.equal(rejected.body.error.code, 'BODY_TOO_LARGE'); assert.deepEqual(f.state(), unchanged);
  const huge = f.imported(f.data({ type: 'x'.repeat(501), reason: 'z'.repeat(150000) })), captured = f.editor(huge), patch = captured.buildPayload({ employeeId: f.employeeB.id }); assert.deepEqual(patch, { employeeId: f.employeeB.id });
  const saved = await f.patch(ENTITY, huge, patch); captured.confirm(saved, f.admin.org, patch); assert.equal(saved.reason.length, 150000); assert.equal(saved.type.length, 501);
});

test('POST same-key replay true CAS CSRF and origin failures keep the committed seven-field state and ledger', async t => {
  const f = await fixture(t), e = f.editor(), payload = e.buildPayload({ employeeId: f.employee.id, type: '合成一次' }), headers = { 'Idempotency-Key': 'synthetic-leave-editor-once' };
  const first = await f.request(f.admin, 'POST', '/api/' + ENTITY, payload, headers); assert.equal(first.status, 201); e.confirm(first.body.item, f.admin.org, payload);
  const committed = f.state(), replay = await f.request(f.admin, 'POST', '/api/' + ENTITY, payload, headers); assert.deepEqual(replay.body, first.body); assert.deepEqual(f.state(), committed);
  const conflict = await f.request(f.admin, 'POST', '/api/' + ENTITY, { ...payload, type: '別假別' }, headers); assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.state(), committed);
  const old = first.body.item, captured = f.editor(old), pending = captured.buildPayload({ reason: '尚未送達的輸入' }), fresh = await f.patch(ENTITY, old, { reason: '督導先存' }, f.clients.supervisor), before = f.state();
  const stale = await f.request(f.admin, 'PATCH', route(old), { version: old.version, ...pending }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  for (const csrf of ['', 'invalid']) assert.equal((await f.request(f.admin, 'PATCH', route(fresh), { version: fresh.version, reason: 'blocked' }, { 'X-CSRF-Token': csrf })).status, 403);
  assert.equal((await f.request(f.admin, 'PATCH', route(fresh), { version: fresh.version, reason: 'blocked' }, { Origin: 'https://untrusted.example.test' })).status, 403);
  assert.deepEqual(pending, { reason: '尚未送達的輸入' }); assert.throws(() => captured.confirm(fresh, f.admin.org, pending), /未確認/); assert.deepEqual((await f.request(f.admin, 'GET', route(old))).body.item, fresh); assert.deepEqual(f.state(), before);
});

test('four roles current and historical employee scope cross-org and active-link authentication remain unchanged', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data()), unrelated = await f.create(ENTITY, f.data({ employeeId: f.employeeB.id }));
  const org = await f.create('organizations', { name: '合成第二機構' }), other = { ...f.admin, org: org.id }, foreignEmployee = await f.create('employees', { name: '合成外部', employeeNo: 'TEST-OTHER' }, other), foreign = await f.create(ENTITY, f.data({ employeeId: foreignEmployee.id }), other);
  const sessions = f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(), memberships = f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(); let before = f.state();
  for (const client of [f.clients.finance, f.clients.caregiver]) {
    for (const data of [{ reason: '禁止' }, { status: 'approved' }]) assert.equal((await f.request(client, 'PATCH', route(first), { version: 1, ...data })).status, 403);
    assert.equal((await f.request(client, 'POST', '/api/' + ENTITY, f.data())).status, 403); assert.equal((await f.request(client, 'GET', route(first) + '/shift-conflicts')).status, 403);
  }
  for (const client of Object.values(f.clients)) for (const url of [route(first), history(first), history(first, false)]) assert.equal((await f.request(client, 'GET', url)).status, 200);
  for (const url of [route(unrelated), history(unrelated), history(unrelated, false)]) { assert.equal((await f.request(f.clients.caregiver, 'GET', url)).status, 404); assert.equal((await f.request(f.clients.finance, 'GET', url)).status, 200); }
  for (const [client, item] of [[other, first], [f.admin, foreign]]) for (const url of [route(item), history(item)]) assert.equal((await f.request(client, 'GET', url)).status, 404);
  assert.equal((await f.request(other, 'PATCH', route(first), { version: 1, reason: 'blocked' })).status, 404); assert.equal((await f.request(null, 'GET', route(first))).status, 401); assert.deepEqual(f.state(), before);
  const moved = await f.patch(ENTITY, first, { employeeId: f.employeeB.id }), back = await f.patch(ENTITY, moved, { employeeId: f.employee.id }); before = f.state();
  const h = await f.request(f.clients.caregiver, 'GET', history(back)); assert.deepEqual(h.body.items.map(x => x.version), [3, 1]); assert.equal(h.body.items[0].comparison.status, 'unavailable'); assert.deepEqual(f.state(), before);
  const inactive = await f.patch('employees', f.employee, { status: 'inactive' }); before = f.state();
  for (const url of [route(back), history(back), '/api/' + ENTITY]) { const r = await f.request(f.clients.caregiver, 'GET', url); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
  assert.equal((await f.request(f.clients.finance, 'GET', route(back))).status, 200); assert.deepEqual(f.state(), before);
  await f.patch('employees', inactive, { status: 'active' }); before = f.state(); assert.equal((await f.request(f.clients.caregiver, 'GET', route(back))).status, 200);
  assert.deepEqual(f.app.db.prepare('SELECT * FROM memberships ORDER BY rowid').all(), memberships); assert.deepEqual(f.app.db.prepare('SELECT * FROM sessions ORDER BY rowid').all(), sessions); assert.deepEqual(f.state(), before);
});

test('fresh approval catches a real new shift race completed shifts and reverse conflicts while adjacent and cancelled intervals stay allowed', async t => {
  const f = await fixture(t), pending = await f.create(ENTITY, f.data({ date: '2026-10-21' })), beforeRead = f.state();
  const preview = await f.request(f.admin, 'GET', route(pending) + '/shift-conflicts'); assert.equal(preview.status, 200); assert.equal(preview.body.total, 0); assert.deepEqual(f.state(), beforeRead);
  const added = await f.create('shifts', f.shiftData({ date: pending.date })), captured = f.editor(pending), before = f.state();
  const race = await f.request(f.admin, 'PATCH', route(pending), { version: pending.version, status: 'approved' }); assert.equal(race.status, 409); assert.equal(race.body.error.code, 'SHIFT_CONFLICT'); assert.deepEqual(f.state(), before);
  const cancelledShift = await f.patch('shifts', added, { status: 'cancelled' }), approved = await f.patch(ENTITY, pending, { status: 'approved' }); captured.confirm(approved, f.admin.org, { status: 'approved' }); assert.equal(cancelledShift.status, 'cancelled');
  const adjacent = await f.create('shifts', f.shiftData({ date: pending.date, startTime: '10:00', endTime: '11:00' })); assert.equal(adjacent.startTime, approved.endTime);
  const reverseBefore = f.state(), reverse = await f.request(f.admin, 'POST', '/api/shifts', f.shiftData({ date: pending.date, startTime: '09:15', endTime: '09:45' })); assert.equal(reverse.status, 409); assert.equal(reverse.body.error.code, 'LEAVE_CONFLICT'); assert.deepEqual(f.state(), reverseBefore);
  const overlappingLeave = await f.create(ENTITY, f.data({ date: pending.date, status: 'approved' })); assert.equal(overlappingLeave.status, 'approved', 'no invented leave-versus-leave exclusion');
  const billing = await f.approve(), completedLeave = await f.create(ENTITY, f.data({ date: f.shift.date })), completedBefore = f.state();
  const completedConflict = await f.request(f.admin, 'PATCH', route(completedLeave), { version: 1, status: 'approved' }); assert.equal(completedConflict.status, 409); assert.equal(completedConflict.body.error.code, 'SHIFT_CONFLICT');
  const completeShift = (await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item;
  const locked = await f.request(f.admin, 'PATCH', '/api/shifts/' + f.shift.id, { version: completeShift.version, status: 'cancelled' }); assert.equal(locked.status, 409); assert.equal(locked.body.error.code, 'SHIFT_HAS_RECORD'); assert.deepEqual(f.state(), completedBefore);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + billing.id)).body.item, billing);
  const boundary = await f.create(ENTITY, f.data({ date: f.shift.date, startTime: '10:00', endTime: '11:00', status: 'approved' })); assert.equal(boundary.status, 'approved');
});

test('unknown success confirmation after a real commit preserves inputs and cannot coerce or omit any saved field', async t => {
  const f = await fixture(t), data = f.data({ type: { secret: 'PRIVATE' } }); delete data.reason;
  const first = f.imported(data), e = f.editor(first), payload = e.buildPayload({ employeeId: f.employeeB.id }), current = await f.patch(ENTITY, first, payload), before = f.state();
  for (const reply of [null, [], {}, { ...current, id: 'other' }, { ...current, orgId: 'other' }, { ...current, version: 1 }, { ...current, version: '2' }, { ...current, reason: '' }, { ...current, type: '[object Object]' }, { ...current, employeeId: f.employee.id }]) assert.throws(() => e.confirm(reply, f.admin.org, payload), /未確認/);
  for (const key of keys.filter(key => key !== 'reason')) { const reply = { ...current }; delete reply[key]; assert.throws(() => e.confirm(reply, f.admin.org, payload), /未確認/); }
  assert.deepEqual(e.buildPayload({ employeeId: f.employeeB.id }), payload); e.confirm(current, f.admin.org, payload); assert.deepEqual((await f.request(f.admin, 'GET', route(current))).body.item, current); assert.deepEqual(f.state(), before);
});

test('all31 report outlets both versioned BLOBs six immutable triggers and eleven-table readonly history preserve approved billing', async t => {
  const f = await fixture(t), billing = await f.approve(), cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.careCase.id, title: '合成PDF', ...filePayload(PDF_BYTES) }), b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成PNG', ...filePayload(PNG_BYTES, '合成.png', 'image/png') });
  const first = await f.create(ENTITY, f.data()), e = f.editor(first), payload = e.buildPayload({ reason: ' 只改請假原因\n' }), current = await f.patch(ENTITY, first, payload); e.confirm(current, f.admin.org, payload);
  const urls = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave', 'training', 'certification']) for (const suffix of ['', '/export', '.csv']) urls.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind === 'certification' ? '&asOf=2026-10-09' : ''}`);
  for (const suffix of ['', '/export', '.csv']) urls.push('/api/employee-report' + suffix); assert.equal(urls.length, 31);
  const triggers = f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), before = f.state(); assert.equal(triggers.length, 6); assert.equal(Object.keys(before.tables).length, 11);
  const reports = async () => { const result = {}; for (const url of urls) { const r = await f.request(f.admin, 'GET', url); assert.equal(r.status, 200, url); result[url] = typeof r.body === 'string' ? r.body : Object.fromEntries(Object.entries(r.body).filter(([key]) => key !== 'generatedAt')); } return result; };
  const firstReports = await reports();
  for (const [url, bytes] of [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) { const r = await f.request(f.admin, 'GET', url + suffix); assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes); assert.equal(sha(r.bytes), sha(bytes)); }
  for (const client of Object.values(f.clients)) for (const url of [route(current), history(current), history(current, false)]) assert.equal((await f.request(client, 'GET', url)).status, 200);
  for (const suffix of ['', '/export', '.csv']) assert.equal((await f.request(f.clients.finance, 'GET', `/api/leave-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`)).status, 200);
  assert.deepEqual(await reports(), firstReports); assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + billing.id)).body.item, billing);
  for (const client of [f.clients.supervisor, f.clients.caregiver]) assert.equal(Object.hasOwn((await f.request(client, 'GET', '/api/service-records/' + billing.id)).body.item, 'billingSnapshot'), false);
  assert.equal(firstReports['/api/reports/fees?month=2026-10'].totals.amountCents, 37035); assert.equal(firstReports['/api/reports/payroll?month=2026-10'].totals.amountCents, 18800);
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), triggers);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    assert.throws(() => f.app.db.exec('DELETE FROM ' + table), /immutable/);
    assert.throws(() => f.app.db.exec('UPDATE ' + table + ' SET ' + (table === 'record_versions' ? 'version=version' : 'id=id')), /immutable/);
  }
  assert.deepEqual(f.state(), before);
});
