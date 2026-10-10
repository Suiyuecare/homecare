import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, insert, business } from '../src/server/model.mjs';

const password = 'synthetic-shift-history-password';
const noPrevious = status => ({ status, previousVersion: null, previousSnapshot: null });
const historyUrl = (item, query = 'compare=previous', entity = 'shifts') =>
  '/api/' + entity + '/' + item.id + '/history' + (query ? '?' + query : '');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 });
  const base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data) {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: base,
        ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', {
    name: '合成排班管理員', email: 'shift-history-admin@example.test', password, organizationName: '合成排班歷程甲機構',
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const clientFrom = response => ({
    cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken,
    org: setup.body.organizations[0].id, user: response.body.user,
  });
  const admin = clientFrom(setup);
  async function create(entity, data, client = admin) {
    const response = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.item;
  }
  async function patch(entity, item, data, client = admin) {
    const response = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.item;
  }
  const employeeA = await create('employees', { name: '合成居服甲', employeeNo: 'TEST-SH-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成居服乙', employeeNo: 'TEST-SH-B', hourlyRateCents: 26000 });
  const clients = { admin };
  for (const [key, role, employee] of [
    ['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB],
  ]) {
    const email = key + '@shift-history.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password });
    assert.equal(login.status, 200);
    clients[key] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-SH-CA' });
  const caseB = await create('cases', { name: '合成個案乙', caseNo: 'TEST-SH-CB' });
  const serviceA = await create('service-items', { code: 'TEST-SH-SA', name: '合成服務甲', minutes: 60, unitPriceCents: 10000 });
  const serviceB = await create('service-items', { code: 'TEST-SH-SB', name: '合成服務乙', minutes: 30, unitPriceCents: 5000 });
  const services = [{ serviceItemId: serviceA.id, quantity: 1 }];
  const planData = caseId => ({
    caseId, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active',
    services: [{ serviceItemId: serviceA.id, quantity: 30 }, { serviceItemId: serviceB.id, quantity: 30 }],
  });
  const planA = await create('care-plans', planData(caseA.id));
  const planB = await create('care-plans', planData(caseB.id));
  const shiftData = {
    caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08',
    startTime: '09:00', endTime: '10:00', services, status: 'scheduled', note: '合成建立',
  };
  const shift = await create('shifts', shiftData);
  function auditEvent({ orgId = admin.org, entity = 'shifts', recordId = shift.id, userId = admin.user.id, action = 'record.update', detail = {} } = {}) {
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, JSON.stringify(detail), now());
  }
  function counts() {
    const result = { changes: app.db.prepare('SELECT total_changes() AS n').get().n };
    for (const table of ['records', 'record_versions', 'audit', 'idempotency']) {
      result[table] = app.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
    }
    return result;
  }
  function savedState() {
    return {
      records: app.db.prepare('SELECT * FROM records ORDER BY id').all(),
      versions: app.db.prepare('SELECT * FROM record_versions ORDER BY record_id,version').all(),
    };
  }
  function addSnapshot(item, version, changes = {}, source = 'baseline') {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(
      admin.org, 'shifts', item.id, version, JSON.stringify(snapshot), now(), source,
    );
    return snapshot;
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, caseA, caseB,
    serviceA, serviceB, services, planA, planB, shiftData, shift, auditEvent, counts, savedState, addSnapshot };
}

test('real reassignment A to B to A preserves snapshots and hides inaccessible predecessor without skipping', async t => {
  const f = await fixture(t);
  const v2 = await f.patch('shifts', f.shift, {
    employeeId: f.employeeB.id, date: '2026-10-09', startTime: '11:00', endTime: '12:30',
    services: [{ serviceItemId: f.serviceB.id, quantity: 2 }], note: 'PRIVATE-B-ASSIGNMENT',
  }, f.clients.supervisor);
  assert.equal((await f.request(f.clients.carerA, 'GET', historyUrl(v2))).status, 404);
  const bHistory = await f.request(f.clients.carerB, 'GET', historyUrl(v2));
  assert.equal(bHistory.status, 200); assert.equal(bHistory.body.total, 1);
  assert.equal(bHistory.body.items[0].version, 2);
  assert.deepEqual(bHistory.body.items[0].comparison, noPrevious('unavailable'));
  const v3 = await f.patch('shifts', v2, { employeeId: f.employeeA.id, note: '合成改回甲' });
  const before = f.counts(), state = f.savedState();
  for (const query of ['', 'compare=previous']) {
    const own = await f.request(f.clients.carerA, 'GET', historyUrl(v3, query));
    assert.equal(own.status, 200); assert.equal(own.body.total, 2);
    assert.deepEqual(own.body.items.map(row => row.version), [3, 1]);
    assert.ok(!JSON.stringify(own.body).includes('PRIVATE-B-ASSIGNMENT'));
    assert.ok(!JSON.stringify(own.body).includes(f.employeeB.id));
    if (query) {
      assert.deepEqual(own.body.items[0].comparison, noPrevious('unavailable'));
      assert.deepEqual(own.body.items[1].comparison, noPrevious('initial'));
    } else assert.ok(own.body.items.every(row => !Object.hasOwn(row, 'comparison') && !Object.hasOwn(row, 'actor')));
    assert.equal((await f.request(f.clients.carerB, 'GET', historyUrl(v3, query))).status, 404);
    for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) {
      const privileged = await f.request(client, 'GET', historyUrl(v3, query));
      assert.equal(privileged.status, 200); assert.equal(privileged.body.total, 3);
      const [last, changed, original] = privileged.body.items;
      assert.equal(changed.snapshot.employeeId, f.employeeB.id);
      assert.equal(changed.snapshot.date, '2026-10-09'); assert.equal(changed.snapshot.startTime, '11:00');
      assert.equal(changed.snapshot.endTime, '12:30');
      assert.deepEqual(changed.snapshot.services, [{ serviceItemId: f.serviceB.id, quantity: 2 }]);
      assert.deepEqual(original.snapshot, f.shift);
      if (query) {
        assert.deepEqual(last.comparison.previousSnapshot, changed.snapshot);
        assert.deepEqual(changed.comparison.previousSnapshot, original.snapshot);
        assert.deepEqual(changed.actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name });
      }
    }
  }
  assert.deepEqual(f.counts(), before); assert.deepEqual(f.savedState(), state);
  const cancelled = await f.patch('shifts', v3, { status: 'cancelled', note: '合成取消' }, f.clients.supervisor);
  const cancelledHistory = await f.request(f.clients.carerA, 'GET', historyUrl(cancelled));
  assert.equal(cancelledHistory.body.items[0].snapshot.status, 'cancelled');
  assert.equal(cancelledHistory.body.items[0].comparison.previousSnapshot.status, 'scheduled');
  assert.deepEqual(cancelledHistory.body.items.map(row => row.version), [4, 3, 1]);
});

