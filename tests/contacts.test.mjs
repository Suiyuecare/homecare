import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now } from '../src/server/model.mjs';

const ENTITY = 'case-contacts';
const route = (item, suffix = '') => '/api/' + ENTITY + (item ? '/' + item.id : '') + suffix;

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 });
  const base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, path, data, headers = {}) {
    const response = await fetch(base + path, {
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
  const setup = await request(null, 'POST', '/api/setup', {
    name: '合成聯絡人管理員', email: 'contacts-admin@example.test', password: 'contacts-test-password', organizationName: '合成聯絡機構甲',
  });
  assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: setup.body.csrfToken, org: setup.body.organizations[0].id, user: setup.body.user };
  async function create(entity, data, client = admin) {
    const result = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.item;
  }
  async function patch(item, data, client = admin) {
    const result = await request(client, 'PATCH', route(item), { version: item.version, ...data });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.item;
  }
  const employee = await create('employees', { name: '合成居服員甲', employeeNo: 'TEST-CONTACT-01' });
  const clients = { admin };
  for (const role of ['supervisor', 'caregiver', 'finance']) {
    const email = role + '@contacts.example.test';
    await create('users', { name: '合成' + role, email, password: 'contacts-test-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password: 'contacts-test-password' });
    clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.body.csrfToken, org: admin.org, user: login.body.user };
  }
  const caseA = await create('cases', { name: '合成可見個案', caseNo: 'TEST-CONTACT-A', contactName: '合成舊聯絡人', contactPhone: 'TEST-OLD-PHONE', primaryCarer: '合成原照顧者' });
  const caseB = await create('cases', { name: '合成其他個案', caseNo: 'TEST-CONTACT-B' });
  async function assign(caseItem = caseA) {
    const service = await create('service-items', { code: 'TEST-CONTACT-' + caseItem.caseNo, name: '合成服務', minutes: 60, unitPriceCents: 10000 });
    const plan = await create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 10 }] });
    await create('shifts', { caseId: caseItem.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  }
  const contact = overrides => ({ caseId: caseA.id, name: '合成聯絡人', ...overrides });
  function counts() {
    return Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, app.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n]));
  }
  return { app, request, create, patch, admin, clients, employee, caseA, caseB, assign, contact, counts };
}

test('contacts trim text, retain repeated categories, and never migrate or synchronize legacy case data', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.admin, 'GET', route())).body.total, 0);
  const originalHistory = (await f.request(f.admin, 'GET', '/api/cases/' + f.caseA.id + '/history?compare=previous')).body;
  let contact = await f.create(ENTITY, f.contact({
    caseId: ' ' + f.caseA.id + ' ', name: '  合成家屬  ', category: ' primary_caregiver ', relationship: ' 親友 ',
    phone: ' +886 TEST #123 ', alternatePhone: ' 日間洽分機 ', email: ' person@contacts.example.test ', organization: ' 合成單位 ', note: ' 合成備註 ', status: ' active ',
  }), f.clients.supervisor);
  assert.equal(contact.name, '合成家屬'); assert.equal(contact.caseId, f.caseA.id);
  for (const field of ['category', 'relationship', 'phone', 'alternatePhone', 'email', 'organization', 'note', 'status']) assert.equal(contact[field], contact[field].trim());
  assert.equal(contact.phone, '+886 TEST #123');
  const second = await f.create(ENTITY, f.contact({ category: 'primary_caregiver' }));
  assert.notEqual(second.id, contact.id);
  const defaults = await f.create(ENTITY, f.contact());
  assert.equal(defaults.category, 'general'); assert.equal(defaults.status, 'active');
  contact = await f.patch(contact, { status: 'inactive', name: ' 停用合成聯絡人 ' });
  assert.equal(contact.status, 'inactive'); assert.equal(contact.name, '停用合成聯絡人');
  contact = await f.patch(contact, { status: 'active', phone: ' \t ', email: ' \n ' });
  assert.equal(contact.phone, ''); assert.equal(contact.email, ''); assert.equal(contact.version, 3);
  assert.equal((await f.request(f.admin, 'DELETE', route(contact))).status, 404);
  const caseAfter = (await f.request(f.admin, 'GET', '/api/cases/' + f.caseA.id)).body.item;
  assert.deepEqual(caseAfter, f.caseA);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/cases/' + f.caseA.id + '/history?compare=previous')).body, originalHistory);
  for (const status of ['paused', 'closed']) {
    const caseItem = await f.create('cases', { name: '合成非啟用個案', caseNo: 'TEST-' + status, status });
    const child = await f.create(ENTITY, f.contact({ caseId: caseItem.id }));
    assert.equal((await f.patch(child, { note: '非啟用個案仍可維護' })).version, 2);
  }
});

