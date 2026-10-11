import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, get, rows } from '../src/server/model.mjs';
import { guardShiftSeriesAccess, shiftSeriesQuery, shiftSeriesOccurrenceQuery, shiftSeriesDates, shiftSeriesOccurrenceId, commitShiftSeriesGeneration, SHIFT_SERIES_OCCURRENCE_ENTITY } from '../src/server/shift-series.mjs';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const request = async (client, method, path, payload, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const password = 'synthetic-shift-series-password', setup = await request(null, 'POST', '/api/setup', { name: '合成週期管理員', email: 'series-admin@example.test', password, organizationName: '合成永久週期甲' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], org: setup.body.organizations[0].id, csrf: setup.body.csrfToken, user: setup.body.user }, clients = { admin };
  const create = async (entity, data, client = admin) => { const response = await request(client, 'POST', '/api/' + entity, data); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item; };
  const patch = async (entity, item, data, client = admin) => { const response = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { ...data, version: item.version }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item; };
  const employeeA = await create('employees', { name: '合成週期原人員', employeeNo: 'SERIES-A' }), employeeB = await create('employees', { name: '合成週期改派人員', employeeNo: 'SERIES-B' });
  const caseA = await create('cases', { name: '合成週期個案', caseNo: 'SERIES-C' }), service = await create('service-items', { code: 'SERIES-S', name: '合成週期服務', minutes: 60, unitPriceCents: 10001 }), services = [{ serviceItemId: service.id, quantity: 2 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services });
  const definition = overrides => ({ name: '合成隔週永久週期', caseId: caseA.id, employeeId: employeeA.id, carePlanId: plan.id, startDate: '2026-10-05', endDate: '', intervalWeeks: 2, weekdays: [1, 3, 5], startTime: '09:00', endTime: '10:00', services, status: 'active', note: ' 原週期交班\r\n末行 ', ...overrides });
  const series = await create('shift-series', definition()), range = (overrides = {}) => ({ version: series.version, fromDate: '2026-10-05', toDate: '2026-10-09', ...overrides });
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = 'series-' + role + '@example.test'; await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], org: admin.org, csrf: login.body.csrfToken, user: login.body.user };
  }
  const organization = await create('organizations', { name: '合成永久週期乙' }), foreign = { ...admin, org: organization.id }, foreignCase = await create('cases', { name: '跨機構個案', caseNo: 'SERIES-FOREIGN' }, foreign);
  const state = () => Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  const prefix = '/api/shift-series/' + series.id, preview = (payload = range(), client = admin, kind = 'generation') => request(client, 'POST', prefix + '/' + kind + '/preview', payload), commit = (payload = range(), client = admin, key = id(), kind = 'generation') => request(client, 'POST', prefix + '/' + kind + '/commit', payload, { 'Idempotency-Key': key });
  const occurrences = (payload = range()) => request(admin, 'GET', prefix + '/occurrences?' + new URLSearchParams(payload));
  const adjustment = (entries, overrides = {}) => ({ ...range(), action: 'reassign', items: entries.filter(entry => entry.editable).map(entry => ({ id: entry.shiftId, version: entry.shift.version })), employeeId: employeeB.id, reason: ' 合成整組原因\n保留原文 ', ...overrides });
  return { app, base, request, create, patch, admin, clients, employeeA, employeeB, caseA, service, services, plan, series, definition, range, state, prefix, preview, commit, occurrences, adjustment, foreignCase };
}

test('malformed internal JSON and unsafe SQL versions never disappear to unlock parent/date or allow generation', async t => {
  const f = await fixture(t), saved = await f.commit(), first = saved.body.items[0].occurrence.shift;
  const link = rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY)[0], raw = f.app.db.prepare('SELECT data,version FROM records WHERE id=?').get(link.id);
  for (const corruption of ['json', 'version', 'missingLink', 'wrongId']) {
    if (corruption === 'json') f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run('{synthetic-broken', link.id);
    else if (corruption === 'version') f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(9007199254740992n, link.id);
    else if (corruption === 'missingLink') f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ date: link.date }), link.id);
    else f.app.db.prepare('INSERT INTO records SELECT ?,org_id,entity,data,version,created_at,updated_at FROM records WHERE id=?').run('synthetic-wrong-occurrence-id', link.id);
    const state = () => { const result = {}; for (const name of ['records', 'record_versions', 'audit', 'idempotency']) { const statement = f.app.db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid'); statement.setReadBigInts(true); result[name] = statement.all(); } return result; }, before = state();
    for (const response of [await f.occurrences(), await f.preview(), await f.commit(), await f.request(f.admin, 'PATCH', '/api/shifts/' + first.id, { version: first.version, date: '2026-10-06' })]) { assert.equal(response.status, 409); assert.equal(response.body.error.code, 'BROKEN_OCCURRENCE'); }
    assert.deepEqual(state(), before);
    if (corruption === 'wrongId') f.app.db.prepare('DELETE FROM records WHERE id=?').run('synthetic-wrong-occurrence-id');
    f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(raw.data, raw.version, link.id);
  }
  assert.equal((await f.occurrences()).status, 200);
});

