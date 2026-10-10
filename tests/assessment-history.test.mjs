import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { id, now, business, insert } from '../src/server/model.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const ENTITY = 'assessments';
const password = 'synthetic-assessment-history-password';
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
  const setup = await request(null, 'POST', '/api/setup', { name: '合成評鑑管理者', email: 'assessment-history-admin@example.test', password, organizationName: '合成評鑑甲機構' });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const clientFrom = result => ({ cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken, org: setup.body.organizations[0].id, user: result.body.user });
  const admin = clientFrom(setup), clients = { admin };
  async function create(entity, data, caller = admin) {
    const result = await request(caller, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(entity, item, data, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...data }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employee = await create('employees', { name: '合成評鑑居服員', employeeNo: 'TEST-AH-EMP', hourlyRateCents: 24000 });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@assessment-history.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = clientFrom(login);
  }
  const caseA = await create('cases', { name: '合成評鑑個案甲', caseNo: 'TEST-AH-CA' });
  const caseB = await create('cases', { name: '合成評鑑個案乙', caseNo: 'TEST-AH-CB', status: 'paused' });
  const service = await create('service-items', { code: 'TEST-AH-SERVICE', name: '合成測試服務', minutes: 60, unitPriceCents: 12345 });
  const services = [{ serviceItemId: service.id, quantity: 3 }];
  const plan = await create('care-plans', { caseId: caseA.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services });
  const shift = await create('shifts', { caseId: caseA.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services });
  const data = overrides => ({ caseId: caseA.id, templateId: 'assessment-01', date: '2026-10-08', answers: { q001: '2026-10-08', q004: '合成初始填答' }, status: 'draft', ...overrides });
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

test('real case and template A to B to A edits retain five saved fields, arbitrary answer JSON, original status rules and exact actors', async t => {
  const f = await fixture(t);
  const answers = { q001: '', q002: null, q003: 0, q004: false, q005: true, q006: '0', q007: 'false', q008: '  合成\n原文<&>  ', q009: [], q010: ['x', null, 3], q011: { nested: '合成巢狀值' }, unknown: { keep: ['合法原始答案'] }, billingSnapshot: '答案同名鍵也不改寫' };
  const first = await f.create(ENTITY, f.data({ answers }));
  const second = await f.patch(ENTITY, first, { caseId: f.caseB.id, templateId: 'assessment-02', date: '2026-10-09', answers: { q001: '另一模板題目', q002: 1 }, status: 'submitted' }, f.clients.supervisor);
  const third = await f.patch(ENTITY, second, { caseId: f.caseA.id, templateId: 'assessment-01', answers, status: 'draft' });
  const fourth = await f.patch(ENTITY, third, { templateId: 'synthetic-unknown-template', status: 'submitted' }, f.clients.supervisor);
  await f.patch('cases', f.caseA, { status: 'closed', name: '目前已改名的合成個案' });
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) {
    const result = await f.request(caller, 'GET', history(fourth)); assert.equal(result.status, 200);
    assert.deepEqual(result.body.items.map(row => row.version), [4, 3, 2, 1]);
    assert.deepEqual(result.body.items.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin), actor(f.clients.supervisor), actor(f.admin)]);
    assert.deepEqual(result.body.items.map(row => row.snapshot.templateId), ['synthetic-unknown-template', 'assessment-01', 'assessment-02', 'assessment-01']);
    assert.deepEqual(result.body.items.map(row => row.snapshot.caseId), [f.caseA.id, f.caseA.id, f.caseB.id, f.caseA.id]);
    assert.deepEqual(result.body.items.map(row => row.snapshot.status), ['submitted', 'draft', 'submitted', 'draft']);
    assert.deepEqual(result.body.items[0].snapshot.answers, answers); assert.deepEqual(result.body.items[3].snapshot.answers, answers);
    assert.ok(!JSON.stringify(result.body).includes('目前已改名的合成個案'));
    for (let i = 0; i < 3; i++) { assert.equal(result.body.items[i].comparison.previousVersion, result.body.items[i].version - 1); assert.deepEqual(result.body.items[i].comparison.previousSnapshot, result.body.items[i + 1].snapshot); }
    assert.deepEqual(result.body.items[3].comparison, noPrevious('initial'));
    const raw = await f.request(caller, 'GET', history(fourth, '')); assert.deepEqual(raw.body.items.map(row => row.snapshot), result.body.items.map(row => row.snapshot));
    assert.ok(raw.body.items.every(row => Object.keys(row).sort().join(',') === 'createdAt,snapshot,source,version'));
  }
  assert.deepEqual(f.state(), before);
});

