import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/server/index.mjs';
import { business, insert, now, replace } from '../src/server/model.mjs';
import { PORTAL_ORIGIN, provisionPortalAccount } from '../src/server/portal-handoff.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';

const PASSWORD = 'synthetic-account-lifecycle-password-only';
const SECRET = 'synthetic-account-lifecycle-handoff-key-only';
const route = id => '/api/account-administration/' + id;
const accountPayload = (item, change = {}) => ({ version: item.version, role: item.role, employeeId: item.employeeId, status: item.status, reason: '合成帳號變更原因', ...change });
const raw = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const state = db => ({ tables: raw(db), triggers: db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all(), changes: db.prepare('SELECT total_changes() AS n').get().n });
const noWrite = (db, before) => assert.deepEqual(state(db), before, 'Rejected operation must change no tables, histories, audit, sessions, idempotency or total_changes');
const tableCounts = db => ({ tables: db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, triggers: db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger'").get().n });

async function fixture(t, { portal = false } = {}) {
  const app = createApp({ dbPath: ':memory:', port: 0, ...(portal ? { portalConfig: { mode: 'portal', publicOrigin: 'http://127.0.0.1:0', portalOrigin: PORTAL_ORIGIN, signingSecret: SECRET } } : {}) });
  t.after(() => app.close());
  const base = await app.listen(); assert.notEqual(new URL(base).port, '4310');
  const request = async (method, path, { identity, payload, key, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/json', ...(identity ? { Cookie: identity.cookie, 'X-CSRF-Token': identity.csrfToken, 'X-Org-Id': identity.orgId } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers }, ...(payload !== undefined ? { body: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}) });
    const text = await response.text(); let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, response };
  };
  const companyAccount = (role, suffix, employeeId) => ({ organizationName: '合成帳號管理機構', name: '合成' + suffix, email: suffix + '@example.invalid', issuer: PORTAL_ORIGIN, googleSubject: 'synthetic_account_' + suffix, authUserId: randomUUID(), role, ...(employeeId ? { employeeId } : {}) });
  const handoff = async (account, change = {}) => {
    const seconds = Math.floor(Date.now() / 1000), claims = { aud: 'home-care', moduleId: 'home-care', iss: account.issuer, googleSubject: account.googleSubject, authUserId: account.authUserId, email: account.email, iat: seconds, exp: seconds + 60, jti: randomUUID(), ...change };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'), signature = createHmac('sha256', SECRET).update(payload, 'ascii').digest('base64url');
    return request('POST', '/api/auth/handoff', { payload: new URLSearchParams({ payload, signature }).toString(), headers: { Origin: PORTAL_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' } });
  };
  const sessionFrom = async result => {
    const cookie = result.response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
    const current = await request('GET', '/api/session', { headers: { Cookie: cookie } }); assert.equal(current.status, 200);
    return { cookie, ...current.body, orgId: current.body.organizations[0].id };
  };
  const login = async email => { const result = await request('POST', '/api/login', { payload: { email, password: PASSWORD } }); assert.equal(result.status, 200, JSON.stringify(result.body)); return sessionFrom(result); };
  let owner, ownerAccount;
  if (portal) {
    ownerAccount = companyAccount('admin', 'owner'); provisionPortalAccount(app.db, ownerAccount);
    const authenticated = await handoff(ownerAccount); assert.equal(authenticated.status, 303); owner = await sessionFrom(authenticated);
  } else {
    const setup = await request('POST', '/api/setup', { payload: { name: '合成管理者', email: 'owner@example.invalid', password: PASSWORD, organizationName: '合成帳號管理機構' } }); assert.equal(setup.status, 201); owner = await sessionFrom(setup);
  }
  const post = async (entity, payload) => { const result = await request('POST', '/api/' + entity, { identity: owner, payload }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const employee = await post('employees', { name: '合成有效員工', employeeNo: 'ACCOUNT-E-01' });
  const inactiveEmployee = await post('employees', { name: '合成停用員工', employeeNo: 'ACCOUNT-E-02', status: 'inactive' });
  const accounts = {}, identities = {};
  for (const role of ['admin', 'supervisor', 'caregiver', 'finance']) {
    if (portal) {
      const account = companyAccount(role, 'account_' + role, role === 'caregiver' ? employee.id : undefined), provisioned = provisionPortalAccount(app.db, account);
      accounts[role] = { id: provisioned.userId, account };
      const authenticated = await handoff(account); assert.equal(authenticated.status, 303); identities[role] = await sessionFrom(authenticated);
    } else {
      accounts[role] = await post('users', { name: '合成' + role, email: 'account_' + role + '@example.invalid', password: PASSWORD, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
      identities[role] = await login(accounts[role].email);
    }
  }
  const read = async id => { const result = await request('GET', route(id), { identity: owner }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item; };
  const change = (item, patch, key = randomUUID(), identity = owner) => request('PATCH', route(item.id), { identity, payload: accountPayload(item, patch), key });
  const arm = (path, method, callback) => {
    let before;
    const listener = req => { if (req.url === path && req.method === method) { app.server.off('request', listener); callback(req); before = state(app.db); } };
    app.server.on('request', listener);
    return () => { assert(before, 'HTTP body wait window must actually execute'); noWrite(app.db, before); };
  };
  return { app, base, request, owner, ownerAccount, accounts, identities, employee, inactiveEmployee, post, read, change, arm, login, handoff, sessionFrom };
}

test('Account administration is same-org admin only for list, detail, history and PATCH across all four roles', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id);
  for (const role of ['supervisor', 'caregiver', 'finance']) for (const [method, path, payload] of [
    ['GET', '/api/account-administration'], ['GET', route(target.id)], ['GET', route(target.id) + '/history'], ['PATCH', route(target.id), accountPayload(target, { status: 'suspended' })],
  ]) {
    const before = state(f.app.db), result = await f.request(method, path, { identity: f.identities[role], payload, key: 'denied-' + role + method + path });
    assert.equal(result.status, 403, role + ' ' + path); noWrite(f.app.db, before);
  }
  for (const identity of [f.owner, f.identities.admin]) {
    const result = await f.request('GET', '/api/account-administration', { identity }); assert.equal(result.status, 200); assert.equal(result.body.total, 5); assert.equal(result.body.orgId, f.owner.orgId);
  }
  assert.deepEqual(tableCounts(f.app.db), { tables: 11, triggers: 6 });
});

test('Account list/detail are read-only explicit typed projections without provider identity, password or tokens', async t => {
  const f = await fixture(t), before = state(f.app.db), list = await f.request('GET', '/api/account-administration?pageSize=2&q=合成', { identity: f.owner });
  assert.equal(list.status, 200); assert.equal(list.body.items.length, 2); noWrite(f.app.db, before);
  for (const item of list.body.items) assert.deepEqual(Object.keys(item).sort(), ['id', 'orgId', 'name', 'email', 'role', 'employeeId', 'employeeName', 'employeeStatus', 'status', 'version', 'updatedAt', 'portalBound', 'bindingActive', 'isSelf', 'canManage'].sort());
  const self = await f.read(f.owner.user.id); assert.equal(self.isSelf, true); assert.equal(self.canManage, false); assert.equal(self.version, 0); assert.equal(self.employeeId, null); assert.equal(self.employeeName, null); assert.equal(self.employeeStatus, null);
  const caregiver = await f.read(f.accounts.caregiver.id); assert.equal(caregiver.employeeId, f.employee.id); assert.equal(caregiver.employeeStatus, 'active'); assert.equal(caregiver.portalBound, false); assert.equal(caregiver.bindingActive, null);
});

test('Suspension/reinstatement captures immutable version history, role/link provenance and revokes old sessions', async t => {
  const f = await fixture(t), original = await f.read(f.accounts.caregiver.id), employeeBefore = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(f.employee.id);
  const result = await f.change(original, { status: 'suspended', reason: '合成離職停用' }); assert.equal(result.status, 200); assert.equal(result.body.item.version, 2); assert.equal(result.body.item.status, 'suspended'); assert.equal(result.body.sessionsRevoked, 1);
  assert.deepEqual(f.app.db.prepare('SELECT * FROM records WHERE id=?').get(f.employee.id), employeeBefore, 'Suspending an account must not suspend employment');
  assert.equal((await f.request('GET', '/api/dashboard', { identity: f.identities.caregiver })).status, 401);
  const denied = await f.request('POST', '/api/login', { payload: { email: f.accounts.caregiver.email, password: PASSWORD } }); assert.equal(denied.status, 401);
  const history = await f.request('GET', route(original.id) + '/history', { identity: f.owner }); assert.equal(history.status, 200); assert.equal(history.body.total, 2); assert.equal(history.body.orgId, f.owner.orgId); assert.equal(history.body.id, original.id);
  assert.deepEqual(history.body.items.map(item => item.source), ['account.change', 'account.baseline']); assert.equal(history.body.items[0].snapshot.reason, '合成離職停用'); assert.equal(history.body.items[0].snapshot.changedBy, f.owner.user.id); assert.equal(history.body.items[1].snapshot.changedBy, null); for (const row of history.body.items) assert.equal(row.snapshot.changedAt, row.createdAt);
  const recordId = f.app.db.prepare("SELECT id FROM records WHERE entity='account-lifecycle'").get().id;
  assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('bad', recordId), /immutable/);
  assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(recordId), /immutable/);
  const restored = await f.change(result.body.item, { status: 'active', reason: '合成復職開通' }); assert.equal(restored.status, 200); assert.equal(restored.body.item.version, 3);
  assert.equal((await f.request('GET', '/api/dashboard', { identity: f.identities.caregiver })).status, 401, 'Previously revoked cookie must remain unusable after reinstatement');
  const fresh = await f.login(f.accounts.caregiver.email); assert.equal((await f.request('GET', '/api/dashboard', { identity: fresh })).status, 200);
  const events = f.app.db.prepare("SELECT detail FROM audit WHERE action='account.change' ORDER BY created_at,rowid").all(); assert.equal(events.length, 2); assert.equal(JSON.parse(events[0].detail).sessionsRevoked, 1);
});

test('Role and employee reassignment require current active same-org employee and revoke cached authority', async t => {
  const f = await fixture(t), finance = await f.read(f.accounts.finance.id);
  const changed = await f.change(finance, { role: 'caregiver', employeeId: f.employee.id }); assert.equal(changed.status, 200); assert.equal(changed.body.item.role, 'caregiver'); assert.equal(changed.body.item.employeeName, f.employee.name);
  assert.equal((await f.request('GET', '/api/dashboard', { identity: f.identities.finance })).status, 401);
  const fresh = await f.login(f.accounts.finance.email); assert.equal(fresh.user.role, 'caregiver'); assert.equal(fresh.user.employeeId, f.employee.id);
  const back = await f.change(changed.body.item, { role: 'finance', employeeId: null }); assert.equal(back.status, 200); assert.equal(back.body.item.employeeName, null); assert.equal(back.body.item.employeeStatus, null);
});

test('Suspension may preserve an unchanged inactive employee linkage but reactivation and reassignment still require active same-org employee', async t => {
  const f = await fixture(t), caregiver = await f.read(f.accounts.caregiver.id);
  replace(f.app.db, f.owner.orgId, 'employees', f.employee, { ...business(f.employee), status: 'inactive' });
  const suspended = await f.change(caregiver, { status: 'suspended' }); assert.equal(suspended.status, 200); assert.equal(suspended.body.item.employeeId, f.employee.id); assert.equal(suspended.body.item.employeeStatus, 'inactive');
  let before = state(f.app.db), denied = await f.change(suspended.body.item, { status: 'active' }); assert.equal(denied.status, 422); assert.equal(denied.body.error.code, 'INVALID_REFERENCE'); noWrite(f.app.db, before);
  before = state(f.app.db); denied = await f.change(suspended.body.item, { employeeId: f.inactiveEmployee.id }); assert.equal(denied.status, 422); noWrite(f.app.db, before);
  const active = await f.post('employees', { name: '合成新有效連結員工', employeeNo: 'ACCOUNT-RELINK' });
  const restored = await f.change(suspended.body.item, { status: 'active', employeeId: active.id }); assert.equal(restored.status, 200); assert.equal(restored.body.item.employeeId, active.id);
});

for (const [label, patch, code] of [
  ['missing employee for caregiver', { role: 'caregiver', employeeId: null }, 'EMPLOYEE_LINK_REQUIRED'],
  ['inactive employee', { role: 'caregiver', employeeId: 'inactive' }, 'INVALID_REFERENCE'],
  ['non-existent employee', { employeeId: randomUUID() }, 'INVALID_REFERENCE'],
  ['blank reason', { status: 'suspended', reason: '   ' }, 'ACCOUNT_CHANGE_INVALID'],
  ['unknown role', { role: 'owner' }, 'ACCOUNT_CHANGE_INVALID'],
  ['unknown status', { status: 'inactive' }, 'ACCOUNT_CHANGE_INVALID'],
  ['fractional version', { version: 0.5, status: 'suspended' }, 'ACCOUNT_CHANGE_INVALID'],
  ['identity expansion', { googleSubject: 'synthetic_not_allowed', status: 'suspended' }, 'ACCOUNT_CHANGE_INVALID'],
]) test('Rejected account change: ' + label + ' is all-table zero-write', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id), payload = { ...patch, ...(patch.employeeId === 'inactive' ? { employeeId: f.inactiveEmployee.id } : {}) }, before = state(f.app.db);
  const result = await f.change(target, payload); assert.equal(result.status, 422); assert.equal(result.body.error.code, code); noWrite(f.app.db, before);
});

test('CAS rejects stale writes and idempotency safely replays once, conflicts and superseded receipts stay zero-write', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id), first = await f.change(target, { status: 'suspended' }, 'synthetic-suspend'); assert.equal(first.status, 200);
  let before = state(f.app.db), replay = await f.change(target, { status: 'suspended' }, 'synthetic-suspend'); assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); noWrite(f.app.db, before);
  before = state(f.app.db); const stale = await f.change(target, { role: 'supervisor' }, 'synthetic-stale'); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT'); noWrite(f.app.db, before);
  before = state(f.app.db); const conflict = await f.change(target, { role: 'supervisor' }, 'synthetic-suspend'); assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT'); noWrite(f.app.db, before);
  const second = await f.change(first.body.item, { status: 'active' }, 'synthetic-reactivate'); assert.equal(second.status, 200);
  before = state(f.app.db); replay = await f.change(target, { status: 'suspended' }, 'synthetic-suspend'); assert.equal(replay.status, 409); assert.equal(replay.body.error.code, 'ACCOUNT_RECEIPT_STALE'); noWrite(f.app.db, before);
});

test('Missing idempotency, unknown/duplicate query and empty changes are rejected before all writes', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id);
  for (const [method, path, payload, code] of [
    ['PATCH', route(target.id), accountPayload(target, { status: 'suspended' }), 'IDEMPOTENCY_REQUIRED'],
    ['GET', '/api/account-administration?status=active&status=suspended', undefined, 'INVALID_QUERY'],
    ['GET', '/api/account-administration?role=owner', undefined, 'INVALID_QUERY'],
    ['GET', route(target.id) + '?orgId=foreign', undefined, 'INVALID_QUERY'],
  ]) { const before = state(f.app.db), result = await f.request(method, path, { identity: f.owner, payload }); assert.equal(result.status, 422); assert.equal(result.body.error.code, code); noWrite(f.app.db, before); }
  const before = state(f.app.db), empty = await f.change(target, {}); assert.equal(empty.status, 409); assert.equal(empty.body.error.code, 'ACCOUNT_CHANGE_EMPTY'); noWrite(f.app.db, before);
  const invalidHistory = await f.request('GET', '/api/account-administration/history', { identity: f.owner }); assert.equal(invalidHistory.status, 404); noWrite(f.app.db, before);
});