test('permanent definition saves open-ended typed weekdays/services, exact note, CAS and immutable case/anchor; terminal status is final', async t => {
  const f = await fixture(t); assert.equal(f.series.endDate, ''); assert.equal(f.series.note, f.definition().note);
  const changed = await f.patch('shift-series', f.series, { name: '合成新名稱' }); assert.equal(changed.version, 2); assert.equal(changed.note, f.series.note);
  let before = f.state(); assert.equal((await f.request(f.admin, 'PATCH', f.prefix, { version: 1, name: 'stale' })).status, 409); assert.deepEqual(f.state(), before);
  for (const fields of [{ caseId: f.foreignCase.id }, { startDate: '2026-10-06' }]) { assert.equal((await f.request(f.admin, 'PATCH', f.prefix, { version: 2, ...fields })).status, 409); assert.deepEqual(f.state(), before); }
  const paused = await f.patch('shift-series', changed, { status: 'paused' }); before = f.state(); assert.equal((await f.preview(f.range({ version: paused.version }))).status, 409); assert.deepEqual(f.state(), before);
  const ended = await f.patch('shift-series', paused, { status: 'ended' }); before = f.state(); assert.equal((await f.request(f.admin, 'PATCH', f.prefix, { version: ended.version, status: 'active' })).status, 409); assert.deepEqual(f.state(), before);
  const history = await f.request(f.admin, 'GET', f.prefix + '/history?compare=previous'); assert.equal(history.status, 200); assert.equal(history.body.items.length, 4); assert.equal(history.body.items[0].snapshot.status, 'ended');
});

test('bounded zero-write preview creates three shifts plus closed internal versioned links atomically; ordinary shifts expose no series metadata', async t => {
  const f = await fixture(t), before = f.state(), totalChanges = f.app.db.prepare('SELECT total_changes() n').get().n;
  const preview = await f.preview(f.range(), f.clients.supervisor); assert.equal(preview.status, 200); assert.deepEqual(preview.body.items.map(item => item.date), ['2026-10-05', '2026-10-07', '2026-10-09']); assert.equal(preview.body.canCommit, true); assert.deepEqual(f.state(), before); assert.equal(f.app.db.prepare('SELECT total_changes() n').get().n, totalChanges);
  const saved = await f.commit(f.range(), f.clients.supervisor); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.createdCount, 3);
  const after = f.state(); assert.equal(after.records.length, before.records.length + 6); assert.equal(after.record_versions.length, before.record_versions.length + 6); assert.equal(after.audit.length, before.audit.length + 3); assert.equal(after.idempotency.length, before.idempotency.length + 1);
  const links = rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY); assert.equal(links.length, 3);
  for (const row of saved.body.items) {
    assert.equal(row.occurrence.seriesSnapshot.note, f.series.note); assert.equal(row.occurrence.shift.note, f.series.note); assert.equal(row.occurrence.shift.version, 1); assert.equal(row.occurrence.editable, true);
    assert.ok(!Object.hasOwn(row.occurrence.shift, 'seriesId')); assert.ok(!Object.hasOwn(row.occurrence.shift, 'batchId'));
    const link = links.find(link => link.date === row.date); assert.equal(link.id, shiftSeriesOccurrenceId(f.admin.org, f.series.id, row.date)); assert.equal(link.version, 1); assert.deepEqual(link.seriesSnapshot, f.series);
    const history = await f.request(f.admin, 'GET', '/api/shifts/' + row.occurrence.shiftId + '/history?compare=previous'); assert.equal(history.body.items[0].actor.id, f.clients.supervisor.user.id);
  }
  assert.equal((await f.request(f.admin, 'GET', '/api/shift-series-occurrences')).status, 404);
  assert.equal((await f.request(f.admin, 'POST', '/api/shift-series-occurrences', {})).status, 404);
});

