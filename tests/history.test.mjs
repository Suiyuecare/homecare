import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, initDb, insert } from '../src/server/model.mjs';

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
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', {
    name: '合成管理員', email: 'history-admin@example.test', password: 'history-test-password', organizationName: '合成歷程機構甲',
  });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(entity, data, client = admin) {
    const result = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.item;
  }
  async function patch(entity, item, data, client = admin) {
    const result = await request(client, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.item;
  }
  const employee = await create('employees', { name: '合成居服員甲', employeeNo: 'TEST-H01' });
  const otherEmployee = await create('employees', { name: '合成居服員乙', employeeNo: 'TEST-H02' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = role + '@history.example.test';
    await create('users', { name: '合成' + role, email, password: 'history-test-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password: 'history-test-password' });
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const service = await create('service-items', { code: 'TEST-HISTORY', name: '合成服務', minutes: 60, unitPriceCents: 10000 });
  const caseA = await create('cases', { name: '可見合成個案', caseNo: 'TEST-HC01' });
  const caseB = await create('cases', { name: '不應洩漏合成個案', caseNo: 'TEST-HC02', note: 'PRIVATE-HIDDEN-CASE' });
  const planData = (caseId, more = {}) => ({ caseId, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }], ...more });
  async function assign(plan, more = {}) {
    return create('shifts', { caseId: plan.caseId, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }], ...more });
  }
  function auditEvent({ orgId = admin.org, entity = 'cases', recordId, userId = admin.user.id, action = 'record.update', detail = {} }) {
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, JSON.stringify(detail), now());
  }
  return { app, request, create, patch, admin, clients, employee, otherEmployee, service, caseA, caseB, planData, assign, auditEvent };
}

const historyUrl = (entity, item, query = 'compare=previous') => '/api/' + entity + '/' + item.id + '/history' + (query ? '?' + query : '');

test('case and plan histories resolve exact actual actors and preserve the legacy response without compare', async t => {
  const f = await fixture(t);
  const plan = await f.create('care-plans', f.planData(f.caseA.id));
  for (const [entity, original] of [['cases', f.caseA], ['care-plans', plan]]) {
    const updated = await f.patch(entity, original, { note: '由督導完成的合成修改' }, f.clients.supervisor);
    const plain = await f.request(f.admin, 'GET', historyUrl(entity, updated, ''));
    assert.equal(plain.status, 200); assert.equal(plain.body.total, 2);
    assert.ok(plain.body.items.every(row => !Object.hasOwn(row, 'actor') && !Object.hasOwn(row, 'comparison')));
    const compared = await f.request(f.admin, 'GET', historyUrl(entity, updated));
    assert.equal(compared.status, 200);
    const [v2, v1] = compared.body.items;
    assert.deepEqual(v2.actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name });
    assert.deepEqual(v1.actor, { id: f.admin.user.id, name: f.admin.user.name });
    assert.equal(v2.comparison.status, 'available'); assert.equal(v2.comparison.previousVersion, 1);
    assert.deepEqual(v2.comparison.previousSnapshot, v1.snapshot);
    assert.deepEqual(v1.comparison, { status: 'initial', previousVersion: null, previousSnapshot: null });
  }
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成督導目前名稱', f.clients.supervisor.user.id);
  const renamed = await f.request(f.admin, 'GET', historyUrl('cases', f.caseA));
  assert.equal(renamed.body.items[0].actor.name, '合成督導目前名稱');
});