test('four real sessions retain existing assessment permission and organization boundaries even when caregiver can read the case', async t => {
  const f = await fixture(t), item = await f.create(ENTITY, f.data());
  const org = await f.create('organizations', { name: '合成評鑑乙機構' }), foreign = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: '合成跨機構個案', caseNo: 'TEST-AH-FOREIGN' }, foreign);
  const foreignAssessment = await f.create(ENTITY, f.data({ caseId: foreignCase.id }), foreign);
  const before = f.state();
  assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/cases/' + f.caseA.id)).status, 200);
  for (const query of ['', 'compare=previous']) {
    for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.equal((await f.request(caller, 'GET', history(item, query))).status, 200);
    assert.equal((await f.request(f.clients.caregiver, 'GET', history(item, query))).status, 403);
    assert.equal((await f.request(null, 'GET', history(item, query))).status, 401);
    assert.equal((await f.request(foreign, 'GET', history(item, query))).status, 404);
    for (const target of [foreignAssessment, f.caseA, { id: id() }]) assert.equal((await f.request(f.admin, 'GET', history(target, query))).status, 404);
  }
  assert.equal((await f.request(f.clients.caregiver, 'GET', '/api/assessments')).status, 403);
  for (const caller of [f.clients.finance, f.clients.caregiver]) {
    assert.equal((await f.request(caller, 'POST', '/api/assessments', f.data())).status, 403);
    assert.equal((await f.request(caller, 'PATCH', '/api/assessments/' + item.id, { version: item.version, answers: {} })).status, 403);
  }
  assert.deepEqual(f.state(), before);
  const inactive = await f.patch('employees', f.employee, { status: 'inactive' });
  let stable = f.state();
  const denied = await f.request(f.clients.caregiver, 'GET', history(item)); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); assert.deepEqual(f.state(), stable);
  await f.patch('employees', inactive, { status: 'active' });
  stable = f.state(); assert.equal((await f.request(f.clients.caregiver, 'GET', history(item))).body.error.code, 'ROLE_FORBIDDEN'); assert.deepEqual(f.state(), stable);
});

