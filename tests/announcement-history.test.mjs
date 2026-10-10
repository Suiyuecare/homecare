import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, now, business } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const ENTITY = 'announcements';
const password = 'synthetic-announcement-history-password';
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];
const history = (item, query = 'compare=previous', entity = ENTITY) => `/api/${entity}/${item.id}/history${query ? '?' + query : ''}`;
const actor = client => ({ id: client.user.id, name: client.user.name });
const noPrevious = status => ({ status, previousVersion: null, previousSnapshot: null });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extraHeaders = {}) {
    const response = await fetch(base + route, { method,
      headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text, bytes, headers: response.headers };
  }
  const setup = await request(null, 'POST', '/api/setup', { name: '合成公告管理者', email: 'announcement-history-admin@example.test', password, organizationName: '合成公告甲機構' });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const clientFrom = result => ({ cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken, org: setup.body.organizations[0].id, user: result.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin) {
    const result = await request(caller, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成公告居服員', employeeNo: 'TEST-ANN-EMP', hourlyRateCents: 24000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@announcement-history.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成公告個案甲', caseNo: 'TEST-ANN-CA' });
  const caseB = await create('cases', { name: '合成公告個案乙', caseNo: 'TEST-ANN-CB', status: 'paused' });
  const service = await create('service-items', { code: 'TEST-ANN-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services });
  const data = overrides => ({ title: '合成公告標題', body: '合成公告內容', audience: 'all', status: 'draft', ...overrides });
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => [table, app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  });
  // These explicit imported/corrupt fixtures exist only in this memory database.
  function imported(fields = {}, version = 1) {
    const time = now(), item = { ...data(fields), id: id(), orgId: admin.org, version, createdAt: time, updatedAt: time };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, admin.org, ENTITY, JSON.stringify(business(item)), version, time, time);
    return item;
  }
  function addSnapshot(item, version, changes = {}, scope = {}) {
    const snapshot = { ...item, ...changes, version };
    app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(scope.orgId || admin.org, scope.entity || ENTITY, item.id, version, JSON.stringify(snapshot), now(), 'baseline');
    return snapshot;
  }
  function auditEvent(item, changes = {}) {
    const { orgId = admin.org, entity = ENTITY, recordId = item.id, userId = admin.user.id, action = 'record.update', detail = { version: item.version }, rawDetail } = changes;
    app.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(id(), orgId, userId, action, entity, recordId, rawDetail ?? JSON.stringify(detail), now());
  }
  async function approve() {
    const record = await create('service-records', { shiftId: shift.id, caseId: caseA.id, employeeId: employee.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services, status: 'submitted' }, clients.caregiver);
    const response = await request(clients.supervisor, 'POST', `/api/service-records/${record.id}/review`, { version: record.version, decision: 'approved', reviewNote: '合成核閱' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const confirmed = await request(admin, 'GET', `/api/service-records/${record.id}`);
    assert.equal(confirmed.status, 200); return confirmed.body.item;
  }
  return { app, request, create, patch, admin, clients, employee, caseA, caseB, service, plan, shift, data, state, imported, addSnapshot, auditEvent, approve };
}

test('real publication lifecycle retains exact saved text, actors and caregiver [6,5,2] gaps for raw and comparison', async t => {
  const f = await fixture(t), text = '  合成公告\n<script>literal only</script>\n  ';
  const v1 = await f.create(ENTITY, f.data({ title: '  合成標題  ', body: text }));
  const v2 = await f.patch(ENTITY, v1, { status: 'published' }, f.clients.supervisor);
  const v3 = await f.patch(ENTITY, v2, { audience: 'supervisor', body: 'PRIVATE-SUPERVISOR-BODY' });
  const v4 = await f.patch(ENTITY, v3, { status: 'draft', body: 'PRIVATE-DRAFT-BODY' }, f.clients.supervisor);
  const v5 = await f.patch(ENTITY, v4, { status: 'published', audience: 'caregiver', body: text });
  const v6 = await f.patch(ENTITY, v5, { body: text + '合成更新' }, f.clients.supervisor);
  const before = f.state();
  for (const caller of Object.values(f.clients)) {
    const caregiver = caller === f.clients.caregiver;
    const expected = caregiver ? [6, 5, 2] : [6, 5, 4, 3, 2, 1];
    const response = await f.request(caller, 'GET', history(v6)); assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map(row => row.version), expected); assert.equal(response.body.total, expected.length);
    assert.deepEqual(response.body.items.map(row => row.actor), expected.map(v => actor(v % 2 === 0 ? f.clients.supervisor : f.admin)));
    assert.equal(response.body.items[0].snapshot.body, text + '合成更新');
    assert.equal(response.body.items[0].comparison.previousSnapshot.body, text);
    assert.equal(response.body.items[0].comparison.previousVersion, 5);
    assert.equal(response.body.items[0].snapshot.title, '  合成標題  ');
    if (caregiver) {
      assert.deepEqual(response.body.items[1].comparison, noPrevious('unavailable'));
      assert.deepEqual(response.body.items[2].comparison, noPrevious('unavailable'));
      assert.ok(!JSON.stringify(response.body).includes('PRIVATE-'));
    } else {
      for (const row of response.body.items.slice(0, -1)) assert.equal(row.comparison.previousVersion, row.version - 1);
      assert.deepEqual(response.body.items.at(-1).comparison, noPrevious('initial'));
      assert.equal(response.body.items.at(-1).snapshot.body, text);
    }
    const raw = await f.request(caller, 'GET', history(v6, '')); assert.equal(raw.status, 200);
    assert.deepEqual(raw.body.items.map(row => row.snapshot), response.body.items.map(row => row.snapshot));
    assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
    assert.ok(response.body.items.every(row => Object.keys(row).sort().join(',') === 'actor,comparison,createdAt,snapshot,source,version'));
    assert.deepEqual(f.state(), before);
  }
});

test('current status and arbitrary saved audience strings retain the four original role scopes', async t => {
  const f = await fixture(t), items = [];
  for (const status of ['draft', 'published']) for (const audience of ['all', 'caregiver', 'supervisor', 'finance', 'admin', '__proto__', 'constructor', 'toString', '', ' all ', '全體同仁']) {
    items.push(await f.create(ENTITY, f.data({ status, audience })));
  }
  const before = f.state();
  for (const caller of Object.values(f.clients)) {
    const expected = caller === f.clients.caregiver ? items.filter(item => item.status === 'published' && ['all', 'caregiver'].includes(item.audience)) : items;
    const list = await f.request(caller, 'GET', '/api/announcements?pageSize=100'); assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map(item => item.id).sort(), expected.map(item => item.id).sort());
    for (const item of items) for (const route of [`/api/announcements/${item.id}`, history(item, ''), history(item)]) {
      const result = await f.request(caller, 'GET', route), allowed = expected.some(x => x.id === item.id);
      assert.equal(result.status, allowed ? 200 : 404, caller.user.name + ':' + item.status + ':' + item.audience);
      if (allowed && route.includes('/history')) assert.equal(result.body.items[0].snapshot.audience, item.audience);
    }
    assert.deepEqual(f.state(), before);
  }
});

test('real withdrawal and audience changes immediately revoke caregiver detail and both histories despite earlier visible versions', async t => {
  const f = await fixture(t); let current = await f.create(ENTITY, f.data({ status: 'published' }));
  for (const patch of [{ status: 'draft' }, { status: 'published', audience: 'supervisor' }, { audience: 'caregiver' }, { audience: 'all' }]) {
    current = await f.patch(ENTITY, current, patch);
    const readable = current.status === 'published' && ['all', 'caregiver'].includes(current.audience), before = f.state();
    for (const route of [`/api/announcements/${current.id}`, history(current, ''), history(current)]) {
      assert.equal((await f.request(f.clients.caregiver, 'GET', route)).status, readable ? 200 : 404);
      for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', route)).status, 200);
    }
    assert.equal((await f.request(f.clients.caregiver, 'GET', history(current, 'compare=next'))).status, readable ? 422 : 404, 'current scope must run before comparison validation');
    assert.deepEqual(f.state(), before);
  }
  const visible = await f.request(f.clients.caregiver, 'GET', history(current));
  assert.deepEqual(visible.body.items.map(row => row.version), [5, 4, 1]);
  assert.equal(visible.body.items[0].comparison.previousVersion, 4); assert.deepEqual(visible.body.items[1].comparison, noPrevious('unavailable'));
});

test('organization, current IDs, authentication and caregiver active employee link stay enforced independently of announcements', async t => {
  const f = await fixture(t), item = await f.create(ENTITY, f.data({ status: 'published' }));
  const org = await f.create('organizations', { name: '合成公告乙機構' }), foreign = { ...f.admin, org: org.id };
  const foreignItem = await f.create(ENTITY, f.data({ status: 'published', body: 'PRIVATE-FOREIGN-ANNOUNCEMENT' }), foreign);
  const foreignEmployee = await f.create('employees', { name: '合成外機構員工', employeeNo: 'TEST-ANN-FOREIGN' }, foreign);
  let before = f.state();
  for (const query of ['', 'compare=previous']) {
    for (const caller of Object.values(f.clients)) assert.equal((await f.request(caller, 'GET', history(item, query))).status, 200);
    assert.equal((await f.request(null, 'GET', history(item, query))).status, 401);
    assert.equal((await f.request({ ...f.admin, org: '' }, 'GET', history(item, query))).status, 400);
    assert.equal((await f.request({ ...f.clients.supervisor, org: org.id }, 'GET', history(item, query))).status, 403);
    assert.equal((await f.request(foreign, 'GET', history(item, query))).status, 404);
    for (const target of [foreignItem, f.employee, { id: id() }]) assert.equal((await f.request(f.admin, 'GET', history(target, query))).status, 404);
  }
  assert.deepEqual(f.state(), before);
  const inactive = await f.patch('employees', f.employee, { status: 'inactive' }); before = f.state();
  for (const query of ['', 'compare=previous']) {
    const denied = await f.request(f.clients.caregiver, 'GET', history(item, query)); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED');
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', history(item, query))).status, 200);
  }
  assert.deepEqual(f.state(), before); await f.patch('employees', inactive, { status: 'active' });
  for (const employeeId of [null, id(), foreignEmployee.id, f.caseA.id]) {
    // Explicit corrupted links are imported only in this isolated memory DB.
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.caregiver.user.id);
    before = f.state();
    for (const query of ['', 'compare=previous']) { const denied = await f.request(f.clients.caregiver, 'GET', history(item, query)); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(f.employee.id, f.admin.org, f.clients.caregiver.user.id);
  before = f.state(); assert.equal((await f.request(f.clients.caregiver, 'GET', history(item))).status, 200); assert.deepEqual(f.state(), before);
});

test('each saved caregiver snapshot requires strict scalar publication and audience before projection and paging', async t => {
  const f = await fixture(t), item = f.imported({ status: 'published' }, 12);
  f.addSnapshot(item, 1);
  for (const [i, changes] of [
    { status: 'draft' }, { status: ['published'] }, { status: { value: 'published' } }, { status: null },
    { audience: ['all'] }, { audience: { value: 'caregiver' } }, { audience: null }, { audience: ' all ' }, { audience: 'finance' }, { audience: '__proto__' },
  ].entries()) f.addSnapshot(item, i + 2, { ...changes, body: 'PRIVATE-HIDDEN-' + (i + 2) });
  f.addSnapshot(item, 12, { audience: 'caregiver' });
  const org = await f.create('organizations', { name: '合成污染歷程機構' });
  f.addSnapshot(item, 13, { body: 'PRIVATE-WRONG-ORG' }, { orgId: org.id });
  f.addSnapshot(item, 14, { body: 'PRIVATE-WRONG-ENTITY' }, { entity: 'employees' });
  const before = f.state();
  for (const caller of Object.values(f.clients)) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', history(item, query)); assert.equal(result.status, 200);
    const isCaregiver = caller === f.clients.caregiver;
    assert.deepEqual(result.body.items.map(row => row.version), isCaregiver ? [12, 1] : Array.from({ length: 12 }, (_, i) => 12 - i));
    assert.ok(!JSON.stringify(result.body).includes('PRIVATE-WRONG-'));
    if (isCaregiver) {
      assert.ok(!JSON.stringify(result.body).includes('PRIVATE-HIDDEN-'));
      if (query) assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable'));
    }
    const paged = await f.request(caller, 'GET', history(item, (query ? query + '&' : '') + 'page=2&pageSize=1'));
    assert.equal(paged.body.total, isCaregiver ? 2 : 12); assert.equal(paged.body.items[0].version, isCaregiver ? 1 : 11);
    assert.deepEqual(f.state(), before);
  }
});

test('empty, hidden-only and missing-version histories do not infer actors or jump versions and all snapshots retain existing public masking', async t => {
  const f = await fixture(t), missing = f.imported({ status: 'published' }, 3);
  f.addSnapshot(missing, 1); f.addSnapshot(missing, 3); f.auditEvent(missing, { action: 'announcement.publish' });
  const empty = f.imported({ status: 'published' });
  const hidden = f.imported({ status: 'published' }, 2); f.addSnapshot(hidden, 1, { status: 'draft' }); f.addSnapshot(hidden, 2, { audience: 'finance' });
  const paired = f.imported({ status: 'published', fileId: 'PRIVATE-BLOB', billingSnapshot: { marker: 'PRIVATE-BILLING' } }, 2);
  f.addSnapshot(paired, 1); f.addSnapshot(paired, 2);
  const before = f.state();
  for (const caller of Object.values(f.clients)) for (const query of ['', 'compare=previous']) {
    const response = await f.request(caller, 'GET', history(missing, query)); assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map(row => row.version), [3, 1]);
    if (query) { assert.deepEqual(response.body.items.map(row => row.actor), [null, null]); assert.deepEqual(response.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(response.body.items[1].comparison, noPrevious('initial')); }
    const none = await f.request(caller, 'GET', history(empty, query)); assert.equal(none.status, 200); assert.equal(none.body.total, 0); assert.deepEqual(none.body.items, []);
    const allHidden = await f.request(caller, 'GET', history(hidden, query)); assert.equal(allHidden.status, 200); assert.equal(allHidden.body.total, caller === f.clients.caregiver ? 0 : 2);
    const pair = await f.request(caller, 'GET', history(paired, query)); assert.equal(pair.status, 200);
    const snapshots = pair.body.items.map(row => row.snapshot); if (query) snapshots.push(pair.body.items[0].comparison.previousSnapshot);
    for (const snapshot of snapshots) {
      assert.ok(!Object.hasOwn(snapshot, 'fileId'));
      assert.equal(Object.hasOwn(snapshot, 'billingSnapshot'), [f.admin, f.clients.finance].includes(caller));
    }
    if ([f.clients.supervisor, f.clients.caregiver].includes(caller)) assert.ok(!JSON.stringify(pair.body).includes('PRIVATE-'));
    assert.deepEqual(f.state(), before);
  }
});

test('only exact record.create/update audit identities establish announcement actors; wrong scope, actions and ambiguous users never do', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data({ status: 'published' })), current = await f.patch(ENTITY, first, { body: '合成督導修改' }, f.clients.supervisor);
  const org = await f.create('organizations', { name: '合成錯誤稽核機構' });
  for (const changes of [{ orgId: org.id }, { entity: 'cases' }, { recordId: id() }, { action: 'service.review' }, { action: 'shift.complete' }, { action: 'announcement.publish' }, { detail: { version: '2' } }, { detail: { version: 2.5 } }, { detail: { version: 99 } }, { detail: {} }, { rawDetail: '{invalid' }]) f.auditEvent(current, changes);
  let before = f.state();
  for (const caller of Object.values(f.clients)) assert.deepEqual((await f.request(caller, 'GET', history(current))).body.items.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin)]);
  assert.deepEqual(f.state(), before);
  f.auditEvent(current, { userId: f.clients.supervisor.user.id });
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成目前督導姓名', f.clients.supervisor.user.id); before = f.state();
  assert.deepEqual((await f.request(f.admin, 'GET', history(current))).body.items[0].actor, { id: f.clients.supervisor.user.id, name: '合成目前督導姓名' }); assert.deepEqual(f.state(), before);
  f.auditEvent(current); f.auditEvent(first, { userId: 'synthetic-deleted-user' }); before = f.state();
  for (const caller of Object.values(f.clients)) assert.deepEqual((await f.request(caller, 'GET', history(current))).body.items.map(row => row.actor), [null, null]);
  assert.deepEqual(f.state(), before);
});

