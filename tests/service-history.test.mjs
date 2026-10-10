import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, insert, business } from '../src/server/model.mjs';

const password = 'synthetic-service-history-password';
const noPrevious = status => ({ status, previousVersion: null, previousSnapshot: null });
const historyUrl = (item, query = 'compare=previous', entity = 'service-records') => '/api/' + entity + '/' + item.id + '/history' + (query ? '?' + query : '');
const actor = client => ({ id: client.user.id, name: client.user.name });

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data) {
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成服務歷程管理員', email: 'service-history-admin@example.test', password, organizationName: '合成服務歷程甲機構' });
  assert.equal(setup.status, 201);
  const clientFrom = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = clientFrom(setup);
  async function create(entity, data, caller = admin) {
    const response = await request(caller, 'POST', '/api/' + entity, data); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const response = await request(caller, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  async function review(item, decision, reviewNote, caller = clients.supervisor) {
    const response = await request(caller, 'POST', '/api/service-records/' + item.id + '/review', { version: item.version, decision, reviewNote }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const employeeA = await create('employees', { name: '合成居服甲', employeeNo: 'TEST-SVH-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成居服乙', employeeNo: 'TEST-SVH-B', hourlyRateCents: 26000 });
  const clients = { admin };
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB]]) {
    const email = key + '@service-history.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[key] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成個案甲', caseNo: 'TEST-SVH-CA' }), caseB = await create('cases', { name: '合成個案乙', caseNo: 'TEST-SVH-CB' });
  const serviceA = await create('service-items', { code: 'TEST-SVH-SA', name: '合成服務甲', minutes: 60, unitPriceCents: 10000 }), serviceB = await create('service-items', { code: 'TEST-SVH-SB', name: '合成服務乙', minutes: 30, unitPriceCents: 5000 });
  const services = [{ serviceItemId: serviceA.id, quantity: 1 }, { serviceItemId: serviceB.id, quantity: 2 }];
  const planData = caseId => ({ caseId, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: serviceA.id, quantity: 30 }, { serviceItemId: serviceB.id, quantity: 30 }] });
  const planA = await create('care-plans', planData(caseA.id)), planB = await create('care-plans', planData(caseB.id));
  const shiftData = { caseId: caseA.id, employeeId: employeeA.id, carePlanId: planA.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services, status: 'scheduled', note: '合成班次' };
  const shift = await create('shifts', shiftData);
  const recordData = { shiftId: shift.id, caseId: caseA.id, employeeId: employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: serviceA.id, quantity: 3 }, { serviceItemId: serviceB.id, quantity: 1 }], status: 'draft', note: '合成草稿' };
  const record = await create('service-records', recordData, clients.carerA);
  function auditEvent({ orgId = admin.org, entity = 'service-records', recordId = record.id, userId = admin.user.id, action = 'service.review', detail = {}, rawDetail } = {}) {
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, rawDetail ?? JSON.stringify(detail), now());
  }
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'].map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  function addSnapshot(item, version, changes = {}, source = 'baseline') {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(admin.org, 'service-records', item.id, version, JSON.stringify(snapshot), now(), source);
    return snapshot;
  }
  return { app, request, create, patch, review, admin, clients, employeeA, employeeB, caseA, caseB, serviceA, serviceB, services, planA, planB, shiftData, shift, recordData, record, auditEvent, state, addSnapshot };
}