test('same-key replay and overlapping periods never duplicate original dates, including cancelled dates, while a later range preserves original week anchor', async t => {
  const f = await fixture(t), key = id(), first = await f.commit(f.range(), f.admin, key); assert.equal(first.status, 200); let before = f.state();
  assert.deepEqual((await f.commit(f.range(), f.admin, key)).body, first.body); assert.deepEqual(f.state(), before);
  assert.equal((await f.commit(f.range({ toDate: '2026-10-10' }), f.admin, key)).status, 409); assert.deepEqual(f.state(), before);
  await f.patch('shifts', first.body.items[0].occurrence.shift, { status: 'cancelled' }); before = f.state(); const allExisting = await f.preview(); assert.equal(allExisting.body.canCommit, false); assert.equal(allExisting.body.existingCount, 3); assert.equal(allExisting.body.items[0].occurrence.lockReason, '班次已取消'); assert.deepEqual(f.state(), before);
  const noNew = await f.commit(); assert.equal(noNew.status, 200); assert.equal(noNew.body.createdCount, 0); assert.equal(f.state().records.length, before.records.length); assert.equal(f.state().record_versions.length, before.record_versions.length);
  const more = await f.commit(f.range({ toDate: '2026-10-19' })); assert.equal(more.status, 200); assert.equal(more.body.createdCount, 1); assert.equal(more.body.existingCount, 3); assert.equal(more.body.items.at(-1).date, '2026-10-19');
  assert.equal(rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY).length, 4);
});

test('template edit affects only future uncreated dates and immutable generation snapshot records remain unchanged', async t => {
  const f = await fixture(t), first = await f.commit(), originalLinks = rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY), originalShifts = first.body.items.map(row => row.occurrence.shift);
  const changed = await f.patch('shift-series', f.series, { employeeId: f.employeeB.id, note: ' 新模板\r\n原文 ', endDate: '2026-10-20' });
  const before = f.state(); assert.equal((await f.commit()).status, 409); assert.deepEqual(f.state(), before);
  const next = await f.commit(f.range({ version: changed.version, fromDate: '2026-10-19', toDate: '2026-10-23' })); assert.equal(next.status, 200); assert.equal(next.body.createdCount, 1); assert.equal(next.body.items[0].occurrence.shift.employeeId, f.employeeB.id); assert.equal(next.body.items[0].occurrence.seriesVersion, 2);
  assert.deepEqual(rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY).filter(item => originalLinks.some(old => old.id === item.id)), originalLinks);
  for (const old of originalShifts) assert.deepEqual(get(f.app.db, f.admin.org, 'shifts', old.id), old);
});

test('closed payload/query/date/time/services rules and role guard reject before any write or foreign parent disclosure', async t => {
  const f = await fixture(t), before = f.state();
  for (const role of ['finance', 'caregiver']) {
    assert.equal((await f.request(f.clients[role], 'GET', '/api/shift-series')).status, 403);
    for (const path of [f.prefix + '/generation/preview', f.prefix + '/generation/commit', f.prefix + '/adjustments/preview', f.prefix + '/adjustments/commit']) assert.equal((await f.request(f.clients[role], 'POST', path, [], { 'Idempotency-Key': id() })).status, 403);
  }
  for (const fields of [{ startDate: '0000-01-01' }, { endDate: '2026-02-30' }, { startTime: '23:00', endTime: '02:00' }, { startTime: '09:00\n' }, { endTime: '10:00\r\n' }, { intervalWeeks: 5 }, { intervalWeeks: '2' }, { weekdays: [1, 1] }, { weekdays: [1.5] }, { note: '字'.repeat(10001) }, { employeeId: ' ' + f.employeeA.id }, { services: [{ serviceItemId: f.service.id, quantity: 1, hidden: 1 }] }, { hidden: true }, { caseId: f.foreignCase.id }]) assert.ok([409, 422].includes((await f.request(f.admin, 'POST', '/api/shift-series', f.definition(fields))).status));
  for (const fields of [{ version: '1' }, { fromDate: '0000-01-01' }, { toDate: '2027-01-10' }, { hidden: true }]) assert.equal((await f.preview(f.range(fields))).status, 422);
  for (const query of ['q=x&q=y', 'status=scheduled', 'pageSize=101', 'hidden=x', 'page=1%0A', 'pageSize=25%0D%0A']) assert.equal((await f.request(f.admin, 'GET', '/api/shift-series?' + query)).status, 422);
  for (const query of ['page=1%0A', 'page=1e0', 'pageSize=25%0D%0A', 'pageSize=2.5', 'page=1&page=2', 'hidden=x']) assert.equal((await f.request(f.admin, 'GET', f.prefix + '/history?' + query)).status, 422);
  for (const version of ['1%0A', '1%0D%0A']) assert.equal((await f.request(f.admin, 'GET', f.prefix + '/occurrences?fromDate=2026-10-05&toDate=2026-10-09&version=' + version)).status, 422);
  assert.equal((await f.request(f.admin, 'POST', f.prefix + '/generation/preview?hidden=x', f.range())).status, 422);
  assert.equal((await f.request(f.admin, 'POST', f.prefix + '/generation/commit', f.range())).status, 422);
  assert.deepEqual(f.state(), before);
});