test('28 true saved versions use exact previous across the 25-row page boundary and preserve pagination and invalid compare errors', async t => {
  const f = await fixture(t); let item = await f.create(ENTITY, f.data({ status: 'published' }));
  for (let v = 2; v <= 28; v++) item = await f.patch(ENTITY, item, { body: '合成第' + v + '版' }, v % 2 ? f.admin : f.clients.supervisor);
  const before = f.state();
  for (const caller of Object.values(f.clients)) {
    const first = await f.request(caller, 'GET', history(item)), second = await f.request(caller, 'GET', history(item, 'compare=previous&page=2&pageSize=25'));
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(first.body.total, 28); assert.equal(second.body.total, 28);
    assert.equal(first.body.pageSize, 25); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
    assert.equal(first.body.items.at(-1).version, 4); assert.equal(first.body.items.at(-1).comparison.previousVersion, 3);
    assert.deepEqual(first.body.items.at(-1).comparison.previousSnapshot, second.body.items[0].snapshot);
    assert.deepEqual(second.body.items.at(-1).comparison, noPrevious('initial')); assert.deepEqual(first.body.items[0].actor, actor(f.clients.supervisor));
    const raw = await f.request(caller, 'GET', history(item, 'page=2&pageSize=25')); assert.deepEqual(raw.body.items.map(row => row.snapshot), second.body.items.map(row => row.snapshot));
    assert.equal((await f.request(caller, 'GET', history(item, 'compare=previous&pageSize=100'))).body.items.length, 28);
    for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) {
      const bad = await f.request(caller, 'GET', history(item, query)); assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'INVALID_COMPARE');
    }
    for (const query of ['compare=previous&page=0', 'compare=previous&pageSize=101', 'compare=previous&page=1.5', 'compare=previous&pageSize=-1']) {
      const bad = await f.request(caller, 'GET', history(item, query)); assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'PAGINATION');
    }
    assert.deepEqual(f.state(), before);
  }
});