test('contacts validate bounded text, email, types, required fields, and immutable same-organization references', async t => {
  const f = await fixture(t);
  const contact = await f.create(ENTITY, f.contact());
  const otherOrg = await f.create('organizations', { name: '合成聯絡機構乙' });
  const otherClient = { ...f.admin, org: otherOrg.id };
  const foreignCase = await f.create('cases', { name: '跨機構合成個案', caseNo: 'TEST-FOREIGN' }, otherClient);
  const before = f.counts();
  const invalid = [
    { name: '' }, { name: ' \n\t ' }, { name: null }, { name: 1 }, { caseId: '' }, { caseId: id() }, { caseId: foreignCase.id },
    { phone: null }, { email: 'not-email' }, { email: 'a@@example.test' }, { email: 'a b@example.test' }, { email: 'a@example' },
    { category: '' }, { category: 'emergency' }, { status: 'deleted' }, { priority: 1 }, { billingSnapshot: {} },
  ];
  for (const [field, limit] of Object.entries({ name: 100, relationship: 100, phone: 100, alternatePhone: 100, email: 254, organization: 200, note: 10000 })) invalid.push({ [field]: 'x'.repeat(limit + 1) });
  for (const fields of invalid) {
    const result = await f.request(f.admin, 'POST', route(), f.contact(fields));
    assert.equal(result.status, 422, JSON.stringify(fields));
  }
  for (const caseId of [f.caseB.id, foreignCase.id, id(), '']) {
    const result = await f.request(f.admin, 'PATCH', route(contact), { version: 1, caseId });
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CASE_IMMUTABLE');
  }
  assert.equal((await f.request(f.admin, 'PATCH', route(contact), { version: 1, email: 'invalid' })).status, 422);
  assert.deepEqual(f.counts(), before, 'failed changes do not append records, history, audit, or idempotency');
  const boundary = await f.create(ENTITY, f.contact({ name: '字'.repeat(100), relationship: '字'.repeat(100), phone: 'x'.repeat(100), alternatePhone: 'x'.repeat(100), email: 'a'.repeat(241) + '@example.test', organization: '字'.repeat(200), note: '字'.repeat(10000) }));
  assert.equal(boundary.email.length, 254);
});

test('contacts route guards allow finance reads and caregivers assigned cases only, including inactive contacts', async t => {
  const f = await fixture(t); await f.assign();
  const mine = await f.create(ENTITY, f.contact());
  const inactive = await f.create(ENTITY, f.contact({ status: 'inactive' }));
  const hidden = await f.create(ENTITY, f.contact({ caseId: f.caseB.id, name: 'PRIVATE-HIDDEN-CONTACT' }));
  const otherOrg = await f.create('organizations', { name: '合成隔離機構' });
  const foreign = { ...f.admin, org: otherOrg.id };
  const foreignCase = await f.create('cases', { name: '另一機構個案', caseNo: 'TEST-OTHER' }, foreign);
  const foreignContact = await f.create(ENTITY, f.contact({ caseId: foreignCase.id }), foreign);
  const before = f.counts();
  for (const client of [f.admin, f.clients.supervisor, f.clients.finance]) {
    assert.equal((await f.request(client, 'GET', route())).body.total, 3);
    assert.equal((await f.request(client, 'GET', route(hidden))).status, 200);
    assert.equal((await f.request(client, 'GET', route(hidden, '/history?compare=previous'))).status, 200);
  }
  const carer = f.clients.caregiver;
  const list = await f.request(carer, 'GET', route());
  assert.deepEqual(new Set(list.body.items.map(item => item.id)), new Set([mine.id, inactive.id]));
  assert.ok(!JSON.stringify(list.body).includes('PRIVATE-HIDDEN-CONTACT'));
  assert.equal((await f.request(carer, 'GET', route(null, '?caseId=' + f.caseB.id))).body.total, 0);
  assert.equal((await f.request(carer, 'GET', route(null, '?q=PRIVATE-HIDDEN'))).body.total, 0);
  for (const contact of [mine, inactive]) {
    assert.equal((await f.request(carer, 'GET', route(contact))).status, 200);
    assert.equal((await f.request(carer, 'GET', route(contact, '/history?compare=previous'))).status, 200);
  }
  for (const contact of [hidden, foreignContact]) {
    assert.equal((await f.request(carer, 'GET', route(contact))).status, 404);
    assert.equal((await f.request(carer, 'GET', route(contact, '/history?compare=previous'))).status, 404);
  }
  assert.equal((await f.request(f.admin, 'GET', route(foreignContact))).status, 404);
  assert.equal((await f.request(foreign, 'GET', route(mine, '/history'))).status, 404);
  for (const client of [carer, f.clients.finance]) {
    assert.equal((await f.request(client, 'POST', route(), {})).status, 403, 'role rejection precedes payload validation');
    for (const contact of [mine, hidden, foreignContact, { id: id() }]) {
      assert.equal((await f.request(client, 'PATCH', route(contact), {})).status, 403, 'role rejection precedes record lookup');
      assert.equal((await f.request(client, 'DELETE', route(contact))).status, 403);
    }
  }
  assert.equal((await f.request(f.admin, 'POST', route(), f.contact(), { 'X-CSRF-Token': '' })).status, 403);
  assert.deepEqual(f.counts(), before);
});