test('commit rechecks plan window, service validity, current status, approved leave and another conflicting shift without partial generation', async t => {
  const f = await fixture(t); assert.equal((await f.preview()).body.canCommit, true);
  await f.patch('service-items', f.service, { validTo: '2026-10-06' }); let before = f.state(); const serviceConflict = await f.commit(); assert.equal(serviceConflict.status, 409); assert.equal(serviceConflict.body.error.details.preview.items[1].conflicts[0].code, 'INACTIVE_SERVICE'); assert.deepEqual(f.state(), before);
  const serviceNow = get(f.app.db, f.admin.org, 'service-items', f.service.id); await f.patch('service-items', serviceNow, { validTo: '' });
  await f.patch('care-plans', f.plan, { validTo: '2026-10-06' }); before = f.state(); assert.equal((await f.commit()).status, 409); assert.deepEqual(f.state(), before);
  await f.patch('care-plans', get(f.app.db, f.admin.org, 'care-plans', f.plan.id), { validTo: '2027-12-31' });
  await f.create('leave-requests', { employeeId: f.employeeA.id, date: '2026-10-07', startTime: '09:00', endTime: '10:00', type: '合成核准假別', status: 'approved' }); before = f.state(); const leaveConflict = await f.commit(); assert.equal(leaveConflict.status, 409); assert.equal(leaveConflict.body.error.details.preview.items[1].conflicts[0].code, 'LEAVE_CONFLICT'); assert.deepEqual(f.state(), before);
});

test('generation SQL failure after first complete occurrence rolls back shifts/internal links/versions/audit/key and same key retries', async t => {
  const f = await fixture(t), before = f.state(), key = id();
  f.app.db.exec(`CREATE TEMP TRIGGER synthetic_series_failure BEFORE INSERT ON records WHEN NEW.entity='shift-series-occurrences' AND json_extract(NEW.data,'$.date')='2026-10-07' BEGIN SELECT RAISE(ABORT,'synthetic series link failure'); END;`);
  assert.equal((await f.commit(f.range(), f.admin, key)).status, 500); assert.deepEqual(f.state(), before); f.app.db.exec('DROP TRIGGER synthetic_series_failure');
  const retry = await f.commit(f.range(), f.admin, key); assert.equal(retry.status, 200); assert.equal(retry.body.createdCount, 3);
});

test('group exact selection protects every recorded shift, rereads fresh versions, and atomically reassigns then cancels without modifying template or trace', async t => {
  const f = await fixture(t), generated = await f.commit(); assert.equal(generated.status, 200); let links = (await f.occurrences()).body.items;
  const first = links[0].shift; await f.create('service-records', { shiftId: first.id, caseId: first.caseId, employeeId: first.employeeId, date: first.date, actualStart: first.startTime, actualEnd: first.endTime, services: first.services, status: 'draft' });
  links = (await f.occurrences()).body.items; assert.equal(links[0].editable, false); const definition = f.adjustment(links), template = get(f.app.db, f.admin.org, 'shift-series', f.series.id), internal = rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY), before = f.state();
  const preview = await f.preview(definition, f.admin, 'adjustments'); assert.equal(preview.status, 200); assert.equal(preview.body.excluded.length, 1); assert.equal(preview.body.preview.readyCount, 2); assert.deepEqual(f.state(), before);
  assert.equal((await f.commit({ ...definition, items: definition.items.slice(0, 1) }, f.admin, id(), 'adjustments')).status, 409); assert.deepEqual(f.state(), before);
  const saved = await f.commit(definition, f.clients.supervisor, id(), 'adjustments'); assert.equal(saved.status, 200); assert.ok(saved.body.result.items.every(item => item.employeeId === f.employeeB.id && item.note === f.series.note)); assert.deepEqual(get(f.app.db, f.admin.org, 'shifts', first.id), first);
  links = (await f.occurrences()).body.items; const cancellation = f.adjustment(links, { action: 'cancel' }); delete cancellation.employeeId;
  const cancelled = await f.commit(cancellation, f.admin, id(), 'adjustments'); assert.equal(cancelled.status, 200); assert.ok(cancelled.body.result.items.every(item => item.status === 'cancelled')); assert.equal((await f.commit(definition, f.admin, id(), 'adjustments')).status, 409);
  assert.deepEqual(get(f.app.db, f.admin.org, 'shift-series', f.series.id), template); assert.deepEqual(rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY), internal);
});

