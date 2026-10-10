import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, business } from '../src/server/model.mjs';
import { toCsv, csvCell } from '../src/server/reports.mjs';
import { PDF_BYTES, PNG_BYTES, filePayload } from './attachment-fixtures.mjs';

const entity = 'employee-training';
const endpoints = ['/api/training-report', '/api/training-report/export', '/api/training-report.csv'];
const range = { startDate: '2026-01-01', endDate: '2026-12-31' };
const url = (endpoint = endpoints[0], filters = {}) => endpoint + '?' + new URLSearchParams({ ...range, ...filters });
const keys = ['trainingId', 'version', 'date', 'employeeId', 'employeeNo', 'employee', 'name', 'category', 'categoryLabel', 'provider', 'trainingMinutes', 'status', 'statusLabel', 'note'];
const columns = [['date', '訓練日期'], ['employeeNo', '員工編號'], ['employee', '員工（目前名稱）'], ['name', '課程名稱'], ['categoryLabel', '訓練類別'], ['provider', '辦訓單位'], ['trainingMinutes', '訓練時間（分鐘）'], ['statusLabel', '訓練狀態'], ['note', '訓練備註']].map(([key, label]) => ({ key, label }));
const tables = ['records', 'record_versions', 'audit', 'idempotency', 'attachment_files', 'certification_attachment_files', 'users', 'memberships', 'sessions', 'organizations', 'demo_seeds'];

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen();
  t.after(() => app.close());
  async function request(client, method, route, data, extra = {}) {
    const response = await fetch(base + route, { method, headers: {
      Origin: base, ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra,
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, headers: response.headers,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
  }
  const password = 'synthetic-training-report-password';
  const setup = await request(null, 'POST', '/api/setup', { name: '合成訓練報表管理者', email: 'training-report-admin@example.test', password, organizationName: '合成訓練報表甲機構' });
  assert.equal(setup.status, 201);
  const client = response => ({ cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrfToken, org: setup.body.organizations[0].id, user: response.body.user });
  const admin = client(setup), clients = { admin };
  async function create(kind, data, caller = admin, headers) {
    const result = await request(caller, 'POST', '/api/' + kind, data, headers);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item;
  }
  async function patch(kind, item, changes, caller = admin) {
    const result = await request(caller, 'PATCH', `/api/${kind}/${item.id}`, { version: item.version, ...changes });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item;
  }
  const employeeA = await create('employees', { name: '合成 Alpha', employeeNo: 'TEST-TR-A', role: '合成照顧職務', qualification: 'PRIVATE-QUALIFICATION', regions: 'PRIVATE-REGIONS', phone: 'PRIVATE-PHONE', email: 'private@example.test', note: 'PRIVATE-EMPLOYEE-NOTE', hourlyRateCents: 24000 });
  const employeeB = await create('employees', { name: '合成 Beta', employeeNo: 'TEST-TR-B', hourlyRateCents: 26000 });
  const inactive = await create('employees', { name: '合成停用員工', employeeNo: 'TEST-TR-I', status: 'inactive' });
  for (const role of ['supervisor', 'finance', 'caregiver']) {
    const email = role + '@training-report.example.test';
    await create('users', { name: '合成' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employeeA.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = client(login);
  }
  const caseItem = await create('cases', { name: 'PRIVATE-CASE-NAME', caseNo: 'PRIVATE-CASE-NO' });
  let sequence = 0;
  const trainingPayload = (changes = {}) => ({ employeeId: employeeA.id, date: '2026-10-08', name: '合成訓練', category: 'in_service', provider: '合成辦訓單位', trainingMinutes: 61, note: '合成保存備註', ...changes });
  function imported(changes = {}, { version = 1, orgId = admin.org, recordId = id() } = {}) {
    // Explicit synthetic imported data in disposable memory; immutable version rows are never rewritten.
    const stamp = now(), data = trainingPayload({ name: 'TEST-TRAINING-' + String(sequence++).padStart(5, '0'), status: 'completed', ...changes });
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, orgId, entity, JSON.stringify(data), version, stamp, stamp);
    return { ...data, id: recordId, orgId, version, createdAt: stamp, updatedAt: stamp };
  }
  const overwrite = (item, changes) => app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(item), ...changes }), item.id);
  const state = () => ({ changes: app.db.prepare('SELECT total_changes() AS n').get().n,
    tables: Object.fromEntries(tables.map(table => { const statement = app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid'); statement.setReadBigInts(true); return [table, statement.all()]; })),
    triggers: app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
  });
  return { app, request, create, patch, admin, clients, employeeA, employeeB, inactive, caseItem, imported, overwrite, state, trainingPayload };
}

test('training report queries have exact date/search defaults, no category filter, strict pagination and readonly headers', async t => {
  const f = await fixture(t), before = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(null, 'GET', url(endpoint))).status, 401);
    const empty = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('cache-control'), 'no-store'); assert.equal(empty.headers.get('x-content-type-options'), 'nosniff');
    if (endpoint !== endpoints[2]) {
      assert.equal(empty.body.title, '教育訓練紀錄總表');
      assert.deepEqual(empty.body.filters, { ...range, q: '', employeeId: '', status: '' });
      assert.deepEqual(empty.body.selection, { employee: '全部可讀員工', status: '全部狀態' });
      assert.deepEqual(empty.body.columns, columns); assert.deepEqual(empty.body.rows, []); assert.deepEqual(empty.body.totals, { count: 0 });
      assert.equal(empty.body.page, 1); assert.equal(empty.body.pageSize, endpoint === endpoints[0] ? 25 : 0);
      assert.equal(empty.body.organization.name, '合成訓練報表甲機構'); assert.ok(Number.isFinite(Date.parse(empty.body.generatedAt)));
    }
    assert.equal((await f.request(f.admin, 'GET', endpoint)).status, 422);
    for (const extra of ['category=', 'category=in_service', 'category=x&category=y', 'caseId=', 'supervisorId=', 'month=2026-10', 'date=2026-10-08', 'format=csv', 'unknown=', 'q=&q=', 'employeeId=&employeeId=', 'status=&status=', 'startDate=2026-01-01', 'endDate=2026-12-31', 'status=active', 'status=%20', 'status=__proto__']) assert.equal((await f.request(f.admin, 'GET', url(endpoint) + '&' + extra)).status, 422, extra);
    for (const dates of [{ startDate: '' }, { endDate: '' }, { startDate: '2026-02-30' }, { endDate: '2026-13-01' }, { startDate: '2026-1-01' }, { startDate: '2026-10-09', endDate: '2026-10-08' }, { startDate: '2024-01-01', endDate: '2025-01-01' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, dates))).status, 422);
    for (const dates of [{ startDate: '2024-01-01', endDate: '2024-12-31' }, { startDate: '2026-10-08', endDate: '2026-10-08' }, { startDate: '0000-01-01', endDate: '0000-01-01' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, dates))).status, 200);
  }
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e0', 'page=01', 'page=', 'page=9007199254740992', 'pageSize=101', 'pageSize=0', 'pageSize=25.0', 'pageSize=', 'page=1&page=1']) assert.equal((await f.request(f.admin, 'GET', url() + '&' + query)).status, 422, query);
  for (const endpoint of endpoints.slice(1)) for (const key of ['page', 'pageSize']) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { [key]: '1' }))).status, 422);
  for (const pageSize of ['1', '100']) assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], { pageSize }))).status, 200);
  assert.deepEqual(f.state(), before);
});