test('same employee changing case filters all raw and compared history until another own shift restores old case visibility', async t => {
  const f = await fixture(t);
  const moved = await f.patch('shifts', f.shift, { caseId: f.caseB.id, carePlanId: f.planB.id, note: '合成換案' }, f.clients.supervisor);
  for (const query of ['', 'compare=previous']) {
    const own = await f.request(f.clients.carerA, 'GET', historyUrl(moved, query));
    assert.equal(own.status, 200); assert.deepEqual(own.body.items.map(row => row.version), [2]);
    assert.ok(!JSON.stringify(own.body).includes(f.caseA.id)); assert.ok(!JSON.stringify(own.body).includes(f.planA.id));
    if (query) assert.deepEqual(own.body.items[0].comparison, noPrevious('unavailable'));
    for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) {
      const full = await f.request(client, 'GET', historyUrl(moved, query));
      assert.equal(full.status, 200); assert.equal(full.body.total, 2);
      assert.equal(full.body.items[1].snapshot.caseId, f.caseA.id, 'historical case may differ from current case');
    }
  }
  await f.create('shifts', { ...f.shiftData, status: 'cancelled', note: '合成另一已取消班，沿既有個案授權' });
  const before = f.counts();
  const visibleAgain = await f.request(f.clients.carerA, 'GET', historyUrl(moved));
  assert.equal(visibleAgain.body.total, 2);
  assert.equal(visibleAgain.body.items[0].comparison.status, 'available');
  assert.equal(visibleAgain.body.items[0].comparison.previousSnapshot.caseId, f.caseA.id);
  assert.equal((await f.request(f.clients.carerA, 'GET', historyUrl(moved, ''))).body.total, 2);
  assert.deepEqual(f.counts(), before);
});