test('Cross-org IDs are unobservable and employee linkage cannot cross institutions', async t => {
  const f = await fixture(t), otherOrg = randomUUID(), otherUser = randomUUID();
  f.app.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(otherOrg, '合成另一機構', now()); f.app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(otherUser, '合成他機構帳號', 'other@example.invalid', '!synthetic-only!', now()); f.app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(otherOrg, otherUser, 'finance', null);
  const otherEmployee = insert(f.app.db, otherOrg, 'employees', { name: '合成另一機構員工', employeeNo: 'OTHER-E', status: 'active' });
  for (const [method, path, payload] of [['GET', route(otherUser)], ['GET', route(otherUser) + '/history'], ['PATCH', route(otherUser), { version: 0, role: 'finance', employeeId: null, status: 'suspended', reason: '合成跨機構拒絕' }]]) { const before = state(f.app.db), result = await f.request(method, path, { identity: f.owner, payload, key: randomUUID() }); assert.equal(result.status, 404); noWrite(f.app.db, before); }
  const target = await f.read(f.accounts.finance.id), before = state(f.app.db), result = await f.change(target, { role: 'caregiver', employeeId: otherEmployee.id }); assert.equal(result.status, 422); noWrite(f.app.db, before);
});

test('Last active administrator and caller self-demotion/suspension/link changes are protected', async t => {
  const f = await fixture(t), self = await f.read(f.owner.user.id);
  for (const patch of [{ role: 'finance' }, { status: 'suspended' }, { employeeId: f.employee.id }]) { const before = state(f.app.db), result = await f.change(self, patch); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'SELF_ACCOUNT_CHANGE_FORBIDDEN'); noWrite(f.app.db, before); }
  const otherAdmin = await f.read(f.accounts.admin.id), suspended = await f.change(otherAdmin, { status: 'suspended' }); assert.equal(suspended.status, 200);
  for (const patch of [{ role: 'finance' }, { status: 'suspended' }]) { const before = state(f.app.db), result = await f.change(self, patch); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'LAST_ADMIN_REQUIRED'); noWrite(f.app.db, before); }
});