test('contacts filter by case, category, status and search before stable pagination and reject invalid categories', async t => {
  const f = await fixture(t); await f.assign();
  for (let i = 1; i <= 28; i++) await f.create(ENTITY, f.contact({ name: '合成分頁 ' + i, category: i <= 26 ? 'primary_caregiver' : 'other', status: i <= 25 ? 'active' : 'inactive', organization: '共同單位' }));
  await f.create(ENTITY, f.contact({ caseId: f.caseB.id, name: '合成分頁他案', category: 'primary_caregiver' }));
  const query = '?caseId=' + f.caseA.id + '&q=' + encodeURIComponent('合成分頁') + '&pageSize=25';
  const page1 = await f.request(f.clients.caregiver, 'GET', route(null, query + '&page=1'));
  const page2 = await f.request(f.clients.caregiver, 'GET', route(null, query + '&page=2'));
  assert.equal(page1.body.total, 28); assert.equal(page1.body.items.length, 25); assert.equal(page2.body.items.length, 3);
  assert.equal(new Set([...page1.body.items, ...page2.body.items].map(item => item.id)).size, 28);
  const filtered = await f.request(f.admin, 'GET', route(null, query + '&category=primary_caregiver&status=inactive'));
  assert.equal(filtered.body.total, 1); assert.equal(filtered.body.items[0].name, '合成分頁 26');
  assert.equal((await f.request(f.admin, 'GET', route(null, query + '&category=other'))).body.total, 2);
  for (const category of ['', 'invalid', 'General', 'general&category=other', 'general&category=general']) {
    const result = await f.request(f.admin, 'GET', route(null, '?category=' + category));
    assert.equal(result.status, 422); assert.equal(result.body.error.code, 'INVALID_CATEGORY');
  }
  assert.equal((await f.request(f.admin, 'GET', route(null, '?pageSize=101'))).status, 422);
});

test('contacts POST retries are idempotent and PATCH requires current version without changing the parent case', async t => {
  const f = await fixture(t);
  const payload = f.contact({ category: 'case_manager' }), headers = { 'Idempotency-Key': 'contacts-create-once' };
  const one = await f.request(f.admin, 'POST', route(), payload, headers);
  const afterCreate = f.counts();
  const two = await f.request(f.admin, 'POST', route(), payload, headers);
  assert.equal(one.status, 201); assert.deepEqual(two.body, one.body); assert.deepEqual(f.counts(), afterCreate);
  assert.equal((await f.request(f.admin, 'POST', route(), { ...payload, name: 'different' }, headers)).status, 409);
  const contact = one.body.item;
  assert.equal((await f.request(f.admin, 'PATCH', route(contact), { name: '缺少版本' })).status, 422);
  const updated = await f.patch(contact, { note: '督導修改' }, f.clients.supervisor);
  assert.equal(updated.version, 2);
  const beforeConflict = f.counts();
  const conflict = await f.request(f.admin, 'PATCH', route(contact), { version: 1, note: '過時修改' });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'VERSION_CONFLICT'); assert.deepEqual(f.counts(), beforeConflict);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/cases/' + f.caseA.id)).body.item, f.caseA);
});