test('real role sessions retain training scope and finance is denied before invalid queries or references', async t => {
  const f = await fixture(t), own = await f.create(entity, f.trainingPayload()), other = await f.create(entity, f.trainingPayload({ employeeId: f.employeeB.id })), inactive = await f.create(entity, f.trainingPayload({ employeeId: f.inactive.id }));
  const org = await f.create('organizations', { name: '合成外機構' }), foreignClient = { ...f.admin, org: org.id };
  const foreignEmployee = await f.create('employees', { name: 'PRIVATE-FOREIGN', employeeNo: 'FOREIGN' }, foreignClient);
  await f.create(entity, f.trainingPayload({ employeeId: foreignEmployee.id, name: 'PRIVATE-FOREIGN-TRAINING' }), foreignClient);
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.caregiver]) for (const endpoint of endpoints) {
    const result = await f.request(caller, 'GET', url(endpoint)); assert.equal(result.status, 200);
    if (endpoint !== endpoints[2]) assert.deepEqual(new Set(result.body.rows.map(row => row.trainingId)), new Set((caller === f.clients.caregiver ? [own] : [own, other, inactive]).map(item => item.id)));
    assert.ok(!JSON.stringify(result.body).includes('PRIVATE-FOREIGN'));
    for (const employeeId of [foreignEmployee.id, f.caseItem.id, id(), ...(caller === f.clients.caregiver ? [f.employeeB.id, f.inactive.id] : [])]) {
      const denied = await f.request(caller, 'GET', url(endpoint, { employeeId, q: 'no-match', status: 'cancelled' })); assert.equal(denied.status, 404); assert.ok(!JSON.stringify(denied.body).includes(employeeId));
    }
  }
  for (const endpoint of endpoints) for (const route of [endpoint, url(endpoint), url(endpoint, { employeeId: id(), category: 'bad', page: '0', startDate: 'bad' })]) {
    const denied = await f.request(f.clients.finance, 'GET', route); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'ROLE_FORBIDDEN');
  }
  assert.equal((await f.request({ ...f.clients.supervisor, org: org.id }, 'GET', url())).status, 403);
  assert.deepEqual(f.state(), before);
});