test('raw and compare filter each historical case before pagination while current orphan keeps earlier authorized versions and unknown templates', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成評鑑污染來源' }), foreign = { ...f.admin, org: org.id };
  const foreignCase = await f.create('cases', { name: 'PRIVATE-FOREIGN-CASE', caseNo: 'TEST-AH-FOREIGN' }, foreign), missing = id();
  const item = await f.create(ENTITY, f.data());
  f.addSnapshot(item, 2, { caseId: f.caseB.id, templateId: 'unknown-but-authorized', answers: { q001: '合成合法不同父项' } });
  f.addSnapshot(item, 3, { caseId: missing, answers: { q001: 'PRIVATE-MISSING' } });
  f.addSnapshot(item, 4, { caseId: foreignCase.id, answers: { q001: 'PRIVATE-FOREIGN' } });
  f.addSnapshot(item, 5, { caseId: f.employee.id, answers: { q001: 'PRIVATE-WRONG-PARENT-ENTITY' } });
  const current = f.addSnapshot(item, 6, { answers: { q001: '合成第六版' } });
  f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(JSON.stringify(business(current)), 6, item.id);
  f.addSnapshot(item, 7, { answers: { q001: 'PRIVATE-WRONG-ORG' } }, { orgId: org.id });
  f.addSnapshot(item, 8, { answers: { q001: 'PRIVATE-WRONG-ENTITY' } }, { entity: 'announcements' });
  const orphan = f.imported({ caseId: missing }, 3); f.addSnapshot(orphan, 1, { caseId: f.caseA.id }); f.addSnapshot(orphan, 2, { caseId: f.caseB.id, templateId: 'unknown-earlier' }); f.addSnapshot(orphan, 3);
  const allHidden = insert(f.app.db, f.admin.org, ENTITY, f.data({ caseId: missing }));
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) for (const query of ['', 'compare=previous']) {
    const response = await f.request(caller, 'GET', history(current, query)); assert.equal(response.status, 200);
    assert.deepEqual(response.body.items.map(row => row.version), [6, 2, 1]); assert.equal(response.body.total, 3);
    for (const secret of ['PRIVATE-', missing, foreignCase.id, f.employee.id]) assert.ok(!JSON.stringify(response.body).includes(secret));
    assert.equal(response.body.items[1].snapshot.templateId, 'unknown-but-authorized');
    if (query) { assert.deepEqual(response.body.items[0].comparison, noPrevious('unavailable')); assert.equal(response.body.items[1].comparison.previousVersion, 1); }
    const page = await f.request(caller, 'GET', history(current, (query ? query + '&' : '') + 'page=2&pageSize=1'));
    assert.equal(page.body.total, 3); assert.equal(page.body.items[0].version, 2);
    assert.equal((await f.request(caller, 'GET', '/api/assessments/' + orphan.id)).status, 200, 'current authorization has no new parent join');
    const earlier = await f.request(caller, 'GET', history(orphan, query)); assert.deepEqual(earlier.body.items.map(row => row.version), [2, 1]);
    if (query) assert.equal(earlier.body.items[0].comparison.previousVersion, 1);
    const hidden = await f.request(caller, 'GET', history(allHidden, query)); assert.equal(hidden.status, 200); assert.equal(hidden.body.total, 0); assert.deepEqual(hidden.body.items, []);
  }
  assert.deepEqual(f.state(), before);
});

test('assessment actors use only exact record.create/update identities and preserve missing or ambiguous attribution', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data()), current = await f.patch(ENTITY, first, { status: 'submitted' }, f.clients.supervisor);
  const org = await f.create('organizations', { name: '合成錯誤稽核機構' });
  for (const changes of [{ orgId: org.id }, { entity: 'cases' }, { recordId: id() }, { action: 'service.review' }, { action: 'shift.complete' }, { action: 'assessment.review' }, { detail: { version: '2' } }, { detail: { version: 2.5 } }, { detail: { version: 99 } }, { detail: {} }, { rawDetail: '{invalid' }]) f.auditEvent(current, changes);
  let before = f.state();
  assert.deepEqual((await f.request(f.admin, 'GET', history(current))).body.items.map(row => row.actor), [actor(f.clients.supervisor), actor(f.admin)]); assert.deepEqual(f.state(), before);
  f.auditEvent(current, { userId: f.clients.supervisor.user.id });
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('合成操作者目前名稱', f.clients.supervisor.user.id);
  before = f.state();
  const renamed = (await f.request(f.admin, 'GET', history(current))).body.items[0].actor;
  assert.deepEqual(renamed, { id: f.clients.supervisor.user.id, name: '合成操作者目前名稱' }); assert.deepEqual(f.state(), before);
  f.auditEvent(current); f.auditEvent(first, { userId: 'synthetic-missing-user' });
  before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) assert.deepEqual((await f.request(caller, 'GET', history(current))).body.items.map(row => row.actor), [null, null]);
  assert.deepEqual(f.state(), before);
});