test('series-only same-day group time reschedule has full conflict/leave checks, exact CAS/reason and no change to dates/template/links', async t => {
  const f = await fixture(t); await f.commit(); let links = (await f.occurrences()).body.items, definition = f.adjustment(links, { action: 'reschedule', startTime: '11:00', endTime: '12:00' }); delete definition.employeeId;
  const before = f.state(), preview = await f.preview(definition, f.admin, 'adjustments'); assert.equal(preview.status, 200); assert.equal(preview.body.preview.canCommit, true); assert.deepEqual(f.state(), before);
  const result = await f.commit(definition, f.admin, id(), 'adjustments'); assert.equal(result.status, 200); assert.ok(result.body.result.items.every(item => item.startTime === '11:00' && item.endTime === '12:00' && item.version === 2 && item.note === f.series.note));
  links = (await f.occurrences()).body.items; const overlap = await f.create('shifts', { caseId: f.caseA.id, employeeId: f.employeeA.id, carePlanId: f.plan.id, date: links[1].date, startTime: '13:00', endTime: '14:00', services: f.services });
  definition = f.adjustment(links, { action: 'reschedule', startTime: '13:30', endTime: '14:30' }); delete definition.employeeId; let zero = f.state(); assert.equal((await f.commit(definition, f.admin, id(), 'adjustments')).status, 409); assert.deepEqual(f.state(), zero);
  await f.patch('shifts', overlap, { status: 'cancelled' }); await f.create('leave-requests', { employeeId: f.employeeA.id, date: links[0].date, startTime: '13:00', endTime: '14:00', type: '合成時段假別', status: 'approved' }); zero = f.state(); const conflict = await f.preview(definition, f.admin, 'adjustments'); assert.equal(conflict.body.preview.items[0].conflicts[0].code, 'LEAVE_CONFLICT'); assert.deepEqual(f.state(), zero);
});

test('linked shifts keep original case/date, malformed internal links fail closed, and all lower-level guards reject before storage', async t => {
  const f = await fixture(t); const saved = await f.commit(), first = saved.body.items[0].occurrence.shift, before = f.state();
  assert.equal((await f.request(f.admin, 'PATCH', '/api/shifts/' + first.id, { version: 1, date: '2026-10-06' })).status, 409); assert.deepEqual(f.state(), before);
  const link = rows(f.app.db, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY)[0]; f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...Object.fromEntries(Object.entries(link).filter(([key]) => !['id', 'orgId', 'version', 'createdAt', 'updatedAt'].includes(key))), hidden: true }), link.id);
  assert.equal((await f.occurrences()).status, 409); assert.equal((await f.preview()).body.error.code, 'BROKEN_OCCURRENCE');
  assert.throws(() => guardShiftSeriesAccess('shift-series', { role: 'finance' }, false), error => error.status === 403);
  assert.throws(() => commitShiftSeriesGeneration(null, { role: 'caregiver' }, f.series.id, {}), error => error.status === 403);
  assert.throws(() => commitShiftSeriesGeneration(f.app.db, { role: 'admin' }, f.series.id, {}), error => error.code === 'SERIES_TRANSACTION_REQUIRED');
  for (const params of ['hidden=x', 'page=01', 'q=a&q=b']) assert.throws(() => shiftSeriesQuery('shift-series', new URLSearchParams(params)), error => error.status === 422);
  assert.throws(() => shiftSeriesOccurrenceQuery(new URLSearchParams('version=1&fromDate=2026-10-05&toDate=2026-10-09&fromDate=2026-10-06')), error => error.status === 422);
  assert.deepEqual(shiftSeriesDates(f.series, { fromDate: '2026-10-12', toDate: '2026-10-23' }), ['2026-10-19', '2026-10-21', '2026-10-23']);
});