test('real draft, submit, supervisor return, resubmit and admin approval preserve exact actors and actual service changes', async t => {
  const f = await fixture(t);
  const submitted = await f.patch('service-records', f.record, { status: 'submitted', note: '合成送交' }, f.clients.carerA);
  const returned = await f.review(submitted, 'returned', '合成督導退回請補記');
  const resubmitted = await f.patch('service-records', returned, { status: 'submitted', actualEnd: '09:52', services: [{ serviceItemId: f.serviceA.id, quantity: 4 }, { serviceItemId: f.serviceB.id, quantity: 1 }], note: '合成修正重送' }, f.clients.carerA);
  const approved = await f.review(resubmitted, 'approved', '合成管理者核准', f.admin);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const result = await f.request(caller, 'GET', historyUrl(approved)); assert.equal(result.status, 200); assert.equal(result.body.total, 5);
    const items = result.body.items;
    assert.deepEqual(items.map(row => row.version), [5, 4, 3, 2, 1]);
    assert.deepEqual(items.map(row => row.actor), [actor(f.admin), actor(f.clients.carerA), actor(f.clients.supervisor), actor(f.clients.carerA), actor(f.clients.carerA)]);
    assert.deepEqual(items.map(row => row.snapshot.status), ['approved', 'submitted', 'returned', 'submitted', 'draft']);
    assert.equal(items[0].snapshot.reviewNote, '合成管理者核准'); assert.equal(items[2].snapshot.reviewNote, '合成督導退回請補記');
    assert.equal(items[1].snapshot.actualEnd, '09:52'); assert.equal(items[2].snapshot.actualEnd, '09:50');
    assert.equal(items[1].snapshot.services[0].quantity, 4); assert.equal(items[2].snapshot.services[0].quantity, 3);
    for (let i = 0; i < items.length - 1; i++) { assert.equal(items[i].comparison.status, 'available'); assert.equal(items[i].comparison.previousVersion, items[i].version - 1); assert.deepEqual(items[i].comparison.previousSnapshot, items[i + 1].snapshot); }
    assert.deepEqual(items.at(-1).comparison, noPrevious('initial'));
    const raw = await f.request(caller, 'GET', historyUrl(approved, '')); assert.deepEqual(raw.body.items.map(row => row.snapshot), items.map(row => row.snapshot)); assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  const completedHistory = await f.request(f.admin, 'GET', historyUrl(f.shift, 'compare=previous', 'shifts'));
  assert.deepEqual(completedHistory.body.items[0].actor, actor(f.admin)); assert.equal(completedHistory.body.items[0].snapshot.status, 'completed');
  assert.deepEqual(f.state(), before);
});

test('real draft reassignment through valid shifts A to B to A hides other employee versions and never skips predecessors', async t => {
  const f = await fixture(t);
  const otherShift = await f.create('shifts', { ...f.shiftData, employeeId: f.employeeB.id, date: '2026-10-09', startTime: '11:00', endTime: '12:00' });
  const v2 = await f.patch('service-records', f.record, { shiftId: otherShift.id, employeeId: f.employeeB.id, date: otherShift.date, actualStart: '11:05', actualEnd: '11:50', note: 'PRIVATE-B-RECORD' }, f.clients.supervisor);
  assert.equal((await f.request(f.clients.carerA, 'GET', historyUrl(v2))).status, 404);
  const b = await f.request(f.clients.carerB, 'GET', historyUrl(v2)); assert.equal(b.body.total, 1); assert.equal(b.body.items[0].version, 2); assert.deepEqual(b.body.items[0].comparison, noPrevious('unavailable'));
  const v3 = await f.patch('service-records', v2, { shiftId: f.shift.id, employeeId: f.employeeA.id, date: f.shift.date, actualStart: '09:08', actualEnd: '09:55', note: '合成回甲' });
  const before = f.state();
  for (const query of ['', 'compare=previous']) {
    const own = await f.request(f.clients.carerA, 'GET', historyUrl(v3, query)); assert.equal(own.status, 200); assert.deepEqual(own.body.items.map(row => row.version), [3, 1]);
    for (const hidden of ['PRIVATE-B-RECORD', otherShift.id, f.employeeB.id]) assert.ok(!JSON.stringify(own.body).includes(hidden));
    if (query) { assert.deepEqual(own.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(own.body.items[1].comparison, noPrevious('initial')); }
    assert.equal((await f.request(f.clients.carerB, 'GET', historyUrl(v3, query))).status, 404);
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) { const all = await f.request(caller, 'GET', historyUrl(v3, query)); assert.equal(all.body.total, 3); if (query) assert.equal(all.body.items[0].comparison.previousSnapshot.employeeId, f.employeeB.id); }
  }
  assert.deepEqual(f.state(), before);
});