test('hidden versions are removed before a full caregiver page count and a hidden page-edge predecessor cannot leak', async t => {
  const f = await fixture(t); let item = await f.create(ENTITY, f.data({ status: 'published' }));
  for (let v = 2; v <= 30; v++) item = await f.patch(ENTITY, item, { status: v === 4 ? 'draft' : 'published', audience: v === 29 ? 'finance' : 'all', body: '合成第' + v + '版' });
  const before = f.state();
  for (const query of ['', 'compare=previous']) {
    const prefix = query ? query + '&' : '';
    const first = await f.request(f.clients.caregiver, 'GET', history(item, prefix + 'page=1&pageSize=25'));
    const second = await f.request(f.clients.caregiver, 'GET', history(item, prefix + 'page=2&pageSize=25'));
    assert.equal(first.body.total, 28); assert.equal(second.body.total, 28); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
    assert.equal(first.body.items.at(-1).version, 5); assert.deepEqual(second.body.items.map(row => row.version), [3, 2, 1]);
    if (query) {
      assert.deepEqual(first.body.items[0].comparison, noPrevious('unavailable'));
      assert.deepEqual(first.body.items.at(-1).comparison, noPrevious('unavailable'));
      assert.equal(second.body.items[0].comparison.previousVersion, 2);
    }
  }
  assert.deepEqual(f.state(), before);
});