test('In-flight old admin request and cached receipts fail after an actual account suspension during body wait', async t => {
  const f = await fixture(t), otherAdmin = await f.read(f.accounts.admin.id), payload = { name: '合成不可新增個案', caseNo: 'DENIED-SUSPEND' };
  const targetPath = '/api/cases';
  const stable = await f.request('POST', targetPath, { identity: f.identities.admin, payload, key: 'old-authority' }); assert.equal(stable.status, 201);
  const data = JSON.stringify({ ...payload, caseNo: 'DENIED-IN-FLIGHT' }), identity = f.identities.admin, url = new URL(f.base);
  let req, arrivedResolve;
  const arrived = new Promise(resolve => { arrivedResolve = resolve; });
  const listener = incoming => { if (incoming.url === targetPath && incoming.headers['idempotency-key'] === 'actual-in-flight') { f.app.server.off('request', listener); arrivedResolve(); } };
  f.app.server.on('request', listener);
  const response = new Promise((resolve, reject) => {
    req = http.request({ hostname: url.hostname, port: url.port, path: targetPath, method: 'POST', headers: { Origin: f.base, Cookie: identity.cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-CSRF-Token': identity.csrfToken, 'X-Org-Id': identity.orgId, 'Idempotency-Key': 'actual-in-flight' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.write(data.slice(0, 1));
  });
  await arrived;
  const suspended = await f.change(otherAdmin, { status: 'suspended' }); assert.equal(suspended.status, 200);
  const before = state(f.app.db); req.end(data.slice(1)); const inFlight = await response; assert.equal(inFlight.status, 401); noWrite(f.app.db, before);
  const denied = await f.request('POST', targetPath, { identity: f.identities.admin, payload, key: 'old-authority' }); assert.equal(denied.status, 401); noWrite(f.app.db, before);
});

test('Runtime body recheck rejects changed account administrator role before account mutation with zero writes', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id);
  const unchanged = f.arm(route(target.id), 'PATCH', () => f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('supervisor', f.owner.orgId, f.owner.user.id));
  const denied = await f.change(target, { status: 'suspended' }); assert.equal(denied.status, 403); unchanged();
});

test('Corrupt lifecycle/head fails closed; atomic audit failure rolls back state, sessions and membership', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id), beforeTables = raw(f.app.db);
  f.app.db.exec("CREATE TRIGGER synthetic_account_audit_failure BEFORE INSERT ON audit WHEN NEW.action='account.change' BEGIN SELECT RAISE(ABORT,'synthetic account failure'); END;");
  const failed = await f.change(target, { status: 'suspended' }); assert.equal(failed.status, 500); assert.deepEqual(raw(f.app.db), beforeTables);
  f.app.db.exec('DROP TRIGGER synthetic_account_audit_failure');
  const result = await f.change(target, { status: 'suspended' }); assert.equal(result.status, 200);
  f.app.db.prepare("UPDATE records SET data=? WHERE entity='account-lifecycle'").run(JSON.stringify({ status: 'active' }));
  const before = state(f.app.db), read = await f.request('GET', route(target.id), { identity: f.owner }); assert.equal(read.status, 409); assert.equal(read.body.error.code, 'ACCOUNT_STATE_INVALID'); noWrite(f.app.db, before);
});