test('every request rechecks active caregiver linkage without excluding inactive employees for managers', async t => {
  const f = await fixture(t); await f.create(entity, f.trainingPayload());
  const inactive = await f.patch('employees', f.employeeA, { status: 'inactive' }); let before = f.state();
  for (const endpoint of endpoints) {
    assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 403);
    for (const caller of [f.admin, f.clients.supervisor]) assert.equal((await f.request(caller, 'GET', url(endpoint, { employeeId: inactive.id }))).status, 200);
  }
  assert.deepEqual(f.state(), before); await f.patch('employees', inactive, { status: 'active' });
  const org = await f.create('organizations', { name: '合成外機構' }), foreign = await f.create('employees', { name: '合成外員工', employeeNo: 'TEST-FOREIGN-LINK' }, { ...f.admin, org: org.id });
  for (const employeeId of [null, id(), f.caseItem.id, foreign.id]) {
    f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(employeeId, f.admin.org, f.clients.caregiver.user.id); before = f.state();
    for (const endpoint of endpoints) { const result = await f.request(f.clients.caregiver, 'GET', url(endpoint)); assert.equal(result.status, 403); assert.equal(result.body.error.code, 'EMPLOYEE_LINK_REQUIRED'); }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE memberships SET employee_id=? WHERE org_id=? AND user_id=?').run(f.employeeA.id, f.admin.org, f.clients.caregiver.user.id);
  assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoints[1]))).body.total, 1);
});

test('saved training with missing foreign wrong-entity or malformed parents remains visible without foreign lookup leakage', async t => {
  const f = await fixture(t), org = await f.create('organizations', { name: '合成外機構' });
  const foreign = await f.create('employees', { name: 'PRIVATE-FOREIGN-NAME', employeeNo: 'PRIVATE-FOREIGN-NO' }, { ...f.admin, org: org.id });
  const parentIds = [id(), foreign.id, f.caseItem.id], imported = parentIds.map(employeeId => f.imported({ employeeId, name: 'PARENT-GROUP' }));
  const malformed = [null, 123, { secret: 'PRIVATE-NESTED-PARENT' }, ['PRIVATE-ARRAY-PARENT']].map(employeeId => f.imported({ employeeId, name: 'PARENT-GROUP' }));
  const before = f.state();
  for (const caller of [f.admin, f.clients.supervisor]) {
    const full = await f.request(caller, 'GET', url(endpoints[1], { q: 'PARENT-GROUP' })); assert.equal(full.status, 200); assert.equal(full.body.total, 7);
    for (const item of [...imported, ...malformed]) {
      const row = full.body.rows.find(x => x.trainingId === item.id); assert.equal(row.employeeNo, ''); assert.equal(row.employee, '');
      assert.equal(row.employeeId, typeof item.employeeId === 'string' ? item.employeeId : '');
    }
    for (const endpoint of endpoints) {
      const all = await f.request(caller, 'GET', url(endpoint, { q: 'PARENT-GROUP' })); assert.equal(all.status, 200);
      for (const secret of ['PRIVATE-FOREIGN-NAME', 'PRIVATE-FOREIGN-NO', 'PRIVATE-CASE-', 'PRIVATE-NESTED-PARENT', 'PRIVATE-ARRAY-PARENT']) assert.ok(!JSON.stringify(all.body).includes(secret));
      for (const employeeId of parentIds) assert.equal((await f.request(caller, 'GET', url(endpoint, { employeeId }))).status, 404);
    }
    for (const q of ['名稱未取得', '—', 'PRIVATE-FOREIGN-NAME', 'PRIVATE-CASE-NAME']) assert.equal((await f.request(caller, 'GET', url(endpoints[0], { q }))).body.total, 0);
  }
  assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoints[1]))).body.total, 0);
  assert.deepEqual(f.state(), before);
});