test('POST idempotency, PATCH CAS, CSRF, original string validation and read-only roles remain unchanged', async t => {
  const f = await fixture(t), payload = f.data({ status: 'published', audience: '__proto__' }), headers = { 'Idempotency-Key': 'announcement-history-create' };
  const created = await f.request(f.clients.supervisor, 'POST', '/api/announcements', payload, headers); assert.equal(created.status, 201);
  let before = f.state(); const replay = await f.request(f.clients.supervisor, 'POST', '/api/announcements', payload, headers); assert.equal(replay.status, 201); assert.deepEqual(replay.body, created.body); assert.deepEqual(f.state(), before);
  const reused = await f.request(f.clients.supervisor, 'POST', '/api/announcements', { ...payload, body: '合成不同內容' }, headers); assert.equal(reused.status, 409); assert.equal(reused.body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.state(), before);
  const current = await f.patch(ENTITY, created.body.item, { audience: 'caregiver', body: '合成最新內容' }); before = f.state();
  const stale = await f.request(f.admin, 'PATCH', '/api/announcements/' + current.id, { version: 1, body: '不得覆寫' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  for (const method of ['POST', 'PATCH']) {
    const route = method === 'POST' ? '/api/announcements' : '/api/announcements/' + current.id, data = method === 'POST' ? payload : { version: current.version, body: '不得覆寫' };
    for (const caller of [f.clients.finance, f.clients.caregiver]) { const denied = await f.request(caller, method, route, data); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'ROLE_FORBIDDEN'); }
    for (const token of ['', 'invalid', 'é'.repeat(64)]) { const denied = await f.request(f.admin, method, route, data, { 'X-CSRF-Token': token }); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'CSRF_INVALID'); }
  }
  for (const bad of [{ title: '' }, { body: '' }, { title: 'x'.repeat(501) }, { body: 'x'.repeat(10001) }, { audience: 'x'.repeat(501) }, { title: {} }, { body: [] }, { audience: ['all'] }, { status: 'sent' }, { status: null }, { fileId: 'forbidden' }, { billingSnapshot: {} }, { publishedAt: now() }]) {
    const result = await f.request(f.admin, 'POST', '/api/announcements', f.data(bad)); assert.equal(result.status, 422, JSON.stringify(result.body));
  }
  const missingVersion = await f.request(f.admin, 'PATCH', '/api/announcements/' + current.id, { body: 'missing version' }); assert.equal(missingVersion.status, 422);
  const tooLarge = await f.request(f.admin, 'POST', '/api/announcements', f.data({ body: '中'.repeat(45000) })); assert.equal(tooLarge.status, 413);
  assert.deepEqual(f.state(), before);
  const exact = await f.create(ENTITY, f.data({ title: 'x'.repeat(500), body: 'x'.repeat(10000), audience: 'x'.repeat(500) }));
  const defaults = await f.create(ENTITY, { title: ' ', body: '\n' }); assert.equal(defaults.status, 'draft'); assert.equal(defaults.audience, 'all'); assert.equal(defaults.title, ' '); assert.equal(defaults.body, '\n');
  before = f.state(); assert.equal((await f.request(f.admin, 'GET', history(exact))).body.items[0].snapshot.body.length, 10000); assert.deepEqual(f.state(), before);
});