test('actor matching ignores wrong scope/version/action and returns null for conflicting or absent identities', async t => {
  const f = await fixture(t);
  const updated = await f.patch('cases', f.caseA, { note: 'v2' }, f.clients.supervisor);
  const otherOrg = await f.create('organizations', { name: '合成歷程機構乙' });
  f.auditEvent({ orgId: otherOrg.id, recordId: updated.id, detail: { version: 2 } });
  f.auditEvent({ entity: 'care-plans', recordId: updated.id, detail: { version: 2 } });
  f.auditEvent({ recordId: f.caseB.id, detail: { version: 2 } });
  f.auditEvent({ recordId: updated.id, detail: { version: '2' } });
  f.auditEvent({ recordId: updated.id, action: 'service.review', detail: { version: 2 } });
  f.auditEvent({ recordId: updated.id, detail: { version: 99 } });
  f.auditEvent({ recordId: updated.id, detail: {} });
  let result = await f.request(f.admin, 'GET', historyUrl('cases', updated));
  assert.equal(result.body.items[0].actor.id, f.clients.supervisor.user.id);
  f.auditEvent({ recordId: updated.id, userId: f.clients.supervisor.user.id, detail: { version: 2 } });
  result = await f.request(f.admin, 'GET', historyUrl('cases', updated));
  assert.equal(result.body.items[0].actor.id, f.clients.supervisor.user.id, 'duplicate evidence for same user is not an identity conflict');
  f.auditEvent({ recordId: updated.id, detail: { version: 2 } });
  result = await f.request(f.admin, 'GET', historyUrl('cases', updated));
  assert.equal(result.body.items[0].actor, null, 'two actual user IDs for one version are ambiguous');
  const missing = await f.create('cases', { name: '缺失身份合成個案', caseNo: 'TEST-HC-MISSING' });
  f.auditEvent({ recordId: missing.id, action: 'record.create', userId: 'nonexistent-user', detail: { version: 1 } });
  assert.equal((await f.request(f.admin, 'GET', historyUrl('cases', missing))).body.items[0].actor, null);
});

test('baseline and missing preceding versions remain unknown without guessing from neighboring entries', async t => {
  const f = await fixture(t);
  const recordId = id(), time = now();
  const data = { name: '合成舊資料基準', caseNo: 'TEST-BASELINE', status: 'active', note: 'v3 only' };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, 'cases', JSON.stringify(data), 3, time, time);
  initDb(f.app.db); // Existing migration saves a baseline without inventing an actor.
  const initial = { ...data, note: 'v1', id: recordId, orgId: f.admin.org, version: 1, createdAt: time, updatedAt: time };
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, 'cases', recordId, 1, JSON.stringify(initial), time, 'baseline');
  f.auditEvent({ recordId, detail: { version: '3' } });
  const result = await f.request(f.admin, 'GET', historyUrl('cases', { id: recordId }));
  assert.equal(result.status, 200); assert.equal(result.body.items[0].version, 3);
  assert.equal(result.body.items[0].source, 'baseline'); assert.equal(result.body.items[0].actor, null);
  assert.deepEqual(result.body.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
  assert.deepEqual(result.body.items[1].comparison, { status: 'initial', previousVersion: null, previousSnapshot: null });
});

test('comparison validation is explicit and history remains append-only and read-only across pagination', async t => {
  const f = await fixture(t);
  const unsupported = await f.create('announcements', { title: '合成仍不支援比較的公告', body: '保留原比較拒絕驗收' });
  for (const compare of ['', 'next', 'Previous', 'previous&compare=previous']) {
    const result = await f.request(f.admin, 'GET', historyUrl('cases', f.caseA, 'compare=' + compare));
    assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_COMPARE');
  }
  assert.equal((await f.request(f.admin, 'GET', historyUrl('announcements', unsupported, 'compare=next'))).status, 422);
  let current = f.caseA;
  for (let version = 2; version <= 28; version++) {
    current = await f.patch('cases', current, { note: '合成第' + version + '版' }, version % 2 ? f.admin : f.clients.supervisor);
  }
  const changesBefore = f.app.db.prepare('SELECT total_changes() AS count').get().count;
  const auditBefore = f.app.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count;
  const page1 = await f.request(f.admin, 'GET', historyUrl('cases', current, 'compare=previous&page=1&pageSize=25'));
  const page2 = await f.request(f.admin, 'GET', historyUrl('cases', current, 'compare=previous&page=2&pageSize=25'));
  assert.equal(page1.body.total, 28); assert.equal(page2.body.total, 28);
  assert.equal(page1.body.items.length, 25); assert.equal(page2.body.items.length, 3);
  const boundary = page1.body.items.at(-1);
  assert.equal(boundary.version, 4); assert.equal(boundary.comparison.previousVersion, 3);
  assert.deepEqual(boundary.comparison.previousSnapshot, page2.body.items[0].snapshot);
  assert.equal(f.app.db.prepare('SELECT total_changes() AS count').get().count, changesBefore);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count, auditBefore);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', current.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(current.id), /immutable/);
});