test('projection is exactly fourteen saved keys and nine columns with safe string-only text and no financial or personal extras', async t => {
  const f = await fixture(t), item = f.imported({ name: '  原課程 <script>TEXT</script>  ', provider: '  辦訓\n原文  ', note: ' 原\r\n備註 ', trainingMinutes: 1, category: 'pre_service', billingSnapshot: { secret: 'PRIVATE-BILLING' }, extra: { secret: 'PRIVATE-EXTRA' } });
  const second = f.imported({ name: ['PRIVATE-NAME'], provider: { secret: 'PRIVATE-PROVIDER' }, note: null, category: 'other', status: 'cancelled', trainingMinutes: 60000 });
  let before = f.state();
  for (const caller of [f.admin, f.clients.supervisor, f.clients.caregiver]) {
    const result = await f.request(caller, 'GET', url(endpoints[1])); assert.equal(result.status, 200); assert.deepEqual(result.body.columns, columns); assert.deepEqual(result.body.totals, { count: 2 });
    for (const row of result.body.rows) assert.deepEqual(Object.keys(row), keys);
    const row = result.body.rows.find(x => x.trainingId === item.id), blank = result.body.rows.find(x => x.trainingId === second.id);
    assert.equal(row.name, item.name); assert.equal(row.provider, item.provider); assert.equal(row.note, item.note); assert.equal(row.trainingMinutes, 1); assert.equal(row.categoryLabel, '職前訓練');
    assert.equal(blank.name, ''); assert.equal(blank.provider, ''); assert.equal(blank.note, ''); assert.equal(blank.trainingMinutes, 60000); assert.equal(blank.categoryLabel, '其他訓練'); assert.equal(blank.statusLabel, '已取消');
    for (const secret of ['PRIVATE-', 'hourlyRateCents', 'billingSnapshot', 'trainingHours', 'statutoryCredits', 'createdAt', 'updatedAt']) assert.ok(!JSON.stringify(result.body).includes(secret), secret);
  }
  assert.deepEqual(f.state(), before);
  for (const name of ['', '   ', { hidden: 'PRIVATE-INVALID-NAME' }, '  名稱有空白  ']) {
    f.overwrite(f.employeeA, { name, employeeNo: ['PRIVATE-NO'] }); before = f.state();
    const result = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: f.employeeA.id })); assert.equal(result.status, 200);
    assert.equal(result.body.selection.employee, typeof name === 'string' && name.trim() ? name : '名稱未取得');
    assert.ok(result.body.rows.every(row => row.employee === (typeof name === 'string' ? name : '') && row.employeeNo === ''));
    assert.deepEqual(f.state(), before);
  }
});

test('literal seven-field search preserves raw q and AND filters without joining fields or searching hidden identifiers and minutes', async t => {
  const f = await fixture(t), first = f.imported({ name: 'Left ONLY-Course .* [x]', provider: 'Right ONLY-Provider', note: '  ONLY-Note  ', category: 'pre_service', status: 'completed', trainingMinutes: 12345 });
  f.imported({ employeeId: f.employeeB.id, name: 'OTHER', category: 'in_service', status: 'cancelled' });
  const before = f.state();
  for (const q of ['test-tr-a', 'alpha', 'only-course', 'only-provider', 'only-note', '職前訓練', '已完成', '.* [x]', '  ONLY-Note  ']) {
    const result = await f.request(f.admin, 'GET', url(endpoints[1], { q })); assert.equal(result.status, 200); assert.equal(result.body.filters.q, q); assert.deepEqual(result.body.rows.map(row => row.trainingId), [first.id]);
  }
  for (const q of [first.id, f.employeeA.id, '12345', '2026-10-08', 'pre_service', 'completed', 'PRIVATE-', 'Left ONLY-Course .* [x]Right', '名稱未取得', '.*[x]']) assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], { q }))).body.total, 0, q);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], { q: 'ONLY', employeeId: f.employeeB.id }))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], { q: 'ONLY', status: 'cancelled' }))).body.total, 0);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[0], { q: 'ONLY', startDate: '2026-10-09' }))).body.total, 0);
  for (const endpoint of endpoints) {
    for (const q of ['x'.repeat(200), '😀'.repeat(100)]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { q }))).status, 200);
    for (const q of ['x'.repeat(201), '😀'.repeat(100) + 'x']) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { q }))).status, 422);
  }
  const full = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: f.employeeB.id, status: 'cancelled' }));
  assert.deepEqual(full.body.selection, { employee: f.employeeB.name, status: '已取消' }); assert.equal(full.body.rows[0].categoryLabel, '在職訓練');
  assert.deepEqual(f.state(), before);
});