test('same employee changing record case loses the old version after old shift reassignment and regains it through a cancelled own shift', async t => {
  const f = await fixture(t);
  const target = await f.create('shifts', { ...f.shiftData, caseId: f.caseB.id, carePlanId: f.planB.id, date: '2026-10-09' });
  const moved = await f.patch('service-records', f.record, { shiftId: target.id, caseId: f.caseB.id, date: target.date, note: '合成換案' }, f.clients.carerA);
  assert.equal((await f.request(f.clients.carerA, 'GET', historyUrl(moved))).body.total, 2);
  await f.patch('shifts', f.shift, { employeeId: f.employeeB.id });
  const before = f.state();
  for (const query of ['', 'compare=previous']) {
    const own = await f.request(f.clients.carerA, 'GET', historyUrl(moved, query)); assert.equal(own.status, 200); assert.deepEqual(own.body.items.map(row => row.version), [2]);
    assert.ok(!JSON.stringify(own.body).includes(f.caseA.id)); assert.ok(!JSON.stringify(own.body).includes(f.shift.id)); if (query) assert.deepEqual(own.body.items[0].comparison, noPrevious('unavailable'));
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) { const all = await f.request(caller, 'GET', historyUrl(moved, query)); assert.equal(all.body.total, 2); assert.equal(all.body.items[1].snapshot.caseId, f.caseA.id, 'different currently-readable historical case is retained'); }
  }
  assert.deepEqual(f.state(), before);
  await f.create('shifts', { ...f.shiftData, status: 'cancelled', date: '2026-01-01', note: '合成取消舊班仍提供既有個案授權' });
  const restored = f.state();
  for (const query of ['', 'compare=previous']) { const own = await f.request(f.clients.carerA, 'GET', historyUrl(moved, query)); assert.equal(own.body.total, 2); if (query) assert.equal(own.body.items[0].comparison.previousSnapshot.caseId, f.caseA.id); }
  assert.deepEqual(f.state(), restored);
});

test('every role filters missing and foreign historical cases before pagination and current record scope does not acquire a shift join', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成歷程乙機構' }), foreignClient = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'TEST-FOREIGN' }, foreignClient), missing = id();
  f.addSnapshot(f.record, 2, { caseId: missing, note: 'PRIVATE-MISSING-CASE' });
  f.addSnapshot(f.record, 3, { caseId: foreignCase.id, note: 'PRIVATE-FOREIGN-HISTORY' });
  const current = f.addSnapshot(f.record, 4, { note: '合成可見第4版' }); f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(JSON.stringify(business(current)), 4, current.id);
  const orphan = insert(f.app.db, f.admin.org, 'service-records', { ...f.recordData, shiftId: id(), note: '合成舊資料班次已缺失' });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', historyUrl(current, query)); assert.equal(result.status, 200); assert.deepEqual(result.body.items.map(row => row.version), [4, 1]);
    for (const hidden of [missing, foreignCase.id, 'PRIVATE-MISSING-CASE', 'PRIVATE-FOREIGN-HISTORY']) assert.ok(!JSON.stringify(result.body).includes(hidden)); if (query) assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable'));
    const noJoin = await f.request(caller, 'GET', historyUrl(orphan, query)); assert.equal(noJoin.status, 200); assert.equal(noJoin.body.total, 1);
  }
  for (const caller of [foreignClient, f.clients.carerB]) for (const query of ['', 'compare=previous']) assert.equal((await f.request(caller, 'GET', historyUrl(current, query))).status, 404);
  assert.equal((await f.request(f.admin, 'GET', historyUrl({ id: id() }))).status, 404); assert.equal((await f.request(null, 'GET', historyUrl(current))).status, 401);
  assert.deepEqual(f.state(), before);
});