test('Direct membership role/link drift from an immutable lifecycle head fails closed without reconciliation writes', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id), changed = await f.change(target, { role: 'supervisor' }); assert.equal(changed.status, 200);
  f.app.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('admin', f.owner.orgId, target.id);
  const before = state(f.app.db), result = await f.request('GET', route(target.id), { identity: f.owner }); assert.equal(result.status, 409); assert.equal(result.body.error.code, 'ACCOUNT_STATE_INVALID'); noWrite(f.app.db, before);
});

test('Direct account mutation requires a real transaction and cannot create partial lifecycle state', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id), before = state(f.app.db);
  assert.throws(() => commitAccountChange(f.app.db, { orgId: f.owner.orgId, role: 'admin', user: f.owner.user }, target.id, accountPayload(target, { status: 'suspended' })), error => error.code === 'ACCOUNT_TRANSACTION_REQUIRED'); noWrite(f.app.db, before);
});

test('Suspension remains institution-scoped while session revocation is conservative across explicit local memberships', async t => {
  const f = await fixture(t), target = await f.read(f.accounts.finance.id), second = await f.request('POST', '/api/organizations', { identity: f.owner, payload: { name: '合成另一明確授權機構' } }); assert.equal(second.status, 201);
  f.app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(second.body.item.id, target.id, 'finance', null);
  const suspended = await f.change(target, { status: 'suspended' }); assert.equal(suspended.status, 200);
  const fresh = await f.login(f.accounts.finance.email); assert.equal(fresh.orgId, second.body.item.id); assert.equal(fresh.organizations.length, 1); assert.equal((await f.request('GET', '/api/dashboard', { identity: fresh })).status, 200);
  const before = state(f.app.db), denied = await f.request('GET', '/api/dashboard', { identity: fresh, headers: { 'X-Org-Id': f.owner.orgId } }); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'ACCOUNT_SUSPENDED'); noWrite(f.app.db, before);
});

