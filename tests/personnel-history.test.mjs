import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, insert, business } from '../src/server/model.mjs';

const password = 'synthetic-personnel-history-password';
const CERT = 'employee-certifications', TRAINING = 'employee-training';
const kinds = [CERT, TRAINING];
const historyUrl = (entity, item, query = 'compare=previous') => `/api/${entity}/${item.id}/history` + (query ? '?' + query : '');
const actor = client => ({ id: client.user.id, name: client.user.name });
const noPrevious = status => ({ status, previousVersion: null, previousSnapshot: null });
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extraHeaders = {}) {
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成人員歷程管理員', email: 'personnel-history-admin@example.test', password, organizationName: '合成人員歷程甲機構' });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const clientFrom = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = clientFrom(setup);
  async function create(entity, data, caller = admin, headers) {
    const response = await request(caller, 'POST', '/api/' + entity, data, headers);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const response = await request(caller, 'PATCH', '/api/' + entity + '/' + item.id, { version: item.version, ...data });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.item;
  }
  const employeeA = await create('employees', { name: '合成人員甲', employeeNo: 'TEST-PH-A', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成人員乙', employeeNo: 'TEST-PH-B' });
  const clients = { admin };
  for (const [key, role, employee] of [['supervisor', 'supervisor'], ['finance', 'finance'], ['carerA', 'caregiver', employeeA], ['carerB', 'caregiver', employeeB]]) {
    const email = key + '@personnel-history.example.test';
    await create('users', { name: '合成' + key, email, password, role, ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password });
    assert.equal(login.status, 200); clients[key] = clientFrom(login);
  }
  const data = (entity, overrides = {}) => ({ employeeId: employeeA.id, name: '合成保存名稱', note: '合成保存備註', ...(entity === CERT
    ? { certificateNo: 'TEST-PH-CERT', issuer: '合成發證單位', issuedOn: '2026-01-01', expiresOn: '2026-10-08', status: 'active' }
    : { category: 'in_service', provider: '合成辦訓單位', date: '2026-10-08', trainingMinutes: 61, status: 'completed' }), ...overrides });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  // Explicit memory-only legacy/import fixtures never overwrite saved versions.
  function addSnapshot(entity, item, version, changes = {}, scope = {}) {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(scope.orgId || admin.org, scope.entity || entity, item.id, version, JSON.stringify(snapshot), now(), 'baseline');
    return snapshot;
  }
  function imported(entity, fields, version = 1) {
    const time = now(), item = { ...data(entity, fields), id: id(), orgId: admin.org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, admin.org, entity, JSON.stringify(business(item)), version, time, time);
    return item;
  }
  function auditEvent(entity, item, changes = {}) {
    const { orgId = admin.org, eventEntity = entity, recordId = item.id, userId = admin.user.id, action = 'record.update', detail = { version: item.version }, rawDetail } = changes;
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, eventEntity, recordId, rawDetail ?? JSON.stringify(detail), now());
  }
  return { app, request, create, patch, admin, clients, employeeA, employeeB, data, state, addSnapshot, imported, auditEvent };
}

for (const entity of kinds) test(`${entity} real create, edit, revoke/cancel and restore retain saved fields and exact administrator/supervisor actors`, async t => {
  const f = await fixture(t), v1 = await f.create(entity, f.data(entity, { name: '  合成保存名稱  ' }));
  const changed = entity === CERT ? { certificateNo: 'TEST-PH-NEW', issuer: '合成新發證單位', issuedOn: '2026-02-02', expiresOn: '' } : { category: 'pre_service', provider: '合成新辦訓單位', date: '2026-10-09', trainingMinutes: 125 };
  const v2 = await f.patch(entity, v1, { ...changed, name: '合成更新名稱' }, f.clients.supervisor);
  const v3 = await f.patch(entity, v2, { status: entity === CERT ? 'revoked' : 'cancelled', note: '合成撤銷取消原因' });
  const v4 = await f.patch(entity, v3, { status: entity === CERT ? 'active' : 'completed', note: '合成恢復原因' }, f.clients.supervisor);
  await f.patch('employees', f.employeeA, { name: '合成人員甲目前新名' });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.carerA]) {
    const response = await f.request(caller, 'GET', historyUrl(entity, v4));
    assert.equal(response.status, 200); assert.equal(response.body.total, 4);
    const rows = response.body.items;
    assert.deepEqual(rows.map(row => row.version), [4, 3, 2, 1]);
    assert.deepEqual(rows.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin), actor(f.clients.supervisor), actor(f.admin)]);
    assert.deepEqual(rows.map(row => row.snapshot.status), [v4.status, v3.status, v2.status, v1.status]);
    assert.equal(rows[3].snapshot.name, '合成保存名稱');
    assert.equal(rows[3].snapshot.employeeId, f.employeeA.id);
    assert.ok(!JSON.stringify(rows).includes('合成人員甲目前新名'), 'employee display names do not rewrite saved snapshots');
    for (const [key, value] of Object.entries(changed)) assert.equal(rows[1].snapshot[key], value);
    for (let i = 0; i < 3; i++) {
      assert.equal(rows[i].comparison.status, 'available'); assert.equal(rows[i].comparison.previousVersion, rows[i].version - 1);
      assert.deepEqual(rows[i].comparison.previousSnapshot, rows[i + 1].snapshot);
    }
    assert.deepEqual(rows[3].comparison, noPrevious('initial'));
    const raw = await f.request(caller, 'GET', historyUrl(entity, v4, ''));
    assert.deepEqual(raw.body.items.map(row => row.snapshot), rows.map(row => row.snapshot));
    assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  assert.deepEqual(f.state(), before);
});

