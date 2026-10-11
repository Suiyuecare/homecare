import test from 'node:test';
import assert from 'node:assert/strict';
import { id, get } from '../src/server/model.mjs';
import { seriesMoveFixture } from './helpers/shift-series-move-fixture.mjs';

test('true HTTP admin/supervisor move preview zero-write, mandatory idem/CAS, same-key receipt and second move use original-date trace', async t => {
  const f = await seriesMoveFixture(t), originals = await f.generate(), body = f.payload((await f.occurrences()).items), before = f.state();
  const preview = await f.move(body); assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.preview.canCommit, true); assert.deepEqual(f.state(), before);
  const missing = await f.request(f.admin, 'POST', f.prefix + '/adjustments/commit', body); assert.equal(missing.status, 422); assert.equal(missing.body.error.code, 'IDEMPOTENCY_REQUIRED'); assert.deepEqual(f.state(), before);
  const key = id(), commit = await f.move(body, 'commit', f.clients.supervisor, key); assert.equal(commit.status, 200, JSON.stringify(commit.body)); const once = f.state();
  const replay = await f.move(body, 'commit', f.clients.supervisor, key); assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.deepEqual(replay.body, commit.body); assert.deepEqual(f.state(), once);
  const otherBody = await f.move({ ...body, reason: 'different' }, 'commit', f.clients.supervisor, key); assert.equal(otherBody.status, 409); assert.equal(otherBody.body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.state(), once);
  const stale = await f.move(body, 'commit'); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'SERIES_SELECTION_CHANGED'); assert.deepEqual(f.state(), once);
  const trace = await f.occurrences(); assert.deepEqual(trace.items.map(row => row.date), originals.map(row => row.date)); assert.ok(trace.items.every(row => row.movedDate === row.shift.date && row.shift.version === 2));
  const back = { ...f.payload(trace.items), daysOffset: -1 }, restored = await f.move(back, 'commit'); assert.equal(restored.status, 200, JSON.stringify(restored.body)); assert.deepEqual(restored.body.result.items.map(row => row.date), originals.map(row => row.date)); assert.ok((await f.occurrences()).items.every(row => !Object.hasOwn(row, 'movedDate')));
});
test('roles, cross organization, closed routes/queries and generic linked-date change stay forbidden', async t => {
  const f = await seriesMoveFixture(t), shifts = await f.generate(), body = f.payload((await f.occurrences()).items), before = f.state();
  for (const role of ['caregiver', 'finance']) for (const stage of ['preview', 'commit']) { const result = await f.move(body, stage, f.clients[role]); assert.equal(result.status, 403); }
  const organization = await f.create('organizations', { name: '合成跨機構移日' }), foreign = { ...f.admin, org: organization.id }, scoped = f.state();
  assert.equal((await f.move(body, 'preview', foreign)).status, 404); assert.deepEqual(f.state(), scoped);
  for (const suffix of ['?skip=true', '?page=1', '?x=1&x=2']) { const result = await f.move(body, 'preview', f.admin, id(), suffix); assert.equal(result.status, 422); }
  const tail = await f.request(f.admin, 'GET', f.prefix + '/occurrences?' + new URLSearchParams({ ...f.range, version: '1\n' })); assert.equal(tail.status, 422);
  const generic = await f.request(f.admin, 'PATCH', '/api/shifts/' + shifts[0].id, { date: '2026-10-08', version: 1 }); assert.equal(generic.status, 409); assert.equal(generic.body.error.code, 'SERIES_SHIFT_IMMUTABLE');
  assert.deepEqual(f.state(), scoped); assert.equal(before.records.length, scoped.records.length);
});
test('any service record excludes its shift, exact all editable membership rejects omission and completed/cancelled remain untouched', async t => {
  const f = await seriesMoveFixture(t), shifts = await f.generate();
  await f.create('service-records', { shiftId: shifts[0].id, caseId: shifts[0].caseId, employeeId: shifts[0].employeeId, date: shifts[0].date, actualStart: shifts[0].startTime, actualEnd: shifts[0].endTime, services: shifts[0].services, status: 'draft' });
  const entries = await f.occurrences(); assert.equal(entries.items[0].editable, false); const body = f.payload(entries.items), before = f.state();
  const omission = await f.move({ ...body, items: body.items.slice(1) }); assert.equal(omission.status, 409); assert.deepEqual(f.state(), before);
  const prepared = await f.move(body); assert.equal(prepared.status, 200); assert.equal(prepared.body.excluded.length, 1); assert.equal(prepared.body.excluded[0].lockReason, '已有服務紀錄');
  const saved = await f.move(body, 'commit'); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.result.total, 2); assert.deepEqual(get(f.app.db, f.admin.org, 'shifts', shifts[0].id), shifts[0]);
  const fresh = await f.occurrences(), cancel = { ...f.payload(fresh.items), action: 'cancel' }; delete cancel.daysOffset; const cancelled = await f.move(cancel, 'commit'); assert.equal(cancelled.status, 200); const allLocked = await f.occurrences(); assert.ok(allLocked.items.every(row => !row.editable));
  assert.equal((await f.move({ ...body, items: [] })).status, 422);
});
test('target approved leave, unselected overlap, care plan/item dates and inactive employee are rechecked at commit with no partial save', async t => {
  const scenarios = ['overlap', 'leave', 'plan', 'item', 'employee'];
  for (const scenario of scenarios) {
    await t.test(scenario, async st => {
      const f = await seriesMoveFixture(st, { roles: false }); await f.generate(); const body = f.payload((await f.occurrences()).items), preview = await f.move(body); assert.equal(preview.status, 200); assert.equal(preview.body.preview.canCommit, true);
      if (scenario === 'overlap') { const otherCase = await f.create('cases', { name: '合成移日目標衝突個案', caseNo: 'MOVE-OTHER' }), plan = await f.create('care-plans', { caseId: otherCase.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services: f.services }); await f.create('shifts', { caseId: otherCase.id, carePlanId: plan.id, employeeId: f.employee.id, date: '2026-10-08', startTime: '09:30', endTime: '10:30', services: f.services, status: 'scheduled' }); }
      if (scenario === 'leave') await f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', type: '合成假', reason: '合成目標日核准假', status: 'approved' });
      if (scenario === 'plan') await f.patch('care-plans', f.plan, { validTo: '2026-10-07' });
      if (scenario === 'item') await f.patch('service-items', f.service, { validTo: '2026-10-07' });
      if (scenario === 'employee') await f.patch('employees', f.employee, { status: 'inactive' });
      const before = f.state(), saved = await f.move(body, 'commit'); assert.equal(saved.status, 409, JSON.stringify(saved.body)); assert.equal(saved.body.error.code, 'BATCH_CONFLICT'); assert.deepEqual(f.state(), before);
    });
  }
});
test('true HTTP second audit failure leaves idem absent; same-key retry succeeds once and no history/audit repair occurs', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), shifts = await f.generate(), body = f.payload((await f.occurrences()).items), before = f.state(), key = id();
  f.app.db.exec(`CREATE TEMP TRIGGER fail_move_http BEFORE INSERT ON audit WHEN NEW.record_id='${shifts[1].id}' AND json_extract(NEW.detail,'$.action')='move' BEGIN SELECT RAISE(ABORT,'synthetic move HTTP rollback'); END;`);
  const failed = await f.move(body, 'commit', f.admin, key); assert.equal(failed.status, 500); assert.deepEqual(f.state(), before);
  f.app.db.exec('DROP TRIGGER fail_move_http'); const saved = await f.move(body, 'commit', f.admin, key); assert.equal(saved.status, 200, JSON.stringify(saved.body)); const once = f.state(); assert.equal((await f.move(body, 'commit', f.admin, key)).status, 200); assert.deepEqual(f.state(), once);
});
test('cached move receipt still needs fresh role/membership and uncorrputed current/origin proof', async t => {
  const f = await seriesMoveFixture(t), shifts = await f.generate(), body = f.payload((await f.occurrences()).items), key = id(); assert.equal((await f.move(body, 'commit', f.clients.supervisor, key)).status, 200);
  const raw = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(shifts[0].id); const data = JSON.parse(raw.data); f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...data, date: '2026-10-09' }), shifts[0].id); const corrupt = f.state();
  const replay = await f.move(body, 'commit', f.clients.supervisor, key); assert.equal(replay.status, 409); assert.equal(replay.body.error.code, 'BROKEN_OCCURRENCE'); assert.deepEqual(f.state(), corrupt); f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(raw.data, shifts[0].id);
  const membership = f.app.db.prepare('SELECT * FROM memberships WHERE user_id=? AND org_id=?').get(f.clients.supervisor.user.id, f.admin.org); assert.ok(membership); f.app.db.prepare('UPDATE memberships SET role=? WHERE user_id=? AND org_id=?').run('caregiver', f.clients.supervisor.user.id, f.admin.org); const before = f.state();
  const denied = await f.move(body, 'commit', f.clients.supervisor, key); assert.equal(denied.status, 403); assert.deepEqual(f.state(), before);
});
test('calendar limits, exact signed numeric JSON and excessive source period reject without writes', async t => {
  const f = await seriesMoveFixture(t, { roles: false, fromDate: '0001-01-01', toDate: '0001-01-03' }); await f.generate(); const body = f.payload((await f.occurrences()).items), before = f.state();
  const out = await f.move({ ...body, daysOffset: -1 }); assert.equal(out.status, 200); assert.equal(out.body.preview.canCommit, false); assert.equal(out.body.preview.items[0].conflicts[0].code, 'INVALID_FIELD');
  assert.equal((await f.move({ ...body, daysOffset: -1 }, 'commit')).status, 409);
  for (const changed of [{ ...body, daysOffset: '1' }, { ...body, daysOffset: 0 }, { ...body, daysOffset: 1.25 }, { ...body, daysOffset: 3652059 }, { ...body, toDate: '0001-04-04' }, { ...body, reason: '' }, { ...body, items: body.items.map(row => ({ ...row, hidden: true })) }]) assert.equal((await f.move(changed)).status, 422);
  assert.deepEqual(f.state(), before);
});