test('all roles reject missing or foreign historical cases and compare only the filtered exact predecessor', async t => {
  const f = await fixture(t);
  const otherOrg = await f.create('organizations', { name: '合成排班歷程乙機構' });
  const otherAdmin = { ...f.admin, org: otherOrg.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'TEST-FOREIGN' }, otherAdmin);
  const missingCaseId = id();
  f.addSnapshot(f.shift, 2, { caseId: missingCaseId, note: 'PRIVATE-MISSING-CASE' });
  f.addSnapshot(f.shift, 3, { caseId: foreignCase.id, note: 'PRIVATE-FOREIGN-HISTORY' });
  const current = f.addSnapshot(f.shift, 4, { note: '合成第4版' });
  f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(JSON.stringify(business(current)), 4, f.shift.id);
  const before = f.counts();
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    for (const query of ['', 'compare=previous']) {
      const result = await f.request(client, 'GET', historyUrl(current, query));
      assert.equal(result.status, 200); assert.equal(result.body.total, 2);
      assert.deepEqual(result.body.items.map(row => row.version), [4, 1]);
      const serialized = JSON.stringify(result.body);
      for (const secret of [missingCaseId, foreignCase.id, 'PRIVATE-MISSING-CASE', 'PRIVATE-FOREIGN-HISTORY']) assert.ok(!serialized.includes(secret));
      if (query) assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable'));
    }
  }
  assert.equal((await f.request(otherAdmin, 'GET', historyUrl(current))).status, 404);
  assert.equal((await f.request(f.clients.carerB, 'GET', historyUrl(current))).status, 404);
  assert.equal((await f.request(f.admin, 'GET', historyUrl({ id: id() }))).status, 404);
  assert.deepEqual(f.counts(), before);
});

test('real review completion resolves reviewer identity and reads leave immutable billing and existing write restrictions intact', async t => {
  const f = await fixture(t);
  const record = await f.create('service-records', {
    shiftId: f.shift.id, caseId: f.caseA.id, employeeId: f.employeeA.id, date: f.shift.date,
    actualStart: '09:00', actualEnd: '10:00', services: f.services, status: 'submitted',
  }, f.clients.carerA);
  for (const changes of [
    { employeeId: f.employeeB.id }, { caseId: f.caseB.id, carePlanId: f.planB.id },
    { date: '2026-10-09' }, { startTime: '09:30', endTime: '10:30' },
    { services: [{ serviceItemId: f.serviceA.id, quantity: 2 }] }, { status: 'cancelled' },
  ]) {
    const blocked = await f.request(f.admin, 'PATCH', '/api/shifts/' + f.shift.id, { version: 1, ...changes });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body)); assert.equal(blocked.body.error.code, 'SHIFT_HAS_RECORD');
  }
  const review = await f.request(f.clients.supervisor, 'POST', '/api/service-records/' + record.id + '/review', {
    version: record.version, decision: 'approved', reviewNote: '合成督導核閱',
  });
  assert.equal(review.status, 200); assert.ok(!Object.hasOwn(review.body.item, 'billingSnapshot'));
  const approved = (await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item;
  assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000);
  assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 10000);
  const completed = (await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item;
  assert.equal(completed.status, 'completed'); assert.equal(completed.version, 2);
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999 });
  await f.patch('service-items', f.serviceA, { unitPriceCents: 88888 });
  const before = f.counts(), state = f.savedState();
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const result = await f.request(client, 'GET', historyUrl(f.shift));
    assert.equal(result.status, 200);
    const row = result.body.items[0];
    assert.deepEqual(row.actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name });
    assert.equal(row.snapshot.status, 'completed'); assert.equal(row.comparison.previousSnapshot.status, 'scheduled');
    assert.ok(!JSON.stringify(result.body).includes('billingSnapshot'));
    assert.deepEqual((await f.request(client, 'GET', historyUrl(f.shift, ''))).body.items.map(item => item.snapshot), result.body.items.map(item => item.snapshot));
  }
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item, approved);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body.totals.amountCents, 10000);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body.totals.amountCents, 24000);
  assert.deepEqual(f.counts(), before); assert.deepEqual(f.savedState(), state);
  const denied = await f.request(f.admin, 'PATCH', '/api/shifts/' + f.shift.id, { version: completed.version, employeeId: f.employeeB.id });
  assert.equal(denied.status, 409); assert.equal(denied.body.error.code, 'SHIFT_HAS_RECORD');
  const annotated = await f.patch('shifts', completed, { note: '合成核閱後補交班備註' }, f.clients.supervisor);
  assert.equal(annotated.version, 3); assert.equal(annotated.status, 'completed');
});