test('current authorization and historical case visibility prevent cross-organization and hidden-plan comparisons', async t => {
  const f = await fixture(t);
  const hiddenPlan = await f.create('care-plans', f.planData(f.caseB.id, { note: 'PRIVATE-PLAN-OLD' }));
  const visiblePlan = await f.patch('care-plans', hiddenPlan, { caseId: f.caseA.id, note: '可見計畫第2版' });
  await f.assign(visiblePlan);
  const carer = f.clients.caregiver;
  const compared = await f.request(carer, 'GET', historyUrl('care-plans', visiblePlan));
  assert.equal(compared.status, 200); assert.equal(compared.body.total, 1);
  assert.equal(compared.body.items[0].version, 2);
  assert.deepEqual(compared.body.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
  assert.ok(!JSON.stringify(compared.body).includes(f.caseB.id)); assert.ok(!JSON.stringify(compared.body).includes('PRIVATE-PLAN-OLD'));
  const legacy = await f.request(carer, 'GET', historyUrl('care-plans', visiblePlan, ''));
  assert.equal(legacy.body.total, 1); assert.ok(!Object.hasOwn(legacy.body.items[0], 'comparison'));
  const privileged = await f.request(f.admin, 'GET', historyUrl('care-plans', visiblePlan));
  assert.equal(privileged.body.items[0].comparison.previousSnapshot.caseId, f.caseB.id);
  assert.equal((await f.request(carer, 'GET', historyUrl('cases', f.caseB))).status, 404);
  assert.equal((await f.request(carer, 'GET', historyUrl('cases', { id: id() }))).status, 404);
  assert.equal((await f.request(carer, 'PATCH', '/api/cases/' + f.caseA.id, { version: f.caseA.version, note: 'blocked' })).status, 403);
  assert.equal((await f.request(carer, 'PATCH', '/api/care-plans/' + visiblePlan.id, { version: visiblePlan.version, note: 'blocked' })).status, 403);
  const otherOrg = await f.create('organizations', { name: '歷程隔離機構' });
  const elsewhere = { ...f.admin, org: otherOrg.id };
  assert.equal((await f.request(elsewhere, 'GET', historyUrl('cases', f.caseA))).status, 404);
  assert.equal((await f.request(elsewhere, 'GET', historyUrl('care-plans', visiblePlan))).status, 404);
});

test('both current and previous history snapshots use financial projection and personnel protections remain intact', async t => {
  const f = await fixture(t);
  const internalCase = insert(f.app.db, f.admin.org, 'cases', {
    name: '合成遮罩個案', caseNo: 'TEST-MASK', status: 'active', billingSnapshot: { employee: { hourlyRateCents: 123456789 } },
  });
  const plan = await f.create('care-plans', f.planData(internalCase.id)); await f.assign(plan);
  await f.patch('cases', internalCase, { note: '新版仍須遮罩' });
  const compared = await f.request(f.clients.caregiver, 'GET', historyUrl('cases', internalCase));
  assert.equal(compared.status, 200); assert.equal(compared.body.items[0].comparison.status, 'available');
  assert.ok(!JSON.stringify(compared.body).includes('billingSnapshot')); assert.ok(!JSON.stringify(compared.body).includes('123456789'));
  const adminHistory = await f.request(f.admin, 'GET', historyUrl('cases', internalCase));
  assert.equal(adminHistory.body.items[0].comparison.previousSnapshot.billingSnapshot.employee.hourlyRateCents, 123456789);
  for (const [entity, data] of [
    ['employee-certifications', { name: '合成證照', issuedOn: '2026-01-01' }],
    ['employee-training', { name: '合成訓練', category: 'other', date: '2026-10-08', trainingMinutes: 60 }],
  ]) {
    const mine = await f.create(entity, { employeeId: f.employee.id, ...data });
    const others = await f.create(entity, { employeeId: f.otherEmployee.id, ...data });
    assert.equal((await f.request(f.clients.caregiver, 'GET', historyUrl(entity, mine, ''))).status, 200);
    assert.equal((await f.request(f.clients.caregiver, 'GET', historyUrl(entity, others, ''))).status, 404);
    assert.equal((await f.request(f.clients.finance, 'GET', historyUrl(entity, mine, ''))).status, 403);
    const personnelComparison = await f.request(f.admin, 'GET', historyUrl(entity, mine));
    assert.equal(personnelComparison.status, 200);
    assert.equal(personnelComparison.body.items[0].comparison.status, 'initial');
    assert.equal((await f.request(f.clients.caregiver, 'GET', historyUrl(entity, mine))).status, 200);
    assert.equal((await f.request(f.clients.caregiver, 'GET', historyUrl(entity, others))).status, 404);
    assert.equal((await f.request(f.clients.finance, 'GET', historyUrl(entity, mine))).status, 403);
  }
});