test('contacts history uses actual actors and exact previous versions across pages while reads and histories stay immutable', async t => {
  const f = await fixture(t); await f.assign();
  let contact = await f.create(ENTITY, f.contact());
  for (let version = 2; version <= 28; version++) contact = await f.patch(contact, { note: '合成第' + version + '版', status: version % 2 ? 'active' : 'inactive' }, version % 2 ? f.admin : f.clients.supervisor);
  const before = f.counts(), changes = f.app.db.prepare('SELECT total_changes() AS n').get().n;
  const first = await f.request(f.clients.caregiver, 'GET', route(contact, '/history?compare=previous&page=1'));
  const second = await f.request(f.clients.finance, 'GET', route(contact, '/history?compare=previous&page=2'));
  assert.equal(first.body.total, 28); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
  assert.deepEqual(first.body.items[0].actor, { id: f.clients.supervisor.user.id, name: f.clients.supervisor.user.name });
  assert.equal(first.body.items[0].snapshot.status, 'inactive'); assert.equal(first.body.items[0].comparison.previousSnapshot.status, 'active');
  assert.deepEqual(first.body.items.at(-1).comparison.previousSnapshot, second.body.items[0].snapshot);
  assert.deepEqual(second.body.items.at(-1).actor, { id: f.admin.user.id, name: f.admin.user.name });
  assert.deepEqual(second.body.items.at(-1).comparison, { status: 'initial', previousVersion: null, previousSnapshot: null });
  const plain = await f.request(f.admin, 'GET', route(contact, '/history'));
  assert.ok(plain.body.items.every(row => !Object.hasOwn(row, 'comparison') && !Object.hasOwn(row, 'actor')));
  for (const compare of ['', 'next', 'previous&compare=previous']) assert.equal((await f.request(f.admin, 'GET', route(contact, '/history?compare=' + compare))).status, 422);
  assert.deepEqual(f.counts(), before); assert.equal(f.app.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', contact.id), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(contact.id), /immutable/);
});

test('all roles exclude contact history from other cases before exact comparisons, even with privileged access to both cases', async t => {
  const f = await fixture(t); await f.assign();
  const recordId = id(), time = now();
  const data = { caseId: f.caseA.id, name: '合成聯絡基準第3版', category: 'general', status: 'active' };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, f.admin.org, ENTITY, JSON.stringify(data), 3, time, time);
  for (const version of [1, 2, 3]) {
    const snapshot = { ...data, caseId: version === 2 ? f.caseB.id : f.caseA.id, name: version === 2 ? 'PRIVATE-OTHER-CASE' : data.name, id: recordId, orgId: f.admin.org, version, createdAt: time, updatedAt: time };
    f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, ENTITY, recordId, version, JSON.stringify(snapshot), time, 'baseline');
  }
  const contact = { id: recordId };
  for (const client of Object.values(f.clients)) {
    for (const query of ['', '?compare=previous']) {
      const result = await f.request(client, 'GET', route(contact, '/history' + query));
      assert.equal(result.status, 200); assert.equal(result.body.total, 2);
      assert.deepEqual(result.body.items.map(row => row.version), [3, 1]);
      assert.ok(!JSON.stringify(result.body).includes('PRIVATE-OTHER-CASE')); assert.ok(!JSON.stringify(result.body).includes(f.caseB.id));
      if (query) {
        assert.equal(result.body.items[0].actor, null);
        assert.deepEqual(result.body.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null });
      }
    }
  }
  const updated = await f.patch({ ...contact, version: 3 }, { note: '合法第4版' });
  const compared = await f.request(f.clients.caregiver, 'GET', route(updated, '/history?compare=previous'));
  assert.equal(compared.body.items[0].comparison.previousVersion, 3); assert.equal(compared.body.items[0].comparison.status, 'available');
  assert.equal(compared.body.items[0].actor.id, f.admin.user.id);
});