test('forty cross-month rows paginate completely, sort by code units and preserve count-only totals for completed and cancelled records', async t => {
  const f = await fixture(t);
  const items = Array.from({ length: 40 }, (_, n) => f.imported({ name: 'TRAINING-' + String(39 - n).padStart(2, '0'), date: n % 2 ? '2026-10-01' : '2026-09-30', status: n % 3 ? 'completed' : 'cancelled', trainingMinutes: n + 1 }));
  const before = f.state(), full = await f.request(f.admin, 'GET', url(endpoints[1]));
  assert.equal(full.status, 200); assert.equal(full.body.total, 40); assert.equal(full.body.page, 1); assert.equal(full.body.pageSize, 40); assert.deepEqual(full.body.totals, { count: 40 });
  assert.deepEqual(full.body.rows.slice(0, 20).map(x => x.name), Array.from({ length: 20 }, (_, n) => 'TRAINING-' + String(2 * n + 1).padStart(2, '0')));
  assert.deepEqual(full.body.rows.slice(20).map(x => x.name), Array.from({ length: 20 }, (_, n) => 'TRAINING-' + String(2 * n).padStart(2, '0')));
  const pages = [];
  for (const page of ['1', '2']) { const result = await f.request(f.admin, 'GET', url(endpoints[0], { page })); assert.equal(result.body.rows.length, page === '1' ? 25 : 15); assert.deepEqual(result.body.totals, { count: 40 }); pages.push(...result.body.rows); }
  assert.deepEqual(pages, full.body.rows); assert.equal(new Set(pages.map(x => x.trainingId)).size, 40);
  assert.deepEqual((await f.request(f.admin, 'GET', url(endpoints[0], { page: '3' }))).body.rows, []);
  const cancelled = await f.request(f.admin, 'GET', url(endpoints[1], { status: 'cancelled' })); assert.equal(cancelled.body.total, items.filter(x => x.status === 'cancelled').length); assert.deepEqual(cancelled.body.totals, { count: cancelled.body.total });
  assert.deepEqual(f.state(), before);
  const a = f.imported({ name: 'a', note: 'TIE', employeeId: f.employeeB.id }, { recordId: 'tie-B-a' });
  const Z = f.imported({ name: 'Z', note: 'TIE' }, { recordId: 'tie-A-Z' });
  const low = f.imported({ name: 'a', note: 'TIE' }, { recordId: 'tie-A-a-a' });
  const high = f.imported({ name: 'a', note: 'TIE' }, { recordId: 'tie-A-a-Z' });
  const ties = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'TIE' })); assert.deepEqual(ties.body.rows.map(x => x.trainingId), [Z.id, high.id, low.id, a.id]);
});