test('baseline, empty and missing versions preserve raw answers and publicRecord masking for both snapshots', async t => {
  const f = await fixture(t), baseline = f.imported({ templateId: 'synthetic-unknown' }, 3);
  f.addSnapshot(baseline, 1); f.addSnapshot(baseline, 3); f.auditEvent(baseline, { action: 'assessment.review' });
  const empty = f.imported(), rawAnswers = { q001: { internal: ['raw API remains unchanged'] }, unknown: 'raw answer stays' };
  const paired = f.imported({ answers: rawAnswers, fileId: 'PRIVATE-BLOB-ID', billingSnapshot: { marker: 'PRIVATE-BILLING' } }, 2);
  f.addSnapshot(paired, 1); f.addSnapshot(paired, 2);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) for (const query of ['', 'compare=previous']) {
    const result = await f.request(caller, 'GET', history(baseline, query)); assert.deepEqual(result.body.items.map(row => row.version), [3, 1]);
    if (query) { assert.ok(result.body.items.every(row => row.actor === null)); assert.deepEqual(result.body.items[0].comparison, noPrevious('unavailable')); assert.deepEqual(result.body.items[1].comparison, noPrevious('initial')); }
    const none = await f.request(caller, 'GET', history(empty, query)); assert.equal(none.status, 200); assert.deepEqual(none.body.items, []); assert.equal(none.body.total, 0);
    const pair = await f.request(caller, 'GET', history(paired, query)); assert.equal(pair.status, 200);
    const snapshots = pair.body.items.map(row => row.snapshot);
    if (query) snapshots.push(pair.body.items[0].comparison.previousSnapshot);
    for (const snapshot of snapshots) {
      assert.deepEqual(snapshot.answers, rawAnswers); assert.ok(!Object.hasOwn(snapshot, 'fileId'));
      assert.equal(Object.hasOwn(snapshot, 'billingSnapshot'), caller !== f.clients.supervisor);
    }
    if (caller === f.clients.supervisor) assert.ok(!JSON.stringify(pair.body).includes('PRIVATE-'));
  }
  assert.deepEqual(f.state(), before);
});

test('28 real versions compare exact predecessors across 25-row pages and retain existing pagination and invalid comparison guards', async t => {
  const f = await fixture(t); let item = await f.create(ENTITY, f.data());
  const unsupported = await f.create('announcements', { title: '合成仍未支援比較公告', body: '保留負向驗收' });
  for (let v = 2; v <= 28; v++) item = await f.patch(ENTITY, item, { answers: { q001: '合成第' + v + '版' } }, v % 2 ? f.admin : f.clients.supervisor);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.finance]) {
    const first = await f.request(caller, 'GET', history(item)), second = await f.request(caller, 'GET', history(item, 'compare=previous&page=2&pageSize=25'));
    assert.equal(first.body.total, 28); assert.equal(second.body.total, 28); assert.equal(first.body.pageSize, 25); assert.equal(first.body.items.length, 25); assert.equal(second.body.items.length, 3);
    assert.equal(first.body.items.at(-1).version, 4); assert.equal(first.body.items.at(-1).comparison.previousVersion, 3);
    assert.deepEqual(first.body.items.at(-1).comparison.previousSnapshot, second.body.items[0].snapshot);
    assert.deepEqual(second.body.items.at(-1).comparison, noPrevious('initial')); assert.deepEqual(first.body.items[0].actor, actor(f.clients.supervisor));
    const raw = await f.request(caller, 'GET', history(item, 'page=2&pageSize=25')); assert.deepEqual(raw.body.items.map(row => row.snapshot), second.body.items.map(row => row.snapshot));
    assert.equal((await f.request(caller, 'GET', history(item, 'compare=previous&pageSize=100'))).body.items.length, 28);
  }
  for (const query of ['compare=', 'compare=next', 'compare=Previous', 'compare=previous&compare=previous', 'compare=previous&compare=next']) {
    const rejected = await f.request(f.admin, 'GET', history(item, query)); assert.equal(rejected.status, 422); assert.equal(rejected.body.error.code, 'INVALID_COMPARE');
  }
  for (const query of ['compare=previous&page=0', 'compare=previous&pageSize=101', 'compare=previous&page=1.5']) assert.equal((await f.request(f.admin, 'GET', history(item, query))).body.error.code, 'PAGINATION');
  assert.equal((await f.request(f.admin, 'GET', history(unsupported, 'compare=next', 'announcements'))).body.error.code, 'INVALID_COMPARE');
  assert.deepEqual(f.state(), before);
});