test('actor evidence requires exact scope, integer version and allowed action; absent or conflicting actual identities remain unknown', async t => {
  const f = await fixture(t);
  const updated = await f.patch('shifts', f.shift, { note: '合成督導第2版' }, f.clients.supervisor);
  const otherOrg = await f.create('organizations', { name: '合成錯誤稽核範圍' });
  for (const event of [
    { orgId: otherOrg.id }, { entity: 'cases' }, { recordId: f.caseA.id },
    { action: 'shift.complete', orgId: otherOrg.id },
    { action: 'shift.complete', entity: 'cases' },
    { action: 'shift.complete', recordId: f.caseA.id },
    { action: 'service.review' }, { action: 'shift.complete', detail: { version: '2' } },
    { action: 'shift.complete', detail: { version: 2.5 } }, { detail: { version: 99 } }, { detail: {} },
  ]) f.auditEvent({ detail: { version: 2 }, ...event });
  let result = await f.request(f.admin, 'GET', historyUrl(updated));
  assert.equal(result.body.items[0].actor.id, f.clients.supervisor.user.id);
  f.auditEvent({ action: 'shift.complete', userId: f.clients.supervisor.user.id, detail: { version: 2 } });
  result = await f.request(f.admin, 'GET', historyUrl(updated));
  assert.equal(result.body.items[0].actor.id, f.clients.supervisor.user.id, 'duplicate same-user evidence is not ambiguous');
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成督導目前姓名', f.clients.supervisor.user.id);
  assert.equal((await f.request(f.admin, 'GET', historyUrl(updated))).body.items[0].actor.name, '合成督導目前姓名');
  f.auditEvent({ action: 'shift.complete', detail: { version: 2 } });
  assert.equal((await f.request(f.admin, 'GET', historyUrl(updated))).body.items[0].actor, null, 'different actual users for one version are ambiguous');
  f.auditEvent({ action: 'shift.complete', userId: 'missing-synthetic-user', detail: { version: 1 } });
  assert.equal((await f.request(f.admin, 'GET', historyUrl(updated))).body.items[1].actor, null);
  f.auditEvent({ entity: 'cases', recordId: f.caseA.id, userId: f.clients.supervisor.user.id, action: 'shift.complete', detail: { version: 1 } });
  const caseHistory = await f.request(f.admin, 'GET', historyUrl(f.caseA, 'compare=previous', 'cases'));
  assert.equal(caseHistory.body.items[0].actor.id, f.admin.user.id, 'shift.complete does not become actor evidence for other entities');
});

test('unattributed baselines and absent versions do not infer actors or skip a missing predecessor', async t => {
  const f = await fixture(t);
  const recordId = id(), timestamp = now();
  const data = { ...f.shiftData, date: '2026-10-12', note: '合成遷移基準第3版' };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, 'shifts', JSON.stringify(data), 3, timestamp, timestamp);
  const current = { ...data, id: recordId, orgId: f.admin.org, version: 3, createdAt: timestamp, updatedAt: timestamp };
  f.addSnapshot(current, 3); f.addSnapshot(current, 1, { note: '合成舊第1版' });
  f.auditEvent({ recordId, action: 'shift.complete', detail: { version: '3' } });
  const before = f.counts();
  for (const client of [f.admin, f.clients.carerA]) {
    const response = await f.request(client, 'GET', historyUrl(current));
    assert.equal(response.status, 200); assert.deepEqual(response.body.items.map(row => row.version), [3, 1]);
    assert.deepEqual(response.body.items[0].comparison, noPrevious('unavailable'));
    assert.deepEqual(response.body.items[1].comparison, noPrevious('initial'));
    assert.ok(response.body.items.every(row => row.actor === null && row.source === 'baseline'));
  }
  assert.deepEqual(f.counts(), before);
});