test('real training lifecycle remains fresh while immutable ownership idempotency CAS CSRF and role write guards stay unchanged', async t => {
  const f = await fixture(t), payload = f.trainingPayload({ name: '  合成初始課程  ' });
  let current = await f.create(entity, payload, f.admin, { 'Idempotency-Key': 'training-report-create' });
  assert.equal(current.name, '合成初始課程');
  let before = f.state(); const replay = await f.request(f.admin, 'POST', '/api/' + entity, payload, { 'Idempotency-Key': 'training-report-create' });
  assert.equal(replay.status, 201); assert.deepEqual(replay.body.item, current); assert.deepEqual(f.state(), before);
  current = await f.patch(entity, current, { name: '合成新版課程', date: '2026-11-03', category: 'pre_service', provider: '合成新版辦訓單位', trainingMinutes: 125 }, f.clients.supervisor);
  for (const [changes, caller] of [[{ status: 'cancelled' }, f.admin], [{ status: 'completed', trainingMinutes: 1 }, f.clients.supervisor]]) {
    current = await f.patch(entity, current, changes, caller); before = f.state();
    for (const endpoint of endpoints) {
      const fresh = await f.request(f.clients.caregiver, 'GET', url(endpoint, { employeeId: f.employeeA.id, status: current.status })); assert.equal(fresh.status, 200);
      if (endpoint !== endpoints[2]) { assert.equal(fresh.body.rows[0].version, current.version); assert.equal(fresh.body.rows[0].name, current.name); assert.equal(fresh.body.rows[0].date, current.date); assert.equal(fresh.body.rows[0].trainingMinutes, current.trainingMinutes); assert.equal(fresh.body.rows[0].category, current.category); }
    }
    assert.deepEqual(f.state(), before);
  }
  assert.equal(current.version, 4); before = f.state();
  const path = '/api/' + entity + '/' + current.id;
  const immutable = await f.request(f.admin, 'PATCH', path, { version: current.version, employeeId: f.employeeB.id }); assert.equal(immutable.status, 409); assert.equal(immutable.body.error.code, 'EMPLOYEE_IMMUTABLE');
  const stale = await f.request(f.admin, 'PATCH', path, { version: 1, note: '過時' }); assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.equal((await f.request(f.admin, 'PATCH', path, { version: current.version, note: '無CSRF' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.request(f.admin, 'POST', '/api/' + entity, { ...payload, name: '不同資料' }, { 'Idempotency-Key': 'training-report-create' })).status, 409);
  for (const caller of [f.clients.caregiver, f.clients.finance]) {
    assert.equal((await f.request(caller, 'PATCH', path, { version: current.version, note: '拒絕' })).status, 403);
    assert.equal((await f.request(caller, 'POST', '/api/' + entity, payload)).status, 403);
  }
  for (const data of [{ trainingMinutes: 0 }, { trainingMinutes: 60001 }, { trainingMinutes: 1.5 }, { trainingMinutes: '61' }, { category: 'credits' }, { status: 'approved' }, { date: '2026-02-30' }, { statutoryCredits: 2 }]) assert.equal((await f.request(f.admin, 'PATCH', path, { version: current.version, ...data })).status, 422);
  const history = await f.request(f.admin, 'GET', path + '/history?compare=previous'); assert.equal(history.status, 200); assert.equal(history.body.total, 4); assert.deepEqual(history.body.items.map(row => row.version), [4, 3, 2, 1]);
  assert.deepEqual(f.state(), before);
});

test('candidate dates validate before date range but employee status search and original role filters exclude unrelated malformed dates', async t => {
  const f = await fixture(t); f.imported({ name: 'GOOD-GROUP' }); const bad = f.imported({ employeeId: f.employeeB.id, status: 'cancelled', name: 'BAD-GROUP' });
  for (const date of [undefined, null, '', '2026-02-30', 'not-a-date', '2026-1-01', ['2026-10-08']]) {
    f.overwrite(bad, { date }); const before = f.state();
    for (const endpoint of endpoints) {
      const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 409, JSON.stringify(date)); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID'); assert.ok(!Object.hasOwn(result.body, 'rows'));
      for (const filters of [{ employeeId: f.employeeA.id }, { status: 'completed' }, { q: 'GOOD-GROUP' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filters))).status, 200);
      assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  f.overwrite(bad, { date: '2025-12-31', category: ['in_service'], trainingMinutes: null, status: 'unknown' });
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(9007199254740992n, bad.id);
  for (const endpoint of endpoints) assert.equal((await f.request(f.admin, 'GET', url(endpoint))).status, 200);
  const yearZero = await f.create(entity, f.trainingPayload({ date: '0000-01-01', name: 'YEAR-ZERO' }));
  const oldest = await f.request(f.admin, 'GET', url(endpoints[1], { startDate: '0000-01-01', endDate: '0000-01-01', q: 'YEAR-ZERO' })); assert.equal(oldest.status, 200); assert.equal(oldest.body.rows[0].trainingId, yearZero.id);
});

test('every in-range match validates category status minutes and safe version before pagination including scoped BigInt exclusions', async t => {
  const f = await fixture(t); for (let n = 0; n < 27; n++) f.imported({ name: 'GOOD-GROUP', date: '2026-01-01' });
  const bad = f.imported({ employeeId: f.employeeB.id, name: 'BAD-GROUP', status: 'cancelled' });
  const variants = [
    ...[undefined, null, '', 'unknown', '__proto__', ['cancelled'], { toString: 'completed' }].map(status => ({ status })),
    ...[undefined, null, '', 'unknown', '__proto__', ['in_service'], { toString: 'other' }].map(category => ({ category })),
    ...[undefined, null, 0, -1, 1.5, 60001, '61', [61], { minutes: 61 }, Number.MAX_SAFE_INTEGER + 1].map(trainingMinutes => ({ trainingMinutes })),
  ];
  for (const changes of variants) {
    f.overwrite(bad, changes); const before = f.state();
    for (const endpoint of endpoints) {
      const result = await f.request(f.admin, 'GET', url(endpoint)); assert.equal(result.status, 409, JSON.stringify(changes)); assert.equal(result.body.error.code, 'REPORT_DATA_INVALID');
      for (const filter of [{ q: 'GOOD-GROUP' }, { employeeId: f.employeeA.id }, { status: 'completed' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filter))).status, 200);
      assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  f.overwrite(bad, { category: ['in_service'], status: ['cancelled'] });
  for (const q of ['在職訓練', '已取消', '[object Object]']) assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q, employeeId: f.employeeB.id }))).body.total, 0);
  f.overwrite(bad, {});
  for (const version of [0, -1, 1.5, 'invalid', 9007199254740992n, -9007199254740992n]) {
    f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(version, bad.id); const before = f.state();
    for (const endpoint of endpoints) {
      assert.equal((await f.request(f.admin, 'GET', url(endpoint))).status, 409);
      for (const filter of [{ q: 'GOOD-GROUP' }, { employeeId: f.employeeA.id }, { status: 'completed' }]) assert.equal((await f.request(f.admin, 'GET', url(endpoint, filter))).status, 200);
      assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoint))).status, 200);
    }
    assert.deepEqual(f.state(), before);
  }
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, bad.id);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[1], { q: 'BAD-GROUP' }))).body.rows[0].version, Number.MAX_SAFE_INTEGER);
  f.app.db.prepare('UPDATE records SET version=? WHERE id=?').run(9007199254740992n, f.employeeB.id);
  const employeeVersion = await f.request(f.admin, 'GET', url(endpoints[1], { employeeId: f.employeeB.id })); assert.equal(employeeVersion.status, 200); assert.equal(employeeVersion.body.rows[0].employee, f.employeeB.name);
  assert.equal((await f.request(f.clients.caregiver, 'GET', url(endpoints[1]))).status, 200);
  f.imported({ name: 'INVALID-ID' }, { recordId: '' });
  for (const endpoint of endpoints) assert.equal((await f.request(f.admin, 'GET', url(endpoint, { q: 'INVALID-ID' }))).status, 409);
});