test('personnel raw/compare keep same-organization and four-role permissions, including inactive, missing and unlinked caregiver membership', async t => {
  const f = await fixture(t), organization = await f.create('organizations', { name: '合成人員歷程乙機構' }), foreignClient = { ...f.admin, org: organization.id };
  const foreignEmployee = await f.create('employees', { name: '合成跨機構員工', employeeNo: 'TEST-PH-FOREIGN' }, foreignClient);
  const items = [];
  for (const entity of kinds) {
    const mine = await f.create(entity, f.data(entity)), other = await f.create(entity, f.data(entity, { employeeId: f.employeeB.id })); items.push([entity, mine]);
    const before = f.state();
    for (const query of ['', 'compare=previous']) {
      for (const caller of [f.admin, f.clients.supervisor, f.clients.carerA]) assert.equal((await f.request(caller, 'GET', historyUrl(entity, mine, query))).status, 200);
      for (const caller of [foreignClient, f.clients.carerB]) assert.equal((await f.request(caller, 'GET', historyUrl(entity, mine, query))).status, 404);
      assert.equal((await f.request(f.clients.carerA, 'GET', historyUrl(entity, other, query))).status, 404);
      const finance = await f.request(f.clients.finance, 'GET', historyUrl(entity, mine, query)); assert.equal(finance.status, 403); assert.equal(finance.body.error.code, 'ROLE_FORBIDDEN');
      assert.equal((await f.request(null, 'GET', historyUrl(entity, mine, query))).status, 401);
      assert.equal((await f.request(f.admin, 'GET', historyUrl(entity, { id: id() }, query))).status, 404);
    }
    assert.deepEqual(f.state(), before);
  }
  const inactive = await f.patch('employees', f.employeeA, { status: 'inactive' });
  // Personnel validation allows maintenance for an inactive, same-org parent.
  for (const entity of kinds) items.push([entity, await f.create(entity, f.data(entity), f.clients.supervisor)]);
  let before = f.state();
  for (const [entity, item] of items) for (const query of ['', 'compare=previous']) {
    for (const caller of [f.admin, f.clients.supervisor]) assert.equal((await f.request(caller, 'GET', historyUrl(entity, item, query))).body.total, 1);
    const denied = await f.request(f.clients.carerA, 'GET', historyUrl(entity, item, query)); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
  }
  assert.deepEqual(f.state(), before);
  await f.patch('employees', inactive, { status: 'active' });
  for (const employeeId of [null, 'synthetic-missing-employee', foreignEmployee.id]) {
    // Explicit malformed membership fixture tests pre-route authorization.
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.carerA.user.id);
    before = f.state();
    for (const [entity, item] of items) for (const query of ['', 'compare=previous']) {
      const denied = await f.request(f.clients.carerA, 'GET', historyUrl(entity, item, query)); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
    }
    assert.deepEqual(f.state(), before);
  }
});