test('announcement reads preserve eleven tables, six immutable triggers and both nonempty BLOB versions and downloads', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data({ status: 'published' })), current = await f.patch(ENTITY, first, { body: '合成更新' }, f.clients.supervisor);
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成公告测试證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成個案PDF', ...filePayload(PDF_BYTES, '合成個案.pdf', 'application/pdf') });
  const b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成證照PNG', ...filePayload(PNG_BYTES, '合成證照.png', 'image/png') });
  const schema = f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all();
  assert.equal(schema.filter(row => row.type === 'table').length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  const before = f.state(); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  for (const caller of Object.values(f.clients)) for (const route of ['/api/announcements', '/api/announcements/' + current.id, history(current, ''), history(current), history(current, 'compare=previous&page=2&pageSize=1')]) {
    const result = await f.request(caller, 'GET', route); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(f.state(), before);
  }
  for (const caller of [f.admin, f.clients.supervisor, f.clients.caregiver]) for (const [route, bytes] of [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) {
    const result = await f.request(caller, 'GET', route + suffix); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); assert.equal(sha(result.bytes), sha(bytes)); assert.match(result.headers.get('content-disposition'), /^attachment;/); assert.deepEqual(f.state(), before);
  }
  assert.deepEqual(f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all(), schema);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    const column = table === 'record_versions' ? 'source' : 'file_name';
    assert.throws(() => f.app.db.prepare(`UPDATE ${table} SET ${column}=?`).run('tamper'), /immutable/);
    assert.throws(() => f.app.db.prepare('DELETE FROM ' + table).run(), /immutable/);
  }
  assert.deepEqual(f.state(), before);
});