test('CSV uses the same fresh nine-column projection with BOM full quoting formula protection and no IDs', async t => {
  const f = await fixture(t);
  f.overwrite(f.employeeA, { employeeNo: '=SYNTHETIC()', name: '  @合成员工' });
  const item = f.imported({ name: '+SUM(1,2)', provider: '-formula, "quoted"', note: '\t=first\r\nsecond "line"' });
  let before = f.state(), json = await f.request(f.admin, 'GET', url(endpoints[1])), csv = await f.request(f.admin, 'GET', url(endpoints[2]));
  assert.equal(csv.status, 200); assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8'); assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="training-report.csv"');
  assert.equal(csv.headers.get('cache-control'), 'no-store'); assert.equal(csv.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(csv.bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(csv.body, toCsv(json.body)); assert.ok(csv.body.startsWith('\uFEFF' + columns.map(c => csvCell(c.label)).join(',') + '\r\n'));
  for (const value of ['=SYNTHETIC()', '  @合成员工', item.name, item.provider, item.note]) assert.ok(csv.body.includes(csvCell(value)), value);
  for (const hidden of [item.id, f.employeeA.id, 'trainingId', 'employeeId', 'version', 'billingSnapshot', 'PRIVATE-']) assert.ok(!csv.body.includes(hidden));
  assert.deepEqual(f.state(), before);
  f.overwrite(item, { name: '更新後CSV', note: '最新備註', trainingMinutes: 60000, status: 'cancelled' }); before = f.state();
  json = await f.request(f.admin, 'GET', url(endpoints[1])); csv = await f.request(f.admin, 'GET', url(endpoints[2]));
  assert.equal(csv.body, toCsv(json.body)); assert.ok(csv.body.includes('更新後CSV')); assert.ok(csv.body.includes('"60000"')); assert.ok(csv.body.includes('已取消')); assert.ok(!csv.body.includes('+SUM(1,2)'));
  assert.deepEqual(f.state(), before);
});

test('exactly 1000 rows and 2 MiB full JSON export succeed and one extra rejects without truncating paginated reads', async t => {
  const f = await fixture(t); for (let n = 0; n < 1000; n++) f.imported({ name: 'COUNT-GROUP' });
  let before = f.state(); const full = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'COUNT-GROUP' })); assert.equal(full.status, 200); assert.equal(full.body.rows.length, 1000);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2], { q: 'COUNT-GROUP' }))).body, toCsv(full.body)); assert.deepEqual(f.state(), before);
  f.imported({ name: 'COUNT-GROUP' }); before = f.state();
  for (const endpoint of endpoints.slice(1)) { const result = await f.request(f.admin, 'GET', url(endpoint, { q: 'COUNT-GROUP' })); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'REPORT_TOO_LARGE'); assert.ok(!Object.hasOwn(result.body, 'rows')); }
  const page = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'COUNT-GROUP', page: '11', pageSize: '100' })); assert.equal(page.body.total, 1001); assert.equal(page.body.rows.length, 1); assert.deepEqual(f.state(), before);
  const items = Array.from({ length: 80 }, () => f.imported({ name: 'BYTE-GROUP', note: '' }));
  const initial = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'BYTE-GROUP' })); assert.equal(initial.status, 200); let remaining = 2097152 - initial.bytes.length, last;
  for (const item of items) {
    const bytes = Math.min(29997, remaining), note = '字'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3);
    assert.ok(note.length <= 10000); f.overwrite(item, { note }); remaining -= Buffer.byteLength(note); last = { item, note }; if (!remaining) break;
  }
  assert.equal(remaining, 0); before = f.state(); const exact = await f.request(f.admin, 'GET', url(endpoints[1], { q: 'BYTE-GROUP' })); assert.equal(exact.status, 200); assert.equal(exact.bytes.length, 2097152);
  assert.equal((await f.request(f.admin, 'GET', url(endpoints[2], { q: 'BYTE-GROUP' }))).status, 200); assert.deepEqual(f.state(), before);
  f.overwrite(last.item, { note: last.note + 'x' }); before = f.state();
  for (const endpoint of endpoints.slice(1)) { const result = await f.request(f.admin, 'GET', url(endpoint, { q: 'BYTE-GROUP' })); assert.equal(result.status, 413); assert.equal(result.body.error.code, 'REPORT_TOO_LARGE'); }
  const limited = await f.request(f.admin, 'GET', url(endpoints[0], { q: 'BYTE-GROUP' })); assert.equal(limited.status, 200); assert.equal(limited.body.total, 80); assert.equal(limited.body.rows.length, 25); assert.deepEqual(f.state(), before);
});