test('service.review actors require exact scope and integer version; conflicting or missing users remain unknown and other entities ignore service reviews', async t => {
  const f = await fixture(t), submitted = await f.patch('service-records', f.record, { status: 'submitted' }, f.clients.carerA), returned = await f.review(submitted, 'returned', '合成精確核閱');
  const org = await f.create('organizations', { name: '合成錯範圍機構' });
  for (const event of [{ orgId: org.id }, { entity: 'shifts' }, { recordId: f.shift.id }, { action: 'shift.complete' }, { action: 'unrelated.action' }, { detail: { version: '3' } }, { detail: { version: 3.5 } }, { detail: { version: 99 } }, { detail: {} }, { rawDetail: '{broken' }]) f.auditEvent({ detail: { version: 3 }, ...event });
  let before = f.state(), response = await f.request(f.admin, 'GET', historyUrl(returned)); assert.deepEqual(response.body.items[0].actor, actor(f.clients.supervisor)); assert.deepEqual(f.state(), before);
  f.auditEvent({ detail: { version: 3 }, userId: f.clients.supervisor.user.id });
  before = f.state(); response = await f.request(f.admin, 'GET', historyUrl(returned)); assert.deepEqual(response.body.items[0].actor, actor(f.clients.supervisor), 'duplicate same user is not ambiguous'); assert.deepEqual(f.state(), before);
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成督導目前新名', f.clients.supervisor.user.id);
  assert.equal((await f.request(f.admin, 'GET', historyUrl(returned))).body.items[0].actor.name, '合成督導目前新名');
  f.auditEvent({ detail: { version: 3 } }); f.auditEvent({ detail: { version: 2 }, userId: 'missing-user' });
  for (const [entity, item] of [['cases', f.caseA], ['shifts', f.shift], ['care-plans', f.planA]]) f.auditEvent({ entity, recordId: item.id, detail: { version: 1 }, userId: f.clients.supervisor.user.id });
  before = f.state(); response = await f.request(f.admin, 'GET', historyUrl(returned)); assert.equal(response.body.items[0].actor, null); assert.equal(response.body.items[1].actor, null); assert.deepEqual(response.body.items[2].actor, actor(f.clients.carerA));
  for (const [entity, item] of [['cases', f.caseA], ['shifts', f.shift], ['care-plans', f.planA]]) assert.deepEqual((await f.request(f.admin, 'GET', historyUrl(item, 'compare=previous', entity))).body.items[0].actor, actor(f.admin));
  assert.deepEqual(f.state(), before);
});

test('baseline snapshots, absent exact predecessors and empty histories do not invent actors or skip missing versions', async t => {
  const f = await fixture(t), recordId = id(), time = now(), data = { ...f.recordData, shiftId: id(), note: '合成第3版匯入基準' };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, 'service-records', JSON.stringify(data), 3, time, time);
  const current = { ...data, id: recordId, orgId: f.admin.org, version: 3, createdAt: time, updatedAt: time };
  f.addSnapshot(current, 3); f.addSnapshot(current, 1, { note: '合成第1版' });
  f.auditEvent({ recordId, detail: { version: '3' } });
  const emptyId = id(); f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(emptyId, f.admin.org, 'service-records', JSON.stringify(data), 1, time, time);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const result = await f.request(caller, 'GET', historyUrl(current)); assert.deepEqual(result.body.items.map(row => row.version), [3, 1]); assert.ok(result.body.items.every(row => row.actor === null && row.source === 'baseline')); assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(result.body.items[1].comparison, noPrevious('initial'));
    const empty = await f.request(caller, 'GET', historyUrl({ id: emptyId })); assert.equal(empty.status, 200); assert.equal(empty.body.total, 0); assert.deepEqual(empty.body.items, []);
  }
  assert.deepEqual(f.state(), before);
});