test('all permitted roles filter foreign, missing and different immutable parents before comparison and pagination without changing current-record scope', async t => {
  const f = await fixture(t), organization = await f.create('organizations', { name: '合成污染來源機構' }), foreignClient = { ...f.admin, org: organization.id };
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN-EMPLOYEE', employeeNo: 'TEST-PH-FOREIGN' }, foreignClient);
  for (const entity of kinds) {
    const item = await f.create(entity, f.data(entity)), missing = id();
    f.addSnapshot(entity, item, 2, { employeeId: f.employeeB.id, note: 'PRIVATE-OTHER-EMPLOYEE' });
    f.addSnapshot(entity, item, 3, { employeeId: foreignEmployee.id, note: 'PRIVATE-FOREIGN-EMPLOYEE' });
    f.addSnapshot(entity, item, 4, { employeeId: missing, note: 'PRIVATE-MISSING-EMPLOYEE' });
    const current = f.addSnapshot(entity, item, 5, { note: '合成可見第五版' });
    f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(JSON.stringify(business(current)), 5, item.id);
    f.addSnapshot(entity, item, 6, { note: 'PRIVATE-WRONG-ORG' }, { orgId: organization.id });
    f.addSnapshot(entity, item, 7, { note: 'PRIVATE-WRONG-ENTITY' }, { entity: entity === CERT ? TRAINING : CERT });
    const orphans = [insert(f.app.db, f.admin.org, entity, f.data(entity, { employeeId: missing })), insert(f.app.db, f.admin.org, entity, f.data(entity, { employeeId: foreignEmployee.id }))];
    const before = f.state();
    for (const caller of [f.admin, f.clients.supervisor, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
      const response = await f.request(caller, 'GET', historyUrl(entity, current, query));
      assert.equal(response.status, 200); assert.equal(response.body.total, 2); assert.deepEqual(response.body.items.map(row => row.version), [5, 1]);
      for (const secret of ['PRIVATE-', missing, foreignEmployee.id, f.employeeB.id]) assert.ok(!JSON.stringify(response.body).includes(secret));
      if (query) { assert.deepEqual(response.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(response.body.items[1].comparison, noPrevious('initial')); }
      const page = await f.request(caller, 'GET', historyUrl(entity, current, (query ? query + '&' : '') + 'page=2&pageSize=1'));
      assert.equal(page.body.total, 2); assert.equal(page.body.items[0].version, 1);
    }
    for (const caller of [f.admin, f.clients.supervisor]) for (const orphan of orphans) {
      assert.equal((await f.request(caller, 'GET', `/api/${entity}/${orphan.id}`)).status, 200, 'current record does not gain a parent join');
      for (const query of ['', 'compare=previous']) {
        const history = await f.request(caller, 'GET', historyUrl(entity, orphan, query));
        assert.equal(history.status, 200); assert.equal(history.body.total, 0); assert.deepEqual(history.body.items, []);
      }
    }
    for (const caller of [f.clients.carerB, foreignClient]) assert.equal((await f.request(caller, 'GET', historyUrl(entity, current))).status, 404);
    assert.deepEqual(f.state(), before);
  }
});

test('personnel actors use only exact record create/update identities and reject wrong scopes, review events, conflicts and missing users', async t => {
  const f = await fixture(t), organization = await f.create('organizations', { name: '合成錯誤稽核機構' });
  for (const entity of kinds) {
    const v1 = await f.create(entity, f.data(entity)), v2 = await f.patch(entity, v1, { note: '合成督導更新' }, f.clients.supervisor);
    for (const change of [
      { orgId: organization.id }, { eventEntity: entity === CERT ? TRAINING : CERT }, { recordId: id() },
      { action: 'service.review' }, { action: 'shift.complete' }, { action: 'unrelated.action' },
      { detail: { version: '2' } }, { detail: { version: 2.5 } }, { detail: { version: 99 } }, { detail: {} }, { rawDetail: '{invalid' },
    ]) f.auditEvent(entity, v2, change);
    let before = f.state(), response = await f.request(f.admin, 'GET', historyUrl(entity, v2));
    assert.deepEqual(response.body.items[0].actor, actor(f.clients.supervisor)); assert.deepEqual(response.body.items[1].actor, actor(f.admin)); assert.deepEqual(f.state(), before);
    f.auditEvent(entity, v2, { userId: f.clients.supervisor.user.id });
    before = f.state(); response = await f.request(f.admin, 'GET', historyUrl(entity, v2)); assert.deepEqual(response.body.items[0].actor, actor(f.clients.supervisor)); assert.deepEqual(f.state(), before);
    f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成督導目前名稱', f.clients.supervisor.user.id);
    before = f.state(); response = await f.request(f.admin, 'GET', historyUrl(entity, v2)); assert.equal(response.body.items[0].actor.name, '合成督導目前名稱'); assert.deepEqual(f.state(), before);
    f.clients.supervisor.user.name = '合成督導目前名稱';
    f.auditEvent(entity, v2); // Different real user, same exact version: ambiguous.
    f.auditEvent(entity, v1, { userId: 'synthetic-missing-user' });
    before = f.state(); response = await f.request(f.admin, 'GET', historyUrl(entity, v2)); assert.deepEqual(response.body.items.map(row => row.actor), [null, null]); assert.deepEqual(f.state(), before);
  }
});

test('baseline gaps, empty history and projected snapshots preserve raw saved dates/minutes without deriving expiry or inventing actors', async t => {
  const f = await fixture(t);
  for (const entity of kinds) {
    const baseline = f.imported(entity, { billingSnapshot: { marker: 'PRIVATE-PERSONNEL-FINANCIAL', employee: { hourlyRateCents: 987654321 } }, fileId: 'PRIVATE-BLOB-ID' }, 3);
    f.addSnapshot(entity, baseline, 1, { note: '合成基準第一版' }); f.addSnapshot(entity, baseline, 3, { note: '合成基準第三版' });
    f.auditEvent(entity, baseline, { detail: { version: '3' } });
    const empty = f.imported(entity, { note: '合成無歷程匯入' });
    const paired = f.imported(entity, { billingSnapshot: { marker: 'PRIVATE-PAIRED-FINANCIAL' }, fileId: 'PRIVATE-PAIRED-BLOB' }, 2);
    f.addSnapshot(entity, paired, 1); f.addSnapshot(entity, paired, 2);
    const before = f.state();
    for (const caller of [f.admin, f.clients.supervisor, f.clients.carerA]) for (const query of ['', 'compare=previous']) {
      const response = await f.request(caller, 'GET', historyUrl(entity, baseline, query)); assert.equal(response.status, 200);
      assert.deepEqual(response.body.items.map(row => row.version), [3, 1]);
      for (const row of response.body.items) {
        assert.equal(row.source, 'baseline'); assert.equal(Object.hasOwn(row.snapshot, 'billingSnapshot'), caller === f.admin);
        assert.ok(!Object.hasOwn(row.snapshot, 'fileId'));
        for (const key of ['expiryState', 'daysToExpiry', 'asOf', 'trainingHours', 'statutoryCredits']) assert.ok(!Object.hasOwn(row.snapshot, key));
        if (query) assert.equal(row.actor, null);
      }
      if (query) { assert.deepEqual(response.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(response.body.items[1].comparison, noPrevious('initial')); }
      const none = await f.request(caller, 'GET', historyUrl(entity, empty, query)); assert.equal(none.status, 200); assert.equal(none.body.total, 0); assert.deepEqual(none.body.items, []);
      const pair = await f.request(caller, 'GET', historyUrl(entity, paired, query)); assert.equal(pair.status, 200);
      const snapshots = pair.body.items.map(row => row.snapshot);
      if (query) { assert.equal(pair.body.items[0].comparison.status, 'available'); snapshots.push(pair.body.items[0].comparison.previousSnapshot); }
      for (const snapshot of snapshots) { assert.equal(Object.hasOwn(snapshot, 'billingSnapshot'), caller === f.admin); assert.ok(!Object.hasOwn(snapshot, 'fileId')); }
      if (caller !== f.admin) assert.ok(!JSON.stringify(pair.body).includes('PRIVATE-PAIRED'));
    }
    assert.deepEqual(f.state(), before);
  }
  const cert = await f.create(CERT, f.data(CERT)), training = await f.create(TRAINING, f.data(TRAINING));
  const before = f.state(), original = await f.request(f.admin, 'GET', historyUrl(CERT, cert));
  for (const [asOf, expiry] of [['2026-10-08', 'due_soon'], ['2026-10-09', 'expired']]) {
    assert.equal((await f.request(f.admin, 'GET', `/api/${CERT}/${cert.id}?asOf=${asOf}`)).body.item.expiryState, expiry);
    assert.deepEqual((await f.request(f.admin, 'GET', historyUrl(CERT, cert, 'compare=previous&asOf=' + asOf))).body, original.body);
  }
  assert.equal((await f.request(f.admin, 'GET', historyUrl(TRAINING, training))).body.items[0].snapshot.trainingMinutes, 61);
  assert.deepEqual(f.state(), before);
});

test('both personnel entities compare exact predecessors across 28 versions and reject invalid comparisons without widening supported routes', async t => {
  const f = await fixture(t);
  const unsupported = await f.create('announcements', { title: '合成仍不支援比較的公告', body: '保留原比較拒絕驗收' });
  for (const entity of kinds) {
    let item = await f.create(entity, f.data(entity));
    for (let version = 2; version <= 28; version++) item = await f.patch(entity, item, { note: '合成真實修改第' + version + '版' }, version % 2 ? f.admin : f.clients.supervisor);
    const before = f.state();
    for (const caller of [f.admin, f.clients.supervisor, f.clients.carerA]) {
      const first = await f.request(caller, 'GET', historyUrl(entity, item, 'compare=previous&page=1&pageSize=25'));
      const second = await f.request(caller, 'GET', historyUrl(entity, item, 'compare=previous&page=2&pageSize=25'));
      assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(first.body.total, 28); assert.equal(second.body.total, 28);
      assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
      assert.equal(first.body.items.at(-1).version, 4); assert.equal(first.body.items.at(-1).comparison.previousVersion, 3);
      assert.deepEqual(first.body.items.at(-1).comparison.previousSnapshot, second.body.items[0].snapshot);
      assert.deepEqual(second.body.items.at(-1).comparison, noPrevious('initial'));
      assert.deepEqual(first.body.items[0].actor, actor(f.clients.supervisor));
      const raw = await f.request(caller, 'GET', historyUrl(entity, item, 'page=2&pageSize=25'));
      assert.deepEqual(raw.body.items.map(row => row.snapshot), second.body.items.map(row => row.snapshot));
      assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
    }
    for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) {
      const invalid = await f.request(f.admin, 'GET', historyUrl(entity, item, query)); assert.equal(invalid.status, 422); assert.equal(invalid.body.error.code, 'INVALID_COMPARE');
    }
    assert.equal((await f.request(f.admin, 'GET', historyUrl('announcements', unsupported, 'compare=next'))).status, 422);
    assert.deepEqual(f.state(), before);
  }
});

test('existing write guards, idempotency, CAS, immutable employee parent and append-only snapshots remain enforced', async t => {
  const f = await fixture(t);
  for (const entity of kinds) {
    const data = f.data(entity), headers = { 'Idempotency-Key': 'synthetic-personnel-history-' + entity };
    const first = await f.request(f.admin, 'POST', '/api/' + entity, data, headers), replay = await f.request(f.admin, 'POST', '/api/' + entity, data, headers);
    assert.equal(first.status, 201); assert.equal(replay.status, 201); assert.deepEqual(first.body, replay.body);
    const item = await f.patch(entity, first.body.item, { employeeId: f.employeeA.id, note: '合成相同員工仍可更新' }, f.clients.supervisor);
    const before = f.state();
    const stale = await f.request(f.admin, 'PATCH', `/api/${entity}/${item.id}`, { version: 1, note: '合成過時更新' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    const moved = await f.request(f.admin, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, employeeId: f.employeeB.id }); assert.equal(moved.status, 409); assert.equal(moved.body.error.code, 'EMPLOYEE_IMMUTABLE');
    assert.equal((await f.request(f.admin, 'POST', '/api/' + entity, { ...data, name: '合成不相同重送' }, headers)).status, 409);
    for (const caller of [f.clients.carerA, f.clients.finance]) {
      assert.equal((await f.request(caller, 'POST', '/api/' + entity, data)).status, 403);
      assert.equal((await f.request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, note: '禁止修改' })).status, 403);
    }
    const saved = await f.request(f.admin, 'GET', historyUrl(entity, item)); assert.equal(saved.body.total, 2); assert.equal(saved.body.items[0].snapshot.employeeId, f.employeeA.id);
    assert.deepEqual(f.state(), before);
    assert.throws(() => f.app.db.prepare('UPDATE record_versions SET source=? WHERE record_id=?').run('tamper', item.id), /immutable/);
    assert.throws(() => f.app.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(item.id), /immutable/);
    assert.deepEqual(f.state(), before);
  }
});

test('all personnel history GETs leave all eleven tables, true approval snapshots and trial fees/payroll unchanged after master price changes', async t => {
  const f = await fixture(t), caseItem = await f.create('cases', { name: '合成計價個案', caseNo: 'TEST-PH-CASE' });
  const service = await f.create('service-items', { code: 'TEST-PH-SERVICE', name: '合成計價項目', minutes: 60, unitPriceCents: 10000 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await f.create('care-plans', { caseId: caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await f.create('shifts', { caseId: caseItem.id, employeeId: f.employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services });
  const submitted = await f.create('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: f.employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, f.clients.carerA);
  const review = await f.request(f.admin, 'POST', `/api/service-records/${submitted.id}/review`, { version: submitted.version, decision: 'approved', reviewNote: '合成核准' });
  assert.equal(review.status, 200); const approved = review.body.item;
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 10000);
  const items = [];
  for (const entity of kinds) { const item = await f.create(entity, f.data(entity)); items.push([entity, await f.patch(entity, item, { note: '合成待閱讀歷程' }, f.clients.supervisor)]); }
  const feesBefore = await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10'), payrollBefore = await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10');
  assert.equal(feesBefore.body.totals.amountCents, 30000); assert.equal(payrollBefore.body.totals.amountCents, 18800);
  await f.patch('employees', f.employeeA, { hourlyRateCents: 99999 }); await f.patch('service-items', service, { unitPriceCents: 88888 });
  const before = f.state();
  for (const [entity, item] of items) for (const caller of [f.admin, f.clients.supervisor, f.clients.carerA, f.clients.finance]) for (const query of ['', 'compare=previous']) {
    const response = await f.request(caller, 'GET', historyUrl(entity, item, query)); assert.equal(response.status, caller === f.clients.finance ? 403 : 200);
  }
  assert.deepEqual((await f.request(f.admin, 'GET', `/api/service-records/${approved.id}`)).body.item, approved);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body.totals.amountCents, feesBefore.body.totals.amountCents);
  assert.equal((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body.totals.amountCents, payrollBefore.body.totals.amountCents);
  const history = await f.request(f.admin, 'GET', historyUrl('service-records', approved)); assert.deepEqual(history.body.items[0].actor, actor(f.admin));
  const completed = (await f.request(f.admin, 'GET', `/api/shifts/${shift.id}`)).body.item;
  assert.equal(completed.status, 'completed'); assert.deepEqual((await f.request(f.admin, 'GET', historyUrl('shifts', completed))).body.items[0].actor, actor(f.admin));
  assert.deepEqual(f.state(), before);
  const lockedRecord = await f.request(f.admin, 'PATCH', `/api/service-records/${approved.id}`, { version: approved.version, note: '禁止修改核准' }); assert.equal(lockedRecord.status, 409); assert.equal(lockedRecord.body.error.code, 'RECORD_LOCKED');
  const lockedShift = await f.request(f.admin, 'PATCH', `/api/shifts/${completed.id}`, { version: completed.version, employeeId: f.employeeB.id }); assert.equal(lockedShift.status, 409); assert.equal(lockedShift.body.error.code, 'SHIFT_HAS_RECORD');
  assert.deepEqual(f.state(), before);
});