test('POST idempotency, PATCH CAS, CSRF and original answers/field/body guards remain unchanged', async t => {
  const f = await fixture(t), payload = f.data({ templateId: 'not-in-catalog', answers: { q001: null, unknown: [false, 0, { nested: 'legal JSON' }] }, status: 'submitted' }), headers = { 'Idempotency-Key': 'assessment-history-create' };
  const created = await f.request(f.clients.supervisor, 'POST', '/api/assessments', payload, headers); assert.equal(created.status, 201);
  let before = f.state(); const replay = await f.request(f.clients.supervisor, 'POST', '/api/assessments', payload, headers); assert.deepEqual(replay.body, created.body); assert.equal(replay.status, 201); assert.deepEqual(f.state(), before);
  assert.equal((await f.request(f.clients.supervisor, 'POST', '/api/assessments', { ...payload, answers: {} }, headers)).body.error.code, 'IDEMPOTENCY_CONFLICT'); assert.deepEqual(f.state(), before);
  const current = await f.patch(ENTITY, created.body.item, { status: 'draft', caseId: f.caseB.id, templateId: 'another-unknown-template' });
  before = f.state();
  const stale = await f.request(f.admin, 'PATCH', '/api/assessments/' + current.id, { version: 1, answers: {} }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  for (const method of ['POST', 'PATCH']) {
    const result = await f.request(f.admin, method, method === 'POST' ? '/api/assessments' : '/api/assessments/' + current.id, method === 'POST' ? payload : { version: current.version, answers: {} }, { 'X-CSRF-Token': 'invalid' }); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'CSRF_INVALID');
  }
  const maxAnswers = { q001: 'x'.repeat(50000 - JSON.stringify({ q001: '' }).length) };
  assert.equal(JSON.stringify(maxAnswers).length, 50000);
  for (const bad of [{ answers: null }, { answers: [] }, { answers: '' }, { answers: 1 }, { answers: false }, { answers: { q001: maxAnswers.q001 + 'x' } }, { caseId: id() }, { caseId: f.employee.id }, { templateId: '' }, { templateId: {} }, { date: '2026-02-30' }, { status: 'approved' }, { score: 8 }, { fileId: 'forbidden' }]) {
    const result = await f.request(f.admin, 'POST', '/api/assessments', f.data(bad)); assert.equal(result.status, 422, JSON.stringify({ bad, error: result.body.error }));
  }
  const tooLarge = await f.request(f.admin, 'POST', '/api/assessments', f.data({ answers: { q001: '中'.repeat(45000) } })); assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.error.code, 'BODY_TOO_LARGE');
  assert.deepEqual(f.state(), before);
  const exact = await f.create(ENTITY, f.data({ answers: maxAnswers }));
  const defaults = await f.create(ENTITY, { caseId: f.caseA.id, templateId: 'unknown-default', date: '2026-10-08' }); assert.deepEqual(defaults.answers, {}); assert.equal(defaults.status, 'draft');
  before = f.state(); assert.deepEqual((await f.request(f.admin, 'GET', history(exact))).body.items[0].snapshot.answers, maxAnswers); assert.deepEqual(f.state(), before);
});

