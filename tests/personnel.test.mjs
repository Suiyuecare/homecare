import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { taipeiToday } from '../src/server/personnel.mjs';

const CERT = 'employee-certifications';
const TRAINING = 'employee-training';
const AS_OF = '2026-10-08';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 });
  const base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extraHeaders = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: base,
        ...(client?.cookie ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', {
    name: '合成人員管理員', email: 'personnel-admin@example.test', password: 'personnel-test-password', organizationName: '合成人員機構甲',
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id };
  async function create(entity, data, client = admin, headers) {
    const result = await request(client, 'POST', '/api/' + entity, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.item;
  }
  const employee = await create('employees', { name: '合成員工甲', employeeNo: 'TEST-P01' });
  const otherEmployee = await create('employees', { name: '合成員工乙', employeeNo: 'TEST-P02' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = role + '@personnel.example.test';
    await create('users', { name: '合成' + role, email, password: 'personnel-test-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password: 'personnel-test-password' });
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org };
  }
  const cert = overrides => ({ employeeId: employee.id, name: '合成證照', issuedOn: '2026-01-01', expiresOn: '2026-12-31', ...overrides });
  const training = overrides => ({ employeeId: employee.id, name: '合成訓練', category: 'in_service', date: AS_OF, trainingMinutes: 60, ...overrides });
  return { app, request, create, admin, clients, employee, otherEmployee, cert, training };
}

test('personnel create/update trims names, enforces same organization and immutable employee ownership', async t => {
  const f = await fixture(t);
  for (const [entity, data] of [[CERT, f.cert], [TRAINING, f.training]]) {
    const item = await f.create(entity, data({ name: '  合成名稱  ' }), f.clients.supervisor);
    assert.equal(item.name, '合成名稱');
    assert.equal(item.orgId, f.admin.org);
    assert.equal((await f.request(f.admin, 'PATCH', '/api/' + entity + '/' + item.id, { version: 1, employeeId: f.otherEmployee.id })).status, 409);
    const immutable = await f.request(f.admin, 'PATCH', '/api/' + entity + '/' + item.id, { version: 1, employeeId: f.otherEmployee.id });
    assert.equal(immutable.body.error.code, 'EMPLOYEE_IMMUTABLE');
    const modified = await f.request(f.clients.supervisor, 'PATCH', '/api/' + entity + '/' + item.id, { version: 1, name: '  新合成名稱  ', note: '合成更新' });
    assert.equal(modified.status, 200); assert.equal(modified.body.item.name, '新合成名稱'); assert.equal(modified.body.item.version, 2);
    assert.equal((await f.request(f.admin, 'PATCH', '/api/' + entity + '/' + item.id, { version: 1, note: 'stale' })).status, 409);
    assert.equal((await f.request(f.admin, 'POST', '/api/' + entity, data({ name: ' \t\n ' }))).status, 422);
    assert.equal((await f.request(f.admin, 'POST', '/api/' + entity, data({ employeeId: 'missing' }))).status, 422);
  }
  const organization = await f.create('organizations', { name: '合成人員機構乙' });
  const orgB = { ...f.admin, org: organization.id };
  const foreignEmployee = await f.create('employees', { name: '跨機構合成人員', employeeNo: 'TEST-FOREIGN' }, orgB);
  for (const [entity, data] of [[CERT, f.cert], [TRAINING, f.training]]) {
    assert.equal((await f.request(f.admin, 'POST', '/api/' + entity, data({ employeeId: foreignEmployee.id }))).status, 422);
    const item = await f.create(entity, data());
    assert.equal((await f.request(orgB, 'GET', '/api/' + entity + '/' + item.id)).status, 404);
    assert.equal((await f.request(orgB, 'GET', '/api/' + entity + '/' + item.id + '/history')).status, 404);
    assert.equal((await f.request(orgB, 'PATCH', '/api/' + entity + '/' + item.id, { version: 1, note: 'forbidden' })).status, 404);
  }
});

test('personnel role matrix denies finance entirely and limits caregivers to own reads and history', async t => {
  const f = await fixture(t);
  for (const [entity, data] of [[CERT, f.cert], [TRAINING, f.training]]) {
    const mine = await f.create(entity, data());
    const others = await f.create(entity, data({ employeeId: f.otherEmployee.id }));
    const ownList = await f.request(f.clients.caregiver, 'GET', '/api/' + entity);
    assert.equal(ownList.status, 200); assert.equal(ownList.body.total, 1); assert.equal(ownList.body.items[0].id, mine.id);
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/' + entity + '?employeeId=' + f.otherEmployee.id)).body.total, 0);
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/' + entity + '/' + mine.id)).status, 200);
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/' + entity + '/' + mine.id + '/history')).body.total, 1);
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/' + entity + '/' + others.id)).status, 404);
    assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/' + entity + '/' + others.id + '/history')).status, 404);
    assert.equal((await f.request(f.clients.caregiver, 'POST', '/api/' + entity, data())).status, 403);
    assert.equal((await f.request(f.clients.caregiver, 'PATCH', '/api/' + entity + '/' + mine.id, { version: 1, note: 'blocked' })).status, 403);
    for (const route of ['/api/' + entity, '/api/' + entity + '/' + mine.id, '/api/' + entity + '/' + mine.id + '/history']) {
      assert.equal((await f.request(f.clients.finance, 'GET', route)).status, 403);
    }
    assert.equal((await f.request(f.clients.finance, 'POST', '/api/' + entity, data())).status, 403);
    assert.equal((await f.request(f.clients.finance, 'PATCH', '/api/' + entity + '/' + mine.id, { version: 1, note: 'blocked' })).status, 403);
  }
});

test('certificate expiry derives day boundaries at read time, filters before pagination, and leaves persisted/history snapshots untouched', async t => {
  const f = await fixture(t);
  const cases = [
    ['yesterday', '2026-10-07', 'active', 'expired', -1],
    ['today', AS_OF, 'active', 'due_soon', 0],
    ['day30', '2026-11-07', 'active', 'due_soon', 30],
    ['day31', '2026-11-08', 'active', 'valid', 31],
    ['none', '', 'active', 'no_expiry', null],
    ['revoked', '2026-10-01', 'revoked', 'revoked', -7],
  ];
  const items = [];
  for (const [name, expiresOn, status, state, days] of cases) {
    const item = await f.create(CERT, f.cert({ name, expiresOn, status })); items.push(item);
    assert.ok(!Object.hasOwn(item, 'expiryState'));
    const got = await f.request(f.admin, 'GET', '/api/' + CERT + '/' + item.id + '?asOf=' + AS_OF);
    assert.equal(got.status, 200); assert.equal(got.body.item.expiryState, state); assert.equal(got.body.item.daysToExpiry, days); assert.equal(got.body.item.asOf, AS_OF);
    const persisted = JSON.parse(f.app.db.prepare('SELECT data FROM records WHERE id=?').get(item.id).data);
    for (const key of ['expiryState', 'daysToExpiry', 'asOf']) assert.ok(!Object.hasOwn(persisted, key));
    const history = await f.request(f.admin, 'GET', '/api/' + CERT + '/' + item.id + '/history?asOf=2030-01-01');
    assert.ok(!Object.hasOwn(history.body.items[0].snapshot, 'expiryState'));
  }
  const pageOne = await f.request(f.admin, 'GET', '/api/' + CERT + '?asOf=' + AS_OF + '&expiry=due_soon&page=1&pageSize=1');
  const pageTwo = await f.request(f.admin, 'GET', '/api/' + CERT + '?asOf=' + AS_OF + '&expiry=due_soon&page=2&pageSize=1');
  assert.equal(pageOne.body.total, 2); assert.equal(pageTwo.body.total, 2);
  assert.equal(pageOne.body.items.length, 1); assert.equal(pageTwo.body.items.length, 1); assert.notEqual(pageOne.body.items[0].id, pageTwo.body.items[0].id);
  for (const expiry of ['expired', 'valid', 'no_expiry', 'revoked']) assert.equal((await f.request(f.admin, 'GET', '/api/' + CERT + '?asOf=' + AS_OF + '&expiry=' + expiry)).body.total, 1);
  const tomorrow = await f.request(f.admin, 'GET', '/api/' + CERT + '/' + items[1].id + '?asOf=2026-10-09');assert.equal(tomorrow.body.item.expiryState, 'expired');
  const defaultDate = await f.request(f.admin, 'GET', '/api/' + CERT + '/' + items[0].id);assert.equal(defaultDate.body.item.asOf, taipeiToday());
  for (const asOf of ['2026-02-30', '2026-2-03', '', 'bad']) assert.equal((await f.request(f.admin, 'GET', '/api/' + CERT + '?asOf=' + asOf)).status, 422);
  assert.equal((await f.request(f.admin, 'GET', '/api/' + CERT + '?expiry=unsupported')).status, 422);
  const leap = await f.create(CERT, f.cert({ issuedOn: '2024-02-29', expiresOn: '2024-03-30' }));
  assert.equal((await f.request(f.admin, 'GET', '/api/' + CERT + '/' + leap.id + '?asOf=2024-02-29')).body.item.daysToExpiry, 30);
});

test('personnel validates date calendar values, reversed dates, integer minutes and category without legal-credit fields', async t => {
  const f = await fixture(t);
  for (const fields of [
    { issuedOn: '2025-02-29' }, { issuedOn: '' }, { issuedOn: '2026-13-01' },
    { expiresOn: '2026-04-31' }, { expiresOn: '2025-12-31' }, { expiresOn: null },
    { issuedOn: '2026-01-01T00:00:00Z' }, { status: 'expired' }, { expiryState: 'valid' }, { asOf: AS_OF },
  ]) assert.equal((await f.request(f.admin, 'POST', '/api/' + CERT, f.cert(fields))).status, 422, JSON.stringify(fields));
  const equalDates = await f.create(CERT, f.cert({ issuedOn: AS_OF, expiresOn: AS_OF }));assert.ok(equalDates.id);
  for (const fields of [
    { date: '2026-02-30' }, { date: '2026-1-01' }, { date: '' }, { category: 'credits' },
    { trainingMinutes: 0 }, { trainingMinutes: -1 }, { trainingMinutes: 1.5 }, { trainingMinutes: 60001 },
    { trainingMinutes: '60' }, { trainingMinutes: null }, { statutoryCredits: 1 }, { status: 'approved' },
  ]) assert.equal((await f.request(f.admin, 'POST', '/api/' + TRAINING, f.training(fields))).status, 422, JSON.stringify(fields));
  assert.equal((await f.create(TRAINING, f.training({ trainingMinutes: 1 }))).trainingMinutes, 1);
  assert.equal((await f.create(TRAINING, f.training({ trainingMinutes: 60000, category: 'other' }))).trainingMinutes, 60000);
  assert.equal((await f.request(f.admin, 'GET', '/api/' + TRAINING + '?date=2026-02-30')).status, 422);
  assert.equal((await f.request(f.admin, 'GET', '/api/' + TRAINING + '?month=2026-13')).status, 422);
  assert.equal((await f.request(f.admin, 'GET', '/api/' + TRAINING + '?category=bad')).status, 422);
});

test('training combines category/employee/status/date/month filters and both entities retain idempotent audited histories', async t => {
  const f = await fixture(t);
  const first = await f.create(TRAINING, f.training({ category: 'pre_service' }));
  await f.create(TRAINING, f.training({ category: 'pre_service', status: 'cancelled' }));
  await f.create(TRAINING, f.training({ category: 'other', date: '2026-09-30' }));
  await f.create(TRAINING, f.training({ employeeId: f.otherEmployee.id, category: 'pre_service' }));
  const query = await f.request(f.admin, 'GET', '/api/' + TRAINING + '?category=pre_service&status=completed&date=' + AS_OF + '&month=2026-10&employeeId=' + f.employee.id);
  assert.equal(query.body.total, 1); assert.equal(query.body.items[0].id, first.id);
  for (const [entity, make] of [[CERT, f.cert], [TRAINING, f.training]]) {
    const data = make({ name: '重送測試' }); const headers = { 'Idempotency-Key': 'personnel-' + entity };
    const one = await f.request(f.admin, 'POST', '/api/' + entity, data, headers);
    const two = await f.request(f.admin, 'POST', '/api/' + entity, data, headers);
    assert.equal(one.status, 201); assert.equal(two.status, 201); assert.equal(one.body.item.id, two.body.item.id);
    assert.equal((await f.request(f.admin, 'POST', '/api/' + entity, { ...data, name: '不同內容' }, headers)).status, 409);
    const patched = await f.request(f.admin, 'PATCH', '/api/' + entity + '/' + one.body.item.id, { version: 1, name: '新版名稱' });assert.equal(patched.status, 200);
    const history = await f.request(f.clients.caregiver, 'GET', '/api/' + entity + '/' + one.body.item.id + '/history');
    assert.equal(history.body.total, 2); assert.equal(history.body.items[0].snapshot.name, '新版名稱'); assert.equal(history.body.items[1].snapshot.name, '重送測試');
    const audit = await f.request(f.admin, 'GET', '/api/audit?q=' + one.body.item.id);
    assert.ok(audit.body.items.some(x => x.action === 'record.create')); assert.ok(audit.body.items.some(x => x.action === 'record.update'));
  }
});

test('fresh demo supplies only synthetic personnel records and never duplicates them', async t => {
  const f = await fixture(t);
  const seeded = await f.request(f.admin, 'POST', '/api/demo/seed', {});assert.equal(seeded.body.seeded, true);
  const certs = await f.request(f.admin, 'GET', '/api/' + CERT);const training = await f.request(f.admin, 'GET', '/api/' + TRAINING);
  assert.equal(certs.body.total, 3);assert.equal(training.body.total, 2);
  assert.ok(certs.body.items.every(x => x.certificateNo.startsWith('TEST-') && x.note.includes('合成')));
  assert.ok(training.body.items.every(x => x.note.includes('不等同法定積分')));
  assert.equal((await f.request(f.admin, 'POST', '/api/demo/seed', {})).body.seeded, false);
  assert.equal((await f.request(f.admin, 'GET', '/api/' + CERT)).body.total, 3);
});