test('28 real draft versions compare across 25-row page boundaries while raw shape, compare validation, CAS and immutable storage stay intact', async t => {
  const f = await fixture(t);
  const unsupported = await f.create('announcements', { title: '合成仍不支援比較的公告', body: '保留原比較拒絕驗收' }); let item = f.record;
  for (let version = 2; version <= 28; version++) item = await f.patch('service-records', item, { note: '合成實際草稿第' + version + '版' }, version % 2 ? f.clients.carerA : f.clients.supervisor);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) {
    const first = await f.request(caller, 'GET', historyUrl(item, 'compare=previous&page=1&pageSize=25')), second = await f.request(caller, 'GET', historyUrl(item, 'compare=previous&page=2&pageSize=25'));
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(first.body.total, 28); assert.equal(second.body.total, 28); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
    assert.equal(first.body.items.at(-1).version, 4); assert.equal(first.body.items.at(-1).comparison.previousVersion, 3); assert.deepEqual(first.body.items.at(-1).comparison.previousSnapshot, second.body.items[0].snapshot); assert.deepEqual(second.body.items.at(-1).comparison, noPrevious('initial'));
    const raw = await f.request(caller, 'GET', historyUrl(item, 'page=2&pageSize=25')); assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version')); assert.deepEqual(raw.body.items.map(row => row.snapshot), second.body.items.map(row => row.snapshot));
  }
  for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) { const result = await f.request(f.admin, 'GET', historyUrl(item, query)); assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_COMPARE'); }
  assert.equal((await f.request(f.admin, 'GET', historyUrl(unsupported, 'compare=next', 'announcements'))).status, 422);
  assert.deepEqual(f.state(), before);
  const stale = await f.request(f.clients.carerA, 'PATCH', '/api/service-records/' + item.id, { version: 1, note: '合成過期' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal((await f.request(f.clients.finance, 'PATCH', '/api/service-records/' + item.id, { version: item.version, note: '禁止' })).status, 403);
  assert.equal((await f.request(f.clients.carerB, 'PATCH', '/api/service-records/' + item.id, { version: item.version, note: '禁止' })).status, 403);
  assert.deepEqual(f.state(), before);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', item.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(item.id), /immutable/);
});

test('both raw and compared service snapshots retain only each roles existing financial projection', async t => {
  const f = await fixture(t), extraShift = await f.create('shifts', { ...f.shiftData, date: '2026-10-20' });
  // Explicit synthetic imported data exercises masking in both members of the compared pair.
  const internal = insert(f.app.db, f.admin.org, 'service-records', { ...f.recordData, shiftId: extraShift.id, date: extraShift.date, billingSnapshot: { marker: 'PRIVATE-FINANCIAL', employee: { hourlyRateCents: 987654321 } } });
  const current = await f.patch('service-records', internal, { note: '合成更新後仍須遮罩' }); const before = f.state();
  for (const caller of [f.admin, f.clients.finance, f.clients.supervisor, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', historyUrl(current, query)); assert.equal(result.status, 200); assert.equal(result.body.total, 2);
    const financial = caller === f.admin || caller === f.clients.finance;
    for (const row of result.body.items) { assert.equal(Object.hasOwn(row.snapshot, 'billingSnapshot'), financial); if (row.comparison?.previousSnapshot) assert.equal(Object.hasOwn(row.comparison.previousSnapshot, 'billingSnapshot'), financial); }
    if (!financial) assert.ok(!JSON.stringify(result.body).includes('PRIVATE-FINANCIAL'));
  }
  assert.deepEqual(f.state(), before);
});

test('history reads leave real approval prices, wages, fees/payroll, record locks and shift locks unchanged', async t => {
  const f = await fixture(t), submitted = await f.patch('service-records', f.record, { status: 'submitted', actualEnd: '09:52' }, f.clients.carerA);
  const locked = await f.request(f.admin, 'PATCH', '/api/service-records/' + submitted.id, { version: submitted.version, note: '不得改提交紀錄' }); assert.equal(locked.status, 409); assert.equal(locked.body.error.code, 'RECORD_LOCKED');
  for (const caller of [f.clients.carerA, f.clients.finance]) assert.equal((await f.request(caller, 'POST', '/api/service-records/' + submitted.id + '/review', { version: submitted.version, decision: 'approved' })).status, 403);
  await f.review(submitted, 'approved', '合成歷史計價核准', f.admin);
  const approved = (await f.request(f.admin, 'GET', '/api/service-records/' + submitted.id)).body.item;
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 10000);
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999 }); await f.patch('service-items', f.serviceA, { unitPriceCents: 88888 });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', historyUrl(approved, query)); assert.equal(result.status, 200); assert.equal(result.body.items[0].snapshot.version, approved.version); if (query) assert.deepEqual(result.body.items[0].actor, actor(f.admin));
  }
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body.totals.amountCents, 35000); assert.equal((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body.totals.amountCents, 18800);
  assert.deepEqual(f.state(), before);
  const recordLock = await f.request(f.admin, 'PATCH', '/api/service-records/' + approved.id, { version: approved.version, note: '不得改核准紀錄' }); assert.equal(recordLock.status, 409); assert.equal(recordLock.body.error.code, 'RECORD_LOCKED');
  const completed = (await f.request(f.admin, 'GET', '/api/shifts/' + f.shift.id)).body.item;
  const shiftLock = await f.request(f.admin, 'PATCH', '/api/shifts/' + f.shift.id, { version: completed.version, employeeId: f.employeeB.id }); assert.equal(shiftLock.status, 409); assert.equal(shiftLock.body.error.code, 'SHIFT_HAS_RECORD');
  const staleReview = await f.request(f.admin, 'POST', '/api/service-records/' + approved.id + '/review', { version: submitted.version, decision: 'approved' }); assert.equal(staleReview.status, 409); assert.equal(staleReview.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(f.state(), before);
});