test('readonly assessment history preserves eleven tables, six immutable triggers and both nonempty BLOB bytes and downloads', async t => {
  const f = await fixture(t), first = await f.create(ENTITY, f.data()), current = await f.patch(ENTITY, first, { status: 'submitted' }, f.clients.supervisor);
  const cert = await f.create('employee-certifications', { employeeId: f.employee.id, name: '合成評鑑測試證照', issuedOn: '2026-01-01' });
  const a = await f.create('case-attachments/upload', { caseId: f.caseA.id, title: '合成個案PDF', ...filePayload(PDF_BYTES, '合成個案.pdf', 'application/pdf') });
  const b = await f.create('certification-attachments/upload', { certificationId: cert.id, title: '合成證照PNG', ...filePayload(PNG_BYTES, '合成證照.png', 'image/png') });
  const schema = f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all();
  assert.equal(schema.filter(row => row.type === 'table').length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  const before = f.state(); assert.equal(before.tables.attachment_files.length, 1); assert.equal(before.tables.certification_attachment_files.length, 1);
  for (const caller of Object.values(f.clients)) for (const route of ['/api/assessments', '/api/assessments/' + current.id, history(current, ''), history(current), history(current, 'compare=previous&page=2&pageSize=1')]) {
    const result = await f.request(caller, 'GET', route); assert.equal(result.status, caller === f.clients.caregiver ? 403 : 200); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const caller of [f.admin, f.clients.supervisor, f.clients.caregiver]) for (const [route, bytes] of [[`/api/case-attachments/${a.id}/download`, PDF_BYTES], [`/api/certification-attachments/${b.id}/download`, PNG_BYTES]]) for (const suffix of ['', '?recordVersion=1']) {
    const result = await f.request(caller, 'GET', route + suffix); assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); assert.equal(sha(result.bytes), sha(bytes)); assert.match(result.headers.get('content-disposition'), /^attachment;/);
  }
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY type,name").all(), schema);
  for (const table of ['record_versions', 'attachment_files', 'certification_attachment_files']) {
    const column = table === 'record_versions' ? 'source' : 'file_name';
    assert.throws(() => f.app.db.prepare(`UPDATE ${table} SET ${column}=?`).run('tamper'), /immutable/);
    assert.throws(() => f.app.db.prepare('DELETE FROM ' + table).run(), /immutable/);
  }
  assert.deepEqual(f.state(), before);
});

test('assessment reads leave approved service pricing and all 25 existing report outlets unchanged', async t => {
  const f = await fixture(t), approved = await f.approve();
  assert.equal(approved.billingSnapshot.serviceMinutes, 47); assert.equal(approved.billingSnapshot.employee.hourlyRateCents, 24000); assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 12345);
  const fees = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, payroll = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  assert.equal(fees.totals.amountCents, 37035); assert.equal(payroll.totals.amountCents, 18800);
  let current = await f.create(ENTITY, f.data()); current = await f.patch(ENTITY, current, { status: 'submitted', answers: { q001: '合成提交不評分' } }, f.clients.supervisor);
  await f.patch('employees', f.employee, { hourlyRateCents: 99999 }); await f.patch('service-items', f.service, { unitPriceCents: 88888 });
  await f.create('leave-requests', { employeeId: f.employee.id, date: '2026-10-09', startTime: '12:00', endTime: '13:00', type: '合成假別' });
  const routes = ['cases', 'shifts', 'services', 'fees', 'payroll'].flatMap(kind => [`/api/reports/${kind}?month=2026-10`, `/api/reports/${kind}.csv?month=2026-10`]);
  for (const kind of ['shift', 'service', 'case', 'leave']) for (const suffix of ['', '/export', '.csv']) routes.push(`/api/${kind}-report${suffix}?startDate=2026-01-01&endDate=2026-12-31`);
  for (const suffix of ['', '/export', '.csv']) routes.push('/api/employee-report' + suffix);
  assert.equal(routes.length, 25);
  const readReports = async () => {
    const results = {};
    for (const route of routes) { const result = await f.request(f.admin, 'GET', route); assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); results[route] = typeof result.body === 'string' ? result.body : Object.fromEntries(Object.entries(result.body).filter(([key]) => key !== 'generatedAt')); }
    return results;
  };
  const before = f.state(), reports = await readReports();
  for (const caller of Object.values(f.clients)) for (const query of ['', 'compare=previous']) assert.equal((await f.request(caller, 'GET', history(current, query))).status, caller === f.clients.caregiver ? 403 : 200);
  assert.deepEqual(await readReports(), reports);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + approved.id)).body.item, approved);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, fees);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payroll);
  assert.deepEqual(f.state(), before);
});