test('28 real versions compare across pagination while raw shape, validation, CAS and append-only storage stay unchanged', async t => {
  const f = await fixture(t);
  const unsupported = await f.create('announcements', { title: '合成仍不支援比較的公告', body: '保留原比較拒絕驗收' });
  let current = f.shift;
  for (let version = 2; version <= 28; version++) {
    current = await f.patch('shifts', current, { note: '合成第' + version + '版交班備註' }, version % 2 ? f.admin : f.clients.supervisor);
  }
  const before = f.counts(), state = f.savedState();
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const first = await f.request(client, 'GET', historyUrl(current, 'compare=previous&page=1&pageSize=25'));
    const second = await f.request(client, 'GET', historyUrl(current, 'compare=previous&page=2&pageSize=25'));
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(first.body.total, 28); assert.equal(second.body.total, 28);
    assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
    const boundary = first.body.items.at(-1);
    assert.equal(boundary.version, 4); assert.equal(boundary.comparison.previousVersion, 3);
    assert.deepEqual(boundary.comparison.previousSnapshot, second.body.items[0].snapshot);
    assert.deepEqual(second.body.items.at(-1).comparison, noPrevious('initial'));
    const raw = await f.request(client, 'GET', historyUrl(current, 'page=2&pageSize=25'));
    assert.ok(raw.body.items.every(row => !Object.hasOwn(row, 'comparison') && !Object.hasOwn(row, 'actor')));
    assert.deepEqual(raw.body.items.map(row => row.snapshot), second.body.items.map(row => row.snapshot));
  }
  for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) {
    const result = await f.request(f.admin, 'GET', historyUrl(current, query));
    assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_COMPARE');
  }
  assert.equal((await f.request(f.admin, 'GET', historyUrl(unsupported, 'compare=next', 'announcements'))).status, 422);
  assert.deepEqual(f.counts(), before); assert.deepEqual(f.savedState(), state);
  for (const client of [f.clients.carerA, f.clients.finance]) {
    const blocked = await f.request(client, 'PATCH', '/api/shifts/' + current.id, { version: current.version, note: '不可写' });
    assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'ROLE_FORBIDDEN');
  }
  const stale = await f.request(f.admin, 'PATCH', '/api/shifts/' + current.id, { version: 1, note: '合成過期輸入' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(f.savedState(), state);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', current.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(current.id), /immutable/);
});

test('both compared and raw shift snapshots retain financial projection for every role', async t => {
  const f = await fixture(t);
  const internal = insert(f.app.db, f.admin.org, 'shifts', {
    ...f.shiftData, date: '2026-10-20', billingSnapshot: { employee: { hourlyRateCents: 987654321 }, marker: 'PRIVATE-FINANCIAL-MARKER' },
  });
  const updated = await f.patch('shifts', internal, { note: '合成新版本仍須遮罩' });
  const before = f.counts();
  for (const client of [f.clients.supervisor, f.clients.carerA, f.admin, f.clients.finance]) {
    for (const query of ['', 'compare=previous']) {
      const response = await f.request(client, 'GET', historyUrl(updated, query));
      assert.equal(response.status, 200); assert.equal(response.body.total, 2);
      const hasFinancialAccess = [f.admin, f.clients.finance].includes(client);
      for (const row of response.body.items) {
        assert.equal(Object.hasOwn(row.snapshot, 'billingSnapshot'), hasFinancialAccess);
        if (row.comparison?.previousSnapshot) assert.equal(Object.hasOwn(row.comparison.previousSnapshot, 'billingSnapshot'), hasFinancialAccess);
      }
      if (!hasFinancialAccess) assert.ok(!JSON.stringify(response.body).includes('PRIVATE-FINANCIAL-MARKER'));
    }
  }
  assert.deepEqual(f.counts(), before);
});
