import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { buildSettingsUser, buildSettingsOrganization, confirmSettingsUser, confirmSettingsOrganization, confirmSettingsDemo, confirmSettingsSession, settingsPayloadKey } from '../public/data/settings-create-core.js';

const password = 'synthetic-settings-test-only';
const snapshot = db => ({ changes: db.prepare('SELECT total_changes() n').get().n,
  schema: db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
  tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()])) });
const businessSnapshot = db => snapshot(db).tables;
async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close()); assert.notEqual(new URL(base).port, '4310');
  const request = async (client, method, endpoint, payload, key, extra = {}) => {
    const response = await fetch(base + endpoint, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.auth.csrfToken } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...extra }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const setup = await request(null, 'POST', '/api/setup', { name: '合成設定管理者', email: 'settings-admin@example.invalid', password, organizationName: '合成設定機構' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], auth: setup.data, org: setup.data.organizations[0].id };
  const scope = { orgId: admin.org, userId: admin.auth.user.id };
  const post = async (entity, payload) => { const r = await request(admin, 'POST', '/api/' + entity, payload, randomUUID()); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.item; };
  const employee = await post('employees', { name: '合成設定員工', employeeNo: 'SYN-SET-EMP', status: 'active' });
  const user = (change = {}) => ({ name: '合成設定新帳號', email: 'settings-' + randomUUID() + '@example.invalid', password, role: 'supervisor', employeeId: null, ...change });
  const actor = async role => {
    const item = await post('users', user({ role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) }));
    const login = await request(null, 'POST', '/api/login', { email: item.email, password }); assert.equal(login.status, 200);
    return { cookie: login.headers.get('set-cookie').split(';')[0], auth: login.data, org: admin.org, item };
  };
  const deny = async (client, endpoint, payload, status, key = randomUUID(), extra) => { const before = snapshot(app.db); const r = await request(client, 'POST', endpoint, payload, key, extra); assert.equal(r.status, status, JSON.stringify(r.data)); assert.deepEqual(snapshot(app.db), before); return r; };
  return { app, base, admin, scope, employee, user, actor, request, post, deny };
}