test('training reads preserve eleven tables both BLOBs six triggers approved billing and all twenty-five previous report exits', async t => {
  const f = await fixture(t), service = await f.create('service-items', { code: 'TEST-TR-SERVICE', name: '合成服務', unitPriceCents: 12345, minutes: 60 });
  const plan = await f.create('care-plans', { caseId: f.caseItem.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 30 }] });
  const shift = await f.create('shifts', { caseId: f.caseItem.id, employeeId: f.employeeA.id, carePlanId: plan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 1 }] });
  const record = await f.create('service-records', { shiftId: shift.id, caseId: f.caseItem.id, employeeId: f.employeeA.id, date: shift.date, actualStart: '09:05', actualEnd: '09:52', services: [{ serviceItemId: service.id, quantity: 3 }], status: 'submitted' }, f.clients.caregiver);
  const approved = await f.request(f.admin, 'POST', '/api/service-records/' + record.id + '/review', { version: record.version, decision: 'approved', reviewNote: '合成核閱' }); assert.equal(approved.status, 200);
  const snapshot = (await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item;
  const cert = await f.create('employee-certifications', { employeeId: f.employeeA.id, name: '合成證照', issuedOn: '2026-01-01' });
  const caseFile = await f.request(f.admin, 'POST', '/api/case-attachments/upload', { caseId: f.caseItem.id, title: '合成個案PDF', ...filePayload(PDF_BYTES, 'synthetic.pdf', 'application/pdf') }); assert.equal(caseFile.status, 201);
  const certFile = await f.request(f.admin, 'POST', '/api/certification-attachments/upload', { certificationId: cert.id, title: '合成證照PNG', ...filePayload(PNG_BYTES, 'synthetic.png', 'image/png') }); assert.equal(certFile.status, 201);
  const feesBefore = (await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body;
  const payrollBefore = (await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body;
  await f.patch('service-items', service, { unitPriceCents: 99999 }); await f.patch('employees', f.employeeA, { hourlyRateCents: 99999 });
  let training = await f.create(entity, f.trainingPayload({ date: shift.date, trainingMinutes: 60000 }));
  training = await f.patch(entity, training, { trainingMinutes: 1, status: 'cancelled' }, f.clients.supervisor);
  const before = f.state(); assert.equal(Object.keys(before.tables).length, 11); assert.equal(before.triggers.length, 6);
  assert.ok(before.tables.attachment_files.length > 0); assert.ok(before.tables.certification_attachment_files.length > 0);
  const previous = [];
  for (const kind of ['cases', 'shifts', 'services', 'fees', 'payroll']) for (const suffix of ['', '.csv']) previous.push(`/api/reports/${kind}${suffix}?month=2026-10`);
  for (const kind of ['shift', 'service', 'case', 'employee', 'leave']) for (const suffix of ['', '/export', '.csv']) previous.push(`/api/${kind}-report${suffix}` + (kind === 'employee' ? '' : '?' + new URLSearchParams(range)));
  assert.equal(previous.length, 25);
  const withoutGeneratedAt = body => { if (typeof body === 'string') return body; const { generatedAt, ...stable } = body; return stable; };
  const oldResults = [];
  for (const path of previous) { const response = await f.request(f.admin, 'GET', path); assert.equal(response.status, 200, path); oldResults.push(withoutGeneratedAt(response.body)); }
  for (const caller of Object.values(f.clients)) for (const endpoint of endpoints) {
    const response = await f.request(caller, 'GET', url(endpoint)); assert.equal(response.status, caller === f.clients.finance ? 403 : 200);
    assert.ok(!JSON.stringify(response.body).includes('billingSnapshot')); assert.ok(!JSON.stringify(response.body).includes('hourlyRateCents'));
  }
  for (let i = 0; i < previous.length; i++) { const response = await f.request(f.admin, 'GET', previous[i]); assert.equal(response.status, 200); assert.deepEqual(withoutGeneratedAt(response.body), oldResults[i]); }
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/fees?month=2026-10')).body, feesBefore);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/reports/payroll?month=2026-10')).body, payrollBefore);
  assert.deepEqual((await f.request(f.admin, 'GET', '/api/service-records/' + record.id)).body.item, snapshot);
  const history = await f.request(f.admin, 'GET', `/api/${entity}/${training.id}/history?compare=previous`); assert.equal(history.body.items[0].snapshot.trainingMinutes, 1); assert.equal(history.body.items[1].snapshot.trainingMinutes, 60000);
  for (const [kind, result, bytes] of [['case-attachments', caseFile, PDF_BYTES], ['certification-attachments', certFile, PNG_BYTES]]) {
    const download = await f.request(f.admin, 'GET', `/api/${kind}/${result.body.item.id}/download`); assert.equal(download.status, 200); assert.deepEqual(download.bytes, bytes);
  }
  assert.deepEqual(f.state(), before);
});