test('announcement history keeps approved billing immutable and all 31 existing report outlets byte or projection equivalent', async t => {
  const f = await fixture(t), approved = await f.approve();
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 12345);
  const fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  assert.equal(fees.totals.amountCents, 37035); assert.equal(payroll.totals.amountCents, 18800);
  let current = await f.create(ENTITY, f.data({ status: 'published' })); current = await f.patch(ENTITY, current, { audience: 'caregiver' }, f.clients.supervisor);
  await f.patch('employees', f.employee, { hourlyRateCents: 99999 }); await f.patch('service-items', f.service, { unitPriceCents: 88888 });
  await f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-09', startTime: '12:00', endTime: '13:00', type: '合成假別' });
  await f.create('employee-training', { employeeId: f.employee.id, name: '合成訓練', category: 'in_service', date: '2026-10-08', trainingMinutes: 47 });
  await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成證照', issuedOn: '2026-01-01', expiresOn: '2026-10-30' });
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave', 'training', 'certification']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31${kind === 'certification' ? '&asOf=2026-10-08' : ''}`);
  for (const suffix of ['', '/export', '.csv']) routes.push('/api/employee-report' + suffix);
  assert.equal(routes.length, 31);
  const readReports = async () => {
    const results = {};
    for (const route of routes) { const result = await f.request(f.admin, 'GET', route); assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); results[route] = typeof result.body === 'string' ? result.body : Object.fromEntries(Object.entries(result.body).filter(([key]) => key !== 'generatedAt')); }
    return results;
  };
  const before = f.state(), reports = await readReports();
  for (const caller of Object.values(f.clients)) for (const query of ['', 'compare=previous']) assert.equal((await f.request(caller, 'GET', history(current, query))).status, 200);
  assert.deepEqual(await readReports(), reports);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  assert.deepEqual(f.state(), before);
});