test('legacy HTTP user creation gives closed org/actor receipt for all four roles without exposing password or bindings', async t => {
  const f = await fixture(t);
  for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
    const payload = f.user({ role, employeeId: role === 'caregiver' ? f.employee.id : null, name: '合成' + role });
    const r = await f.request(f.admin, 'POST', '/api/users', payload, randomUUID()); assert.equal(r.status, 201);
    const item = confirmSettingsUser(r.data, f.scope, payload); assert.equal(item.version, 0); assert.equal(item.orgId, f.admin.org);
    assert.equal(JSON.stringify(r.data).includes(password), false); assert.equal(JSON.stringify(r.data).includes('password_hash'), false);
  }
});
test('user, organization and demo exact-key replay returns original receipt with every table and total_changes unchanged', async t => {
  const f = await fixture(t), userPayload = f.user();
  for (const [endpoint, payload, status, confirm] of [
    ['/api/users', userPayload, 201, value => confirmSettingsUser(value, f.scope, userPayload)],
    ['/api/organizations', { name: '合成新機構' }, 201, value => confirmSettingsOrganization(value, f.scope, { name: '合成新機構' })],
    ['/api/demo/seed', {}, 200, value => confirmSettingsDemo(value, f.scope)],
  ]) {
    const key = randomUUID(), first = await f.request(f.admin, 'POST', endpoint, payload, key); assert.equal(first.status, status); confirm(first.data);
    const before = snapshot(f.app.db), second = await f.request(f.admin, 'POST', endpoint, payload, key); assert.equal(second.status, status); assert.deepEqual(second.data, first.data); assert.deepEqual(snapshot(f.app.db), before);
  }
  const repeated = await f.request(f.admin, 'POST', '/api/demo/seed', {}, randomUUID()); assert.equal(confirmSettingsDemo(repeated.data, f.scope).seeded, false);
});
test('demo requester receipt does not claim a later admin originally created existing synthetic data', async t => {
  const f = await fixture(t), manager = await f.actor('admin');
  const initial = await f.request(f.admin, 'POST', '/api/demo/seed', {}, randomUUID()); assert.equal(initial.data.seeded, true);
  const result = await f.request(manager, 'POST', '/api/demo/seed', {}, randomUUID()); assert.equal(result.status, 200);
  confirmSettingsDemo(result.data, { orgId: manager.org, userId: manager.auth.user.id });
  assert.equal(result.data.seeded, false); assert.equal(result.data.requestedBy, manager.auth.user.id); assert.equal(Object.hasOwn(result.data, 'createdBy'), false);
});
test('tampered cached user/org receipts cannot attribute another administrator creation to requester', async t => {
  const f = await fixture(t), manager = await f.actor('admin');
  for (const [endpoint, payload, status] of [['/api/users', f.user(), 201], ['/api/organizations', { name: '合成建立者證據機構' }, 201]]) {
    const actual = await f.request(manager, 'POST', endpoint, payload, randomUUID()); assert.equal(actual.status, status);
    // A corrupt cached envelope can match live rows and requester fields, but
    // cannot change the immutable creation audit written by the other actor.
    const forged = { item: { ...actual.data.item, createdBy: f.scope.userId } };
    if (endpoint === '/api/organizations') f.app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(actual.data.item.id, f.scope.userId, 'admin', null);
    const key = randomUUID();
    f.app.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run(f.scope.orgId, f.scope.userId, key, 'POST ' + endpoint, createHash('sha256').update(JSON.stringify(payload)).digest('hex'), JSON.stringify(forged), status, new Date().toISOString());
    const result = await f.deny(f.admin, endpoint, payload, 409, key); assert.equal(result.data.error.code, 'SETTINGS_RECEIPT_STALE');
  }
});
test('same key different content or route is denied without writes; absent key remains legacy compatible', async t => {
  const f = await fixture(t), payload = f.user(), key = randomUUID(); assert.equal((await f.request(f.admin, 'POST', '/api/users', payload, key)).status, 201);
  await f.deny(f.admin, '/api/users', { ...payload, name: '另一合成內容' }, 409, key); await f.deny(f.admin, '/api/organizations', { name: '合成衝突鍵' }, 409, key);
  assert.equal((await f.request(f.admin, 'POST', '/api/users', f.user())).status, 201);
});
test('all three settings writes reject other roles, anonymous and foreign organization before any writes', async t => {
  const f = await fixture(t);
  for (const client of [await f.actor('supervisor'), await f.actor('finance'), await f.actor('caregiver')]) {
    for (const [route, payload] of [['/api/users', f.user()], ['/api/organizations', { name: '合成不得新建' }], ['/api/demo/seed', {}]]) await f.deny(client, route, payload, 403);
  }
  await f.deny(null, '/api/users', f.user(), 401); await f.deny({ ...f.admin, org: randomUUID() }, '/api/users', f.user(), 403);
  await f.deny(f.admin, '/api/users', f.user(), 403, randomUUID(), { 'X-CSRF-Token': '0'.repeat(64) });
});
test('caregiver missing, inactive or cross-org employee and unknown body fields remain zero-write denials', async t => {
  const f = await fixture(t);
  await f.deny(f.admin, '/api/users', f.user({ role: 'caregiver' }), 422);
  await f.deny(f.admin, '/api/users', f.user({ employeeId: randomUUID() }), 422);
  const inactive = await f.post('employees', { name: '合成停用員工', employeeNo: 'SYN-INACTIVE', status: 'inactive' });
  await f.deny(f.admin, '/api/users', f.user({ role: 'caregiver', employeeId: inactive.id }), 422);
  const foreign = await f.request(f.admin, 'POST', '/api/organizations', { name: '合成外機構' }, randomUUID());
  const foreignClient = { ...f.admin, org: foreign.data.item.id }, foreignEmployee = await f.request(foreignClient, 'POST', '/api/employees', { name: '合成外員工', employeeNo: 'SYN-FOREIGN' }, randomUUID());
  await f.deny(f.admin, '/api/users', f.user({ role: 'caregiver', employeeId: foreignEmployee.data.item.id }), 422);
  for (const [endpoint, payload] of [['/api/users', { ...f.user(), orgId: foreign.data.item.id }], ['/api/organizations', { name: '合成', role: 'admin' }], ['/api/demo/seed', { seeded: true }]]) await f.deny(f.admin, endpoint, payload, 422);
});
test('cached user creation cannot acknowledge old active/role/link receipt after lifecycle change', async t => {
  const f = await fixture(t), payload = f.user(), key = randomUUID(), created = await f.request(f.admin, 'POST', '/api/users', payload, key);
  const changed = await f.request(f.admin, 'PATCH', '/api/account-administration/' + created.data.item.id, { version: 0, role: 'finance', employeeId: null, status: 'active', reason: '合成後續角色調整' }, randomUUID()); assert.equal(changed.status, 200);
  const result = await f.deny(f.admin, '/api/users', payload, 409, key); assert.equal(result.data.error.code, 'SETTINGS_RECEIPT_STALE');
});
test('cached organization and demo receipt corruption or missing live marker cannot claim success', async t => {
  const f = await fixture(t), key = randomUUID(), payload = { name: '合成回執機構' }, created = await f.request(f.admin, 'POST', '/api/organizations', payload, key);
  f.app.db.prepare('UPDATE organizations SET name=? WHERE id=?').run('合成後續改名', created.data.item.id);
  assert.equal((await f.deny(f.admin, '/api/organizations', payload, 409, key)).data.error.code, 'SETTINGS_RECEIPT_STALE');
  const demoKey = randomUUID(); assert.equal((await f.request(f.admin, 'POST', '/api/demo/seed', {}, demoKey)).status, 200);
  f.app.db.prepare('DELETE FROM demo_seeds WHERE org_id=?').run(f.admin.org);
  assert.equal((await f.deny(f.admin, '/api/demo/seed', {}, 409, demoKey)).data.error.code, 'SETTINGS_RECEIPT_STALE');
});
for (const endpoint of ['/api/users', '/api/organizations', '/api/demo/seed']) for (const phase of ['new', 'cached']) test('real partial-body HTTP ' + endpoint + ' ' + phase + ' rejects revoked admin with zero writes', async t => {
  const f = await fixture(t), manager = await f.actor('admin'), payload = endpoint === '/api/users' ? f.user() : endpoint === '/api/organizations' ? { name: '合成不得晚存機構' } : {}, text = JSON.stringify(payload), key = randomUUID();
  if (phase === 'cached') assert.equal((await f.request(f.admin, 'POST', endpoint, payload, key)).status, endpoint === '/api/demo/seed' ? 200 : 201);
  let pending;
  const result = new Promise((resolve, reject) => { pending = http.request(f.base + endpoint, { method: 'POST', headers: { Origin: f.base, Cookie: f.admin.cookie, 'X-Org-Id': f.admin.org, 'X-CSRF-Token': f.admin.auth.csrfToken, 'Idempotency-Key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, response => { let bytes = ''; response.setEncoding('utf8'); response.on('data', part => bytes += part); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(bytes) })); }); pending.on('error', reject); pending.write(text.slice(0, -1)); });
  await new Promise(resolve => setTimeout(resolve, 30));
  const changed = await f.request(manager, 'PATCH', '/api/account-administration/' + f.admin.auth.user.id, { version: 0, role: 'admin', employeeId: null, status: 'suspended', reason: '合成真請求中撤銷帳號' }, randomUUID()); assert.equal(changed.status, 200);
  const before = snapshot(f.app.db); pending.end(text.slice(-1)); assert.equal((await result).status, 401); assert.deepEqual(snapshot(f.app.db), before);
});
test('audit insertion failure rolls back organization/user/domain/idempotency rather than leaving partial creation', async t => {
  const f = await fixture(t); f.app.db.exec("CREATE TEMP TRIGGER settings_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  for (const [endpoint, payload] of [['/api/users', f.user()], ['/api/organizations', { name: '合成回滾機構' }], ['/api/demo/seed', {}]]) {
    const before = businessSnapshot(f.app.db), result = await f.request(f.admin, 'POST', endpoint, payload, randomUUID()); assert.equal(result.status, 500); assert.deepEqual(businessSnapshot(f.app.db), before);
  }
});
test('typed create boundaries reject malformed/missing/unknown/wrong scope/getter receipt without executing accessors', () => {
  const scope = { orgId: randomUUID(), userId: randomUUID() }, payload = buildSettingsUser({ name: '  合成新使用者  ', email: ' SYN@EXAMPLE.INVALID ', password, role: 'supervisor', employeeId: '' });
  assert.equal(payload.name, '合成新使用者'); assert.equal(payload.email, 'syn@example.invalid');
  const item = { id: randomUUID(), orgId: scope.orgId, name: payload.name, email: payload.email, role: payload.role, employeeId: null, status: 'active', version: 0, createdAt: '2026-10-11T00:00:00.000Z', createdBy: scope.userId }, good = { item };
  assert.equal(confirmSettingsUser(good, scope, payload), item);
  for (const value of [null, {}, { item: { ...item, orgId: randomUUID() } }, { item: { ...item, createdBy: randomUUID() } }, { item: { ...item, version: 2 } }, { item: { ...item, status: 'suspended' } }, { item: { ...item, password } }, { item, unknown: true }]) assert.throws(() => confirmSettingsUser(value, scope, payload));
  let called = 0; const malicious = { ...item }; Object.defineProperty(malicious, 'name', { enumerable: true, get() { called++; return item.name; } }); assert.throws(() => confirmSettingsUser({ item: malicious }, scope, payload)); assert.equal(called, 0);
  const org = { id: randomUUID(), name: '合成新機構', role: 'admin', sourceOrgId: scope.orgId, createdBy: scope.userId, createdAt: item.createdAt };
  assert.equal(confirmSettingsOrganization({ item: org }, scope, buildSettingsOrganization({ name: ' 合成新機構 ' })), org); assert.throws(() => confirmSettingsOrganization({ item: { ...org, id: scope.orgId } }, scope, { name: org.name }));
  assert.throws(() => confirmSettingsDemo({ seeded: true, message: '已建立完全合成示範資料', orgId: randomUUID(), requestedBy: scope.userId }, scope));
  assert.throws(() => confirmSettingsDemo({ seeded: true, message: '已建立完全合成示範資料', orgId: scope.orgId, createdBy: scope.userId }, scope));
});
test('payload key remains same for retry, rotates on changed input and does not revive an earlier action key', () => {
  let keys = 0; const keyFor = settingsPayloadKey(() => 'synthetic-key-' + ++keys), one = { name: '合成一' }, two = { name: '合成二' };
  assert.equal(keyFor(one), keyFor({ ...one })); assert.notEqual(keyFor(two), 'synthetic-key-1'); assert.notEqual(keyFor(one), 'synthetic-key-1'); assert.equal(keys, 3);
});
test('session refresh is closed and pins original actor/current org and newly created exact membership; sparse/getter arrays denied', () => {
  const scope = { orgId: randomUUID(), userId: randomUUID() }, organization = { id: randomUUID(), name: '合成新機構' }, original = { name: '合成原管理者', email: 'synthetic@example.invalid' };
  const session = { user: { id: scope.userId, ...original, role: 'admin', employeeId: null }, organizations: [{ id: scope.orgId, name: '合成原機構', role: 'admin', employeeId: null }, { ...organization, role: 'admin', employeeId: null }], csrfToken: '1'.repeat(64) };
  assert.equal(confirmSettingsSession(session, scope, organization, original, session.csrfToken), session);
  for (const changed of [{ ...session, user: { ...session.user, id: randomUUID() } }, { ...session, csrfToken: '2'.repeat(64) }, { ...session, organizations: [session.organizations[0]] }, { ...session, organizations: [session.organizations[0], { ...session.organizations[1], name: '錯誤新機構' }] }, { ...session, organizations: [{ ...session.organizations[0], employeeId: randomUUID() }, session.organizations[1]] }, { ...session, organizations: new Array(2) }]) assert.throws(() => confirmSettingsSession(changed, scope, organization, original, session.csrfToken));
  let called = 0; const list = [...session.organizations]; Object.defineProperty(list, 1, { enumerable: true, get() { called++; return session.organizations[1]; } }); assert.throws(() => confirmSettingsSession({ ...session, organizations: list }, scope, organization, original, session.csrfToken)); assert.equal(called, 0);
});