test('real approved service billing snapshot remains frozen while other editable series shifts move and original slots never refill', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), shifts = await f.generate(), record = await f.create('service-records', { shiftId: shifts[0].id, caseId: shifts[0].caseId, employeeId: shifts[0].employeeId, date: shifts[0].date, actualStart: '2026-10-05T09:00:33+08:00', actualEnd: '2026-10-05T10:00:59+08:00', services: shifts[0].services, status: 'submitted' });
  const reviewed = await f.request(f.admin, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成確實核閱' }); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const approved = get(f.app.db, f.admin.org, 'service-records', record.id), completed = get(f.app.db, f.admin.org, 'shifts', shifts[0].id); assert.equal(approved.billingSnapshot.source, 'approval'); assert.equal(approved.billingSnapshot.serviceMinutes, 60); assert.equal(completed.status, 'completed');
  const trace = await f.occurrences(); assert.equal(trace.items[0].lockReason, '已有服務紀錄'); const body = f.payload(trace.items), before = f.state(), preview = await f.move(body); assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.preview.canCommit, true); assert.equal(preview.body.excluded.length, 1); assert.deepEqual(f.state(), before);
  const saved = await f.move(body, 'commit'); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.result.total, 2); assert.deepEqual(get(f.app.db, f.admin.org, 'service-records', record.id), approved); assert.deepEqual(get(f.app.db, f.admin.org, 'shifts', shifts[0].id), completed);
  const regeneration = await f.request(f.admin, 'POST', f.prefix + '/generation/commit', f.range, { 'Idempotency-Key': id() }); assert.equal(regeneration.status, 200, JSON.stringify(regeneration.body)); assert.equal(regeneration.body.createdCount, 0); assert.equal(regeneration.body.existingCount, 3); assert.deepEqual(get(f.app.db, f.admin.org, 'service-records', record.id), approved);
});