test('Portal four-role provisioning plus caregiver suspension/reinstatement retains exact private identity and single-org binding', async t => {
  const f = await fixture(t, { portal: true }); assert.deepEqual(tableCounts(f.app.db), { tables: 13, triggers: 6 });
  const target = await f.read(f.accounts.caregiver.id); assert.equal(target.portalBound, true); assert.equal(target.bindingActive, true);
  const binding = f.app.db.prepare('SELECT * FROM portal_identity_bindings WHERE user_id=?').get(target.id);
  for (const key of ['issuer', 'google_subject', 'portal_auth_user_id']) assert(!JSON.stringify(target).includes(binding[key]));
  const beforeProvision = state(f.app.db), duplicate = provisionPortalAccount(f.app.db, f.accounts.caregiver.account); assert.equal(duplicate.status, 'already-provisioned'); noWrite(f.app.db, beforeProvision);
  const suspended = await f.change(target, { status: 'suspended' }); assert.equal(suspended.status, 200); assert.deepEqual(f.app.db.prepare('SELECT * FROM portal_identity_bindings WHERE user_id=?').get(target.id), binding);
  let before = state(f.app.db); const rejected = await f.handoff(f.accounts.caregiver.account); assert.equal(rejected.status, 403); assert.equal(rejected.body.error.code, 'PORTAL_IDENTITY_DENIED'); noWrite(f.app.db, before);
  before = state(f.app.db); assert.throws(() => provisionPortalAccount(f.app.db, f.accounts.caregiver.account), error => error.code === 'PORTAL_PROVISION_CONFLICT'); noWrite(f.app.db, before);
  const restored = await f.change(suspended.body.item, { status: 'active' }); assert.equal(restored.status, 200);
  const signed = await f.handoff(f.accounts.caregiver.account); assert.equal(signed.status, 303); const fresh = await f.sessionFrom(signed); assert.equal(fresh.user.role, 'caregiver'); assert.equal(fresh.user.employeeId, f.employee.id);
  for (const change of [{ authUserId: randomUUID() }, { googleSubject: 'synthetic_wrong_subject' }, { email: 'wrong@example.invalid' }]) { before = state(f.app.db); const denied = await f.handoff(f.accounts.caregiver.account, change); assert.equal(denied.status, 403); noWrite(f.app.db, before); }
});

test('Reactivating lifecycle never re-enables a withdrawn Portal binding or changes employee status', async t => {
  const f = await fixture(t, { portal: true }), target = await f.read(f.accounts.caregiver.id), suspended = await f.change(target, { status: 'suspended' }); assert.equal(suspended.status, 200);
  f.app.db.prepare('UPDATE portal_identity_bindings SET active=0 WHERE user_id=?').run(target.id);
  const bindingBefore = f.app.db.prepare('SELECT * FROM portal_identity_bindings WHERE user_id=?').get(target.id), restored = await f.change(suspended.body.item, { status: 'active' }); assert.equal(restored.status, 200); assert.equal(restored.body.item.status, 'active'); assert.equal(restored.body.item.bindingActive, false);
  assert.deepEqual(f.app.db.prepare('SELECT * FROM portal_identity_bindings WHERE user_id=?').get(target.id), bindingBefore);
  const before = state(f.app.db), denied = await f.handoff(f.accounts.caregiver.account); assert.equal(denied.status, 403); noWrite(f.app.db, before);
});
